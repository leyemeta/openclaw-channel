/**
 * 入站帧 → NormalizedTurnInput 的纯转换层。规范化后由 gateway 经
 * adapter.ingest 交给 host 完成路由 / sessionKey / reply dispatch。
 *
 * SDK 的 ChannelMessagingAdapter 是出站用的 sessionKey 解析器,本场景用不到,
 * 故末尾导出 messaging = undefined。
 */

import type { InboundMessageFrame, InboundUser } from "../transport/frames.js";

/** 把用户身份 prepend 到正文,Agent 无需调工具就能正确称呼用户。 */
export function injectIdentityIntoText(text: string, user: InboundUser): string {
  const safeName = user.name?.trim() || "(未署名)";
  const safeId = user.id || "unknown";
  return `[来自 leyemeta 用户:${safeName} (${safeId})]\n${text}`;
}

/**
 * adapter.ingest 期望的 NormalizedTurnInput 形状(子集)。不直接 import SDK type,
 * 让本文件保持纯转换、字段就近可读。
 */
export interface NormalizedTurnInputLike {
  /** 平台 messageId,用于去重与日志。 */
  id: string;
  /** 平台时间戳(ms);缺失则 fallback。 */
  timestamp: number;
  /** 原始文本(不带身份注入)。 */
  rawText: string;
  /** 给 Agent 看的文本(带身份注入)。 */
  textForAgent: string;
  /** 命令检测用的文本(平台对话不走斜杠命令,与 rawText 一致)。 */
  textForCommands: string;
  /** 透传整帧给消费者(后续 reply pipeline 需要 user/conversationId 等字段)。 */
  raw: InboundMessageFrame;
}

export function buildNormalizedTurnInput(
  frame: InboundMessageFrame,
  fallbackTimestamp: number = Date.now(),
): NormalizedTurnInputLike {
  const p = frame.payload;
  const ts = typeof frame.ts === "number" && Number.isFinite(frame.ts) ? frame.ts : fallbackTimestamp;
  const textForAgent = injectIdentityIntoText(p.text ?? "", p.user);
  return {
    id: p.messageId,
    timestamp: ts,
    rawText: p.text ?? "",
    textForAgent,
    textForCommands: p.text ?? "",
    raw: frame,
  };
}

/** gateway/onMessage 一站式取用:避免在多处零散解构同一个 payload。 */
export interface InboundEnvelope {
  accountId: string;
  conversationId: string;
  messageId: string;
  user: InboundUser;
  /** 已带身份注入,可直接交给 Agent。 */
  textForAgent: string;
  /** 原始文本,后续工具/审计要用。 */
  rawText: string;
  /** 透传给 ctx.channelRuntime.turn.run 的 input。 */
  turnInput: NormalizedTurnInputLike;
}

export function buildInboundEnvelope(
  accountId: string,
  frame: InboundMessageFrame,
  fallbackTimestamp: number = Date.now(),
): InboundEnvelope {
  const p = frame.payload;
  const turnInput = buildNormalizedTurnInput(frame, fallbackTimestamp);
  return {
    accountId,
    conversationId: p.conversationId,
    messageId: p.messageId,
    user: p.user,
    textForAgent: turnInput.textForAgent,
    rawText: turnInput.rawText,
    turnInput,
  };
}

// leyemeta 场景下不需要 ChannelMessagingAdapter(target/sessionKey 解析器),plugin 不挂 messaging 字段
export const messaging = undefined;
