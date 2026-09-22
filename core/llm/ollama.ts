/**
 * Ollama 适配器（本地模型，通过 LLM_PROVIDER=ollama 启用）
 *
 *   ollama pull qwen2.5:3b
 *   LLM_PROVIDER=ollama npm run dev
 *
 * ## 它为什么存在
 *
 * 这个仓库的适配器接口一直写着「可插拔」，但在这之前只有 mock 和 Anthropic
 * 两个实现，而后者需要密钥、要花钱、跑在别人的服务器上 —— 也就是「接口能不能
 * 换一个完全不同的模型实现」这件事，一直没有在**能跑**的状态下被验证过。
 * 加这一条是为了让那句话可执行：一个不同的传输协议（HTTP + NDJSON 流）、
 * 不同的工具 schema 格式（OpenAI 风格）、不同的 usage 字段，套进同一个
 * `LLMAdapter` 之后，下游的三道闸、工具执行、SSE 网关卡一行都不用改。
 *
 * ## 和 Anthropic 那条路的两处实质差别（不是笔误）
 *
 * ① **工具调用这条路没有约束解码。** 这一条要说准，因为它很容易被说过头：
 *    Ollama **确实**有 schema 约束解码 —— `/api/chat` 的 `format` 参数可以给一份
 *    JSON Schema，实测输出会严格贴着它（作者验过：给 `{orderNo: string}`，
 *    回来就是 `{"orderNo": "ABC123456789"}`）。但那约束的是 `content`，
 *    **不是 `tool_calls` 通道** —— 没有等价于 Anthropic `strict: true` 的东西
 *    能保证「工具名和参数一定符合 Schema」。
 *    所以在这条路上，工具参数的正确性只能靠闸1 的本地校验兜，
 *    它从「第二道」被逼成了**唯一**一道。这不是缺点，是个更有价值的测试姿态。
 *
 *    ⚠️ 但「逼成了主防线」是个**设计后果，不是已观察到的现象**：见下面那条
 *    关于 3B 模型的说明 —— 它压根产不出结构化的工具调用，所以闸1 在真机上
 *    还没被真正考验过。
 *
 * ② **没有 refusal 这类结构化终止原因。** Anthropic 的 `stop_reason` 能区分
 *    「说完了」「被截断了」「拒答了」，三种走三条不同的路。Ollama 只给一个
 *    `done_reason`（通常是 `stop` / `length`）。所以这里只能保守处理：`length`
 *    当成截断，其余的「拒答」识别不了 —— 小模型的拒答通常就是一句普通文本。
 *
 * ## 这个文件里哪些分支真机验过、哪些只验过桩（作者实测记录）
 *
 * 真机上验过的：NDJSON 按行读、`prompt_eval_count` / `eval_count` 两个 usage
 * 字段名、`done_reason`、请求形状（`/api/chat` + `stream: true` + OpenAI 风格
 * `tools`）—— `npm run check:model` 跑通一轮，usage 记到 782 in / 28 out。
 *
 * **真机上没验过的：工具调用那条路。** qwen2.5:3b 在这套 system prompt + 四个
 * 工具下，产不出结构化的 `tool_calls`（返回 `null`），而是把 Qwen 的原生标记
 * 当普通文本吐进 `content`：
 *
 *     <tools>
 *     {"name": show_order_table, "arguments": <args{"timeRange": "last30d", ...}}>}
 *
 * 模板本身是对的（`/api/show` 里 `.Tools` 段齐全，`capabilities` 含 `tools`），
 * 是模型没照着它给的 `<tool_call>` 格式写 —— 属于模型能力，不是协议问题。
 * 后果是：`normalizeArguments`、按序号归并 `calls`、合成调用 ID 这几段，
 * 在真机上全是**死代码**，只有注入的桩在跑它们。别把它读成「真机验过了」。
 *
 * ## 小模型跑评测的意义要说清楚
 *
 * 3B 模型跑这个评测集，分数**不会**好看，而且不该被拿来当成绩。
 * 尤其要小心一种误读：**「链路能通」这句话在 3B 上只兑现了一半** ——
 * 通的是「请求发得出、流读得回、SSE 收得尾、usage 记得到」，
 * 没通的是「工具真的被调用了、信封真的渲染了」（原因见上）。
 * 拿它的通过率当代码好坏的证据，或者当「工具链路验过了」的证据，都是把
 * 两件事混在一起 —— 而后者更危险，因为它看起来像是验过了。
 */

import { toApiTools } from "../tools/definitions";
import type { LLMAdapter, LLMDecision, LLMHandlers, LLMRequest, LLMToolCall } from "./adapter";
import { LLMUnavailableError } from "./anthropic";

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "qwen2.5:3b";

/**
 * 超时默认值。**必须严格小于网关那边的 `TIMEOUTS.llm` 默认值（30s）**，
 * 这个顺序不是风格问题，是这段代码能不能起作用的开关。
 *
 * 两道超时是嵌套的：外层是网关的 `withTimeout(…, TIMEOUTS.llm)`，内层是这里的
 * `OLLAMA_TIMEOUT_MS`。哪个先到，决定了用户看到的是哪条错误 ——
 * 而只有内层这条知道「这是本地模型」，也只有它能给出那句可执行的提示
 * （把超时调大 / 模型还在加载权重）。外层先到的话，用户拿到的是一句
 * 「llm.decide 超过 30000ms 未返回」—— 正确，但完全没法照着做。
 *
 * 第一版把这里写成 60s（大于外层的 30s），于是**默认配置下这条分支永远不会执行**：
 * 内层超时是一段死代码，写好的提示一句都到不了用户面前。selftest 里那条
 * 「超时中止抛 LLMUnavailableError」之所以没拦住它，是因为用例显式注入了 120ms ——
 * 测试验的是分支本身对不对，而默认值之间的关系错了。
 *
 * 所以：本地模型要跑得动，两个都要调大，且始终满足
 * `OLLAMA_TIMEOUT_MS < LLM_TIMEOUT_MS`（`.env.example` 里给了成对的例子）。
 */
export const DEFAULT_TIMEOUT_MS = 25_000;

/**
 * 当前配置下实际生效的超时。抽出来是为了让上面那条「必须小于外层」的约束
 * **可以被断言**——用默认值比默认值只能验出厂配置，验不了用户改过之后的现场。
 */
export function resolveTimeoutMs(): number {
  return Number(process.env.OLLAMA_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
}

/**
 * 温度固定 0，不给环境变量。
 *
 * 理由是这条路的用途就是「可复现地跑一遍链路」：温度调上去之后，同一个用例
 * 每次跑出来的分数不一样，那 eval 的回归对比就失去了基线 ——「这次比上次低了
 * 3 个点」到底是改了代码还是模型这次手气不好，分不出来。
 *
 * 但要说清楚：**温度 0 不等于确定**。换一次模型版本、换一次量化、甚至换个后端，
 * 输出都可能变。它只是把「同一进程内的随机性」压掉，不提供跨版本的可复现性。
 */
const TEMPERATURE = 0;

/* ============================================================
   协议形状
   ============================================================ */

interface OllamaToolCall {
  function?: { name?: string; arguments?: unknown };
}

interface OllamaChunk {
  message?: { content?: string; thinking?: string; tool_calls?: OllamaToolCall[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/** OpenAI 风格的函数定义。Ollama 不吃 Anthropic 的 `input_schema` + `strict`。 */
function toOllamaTools(): { type: "function"; function: { name: string; description: string; parameters: unknown } }[] {
  return toApiTools().map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

/**
 * 工具调用参数的归一化。
 *
 * 这里有一个**真实存在的不一致**：不同后端（以及 Ollama 的不同版本）对
 * `arguments` 的返回形状不统一 —— 多数给的是已经解析好的对象，但按 OpenAI
 * 的流式规范它应该是一个 JSON **字符串**（流式下要能半截半截地拼）。
 * 两种都要吃。
 *
 * 而「拼不出来的 JSON 怎么办」这个决定更要紧：**不在这里修，也不吞掉**，
 * 当成空参数交给闸1 —— 必填字段缺失会被闸1 拒，拒了走重试或降级，
 * 用户拿到一句人话。
 *
 * 反过来做（在这里 try/catch 后补一个默认订单号之类）才是错的：那等于替模型
 * 把参数编出来，而这个仓库从头到尾的原则就是「模型不给数字，数字来自业务系统」。
 */
function normalizeArguments(raw: unknown): Record<string, unknown> {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* 落到下面：交给闸1 拒 */
    }
  }
  return {};
}

/* ============================================================
   适配器
   ============================================================ */

export interface OllamaOptions {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  /**
   * 注入传输层，测试用；缺省是全局 fetch。
   *
   * 这个口子和可观测性那边的 `sinkOverride` 是同一个理由：**没有它，这个文件里
   * 最容易出错的那部分逻辑就观察不到**。按行切 NDJSON 的边界处理只在
   * 「一个 JSON 对象横跨两个 chunk」时才起作用 —— 而那要靠网络恰好那么切，
   * 真模型跑一万次都未必撞上一次。`arguments` 是字符串而不是对象的那条分支同理：
   * 本机 Ollama 永远给对象，那条分支在真机上是死代码。
   *
   * 「真机没走过」和「逻辑不对」是两回事，但后果一样。这两条分支必须能被喂进去
   * 验一遍，而那只能靠注入。
   */
  fetchImpl?: typeof fetch;
}

export function createOllamaAdapter(opts: OllamaOptions = {}): LLMAdapter {
  const baseUrl = (opts.baseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = opts.model ?? process.env.LLM_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? resolveTimeoutMs();
  const doFetch = opts.fetchImpl ?? fetch;

  return {
    name: `ollama:${model}`,

    async decide(req: LLMRequest, handlers?: LLMHandlers): Promise<LLMDecision> {
      const messages = [
        { role: "system", content: req.system },
        ...req.history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: req.userText },
      ];

      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);

      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: ctl.signal,
          body: JSON.stringify({
            model,
            messages,
            tools: toOllamaTools(),
            stream: true,
            options: { temperature: TEMPERATURE },
          }),
        });
      } catch (err) {
        clearTimeout(timer);
        throw new LLMUnavailableError(
          `连不上本地 Ollama（${baseUrl}）。确认它在跑：ollama serve —— 或者改回 LLM_PROVIDER=mock。`,
          err,
        );
      }

      if (!res.ok || !res.body) {
        clearTimeout(timer);
        const detail = await res.text().catch(() => "");
        // 404 通常就是模型没拉。把这句话原样带出来，省得人去猜。
        const hint = res.status === 404 ? `（模型没下载？ollama pull ${model}）` : "";
        throw new LLMUnavailableError(`Ollama 返回 ${res.status}${hint} ${detail.slice(0, 200)}`);
      }

      let text = "";
      /** 按出现顺序收，键是调用序号 —— 流式下同一个调用的参数可能分片到达 */
      const calls = new Map<number, LLMToolCall>();
      let usage: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 };
      let doneReason = "";

      function absorb(line: string): void {
        let chunk: OllamaChunk;
        try {
          chunk = JSON.parse(line) as OllamaChunk;
        } catch {
          // 一行坏报文不该让整轮挂掉：丢掉它，继续读后面的。数据已经流了一部分
          // 给用户了，这时候抛错只会把一次能救的对话变成一次降级。
          return;
        }
        if (chunk.error) throw new LLMUnavailableError(`Ollama 报错：${chunk.error}`);

        const delta = chunk.message?.content ?? "";
        if (delta !== "") {
          text += delta;
          handlers?.onTextDelta?.(delta);
        }

        // thinking 刻意不转发（qwen3 这类会带这个字段），理由和 Anthropic
        // 那条一样：模型在纠结用哪个工具，是给 trace 看的，不是给用户看的。
        for (const [i, call] of (chunk.message?.tool_calls ?? []).entries()) {
          const name = call.function?.name ?? "";
          if (name === "") continue;
          // 同一序号以最后一次为准：小模型偶尔会把同一个调用报两遍。
          calls.set(i, {
            // Ollama 不给调用 ID，这里自己编一个。trace 里需要一个能和模型侧对账的
            // 稳定标识，而「模型没给」不等于「这一轮没有调用」—— 空字符串会让
            // trace 里所有调用长得一样，按 ID 反查就失效了。
            id: `ollama_call_${String(i + 1).padStart(2, "0")}`,
            name,
            input: normalizeArguments(call.function?.arguments),
          });
        }

        if (chunk.done) {
          doneReason = chunk.done_reason ?? "";
          usage = { inputTokens: chunk.prompt_eval_count ?? 0, outputTokens: chunk.eval_count ?? 0 };
        }
      }

      try {
        // NDJSON：一行一个 JSON 对象。**不是 SSE** —— 没有 `data:` 前缀，也没有
        // 事件名。拿 SSE 的解析器来读它，第一行就会卡住。
        //
        // 按行切而不是按 chunk 切：网络给的 chunk 边界和「一行」没有任何关系，
        // 一个 JSON 对象可能横跨两个 chunk。这是自己解析流式协议最容易漏的一条，
        // 而且它只在长响应上偶发 —— 短回复永远撞不到，所以不会被日常使用发现。
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl = buffer.indexOf("\n");
          while (nl !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line !== "") absorb(line);
            nl = buffer.indexOf("\n");
          }
        }
        // 最后一行可能没有换行符收尾。丢掉它等于丢掉 done 和 usage ——
        // 而 usage 丢了会静默地把成本记账记成 0。
        if (buffer.trim() !== "") absorb(buffer.trim());
      } catch (err) {
        // 走到这里只剩两类：超时中止（abort → AbortError），以及 absorb 里
        // 那个 `chunk.error`。**必须转成 LLMUnavailableError** ——
        // 网关只认这个错误类型来触发降级，漏出去一个裸的 AbortError，
        // 用户拿到的就不是「稍后再试」而是一次没有兜底的失败。
        if (err instanceof LLMUnavailableError) throw err;
        throw new LLMUnavailableError(
          `本地模型在 ${timeoutMs}ms 内没读完（CPU 上第一次要加载权重，把 OLLAMA_TIMEOUT_MS 调大一点再试），本轮降级为文本回复。`,
          err,
        );
      } finally {
        clearTimeout(timer);
      }

      // 截断必须查在执行工具之前 —— 参数可能是半截的，交给闸1 拒也行，
      // 但那等于让一个「本来就是坏事」的请求多走一圈。
      if (doneReason === "length") {
        throw new LLMUnavailableError("模型输出被长度上限截断，本轮降级为文本回复。");
      }

      return { text, toolCalls: [...calls.values()], usage };
    },
  };
}

/** 缺省实例。名字里带模型名，评测报告里一眼能看出这一轮跑的是哪个。 */
export const ollamaAdapter: LLMAdapter = createOllamaAdapter();
