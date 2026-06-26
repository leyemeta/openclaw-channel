/**
 * 在 startAccount(ctx) 中实例化 LeyemetaWsClient,处理 ws 生命周期并通过
 * ctx.setStatus / runtime.channel.turn.run 与 host 交互。
 *
 * 入站 inbound.message 经 turn.run 交给 host kernel,最终由 dispatcher 投递回 ws;
 * resolveTurn 实现见 ./turn-resolver.ts。
 *
 * 两个关键点:registerConn/unregisterConn 必须配对(含 startAccount 抛出时);
 * startAccount 必须 await 到 ctx.abortSignal 才返回 —— host 把它的 promise 寿命
 * 当成 channel 生命周期,提前 resolve 会被判为异常退出并触发退避重启。
 */

import type { ChannelPlugin } from "openclaw/plugin-sdk";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";

import { describeError } from "../runtime/logger.js";
import { registerConn, unregisterConn } from "../runtime/context.js";
import {
  clearAccount,
  listByAccount,
  lookupTurn,
} from "../runtime/in-flight.js";
import type { Logger } from "../runtime/logger.js";
import { startRunWatcher } from "../runtime/run-watcher.js";
import {
  LeyemetaWsClient,
  type WsClientOptions,
} from "../transport/ws-client.js";
import type { InboundFrame } from "../transport/frames.js";
import type { LeyemetaAccount } from "../types.js";

import {
  AttachmentDownloadError,
  processInboundAttachments,
} from "./attachments.js";
import { config } from "./config.js";
import { buildInboundEnvelope } from "./messaging.js";
import {
  buildAssistantMessageId,
  deliverErrorToWs,
  deliverTextToWs,
} from "./outbound.js";
import { buildPreparedChannelTurn } from "./turn-resolver.js";
import { getLeyemetaRuntime } from "../runtime/host-runtime.js";

// 硬编码副本,避免运行时 require package.json(NodeNext + isolatedModules 不能
// import json 进 src/);未来可由 build 脚本注入。
const PLUGIN_VERSION = "1.0.0-alpha.0";

function toTransportLogger(ctx: ChannelGatewayContext<LeyemetaAccount>): Logger {
  const sink = ctx.log;
  if (!sink) {
    return {
      info: (m) => console.log(`[leyemeta:${ctx.accountId}] ${m}`),
      warn: (m) => console.warn(`[leyemeta:${ctx.accountId}] ${m}`),
      error: (m) => console.error(`[leyemeta:${ctx.accountId}] ${m}`),
      debug: (m) => console.debug?.(`[leyemeta:${ctx.accountId}] ${m}`),
    };
  }
  return {
    info: sink.info.bind(sink),
    warn: sink.warn.bind(sink),
    error: sink.error.bind(sink),
    debug: sink.debug ? sink.debug.bind(sink) : undefined,
  };
}

/** ctx.channelRuntime 类型上是窄的 ChannelRuntimeSurface,host 实际注入了完整
 *  PluginRuntimeChannel(SDK 承诺);这里 cast + runtime check 后再用。 */
interface MinimalTurnRuntime {
  turn?: {
    run?: (params: unknown) => Promise<unknown>;
  };
}

function getTurnRunner(
  ctx: ChannelGatewayContext<LeyemetaAccount>,
): ((params: unknown) => Promise<unknown>) | null {
  const rt = ctx.channelRuntime as MinimalTurnRuntime | undefined;
  const fn = rt?.turn?.run;
  return typeof fn === "function" ? fn.bind(rt!.turn!) : null;
}

async function handleInboundMessage(
  ctx: ChannelGatewayContext<LeyemetaAccount>,
  frame: Extract<InboundFrame, { type: "inbound.message" }>,
  client: LeyemetaWsClient,
): Promise<void> {
  const envelope = buildInboundEnvelope(ctx.accountId, frame);
  const attachmentCount = frame.payload.attachments?.length ?? 0;
  // inbound 帧不带 agentId —— 它只在握手 ready 帧出现一次,从连接级快照取出,
  // 便于排查"转发到错误智能体"。
  const ready = client.getReadyInfo();
  const agentTag = ready ? `${ready.agentId}`: "<unknown:not-ready>";
  ctx.log?.info?.(
    `inbound: agent=${agentTag} conv=${envelope.conversationId} msg=${envelope.messageId} ` +
      `from=${envelope.user.name}(${envelope.user.id}) ` +
      `attachments=${attachmentCount} ` +
      `text=${JSON.stringify(envelope.rawText.slice(0, 80))}`,
  );

  ctx.setStatus({
    accountId: ctx.accountId,
    lastInboundAt: Date.now(),
  });

  // 附件下载在 turn pipeline 之前完成,失败即 fail-fast:发 outbound.error + done:true
  // 收尾、不进 agent(平台已保证 URL 可达,失败基本是真异常,半残附件会误导回复)。
  let attachmentInjection: Awaited<ReturnType<typeof processInboundAttachments>>;
  try {
    const runtime = getLeyemetaRuntime();
    attachmentInjection = await processInboundAttachments({
      attachments: frame.payload.attachments,
      media: runtime.channel.media,
      log: ctx.log,
    });
  } catch (err) {
    if (err instanceof AttachmentDownloadError) {
      ctx.log?.warn?.(
        `attachment download failed conv=${envelope.conversationId} ` +
          `file=${err.filename}: ${describeError(err)}`,
      );
      deliverErrorToWs({
        accountId: ctx.accountId,
        conversationId: envelope.conversationId,
        code: "UPSTREAM_DOWN",
        message: `附件下载失败: ${err.filename}`,
        log: ctx.log,
      });
      // 补一帧空 done:true,让平台前端解锁输入框
      try {
        deliverTextToWs({
          accountId: ctx.accountId,
          conversationId: envelope.conversationId,
          text: "",
          done: true,
          messageId: buildAssistantMessageId(),
        });
      } catch (closeErr) {
        ctx.log?.warn?.(
          `attachment-fail close frame send failed: ${describeError(closeErr)}`,
        );
      }
      return;
    }
    // 其它错误(runtime 未初始化等)交给外层 catch
    throw err;
  }

  if (attachmentInjection.acceptedCount > 0) {
    ctx.log?.info?.(
      `attachments accepted=${attachmentInjection.acceptedCount} ` +
        `skipped=${attachmentInjection.skipped.length} ` +
        `paths=${JSON.stringify(attachmentInjection.fields.MediaPaths ?? [])}`,
    );
  }

  const runTurn = getTurnRunner(ctx);
  if (!runTurn) {
    ctx.log?.warn?.(
      "channelRuntime.turn.run not available (startup subset?); " +
        "skipping host dispatch — full integration deferred until reply pipeline wired",
    );
    return;
  }

  try {
    await runTurn({
      channel: "leyemeta",
      accountId: ctx.accountId,
      raw: envelope,
      adapter: {
        ingest: () => envelope.turnInput,
        resolveTurn: () =>
          buildPreparedChannelTurn(ctx, envelope, attachmentInjection),
      },
    });
  } catch (err) {
    ctx.log?.error?.(`turn.run failed: ${describeError(err)}`);
  }
}

function handleInboundCancel(
  ctx: ChannelGatewayContext<LeyemetaAccount>,
  frame: Extract<InboundFrame, { type: "inbound.cancel" }>,
): void {
  const conv = frame.payload.conversationId;
  ctx.log?.info?.(`cancel: conv=${conv}`);
  const turn = lookupTurn(ctx.accountId, conv);
  if (!turn) {
    // agent 已结束 / cancel 到得稍晚 / conv 写错,都不致命
    ctx.log?.debug?.(`cancel: no in-flight turn for ${conv}`);
    return;
  }
  // abort 短路 agent,close 立刻发收尾帧让前端尽早解锁(closeStream 幂等,
  // 后续 onSettled 再 close 一次也无妨)
  turn.abort("inbound.cancel");
  turn.close("cancelled");
}

/** 让 startAccount 的 promise 寿命 = channel 真正运行的寿命(见文件头说明)。 */
function waitUntilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

type LeyemetaGatewayAdapter = NonNullable<ChannelPlugin<LeyemetaAccount>["gateway"]>;

export const gateway: LeyemetaGatewayAdapter = {
  startAccount: async (ctx: ChannelGatewayContext<LeyemetaAccount>) => {
    const { account, accountId } = ctx;

    if (!account.configured) {
      ctx.log?.warn?.(
        `startAccount: account "${accountId}" not configured (missing member_key); skipping`,
      );
      await waitUntilAborted(ctx.abortSignal);
      return;
    }

    if (!account.enabled) {
      ctx.log?.info?.(`startAccount: account "${accountId}" disabled; skipping`);
      await waitUntilAborted(ctx.abortSignal);
      return;
    }

    // gateway_url 是 channel 级全局配置,所有 account 共用
    const gatewayUrl = config.resolveGatewayUrl(ctx.cfg);

    ctx.log?.info?.(`starting leyemeta[${accountId}] (gateway_url=${gatewayUrl})`);
    ctx.setStatus({
      accountId,
      enabled: true,
      configured: true,
      running: true,
      lastStartAt: Date.now(),
    });

    const transportLogger = toTransportLogger(ctx);
    const opts: WsClientOptions = {
      url: gatewayUrl,
      memberKey: account.member_key,
      accountId,
      pluginVersion: PLUGIN_VERSION,
      logger: transportLogger,
      onReady: (info) => {
        ctx.log?.info?.(
          `ready: agentId=${info.agentId} agentName=${info.agentName} ` +
            `caps=${(info.capabilities ?? []).join(",")}`,
        );
        ctx.setStatus({
          accountId,
          connected: true,
          running: true,
          lastConnectedAt: Date.now(),
        });
      },
      onMessage: (frame) => {
        // ws-client 已过滤 ready / ping,这里只剩 inbound.message / inbound.cancel
        if (frame.type === "inbound.message") {
          void handleInboundMessage(ctx, frame, client).catch((err) => {
            ctx.log?.error?.(`handleInboundMessage threw ${describeError(err)}`);
          });
        } else if (frame.type === "inbound.cancel") {
          handleInboundCancel(ctx, frame);
        } else {
          ctx.log?.warn?.(`unexpected inbound frame type: ${(frame as InboundFrame).type}`);
        }
      },
      onError: (err) => {
        ctx.log?.warn?.(`ws error: ${describeError(err)}`);
        ctx.setStatus({
          accountId,
          lastError: describeError(err),
        });
      },
      onDisconnect: ({ code, reason }) => {
        ctx.log?.info?.(
          `plugin<->platform ws disconnected code=${code} reason=${reason || "<empty>"}`,
        );
        // 信道已断,继续跑 in-flight agent 纯属烧 token,全量 abort。
        // 不调 close:收尾帧也发不出去,只会徒增 warn 日志。
        const inflight = listByAccount(accountId);
        if (inflight.length > 0) {
          ctx.log?.info?.(
            `aborting ${inflight.length} in-flight turn(s) due to ws disconnect`,
          );
          for (const turn of inflight) {
            turn.abort(`plugin<->platform ws disconnected: code=${code}`);
          }
        }
        ctx.setStatus({
          accountId,
          connected: false,
          lastDisconnect: {
            at: Date.now(),
            status: code,
            error: reason || undefined,
          },
        });
      },
    };

    const client = new LeyemetaWsClient(opts);
    registerConn(accountId, client);

    // 订阅 run 事件广播 agent 忙闲状态(见 run-watcher.ts)。ws 未 ready 时直接丢弃。
    const runWatcher = startRunWatcher((busy) => {
      const sent = client.send({
        type: "openclaw.agent.status",
        ts: Date.now(),
        payload: {
          state: busy ? "busy" : "idle",
          since: Date.now(),
        },
      });
      if (!sent) {
        ctx.log?.debug?.(
          `openclaw.agent.status ${busy ? "busy" : "idle"} dropped (ws not ready)`,
        );
      }
    });

    client.start();

    try {
      await waitUntilAborted(ctx.abortSignal);
    } finally {
      ctx.log?.info?.(`stopping leyemeta[${accountId}]`);
      // 关停顺序:先 abort 让 agent 短路(turn 在 finally 注销自己),clearAccount
      // 兜底回收,最后才 stop ws —— 保证 turn settle 时收尾帧还能借未断的信道发出。
      const inflight = listByAccount(accountId);
      if (inflight.length > 0) {
        ctx.log?.info?.(
          `aborting ${inflight.length} in-flight turn(s) on shutdown`,
        );
        for (const turn of inflight) {
          turn.abort("startAccount shutdown");
        }
      }
      clearAccount(accountId);
      runWatcher.dispose();
      await client.stop().catch(() => {});
      unregisterConn(accountId, client);
      ctx.setStatus({
        accountId,
        connected: false,
        running: false,
        lastStopAt: Date.now(),
      });
    }
  },

  // host 在 startAccount 已注册 stop 时通常不会单独调用 stopAccount;保留兜底日志。
  stopAccount: async (ctx: ChannelGatewayContext<LeyemetaAccount>) => {
    ctx.log?.info?.(`stopAccount leyemeta[${ctx.accountId}]`);
  },
};
