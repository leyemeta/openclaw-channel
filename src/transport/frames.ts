/**
 * leyemeta WebSocket 帧契约 —— JSON 文本帧,统一外壳 `{ type, id?, ts, payload }`。
 *
 * - 入站:`inbound.message` / `inbound.cancel` / `ping` / `ready`
 * - 出站:`outbound.delta` / `outbound.tool_status` / `outbound.error` / `pong`
 * - `decode` 在 type 未知或外壳不合法时抛 `FrameDecodeError`(code = INVALID_FRAME)
 *
 * 本层与 OpenClaw SDK 完全解耦,仅暴露纯 TS 类型 + 函数。
 */

// ---------- 共享附件类型 ----------

export interface InboundAttachment {
  type: string;
  url: string;
  filename?: string;
  mime?: string;
}

export interface InboundUser {
  id: string;
  name: string;
  tenantId?: string;
  permissions?: string[];
}

// ---------- 入站帧（leyemeta → 插件） ----------

export interface ReadyFramePayload {
  agentId: string;
  agentName: string;
  capabilities?: string[];
}

export interface ReadyFrame {
  type: "ready";
  id?: string;
  ts?: number;
  payload: ReadyFramePayload;
}

export interface InboundMessagePayload {
  conversationId: string;
  messageId: string;
  user: InboundUser;
  text: string;
  attachments?: InboundAttachment[];
  replyTo?: string | null;
}

export interface InboundMessageFrame {
  type: "inbound.message";
  id?: string;
  ts?: number;
  payload: InboundMessagePayload;
}

export interface InboundCancelPayload {
  conversationId: string;
}

export interface InboundCancelFrame {
  type: "inbound.cancel";
  id?: string;
  ts?: number;
  payload: InboundCancelPayload;
}

export interface PingFrame {
  type: "ping";
  id?: string;
  ts?: number;
  payload?: Record<string, unknown>;
}

export type InboundFrame =
  | ReadyFrame
  | InboundMessageFrame
  | InboundCancelFrame
  | PingFrame;

export type InboundFrameType = InboundFrame["type"];

const INBOUND_TYPES = new Set<InboundFrameType>([
  "ready",
  "inbound.message",
  "inbound.cancel",
  "ping",
]);

// ---------- 出站帧（插件 → leyemeta） ----------

export interface OutboundDeltaPayload {
  conversationId: string;
  messageId: string;
  delta: string;
  done: boolean;
}

export interface OutboundDeltaFrame {
  type: "outbound.delta";
  id?: string;
  ts?: number;
  payload: OutboundDeltaPayload;
}

export type OutboundToolStatusPhase = "running" | "success" | "error";

export interface OutboundToolStatusPayload {
  conversationId: string;
  tool: string;
  phase: OutboundToolStatusPhase;
  summary?: string;
}

export interface OutboundToolStatusFrame {
  type: "outbound.tool_status";
  id?: string;
  ts?: number;
  payload: OutboundToolStatusPayload;
}

/** 错误码短码;留 `string` 兜底允许平台后续扩展,客户端优先用已列短码。 */
export type OutboundErrorCode =
  | "UNAUTHORIZED"
  | "INVALID_FRAME"
  | "AGENT_FAILED"
  | "TOOL_TIMEOUT"
  | "RATE_LIMITED"
  | "UPSTREAM_DOWN"
  | (string & {});

export interface OutboundErrorPayload {
  conversationId: string;
  code: OutboundErrorCode;
  message: string;
}

export interface OutboundErrorFrame {
  type: "outbound.error";
  id?: string;
  ts?: number;
  payload: OutboundErrorPayload;
}

export interface PongFrame {
  type: "pong";
  id?: string;
  ts?: number;
  payload?: Record<string, unknown>;
}

export type AgentStatusState = "busy" | "idle";

export interface AgentStatusPayload {
  state: AgentStatusState;
  /** 进入该状态的时间戳(ms)。busy=首个 run 开始时刻;idle=最后一个 run 结束时刻。 */
  since: number;
}

/**
 * agent 忙闲状态广播。用 openclaw.* 命名空间区别于业务出站消息(outbound.*)。
 * 由全局 run 事件驱动,只在 0↔1 跨越时发、不做心跳重发,ws 未 ready 时直接丢弃。
 */
export interface AgentStatusFrame {
  type: "openclaw.agent.status";
  id?: string;
  ts?: number;
  payload: AgentStatusPayload;
}

export type OutboundFrame =
  | OutboundDeltaFrame
  | OutboundToolStatusFrame
  | OutboundErrorFrame
  | AgentStatusFrame
  | PongFrame;

export type OutboundFrameType = OutboundFrame["type"];

const OUTBOUND_TYPES = new Set<OutboundFrameType>([
  "outbound.delta",
  "outbound.tool_status",
  "outbound.error",
  "openclaw.agent.status",
  "pong",
]);

// ---------- 综合 ----------

export type Frame = InboundFrame | OutboundFrame;
export type FrameType = Frame["type"];

const ALL_TYPES = new Set<FrameType>([...INBOUND_TYPES, ...OUTBOUND_TYPES]);

// ---------- 编解码 ----------

/** `code` 固定为 `INVALID_FRAME`;`cause` 仅供日志,不参与帧外发(避免泄漏堆栈)。 */
export class FrameDecodeError extends Error {
  public readonly code = "INVALID_FRAME" as const;
  public override readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "FrameDecodeError";
    if (options && "cause" in options) {
      this.cause = options.cause;
    }
  }
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isFrameType(x: unknown): x is FrameType {
  return typeof x === "string" && ALL_TYPES.has(x as FrameType);
}

export function encode(frame: Frame): string {
  return JSON.stringify(frame);
}

/**
 * - 非合法 JSON / 非对象 / type 未知 → 抛 FrameDecodeError
 * - payload 仅做"是对象/可省略"的最低校验;具体字段校验交给上层,避免协议小幅扩展时强行 INVALID_FRAME
 */
export function decode(raw: string | Buffer | ArrayBuffer | Uint8Array): Frame {
  let text: string;
  if (typeof raw === "string") {
    text = raw;
  } else if (raw instanceof ArrayBuffer) {
    text = new TextDecoder("utf-8").decode(new Uint8Array(raw));
  } else if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
    text = new TextDecoder("utf-8").decode(raw);
  } else {
    throw new FrameDecodeError("frame raw must be string|Buffer|ArrayBuffer");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new FrameDecodeError("frame is not valid JSON", { cause: err });
  }

  if (!isPlainObject(parsed)) {
    throw new FrameDecodeError("frame must be a JSON object");
  }

  const { type, id, ts, payload } = parsed;

  if (!isFrameType(type)) {
    throw new FrameDecodeError(
      `unknown frame type: ${typeof type === "string" ? type : typeof type}`,
    );
  }

  if (id !== undefined && typeof id !== "string") {
    throw new FrameDecodeError("frame.id must be a string when present");
  }

  if (ts !== undefined && (typeof ts !== "number" || !Number.isFinite(ts))) {
    throw new FrameDecodeError("frame.ts must be a finite number when present");
  }

  // ping / pong 允许 payload 缺失;其它帧 payload 必须是对象
  const payloadRequired = type !== "ping" && type !== "pong";
  if (payloadRequired) {
    if (!isPlainObject(payload)) {
      throw new FrameDecodeError(`frame.payload must be an object for type=${type}`);
    }
  } else if (payload !== undefined && !isPlainObject(payload)) {
    throw new FrameDecodeError(`frame.payload must be an object when present for type=${type}`);
  }

  return parsed as unknown as Frame;
}

export function isInboundFrame(frame: Frame): frame is InboundFrame {
  return INBOUND_TYPES.has(frame.type as InboundFrameType);
}

export function isOutboundFrame(frame: Frame): frame is OutboundFrame {
  return OUTBOUND_TYPES.has(frame.type as OutboundFrameType);
}
