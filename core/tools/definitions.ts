/**
 * Agent 工具层 —— Tool Definition
 *
 * 核心认知（对应第三阶段文档 2.1）：**模型不「生成组件」，模型调用一个
 * 「会返回组件的工具」**。这把「选组件」这个开放问题降维成了成熟的
 * function calling，准确率和可测性都高一个数量级。
 *
 * 两条写法纪律（文档 2.2）：
 *   1. description 既写「什么时候用」，也写「不用于什么」—— 防止模型在
 *      order / refund / chart 三个相近工具之间混淆，这是意图识别准确率的主因；
 *   2. 参数只放**查询意图**（timeRange / statusFilter），不放假数据。
 *      真实订单行、金额、统计值由工具内部调业务 API 取 —— 从根上杜绝编造。
 *
 * 注：协议文档中该字段名为 `parameters`，Anthropic SDK 用 `input_schema`，
 * 二者是同一份 JSON Schema。
 */

import type { JsonSchema } from "../protocol/schema";
import type { ComponentName } from "../protocol/types";

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

/** 时间窗枚举，四个工具共用 */
const TIME_RANGE = ["last7d", "last30d", "last90d", "all"] as const;

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "show_order_table",
    // description 逐字采用协议文档 2.2 的示例
    description:
      "当用户想查看、查询、列出自己的订单（如“我的订单”“最近买了什么”“订单状态”）时调用。用于以表格展示订单列表。仅用于展示订单，不用于退款或统计。",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["timeRange"],
      properties: {
        timeRange: { type: "string", enum: [...TIME_RANGE] },
        statusFilter: {
          type: "string",
          enum: ["all", "paid", "shipped", "completed", "refunding", "refunded"],
        },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: "show_refund_form",
    description:
      "当用户明确要对自己的某一个订单发起退款、退货、退钱，并且已经能确定具体订单号时调用。用于展示退款申请表单。仅用于发起退款申请；不用于查询退款进度、不用于统计退款原因，也不代表退款已经执行——退款的最终提交由用户在表单中确认并经系统校验后完成。",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["orderNo"],
      properties: {
        orderNo: { type: "string", minLength: 1, maxLength: 64 },
      },
    },
  },
  {
    name: "show_refund_reason_chart",
    description:
      "当用户想了解自己退款情况的分布或构成（如“我的退款都是什么原因”“退款原因统计”“退款都花在哪些原因上”）时调用。用于以柱状图展示退款原因统计。仅用于统计展示；不用于查询具体订单、不用于发起退款。",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["timeRange"],
      properties: {
        timeRange: { type: "string", enum: [...TIME_RANGE] },
        dimension: { type: "string", enum: ["reason"] },
        measure: { type: "string", enum: ["count", "amount"] },
      },
    },
  },
  {
    name: "show_result_card",
    description:
      "当一次操作已经产生确定结果、需要向用户反馈结果时调用（如用户刚提交完退款申请）。用于展示结果卡片。仅用于反馈服务端已有的结果；不用于发起新操作、不用于展示尚未发生的结果。",
    // 协议文档未给出本工具的参数定义。此处按「模型只给引用，数据由服务端取」的
    // 原则补全：模型只传订单号，结果内容一律从服务端会话状态读取，
    // 避免模型自行描述一个尚未发生的处理结果。
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["orderNo"],
      properties: {
        orderNo: { type: "string", minLength: 1, maxLength: 64 },
      },
    },
  },
];

export const TOOL_NAMES = TOOL_DEFINITIONS.map((t) => t.name);

/**
 * 工具名 → 组件名的映射。
 *
 * 存在的意义是抢时间：模型一决定调哪个工具，服务端就知道要渲染什么组件，
 * 于是可以在**取数之前**把骨架屏推下去。若等工具执行完再发 skeleton，
 * 它和 component 之间只差几毫秒，CLS 治理就白做了。
 *
 * 这也是工具与组件保持一对一的原因 —— 若一个工具可能返回多种组件，
 * 这里就得等执行结果，骨架屏自然失效。
 */
export const TOOL_COMPONENT_MAP: Record<string, ComponentName> = {
  show_order_table: "OrderTable",
  show_refund_form: "RefundForm",
  show_refund_reason_chart: "RefundReasonChart",
  show_result_card: "ResultCard",
};

export type ToolName = (typeof TOOL_DEFINITIONS)[number]["name"];

export function isToolName(value: unknown): value is ToolName {
  return typeof value === "string" && TOOL_NAMES.includes(value);
}

/** 给 Anthropic API 用的工具数组（含 strict，保证参数严格符合 Schema） */
export function toApiTools(): {
  name: string;
  description: string;
  input_schema: JsonSchema;
  strict: boolean;
}[] {
  return TOOL_DEFINITIONS.map((t) => ({ ...t, strict: true }));
}
