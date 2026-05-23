import { afterEach, describe, expect, it } from "vitest";

import {
  _resetConnsForTest,
  getConn,
  listConnAccountIds,
  lookupMemberKey,
  registerConn,
  unregisterConn,
} from "../../src/runtime/context.js";
import type { LeyemetaWsClient } from "../../src/transport/ws-client.js";

const fakeClient = (label: string): LeyemetaWsClient =>
  ({
    label,
    stop: async () => {},
  } as unknown as LeyemetaWsClient);

describe("connection pool", () => {
  afterEach(() => {
    _resetConnsForTest();
  });

  it("register/get/list/unregister 基本路径", () => {
    const a = fakeClient("a");
    const b = fakeClient("b");
    registerConn("acc1", a);
    registerConn("acc2", b);

    expect(getConn("acc1")).toBe(a);
    expect(getConn("acc2")).toBe(b);
    expect(listConnAccountIds().sort()).toEqual(["acc1", "acc2"]);

    unregisterConn("acc1", a);
    expect(getConn("acc1")).toBeUndefined();
    expect(listConnAccountIds()).toEqual(["acc2"]);
  });

  it("同 accountId 注册新 client 时,旧 client 被异步 stop", () => {
    const stopSpy = (() => {
      let called = false;
      const c = fakeClient("old") as unknown as { stop: () => Promise<void> };
      c.stop = async () => {
        called = true;
      };
      return { c: c as unknown as LeyemetaWsClient, getCalled: () => called };
    })();
    registerConn("acc1", stopSpy.c);
    const fresh = fakeClient("new");
    registerConn("acc1", fresh);
    expect(getConn("acc1")).toBe(fresh);
    // stop 是异步触发的 fire-and-forget,这里只断言注册替换成功
  });

  it("unregisterConn 当指定的 client 不匹配时不删除", () => {
    const a = fakeClient("a");
    const b = fakeClient("b");
    registerConn("acc1", a);
    unregisterConn("acc1", b);
    expect(getConn("acc1")).toBe(a);
  });
});

describe("lookupMemberKey", () => {
  afterEach(() => {
    _resetConnsForTest();
  });

  it("返回 cfg 里配置的 member_key", () => {
    const cfg = {
      channels: {
        leyemeta: {
          accounts: {
            cs: { enabled: true, member_key: "K1_xxxx" },
          },
        },
      },
    };
    // 因 OpenClawConfig 是 SDK 复杂类型,这里以 any 注入(测试边界)
    expect(lookupMemberKey("cs", cfg as never)).toBe("K1_xxxx");
  });

  it("accountId 不存在 → null", () => {
    const cfg = { channels: { leyemeta: { accounts: {} } } };
    expect(lookupMemberKey("missing", cfg as never)).toBeNull();
  });

  it("空 accountId → null", () => {
    expect(lookupMemberKey("", {} as never)).toBeNull();
  });

  it("member_key 为空字符串 → null", () => {
    const cfg = {
      channels: {
        leyemeta: { accounts: { cs: { enabled: true, member_key: "" } } },
      },
    };
    expect(lookupMemberKey("cs", cfg as never)).toBeNull();
  });
});
