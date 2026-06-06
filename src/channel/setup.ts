/**
 * setup —— Channel setup adapter,让 `openclaw channels add` 在**非交互式**(带 flag)
 * 模式下可用。host 收到 `--channel leyemeta --account <id> --token <key> [--name <n>]`
 * 后,把这些 flag 归一成 `ChannelSetupInput`,调 `applyAccountConfig` 把 account 写进
 * `cfg.channels.leyemeta.accounts.<id>`,再持久化 cfg。
 *
 * 没有这个 adapter 时,host 判定该 channel 只能交互式向导添加,于是对脚本里的
 * 非交互式 add 报 "does not support non-interactive add"。
 *
 * 字段映射:`input.token` → `accounts.<id>.token`(配置层字段名,见 config-schema.ts);
 *           `input.name` → `accounts.<id>.displayName`。token 承载平台 member_key。
 */

import type {
  ChannelSetupAdapter,
  ChannelSetupInput,
  OpenClawConfig,
} from "openclaw/plugin-sdk";

import type { LeyemetaAccountRaw, LeyemetaChannelConfig } from "../types.js";

/** 不可变地取出 `channels.leyemeta` 子树(可能不存在)。 */
function readChannel(cfg: OpenClawConfig): LeyemetaChannelConfig | undefined {
  return (cfg as { channels?: { leyemeta?: LeyemetaChannelConfig } }).channels
    ?.leyemeta;
}

export const setup: ChannelSetupAdapter = {
  /**
   * 非交互式 add 的落地点。纯函数式:返回写入了该 account 的新 cfg,不就地修改入参
   * (host 的 config 写入模型按 immutable 处理)。token 为空时不阻断——交由
   * `validateInput` 给出明确错误;这里只负责"有什么写什么"。
   */
  applyAccountConfig: ({ cfg, accountId, input }): OpenClawConfig => {
    const existingChannel = readChannel(cfg) ?? {};
    const existingAccounts = existingChannel.accounts ?? {};
    const prev = existingAccounts[accountId];

    const nextAccount: LeyemetaAccountRaw = {
      // 保留已有 enabled,新建默认启用
      enabled: prev?.enabled ?? true,
      // token 是配置层字段(承载 member_key);input.token 来自 --token flag
      token: input.token ?? prev?.token ?? "",
      // --name 写入 displayName;未传则保留旧值
      ...(input.name !== undefined
        ? { displayName: input.name }
        : prev?.displayName !== undefined
          ? { displayName: prev.displayName }
          : {}),
    };

    return {
      ...(cfg as object),
      channels: {
        ...((cfg as { channels?: Record<string, unknown> }).channels ?? {}),
        leyemeta: {
          ...existingChannel,
          accounts: {
            ...existingAccounts,
            [accountId]: nextAccount,
          },
        },
      },
    } as OpenClawConfig;
  },

  /**
   * 写入前校验。token 缺失/空白即拒绝——返回错误字符串,host 据此中止 add 并打印。
   * 返回 null 表示通过。
   */
  validateInput: ({ input }): string | null => {
    const token = input.token?.trim();
    if (!token) {
      return "缺少 --token:leyemeta account 需要平台 member_key(经 --token 传入)。";
    }
    return null;
  },
};

// 显式标注 input 类型来源,避免未来误改字段名时静默漂移。
export type { ChannelSetupInput };
