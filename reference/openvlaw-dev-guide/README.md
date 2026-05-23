# OpenClaw 系统架构设计与二次开发手册

> **OpenClaw** - 个人 AI 助手系统  
> 版本: 2026.1.30  
> 最后更新: 2026-02-01

---

## 📚 文档目录

本文档集包含 OpenClaw 系统的完整架构设计方案和各模块的二次开发指导。

| 序号 | 文档 | 内容概述 |
|:---:|:---|:---|
| 1 | [系统整体架构设计方案](./01-系统整体架构设计方案.md) | 系统分层、核心组件、数据流、接口设计、部署架构 |
| 2 | [Gateway 模块二次开发指导手册](./02-Gateway模块二次开发指导手册.md) | WebSocket 控制平面、RPC 方法、事件系统、协议扩展 |
| 3 | [Channel 插件开发指导手册](./03-Channel插件开发指导手册.md) | 消息通道开发、Adapter 实现、配置 Schema、测试 |
| 4 | [Agent 工具开发指导手册](./04-Agent工具开发指导手册.md) | Agent Tool 开发、Pi RPC 集成、工具上下文、测试 |
| 5 | [Plugin SDK 开发指导手册](./05-Plugin SDK开发指导手册.md) | 插件架构、扩展点、配置系统、发布流程 |
| 6 | [CLI 扩展开发指导手册](./06-CLI扩展开发指导手册.md) | CLI 命令开发、交互设计、依赖注入、测试 |

---

## 🏗️ 系统架构速览

### 架构分层

```
┌─────────────────────────────────────────────────────────────┐
│                     客户端层 (Client Layer)                   │
│         CLI │ WebChat │ macOS App │ iOS/Android Nodes        │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ WebSocket / HTTP
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                 Gateway 控制平面层 (Control Plane)             │
│     WS Server │ HTTP API │ Channel Mgr │ Plugin Mgr         │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│  消息通道层   │      │ Agent 运行时层 │      │   扩展插件层  │
│   Channels   │      │    Agent     │      │   Plugins    │
└──────────────┘      └──────────────┘      └──────────────┘
```

### 核心组件

| 组件 | 路径 | 职责 |
|:---|:---|:---|
| **Gateway** | `src/gateway/` | WebSocket/HTTP 控制平面 |
| **Channels** | `src/channels/`, `src/{whatsapp,telegram,...}/` | 消息通道适配器 |
| **Agent Runtime** | `src/agents/` | Pi RPC Agent 封装 |
| **Plugin SDK** | `src/plugin-sdk/`, `src/plugins/` | 插件系统 |
| **CLI** | `src/cli/` | 命令行界面 |

---

## 🚀 快速开始

### 环境准备

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

### 启动开发

```bash
# 启动 Gateway 开发模式
pnpm gateway:dev

# 带热重载
pnpm gateway:watch

# 运行测试
pnpm test
```

---

## 📖 开发场景导航

### 场景 1: 添加新的消息通道

**目标**: 让 OpenClaw 支持一个新的消息平台

**参考文档**: [03-Channel插件开发指导手册](./03-Channel插件开发指导手册.md)

**关键步骤**:
1. 创建插件目录 `extensions/my-channel/`
2. 实现 `ChannelPlugin` 接口
3. 配置 `openclaw.plugin.json`
4. 注册出站/入站适配器
5. 测试并发布

### 场景 2: 添加 Agent 工具

**目标**: 让 AI Agent 能够调用新的功能

**参考文档**: [04-Agent工具开发指导手册](./04-Agent工具开发指导手册.md)

**关键步骤**:
1. 定义工具 Schema (TypeBox)
2. 实现 `execute` 函数
3. 在插件中注册或添加到内置工具
4. 测试工具调用

### 场景 3: 扩展 Gateway RPC

**目标**: 添加新的 WebSocket/HTTP 接口

**参考文档**: [02-Gateway模块二次开发指导手册](./02-Gateway模块二次开发指导手册.md)

**关键步骤**:
1. 定义协议 Schema
2. 实现方法处理器
3. 注册到 `methodHandlers`
4. 更新类型定义

### 场景 4: 开发完整插件

**目标**: 创建一个包含多种扩展的插件

**参考文档**: [05-Plugin SDK开发指导手册](./05-Plugin SDK开发指导手册.md)

**关键步骤**:
1. 创建插件目录和清单
2. 实现注册函数
3. 注册工具/通道/CLI/服务
4. 配置 Schema 和 UI 提示
5. 测试并发布到 npm

### 场景 5: 添加 CLI 命令

**目标**: 扩展命令行界面

**参考文档**: [06-CLI扩展开发指导手册](./06-CLI扩展开发指导手册.md)

**关键步骤**:
1. 创建命令文件
2. 使用 `@clack/prompts` 实现交互
3. 注册到程序
4. 编写测试

---

## 🎯 核心概念

### 1. Gateway 协议

WebSocket 协议帧格式:

```typescript
// 请求
{
  type: "req",
  id: "unique-id",
  method: "methodName",
  params: { ... },
  idempotencyKey?: "for-retry"
}

// 响应
{
  type: "res",
  id: "same-id",
  ok: true | false,
  payload?: { ... },
  error?: { message, code }
}

// 事件推送
{
  type: "event",
  event: "eventName",
  payload: { ... }
}
```

### 2. Channel Plugin 接口

```typescript
interface ChannelPlugin {
  id: string;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  config: ChannelConfigAdapter;
  outbound: ChannelOutboundAdapter;
  gateway?: ChannelGatewayAdapter;
  security?: ChannelSecurityAdapter;
  messaging?: ChannelMessagingAdapter;
  // ... 更多适配器
}
```

### 3. Agent Tool 接口

```typescript
interface AgentTool {
  name: string;
  description: string;
  parameters: TSchema;
  execute: (params: {
    args: Record<string, unknown>;
    context: ToolContext;
  }) => AsyncIterable<ToolResult> | Promise<ToolResult>;
}
```

### 4. Plugin API

```typescript
interface OpenClawPluginApi {
  registerChannel(options: { plugin: ChannelPlugin }): void;
  registerTool(tool: AgentTool): void;
  registerGatewayMethod(method: string, handler: Function): void;
  registerHttpRoute(path: string, handler: Function): void;
  registerCli(registerFn: Function, metadata: CliMetadata): void;
  registerService(service: BackgroundService): void;
  // ... 更多
}
```

---

## 🔧 常用命令

```bash
# 开发
pnpm install          # 安装依赖
pnpm build            # 构建
pnpm gateway:dev      # 开发模式启动 Gateway
pnpm gateway:watch    # 热重载模式

# 测试
pnpm test             # 运行测试
pnpm test:coverage    # 覆盖率测试
pnpm test:e2e         # E2E 测试

# 代码规范
pnpm lint             # 检查
pnpm lint:fix         # 自动修复
pnpm format           # 格式化

# CLI 使用
openclaw onboard                # 引导安装
openclaw gateway                # 启动 Gateway
openclaw agent --message "Hi"   # 发送消息给 Agent
openclaw plugins list           # 列出插件
openclaw plugins install <pkg>  # 安装插件

# 调试
DEBUG=openclaw:* pnpm gateway:dev    # 详细日志
DEBUG=openclaw:gateway pnpm gateway:dev  # Gateway 日志
DEBUG=openclaw:channels pnpm gateway:dev # 通道日志
```

---

## 📁 目录结构

```
openclaw/
├── src/                          # 核心源码
│   ├── gateway/                  # Gateway 服务器
│   ├── channels/                 # 通道框架
│   ├── agents/                   # Agent 运行时
│   ├── plugins/                  # 插件系统
│   ├── cli/                      # CLI 实现
│   ├── config/                   # 配置系统
│   ├── sessions/                 # 会话管理
│   └── ...                       # 其他模块
│
├── extensions/                   # 扩展插件
│   ├── matrix/                   # Matrix 通道
│   ├── msteams/                  # Microsoft Teams
│   ├── voice-call/               # 语音通话
│   └── ...                       # 更多插件
│
├── docs-internal/                # 本文档集
│   ├── README.md                 # 本文件
│   ├── 01-系统整体架构设计方案.md
│   ├── 02-Gateway模块二次开发指导手册.md
│   ├── 03-Channel插件开发指导手册.md
│   ├── 04-Agent工具开发指导手册.md
│   ├── 05-Plugin SDK开发指导手册.md
│   └── 06-CLI扩展开发指导手册.md
│
├── docs/                         # 用户文档 (Mintlify)
├── apps/                         # 客户端应用
│   ├── macos/                    # macOS 应用
│   ├── ios/                      # iOS 应用
│   └── android/                  # Android 应用
│
├── test/                         # 测试辅助
└── scripts/                      # 构建脚本
```

---

## 🔗 参考资源

### 官方文档

- [OpenClaw Docs](https://docs.openclaw.ai) - 用户文档
- [GitHub Repo](https://github.com/openclaw/openclaw) - 源码仓库
- [Pi Agent Core](https://github.com/badlogic/pi-mono) - Agent 运行时

### 技术参考

- [TypeBox](https://github.com/sinclairzx81/typebox) - JSON Schema 类型
- [Commander.js](https://github.com/tj/commander.js) - CLI 框架
- [@clack/prompts](https://github.com/natemoo-re/clack) - 交互提示
- [Vitest](https://vitest.dev/) - 测试框架

---

## 📝 贡献指南

### 提交 Issue

- 使用清晰的标题描述问题
- 提供复现步骤
- 包含环境信息（Node 版本、操作系统）
- 附上相关日志

### 提交 PR

1. Fork 仓库
2. 创建功能分支 (`git checkout -b feature/my-feature`)
3. 提交更改 (`git commit -am 'Add feature'`)
4. 推送到分支 (`git push origin feature/my-feature`)
5. 创建 Pull Request

### 代码规范

- 使用 TypeScript (ESM)
- 遵循 Oxlint/Oxfmt 规范
- 添加测试覆盖
- 更新相关文档

---

## 📜 许可证

MIT License - 详见 [LICENSE](../LICENSE) 文件

---

## 🙏 致谢

感谢所有贡献者让 OpenClaw 变得更好！

特别感谢：
- [Mario Zechner](https://mariozechner.at/) - Pi Agent Core 作者
- [所有贡献者](https://github.com/openclaw/openclaw/graphs/contributors)

---

> **提示**: 本文档是内部开发文档，与面向用户的 [docs.openclaw.ai](https://docs.openclaw.ai) 互补。如需了解系统使用方法，请参考官方用户文档。
