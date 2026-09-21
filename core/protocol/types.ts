/**
 * Generative UI 协议层 —— 类型定义
 *
 * 严格对应《AI 客服 Generative UI 协议层设计（第三阶段）》第 1 节。
 * 协议分三层解耦，任一层独立升级不牵连另两层：
 *   ① 传输层（SSE 事件流）
 *   ② 组件契约层（渲染什么 —— 本文件的 Envelope 与 props）
 *   ③ Agent 工具层（模型怎么选 —— 见 core/tools/definitions.ts）
 */

/* ============================================================
   ① 组件契约层
   ============================================================ */

/**
 * 协议大版本。整套契约（信封结构、事件类型）发生破坏性变更时才升。
 * 单个组件迭代只动 componentVersion，不动这里 —— 避免「改一个 Table 逼所有组件升级」。
 */
export const SCHEMA_VERSION = "1.0" as const;

/** 白名单组件名。非白名单组件一律降级为文本（闸2 / 闸3）。 */
export type ComponentName =
  | "OrderTable"
  | "RefundForm"
  | "RefundReasonChart"
  | "ResultCard";

/**
 * 统一信封 —— 所有组件共用这一个外壳。
 * 前端只解析这一个结构，不必为每个组件写一套解析逻辑。
 */
export interface GenUIEnvelope {
  /** 协议大版本，整套契约 */
  schemaVersion: string;
  /** 组件名，必须命中白名单 */
  component: ComponentName;
  /** 单组件版本，独立于整套协议演进 */
  componentVersion: string;
  /** 组件实例唯一 ID —— 状态同步与 action 回填的定位锚点 */
  instanceId: string;
  /** 关联的会话消息 ID，串起多轮 */
  correlationId: string;
  /** 组件专属属性，严格 Schema，additionalProperties: false */
  props: Record<string, unknown>;
  meta: EnvelopeMeta;
}

export interface EnvelopeMeta {
  /** 数据来源标记。金额类强制填写，可审计可回溯 */
  dataSource: string;
  /** 渲染时间（毫秒时间戳） */
  renderedAt: number;
}

/* ---------- 各组件 props ---------- */

export interface OrderTableColumn {
  key: string;
  title: string;
  type?: "text" | "money" | "tag" | "datetime";
  sortable?: boolean;
}

export interface RowAction {
  label: string;
  /** 必须命中该组件声明的 action 白名单 */
  action: string;
  /** 参数，支持 $row.<key> 引用当前行数据 */
  params?: Record<string, unknown>;
}

export interface OrderTableProps {
  columns: OrderTableColumn[];
  /** 由业务 API 取数回填，模型禁止编造 */
  rows: Record<string, unknown>[];
  rowActions?: RowAction[];
  pagination?: { page: number; pageSize: number; total: number };
}

export type FormFieldType = "select" | "money" | "textarea" | "text";

export interface FormField {
  name: string;
  label: string;
  type: FormFieldType;
  /** 受控枚举。前端只渲染这里给出的选项，不接受模型自由生成 */
  options?: string[];
  required?: boolean;
  /** 金额类字段必须为 false —— 值来自业务系统，用户与模型都不可改 */
  editable?: boolean;
  value?: string | number;
  /** 只读字段的权威来源，便于审计 */
  source?: string;
}

export interface RefundFormProps {
  /** 预填，来自上一步 action 参数 */
  orderNo: string;
  fields: FormField[];
  /** 提交走既有强校验通道，非模型直接执行 */
  submitAction: string;
  /** 关键操作二次确认 */
  confirmRequired: boolean;
}

export interface RefundReasonChartProps {
  chartType: "bar";
  /** 由统计 API 取数 */
  data: { label: string; value: number; amountCents?: number }[];
  dimension: string;
  measure: string;
  /**
   * v2 新增（可选）。一句结论文案，例如「质量问题占了将近一半」。
   *
   * 选它当第一个 v2，是因为它同时满足两个条件：对老客户端是**纯增量**
   * （不填就不渲染，v1 的页面不会因此变形），对新客户端有真实价值
   * （图表本身说明了分布，但没人念出来）。
   * 灰度期最怕的是「新版本让老包渲染出一片空白」，增量式的改动从设计上就避开了这件事。
   */
  highlight?: string;
}

export interface ResultCardProps {
  /** 受控枚举 */
  status: "success" | "fail" | "pending";
  title: string;
  detail: Record<string, unknown>;
  nextActions?: RowAction[];
}

export interface ComponentPropsMap {
  OrderTable: OrderTableProps;
  RefundForm: RefundFormProps;
  RefundReasonChart: RefundReasonChartProps;
  ResultCard: ResultCardProps;
}

/* ============================================================
   ② 传输层 —— SSE 七类事件
   ============================================================ */

export type SSEEventName =
  | "text_delta"
  | "skeleton"
  | "component"
  | "tool_status"
  | "state"
  | "error"
  | "done";

/** 文本增量（打字机）。前端需节流批量更新，避免逐字重排 */
export interface TextDeltaEvent {
  delta: string;
  correlationId: string;
}

/** 组件占位，先于数据到达。固定高度是 CLS 从 0.35 压到 ≤0.1 的关键 */
export interface SkeletonEvent {
  component: ComponentName;
  instanceId: string;
  correlationId: string;
}

/** 工具执行中/完成，缓解取数延迟的等待焦虑 */
export interface ToolStatusEvent {
  instanceId: string;
  status: "running" | "done";
  tool: string;
}

/** 会话状态同步。服务端是会话状态的单一真相源 */
export interface StateEvent {
  correlationId: string;
  aiStatePatch: Record<string, unknown>;
}

/** 错误。recoverable=true 时前端降级文本或重试；否则展示友好错误卡片，不白屏 */
export interface ErrorEvent {
  code: string;
  message: string;
  correlationId: string;
  recoverable: boolean;
}

export interface DoneEvent {
  correlationId: string;
}

/** SSE 事件名 → data 结构 的映射，前后端共用 */
export interface SSEEventPayloadMap {
  text_delta: TextDeltaEvent;
  skeleton: SkeletonEvent;
  component: GenUIEnvelope;
  tool_status: ToolStatusEvent;
  state: StateEvent;
  error: ErrorEvent;
  done: DoneEvent;
}

/* ============================================================
   ③ action 回填协议
   ============================================================ */

/**
 * 组件产生的用户输入必须回到 Agent 上下文。
 * 回填走普通 HTTP POST，不引入 WebSocket。
 */
export interface ComponentAction {
  type: "component_action";
  /** 定位是哪个组件实例 */
  instanceId: string;
  correlationId: string;
  /** 必须是该组件声明过的 action，未声明的一律拒绝 */
  action: string;
  params: Record<string, unknown>;
  /** 组件本地态，便于恢复 */
  clientState?: Record<string, unknown>;
}

/* ============================================================
   会话 / trace 结构
   ============================================================ */

/** 会话状态 —— 服务端持有，前端通过 state 事件同步副本 */
export interface SessionState {
  sessionId: string;
  /** 登录态用户。模型与前端传来的任何身份参数都不采信 */
  userId: string;
  /** 最近一次展示过的订单号，供「给这个订单退款」这类指代消解 */
  lastOrderNo?: string;
  /** 最近一次组件实例，用于校验 action 归属 */
  liveInstances: Record<string, { component: ComponentName; actionWhitelist: string[] }>;
  /** 结构化对话历史（含 component_action 回填） */
  turns: SessionTurn[];
}

export interface SessionTurn {
  role: "user" | "assistant";
  /** 用户原始文本；回填时为结构化描述 */
  text: string;
  /** 该轮展示过的组件，便于模型理解上下文 */
  components?: { component: ComponentName; instanceId: string }[];
}

/** 单条执行 trace —— 可观测性要求 correlationId 贯穿 */
export interface TraceStep {
  name: string;
  status: "ok" | "degraded" | "failed";
  startedAt: number;
  ms: number;
  detail?: string;
  /** 该步骤命中的证据/数据来源 */
  evidenceRefs?: string[];
}

export interface TurnTrace {
  correlationId: string;
  startedAt: number;
  totalMs: number;
  degraded: boolean;
  steps: TraceStep[];
  /** 三道闸的命中情况，用于埋点统计 */
  gates: {
    gate1: { attempts: number; passed: boolean; error?: string };
    gate2: { passed: boolean; rejected?: string };
    gate3: { passed: boolean; rejected?: string };
  };
}
