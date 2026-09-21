/**
 * OTLP/HTTP JSON 编码
 *
 * 把一轮的 TurnTrace 编成 OpenTelemetry 的 OTLP 报文。
 *
 * ## 为什么手写编码而不用 @opentelemetry/sdk
 *
 * 和 mcp/server.ts 手写 JSON-RPC、data/ 用 node:sqlite 是同一个判断：
 * **这一层没有值得引入依赖的复杂度**。我们只做一件事 —— 把已有的
 * TurnTrace 编成固定形状的 JSON，POST 出去。真正的复杂度（采样器、
 * 处理器链、gRPC）在这个形态下一样都用不上。
 *
 * 代价同样要说清楚：**没有重试与退避**，因为 SDK 那套重试的价值建立在
 * 「后台常驻 + 有界队列 + 长期运行」上，而这里是短生命周期进程。
 * 换来的策略是**有界队列 + 丢最旧 + 显式计数**（见 index.ts）——
 * 宁可明确地丢，不可无限地攒。真要长跑，应该换 SDK。
 *
 * 用了 OTLP 而不是某个厂商的私有格式，是因为它现在是个事实标准：
 * Langfuse、Jaeger、Tempo、Datadog 都收。换后端只改一个 URL。
 *
 * ## 三处容易写错的地方
 *
 * 1. **时间是纳秒字符串**，不是毫秒数字。传毫秒进去，后端拿到的是 1970 年。
 * 2. **traceId 是 32 位十六进制、spanId 是 16 位**，且不能全零。
 *    correlationId 长这样：`msg_mubfhm2l_v57bdq` —— 不是十六进制，直接塞会被拒。
 * 3. **属性值是带类型标签的对象**（`{stringValue: "x"}`），不是裸值。
 */

import { createHash } from "node:crypto";
import type { TraceStep, TurnTrace } from "../protocol/types";

/** OTLP 的 span kind：1=INTERNAL。这些都是进程内部的步骤。 */
const SPAN_KIND_INTERNAL = 1;
/** span status code：1=OK，2=ERROR。0 是 UNSET，不要用。 */
const STATUS_OK = 1;
const STATUS_ERROR = 2;

/* ---------- 十六进制 ID ---------- */

function hexId(seed: string, bytes: number): string {
  return createHash("sha256").update(seed, "utf8").digest("hex").slice(0, bytes * 2);
}

/**
 * correlationId → traceId。
 *
 * **用哈希而不是随机数**：同一个 correlationId 必须永远映射到同一个 traceId。
 * 否则导出重试（或队列抖动导致的重复投递）会在后端造出两条互不相干的 trace，
 * 而排查时看到的「这个 ID 有两轮」会让人以为系统在重复处理请求。
 *
 * 这个性质也是可测的（selftest 第十三节里有断言）。
 */
export function traceIdOf(correlationId: string): string {
  return hexId(`trace:${correlationId}`, 16);
}

function spanIdOf(correlationId: string, step: string, index: number): string {
  return hexId(`span:${correlationId}:${step}:${index}`, 8);
}

/* ---------- 属性 ---------- */

type OtlpValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

export type OtlpAttribute = { key: string; value: OtlpValue };

/**
 * 属性值要带类型标签。
 *
 * intValue 在 OTLP JSON 里是**字符串**（因为 int64 超出 JSON number 的安全范围）——
 * 这里传数字会被后端当成 double，指标聚合时能对不上。
 */
export function attr(key: string, value: string | number | boolean): OtlpAttribute {
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { key, value: { intValue: String(value) } } : { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: value } };
}

/* ---------- 步骤 → span ---------- */

export interface EncodeOptions {
  /** 服务标识，落在 resource 上 */
  serviceName?: string;
  serviceVersion?: string;
  /** 这一轮的业务属性（应已脱敏，见 redact.ts） */
  turnAttributes?: OtlpAttribute[];
  /**
   * 是否上报步骤的 detail / evidenceRefs。
   *
   * **默认关**，而且这个默认是刻意的，不是偷懒。
   *
   * `detail` 是自由文本，主要来源是错误信息 —— 而**错误信息经常原样带着
   * 触发它的那个输入**：「订单号 SO-20260901-0001 不存在」。
   * 也就是说，即使入参脱敏做得再干净，detail 这条路会把值原样漏出去。
   * 这是一个很容易被忽略的旁路：堵了正门，忘了后门。
   *
   * 需要它的时候（自建后端、排查特定问题）用 `OBSERVABILITY_INCLUDE_DETAIL=on`
   * 显式打开，并且要清楚那一刻起这条链路就不再是脱敏的。
   */
  includeDetail?: boolean;
}

function stepSpan(trace: TurnTrace, step: TraceStep, index: number, opts: EncodeOptions): Record<string, unknown> {
  const parentSpanId = spanIdOf(trace.correlationId, "__turn__", 0);
  const startMs = step.startedAt;
  const endMs = step.startedAt + step.ms;

  const attributes: OtlpAttribute[] = [attr("step.index", index), attr("step.ms", step.ms)];
  if (step.evidenceRefs?.length) {
    // 证据引用是**我们自己的代码**产生的标识（接口名、规则 id），不是用户输入，
    // 所以不在脱敏范围内 —— 但条数记下来，便于发现「某一个步骤突然引用了上百条证据」
    attributes.push(attr("evidence.count", step.evidenceRefs.length));
  }
  if (opts.includeDetail) {
    if (step.detail) attributes.push(attr("step.detail", step.detail));
    if (step.evidenceRefs?.length) attributes.push(attr("evidence.refs", step.evidenceRefs.join(",")));
  }

  return {
    traceId: traceIdOf(trace.correlationId),
    spanId: spanIdOf(trace.correlationId, step.name, index),
    parentSpanId,
    name: step.name,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: String(startMs * 1_000_000),
    endTimeUnixNano: String(endMs * 1_000_000),
    attributes,
    // 只有 failed 才是 ERROR。
    // degraded **不是** error —— 用户拿到了正确内容，只是没穿卡片。
    // 把它标成 ERROR 会让后端的错误率变成一个混合了「真故障」和「有意的降级策略」
    // 的数字，而这个数字恰恰是告警阈值要用的。
    status: { code: step.status === "failed" ? STATUS_ERROR : STATUS_OK },
  };
}

/**
 * TurnTrace → OTLP ResourceSpans。
 *
 * 结构是三层：resource（谁产生的）→ scope（用哪套代码/库）→ spans（做了什么）。
 * 一台机器上跑多个服务时，靠 resource 上的 service.name 区分，
 * 所以那个属性不能省 —— 省了后端的所有 trace 会混成一坨。
 */
export function encodeTurn(trace: TurnTrace, opts: EncodeOptions = {}): Record<string, unknown> {
  const traceId = traceIdOf(trace.correlationId);
  const turnSpanId = spanIdOf(trace.correlationId, "__turn__", 0);

  // 根 span 代表「这一轮」，子 span 是每个步骤。
  // 这样后端展开一条 trace 时，先看到总耗时和降级与否，再往下看是哪一步慢。
  const rootAttributes: OtlpAttribute[] = [
    attr("turn.correlationId", trace.correlationId),
    attr("turn.totalMs", trace.totalMs),
    attr("turn.degraded", trace.degraded),
    attr("turn.stepCount", trace.steps.length),
    attr("gate.gate1.passed", trace.gates.gate1.passed),
    attr("gate.gate1.attempts", trace.gates.gate1.attempts),
    attr("gate.gate2.passed", trace.gates.gate2.passed),
    ...(opts.turnAttributes ?? []),
  ];

  const rootSpan = {
    traceId,
    spanId: turnSpanId,
    name: "turn",
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: String(trace.startedAt * 1_000_000),
    endTimeUnixNano: String((trace.startedAt + trace.totalMs) * 1_000_000),
    attributes: rootAttributes,
    // 一轮被降级不等于这一轮失败：用户拿到了内容。同上，不标 ERROR。
    status: { code: STATUS_OK },
  };

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            attr("service.name", opts.serviceName ?? "ai-cs-genui"),
            attr("service.version", opts.serviceVersion ?? "0.1.0"),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "ai-cs-genui/turn-trace", version: opts.serviceVersion ?? "0.1.0" },
            spans: [rootSpan, ...trace.steps.map((s, i) => stepSpan(trace, s, i, opts))],
          },
        ],
      },
    ],
  };
}

/** 这一轮会不会被后端标成错误（用于本地统计，不参与上报决策） */
export function hasFailedStep(trace: TurnTrace): boolean {
  return trace.steps.some((s) => s.status === "failed");
}
