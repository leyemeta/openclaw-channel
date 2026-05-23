/**
 * leyemeta 插件共享类型。
 * channel 相关类型 type-only 引自 `openclaw/plugin-sdk`,不维护本地镜像。
 */

export const LEYEMETA_CHANNEL_ID = "leyemeta" as const;

export const DEFAULT_GATEWAY_URL = "ws://localhost:8000/openclaw/v1" as const;

/** openclaw.json 中单个 account 的原始字段。 */
export interface LeyemetaAccountRaw {
  enabled?: boolean;
  member_key: string;
  displayName?: string;
}

/** `channels.leyemeta.*` 的原始配置。 */
export interface LeyemetaChannelConfig {
  gateway_url?: string;
  accounts?: Record<string, LeyemetaAccountRaw>;
}

/**
 * `resolveAccount` 返回的运行期 account 视图。
 *
 * SDK 的 `ChannelConfigAdapter.resolveAccount` 必须返回非 optional 的 ResolvedAccount,
 * `configured` 字段用来标记"是否真的有可用配置"。
 *
 * `gateway_url` 是 channel 级全局配置,所有 account 共用,因此**不**放在这里;
 * 需要时通过 `config.resolveGatewayUrl(cfg)` 读取。
 */
export interface LeyemetaAccount {
  accountId: string;
  configured: boolean;
  enabled: boolean;
  member_key: string;
  displayName?: string;
}

/** 入站消息中由平台传递的最小用户身份。 */
export interface LeyemetaUser {
  id: string;
  name: string;
  tenantId?: string;
  permissions?: string[];
}
