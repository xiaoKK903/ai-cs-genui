/**
 * component_action 回填入口
 *
 * 用户在组件里做的操作（点「申请退款」、提交表单、点结果卡上的后续按钮）走这里回到服务端。
 * 文档 1.5 的闭环：**组件产生的用户输入必须回到 Agent 上下文**，否则多轮就是断的 ——
 * 用户提交完退款，下一句问「到哪一步了」，Agent 一脸茫然。
 *
 * 与 /api/chat 的关键差别，也是这个文件存在的意义：
 *
 *   chat 那条路，动作来自**模型的判断**；
 *   action 这条路，动作来自**前端的输入**。
 *
 * 后者是完全不可信的。所以这里有两道 chat 不需要的检查：
 *
 *   ① instanceId 必须能在服务端会话里找到 —— 挡住伪造的和已经过期的组件实例；
 *   ② action 必须同时命中「该组件声明的白名单」和「服务端真的会执行的 handler 列表」。
 *      两份白名单是分开的：前者管组件说了什么，后者管我们真的做什么。
 *      前端伪造一个看起来合理但从未注册的 action，会在第 ② 步被拒。
 *
 * 还有一条底线：**退款金额永远不从 params 读**。params 里带了也不看，
 * 金额一律以订单在业务系统里的值为准（见 core/data/order-service.ts 的 submitRefund）。
 */

import { resolveSessionId, resolveUserId } from "@/core/auth";
import { REFUND_REASON_BY_LABEL, type RefundReason } from "@/core/data/domain";
import { submitRefund } from "@/core/data/order-service";
import {
  appendTurn,
  findInstance,
  getOrCreateSession,
  setLastOrderNo,
  setLastRefundResult,
  type ServerSession,
} from "@/core/data/session";
import { gate2CheckToolInput } from "@/core/guardrails/gates";
import { dispatchToolCalls, streamText } from "@/core/gateway/dispatch";
import { rateLimitResponse, withTurnSlot } from "@/core/gateway/guard";
import { sseResponse } from "@/core/gateway/sse";
import type { LLMToolCall } from "@/core/llm/adapter";
import { isTextOnlyForced } from "@/core/llm";
import { newCorrelationId } from "@/core/protocol/envelope";
import { ACTION_HANDLERS } from "@/core/protocol/schema";
import { TraceBuilder, writeAudit } from "@/core/trace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ActionBody {
  sessionId?: unknown;
  instanceId?: unknown;
  /** 上一轮对话的 correlationId —— 用来把「点了按钮」串回原来那次对话 */
  correlationId?: unknown;
  action?: unknown;
  params?: unknown;
  clientState?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as ActionBody;

  // 这是**新一轮**，有自己的 correlationId。前端传来的那个记为 parent，
  // 两者都写进审计 —— 只保留一个新的，等于把「这次点击属于哪次对话」弄丢了。
  const correlationId = newCorrelationId();
  const parentCorrelationId = typeof body.correlationId === "string" ? body.correlationId : undefined;

  const instanceId = typeof body.instanceId === "string" ? body.instanceId : "";
  const action = typeof body.action === "string" ? body.action : "";
  const params = (typeof body.params === "object" && body.params !== null ? body.params : {}) as Record<string, unknown>;

  const userId = resolveUserId(request);
  const sessionId = resolveSessionId(request, body);

  // 和 chat 走同一套闸。按钮这条路会真的产生副作用（submitRefund），
  // 更不能是那个「少校验了一次」的入口。
  const limited = rateLimitResponse(sessionId, correlationId);
  if (limited) return limited;

  return sseResponse(correlationId, (emit) =>
    withTurnSlot(emit, correlationId, async () => {
    const trace = new TraceBuilder(correlationId);
    const session = getOrCreateSession(sessionId, userId);
    const textOnly = isTextOnlyForced();
    const ctx = { session, correlationId, emit, trace, textOnly };

    const reject = async (reason: string, userText: string): Promise<void> => {
      trace.note("action 被拒绝", reason);
      trace.markDegraded(reason);
      await streamText(ctx, userText);
      emit.send("done", { correlationId });
      writeAudit({ correlationId, parentCorrelationId, sessionId, userId, action, instanceId, rejected: reason });
    };

    // —— ① 实例归属：查不到说明是伪造的，或者这条消息已经翻篇了
    const instance = findInstance(session, instanceId);
    if (!instance) {
      return reject("instanceId 不在当前会话的存活列表中", "这个操作已经过期了，刷新一下再来一次？");
    }

    // —— ② 双白名单
    if (!instance.actionWhitelist.includes(action)) {
      return reject(`组件 ${instance.component} 未声明 action：${action}`, "这个操作我不支持。");
    }
    if (!(ACTION_HANDLERS as readonly string[]).includes(action)) {
      return reject(`服务端未注册 handler：${action}`, "这个操作我暂时做不了。");
    }

    // —— ③ 入参内容安全（与 chat 路径同一套检测）
    const inputCheck = gate2CheckToolInput(`component_action:${action}`, params);
    if (!inputCheck.passed) {
      return reject(inputCheck.reason, "提交的内容有点问题，检查一下再试？");
    }

    const outcome = await runAction(action, params, session, trace);

    if (outcome.kind === "text") {
      await streamText(ctx, outcome.text);
      appendTurn(session, { role: "user", text: `（用户在 ${instance.component} 上点击了 ${action}）` });
      appendTurn(session, { role: "assistant", text: outcome.text });
    } else {
      const result = await dispatchToolCalls(outcome.calls, ctx);
      appendTurn(session, { role: "user", text: `（用户在 ${instance.component} 上把操作提交为：${action}）` });
      appendTurn(session, {
        role: "assistant",
        text: result.texts.join(" "),
        components: result.components,
      });
    }

    emit.send("state", {
      correlationId,
      aiStatePatch: {
        sessionId: session.sessionId,
        lastOrderNo: session.lastOrderNo ?? null,
        hasRefundResult: Boolean(session.lastRefundResult),
        liveInstanceCount: Object.keys(session.liveInstances).length,
      },
    });
    emit.send("done", { correlationId });

    const finished = trace.finish();
    writeAudit({
      correlationId,
      parentCorrelationId,
      sessionId,
      userId,
      action,
      instanceId,
      params: redact(params),
      gates: finished.gates,
      totalMs: finished.totalMs,
    });
    }),
  );
}

/* ============================================================
   各 action 的服务端实现
   ============================================================ */

type ActionOutcome = { kind: "tool"; calls: LLMToolCall[] } | { kind: "text"; text: string };

function call(name: string, input: Record<string, unknown>): LLMToolCall {
  return { id: `call_act_${Date.now().toString(36)}`, name, input };
}

async function runAction(
  action: string,
  params: Record<string, unknown>,
  session: ServerSession,
  trace: TraceBuilder,
): Promise<ActionOutcome> {
  switch (action) {
    /* 行内按钮：把这一行的订单拉成退款表单 */
    case "openRefundForm": {
      const orderNo = str(params.orderNo) ?? session.lastOrderNo;
      if (!orderNo) {
        return { kind: "text", text: "没定位到是哪一笔订单，先让我把你的订单列出来吧。" };
      }
      return { kind: "tool", calls: [call("show_refund_form", { orderNo })] };
    }

    /* 表单提交：唯一真正产生副作用的 action */
    case "submitRefund": {
      const orderNo = str(params.orderNo) ?? session.lastOrderNo;
      if (!orderNo) {
        return { kind: "text", text: "没收到订单号，这次提交我先不处理。" };
      }

      const reasonLabel = str(params.reason);
      const reason: RefundReason = (reasonLabel && REFUND_REASON_BY_LABEL[reasonLabel]) || "other";
      if (reasonLabel && !REFUND_REASON_BY_LABEL[reasonLabel]) {
        trace.note("退款原因反查失败", `收到未知选项「${reasonLabel}」，按「其他」处理`);
      }

      // —— 订单维度的幂等不在这里做了。
      //
      // 原来这里查的是会话内存里的 lastRefundResult：「一个订单只能有一笔在途退款」这条
      // 业务不变量，被挂在了「会话」这个维度上 —— 换个浏览器、或者进程重启，它就不成立了。
      // 现在订单维度与请求维度的幂等统一由 order-service 在数据库层负责：
      // 前者查 refunds 表里的在途记录，后者靠那条只对成功单据生效的部分唯一索引。

      // —— 请求维度：键由服务端自己算，不信任前端传来的幂等键。
      // 同一会话、同一订单、同一原因重复提交，拿到的是同一笔单据。
      const idempotencyKey = `act:${session.sessionId}:${orderNo}:${reason}`;

      const result = submitRefund(session.userId, {
        orderId: orderNo,
        reason,
        // params 里的 amount 一律不看 —— 红线 2：金额权威来自业务系统
        claimedAmountCents: 0,
        note: str(params.note),
        idempotencyKey,
      });

      trace.note(
        "退款提交完成",
        `${result.refundId} ${result.status} ${result.amountCents}分`,
        [`refund-service.submitRefund`, `order:${orderNo}`],
      );

      setLastRefundResult(session, result);
      setLastOrderNo(session, orderNo);

      return { kind: "tool", calls: [call("show_result_card", { orderNo })] };
    }

    /* 结果卡上的后续按钮。真实系统会去查退款单，这里只回一句确定的话。 */
    case "queryRefundStatus": {
      const result = session.lastRefundResult;
      if (!result) {
        return { kind: "text", text: "我这边还没有你提交过的退款申请，先提交一笔我再帮你盯进度。" };
      }
      return {
        kind: "text",
        text: `退款单 ${result.refundId} 已受理，${result.expectedArrival}。审核通过前你可以随时来问我。`,
      };
    }

    case "queryOrderDetail": {
      const orderNo = str(params.orderNo) ?? session.lastOrderNo;
      if (!orderNo) return { kind: "text", text: "想看哪一笔订单？给我个订单号。" };
      // 复用订单表格：单条订单也用同一张卡片，避免为「详情」多做一个组件
      return { kind: "tool", calls: [call("show_order_table", { timeRange: "all", statusFilter: "all" })] };
    }

    default:
      return { kind: "text", text: "这个操作我暂时做不了。" };
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/** 审计里不落完整表单内容 —— 备注可能含用户隐私，留长度和字段名就够排查了 */
function redact(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = typeof v === "string" && v.length > 32 ? `${v.slice(0, 32)}…(${v.length})` : v;
  }
  return out;
}
