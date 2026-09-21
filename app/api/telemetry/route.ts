/**
 * 前端埋点回传
 *
 * 目前只收一类事件：闸3 拦截。
 *
 * 为什么需要它 —— 三道闸里，闸1 和闸2 都跑在服务端，trace 里天然有记录；
 * 只有闸3 跑在用户的浏览器里。如果不回传，那么「有多少用户其实看到了降级块」
 * 这个问题就只能靠猜，而它恰恰是灰度期最该盯的指标之一（渲染成功率）。
 *
 * 刻意做得很轻：不做鉴权以外的校验、不落用户标识、失败也不重试。
 * 埋点回传本身不该成为新的故障源 —— 它挂了，客服对话必须照常。
 */

import { resolveUserId } from "@/core/auth";
import { writeAudit } from "@/core/trace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.type !== "string") {
    return Response.json({ ok: false }, { status: 400 });
  }

  writeAudit({
    kind: "client_telemetry",
    type: body.type,
    correlationId: body.correlationId,
    component: body.component,
    componentVersion: body.componentVersion,
    instanceId: body.instanceId,
    reason: typeof body.reason === "string" ? body.reason.slice(0, 200) : undefined,
    // 只记到「是谁」这一层，不记任何前端内容
    userId: resolveUserId(request),
  });

  return Response.json({ ok: true });
}
