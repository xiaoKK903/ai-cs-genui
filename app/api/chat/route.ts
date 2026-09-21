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
import { sseResponse } from "@/core/gateway/sse";
import type { LLMAdapter, LLMDecision, LLMMessage, LLMToolCall } from "@/core/llm/adapter";
import { getAdapter, isTextOnlyForced } from "@/core/llm";
import { buildSystemPrompt } from "@/core/llm/prompt";
import { newCorrelationId } from "@/core/protocol/envelope";
import { TraceBuilder, writeAudit } from "@/core/trace";

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

  return sseResponse(correlationId, async (emit) => {
    const trace = new TraceBuilder(correlationId);
    const session = getOrCreateSession(sessionId, userId);
    const adapter = getAdapter();
    const textOnly = isTextOnlyForced();

    const system = buildSystemPrompt({
      today: new Date().toISOString().slice(0, 10),
      lastOrderNo: session.lastOrderNo,
      hasRefundResult: Boolean(session.lastRefundResult),
    });

    const history: LLMMessage[] = session.turns.map((t) => ({ role: t.role, content: t.text }));
    const baseReq = { system, history, userText };

    // —— 模型决策：闸1（约束解码）在这里生效
    const decision = await trace.run("llm.decide", () =>
      decideWithGate1Retry(adapter, baseReq, trace, (delta) => {
        emit.send("text_delta", { delta, correlationId });
      }),
    );

    if (!decision) {
      // 三次都没能产出合法调用 —— 退化成纯文本。用户拿到的是「换个说法再试」，
      // 不是一条 500。这一轮的失败对用户是一次可重试的对话，不是一次故障。
      const fallback = "抱歉，我这轮没处理好。换个说法再问我一次？";
      emit.send("text_delta", { delta: fallback, correlationId });
      trace.markDegraded("闸1 重试耗尽");
      emit.send("state", { correlationId, aiStatePatch: stateOf(session) });
      emit.send("done", { correlationId });
      writeAudit({ correlationId, sessionId, userId, provider: adapter.name, message: userText, trace: trace.finish() });
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

    const finished = trace.finish();
    writeAudit({
      correlationId,
      sessionId,
      userId,
      provider: adapter.name,
      message: userText,
      toolCalls: decision.toolCalls.map((c) => ({ name: c.name, input: c.input })),
      components: result.components,
      degraded: result.degraded,
      gates: finished.gates,
      totalMs: finished.totalMs,
    });
  });
}

/**
 * 闸1 的重试循环。
 *
 * 调用方的约定：只有第一次尝试的文本会被推给前端。重试时传 undefined 作为 handlers，
 * 于是这一轮的产出只进 trace，不进 UI。
 */
async function decideWithGate1Retry(
  adapter: LLMAdapter,
  baseReq: { system: string; history: LLMMessage[]; userText: string },
  trace: TraceBuilder,
  onFirstAttemptDelta: (delta: string) => void,
): Promise<LLMDecision | null> {
  let req = baseReq;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= MAX_DECODE_RETRIES; attempt += 1) {
    const decision = await adapter.decide(
      req,
      attempt === 1 ? { onTextDelta: onFirstAttemptDelta } : undefined,
    );

    if (decision.toolCalls.length === 0) {
      trace.gate1(attempt, true);
      return decision;
    }

    const failures = collectGate1Failures(decision.toolCalls);
    if (failures.length === 0) {
      trace.gate1(attempt, true);
      return decision;
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

  return null;
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
