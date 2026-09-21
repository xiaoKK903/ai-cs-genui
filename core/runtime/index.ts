/**
 * 运行时治理层的装配点
 *
 * 四种能力各自独立成一个文件，在这里合成一组**单例**：
 *   超时   —— 单次调用别等太久
 *   熔断   —— 上游挂了别再撞
 *   限流   —— 别被单个用户刷垮 / 别让总并发超顶
 *   预路由 —— 能不问模型就不问
 *
 * ## 为什么是单例，以及为什么这不脏
 *
 * 熔断器、令牌桶、并发闸表达的都是**进程级的共享状态** ——
 * 「最近失败了 3 次」是全进程的事实，每个请求各持一份就完全不成立了。
 * 所以这里的模块级单例不是图省事，是这些对象的语义要求。
 *
 * 代价是它们活不过进程重启。对熔断器来说这没问题（重启后重新探测是应该的），
 * 对令牌桶来说也还好（重启时全放行一次）。真要多实例部署，替换点就是这一个文件。
 *
 * ## 默认值的选择
 *
 * 全部偏宽松。演示项目跑起来的体感应该和没有这层一样 ——
 * 这些闸门的价值在流量异常时才体现，不该在正常使用时被感觉到。
 * 生产部署时按 env 收紧，取值不应该改代码。
 */

import { CircuitBreaker } from "./breaker";
import { CostLedger } from "./cost";
import { ConcurrencyGate, KeyedRateLimiter } from "./limiter";
import { msFromEnv } from "./timeout";

export * from "./timeout";
export * from "./breaker";
export * from "./limiter";
export * from "./router";
export * from "./cost";

/* ---------- 超时预算 ---------- */

export const TIMEOUTS = {
  /** 模型决策。开了 thinking 之后一次往返可能十几秒，给足 */
  get llm() {
    return msFromEnv("LLM_TIMEOUT_MS", 30_000);
  },
  /** 单次工具取数。业务系统的正常响应应该在几百毫秒内 */
  get tool() {
    return msFromEnv("TOOL_TIMEOUT_MS", 5_000);
  },
};

/* ---------- 熔断 ---------- */

/** 模型服务熔断器。只有真模型路径会真的失败，mock 永远成功 */
export const llmBreaker = new CircuitBreaker("llm", {
  threshold: Number(process.env.LLM_BREAKER_THRESHOLD ?? 3),
  cooldownMs: Number(process.env.LLM_BREAKER_COOLDOWN_MS ?? 10_000),
});

/* ---------- 限流 ---------- */

/** 每会话：容量 8、每秒补 0.5 —— 正常聊天碰不到，按住回车刷会碰到 */
export const chatRateLimiter = new KeyedRateLimiter(
  Number(process.env.RATE_LIMIT_BURST ?? 8),
  Number(process.env.RATE_LIMIT_PER_SEC ?? 0.5),
);

/** 全局并发轮次上限 */
export const turnGate = new ConcurrencyGate(Number(process.env.MAX_CONCURRENT_TURNS ?? 64));

/* ---------- 成本 ---------- */

export const costLedger = new CostLedger();

/** 单会话模型调用上限。超过后仍然服务，只是不再渲染组件 —— 见 cost.ts */
export function sessionBudget(): number {
  return Number(process.env.SESSION_MAX_MODEL_CALLS ?? 200);
}

/**
 * 仅供测试：把所有共享状态清空。
 *
 * 自测里必须调 —— 否则「限流生效」这条断言会因为它之前已经跑过几十轮
 * 而看到一个不一样的起始状态，失败起来毫无规律。
 */
export function __resetRuntime(): void {
  llmBreaker.reset();
  chatRateLimiter.reset();
  turnGate.reset();
  costLedger.reset();
}
