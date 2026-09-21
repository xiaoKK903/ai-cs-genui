/**
 * 可观测性出口
 *
 * ## 这一层要解决的问题
 *
 * 这个仓库原本就有可观测性数据：双层 trace、贯穿全链路的 correlationId、
 * 审计 JSONL、`/api/trace` 查询、前端闸3 的拦截回传。缺的不是「采集」，
 * 是**出口** —— 数据只落在本地文件里，Serverless 没有持久卷就全丢了，
 * 也没法跨轮次聚合（「最近一小时降级率涨了没有」这种问题本地文件答不了）。
 *
 * 所以这一节做的是把已有的 trace 编成 OTLP 报到标准后端，
 * 而不是再造一套埋点。
 *
 * ## 四条纪律
 *
 * ① **本地 JSONL 不动，上报是第二条腿。**
 *    顺序是先落盘、再入队上报。上报失败丢的是分析能力，
 *    落盘失败丢的是**追责能力** —— 两者的严重性差一个量级，
 *    所以绝不能让上报的任何问题影响到落盘（见 closeTurn）。
 *
 * ② **永远不阻塞、永远不抛错。**
 *    和 writeAudit 同一条纪律：观测链路的故障不该让一次客服对话挂掉。
 *    一次 POST 超时就把用户的请求拖住几秒，是拿主流程给支线陪葬。
 *
 * ③ **有界队列，丢最旧，丢了多少要能看见。**
 *    无界队列在下游挂掉时会吃光内存 —— 那是把「观测不可用」升级成「服务不可用」。
 *    所以宁可明确地丢，且把丢弃计数暴露出来：**一个静默丢弃的观测系统比没有更糟**，
 *    因为它会让你相信你看到的是全部。
 *
 * ④ **采样必须确定性。**
 *    用 correlationId 的哈希决定采不采，不用随机数。两个理由：
 *    可测（同一个 ID 结论永远一样）、可比（复现一次问题时不会「这次没采到」）。
 *
 * ## 采样规则里最要紧的一条
 *
 * **降级、任一道闸拒绝、有 failed 步骤的轮次，无条件上报。**
 *
 * 朴素采样的致命之处在于：出问题的轮次是**少数**，所以按比例采样会恰好
 * 把它们丢掉大部分 —— 你留下了 90% 的顺利请求和 10% 的故障请求，
 * 然后拿这份样本去算降级率。这是采样这件事上最容易犯、后果最隐蔽的错。
 *
 * 头部采样（在请求进来时就决定采不采）做不到这一点，因为那时还不知道
 * 这轮会不会出问题。所以这里是**轮次结束后**再决定 —— 代价是慢一点，
 * 换来的是「该看的都在」。
 */

import { writeAudit } from "../trace";
import type { TraceBuilder } from "../trace";
import type { TurnTrace } from "../protocol/types";
import { encodeTurn, hasFailedStep, traceIdOf, attr, type OtlpAttribute } from "./otlp";
import { hashId, redactMessage, redactToolArgs } from "./redact";

export { attr, encodeTurn, traceIdOf } from "./otlp";
export { hashId, redactMessage, redactToolArgs } from "./redact";

/* ============================================================
   采样
   ============================================================ */

/** 降级 / 闸拒绝 / 有 failed 步骤 —— 三种「必须留下」的情形 */
export function isInteresting(trace: TurnTrace): boolean {
  if (trace.degraded) return true;
  if (hasFailedStep(trace)) return true;
  const g1 = trace.gates.gate1;
  const g2 = trace.gates.gate2;
  // gate1.passed 为 false 且 attempts > 0，才是「真的试过并被拒」；
  // 预路由那一轮从没调过模型，attempts 是 0，不算失败。
  if (g1.attempts > 0 && !g1.passed) return true;
  if (g2.rejected) return true;
  return false;
}

/**
 * 采不采这一轮。
 *
 * rate=1 全采、rate<=0 只采「必须留」的那些。**注意 rate=0 不等于不上报** ——
 * 这是刻意的：把采样率调到 0 的意图通常是「太贵了，只看问题」，
 * 而不是「连问题也不要」。真要全关，应该不配 endpoint。
 */
export function shouldExport(trace: TurnTrace, rate: number): boolean {
  if (isInteresting(trace)) return true;
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  // 确定性采样：把 traceId 的前 8 位十六进制当 [0,1) 的定点数。
  // 复用 traceId 而不是另取一个哈希，是为了让「采不采」这件事和
  // 「上报后是什么 traceId」出自同一个散列 —— 排查时不用怀疑两套算法对不上。
  const bucket = parseInt(traceIdOf(trace.correlationId).slice(0, 8), 16) / 0x1_0000_0000;
  return bucket < rate;
}

/* ============================================================
   出口
   ============================================================ */

export interface ExportStats {
  /** 真的发出去的轮次数 */
  sent: number;
  /** 采样过滤掉的 */
  sampled: number;
  /** 因为队列满被丢掉的（丢的是最旧的） */
  dropped: number;
  /** 发送失败的 */
  failed: number;
  /** 队列里还没发的 */
  pending: number;
}

export interface SinkOptions {
  /** OTLP 收集端地址，如 http://localhost:3000/api/public/otel/v1/traces */
  endpoint: string;
  /** 采样率 0~1 */
  sampleRate?: number;
  /** 队列上限，超过丢最旧 */
  maxQueue?: number;
  /** 单次 POST 超时 */
  timeoutMs?: number;
  /** 单次请求最多带几轮（合并投递） */
  batchSize?: number;
  /** 鉴权头，比如 Langfuse 的 Basic / Bearer */
  headers?: Record<string, string>;
  serviceName?: string;
  includeDetail?: boolean;
  /** 注入传输层，测试用；缺省是 fetch */
  post?: (url: string, body: string, headers: Record<string, string>, timeoutMs: number) => Promise<void>;
}

export interface Sink {
  /** 入队。不 await、不抛错 */
  enqueue(trace: TurnTrace, turnAttributes: OtlpAttribute[]): void;
  /** 等队列排空（测试用；生产不调） */
  flush(): Promise<void>;
  readonly stats: ExportStats;
}

/**
 * 缺省传输：OTLP/HTTP + JSON。
 *
 * 用了 JSON 编码而不是 protobuf，是因为它能在 selftest 里被直接解析断言 ——
 * 二进制编码只能验「发出去了」，验不了「发出去的是什么」。
 *
 * 注意 headers 里已经带了 content-type（由 createSink 组装，不是这里加的）。
 * 一开始我把它写在这个函数里，结果是：任何**注入的传输层**都得自己记得加，
 * 而 OTLP 端点拿不到 `application/json` 会直接拒收。声明协议的地方
 * 和实现传输的地方分开，就是会出这种事。
 */
async function httpPost(url: string, body: string, headers: Record<string, string>, timeoutMs: number): Promise<void> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", headers, body, signal: ctl.signal });
    if (!res.ok) throw new Error(`OTLP 端点返回 ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

export function createSink(opts: SinkOptions): Sink {
  const sampleRate = opts.sampleRate ?? 1;
  const maxQueue = opts.maxQueue ?? 256;
  const batchSize = opts.batchSize ?? 16;
  const timeoutMs = opts.timeoutMs ?? 2000;
  const post = opts.post ?? httpPost;
  // content-type 在这里定，不在传输层里加 —— 它是 OTLP/HTTP 的协议约定
  // （JSON 编码用 application/json，二进制用 application/x-protobuf），
  // 属于「这一层说什么语言」，不属于「怎么发出去」
  const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };

  const queue: { trace: TurnTrace; turnAttributes: OtlpAttribute[] }[] = [];
  const stats: ExportStats = { sent: 0, sampled: 0, dropped: 0, failed: 0, pending: 0 };
  let draining: Promise<void> | null = null;

  async function drain(): Promise<void> {
    while (queue.length > 0) {
      const batch = queue.splice(0, batchSize);
      const payload = {
        resourceSpans: batch.flatMap((item) => {
          const encoded = encodeTurn(item.trace, {
            serviceName: opts.serviceName,
            turnAttributes: item.turnAttributes,
            includeDetail: opts.includeDetail,
          });
          return (encoded.resourceSpans as unknown[]) ?? [];
        }),
      };
      try {
        await post(opts.endpoint, JSON.stringify(payload), headers, timeoutMs);
        stats.sent += batch.length;
      } catch {
        // 丢的是这一批，不是整个队列 —— 一次网络抖动不该让后面所有轮次陪葬。
        // 也不重试：重试会在下游持续故障时把队列越堆越满，最后丢得更多。
        stats.failed += batch.length;
      }
    }
  }

  function kick(): void {
    if (draining) return;
    draining = drain().finally(() => {
      draining = null;
    });
  }

  return {
    enqueue(trace, turnAttributes) {
      if (!shouldExport(trace, sampleRate)) {
        stats.sampled += 1;
        return;
      }
      if (queue.length >= maxQueue) {
        queue.shift();
        stats.dropped += 1;
      }
      queue.push({ trace, turnAttributes });
      stats.pending = queue.length;
      kick();
    },
    async flush() {
      // 先等在飞的这一轮排空，再处理在此期间新入队的
      while (draining || queue.length > 0) {
        kick();
        await draining;
      }
    },
    stats,
  };
}

/* ============================================================
   装配
   ============================================================ */

let cached: Sink | null = null;

function envNum(name: string, dflt: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * 进程内单例。
 *
 * 没配 `OBSERVABILITY_OTLP_ENDPOINT` 就返回 null —— **不上报是缺省行为**。
 * 这一点同样是刻意的：接观测后端要先想清楚数据出境的问题（脱敏、盐、
 * 合规），所以它必须是一个显式的动作，不能因为「装了个依赖」就默认开着。
 */
export function getSink(): Sink | null {
  if (cached) return cached;
  const endpoint = process.env.OBSERVABILITY_OTLP_ENDPOINT?.trim();
  if (!endpoint) return null;

  const headers: Record<string, string> = {};
  const auth = process.env.OBSERVABILITY_OTLP_AUTH?.trim();
  if (auth) headers.authorization = auth;

  cached = createSink({
    endpoint,
    sampleRate: envNum("OBSERVABILITY_SAMPLE_RATE", 1),
    maxQueue: envNum("OBSERVABILITY_MAX_QUEUE", 256),
    timeoutMs: envNum("OBSERVABILITY_TIMEOUT_MS", 2000),
    includeDetail: (process.env.OBSERVABILITY_INCLUDE_DETAIL ?? "").trim().toLowerCase() === "on",
    serviceName: process.env.OBSERVABILITY_SERVICE_NAME?.trim() || undefined,
    headers,
  });
  return cached;
}

/** 测试用：丢掉单例，让下一次 getSink 重新读环境变量 */
export function resetSink(): void {
  cached = null;
}

/* ============================================================
   一轮的收口
   ============================================================ */

export interface CloseTurnArgs {
  trace: TraceBuilder;
  /** 落进本地 JSONL 的记录（与原来 writeAudit 的内容一致） */
  record: Record<string, unknown>;
  /**
   * 这一轮的业务属性 —— **应当已经脱敏**。
   *
   * 类型上给的是 OtlpAttribute[] 而不是裸对象，是为了让「脱敏」这一步
   * 无法被跳过：调用方必须先经过 attr() 包装，而值从哪来是这个函数
   * 签名之外的事。做不到强制，但至少让「随手塞一个对象进去」不成立。
   */
  attributes?: OtlpAttribute[];
  /**
   * 测试注入点：换掉这一轮的 sink。
   *
   * 存在的理由不是「方便测试」，而是**没有它这条顺序就观察不到**：
   * 真正的 sink 被设计成永不抛错（有界队列 + 内部 try），
   * 所以「上报挂了会不会影响落盘」在正常路径上永远测不出来 ——
   * 而这恰恰是 closeTurn 里唯一重要的性质。
   *
   * 加了这个口子，selftest 才能塞一个**真的会抛**的 sink 进来，
   * 把「先落盘」这件事从一句注释变成一个会红的断言。
   */
  sinkOverride?: Sink;
}

/**
 * 一轮结束的统一出口：**先落盘，再上报**。
 *
 * 抽成一个函数的理由是顺序和容错，不是省几行：
 *
 *   - 顺序：落盘在前。上报抛错（哪怕是我们自己的 bug）也不能让审计丢失。
 *   - 容错：整个上报段包在 try 里，且队列操作本身不抛 —— 双保险。
 *     一次客服对话的价值高于一条 trace，这个取舍没有悬念。
 *
 * 还顺手消掉了原来三处各写一遍 `trace.finish()` 的重复，
 * 以及「gates 只在主路径记了、降级路径没记」这个不一致。
 */
export function closeTurn(args: CloseTurnArgs): TurnTrace {
  const finished = args.trace.finish();

  // ① 本地，永远先做，且不受上报影响
  writeAudit({
    ...args.record,
    totalMs: finished.totalMs,
    degraded: args.record.degraded ?? finished.degraded,
    gates: finished.gates,
  });

  // ② 上报，尽力而为
  try {
    const sink = args.sinkOverride ?? getSink();
    if (sink) {
      sink.enqueue(finished, [
        ...(args.attributes ?? []),
        attr("turn.stepCount", finished.steps.length),
      ]);
    }
  } catch {
    // 观测链路自己出问题（包括 sink 实现本身有 bug），不能影响这一轮对话。
    // 注意这一段**必须在 writeAudit 之后**：顺序反过来的话，
    // 一个抛错的 sink 会让审计也一起丢掉 —— 丢分析能力和丢追责能力，
    // 严重性差一个量级。
  }

  return finished;
}

/** 便捷构造：把常见的用户/会话标识脱敏后包成属性 */
export function identityAttrs(sessionId: string, userId: string, userText: string): OtlpAttribute[] {
  const msg = redactMessage(userText);
  return [
    attr("user.hash", hashId(userId)),
    attr("session.hash", hashId(sessionId)),
    attr("message.length", msg.length),
    attr("message.lengthBucket", msg.lengthBucket),
  ];
}

/** 便捷构造：把工具调用脱敏后包成属性（值按 Schema 判定，见 redact.ts） */
export function toolAttrs(toolCalls: { name: string; input: unknown }[]): OtlpAttribute[] {
  const out: OtlpAttribute[] = [attr("tool.count", toolCalls.length)];
  toolCalls.forEach((call, i) => {
    out.push(attr(`tool.${i}.name`, call.name));
    const { values, omitted } = redactToolArgs(call.name, call.input);
    for (const [k, v] of Object.entries(values)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        out.push(attr(`tool.${i}.arg.${k}`, v));
      }
    }
    // 只报「带了哪些参数」——键名是我们自己的 Schema 里的，不是用户数据
    if (omitted.length > 0) out.push(attr(`tool.${i}.redacted`, omitted.join(",")));
  });
  return out;
}
