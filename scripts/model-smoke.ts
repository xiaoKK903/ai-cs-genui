/**
 * 真模型冒烟 —— 「换一个模型实现，链路还通不通」
 *
 * 跑法：
 *   ollama pull qwen2.5:3b
 *   npm run build && npm run check:model
 *
 * 也可以指到云端那条路（需要密钥）：
 *   LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-... npm run check:model
 *
 * ## 它验的**不是**模型准不准
 *
 * 这条界限必须画在最前面，否则这个脚本很容易被读成「模型测过了」。
 * 它验的是四件**跟模型能力无关**的事：
 *
 *   1. 适配器装上之后，生产进程能起来、一轮能跑完、SSE 流能不挂地收尾。
 *   2. **provider 真的换过去了** —— trace 里记的是 `ollama:xxx`，不是 mock。
 *      这是全套断言里最要紧的一条：拼错的名字、没生效的环境变量、
 *      静默回退，全都会让这一轮跑出一个漂亮的 mock 结果，而人以为那是模型。
 *   3. **usage 记到了数**。真模型的 token 数必须是非 0 —— 为 0 只有一个解释：
 *      适配器读 usage 的字段名是猜的（`prompt_eval_count` / `eval_count`
 *      这种字段名抄错一个字母不会有任何报错，只会让成本记账静默变 0）。
 *   4. 模型没选对工具时，链路是**降级**而不是崩掉。
 *
 * 至于「模型选得对不对」——那是 eval 的事，而且 3B 模型选不准是正常的。
 * 所以这一轮的实际结果（渲染了组件还是降级了）**只打印，不判红**。
 * 一个把「小模型没选对」判成失败的脚本，会让人以为代码坏了。
 */

export {};

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${detail ? ` —— ${detail}` : ""}`);
  if (!cond) failed += 1;
}
/** 只报数，不判红 —— 用于「模型这次表现如何」这类不该由脚本定性的东西 */
function note(label: string, value: string): void {
  console.log(`  · ${label}：${value}`);
}

if (!existsSync(join(process.cwd(), ".next", "BUILD_ID"))) {
  console.error("没有找到 .next/BUILD_ID —— 先跑 `npm run build`。");
  process.exit(1);
}

const provider = (process.env.LLM_PROVIDER ?? "ollama").trim();
const model = process.env.LLM_MODEL ?? (provider === "ollama" ? "qwen2.5:3b" : "claude-opus-5");

if (provider === "mock") {
  console.error("这个脚本是给真模型用的。跑 mock 请用 `npm run check:deploy`。");
  process.exit(1);
}

/**
 * 本地模型的超时，两个必须成对给，且适配器那个要**更小**。
 *
 * 这两道超时是嵌套的：网关的 `withTimeout(…, LLM_TIMEOUT_MS)` 在外，
 * 适配器的 `OLLAMA_TIMEOUT_MS` 在内。CPU 上跑 3B，光是把 system prompt
 * 加四个工具定义读进去就要十几秒，网关那个 30s 默认值不够用 —— 而不够用的
 * 后果是外层先超时，用户拿到一句「llm.decide 超过 30000ms 未返回」，
 * 那是**正确但没法照着做**的错误。
 *
 * 这里给的是「够跑完」的值，不改仓库的默认值 —— 默认值面向的是云端模型，
 * 30s 对它是合理的。真实部署要按自己的机器调这两个数。
 * 用户自己设了就不覆盖，免得这个脚本把现场配置盖掉。
 */
const localTimeouts =
  provider === "ollama"
    ? { llm: process.env.LLM_TIMEOUT_MS ?? "180000", ollama: process.env.OLLAMA_TIMEOUT_MS ?? "150000" }
    : null;

const appPort = 3500 + Math.floor(Math.random() * 100);
const child = spawn(
  process.execPath,
  [join("node_modules", "next", "dist", "bin", "next"), "start", "-p", String(appPort)],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      LLM_PROVIDER: provider,
      ...(localTimeouts ? { LLM_TIMEOUT_MS: localTimeouts.llm, OLLAMA_TIMEOUT_MS: localTimeouts.ollama } : {}),
      // 输出目录固定，不要用开发时那份：冒烟会往库里写会话
      DB_PATH: "data/model-smoke.db",
      MOCK_STREAM_DELAY_MS: "0",
      MOCK_TOOL_DELAY_MS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let stderr = "";
child.stdout.on("data", () => {});
child.stderr.on("data", (c) => (stderr += c));

const base = `http://127.0.0.1:${appPort}`;
const startedAt = Date.now();

/**
 * 等就绪的超时给得比部署检查长得多。
 *
 * CPU 上跑 3B，第一次请求要把权重读进内存 —— 冷启动十几秒到一分钟都正常。
 * 拿部署检查那个 30s 来量这条路，会把「模型还在加载」误判成「服务起不来」，
 * 而这两件事的处理方式完全不同（一个等，一个查）。
 */
async function waitReady(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(base, { signal: AbortSignal.timeout(2000) });
      if (res.status > 0) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

console.log(`\n真模型冒烟 · provider=${provider} · model=${model}\n`);
if (localTimeouts) {
  note("本轮超时", `网关 LLM_TIMEOUT_MS=${localTimeouts.llm}ms · 适配器 OLLAMA_TIMEOUT_MS=${localTimeouts.ollama}ms（内层更小，超时提示才到得了用户）`);
}

const ready = await waitReady(90_000);
check("生产进程能起来（真模型适配器装进去之后，构建产物还是能跑）", ready, ready ? `端口 ${appPort}` : stderr.slice(0, 300));
if (!ready) {
  child.kill();
  console.log(`\n失败：${failed} 项\n`);
  process.exit(1);
}

/** 一轮的完整 SSE 读到底。模型慢，超时给宽 */
async function runRound(
  message: string,
  sessionId: string,
): Promise<{ stream: string; events: string[]; correlationId: string; assistantText: string }> {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, message }),
  });
  let stream = "";
  let assistantText = "";
  /** 已经消费到 stream 的哪个位置 —— 每次读回来的是**整个** stream，不记住就会重复累加 */
  let consumed = 0;
  const deltaRe = /"delta":"((?:[^"\\]|\\.)*)"/g;
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  // 必须比上面那对超时**更宽**，否则先撞到的是这里的读超时，
  // 于是你会看到「什么都没发生」而看不到服务端给的降级原因 —— 又是同一个顺序问题。
  const deadline = Date.now() + 240_000;
  while (reader && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    stream += decoder.decode(value, { stream: true });

    // 顺手把文本增量拼起来。**这是为了消歧**：模型没产出工具调用时，
    // 「它老老实实回了句人话」和「它想调但格式写错了、于是解析器什么都没拿到」
    // 在 trace 里长得一模一样（都是 text-only、闸1 一次通过）。只报
    // 「没调工具」的话，后者会被当成前者放过去 —— 而后者说明适配器可能有 bug。
    // 把模型的原话打出来，这两种情况一眼就能分开。
    deltaRe.lastIndex = consumed;
    for (let m = deltaRe.exec(stream); m !== null; m = deltaRe.exec(stream)) {
      try {
        assistantText += JSON.parse(`"${m[1]}"`) as string;
      } catch {
        // 转义序列被切在半截 —— 不推进 consumed，等下一轮数据补齐再解析这一条
        break;
      }
      consumed = deltaRe.lastIndex;
    }

    if (stream.includes("event: done") || stream.includes("event: error")) break;
  }
  return {
    stream,
    events: [...stream.matchAll(/^event: (.+)$/gm)].map((m) => m[1]),
    correlationId: /"correlationId":"([^"]+)"/.exec(stream)?.[1] ?? "",
    assistantText,
  };
}

/** 一个一定会调工具的提问：订单列表是四个工具里最简单的一个 */
const round = await runRound("帮我看看我最近30天的订单", "sess_model_smoke_a");
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

check("一轮对话跑到了 done（没有挂住）", round.events.includes("done"), round.events.join(",") || "（没有任何事件）");
check("流里没有 error 事件", !round.events.includes("error"), round.events.filter((e) => e === "error").length + " 个");
check("能取到 correlationId（后面的断言全靠它反查）", round.correlationId !== "");

/* ============================================================
   从服务端 trace 反查这一轮 —— 验的是「真的用了那个模型」
   ============================================================ */

interface AuditRecord {
  provider?: string;
  toolCalls?: { name: string; input: unknown }[];
  components?: unknown[];
  degraded?: boolean;
  degradedReason?: string;
  usage?: { inputTokens: number; outputTokens: number };
  totalMs?: number;
}

let record: AuditRecord | null = null;
if (round.correlationId !== "") {
  const res = await fetch(`${base}/api/trace?correlationId=${encodeURIComponent(round.correlationId)}`);
  const body = (await res.json()) as { records?: AuditRecord[] };
  record = body.records?.[0] ?? null;
}

/**
 * 最要紧的一条。
 *
 * 没有它，整个脚本是「假绿」：`LLM_PROVIDER` 拼错、环境变量没传进子进程、
 * 代码里某个分支静默回退 —— 任何一种都会让这一轮跑的是 mock，
 * 而 mock 是 100% 正确的，于是所有断言都过，结论是「真模型跑通了」。
 */
check(
  `trace 里记的 provider 是 ${provider}:* —— 没静默退回 mock`,
  (record?.provider ?? "").startsWith(`${provider}:`),
  record?.provider ?? "（trace 里没有 provider 字段）",
);
check("trace 里记的模型名与请求的一致", (record?.provider ?? "").includes(model), record?.provider ?? "（无）");

/* ============================================================
   usage —— 字段名猜错的唯一可观测后果
   ============================================================ */

const usage = record?.usage ?? { inputTokens: 0, outputTokens: 0 };
const usageTotal = usage.inputTokens + usage.outputTokens;

check(
  "usage 记到了数（这一轮真的花掉过 token）",
  usageTotal > 0,
  // 为 0 只有两种解释，而它们的处置完全不同，所以分开说：
  //   ① 模型调用根本没成功（连不上 / 超时）—— 去看 reason
  //   ② 调用成功了但用量没解析出来 —— 读 usage 的字段名抄错了，
  //      这件事**不会有任何报错**，只会让成本记账静默地记成 0
  usageTotal > 0 ? `${usage.inputTokens} in / ${usage.outputTokens} out`
    : record?.degraded
      ? `用量为 0，且本轮降级了 —— 先看降级原因是不是「连不上/超时」：${String(record.degradedReason ?? "（无）").slice(0, 120)}`
      : "用量为 0，但本轮没有降级 —— 调用成功了却没解析出 token，多半是 usage 的字段名读错了",
);
note("这一轮 token", `${usage.inputTokens} in / ${usage.outputTokens} out`);

/* ============================================================
   链路结果：只打印，不判红
   ============================================================ */

const componentCount = round.events.filter((e) => e === "component").length;
const calledTools = (record?.toolCalls ?? []).map((c) => c.name).join(", ") || "（没调工具）";

console.log("");
note("耗时", `${elapsed}s（含冷启动）`);
note("模型这次调了", calledTools);
if ((record?.toolCalls ?? []).length === 0 && !record?.degraded) {
  // 这一轮「正常」但没调工具，是 3B 模型上最常见的结果，而且它有个不明显的后果：
  // 适配器里解析工具调用的那几段（参数归一化 / 按序号归并 / 合成调用 ID）
  // 这一轮**一行都没跑到**。所以下面那句「链路通」不能顺手升级成「工具链路通」。
  note(
    "注意",
    "这一轮模型没产出结构化工具调用 —— 适配器的工具解析分支本轮未被走到，所以本次绿**不覆盖**工具调用链路",
  );
  // 把模型的原话打出来：如果它回的是「您好，有什么可以帮您」，那是模型没选工具；
  // 如果它回的是 `<tool_call>{...}` 这类半成品标记，那是**模型想调、格式没写对** ——
  // 两种情况的排查方向完全不同，而只看 trace 分不出来。
  note("模型原话", JSON.stringify(round.assistantText.slice(0, 160)));
}
note("服务端判定", record?.degraded ? "降级为纯文本" : "正常");
note("用户实际拿到", componentCount > 0 ? `${componentCount} 个组件` : "纯文本（没有组件）");

if (record?.degraded) {
  // 降级本身是设计内的行为，不是 bug —— 但要说清它是哪一类降级，
  // 否则「降级了」和「链路坏了」在读日志的人眼里长得一样。
  note(
    "降级说明",
    "闸1 重试耗尽或模型调用失败 —— 3B 模型参数写不对是常见的，链路按设计兜住了（这不是链路故障）",
  );
}

note(
  "结论口径",
  "以上只说明「链路通、provider 生效、usage 读对」。模型选得准不准是 eval 的事，本脚本不作判断。",
);

child.kill();
console.log(failed === 0 ? "\n全部通过\n" : `\n失败：${failed} 项\n`);
process.exit(failed === 0 ? 0 : 1);
