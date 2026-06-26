/**
 * 模块级 PluginRuntime 持有槽。host 在 register 阶段经 entry 的 setter 注入完整
 * runtime,之后入站派发 / 工具执行即可拿到 runtime.channel.*。
 *
 * - getLeyemetaRuntime():未初始化时 throw,用于 gateway 入站派发(host 必已注入)
 * - tryGetLeyemetaRuntime():未初始化时返回 null,用于可能早于 register 的路径
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
