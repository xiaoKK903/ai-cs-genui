/**
 * 入口闸门 —— chat 和 action 两条路共用
 *
 * 抽出来的理由和 dispatch.ts 完全一样：这两条路最后都要落到同一批资源上
 * （一次模型调用、一次取数、一条 SSE 连接），限制写在一边、另一边漏掉的话，
 * 「按钮那条路没有限流」就是个只有被刷的时候才会发现的洞。
 *
 * 两层限制的定位：
 *   限流（按会话）—— 防单个用户刷。HTTP 层直接拒绝，连流都不开。
 *   并发闸（全局）—— 防整体过载。放在流里面，见下面对「为什么不能放外面」的说明。
 */

import { chatRateLimiter, turnGate } from "../runtime";
import type { SSEEmitter } from "./sse";

/**
 * 按会话限流。超过则返回一个 429 响应，调用方直接 return 它。
 *
 * 键用 sessionId 而不是 userId：一个人开了两个标签页就是两个会话，
 * 各自独立配额是合理的 —— 我们想挡的是「一个会话疯狂发」，不是「一个人用得多」。
 */
export function rateLimitResponse(sessionId: string, correlationId: string): Response | null {
  if (chatRateLimiter.tryAcquire(sessionId)) return null;
  return Response.json(
    { error: "消息发得太快了，缓一下再问", correlationId, retryAfterMs: 2_000 },
    { status: 429, headers: { "Retry-After": "2" } },
  );
}

/**
 * 占用一个并发槽位跑这一轮，结束自动释放。
 *
 * **必须在 SSE 流内部调用，不能提到 HTTP 层去。** 原因是连接数超限时
 * sseResponse 会直接返回 503、根本不执行 run —— 如果槽位是在外面占的，
 * 这一次就会被永久泄漏。泄漏几个槽位不致命，但它只在流量高峰出现，
 * 表现为「明明没人用却一直说忙」，是那种查一整天也查不出来的故障。
 */
export async function withTurnSlot(
  emit: SSEEmitter,
  correlationId: string,
  work: () => Promise<void>,
): Promise<void> {
  if (!turnGate.tryEnter()) {
    emit.send("error", {
      code: "SERVER_BUSY",
      message: "当前咨询的人有点多，稍等几秒再问我一次？",
      correlationId,
      recoverable: true,
    });
    return;
  }
  try {
    await work();
  } finally {
    turnGate.leave();
  }
}
