import type { ChannelPlugin } from "openclaw/plugin-sdk";

import { capabilities } from "./channel/capabilities.js";
import { config } from "./channel/config.js";
import { leyemetaConfigSchema } from "./channel/config-schema.js";
import { gateway } from "./channel/gateway.js";
import { meta } from "./channel/meta.js";
import { outbound } from "./channel/outbound.js";
import { security } from "./channel/security.js";
import { setup } from "./channel/setup.js";
import type { LeyemetaAccount } from "./types.js";

/**
 * ChannelPlugin 定义。
 *
 * 未挂载字段:
 * - `messaging` —— SDK 真实形状是 target/sessionKey 解析,leyemeta 没有此需求,
 *   入站派发由 gateway 通过 `ctx.channelRuntime.turn.run` 直接完成
 * - `agentTools` —— 后续阶段才会注入 leyemeta.* 工具
 *
 * `setup` —— 提供非交互式 `channels add` 能力(把 --token/--name flag 写进 account);
 *   缺它时 host 报 "does not support non-interactive add"。
 */
export const leyemetaPlugin: ChannelPlugin<LeyemetaAccount> = {
  id: "leyemeta",
  meta,
  capabilities,
  reload: { configPrefixes: ["channels.leyemeta"] },
  configSchema: leyemetaConfigSchema,
  config,
  gateway,
  outbound,
  security,
  setup,
};
