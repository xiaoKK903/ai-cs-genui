/**
 * 组件契约 —— 白名单与 props JSON Schema（权威定义）
 *
 * 这一份是前后端**共用**的组件契约：后端用它做出参校验（闸2），前端用它在渲染前
 * 二次校验（闸3）。两边读同一个文件，是「协议层解耦」能成立的前提。
 *
 * 设计铁律（对应第三阶段文档 1.3）：
 *   - 模型只决定「选哪个组件、展示哪些字段」，不决定数据值与渲染逻辑；
 *   - 行数据、金额一律由 API 回填（见 core/tools/execute.ts）；
 *   - 列 / 字段是受控枚举，additionalProperties: false 挡住一切计划外字段。
 */

import type { ComponentName } from "./types";

/* ============================================================
   最小 JSON Schema 子集
   ============================================================ */

export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean";
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: (string | number)[];
  additionalProperties?: boolean;
  /** 多类型择一，例如表单字段的 value 允许 string | number */
  anyOf?: JsonSchema[];
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

/* ============================================================
   公共片段
   ============================================================ */

/** 行内操作 / 后续操作。action 必须命中该组件的 ACTION_WHITELIST */
const ACTION_ITEM: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["label", "action"],
  properties: {
    label: { type: "string", minLength: 1, maxLength: 24 },
    action: { type: "string", minLength: 1, maxLength: 64 },
    params: { type: "object" },
  },
};

/* ============================================================
   四个组件的 props Schema
   ============================================================ */

/**
 * v1 契约。
 *
 * 名字从 COMPONENT_SCHEMAS 改成 V1_SCHEMAS 是为了把「组件」和「版本」这两件事
 * 在代码里分开 —— 原来一个组件只有一份 schema，于是 componentVersion 字段
 * 只是个装饰：闸2 校验 props 时根本不看它。灰度期要真正共存，schema 必须按版本取。
 */
const V1_SCHEMAS: Record<ComponentName, JsonSchema> = {
  OrderTable: {
    type: "object",
    additionalProperties: false,
    required: ["columns", "rows"],
    properties: {
      columns: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["key", "title"],
          properties: {
            key: { type: "string", minLength: 1, maxLength: 32 },
            title: { type: "string", minLength: 1, maxLength: 16 },
            type: { type: "string", enum: ["text", "money", "tag", "datetime"] },
            sortable: { type: "boolean" },
          },
        },
      },
      // 行数据由 order-api 回填。这里只约束规模，不约束行内字段 ——
      // 行结构属于业务系统，不该被协议层固化。
      rows: { type: "array", maxItems: 50, items: { type: "object" } },
      rowActions: { type: "array", maxItems: 3, items: ACTION_ITEM },
      pagination: {
        type: "object",
        additionalProperties: false,
        required: ["page", "pageSize", "total"],
        properties: {
          page: { type: "integer", minimum: 1 },
          pageSize: { type: "integer", minimum: 1, maximum: 50 },
          total: { type: "integer", minimum: 0 },
        },
      },
    },
  },

  RefundForm: {
    type: "object",
    additionalProperties: false,
    required: ["orderNo", "fields", "submitAction", "confirmRequired"],
    properties: {
      orderNo: { type: "string", minLength: 1, maxLength: 64 },
      fields: {
        type: "array",
        minItems: 1,
        maxItems: 6,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "label", "type"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 32 },
            label: { type: "string", minLength: 1, maxLength: 16 },
            type: { type: "string", enum: ["select", "money", "textarea", "text"] },
            options: { type: "array", maxItems: 12, items: { type: "string" } },
            required: { type: "boolean" },
            // 金额字段被要求 editable:false。闸2 会额外做语义检查：
            // 凡 type=money 的字段，editable 必须为 false 且带 source。
            editable: { type: "boolean" },
            value: { anyOf: [{ type: "string" }, { type: "number" }] },
            source: { type: "string", maxLength: 64 },
          },
        },
      },
      submitAction: { type: "string", minLength: 1, maxLength: 64 },
      confirmRequired: { type: "boolean" },
    },
  },

  RefundReasonChart: {
    type: "object",
    additionalProperties: false,
    required: ["chartType", "data", "dimension", "measure"],
    properties: {
      chartType: { type: "string", enum: ["bar"] },
      data: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["label", "value"],
          properties: {
            label: { type: "string", minLength: 1, maxLength: 24 },
            value: { type: "number", minimum: 0 },
            amountCents: { type: "number", minimum: 0 },
          },
        },
      },
      dimension: { type: "string", enum: ["reason"] },
      measure: { type: "string", enum: ["count", "amount"] },
    },
  },

  ResultCard: {
    type: "object",
    additionalProperties: false,
    required: ["status", "title", "detail"],
    properties: {
      status: { type: "string", enum: ["success", "fail", "pending"] },
      title: { type: "string", minLength: 1, maxLength: 32 },
      detail: { type: "object" },
      nextActions: { type: "array", maxItems: 3, items: ACTION_ITEM },
    },
  },
};

/* ============================================================
   action 白名单
   ============================================================ */

/**
 * 每个组件允许触发的 action。
 *
 * 这是「恶意调 Action」的第一道服务端兜底：即使模型在 props 里塞了一个
 * 看起来合理但从未注册的 action，闸2 也会把整个组件降级为文本。
 */
export const ACTION_WHITELIST: Record<ComponentName, string[]> = {
  OrderTable: ["openRefundForm"],
  RefundForm: ["submitRefund"],
  RefundReasonChart: [],
  ResultCard: ["queryOrderDetail", "queryRefundStatus"],
};

/**
 * 服务端 Action Handler 白名单 —— 真正执行写操作的那一层。
 *
 * 与上面的 ACTION_WHITELIST 分开：前者管「组件声明了什么」，这里管
 * 「服务端真的会执行什么」。前端伪造一个未注册的 action 会在这一层被拒。
 */
export const ACTION_HANDLERS = ["openRefundForm", "submitRefund", "queryOrderDetail", "queryRefundStatus"] as const;

export type ActionHandler = (typeof ACTION_HANDLERS)[number];

/* ============================================================
   按版本索引的 props Schema
   ============================================================ */

/**
 * RefundReasonChart@2 —— 与 v1 的唯一差别是多一个可选的 highlight。
 *
 * 增量式升级（只加字段、不改语义、不加必填）是灰度期唯一稳妥的改法：
 * 老包拿到 v2 的信封会走闸3 降级，新包渲染出多出来的那一行，
 * 两边都不会因为对方的存在而坏掉。
 *
 * 这里没有写成 `{...v1, properties: {...}}` 那种浅拷贝 —— 手写一遍虽然长，
 * 但「v2 到底和 v1 差在哪」这件事在 diff 里一眼可见。
 * 用展开运算符省下的那点体量，换来的是 review 时要去脑内做合并。
 */
const REFUND_REASON_CHART_V2: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["chartType", "data", "dimension", "measure"],
  properties: {
    chartType: { type: "string", enum: ["bar"] },
    data: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "value"],
        properties: {
          label: { type: "string", minLength: 1, maxLength: 24 },
          value: { type: "number", minimum: 0 },
          amountCents: { type: "number", minimum: 0 },
        },
      },
    },
    dimension: { type: "string", enum: ["reason"] },
    measure: { type: "string", enum: ["count", "amount"] },
    highlight: { type: "string", minLength: 1, maxLength: 60 },
  },
};

export const COMPONENT_VERSION_SCHEMAS: Record<ComponentName, Record<string, JsonSchema>> = {
  OrderTable: { "1": V1_SCHEMAS.OrderTable },
  RefundForm: { "1": V1_SCHEMAS.RefundForm },
  RefundReasonChart: { "1": V1_SCHEMAS.RefundReasonChart, "2": REFUND_REASON_CHART_V2 },
  ResultCard: { "1": V1_SCHEMAS.ResultCard },
};

/** 每个组件的默认版本（v1）。给不关心版本的调用方用，例如工具定义的生成。 */
export const COMPONENT_SCHEMAS: Record<ComponentName, JsonSchema> = V1_SCHEMAS;

export const COMPONENT_NAMES = Object.keys(COMPONENT_SCHEMAS) as ComponentName[];

export function isComponentName(value: unknown): value is ComponentName {
  return typeof value === "string" && (COMPONENT_NAMES as string[]).includes(value);
}
