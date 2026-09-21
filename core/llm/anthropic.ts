/**
 * Anthropic 适配器（需配置 ANTHROPIC_API_KEY，通过 LLM_PROVIDER=anthropic 启用）
 *
 * 与 mock 适配器的契约完全一致，差别只在于「谁来做意图识别」。
 *
 * 几处实现上的取舍：
 *   - **流式**：文本边收边推，用户不必等模型说完才看到第一个字。工具调用参数用
 *     eager_input_streaming 边生成边解析，大参数不会在服务端buffer满了一次性吐出来。
 *   - **adaptive thinking**：工具选择属于「需要想一下」的判断（三个语义相近的工具要区分），
 *     开思考对准确率的收益大于延迟成本。用 LLM_THINKING=off 可关掉做对照。
 *   - **strict 工具定义**：input_schema 上的 strict 让服务端按 Schema 约束解码，
 *     这是闸1「约束解码」真正落地的地方 —— 闸1 的本地校验是它失手时的第二道。
 *   - **不设 temperature**：开了 thinking 之后它不生效，设了反而让人误以为能调。
 */

import Anthropic from "@anthropic-ai/sdk";
import { toApiTools } from "../tools/definitions";
import type { LLMAdapter, LLMDecision, LLMHandlers, LLMRequest, LLMToolCall } from "./adapter";

const MODEL = process.env.LLM_MODEL ?? "claude-opus-5";
const MAX_TOKENS = 2048;
const THINKING_ENABLED = (process.env.LLM_THINKING ?? "on") !== "off";

export class LLMUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "LLMUnavailableError";
  }
}

let cached: Anthropic | null = null;

function getClient(): Anthropic {
  if (cached) return cached;
  try {
    // 构造时会读 ANTHROPIC_API_KEY，缺失则直接抛错 —— 早失败好过第一次请求才失败
    cached = new Anthropic();
  } catch (err) {
    throw new LLMUnavailableError(
      "未找到 ANTHROPIC_API_KEY，无法启用真模型。可以改回 LLM_PROVIDER=mock 使用确定性演示。",
      err,
    );
  }
  return cached;
}

export const anthropicAdapter: LLMAdapter = {
  name: `anthropic:${MODEL}`,

  async decide(req: LLMRequest, handlers?: LLMHandlers): Promise<LLMDecision> {
    const client = getClient();

    const messages: Anthropic.MessageParam[] = [
      ...req.history.map((m) => ({ role: m.role, content: m.content }) as Anthropic.MessageParam),
      { role: "user", content: req.userText },
    ];

    const tools = toApiTools().map((t) => ({ ...t, eager_input_streaming: true }));

    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: req.system,
      messages,
      tools: tools as Anthropic.ToolUnion[],
      ...(THINKING_ENABLED ? { thinking: { type: "adaptive" as const } } : {}),
    });

    // 只转发正文增量。thinking 的 delta 走另一个事件，不会混进来 ——
    // 用户看见「模型在纠结用哪个工具」没有意义，那是给 trace 看的东西。
    stream.on("text", (delta) => handlers?.onTextDelta?.(delta));

    let message: Anthropic.Message;
    try {
      message = await stream.finalMessage();
    } catch (err) {
      throw new LLMUnavailableError("模型调用失败，本轮降级为文本回复。", err);
    }

    // 截断与拒答必须先查再执行工具：max_tokens 截断时 tool_use 的参数可能是半截的，
    // 交给闸1 去拒当然也行，但那等于让一个「本来就是坏事」的请求多走一圈。
    if (message.stop_reason === "max_tokens") {
      throw new LLMUnavailableError("模型输出被 max_tokens 截断，本轮降级为文本回复。");
    }
    if (message.stop_reason === "refusal") {
      return {
        text: "这个问题我不太方便回答，换个说法我们再试试？订单、退款这类事我都能直接办。",
        toolCalls: [],
      };
    }

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const toolCalls: LLMToolCall[] = message.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({
        id: b.id,
        name: b.name,
        input: (b.input ?? {}) as Record<string, unknown>,
      }));

    return { text, toolCalls };
  },
};
