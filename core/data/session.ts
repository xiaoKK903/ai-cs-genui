/**
 * 服务端会话状态 —— 会话状态的单一真相源（协议文档 R3 对策）
 *
 * 前端只持有副本：所有状态变更都发生在服务端，通过 SSE 的 `state` 事件同步给前端。
 * 这样才能保证「用户点了订单准备退款」这件事在下一轮对话里不会丢。
 *
 * ## 为什么要从进程内 Map 换成 SQLite
 *
 * 第四阶段的硬伤清单里写着：「会话状态持久化 —— 进程内存态会随重启/扩缩容丢失；
 * 会话上下文需外置存储（如 Redis）」。内存 Map 在单实例演示里看不出问题，
 * 但只要进程重启，用户上一句说的「给这个订单退款」里的「这个」就指不到任何东西了 ——
 * 多轮上下文直接断掉，而且**只在重启后复现**，是最难查的那类 bug。
 *
 * 生产部署多实例时，这里应该换成 Redis：把 sessions 表换成 KV + TTL 即可，
 * 本文件导出的函数签名不用动 —— 上层只依赖这些函数，不依赖存储。
 *
 * ## 一条纪律
 *
 * 状态变更一律走本文件的函数（setLastOrderNo / appendTurn / registerInstance），
 * 不要直接给 session 对象赋值。直接赋值必须记得手动 save，漏一次就是上面那个 bug；
 * 函数内部负责落库，调用方不可能忘。
 */

import { getDb } from "./db";
import type { RefundResult } from "./domain";
import type { ComponentName, SessionState, SessionTurn } from "../protocol/types";

export interface ServerSession extends SessionState {
  /** 最近一次退款提交的真实结果，ResultCard 从这里取数，模型不参与 */
  lastRefundResult?: RefundResult;
  createdAt: number;
  updatedAt: number;
}

interface SessionRow {
  session_id: string;
  user_id: string;
  last_order_no: string | null;
  last_refund_result: string | null;
  live_instances: string;
  turns: string;
  created_at: number;
  updated_at: number;
}

/** 会话历史只保留最近若干轮，避免无限增长（生产由 context 管理策略接管） */
const MAX_TURNS = 24;
const MAX_LIVE_INSTANCES = 40;

function parse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    // 库里存了坏 JSON（手工改过、或历史版本写坏了）时降级为空，
    // 不能让它把整轮对话打挂 —— 会话状态坏了是可以重建的，对话不能停。
    return fallback;
  }
}

function hydrate(row: SessionRow): ServerSession {
  const session: ServerSession = {
    sessionId: row.session_id,
    userId: row.user_id,
    lastOrderNo: row.last_order_no ?? undefined,
    liveInstances: parse(row.live_instances, {}),
    turns: parse(row.turns, [] as SessionTurn[]),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
  if (row.last_refund_result) {
    session.lastRefundResult = parse<RefundResult | undefined>(row.last_refund_result, undefined);
  }
  return session;
}

export function saveSession(session: ServerSession): void {
  session.updatedAt = Date.now();
  getDb()
    .prepare(
      `INSERT INTO sessions
         (session_id, user_id, last_order_no, last_refund_result, live_instances, turns, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         user_id            = excluded.user_id,
         last_order_no      = excluded.last_order_no,
         last_refund_result = excluded.last_refund_result,
         live_instances     = excluded.live_instances,
         turns              = excluded.turns,
         updated_at         = excluded.updated_at`,
    )
    .run(
      session.sessionId,
      session.userId,
      session.lastOrderNo ?? null,
      session.lastRefundResult ? JSON.stringify(session.lastRefundResult) : null,
      JSON.stringify(session.liveInstances),
      JSON.stringify(session.turns),
      session.createdAt,
      session.updatedAt,
    );
}

/**
 * 取得（或创建）会话。
 *
 * `userId` 由服务端鉴权中间件解析登录态得到，**永远不从请求体里读** ——
 * 这是「越权查订单」的兜底位置：模型传什么 userId 都不影响这里。
 */
export function getOrCreateSession(sessionId: string, userId: string): ServerSession {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM sessions WHERE session_id = ?`).get(sessionId) as
    | SessionRow
    | undefined;

  if (row) {
    const session = hydrate(row);
    // 登录态以本次请求为准；若与既有会话不一致，说明会话被复用，直接重置
    if (session.userId !== userId) {
      session.userId = userId;
      session.turns = [];
      session.liveInstances = {};
      session.lastOrderNo = undefined;
      session.lastRefundResult = undefined;
    }
    session.updatedAt = Date.now();
    saveSession(session);
    return session;
  }

  const created: ServerSession = {
    sessionId,
    userId,
    liveInstances: {},
    turns: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  saveSession(created);
  return created;
}

/* ---------- 状态变更（每个函数负责落库） ---------- */

/**
 * 记下最近展示过的订单号。
 *
 * 这不是「缓存」——它是指代消解的锚点。用户说「给这个订单退款」时，
 * 「这个」在服务端唯一能对应上的东西就是它。
 */
export function setLastOrderNo(session: ServerSession, orderNo: string | undefined): void {
  session.lastOrderNo = orderNo;
  saveSession(session);
}

export function setLastRefundResult(session: ServerSession, result: RefundResult | undefined): void {
  session.lastRefundResult = result;
  saveSession(session);
}

export function appendTurn(session: ServerSession, turn: SessionTurn): void {
  session.turns.push(turn);
  if (session.turns.length > MAX_TURNS) {
    session.turns = session.turns.slice(-MAX_TURNS);
  }
  saveSession(session);
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
  if (ids.length > MAX_LIVE_INSTANCES) {
    for (const id of ids.slice(0, ids.length - MAX_LIVE_INSTANCES)) delete session.liveInstances[id];
  }
  saveSession(session);
}

/** 回填时取出组件实例；取不到说明是过期或伪造的 instanceId */
export function findInstance(session: ServerSession, instanceId: string) {
  return session.liveInstances[instanceId];
}

export function __resetSessions(): void {
  getDb().exec("DELETE FROM sessions");
}
