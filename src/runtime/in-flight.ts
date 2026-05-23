/**
 * in-flight turn 注册表 —— 让"外部信号"(平台转发的 inbound.cancel /
 * 插件↔平台 ws 信道断 / 插件自身关停)能精准找到对应 turn 并触发
 * abort + close,避免 agent 继续烧 token、ws 继续发已被丢弃的流。
 *
 * 数据结构:Map<accountId, Map<conversationId, InFlightTurn>>。
 *   - 一个 conversation 同时只允许一个 in-flight turn —— 后到的会顶掉前一个
 *     (SDK inbound dedupe 通常已先挡掉重复入站,这里只是兜底)。
 *   - 模块级 Map,对齐 `./context.ts` 风格(host 单进程加载本插件,所有
 *     channel/outbound/tools 共享同一份模块导出)。
 */

export interface InFlightTurn {
  /** 调用 AbortController.abort(reason);幂等(底层 AbortController 重复调用是 no-op)。 */
  abort: (reason: string) => void;
  /**
   * 立刻发 done:true(或 outbound.error)收尾,reason 用于日志区分:
   *   - cancelled:平台转发的 inbound.cancel
   *   - disconnected:插件↔平台 ws 信道断
   *   - shutdown:插件自身关停(SIGTERM / ctx.abortSignal)
   * 实现侧应是幂等的(已收尾过就 no-op)。
   */
  close: (reason: "cancelled" | "disconnected" | "shutdown") => void;
}

/** Map<accountId, Map<conversationId, InFlightTurn>> */
const turns = new Map<string, Map<string, InFlightTurn>>();

/**
 * 注册 in-flight turn。同 (accountId, conversationId) 已有时,先 abort 旧的,再覆盖。
 * Why abort 旧 turn:即使 SDK 入站 dedupe 漏过,新 turn 起来后旧 turn 也应该立即停掉,
 * 否则同一会话两个并发 agent 会乱写收尾帧。
 */
export function registerTurn(
  accountId: string,
  conversationId: string,
  turn: InFlightTurn,
): void {
  let perAccount = turns.get(accountId);
  if (!perAccount) {
    perAccount = new Map();
    turns.set(accountId, perAccount);
  }
  const prev = perAccount.get(conversationId);
  if (prev && prev !== turn) {
    try {
      prev.abort("superseded by new in-flight turn");
    } catch {
      // 旧 turn 的 abort 抛错不应阻塞新 turn 注册
    }
  }
  perAccount.set(conversationId, turn);
}

/**
 * 注销 in-flight turn。仅当当前注册的就是 `turn` 时才删除 —— 防止"旧 turn 在 finally
 * 里注销时误删已经被新 turn 顶替的条目"。
 */
export function unregisterTurn(
  accountId: string,
  conversationId: string,
  turn?: InFlightTurn,
): void {
  const perAccount = turns.get(accountId);
  if (!perAccount) return;
  const current = perAccount.get(conversationId);
  if (!current) return;
  if (turn && current !== turn) return;
  perAccount.delete(conversationId);
  if (perAccount.size === 0) {
    turns.delete(accountId);
  }
}

export function lookupTurn(
  accountId: string,
  conversationId: string,
): InFlightTurn | undefined {
  return turns.get(accountId)?.get(conversationId);
}

/**
 * 列出某个 account 名下所有 in-flight turn —— 用于 ws 断开 / 关停时批量 abort。
 * 返回快照数组,调用方迭代过程中即便有 turn 通过 finally 注销自己,也不会受影响。
 */
export function listByAccount(accountId: string): InFlightTurn[] {
  const perAccount = turns.get(accountId);
  if (!perAccount || perAccount.size === 0) return [];
  return Array.from(perAccount.values());
}

/**
 * 清空某个 account 名下所有 in-flight 条目(不调用 abort/close)。
 * 用在 gateway.startAccount 的 finally:此时已经先 abort 过一遍了,清表只是回收。
 */
export function clearAccount(accountId: string): void {
  turns.delete(accountId);
}

/** 测试钩子:清空所有注册项,生产代码不应调用。 */
export function _resetInFlightForTest(): void {
  turns.clear();
}
