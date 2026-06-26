# leyemeta-openclaw-plugin 设计文档

> v0.1 草案 · 2026-04-28

## 0. 术语

- **平台** = leyemeta（leyemeta.com）
- **插件** = 本仓库交付的 OpenClaw Channel Plugin
- **OpenClaw** = 用户本地运行的 OpenClaw 实例
- **Agent** = OpenClaw 一等公民，定义于 `openclaw.json.agents.list[]`，含 `id` / `workspace` / `agentDir`（角色人设目录）
- **平台智能体** = leyemeta 上由用户配置的对话机器人，由 `member_key` 唯一标识
- **Account** = OpenClaw Channel 内的连接/会话隔离单位
- **Binding** = `bindings[]` 中一条 `(channel, accountId) → agentId` 的路由规则

## 1. 背景与目标

### 1.1 业务背景

leyemeta 平台（下称"平台"）拥有自己的智能体对话页面，用户可以在平台上创建多个智能体（不同角色：客服、文档助手、代码助手等）。平台不打算自研推理后端，决定把 AI 推理能力外包给用户本地运行的 OpenClaw。

用户路径：
1. 用户自行部署 OpenClaw
2. 在 OpenClaw 中通过 `agents.list[]` 创建多个 Agent，角色人设写在各自 `agentDir`
3. 在 leyemeta 创建多个智能体（每个对应一个 `member_key`）
4. 用本插件把 OpenClaw Agent 1:1 绑定到 leyemeta 智能体
5. 平台用户在对话页与某个智能体聊天 → 消息经由本插件 → 路由到对应的 OpenClaw Agent → 推理 → 回复送回平台。

### 1.2 目标

- **G1** 标准 Channel 接口实现（connect / 入站 / 出站），打通对话流
- **G2** 多 Agent ↔ 多平台智能体 1:1 绑定（多 account + bindings 路由）
- **G3** 每条入站消息向 Agent 注入用户身份信息（ID/姓名/权限），让 Agent 在回复中能称呼/判断
- **G4** 把平台开放 API 注册为 OpenClaw Tool（`leyemeta.*` 命名空间，全局共享）
- **G5** CLI 向导降低配置门槛（`openclaw leyemeta agent add` 等）

### 1.3 非目标

- 不替用户管理"角色人设"，由用户写在 `agentDir`
- 不实现"动态切换绑定"，绑定静态声明，改动需重启
- 不为平台多租户做隔离设计，部署形态为"一个用户 = 一个 OpenClaw"

---

## 2. 核心架构

### 2.1 三方关系

```
leyemeta 平台（智能体 K1/K2/K3）
        │  wss://leyemeta.com/openclaw/v1
        │  每个 account 一条独立 WS
        ▼
OpenClaw（用户本地）
  Channel: leyemeta
    Account cs (K1) / doc (K2) / code (K3)
  bindings[]:
    (leyemeta, cs)   → customer-service
    (leyemeta, doc)  → doc-helper
    (leyemeta, code) → main
  Agents: customer-service / doc-helper / main（人设在各自 agentDir）
  全局 Tools: leyemeta.get_user_profile / list_user_resources / ...
```

### 2.2 关键决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 角色定义放哪 | OpenClaw `agentDir`，插件不碰 | 避免双重事实来源 |
| 多角色实现 | 多 Account + bindings 路由 | 沿用 OpenClaw 原生机制 |
| Account ↔ 智能体绑定 | account 配置中的 `member_key` | 平台已用 `member_key` 唯一标识 |
| 插件 ↔ 平台拓扑 | 每个 Account 一条独立 WS | 故障隔离、协议简单 |
| 用户身份注入 | 插件每条入站消息从平台拿到，挂上下文 | 身份 per-message 变化 |
| 平台 API 暴露方式 | 注册为 OpenClaw Tool | 真能调用，胜过 system prompt 告知 |
| 工具可见性 | 全局共享 | 简化模型，权限由 token 在服务端控制 |
| 部署形态 | 用户自部署，主动接入 | 与 OpenClaw 个人助手定位一致 |

### 2.3 数据流（一次问答全链路）

```
平台用户 → leyemeta 后端（持久化 + 推 inbound 帧）
  → 插件 onMessage → emitMessage(channel, accountId, ...)
  → OpenClaw 路由（按 bindings 选 agent）
  → Agent Runtime（人设作 system prompt；可调内置工具或 leyemeta.* 工具）
  → outbound.sendText → 插件经对应 WS 发 outbound 帧
  → 平台后端持久化 + 推送给浏览器
```

---

## 3. 插件结构

### 3.1 目录布局

```
leyemeta-openclaw-plugin/
├── package.json
├── openclaw.plugin.json          # 插件清单
├── tsconfig.json
├── src/
│   ├── index.ts                  # 插件入口（register）
│   ├── channel/                  # plugin/meta/config/gateway/messaging/outbound/security
│   ├── transport/                # ws-client / frames / auth
│   ├── tools/                    # index + leyemeta.* 各工具
│   ├── cli/                      # index + agent-{add,list,test,remove}
│   ├── runtime/                  # context（连接池/配置缓存） + logger
│   └── types.ts
├── test/
│   ├── unit/                     # frames / outbound / tools
│   └── e2e/plugin.e2e.test.ts    # 用 staging
└── docs/                         # DESIGN / PROTOCOL / USER-GUIDE
```

### 3.2 命名

- 插件 id: `leyemeta`；npm 包: `@leyemeta/openclaw-channel`
- Channel id: `leyemeta`；Tool 命名空间: `leyemeta.*`
- CLI: `openclaw leyemeta agent {add|list|test|remove}`

---

## 4. 配置

### 4.1 `openclaw.json` 用户侧示例

```jsonc
{
  "agents": {
    "list": [
      { "id": "main" },
      { "id": "customer-service", "name": "客服小乐",
        "workspace": "C:\\Users\\sss\\.openclaw\\ws-cs",
        "agentDir":  "C:\\Users\\sss\\.openclaw\\agents\\cs" },
      { "id": "doc-helper", "name": "文档助手",
        "agentDir": "C:\\Users\\sss\\.openclaw\\agents\\doc" }
    ]
  },
  "channels": {
    "leyemeta": {
      "gateway_url": "wss://leyemeta.com/openclaw/v1",
      "accounts": {
        "cs":  { "enabled": true, "member_key": "K1_xxxx" },
        "doc": { "enabled": true, "member_key": "K2_xxxx" }
      }
    }
  },
  "bindings": [
    { "type": "route", "agentId": "customer-service",
      "match": { "channel": "leyemeta", "accountId": "cs"  } },
    { "type": "route", "agentId": "doc-helper",
      "match": { "channel": "leyemeta", "accountId": "doc" } }
  ],
  "plugins": { "entries": { "leyemeta": { "enabled": true } } }
}
```

### 4.2 插件清单 `openclaw.plugin.json`

```jsonc
{
  "id": "leyemeta",
  "name": "Leyemeta Channel",
  "version": "1.0.0",
  "description": "把 leyemeta 平台对话流接入 OpenClaw，支持多智能体绑定",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "gateway_url": {
       "type": "string",
       "format": "uri",
       "description": "leyemeta 接入端点 WebSocket URL",
       "default": "wss://leyemeta.com/openclaw/v1"
      },
      "accounts": {
        "type": "object",
        "patternProperties": {
          "^[a-zA-Z0-9_-]+$": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "enabled":    { "type": "boolean", "default": true },
              "member_key": {
                "type": "string",
                "description": "leyemeta 智能体的成员密钥，唯一标识一个智能体"
              },
              "displayName":{
                 "type": "string",
                 "description": "在 OpenClaw 内展示的别名（可选）"
              }
            },
            "required": ["member_key"]
          }
        }
      }
    },
    "required": ["accounts"]
  },
  "uiHints": {
    "gateway_url": { "label": "Gateway URL", "placeholder": "wss://leyemeta.com/openclaw/v1" },
    "accounts.*.member_key": { "label": "Member Key", "sensitive": true,
      "description": "在 leyemeta 智能体设置页生成" }
  }
}
```

### 4.3 字段语义

| 字段 | 含义 | 谁配 |
|------|------|------|
| `channels.leyemeta.gateway_url` | 平台接入点 WS URL | 用户（默认值可改） |
| `channels.leyemeta.accounts.<id>` | 本地代号，对应一个平台智能体 | 用户（CLI 自动生成） |
| `accounts.<id>.member_key` | 平台智能体身份 | 用户从 leyemeta 复制 |
| `accounts.<id>.enabled` | 是否启用 | 用户 |
| `bindings[].agentId` | 路由到哪个 Agent | 用户（CLI 写入） |

---

## 5. WebSocket 协议（草案，最终以 `docs/PROTOCOL.md` 为准）

### 5.1 握手

```
GET wss://leyemeta.com/openclaw/v1
Sec-WebSocket-Protocol: leyemeta.openclaw.v1
Authorization: Bearer <member_key>
X-Plugin-Version: 1.0.0
X-Account-Id: <accountId>      # 仅诊断
```

握手成功首帧：`{ "type": "ready", "agentId", "agentName", "capabilities": ["text","attachments","tool_status"] }`。

鉴权分工：
- `Authorization` Header 鉴权（Node.js 友好；upgrade 阶段拒绝非法）
- `Sec-WebSocket-Protocol` 仅传协议版本，不放密钥
- 首帧 `auth` 仅作浏览器兼容备选；启用时平台须限速/限并发

### 5.2 帧外壳（统一 JSON 文本帧）

```jsonc
{ "type": "<帧类型>", "id": "<可选 UUID>", "ts": 1714291200000, "payload": { ... } }
```

### 5.3 入站帧（leyemeta → 插件）

```jsonc
// 新消息
{ "type": "inbound.message", "id": "msg_xxx", "ts": ...,
  "payload": {
    "conversationId": "conv_xxx",
    "messageId": "msg_xxx",
    "user": { "id": "u_123", "name": "张三", "tenantId": "t_org1", "permissions": ["read","write"] },
    "text": "帮我查一下昨天的订单",
    "attachments": [{ "type":"image", "url":"https://...", "filename":"...", "mime":"image/png" }],
    "replyTo": null
  } }

// 中断当前生成
{ "type": "inbound.cancel", "payload": { "conversationId": "conv_xxx" } }

// 心跳
{ "type": "ping", "ts": ... }
```

### 5.4 出站帧（插件 → leyemeta）

```jsonc
// 流式 chunk / 结束
{ "type":"outbound.delta",
  "payload": { "conversationId":"conv_xxx", "messageId":"asm_xxx", "delta":"好的，正在", "done":false } }
{ "type":"outbound.delta",
  "payload": { "conversationId":"conv_xxx", "messageId":"asm_xxx", "delta":"", "done":true } }

// 工具调用透传（可选，受 capabilities.tool_status 控制）
{ "type":"outbound.tool_status",
  "payload": { "conversationId":"...", "tool":"leyemeta.get_user_profile",
    "phase":"running|success|error", "summary":"..." } }

// 错误
{ "type":"outbound.error",
  "payload": { "conversationId":"...", "code":"AGENT_FAILED", "message":"..." } }

// 心跳
{ "type":"pong", "ts": ... }
```

### 5.5 连接生命周期

| 事件 | 行为 |
|------|------|
| 启动 | 每个启用的 account 独立建一条 WS |
| 收到 `ready` | 缓存 agentId/agentName/capabilities，标记可用 |
| 30s 无消息 | 客户端发 `ping` |
| 收到任何帧（含 pong） | 视为存活 |
| 异常关闭 | 指数退避重连 1→2→4→8→16s，封顶 30s，±20% 抖动 |
| 配置变更 | account 增删改时重启对应 WS |

### 5.6 平台需确认的细节

详见 §11 Q1–Q10。MVP 已定要点摘录：
- WS URL/鉴权（Q1）：见 5.1
- 会话归属（Q4）：OpenClaw 自管，`sessionKey = "leyemeta/${accountId}/${conversationId}"`；插件每帧只透传单条用户消息，平台不回灌历史
- 重连/限流（Q5）：见 5.5；上行不设客户端软限，平台总控；超限以 `RATE_LIMITED` 反压，插件不重试
- 协议版本（Q7）：MVP 固定 `leyemeta.openclaw.v1`

---

## 6. Adapter 实现要点

### 6.1 ChannelMeta + Capabilities

```typescript
// src/channel/meta.ts
export const meta: ChannelMeta = {
  id: "leyemeta",
  label: "乐椰星球",
  selectionLabel: "乐椰星球（平台对接）",
  docsPath: "/channels/leyemeta",
  blurb: "把 乐椰星球 平台智能体接入 OpenClaw"
};

export const capabilities: ChannelCapabilities = {
  chatTypes: ["direct"],            // 平台对话页是 1:1
  // 准入策略(2026-06-26):黑名单 —— 默认放行所有附件,仅按文件后缀拦截
  // 可执行/脚本类等不安全类型(见 attachments.ts UNSAFE_EXTENSIONS)。
  media: { maxSizeBytes: 20 * 1024 * 1024 },
  supports: {
    threads: false,
    reactions: false,
    edits: false,
    deletions: false,
    mentions: false,
    formatting: true                // markdown
  }
};
```

### 6.2 ConfigAdapter

```typescript
// src/channel/config.ts
export const config: ChannelConfigAdapter = {
  listAccountIds: (cfg) =>
    Object.keys(cfg.channels?.leyemeta?.accounts ?? {}),

  resolveAccount: (cfg, accountId) => {
    const accounts = cfg.channels?.leyemeta?.accounts;
    const acc = accountId ? accounts?.[accountId] : undefined;
    if (!acc) return undefined;
    return {
      accountId: accountId!,
      enabled: acc.enabled ?? true,
      member_key: acc.member_key,
      gateway_url: cfg.channels.leyemeta.gateway_url ?? "wss://leyemeta.com/openclaw/v1",
      displayName: acc.displayName
    };
  }
};
```

### 6.3 GatewayAdapter（连接生命周期）

```typescript
const conns = new Map<string, LeyemetaWsClient>(); // accountId -> client
export const gateway: ChannelGatewayAdapter = {
  start: async (account, deps) => {
    const client = new LeyemetaWsClient({
      url: account.gateway_url,
      memberKey: account.member_key,
      accountId: account.accountId,
      logger: deps.logger,
      onReady:      (info) => deps.onReady(info),
      onMessage:    (frame) => deps.emit("message", { data: frame, accountId: account.accountId }),
      onError: (err) => deps.onError(err),
      onDisconnect: () => deps.onDisconnect()
    });
    await client.start();
    conns.set(account.accountId, client);
    return { stop: async () => { await client.stop(); conns.delete(account.accountId); } };
  }
};
export function getConn(accountId: string) { return conns.get(accountId); }
```

### 6.4 MessagingAdapter（入站）

```typescript
export const messaging: ChannelMessagingAdapter = {
  onMessage: async (event, deps) => {
    const frame = event.data;
    if (frame.type !== "inbound.message") return;
    const p = frame.payload;
    deps.emitMessage({
      id: p.messageId,
      channel: "leyemeta",
      accountId: event.accountId,
      senderId: p.user.id,
      senderName: p.user.name,
      text: p.text,
      timestamp: new Date(frame.ts ?? Date.now()),
      isGroup: false,
      attachments: p.attachments,
      // 关键：用户身份挂 metadata，让 ToolContext 可读
      metadata: {
        leyemeta: {
          conversationId: p.conversationId,
          user: p.user 
        }
      },
      // 让 OpenClaw 用稳定 sessionKey
      sessionKey: `leyemeta/${event.accountId}/${p.conversationId}`
    });
  }
};
```

**用户身份让 Agent "看到"** 两种做法（MVP 选 A）：
- A. 在 messaging 把身份 prepend 到 text（如 `[来自 leyemeta 用户：张三 (u_123)] ...`）—— 简单可靠
- B. 注册 `leyemeta.whoami` 工具，Agent 自己调 —— 干净但模型未必每次都调

### 6.5 OutboundAdapter（出站）

```typescript
export const outbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async ({ text, target, account }) => {
    const conn = getConn(account.accountId);
    if (!conn) return { ok: false, error: "Connection not ready" };
    // OpenClaw 已合并 chunk，这里收到完整文本，一次性发 done=true
    const conversationId = (target as any)?.conversationId
      ?? extractConversationFromSessionKey(account.sessionKey);
    const messageId = `asm_${cryptoRandomId()}`;
    await conn.send({ type: "outbound.delta",
      payload: { conversationId, messageId, delta: text, done: true } });
    return { ok: true, messageId };
  }
};
```

> 流式回复：MVP 不做；v1.2 通过 OpenClaw `agent:*` hook 截取 token 流逐 chunk 推送 `outbound.delta`（见 §10）。

### 6.6 SecurityAdapter

平台是受信通道（已认证用户）：

```typescript
export const security: ChannelSecurityAdapter = {
  getDmPolicy:      () => "open",
  getAllowFrom:     () => [],
  resolveSenderId:  (event) => event.data?.payload?.user?.id ?? "unknown"
};
```

---

## 7. 平台 API → OpenClaw Tool

### 7.1 原则

- 所有平台 API 注册为 Tool，命名空间 `leyemeta.*`，全局注册一次，所有 Agent 可用
- 鉴权：执行时由 `context.accountId` 反查 `member_key` 作为 `Authorization`
- 权限由平台基于 `member_key` 控制；插件不做软限制

### 7.2 工具样板

```typescript
// src/tools/user-profile.ts
export const getUserProfileTool: AgentTool = {
  name: "leyemeta.get_user_profile",
  description: `获取 leyemeta 用户资料。
当用户询问"我的"个人信息（昵称、邮箱、所在团队等）时使用。
userId 必须取自当前对话上下文（不能编造）。`,
  parameters: Type.Object({
    userId: Type.String({ description: "leyemeta 用户 ID（如 u_123）" })
  }),
  execute: async ({ args, context }) => {
    const memberKey = lookupMemberKey(context); // accountId → config 反查
    const resp = await fetch(`https://leyemeta.com/api/users/${args.userId}`,
      { headers: { Authorization: `Bearer ${memberKey}` } });
    if (!resp.ok) return { type: "error", content: `查询失败: HTTP ${resp.status}` };
    return { type: "json", content: JSON.stringify(await resp.json(), null, 2) };
  }
};
```

### 7.3 API 清单

**MVP（v1.0）必交付**

| 工具 | 用途 | API |
|------|------|-----|
| `leyemeta.get_user_profile` | 查用户资料，供 Agent 称呼用户 | `GET /api/users/{id}` |

> MVP 仅交付该工具，把"身份注入 → Tool 真能查到 → 回复中能称呼"最小闭环跑通。

**v1.x 候选（待平台逐项对齐）**

| 工具 | 用途 | API |
|------|------|-----|
| `leyemeta.list_user_resources` | 列出用户资源 | `GET /api/users/{id}/resources` |
| `leyemeta.search_knowledge` | 检索知识库 | `POST /api/kb/search` |
| `leyemeta.create_ticket` | 创建工单 | `POST /api/tickets` |
| `leyemeta.send_notification` | 发通知 | `POST /api/notifications` |

### 7.4 工具描述即"能力清单"

OpenClaw 把工具列表注入模型上下文时，模型能看到每个工具的描述与触发场景。这是把"告知 OpenClaw 平台有哪些能力"落地的方式：**注册成工具让 Agent 自己看到，而非塞 system prompt**。

---

## 8. CLI 向导

### 8.1 命令树

```
openclaw leyemeta agent {add | list | test <id> | remove <id>}
```

### 8.2 `agent add` 交互

```
? account 本地代号: cs
? 输入 member_key: K1_xxxx
? 选择本地 Agent 来扮演:
  > main / customer-service / doc-helper / [创建新 Agent]
? 测试连通性？(Y/n) Y
  ✓ 写入 channels.leyemeta.accounts.cs
  ✓ 写入 bindings (leyemeta, cs → customer-service)
  ✓ 握手成功，agentName="客服小乐"
完成。重启 OpenClaw 让配置生效。
```

### 8.3 实现要点

- 用 `api.runtime.config` 读现有配置；写 `~/.openclaw/openclaw.json`（原子写 + 写前备份 + 写后 schema 校验）
- "创建新 Agent" 选项不直接改 `agents.list`（涉及 `agentDir`），而是打印手册并推荐 OpenClaw 自身命令

---

## 9. 开发与验证

### 9.1 本地开发

```bash
pnpm install && pnpm build      # tsc 输出到 dist/

# openclaw.json 挂本地路径
"plugins": {
  "load":    { "paths": ["d:\\source\\leyemeta-openclaw-plugin\\dist"] },
  "entries": { "leyemeta": { "enabled": true } }
}

# 联调指向 staging：改 channels.leyemeta.gateway_url + 填 staging member_key
# staging 由平台后端维护（Q10）
```

### 9.2 测试矩阵

| 层 | 工具 | 覆盖 |
|----|------|------|
| 单元 | vitest | 帧编解码、配置解析、Tool execute、CLI dry-run |
| 集成 | 进程内 fake WS server（仅覆盖帧契约） | 握手、入站→emitMessage→出站 send 契约；断线重连 |
| E2E | 真实 OpenClaw + 平台 staging | 多 account 并发、bindings 路由正确性、真实链路冒烟 |

### 9.3 关键测试用例

- 多 account 并发连接，路由到正确 Agent
- 断线重连后会话上下文延续
- 用户身份注入：mock `user.name="李四"`，回复中出现"李四"
- Tool 调用：模型调 `get_user_profile` 时 HTTP 带正确 `Authorization`
- Cancel：用户中断后停止生成、不再推 delta
- 并发会话：同 account 下多个 conversation，sessionKey 隔离

---

## 10. 演进规划

| 阶段 | 内容 |
|------|------|
| **MVP v1.0** | 单 account 文本对话、身份注入、`whoami` + 1~2 个平台 API、CLI add/list |
| **v1.1** | 多 account 并发、断线重连、附件下行（图/PDF） |
| **v1.2** | 流式回复（拦截 OpenClaw token 流逐 chunk 推 `outbound.delta`） |
| **v1.3** | 工具调用过程透传（`outbound.tool_status`） |
| **v1.4** | 上行附件（用户发图片/文档给 Agent） |
| **v2.0** | 配置热重载（add/remove account 不用重启 OpenClaw） |

---

## 11. 与平台对接的开放问题

| # | 问题 | 状态 |
|---|------|------|
| Q1 | WS URL 与鉴权 | ✅ `wss://leyemeta.com/openclaw/v1`；Header 鉴权；subprotocol 仅传版本；首帧 auth 仅作浏览器兼容备选 |
| Q2 | 帧 schema | ✅ 完全采纳 §5.3 / §5.4 草案 |
| Q3 | 附件传递 | ✅ URL 直链 |
| Q4 | 会话历史归属 | ✅ OpenClaw 自管，按 sessionKey 隔离 |
| Q5 | 限流/重连退避 | ✅ 重连 1→2→4→8→16s 封顶 30s，±20% 抖动；上行不设软限，超限以 `RATE_LIMITED` 反压、不重试 |
| Q6 | 平台开放 API + 鉴权 | ✅ MVP 仅 `get_user_profile`（`GET /api/users/{id}`，`Bearer member_key`）；其余 §7.3 候选 v1.x 对齐 |
| Q7 | 协议版本 | ✅ MVP 固定 `leyemeta.openclaw.v1`；升级策略推迟到首次破坏性变更前 |
| Q8 | 错误码字典（`outbound.error.code`） | ✅ 大写蛇形短码，首版含 `UNAUTHORIZED` / `INVALID_FRAME` / `AGENT_FAILED` / `TOOL_TIMEOUT` / `RATE_LIMITED` / `UPSTREAM_DOWN`，全集在 PROTOCOL.md 维护 |
| Q9 | 流式 chunk 大小/频率 | ✅ v1.2 时间为主：≤100ms 一帧或累计 ≥32 字符提前 flush；末帧 `done:true` |
| Q10 | mock server | ✅ 由平台后端提供 staging；本仓库不维护内置 mock；§9 改为指向 staging |

---

## 12. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| OpenClaw 内部 API（metadata 透传、bindings 路由）未公开文档 | 实现踩坑 | 联调时读源码 `src/channels/plugins/`、`src/routing/`；用 `api.runtime.config` 探测 |
| 出站流式不在 ChannelOutboundAdapter 标准内 | v1.2 需绕到 hook | MVP 不做流式；v1.2 调研 OpenClaw `agent:*` hook 接入点 |
| `member_key` 泄漏即接管智能体 | 安全 | 标记 sensitive；CLI 不打印；建议平台支持 key 轮换 |
| 多 account WS 对平台连接数压力 | 性能 | 文档要求平台允许；超阈值时降级为单连接路由（v2 选项） |
| OpenClaw 升级导致 SDK 不兼容 | 长期 | `peerDependencies` 锁定 OpenClaw 主版本 |

---

## 13. 文档维护

- `/reference/openvlaw-dev-guide`：openclaw的创建指引文档
- `DESIGN.md`：架构与设计决策（本文）
- `docs/PROTOCOL.md`：WS 帧协议详细规范，与平台后端共建
- `docs/USER-GUIDE.md`：终端用户安装/配置
- 架构变更需追加"决策日志"（待加）

---

*v0.1 草案。第 11 节开放问题对齐后进入 v0.2 编码。*
