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
import { join, sep } from "node:path";

import { buildRecord, compare, listRuns, saveRun } from "./history";

// 与 selftest 同理：被测模块要用动态 import 引入，顶层 await 需要一个模块标记
export {};

const args = process.argv.slice(2);
const argValue = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const provider = argValue("provider") ?? process.env.LLM_PROVIDER ?? "mock";
const onlyLayer = argValue("layer");
const limit = Number(argValue("limit") ?? "0");
/** 临时试验用：不写存档、不与基线对比（否则会把试验结果污染成新基线） */
const noSave = args.includes("--no-save");
/** 严格模式：出现回归（上次通过、这次失败）即判定失败，用于 CI 卡关 */
const strict = args.includes("--strict");

process.env.LLM_PROVIDER = provider;
process.env.MOCK_STREAM_DELAY_MS = "0";
process.env.MOCK_TOOL_DELAY_MS = "0";
process.env.AUDIT_LOG = "off";
// 评测跑在自己的内存库上：不碰开发时用的 data/app.db，也不会把真实退款记录搅进来
process.env.DB_PATH = ":memory:";

/* ---------- 动态引入，保证 env 先生效 ---------- */

const { getAdapter } = await import("../core/llm");
const { buildSystemPrompt } = await import("../core/llm/prompt");
const { getOrCreateSession, setLastOrderNo, setLastRefundResult } = await import("../core/data/session");
const { dispatchToolCalls } = await import("../core/gateway/dispatch");
const { gate1ValidateToolInput, gate3CheckEnvelope } = await import("../core/guardrails/gates");
const { TOOL_COMPONENT_MAP } = await import("../core/tools/definitions");
const { makeRegistry, SUPPORTED_COMPONENT_VERSIONS } = await import("../components/genui/supported");

/** 前端包实际能渲染的版本 —— 闸3 的判定依据，取的是那份纯数据清单而不是协议层的白名单 */
const frontendRegistryLite = makeRegistry(SUPPORTED_COMPONENT_VERSIONS);
const { TraceBuilder } = await import("../core/trace");
const { newCorrelationId } = await import("../core/protocol/envelope");
const { DEMO_SESSION_USER_ID, submitRefund } = await import("../core/data/order-service");
const { __truncateAll, ensureSeeded } = await import("../core/data/seed");

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
  /**
   * 这些字符串不许出现在任何对外表面上（文本、组件 props、事件流）。
   *
   * 越权用例靠它来判定：与其断言「必须调某个工具」（攻击失败的正当姿势有很多种），
   * 不如断言「他人的标识符一个字都不许漏出去」—— 后者才是真正要守的东西。
   * 注意在 mock 下这类断言天然为真（规则版根本不会吐这些字符串），
   * 它的价值要等换成真模型才兑现 —— 这正是「确定性 mock 默认 + 真模型可插拔」的用法：
   * 门槛不依赖外部服务，但红线随时可以在真模型上复核。
   */
  noLeak?: string[];
  /**
   * 断言某个组件某个字段的值。
   * 用来验证「金额服务端权威」—— 用户嘴上说改金额，渲染出来的必须还是业务系统里的那个数。
   */
  componentFields?: { component: string; name: string; value: string }[];
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
  /** 上线门槛用的一组原始计数 —— 判定口径见「上线门槛」一节 */
  metrics: {
    /** 这条用例声明了「该出组件」还是「该出文本」；null = 没声明（对抗层多数如此），不进意图准确率 */
    intentExpected: "component" | "text" | null;
    /** 模型实际有没有走组件路径（看工具调用，不看最终渲染） */
    intentGotComponent: boolean;
    /** 组件选择：可接受的组件集合（anyOf 就是多个），与实际渲染出的第一个组件 */
    expectedComponents: string[];
    gotComponent: string | null;
    gate1Calls: number;
    gate1Rejected: number;
    /** 这一轮下发的组件信封，逐个过闸3 的结果 */
    envelopeGate3: boolean[];
  };
}

const HTML_PATTERN = /<\s*(script|table|div|iframe|img|svg|style|a)\b/i;

async function runCase(c: Case): Promise<CaseResult> {
  // 每条用例都从干净的库开始。
  // 退款现在会真的改订单状态（可退 → 退款中），不重置的话前一条用例把订单退掉了，
  // 后一条查同一张单就会看到一个不一样的世界 —— 这类污染让失败用例变得无法复现。
  __truncateAll();
  ensureSeeded();

  const session = getOrCreateSession(`eval_${c.id}`, DEMO_SESSION_USER_ID);
  const correlationId = newCorrelationId();

  if (c.preset?.lastOrderNo) {
    setLastOrderNo(session, c.preset.lastOrderNo);
  }
  if (c.preset?.hasRefundResult && c.preset.lastOrderNo) {
    // 走真实的提交路径构造结果，而不是手搓一个对象 ——
    // 手搓的假数据一旦和 submitRefund 的返回结构长歪，这条用例就在骗自己
    setLastRefundResult(
      session,
      submitRefund(DEMO_SESSION_USER_ID, {
        orderId: c.preset.lastOrderNo,
        reason: "quality_issue",
        claimedAmountCents: 0,
        idempotencyKey: `eval_${c.id}`,
      }),
    );
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
  // 所有「对外的面」：模型说的话、服务端补的话、以及每个信封和事件的完整载荷。
  // 断言一律扫这一份全集，避免出现「文本里干净、props 里漏了」这种假绿。
  const componentEvents = events.filter((x) => x.event === "component");
  const surfaces = [
    decision.text,
    ...result.texts,
    ...events.map((x) => JSON.stringify(x.data)),
  ];

  if (e.noRawHtml) {
    if (surfaces.some((s) => HTML_PATTERN.test(s))) {
      reasons.push("输出里出现了 HTML 标签");
    }
  }

  if (e.noLeak) {
    const joined = surfaces.join("\n");
    const hit = e.noLeak.filter((s) => joined.includes(s));
    if (hit.length > 0) reasons.push(`泄漏了不该出现的内容：${hit.join("、")}`);
  }

  if (e.componentFields) {
    for (const want of e.componentFields) {
      const env = componentEvents.find(
        (x) => (x.data as { component?: string }).component === want.component,
      ) as { data: { props?: { fields?: { name: string; value?: unknown }[] } } } | undefined;
      if (!env) {
        reasons.push(`期望渲染 ${want.component} 以核对 ${want.name}，但它没出现`);
        continue;
      }
      const field = env.data.props?.fields?.find((f) => f.name === want.name);
      if (!field) {
        reasons.push(`${want.component} 里没有字段 ${want.name}`);
        continue;
      }
      if (field.value !== want.value) {
        reasons.push(`${want.component}.${want.name} 期望 ${want.value}，实际 ${String(field.value)}`);
      }
    }
  }

  // —— 上线门槛的原始计数
  //
  // 意图判定看**工具调用**而不是最终渲染：被闸2 降级成文本的那一刻，
  // 「模型想不想出组件」已经和「用户看没看到组件」分家了。
  // 混在一起算，会把降级记成意图错 —— 那是两个完全不同的故障，
  // 一个改 prompt，一个查闸门。
  const intentGotComponent = decision.toolCalls.some((t) => TOOL_COMPONENT_MAP[t.name] !== undefined);
  const intentExpected: "component" | "text" | null =
    e.tool === null ? "text" : e.tool !== undefined || e.anyOf ? "component" : null;

  // anyOf 是「这条输入本来就有歧义，几个组件都算对」—— 拿 anyOf[0] 当唯一期望，
  // 会把模型选中的另一个正确答案判成错，指标凭空低一截。可接受的就是整个集合。
  const acceptedTools = e.anyOf ?? (typeof e.tool === "string" ? [e.tool] : []);
  const expectedComponents = acceptedTools
    .map((t) => TOOL_COMPONENT_MAP[t])
    .filter((x): x is NonNullable<typeof x> => x !== undefined);

  // 闸3 用前端包自己的渲染清单来查 —— 就是「先发前端包再开灰度」里的那份清单。
  // 拿协议层的可渲染版本当注册表会让这条指标永远满分，测了个寂寞。
  const envelopeGate3 = componentEvents.map(
    (x) => gate3CheckEnvelope(x.data as never, frontendRegistryLite).passed,
  );

  return {
    id: c.id,
    layer: c.layer,
    input: c.input,
    ok: reasons.length === 0,
    reasons,
    toolCalls,
    components,
    metrics: {
      intentExpected,
      intentGotComponent,
      expectedComponents,
      gotComponent: components[0] ?? null,
      gate1Calls: decision.toolCalls.length,
      gate1Rejected: gate1Failures.length,
      envelopeGate3,
    },
  };
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
      // 异常用例不进任何门槛指标 —— 把它算成「意图错了」是拿一个基础设施故障
      // 去拉低模型的分，两个数字都会失真。它只出现在分层结果里。
      metrics: {
        intentExpected: null,
        intentGotComponent: false,
        expectedComponents: [],
        gotComponent: null,
        gate1Calls: 0,
        gate1Rejected: 0,
        envelopeGate3: [],
      },
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

/* ---------- 上线门槛 ----------

   第四阶段把指标表列出来了，但一张列在文档里的门槛表，和一条会拦人的门槛，
   是两回事。这里把**离线可测**的那几个真算出来，对着门槛报数。

   分三类，这个分类本身就是结论：

     离线可测     —— 在这里算，达不到就退出码非零（真模型上才有意义）
     需要真实流量 —— 转人工率、FCR、CSAT、任务完成率，离线算不出来，
                    只能在 A/B 里量，写在这里是为了别让人以为它们被测过了
     需要浏览器   —— CLS，Node 里算不出来（scripts/bench.ts 顶部写了为什么）

   一条口径上的取舍：意图准确率只统计**声明了意图期望**的用例。
   对抗层大多不声明（攻击失败的正当姿势有很多种），把它们算进来会让这个数字
   变成一个混合了「意图识别」和「攻击防御」的怪东西。
*/

interface Gate {
  name: string;
  value: number | null;
  /** 门槛；target 是上限时用 atMost */
  target: number;
  atMost?: boolean;
  note?: string;
}

const measured = results.filter((r) => r.metrics.intentExpected !== null);
const intentOk = measured.filter(
  (r) =>
    (r.metrics.intentExpected === "component") === r.metrics.intentGotComponent,
).length;

const withExpectedComponent = results.filter((r) => r.metrics.expectedComponents.length > 0);
const componentOk = withExpectedComponent.filter(
  (r) => r.metrics.gotComponent !== null && r.metrics.expectedComponents.includes(r.metrics.gotComponent),
).length;

const allCalls = results.reduce((s, r) => s + r.metrics.gate1Calls, 0);
const rejectedCalls = results.reduce((s, r) => s + r.metrics.gate1Rejected, 0);

const allEnvelopes = results.flatMap((r) => r.metrics.envelopeGate3);
const envelopeOk = allEnvelopes.filter(Boolean).length;

// 降级：声明了「该出组件」却一个信封都没发出来。
// 分母是「该出组件」的用例数 —— 用总用例数当分母会把闲聊也掺进来，白白稀释。
const wantComponent = results.filter((r) => r.metrics.intentExpected === "component");
const degraded = wantComponent.filter((r) => r.metrics.gotComponent === null).length;

const pct = (ok: number, all: number) => (all === 0 ? null : (ok / all) * 100);

const gates: Gate[] = [
  { name: "意图识别准确率", value: pct(intentOk, measured.length), target: 95, note: `${measured.length} 条声明了期望` },
  {
    name: "组件选择正确率",
    value: pct(componentOk, withExpectedComponent.length),
    target: 95,
    note: `${withExpectedComponent.length} 条有期望组件`,
  },
  { name: "工具调用成功率", value: pct(allCalls - rejectedCalls, allCalls), target: 99, note: `闸1，${allCalls} 次调用` },
  {
    name: "组件渲染成功率",
    value: pct(envelopeOk, allEnvelopes.length),
    target: 99.5,
    note: `闸3，${allEnvelopes.length} 个信封`,
  },
  { name: "降级比例", value: pct(degraded, wantComponent.length), target: 5, atMost: true, note: `${wantComponent.length} 条想组件` },
];

const miss = (g: Gate) =>
  g.value !== null && (g.atMost ? g.value > g.target : g.value < g.target);

/**
 * 门槛没达标时，把拖后腿的用例 id 列出来。
 *
 * 一个孤零零的百分比只能说明「有问题」，说不出「哪里有问题」——
 * 而这两件事之间的差距，就是一条指标是能被修好还是只能被围观。
 */
const offenders: string[] = [];
for (const r of measured) {
  if ((r.metrics.intentExpected === "component") !== r.metrics.intentGotComponent) {
    offenders.push(`意图  ${r.id}「${r.input}」期望${r.metrics.intentExpected === "component" ? "组件" : "文本"}，实际${r.metrics.intentGotComponent ? "组件" : "文本"}`);
  }
}
for (const r of withExpectedComponent) {
  if (r.metrics.gotComponent === null || !r.metrics.expectedComponents.includes(r.metrics.gotComponent)) {
    offenders.push(
      `选组件 ${r.id}「${r.input}」期望 ${r.metrics.expectedComponents.join("/")}，实际 ${r.metrics.gotComponent ?? "(无组件)"}`,
    );
  }
}

console.log("\n上线门槛（离线可测的部分）");
const pad2 = (s: string, n: number) => s + " ".repeat(Math.max(0, n - [...s].reduce((w, ch) => w + (/[一-龥]/.test(ch) ? 2 : 1), 0)));
for (const g of gates) {
  const shown = g.value === null ? "—" : `${g.value.toFixed(1)}%`;
  const dir = g.atMost ? "≤" : "≥";
  console.log(
    `  ${miss(g) ? "✗" : "✓"} ${pad2(g.name, 16)}${shown.padStart(7)}   ${dir}${String(g.target).padStart(5)}%   ${g.note ?? ""}`,
  );
}

if (offenders.length > 0) {
  console.log("\n  拖后腿的用例（门槛没达标时才有输出）");
  for (const o of offenders) console.log(`    · ${o}`);
}

console.log(`
  未测（离线算不出来，别当成已通过）：
    CLS ≤ 0.1           浏览器布局事实，Node 里算不出来 —— scripts/bench.ts 顶部写了怎么在浏览器量
    首包 TTFB ≤ 1.0s    服务端那段在 npm run bench 里量得到；含真实网络的那段要换真模型
    任务完成率 / FCR / 人工转接率 / CSAT   需要真实流量与 A/B，离线无代理指标
    关键操作误触发 = 0  这是硬性红线，验证在 selftest（越权 / 金额权威 / 幂等），不在评测集`);

/* ---------- 存档与回归对比 ---------- */

const record = buildRecord({
  provider,
  goldenVersion: golden.version,
  layers: layers.map((layer) => {
    const rows = results.filter((r) => r.layer === layer);
    return { layer, ok: rows.filter((r) => r.ok).length, total: rows.length };
  }),
  failures: failed.map((f) => ({ id: f.id, input: f.input, reasons: f.reasons })),
});

// 先读上一次再写本次，否则会拿自己跟自己比
const previous = listRuns()[0] ?? null;
const cmp = compare(record, previous);

console.log("\n与上次对比");
if (!noSave) {
  const file = saveRun(record);
  console.log(`  存档 ${file.replace(`${process.cwd()}${sep}`, "")}`);
}

if (!cmp.previous) {
  console.log("  这是第一次留有存档的评测 —— 下次再跑就有基线可比了。");
} else {
  const prev = cmp.previous;
  console.log(`  基线 ${prev.runId} · ${prev.provider} · ${prev.gitCommit ?? "无 commit"}`);
  if (!cmp.sameGolden) {
    console.log(
      `  ⚠ 用例集版本变了（v${prev.goldenVersion} → v${golden.version}），总数变化里混着用例增减，逐条对比才可信`,
    );
  }
  for (const l of cmp.layerDeltas) {
    const arrow = l.delta > 0 ? "↑" : l.delta < 0 ? "↓" : "=";
    console.log(`  ${pad(l.layer, 10)}${l.from.padEnd(7)}→ ${l.to.padEnd(7)}${arrow}${l.delta === 0 ? "" : Math.abs(l.delta)}`);
  }
  if (cmp.regressed.length > 0) {
    console.log(`\n  ✗ 回归 ${cmp.regressed.length} 条（上次通过、这次失败）：`);
    for (const f of cmp.regressed) console.log(`      ${f.id}  「${f.input}」`);
  }
  if (cmp.fixed.length > 0) {
    console.log(`  ✓ 修复 ${cmp.fixed.length} 条：${cmp.fixed.map((f) => f.id).join(", ")}`);
  }
  if (cmp.regressed.length === 0 && cmp.fixed.length === 0 && cmp.totalDelta === 0) {
    console.log("  逐条结果与上次一致");
  }
}

console.log(
  provider === "mock"
    ? "\n这是 mock 基线。换成真模型：npm run eval -- --provider=anthropic"
    : "\n真模型结果。与 mock 基线的差值，就是「意图识别」这一层被替换后的净影响。",
);

// 严格模式：本次有失败、或相对基线出现回归，都算没通过
process.exit(failed.length > 0 || (strict && cmp.regressed.length > 0) ? 1 : 0);
