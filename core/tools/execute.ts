/**
 * Agent 工具层 —— 服务端工具执行
 *
 * 这一层是整条链路的关键收口：**模型只负责选中工具并给出查询意图，
 * 组件里的每一个数据值都由这里从业务系统取回。**
 *
 * 三条不可妥协的红线在这里落地（对应第四阶段文档）：
 *   1. 数据权限只认登录态 —— 所有业务调用传的都是 `session.userId`，
 *      模型传来的任何身份参数一律丢弃，连读都不读；
 *   2. 金额服务端权威 —— 退款表单里的金额从订单取，不采信模型填的数；
 *   3. 全链路审计 —— 每个 envelope 带 correlationId，meta.dataSource 写明数据出处。
 *
 * 返回值分三种，刻意区分「不给组件」和「拒绝执行」：
 *   - component：正常渲染
 *   - text     ：查得到但没内容（如近 7 天没有订单），渲染空表格不如直说
 *   - refused  ：越权 / 订单不存在 —— 需要审计，且措辞不能泄露他人订单是否存在
 */

import {
  findOrder,
  formatYuan,
  listOrders,
  orderBelongsToAnotherUser,
  REFUND_REASON_LABEL,
  refundReasonStats,
  type Order,
  type RefundReason,
} from "../data/order-service";
import { registerInstance, setLastOrderNo, type ServerSession } from "../data/session";
import { makeEnvelope, newInstanceId } from "../protocol/envelope";
import { ACTION_WHITELIST } from "../protocol/schema";
import type { GenUIEnvelope, RowAction } from "../protocol/types";

/* ============================================================
   入参类型 —— 与 core/tools/definitions.ts 的 input_schema 一一对应
   ============================================================ */

export type TimeRange = "last7d" | "last30d" | "last90d" | "all";

export interface ShowOrderTableInput {
  timeRange: TimeRange;
  statusFilter?: "all" | "paid" | "shipped" | "completed" | "refunding" | "refunded";
  limit?: number;
}

export interface ShowRefundFormInput {
  orderNo: string;
}

export interface ShowRefundReasonChartInput {
  timeRange: TimeRange;
  dimension?: "reason";
  measure?: "count" | "amount";
}

export interface ShowResultCardInput {
  orderNo: string;
}

/* ============================================================
   执行结果
   ============================================================ */

export type ToolOutcome =
  | { kind: "component"; envelope: GenUIEnvelope; summary: string }
  | { kind: "text"; text: string }
  | { kind: "refused"; text: string; reason: string };

export interface ToolContext {
  session: ServerSession;
  correlationId: string;
  /**
   * 由网关预先分配。
   *
   * instanceId 之所以不在这一层生成，是因为骨架屏必须在**取数之前**发出去 ——
   * 而 skeleton 事件要带 instanceId，前端才能用它把后到的组件精确替换掉。
   * 于是 ID 的分配权上移到「知道要调哪个工具、但还没执行」的那一层。
   */
  instanceId?: string;
}

/* ============================================================
   公共工具
   ============================================================ */

const RANGE_DAYS: Record<TimeRange, number | null> = {
  last7d: 7,
  last30d: 30,
  last90d: 90,
  all: null,
};

const RANGE_LABEL: Record<TimeRange, string> = {
  last7d: "近 7 天",
  last30d: "近 30 天",
  last90d: "近 90 天",
  all: "全部",
};

function withinRange(iso: string, range: TimeRange): boolean {
  const days = RANGE_DAYS[range];
  if (days === null) return true;
  return iso >= new Date(Date.now() - days * 86400000).toISOString();
}

const STATUS_LABEL: Record<Order["status"], string> = {
  paid: "待发货",
  shipped: "已发货",
  completed: "已完成",
  refunding: "退款中",
  refunded: "已退款",
};

/**
 * 登记组件实例并封装信封。
 *
 * 登记动作放在这里而不是网关：只有执行层知道该组件声明了哪些 action，
 * 而 action 回填时的归属校验正是拿这份登记来比对的。
 */
function emit(
  ctx: ToolContext,
  component: Parameters<typeof newInstanceId>[0],
  props: Record<string, unknown>,
  dataSource: string,
): GenUIEnvelope {
  const instanceId = ctx.instanceId ?? newInstanceId(component);
  registerInstance(ctx.session, instanceId, component, ACTION_WHITELIST[component]);
  return makeEnvelope({
    component,
    props,
    instanceId,
    correlationId: ctx.correlationId,
    dataSource,
  });
}

/* ============================================================
   ① show_order_table
   ============================================================ */

function execShowOrderTable(input: ShowOrderTableInput, ctx: ToolContext): ToolOutcome {
  const range = input.timeRange ?? "last30d";
  const status = input.statusFilter && input.statusFilter !== "all" ? input.statusFilter : undefined;

  // 注意第一个参数：登录态用户，取自服务端会话。模型传不了，也改不了。
  const all = listOrders(ctx.session.userId, { status });
  const rows = all.filter((o) => withinRange(o.placedAt, range));

  if (rows.length === 0) {
    const scope = status ? `${RANGE_LABEL[range]}「${STATUS_LABEL[status]}」的订单` : `${RANGE_LABEL[range]}的订单`;
    return { kind: "text", text: `我查了一下，你${scope}暂时没有记录。换个时间范围可以再看看。` };
  }

  const limit = Math.min(input.limit ?? 20, 50);
  const page = rows.slice(0, limit);

  const columns = [
    { key: "id", title: "订单号", type: "text" as const, sortable: false },
    { key: "itemName", title: "商品", type: "text" as const },
    { key: "amountText", title: "金额", type: "money" as const },
    { key: "statusLabel", title: "状态", type: "tag" as const },
    { key: "placedAt", title: "下单时间", type: "datetime" as const, sortable: true },
  ];

  // 行级可操作性由行数据里的 refundable 决定 —— 前端拿到 $row.refundable
  // 为 false 就不渲染这个按钮。协议层不掺业务规则，但允许业务系统在行数据里表达它。
  const rowActions: RowAction[] = [
    {
      label: "申请退款",
      action: "openRefundForm",
      params: { orderNo: "$row.id" },
    },
  ];

  const props = {
    columns,
    rows: page.map((o) => ({
      id: o.id,
      itemName: o.itemName,
      amountText: formatYuan(o.amountCents),
      statusLabel: STATUS_LABEL[o.status],
      placedAt: o.placedAt,
      refundable: o.refundable,
    })),
    rowActions,
    pagination: { page: 1, pageSize: limit, total: rows.length },
  };

  const envelope = emit(ctx, "OrderTable", props, "order-service.listOrders");

  // 只展示了一单时记下来，供「就退这个订单」这类指代消解
  if (page.length === 1) setLastOrderNo(ctx.session, page[0].id);

  return {
    kind: "component",
    envelope,
    summary: `帮你查到${RANGE_LABEL[range]}共 ${rows.length} 笔订单，下面是明细。`,
  };
}

/* ============================================================
   ② show_refund_form
   ============================================================ */

function execShowRefundForm(input: ShowRefundFormInput, ctx: ToolContext): ToolOutcome {
  const orderNo = (input.orderNo ?? "").trim();
  if (!orderNo) {
    return { kind: "text", text: "你指的是哪一笔订单？把订单号告诉我，或者先让我列出你的订单。" };
  }

  const order = findOrder(ctx.session.userId, orderNo);
  if (!order) {
    // 区分「不存在」与「属于别人」只在服务端日志里体现；对用户措辞保持一致，
    // 避免通过错误文案探测他人订单是否存在。
    const belongsToOther = orderBelongsToAnotherUser(orderNo);
    return {
      kind: "refused",
      reason: belongsToOther ? "跨用户访问被拦截" : "订单不存在",
      text: "这笔订单不在你的账号下，我没法为它发起退款。可以让我先列出你的订单看看。",
    };
  }

  if (!order.refundable) {
    return {
      kind: "text",
      text: `订单 ${order.id}（${order.itemName}）当前状态是「${STATUS_LABEL[order.status]}」，这笔单子走不了自助退款。需要的话我帮你转人工客服。`,
    };
  }

  const props = {
    orderNo: order.id,
    fields: [
      {
        name: "orderNo",
        label: "订单号",
        type: "text" as const,
        editable: false,
        value: order.id,
        source: "order-service.orders.id",
      },
      {
        name: "itemName",
        label: "退款商品",
        type: "text" as const,
        editable: false,
        value: order.itemName,
        source: "order-service.orders.itemName",
      },
      {
        name: "reason",
        label: "退款原因",
        type: "select" as const,
        // 受控枚举：前端只渲染这里给出的选项
        options: Object.values(REFUND_REASON_LABEL),
        required: true,
      },
      {
        name: "amount",
        label: "退款金额",
        type: "money" as const,
        // 金额权威来自业务系统 —— 用户和模型都改不了，闸2 会额外校验这一条
        editable: false,
        value: formatYuan(order.amountCents),
        source: "order-service.orders.amountCents",
      },
      {
        name: "note",
        label: "补充说明",
        type: "textarea" as const,
        required: false,
      },
    ],
    submitAction: "submitRefund",
    // 关键操作二次确认。表单提交前还要过一次服务端强校验，前端确认不替代服务端校验。
    confirmRequired: true,
  };

  const envelope = emit(ctx, "RefundForm", props, "order-service.findOrder");
  setLastOrderNo(ctx.session, order.id);

  return {
    kind: "component",
    envelope,
    summary: `订单 ${order.id}（${order.itemName}）可以申请退款，金额 ${formatYuan(order.amountCents)}。请确认下面的信息后提交。`,
  };
}

/* ============================================================
   ③ show_refund_reason_chart
   ============================================================ */

function execShowRefundReasonChart(input: ShowRefundReasonChartInput, ctx: ToolContext): ToolOutcome {
  const range = input.timeRange ?? "last30d";
  const days = RANGE_DAYS[range] ?? 30;
  const measure = input.measure ?? "count";

  // 统计口径：last90d / all 在演示数据里取不到更长窗口，按 90 天兜底
  const stats = refundReasonStats(ctx.session.userId, days ?? 90);

  if (stats.items.length === 0) {
    return { kind: "text", text: `${RANGE_LABEL[range]}你还没有退款记录，暂时没有可以统计的内容。` };
  }

  const props = {
    chartType: "bar" as const,
    data: stats.items.map((i) => ({
      label: i.label,
      // value 跟随所选度量：看笔数就是笔数，看金额就是元
      value: measure === "amount" ? i.amountCents / 100 : i.count,
      amountCents: i.amountCents,
    })),
    dimension: "reason",
    measure,
  };

  const envelope = emit(ctx, "RefundReasonChart", props, "refund-service.reasonStats");

  const desc =
    measure === "amount"
      ? `合计 ${formatYuan(stats.totalAmountCents)}`
      : `共 ${stats.total} 笔`;

  return {
    kind: "component",
    envelope,
    summary: `${RANGE_LABEL[range]}你发起过 ${desc} 退款，按原因分布是这样的：`,
  };
}

/* ============================================================
   ④ show_result_card
   ============================================================ */

function execShowResultCard(input: ShowResultCardInput, ctx: ToolContext): ToolOutcome {
  const result = ctx.session.lastRefundResult;

  if (!result || result.orderId !== input.orderNo) {
    // 模型想展示一个「还没发生的结果」——拒绝。结果只能来自服务端已经执行过的事实。
    return {
      kind: "text",
      text: "我这边还没有这笔退款的处理结果，等你提交之后我再来反馈。",
    };
  }

  const status = result.status === "submitted" ? ("success" as const) : ("fail" as const);

  const detail =
    status === "success"
      ? {
          refundId: result.refundId,
          orderNo: result.orderId,
          amount: formatYuan(result.amountCents),
          expectedArrival: result.expectedArrival,
          duplicated: result.deduplicated ? "该申请此前已提交，未重复创建" : "首次提交",
        }
      : {
          orderNo: result.orderId,
          rejectReason: result.rejectReason ?? "未通过校验",
        };

  const nextActions: RowAction[] =
    status === "success"
      ? [{ label: "查询退款进度", action: "queryRefundStatus", params: { orderNo: result.orderId } }]
      : [{ label: "查看订单详情", action: "queryOrderDetail", params: { orderNo: result.orderId } }];

  const props = {
    status,
    title: status === "success" ? "退款申请已提交" : "退款申请未通过",
    detail,
    nextActions,
  };

  const envelope = emit(ctx, "ResultCard", props, "refund-service.submitRefund");

  return {
    kind: "component",
    envelope,
    summary:
      status === "success"
        ? `退款申请已提交，单号 ${result.refundId}，金额 ${formatYuan(result.amountCents)}。`
        : `这笔退款没能提交：${result.rejectReason ?? "未通过校验"}。`,
  };
}

/* ============================================================
   统一入口
   ============================================================ */

export function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): ToolOutcome {
  switch (name) {
    case "show_order_table":
      return execShowOrderTable(input as unknown as ShowOrderTableInput, ctx);
    case "show_refund_form":
      return execShowRefundForm(input as unknown as ShowRefundFormInput, ctx);
    case "show_refund_reason_chart":
      return execShowRefundReasonChart(input as unknown as ShowRefundReasonChartInput, ctx);
    case "show_result_card":
      return execShowResultCard(input as unknown as ShowResultCardInput, ctx);
    default:
      // 走到这里说明上游白名单漏了。宁可回文本，也不执行未知工具。
      return { kind: "refused", reason: `未注册的工具：${name}`, text: "这个操作我还做不了。" };
  }
}

/** 供 action 回填时复用：把退款结果整理成 ResultCard 能吃的入参 */
export function resultCardInputFor(orderNo: string): ShowResultCardInput {
  return { orderNo };
}

/** 退款原因下拉的可选项，供前端兜底渲染（正常情况下前端只认 envelope 里的 options） */
export const REFUND_REASON_OPTIONS: string[] = Object.values(REFUND_REASON_LABEL);

export type { RefundReason };
