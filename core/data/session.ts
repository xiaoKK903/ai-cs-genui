/**
 * 服务端会话状态 —— 会话状态的单一真相源（R3 对策）
 *
 * 前端只持有副本：所有状态变更都发生在服务端，通过 SSE 的 `state` 事件同步给前端。
 * 这样才能保证「用户点了订单准备退款」这件事在下一轮对话里不会丢。
 *
 * MVP 用进程内 Map；接口按可替换设计，生产换成 Redis 即可（多实例部署必需，
 * 否则会话会随扩容丢失 —— 见第四阶段生产化必补项）。
 */

import type { RefundResult } from "./mock-db";
import type { ComponentName, SessionState, SessionTurn } from "../protocol/types";

export interface ServerSession extends SessionState {
  /** 最近一次退款提交的真实结果，ResultCard 从这里取数，模型不参与 */
  lastRefundResult?: RefundResult;
  createdAt: number;
  updatedAt: number;
}

const SESSIONS = new Map<string, ServerSession>();

/**
 * 取得（或创建）会话。
 *
 * `userId` 由服务端鉴权中间件解析登录态得到，**永远不从请求体里读** ——
 * 这是「越权查订单」的兜底位置：模型传什么 userId 都不影响这里。
 */
export function getOrCreateSession(sessionId: string, userId: string): ServerSession {
  const existing = SESSIONS.get(sessionId);
  if (existing) {
    // 登录态以本次请求为准；若与既有会话不一致，说明会话被复用，直接重置
    if (existing.userId !== userId) {
      existing.userId = userId;
      existing.turns = [];
      existing.liveInstances = {};
      existing.lastOrderNo = undefined;
      existing.lastRefundResult = undefined;
    }
    existing.updatedAt = Date.now();
    return existing;
  }

  const created: ServerSession = {
    sessionId,
    userId,
    liveInstances: {},
    turns: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  SESSIONS.set(sessionId, created);
  return created;
}

export function appendTurn(session: ServerSession, turn: SessionTurn): void {
  session.turns.push(turn);
  // 会话历史只保留最近若干轮，避免无限增长（生产由 context 管理策略接管）
  if (session.turns.length > 24) {
    session.turns = session.turns.slice(-24);
  }
  session.updatedAt = Date.now();
}

/** 登记本轮展示过的组件实例，action 回填时据此校验归属与 action 白名单 */
export function registerInstance(
  session: ServerSession,
  instanceId: string,
  component: ComponentName,
  actionWhitelist: string[],
): void {
  session.liveInstances[instanceId] = { component, actionWhitelist };
  const ids = Object.keys(session.liveInstances);
  if (ids.length > 40) {
    for (const id of ids.slice(0, ids.length - 40)) delete session.liveInstances[id];
  }
}

/** 回填时取出组件实例；取不到说明是过期或伪造的 instanceId */
export function findInstance(session: ServerSession, instanceId: string) {
  return session.liveInstances[instanceId];
}

export function __resetSessions(): void {
  SESSIONS.clear();
}
