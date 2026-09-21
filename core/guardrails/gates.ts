/**
 * 三道防错闸
 *
 * 这三道闸不是「同一件事做三遍」，它们挡的是三类不同的失败，而且分属不同信任域：
 *
 *   闸1  生成侧（模型 → 工具调用）  约束解码 + 校验失败重试（≤3 次）
 *        挡的是「格式跑偏」：模型选对了工具但参数不合法。
 *        手段是重试 —— 这时候还没有任何副作用，重试是免费的。
 *
 *   闸2  服务端出参（工具 → 信封）  白名单 + Schema + 注入检测 → 降级文本
 *        挡的是「越界内容」：组件不在白名单、props 不合契约、字符串里带载荷。
 *        手段是降级 —— 副作用已经发生（数据已查/已写），只能换一种呈现方式，不能重试。
 *
 *   闸3  渲染前（信封 → DOM）      前端注册表 + 版本 + props 二次校验
 *        挡的是「版本错配」：老前端收到新组件、或信封在传输中被改过。
 *        手段是不渲染 —— 前端是最后一道，这里放行就等于直接进 DOM。
 *
 * 为什么闸2 和闸3 要用同一份 Schema 却各查一遍？因为它们的信任前提不同：
 * 闸2 相信「服务端刚构造的东西应该是对的」，查的是我们的代码有没有 bug；
 * 闸3 相信「我收到的这个字节流可能不是我以为的那个人发的」，查的是链路。
 * 把闸2 当成闸3 的替代，等于假设服务端到浏览器之间不可篡改。
 */

import { checkEnvelope } from "../protocol/envelope";
import type { ComponentName, GenUIEnvelope } from "../protocol/types";
import { summarizeIssues, validate } from "../protocol/validate";
import { TOOL_DEFINITIONS } from "../tools/definitions";
import { detectInjection, summarizeHits } from "./injection";

/* ============================================================
   闸1 —— 生成侧：约束解码 + 重试
   ============================================================ */

/** 重试上限。超过就放弃工具调用，退回纯文本回答 —— 不让模型无限撞墙。 */
export const MAX_DECODE_RETRIES = 3;

export type Gate1Result = { passed: true } | { passed: false; error: string };

/**
 * 校验一次工具调用是否符合它的 input_schema。
 *
 * 调用方（core/llm/*）拿到 passed:false 时应把 error 原样回灌给模型重试，
 * 而不是自己改写参数 —— 改写等于让服务端替模型做决策，出问题时无法归因。
 */
export function gate1ValidateToolInput(toolName: string, input: unknown): Gate1Result {
  const def = TOOL_DEFINITIONS.find((t) => t.name === toolName);
  if (!def) {
    // 未注册的工具名：不是格式问题，不该重试，直接失败
    return { passed: false, error: `工具 ${toolName} 未注册` };
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { passed: false, error: "工具入参必须是对象" };
  }

  const issues = validate(def.input_schema, input, "$.input");
  if (issues.length > 0) {
    return { passed: false, error: `入参不符合 Schema：${summarizeIssues(issues)}` };
  }
  return { passed: true };
}

/* ============================================================
   闸2 —— 服务端出参
   ============================================================ */

export type Gate2Result =
  | { passed: true; envelope: GenUIEnvelope }
  | { passed: false; reason: string };

export type Gate2InputResult = { passed: true } | { passed: false; reason: string };

/**
 * 组件信封出站校验。
 *
 * 失败时**不做任何修补**：不删字段、不改 props、不替换组件名。原因很实际 ——
 * 一次「自动修好」会让 trace 里留下一份和实际渲染不一致的记录，出事时查不出来。
 * 降级为文本，让用户拿到正确的内容 + 一个不那么好看的呈现，是唯一可审计的选择。
 *
 * 降级文案由调用方给：闸2 只判断能不能渲染，不知道用户问的是什么。
 * 网关会用同一轮工具执行产生的文字摘要来兜底 —— 数据本身是对的，只是没穿上卡片。
 */
export function gate2CheckEnvelope(raw: unknown): Gate2Result {
  const checked = checkEnvelope(raw);
  if (!checked.ok) return { passed: false, reason: checked.reason };

  // 结构合规之后才扫内容 —— 注入扫描比 Schema 校验贵，放在后面能少跑
  const hits = detectInjection(checked.envelope.props, "$.props");
  if (hits.length > 0) {
    return { passed: false, reason: `props 命中注入特征：${summarizeHits(hits)}` };
  }

  return { passed: true, envelope: checked.envelope };
}

/**
 * 工具入参的内容安全校验（结构合规之后、执行之前）。
 *
 * 位置很关键：这一步必须在 executeTool 之前。orderNo 这类字符串会直接进业务查询，
 * 让它先过一遍再执行，代价是一次正则，收益是把「有人在试」这件事记进审计。
 */
export function gate2CheckToolInput(
  toolName: string,
  input: Record<string, unknown>,
): Gate2InputResult {
  const hits = detectInjection(input, `$.tools.${toolName}.input`);
  if (hits.length > 0) {
    return { passed: false, reason: `工具入参命中注入特征：${summarizeHits(hits)}` };
  }
  return { passed: true };
}

/* ============================================================
   闸3 —— 渲染前
   ============================================================ */

/**
 * 前端组件注册表。
 *
 * 与「组件白名单」不是一回事：白名单是「协议允许哪些组件」（后端也认），
 * 注册表是「**这个前端包** 里真的打包了哪些组件」。灰度期间两者会不一致 ——
 * 后端按新协议下发了 OrderTable@2，而用户浏览器里还是昨天的包，只有 v1。
 * 这时应该降级，而不是白屏。
 */
export interface ComponentRegistry {
  has(component: ComponentName, version: string): boolean;
  /** 当前包实际支持的组合，用于降级提示与自检 */
  list(): string[];
}

export type Gate3Result =
  | { passed: true; envelope: GenUIEnvelope }
  | { passed: false; reason: string };

/**
 * 渲染前最后一道。过了这里就是 React.createElement，没有下一次机会。
 *
 * 比闸2 多查的只有一件事：注册表。其余校验刻意重跑一遍 —— 见文件头对信任域的说明。
 * 另外，闸3 失败**不抛异常**：抛出会被上层错误边界接住变成整屏错误页，
 * 而这只是一条消息渲染不出来，对话本身应该继续。
 */
export function gate3CheckEnvelope(raw: unknown, registry: ComponentRegistry): Gate3Result {
  const checked = checkEnvelope(raw);
  if (!checked.ok) return { passed: false, reason: checked.reason };

  const { component, componentVersion } = checked.envelope;
  if (!registry.has(component, componentVersion)) {
    return {
      passed: false,
      reason: `当前前端包未注册 ${component}@${componentVersion}（已注册：${registry.list().join(", ")}）`,
    };
  }

  const hits = detectInjection(checked.envelope.props, "$.props");
  if (hits.length > 0) {
    return { passed: false, reason: `props 命中注入特征：${summarizeHits(hits)}` };
  }

  return { passed: true, envelope: checked.envelope };
}
