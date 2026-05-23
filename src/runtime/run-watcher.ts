/**
 * run-watcher —— 订阅 OpenClaw 全局 `run.started` / `run.completed` 诊断事件,
 * 维护进程级"在跑 run 数"计数器,在 0↔1 跨越时回调 listener。
 *
 * 为什么不用 in-flight 注册表:
 *   in-flight 只覆盖"经由本插件 inbound.message 进来的 turn",看不到 OpenClaw web UI
 *   直连、cron、其它 channel 等入口产生的 run。订阅诊断事件才是"agent 进程
 *   有没有在干活"的唯一权威信号源。
 *
 * 为什么用 onInternalDiagnosticEvent 而不是 onDiagnosticEvent:
 *   SDK 的 run.started / run.completed 是通过 emitTrustedDiagnosticEvent 发出的(见
 *   selection-*.js 中 embedded run 入口),而 onDiagnosticEvent 内部会过滤掉所有
 *   trusted 事件(`if (metadata.trusted || event.type === "log.record") return`),
 *   导致用户侧根本收不到 run.* 事件。必须走 onInternalDiagnosticEvent。
 *   `log.record` 这种噪音由本模块按 type 自行过滤(我们只关心 run.started / run.completed)。
 *
 * 设计要点:
 *   - 计数维度是 `runId`(SDK 保证唯一),不是 sessionKey/agentId —— 这是"该 OpenClaw 进程
 *     有没有正在跑的 run",与 conversation 维度无关。
 *   - 0→≥1 触发 busy,≥1→0 触发 idle;中间态(1→2、2→1)不触发,避免抖动。
 *   - listener 仅 set 一个(本插件一个进程只对外暴露一份 agent 状态)。
 *   - listener 抛错绝不影响订阅本身,静默吞。
 *   - dispose 返回 SDK 的退订函数;调用方在关停时务必调,避免反复 startAccount 累积 listener。
 */

import { onInternalDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";

export type BusyTransitionListener = (busy: boolean) => void;

interface RunWatcherHandle {
  /** 解除 SDK 订阅并清空内部状态。 */
  dispose: () => void;
}

/**
 * 启动一个 run watcher。多次调用会各自独立(每次都注册一个 SDK listener),
 * 调用方负责持有 handle 并在适当时机 dispose;通常 gateway.startAccount 持有一份即可。
 */
export function startRunWatcher(listener: BusyTransitionListener): RunWatcherHandle {
  const runningRuns = new Set<string>();
  let disposed = false;

  const emit = (busy: boolean): void => {
    try {
      listener(busy);
    } catch {
      // listener 抛错不应影响订阅本身
    }
  };

  const handler = (evt: DiagnosticEventPayload, _metadata: unknown): void => {
    if (disposed) return;
    // 仅关心 run.started / run.completed,其它一律忽略(包括 log.record / harness.* / model.*)
    if (evt.type === "run.started") {
      const wasEmpty = runningRuns.size === 0;
      runningRuns.add(evt.runId);
      if (wasEmpty) emit(true);
      return;
    }
    if (evt.type === "run.completed") {
      // run.completed 可能出现"未见 started 就先 completed"的极端场景(订阅时机晚于 started);
      // 此时 delete 返回 false,无视即可,绝不能据此发 idle。
      if (!runningRuns.delete(evt.runId)) return;
      if (runningRuns.size === 0) emit(false);
    }
  };

  const off = onInternalDiagnosticEvent(handler);

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      off();
      // 若 dispose 时仍有未结束的 run,语义上视作 idle —— 调用方已不再关心了。
      // 不主动 emit idle:listener 已可能解绑/上游 ws 已断,徒增噪音。
      runningRuns.clear();
    },
  };
}
