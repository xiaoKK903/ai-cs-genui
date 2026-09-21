/**
 * 适配器选择
 *
 * 默认 mock。理由不是「省事」，而是这个仓库的第一使用场景是被人 clone 下来看 ——
 * 如果第一步就要 API Key，多数人到这里就停了，看不到后面三道闸和 SSE 的部分。
 */

import type { LLMAdapter } from "./adapter";
import { anthropicAdapter } from "./anthropic";
import { mockAdapter } from "./mock";

export type ProviderName = "mock" | "anthropic";

export function resolveProvider(): ProviderName {
  const raw = (process.env.LLM_PROVIDER ?? "mock").trim().toLowerCase();
  return raw === "anthropic" ? "anthropic" : "mock";
}

export function getAdapter(): LLMAdapter {
  return resolveProvider() === "anthropic" ? anthropicAdapter : mockAdapter;
}

/**
 * 一键降级开关。
 *
 * 上线门槛里的一条硬要求（第四阶段）：出问题时必须能**立刻**让所有用户回到纯文本，
 * 而不是等改代码、走发布流程。这个开关读到 on/true/1 就整条链路不产出组件信封，
 * 只留文本 —— 对话本身不受影响，这是它能当应急开关用而不是当熔断用的原因。
 */
export function isTextOnlyForced(): boolean {
  const v = (process.env.FORCE_TEXT_ONLY ?? "off").trim().toLowerCase();
  return v === "on" || v === "true" || v === "1";
}

export { mockAdapter, anthropicAdapter };
export type { LLMAdapter, LLMDecision, LLMHandlers, LLMRequest, LLMToolCall } from "./adapter";
