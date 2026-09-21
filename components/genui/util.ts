/**
 * 组件层公共工具
 */

export interface ActionPayload {
  action: string;
  params: Record<string, unknown>;
}

/**
 * 所有 GenUI 组件统一的入参形状。
 *
 * 组件只认两件事：契约 props（服务端给的）+ onAction（往哪报）。
 * 它不知道 SSE、不知道信封、不知道模型 —— 这样组件才能被单独渲染和测试。
 */
export interface GenUIComponentProps<P> {
  props: P;
  onAction: (payload: ActionPayload) => void;
  /** 上一轮还没结束时禁用交互，防止连点产生两笔退款 */
  disabled?: boolean;
}

/**
 * 解析 action 参数里的 `$row.<key>` 引用。
 *
 * 协议里 rowActions 是**组件级**的（一份按钮定义作用于所有行），
 * 但每行要带的参数不同（订单号）。用 `$row.id` 这种引用而不是让服务端
 * 展开成 N 份按钮定义 —— 后者会让 props 体积随行数线性增长。
 */
export function resolveParams(
  params: Record<string, unknown> | undefined,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (typeof v === "string" && v.startsWith("$row.")) {
      out[k] = row[v.slice("$row.".length)];
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 行级 action 可见性。
 *
 * 唯一一条约定：行数据里 `refundable === false` 时不给「申请退款」按钮。
 * 这是**业务系统在行数据里表达自己的规则**，不是协议层的规则 —— 协议只规定了
 * 「按钮必须命中 action 白名单」，至于是不是每一行都该显示，那是业务的事。
 *
 * 注意它只是体验优化：真正拦住一笔不该退的款，靠的是服务端 submitRefund 里的
 * refundable 校验和归属校验。前端藏按钮从来不构成防线。
 */
export function isActionVisible(action: string, row: Record<string, unknown>): boolean {
  if (action === "openRefundForm" && row.refundable === false) return false;
  return true;
}

/** ISO 时间 → 「09-03 08:47」。只到分钟：客服场景里秒没有意义。 */
export function formatDateTime(iso: unknown): string {
  if (typeof iso !== "string") return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 业务状态 → 视觉色调。词表跟着业务走，不跟着组件走。 */
export function statusTone(label: unknown): string {
  const s = String(label ?? "");
  if (/(已退款|退款失败|已取消)/.test(s)) return "danger";
  if (/(退款中|待付款|异常)/.test(s)) return "warning";
  if (/(已完成|已发货|已受理|成功)/.test(s)) return "ok";
  if (/(待发货|处理中)/.test(s)) return "info";
  return "neutral";
}
