/**
 * 按 correlationId 查回一轮完整 trace
 *
 * 这个端点存在的唯一理由是演示「correlationId 贯穿全链路」到底是什么意思：
 * 用户在界面上看到的是一句回答和一个卡片，工程师拿着那个 ID，
 * 能看到这一轮在服务端经历了什么 —— 意图识别花了多久、闸1 试了几次、
 * 工具查的哪个接口、闸2 有没有拦过东西、闸3 有没有被前端报回来。
 *
 * 只读、按 ID 精确查、不提供列表 —— 审计日志里全是用户行为，
 * 一个能翻页浏览的接口比一个按 ID 查的接口危险得多。
 */

import { readAudit } from "@/core/trace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const correlationId = new URL(request.url).searchParams.get("correlationId");
  if (!correlationId) {
    return Response.json({ error: "缺少 correlationId" }, { status: 400 });
  }

  const records = readAudit(correlationId);
  return Response.json({ correlationId, count: records.length, records });
}
