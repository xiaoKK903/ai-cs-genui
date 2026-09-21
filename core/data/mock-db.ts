/**
 * 模拟业务系统（订单 / 退款）。
 *
 * 这个文件扮演的是「企业既有业务系统」的角色 —— 生产环境里它是订单服务、
 * 退款服务和风控服务的客户端，这里用内存数据替代，但接口语义与边界保持一致：
 *
 *   1. 所有查询函数第一个参数是 sessionUserId，由服务端从登录态解析后传入，
 *      **绝不使用模型或前端传来的 userId**。这是「越权查订单」的兜底位置。
 *   2. 金额以「分」为单位的整数存储与计算，不使用浮点数。前端展示时才格式化。
 *   3. 退款提交走幂等键 + 服务端权威金额 + 归属校验，模型不参与金额决策。
 */

/* ---------- 类型 ---------- */

// 取值与协议文档 2.2 中 show_order_table 的 statusFilter 枚举保持一致
export type OrderStatus =
  | "paid"      // 已付款，待发货
  | "shipped"   // 已发货
  | "completed" // 已完成
  | "refunding" // 退款中
  | "refunded"; // 已退款

export interface Order {
  id: string;
  itemName: string;
  /** 金额单位：分 */
  amountCents: number;
  status: OrderStatus;
  placedAt: string;
  /** 脱敏手机号，原文在任何情况下都不出服务端 */
  maskedPhone: string;
  address: string;
  refundable: boolean;
}

export type RefundReason =
  | "seven_day_no_reason" // 七天无理由
  | "quality_issue"       // 质量问题
  | "wrong_item"          // 发错货
  | "late_delivery"       // 物流超时
  | "duplicate_buy"       // 重复下单
  | "other";

export interface RefundRecord {
  orderId: string;
  reason: RefundReason;
  amountCents: number;
  requestedAt: string;
}

export interface RefundRequestInput {
  orderId: string;
  reason: RefundReason;
  /** 用户填写的金额（分）—— 仅作为「用户意图」参考，服务端不采信 */
  claimedAmountCents: number;
  note?: string;
  idempotencyKey: string;
}

export interface RefundResult {
  refundId: string;
  orderId: string;
  /** 服务端权威金额 */
  amountCents: number;
  status: "submitted" | "rejected";
  expectedArrival: string;
  /** 幂等命中：同一次提交重复请求，返回首次结果 */
  deduplicated: boolean;
  rejectReason?: string;
  traceId: string;
}

/* ---------- 数据 ---------- */

/**
 * 相对当前时间生成时间戳。
 *
 * 演示数据不写死日期 —— 否则仓库放几个月后 clone 下来，订单会被
 * last7d / last30d 的时间窗全部过滤掉，演示直接空掉。
 */
function at(daysAgo: number, hour: number, minute: number): string {
  const d = new Date(Date.now() - daysAgo * 86400000);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

/** 登录态用户。生产环境由鉴权中间件注入，这里固定一个演示账号。 */
export const DEMO_SESSION_USER_ID = "U-880417";

/** 另一个用户 —— 用于演示「越权查别人的订单会被拒绝」。 */
export const OTHER_USER_ID = "U-119002";

const ORDERS: Record<string, Order[]> = {
  [DEMO_SESSION_USER_ID]: [
    {
      id: "SO-20260815-4471",
      itemName: "云感记忆棉枕头 · 标准款",
      amountCents: 25900,
      status: "completed",
      placedAt: at(23, 10, 24),
      maskedPhone: "138****6621",
      address: "杭州市余杭区文一西路 969 号",
      refundable: true,
    },
    {
      id: "SO-20260828-9032",
      itemName: "轻量羽绒服 · 藏青 / L",
      amountCents: 89900,
      status: "shipped",
      placedAt: at(14, 19, 2),
      maskedPhone: "138****6621",
      address: "杭州市余杭区文一西路 969 号",
      refundable: false,
    },
    {
      id: "SO-20260903-1188",
      itemName: "桌面空气净化器 · 除甲醛滤芯套装",
      amountCents: 45900,
      status: "refunding",
      placedAt: at(5, 8, 47),
      maskedPhone: "138****6621",
      address: "杭州市余杭区文一西路 969 号",
      refundable: false,
    },
    {
      id: "SO-20260910-6620",
      itemName: "不锈钢保温杯 500ml",
      amountCents: 12900,
      status: "paid",
      placedAt: at(2, 21, 15),
      maskedPhone: "138****6621",
      address: "杭州市余杭区文一西路 969 号",
      refundable: true,
    },
  ],
  [OTHER_USER_ID]: [
    {
      id: "SO-20260901-2201",
      itemName: "（他人订单，演示越权拦截用）",
      amountCents: 9900,
      status: "completed",
      placedAt: at(18, 12, 0),
      maskedPhone: "159****3320",
      address: "成都市武侯区天府大道 1 号",
      refundable: true,
    },
  ],
};

/** 近 30 天退款原因分布（按当前会话用户聚合）。 */
const REFUND_HISTORY: RefundRecord[] = [
  { orderId: "SO-20260712-3390", reason: "quality_issue", amountCents: 15900, requestedAt: at(40, 9, 10) },
  { orderId: "SO-20260719-7712", reason: "seven_day_no_reason", amountCents: 25900, requestedAt: at(36, 15, 32) },
  { orderId: "SO-20260726-1043", reason: "late_delivery", amountCents: 8900, requestedAt: at(33, 11, 5) },
  { orderId: "SO-20260802-5588", reason: "quality_issue", amountCents: 32900, requestedAt: at(28, 20, 41) },
  { orderId: "SO-20260811-9021", reason: "wrong_item", amountCents: 45900, requestedAt: at(22, 10, 18) },
  { orderId: "SO-20260818-2210", reason: "seven_day_no_reason", amountCents: 12900, requestedAt: at(18, 16, 55) },
  { orderId: "SO-20260825-4477", reason: "duplicate_buy", amountCents: 69900, requestedAt: at(12, 22, 3) },
  { orderId: "SO-20260901-8834", reason: "quality_issue", amountCents: 25900, requestedAt: at(6, 8, 26) },
  { orderId: "SO-20260906-3312", reason: "late_delivery", amountCents: 15900, requestedAt: at(3, 19, 44) },
];

export const REFUND_REASON_LABEL: Record<RefundReason, string> = {
  seven_day_no_reason: "七天无理由",
  quality_issue: "质量问题",
  wrong_item: "发错货",
  late_delivery: "物流超时",
  duplicate_buy: "重复下单",
  other: "其他",
};

/**
 * 中文标签 → 枚举值。
 *
 * 表单里给用户看的是中文（组件契约里 options 就是这几个字符串），回填时收到的也是中文。
 * 这一层反查放在服务端而不是前端：前端直接传枚举 key 的话，标签就成了「前端自己编的」，
 * 服务端无法确认用户看到的选项和提交的值是同一个东西。
 */
export const REFUND_REASON_BY_LABEL: Record<string, RefundReason> = Object.fromEntries(
  Object.entries(REFUND_REASON_LABEL).map(([k, v]) => [v, k as RefundReason]),
);

/* ---------- 业务 API ---------- */

/**
 * 查询当前登录用户的订单。
 *
 * `sessionUserId` 由服务端从登录态解析后传入。这里没有任何「按传入 userId 查询」
 * 的入口 —— 越权在函数签名层面就不可能发生。
 */
export function listOrders(
  sessionUserId: string,
  filter?: { status?: OrderStatus; limit?: number },
): Order[] {
  const all = ORDERS[sessionUserId] ?? [];
  const filtered = filter?.status ? all.filter((o) => o.status === filter.status) : all;
  const limited = filter?.limit ? filtered.slice(0, filter.limit) : filtered;
  // 返回副本，避免调用方直接改动「数据库」
  return limited.map((o) => ({ ...o }));
}

export function findOrder(sessionUserId: string, orderId: string): Order | undefined {
  const hit = (ORDERS[sessionUserId] ?? []).find((o) => o.id === orderId);
  return hit ? { ...hit } : undefined;
}

/** 订单是否存在但属于别的用户 —— 用于区分「不存在」与「无权访问」。 */
export function orderBelongsToAnotherUser(orderId: string): boolean {
  return Object.entries(ORDERS).some(([uid, list]) => uid !== DEMO_SESSION_USER_ID && list.some((o) => o.id === orderId));
}

export interface RefundReasonStat {
  reason: RefundReason;
  label: string;
  count: number;
  amountCents: number;
}

/** 近 N 天退款原因分布。所有数字来自服务端聚合，模型不参与计算。 */
export function refundReasonStats(sessionUserId: string, days = 30): {
  windowDays: number;
  total: number;
  totalAmountCents: number;
  items: RefundReasonStat[];
} {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const rows = REFUND_HISTORY.filter((r) => r.requestedAt >= since);

  const byReason = new Map<RefundReason, RefundReasonStat>();
  for (const r of rows) {
    const cur = byReason.get(r.reason) ?? {
      reason: r.reason,
      label: REFUND_REASON_LABEL[r.reason],
      count: 0,
      amountCents: 0,
    };
    cur.count += 1;
    cur.amountCents += r.amountCents;
    byReason.set(r.reason, cur);
  }

  const items = [...byReason.values()].sort((a, b) => b.count - a.count);
  return {
    windowDays: days,
    total: items.reduce((s, i) => s + i.count, 0),
    totalAmountCents: items.reduce((s, i) => s + i.amountCents, 0),
    items,
  };
}

/* ---------- 退款提交（幂等 + 服务端权威金额） ---------- */

const refundStore = new Map<string, RefundResult>();
let refundSeq = 0;

/**
 * 提交退款申请。
 *
 * 三道服务端约束，任何一道不过都直接拒绝 —— 这里不是「模型可能出错」的兜底，
 * 而是**模型完全没有决策权**：
 *   - 归属：订单必须属于 sessionUserId
 *   - 金额：以订单在业务系统里的金额为准，入参 claimedAmount 只用于比对告警
 *   - 幂等：idempotencyKey 命中直接返回首次结果，不重复创建
 */
export function submitRefund(sessionUserId: string, input: RefundRequestInput): RefundResult {
  const hit = refundStore.get(input.idempotencyKey);
  if (hit) return { ...hit, deduplicated: true };

  const order = findOrder(sessionUserId, input.orderId);
  if (!order) {
    return {
      refundId: "-",
      orderId: input.orderId,
      amountCents: 0,
      status: "rejected",
      expectedArrival: "-",
      deduplicated: false,
      rejectReason: "订单不存在或不属于当前账号",
      traceId: `RF-REJ-${Date.now()}`,
    };
  }

  if (!order.refundable) {
    const reasonMap: Record<OrderStatus, string> = {
      paid: "已付款待发货订单可直接取消",
      shipped: "已发货订单需先申请拦截，请联系人工客服",
      completed: "已完成订单已超出售后期限",
      refunding: "该订单已在退款流程中，请勿重复提交",
      refunded: "该订单已完成退款",
    };
    return {
      refundId: "-",
      orderId: order.id,
      amountCents: 0,
      status: "rejected",
      expectedArrival: "-",
      deduplicated: false,
      rejectReason: reasonMap[order.status],
      traceId: `RF-REJ-${Date.now()}`,
    };
  }

  refundSeq += 1;
  const result: RefundResult = {
    refundId: `RF-2026${String(refundSeq).padStart(5, "0")}`,
    orderId: order.id,
    // 权威金额来自订单，不取 input.claimedAmountCents
    amountCents: order.amountCents,
    status: "submitted",
    expectedArrival: "审核通过后 3–7 个工作日原路退回",
    deduplicated: false,
    traceId: `RF-TR-${Date.now()}-${refundSeq}`,
  };
  refundStore.set(input.idempotencyKey, result);
  return result;
}

/** 仅测试与演示用：清空退款单据与幂等记录。 */
export function __resetRefundStore(): void {
  refundStore.clear();
  refundSeq = 0;
}

/* ---------- 展示helper ---------- */

export function formatYuan(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}
