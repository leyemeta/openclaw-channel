#!/usr/bin/env bash
# ============================================================
# 乐椰 (Leyemeta) OpenClaw 频道安装固化脚本
# ============================================================
# 用途：一键安装 @leyemeta/openclaw-channel 插件，
#       创建 Agent、添加 Account 并绑定路由。
#
# 使用方法：
#   chmod +x install-leyemeta.sh
#   ./install-leyemeta.sh
#
# 环境变量（可覆盖默认值）：
#   LEYE_ID          - 应用唯一标识 (默认: 1536656052991430656)
#   LEYE_CODE        - 应用凭证 / member_key (默认: e09cc5e70ced4cedb2ae046d7b3b1304)
#   LEYE_NAME        - Agent 与 account 显示名称 (默认: 我的小龙虾)
#   LEYE_GATEWAY_URL - WebSocket 网关地址 (默认: wss://sps-test.3mzz.cn/api/ai/openclaw)
#   OPENCLAW_WORKSPACE - 插件安装根目录 (默认: ~/.openclaw/workspace)
#   AGENT_WORKSPACE  - Agent 专有工作区 (默认: ~/.openclaw/workspace-<LEYE_ID>)
#   NODE_VERSION     - 自动安装的 Node 主版本 (默认: 22)
#   NVM_VERSION      - 缺少 nvm 时自动安装的 nvm 版本 (默认: v0.40.1)
# ============================================================

set -euo pipefail

# ---- 参数（可通过环境变量覆盖） ----
ID="${LEYE_ID:-2063205181969010688}"
CODE="${LEYE_CODE:-c09ef0a3e2c544aba7a254693a8f96ad}"
NAME="${LEYE_NAME:-小程}"
GATEWAY_URL="${LEYE_GATEWAY_URL:-wss://sps-test.3mzz.cn/api/ai/openclaw}"
# WORKSPACE：插件安装根目录（全局共享，npm install 用）。
WORKSPACE="${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}"
# AGENT_WORKSPACE：每个 Agent 的专有工作区，按 ID 区分，互不干扰。
AGENT_WORKSPACE="${AGENT_WORKSPACE:-$HOME/.openclaw/workspace/$ID}"
# 自动安装 Node 时使用的主版本，以及缺 nvm 时拉取的 nvm 版本。
NODE_VERSION="${NODE_VERSION:-22}"
NVM_VERSION="${NVM_VERSION:-v0.40.1}"

# ---- 颜色 ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# ---- 前置检查 ----

# 确保 nvm 可用：已安装则加载，未安装则自动安装后加载。
ensure_nvm() {
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh"
    return 0
  fi

  log_warn "未检测到 nvm，正在自动安装 nvm $NVM_VERSION ..."
  if command -v curl &>/dev/null; then
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | bash
  elif command -v wget &>/dev/null; then
    wget -qO- "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | bash
  else
    log_error "缺少 curl/wget，无法自动安装 nvm，请手动安装 nvm 或 Node.js >= 22.19"
    exit 1
  fi

  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    log_info "nvm 安装完成。"
  else
    log_error "nvm 自动安装失败，请手动安装 nvm 或 Node.js >= 22.19"
    exit 1
  fi
}

# 用 nvm 安装目标 Node 主版本并设为默认。
install_node_via_nvm() {
  ensure_nvm
  log_info "正在通过 nvm 安装 Node $NODE_VERSION ..."
  nvm install "$NODE_VERSION"
  nvm use "$NODE_VERSION"
  nvm alias default "$NODE_VERSION" 2>/dev/null || true
}

# 确保 Node.js 存在且版本 >= 22.19，不满足则自动安装。
ensure_node() {
  if ! command -v node &>/dev/null; then
    log_warn "未找到 Node.js，正在自动安装 Node $NODE_VERSION ..."
    install_node_via_nvm
  fi

  NODE_VER=$(node --version | sed 's/v//')
  NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
  NODE_MINOR=$(echo "$NODE_VER" | cut -d. -f2)

  if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 19 ]; }; then
    log_warn "Node.js 版本 $NODE_VER < 22.19，正在通过 nvm 升级到 $NODE_VERSION ..."
    install_node_via_nvm

    # 升级后复核，仍不满足则终止，避免后续步骤误用旧版本。
    NODE_VER=$(node --version | sed 's/v//')
    NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
    NODE_MINOR=$(echo "$NODE_VER" | cut -d. -f2)
    if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 19 ]; }; then
      log_error "Node.js 自动升级后版本仍为 $NODE_VER (< 22.19)，请手动处理。"
      exit 1
    fi
  fi
}

check_prereqs() {
  log_info "检查前置环境..."

  ensure_node

  # openclaw 由调用方提供（用户必然已装 openclaw 才会运行本脚本），此处仅兜底检查。
  if ! command -v openclaw &>/dev/null; then
    log_error "未找到 openclaw 命令，请先安装 OpenClaw 后再运行本脚本。"
    exit 1
  fi

  log_info "Node.js $(node --version) ✓"
  log_info "OpenClaw $(openclaw --version 2>/dev/null || echo 'OK') ✓"
}

# ---- 第 1 步：安装插件 ----
install_plugin() {
  log_info "第 1 步：检查 Leyemeta 插件..."

  PLUGIN_LIST=$(openclaw plugins list 2>&1)
  if echo "$PLUGIN_LIST" | grep -qi "leyemeta"; then
    log_info "插件 @leyemeta/openclaw-channel 已存在，跳过安装。"
  else
    log_info "正在安装 @leyemeta/openclaw-channel..."
    cd "$WORKSPACE"
    npm install @leyemeta/openclaw-channel

    if ! openclaw plugins list 2>&1 | grep -qi "leyemeta"; then
      log_info "通过 openclaw plugins install 注册插件..."
      openclaw plugins install "@leyemeta/openclaw-channel"
    fi

    log_info "插件安装完成。"
  fi

  # 确保插件已启用
  openclaw plugins enable leyemeta 2>/dev/null || true
}

# ---- 第 2 步：配置应用凭证 ----
configure_agent_and_account() {
  log_info "第 2 步：配置 Agent 与 Account..."

  # 2.1 创建或复用 Agent
  AGENT_LIST=$(openclaw agents list 2>&1)
  if echo "$AGENT_LIST" | grep -q "$ID"; then
    log_info "Agent $ID 已存在，将复用。"
  else
    log_info "正在创建 Agent: $ID（专有工作区: $AGENT_WORKSPACE）..."
    # 文档未保证自动创建工作区目录，先 mkdir -p 兜底。
    mkdir -p "$AGENT_WORKSPACE"
    openclaw agents add "$ID" --workspace "$AGENT_WORKSPACE" --non-interactive
    openclaw agents set-identity --agent "$ID" --name "$NAME" 2>/dev/null || true
    log_info "Agent 创建成功。"
  fi

  # 2.2 添加 Account
  log_info "正在添加 Leyemeta channel account..."
  openclaw channels add \
    --channel leyemeta \
    --account "$ID" \
    --token "$CODE" \
    --name "$NAME"

  log_info "Account 添加成功。"
}

# ---- 第 3 步：绑定 Agent 与渠道 ----
bind_agent() {
  log_info "第 3 步：绑定 Agent 与渠道..."

  EXISTING_BINDINGS=$(openclaw agents bindings --json 2>&1)
  if echo "$EXISTING_BINDINGS" | grep -Eq "\"agentId\":[[:space:]]*\"$ID\""; then
    log_info "Agent $ID 已有绑定，将重建绑定。"
    openclaw agents unbind --agent "$ID" --bind "leyemeta:$ID" 2>/dev/null || true
  fi

  openclaw agents bind --agent "$ID" --bind "leyemeta:$ID"
  log_info "绑定成功。"
}

# ---- 第 4 步：验证 ----
verify() {
  log_info "第 4 步：验证配置..."

  echo ""
  echo "============================================"
  echo "  安装验证报告"
  echo "============================================"

  # 插件状态
  if openclaw plugins list 2>&1 | grep -qi "leyemeta.*enabled"; then
    echo -e "  插件状态:     ${GREEN}✅ 已安装并启用${NC}"
  else
    echo -e "  插件状态:     ${RED}❌ 未正确加载${NC}"
  fi

  # Agent 状态
  if openclaw agents list 2>&1 | grep -q "$ID"; then
    echo -e "  Agent:        ${GREEN}✅ $ID${NC}"
  else
    echo -e "  Agent:        ${RED}❌ 未找到${NC}"
  fi

  # Account 状态
  if openclaw channels list --json 2>&1 | grep -q "$ID"; then
    echo -e "  Account:      ${GREEN}✅ $ID ($NAME)${NC}"
  else
    echo -e "  Account:      ${RED}❌ 未找到${NC}"
  fi

  # 绑定状态
  if openclaw agents bindings --json 2>&1 | grep -Eq "\"agentId\":[[:space:]]*\"$ID\""; then
    echo -e "  路由绑定:     ${GREEN}✅ leyemeta:$ID → Agent $ID${NC}"
  else
    echo -e "  路由绑定:     ${RED}❌ 未绑定${NC}"
  fi

  echo "============================================"
  echo ""
}

# ---- 第 5 步：重启网关 ----
restart_gateway() {
  log_info "第 5 步：重启 OpenClaw 网关以应用配置..."

  # 优先安全重启（等待在途任务排空）；若网关未运行则回退到 start。
  # 部分容器内的 openclaw 不支持 restart/start 子命令，只有裸 `openclaw gateway`，
  # 该命令是前台阻塞式启动，故最后一级回退用 nohup 后台拉起，避免卡住脚本。
  if openclaw gateway restart --safe 2>/dev/null; then
    log_info "网关已安全重启。"
  elif openclaw gateway start 2>/dev/null; then
    log_info "网关原先未运行，已启动。"
  elif command -v openclaw &>/dev/null; then
    log_warn "restart/start 子命令不可用（容器环境），回退到后台启动 openclaw gateway ..."
    nohup openclaw gateway >/tmp/openclaw-gateway.log 2>&1 &
    log_info "网关已通过 openclaw gateway 后台启动（日志: /tmp/openclaw-gateway.log）。"
  else
    log_warn "自动重启网关失败，请手动执行：openclaw gateway restart"
  fi

  log_info "全部完成！${NAME} 已就绪，可以在乐椰平台中与 OpenClaw 沟通了 🎉"
}

# ---- 执行主流程 ----
main() {
  echo ""
  echo "============================================"
  echo "  乐椰 (Leyemeta) OpenClaw 频道安装脚本"
  echo "============================================"
  echo "  Agent ID:    $ID"
  echo "  显示名称:    $NAME"
  echo "  专有工作区:  $AGENT_WORKSPACE"
  echo "  Gateway:     $GATEWAY_URL"
  echo "============================================"
  echo ""

  check_prereqs
  install_plugin
  configure_agent_and_account
  bind_agent
  verify
  restart_gateway
}

main "$@"
