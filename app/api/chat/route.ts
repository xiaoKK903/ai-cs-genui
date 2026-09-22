/**
 * 对话入口 —— SSE 网关
 *
 * 一轮请求的完整时序：
 *
 *   解析登录态 → 取会话 → 拼 system → 模型决策（闸1，失败重试≤3）
 *     → 工具分发（闸2 入参 → 骨架屏 → 取数 → 闸2 出参 → component）
 *     → state 同步 → done
 *
 * 两个刻意的设计：
 *
 *   1. **登录态与请求体彻底隔离**。body 里即使带了 userId 也不会被读 ——
 *      见 core/auth.ts。这是「越权查订单」唯一的兜底位置，放在别处都晚了一步。
 *   2. **闸1 的重试对用户不可见**。第一次尝试的文本已经流给用户了，重试时不再重复推流，
 *      否则用户会看到同一句话冒两遍。代价是重试那一次的思考过程没进 UI —— 但那是
 *      服务端的事，用户不需要看见我们内部校验失败了一次。
 */

import { resolveSessionId, resolveUserId } from "@/core/auth";
import { appendTurn, getOrCreateSession } from "@/core/data/session";
import { MAX_DECODE_RETRIES, gate1ValidateToolInput } from "@/core/guardrails/gates";
import { dispatchToolCalls } from "@/core/gateway/dispatch";
import { rateLimitResponse, withTurnSlot } from "@/core/gateway/guard";
import { sseResponse } from "@/core/gateway/sse";
import type { LLMAdapter, LLMDecision, LLMMessage, LLMToolCall } from "@/core/llm/adapter";
import { getAdapter, isTextOnlyForced } from "@/core/llm";
import { buildSystemPrompt } from "@/core/llm/prompt";
import { newCorrelationId } from "@/core/protocol/envelope";
import {
  TIMEOUTS,
  type Usage,
  costLedger,
  llmBreaker,
  preroute,
  sessionBudget,
  withBreaker,
  withTimeout,
} from "@/core/runtime";
import { TraceBuilder } from "@/core/trace";
import { attr, closeTurn, hashId, identityAttrs, toolAttrs } from "@/core/observability";

// 用了 node:fs（审计落盘），必须跑在 Node runtime，不能上 Edge
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ChatBody {
  sessionId?: unknown;
  message?: unknown;
  /** 故意声明出来但不读 —— 见文件头。留着是为了让 code review 时一眼看到它被忽略了。 */
  userId?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as ChatBody;
  const correlationId = newCorrelationId();

  const userText = typeof body.message === "string" ? body.message.trim() : "";
  if (!userText) {
    return Response.json({ error: "message 不能为空", correlationId }, { status: 400 });
  }

  const userId = resolveUserId(request);
  const sessionId = resolveSessionId(request, body);

  // —— 限流（H3）：按会话限，不按全局。
  // 一个人按住回车不放，不该让所有人的对话都变慢。
  const limited = rateLimitResponse(sessionId, correlationId);
  if (limited) return limited;

  return sseResponse(correlationId, (emit) =>
    withTurnSlot(emit, correlationId, () =>
      handleTurn({ emit, correlationId, sessionId, userId, userText }),
    ),
  );
}

/** 一轮对话的正文。抽出来是为了让上面的闸门逻辑（限流/并发/释放）保持一眼可读。 */
async function handleTurn(args: {
  emit: Parameters<Parameters<typeof sseResponse>[1]>[0];
  correlationId: string;
  sessionId: string;
  userId: string;
  userText: string;
}): Promise<void> {
  const { emit, correlationId, sessionId, userId, userText } = args;
  const trace = new TraceBuilder(correlationId);
  const session = getOrCreateSession(sessionId, userId);
  const adapter = getAdapter();

  // —— 预路由（H6）：整条消息只是寒暄时，连模型都不用问。
  // 这是成本控制里性价比最高的一刀，因为它砍掉的是一整次往返（含 system prompt）。
  const hit = preroute(userText);
  if (hit) {
    costLedger.recordSaved(sessionId);
    trace.note("预路由命中", hit.reason);
    emit.send("text_delta", { delta: hit.reply, correlationId });
    appendTurn(session, { role: "user", text: userText });
    appendTurn(session, { role: "assistant", text: hit.reply });
    emit.send("state", { correlationId, aiStatePatch: stateOf(session) });
    emit.send("done", { correlationId });
    closeTurn({
      trace,
      record: { correlationId, sessionId, userId, provider: adapter.name, message: userText, prerouted: true },
      attributes: [...identityAttrs(sessionId, userId, userText), attr("turn.prerouted", true)],
    });
    return;
  }

  // 会话预算触顶后不再渲染组件，但对话本身照常 —— 拿可用性换成本通常不划算
  const budgetExceeded = costLedger.overBudget(sessionId, sessionBudget());
  const textOnly = isTextOnlyForced() || budgetExceeded;
  if (budgetExceeded) trace.markDegraded("会话预算触顶");

  const system = buildSystemPrompt({
    today: new Date().toISOString().slice(0, 10),
    lastOrderNo: session.lastOrderNo,
    hasRefundResult: Boolean(session.lastRefundResult),
  });

  const history: LLMMessage[] = session.turns.map((t) => ({ role: t.role, content: t.text }));
  const baseReq = { system, history, userText };

  // —— 模型决策：闸1（约束解码）在这里生效；熔断 + 超时在这里生效
  let outcome: Awaited<ReturnType<typeof decideWithGate1Retry>>;
  try {
    outcome = await trace.run("llm.decide", () =>
      decideWithGate1Retry(adapter, baseReq, trace, (delta) => {
        emit.send("text_delta", { delta, correlationId });
      }),
    );
  } catch (err) {
    // 模型这条路彻底走不通（熔断打开 / 超时 / 未配密钥）。
    // 给用户一句能继续对话的话，而不是一条错误 —— 这一轮的失败对他来说
    // 是一次「换个说法再试」，不是一次故障。
    costLedger.record(sessionId, { inputTokens: 0, outputTokens: 0 });
    await degradeTurn({
      emit,
      trace,
      session,
      correlationId,
      sessionId,
      userId,
      userText,
      provider: adapter.name,
      reason: err instanceof Error ? err.message : String(err),
      fallback: "抱歉，我这轮没处理好。换个说法再问我一次？",
      // 抛出来的时候调用**没成功**，所以这里确实没有用量可记。
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    return;
  }

  costLedger.record(sessionId, outcome.usage);
  const decision = outcome.decision;

  if (!decision) {
    // 三次都没能产出合法调用 —— 退化成纯文本，走的是和「模型不可用」同一个出口。
    // 对用户来说这两件事没有区别：这一轮没结果，可以重说一遍。
    await degradeTurn({
      emit,
      trace,
      session,
      correlationId,
      sessionId,
      userId,
      userText,
      provider: adapter.name,
      reason: "闸1 重试耗尽",
      fallback: "抱歉，我这轮没处理好。换个说法再问我一次？",
      // 这一条**必须**带上：三次重试的钱是真花了的。
      // 不给它记用量，成本看板上「闸1 重试」这个最该被看见的科目会显示为 0 ——
      // 而它恰恰是小模型路径上最常见的花钱方式（参数写不对 → 重试 → 再花钱）。
      usage: outcome.usage,
    });
    return;
  }

  // —— 工具分发
  const result = await dispatchToolCalls(decision.toolCalls, {
    session,
    correlationId,
    emit,
    trace,
    textOnly,
  });

  // —— 会话状态回写（R3：服务端是单一真相源）
  appendTurn(session, { role: "user", text: userText });
  appendTurn(session, {
    role: "assistant",
    text: [decision.text, ...result.texts].filter(Boolean).join(" "),
    components: result.components,
  });

  // —— 状态同步：前端只持有副本，每次变更由服务端推
  emit.send("state", { correlationId, aiStatePatch: stateOf(session) });
  emit.send("done", { correlationId });

  closeTurn({
    trace,
    // 本地这份**带原始入参**，是刻意的：追责时要能回答「当时到底传了什么」，
    // 而脱敏只针对出境的那一份（attributes）。两个目的不能共用一份数据。
    record: {
      correlationId,
      sessionId,
      userId,
      provider: adapter.name,
      message: userText,
      toolCalls: decision.toolCalls.map((c) => ({ name: c.name, input: c.input })),
      components: result.components,
      degraded: result.degraded,
      // token 数落进这一轮的记录里。之前只有进程内的 costLedger 有它，
      // 那是按 session 汇总的、重启就没了 —— 于是「这一轮到底花了多少」
      // 事后答不出来，而「换个模型这一轮贵了多少」恰恰是个按轮次比的问题。
      // token 数不是个人信息，出境那份要不要带是另一回事（现在不带）。
      usage: outcome.usage,
    },
    attributes: [
      ...identityAttrs(sessionId, userId, userText),
      ...toolAttrs(decision.toolCalls),
      attr("component.count", result.components.length),
      attr("turn.degraded", result.degraded),
    ],
  });
}

/**
 * 本轮降级为纯文本的统一出口。
 *
 * 抽出来的原因：降级现在有四个来源（闸1 重试耗尽、模型超时、模型熔断、模型报错），
 * 它们的善后动作完全一样 —— 推一句话、同步状态、补一条审计、关流。
 * 四个地方各写一遍，迟早会漏掉其中一个步骤（最容易漏的是 appendTurn，
 * 漏了之后对话历史里就少一轮，模型下一轮看到的上下文是断的）。
 *
 * 审计一定要写：降级不是错误，但它必须留下痕迹 ——
 * 「这一轮我们没给用户组件」这件事，事后要能查得出发生过多少次、因为什么。
 */
async function degradeTurn(args: {
  emit: Parameters<Parameters<typeof sseResponse>[1]>[0];
  trace: TraceBuilder;
  session: ReturnType<typeof getOrCreateSession>;
  correlationId: string;
  sessionId: string;
  userId: string;
  userText: string;
  provider: string;
  reason: string;
  fallback: string;
  /** 降级前已经花掉的用量。模型调用失败时是 0，但闸1 重试耗尽时不是 0。 */
  usage: Usage;
}): Promise<void> {
  const { emit, trace, session, correlationId, userText, fallback } = args;
  emit.send("text_delta", { delta: fallback, correlationId });
  trace.markDegraded(args.reason);

  appendTurn(session, { role: "user", text: userText });
  appendTurn(session, { role: "assistant", text: fallback });

  emit.send("state", { correlationId, aiStatePatch: stateOf(session) });
  emit.send("done", { correlationId });

  closeTurn({
    trace,
    record: {
      correlationId,
      sessionId: args.sessionId,
      userId: args.userId,
      provider: args.provider,
      message: userText,
      degraded: true,
      degradedReason: args.reason,
      // 降级不等于免费。不记这一笔，「这一轮为什么花了钱却没有结果」就永远答不上来 ——
      // 而闸1 重试正是最典型的「花了钱、没结果」。
      usage: args.usage,
    },
    attributes: [
      ...identityAttrs(args.sessionId, args.userId, userText),
      attr("turn.degraded", true),
      // 降级原因**只上报一个哈希**，不报原文。
      // 原因串是拼接出来的，里面经常带着触发它的那个值
      // （校验失败的消息天然会引用被判为非法的输入），
      // 所以它和用户原话、订单号属于同一类：本地留着，不出网。
      // 哈希仍然可用 —— 同一个原因在不同轮次会得到同一个值，能分组、能计数。
      attr("degrade.reasonHash", hashId(args.reason)),
    ],
  });
}

/**
 * 闸1 的重试循环。
 *
 * 调用方的约定：只有第一次尝试的文本会被推给前端。重试时传 undefined 作为 handlers，
 * 于是这一轮的产出只进 trace，不进 UI。
 *
 * ## 熔断与超时为什么包在**每一次尝试**上，而不是整个循环
 *
 * 因为真正被打出去的是每一次尝试，成本也是按次数计的。包在循环外面的话，
 * 三次重试共用一个 30 秒预算，上游挂了的时候我们仍然会把三次全打出去 ——
 * 熔断要挡掉的正是这件事。
 *
 * ## 返回值带上 usage
 *
 * 重试三次就花三次的钱。只记最后一次的用量，成本看板上的数字会小得离谱，
 * 而「闸1 重试率」恰恰是最该被看见的成本项之一。
 */
async function decideWithGate1Retry(
  adapter: LLMAdapter,
  baseReq: { system: string; history: LLMMessage[]; userText: string },
  trace: TraceBuilder,
  onFirstAttemptDelta: (delta: string) => void,
): Promise<{ decision: LLMDecision | null; usage: Usage }> {
  let req = baseReq;
  let lastError: string | undefined;
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };

  for (let attempt = 1; attempt <= MAX_DECODE_RETRIES; attempt += 1) {
    const decision = await withBreaker(llmBreaker, () =>
      withTimeout(
        () => adapter.decide(req, attempt === 1 ? { onTextDelta: onFirstAttemptDelta } : undefined),
        TIMEOUTS.llm,
        "llm.decide",
      ),
    );

    usage.inputTokens += decision.usage?.inputTokens ?? 0;
    usage.outputTokens += decision.usage?.outputTokens ?? 0;

    if (decision.toolCalls.length === 0) {
      trace.gate1(attempt, true);
      return { decision, usage };
    }

    const failures = collectGate1Failures(decision.toolCalls);
    if (failures.length === 0) {
      trace.gate1(attempt, true);
      return { decision, usage };
    }

    lastError = failures.join("；");
    trace.note(`闸1 第 ${attempt} 次校验未通过`, lastError);
    trace.gate1(attempt, false, lastError);

    // 把错误原样回灌给模型。不替它改写参数 —— 服务端替模型做决策，
    // 出问题时就没法区分「模型选错了」还是「我们改错了」。
    req = {
      ...req,
      history: [
        ...req.history,
        { role: "assistant" as const, content: decision.text || "（调用工具）" },
        { role: "user" as const, content: `你上次的工具调用参数不合法：${lastError}。请只使用 Schema 允许的取值重新调用。` },
      ],
    };
  }

  return { decision: null, usage };
}

function collectGate1Failures(calls: LLMToolCall[]): string[] {
  const out: string[] = [];
  for (const call of calls) {
    const check = gate1ValidateToolInput(call.name, call.input);
    if (!check.passed) out.push(`${call.name}(${check.error})`);
  }
  return out;
}

function stateOf(session: ReturnType<typeof getOrCreateSession>): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    lastOrderNo: session.lastOrderNo ?? null,
    hasRefundResult: Boolean(session.lastRefundResult),
    liveInstanceCount: Object.keys(session.liveInstances).length,
  };
}
