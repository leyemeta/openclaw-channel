# Gateway 模块二次开发指导手册

> 版本: 2026.1.30  
> 适用范围: Gateway WebSocket/HTTP 控制平面扩展

---

## 1. Gateway 架构概述

### 1.1 核心职责

Gateway 是 OpenClaw 的**控制平面**，负责：

1. **协议转换**: WebSocket/HTTP ↔ 内部事件
2. **连接管理**: 客户端、节点、通道的生命周期
3. **消息路由**: 入站消息 → Agent → 出站消息
4. **RPC 处理**: 处理客户端请求，返回响应或事件流
5. **插件集成**: 加载插件，注册扩展点

### 1.2 模块结构

```
src/gateway/
├── server*.ts                    # 核心服务器实现
│   ├── server-startup.ts         # 启动流程
│   ├── server-impl.ts            # 主实现
│   ├── server-ws-runtime.ts      # WS 运行时
│   └── server-*.ts               # 各功能模块
│
├── server-methods/               # RPC 方法处理器
│   ├── types.ts                  # 方法类型定义
│   └── ...                       # 各方法实现
│
├── protocol/                     # 协议定义
│   ├── schema.ts                 # TypeBox Schema
│   └── ...                       # 帧定义
│
├── client.ts                     # 客户端连接管理
├── auth.ts                       # 认证逻辑
├── boot.ts                       # 启动引导
├── call.ts                       # RPC 调用处理
└── ...                           # 其他工具模块
```

---

## 2. 开发环境准备

### 2.1 前置要求

```bash
# 1. Node.js ≥22
node --version  # v22.12.0+

# 2. pnpm
pnpm --version  # 10.23.0+

# 3. 安装依赖
pnpm install

# 4. 构建
pnpm build
```

### 2.2 启动 Gateway 开发模式

```bash
# 方式 1: 使用 tsx 直接运行 (推荐开发)
pnpm gateway:dev

# 方式 2: 带热重载
pnpm gateway:watch

# 方式 3: 跳过通道初始化（纯 Gateway 开发）
pnpm gateway:dev:reset
```

---

## 3. 添加新的 Gateway RPC 方法

### 3.1 场景

你需要添加一个新的 RPC 方法，让客户端可以调用 Gateway 的某项功能。

### 3.2 实现步骤

#### 步骤 1: 定义方法 Schema

```typescript
// src/gateway/protocol/schema.ts

import { Type } from "@sinclair/typebox";

// 请求参数 Schema
export const MyMethodParamsSchema = Type.Object({
  param1: Type.String(),
  param2: Type.Optional(Type.Number()),
});

// 响应 Schema
export const MyMethodResponseSchema = Type.Object({
  result: Type.String(),
  timestamp: Type.Number(),
});
```

#### 步骤 2: 实现方法处理器

```typescript
// src/gateway/server-methods/my-method.ts

import type { GatewayMethodHandler } from "./types.js";
import type { MyMethodParams, MyMethodResponse } from "../protocol/types.js";

export const handleMyMethod: GatewayMethodHandler<
  MyMethodParams,
  MyMethodResponse
> = async ({ params, context, respond }) => {
  // 1. 参数验证（可选，框架会自动验证）
  const { param1, param2 } = params;
  
  // 2. 执行业务逻辑
  const result = await doSomething(param1, param2);
  
  // 3. 发送成功响应
  respond(true, {
    result: result.toString(),
    timestamp: Date.now(),
  });
};

async function doSomething(param1: string, param2?: number): Promise<string> {
  // 实现业务逻辑
  return `Processed: ${param1}`;
}
```

#### 步骤 3: 注册方法

```typescript
// src/gateway/server-methods-list.ts

import { handleMyMethod } from "./server-methods/my-method.js";

export const methodHandlers: Record<string, GatewayMethodHandler> = {
  // ... 现有方法
  "myMethod": handleMyMethod,  // 添加新方法
};
```

#### 步骤 4: 添加类型定义（可选）

```typescript
// src/gateway/protocol/types.ts

import type { Static } from "@sinclair/typebox";
import {
  MyMethodParamsSchema,
  MyMethodResponseSchema,
} from "./schema.js";

export type MyMethodParams = Static<typeof MyMethodParamsSchema>;
export type MyMethodResponse = Static<typeof MyMethodResponseSchema>;
```

### 3.3 完整示例：自定义状态查询

```typescript
// src/gateway/server-methods/custom-status.ts

import type { GatewayMethodHandler } from "./types.js";

interface CustomStatusParams {
  includeDetails?: boolean;
}

interface CustomStatusResponse {
  status: "healthy" | "degraded" | "unhealthy";
  uptime: number;
  details?: Record<string, unknown>;
}

export const handleCustomStatus: GatewayMethodHandler<
  CustomStatusParams,
  CustomStatusResponse
> = async ({ params, context, respond }) => {
  const { runtime } = context;
  
  // 获取 Gateway 状态
  const uptime = process.uptime();
  const memoryUsage = process.memoryUsage();
  
  // 判断健康状态
  let status: "healthy" | "degraded" | "unhealthy" = "healthy";
  if (memoryUsage.heapUsed > 500 * 1024 * 1024) {
    status = "degraded";
  }
  
  const response: CustomStatusResponse = {
    status,
    uptime,
  };
  
  // 可选的详细信息
  if (params.includeDetails) {
    response.details = {
      memory: memoryUsage,
      pid: process.pid,
      version: runtime.version,
      channels: runtime.channelManager.getStatus(),
    };
  }
  
  respond(true, response);
};
```

---

## 4. 添加事件推送

### 4.1 场景

Gateway 需要主动向客户端推送事件（如状态变更、消息通知）。

### 4.2 实现方式

#### 方式 1: 广播事件（所有客户端）

```typescript
// src/gateway/server-broadcast.ts

import { broadcastEvent } from "./server-broadcast.js";

// 广播事件给所有连接的客户端
broadcastEvent({
  type: "event",
  event: "system:notification",
  payload: {
    message: "系统即将维护",
    level: "warning",
  },
});
```

#### 方式 2: 向特定客户端推送

```typescript
// 在方法处理器中
export const handleSubscribe: GatewayMethodHandler = async ({
  context,
  respond,
}) => {
  const { client } = context;
  
  // 存储客户端订阅
  context.runtime.subscriptionManager.add(client.id, "custom:events");
  
  // 发送确认
  respond(true, { subscribed: true });
  
  // 稍后向该客户端推送事件
  setInterval(() => {
    client.send({
      type: "event",
      event: "custom:tick",
      payload: { time: Date.now() },
    });
  }, 5000);
};
```

### 4.3 自定义事件类型

```typescript
// src/gateway/server-node-events-types.ts

// 添加自定义事件类型
export interface CustomEvents {
  "custom:notification": {
    title: string;
    body: string;
    data?: Record<string, unknown>;
  };
  
  "custom:progress": {
    taskId: string;
    progress: number;
    message?: string;
  };
}

// 在原有事件类型中扩展
declare module "./server-node-events-types.js" {
  interface GatewayEvents extends CustomEvents {}
}
```

---

## 5. 修改协议 Schema

### 5.1 场景

需要修改 Gateway 协议的数据结构（添加新字段、修改验证规则）。

### 5.2 Schema 文件位置

```
src/gateway/protocol/
├── schema.ts              # 主要 Schema 定义
├── schema.config.ts       # 配置相关 Schema
├── schema.channels.ts     # 通道相关 Schema
└── schema.agent.ts        # Agent 相关 Schema
```

### 5.3 添加新字段示例

```typescript
// src/gateway/protocol/schema.ts

import { Type } from "@sinclair/typebox";

// 现有 ConnectParamsSchema
export const ConnectParamsSchema = Type.Object({
  role: Type.Union([Type.Literal("client"), Type.Literal("node")]),
  deviceId: Type.String(),
  token: Type.Optional(Type.String()),
  // 添加新字段
  capabilities: Type.Optional(
    Type.Array(Type.String())
  ),
  version: Type.Optional(Type.String()),
});

// 现有 AgentParamsSchema
export const AgentParamsSchema = Type.Object({
  message: Type.String(),
  sessionKey: Type.String(),
  thinking: Type.Optional(ThinkingLevelSchema),
  // 添加新字段
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  priority: Type.Optional(Type.Number({ minimum: 0, maximum: 10 })),
});
```

### 5.4 生成 JSON Schema

```bash
# 重新生成协议 Schema
pnpm protocol:gen

# 生成 Swift 模型（macOS/iOS 客户端使用）
pnpm protocol:gen:swift
```

---

## 6. 集成插件系统

### 6.1 场景

Gateway 需要暴露 API 给插件使用，或让插件注册 Gateway 功能。

### 6.2 插件 API 上下文

```typescript
// src/gateway/server-plugins.ts

export interface GatewayPluginContext {
  // Gateway 运行时
  runtime: GatewayRuntime;
  
  // 方法注册
  registerMethod: (
    method: string,
    handler: GatewayMethodHandler
  ) => void;
  
  // HTTP 路由注册
  registerHttpRoute: (
    path: string,
    handler: HttpHandler
  ) => void;
  
  // 事件广播
  broadcast: (event: GatewayEvent) => void;
  
  // 日志
  logger: Logger;
}
```

### 6.3 插件注册点扩展

```typescript
// src/gateway/server-plugins.ts

export function loadPlugins(runtime: GatewayRuntime): void {
  for (const plugin of runtime.plugins) {
    const context: GatewayPluginContext = {
      runtime,
      registerMethod: (method, handler) => {
        runtime.methodHandlers[method] = handler;
        runtime.logger.info(`Plugin registered method: ${method}`);
      },
      registerHttpRoute: (path, handler) => {
        runtime.httpRoutes[path] = handler;
      },
      broadcast: (event) => broadcastEvent(event),
      logger: runtime.logger.child({ plugin: plugin.id }),
    };
    
    // 调用插件注册函数
    plugin.register(context);
  }
}
```

---

## 7. 添加 HTTP API 端点

### 7.1 场景

除了 WebSocket，还需要提供 HTTP REST API。

### 7.2 实现方式

#### 步骤 1: 定义处理器

```typescript
// src/gateway/http-handlers/custom-api.ts

import type { Request, Response } from "express";
import type { GatewayRuntime } from "../server-runtime.js";

export function createCustomApiHandler(runtime: GatewayRuntime) {
  return async (req: Request, res: Response) => {
    try {
      // 验证认证
      const token = req.headers.authorization?.replace("Bearer ", "");
      if (!validateToken(token, runtime.config)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      
      // 处理请求
      const result = await handleRequest(req.body, runtime);
      
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };
}

async function handleRequest(body: unknown, runtime: GatewayRuntime) {
  // 实现业务逻辑
  return { processed: true };
}
```

#### 步骤 2: 注册路由

```typescript
// src/gateway/server-http.ts

import { createCustomApiHandler } from "./http-handlers/custom-api.js";

export function setupHttpRoutes(app: Express, runtime: GatewayRuntime): void {
  // ... 现有路由
  
  // 添加新路由
  app.post("/v1/custom/endpoint", createCustomApiHandler(runtime));
}
```

---

## 8. 修改客户端连接逻辑

### 8.1 场景

需要修改客户端连接时的验证、初始化逻辑。

### 8.2 连接处理流程

```typescript
// src/gateway/client.ts

export class GatewayClient {
  constructor(
    private ws: WebSocket,
    private runtime: GatewayRuntime
  ) {
    this.setupHandlers();
  }
  
  private setupHandlers(): void {
    this.ws.on("message", (data) => this.handleMessage(data));
    this.ws.on("close", () => this.handleClose());
    this.ws.on("error", (err) => this.handleError(err));
  }
  
  private async handleMessage(data: RawData): Promise<void> {
    // 1. 解析消息
    const frame = parseFrame(data);
    
    // 2. 验证帧格式
    if (!validateFrame(frame)) {
      this.sendError("Invalid frame format");
      return;
    }
    
    // 3. 处理连接帧（第一个帧必须是 connect）
    if (!this.isConnected && frame.method !== "connect") {
      this.sendError("First frame must be connect");
      this.ws.close();
      return;
    }
    
    // 4. 路由到对应处理器
    await this.routeFrame(frame);
  }
  
  // 可以在这里添加自定义验证逻辑
  private async validateConnection(params: ConnectParams): Promise<boolean> {
    // 自定义验证：检查设备 ID 格式
    if (!isValidDeviceId(params.deviceId)) {
      return false;
    }
    
    // 自定义验证：检查版本兼容性
    if (params.version) {
      const minVersion = "2026.1.0";
      if (!satisfiesVersion(params.version, minVersion)) {
        return false;
      }
    }
    
    return true;
  }
}
```

---

## 9. 添加配置热重载支持

### 9.1 场景

Gateway 需要支持配置变更时自动重载，无需重启。

### 9.2 实现方式

```typescript
// src/gateway/config-reload.ts

import { watch } from "chokidar";

export function setupConfigWatcher(runtime: GatewayRuntime): void {
  const configPath = getConfigPath();
  
  const watcher = watch(configPath, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });
  
  watcher.on("change", async () => {
    runtime.logger.info("Config file changed, reloading...");
    
    try {
      // 1. 加载新配置
      const newConfig = await loadConfig(configPath);
      
      // 2. 验证配置
      validateConfig(newConfig);
      
      // 3. 应用配置变更
      await applyConfigChanges(runtime, newConfig);
      
      // 4. 广播配置重载事件
      broadcastEvent({
        type: "event",
        event: "config:reload",
        payload: { timestamp: Date.now() },
      });
      
      runtime.logger.info("Config reloaded successfully");
    } catch (error) {
      runtime.logger.error("Config reload failed:", error);
    }
  });
}

async function applyConfigChanges(
  runtime: GatewayRuntime,
  newConfig: OpenClawConfig
): Promise<void> {
  // 对比新旧配置，应用变更
  const changes = diffConfig(runtime.config, newConfig);
  
  for (const change of changes) {
    switch (change.type) {
      case "channel":
        await runtime.channelManager.updateConfig(change.key, change.value);
        break;
      case "agent":
        runtime.agentBridge.updateConfig(change.value);
        break;
      case "plugin":
        await runtime.pluginManager.updateConfig(change.value);
        break;
    }
  }
  
  // 更新运行时配置
  runtime.config = newConfig;
}
```

---

## 10. 调试与测试

### 10.1 本地调试

```bash
# 1. 启动 Gateway（调试模式）
DEBUG=openclaw:gateway pnpm gateway:dev

# 2. 使用 wscat 测试 WebSocket
pnpm dlx wscat -c ws://127.0.0.1:18789

# 3. 发送连接帧
> {"type":"req","id":"1","method":"connect","params":{"role":"client","deviceId":"test-001"}}

# 4. 发送 Agent 请求
> {"type":"req","id":"2","method":"agent","params":{"message":"Hello","sessionKey":"test/session"}}
```

### 10.2 单元测试

```typescript
// src/gateway/server-methods/my-method.test.ts

import { describe, it, expect } from "vitest";
import { handleMyMethod } from "./my-method.js";
import { createMockContext } from "../../test-helpers/gateway.js";

describe("handleMyMethod", () => {
  it("should return success response", async () => {
    const context = createMockContext();
    
    await handleMyMethod({
      params: { param1: "test" },
      context,
      respond: (ok, payload) => {
        expect(ok).toBe(true);
        expect(payload.result).toContain("test");
      },
    });
  });
  
  it("should handle errors", async () => {
    const context = createMockContext();
    
    await handleMyMethod({
      params: { param1: "" },  // 空参数
      context,
      respond: (ok, payload) => {
        expect(ok).toBe(false);
        expect(payload.error).toBeDefined();
      },
    });
  });
});
```

### 10.3 E2E 测试

```typescript
// src/gateway/my-feature.e2e.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestGateway, TestClient } from "../test-helpers/e2e.js";

describe("My Feature E2E", () => {
  let gateway: TestGateway;
  let client: TestClient;
  
  beforeAll(async () => {
    gateway = await startTestGateway();
    client = await gateway.connect({ role: "client", deviceId: "test" });
  });
  
  afterAll(async () => {
    await client.disconnect();
    await gateway.stop();
  });
  
  it("should handle myMethod RPC", async () => {
    const response = await client.request("myMethod", {
      param1: "test",
    });
    
    expect(response.ok).toBe(true);
    expect(response.payload.result).toBeDefined();
  });
});
```

---

## 11. 最佳实践

### 11.1 代码规范

1. **使用 TypeBox 定义 Schema**: 所有 RPC 参数/响应必须有 Schema
2. **异步处理**: 所有处理器必须是 async 函数
3. **错误处理**: 使用 try-catch，返回规范的错误格式
4. **日志记录**: 使用 context.runtime.logger，带上下文

### 11.2 性能优化

1. **避免阻塞**: 长时间操作使用异步或流式响应
2. **缓存**: 频繁访问的数据可以缓存
3. **批量处理**: 批量操作优先于多次单条操作

### 11.3 安全注意事项

1. **验证输入**: 不要信任客户端输入
2. **权限检查**: 敏感操作检查用户权限
3. **限流**: 对高频接口实施限流

---

## 12. 参考文档

- [Gateway Protocol](/gateway/protocol)
- [Architecture Overview](/concepts/architecture)
- [Plugin SDK](/plugin-sdk)

---

*本手册涵盖了 Gateway 模块的常见扩展场景。如需更复杂的定制，请参考源码和现有实现。*
