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
 *
 * ## 一条用例的四种结局，以及为什么必须分开
 *
 *   PASS / FAIL —— 系统跑完了，结论可信。这是**质量信号**，进分数。
 *   ERROR       —— 评测自己崩了。这是**基础设施故障**，不进分数、也不算通过。
 *   SKIP        —— review_status 不是 approved（回流的候选用例），**不进分数**。
 *
 * 把 ERROR 和 FAIL 混成一个「不通过」，是这个脚本最容易犯、后果最贵的错：
 * 某天机器出问题十条用例抛异常，报告上写「准确率从 100% 掉到 92%」，
 * 然后所有人去查 Prompt。真正该修的是机器。这两个数字分开报，一眼分得清。
 */

import { readFileSync } from "node:fs";
import { join, sep } from "node:path";

import { buildRecord, compare, listRuns, runStamp, saveRun } from "./history";
import { aggregate, computeDatasetHash, severityOf } from "./models";
import type { CaseStatus, EvalCase, ReviewStatus } from "./models";

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
/**
 * 默认不跑隔离区（review_status 不是 approved）的用例。
 *
 * 加上这个开关会把它们跑一遍并单独列出来，**但依然不计分** ——
 * 加它的用途是「看一眼这条线上回流回来的用例现在过不过，好决定要不要评审它」，
 * 不是「让它进分数」。这两件事混了，隔离区就白设了。
 */
const withCandidates = args.includes("--candidates");

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

interface GoldenSet {
  dataset_id: string;
  version: string;
  cases: (Omit<EvalCase, "expect"> & { expect: Expect })[];
}

type Case = GoldenSet["cases"][number];

const golden = JSON.parse(
  readFileSync(join(process.cwd(), "eval", "golden-set.json"), "utf8"),
) as GoldenSet;

/** 用例的内容哈希：回答「同一个用例昨天过今天不过，中间改的是用例还是代码」 */
const datasetHash = computeDatasetHash(golden.cases);

const reviewOf = (c: { review_status?: ReviewStatus }): ReviewStatus => c.review_status ?? "approved";

const scoped = golden.cases.filter((c) => !onlyLayer || c.layer === onlyLayer);

/**
 * 隔离区：线上回流回来的用例，人工评审通过前不进评测。
 *
 * 不跑它们（默认）而不是「跑了不算分」，是个刻意的选择：
 * 一条没评审过的用例，跑出来的结果没有任何人可以依据它做决定 ——
 * 那就不该消耗时间和注意力。要看的时候加 `--candidates`。
 */
const quarantined = scoped.filter((c) => reviewOf(c) !== "approved");
const active = scoped.filter((c) => reviewOf(c) === "approved");
const cases = (withCandidates ? scoped : active).slice(0, limit || undefined);

/* ---------- 单个用例 ---------- */

interface CaseResult {
  id: string;
  layer: string;
  input: string;
  /** 四态，见文件头。`ok` 只是它的一个投影，保留是为了让判定逻辑读起来短 */
  status: CaseStatus;
  reasons: string[];
  /** ERROR 的原因。它不是「哪里没做对」，是「没测出来」，所以和 reasons 分开放 */
  error: string;
  weight: number;
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
    // 跑到这里就一定拿到了可信结论：要么符合期望，要么不符合。
    // 唯一会变成 ERROR 的路径是抛异常，那在调用处捕获。
    status: reasons.length === 0 ? "pass" : "fail",
    reasons,
    error: "",
    weight: severityOf(c),
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

console.log(
  `评测集 ${golden.dataset_id} v${golden.version} · ${datasetHash} · provider=${getAdapter().name} · ${cases.length} 条`,
);
if (quarantined.length > 0 && !withCandidates) {
  console.log(`隔离区 ${quarantined.length} 条未跑（未评审，不计分）—— 要看加 --candidates`);
}
console.log("");

/** 中性指标：既不声明期望、也不产生调用，所以对任何门槛都是「不存在」而不是「失败」 */
const NEUTRAL_METRICS: CaseResult["metrics"] = {
  intentExpected: null,
  intentGotComponent: false,
  expectedComponents: [],
  gotComponent: null,
  gate1Calls: 0,
  gate1Rejected: 0,
  envelopeGate3: [],
};

const results: CaseResult[] = [];
/** 隔离区用例的结果。单独放 —— 它们**永远**不进分数，展示了也只是给人看 */
const candidateResults: CaseResult[] = [];

for (const c of cases) {
  const quarantined = reviewOf(c) !== "approved";
  try {
    const r = await runCase(c);
    if (quarantined) {
      candidateResults.push(r);
    } else {
      results.push(r);
      if (r.status === "fail") console.log(`  ✗ ${c.id}  ${c.input}`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // 两种结局不同的处理，是这整个脚本最值得看一眼的地方：
    //   隔离区的用例抛异常 → 无所谓，它本来就不算数
    //   正常用例抛异常     → ERROR，**不是** FAIL
    // 后者如果写成 FAIL，一次机器故障会被记成一次质量退步，
    // 然后有人去改一句根本没坏的 Prompt。
    const r: CaseResult = {
      id: c.id,
      layer: c.layer,
      input: c.input,
      status: quarantined ? "skip" : "error",
      // reasons 留空：异常不是「哪里没做对」的清单，硬塞进去会让失败报告里
      // 混进一批看着像断言失败、实际是崩溃的行
      reasons: [],
      error: reason,
      weight: severityOf(c),
      toolCalls: [],
      components: [],
      metrics: NEUTRAL_METRICS,
    };
    if (quarantined) {
      candidateResults.push(r);
    } else {
      results.push(r);
      console.log(`  ! ${c.id}  执行异常：${reason}`);
    }
  }
}

/* ---------- 汇总 ---------- */

const layers = [...new Set(results.map((r) => r.layer))];
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - [...s].reduce((w, ch) => w + (/[一-龥]/.test(ch) ? 2 : 1), 0)));

const report = aggregate({
  ...runStamp(),
  provider: getAdapter().name,
  datasetId: golden.dataset_id,
  datasetVersion: golden.version,
  datasetHash,
  gitCommit: null, // 由 history 去问 git，这里不重复问一次
  results: results.map((r) => ({
    caseId: r.id,
    layer: r.layer,
    status: r.status,
    score: r.status === "pass" ? 1 : 0,
    reasons: r.reasons,
    error: r.error,
    weight: r.weight,
    input: r.input,
  })),
});

console.log("\n分层结果");
for (const cs of report.categoryStats) {
  const rate = (cs.passRate * 100).toFixed(1);
  // 异常单独一列。混进分子的分母里，两种故障就再也分不出来了
  const extra = cs.errored > 0 ? `  ⚠ 异常 ${cs.errored}` : "";
  console.log(
    `  ${pad(cs.layer, 10)}${String(cs.passed).padStart(3)}/${String(cs.passed + cs.failed).toString().padEnd(3)}  ${rate.padStart(5)}%${extra}`,
  );
}
console.log(`  ${"─".repeat(34)}`);
console.log(
  `  ${pad("合计", 10)}${String(report.passed).padStart(3)}/${String(report.passed + report.failed).toString().padEnd(3)}  ${(
    report.rawPassRate * 100
  ).toFixed(1).padStart(5)}%`,
);
console.log(
  `  ${pad("加权得分", 10)}${(report.weightedScore * 100).toFixed(1).padStart(5)}%   （按层严重度加权：对抗 ×5、操作 ×3、展示 ×2、闲聊 ×1）`,
);
if (report.errored > 0 || report.skipped > 0) {
  console.log(
    `  ${pad("未计分", 10)}${String(report.errored + report.skipped).padStart(3)} 条   （异常 ${report.errored} · 隔离区 ${report.skipped}）—— 不进上面任何数字`,
  );
}

const failed = results.filter((r) => r.status === "fail");
const errored = results.filter((r) => r.status === "error");

if (failed.length > 0) {
  console.log("\n失败用例");
  for (const f of failed) {
    console.log(`  ${f.id}  「${f.input}」`);
    console.log(`     工具：${f.toolCalls.join(",") || "(纯文本)"} · 组件：${f.components.join(",") || "(无)"}`);
    for (const reason of f.reasons) console.log(`     · ${reason}`);
  }
}

/**
 * 异常单独一节，不混进「失败用例」。
 *
 * 这一节的输出长得和失败不一样是有意的：失败要回答「哪里没做对」，
 * 异常要回答「哪个组件崩了、崩在哪一行」。看这两节的人，下一步动作也不同 ——
 * 一个去改 prompt，一个去修代码。
 */
if (errored.length > 0) {
  console.log("\n执行异常（不是质量失败 —— 这些是评测自身没跑起来）");
  for (const f of errored) {
    console.log(`  ! ${f.id}  「${f.input}」`);
    console.log(`     ${f.error}`);
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
  /** 展示单位。缺省百分比；异常那条报的是条数 */
  unit?: "count";
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
  // 下面两条不是第四阶段那张表里的，是这个仓库自己加的。
  // 加它们的理由：上面五条全是「某一层的某件事做对没有」，
  // 少了「整体有没有退步」和「这次评测本身可信不可信」两个方向。
  {
    name: "加权得分",
    value: report.weightedScore * 100,
    target: 95,
    note: "按层严重度加权，对抗层挂了掉分最多",
  },
  {
    name: "执行异常",
    // 门槛是 0，不是「低于 2%」。
    //
    // 有些评测框架给异常率留一个百分比容忍度，理由是真实的模型调用会有网络抖动。
    // 那在每天跑一万条的生产评测里是对的，在这个仓库里是错的：
    // 默认的 mock 是**确定性**的，同一个输入永远给同一个输出 ——
    // 它上面出现异常，100% 是代码 bug，不存在「抖动」这个解释。
    // 而一条异常用例意味着这次评测**少了一个结论**，上面所有比率的分母都是缺的。
    // 少测了一条还能算通过，这个口子一开，就再也关不上了。
    value: report.errored,
    target: 0,
    atMost: true,
    unit: "count",
    note: "任何一条异常都让本次结论不完整",
  },
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
  const isCount = g.unit === "count";
  const suffix = isCount ? "条" : "%";
  const shown = g.value === null ? "—" : `${isCount ? g.value : g.value.toFixed(1)}${suffix}`;
  const dir = g.atMost ? "≤" : "≥";
  console.log(
    `  ${miss(g) ? "✗" : "✓"} ${pad2(g.name, 16)}${shown.padStart(7)}   ${dir}${String(g.target).padStart(5)}${suffix}   ${g.note ?? ""}`,
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

// 门槛的结论写回报告，随存档一起落盘 ——
// 否则「这次没达标」这件事只活在终端的那一屏里，翻存档时看不见
report.gatePassed = gates.filter(miss).length === 0;
report.gateReasons = gates
  .filter(miss)
  .map((g) => {
    const suffix = g.unit === "count" ? "条" : "%";
    const shown = g.value === null ? "未测" : `${g.unit === "count" ? g.value : g.value.toFixed(1)}${suffix}`;
    return `${g.name} ${shown} ${g.atMost ? ">" : "<"} ${g.target}${suffix}`;
  });

const record = buildRecord(report, { quarantined: quarantined.length });

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
  // 这一行是整个「对比」环节的前提：变的是考卷还是答题的。
  // 不写出来，下面所有数字都可以被两种完全相反的原因解释
  console.log(
    cmp.sameGolden
      ? `  用例集 ${record.datasetHash} 未变 —— 下面的差异都是代码/模型造成的`
      : `  ⚠ 用例集内容变了（${prev.datasetHash} → ${record.datasetHash}）：差异里混着用例增减，逐条对比才可信`,
  );
  const scoreArrow = cmp.scoreDelta > 0 ? "↑" : cmp.scoreDelta < 0 ? "↓" : "=";
  console.log(
    `  加权得分 ${(prev.weightedScore * 100).toFixed(1)}% → ${(record.weightedScore * 100).toFixed(1)}%  ${scoreArrow}${cmp.scoreDelta === 0 ? "" : `${Math.abs(cmp.scoreDelta).toFixed(1)}pp`}`,
  );
  for (const l of cmp.layerDeltas) {
    const arrow = l.delta > 0 ? "↑" : l.delta < 0 ? "↓" : "=";
    console.log(`  ${pad(l.layer, 10)}${l.from.padEnd(7)}→ ${l.to.padEnd(7)}${arrow}${l.delta === 0 ? "" : Math.abs(l.delta)}`);
  }
  if (cmp.newErrors.length > 0) {
    console.log(`\n  ⚠ 新出现执行异常 ${cmp.newErrors.length} 条 —— 先看这个，异常会让上面的比率虚高：`);
    for (const e of cmp.newErrors) console.log(`      ${e.id}  ${e.error}`);
  }
  if (cmp.recovered.length > 0) {
    console.log(`  · 异常恢复 ${cmp.recovered.length} 条：${cmp.recovered.map((e) => e.id).join(", ")}`);
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

/**
 * 隔离区：跑了但不计分的那批。
 *
 * 单独一节、明确的「不计分」字样，是为了防止一个很自然但很危险的读法：
 * 看到「候选区 3 条全过」就以为可以把它当成成绩。它现在的身份是**待评审**，
 * 评审通过了（把 review_status 改成 approved）它才会进入上面的数字。
 */
if (withCandidates && candidateResults.length > 0) {
  console.log(`\n隔离区（未评审，不计分 · ${candidateResults.length} 条）`);
  for (const c of candidateResults) {
    const mark = c.status === "pass" ? "通过" : c.status === "error" ? "异常" : "未通过";
    console.log(`  ${mark.padEnd(4)}${c.id}  「${c.input}」${c.error ? `  ${c.error}` : ""}`);
  }
  console.log("  评审通过后把 review_status 改成 approved，这些用例才会进分数。");
} else if (quarantined.length > 0 && !withCandidates) {
  console.log(
    `\n隔离区 ${quarantined.length} 条未跑：${quarantined.map((c) => c.id).join(", ")}\n  线上回流回来的用例，人工评审前不计分（--candidates 可以跑一遍看看）。`,
  );
}

console.log(
  provider === "mock"
    ? "\n这是 mock 基线。换成真模型：npm run eval -- --provider=anthropic"
    : "\n真模型结果。与 mock 基线的差值，就是「意图识别」这一层被替换后的净影响。",
);

// 门槛没达标 = 没通过。
//
// 只报数不拦人的门槛，和一句写在文档里的建议没有区别 —— 区别只在于
// 看板好看一点。所以这里让退出码说话：达标与否不看人有没有注意到那一行。
//
// 与 --strict 的关系：--strict 比的是**和上次**（回归），门槛比的是**和绝对线**。
// 一个防「慢慢退步」，一个防「一直就不够好」—— 两个都得有。
const gateMissed = gates.filter(miss).length;

// 三种没通过：有用例失败、门槛没达标、严格模式下出现回归。
//
// 执行异常不需要单独写在这里 —— 「执行异常 ≤ 0 条」本身就在门槛表里，
// 走的是同一条判定路径。两处各写一遍的话，改了一处忘了另一处，
// 就会出现「门槛显示 ✗ 但退出码是 0」这种最伤信任的状态。
process.exit(failed.length > 0 || gateMissed > 0 || (strict && cmp.regressed.length > 0) ? 1 : 0);
