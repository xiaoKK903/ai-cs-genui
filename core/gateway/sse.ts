/**
 * SSE 传输层
 *
 * 文档 3.3 已经答过「为什么不换 WebSocket」：客服是单向为主的问答流，
 * action 回填走一次普通 POST 就够，不值得为此引入连接、心跳、重连三套复杂度。
 *
 * 这里只做一件事：把「要发什么事件」和「怎么写成 SSE 帧」分开。
 * 上层代码只管 emit.send("component", envelope)，不需要知道 data 要 JSON.stringify、
 * 帧尾要两个换行。
 */

import type { SSEEventName, SSEEventPayloadMap } from "../protocol/types";

export interface SSEEmitter {
  send<K extends SSEEventName>(event: K, data: SSEEventPayloadMap[K]): void;
  /** 流是否已经结束（客户端断开或主动 close） */
  readonly closed: boolean;
}

/**
 * 包装一个 SSE 响应。
 *
 * 两个容易被忽略的点：
 *
 *   1. **兜底不能省**。run 里任何一处未捕获的异常，如果不在这里转成一条 error 事件，
 *      浏览器看到的是流被截断 —— 前端状态机停在 Streaming 不动，输入框永远不解锁。
 *      一条 error 比一次静默断流好得多。
 *   2. **不主动心跳**。这一轮响应通常在秒级结束，加心跳只会让前端状态机多一种要处理
 *      的事件。真要做长连接保活，应该由网关层统一处理，而不是散在每个 route 里。
 */
export function sseResponse(
  correlationId: string,
  run: (emit: SSEEmitter) => Promise<void>,
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const emit: SSEEmitter = {
        get closed() {
          return closed;
        },
        send(event, data) {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            // controller 已关闭（客户端断开）—— 标记后静默丢弃后续事件
            closed = true;
          }
        },
      };

      try {
        await run(emit);
      } catch (err) {
        emit.send("error", {
          code: "TURN_FAILED",
          message: err instanceof Error ? err.message : "服务出了点问题",
          correlationId,
          // 可恢复：前端降级为文本即可，不需要用户刷新页面重来一遍
          recoverable: true,
        });
      } finally {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // 已经关了，忽略
          }
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // 挡在中间的 Nginx 默认会缓冲响应，这对 SSE 是致命的 —— 事件会攒到连接关闭才一次吐出，
      // 打字机效果和骨架屏时序全部失效。这一行让代理直接透传。
      "X-Accel-Buffering": "no",
    },
  });
}
