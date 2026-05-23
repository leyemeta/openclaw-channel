/**
 * 模块级 `PluginRuntime` 持有槽。
 *
 * host 在 `register()` 阶段(channel-entry-contract:setChannelRuntime)调用我们 entry 上声明的 setter,
 * 把完整 `PluginRuntime` 注入进来,之后入站派发 / 工具执行就能拿到 `runtime.channel.turn / reply /
 * routing / session / ...`。形态对齐 `@openclaw/feishu` 的 `setFeishuRuntime` 写法。
 *
 * - `getLeyemetaRuntime()`:throws when uninitialized —— 用于 gateway 入站派发(此时 host 必已注入)
 * - `tryGetLeyemetaRuntime()`:null fallback —— 用于 outbound 等可能早于 register 触发的路径
 */

import {
  createPluginRuntimeStore,
  type PluginRuntime,
} from "openclaw/plugin-sdk/runtime-store";

const store = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "leyemeta",
  errorMessage:
    "leyemeta plugin runtime is not initialized yet (host setChannelRuntime not called)",
});

/** entry 用,host 通过 setChannelRuntime 调入。 */
export const setLeyemetaRuntime = store.setRuntime;

/** 入站派发用;runtime 未注入时抛错(register 阶段未触发,属于异常)。 */
export const getLeyemetaRuntime = store.getRuntime;

/** outbound 等罕见早期路径用;runtime 未注入时返回 null。 */
export const tryGetLeyemetaRuntime = store.tryGetRuntime;

export type { PluginRuntime };
