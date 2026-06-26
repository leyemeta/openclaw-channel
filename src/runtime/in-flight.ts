/**
 * in-flight turn 注册表:让外部信号(inbound.cancel / ws 断 / 插件关停)能找到
 * 对应 turn 并 abort + close,避免 agent 继续烧 token、ws 继续发已丢弃的流。
 *
 * 结构 Map<accountId, Map<conversationId, InFlightTurn>>,每 conversation 至多一个
 * in-flight turn(后到顶掉先到)。模块级 Map,与 ./context.ts 同款风格。
 */

export interface InFlightTurn {
  /** 调用 AbortController.abort(reason);幂等(底层 AbortController 重复调用是 no-op)。 */
  abort: (reason: string) => void;
  /**
   * 立刻发 done:true(或 outbound.error)收尾,幂等。reason 仅用于日志区分:
   * cancelled(inbound.cancel)/ disconnected(ws 断)/ shutdown(插件关停)。
   */
  close: (reason: "cancelled" | "disconnected" | "shutdown") => void;
}

/** Map<accountId, Map<conversationId, InFlightTurn>> */
const turns = new Map<string, Map<string, InFlightTurn>>();

/**
 * 注册 in-flight turn;同 (accountId, conversationId) 已有时先 abort 旧的再覆盖,
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
      // 旧 turn abort 抛错不应阻塞新 turn 注册
    }
  }
  perAccount.set(conversationId, turn);
}

/**
 * 注销 in-flight turn。仅当当前注册的就是 `turn` 时才删 —— 防止旧 turn 在 finally
 * 里误删已被新 turn 顶替的条目。
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
 * 列出某 account 名下所有 in-flight turn,用于 ws 断 / 关停时批量 abort。
 * 返回快照数组,迭代期间有 turn 注销自己也不受影响。
 */
export function listByAccount(accountId: string): InFlightTurn[] {
  const perAccount = turns.get(accountId);
  if (!perAccount || perAccount.size === 0) return [];
  return Array.from(perAccount.values());
}

/**
 * 清空某 account 名下所有条目(不调 abort/close)。用于 startAccount 的 finally,
 * 此时已 abort 过一遍,清表只是回收。
 */
export function clearAccount(accountId: string): void {
  turns.delete(accountId);
}

/** 测试钩子:清空所有注册项,生产代码不应调用。 */
export function _resetInFlightForTest(): void {
  turns.clear();
}
