import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { AddressInfo } from "node:net";

import { LEYEMETA_SUBPROTOCOL } from "../../src/transport/auth.js";
import {
  decode,
  encode,
  type Frame,
  type OutboundFrame,
} from "../../src/transport/frames.js";
import {
  LeyemetaWsClient,
  type WebSocketFactory,
  type WebSocketLike,
} from "../../src/transport/ws-client.js";

// ---------- 通用工具 ----------

function waitUntil(predicate: () => boolean, timeoutMs = 2000, intervalMs = 10): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`waitUntil timed out after ${timeoutMs}ms`));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

interface StartedServer {
  server: WebSocketServer;
  port: number;
  /** 收到的客户端 socket 列表(测试可对其 send 帧)。 */
  sockets: ServerSocket[];
  /** 每个 socket 收到的 raw 文本帧。 */
  received: string[];
  /** 客户端发起 upgrade 时的 headers / subprotocols。 */
  handshakes: { headers: Record<string, string | string[] | undefined>; protocols: string[] }[];
}

async function startServer(): Promise<StartedServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      const addr = wss.address() as AddressInfo;
      const state: StartedServer = {
        server: wss,
        port: addr.port,
        sockets: [],
        received: [],
        handshakes: [],
      };

      wss.on("connection", (ws, req) => {
        state.sockets.push(ws);
        const proto = req.headers["sec-websocket-protocol"];
        state.handshakes.push({
          headers: { ...req.headers },
          protocols:
            typeof proto === "string"
              ? proto.split(",").map((s) => s.trim())
              : Array.isArray(proto)
                ? proto
                : [],
        });
        ws.on("message", (data) => {
          state.received.push(data.toString());
        });
      });

      wss.on("error", reject);
      resolve(state);
    });
  });
}

async function stopServer(s: StartedServer): Promise<void> {
  for (const sock of s.sockets) {
    try {
      sock.terminate();
    } catch {
      // ignore
    }
  }
  await new Promise<void>((resolve) => s.server.close(() => resolve()));
}

// ---------- 真 WS server:握手 / ping-pong ----------

describe("LeyemetaWsClient · real server handshake & heartbeat", () => {
  let srv: StartedServer;

  beforeEach(async () => {
    srv = await startServer();
  });
  afterEach(async () => {
    await stopServer(srv);
  });

  it("sends Authorization, X-Plugin-Version, X-Account-Id and subprotocol", async () => {
    const client = new LeyemetaWsClient({
      url: `ws://127.0.0.1:${srv.port}`,
      memberKey: "K1_secret",
      accountId: "dev",
      pluginVersion: "1.0.0",
    });

    const ready = vi.fn();
    client.start();
    await waitUntil(() => srv.handshakes.length > 0, 2000);

    const hs = srv.handshakes[0]!;
    expect(hs.headers["authorization"]).toBe("Bearer K1_secret");
    expect(hs.headers["x-plugin-version"]).toBe("1.0.0");
    expect(hs.headers["x-account-id"]).toBe("dev");
    expect(hs.protocols).toEqual([LEYEMETA_SUBPROTOCOL]);

    // 推 ready 帧 → 客户端进入 ready
    client["opts"].onReady = ready;
    srv.sockets[0]!.send(
      encode({
        type: "ready",
        ts: 1,
        payload: { agentId: "ag_1", agentName: "客服小乐", capabilities: ["text"] },
      }),
    );
    await waitUntil(() => client.getState() === "ready", 2000);
    expect(client.getReadyInfo()).toMatchObject({ agentId: "ag_1", agentName: "客服小乐" });

    await client.stop();
  });

  it("auto-replies pong when receiving ping", async () => {
    const client = new LeyemetaWsClient({
      url: `ws://127.0.0.1:${srv.port}`,
      memberKey: "K",
      accountId: "dev",
      pluginVersion: "1.0.0",
    });
    client.start();
    await waitUntil(() => srv.sockets.length > 0, 2000);
    const sock = srv.sockets[0]!;

    // 等待 onopen 完成(server 视角下其实已建立)
    sock.send(encode({ type: "ping", ts: 1 }));

    await waitUntil(() => srv.received.some((r) => r.includes('"pong"')), 2000);
    const pong = srv.received.find((r) => r.includes('"pong"'))!;
    expect(decode(pong).type).toBe("pong");

    await client.stop();
  });

  it("delivers inbound.message via onMessage", async () => {
    const got: Frame[] = [];
    const client = new LeyemetaWsClient({
      url: `ws://127.0.0.1:${srv.port}`,
      memberKey: "K",
      accountId: "dev",
      pluginVersion: "1.0.0",
      onMessage: (f) => got.push(f),
    });
    client.start();
    await waitUntil(() => srv.sockets.length > 0, 2000);

    srv.sockets[0]!.send(
      encode({
        type: "ready",
        ts: 1,
        payload: { agentId: "ag_1", agentName: "n" },
      }),
    );
    await waitUntil(() => client.getState() === "ready", 2000);

    srv.sockets[0]!.send(
      encode({
        type: "inbound.message",
        ts: 2,
        payload: {
          conversationId: "c1",
          messageId: "m1",
          user: { id: "u1", name: "张三" },
          text: "hi",
        },
      }),
    );
    await waitUntil(() => got.length === 1, 2000);
    expect(got[0]!.type).toBe("inbound.message");

    await client.stop();
  });

  it("send() emits encoded outbound.delta on the wire", async () => {
    const client = new LeyemetaWsClient({
      url: `ws://127.0.0.1:${srv.port}`,
      memberKey: "K",
      accountId: "dev",
      pluginVersion: "1.0.0",
    });
    client.start();
    await waitUntil(() => srv.sockets.length > 0, 2000);
    srv.sockets[0]!.send(
      encode({ type: "ready", ts: 1, payload: { agentId: "a", agentName: "n" } }),
    );
    await waitUntil(() => client.getState() === "ready", 2000);

    const ok = client.send({
      type: "outbound.delta",
      payload: { conversationId: "c", messageId: "asm_1", delta: "hello", done: true },
    } satisfies OutboundFrame);
    expect(ok).toBe(true);

    await waitUntil(() => srv.received.some((r) => r.includes('"outbound.delta"')), 2000);
    const wire = srv.received.find((r) => r.includes('"outbound.delta"'))!;
    expect(decode(wire)).toMatchObject({
      type: "outbound.delta",
      payload: { delta: "hello", done: true },
    });

    await client.stop();
  });

  it("send() returns false when not yet ready", () => {
    const client = new LeyemetaWsClient({
      url: `ws://127.0.0.1:${srv.port}`,
      memberKey: "K",
      accountId: "dev",
      pluginVersion: "1.0.0",
    });
    // 没 start,直接 send
    const ok = client.send({
      type: "pong",
      ts: 0,
    });
    expect(ok).toBe(false);
  });
});

// ---------- 重连退避序列(用 fake socket + fake timers,完全确定性) ----------

interface FakeSocketHandle {
  ws: WebSocketLike;
  sent: string[];
  emitOpen: () => void;
  emitMessage: (raw: string) => void;
  emitClose: (code?: number, reason?: string) => void;
  emitError: (err: Error) => void;
}

function makeFakeSocketFactory(handles: FakeSocketHandle[]): WebSocketFactory {
  return () => {
    const listeners: Record<string, Function[]> = {};
    const sent: string[] = [];
    const ws: WebSocketLike = {
      send: (data: string) => {
        sent.push(data);
      },
      close: () => {
        // no-op:由测试主动 emitClose 模拟服务端关闭
      },
      on(event: string, cb: any) {
        (listeners[event] ??= []).push(cb);
      },
      removeAllListeners(event?: string) {
        if (event) listeners[event] = [];
        else for (const k of Object.keys(listeners)) listeners[k] = [];
      },
    };
    handles.push({
      ws,
      sent,
      emitOpen: () => listeners["open"]?.forEach((f) => f()),
      emitMessage: (raw) => listeners["message"]?.forEach((f) => f(Buffer.from(raw))),
      emitClose: (code = 1006, reason = "") =>
        listeners["close"]?.forEach((f) => f(code, Buffer.from(reason))),
      emitError: (err) => listeners["error"]?.forEach((f) => f(err)),
    });
    return ws;
  };
}

describe("LeyemetaWsClient · reconnect backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses 30s for first 10 attempts then switches to 5min, without retry cap", async () => {
    const handles: FakeSocketHandle[] = [];
    const disconnects: number[] = [];

    const client = new LeyemetaWsClient({
      url: "ws://fake",
      memberKey: "K",
      accountId: "dev",
      pluginVersion: "1.0.0",
      webSocketFactory: makeFakeSocketFactory(handles),
      jitter: (b) => b, // 关闭抖动,断言精确序列
      onDisconnect: () => disconnects.push(Date.now()),
    });

    // 行为契约:前 10 次重连间隔 30s,之后改为 5 分钟,且不设上限。
    // 这里跑 12 轮:第 1~10 轮 30s,第 11~12 轮 300s,验证阶梯切换。
    const FAST_MS = 30_000;
    const SLOW_MS = 300_000;
    const FAST_ROUNDS = 10;
    const SLOW_ROUNDS = 2;

    client.start();
    expect(handles).toHaveLength(1);

    // 让首次连"开过"再断
    handles[0]!.emitOpen();
    handles[0]!.emitClose(1006, "boom");
    expect(disconnects).toHaveLength(1);

    const totalRounds = FAST_ROUNDS + SLOW_ROUNDS;
    for (let i = 0; i < totalRounds; i++) {
      const expected = i < FAST_ROUNDS ? FAST_MS : SLOW_MS;
      const before = handles.length;
      // 不到 expected,定时器还没触发
      await vi.advanceTimersByTimeAsync(expected - 1);
      expect(
        handles.length,
        `attempt #${i + 1} should not fire before ${expected}ms`,
      ).toBe(before);
      // 跨过 expected,新建一条 fake socket
      await vi.advanceTimersByTimeAsync(2);
      expect(
        handles.length,
        `attempt #${i + 1} should fire at ${expected}ms`,
      ).toBe(before + 1);
      // 关掉新连接,触发下一轮退避
      handles[before]!.emitOpen();
      handles[before]!.emitClose(1006, "boom");
    }

    await client.stop();
  });

  it("stop() cancels pending reconnect", async () => {
    const handles: FakeSocketHandle[] = [];
    const client = new LeyemetaWsClient({
      url: "ws://fake",
      memberKey: "K",
      accountId: "dev",
      pluginVersion: "1.0.0",
      webSocketFactory: makeFakeSocketFactory(handles),
      jitter: (b) => b,
    });
    client.start();
    handles[0]!.emitOpen();
    handles[0]!.emitClose();
    // 在退避窗口内 stop —— 即使快进,也不应再开新连接
    await client.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(handles).toHaveLength(1);
  });

  it("stays in 30s fast phase across `ready` handshake while attempts < 10", async () => {
    // fast 阶段(前 10 次)attempt 计数器是否重置不影响延迟,都是 30s。
    // 这个测试锁住"前 10 次稳定 30s"的契约,防止未来回归到指数退避。
    const handles: FakeSocketHandle[] = [];
    const client = new LeyemetaWsClient({
      url: "ws://fake",
      memberKey: "K",
      accountId: "dev",
      pluginVersion: "1.0.0",
      webSocketFactory: makeFakeSocketFactory(handles),
      jitter: (b) => b,
    });

    client.start();
    handles[0]!.emitOpen();
    handles[0]!.emitClose(); // 应在 30s 后重连
    await vi.advanceTimersByTimeAsync(29_999);
    expect(handles).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(handles).toHaveLength(2);

    // 第二次断开但没收到 ready —— 仍是 30s
    handles[1]!.emitOpen();
    handles[1]!.emitClose();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(handles).toHaveLength(3);

    // 第三次握手稳定到 ready,再断时仍是 30s(契约:固定节奏)
    handles[2]!.emitOpen();
    handles[2]!.emitMessage(
      JSON.stringify({
        type: "ready",
        ts: 1,
        payload: { agentId: "a", agentName: "n" },
      }),
    );
    expect(client.getState()).toBe("ready");
    handles[2]!.emitClose();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(handles).toHaveLength(4);

    await client.stop();
  });

  // 回归测试:`ws` 模块在 connecting 状态下调用 close() 会同步抛
  //   `WebSocket was closed before the connection was established`,
  //   并异步通过 'error' 事件再次抛出。早期实现先 detachSocket 再 close,
  //   错误事件无 listener 会被 Node 升级为 unhandled error 直接 crash 进程。
  //   修复后 stop() 会在 close() 之前挂一个吞错的 noop error listener。
  it("stop() while still connecting does not crash on ws.close throwing + emitting error", async () => {
    // 自定义 fake:close() 同步抛错,然后异步触发一次 'error' 事件
    const listeners: Record<string, Function[]> = {};
    let detached = false;
    const ws: WebSocketLike = {
      send: () => {},
      close: () => {
        // 异步 emit error,模拟 ws 模块的行为
        setImmediate(() => {
          const errListeners = listeners["error"] ?? [];
          const err = new Error("WebSocket was closed before the connection was established");
          if (errListeners.length === 0) {
            // 在生产代码里 Node 会 crash;这里把缺失 listener 当致命错误暴露给测试
            throw new Error("FAIL: 'error' emitted without listener after stop()");
          }
          errListeners.forEach((f) => f(err));
        });
        throw new Error("WebSocket was closed before the connection was established");
      },
      on(event: string, cb: any) {
        (listeners[event] ??= []).push(cb);
      },
      removeAllListeners(event?: string) {
        detached = true;
        if (event) listeners[event] = [];
        else for (const k of Object.keys(listeners)) listeners[k] = [];
      },
    };

    const client = new LeyemetaWsClient({
      url: "ws://fake",
      memberKey: "K",
      accountId: "dev",
      pluginVersion: "1.0.0",
      webSocketFactory: () => ws,
    });

    client.start();
    // 不 emit open —— 保持在 connecting 状态
    expect(client.getState()).toBe("connecting");

    // stop() 应吞掉同步异常
    await client.stop();
    expect(detached).toBe(true);

    // 用真实定时器跑一遍 setImmediate,验证 emit 'error' 没有再 crash
    vi.useRealTimers();
    await new Promise<void>((resolve) => setImmediate(resolve));
    vi.useFakeTimers();
  });
});
