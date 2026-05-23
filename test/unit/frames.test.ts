import { describe, expect, it } from "vitest";

import {
  decode,
  encode,
  FrameDecodeError,
  isInboundFrame,
  isOutboundFrame,
  type AgentStatusFrame,
  type Frame,
  type InboundMessageFrame,
  type OutboundDeltaFrame,
  type ReadyFrame,
} from "../../src/transport/frames.js";

describe("transport/frames · encode/decode round-trip", () => {
  it("ready frame round-trips", () => {
    const frame: ReadyFrame = {
      type: "ready",
      ts: 1714291200000,
      payload: {
        agentId: "ag_1",
        agentName: "客服小乐",
        capabilities: ["text", "attachments"],
      },
    };
    const wire = encode(frame);
    const back = decode(wire);
    expect(back).toEqual(frame);
    expect(isInboundFrame(back)).toBe(true);
    expect(isOutboundFrame(back)).toBe(false);
  });

  it("inbound.message round-trips with attachments", () => {
    const frame: InboundMessageFrame = {
      type: "inbound.message",
      id: "msg_a",
      ts: 1,
      payload: {
        conversationId: "conv_1",
        messageId: "msg_a",
        user: { id: "u_1", name: "张三", permissions: ["read"] },
        text: "你好",
        attachments: [
          { type: "image", url: "https://example.com/a.png", filename: "a.png", mime: "image/png" },
        ],
        replyTo: null,
      },
    };
    const back = decode(encode(frame));
    expect(back).toEqual(frame);
  });

  it("outbound.delta done=true round-trips", () => {
    const frame: OutboundDeltaFrame = {
      type: "outbound.delta",
      payload: {
        conversationId: "conv_1",
        messageId: "asm_1",
        delta: "hello",
        done: true,
      },
    };
    const back = decode(encode(frame));
    expect(back).toEqual(frame);
    expect(isOutboundFrame(back)).toBe(true);
  });

  it("openclaw.agent.status round-trips and is outbound", () => {
    const busy: AgentStatusFrame = {
      type: "openclaw.agent.status",
      ts: 1714291200000,
      payload: { state: "busy", since: 1714291200000 },
    };
    const idle: AgentStatusFrame = {
      type: "openclaw.agent.status",
      ts: 1714291300000,
      payload: { state: "idle", since: 1714291300000 },
    };
    for (const frame of [busy, idle]) {
      const back = decode(encode(frame));
      expect(back).toEqual(frame);
      expect(isOutboundFrame(back)).toBe(true);
      expect(isInboundFrame(back)).toBe(false);
    }
  });

  it("ping/pong allow missing payload", () => {
    expect(decode(encode({ type: "ping", ts: 1 }))).toMatchObject({ type: "ping" });
    expect(decode(encode({ type: "pong", ts: 1 }))).toMatchObject({ type: "pong" });
  });

  it("decodes Buffer / Uint8Array", () => {
    const wire = encode({ type: "ping", ts: 5 });
    expect(decode(Buffer.from(wire))).toMatchObject({ type: "ping", ts: 5 });
    expect(decode(new TextEncoder().encode(wire))).toMatchObject({ type: "ping", ts: 5 });
  });
});

describe("transport/frames · decode rejection", () => {
  it("rejects non-JSON input as INVALID_FRAME", () => {
    try {
      decode("not json{{");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FrameDecodeError);
      expect((err as FrameDecodeError).code).toBe("INVALID_FRAME");
    }
  });

  it("rejects unknown frame type", () => {
    expect(() => decode(JSON.stringify({ type: "totally.fake", payload: {} }))).toThrow(
      FrameDecodeError,
    );
  });

  it("rejects non-object root", () => {
    expect(() => decode(JSON.stringify(["array"]))).toThrow(FrameDecodeError);
    expect(() => decode(JSON.stringify("string"))).toThrow(FrameDecodeError);
    expect(() => decode(JSON.stringify(42))).toThrow(FrameDecodeError);
  });

  it("rejects bad id / ts types", () => {
    expect(() => decode(JSON.stringify({ type: "ping", id: 123 }))).toThrow(FrameDecodeError);
    expect(() => decode(JSON.stringify({ type: "ping", ts: "now" }))).toThrow(FrameDecodeError);
  });

  it("rejects missing payload for non-ping/pong frames", () => {
    expect(() => decode(JSON.stringify({ type: "inbound.message" }))).toThrow(FrameDecodeError);
    expect(() => decode(JSON.stringify({ type: "ready", payload: 42 }))).toThrow(FrameDecodeError);
  });
});

describe("transport/frames · type guards", () => {
  it("partitions inbound vs outbound", () => {
    const inbound: Frame = { type: "ping", ts: 0 };
    const outbound: Frame = { type: "pong", ts: 0 };
    expect(isInboundFrame(inbound)).toBe(true);
    expect(isOutboundFrame(inbound)).toBe(false);
    expect(isOutboundFrame(outbound)).toBe(true);
    expect(isInboundFrame(outbound)).toBe(false);
  });
});
