/**
 * 内部用 Logger 接口,形状对齐 SDK 的 `ChannelLogSink`(info/warn/error,debug 可选)。
 * 单独定义是为了让 transport 层不直接依赖 `openclaw/plugin-sdk`,便于单测 mock。
 */

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
}

export const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/** 给已有 logger 加前缀(`[prefix] msg`),便于区分多 account 日志;base 缺失某方法时退化为 noop。 */
export function withPrefix(base: Logger | undefined, prefix: string): Logger {
  const safe = base ?? noopLogger;
  const stamp = `[${prefix}]`;
  return {
    info: (msg) => safe.info(`${stamp} ${msg}`),
    warn: (msg) => safe.warn(`${stamp} ${msg}`),
    error: (msg) => safe.error(`${stamp} ${msg}`),
    debug: safe.debug ? (msg) => safe.debug?.(`${stamp} ${msg}`) : undefined,
  };
}

/** 任意 unknown 错误归一化为可读字符串(日志专用,不做敏感字段脱敏)。 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
