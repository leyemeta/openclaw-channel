/**
 * 监听 OpenClaw 全局 run 事件,维护进程级"在跑 run 数",仅在 0↔1 跨越时回调
 * listener(busy/idle),中间态(1↔2)不触发以避免抖动。
 *
 * 这是 agent 忙闲状态的唯一权威来源:它能看到 web UI 直连、cron 等所有入口的 run,
 * 而 in-flight 注册表只覆盖本插件 inbound.message 的 turn。
 *
 * 必须用 onInternalDiagnosticEvent —— run.started/completed 是 trusted 事件,
 * 公开的 onDiagnosticEvent 会把它们连同 log.record 一起过滤掉。
 */

import { onInternalDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";

export type BusyTransitionListener = (busy: boolean) => void;

interface RunWatcherHandle {
  /** 解除 SDK 订阅并清空内部状态。 */
  dispose: () => void;
}

/**
 * 启动一个 run watcher;每次调用独立注册一个 SDK listener。调用方需持有 handle
 * 并在关停时 dispose,否则重复 startAccount 会累积 listener。
 */
export function startRunWatcher(listener: BusyTransitionListener): RunWatcherHandle {
  const runningRuns = new Set<string>();
  let disposed = false;

  const emit = (busy: boolean): void => {
    try {
      listener(busy);
    } catch {
      // listener 抛错不影响订阅本身
    }
  };

  const handler = (evt: DiagnosticEventPayload, _metadata: unknown): void => {
    if (disposed) return;
    if (evt.type === "run.started") {
      const wasEmpty = runningRuns.size === 0;
      runningRuns.add(evt.runId);
      if (wasEmpty) emit(true);
      return;
    }
    if (evt.type === "run.completed") {
      // delete 返回 false 说明没见过对应的 started(订阅晚于它),据此发 idle 会误报
      if (!runningRuns.delete(evt.runId)) return;
      if (runningRuns.size === 0) emit(false);
    }
    // 其它事件(log.record / harness.* / model.* 等)一律忽略
  };

  const off = onInternalDiagnosticEvent(handler);

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      off();
      // 不补发 idle:此时 listener 多半已解绑、ws 已断,补发只是噪音
      runningRuns.clear();
    },
  };
}
