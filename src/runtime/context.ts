/**
 * 跨 channel/outbound/tools 共享的运行时状态:
 *   1. `accountId → LeyemetaWsClient` 连接池(gateway 注册,outbound 取用)
 *   2. `lookupMemberKey(accountId, cfg)` —— 工具反查 member_key 的入口
 *
 * 用模块级 Map 而不是 class:host 单进程加载本插件,gateway.startAccount 与
 * outbound.sendText 共享同一份模块导出,模块级 map 既简单又一致。
 * `unregisterConn` 不主动 stop —— stop 由 gateway 自己 await 完成,避免双重 stop。
 */

import { config as channelConfig } from "../channel/config.js";
import type { LeyemetaWsClient } from "../transport/ws-client.js";
import type { LeyemetaAccount } from "../types.js";

type OpenClawConfigLike = Parameters<typeof channelConfig.resolveAccount>[0];

const conns = new Map<string, LeyemetaWsClient>();

/** 注册连接(同 accountId 已存在时,先 stop 旧的)。 */
export function registerConn(accountId: string, client: LeyemetaWsClient): void {
  const prev = conns.get(accountId);
  if (prev && prev !== client) {
    void prev.stop().catch(() => {});
  }
  conns.set(accountId, client);
}

/** 注销连接(只移除引用,不主动 stop)。 */
export function unregisterConn(accountId: string, client?: LeyemetaWsClient): void {
  const current = conns.get(accountId);
  if (!current) return;
  if (client && current !== client) return;
  conns.delete(accountId);
}

export function getConn(accountId: string): LeyemetaWsClient | undefined {
  return conns.get(accountId);
}

export function listConnAccountIds(): string[] {
  return Array.from(conns.keys());
}

/** 测试钩子:清空连接池,生产代码不应调用。 */
export function _resetConnsForTest(): void {
  conns.clear();
}

/**
 * 反查 account 的 `member_key`,工具用 Authorization Bearer 调平台 API。
 * 返回 null 表示 accountId 在 cfg 里不存在或未配 member_key —— 调用方应据此返回错误,
 * 不要降级成空字符串调用 API。
 */
export function lookupMemberKey(
  accountId: string,
  cfg: OpenClawConfigLike,
): string | null {
  if (!accountId) return null;
  const account: LeyemetaAccount = channelConfig.resolveAccount(cfg, accountId);
  if (!account.configured) return null;
  return account.member_key || null;
}
