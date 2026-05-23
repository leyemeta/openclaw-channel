# Channel 插件开发指导手册

> 版本: 2026.1.30  
> 适用范围: 消息通道插件开发

---

## 1. Channel 架构概述

### 1.1 什么是 Channel Plugin

Channel Plugin 是 OpenClaw 中用于对接各种消息平台的扩展模块。每个 Channel 通过实现标准接口，让 Gateway 能够：

- 接收来自该平台的入站消息
- 向该平台发送出站消息
- 管理通道连接和状态

### 1.2 Channel 分类

| 类型 | 示例 | 特点 |
|------|------|------|
| **核心内置** | WhatsApp, Telegram, Slack | 与 Gateway 一起发布 |
| **扩展插件** | Matrix, Teams, Zalo | 独立发布，可选安装 |

### 1.3 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        Gateway                                  │
├─────────────────────────────────────────────────────────────────┤
│  Channel Manager                                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │ WhatsApp │  │ Telegram │  │  Custom  │  │  Matrix  │        │
│  │  Plugin  │  │  Plugin  │  │  Plugin  │  │  Plugin  │        │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘        │
└───────┼─────────────┼─────────────┼─────────────┼───────────────┘
        │             │             │             │
        ▼             ▼             ▼             ▼
   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐
   │ Baileys │   │  grammY │   │ Custom  │   │Matrix   │
   │ Library │   │  Bot    │   │  API    │   │SDK      │
   └─────────┘   └─────────┘   └─────────┘   └─────────┘
```

---

## 2. Channel Plugin 接口

### 2.1 核心接口定义

```typescript
// src/channels/plugins/types.plugin.ts

interface ChannelPlugin {
  /** 唯一标识符 */
  id: string;
  
  /** 元数据 */
  meta: ChannelMeta;
  
  /** 能力声明 */
  capabilities: ChannelCapabilities;
  
  /** 配置适配器（必需） */
  config: ChannelConfigAdapter;
  
  /** 出站适配器（必需） */
  outbound: ChannelOutboundAdapter;
  
  /** 可选适配器 */
  gateway?: ChannelGatewayAdapter;      // 连接生命周期
  security?: ChannelSecurityAdapter;    // 安全策略
  messaging?: ChannelMessagingAdapter;  // 入站消息
  mentions?: ChannelMentionAdapter;     // 提及解析
  threading?: ChannelThreadingAdapter;  // 线程/回复
  setup?: ChannelSetupAdapter;          // 向导设置
  status?: ChannelStatusAdapter;        // 状态诊断
  actions?: ChannelMessageActionAdapter; // 消息操作
  commands?: ChannelCommandAdapter;     // 原生命令
}
```

### 2.2 元数据 (ChannelMeta)

```typescript
interface ChannelMeta {
  /** 通道 ID */
  id: string;
  
  /** 显示标签 */
  label: string;
  
  /** 选择时的显示文本 */
  selectionLabel: string;
  
  /** 文档路径 */
  docsPath: string;
  
  /** 简介 */
  blurb: string;
  
  /** 别名 */
  aliases?: string[];
  
  /** 排序权重 */
  order?: number;
  
  /** 图标 */
  systemImage?: string;
}
```

### 2.3 能力声明 (ChannelCapabilities)

```typescript
interface ChannelCapabilities {
  /** 支持的聊天类型 */
  chatTypes: ("direct" | "group")[];
  
  /** 媒体限制 */
  media?: {
    maxSizeBytes?: number;
    supportedTypes?: string[];
  };
  
  /** 支持的功能 */
  supports?: {
    threads?: boolean;        // 线程/回复
    reactions?: boolean;      // 表情反应
    edits?: boolean;          // 消息编辑
    deletions?: boolean;      // 消息删除
    mentions?: boolean;       // @提及
    formatting?: boolean;     // 富文本
    voice?: boolean;          // 语音消息
    video?: boolean;          // 视频通话
  };
}
```

---

## 3. 开发一个新的 Channel 插件

### 3.1 目录结构

```
extensions/my-channel/
├── index.ts                    # 主入口
├── types.ts                    # 类型定义
├── config.ts                   # 配置处理
├── gateway.ts                  # 连接管理
├── messaging.ts                # 消息处理
├── outbound.ts                 # 发送消息
├── security.ts                 # 安全策略
├── normalize.ts                # 目标规范化
├── openclaw.plugin.json        # 插件清单
├── package.json                # npm 配置 (可选)
└── README.md                   # 文档
```

### 3.2 最小可用示例

```typescript
// extensions/my-channel/index.ts

import type { ChannelPlugin, ChannelConfigAdapter, ChannelOutboundAdapter } from "openclaw/plugin-sdk";

const myChannel: ChannelPlugin = {
  id: "mychannel",
  
  meta: {
    id: "mychannel",
    label: "My Channel",
    selectionLabel: "My Channel (Custom)",
    docsPath: "/channels/mychannel",
    blurb: "A custom messaging channel.",
    aliases: ["mc"],
  },
  
  capabilities: {
    chatTypes: ["direct", "group"],
    media: {
      maxSizeBytes: 10 * 1024 * 1024,  // 10MB
      supportedTypes: ["image/jpeg", "image/png", "video/mp4"],
    },
    supports: {
      threads: true,
      reactions: false,
      mentions: true,
    },
  },
  
  config: {
    listAccountIds: (cfg) => {
      return Object.keys(cfg.channels?.mychannel?.accounts ?? {});
    },
    resolveAccount: (cfg, accountId) => {
      return cfg.channels?.mychannel?.accounts?.[accountId ?? "default"];
    },
  },
  
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ text, target, account }) => {
      // 调用你的 API 发送消息
      const response = await fetch(`${account.apiUrl}/send`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${account.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: target.id,
          message: text,
        }),
      });
      
      if (!response.ok) {
        return {
          ok: false,
          error: `Failed to send: ${response.statusText}`,
        };
      }
      
      return { ok: true };
    },
  },
};

export default function register(api) {
  api.registerChannel({ plugin: myChannel });
}
```

### 3.3 插件清单

```json
// extensions/my-channel/openclaw.plugin.json

{
  "id": "mychannel",
  "name": "My Channel",
  "version": "1.0.0",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "accounts": {
        "type": "object",
        "additionalProperties": {
          "type": "object",
          "properties": {
            "enabled": { "type": "boolean" },
            "token": { "type": "string" },
            "apiUrl": { "type": "string" }
          },
          "required": ["token"]
        }
      }
    }
  },
  "uiHints": {
    "accounts": {
      "label": "Accounts",
      "description": "Configure your My Channel accounts"
    },
    "accounts.*.token": {
      "label": "API Token",
      "sensitive": true
    },
    "accounts.*.apiUrl": {
      "label": "API URL",
      "placeholder": "https://api.mychannel.com"
    }
  }
}
```

---

## 4. 完整 Channel 插件示例

### 4.1 带连接管理的通道

```typescript
// extensions/my-channel/index.ts

import type {
  ChannelPlugin,
  ChannelGatewayAdapter,
  ChannelMessagingAdapter,
  ChannelSecurityAdapter,
} from "openclaw/plugin-sdk";

interface MyChannelConnection {
  ws: WebSocket;
  accountId: string;
}

const connections = new Map<string, MyChannelConnection>();

const myChannel: ChannelPlugin = {
  id: "mychannel",
  meta: { /* ... */ },
  capabilities: { /* ... */ },
  config: { /* ... */ },
  outbound: { /* ... */ },
  
  // 连接生命周期管理
  gateway: {
    start: async (account, deps) => {
      const { logger } = deps;
      
      logger.info(`Starting My Channel connection for ${account.accountId}`);
      
      // 建立 WebSocket 连接
      const ws = new WebSocket(account.wsUrl, {
        headers: { Authorization: `Bearer ${account.token}` },
      });
      
      ws.on("open", () => {
        logger.info(`My Channel connected: ${account.accountId}`);
        deps.onReady();
      });
      
      ws.on("message", (data) => {
        handleIncomingMessage(data, account, deps);
      });
      
      ws.on("error", (err) => {
        logger.error(`My Channel error: ${err.message}`);
        deps.onError(err);
      });
      
      ws.on("close", () => {
        logger.info(`My Channel disconnected: ${account.accountId}`);
        deps.onDisconnect();
      });
      
      connections.set(account.accountId, { ws, accountId: account.accountId });
      
      return {
        stop: async () => {
          ws.close();
          connections.delete(account.accountId);
        },
      };
    },
  },
  
  // 入站消息处理
  messaging: {
    onMessage: async (event, deps) => {
      const { logger, emitMessage } = deps;
      
      // 解析消息
      const message = parseMessage(event.data);
      
      logger.debug(`Received message: ${message.id}`);
      
      // 构造标准消息格式
      const normalizedMessage = {
        id: message.id,
        channel: "mychannel",
        accountId: event.accountId,
        senderId: message.from,
        senderName: message.fromName,
        text: message.text,
        timestamp: message.timestamp,
        isGroup: message.chatType === "group",
        groupId: message.groupId,
        attachments: message.attachments?.map(a => ({
          type: a.type,
          url: a.url,
          filename: a.filename,
        })),
      };
      
      // 发送给 Gateway
      emitMessage(normalizedMessage);
    },
  },
  
  // 安全策略
  security: {
    getDmPolicy: (account) => {
      return account.dmPolicy ?? "pairing";
    },
    getAllowFrom: (account) => {
      return account.allowFrom ?? [];
    },
    checkGroupAccess: (account, groupId) => {
      const groups = account.groups ?? {};
      if ("*" in groups) return true;
      return groupId in groups;
    },
  },
};

function handleIncomingMessage(
  data: RawData,
  account: ChannelAccount,
  deps: GatewayDeps
) {
  try {
    const event = JSON.parse(data.toString());
    deps.emit("message", { data: event, accountId: account.accountId });
  } catch (err) {
    deps.logger.error("Failed to parse message:", err);
  }
}

function parseMessage(data: any): ParsedMessage {
  // 解析平台特定格式为标准格式
  return {
    id: data.message_id,
    from: data.sender.id,
    fromName: data.sender.name,
    text: data.content.text,
    timestamp: new Date(data.timestamp),
    chatType: data.chat.type,
    groupId: data.chat.group_id,
    attachments: data.content.attachments,
  };
}

export default function register(api) {
  api.registerChannel({ plugin: myChannel });
}
```

---

## 5. 各 Adapter 详解

### 5.1 Config Adapter（配置适配器）

```typescript
interface ChannelConfigAdapter {
  /** 列出所有账户 ID */
  listAccountIds: (config: OpenClawConfig) => string[];
  
  /** 解析账户配置 */
  resolveAccount: (
    config: OpenClawConfig,
    accountId: string | undefined
  ) => ChannelAccount | undefined;
}
```

**示例：**

```typescript
config: {
  // 多账户支持
  listAccountIds: (cfg) => {
    return Object.keys(cfg.channels?.mychannel?.accounts ?? {});
  },
  
  // 解析账户配置
  resolveAccount: (cfg, accountId) => {
    const accounts = cfg.channels?.mychannel?.accounts;
    const account = accounts?.[accountId ?? "default"];
    
    if (!account) return undefined;
    
    return {
      accountId: accountId ?? "default",
      enabled: account.enabled ?? true,
      token: account.token,
      apiUrl: account.apiUrl ?? "https://api.mychannel.com",
      // 自定义字段
      dmPolicy: account.dmPolicy ?? "pairing",
      allowFrom: account.allowFrom ?? [],
    };
  },
}
```

### 5.2 Outbound Adapter（出站适配器）

```typescript
interface ChannelOutboundAdapter {
  /** 投递模式 */
  deliveryMode: "direct" | "queued";
  
  /** 发送文本消息 */
  sendText: (context: OutboundContext) => Promise<SendResult>;
  
  /** 发送媒体（可选） */
  sendMedia?: (context: MediaOutboundContext) => Promise<SendResult>;
  
  /** 编辑消息（可选） */
  editText?: (context: EditContext) => Promise<SendResult>;
  
  /** 删除消息（可选） */
  deleteMessage?: (context: DeleteContext) => Promise<SendResult>;
}
```

**示例：**

```typescript
outbound: {
  deliveryMode: "direct",
  
  sendText: async ({ text, target, account, replyTo }) => {
    try {
      const body: any = {
        to: target.id,
        message: text,
      };
      
      // 回复消息
      if (replyTo?.messageId) {
        body.reply_to = replyTo.messageId;
      }
      
      const response = await fetch(`${account.apiUrl}/messages`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${account.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      
      if (!response.ok) {
        return {
          ok: false,
          error: `HTTP ${response.status}: ${response.statusText}`,
        };
      }
      
      const result = await response.json();
      
      return {
        ok: true,
        messageId: result.message_id,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Unknown error",
      };
    }
  },
  
  sendMedia: async ({ media, target, account }) => {
    // 上传文件
    const formData = new FormData();
    formData.append("file", new Blob([media.data]), media.filename);
    formData.append("to", target.id);
    
    const response = await fetch(`${account.apiUrl}/media`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${account.token}`,
      },
      body: formData,
    });
    
    return {
      ok: response.ok,
      messageId: (await response.json()).message_id,
    };
  },
}
```

### 5.3 Gateway Adapter（连接适配器）

```typescript
interface ChannelGatewayAdapter {
  /** 启动连接 */
  start: (
    account: ChannelAccount,
    deps: GatewayDeps
  ) => Promise<{ stop: () => Promise<void> }>;
  
  /** 登录流程（可选） */
  login?: {
    startQr?: (account: ChannelAccount) => Promise<QrResult>;
    waitForQr?: (account: ChannelAccount) => Promise<LoginResult>;
  };
  
  /** 登出流程（可选） */
  logout?: (account: ChannelAccount) => Promise<LogoutResult>;
}
```

### 5.4 Security Adapter（安全适配器）

```typescript
interface ChannelSecurityAdapter {
  /** 获取 DM 策略 */
  getDmPolicy: (account: ChannelAccount) => DmPolicy;
  
  /** 获取允许列表 */
  getAllowFrom: (account: ChannelAccount) => AllowFromConfig;
  
  /** 检查群组访问权限 */
  checkGroupAccess?: (
    account: ChannelAccount,
    groupId: string
  ) => boolean;
  
  /** 解析发送者标识 */
  resolveSenderId?: (event: MessageEvent) => string;
}
```

### 5.5 Threading Adapter（线程适配器）

```typescript
interface ChannelThreadingAdapter {
  /** 提取回复上下文 */
  getReplyContext: (event: MessageEvent) => ThreadContext | undefined;
  
  /** 格式化回复 */
  formatReply: (replyTo: ReplyTarget) => string | undefined;
}
```

---

## 6. 配置 Schema 设计

### 6.1 推荐配置结构

```json5
// openclaw.json
{
  channels: {
    mychannel: {
      // 多账户配置
      accounts: {
        default: {
          enabled: true,
          token: "your-api-token",
          apiUrl: "https://api.mychannel.com",
          
          // 安全设置
          dmPolicy: "pairing",  // "pairing" | "open" | "closed"
          allowFrom: ["user1", "user2"],  // 允许的发送者
          
          // 群组设置
          groups: {
            "*": {
              requireMention: true,
            },
            "group-id-1": {
              allowFrom: ["admin1"],
            },
          },
        },
      },
    },
  },
}
```

### 6.2 JSON Schema

```json
{
  "type": "object",
  "properties": {
    "channels": {
      "type": "object",
      "properties": {
        "mychannel": {
          "type": "object",
          "properties": {
            "accounts": {
              "type": "object",
              "patternProperties": {
                "^[a-zA-Z0-9_-]+$": {
                  "type": "object",
                  "properties": {
                    "enabled": { "type": "boolean" },
                    "token": { "type": "string" },
                    "apiUrl": { "type": "string", "format": "uri" },
                    "dmPolicy": {
                      "type": "string",
                      "enum": ["pairing", "open", "closed"]
                    },
                    "allowFrom": {
                      "type": "array",
                      "items": { "type": "string" }
                    },
                    "groups": {
                      "type": "object",
                      "additionalProperties": {
                        "type": "object",
                        "properties": {
                          "requireMention": { "type": "boolean" },
                          "allowFrom": {
                            "type": "array",
                            "items": { "type": "string" }
                          }
                        }
                      }
                    }
                  },
                  "required": ["token"]
                }
              }
            }
          }
        }
      }
    }
  }
}
```

---

## 7. 测试 Channel 插件

### 7.1 本地开发测试

```bash
# 1. 创建符号链接到扩展目录
mkdir -p ~/.openclaw/extensions
ln -s /path/to/my-channel ~/.openclaw/extensions/my-channel

# 2. 在 openclaw.json 中启用
{
  "plugins": {
    "entries": {
      "mychannel": { "enabled": true }
    }
  }
}

# 3. 启动 Gateway 查看加载情况
pnpm gateway:dev

# 4. 检查通道状态
openclaw channels status
```

### 7.2 单元测试

```typescript
// extensions/my-channel/index.test.ts

import { describe, it, expect } from "vitest";
import { myChannel } from "./index.js";

describe("My Channel Plugin", () => {
  describe("config", () => {
    it("should list account IDs", () => {
      const cfg = {
        channels: {
          mychannel: {
            accounts: {
              default: { token: "test" },
              work: { token: "test2" },
            },
          },
        },
      };
      
      const ids = myChannel.config.listAccountIds(cfg);
      expect(ids).toEqual(["default", "work"]);
    });
    
    it("should resolve account", () => {
      const cfg = {
        channels: {
          mychannel: {
            accounts: {
              default: { token: "test-token", apiUrl: "https://api.test.com" },
            },
          },
        },
      };
      
      const account = myChannel.config.resolveAccount(cfg, "default");
      expect(account).toMatchObject({
        accountId: "default",
        token: "test-token",
        apiUrl: "https://api.test.com",
      });
    });
  });
  
  describe("outbound", () => {
    it("should send text message", async () => {
      const result = await myChannel.outbound.sendText({
        text: "Hello",
        target: { id: "user-123" },
        account: { token: "test", apiUrl: "https://api.test.com" },
      });
      
      expect(result.ok).toBe(true);
    });
  });
});
```

### 7.3 E2E 测试

```typescript
// extensions/my-channel/e2e.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestGateway, TestClient } from "../../test-helpers/e2e.js";

describe("My Channel E2E", () => {
  let gateway: TestGateway;
  
  beforeAll(async () => {
    gateway = await startTestGateway({
      config: {
        channels: {
          mychannel: {
            accounts: {
              default: {
                enabled: true,
                token: process.env.MYCHANNEL_TEST_TOKEN!,
              },
            },
          },
        },
      },
    });
  });
  
  afterAll(async () => {
    await gateway.stop();
  });
  
  it("should send and receive messages", async () => {
    const client = await gateway.connect();
    
    // 发送消息
    const sendResult = await client.request("send", {
      channel: "mychannel",
      to: "test-user",
      message: "Hello from test",
    });
    
    expect(sendResult.ok).toBe(true);
    
    // 等待接收消息（模拟入站）
    const message = await client.waitForEvent("message:inbound", 5000);
    expect(message.text).toBe("Hello from test");
  });
});
```

---

## 8. 最佳实践

### 8.1 错误处理

```typescript
// 好的做法：详细的错误信息
async function sendMessage(params: SendParams): Promise<SendResult> {
  try {
    const response = await fetch(`${apiUrl}/send`, { ... });
    
    if (response.status === 401) {
      return {
        ok: false,
        error: "Authentication failed. Please check your token.",
        retryable: false,
      };
    }
    
    if (response.status === 429) {
      return {
        ok: false,
        error: "Rate limited. Please try again later.",
        retryable: true,
        retryAfter: 60,
      };
    }
    
    // ...
  } catch (err) {
    return {
      ok: false,
      error: `Network error: ${err.message}`,
      retryable: true,
    };
  }
}
```

### 8.2 日志规范

```typescript
// 使用 Gateway 提供的 logger
declare const deps: GatewayDeps;

// 不同级别
 deps.logger.debug("Processing message", { messageId: msg.id });  // 调试信息
deps.logger.info("Channel connected", { accountId });            // 重要事件
deps.logger.warn("Rate limit approaching");                       // 警告
deps.logger.error("Failed to send message", { error });           // 错误

// 结构化日志
deps.logger.info("Message sent", {
  messageId: result.messageId,
  recipient: target.id,
  latency: Date.now() - startTime,
});
```

### 8.3 重连策略

```typescript
gateway: {
  start: async (account, deps) => {
    let reconnectAttempts = 0;
    const maxReconnectDelay = 30000;  // 最大 30 秒
    
    const connect = () => {
      const ws = new WebSocket(account.wsUrl);
      
      ws.on("close", () => {
        // 指数退避重连
        const delay = Math.min(
          1000 * Math.pow(2, reconnectAttempts),
          maxReconnectDelay
        );
        
        deps.logger.info(`Reconnecting in ${delay}ms...`);
        
        setTimeout(() => {
          reconnectAttempts++;
          connect();
        }, delay);
      });
      
      ws.on("open", () => {
        reconnectAttempts = 0;
        deps.onReady();
      });
    };
    
    connect();
    
    return {
      stop: async () => {
        // 清理连接
      },
    };
  },
}
```

---

## 9. 发布插件

### 9.1 准备发布

```bash
# 1. 确保版本号正确
cat package.json | grep version

# 2. 运行测试
pnpm test

# 3. 构建（如果需要）
pnpm build

# 4. 创建发布包
cd extensions/my-channel
tar -czf my-channel-1.0.0.tgz .
```

### 9.2 发布到 npm

```json
// package.json
{
  "name": "@your-scope/openclaw-mychannel",
  "version": "1.0.0",
  "openclaw": {
    "extensions": ["./dist/index.js"]
  },
  "files": ["dist", "openclaw.plugin.json"],
  "publishConfig": {
    "access": "public"
  }
}
```

```bash
# 发布
npm publish
```

### 9.3 用户安装

```bash
# 从 npm 安装
openclaw plugins install @your-scope/openclaw-mychannel

# 或从本地文件安装
openclaw plugins install ./my-channel-1.0.0.tgz

# 重启 Gateway
openclaw gateway restart
```

---

## 10. 参考示例

### 10.1 官方示例

| 示例 | 路径 | 说明 |
|------|------|------|
| Matrix | `extensions/matrix/` | 完整功能的 Channel 插件 |
| Teams | `extensions/msteams/` | 企业级通道示例 |
| Zalo | `extensions/zalo/` | 多账户配置示例 |

### 10.2 内置通道参考

| 通道 | 路径 | 特点 |
|------|------|------|
| Telegram | `src/telegram/` | Bot API 集成 |
| Slack | `src/slack/` | Socket Mode |
| Discord | `src/discord/` | Gateway Intents |

---

## 11. 常见问题

### Q1: 如何支持多账户？

使用 `accounts` 配置对象，在 `config.listAccountIds` 和 `config.resolveAccount` 中处理。

### Q2: 如何处理媒体文件？

在 `outbound.sendMedia` 中实现文件上传，使用 `fetch` 的 `FormData`。

### Q3: 如何实现 QR 码登录？

在 `gateway.login` 中实现 `startQr` 和 `waitForQr` 方法。

### Q4: 如何处理群组消息？

在 `messaging.onMessage` 中检查 `isGroup` 字段，使用 `security.checkGroupAccess` 验证权限。

### Q5: 如何调试入站消息？

使用 `DEBUG=openclaw:channels` 环境变量启动 Gateway。

---

*本手册涵盖了 Channel 插件开发的核心内容。更多细节请参考源码中的内置通道实现。*
