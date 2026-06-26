/**
 * Agent 回复送回 leyemeta 平台的出口。
 *
 * - deliveryMode "direct":不走 OpenClaw gateway client,用自带 WS 直发
 * - sendText:host 出站 pipeline 入口,一帧 outbound.delta(done:true)
 * - deliverTextToWs:共用底座,turn-resolver 的 reply dispatcher 也走它;
 *   流式时 done:false 多帧 + 末帧 done:true,非流式时单帧 done:true
 *
 * 失败靠 throw(OutboundDeliveryResult 无 error 字段),host 据此走 retry。
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
 * 把 outbound 的 `to` 还原成 conversationId,兼容三种形态:
 * 纯 ID、规范 sessionKey(含 :direct: 标记)、其它含 : 的复合 key(取末段兜底)。
 *
 * 命中 :direct: 时取标记后的整段(不按 : 切),这样 conversationId 自身含 : 也不会
 * 被截断;且保留原始大小写,不用会转小写的 SDK parseAgentSessionKey。
 *
 * 主回复路径走 turn-resolver 的 deliver(直接用入站 conversationId),本函数只服务
 * host 出站 pipeline(sendText)的 ctx.to 解析。
 */
export function extractConversationId(to: string): string | null {
  if (!to) return null;
  const trimmed = to.trim();
  if (!trimmed) return null;

  // 规范 sessionKey:取 :direct: 之后的整段
  const markerIdx = trimmed.indexOf(DIRECT_MARKER);
  if (markerIdx !== -1) {
    const conv = trimmed.slice(markerIdx + DIRECT_MARKER.length).trim();
    return conv.length > 0 ? conv : null;
  }

  // 其它含 : 的复合 key:兜底取末段
  if (trimmed.includes(":")) {
    const segs = trimmed.split(":");
    const last = segs[segs.length - 1];
    return last && last.length > 0 ? last : null;
  }

  return trimmed; // 纯 conversationId
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

/** 共用投递底座(host pipeline 与 reply dispatcher 都走这条),失败 throw。 */
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
 * 推 outbound.error 帧给平台。永不 throw —— 在错误处理路径上再抛会陷入循环或
 * 掩盖原始错误。投递失败仅记 warn,调用方继续走 closeStream 兜底。
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
 * 推 outbound.tool_status 帧给平台。永不 throw —— 工具状态是辅助信号,投递失败
 * 不应污染主回复流,也不触碰 streaming 状态机。
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

  // OpenClaw 已按此上限合并/分块,每段都是完整出站消息
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
