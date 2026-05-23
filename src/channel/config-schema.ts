import type { ChannelConfigSchema } from "openclaw/plugin-sdk";

/**
 * 与 `openclaw.plugin.json.channelConfigs.leyemeta` 镜像;修改时两边一起改。
 */
export const leyemetaConfigSchema: ChannelConfigSchema = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      gateway_url: {
        type: "string",
        format: "uri",
        description: "leyemeta 接入端点 WebSocket URL",
        default: "wss://leyemeta.com/openclaw/v1",
      },
      // 流式输出开关。leyemeta 协议天生以 outbound.delta 帧承载,默认开启 block streaming。
      // host 会读 streaming.block.enabled 决定是否走 createBlockReplyPipeline,从而触发
      // dispatcher 把回复按段投递(deliver kind=block);关闭时退化为一次性 final。
      //
      // 注意:Ajv useDefaults 只在父对象存在时填子 default;为了让用户什么都不写
      // 也能开启,这里给每层 object 都补上 default: {},让 default 沿链路一路冒上来。
      streaming: {
        type: "object",
        additionalProperties: false,
        description: "流式输出策略;关闭后回复退化为单帧 final",
        default: {},
        properties: {
          block: {
            type: "object",
            additionalProperties: false,
            description: "block 分片下发配置",
            default: {},
            properties: {
              enabled: {
                type: "boolean",
                default: true,
                description: "启用 block 分片(默认 true,leyemeta 协议本身就是流式)",
              },
              coalesce: {
                type: "object",
                additionalProperties: false,
                description: "分片合并阈值;不设走 SDK 默认",
                properties: {
                  minChars: { type: "integer", minimum: 1 },
                  maxChars: { type: "integer", minimum: 1 },
                  idleMs: { type: "integer", minimum: 0 },
                },
              },
            },
          },
        },
      },
      accounts: {
        type: "object",
        description: "本地 account 代号到平台智能体身份的映射",
        patternProperties: {
          "^[a-zA-Z0-9_-]+$": {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: {
                type: "boolean",
                default: true,
                description: "是否启用该 account(false 时插件不会为其建立连接)",
              },
              member_key: {
                type: "string",
                minLength: 1,
                description: "leyemeta 智能体的成员密钥",
              },
              displayName: {
                type: "string",
                description: "在 OpenClaw 内展示的别名(可选)",
              },
            },
            required: ["member_key"],
          },
        },
        additionalProperties: false,
      },
    },
    required: ["accounts"],
  },
  uiHints: {
    gateway_url: {
      label: "Gateway URL",
      placeholder: "wss://leyemeta.com/openclaw/v1",
      help: "通常无需修改,仅在对接 staging 环境时改写",
    },
    accounts: {
      label: "Accounts",
      help: "每个 account 对应一个 leyemeta 平台智能体",
    },
    "accounts.*.member_key": {
      label: "Member Key",
      sensitive: true,
      help: "在 leyemeta 智能体设置页生成;切勿粘贴到截图或日志中",
    },
    "accounts.*.displayName": {
      label: "Display Name",
      placeholder: "例如:客服小乐",
    },
  },
};
