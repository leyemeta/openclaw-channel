import { describe, expect, it } from "vitest";

import {
  buildInboundEnvelope,
  buildNormalizedTurnInput,
  injectIdentityIntoText,
} from "../../src/channel/messaging.js";
import type { InboundMessageFrame } from "../../src/transport/frames.js";

function makeFrame(overrides: Partial<InboundMessageFrame["payload"]> = {}, ts?: number): InboundMessageFrame {
  return {
    type: "inbound.message",
    id: "msg_001",
    ts,
    payload: {
      conversationId: "conv_xxx",
      messageId: "msg_001",
      user: { id: "u_123", name: "张三" },
      text: "帮我查一下昨天的订单",
      ...overrides,
    },
  };
}

describe("injectIdentityIntoText", () => {
  it("把姓名/ID prepend 到正文(MVP 选 A)", () => {
    const out = injectIdentityIntoText("hi", { id: "u_1", name: "李四" });
    expect(out).toBe("[来自 leyemeta 用户:李四 (u_1)]\nhi");
  });

  it("空白 name 用占位符,缺 id 用 unknown", () => {
    const out = injectIdentityIntoText("hi", { id: "", name: "  " });
    expect(out).toContain("(未署名)");
    expect(out).toContain("(unknown)");
  });
});

describe("buildNormalizedTurnInput", () => {
  it("透传 messageId / 时间戳 / textForAgent 含身份注入", () => {
    const input = buildNormalizedTurnInput(makeFrame({}, 1000));
    expect(input.id).toBe("msg_001");
    expect(input.timestamp).toBe(1000);
    expect(input.rawText).toBe("帮我查一下昨天的订单");
    expect(input.textForAgent.startsWith("[来自 leyemeta 用户:张三 (u_123)]\n")).toBe(true);
    expect(input.textForCommands).toBe(input.rawText);
  });

  it("ts 缺失时用 fallback", () => {
    const input = buildNormalizedTurnInput(
      { type: "inbound.message", payload: makeFrame().payload },
      9999,
    );
    expect(input.timestamp).toBe(9999);
  });
});

describe("buildInboundEnvelope", () => {
  it("包含 accountId + user + textForAgent", () => {
    const env = buildInboundEnvelope("dev", makeFrame({}, 5000));
    expect(env.accountId).toBe("dev");
    expect(env.conversationId).toBe("conv_xxx");
    expect(env.messageId).toBe("msg_001");
    expect(env.user.id).toBe("u_123");
    expect(env.textForAgent).toContain("张三");
    expect(env.rawText).toBe("帮我查一下昨天的订单");
    expect(env.turnInput.id).toBe("msg_001");
  });
});
