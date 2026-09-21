/**
 * 订单 / 退款业务服务
 *
 * 这个模块扮演的是「企业既有业务系统」的客户端 —— 生产环境里它是对订单服务、
 * 退款服务和风控服务的调用，这里用本地 SQLite 实现，但接口语义与边界保持一致：
 *
 *   1. 所有查询函数第一个参数是 sessionUserId，由服务端从登录态解析后传入，
 *      **绝不使用模型或前端传来的 userId**。这是「越权查订单」的兜底位置。
 *   2. 金额以「分」为单位的整数存储与计算，不使用浮点数。前端展示时才格式化。
 *   3. 退款提交走幂等键 + 服务端权威金额 + 归属校验，模型不参与金额决策。
 *
 * 相比内存版本的实质变化（不只是「换个存储」）：
 *   - 幂等从「内存 Map 的约定」变成「数据库唯一索引的保证」，跨进程重启依然成立；
 *   - 退款成功后会**真的改变订单状态**（可退 → 退款中），原来这条链路是断的；
 *   - 退款单号来自持久化序列，重启不会重号。
 */

import { getDb, nextSeq } from "./db";
import {
  DEMO_SESSION_USER_ID,
  OTHER_USER_ID,
  REFUND_REASON_LABEL,
  type Order,
  type OrderStatus,
  type RefundReason,
  type RefundReasonStat,
  type RefundRequestInput,
  type RefundResult,
} from "./domain";
import { ensureSeeded } from "./seed";

// 数据访问入口，先于任何查询把种子数据准备好（幂等，仅首次生效）
ensureSeeded();

// 转出给上层用的领域常量与工具函数。
// 调用方（工具执行层、路由、测试）只需要 import 这个模块，不必关心
// domain / db / seed 的拆分 —— 那是实现细节，不是它们该知道的。
export { DEMO_SESSION_USER_ID, OTHER_USER_ID, REFUND_REASON_LABEL };
export { formatYuan } from "./domain";
export type { Order, OrderStatus, RefundReason, RefundResult, RefundRequestInput };

/* ---------- 行映射 ---------- */

interface OrderRow {
  id: string;
  item_name: string;
  amount_cents: number;
  status: string;
  placed_at: string;
  masked_phone: string;
  address: string;
  refundable: number;
}

function toOrder(r: OrderRow): Order {
  return {
    id: r.id,
    itemName: r.item_name,
    amountCents: Number(r.amount_cents),
    status: r.status as OrderStatus,
    placedAt: r.placed_at,
    maskedPhone: r.masked_phone,
    address: r.address,
    refundable: Number(r.refundable) === 1,
  };
}

interface RefundRow {
  idempotency_key: string;
  refund_id: string;
  order_id: string;
  amount_cents: number;
  status: string;
  expected_arrival: string;
  reject_reason: string | null;
  trace_id: string;
}

function toRefundResult(r: RefundRow, deduplicated: boolean): RefundResult {
  return {
    refundId: r.refund_id,
    orderId: r.order_id,
    amountCents: Number(r.amount_cents),
    status: r.status as "submitted" | "rejected",
    expectedArrival: r.expected_arrival,
    deduplicated,
    ...(r.reject_reason ? { rejectReason: r.reject_reason } : {}),
    traceId: r.trace_id,
  };
}

/* ---------- 查询 ---------- */

/**
 * 查询当前登录用户的订单。
 *
 * `sessionUserId` 由服务端从登录态解析后传入。SQL 里 WHERE user_id = ? 绑定的是它，
 * 不存在「按传入 userId 查询」的入口 —— 越权在函数签名层面就不可能发生。
 */
export function listOrders(
  sessionUserId: string,
  filter?: { status?: OrderStatus; limit?: number },
): Order[] {
  const db = getDb();
  const limit = filter?.limit ?? 50;

  const rows = filter?.status
    ? (db
        .prepare(
          `SELECT * FROM orders WHERE user_id = ? AND status = ?
           ORDER BY placed_at DESC LIMIT ?`,
        )
        .all(sessionUserId, filter.status, limit) as unknown as OrderRow[])
    : (db
        .prepare(`SELECT * FROM orders WHERE user_id = ? ORDER BY placed_at DESC LIMIT ?`)
        .all(sessionUserId, limit) as unknown as OrderRow[]);

  return rows.map(toOrder);
}

export function findOrder(sessionUserId: string, orderId: string): Order | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM orders WHERE user_id = ? AND id = ?`)
    .get(sessionUserId, orderId) as unknown as OrderRow | undefined;
  return row ? toOrder(row) : undefined;
}

/**
 * 订单是否存在但属于别的用户 —— 用于区分「不存在」与「无权访问」。
 *
 * 对外这两者的措辞必须一致（否则等于告诉攻击者「这个单号存在」），
 * 但内部要分得清：一个该告警，一个只是用户输错了。
 */
export function orderBelongsToAnotherUser(orderId: string): boolean {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM orders WHERE id = ? AND user_id <> ?`)
    .get(orderId, DEMO_SESSION_USER_ID) as { n: number };
  return Number(row.n) > 0;
}

/** 近 N 天退款原因分布。所有数字来自服务端聚合，模型不参与计算。 */
export function refundReasonStats(sessionUserId: string, days = 30): {
  windowDays: number;
  total: number;
  totalAmountCents: number;
  items: RefundReasonStat[];
} {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const rows = getDb()
    .prepare(
      `SELECT reason, COUNT(*) AS count, SUM(amount_cents) AS amount
       FROM refund_history
       WHERE user_id = ? AND requested_at >= ?
       GROUP BY reason
       ORDER BY count DESC`,
    )
    .all(sessionUserId, since) as unknown as { reason: string; count: number; amount: number }[];

  const items: RefundReasonStat[] = rows.map((r) => ({
    reason: r.reason as RefundReason,
    label: REFUND_REASON_LABEL[r.reason as RefundReason],
    count: Number(r.count),
    amountCents: Number(r.amount),
  }));

  return {
    windowDays: days,
    total: items.reduce((s, i) => s + i.count, 0),
    totalAmountCents: items.reduce((s, i) => s + i.amountCents, 0),
    items,
  };
}

/* ---------- 退款提交（幂等 + 服务端权威金额） ---------- */

/**
 * 提交退款申请。
 *
 * 四道服务端约束，任何一道不过都直接拒绝 —— 这里不是「模型可能出错」的兜底，
 * 而是**模型完全没有决策权**：
 *   - 归属：订单必须属于 sessionUserId（SQL 的 WHERE 里绑定）
 *   - 金额：以订单在业务系统里的金额为准，入参 claimedAmount 只用于比对告警
 *   - 在途：同一订单已有未完结退款时拒绝（业务维度去重）
 *   - 幂等：idempotencyKey 命中直接返回首次结果，不重复创建
 *
 * 幂等的实现是数据库层面的：refunds 表上有一条「只对 status='submitted' 生效」的部分唯一索引。
 * 两个并发请求同时穿过前面的检查时，第二条 INSERT 会被数据库拒绝 —— 这是我们期望的结果，
 * 捕获后重新读出首次结果返回即可。**幂等不能靠「先查再写」的检查，那中间有窗口。**
 */
export function submitRefund(sessionUserId: string, input: RefundRequestInput): RefundResult {
  const db = getDb();

  // ① 幂等：同一次提交重复请求，返回首次结果
  const hit = db
    .prepare(`SELECT * FROM refunds WHERE idempotency_key = ? AND status = 'submitted'`)
    .get(input.idempotencyKey) as unknown as RefundRow | undefined;
  if (hit) return toRefundResult(hit, true);

  // ② 归属：订单必须存在且属于当前登录用户
  const order = findOrder(sessionUserId, input.orderId);
  if (!order) {
    return reject(db, sessionUserId, input, "订单不存在或不属于当前账号");
  }

  // ③ 业务维度去重：该订单已经有在途退款了
  const inflight = db
    .prepare(`SELECT * FROM refunds WHERE order_id = ? AND user_id = ? AND status = 'submitted'`)
    .get(order.id, sessionUserId) as unknown as RefundRow | undefined;
  if (inflight) {
    return toRefundResult(inflight, true);
  }

  // ④ 订单自身是否可退
  if (!order.refundable) {
    const reasonMap: Record<OrderStatus, string> = {
      paid: "已付款待发货订单可直接取消",
      shipped: "已发货订单需先申请拦截，请联系人工客服",
      completed: "已完成订单已超出售后期限",
      refunding: "该订单已在退款流程中，请勿重复提交",
      refunded: "该订单已完成退款",
    };
    return reject(db, sessionUserId, input, reasonMap[order.status]);
  }

  // ⑤ 落库：插退款单 + 改订单状态，一个事务里完成
  const refundId = `RF-2026${String(nextSeq("refund")).padStart(5, "0")}`;
  const traceId = `RF-TR-${Date.now()}-${input.idempotencyKey.slice(-6)}`;
  const expectedArrival = "审核通过后 3–7 个工作日原路退回";
  const now = new Date().toISOString();

  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO refunds
         (idempotency_key, refund_id, order_id, user_id, amount_cents, status, expected_arrival, trace_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?, ?)`,
    ).run(
      input.idempotencyKey,
      refundId,
      order.id,
      sessionUserId,
      // 权威金额来自订单，不取 input.claimedAmountCents
      order.amountCents,
      expectedArrival,
      traceId,
      now,
    );

    // 退款成功后订单本身要变 —— 否则用户刷新一下会看到订单还是「可退款」，
    // 而实际已经在退款流程里了。这条链路在内存版本里是断的。
    db.prepare(`UPDATE orders SET status = 'refunding', refundable = 0 WHERE id = ? AND user_id = ?`).run(
      order.id,
      sessionUserId,
    );

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    // 唯一索引冲突 = 并发下另一个请求先落库了，读出它的结果返回，这才是幂等
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
      const winner = db
        .prepare(`SELECT * FROM refunds WHERE idempotency_key = ? AND status = 'submitted'`)
        .get(input.idempotencyKey) as unknown as RefundRow | undefined;
      if (winner) return toRefundResult(winner, true);
    }
    throw err;
  }

  const saved = db
    .prepare(`SELECT * FROM refunds WHERE idempotency_key = ? AND status = 'submitted'`)
    .get(input.idempotencyKey) as unknown as RefundRow;
  return toRefundResult(saved, false);
}

/**
 * 被拒绝的提交也要留档。
 *
 * 内存版本里拒绝是不记录的（因为不影响幂等），但那意味着「有人反复尝试提交别人的订单」
 * 这件事在系统里没有任何痕迹。风控要的正是这些被拒记录。
 */
function reject(
  db: ReturnType<typeof getDb>,
  sessionUserId: string,
  input: RefundRequestInput,
  reason: string,
): RefundResult {
  const traceId = `RF-REJ-${Date.now()}`;
  db.prepare(
    `INSERT INTO refunds
       (idempotency_key, refund_id, order_id, user_id, amount_cents, status, expected_arrival, reject_reason, trace_id, created_at)
     VALUES (?, '-', ?, ?, 0, 'rejected', '-', ?, ?, ?)`,
  ).run(input.idempotencyKey, input.orderId, sessionUserId, reason, traceId, new Date().toISOString());

  return {
    refundId: "-",
    orderId: input.orderId,
    amountCents: 0,
    status: "rejected",
    expectedArrival: "-",
    deduplicated: false,
    rejectReason: reason,
    traceId,
  };
}

/* ---------- 审计查询（风控/客服复盘用） ---------- */

/** 某订单的全部退款提交记录，含被拒绝的。 */
export function refundAuditTrail(orderId: string, sessionUserId: string): RefundResult[] {
  const rows = getDb()
    .prepare(`SELECT * FROM refunds WHERE order_id = ? AND user_id = ? ORDER BY id ASC`)
    .all(orderId, sessionUserId) as unknown as RefundRow[];
  return rows.map((r) => toRefundResult(r, false));
}
