/**
 * outbound —— Agent 回复送回 leyemeta 平台的出口。
 *
 * 约定:
 *   - `deliveryMode: "direct"` —— 不走 OpenClaw gateway client,使用自带 WS 直发
 *   - `sendText` —— host 出站 pipeline 入口,文本一帧 `outbound.delta(done:true)` 发出
 *   - `deliverTextToWs` —— 复用底座,turn-resolver 的 reply dispatcher deliver 回调也走它
 *     · 流式分片:`done:false` 多次发,最后一帧 `done:true`(可为空 delta 仅作收尾)
 *     · 非流式:单帧 `done:true` 一次性发完
 *
 * `to` 字段:sessionKey 形如 `leyemeta/<accountId>/<conversationId>`,host 通常会回填为
 *   conversationId 本身;`extractConversationId` 做双重保险(纯 ID / sessionKey / 含 `:` 复合)。
 *
 * 失败处理:OpenClaw `OutboundDeliveryResult` 无 error 字段(失败靠 throw),
 *   所以 ws 未就绪 / conversationId 解析失败时直接 throw,host 会走 retry 路径。
 */

import type {
  ChannelOutboundAdapter,
  ChannelOutboundContext,
} from "openclaw/plugin-sdk/channel-contract";

import { getConn } from "../runtime/context.js";
import type { Logger } from "../runtime/logger.js";
import { describeError } from "../runtime/logger.js";
import type {
  OutboundDeltaFrame,
  OutboundErrorCode,
  OutboundErrorFrame,
  OutboundToolStatusFrame,
  OutboundToolStatusPhase,
} from "../transport/frames.js";

/** dmScope 隔离下,sessionKey 形如 `agent:<id>:direct:<conv>` 或
 *  `agent:<id>:<channel>:direct:<conv>`,conversationId 紧跟此标记之后。 */
const DIRECT_MARKER = ":direct:";

/**
 * 把 outbound 的 `to` 字段还原成 conversationId。兼容:
 *   1. `conv_xxx`                          —— 平台 conversationId(纯 ID),直接用
 *   2. `agent:<id>:direct:<conv>`          —— dmScope=per-peer 的规范 sessionKey
 *   3. `agent:<id>:<channel>:direct:<conv>`—— dmScope=per-(account-)channel-peer
 *   4. 其它含 `:` 的复合(预留语法)       —— 取最后一段兜底
 *
 * 重要:命中 `:direct:` 时取标记后**全部内容**(不再按 `:` 切末段),
 *   这样即便平台 conversationId 自身含 `:` 也不会被截断;同时保留原始大小写
 *   (不用 SDK parseAgentSessionKey —— 它会把 key 转小写,可能改坏含字母的 conv)。
 *
 * 注:当前回复主路径走 turn-resolver 的 deliver,直接用入站 envelope.conversationId,
 *   不经过本函数;本函数服务于 host 出站 pipeline(sendText)的 `ctx.to` 解析。
 */
export function extractConversationId(to: string): string | null {
  if (!to) return null;
  const trimmed = to.trim();
  if (!trimmed) return null;

  // 规范 sessionKey:取 `:direct:` 之后的整段(含大小写、含内部任意字符)
  const markerIdx = trimmed.indexOf(DIRECT_MARKER);
  if (markerIdx !== -1) {
    const conv = trimmed.slice(markerIdx + DIRECT_MARKER.length).trim();
    return conv.length > 0 ? conv : null;
  }

  // 其它含 `:` 的复合 key(预留语法 / 非 direct 形态):兜底取末段
  if (trimmed.includes(":")) {
    const segs = trimmed.split(":");
    const last = segs[segs.length - 1];
    return last && last.length > 0 ? last : null;
  }

  // 纯 conversationId,直接用
  return trimmed;
}

/** 时间戳 + 随机段;不引入 nanoid 之类的依赖。后续若要严格幂等可换 ULID。 */
export function buildAssistantMessageId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, "0");
  return `asm_${ts}_${rand}`;
}

export interface DeliverTextToWsParams {
  accountId: string;
  conversationId: string;
  text: string;
  /** 一次性发完整文本传 true;后续流式分片传 false,最后一帧 true。 */
  done: boolean;
  /** 复用现有 assistantMessageId(同 conversation 多帧场景);缺省自动生成。 */
  messageId?: string;
}

export interface DeliverTextToWsResult {
  messageId: string;
  conversationId: string;
  timestamp: number;
}

/**
 * 共用的 outbound 投递底座:host outbound pipeline 和 reply dispatcher 都走这条。
 * 失败 throw,调用方负责决定重试或放行。
 */
export function deliverTextToWs(params: DeliverTextToWsParams): DeliverTextToWsResult {
  const { accountId, conversationId, text, done } = params;

  if (!accountId) {
    throw new Error("leyemeta outbound: accountId is required");
  }
  if (!conversationId) {
    throw new Error("leyemeta outbound: conversationId is required");
  }

  const conn = getConn(accountId);
  if (!conn) {
    throw new Error(
      `leyemeta outbound: no active connection for account "${accountId}" (gateway may not have started or is reconnecting)`,
    );
  }

  const messageId = params.messageId ?? buildAssistantMessageId();
  const frame: OutboundDeltaFrame = {
    type: "outbound.delta",
    ts: Date.now(),
    payload: {
      conversationId,
      messageId,
      delta: text,
      done,
    },
  };

  const ok = conn.send(frame);
  if (!ok) {
    throw new Error(
      `leyemeta outbound: ws not ready for account "${accountId}" (state=${conn.getState()})`,
    );
  }

  return {
    messageId,
    conversationId,
    timestamp: frame.ts ?? Date.now(),
  };
}

export interface DeliverErrorToWsParams {
  accountId: string;
  conversationId: string;
  code: OutboundErrorCode;
  message: string;
  /** 投递失败时写一行 warn;缺省静默。turn-resolver 调用时传 ctx.log。 */
  log?: Logger;
}

/**
 * 把 outbound.error 帧推给平台。**永不 throw** —— 错误处理路径上,
 * 任何抛出都会触发新的错误处理,容易陷入循环或掩盖原始错误。
 *
 * 投递失败时(无 conn / ws 未 ready / send 抛错)仅记 warn,
 * 调用方继续走原有 closeStream 兜底。
 */
export function deliverErrorToWs(params: DeliverErrorToWsParams): void {
  const { accountId, conversationId, code, message, log } = params;

  if (!accountId || !conversationId) {
    log?.warn?.(
      `leyemeta outbound.error: missing accountId or conversationId (account="${accountId}", conv="${conversationId}")`,
    );
    return;
  }

  const conn = getConn(accountId);
  if (!conn) {
    log?.warn?.(
      `leyemeta outbound.error: no active connection for account "${accountId}" (code=${code})`,
    );
    return;
  }

  const frame: OutboundErrorFrame = {
    type: "outbound.error",
    ts: Date.now(),
    payload: { conversationId, code, message },
  };

  try {
    const ok = conn.send(frame);
    if (!ok) {
      log?.warn?.(
        `leyemeta outbound.error: ws not ready for account "${accountId}" (state=${conn.getState()}, code=${code})`,
      );
    }
  } catch (err) {
    log?.warn?.(
      `leyemeta outbound.error: send threw (account="${accountId}", code=${code}): ${describeError(err)}`,
    );
  }
}

export interface DeliverToolStatusToWsParams {
  accountId: string;
  conversationId: string;
  tool: string;
  phase: OutboundToolStatusPhase;
  summary?: string;
  /** 投递失败时写一行 warn;缺省静默。turn-resolver 调用时传 ctx.log。 */
  log?: Logger;
}

/**
 * 把 outbound.tool_status 帧推给平台。**永不 throw** ——
 * 工具状态是辅助信号,投递失败不应该污染主回复流。
 *
 * 与 deliverErrorToWs 同款"信道未就绪就静默 warn"策略;
 * 与 deliverTextToWs 区别:这里不影响 streamingActive/streamClosed 状态机。
 */
export function deliverToolStatusToWs(params: DeliverToolStatusToWsParams): void {
  const { accountId, conversationId, tool, phase, summary, log } = params;

  if (!accountId || !conversationId || !tool) {
    log?.warn?.(
      `leyemeta outbound.tool_status: missing field (account="${accountId}", conv="${conversationId}", tool="${tool}")`,
    );
    return;
  }

  const conn = getConn(accountId);
  if (!conn) {
    log?.warn?.(
      `leyemeta outbound.tool_status: no active connection for account "${accountId}" (tool=${tool}, phase=${phase})`,
    );
    return;
  }

  const frame: OutboundToolStatusFrame = {
    type: "outbound.tool_status",
    ts: Date.now(),
    payload: {
      conversationId,
      tool,
      phase,
      ...(summary ? { summary } : {}),
    },
  };

  try {
    const ok = conn.send(frame);
    if (!ok) {
      log?.warn?.(
        `leyemeta outbound.tool_status: ws not ready for account "${accountId}" (state=${conn.getState()}, tool=${tool}, phase=${phase})`,
      );
    }
  } catch (err) {
    log?.warn?.(
      `leyemeta outbound.tool_status: send threw (account="${accountId}", tool=${tool}, phase=${phase}): ${describeError(err)}`,
    );
  }
}

export const outbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",

  // OpenClaw 已按 textChunkLimit 合并/分块;每段都是一条完整出站消息,
  // 同 conversation 共用 messageId 便于平台侧拼接(MVP done=true)。
  textChunkLimit: 4000,

  sendText: async (ctx: ChannelOutboundContext) => {
    const accountId = ctx.accountId ?? "";
    if (!accountId) {
      throw new Error("leyemeta outbound: ctx.accountId is required");
    }

    const conversationId = extractConversationId(ctx.to);
    if (!conversationId) {
      throw new Error(
        `leyemeta outbound: cannot derive conversationId from to="${ctx.to}"`,
      );
    }

    const result = deliverTextToWs({
      accountId,
      conversationId,
      text: ctx.text,
      done: true,
    });

    return {
      channel: "leyemeta",
      messageId: result.messageId,
      conversationId: result.conversationId,
      timestamp: result.timestamp,
    };
  },
};
