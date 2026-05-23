/**
 * 错误分类器:把内部错误归类到 outbound.error 的 code + message。
 *
 * 出现位置:turn-resolver 的 deliver onError 回调、runDispatch outer catch。
 * 扩展:新增错误码只改这一个文件,不要把分类逻辑撒到各处错误源。
 *
 * 注意:本批暂不区分 cancel 来源 —— AbortError 一律归 AGENT_FAILED。
 * 等 cancel-source plumbing(P1)真正完成后,在 hint.source 上扩展即可。
 */

import type { OutboundErrorCode } from "../transport/frames.js";
import { describeError } from "../runtime/logger.js";

export interface ClassifyHint {
  source?: "deliver" | "dispatch";
}

export interface ClassifiedError {
  code: OutboundErrorCode;
  message: string;
}

const RE_RATE_LIMIT = /rate.?limit|\b429\b/i;
const RE_TIMEOUT = /timeout\b|timed out/i;

function isAbortError(err: unknown): boolean {
  if (err && typeof err === "object" && "name" in err) {
    return (err as { name?: unknown }).name === "AbortError";
  }
  return false;
}

function extractText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return describeError(err);
}

export function classifyError(
  err: unknown,
  _hint?: ClassifyHint,
): ClassifiedError {
  if (isAbortError(err)) {
    return { code: "AGENT_FAILED", message: "Agent was aborted." };
  }

  const text = extractText(err);

  if (RE_RATE_LIMIT.test(text)) {
    return {
      code: "RATE_LIMITED",
      message: "Upstream rate limit hit, please retry shortly.",
    };
  }

  if (RE_TIMEOUT.test(text)) {
    return {
      code: "TOOL_TIMEOUT",
      message: "A tool or upstream call timed out.",
    };
  }

  return { code: "AGENT_FAILED", message: describeError(err) };
}
