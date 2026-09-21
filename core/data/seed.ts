/**
 * 种子数据 —— 扮演「企业既有业务系统里本来就有的那些数据」
 *
 * 只在库为空时写入一次。库文件（data/app.db）不进仓库，所以任何人 clone 下来
 * 首次启动都会重新生成一份，时间戳永远是相对「现在」的。
 *
 * 这一点是刻意的：如果种子写死日期，仓库放几个月后 clone 下来，
 * 订单会被 last7d / last30d 的时间窗全部过滤掉，演示直接空掉 ——
 * 「打开就能用」是演示项目的底线。
 *
 * 要重置数据：删掉 data/app.db 再启动即可。
 */

import { getDb } from "./db";
import { DEMO_SESSION_USER_ID, OTHER_USER_ID, type OrderStatus, type RefundReason } from "./domain";

/**
 * 相对当前时间生成时间戳。
 * 小时/分钟也固定下来，让每次生成的演示数据长得一样（便于截图和对比）。
 */
function at(daysAgo: number, hour: number, minute: number): string {
  const d = new Date(Date.now() - daysAgo * 86400000);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

interface SeedOrder {
  id: string;
  userId: string;
  itemName: string;
  amountCents: number;
  status: OrderStatus;
  daysAgo: number;
  hour: number;
  minute: number;
  maskedPhone: string;
  address: string;
  refundable: boolean;
}

const SEED_ORDERS: SeedOrder[] = [
  {
    id: "SO-20260815-4471",
    userId: DEMO_SESSION_USER_ID,
    itemName: "云感记忆棉枕头 · 标准款",
    amountCents: 25900,
    status: "completed",
    daysAgo: 23,
    hour: 10,
    minute: 24,
    maskedPhone: "138****6621",
    address: "杭州市余杭区文一西路 969 号",
    refundable: true,
  },
  {
    id: "SO-20260828-9032",
    userId: DEMO_SESSION_USER_ID,
    itemName: "轻量羽绒服 · 藏青 / L",
    amountCents: 89900,
    status: "shipped",
    daysAgo: 14,
    hour: 19,
    minute: 2,
    maskedPhone: "138****6621",
    address: "杭州市余杭区文一西路 969 号",
    refundable: false,
  },
  {
    id: "SO-20260903-1188",
    userId: DEMO_SESSION_USER_ID,
    itemName: "桌面空气净化器 · 除甲醛滤芯套装",
    amountCents: 45900,
    status: "refunding",
    daysAgo: 5,
    hour: 8,
    minute: 47,
    maskedPhone: "138****6621",
    address: "杭州市余杭区文一西路 969 号",
    refundable: false,
  },
  {
    id: "SO-20260910-6620",
    userId: DEMO_SESSION_USER_ID,
    itemName: "不锈钢保温杯 500ml",
    amountCents: 12900,
    status: "paid",
    daysAgo: 2,
    hour: 21,
    minute: 15,
    maskedPhone: "138****6621",
    address: "杭州市余杭区文一西路 969 号",
    refundable: true,
  },
  {
    id: "SO-20260901-2201",
    userId: OTHER_USER_ID,
    itemName: "（他人订单，演示越权拦截用）",
    amountCents: 9900,
    status: "completed",
    daysAgo: 18,
    hour: 12,
    minute: 0,
    maskedPhone: "159****3320",
    address: "成都市武侯区天府大道 1 号",
    refundable: true,
  },
];

/** 历史退款记录（按用户聚合，用于「退款原因分布」）。 */
const SEED_REFUND_HISTORY: {
  orderId: string;
  reason: RefundReason;
  amountCents: number;
  daysAgo: number;
  hour: number;
  minute: number;
}[] = [
  { orderId: "SO-20260712-3390", reason: "quality_issue", amountCents: 15900, daysAgo: 40, hour: 9, minute: 10 },
  { orderId: "SO-20260719-7712", reason: "seven_day_no_reason", amountCents: 25900, daysAgo: 36, hour: 15, minute: 32 },
  { orderId: "SO-20260726-1043", reason: "late_delivery", amountCents: 8900, daysAgo: 33, hour: 11, minute: 5 },
  { orderId: "SO-20260802-5588", reason: "quality_issue", amountCents: 32900, daysAgo: 28, hour: 20, minute: 41 },
  { orderId: "SO-20260811-9021", reason: "wrong_item", amountCents: 45900, daysAgo: 22, hour: 10, minute: 18 },
  { orderId: "SO-20260818-2210", reason: "seven_day_no_reason", amountCents: 12900, daysAgo: 18, hour: 16, minute: 55 },
  { orderId: "SO-20260825-4477", reason: "duplicate_buy", amountCents: 69900, daysAgo: 12, hour: 22, minute: 3 },
  { orderId: "SO-20260901-8834", reason: "quality_issue", amountCents: 25900, daysAgo: 6, hour: 8, minute: 26 },
  { orderId: "SO-20260906-3312", reason: "late_delivery", amountCents: 15900, daysAgo: 3, hour: 19, minute: 44 },
];

let seeded = false;

/** 幂等：库里有订单就什么都不做。可安全地在模块加载时反复调用。 */
export function ensureSeeded(): void {
  if (seeded) return;
  const db = getDb();

  const row = db.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number };
  if (Number(row.n) > 0) {
    seeded = true;
    return;
  }

  // 包在事务里：种子数据要么全在要么全不在，避免中途失败留下半份数据
  db.exec("BEGIN");
  try {
    const insertOrder = db.prepare(
      `INSERT INTO orders (id, user_id, item_name, amount_cents, status, placed_at, masked_phone, address, refundable)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const o of SEED_ORDERS) {
      insertOrder.run(
        o.id,
        o.userId,
        o.itemName,
        o.amountCents,
        o.status,
        at(o.daysAgo, o.hour, o.minute),
        o.maskedPhone,
        o.address,
        o.refundable ? 1 : 0,
      );
    }

    const insertHistory = db.prepare(
      `INSERT INTO refund_history (user_id, order_id, reason, amount_cents, requested_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    // 历史退款统一挂在演示账号下 —— 统计接口按登录态用户聚合，这样图表才有数据
    for (const r of SEED_REFUND_HISTORY) {
      insertHistory.run(
        DEMO_SESSION_USER_ID,
        r.orderId,
        r.reason,
        r.amountCents,
        at(r.daysAgo, r.hour, r.minute),
      );
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  seeded = true;
}

/** 仅供测试：清空所有数据（含退款单据与会话），下次 ensureSeeded 会重新种。 */
export function __truncateAll(): void {
  const db = getDb();
  db.exec("BEGIN");
  try {
    for (const t of ["orders", "refund_history", "refunds", "sessions", "seq"]) {
      db.exec(`DELETE FROM ${t}`);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  seeded = false;
}
