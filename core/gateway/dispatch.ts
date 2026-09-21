/**
 * 工具调用分发 —— 一轮里「模型说完了，接下来该干什么」的全部逻辑
 *
 * chat 和 action 两个入口共用这一段：前者是模型决定调工具，后者是用户点了按钮。
 * 殊途同归 —— 两条路径最后都要经过闸2、都要产出信封、都要下发组件，
 * 分开写两份的后果是两边会慢慢长歪，而「按钮那条路少校验了一次」这种 bug
 * 恰恰最难在测试里被发现。
 */

import type { ServerSession } from "../data/session";
import { gate2CheckEnvelope, gate2CheckToolInput } from "../guardrails/gates";
import type { LLMToolCall } from "../llm/adapter";
import { resolveProvider } from "../llm";
import { newInstanceId } from "../protocol/envelope";
import type { ComponentName } from "../protocol/types";
import { TIMEOUTS, TimeoutError, withTimeout } from "../runtime";
import { TOOL_COMPONENT_MAP } from "../tools/definitions";
import { executeTool } from "../tools/execute";
import type { TraceBuilder } from "../trace";
import type { SSEEmitter } from "./sse";

export interface DispatchContext {
  session: ServerSession;
  correlationId: string;
  emit: SSEEmitter;
  trace: TraceBuilder;
  /** 一键降级开关打开时，只出文本、不出组件 */
  textOnly: boolean;
}

export interface DispatchResult {
  components: { component: ComponentName; instanceId: string }[];
  /** 本轮产出的所有面向用户的文本，用于写回会话历史 */
  texts: string[];
  degraded: boolean;
}

const CHUNK_SIZE = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 服务端产出的补充文本（工具摘要、拒绝说明、降级文案）也要走打字机。
 *
 * 只在 mock 下加延迟。真模型路径里，这类文本是服务端现成的一句话，
 * 人为拖慢它没有任何收益 —— 用户等的是模型的思考，不是我们磨蹭。
 */
export async function streamText(ctx: DispatchContext, text: string): Promise<void> {
  if (!text) return;
  const delay = resolveProvider() === "mock" ? Number(process.env.MOCK_STREAM_DELAY_MS ?? 18) : 0;

  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    if (ctx.emit.closed) return;
    ctx.emit.send("text_delta", { delta: text.slice(i, i + CHUNK_SIZE), correlationId: ctx.correlationId });
    if (delay > 0) await sleep(delay);
  }
}

/**
 * 模拟取数耗时。
 *
 * 真实环境里这段时间是订单服务的网络往返 + 聚合。演示数据是内存里的，
 * 不补一点延迟，骨架屏会在一帧内被替换掉 —— CLS 治理的效果（以及它为什么重要）
 * 就完全看不出来了。
 */
function toolLatencyMs(): number {
  if (resolveProvider() !== "mock") return 0;
  return Number(process.env.MOCK_TOOL_DELAY_MS ?? 260);
}

/**
 * 执行模型给出的工具调用并下发结果。
 *
 * 每一步的先后顺序都是有意排的，改动前先想清楚代价：
 *
 *   skeleton → tool_status(running) → [取数] → 闸2 出参 → component → tool_status(done)
 *
 * 骨架屏必须早于取数，否则它和组件几乎同时到达，占位就失去意义；
 * 闸2 必须在 component 之前，否则被拦下的信封已经出门了。
 */
export async function dispatchToolCalls(
  calls: LLMToolCall[],
  ctx: DispatchContext,
): Promise<DispatchResult> {
  const result: DispatchResult = { components: [], texts: [], degraded: false };

  for (const call of calls) {
    // —— 闸2（入参侧）：orderNo 这类字符串会直接进业务查询，执行前先扫一遍
    const inputCheck = gate2CheckToolInput(call.name, call.input);
    if (!inputCheck.passed) {
      ctx.trace.gate2(false, inputCheck.reason);
      ctx.trace.markDegraded(inputCheck.reason);
      result.degraded = true;

      const fallback = "这个请求我没法处理，换个说法我们再试一次？";
      await streamText(ctx, fallback);
      result.texts.push(fallback);
      continue;
    }

    const component = TOOL_COMPONENT_MAP[call.name];
    const instanceId = component ? newInstanceId(component) : `cmp_unknown_${Date.now().toString(36)}`;

    // 一键降级：不占位、不下发组件，但工具照常执行 —— 用户拿到的是内容，少的是卡片
    if (ctx.textOnly) {
      ctx.trace.markDegraded("FORCE_TEXT_ONLY 已开启");
      result.degraded = true;
    } else if (component) {
      ctx.emit.send("skeleton", { component, instanceId, correlationId: ctx.correlationId });
      ctx.emit.send("tool_status", { instanceId, status: "running", tool: call.name });
    }

    let outcome: Awaited<ReturnType<typeof executeTool>>;
    try {
      outcome = await ctx.trace.run(
        `tool:${call.name}`,
        async () =>
          // 取数超时（H2）。
          // 没有这一层的话，业务系统「慢」就等于这一轮永远不结束 ——
          // 骨架屏一直转，用户既拿不到结果也得不到失败，只能刷新页面。
          // 超时不是拒绝：数据可能根本没问题，只是这次没等回来，
          // 所以文案是「再试一次」而不是「你无权/不存在」。
          withTimeout(
            async () => {
              if (toolLatencyMs() > 0) await sleep(toolLatencyMs());
              return executeTool(call.name, call.input, {
                session: ctx.session,
                correlationId: ctx.correlationId,
                instanceId,
              });
            },
            TIMEOUTS.tool,
            `tool:${call.name}`,
          ),
        undefined,
        [`tool:${call.name}`],
      );
    } catch (err) {
      const label = err instanceof TimeoutError ? "取数超时" : "取数失败";
      ctx.trace.note(label, err instanceof Error ? err.message : String(err));
      ctx.trace.markDegraded(label);
      result.degraded = true;

      const text = "系统响应有点慢，这笔我暂时没查出来。稍后再问我一次？";
      await streamText(ctx, text);
      result.texts.push(text);
      // 骨架屏交给前端在本轮结束时统一清理（见 Chat.tsx finishTurn），
      // 这里只需要把工具状态收掉，免得那个「查询中」的标签一直转
      if (!ctx.textOnly && component) {
        ctx.emit.send("tool_status", { instanceId, status: "done", tool: call.name });
      }
      continue;
    }

    if (outcome.kind === "refused") {
      // 越权/不存在：不进组件、不重试，如实告诉用户 —— 措辞里不含任何他人订单信息
      ctx.trace.note("工具拒绝执行", outcome.reason);
      await streamText(ctx, outcome.text);
      result.texts.push(outcome.text);
      continue;
    }

    if (outcome.kind === "text") {
      await streamText(ctx, outcome.text);
      result.texts.push(outcome.text);
      continue;
    }

    // —— 闸2（出参侧）：信封出站前最后一道
    if (ctx.textOnly) {
      await streamText(ctx, outcome.summary);
      result.texts.push(outcome.summary);
      continue;
    }

    const checked = gate2CheckEnvelope(outcome.envelope);
    if (!checked.passed) {
      ctx.trace.gate2(false, checked.reason);
      ctx.trace.markDegraded(checked.reason);
      result.degraded = true;

      // 关键：降级成文本时用的不是一句「出错了」，而是同一轮工具执行产生的摘要 ——
      // 数据本身是对的，只是没穿上卡片。用户损失的是观感，不是信息。
      await streamText(ctx, outcome.summary);
      result.texts.push(outcome.summary);
      ctx.emit.send("tool_status", { instanceId, status: "done", tool: call.name });
      continue;
    }

    ctx.trace.gate2(true);
    ctx.emit.send("component", checked.envelope);
    ctx.emit.send("tool_status", { instanceId, status: "done", tool: call.name });

    result.components.push({ component: checked.envelope.component, instanceId: checked.envelope.instanceId });
    result.texts.push(outcome.summary);
  }

  return result;
}
