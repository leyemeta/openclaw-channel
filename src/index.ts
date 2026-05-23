/**
 * 插件入口。
 *
 * 通过 `defineBundledChannelEntry` 注册 channel contract,host 据此识别
 * `kind: "bundled-channel-entry"` 并调用 `loadChannelPlugin()` 取得 plugin
 * 实例,完成 lifecycle 启动。直接 `export default register(api)` 形态会让
 * host 跳过 channel contract,导致 `startAccount` 不会被调用。
 */

import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

import { leyemetaConfigSchema } from "./channel/config-schema.js";

const leyemetaChannelEntry = defineBundledChannelEntry({
  id: "leyemeta",
  name: "Leyemeta Channel",
  description: "把 leyemeta 平台对话流接入 OpenClaw,支持多智能体绑定。",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "leyemetaPlugin",
  },
  configSchema: leyemetaConfigSchema,
  // host 在 register() 阶段调 setLeyemetaRuntime(api.runtime),把完整 PluginRuntime
  // 注入到模块槽。gateway/turn-resolver 后续通过 getLeyemetaRuntime() 取用。
  runtime: {
    specifier: "./runtime/host-runtime.js",
    exportName: "setLeyemetaRuntime",
  },
});

export default leyemetaChannelEntry;
export { leyemetaPlugin } from "./channel-plugin-api.js";
