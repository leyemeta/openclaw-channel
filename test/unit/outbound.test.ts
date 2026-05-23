import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deliverErrorToWs,
  deliverToolStatusToWs,
  extractConversationId,
  outbound,
} from "../../src/channel/outbound.js";
import {
  _resetConnsForTest,
  registerConn,
} from "../../src/runtime/context.js";
import type { LeyemetaWsClient } from "../../src/transport/ws-client.js";

describe("extractConversationId", () => {
  it("纯 conversationId 直接通过", () => {
    expect(extractConversationId("conv_xxx")).toBe("conv_xxx");
  });

  it("拆 sessionKey leyemeta/<acc>/<conv>", () => {
    expect(extractConversationId("leyemeta/dev/conv_xxx")).toBe("conv_xxx");
  });

  it("空字符串返回 null", () => {
    expect(extractConversationId("")).toBeNull();
    expect(extractConversationId("   ")).toBeNull();
  });

  it("含 ':' 的复合取最后一段(预留语法)", () => {
    expect(extractConversationId("acc:cs:conv_99")).toBe("conv_99");
  });
});

describe("outbound.sendText", () => {
  beforeEach(() => {
    _resetConnsForTest();
  });

  afterEach(() => {
    _resetConnsForTest();
    vi.restoreAllMocks();
  });

  function fakeReadyClient(send: (frame: unknown) => boolean = () => true): LeyemetaWsClient {
    return {
      send,
      getState: () => "ready",
      stop: async () => {},
      // 其它字段对 outbound 不重要
    } as unknown as LeyemetaWsClient;
  }

  it("拒绝缺 accountId 的调用", async () => {
    await expect(
      outbound.sendText!({ cfg: {} as never, to: "conv_x", text: "hi" }),
    ).rejects.toThrow(/accountId is required/);
  });

  it("找不到连接时抛错", async () => {
    await expect(
      outbound.sendText!({
        cfg: {} as never,
        to: "conv_x",
        text: "hi",
        accountId: "dev",
      }),
    ).rejects.toThrow(/no active connection/);
  });

  it("成功发送 outbound.delta(done:true) 帧", async () => {
    const sent: unknown[] = [];
    const client = fakeReadyClient((frame) => {
      sent.push(frame);
      return true;
    });
    registerConn("dev", client);

    const result = await outbound.sendText!({
      cfg: {} as never,
      to: "conv_xxx",
      text: "你好",
      accountId: "dev",
    });

    expect(result.channel).toBe("leyemeta");
    expect(result.conversationId).toBe("conv_xxx");
    expect(result.messageId).toMatch(/^asm_/);
    expect(sent).toHaveLength(1);
    const frame = sent[0] as { type: string; payload: { conversationId: string; messageId: string; delta: string; done: boolean } };
    expect(frame.type).toBe("outbound.delta");
    expect(frame.payload.conversationId).toBe("conv_xxx");
    expect(frame.payload.delta).toBe("你好");
    expect(frame.payload.done).toBe(true);
    expect(frame.payload.messageId).toBe(result.messageId);
  });

  it("client.send 返回 false 时抛错(transport 未 ready)", async () => {
    const client = {
      send: () => false,
      getState: () => "connecting",
      stop: async () => {},
    } as unknown as LeyemetaWsClient;
    registerConn("dev", client);

    await expect(
      outbound.sendText!({
        cfg: {} as never,
        to: "conv_xxx",
        text: "hi",
        accountId: "dev",
      }),
    ).rejects.toThrow(/ws not ready/);
  });

  it("通过 sessionKey 形式的 to 也能拆出 conversationId", async () => {
    const sent: unknown[] = [];
    const client = fakeReadyClient((frame) => {
      sent.push(frame);
      return true;
    });
    registerConn("dev", client);

    const result = await outbound.sendText!({
      cfg: {} as never,
      to: "leyemeta/dev/conv_42",
      text: "x",
      accountId: "dev",
    });
    expect(result.conversationId).toBe("conv_42");
  });
});

describe("deliverErrorToWs", () => {
  beforeEach(() => {
    _resetConnsForTest();
  });

  afterEach(() => {
    _resetConnsForTest();
    vi.restoreAllMocks();
  });

  function fakeReadyClient(send: (frame: unknown) => boolean = () => true): LeyemetaWsClient {
    return {
      send,
      getState: () => "ready",
      stop: async () => {},
    } as unknown as LeyemetaWsClient;
  }

  it("成功投递 outbound.error 帧", () => {
    const sent: unknown[] = [];
    const client = fakeReadyClient((frame) => {
      sent.push(frame);
      return true;
    });
    registerConn("dev", client);

    deliverErrorToWs({
      accountId: "dev",
      conversationId: "conv_xxx",
      code: "AGENT_FAILED",
      message: "boom",
    });

    expect(sent).toHaveLength(1);
    const frame = sent[0] as {
      type: string;
      payload: { conversationId: string; code: string; message: string };
    };
    expect(frame.type).toBe("outbound.error");
    expect(frame.payload.conversationId).toBe("conv_xxx");
    expect(frame.payload.code).toBe("AGENT_FAILED");
    expect(frame.payload.message).toBe("boom");
  });

  it("无 conn 时不抛,log.warn 被调一次", () => {
    const warn = vi.fn();
    expect(() =>
      deliverErrorToWs({
        accountId: "dev",
        conversationId: "conv_xxx",
        code: "AGENT_FAILED",
        message: "boom",
        log: { info: () => {}, warn, error: () => {} },
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("client.send 返回 false 时不抛,log.warn 被调一次", () => {
    const warn = vi.fn();
    const client = fakeReadyClient(() => false);
    registerConn("dev", client);

    expect(() =>
      deliverErrorToWs({
        accountId: "dev",
        conversationId: "conv_xxx",
        code: "RATE_LIMITED",
        message: "slow down",
        log: { info: () => {}, warn, error: () => {} },
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("不传 log 时,无 conn / send false 也完全静默不抛", () => {
    // 无 conn
    expect(() =>
      deliverErrorToWs({
        accountId: "dev",
        conversationId: "conv_xxx",
        code: "AGENT_FAILED",
        message: "boom",
      }),
    ).not.toThrow();

    // send false
    const client = fakeReadyClient(() => false);
    registerConn("dev", client);
    expect(() =>
      deliverErrorToWs({
        accountId: "dev",
        conversationId: "conv_xxx",
        code: "AGENT_FAILED",
        message: "boom",
      }),
    ).not.toThrow();
  });
});

describe("deliverToolStatusToWs", () => {
  beforeEach(() => {
    _resetConnsForTest();
  });

  afterEach(() => {
    _resetConnsForTest();
    vi.restoreAllMocks();
  });

  function fakeReadyClient(send: (frame: unknown) => boolean = () => true): LeyemetaWsClient {
    return {
      send,
      getState: () => "ready",
      stop: async () => {},
    } as unknown as LeyemetaWsClient;
  }

  it("成功投递 outbound.tool_status running 帧(含 summary)", () => {
    const sent: unknown[] = [];
    const client = fakeReadyClient((frame) => {
      sent.push(frame);
      return true;
    });
    registerConn("dev", client);

    deliverToolStatusToWs({
      accountId: "dev",
      conversationId: "conv_xxx",
      tool: "web_search",
      phase: "running",
      summary: "正在查询...",
    });

    expect(sent).toHaveLength(1);
    const frame = sent[0] as {
      type: string;
      payload: { conversationId: string; tool: string; phase: string; summary?: string };
    };
    expect(frame.type).toBe("outbound.tool_status");
    expect(frame.payload.conversationId).toBe("conv_xxx");
    expect(frame.payload.tool).toBe("web_search");
    expect(frame.payload.phase).toBe("running");
    expect(frame.payload.summary).toBe("正在查询...");
  });

  it("不传 summary 时 payload.summary 缺省(不写空串)", () => {
    const sent: unknown[] = [];
    const client = fakeReadyClient((frame) => {
      sent.push(frame);
      return true;
    });
    registerConn("dev", client);

    deliverToolStatusToWs({
      accountId: "dev",
      conversationId: "conv_xxx",
      tool: "web_search",
      phase: "running",
    });

    const frame = sent[0] as { payload: Record<string, unknown> };
    expect("summary" in frame.payload).toBe(false);
  });

  it("缺 tool 时不抛、不发帧,log.warn 一次", () => {
    const warn = vi.fn();
    const client = fakeReadyClient(() => {
      throw new Error("should not be called");
    });
    registerConn("dev", client);

    expect(() =>
      deliverToolStatusToWs({
        accountId: "dev",
        conversationId: "conv_xxx",
        tool: "",
        phase: "running",
        log: { info: () => {}, warn, error: () => {} },
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("无 conn 时不抛,log.warn 一次", () => {
    const warn = vi.fn();
    expect(() =>
      deliverToolStatusToWs({
        accountId: "dev",
        conversationId: "conv_xxx",
        tool: "web_search",
        phase: "running",
        log: { info: () => {}, warn, error: () => {} },
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("client.send 返回 false 时不抛,log.warn 一次", () => {
    const warn = vi.fn();
    const client = fakeReadyClient(() => false);
    registerConn("dev", client);

    expect(() =>
      deliverToolStatusToWs({
        accountId: "dev",
        conversationId: "conv_xxx",
        tool: "web_search",
        phase: "running",
        log: { info: () => {}, warn, error: () => {} },
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("client.send 抛错时不抛,log.warn 一次", () => {
    const warn = vi.fn();
    const client = fakeReadyClient(() => {
      throw new Error("ws boom");
    });
    registerConn("dev", client);

    expect(() =>
      deliverToolStatusToWs({
        accountId: "dev",
        conversationId: "conv_xxx",
        tool: "web_search",
        phase: "running",
        log: { info: () => {}, warn, error: () => {} },
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("不传 log 时,异常路径完全静默", () => {
    // 无 conn
    expect(() =>
      deliverToolStatusToWs({
        accountId: "dev",
        conversationId: "conv_xxx",
        tool: "web_search",
        phase: "running",
      }),
    ).not.toThrow();

    // send 抛错
    const client = fakeReadyClient(() => {
      throw new Error("ws boom");
    });
    registerConn("dev", client);
    expect(() =>
      deliverToolStatusToWs({
        accountId: "dev",
        conversationId: "conv_xxx",
        tool: "web_search",
        phase: "running",
      }),
    ).not.toThrow();
  });
});
