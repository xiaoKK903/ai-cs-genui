/**
 * 信封的构造与结构校验
 *
 * 服务端构造（makeEnvelope）→ SSE component 事件下发 → 前端渲染前校验（闸3）。
 * 两侧走同一份 schema 与同一段校验逻辑。
 */

import { ACTION_WHITELIST, COMPONENT_VERSION_SCHEMAS, isComponentName } from "./schema";
import { SCHEMA_VERSION, type ComponentName, type GenUIEnvelope } from "./types";
import { summarizeIssues, validate } from "./validate";

/**
 * 每个组件可渲染的版本集合。
 *
 * 不再手写，直接从版本化的 schema 表里推出来 —— 「有 schema 的版本」和
 * 「协议允许渲染的版本」如果分成两份手写清单维护，加 v2 时漏改一边，
 * 表现是「服务端认为能发、发出去却被自己人拦下」，排查起来要绕一圈。
 */
export const RENDERABLE_COMPONENT_VERSIONS: Record<ComponentName, string[]> = Object.fromEntries(
  Object.entries(COMPONENT_VERSION_SCHEMAS).map(([name, versions]) => [name, Object.keys(versions)]),
) as Record<ComponentName, string[]>;

export interface EnvelopeBuildInput {
  component: ComponentName;
  props: Record<string, unknown>;
  instanceId: string;
  correlationId: string;
  dataSource: string;
  componentVersion?: string;
}

let instanceSeq = 0;

/** 生成组件实例 ID。instanceId 是状态同步与 action 回填的定位锚点，必须唯一。 */
export function newInstanceId(component: ComponentName): string {
  instanceSeq += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `cmp_${component.toLowerCase()}_${Date.now().toString(36)}_${instanceSeq}_${rand}`;
}

export function newCorrelationId(): string {
  return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function makeEnvelope(input: EnvelopeBuildInput): GenUIEnvelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    component: input.component,
    componentVersion: input.componentVersion ?? "1",
    instanceId: input.instanceId,
    correlationId: input.correlationId,
    props: input.props,
    meta: {
      dataSource: input.dataSource,
      renderedAt: Date.now(),
    },
  };
}

export type EnvelopeCheck =
  | { ok: true; envelope: GenUIEnvelope }
  | { ok: false; reason: string };

/**
 * 信封结构校验 —— 闸2（后端出参）与闸3（前端渲染前）共用。
 *
 * 检查顺序刻意从「便宜且致命」到「贵且细节」：白名单 → 版本 → props Schema → action。
 */
export function checkEnvelope(raw: unknown): EnvelopeCheck {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "信封不是对象" };
  }
  const e = raw as Partial<GenUIEnvelope>;

  // 1) 组件白名单 —— 非注册组件一律降级为文本
  if (!isComponentName(e.component)) {
    return { ok: false, reason: `组件不在白名单内：${String(e.component)}` };
  }
  const component = e.component;

  // 2) 协议大版本
  if (e.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, reason: `协议版本不匹配：${String(e.schemaVersion)}（期望 ${SCHEMA_VERSION}）` };
  }

  // 3) 单组件版本可渲染性（R1：未知版本回退降级，不原地炸）
  const version = String(e.componentVersion ?? "");
  const schema = COMPONENT_VERSION_SCHEMAS[component]?.[version];
  if (!schema) {
    return { ok: false, reason: `组件版本不可渲染：${component}@${version}` };
  }

  // 4) 定位锚点
  if (typeof e.instanceId !== "string" || e.instanceId.length === 0) {
    return { ok: false, reason: "缺少 instanceId（状态同步与回填的定位锚点）" };
  }
  if (typeof e.correlationId !== "string" || e.correlationId.length === 0) {
    return { ok: false, reason: "缺少 correlationId" };
  }

  // 5) props 严格 Schema —— 按信封自己声明的版本取。
  // 这是版本共存能成立的关键一步：v2 的信封（带 highlight）拿 v1 的 schema 校验
  // 会被 additionalProperties:false 判死，而它本该是合法的。
  const issues = validate(schema, e.props, "$.props");
  if (issues.length > 0) {
    return { ok: false, reason: `props 未通过 Schema：${summarizeIssues(issues)}` };
  }

  // 6) action 必须命中该组件声明过的白名单 —— 防越权动作
  const actionIssue = checkActions(component, e.props as Record<string, unknown>);
  if (actionIssue) return { ok: false, reason: actionIssue };

  // 7) 金额类语义：type=money 的字段必须只读且带来源
  const moneyIssue = checkMoneyFields(component, e.props as Record<string, unknown>);
  if (moneyIssue) return { ok: false, reason: moneyIssue };

  const meta = e.meta;
  if (typeof meta !== "object" || meta === null || typeof (meta as { dataSource?: unknown }).dataSource !== "string") {
    return { ok: false, reason: "缺少 meta.dataSource（金额类必须可审计来源）" };
  }

  return {
    ok: true,
    envelope: {
      schemaVersion: e.schemaVersion,
      component,
      componentVersion: version,
      instanceId: e.instanceId,
      correlationId: e.correlationId,
      props: e.props as Record<string, unknown>,
      meta: { dataSource: (meta as { dataSource: string }).dataSource, renderedAt: Number((meta as { renderedAt?: number }).renderedAt ?? Date.now()) },
    },
  };
}

function collectActions(props: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["rowActions", "nextActions"]) {
    const arr = props[key];
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (item && typeof item === "object" && typeof (item as { action?: unknown }).action === "string") {
          out.push((item as { action: string }).action);
        }
      }
    }
  }
  if (typeof props.submitAction === "string") out.push(props.submitAction);
  return out;
}

function checkActions(component: ComponentName, props: Record<string, unknown>): string | null {
  const allowed = new Set(ACTION_WHITELIST[component]);
  for (const action of collectActions(props)) {
    if (!allowed.has(action)) {
      return `组件 ${component} 声明了未注册的 action：${action}`;
    }
  }
  return null;
}

function checkMoneyFields(component: ComponentName, props: Record<string, unknown>): string | null {
  if (component !== "RefundForm") return null;
  const fields = props.fields;
  if (!Array.isArray(fields)) return null;
  for (const f of fields) {
    if (!f || typeof f !== "object") continue;
    const field = f as { name?: unknown; type?: unknown; editable?: unknown; source?: unknown };
    if (field.type === "money") {
      if (field.editable !== false) {
        return `金额字段 ${String(field.name)} 必须 editable:false（金额权威来自业务系统）`;
      }
      if (typeof field.source !== "string" || field.source.length === 0) {
        return `金额字段 ${String(field.name)} 缺少 source，无法审计`;
      }
    }
  }
  return null;
}
