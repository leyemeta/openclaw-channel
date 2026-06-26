/**
 * 实现 host `turn.run({ adapter })` 的 resolveTurn 部分,返回 PreparedChannelTurn,
 * 由 host kernel 跑完 recordInboundSession + runDispatch(拉 agent、投递 reply)。
 * 形态对齐 @openclaw/feishu 的单 agent 路径。
 *
 * 出站收尾的关键约束:block streaming 模式下 SDK 会丢弃 final payload
 * (shouldDropFinalPayloads),deliver(kind=final) 不被调用,所以收尾的
 * done:true 必须由 dispatcher 的 onSettled 钩子兜底发出 —— 见下方 closeStream。
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

// 从 PluginRuntime 公开类型链反推 resolveTurn 的返回类型,避免直接 import SDK 私有
// 路径触发 TS2742 declaration-emit 错误。
type ResolveTurnReturn = Awaited<
  ReturnType<
    Parameters<
      PluginRuntime["channel"]["turn"]["run"]
    >[0]["adapter"]["resolveTurn"]
  >
>;

/**
 * 构造 PreparedChannelTurn,交给 host kernel 跑完 record + dispatch。
 * 不可返回 null —— host 会直接读结果的 .accountId。
 */
export function buildPreparedChannelTurn(
  ctx: ChannelGatewayContext<LeyemetaAccount>,
  envelope: InboundEnvelope,
  attachmentInjection?: AttachmentInjection,
): ResolveTurnReturn {
  const runtime = getLeyemetaRuntime();
  const log = ctx.log;

  // 解析路由:bindings 命中则用指定 agentId,否则取 agents.list[0]
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: "leyemeta",
    accountId: ctx.accountId,
    peer: { kind: "direct", id: envelope.conversationId },
  });

  // 会话隔离 key 直接用 route.sessionKey,别手写。resolveAgentRoute 已按 host 配置
  // session.dmScope 折算成规范 key —— 手写的非规范 key 会"写得进、读不出"(消息能回
  // 但 web 端会话里看不到)。注意:host 配置须设 dmScope: "per-peer",否则默认 main
  // 会让所有会话塌缩成一份导致串台。详见 DESIGN.md §会话隔离。
  const sessionKey = route.sessionKey;
  log?.info?.(
    `route-resolve conv=${envelope.conversationId} sessionKey=${sessionKey} agentId=${route.agentId}`,
  );

  // session store 路径,recordInboundSession 写入此目录
  const storePath = runtime.channel.session.resolveStorePath(
    ctx.cfg.session?.store,
    { agentId: route.agentId },
  );

  // 跳过的附件信息只追加进 BodyForAgent,提示 agent 用户发了文件但被忽略。
  // Body / rawText 保持原样 —— transcript 持久化的是 Body,不能掺入这段提示。
  const skippedNote = attachmentInjection
    ? buildSkippedAttachmentsNote(attachmentInjection.skipped)
    : "";
  const bodyForAgent = skippedNote
    ? `${envelope.turnInput.textForAgent}${skippedNote}`
    : envelope.turnInput.textForAgent;

  // 构造 FinalizedMsgContext。finalizeInboundContext 会强制写入 CommandAuthorized:false
  // (default-deny);Media* 字段对齐 SDK MsgContext,prompt 装配时喂给多模态模型。
  const rawCtx: Record<string, unknown> = {
    Body: envelope.rawText,
    BodyForAgent: bodyForAgent,
    CommandBody: envelope.rawText,
    BodyForCommands: envelope.rawText,
    SessionKey: sessionKey,
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

  // 同一轮回复共用一个 assistantMessageId,让平台 UI 能把多帧合并显示
  const assistantMessageId = buildAssistantMessageId();

  log?.debug?.(
    `streaming probe: block.enabled=${String(
      (ctx.cfg as { channels?: { leyemeta?: { streaming?: { block?: { enabled?: unknown } } } } })
        .channels?.leyemeta?.streaming?.block?.enabled,
    )} (undefined 表示 schema default 未填进 cfg)`,
  );

  // 流式收尾状态机(收尾 done:true 由 onSettled 兜底,见文件头说明)
  let streamingActive = false; // 已发过 done:false 的 block
  let streamClosed = false;    // done:true 已发出(幂等保护)
  let finalSentInline = false; // 非 streaming 路径:final 单帧已发(自带 done:true)
  let streamedChars = 0;
  let blockCount = 0;

  // tool_status 按工具名去重:SDK 一次工具会 fire 2-3 次 onToolStart,同名只发一帧
  // phase=running。SDK 暂未暴露 end/error,故本版本不发 success/error。
  const announcedTools = new Set<string>();

  // reason 仅用于日志:settled(正常)/ error(抛错兜底)/ cancelled(inbound.cancel)
  // / disconnected(ws 断)/ shutdown(插件关停)
  type CloseReason =
    | "settled"
    | "error"
    | "cancelled"
    | "disconnected"
    | "shutdown";
  const closeStream = (reason: CloseReason): void => {
    if (streamClosed) return;
    if (finalSentInline) {
      // final 单帧已自带 done:true,无需补
      streamClosed = true;
      return;
    }
    if (!streamingActive) {
      // 整轮没产文本(silent reply / NO_REPLY),不造空收尾帧
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
      // ws 可能已断:吞掉,避免外层重复 close 连锁失败
      streamClosed = true;
      log?.warn?.(
        `stream-close failed (reason=${reason}): ${describeError(err)}`,
      );
    }
  };

  // dispatcher 出站策略:block → 增量帧 done:false;final 在已 streaming 时不发
  // (交 onSettled 兜底),否则非空 text 一次性 done:true;tool 忽略(走 onToolStart)。
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

        // 工具状态走 onToolStart,不掺入主回复流
        if (info.kind === "tool") return;

        if (info.kind === "block") {
          if (!text) return;
          // 第二段起补换行,与 SDK 按 \n 拼接多 block 的累加视图一致
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

        // kind === "final":已 streaming 时收尾交给 onSettled,这里不发
        if (streamingActive) {
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
        // 先发 outbound.error 让平台拿到错误码,再 closeStream 补 done:true 收尾
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

  // AbortController + in-flight 注册,让外部信号(cancel / ws 断 / 关停)命中本 turn:
  // abort 短路 agent,close 兜底发收尾帧。在 resolve 阶段就注册以防 cancel 早到,
  // 注销放在 runDispatch 的 finally(失败也注销)。
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
      // disconnected 时 deliverTextToWs 必失败,但 closeStream 内部已 try/catch
      closeStream(reason);
    },
  };
  registerTurn(ctx.accountId, envelope.conversationId, inflight);

  const prepared = {
    channel: "leyemeta" as const,
    accountId: ctx.accountId,
    routeSessionKey: sessionKey,
    storePath,
    ctxPayload,
    recordInboundSession: runtime.channel.session.recordInboundSession,
    record: {
      onRecordError: (err: unknown) =>
        log?.error?.(
          `recordInboundSession failed (sessionKey=${sessionKey}): ${describeError(err)}`,
        ),
    },
    onPreDispatchFailure: () => {
      // record/resolve 阶段失败时 host 调此钩子,不进 runDispatch,故在这里注销
      // 防止 in-flight 泄漏(否则后续 cancel 会指向已死 turn)。
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
              // disableBlockStreaming:false 是开启 block streaming 的唯一开关 —— 这条
              //   get-reply 路径不读 channel 的 streaming.block.enabled,只看这个 flag,
              //   传 false 才会让 deliver(kind=block) 真正触发。
              // abortSignal:透传给底层 agent,abort 后立即短路返回不再烧 token。
              replyOptions: {
                ...replyOptions,
                disableBlockStreaming: false,
                abortSignal: abortController.signal,
                // 探针:onItemEvent 携带工具完整生命周期(phase start→update→end,
                // itemId 跨 phase 稳定可做精准 dedup)。暂只打 log,未接入 tool_status ——
                // 其 tool 字段语义与 onToolStart 的 running 帧无法天然配对,待与前端协商帧契约。
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
                // 同一次调用 SDK 会 fire 2-3 次 onToolStart,按 name 去重后只发一帧
                // phase=running。deliverToolStatusToWs 永不抛,不干扰主回复流。
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
        // closeStream 幂等(streamClosed 保护)。这里补发 outbound.error 可能与
        // deliver onError 重复一帧,平台取最新 code 即可,不去重。
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
        // 无论正常/抛错/abort 都注销;传 inflight 自身做指纹校验,避免误删新 turn
        unregisterTurn(ctx.accountId, envelope.conversationId, inflight);
      }
    },
  };

  return prepared;
}
