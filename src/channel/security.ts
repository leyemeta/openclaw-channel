/**
 * security —— leyemeta 是受信通道(平台已完成用户认证),DM 策略一律 `open`,
 * 不维护 allowFrom 白名单。
 *
 * senderId 由 inbound 帧的 `payload.user.id` 透传(见 messaging.buildInboundEnvelope),
 * 因此本文件只暴露 `resolveDmPolicy`。
 */

import type { ChannelPlugin } from "openclaw/plugin-sdk";

import type { LeyemetaAccount } from "../types.js";

type LeyemetaSecurityAdapter = NonNullable<ChannelPlugin<LeyemetaAccount>["security"]>;

export const security: LeyemetaSecurityAdapter = {
  resolveDmPolicy: () => ({
    policy: "open",
    allowFrom: null, // open 模式下 host 应忽略 allowFrom
    allowFromPath: "channels.leyemeta.allowFrom", // 占位,未来若加白名单改这里
    approveHint: "leyemeta 平台用户已在平台侧完成认证,无需配对",
  }),
};
