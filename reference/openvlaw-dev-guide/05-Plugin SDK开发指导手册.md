# Plugin SDK 开发指导手册

> 版本: 2026.1.30  
> 适用范围: OpenClaw 插件开发

---

## 1. 插件系统概述

### 1.1 什么是插件

OpenClaw 插件是扩展系统功能的代码模块。插件可以：

- 注册新的消息通道
- 添加 Agent 工具
- 扩展 Gateway RPC 方法
- 添加 CLI 命令
- 注册后台服务
- 绑定生命周期钩子

### 1.2 插件发现顺序

OpenClaw 按以下顺序扫描插件：

```
1. Config paths         → plugins.load.paths
2. Workspace extensions → <workspace>/.openclaw/extensions/
3. Global extensions    → ~/.openclaw/extensions/
4. Bundled extensions   → <openclaw>/extensions/*
```

### 1.3 插件架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        Plugin Loader                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐        │
│  │   Discover  │────▶│    Load     │────▶│   Validate  │        │
│  │   (scan)    │     │   (jiti)    │     │  (schema)   │        │
│  └─────────────┘     └─────────────┘     └─────────────┘        │
│                                                  │               │
│                                                  ▼               │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐        │
│  │   Channel   │◄────│   Register  │◄────│   Init      │        │
│  │   Plugin    │     │  (exports)  │     │  (api)      │        │
│  └─────────────┘     └─────────────┘     └─────────────┘        │
│  ┌─────────────┐                                                │
│  │    Tool     │                                                │
│  │   Plugin    │                                                │
│  └─────────────┘                                                │
│  ┌─────────────┐                                                │
│  │    CLI      │                                                │
│  │   Plugin    │                                                │
│  └─────────────┘                                                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. 快速开始

### 2.1 创建插件目录

```bash
# 创建工作区插件目录
mkdir -p ~/.openclaw/extensions/my-plugin
cd ~/.openclaw/extensions/my-plugin

# 创建基本文件
touch index.ts openclaw.plugin.json README.md
```

### 2.2 插件清单

```json
// openclaw.plugin.json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "A demo plugin for OpenClaw",
  
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "apiKey": {
        "type": "string",
        "description": "API key for external service"
      },
      "endpoint": {
        "type": "string",
        "default": "https://api.example.com"
      }
    }
  },
  
  "uiHints": {
    "apiKey": {
      "label": "API Key",
      "sensitive": true
    },
    "endpoint": {
      "label": "API Endpoint",
      "placeholder": "https://api.example.com"
    }
  }
}
```

### 2.3 插件入口

```typescript
// index.ts

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export default function register(api: OpenClawPluginApi) {
  // 插件注册逻辑
  api.logger.info("My Plugin loaded!");
  
  // 注册工具
  api.registerTool({
    name: "my_tool",
    description: "A demo tool",
    parameters: Type.Object({}),
    execute: async () => ({
      type: "text",
      content: "Hello from My Plugin!",
    }),
  });
}
```

### 2.4 启用插件

```json5
// ~/.openclaw/openclaw.json
{
  plugins: {
    enabled: true,
    entries: {
      "my-plugin": {
        enabled: true,
        config: {
          apiKey: "your-api-key",
          endpoint: "https://api.example.com",
        },
      },
    },
  },
}
```

---

## 3. Plugin API 详解

### 3.1 核心 API 接口

```typescript
interface OpenClawPluginApi {
  /** 插件 ID */
  id: string;
  
  /** 插件配置 */
  config: PluginConfig;
  
  /** 日志器 */
  logger: Logger;
  
  /** 运行时依赖 */
  runtime: PluginRuntime;
  
  // ========== 注册方法 ==========
  
  /** 注册通道 */
  registerChannel(options: { plugin: ChannelPlugin }): void;
  
  /** 注册工具 */
  registerTool(tool: AgentTool): void;
  
  /** 注册 Gateway 方法 */
  registerGatewayMethod(
    method: string,
    handler: GatewayMethodHandler
  ): void;
  
  /** 注册 HTTP 路由 */
  registerHttpRoute(
    path: string,
    handler: HttpHandler
  ): void;
  
  /** 注册 CLI 命令 */
  registerCli(
    registerFn: (program: Command) => void,
    metadata: CliMetadata
  ): void;
  
  /** 注册服务 */
  registerService(service: BackgroundService): void;
  
  /** 注册命令 */
  registerCommand(command: AutoReplyCommand): void;
  
  /** 注册模型提供者 */
  registerProvider(provider: ModelProvider): void;
}
```

### 3.2 运行时依赖

```typescript
interface PluginRuntime {
  /** 主配置 */
  config: OpenClawConfig;
  
  /** TTS 服务 */
  tts: {
    textToSpeech(params: TTSParams): Promise<TTSResult>;
    textToSpeechTelephony(params: TTSParams): Promise<TTSResult>;
  };
  
  /** 通道操作 */
  channels: {
    sendMessage(channel: string, message: string): Promise<void>;
    getStatus(channel: string): ChannelStatus;
  };
  
  /** 会话操作 */
  sessions: {
    get(sessionKey: string): Session;
    list(): Session[];
  };
  
  /** 工具调用 */
  tools: {
    invoke(name: string, params: unknown): Promise<ToolResult>;
  };
  
  /** 日志 */
  logger: Logger;
}
```

---

## 4. 扩展点详解

### 4.1 注册通道

```typescript
// index.ts

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export default function register(api: OpenClawPluginApi) {
  api.registerChannel({
    plugin: {
      id: "mychannel",
      meta: {
        id: "mychannel",
        label: "My Channel",
        selectionLabel: "My Channel (API)",
        docsPath: "/channels/mychannel",
        blurb: "Custom messaging channel via API.",
      },
      capabilities: {
        chatTypes: ["direct"],
        supports: { mentions: true },
      },
      config: {
        listAccountIds: (cfg) => Object.keys(cfg.channels?.mychannel?.accounts ?? {}),
        resolveAccount: (cfg, id) => cfg.channels?.mychannel?.accounts?.[id ?? "default"],
      },
      outbound: {
        deliveryMode: "direct",
        sendText: async ({ text, target, account }) => {
          // 实现发送逻辑
          return { ok: true };
        },
      },
    },
  });
}
```

### 4.2 注册工具

```typescript
// index.ts

import { Type } from "@sinclair/typebox";

export default function register(api: OpenClawPluginApi) {
  api.registerTool({
    name: "my_api_query",
    description: "Query My API for data",
    parameters: Type.Object({
      endpoint: Type.String({
        description: "API endpoint path",
        examples: ["/users", "/orders"],
      }),
    }),
    execute: async ({ args, context }) => {
      const pluginConfig = api.config;
      const response = await fetch(`${pluginConfig.endpoint}${args.endpoint}`, {
        headers: { Authorization: `Bearer ${pluginConfig.apiKey}` },
      });
      
      const data = await response.json();
      return {
        type: "json",
        content: JSON.stringify(data, null, 2),
      };
    },
  });
}
```

### 4.3 注册 Gateway RPC 方法

```typescript
// index.ts

export default function register(api: OpenClawPluginApi) {
  api.registerGatewayMethod("myplugin.status", ({ respond, context }) => {
    const status = {
      plugin: api.id,
      version: "1.0.0",
      uptime: process.uptime(),
      config: api.config,
    };
    
    respond(true, status);
  });
  
  // 带参数的 RPC 方法
  api.registerGatewayMethod("myplugin.query", ({ params, respond }) => {
    const { query } = params;
    
    // 执行查询
    const result = performQuery(query);
    
    respond(true, { result });
  });
}
```

### 4.4 注册 HTTP 路由

```typescript
// index.ts

import type { Request, Response } from "express";

export default function register(api: OpenClawPluginApi) {
  api.registerHttpRoute("/myplugin/webhook", async (req: Request, res: Response) => {
    try {
      // 验证 webhook 签名
      const signature = req.headers["x-signature"];
      if (!verifySignature(req.body, signature)) {
        res.status(401).json({ error: "Invalid signature" });
        return;
      }
      
      // 处理 webhook
      await handleWebhook(req.body);
      
      res.json({ received: true });
    } catch (error) {
      api.logger.error("Webhook error:", error);
      res.status(500).json({ error: "Internal error" });
    }
  });
}
```

### 4.5 注册 CLI 命令

```typescript
// index.ts

export default function register(api: OpenClawPluginApi) {
  api.registerCli(
    (program) => {
      const cmd = program
        .command("myplugin")
        .description("My Plugin commands");
      
      cmd
        .command("status")
        .description("Show plugin status")
        .action(async () => {
          console.log("Plugin Status:");
          console.log(`  ID: ${api.id}`);
          console.log(`  Config:`, api.config);
        });
      
      cmd
        .command("sync")
        .description("Sync data")
        .option("-f, --force", "Force sync")
        .action(async (options) => {
          console.log("Syncing...", options.force ? "(forced)" : "");
          // 执行同步
        });
    },
    { commands: ["myplugin", "myplugin:status", "myplugin:sync"] }
  );
}
```

### 4.6 注册后台服务

```typescript
// index.ts

export default function register(api: OpenClawPluginApi) {
  let intervalId: NodeJS.Timeout;
  
  api.registerService({
    id: "myplugin-sync",
    
    start: () => {
      api.logger.info("Starting sync service...");
      
      // 定期同步
      intervalId = setInterval(async () => {
        try {
          await performSync();
          api.logger.debug("Sync completed");
        } catch (error) {
          api.logger.error("Sync failed:", error);
        }
      }, 60000);  // 每分钟
    },
    
    stop: () => {
      api.logger.info("Stopping sync service...");
      clearInterval(intervalId);
    },
  });
}
```

### 4.7 注册自动回复命令

```typescript
// index.ts

export default function register(api: OpenClawPluginApi) {
  api.registerCommand({
    name: "mystatus",
    description: "Show my plugin status",
    handler: (ctx) => {
      return {
        text: `Plugin ${api.id} is running! Channel: ${ctx.channel}`,
      };
    },
  });
  
  // 带参数的命令
  api.registerCommand({
    name: "setmode",
    description: "Set plugin mode",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const mode = ctx.args?.trim() || "default";
      await saveMode(mode);
      return { text: `Mode set to: ${mode}` };
    },
  });
}
```

### 4.8 注册模型提供者

```typescript
// index.ts

export default function register(api: OpenClawPluginApi) {
  api.registerProvider({
    id: "acme",
    label: "Acme AI",
    
    auth: [
      {
        id: "oauth",
        label: "OAuth",
        kind: "oauth",
        
        run: async (ctx) => {
          // 启动 OAuth 流程
          const { code } = await ctx.oauth.createVpsAwareHandlers({
            provider: "acme",
            clientId: "xxx",
          });
          
          // 交换 token
          const tokens = await exchangeCode(code);
          
          return {
            profiles: [
              {
                profileId: "acme:default",
                credential: {
                  type: "oauth",
                  provider: "acme",
                  access: tokens.access_token,
                  refresh: tokens.refresh_token,
                  expires: Date.now() + tokens.expires_in * 1000,
                },
              },
            ],
            defaultModel: "acme/opus-1",
            configPatch: {
              models: [
                { id: "acme/opus-1", provider: "acme" },
              ],
            },
          };
        },
      },
      {
        id: "apikey",
        label: "API Key",
        kind: "apiKey",
        
        run: async (ctx) => {
          const apiKey = await ctx.prompter.password("Enter API Key:");
          
          return {
            profiles: [
              {
                profileId: "acme:default",
                credential: {
                  type: "apiKey",
                  provider: "acme",
                  key: apiKey,
                },
              },
            ],
          };
        },
      },
    ],
  });
}
```

---

## 5. 插件配置

### 5.1 配置 Schema

```json
// openclaw.plugin.json
{
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "enabled": {
        "type": "boolean",
        "default": true
      },
      "apiKey": {
        "type": "string"
      },
      "endpoint": {
        "type": "string",
        "format": "uri"
      },
      "timeout": {
        "type": "number",
        "minimum": 1000,
        "maximum": 60000,
        "default": 5000
      },
      "features": {
        "type": "object",
        "properties": {
          "featureA": { "type": "boolean", "default": true },
          "featureB": { "type": "boolean", "default": false }
        }
      }
    },
    "required": ["apiKey"]
  }
}
```

### 5.2 UI 提示

```json
// openclaw.plugin.json
{
  "uiHints": {
    "apiKey": {
      "label": "API Key",
      "description": "Your API key from the dashboard",
      "sensitive": true,
      "placeholder": "sk-..."
    },
    "endpoint": {
      "label": "API Endpoint",
      "description": "Base URL for API calls",
      "placeholder": "https://api.example.com"
    },
    "timeout": {
      "label": "Request Timeout",
      "description": "Maximum time to wait for API response (ms)"
    },
    "features": {
      "label": "Feature Flags",
      "collapsed": true
    },
    "features.featureA": {
      "label": "Enable Feature A",
      "description": "This enables advanced functionality"
    }
  }
}
```

### 5.3 读取配置

```typescript
// index.ts

export default function register(api: OpenClawPluginApi) {
  // 方式 1: 直接访问配置
  const config = api.config;
  const apiKey = config.apiKey;
  const timeout = config.timeout ?? 5000;
  
  // 方式 2: 运行时访问主配置
  const mainConfig = api.runtime.config;
  const agentModel = mainConfig.agent?.model;
  
  // 方式 3: 类型安全访问
  interface MyPluginConfig {
    apiKey: string;
    endpoint?: string;
    timeout?: number;
  }
  
  const typedConfig = api.config as MyPluginConfig;
}
```

---

## 6. 插件开发最佳实践

### 6.1 错误处理

```typescript
// ✅ 好的错误处理
async function fetchData() {
  try {
    const response = await fetch(api.config.endpoint);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    return await response.json();
  } catch (error) {
    api.logger.error("Failed to fetch data:", error);
    
    // 返回友好的错误
    return {
      error: true,
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
```

### 6.2 日志规范

```typescript
// ✅ 结构化日志
api.logger.info("Plugin initialized", {
  version: "1.0.0",
  config: {
    endpoint: api.config.endpoint,
    timeout: api.config.timeout,
  },
});

api.logger.debug("Processing request", { requestId: "123" });

api.logger.warn("Deprecated feature used", { feature: "oldApi" });

api.logger.error("Operation failed", {
  operation: "sync",
  error: error.message,
  stack: error.stack,
});
```

### 6.3 资源清理

```typescript
// ✅ 正确清理资源
let connection: Connection | null = null;

api.registerService({
  id: "my-service",
  
  start: async () => {
    connection = await createConnection(api.config);
  },
  
  stop: async () => {
    if (connection) {
      await connection.close();
      connection = null;
    }
  },
});

// ✅ 使用 AbortController
const controller = new AbortController();

fetch(url, { signal: controller.signal })
  .then(response => response.json())
  .catch(err => {
    if (err.name === "AbortError") {
      api.logger.debug("Request aborted");
    }
  });

// 停止时取消
api.registerService({
  id: "my-service",
  start: () => { /* ... */ },
  stop: () => controller.abort(),
});
```

### 6.4 类型安全

```typescript
// ✅ 定义类型
interface MyPluginConfig {
  apiKey: string;
  endpoint: string;
  features?: {
    enabled: boolean;
  };
}

interface MyData {
  id: string;
  name: string;
  value: number;
}

// ✅ 使用类型守卫
function isMyData(obj: unknown): obj is MyData {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "id" in obj &&
    "name" in obj &&
    "value" in obj
  );
}

// ✅ 泛型工具
async function fetchApi<T>(endpoint: string): Promise<T> {
  const response = await fetch(`${api.config.endpoint}${endpoint}`);
  return response.json() as Promise<T>;
}
```

---

## 7. 插件测试

### 7.1 单元测试

```typescript
// index.test.ts

import { describe, it, expect, vi } from "vitest";
import register from "./index.js";

describe("My Plugin", () => {
  it("should register tool", () => {
    const mockApi = {
      id: "my-plugin",
      config: { apiKey: "test" },
      logger: { info: vi.fn(), error: vi.fn() },
      registerTool: vi.fn(),
      registerGatewayMethod: vi.fn(),
    };
    
    register(mockApi);
    
    expect(mockApi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "my_tool",
        description: expect.any(String),
      })
    );
  });
  
  it("should handle errors", async () => {
    const tool = {
      name: "my_tool",
      execute: async ({ args }) => {
        if (!args.required) {
          return {
            type: "error",
            content: "Missing required parameter",
          };
        }
        return { type: "text", content: "OK" };
      },
    };
    
    const result = await tool.execute({ args: {} });
    expect(result.type).toBe("error");
  });
});
```

### 7.2 集成测试

```typescript
// e2e.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestGateway } from "../../test-helpers/e2e.js";

describe("My Plugin E2E", () => {
  let gateway;
  
  beforeAll(async () => {
    gateway = await startTestGateway({
      plugins: {
        entries: {
          "my-plugin": {
            enabled: true,
            config: { apiKey: "test-key" },
          },
        },
      },
    });
  });
  
  afterAll(async () => {
    await gateway.stop();
  });
  
  it("should respond to RPC method", async () => {
    const client = await gateway.connect();
    
    const response = await client.request("myplugin.status", {});
    
    expect(response.ok).toBe(true);
    expect(response.payload.plugin).toBe("my-plugin");
  });
});
```

---

## 8. 发布插件

### 8.1 准备发布

```bash
# 1. 更新版本号
npm version patch  # 或 minor/major

# 2. 运行测试
pnpm test

# 3. 检查配置
cat openclaw.plugin.json | jq .

# 4. 打包
npm pack
```

### 8.2 发布到 npm

```json
// package.json
{
  "name": "@your-scope/openclaw-my-plugin",
  "version": "1.0.0",
  "description": "My OpenClaw plugin",
  "main": "dist/index.js",
  "openclaw": {
    "extensions": ["./dist/index.js"]
  },
  "files": [
    "dist/",
    "openclaw.plugin.json",
    "README.md"
  ],
  "publishConfig": {
    "access": "public"
  }
}
```

```bash
# 发布
npm publish
```

### 8.3 用户安装

```bash
# 从 npm 安装
openclaw plugins install @your-scope/openclaw-my-plugin

# 本地开发安装
openclaw plugins install -l ./my-plugin

# 更新
openclaw plugins update my-plugin
```

---

## 9. 高级主题

### 9.1 插件间通信

```typescript
// 插件 A: 暴露 API
export const sharedApi = {
  async getData() {
    return { foo: "bar" };
  },
};

// 插件 B: 使用其他插件的 API
export default function register(api) {
  // 通过 Gateway 事件通信
  api.registerGatewayMethod("pluginB.callA", async ({ respond }) => {
    // 调用插件 A 的方法
    const result = await api.runtime.gateway.request("pluginA.getData");
    respond(true, result);
  });
}
```

### 9.2 插件钩子

```typescript
// hooks/my-hook/HOOK.md
---
event: message:inbound
---

# My Hook

处理入站消息的钩子。

```typescript
// hooks/my-hook/handler.ts
import type { HookHandler } from "openclaw/plugin-sdk";

export const handler: HookHandler = async (event, context) => {
  // 修改或增强事件
  if (event.text.includes("urgent")) {
    event.priority = "high";
  }
  
  return event;
};
```

// 注册钩子
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

### 9.3 插件 Slots

```typescript
// 声明插件类型
// openclaw.plugin.json
{
  "id": "my-memory",
  "kind": "memory",  // 声明为 memory 类型
  "configSchema": { /* ... */ }
}

// 用户配置选择
// openclaw.json
{
  "plugins": {
    "slots": {
      "memory": "my-memory"  // 选择使用 my-memory
    }
  }
}
```

---

## 10. 参考

### 10.1 官方插件示例

| 插件 | 路径 | 功能 |
|------|------|------|
| Voice Call | `extensions/voice-call/` | 语音通话 |
| Matrix | `extensions/matrix/` | Matrix 通道 |
| Teams | `extensions/msteams/` | Microsoft Teams |
| Memory Core | `extensions/memory-core/` | 记忆系统 |
| Nostr | `extensions/nostr/` | Nostr 协议 |

### 10.2 文档

- [Plugins Overview](/plugin)
- [Channel Plugins](/channels)
- [Agent Tools](/plugins/agent-tools)

---

*本手册涵盖了 Plugin SDK 的核心内容。更多高级用法请参考官方插件源码。*
