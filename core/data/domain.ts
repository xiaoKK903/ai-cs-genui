/**
 * 领域模型与领域常量
 *
 * 从原来的 mock-db.ts 里抽出来，动机只有一个：`seed.ts` 要用这些类型，
 * 而 `order-service.ts` 要用 `seed.ts` —— 类型留在数据访问层会造成循环导入。
 *
 * 这个文件里没有任何行为，只有「业务系统长什么样」的定义。
 */

/* ---------- 身份 ---------- */

/**
 * 登录态用户。
 *
 * 注意这两个常量的用途：它们是**种子数据**里的身份，不是「可被传入的用户 ID」。
 * 所有查询函数的第一个参数是 sessionUserId，由服务端从 cookie 解析后传入，
 * 绝不使用模型或前端传来的值 —— 越权拦截在这个函数签名层面就不可能绕过。
 */
export const DEMO_SESSION_USER_ID = "U-880417";
/** 另一个用户 —— 用于演示「越权查别人的订单会被拒绝」。 */
export const OTHER_USER_ID = "U-119002";

/* ---------- 订单 ---------- */

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

/* ---------- 退款 ---------- */

export type RefundReason =
  | "seven_day_no_reason" // 七天无理由
  | "quality_issue"       // 质量问题
  | "wrong_item"          // 发错货
  | "late_delivery"       // 物流超时
  | "duplicate_buy"       // 重复下单
  | "other";

/** 历史退款记录（用于「退款原因分布」统计） */
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

export interface RefundReasonStat {
  reason: RefundReason;
  label: string;
  count: number;
  amountCents: number;
}

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

export function formatYuan(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}
