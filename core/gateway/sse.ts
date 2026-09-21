/**
 * SSE 传输层
 *
 * 文档 3.3 已经答过「为什么不换 WebSocket」：客服是单向为主的问答流，
 * action 回填走一次普通 POST 就够，不值得为此引入连接、心跳、重连三套复杂度。
 *
 * 这里只做一件事：把「要发什么事件」和「怎么写成 SSE 帧」分开。
 * 上层代码只管 emit.send("component", envelope)，不需要知道 data 要 JSON.stringify、
 * 帧尾要两个换行。
 *
 * ## 第四阶段补上的两件事（H1）
 *
 * 这一层原本写着「不主动心跳，因为这一轮响应通常在秒级结束」。这句话在
 * **mock 下成立，在真模型下不成立** —— 开了 thinking 的一次往返可以十几秒，
 * 中间一个字节都不发。这段时间里，中间任何一跳（Nginx、云负载均衡、公司代理）
 * 都会认为这是一条闲置连接并把它掐掉，用户看到的是「说到一半没了」。
 *
 * 心跳和连接数上限是同一件事的两面：心跳让**单条**连接活得够久，
 * 上限保证**很多条**连接不会一起把我们拖住。
 * 两者都不是功能，是让功能在真实网络里能跑起来的前提。
 */

import type { SSEEventName, SSEEventPayloadMap } from "../protocol/types";

export interface SSEEmitter {
  send<K extends SSEEventName>(event: K, data: SSEEventPayloadMap[K]): void;
  /** 流是否已经结束（客户端断开或主动 close） */
  readonly closed: boolean;
}

/* ============================================================
   连接数保护
   ============================================================ */

let activeConnections = 0;
let rejectedConnections = 0;

function maxConnections(): number {
  const n = Number(process.env.MAX_SSE_CONNECTIONS);
  return Number.isFinite(n) && n > 0 ? n : 128;
}

function heartbeatMs(): number {
  const n = Number(process.env.SSE_HEARTBEAT_MS);
  if (Number.isFinite(n) && n >= 0) return n;
  return 15_000;
}

export function sseStats(): { active: number; rejected: number; limit: number } {
  return { active: activeConnections, rejected: rejectedConnections, limit: maxConnections() };
}

/** 仅测试用 */
export function __resetSseStats(): void {
  activeConnections = 0;
  rejectedConnections = 0;
}

/* ============================================================
   响应构造
   ============================================================ */

/**
 * 包装一个 SSE 响应。
 *
 * 三个容易被忽略的点：
 *
 *   1. **兜底不能省**。run 里任何一处未捕获的异常，如果不在这里转成一条 error 事件，
 *      浏览器看到的是流被截断 —— 前端状态机停在 Streaming 不动，输入框永远不解锁。
 *      一条 error 比一次静默断流好得多。
 *   2. **心跳发的是注释帧**（`:` 开头），不是一个命名事件。这样客户端不需要为它
 *      加任何分支 —— 按规范注释行本就被忽略，前端那三十行解析器一行都不用改。
 *   3. **连接数超限时拒绝的是新连接，不是踢掉老连接**。踢老连接会让已经在看答案的
 *      用户突然断掉；拒绝新连接只影响刚要开始的那个，而且他能重试。
 *      宁可让后来者等一下，也不打断正在进行的人。
 */
export function sseResponse(
  correlationId: string,
  run: (emit: SSEEmitter) => Promise<void>,
): Response {
  const limit = maxConnections();
  if (activeConnections >= limit) {
    rejectedConnections += 1;
    // 503 + Retry-After 而不是 429：这是「我这边满了」，不是「你发太快了」，
    // 两者的重试语义不同 —— 前者该等，后者该收敛。
    return Response.json(
      {
        error: "当前对话连接已满，请稍后重试",
        correlationId,
        retryAfterMs: 2_000,
      },
      { status: 503, headers: { "Retry-After": "2" } },
    );
  }

  activeConnections += 1;
  const encoder = new TextEncoder();
  const beatMs = heartbeatMs();

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

      // 心跳：模型思考期间（尤其是开了 thinking 的那十几秒）靠它把连接焐热，
      // 免得被中间某一跳当成闲置连接掐掉
      const beat =
        beatMs > 0
          ? setInterval(() => {
              if (closed) return;
              try {
                controller.enqueue(encoder.encode(`: keepalive\n\n`));
              } catch {
                closed = true;
              }
            }, beatMs)
          : undefined;

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
        if (beat) clearInterval(beat);
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // 已经关了，忽略
          }
        }
        activeConnections = Math.max(0, activeConnections - 1);
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
