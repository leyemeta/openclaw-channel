import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _resetInFlightForTest,
  clearAccount,
  listByAccount,
  lookupTurn,
  registerTurn,
  unregisterTurn,
  type InFlightTurn,
} from "../../src/runtime/in-flight.js";

function makeTurn(label: string): InFlightTurn & {
  label: string;
  abortCalls: string[];
  closeCalls: Array<"cancelled" | "disconnected" | "shutdown">;
} {
  const abortCalls: string[] = [];
  const closeCalls: Array<"cancelled" | "disconnected" | "shutdown"> = [];
  return {
    label,
    abortCalls,
    closeCalls,
    abort: (reason) => {
      abortCalls.push(reason);
    },
    close: (reason) => {
      closeCalls.push(reason);
    },
  };
}

describe("in-flight turn registry", () => {
  afterEach(() => {
    _resetInFlightForTest();
  });

  it("register/lookup/unregister 基本路径", () => {
    const t = makeTurn("a");
    registerTurn("acc1", "conv1", t);

    expect(lookupTurn("acc1", "conv1")).toBe(t);
    expect(listByAccount("acc1")).toEqual([t]);

    unregisterTurn("acc1", "conv1", t);
    expect(lookupTurn("acc1", "conv1")).toBeUndefined();
    expect(listByAccount("acc1")).toEqual([]);
  });

  it("同 (accountId, conversationId) 重复注册 → 旧 turn 被 abort 并顶替", () => {
    const oldTurn = makeTurn("old");
    const newTurn = makeTurn("new");
    registerTurn("acc1", "conv1", oldTurn);
    registerTurn("acc1", "conv1", newTurn);

    expect(oldTurn.abortCalls).toEqual(["superseded by new in-flight turn"]);
    expect(lookupTurn("acc1", "conv1")).toBe(newTurn);
  });

  it("旧 turn abort 抛错不阻塞新 turn 注册", () => {
    const oldTurn = makeTurn("old");
    oldTurn.abort = () => {
      throw new Error("boom");
    };
    const newTurn = makeTurn("new");
    registerTurn("acc1", "conv1", oldTurn);

    expect(() => registerTurn("acc1", "conv1", newTurn)).not.toThrow();
    expect(lookupTurn("acc1", "conv1")).toBe(newTurn);
  });

  it("accountId 之间相互隔离", () => {
    const a = makeTurn("a");
    const b = makeTurn("b");
    registerTurn("acc1", "conv1", a);
    registerTurn("acc2", "conv1", b);

    expect(lookupTurn("acc1", "conv1")).toBe(a);
    expect(lookupTurn("acc2", "conv1")).toBe(b);
    expect(listByAccount("acc1")).toEqual([a]);
    expect(listByAccount("acc2")).toEqual([b]);
  });

  it("listByAccount 返回快照,迭代过程中注销不受影响", () => {
    const t1 = makeTurn("t1");
    const t2 = makeTurn("t2");
    registerTurn("acc1", "conv1", t1);
    registerTurn("acc1", "conv2", t2);

    const snapshot = listByAccount("acc1");
    expect(snapshot).toHaveLength(2);

    // 模拟一边迭代一边由 finally 注销自己
    for (const turn of snapshot) {
      const cid = turn === t1 ? "conv1" : "conv2";
      unregisterTurn("acc1", cid, turn);
    }
    expect(listByAccount("acc1")).toEqual([]);
  });

  it("unregisterTurn 指定 turn 不匹配时不删除(防 finally 误删新 turn)", () => {
    const oldTurn = makeTurn("old");
    const newTurn = makeTurn("new");
    registerTurn("acc1", "conv1", oldTurn);
    registerTurn("acc1", "conv1", newTurn); // 新 turn 顶替

    // 旧 turn 的 finally 来注销自己,但此时已经是 newTurn 注册中,应该不动
    unregisterTurn("acc1", "conv1", oldTurn);
    expect(lookupTurn("acc1", "conv1")).toBe(newTurn);

    unregisterTurn("acc1", "conv1", newTurn);
    expect(lookupTurn("acc1", "conv1")).toBeUndefined();
  });

  it("unregisterTurn 不传 turn 参数 → 无条件删除", () => {
    const t = makeTurn("t");
    registerTurn("acc1", "conv1", t);
    unregisterTurn("acc1", "conv1");
    expect(lookupTurn("acc1", "conv1")).toBeUndefined();
  });

  it("clearAccount 清空整个 account 名下条目(不触发 abort/close)", () => {
    const t1 = makeTurn("t1");
    const t2 = makeTurn("t2");
    registerTurn("acc1", "conv1", t1);
    registerTurn("acc1", "conv2", t2);
    registerTurn("acc2", "conv1", makeTurn("other"));

    clearAccount("acc1");
    expect(listByAccount("acc1")).toEqual([]);
    expect(listByAccount("acc2")).toHaveLength(1);
    // 注意:clearAccount 设计上不调用 abort/close
    expect(t1.abortCalls).toEqual([]);
    expect(t2.closeCalls).toEqual([]);
  });

  it("lookupTurn 未注册 → undefined,listByAccount 未注册 → []", () => {
    expect(lookupTurn("none", "none")).toBeUndefined();
    expect(listByAccount("none")).toEqual([]);
  });

  it("abort + close 配合(典型 cancel 调用)", () => {
    const t = makeTurn("t");
    registerTurn("acc1", "conv1", t);
    const found = lookupTurn("acc1", "conv1");
    expect(found).toBe(t);
    found?.abort("inbound.cancel");
    found?.close("cancelled");
    expect(t.abortCalls).toEqual(["inbound.cancel"]);
    expect(t.closeCalls).toEqual(["cancelled"]);
  });

  it("_resetInFlightForTest 清空一切", () => {
    registerTurn("acc1", "conv1", makeTurn("t1"));
    registerTurn("acc2", "conv2", makeTurn("t2"));
    _resetInFlightForTest();
    expect(listByAccount("acc1")).toEqual([]);
    expect(listByAccount("acc2")).toEqual([]);
  });
});

// 防止 vi 未引用告警(vitest mock 工具占位,后续场景需要时直接用)
void vi;
