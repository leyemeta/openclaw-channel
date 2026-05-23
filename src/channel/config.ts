import type { OpenClawConfig } from "openclaw/plugin-sdk";

import type { LeyemetaAccount, LeyemetaChannelConfig } from "../types.js";
import { DEFAULT_GATEWAY_URL } from "../types.js";

function readChannel(cfg: OpenClawConfig): LeyemetaChannelConfig | undefined {
  const channels = (cfg as { channels?: { leyemeta?: LeyemetaChannelConfig } })
    .channels;
  return channels?.leyemeta;
}

export const config = {
  listAccountIds: (cfg: OpenClawConfig): string[] => {
    const accounts = readChannel(cfg)?.accounts;
    return accounts ? Object.keys(accounts) : [];
  },

  resolveAccount: (
    cfg: OpenClawConfig,
    accountId?: string | null,
  ): LeyemetaAccount => {
    const channel = readChannel(cfg);
    const id = accountId ?? "default";
    const raw = accountId ? channel?.accounts?.[accountId] : undefined;

    return {
      accountId: id,
      configured: Boolean(raw?.member_key),
      enabled: raw?.enabled ?? false,
      member_key: raw?.member_key ?? "",
      displayName: raw?.displayName,
    };
  },

  // gateway_url 是 channel 级全局配置,所有 account 共用;gateway 启动时直接从 ctx.cfg 读
  resolveGatewayUrl: (cfg: OpenClawConfig): string =>
    readChannel(cfg)?.gateway_url ?? DEFAULT_GATEWAY_URL,

  isConfigured: (account: LeyemetaAccount): boolean => account.configured,
};
