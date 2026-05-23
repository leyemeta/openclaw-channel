/**
 * turn-resolver —— gateway 收到 inbound.message 后,把 host 的 `turn.run({ adapter })`
 * 中 `resolveTurn` 部分实现出来,返回 `PreparedChannelTurn`,让 host kernel 跑完:
 *   1. recordInboundSession(写入站会话)
 *   2. runDispatch(拉 Agent 跑 turn,通过 dispatcher 把 reply 投递回来)
 *
 * 形态对齐 `@openclaw/feishu` 的 `monitor.account-CUZxYkjE.js:2509-2573` 单 agent 路径。
 *
 * 反向调用链:
 *   gateway.handleInboundMessage
 *     → runtime.channel.turn.run({ adapter: { ingest, resolveTurn } })
 *     → host kernel 调 resolveTurn -> buildPreparedChannelTurn (本文件)
 *     → host kernel 调 runDispatch
 *       → runtime.channel.reply.withReplyDispatcher (finally → onSettled → closeStream)
 *         → runtime.channel.reply.dispatchReplyFromConfig
 *           → Agent 跑 turn,产 reply payload(多个 block / 单个 final)
 *           → dispatcher.sendBlockReply -> deliver(kind=block) → outbound.delta done:false
 *           → dispatcher.sendFinalReply -> deliver(kind=final):
 *               · 已 streaming → 不发(走 onSettled 兜底)
 *               · 否则非空 text → 一次性 outbound.delta done:true
 *       → 收尾:onSettled 触发 closeStream → 若 streaming 过则补一帧 outbound.delta delta:"" done:true
 *
 * 关键:block streaming 模式下,SDK 会丢弃 final payload(agent-runner shouldDropFinalPayloads),
 * deliver(kind=final) 不会被调用,所以 done:true 必须由 onSettled 钩子兜底发出。
 */

import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk";

import { describeError } from "../runtime/logger.js";
import { getLeyemetaRuntime } from "../runtime/host-runtime.js";
import {
  type InFlightTurn,
  registerTurn,
  unregisterTurn,
} from "../runtime/in-flight.js";
import type { LeyemetaAccount } from "../types.js";

import {
  type AttachmentInjection,
  buildSkippedAttachmentsNote,
} from "./attachments.js";
import { classifyError } from "./error-mapping.js";
import {
  buildAssistantMessageId,
  deliverErrorToWs,
  deliverTextToWs,
  deliverToolStatusToWs,
} from "./outbound.js";
import type { InboundEnvelope } from "./messaging.js";

/**
 * `resolveTurn` 的真实返回类型(走 PluginRuntime 公开类型链反推,避免直接 import
 * SDK 私有 src 路径触发 TS2742 declaration-emit 错误)。
 */
type ResolveTurnReturn = Awaited<
  ReturnType<
    Parameters<
      PluginRuntime["channel"]["turn"]["run"]
    >[0]["adapter"]["resolveTurn"]
  >
>;

/**
 * 构造 PreparedChannelTurn,交给 host kernel 跑完 record + dispatch。
 *
 * 注意:不可返回 null —— host 在 `kernel.resolveTurn` 拿到结果后直接读 `.accountId`,
 * 之前的 `() => null` 就是当前崩点的根因。
 */
export function buildPreparedChannelTurn(
  ctx: ChannelGatewayContext<LeyemetaAccount>,
  envelope: InboundEnvelope,
  attachmentInjection?: AttachmentInjection,
): ResolveTurnReturn {
  const runtime = getLeyemetaRuntime();
  const log = ctx.log;

  // 1. 解析路由:bindings 命中 → 指定 agentId;否则 default(取 agents.list[0])
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: "leyemeta",
    accountId: ctx.accountId,
    peer: { kind: "direct", id: envelope.conversationId },
  });

  // 2. session store 路径,recordInboundSession 写入此目录
  const storePath = runtime.channel.session.resolveStorePath(
    ctx.cfg.session?.store,
    { agentId: route.agentId },
  );

  // 3. 把"跳过的不支持附件"信息追加到 BodyForAgent,让 agent 知道用户其实
  //    发了某些文件但被忽略,避免"我没收到附件"的尴尬回复。
  //    rawText / commandBody / Body 保持不变(原始输入语义不变,
  //    OpenClaw session transcript 持久化的是 Body)。
  const skippedNote = attachmentInjection
    ? buildSkippedAttachmentsNote(attachmentInjection.skipped)
    : "";
  const bodyForAgent = skippedNote
    ? `${envelope.turnInput.textForAgent}${skippedNote}`
    : envelope.turnInput.textForAgent;

  // 4. 构造 FinalizedMsgContext;字段集合参考 feishu monitor.account 2502-2508
  //    finalizeInboundContext 会强制写入 `CommandAuthorized: false`(default-deny)
  //    Media* 字段语义对齐 SDK auto-reply/templating.MsgContext,
  //    agent prompt 装配阶段会把 MediaPaths 内文件喂给多模态模型。
  const rawCtx: Record<string, unknown> = {
    Body: envelope.rawText,
    BodyForAgent: bodyForAgent,
    CommandBody: envelope.rawText,
    BodyForCommands: envelope.rawText,
    SessionKey: route.sessionKey,
    AccountId: ctx.accountId,
    From: envelope.user.id,
    To: envelope.conversationId,
    MessageSid: envelope.messageId,
    ChatType: "direct",
    Provider: "leyemeta",
    Surface: "leyemeta",
    SenderId: envelope.user.id,
    SenderName: envelope.user.name,
    Timestamp: envelope.turnInput.timestamp,
    OriginatingChannel: "leyemeta",
    OriginatingTo: envelope.conversationId,
    ...(attachmentInjection?.fields ?? {}),
  };
  const ctxPayload = runtime.channel.reply.finalizeInboundContext(rawCtx);

  // 4. 复用 assistantMessageId,让同一轮 Agent 回复在平台 UI 上能合并
  const assistantMessageId = buildAssistantMessageId();

  log?.debug?.(
    `streaming probe: block.enabled=${String(
      (ctx.cfg as { channels?: { leyemeta?: { streaming?: { block?: { enabled?: unknown } } } } })
        .channels?.leyemeta?.streaming?.block?.enabled,
    )} (undefined 表示 schema default 未填进 cfg)`,
  );

  // 5. 流式收尾状态机。
  //    Why: SDK 在 block streaming 跑过后会丢弃 final payload
  //    (agent-runner.runtime.js:2195 shouldDropFinalPayloads),
  //    deliver(kind="final") 经过 normalize 空 text → null 不会被调用。
  //    所以收尾 done:true 必须挂在 dispatcher 必然终结的钩子上 —— onSettled。
  let streamingActive = false; // 已发过 done:false 的 block
  let streamClosed = false;    // done:true 已发出(幂等保护)
  let finalSentInline = false; // 非 streaming 路径:final 单帧已发(自带 done:true)
  let streamedChars = 0;
  let blockCount = 0;

  // tool_status 去重:onToolStart 一次工具会触发 2-3 次(SDK 内部 lifecycle 多 fire 点),
  // 同 turn 同名工具只发一次 phase=running。维度暂定 name,日后若 SDK 暴露 toolCallId
  // 可升级成 (name, callId) 复合 key 以支持同 turn 同名工具多次调用各算一次。
  // 注意:phase 维度极窄(目前观察只有 "start"),end/error 缺失,故此版本只发 running,
  // 不区分 success/error。
  const announcedTools = new Set<string>();

  /**
   * reason 枚举:
   *   - settled:正常收尾(host onSettled 钩子触发)
   *   - error:dispatch 抛错 / deliver 抛错兜底
   *   - cancelled:平台转发 inbound.cancel(用户点停止 / 平台代发)
   *   - disconnected:插件↔平台 ws 信道断(deliver 必失败,仅留日志)
   *   - shutdown:插件自身关停(SIGTERM / ctx.abortSignal)
   */
  type CloseReason =
    | "settled"
    | "error"
    | "cancelled"
    | "disconnected"
    | "shutdown";
  const closeStream = (reason: CloseReason): void => {
    if (streamClosed) return;
    if (finalSentInline) {
      // final 单帧路径已自带 done:true,无需补
      streamClosed = true;
      return;
    }
    if (!streamingActive) {
      // 整轮没产文本(silent reply / NO_REPLY),不主动造空收尾帧
      streamClosed = true;
      return;
    }
    try {
      deliverTextToWs({
        accountId: ctx.accountId,
        conversationId: envelope.conversationId,
        text: "",
        done: true,
        messageId: assistantMessageId,
      });
      streamClosed = true;
      log?.info?.(
        `stream-close reason=${reason} conv=${envelope.conversationId} msg=${assistantMessageId} blocks=${blockCount} chars=${streamedChars}`,
      );
    } catch (err) {
      // ws 可能已断:吞掉,避免外层重复 close 时连锁失败
      streamClosed = true;
      log?.warn?.(
        `stream-close failed (reason=${reason}): ${describeError(err)}`,
      );
    }
  };

  // 6. 造 dispatcher。流式策略:
  //    - kind=tool        → 忽略(预留给 v1.3 工具状态透传 outbound.tool_status)
  //    - kind=block       → 增量帧下发(done=false),维护 streamingActive
  //    - kind=final + streamingActive → 不发(留给 onSettled 兜底空 done:true)
  //    - kind=final + 非空 text → 一次性整段下发(done=true)
  //    - kind=final + 空 text  → 跳过
  const { dispatcher, replyOptions, markDispatchIdle } =
    runtime.channel.reply.createReplyDispatcherWithTyping({
      humanDelay: runtime.channel.reply.resolveHumanDelayConfig(
        ctx.cfg,
        route.agentId,
      ),
      deliver: async (payload, info) => {
        const text = payload.text ?? "";
        log?.debug?.(
          `deliver kind=${info.kind} textLen=${text.length} ` +
            `isReasoning=${payload.isReasoning === true} ` +
            `isError=${payload.isError === true}`,
        );

        // deliver(kind="tool") 在默认 verbose=off 下不会被 SDK 调到;即便后续 agent
        // 配置打开 verbose,这里也仍然丢弃 —— 工具状态走 onToolStart 路径,不掺入主流。
        if (info.kind === "tool") return;

        if (info.kind === "block") {
          if (!text) return;
          // SDK 多 block 之间按 \n 拼接,这里在第二段起补换行,与 SDK 累加视图一致
          const deltaText = streamingActive ? `\n${text}` : text;
          deliverTextToWs({
            accountId: ctx.accountId,
            conversationId: envelope.conversationId,
            text: deltaText,
            done: false,
            messageId: assistantMessageId,
          });
          streamingActive = true;
          streamedChars += deltaText.length;
          blockCount += 1;
          log?.info?.(
            `reply block#${blockCount} delivered conv=${envelope.conversationId} msg=${assistantMessageId} len=${deltaText.length}`,
          );
          return;
        }

        // kind === "final"
        if (streamingActive) {
          // 已 streaming,收尾交给 onSettled 统一处理,这里什么都不做
          return;
        }
        if (!text) return;
        deliverTextToWs({
          accountId: ctx.accountId,
          conversationId: envelope.conversationId,
          text,
          done: true,
          messageId: assistantMessageId,
        });
        finalSentInline = true;
        log?.info?.(
          `reply final delivered conv=${envelope.conversationId} msg=${assistantMessageId} len=${text.length}`,
        );
      },
      onError: (err, info) => {
        log?.error?.(
          `reply deliver error kind=${info.kind}: ${describeError(err)}`,
        );
        // 先发 outbound.error 让平台拿到错误码,再 closeStream 补 done:true 收尾。
        // 顺序很重要:closeStream 反过来会让前端先看到 done 再看到 error。
        const { code, message } = classifyError(err, { source: "deliver" });
        deliverErrorToWs({
          accountId: ctx.accountId,
          conversationId: envelope.conversationId,
          code,
          message,
          log,
        });
        closeStream("error");
      },
    });

  const composedOnSettled = async (): Promise<void> => {
    closeStream("settled");
    markDispatchIdle();
  };

  // 7. AbortController + in-flight 注册。
  //    Why: 让"外部信号"(平台转发的 inbound.cancel / 插件↔平台 ws 断 / 插件关停)
  //    能精准命中本 turn:abort 让 SDK 短路 agent,close 兜底发 done:true 收尾帧。
  //    注册时机:resolve 阶段就注册 —— 这样即便 host 还没真正调 runDispatch(理论上不会,
  //    但稳健起见),cancel 也能命中。注销务必在 runDispatch 的 finally 里,失败也要注销。
  const abortController = new AbortController();
  const inflight: InFlightTurn = {
    abort: (reason) => {
      if (!abortController.signal.aborted) {
        abortController.abort(reason);
        log?.info?.(
          `turn abort conv=${envelope.conversationId} reason=${reason}`,
        );
      }
    },
    close: (reason) => {
      // disconnected 路径下,deliverTextToWs 必然抛错(信道已断),
      // closeStream 内部 try/catch 会吞掉并打 warn,这里不需要额外处理。
      closeStream(reason);
    },
  };
  registerTurn(ctx.accountId, envelope.conversationId, inflight);

  const prepared = {
    channel: "leyemeta" as const,
    accountId: ctx.accountId,
    routeSessionKey: route.sessionKey,
    storePath,
    ctxPayload,
    recordInboundSession: runtime.channel.session.recordInboundSession,
    record: {
      onRecordError: (err: unknown) =>
        log?.error?.(
          `recordInboundSession failed (sessionKey=${route.sessionKey}): ${describeError(err)}`,
        ),
    },
    onPreDispatchFailure: () => {
      // host 在 record/resolve 阶段失败时调,不会进 runDispatch → 那条 finally 注销不到。
      // 这里同步注销,避免 in-flight 泄漏(后续同 conv 来 cancel 会指向已死 turn)。
      unregisterTurn(ctx.accountId, envelope.conversationId, inflight);
      return runtime.channel.reply.settleReplyDispatcher({
        dispatcher,
        onSettled: composedOnSettled,
      });
    },
    runDispatch: async () => {
      try {
        return await runtime.channel.reply.withReplyDispatcher({
          dispatcher,
          onSettled: composedOnSettled,
          run: () =>
            runtime.channel.reply.dispatchReplyFromConfig({
              ctx: ctxPayload,
              cfg: ctx.cfg,
              dispatcher,
              // 显式打开 block streaming + 透传 abortSignal。
              // Why disableBlockStreaming: dispatchReplyFromConfig 内部走 get-reply 路径,
              //   blockStreamingEnabled 由 `opts.disableBlockStreaming === false ? "on"
              //   : agentCfg.blockStreamingDefault === "on" ? "on" : "off"` 计算
              //   (见 get-reply-l4t-yw84.js:1111)。channel 那层的 streaming.block.enabled
              //   在这条路径上不被读;必须在 replyOptions 上传 false 才能把 SDK 切到
              //   block streaming pipeline,让 deliver(kind=block) 真正触发。
              // Why abortSignal: SDK GetReplyOptions.abortSignal 透传给底层 agent 跑批,
              //   一旦 abort,agent 立即短路返回,不再烧 token。
              replyOptions: {
                ...replyOptions,
                disableBlockStreaming: false,
                abortSignal: abortController.signal,
                // 探针:onItemEvent 是 SDK 在 replyOptions 上能拿到工具完整生命周期的钩子,
                // 暂不接入 outbound.tool_status,先保留 log 供日后实施 success/error 帧时回看。
                //
                // 已确认事实(2026-05-14 真实样本):
                //   - 每个工具调用触发 phase = start → update → end 三相,带 status
                //   - 成功收尾:phase=end status=completed (失败样本未捕到,推测 status!="completed")
                //   - itemId 形如 "tool:call_00_xxx",跨 phase 稳定,是天然的精准 dedup 维度
                //   - kind 字段成对出现:tool 和 command。command 是 exec 子项,语义重复,
                //     真接入时只取 kind=tool 即可
                //   - phase=end 的 payload.summary 含工具结果摘要(如 "+24°C", "上证指数..."),
                //     start/update 的 summary 是空
                //   - title 是人类可读描述("exec fetch https://hq.sinajs.cn/... -> run iconv gbk"),
                //     name 字段在 codex 路径下退化成 "exec",失去真实工具名
                //
                // 未接入原因:与 onToolStart 的 running 帧字段(name=web_search)无法天然配对,
                // 需先和前端协商 tool_status 帧契约的 tool 字段语义。
                onItemEvent: (payload) => {
                  const itemId = payload?.itemId ?? "<no-id>";
                  const kind = payload?.kind ?? "<no-kind>";
                  const phase = payload?.phase ?? "<no-phase>";
                  const status = payload?.status ?? "<no-status>";
                  const name = payload?.name ?? "";
                  const title = payload?.title ?? "";
                  const summaryHead = (payload?.summary ?? "").slice(0, 80);
                  log?.info?.(
                    `tool-probe onItemEvent conv=${envelope.conversationId} ` +
                      `itemId=${itemId} kind=${kind} phase=${phase} status=${status} ` +
                      `name=${JSON.stringify(name)} title=${JSON.stringify(title)} ` +
                      `summaryHead=${JSON.stringify(summaryHead)}`,
                  );
                },
                // 工具状态透传:SDK 在工具 lifecycle 内对同一次调用会多次 fire onToolStart
                // (实测同名同 argKeys 同秒 2-3 次),按 name 维度去重后每个工具只发一帧
                // phase=running。结束/失败信号 SDK 暂未通过钩子暴露,本版本不发 success/error。
                // 投递函数永不抛(信道断会静默 warn),不会干扰主回复流。
                onToolStart: (payload) => {
                  const name = payload?.name;
                  if (!name) return;
                  if (announcedTools.has(name)) return;
                  announcedTools.add(name);
                  deliverToolStatusToWs({
                    accountId: ctx.accountId,
                    conversationId: envelope.conversationId,
                    tool: name,
                    phase: "running",
                    log,
                  });
                  log?.info?.(
                    `tool-status running conv=${envelope.conversationId} tool=${name}`,
                  );
                },
              },
            }),
        });
      } catch (err) {
        // withReplyDispatcher 的 finally 已经会跑 onSettled,但若 onSettled 内部
        //   closeStream 因 ws 异常被吞,这里再补一次是幂等的(streamClosed 保护)。
        // outbound.error 投递是新增的语义补充:若 deliver onError 已经发过一帧,
        //   这里可能重复发一帧,平台取最新 code 即可。本批不加去重标志。
        const { code, message } = classifyError(err, { source: "dispatch" });
        deliverErrorToWs({
          accountId: ctx.accountId,
          conversationId: envelope.conversationId,
          code,
          message,
          log,
        });
        closeStream("error");
        throw err;
      } finally {
        // 注销 in-flight,无论 dispatch 是正常完成、抛错还是被 abort。
        // 传入 inflight 自身做"指纹校验",防止同 conv 已被新 turn 顶替时误删新条目。
        unregisterTurn(ctx.accountId, envelope.conversationId, inflight);
      }
    },
  };

  return prepared;
}
