# CLI 扩展开发指导手册

> 版本: 2026.1.30  
> 适用范围: OpenClaw CLI 扩展开发

---

## 1. CLI 架构概述

### 1.1 CLI 组件结构

```
src/cli/
├── program/              # 命令程序定义
│   ├── build-program.ts  # 主程序构建
│   ├── commands/         # 命令定义
│   │   ├── gateway.ts
│   │   ├── agent.ts
│   │   ├── channels.ts
│   │   └── ...
│   └── options.ts        # 全局选项
├── deps.ts               # 依赖注入
├── prompts.ts            # 交互提示
├── progress.ts           # 进度显示
└── wait.ts               # 等待工具
```

### 1.2 CLI 执行流程

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│   User   │────▶│   Parse  │────▶│  Route   │────▶│ Execute  │
│  Input   │     │   Args   │     │  Command │     │  Handler │
└──────────┘     └──────────┘     └──────────┘     └────┬─────┘
                                                        │
                                                        ▼
                                              ┌─────────────────┐
                                              │  Output Result  │
                                              │  (text/table/   │
                                              │   json/stream)  │
                                              └─────────────────┘
```

---

## 2. 添加内置 CLI 命令

### 2.1 创建命令文件

```typescript
// src/cli/program/commands/my-command.ts

import { Command } from "commander";
import type { CliDeps } from "../../deps.js";

export function addMyCommand(program: Command, deps: CliDeps): void {
  program
    .command("mycommand")
    .description("My custom command")
    .option("-f, --flag", "Enable flag")
    .option("-v, --value <value>", "Set value")
    .argument("[input]", "Input file")
    .action(async (input, options) => {
      try {
        // 执行命令逻辑
        const result = await executeMyCommand(input, options, deps);
        
        // 输出结果
        console.log(result);
      } catch (error) {
        console.error("Error:", error.message);
        process.exit(1);
      }
    });
}

async function executeMyCommand(
  input: string | undefined,
  options: { flag?: boolean; value?: string },
  deps: CliDeps
): Promise<string> {
  // 实现业务逻辑
  const config = await deps.loadConfig();
  
  if (options.flag) {
    // 处理 flag
  }
  
  if (options.value) {
    // 处理 value
  }
  
  return `Processed: ${input ?? "default"}`;
}
```

### 2.2 注册命令

```typescript
// src/cli/program/build-program.ts

import { addMyCommand } from "./commands/my-command.js";

export function buildProgram(deps: CliDeps): Command {
  const program = new Command();
  
  // ... 现有命令
  
  // 添加新命令
  addMyCommand(program, deps);
  
  return program;
}
```

### 2.3 使用依赖注入

```typescript
// src/cli/deps.ts

import type { LoadConfigFunction } from "../config/config.js";
import type { GatewayClient } from "../gateway/client.js";

export interface CliDeps {
  loadConfig: LoadConfigFunction;
  createGatewayClient: () => GatewayClient;
  logger: Logger;
  // 添加新的依赖
  myService: MyService;
}

export function createDefaultDeps(): CliDeps {
  return {
    loadConfig: createLoadConfig(),
    createGatewayClient: () => new GatewayClient(),
    logger: createLogger(),
    myService: createMyService(),
  };
}
```

---

## 3. CLI 交互开发

### 3.1 使用 @clack/prompts

```typescript
// src/cli/program/commands/interactive.ts

import * as p from "@clack/prompts";
import { Command } from "commander";
import type { CliDeps } from "../../deps.js";

export function addInteractiveCommand(program: Command, deps: CliDeps): void {
  program
    .command("interactive")
    .description("Interactive mode demo")
    .action(async () => {
      p.intro("Welcome to Interactive Mode!");
      
      // 文本输入
      const name = await p.text({
        message: "What is your name?",
        placeholder: "John Doe",
        validate: (value) => {
          if (value.length === 0) return "Name is required!";
        },
      });
      
      if (p.isCancel(name)) {
        p.cancel("Operation cancelled.");
        process.exit(0);
      }
      
      // 选择
      const role = await p.select({
        message: "Select your role:",
        options: [
          { value: "admin", label: "Administrator" },
          { value: "user", label: "Regular User" },
          { value: "guest", label: "Guest" },
        ],
      });
      
      if (p.isCancel(role)) {
        p.cancel("Operation cancelled.");
        process.exit(0);
      }
      
      // 确认
      const confirm = await p.confirm({
        message: "Do you want to proceed?",
        initialValue: true,
      });
      
      if (p.isCancel(confirm) || !confirm) {
        p.cancel("Operation cancelled.");
        process.exit(0);
      }
      
      // 多选
      const features = await p.multiselect({
        message: "Select features to enable:",
        options: [
          { value: "feature-a", label: "Feature A" },
          { value: "feature-b", label: "Feature B" },
          { value: "feature-c", label: "Feature C" },
        ],
        required: false,
      });
      
      // 进度条
      const s = p.spinner();
      s.start("Processing...");
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      s.stop("Done!");
      
      // 输出
      p.outro(`Welcome, ${name}! Your role is ${role}.`);
      
      // 展示结果
      console.log("\nConfiguration:");
      console.log(`  Features: ${features.join(", ")}`);
    });
}
```

### 3.2 使用进度条

```typescript
// src/cli/progress.ts

import { createProgress } from "osc-progress";
import * as p from "@clack/prompts";

export async function withProgress<T>(
  message: string,
  task: (update: (text: string) => void) => Promise<T>
): Promise<T> {
  const s = p.spinner();
  s.start(message);
  
  try {
    const result = await task((text) => {
      s.message(`${message} - ${text}`);
    });
    
    s.stop(`${message} - Complete`);
    return result;
  } catch (error) {
    s.stop(`${message} - Failed`);
    throw error;
  }
}

// 使用示例
export function addProgressCommand(program: Command): void {
  program
    .command("progress-demo")
    .action(async () => {
      const result = await withProgress(
        "Downloading",
        async (update) => {
          for (let i = 0; i <= 100; i += 10) {
            update(`${i}%`);
            await new Promise(r => setTimeout(r, 200));
          }
          return "Downloaded!";
        }
      );
      
      console.log(result);
    });
}
```

### 3.3 表格输出

```typescript
// src/cli/table-output.ts

import { table } from "table";

export function printTable(data: Record<string, unknown>[]): void {
  if (data.length === 0) {
    console.log("No data to display.");
    return;
  }
  
  const headers = Object.keys(data[0]);
  const rows = data.map(item => headers.map(h => String(item[h] ?? "")));
  
  console.log(table([headers, ...rows]));
}

// 使用示例
export function addTableCommand(program: Command, deps: CliDeps): void {
  program
    .command("list-items")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      const items = [
        { id: 1, name: "Item A", status: "active" },
        { id: 2, name: "Item B", status: "inactive" },
        { id: 3, name: "Item C", status: "pending" },
      ];
      
      if (options.json) {
        console.log(JSON.stringify(items, null, 2));
      } else {
        printTable(items);
      }
    });
}
```

---

## 4. 插件中的 CLI 扩展

### 4.1 注册 CLI 命令

```typescript
// extensions/my-plugin/index.ts

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export default function register(api: OpenClawPluginApi) {
  api.registerCli(
    (program) => {
      // 顶级命令
      program
        .command("myplugin")
        .description("My plugin commands")
        .action(() => {
          console.log("My Plugin v1.0.0");
          console.log("Use 'myplugin <command>' to see available commands.");
        });
      
      // 子命令
      const myplugin = program.commands.find(c => c.name() === "myplugin");
      
      myplugin
        ?.command("status")
        .description("Show plugin status")
        .action(async () => {
          console.log("Plugin Status:");
          console.log(`  ID: ${api.id}`);
          console.log(`  Config:`, api.config);
        });
      
      myplugin
        ?.command("sync")
        .description("Sync data")
        .option("-f, --force", "Force sync")
        .option("--since <date>", "Sync since date")
        .action(async (options) => {
          const spinner = createSpinner();
          spinner.start("Syncing...");
          
          try {
            await performSync({
              force: options.force,
              since: options.since,
            });
            
            spinner.succeed("Sync completed!");
          } catch (error) {
            spinner.fail(`Sync failed: ${error.message}`);
            process.exit(1);
          }
        });
      
      myplugin
        ?.command("config")
        .description("Manage configuration")
        .subcommand("get <key>")
        .action((key) => {
          console.log(`${key}:`, api.config[key]);
        });
    },
    { commands: ["myplugin", "myplugin:status", "myplugin:sync", "myplugin:config"] }
  );
}
```

### 4.2 使用 Gateway 客户端

```typescript
// extensions/my-plugin/cli.ts

import type { Command } from "commander";
import { createGatewayClient } from "openclaw/plugin-sdk";

export function addGatewayCommands(program: Command): void {
  program
    .command("gateway-call")
    .description("Call Gateway RPC method")
    .argument("<method>", "RPC method name")
    .argument("[params]", "JSON params")
    .action(async (method, paramsJson) => {
      const client = createGatewayClient();
      
      try {
        await client.connect();
        
        const params = paramsJson ? JSON.parse(paramsJson) : {};
        const result = await client.request(method, params);
        
        console.log(JSON.stringify(result, null, 2));
      } catch (error) {
        console.error("Error:", error.message);
        process.exit(1);
      } finally {
        await client.disconnect();
      }
    });
}
```

---

## 5. 命令测试

### 5.1 单元测试

```typescript
// src/cli/program/commands/my-command.test.ts

import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { addMyCommand } from "./my-command.js";

describe("mycommand", () => {
  it("should execute successfully", async () => {
    const program = new Command();
    const mockDeps = {
      loadConfig: vi.fn().mockResolvedValue({}),
    };
    
    addMyCommand(program, mockDeps);
    
    // 解析命令
    const result = await program
      .parseAsync(["node", "test", "mycommand", "input.txt", "--flag"]);
    
    expect(mockDeps.loadConfig).toHaveBeenCalled();
  });
  
  it("should handle errors", async () => {
    const program = new Command();
    const mockDeps = {
      loadConfig: vi.fn().mockRejectedValue(new Error("Config error")),
    };
    
    addMyCommand(program, mockDeps);
    
    // 应该抛出错误
    await expect(
      program.parseAsync(["node", "test", "mycommand"])
    ).rejects.toThrow();
  });
});
```

### 5.2 E2E 测试

```typescript
// e2e/cli.test.ts

import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

describe("CLI E2E", () => {
  it("should show help", () => {
    const output = execSync("node ./openclaw.mjs --help", { encoding: "utf-8" });
    expect(output).toContain("Usage:");
    expect(output).toContain("Commands:");
  });
  
  it("should execute mycommand", () => {
    const output = execSync("node ./openclaw.mjs mycommand input.txt", {
      encoding: "utf-8",
    });
    expect(output).toContain("Processed: input.txt");
  });
});
```

---

## 6. 最佳实践

### 6.1 错误处理

```typescript
// ✅ 好的错误处理
program
  .command("risky")
  .action(async () => {
    try {
      await riskyOperation();
    } catch (error) {
      if (error instanceof ConfigError) {
        console.error("Configuration error:", error.message);
        console.error("Run 'openclaw config validate' to check your config.");
      } else if (error instanceof NetworkError) {
        console.error("Network error:", error.message);
        console.error("Please check your connection.");
      } else {
        console.error("Unexpected error:", error);
      }
      process.exit(1);
    }
  });
```

### 6.2 输出格式

```typescript
// ✅ 支持多种输出格式
program
  .command("list")
  .option("--json", "Output as JSON")
  .option("--csv", "Output as CSV")
  .action(async (options) => {
    const data = await fetchData();
    
    if (options.json) {
      console.log(JSON.stringify(data, null, 2));
    } else if (options.csv) {
      console.log(toCSV(data));
    } else {
      printTable(data);
    }
  });
```

### 6.3 配置验证

```typescript
// ✅ 验证配置
async function validateConfig(deps: CliDeps): Promise<void> {
  const config = await deps.loadConfig();
  
  if (!config.agent?.model) {
    throw new ConfigError(
      "No model configured. Run 'openclaw config set agent.model <model>'"
    );
  }
}
```

---

## 7. 参考

### 7.1 现有命令

| 命令 | 路径 | 功能 |
|------|------|------|
| `gateway` | `src/cli/program/commands/gateway.ts` | Gateway 管理 |
| `agent` | `src/cli/program/commands/agent.ts` | Agent 交互 |
| `channels` | `src/cli/program/commands/channels.ts` | 通道管理 |
| `config` | `src/cli/program/commands/config.ts` | 配置管理 |
| `plugins` | `src/cli/program/commands/plugins.ts` | 插件管理 |

### 7.2 文档

- [CLI Reference](/cli)
- [Commander.js Docs](https://github.com/tj/commander.js)
- [@clack/prompts](https://github.com/natemoo-re/clack)

---

*本手册涵盖了 CLI 扩展开发的核心内容。*
