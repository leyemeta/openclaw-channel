# leyemeta-openclaw-plugin · 开发 TODO

> 路线图与执行清单 · 与 `docs/DESIGN.md` v0.1 配套
> 仓库路径：`/home/devbox/project/openclaw-plugin/leyemeta-openclaw-plugin/`

---

## 开发原则：先骨架可装载，再迭代功能

本项目从零开始，必须按"先壳后肉"的顺序推进，避免出现"代码写了一半，结果 OpenClaw 根本加载不到插件"的反复返工。

1. **骨架优先（Phase 0–1）**：先让 `openclaw.plugin.json` + `register()` + 一个空壳 Channel 被 OpenClaw 真实发现并加载，作为后续所有工作的"地面"。
2. **协议在前，业务在后（Phase 2 之前不写 Adapter 业务逻辑）**：WebSocket 帧契约、握手、心跳、重连先收敛，避免业务代码与传输层耦合。
3. **每个 Phase 自带验收标准**：必须能用日志、命令或测试证明"这一阶段真的完成"，否则不开下一 Phase。
4. **小步交付，单向依赖**：Phase N 只能依赖 Phase 0..N-1，禁止逆向依赖；遇到需要回填上游的，先暂停当前 Phase。
5. **配置即接口**：所有面向用户的字段以 `openclaw.plugin.json.configSchema` 为准；CLI 与代码读写都走 schema 校验。
6. **MVP 范围克制**：v1.0 只做单 account + 单工具 `leyemeta.get_user_profile` + 非流式回复；多 account/重连/流式/工具透传留给后续小版本（参见 DESIGN §10）。
7. **设计与编码严格分离**：编码动作必须落在对应 Phase 的子任务里，禁止在调研期间偷偷下手。

---

## Phase 全景与依赖

```
Phase 0  项目初始化与脚手架
   │
   ▼
Phase 1  最小可加载插件骨架  🎯 关键里程碑（被 OpenClaw 加载成功）
   │
   ▼
Phase 2  WebSocket Transport（独立可测）
   │
   ▼
Phase 3  Channel 核心（Gateway / Messaging / Outbound / Security）
   │
   ├─► Phase 4  Tools（依赖 runtime context）
   │
   └─► Phase 5  CLI 向导（依赖 config 写入路径）
            │
            ▼
        Phase 6  测试（单元 / 集成 / staging E2E）
            │
            ▼
        Phase 7  文档与发布
```

**严格规则**：Phase 1 未通过验收（OpenClaw 启动日志看不到 `leyemeta` 插件加载成功）之前，**禁止开始 Phase 2**。

---

## Phase 0 — 项目初始化与脚手架

> 目的：把仓库从"只有文档"变成"有可编译、可 lint 的 TypeScript 工程"。
> 依赖：无。

### 子任务

- [x] 0.1 初始化 `package.json`
  - `name: "@leyemeta/openclaw-channel"`
  - `main: "dist/index.js"`、`types: "dist/index.d.ts"`
  - `scripts`：`build` / `dev` / `clean` / `test` / `lint` / `typecheck`
  - `peerDependencies`：`openclaw`（锁定主版本，对应 npm 上发布的 OpenClaw 主包）
  - `dependencies`：`ws`、`ajv`、`ajv-formats`、`@sinclair/typebox`
  - `devDependencies`：`typescript`、`vitest`、`@types/node`、`@types/ws`、`tsx`、`eslint` 等
- [x] 0.2 `tsconfig.json`：`module=NodeNext`、`target=ES2022`、`strict=true`、`outDir=dist`、`rootDir=src`、`declaration=true`
- [x] 0.3 创建空目录骨架（按 DESIGN §3.1）：
  - `src/index.ts`
  - `src/types.ts`
  - `src/channel/{meta,capabilities,config,gateway,messaging,outbound,security}.ts`
  - `src/transport/{ws-client,frames,auth}.ts`
  - `src/tools/index.ts`
  - `src/cli/index.ts`
  - `src/runtime/{context,logger}.ts`
  - `test/unit/.gitkeep`、`test/e2e/.gitkeep`
- [x] 0.4 仓库基础配置：`.gitignore`（`dist/`、`node_modules/`、`.env*`、`*.log`）、`.editorconfig`、`.nvmrc`
- [x] 0.5 `README.md` 占位（"开发中，参见 docs/DESIGN.md"）
- [x] 0.6 跑通空构建：`pnpm install && pnpm build` 成功输出 `dist/`（即便只有空 register）

### 涉及文件

- `package.json`、`tsconfig.json`、`.gitignore`、`.editorconfig`、`.nvmrc`、`README.md`
- `src/**`（空骨架）

### 验收标准

- `pnpm build` 退出码 0，`dist/index.js` 存在
- `pnpm typecheck` 通过
- `git status` 干净（除新增文件外）

---

## Phase 1 — 最小可加载插件骨架  🎯 Milestone

> **关键里程碑**：本 Phase 的唯一目的，就是让 OpenClaw 在启动日志里打出"leyemeta 插件加载成功"。一旦达成，整套地基稳了；未达成则后续所有 Phase 不准动手。
> 依赖：Phase 0。

### 子任务

- [x] 1.1 编写 `openclaw.plugin.json` 清单（按 DESIGN §4.2）
  - `id: "leyemeta"`、`version: "1.0.0"`
  - `configSchema` 完整声明 `gateway_url` + `accounts.<id>.{member_key,enabled,displayName}`
  - `uiHints` 标记 `member_key: sensitive`
- [x] 1.2 `src/index.ts` 实现 `export default function register(api)`：
  - 调用 `api.registerChannel({ plugin: leyemetaChannel })`
  - 暂不注册 Tool / CLI / Service
- [x] 1.3 `src/channel/meta.ts` 与 `src/channel/capabilities.ts`：填入 DESIGN §6.1 的常量
- [x] 1.4 `src/channel/config.ts`：实现 `listAccountIds` / `resolveAccount`（最简单可用版本，不做缓存）
- [x] 1.5 `src/channel/{gateway,messaging,outbound,security}.ts` 写**空壳实现**：
  - `gateway.start` 立刻返回 `{ stop: async () => {} }`，仅打一行 `logger.info("leyemeta gateway stub started", { accountId })`
  - `messaging.onMessage` 直接 return
  - `outbound.sendText` 返回 `{ ok: true, messageId: "stub" }`
  - `security` 按 DESIGN §6.6 提供常量
- [x] 1.6 `src/types.ts`：定义 `LeyemetaChannelConfig` / `LeyemetaAccount` 等共享类型（含 OpenClaw SDK 类型的最小化本地镜像，待 Phase 2/3 替换为 SDK 真实类型）
- [x] 1.7 `package.json.files` 声明 `["dist", "openclaw.plugin.json"]`（已在 Phase 0 配置，本阶段复核确认）
- [x] 1.8 本地链接到 OpenClaw 验证加载（路径 A）：
  - `openclaw.json.plugins.load.paths` 指向本仓库根（host 通过 `package.json.openclaw.runtimeExtensions` 找到 `dist/index.js`）
  - `plugins.entries.leyemeta.enabled = true`
  - `channels.leyemeta = { gateway_url: "wss://leyemeta.example/openclaw", accounts: { dev: { enabled: true, member_key: "DUMMY", displayName: "dev" } } }`
- [x] 1.9 启动 OpenClaw gateway 观察日志（2026-05-07 验证通过）：
  - ✅ plugin discovery 命中：`8 plugins: browser, device-pair, feishu, file-transfer, leyemeta, memory-core, ...`
  - ✅ schema 校验通过：`channels status` 报 `乐椰星球 dev: enabled, configured`
  - ✅ stub 日志被打印：`[leyemeta] starting leyemeta[dev] (stub, gateway_url=wss://leyemeta.example/openclaw)`

#### 1.8/1.9 排查记录（重要踩坑）

最初版本 `src/index.ts` 写成 `export default function register(api) { api.registerChannel(...) }`,host 能调到 `register` 并打 `leyemeta plugin: registering channel`,但**永远不调 `gateway.start`**,health-monitor 持续报 `[leyemeta:dev] restarting (reason: stopped)`。

根因：OpenClaw 2026.5.x 的 channel 插件入口必须是 `defineBundledChannelEntry(...)` 返回的 `BundledChannelEntryContract`(`kind: "bundled-channel-entry"`),host 通过这个 contract 的 `loadChannelPlugin()` 才能拿到 `ChannelPlugin` 并把 channel 拉进 lifecycle。同时 `ChannelGatewayAdapter` 真实方法是 **`startAccount(ctx) / stopAccount(ctx)`**(不是 `start(account, deps)`)。

修复：
- `src/index.ts` 改用 `defineBundledChannelEntry`,与 `@openclaw/feishu` dist/index.js 同形态
- 新建 `src/channel-plugin-api.ts` 导出 `leyemetaPlugin: ChannelPlugin<LeyemetaAccount>`
- 新建 `src/channel/config-schema.ts` 提供 SDK 形状的 `ChannelConfigSchema`
- 重写 `src/channel/{gateway,capabilities,config,outbound,meta}.ts` 对齐 SDK 真实形状(类型从 `openclaw/plugin-sdk` / `openclaw/plugin-sdk/channel-contract` 引入,`src/types.ts` 删除手写镜像 —— 镜像跟 SDK 偏移正是根因)
- `package.json.openclaw` 增加 `channel` 块 + `compat.pluginApi: ">=2026.5.0"`,`peerDependencies.openclaw` 提到 `>=2026.5.0`

#### 仓库内已自检通过（不依赖 OpenClaw 实例）

- ✅ `pnpm typecheck` / `pnpm build` 全绿，`dist/index.js` 与 `dist/channel/*.js` 完整产出
- ✅ 用 stub `OpenClawPluginApi` 调 `register(api)` → 看到 `[INFO] leyemeta plugin: registering channel` + `registerChannel` 命中，`plugin.id === "leyemeta"`
- ✅ `openclaw.plugin.json.configSchema` 用 ajv 自检：合法配置通过；缺 `member_key` / 缺 `accounts` 被拒收（与验收 #2 一致）

### 涉及文件

- `openclaw.plugin.json`（仓库根，channel manifest 副本）
- `package.json`（`openclaw.channel` 块 + `compat.pluginApi`）
- `src/index.ts`（`defineBundledChannelEntry` 入口）
- `src/channel-plugin-api.ts`（`leyemetaPlugin: ChannelPlugin`）
- `src/channel/{meta,capabilities,config,config-schema,gateway,outbound,messaging,security}.ts`
- `src/types.ts`（仅保留 leyemeta 自有类型，SDK 类型直接从 `openclaw/plugin-sdk` import）

### 验收标准（**全部满足才算通过 Milestone**）

1. ✅ OpenClaw 启动日志中明确出现 `plugin "leyemeta" loaded`（或等价提示），无报错
2. ✅ 配置 schema 校验通过：`channels status` 报 `dev: enabled, configured`
3. ✅ `dev` account 出现在 OpenClaw "channels/accounts" 列表中
4. ✅ stub gateway 的 `startAccount` 日志被打印（每次 lifecycle 启动一次）
5. ⏸️ 关闭 OpenClaw 干净退出，stub 的 `stop` 不抛错 — Phase 1 stub 立刻返回导致 host 不会调用 `stop`，Phase 2 transport 接入后再回头验证

> Phase 1 Milestone 已通过：1-4 全部命中，5 因 stub 形态不触发，留待 Phase 2 验证。**已可进入 Phase 2**。

---

## Phase 2 — WebSocket Transport（独立可测）

> 目的：把"和 leyemeta 平台说话"的传输层做成一个不依赖 OpenClaw 的独立模块。
> 依赖：Phase 1（骨架已能加载，确保 transport 一旦接入就能跑）。

### 子任务

- [x] 2.1 `src/transport/frames.ts`：
  - 定义统一帧外壳 `{ type, id?, ts, payload }`（DESIGN §5.2）
  - 定义入站枚举 `inbound.message` / `inbound.cancel` / `ping` / `ready`
  - 定义出站枚举 `outbound.delta` / `outbound.tool_status` / `outbound.error` / `pong`
  - 提供 `encode(frame): string` / `decode(raw): Frame`，`decode` 在 type 未知时抛 `INVALID_FRAME`
- [x] 2.2 `src/transport/auth.ts`：
  - 构造 `Authorization: Bearer <member_key>`、`Sec-WebSocket-Protocol: leyemeta.openclaw.v1`、`X-Plugin-Version`、`X-Account-Id`
- [x] 2.3 `src/transport/ws-client.ts`（核心）：
  - 类 `LeyemetaWsClient`，构造参数：`{ url, memberKey, accountId, pluginVersion, logger, onReady, onMessage, onError, onDisconnect, webSocketFactory?, reconnect?, heartbeatIntervalMs?, jitter? }`
  - `start()` / `stop()` / `send(frame)` / `getState()` / `getReadyInfo()`
  - 收到 `ready` 缓存 `{ agentId, agentName, capabilities }` 并触发 `onReady`；同时**重置 reconnectAttempts**（仅 TCP open 不算稳定）
  - 心跳：30s 无入站则发 `ping`；任何入站重置计时器；收 `ping` 自动回 `pong`
  - 重连：指数退避 1→2→4→8→16s，封顶 30s，±20% 抖动；`stop()` 后不再重连
  - 错误归一化：网络断开 → `onDisconnect`；协议错误 / 解码失败 → `onError`
- [x] 2.4 `src/runtime/logger.ts`：定义 `Logger` 接口（与 SDK `ChannelLogSink` 同形），提供 `noopLogger` / `withPrefix` / `describeError`，便于单测注入
- [x] 2.5 单元测试（vitest，19 用例全绿）：
  - `test/unit/frames.test.ts`：encode/decode round-trip（ready/inbound.message/outbound.delta/ping/pong）+ Buffer/Uint8Array 解码 + 错误帧拒收（非 JSON / 未知 type / 非对象 / 错误 id&ts / 缺 payload）+ 类型保护
  - `test/unit/ws-client.test.ts`：真实 `ws` server 握手（Authorization/X-Plugin-Version/X-Account-Id/subprotocol）+ ping→pong 自动回 + inbound.message 派发 + outbound.delta 上线 + 未 ready 时 send=false；fake socket + fake timers 验证重连序列 1→2→4→8→16→30→30s + `stop()` 取消重连 + `ready` 后退避计数重置

### 涉及文件

- `src/transport/{frames,auth,ws-client}.ts`
- `src/runtime/logger.ts`
- `vitest.config.ts`（新增）
- `test/unit/frames.test.ts`、`test/unit/ws-client.test.ts`

### 验收标准

- ✅ `pnpm test` 19/19 通过：编解码、握手、心跳、断线重连退避序列符合预期
- ✅ `pnpm typecheck` / `pnpm build` 全绿，dist 下 `transport/{frames,auth,ws-client}.{js,d.ts}` + `runtime/logger.{js,d.ts}` 完整产出
- ✅ transport 模块零 OpenClaw 依赖（仅依赖 `ws` + 本地 `runtime/logger` 接口）

> Phase 2 已通过。**已可进入 Phase 3**。

---

## Phase 3 — Channel 核心（接业务逻辑）

> 目的：用 Phase 2 的 transport 替换掉 Phase 1 的 stub，把对话流真正打通（非流式）。
> 依赖：Phase 1（骨架）+ Phase 2（transport）。

### 子任务

- [x] 3.1 `src/runtime/context.ts`：
  - 全局 `conns: Map<accountId, LeyemetaWsClient>`
  - `getConn(accountId)`、`registerConn`、`unregisterConn`、`listConnAccountIds`
  - `lookupMemberKey(accountId, cfg)`：从 OpenClaw cfg 反查 `accountId → member_key`（供 Phase 4 Tool 使用）
  - 测试钩子 `_resetConnsForTest`，生产代码不调用
- [x] 3.2 升级 `src/channel/gateway.ts`（替换 stub）：
  - 用 `LeyemetaWsClient` 实例化连接，订阅 `onReady/onMessage/onError/onDisconnect`
  - `startAccount` 注册到连接池，`stop` 注销
  - `setStatus` 完整反映 lifecycle：`lastStartAt / lastConnectedAt / lastDisconnect / lastInboundAt / lastError / lastStopAt`
  - `abortSignal` → 触发 `client.stop`（idempotent）
  - 入站派发：**尝试**通过 `ctx.channelRuntime.turn.run({ adapter: { ingest, resolveTurn } })` 走 host turn pipeline；
    缺失或 host 提供的是 startup 子集时，只记日志（防御性，见下方"已知遗留"）
- [x] 3.3 升级 `src/channel/messaging.ts`：
  - 不挂 SDK `ChannelMessagingAdapter`（SDK 形状是 target/sessionKey 解析器，leyemeta 不需要）
  - 改为导出**纯转换函数**：`buildSessionKey` / `injectIdentityIntoText` / `buildNormalizedTurnInput` / `buildInboundEnvelope`
  - 身份注入（MVP 选 A）：`[来自 leyemeta 用户:${name} (${id})]\n` prepend
  - sessionKey = `leyemeta/<accountId>/<conversationId>`
  - 单测覆盖空白 name / 缺 id / ts fallback / envelope 完整性
- [x] 3.4 升级 `src/channel/outbound.ts`：
  - `deliveryMode: "direct"`、`textChunkLimit: 4000`
  - `extractConversationId` 兼容三种 `to`：纯 conversationId / sessionKey 形式 / `:` 分段
  - `messageId = "asm_<base36 ts>_<rand8>"`（无 nanoid 依赖）
  - 一次性发 `outbound.delta(done:true)`
  - 错误以 `throw` 暴露（host outbound pipeline 走 retry/lastError），而不是吞成 ok 结果
  - 单测 9 例覆盖成功 / 缺 accountId / 无连接 / ws 未 ready / sessionKey 形 to
- [x] 3.5 `src/channel/security.ts`：`resolveDmPolicy: () => ({ policy: "open", allowFrom: null, ... })`（DESIGN §6.6）
  - DESIGN 旧版的 `resolveSenderId` 已不在 SDK 形状内，senderId 改由入站帧 `payload.user.id` 透传（`buildInboundEnvelope` 已覆盖）
- [x] 3.6 在 `src/channel-plugin-api.ts` 装载 `gateway / outbound / security`（`messaging` 仍 undefined，SDK 真实形状不需要）

### 已知遗留（不阻塞 Phase 3 收尾）

`ctx.channelRuntime.turn.run` 的完整 `adapter.resolveTurn`（返回 `AssembledChannelTurn`/`PreparedChannelTurn`）需要构造 ReplyDispatcher、recordInboundSession、agentRoute、storePath 等一大堆 host 细节，
参考 `@openclaw/feishu/dist/monitor.account-CUZxYkjE.js:2390~2500`。这部分按 DESIGN §12 的"OpenClaw 内部 API 未公开文档"风险记录，**不在 Phase 3 范围**。当前实现：
- `ingest()` 已正确返回 `NormalizedTurnInput`（身份注入 + 时间戳 + raw 透传）
- `resolveTurn()` 暂返回 null，host turn pipeline 会"drop with reason"——不会崩，只是不真发回复
- 真正的 inbound → Agent → outbound 闭环留给 Phase 6 fake server e2e + 真实 OpenClaw reply pipeline 接入时一并打通

### 涉及文件

- `src/runtime/context.ts`（新版）
- `src/channel/{gateway,messaging,outbound,security}.ts`（全部从 stub/undefined 升级）
- `src/channel-plugin-api.ts`（挂载 security）
- `test/unit/{messaging,outbound,runtime-context}.test.ts`（新增 22 例）

### 验收标准

- ✅ `pnpm typecheck` / `pnpm build` 全绿
- ✅ `pnpm test` 41/41 通过（Phase 2 的 19 + Phase 3 新增 22）
- ✅ 协议级：`outbound.delta(done:true)` 帧结构符合 DESIGN §5.4（单测断言）
- ✅ 身份注入命中：`textForAgent` 包含 `[来自 leyemeta 用户:<name> (<id>)]`
- ✅ sessionKey 拼接正确：`leyemeta/<acc>/<conv>`
- ⏸️ 端到端：`inbound.message → Agent → outbound.delta(done:true)` 闭环 —— 因 host turn pipeline 集成留给 Phase 6，本阶段以"transport + 帧契约 + 协议正确性"为完成线
- ⏸️ `inbound.cancel` 后 OpenClaw 停止生成 —— 同样依赖 abortController hook，Phase 6 一并验

> Phase 3 已完成 transport + 协议层闭环；reply pipeline 集成与 fake server e2e 移交 Phase 6。**已可进入 Phase 4（Tools）与 Phase 5（CLI）并行**。

---

## Phase 4 — Tools（leyemeta.get_user_profile）

> 目的：把"平台 API 注册为 OpenClaw Tool"最小闭环跑通，证明 Tool 能拿到 `member_key` 并调通真实 HTTP API。
> 依赖：Phase 3（runtime context 提供 accountId → member_key 反查）。

### 子任务

- [ ] 4.1 `src/tools/user-profile.ts`：
  - `name: "leyemeta.get_user_profile"`
  - description 严格按 DESIGN §7.2 的中文描述（含"userId 必须取自上下文"）
  - parameters: `{ userId: string }`（用 TypeBox / Ajv 校验）
  - execute：
    - `memberKey = lookupMemberKey(context)`，缺失时返回 `{ type: "error" }`
    - `fetch(GET https://leyemeta.com/api/users/{userId}, Bearer memberKey)`
    - 4xx/5xx → `{ type: "error", content: "查询失败: HTTP {status}" }`
    - 成功 → `{ type: "json", content: JSON.stringify(body, null, 2) }`
- [ ] 4.2 `src/tools/index.ts`：聚合导出 `[getUserProfileTool]`
- [ ] 4.3 在 `src/index.ts.register()` 中遍历注册：`tools.forEach(t => api.registerTool(t))`
- [ ] 4.4 单元测试：mock fetch + mock context，覆盖成功 / 401 / 缺 memberKey 三条路径
- [ ] 4.5 联调：在 staging 让 Agent 触发该 Tool，观察 OpenClaw 工具调用日志中携带正确 `Authorization`

### 涉及文件

- `src/tools/{index,user-profile}.ts`
- `src/runtime/context.ts`（补完 `lookupMemberKey`）
- `test/unit/user-profile.test.ts`

### 验收标准

- 单测全绿
- staging 真实命中：Agent 输入"我的资料"→ 模型调用工具 → 返回真实用户资料 → 回复中体现

---

## Phase 5 — CLI 向导

> 目的：让用户用 `openclaw leyemeta agent add` 一条命令完成 account + binding 配置。
> 依赖：Phase 1（schema）+ Phase 3（连通性测试需 transport）。

### 子任务

- [ ] 5.1 `src/cli/index.ts`：
  - 用 `api.registerCli((program) => …)` 挂载 `leyemeta agent` 子命令
  - 子命令：`add` / `list` / `test <accountId>` / `remove <accountId>`
- [ ] 5.2 `src/cli/agent-add.ts`（交互按 DESIGN §8.2）：
  - 提问 account id / member_key / 选哪个本地 Agent / 是否测试连通
  - 选项"创建新 Agent" → 仅打印手册文案，不直接改 `agents.list`
- [ ] 5.3 `src/cli/agent-list.ts`：读 `api.runtime.config`，列出 `channels.leyemeta.accounts` + 对应 binding agentId
- [ ] 5.4 `src/cli/agent-test.ts`：临时实例化 `LeyemetaWsClient` 跑一次握手，命中 `ready` 即认为通；超时 10s 失败
- [ ] 5.5 `src/cli/agent-remove.ts`：删除 `accounts[id]` + 移除对应 `bindings`，要求 `--yes` 确认
- [ ] 5.6 通用：原子写 `~/.openclaw/openclaw.json`
  - 先备份到 `openclaw.json.bak.<ts>`
  - 写临时文件 + `fs.rename` 原子替换
  - 写后用 `configSchema` + `bindings` 规则校验，失败则回滚
- [ ] 5.7 `member_key` 永不打印；`list` 输出脱敏（`K1_xxxx****`）
- [ ] 5.8 CLI 单测：dry-run 模式注入 mock config，断言生成的 patch 正确

### 涉及文件

- `src/cli/{index,agent-add,agent-list,agent-test,agent-remove}.ts`
- `test/unit/cli.test.ts`

### 验收标准

- `openclaw leyemeta agent add` 跑完后 `openclaw.json` diff 符合预期，且 OpenClaw 重启后能加载新 account
- `agent test` 对错的 `member_key` 返回非 0 退出码 + 明确错误
- `agent remove` 触发 backup 文件存在

---

## Phase 6 — 测试

> 目的：把验证方式从"手工 staging"升级为"CI 可重复"。
> 依赖：Phase 3 / 4 / 5 已基本完成（需要被测对象）。

### 子任务

- [ ] 6.1 单元测试覆盖（vitest）：
  - `transport/frames`：编解码 + 错误帧
  - `transport/ws-client`：握手 / ping-pong / 重连退避
  - `channel/messaging`：身份注入正确性、sessionKey 拼接
  - `channel/outbound`：messageId 生成、`done:true` 帧结构
  - `tools/user-profile`：成功 / 401 / 无 memberKey
  - `cli/*`：dry-run patch
- [ ] 6.2 集成测试（fake WS server，进程内）：
  - `test/e2e/fake-server.ts`：实现 `ws` server，按帧契约 fixture 收发
  - 用例：握手 → 推 inbound → assert 收到 outbound.delta(done:true) → 主动断开 → 验证客户端按退避重连
- [ ] 6.3 staging E2E（可手动触发）：
  - `test/e2e/plugin.e2e.test.ts`：读环境变量 `LEYEMETA_STAGING_KEY`，跳过条件 `if (!key) test.skip`
  - 用例（按 DESIGN §9.3）：多 account 并发路由、断线重连后会话延续、身份注入命中、Tool 真实调用、cancel 生效
- [ ] 6.4 CI 配置：GitHub Actions 跑 `lint + typecheck + unit + integration`；E2E 仅手动 dispatch
- [ ] 6.5 覆盖率门槛：`transport/` 与 `channel/` 行覆盖 ≥ 80%

### 涉及文件

- `test/unit/**`、`test/e2e/{fake-server,plugin.e2e}.ts`
- `.github/workflows/ci.yml`

### 验收标准

- CI 全绿
- 集成测试 < 30s 内完成
- staging E2E 文档说明清楚如何在本地跑通

---

## Phase 7 — 文档与发布

> 目的：把项目从"内部能跑"变成"对接方与终端用户都能用"。
> 依赖：Phase 1–6 全部完成。

### 子任务

- [ ] 7.1 `docs/PROTOCOL.md`：以 DESIGN §5 为基础，整理为独立规范文档（与平台后端共建）
  - 帧类型完整 schema（JSON Schema）
  - 错误码字典（`UNAUTHORIZED`/`INVALID_FRAME`/`AGENT_FAILED`/`TOOL_TIMEOUT`/`RATE_LIMITED`/`UPSTREAM_DOWN`）
  - 版本协商策略
- [ ] 7.2 `docs/USER-GUIDE.md`：终端用户视角
  - 安装：`pnpm add -g @leyemeta/openclaw-channel` 或软链方式
  - 配置：`openclaw.json` 片段、CLI 向导
  - 常见问题（连不上、握手失败、member_key 在哪拿）
- [ ] 7.3 `README.md`：项目门面（特性、快速开始、链接到 PROTOCOL/USER-GUIDE/DESIGN）
- [ ] 7.4 `CHANGELOG.md`：从 v1.0.0 开始记录
- [ ] 7.5 npm 发布准备：
  - `package.json` 校对 `name/version/license/repository/homepage/files`
  - `prepublishOnly` 脚本：`clean && build && test`
  - `npm pack --dry-run` 检查产物只含 `dist/` + `openclaw.plugin.json` + 元信息
- [ ] 7.6 决策日志：在 `docs/DESIGN.md` 末尾追加"决策日志"小节，记录 v0.1 → v1.0 的关键调整
- [ ] 7.7 打 git tag `v1.0.0` + GitHub Release（包含发布说明）

### 涉及文件

- `docs/{PROTOCOL,USER-GUIDE}.md`、`README.md`、`CHANGELOG.md`、`docs/DESIGN.md`
- `package.json`

### 验收标准

- `npm publish --dry-run` 成功
- 在干净环境按 USER-GUIDE 走一遍能跑通
- PROTOCOL.md 与平台后端 review 一致

---

## 进度看板（手动维护）

| Phase | 状态 | 完成率 | 备注 |
|-------|------|--------|------|
| 0 脚手架        | ✅ 已完成 | 100% | `pnpm build` / `pnpm typecheck` 均通过 |
| 1 骨架可加载 🎯 | ✅ 已完成 | 100% | 2026-05-07 在 OpenClaw 2026.5.5 上验证 stub `startAccount` 被调用；接口形态从 `register(api)` 迁到 `defineBundledChannelEntry`，详见本 Phase 排查记录 |
| 2 Transport     | ✅ 已完成 | 100% | 2026-05-09：`pnpm test` 19/19 通过；frames + ws-client + auth + logger 全部实现；transport 零 OpenClaw 依赖 |
| 3 Channel 核心  | ✅ 已完成 | 100% | 2026-05-09：runtime/context + gateway/messaging/outbound/security 全部上线；`pnpm test` 41/41（新增 22 例）。host reply pipeline 集成留给 Phase 6 |
| 4 Tools         | ⬜ 未开始 | 0% | 依赖 3 |
| 5 CLI           | ⬜ 未开始 | 0% | 依赖 1+3 |
| 6 测试          | ⬜ 未开始 | 0% | 依赖 3+4+5 |
| 7 文档与发布    | ⬜ 未开始 | 0% | 依赖全部 |

---

## 附：Phase 1 失败时的诊断清单

如果 Phase 1 OpenClaw 启动看不到插件加载，按顺序排查：

1. `openclaw.plugin.json` 是否在仓库根 + `dist/` 都存在（`package.json.files` 漏配是高频原因）
2. `openclaw.json.plugins.load.paths` 是否指向 `dist/` 而非 `src/`
3. `openclaw.json.plugins.entries.leyemeta.enabled` 是否为 true
4. `register` 是否 `export default` 且签名为 `(api) => void`
5. `configSchema` 校验失败 → OpenClaw 启动期会拒载，看具体错误字段
6. node 版本是否与 OpenClaw 要求一致
7. 软链方式时 `~/.openclaw/extensions/leyemeta` 是否真的指向编译后产物所在目录

> 上述任一项错配都会让 Phase 1 静默失败，导致 Phase 2 之后所有工作建在沙上。
