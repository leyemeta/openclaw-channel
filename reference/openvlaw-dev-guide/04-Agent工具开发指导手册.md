# Agent 工具开发指导手册

> 版本: 2026.1.30  
> 适用范围: Agent 工具（Tools）开发

---

## 1. Agent 工具概述

### 1.1 什么是 Agent Tool

Agent Tool 是 AI Agent 可调用的功能单元。当用户发送消息时，Agent 可以：

1. **理解意图** - 分析用户需求
2. **选择工具** - 决定调用哪个工具
3. **执行工具** - 运行工具代码
4. **返回结果** - 将结果呈现给用户

### 1.2 工具分类

| 类别 | 示例 | 说明 |
|------|------|------|
| **系统工具** | `bash`, `read`, `write` | 系统级操作 |
| **通道工具** | `discord_*`, `slack_*` | 消息平台操作 |
| **自动化工具** | `browser`, `canvas`, `cron` | 自动化能力 |
| **设备工具** | `nodes` | 设备节点控制 |
| **自定义工具** | `my_api`, `my_database` | 用户/插件扩展 |

### 1.3 工具调用流程

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│   User   │────▶│  Agent   │────▶│  Select  │────▶│  Execute │
│  Message │     │  Think   │     │   Tool   │     │   Tool   │
└──────────┘     └──────────┘     └────┬─────┘     └────┬─────┘
                                       │                │
                                       │                ▼
                                       │         ┌──────────┐
                                       │         │  Return  │
                                       │         │  Result  │
                                       │         └────┬─────┘
                                       │                │
                                       └────────────────┘
                                                          │
                                                          ▼
                                                   ┌──────────┐
                                                   │  Agent   │
                                                   │ Response │
                                                   └──────────┘
```

---

## 2. 工具接口定义

### 2.1 基础接口

```typescript
// src/agents/tools/types.ts

interface AgentTool {
  /** 工具名称 */
  name: string;
  
  /** 工具描述（告诉 Agent 何时使用） */
  description: string;
  
  /** 参数 Schema（TypeBox） */
  parameters: TSchema;
  
  /** 执行函数 */
  execute: ToolExecuteFunction;
}

type ToolExecuteFunction = (
  params: ToolExecuteParams
) => AsyncIterable<ToolResult> | Promise<ToolResult>;

interface ToolExecuteParams {
  /** 解析后的参数 */
  args: Record<string, unknown>;
  
  /** 工具上下文 */
  context: ToolContext;
}

interface ToolContext {
  /** 会话标识 */
  sessionKey: string;
  
  /** 消息通道 */
  channel: string;
  
  /** 发送者 ID */
  senderId: string;
  
  /** 当前配置 */
  config: OpenClawConfig;
  
  /** 运行时依赖 */
  deps: ToolRuntimeDeps;
}
```

### 2.2 工具结果

```typescript
interface ToolResult {
  /** 结果类型 */
  type: "text" | "image" | "error" | "json";
  
  /** 结果内容 */
  content: string;
  
  /** 额外数据 */
  data?: Record<string, unknown>;
  
  /** 是否完成 */
  done?: boolean;
}
```

---

## 3. 开发内置工具

### 3.1 创建新工具文件

```typescript
// src/agents/tools/my-tool.ts

import { Type } from "@sinclair/typebox";
import type { AgentTool } from "./types.js";

export const myTool: AgentTool = {
  name: "my_tool",
  
  description: `
    描述工具的功能和用途。
    告诉 Agent 在什么情况下应该使用这个工具。
    例如：当用户需要查询天气时使用此工具。
  `.trim(),
  
  parameters: Type.Object({
    location: Type.String({
      description: "城市名称，如 '北京'",
    }),
    date: Type.Optional(Type.String({
      description: "日期，格式 YYYY-MM-DD，默认为今天",
    })),
    includeDetails: Type.Optional(Type.Boolean({
      description: "是否包含详细天气信息",
      default: false,
    })),
  }),
  
  execute: async ({ args, context }) => {
    const { location, date, includeDetails } = args;
    
    try {
      // 执行业务逻辑
      const weather = await fetchWeather(location, date);
      
      // 格式化结果
      let result = `**${location}** 天气：\n`;
      result += `- 温度：${weather.temperature}°C\n`;
      result += `- 天气：${weather.condition}\n`;
      
      if (includeDetails) {
        result += `- 湿度：${weather.humidity}%\n`;
        result += `- 风速：${weather.windSpeed} km/h\n`;
      }
      
      return {
        type: "text",
        content: result,
      };
    } catch (error) {
      return {
        type: "error",
        content: `查询天气失败: ${error instanceof Error ? error.message : "未知错误"}`,
      };
    }
  },
};

async function fetchWeather(
  location: string,
  date?: string
): Promise<WeatherData> {
  // 实现天气查询逻辑
  const response = await fetch(
    `https://api.weather.com/v1/current?city=${encodeURIComponent(location)}&date=${date ?? ""}`
  );
  
  if (!response.ok) {
    throw new Error(`API 错误: ${response.status}`);
  }
  
  return response.json();
}

interface WeatherData {
  temperature: number;
  condition: string;
  humidity: number;
  windSpeed: number;
}
```

### 3.2 注册工具

```typescript
// src/agents/tools/index.ts

import { myTool } from "./my-tool.js";

export const builtinTools: AgentTool[] = [
  // ... 现有工具
  myTool,
];
```

### 3.3 流式输出工具

```typescript
// src/agents/tools/streaming-example.ts

import { Type } from "@sinclair/typebox";
import type { AgentTool } from "./types.js";

export const streamingTool: AgentTool = {
  name: "streaming_example",
  
  description: "演示流式输出的工具",
  
  parameters: Type.Object({
    duration: Type.Number({
      description: "执行时长（秒）",
      default: 5,
    }),
  }),
  
  // 使用生成器实现流式输出
  execute: async function* ({ args }) {
    const { duration } = args;
    const steps = duration * 2;  // 每 0.5 秒输出一次
    
    for (let i = 0; i < steps; i++) {
      const progress = ((i + 1) / steps) * 100;
      
      yield {
        type: "text",
        content: `进度: ${progress.toFixed(0)}%\n`,
        done: false,
      };
      
      // 模拟处理时间
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // 最终结果
    yield {
      type: "text",
      content: "✅ 处理完成！",
      done: true,
    };
  },
};
```

---

## 4. 工具上下文和依赖

### 4.1 可用上下文

```typescript
interface ToolContext {
  // 会话信息
  sessionKey: string;
  channel: string;
  accountId?: string;
  senderId: string;
  senderName?: string;
  
  // 配置
  config: OpenClawConfig;
  
  // 运行时依赖
  deps: {
    // 日志
    logger: Logger;
    
    // 通道操作
    channelSend: (message: string) => Promise<void>;
    
    // 会话操作
    getSession: () => Session;
    updateSession: (patch: Partial<Session>) => Promise<void>;
    
    // 节点调用
    invokeNode: (command: string, params: unknown) => Promise<unknown>;
    
    // 浏览器
    browser: BrowserController;
    
    // 文件系统
    workspace: WorkspaceAccess;
    
    // 其他...
  };
}
```

### 4.2 使用示例

```typescript
export const toolWithContext: AgentTool = {
  name: "context_example",
  
  description: "演示如何使用工具上下文",
  
  parameters: Type.Object({}),
  
  execute: async ({ args, context }) => {
    const { logger, channelSend, getSession, config } = context;
    
    // 1. 记录日志
    logger.info("Tool executed", { sessionKey: context.sessionKey });
    
    // 2. 发送中间消息到通道
    await channelSend("正在处理中...");
    
    // 3. 获取会话信息
    const session = getSession();
    logger.debug("Session state", { model: session.model });
    
    // 4. 读取配置
    const toolConfig = config.agents?.defaults?.toolPolicy;
    
    // 5. 执行操作...
    
    return {
      type: "text",
      content: "处理完成",
    };
  },
};
```

---

## 5. 高级工具开发

### 5.1 带审批的工具

```typescript
// src/agents/tools/elevated-tool.ts

import { Type } from "@sinclair/typebox";
import type { AgentTool } from "./types.js";

export const elevatedTool: AgentTool = {
  name: "system_command",
  
  description: `
    执行系统命令（需要审批）。
    仅在用户明确要求时调用。
  `.trim(),
  
  parameters: Type.Object({
    command: Type.String({
      description: "要执行的 shell 命令",
    }),
  }),
  
  execute: async ({ args, context }) => {
    const { command } = args;
    const { deps, config, sessionKey } = context;
    
    // 1. 检查是否需要审批
    const needsApproval = !context.isElevated;
    
    if (needsApproval) {
      // 2. 创建审批请求
      const approvalId = await deps.requestApproval({
        sessionKey,
        tool: "system_command",
        params: { command },
        description: `执行命令: ${command}`,
      });
      
      // 3. 等待审批
      const approved = await deps.waitForApproval(approvalId, {
        timeout: 300000,  // 5 分钟超时
      });
      
      if (!approved) {
        return {
          type: "error",
          content: "命令执行被拒绝或超时",
        };
      }
    }
    
    // 4. 执行命令
    try {
      const result = await deps.execCommand(command);
      
      return {
        type: "text",
        content: `命令执行结果:\n\`\`\`\n${result.stdout}\n\`\`\``,
      };
    } catch (error) {
      return {
        type: "error",
        content: `执行失败: ${error.message}`,
      };
    }
  },
};
```

### 5.2 多步骤工具

```typescript
// src/agents/tools/multi-step-tool.ts

import { Type } from "@sinclair/typebox";
import type { AgentTool } from "./types.js";

export const multiStepTool: AgentTool = {
  name: "deploy_service",
  
  description: `
    部署服务到生产环境。
    这是一个多步骤操作，包含：构建、测试、部署。
  `.trim(),
  
  parameters: Type.Object({
    service: Type.String({
      description: "服务名称",
    }),
    version: Type.String({
      description: "版本号",
    }),
  }),
  
  execute: async function* ({ args, context }) {
    const { service, version } = args;
    const { logger } = context.deps;
    
    // 步骤 1: 构建
    yield {
      type: "text",
      content: `🔨 步骤 1/3: 构建 ${service}:${version}...`,
      done: false,
    };
    
    try {
      await buildService(service, version);
      yield {
        type: "text",
        content: `✅ 构建完成\n`,
        done: false,
      };
    } catch (error) {
      yield {
        type: "error",
        content: `❌ 构建失败: ${error.message}`,
        done: true,
      };
      return;
    }
    
    // 步骤 2: 测试
    yield {
      type: "text",
      content: `🧪 步骤 2/3: 运行测试...`,
      done: false,
    };
    
    const testResults = await runTests(service);
    if (!testResults.passed) {
      yield {
        type: "error",
        content: `❌ 测试失败:\n${testResults.failures.join("\n")}`,
        done: true,
      };
      return;
    }
    
    yield {
      type: "text",
      content: `✅ 测试通过 (${testResults.count} 个)\n`,
      done: false,
    };
    
    // 步骤 3: 部署
    yield {
      type: "text",
      content: `🚀 步骤 3/3: 部署到生产环境...`,
      done: false,
    };
    
    await deployService(service, version);
    
    yield {
      type: "text",
      content: `✅ 部署完成！\n服务 ${service}:${version} 已上线。`,
      done: true,
    };
  },
};
```

### 5.3 工具组合

```typescript
// src/agents/tools/composite-tool.ts

import { Type } from "@sinclair/typebox";
import type { AgentTool } from "./types.js";

export const compositeTool: AgentTool = {
  name: "analyze_and_chart",
  
  description: `
    分析数据并生成图表。
    组合了数据分析工具和图表生成工具。
  `.trim(),
  
  parameters: Type.Object({
    data: Type.String({
      description: "数据 URL 或文件路径",
    }),
    analysisType: Type.Enum({
      summary: "摘要统计",
      trend: "趋势分析",
      correlation: "相关性分析",
    }),
    chartType: Type.Enum({
      bar: "柱状图",
      line: "折线图",
      pie: "饼图",
    }),
  }),
  
  execute: async ({ args, context }) => {
    const { data, analysisType, chartType } = args;
    const { deps } = context;
    
    // 1. 调用数据分析工具
    const analysisResult = await deps.invokeTool("analyze_data", {
      source: data,
      type: analysisType,
    });
    
    // 2. 调用图表生成工具
    const chartResult = await deps.invokeTool("generate_chart", {
      data: analysisResult.data,
      type: chartType,
    });
    
    // 3. 组合结果
    return {
      type: "text",
      content: [
        "## 数据分析结果",
        analysisResult.content,
        "",
        "## 可视化图表",
        chartResult.content,
      ].join("\n"),
      data: {
        analysis: analysisResult.data,
        chart: chartResult.data,
      },
    };
  },
};
```

---

## 6. 插件中的工具开发

### 6.1 注册插件工具

```typescript
// extensions/my-plugin/index.ts

import { Type } from "@sinclair/typebox";

export default function register(api) {
  // 注册自定义工具
  api.registerTool({
    name: "my_api_query",
    
    description: `
      查询 My API 的数据。
      当用户需要获取特定业务数据时使用此工具。
    `.trim(),
    
    parameters: Type.Object({
      endpoint: Type.String({
        description: "API 端点",
        examples: ["/users", "/orders"],
      }),
      method: Type.Enum({
        GET: "GET",
        POST: "POST",
        PUT: "PUT",
        DELETE: "DELETE",
      }, {
        default: "GET",
      }),
      params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    
    execute: async ({ args, context }) => {
      const { endpoint, method, params } = args;
      const { config } = context;
      
      // 获取插件配置
      const pluginConfig = config.plugins?.entries?.myplugin?.config;
      const apiKey = pluginConfig?.apiKey;
      const baseUrl = pluginConfig?.baseUrl ?? "https://api.example.com";
      
      try {
        const response = await fetch(`${baseUrl}${endpoint}`, {
          method,
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: method !== "GET" ? JSON.stringify(params) : undefined,
        });
        
        const data = await response.json();
        
        return {
          type: "json",
          content: JSON.stringify(data, null, 2),
          data,
        };
      } catch (error) {
        return {
          type: "error",
          content: `API 调用失败: ${error.message}`,
        };
      }
    },
  });
}
```

### 6.2 使用运行时依赖

```typescript
// extensions/my-plugin/tools.ts

import type { PluginAPI } from "openclaw/plugin-sdk";

export function registerTools(api: PluginAPI) {
  api.registerTool({
    name: "tts_custom",
    
    description: "使用自定义 TTS 服务",
    
    parameters: Type.Object({
      text: Type.String(),
      voice: Type.Optional(Type.String()),
    }),
    
    execute: async ({ args, context }) => {
      // 使用运行时提供的 TTS 服务
      const result = await api.runtime.tts.textToSpeech({
        text: args.text,
        voice: args.voice,
      });
      
      return {
        type: "text",
        content: `已生成语音: ${result.duration}s`,
        data: { audioUrl: result.url },
      };
    },
  });
}
```

---

## 7. 工具 Schema 最佳实践

### 7.1 参数设计原则

```typescript
// ✅ 好的实践：清晰的描述和约束
parameters: Type.Object({
  city: Type.String({
    description: "城市名称，如 '北京'、'Shanghai'",
    minLength: 1,
    maxLength: 100,
  }),
  days: Type.Number({
    description: "预报天数",
    minimum: 1,
    maximum: 7,
    default: 3,
  }),
  units: Type.Enum({
    metric: "摄氏度",
    imperial: "华氏度",
  }, {
    default: "metric",
  }),
});

// ❌ 避免：模糊或不完整的定义
parameters: Type.Object({
  city: Type.String(),  // 缺少描述
  days: Type.Number(),  // 缺少范围和默认值
});
```

### 7.2 使用 $id 复用 Schema

```typescript
// src/agents/tools/common-schemas.ts

import { Type } from "@sinclair/typebox";

// 定义可复用的 Schema
export const DateRangeSchema = Type.Object({
  start: Type.String({ format: "date" }),
  end: Type.String({ format: "date" }),
}, { $id: "DateRange" });

export const PaginationSchema = Type.Object({
  page: Type.Number({ default: 1, minimum: 1 }),
  limit: Type.Number({ default: 20, minimum: 1, maximum: 100 }),
}, { $id: "Pagination" });
```

```typescript
// 在其他工具中引用
import { DateRangeSchema, PaginationSchema } from "./common-schemas.js";

parameters: Type.Object({
  dateRange: Type.Ref(DateRangeSchema),
  pagination: Type.Ref(PaginationSchema),
});
```

---

## 8. 测试工具

### 8.1 单元测试

```typescript
// src/agents/tools/my-tool.test.ts

import { describe, it, expect } from "vitest";
import { myTool } from "./my-tool.js";
import { createMockContext } from "../../test-helpers/tools.js";

describe("myTool", () => {
  it("should execute successfully", async () => {
    const result = await myTool.execute({
      args: {
        location: "北京",
        includeDetails: true,
      },
      context: createMockContext(),
    });
    
    expect(result.type).toBe("text");
    expect(result.content).toContain("北京");
  });
  
  it("should handle missing parameter", async () => {
    const result = await myTool.execute({
      args: {},
      context: createMockContext(),
    });
    
    expect(result.type).toBe("error");
  });
  
  it("should handle API errors", async () => {
    const result = await myTool.execute({
      args: { location: "InvalidCity" },
      context: createMockContext(),
    });
    
    expect(result.type).toBe("error");
    expect(result.content).toContain("失败");
  });
});
```

### 8.2 集成测试

```typescript
// src/agents/tools/my-tool.integration.test.ts

import { describe, it, expect } from "vitest";
import { runAgentWithTools } from "../../test-helpers/agent.js";

describe("myTool integration", () => {
  it("should be called by agent when relevant", async () => {
    const result = await runAgentWithTools({
      message: "北京今天天气怎么样？",
      tools: ["my_tool"],
    });
    
    // 验证工具被调用
    expect(result.toolCalls).toContainEqual(
      expect.objectContaining({
        tool: "my_tool",
        params: expect.objectContaining({
          location: expect.stringContaining("北京"),
        }),
      })
    );
    
    // 验证结果包含在响应中
    expect(result.response).toContain("天气");
  });
});
```

---

## 9. 工具安全

### 9.1 输入验证

```typescript
execute: async ({ args, context }) => {
  const { path } = args;
  
  // ✅ 验证路径安全性
  const resolvedPath = resolvePath(path);
  const workspaceRoot = context.deps.workspace.root;
  
  if (!resolvedPath.startsWith(workspaceRoot)) {
    return {
      type: "error",
      content: "路径超出工作区范围",
    };
  }
  
  // ... 继续执行
}
```

### 9.2 权限检查

```typescript
execute: async ({ args, context }) => {
  // ✅ 检查会话权限
  if (!context.isMainSession && !context.config.allowNonMainSessions) {
    return {
      type: "error",
      content: "此工具仅可在主会话中使用",
    };
  }
  
  // ✅ 检查用户权限
  if (!context.isAuthorizedSender) {
    return {
      type: "error",
      content: "未授权的用户",
    };
  }
  
  // ... 继续执行
}
```

### 9.3 资源限制

```typescript
execute: async ({ args, context }) => {
  const { data } = args;
  
  // ✅ 限制数据大小
  const MAX_SIZE = 10 * 1024 * 1024;  // 10MB
  if (data.length > MAX_SIZE) {
    return {
      type: "error",
      content: `数据超出大小限制 (${MAX_SIZE} bytes)`,
    };
  }
  
  // ✅ 设置超时
  const result = await Promise.race([
    processData(data),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("超时")), 30000)
    ),
  ]);
  
  // ... 返回结果
}
```

---

## 10. 最佳实践

### 10.1 描述编写指南

```typescript
// ✅ 好的描述
const goodDescription = `
  查询指定城市的实时天气信息。
  
  使用场景：
  - 用户询问"XX天气怎么样"
  - 用户需要出行天气建议
  - 需要获取温度、湿度、风速等信息
  
  参数说明：
  - location: 城市名称（中文或英文）
  - date: 可选，查询指定日期，默认今天
  
  返回：天气状况、温度范围、建议穿着
`.trim();

// ❌ 差的描述
const badDescription = "获取天气";
```

### 10.2 错误处理

```typescript
// ✅ 好的错误处理
try {
  const result = await fetchData();
  return { type: "text", content: formatResult(result) };
} catch (error) {
  // 区分错误类型
  if (error instanceof NetworkError) {
    return {
      type: "error",
      content: `网络错误: ${error.message}。请检查网络连接后重试。`,
    };
  }
  
  if (error instanceof AuthError) {
    return {
      type: "error",
      content: `认证失败: ${error.message}。请检查 API 密钥配置。`,
    };
  }
  
  // 未知错误
  return {
    type: "error",
    content: `操作失败: ${error.message}`,
  };
}
```

### 10.3 结果格式化

```typescript
// ✅ 使用 Markdown 格式化结果
return {
  type: "text",
  content: `
## 查询结果

| 项目 | 值 |
|------|-----|
| 名称 | ${data.name} |
| 状态 | ${data.status} |
| 时间 | ${formatDate(data.timestamp)} |

### 详情
\`\`\`json
${JSON.stringify(data.details, null, 2)}
\`\`\`
  `.trim(),
};
```

---

## 11. 参考

### 11.1 内置工具列表

| 工具 | 路径 | 功能 |
|------|------|------|
| `bash` | `src/agents/tools/bash-tools.ts` | Shell 命令执行 |
| `browser` | `src/browser/` | 浏览器控制 |
| `canvas` | `src/canvas-host/` | Canvas 操作 |
| `discord_*` | `src/discord/tools/` | Discord 操作 |
| `slack_*` | `src/slack/tools/` | Slack 操作 |
| `sessions_*` | `src/agents/openclaw-tools.ts` | 会话管理 |

### 11.2 文档

- [Tools 配置](/tools)
- [Agent 运行时](/concepts/agent-loop)
- [Plugin Agent Tools](/plugins/agent-tools)

---

*本手册涵盖了 Agent 工具开发的核心内容。更多高级用法请参考源码和官方文档。*
