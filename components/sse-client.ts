/**
 * SSE 客户端
 *
 * 用 fetch + ReadableStream 而不是 EventSource。原因很直接：EventSource 只支持 GET，
 * 而我们的对话要把消息正文放进请求体 —— 塞进 query string 会让用户的问题出现在
 * 各级访问日志里。代价是得自己解析帧，一共三十行。
 *
 * 解析规则按规范来：空行分隔帧，`:` 开头是注释（心跳），同一帧可以有多行 `data:`
 * 需要拼起来 —— 最后这条容易被忽略，模型输出的长文本里带换行时就会踩到。
 */

export interface SSEEvent {
  event: string;
  data: Record<string, unknown>;
}

export async function streamSSE(
  url: string,
  body: unknown,
  onEvent: (ev: SSEEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`请求失败（HTTP ${res.status}）${detail.slice(0, 120)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const ev = parseFrame(frame);
      if (ev) onEvent(ev);
    }
  }

  // 服务端正常收尾时最后一帧一定带空行，但连接被中断时可能留下半帧 ——
  // 能解析就解析，解析不了就丢，不让它把整轮结果带走。
  const tail = parseFrame(buffer);
  if (tail) onEvent(tail);
}

function parseFrame(frame: string): SSEEvent | null {
  let event = "message";
  const dataLines: string[] = [];

  for (const raw of frame.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.length === 0 || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> };
  } catch {
    return null;
  }
}
