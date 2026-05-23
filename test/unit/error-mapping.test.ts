import { describe, expect, it } from "vitest";

import { classifyError } from "../../src/channel/error-mapping.js";

describe("classifyError", () => {
  it("AbortError 归 AGENT_FAILED + 固定 message(cancel 来源由 P1 区分)", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    const { code, message } = classifyError(err);
    expect(code).toBe("AGENT_FAILED");
    expect(message).toBe("Agent was aborted.");
  });

  it("rate limit / 429 文本 → RATE_LIMITED", () => {
    expect(classifyError(new Error("Rate limit exceeded (429)")).code).toBe(
      "RATE_LIMITED",
    );
    expect(classifyError(new Error("rate-limit hit")).code).toBe(
      "RATE_LIMITED",
    );
    expect(classifyError(new Error("HTTP 429")).code).toBe("RATE_LIMITED");
  });

  it("timeout 文本 → TOOL_TIMEOUT", () => {
    expect(classifyError(new Error("Connection timed out after 30s")).code).toBe(
      "TOOL_TIMEOUT",
    );
    expect(classifyError(new Error("upstream timeout")).code).toBe(
      "TOOL_TIMEOUT",
    );
  });

  it("默认 → AGENT_FAILED,message 用 describeError 输出", () => {
    const { code, message } = classifyError(new Error("something else"));
    expect(code).toBe("AGENT_FAILED");
    expect(message).toBe("Error: something else");
  });

  it("非 Error 值不抛(string / object / null)", () => {
    expect(() => classifyError("plain string")).not.toThrow();
    expect(() => classifyError({ weird: true })).not.toThrow();
    expect(() => classifyError(null)).not.toThrow();
    expect(classifyError("plain string").code).toBe("AGENT_FAILED");
    expect(classifyError({ weird: true }).code).toBe("AGENT_FAILED");
    expect(classifyError(null).code).toBe("AGENT_FAILED");
  });
});
