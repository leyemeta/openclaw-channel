import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  emitTrustedDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "openclaw/plugin-sdk/diagnostic-runtime";

import { startRunWatcher } from "../../src/runtime/run-watcher.js";

// 用 emitTrustedDiagnosticEvent 模拟真实 SDK 路径:SDK 在 embedded run 入口(selection-*.js)
// 通过 emitTrustedDiagnosticEvent 派发 run.started / run.completed,onDiagnosticEvent 会过滤掉
// 它们,只有 onInternalDiagnosticEvent 能收到。run-watcher 选用 internal 订阅就是为此。
function emitRunStarted(runId: string, extra: Record<string, unknown> = {}): void {
  emitTrustedDiagnosticEvent({
    type: "run.started",
    runId,
    ...extra,
  } as never);
}

function emitRunCompleted(runId: string, extra: Record<string, unknown> = {}): void {
  emitTrustedDiagnosticEvent({
    type: "run.completed",
    runId,
    durationMs: 1,
    outcome: "completed",
    ...extra,
  } as never);
}

describe("run-watcher · busy/idle on 0↔1 run-count transitions", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
  });

  it("first run.started 触发 busy=true, last run.completed 触发 idle=false", () => {
    const events: boolean[] = [];
    const handle = startRunWatcher((busy) => events.push(busy));

    emitRunStarted("r1");
    expect(events).toEqual([true]);

    emitRunCompleted("r1");
    expect(events).toEqual([true, false]);

    handle.dispose();
  });

  it("并发 run 中间态不触发", () => {
    const events: boolean[] = [];
    const handle = startRunWatcher((busy) => events.push(busy));

    emitRunStarted("r1"); // 0→1: busy
    emitRunStarted("r2"); // 1→2: silent
    emitRunStarted("r3"); // 2→3: silent
    emitRunCompleted("r2"); // 3→2: silent
    emitRunCompleted("r3"); // 2→1: silent
    emitRunCompleted("r1"); // 1→0: idle

    expect(events).toEqual([true, false]);
    handle.dispose();
  });

  it("未见 run.started 的 run.completed 不会误发 idle", () => {
    const events: boolean[] = [];
    const handle = startRunWatcher((busy) => events.push(busy));

    // 边界:订阅时机晚于 started,直接看到 completed
    emitRunCompleted("ghost");
    expect(events).toEqual([]);

    // 真实流程仍能正常工作
    emitRunStarted("r1");
    emitRunCompleted("r1");
    expect(events).toEqual([true, false]);

    handle.dispose();
  });

  it("listener 抛错不影响后续派发", () => {
    let calls = 0;
    const handle = startRunWatcher(() => {
      calls += 1;
      throw new Error("boom");
    });

    expect(() => emitRunStarted("r1")).not.toThrow();
    expect(() => emitRunCompleted("r1")).not.toThrow();
    expect(calls).toBe(2);

    handle.dispose();
  });

  it("dispose 后不再回调,且重复 dispose 安全", () => {
    const events: boolean[] = [];
    const handle = startRunWatcher((busy) => events.push(busy));

    emitRunStarted("r1");
    handle.dispose();
    emitRunCompleted("r1"); // dispose 后不应再触发
    emitRunStarted("r2");

    expect(events).toEqual([true]);
    expect(() => handle.dispose()).not.toThrow();
  });

  it("dispose 后再 startRunWatcher,新 watcher 从 0 起算", () => {
    const ev1: boolean[] = [];
    const h1 = startRunWatcher((b) => ev1.push(b));
    emitRunStarted("r1");
    expect(ev1).toEqual([true]);
    h1.dispose();
    // r1 仍在 SDK 看来是"未结束",但 watcher 已弃用 —— 新 watcher 与之无关
    const ev2: boolean[] = [];
    const h2 = startRunWatcher((b) => ev2.push(b));
    emitRunCompleted("r1"); // 新 watcher 没见过 r1 started,应忽略
    expect(ev2).toEqual([]);
    emitRunStarted("r2");
    expect(ev2).toEqual([true]);
    h2.dispose();
  });
});
