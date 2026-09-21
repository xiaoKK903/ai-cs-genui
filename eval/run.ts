/**
 * 评测
 *
 * 跑法：
 *   npm run eval                     # 用默认的 mock 跑基线
 *   npm run eval -- --provider=anthropic   # 用真模型跑（需要 ANTHROPIC_API_KEY）
 *
 * 这个脚本要回答的问题只有一个：**意图识别这一层，到底有多准。**
 *
 * 为什么不把它并进 selftest：selftest 的断言是「代码是否按设计工作」，
 * 期望值是确定的，挂了就是 bug。这里的期望值是「模型应该选对」，
 * 挂了可能是模型不行、也可能是工具描述写得不够清楚 —— 是**质量**问题不是**正确性**问题，
 * 两者的处理方式完全不同（前者改 prompt/描述/换模型，后者改代码）。
 *
 * 分层统计而不是只报一个总数：展示层和对抗层各挂一半，和一个总数挂一半，
 * 指向的是完全不同的两件事。
 *
 * 端到端也跑一遍（dispatch 之后看最终渲染了什么）：因为「模型选对了工具」
 * 和「用户看到了正确的组件」中间还隔着三道闸。只看前者，会把被闸拦掉的
 * 全部算成成功 —— 那是最危险的一种「绿」。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// 与 selftest 同理：被测模块要用动态 import 引入，顶层 await 需要一个模块标记
export {};

const args = process.argv.slice(2);
const argValue = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const provider = argValue("provider") ?? process.env.LLM_PROVIDER ?? "mock";
const onlyLayer = argValue("layer");
const limit = Number(argValue("limit") ?? "0");

process.env.LLM_PROVIDER = provider;
process.env.MOCK_STREAM_DELAY_MS = "0";
process.env.MOCK_TOOL_DELAY_MS = "0";
process.env.AUDIT_LOG = "off";

/* ---------- 动态引入，保证 env 先生效 ---------- */

const { getAdapter } = await import("../core/llm");
const { buildSystemPrompt } = await import("../core/llm/prompt");
const { getOrCreateSession } = await import("../core/data/session");
const { dispatchToolCalls } = await import("../core/gateway/dispatch");
const { gate1ValidateToolInput } = await import("../core/guardrails/gates");
const { TraceBuilder } = await import("../core/trace");
const { newCorrelationId } = await import("../core/protocol/envelope");
const { DEMO_SESSION_USER_ID, submitRefund } = await import("../core/data/mock-db");

/* ---------- 测试集 ---------- */

interface Expect {
  /** 期望模型调用这个工具；null 表示期望纯文本 */
  tool?: string | null;
  /** 任一命中即可（用于确实有歧义的输入） */
  anyOf?: string[];
  /** 这些工具一个都不许出现 */
  forbiddenTools?: string[];
  /** 端到端最终渲染出的组件；null 表示一个组件都不该有 */
  finalComponent?: string | null;
  /** 所有对外文本与信封里都不许出现 HTML 标签 */
  noRawHtml?: boolean;
}

interface Case {
  id: string;
  layer: string;
  input: string;
  preset?: { lastOrderNo?: string; hasRefundResult?: boolean };
  expect: Expect;
}

interface GoldenSet {
  version: string;
  cases: Case[];
}

const golden = JSON.parse(
  readFileSync(join(process.cwd(), "eval", "golden-set.json"), "utf8"),
) as GoldenSet;

const cases = golden.cases.filter((c) => !onlyLayer || c.layer === onlyLayer).slice(0, limit || undefined);

/* ---------- 单个用例 ---------- */

interface CaseResult {
  id: string;
  layer: string;
  input: string;
  ok: boolean;
  reasons: string[];
  toolCalls: string[];
  components: string[];
}

const HTML_PATTERN = /<\s*(script|table|div|iframe|img|svg|style|a)\b/i;

async function runCase(c: Case): Promise<CaseResult> {
  const session = getOrCreateSession(`eval_${c.id}`, DEMO_SESSION_USER_ID);
  const correlationId = newCorrelationId();

  if (c.preset?.lastOrderNo) {
    session.lastOrderNo = c.preset.lastOrderNo;
  }
  if (c.preset?.hasRefundResult && c.preset.lastOrderNo) {
    // 走真实的提交路径构造结果，而不是手搓一个对象 ——
    // 手搓的假数据一旦和 submitRefund 的返回结构长歪，这条用例就在骗自己
    session.lastRefundResult = submitRefund(DEMO_SESSION_USER_ID, {
      orderId: c.preset.lastOrderNo,
      reason: "quality_issue",
      claimedAmountCents: 0,
      idempotencyKey: `eval_${c.id}`,
    });
  }

  const system = buildSystemPrompt({
    today: new Date().toISOString().slice(0, 10),
    lastOrderNo: session.lastOrderNo,
    hasRefundResult: Boolean(session.lastRefundResult),
  });

  const decision = await getAdapter().decide({ system, history: [], userText: c.input });
  const toolCalls = decision.toolCalls.map((t) => t.name);

  // 闸1 不在这里重试：我们要知道的是模型「一次说对」的比例。
  // 重试是工程兜底，把它算进去会把模型能力的分打高。
  const gate1Failures = decision.toolCalls
    .map((t) => gate1ValidateToolInput(t.name, t.input))
    .filter((r) => !r.passed);

  const events: { event: string; data: Record<string, unknown> }[] = [];
  const result = await dispatchToolCalls(decision.toolCalls, {
    session,
    correlationId,
    emit: {
      closed: false,
      send(event: string, data: unknown) {
        events.push({ event, data: data as Record<string, unknown> });
      },
    } as never,
    trace: new TraceBuilder(correlationId),
    textOnly: false,
  });

  const components = result.components.map((x) => x.component);
  const reasons: string[] = [];

  if (gate1Failures.length > 0) {
    reasons.push(`闸1 拒绝：${gate1Failures.length} 个调用参数不合法`);
  }

  const e = c.expect;
  if (e.tool === null && toolCalls.length > 0) {
    reasons.push(`期望纯文本，实际调了 ${toolCalls.join(",")}`);
  }
  if (typeof e.tool === "string" && toolCalls[0] !== e.tool) {
    reasons.push(`期望 ${e.tool}，实际 ${toolCalls[0] ?? "(纯文本)"}`);
  }
  if (e.anyOf && !e.anyOf.includes(toolCalls[0] ?? "")) {
    reasons.push(`期望 ${e.anyOf.join(" 或 ")}，实际 ${toolCalls[0] ?? "(纯文本)"}`);
  }
  if (e.forbiddenTools) {
    const hit = toolCalls.filter((t) => e.forbiddenTools!.includes(t));
    if (hit.length > 0) reasons.push(`出现了禁止的工具：${hit.join(",")}`);
  }
  if (e.finalComponent === null && components.length > 0) {
    reasons.push(`期望不渲染任何组件，实际渲染了 ${components.join(",")}`);
  }
  if (typeof e.finalComponent === "string" && components[0] !== e.finalComponent) {
    reasons.push(`期望渲染 ${e.finalComponent}，实际 ${components[0] ?? "(无组件)"}`);
  }
  if (e.noRawHtml) {
    const surfaces = [
      decision.text,
      ...result.texts,
      ...events.filter((x) => x.event === "component").map((x) => JSON.stringify(x.data)),
    ];
    if (surfaces.some((s) => HTML_PATTERN.test(s))) {
      reasons.push("输出里出现了 HTML 标签");
    }
  }

  return { id: c.id, layer: c.layer, input: c.input, ok: reasons.length === 0, reasons, toolCalls, components };
}

/* ---------- 跑 ---------- */

console.log(`评测集 v${golden.version} · provider=${getAdapter().name} · ${cases.length} 条\n`);

const results: CaseResult[] = [];
for (const c of cases) {
  try {
    const r = await runCase(c);
    results.push(r);
    if (!r.ok) console.log(`  ✗ ${c.id}  ${c.input}`);
  } catch (err) {
    results.push({
      id: c.id,
      layer: c.layer,
      input: c.input,
      ok: false,
      reasons: [`执行异常：${err instanceof Error ? err.message : String(err)}`],
      toolCalls: [],
      components: [],
    });
  }
}

/* ---------- 汇总 ---------- */

const layers = [...new Set(results.map((r) => r.layer))];
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - [...s].reduce((w, ch) => w + (/[一-龥]/.test(ch) ? 2 : 1), 0)));

console.log("\n分层结果");
for (const layer of layers) {
  const rows = results.filter((r) => r.layer === layer);
  const ok = rows.filter((r) => r.ok).length;
  const rate = ((ok / rows.length) * 100).toFixed(1);
  console.log(`  ${pad(layer, 10)}${String(ok).padStart(3)}/${String(rows.length).padEnd(3)}  ${rate.padStart(5)}%`);
}
console.log(`  ${"─".repeat(34)}`);
const totalOk = results.filter((r) => r.ok).length;
console.log(
  `  ${pad("合计", 10)}${String(totalOk).padStart(3)}/${String(results.length).padEnd(3)}  ${(
    (totalOk / results.length) *
    100
  ).toFixed(1).padStart(5)}%`,
);

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.log("\n失败用例");
  for (const f of failed) {
    console.log(`  ${f.id}  「${f.input}」`);
    console.log(`     工具：${f.toolCalls.join(",") || "(纯文本)"} · 组件：${f.components.join(",") || "(无)"}`);
    for (const reason of f.reasons) console.log(`     · ${reason}`);
  }
}

console.log(
  provider === "mock"
    ? "\n这是 mock 基线。换成真模型：npm run eval -- --provider=anthropic"
    : "\n真模型结果。与 mock 基线的差值，就是「意图识别」这一层被替换后的净影响。",
);

process.exit(failed.length === 0 ? 0 : 1);
