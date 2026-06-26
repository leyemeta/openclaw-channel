/**
 * leyemeta WebSocket 客户端,transport 层核心,零 OpenClaw 依赖。
 *
 * - 握手:Authorization Bearer + subprotocol,收到 `ready` 帧后进入 ready 状态
 * - 心跳:heartbeatIntervalMs(默认 30s)无入站则发 ping;任何入站重置;收 ping 回 pong
 * - 重连:前 10 次每 30s,之后每 5 分钟,无限重试(±20% 抖动);stop() 后不再重连
 *
 * 状态机:idle → connecting → open → ready ↔ open;close 后排重连回到 connecting,
 * stop() 推到 stopped 并忽略一切重连意图。
 */

import { WebSocket, type RawData } from "ws";

import {
  describeError,
  noopLogger,
  withPrefix,
  type Logger,
} from "../runtime/logger.js";

import { buildHandshake, LEYEMETA_SUBPROTOCOL } from "./auth.js";
import {
  decode,
  encode,
  FrameDecodeError,
  type Frame,
  type InboundFrame,
  type OutboundFrame,
  type ReadyFramePayload,
} from "./frames.js";

export interface WsClientOptions {
  url: string;
  memberKey: string;
  accountId: string;
  /** 注入到 `X-Plugin-Version` header。 */
  pluginVersion: string;

  logger?: Logger;

  onReady?: (info: ReadyFramePayload) => void;
  onMessage?: (frame: InboundFrame) => void;
  onError?: (err: Error) => void;
  onDisconnect?: (info: { code: number; reason: string }) => void;

  /** 单测注入 mock WebSocket 工厂;默认走 `ws` 包。 */
  webSocketFactory?: WebSocketFactory;

  reconnect?: Partial<ReconnectPolicy>;

  /** 心跳间隔(ms),默认 30s。 */
  heartbeatIntervalMs?: number;

  /** 抖动函数,默认 ±20%;单测中常注入"原样返回"以保证序列确定。 */
  jitter?: (baseMs: number) => number;
}

export type WebSocketFactory = (
  url: string,
  protocols: readonly string[],
  options: { headers: Record<string, string> },
) => WebSocketLike;

/** ws-client 用到的最小 WebSocket 表面,便于单测 mock;`ws` 与浏览器 WebSocket 都满足。 */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: RawData) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  off?: (event: string, listener: (...args: any[]) => void) => void;
  removeAllListeners?: (event?: string) => void;
}

export interface ReconnectPolicy {
  /** 前 `fastAttempts` 次重连使用的短间隔(ms)。 */
  fastMs: number;
  /** 短间隔的尝试次数;超过后切到 `slowMs`。 */
  fastAttempts: number;
  /** 长间隔(ms),用于持续重试以降低对服务端的请求频率。 */
  slowMs: number;
  /** 抖动比例 0~1,0 关闭抖动。 */
  jitterRatio: number;
  /** Infinity 表示无限重试。 */
  maxAttempts: number;
}

// 阶梯式间隔:前 10 次 30s 求快速恢复,之后切 5 分钟降低对服务端的压力。
const DEFAULT_RECONNECT: ReconnectPolicy = {
  fastMs: 30_000,
  fastAttempts: 10,
  slowMs: 300_000,
  jitterRatio: 0.2,
  maxAttempts: Number.POSITIVE_INFINITY,
};

const DEFAULT_HEARTBEAT_MS = 30_000;

type ClientState =
  | "idle"
  | "connecting"
  | "open"
  | "ready"
  | "closing"
  | "closed"
  | "stopped";

const defaultWebSocketFactory: WebSocketFactory = (url, protocols, options) => {
  return new WebSocket(url, protocols as string[], {
    headers: options.headers,
  }) as unknown as WebSocketLike;
};

export class LeyemetaWsClient {
  private readonly opts: WsClientOptions;
  private readonly logger: Logger;
  private readonly factory: WebSocketFactory;
  private readonly reconnectPolicy: ReconnectPolicy;
  private readonly heartbeatIntervalMs: number;
  private readonly jitter: (baseMs: number) => number;

  private state: ClientState = "idle";
  private ws: WebSocketLike | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private readyInfo: ReadyFramePayload | null = null;

  constructor(opts: WsClientOptions) {
    this.opts = opts;
    this.logger = withPrefix(opts.logger ?? noopLogger, `leyemeta:${opts.accountId}`);
    this.factory = opts.webSocketFactory ?? defaultWebSocketFactory;
    this.reconnectPolicy = { ...DEFAULT_RECONNECT, ...(opts.reconnect ?? {}) };
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    this.jitter = opts.jitter ?? defaultJitter(this.reconnectPolicy.jitterRatio);
  }

  getState(): ClientState {
    return this.state;
  }

  /** 收到 `ready` 后的能力快照,未握手时为 null。 */
  getReadyInfo(): ReadyFramePayload | null {
    return this.readyInfo;
  }

  /** 发起连接;若已在连/已连好则幂等。不会 throw —— 失败通过 onError + 退避重连暴露。 */
  start(): void {
    if (this.state === "stopped") {
      this.logger.warn("start() called after stop(); ignored");
      return;
    }
    if (this.state === "connecting" || this.state === "open" || this.state === "ready") {
      return;
    }
    this.openSocket();
  }

  /** 停止并取消定时器,从此不再重连。可重复调用。 */
  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    this.state = "stopped";
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    if (this.ws) {
      const ws = this.ws;
      // 摘掉原 listener,再挂一个吞错的 noop。connecting 态下 close() 会异步触发
      // 'error' 事件,缺 error listener 时 Node 会升级为 unhandled error 直接 crash。
      this.detachSocket(ws);
      try {
        ws.on("error", () => {
          // 主动停机,断开/未建连产生的 ws 错误一律丢弃
        });
      } catch {
        // 忽略
      }
      try {
        ws.close(1000, "client stop");
      } catch (err) {
        this.logger.warn(`stop: ws.close threw ${describeError(err)}`);
      }
      this.ws = null;
    }
    this.readyInfo = null;
    this.logger.info("stopped");
  }

  /**
   * 仅在 ready 状态发送,其它状态返回 false 由调用方决定排队/丢弃。
   * transport 层不缓冲,避免与 OpenClaw outbound 的出站语义重复。
   */
  send(frame: OutboundFrame): boolean {
    if (this.state !== "ready" || !this.ws) {
      this.logger.warn(`send(${frame.type}): not ready (state=${this.state}); dropped`);
      return false;
    }
    try {
      this.ws.send(encode(frame));
      return true;
    } catch (err) {
      this.logger.error(`send(${frame.type}) threw ${describeError(err)}`);
      this.emitError(err instanceof Error ? err : new Error(describeError(err)));
      return false;
    }
  }

  // ---------- 连接 ----------

  private openSocket(): void {
    const { url, memberKey, accountId, pluginVersion } = this.opts;
    const handshake = buildHandshake({ memberKey, accountId, pluginVersion });

    this.state = "connecting";
    this.logger.info(`connecting to ${memberKey} ${url} (subprotocol=${LEYEMETA_SUBPROTOCOL})`);

    let ws: WebSocketLike;
    try {
      ws = this.factory(url, handshake.protocols, { headers: handshake.headers });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(describeError(err));
      this.logger.error(`webSocketFactory threw ${describeError(e)}`);
      this.emitError(e);
      this.scheduleReconnect();
      return;
    }

    this.ws = ws;

    ws.on("open", () => this.handleOpen());
    ws.on("message", (data) => this.handleRawMessage(data));
    ws.on("close", (code, reason) => this.handleClose(code, reason));
    ws.on("error", (err) => this.handleSocketError(err));
  }

  private handleOpen(): void {
    if (this.state === "stopped") return;
    this.state = "open";
    this.logger.info("ws open; awaiting `ready` frame");
    this.armHeartbeat();
  }

  private handleRawMessage(raw: RawData): void {
    if (this.state === "stopped") return;

    let frame: Frame;
    try {
      frame = decode(raw as unknown as string | Buffer | ArrayBuffer | Uint8Array);
    } catch (err) {
      if (err instanceof FrameDecodeError) {
        this.logger.warn(`decode failed (${err.message}); ignoring frame`);
        this.emitError(err);
      } else {
        this.emitError(err instanceof Error ? err : new Error(describeError(err)));
      }
      return;
    }

    this.armHeartbeat();

    switch (frame.type) {
      case "ready":
        this.handleReady(frame.payload);
        return;
      case "ping":
        this.handlePing();
        return;
      case "inbound.message":
      case "inbound.cancel":
        if (this.state !== "ready") {
          this.logger.warn(
            `received ${frame.type} before ready; delivering anyway (state=${this.state})`,
          );
        }
        this.opts.onMessage?.(frame);
        return;
      default:
        this.logger.warn(`unexpected inbound frame type: ${(frame as Frame).type}`);
        this.emitError(new FrameDecodeError(`unexpected inbound type ${(frame as Frame).type}`));
        return;
    }
  }

  private handleReady(payload: ReadyFramePayload): void {
    this.readyInfo = payload;
    this.state = "ready";
    // 收到 ready 才算握手稳定,此时才重置退避计数(TCP 连上不算)
    this.reconnectAttempts = 0;
    this.logger.info(
      `ready: agentId=${payload.agentId} agentName=${payload.agentName} caps=${(payload.capabilities ?? []).join(",")}`,
    );
    try {
      this.opts.onReady?.(payload);
    } catch (err) {
      this.logger.error(`onReady threw ${describeError(err)}`);
    }
  }

  private handlePing(): void {
    if (!this.ws) return;
    try {
      this.ws.send(encode({ type: "pong", ts: Date.now() }));
    } catch (err) {
      this.logger.warn(`pong failed ${describeError(err)}`);
    }
  }

  private handleClose(code: number, reason: Buffer): void {
    const reasonText = reason?.toString?.() ?? "";
    this.logger.info(`ws closed code=${code} reason=${reasonText || "<empty>"}`);
    this.clearHeartbeatTimer();
    this.detachSocket(this.ws);
    this.ws = null;
    this.readyInfo = null;

    if (this.state === "stopped") return; // 主动 stop,不通知 onDisconnect

    this.state = "closed";
    try {
      this.opts.onDisconnect?.({ code, reason: reasonText });
    } catch (err) {
      this.logger.error(`onDisconnect threw ${describeError(err)}`);
    }
    this.scheduleReconnect();
  }

  private handleSocketError(err: Error): void {
    this.logger.warn(`ws error ${describeError(err)}`);
    this.emitError(err);
    // ws 'error' 通常会再触发 'close',重连交给 close 处理
  }

  private emitError(err: Error): void {
    try {
      this.opts.onError?.(err);
    } catch (cbErr) {
      this.logger.error(`onError threw ${describeError(cbErr)}`);
    }
  }

  // ---------- 心跳 ----------

  private armHeartbeat(): void {
    this.clearHeartbeatTimer();
    if (this.state === "stopped") return;
    this.heartbeatTimer = setTimeout(() => {
      if (this.state !== "open" && this.state !== "ready") return;
      try {
        this.ws?.send(encode({ type: "ping", ts: Date.now() }));
      } catch (err) {
        this.logger.warn(`heartbeat ping failed ${describeError(err)}`);
      }
      this.armHeartbeat();
    }, this.heartbeatIntervalMs);
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ---------- 重连 ----------

  private scheduleReconnect(): void {
    if (this.state === "stopped") return;
    if (this.reconnectAttempts >= this.reconnectPolicy.maxAttempts) {
      this.logger.error(
        `reconnect attempts exhausted (${this.reconnectAttempts}/${this.reconnectPolicy.maxAttempts})`,
      );
      return;
    }
    const delay = this.computeBackoffMs(this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.logger.info(
      `scheduling reconnect attempt #${this.reconnectAttempts} in ${Math.round(delay)}ms`,
    );
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.state === "stopped") return;
      this.openSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** 阶梯:attempt < fastAttempts 用 fastMs,之后用 slowMs;attempt 从 0 开始。 */
  private computeBackoffMs(attempt: number): number {
    const { fastMs, fastAttempts, slowMs } = this.reconnectPolicy;
    const base = attempt < fastAttempts ? fastMs : slowMs;
    return this.jitter(base);
  }

  private detachSocket(ws: WebSocketLike | null): void {
    if (!ws) return;
    try {
      ws.removeAllListeners?.();
    } catch {
      // 忽略
    }
  }
}

function defaultJitter(ratio: number): (baseMs: number) => number {
  if (ratio <= 0) return (b) => b;
  return (baseMs) => {
    const r = (Math.random() * 2 - 1) * ratio; // [-ratio, +ratio)
    return Math.max(0, baseMs * (1 + r));
  };
}
