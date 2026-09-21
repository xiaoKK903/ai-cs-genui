/**
 * LLM 适配器接口
 *
 * 默认走确定性 mock（不联网、不花钱、结果可复现），配置 ANTHROPIC_API_KEY 后
 * 切到真模型。两条路径产出同一个结构，下游（三道闸、工具执行、SSE 网关）完全无感。
 *
 * 为什么把「可插拔」当成第一等设计而不是事后补：因为**评测必须先于模型可信**。
 * 如果 mock 和真模型不是同一个接口，那么 eval 跑出来的通过率就只对其中一条路径成立，
 * 换模型时的回归验证等于从零开始。
 *
 * 一个刻意的收敛：适配器只跑**一轮**，不把工具执行结果回灌给模型。
 * 这是架构决定的 —— 工具返回的是「给用户看的组件」，不是「给模型看的中间结果」，
 * 模型不需要看到订单行就能决定下一步该做什么。将来若出现真正需要多步推理的场景
 * （比如「把我上次退的那单再退一次」需要先查历史），在 decide 内部加 tool_result
 * 回灌循环即可，对上层接口没有影响。
 */

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMRequest {
  system: string;
  history: LLMMessage[];
  userText: string;
}

export interface LLMToolCall {
  /** 模型自报的调用 ID，写进 trace 便于与模型侧日志对账 */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LLMDecision {
  /** 面向用户的文本。只调工具时可以是一句过渡语，也可以为空 */
  text: string;
  toolCalls: LLMToolCall[];
  /**
   * 本轮消耗的 token。可选项，因为不是所有适配器都报得出来 ——
   * mock 就没有这个数（它不花任何钱，报一个编出来的数只会污染成本看板）。
   * 缺失时按 0 记账，宁可少记也不要记一个假的。
   */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LLMHandlers {
  /** 文本增量回调。网关在这里把 delta 立刻推成 SSE text_delta */
  onTextDelta?: (delta: string) => void;
}

export interface LLMAdapter {
  readonly name: string;
  decide(req: LLMRequest, handlers?: LLMHandlers): Promise<LLMDecision>;
}
