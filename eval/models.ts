/**
 * 评测的词汇表：一次评测里流动的每样东西是什么
 *
 * 这一层的存在理由和 `core/protocol/` 一样 —— 把「一次评测的结果」定义清楚，
 * 后面所有关于它的讨论（报告、对比、门槛、回流）才有共同的词。
 *
 * 设计取自用户另一个已落地的项目 `已完成题目/第23题/agent-eval`（Python）。
 * 那边把三件事做对了，这里照搬的是**机制**不是代码：
 *
 *   1. FAIL 与 ERROR 严格分开（CaseStatus）
 *   2. candidate 隔离区：线上回流的用例在人工评审前不计分（ReviewStatus）
 *   3. 数据集内容哈希：回答「同一个用例昨天过今天不过，中间到底改了啥」
 *
 * 不直接依赖那个项目，是因为它要求 Python 环境。这个仓库的纪律是
 * `npm run check` 一条命令跑完全部验证 —— 为了一个评测词汇表把 Python 拉进来，
 * 违背的是自己定的规矩。机制值钱，语言不值钱。
 */

import { createHash } from "node:crypto";

/* ---------- 用例状态 ---------- */

/**
 * 一条用例跑完之后的四种结局。
 *
 * **FAIL 和 ERROR 必须分开，这是整套东西里最重要的一条。**
 *
 *   FAIL  —— 系统好好跑完了，但结果不符合期望。这是**质量信号**，计入分数。
 *   ERROR —— 我们没拿到可信的结论：进程崩了、评测脚本自己抛异常、断言代码有 bug。
 *            这是**基础设施故障**，不是质量信号，**绝不能算成通过、也绝不能算成失败**。
 *
 * 混在一起的后果很具体：某天评测机磁盘满了，十条用例抛异常，
 * 报告上「准确率从 100% 掉到 92%」—— 所有人去查 Prompt，查一整天。
 * 真正该做的是去修磁盘。这两个数字分开报，一眼就能分清。
 */
export type CaseStatus = "pass" | "fail" | "error" | "skip";

/** 用例的治理状态。回流的用例先进隔离区，人工评审过才计分。 */
export type ReviewStatus = "approved" | "candidate" | "deprecated";

/* ---------- 用例 ---------- */

/**
 * 用例。`expect` 是泛型的：这一层只关心「它是一份可以哈希的断言」，
 * 断言具体长什么样由跑评测的那一侧定义（run.ts 里的 `Expect`）。
 * 若把它写死成 `Record<string, unknown>`，那个接口会因为缺索引签名而赋值不进来 ——
 * 而为了一个哈希去给断言类型加索引签名，是让被服务的东西迁就工具。
 */
export interface EvalCase<E = Record<string, unknown>> {
  id: string;
  layer: string;
  input: string;
  preset?: { lastOrderNo?: string; hasRefundResult?: boolean };
  expect: E;
  /**
   * 治理状态，缺省 approved。
   *
   * candidate 来自线上失败回流（见 eval/ingest.ts）：它**不计分**，
   * 直到有人把它改成 approved。理由是一条没评过的用例进了分数，
   * 等于让线上的一次误报直接改写质量结论 —— 而线上报错的原因可能是
   * 用户打错字、也可能是业务规则本来就要改，这得人来判断。
   */
  review_status?: ReviewStatus;
  /** 单条重要性系数，缺省 1。某一类业务后果特别重时单独调它 */
  weight?: number;
  /** 来源。回流的用例带 incident id，出问题时能追回那次线上事故 */
  source?: { origin?: string; incident_id?: string; note?: string };
}

export interface GoldenSet {
  dataset_id: string;
  version: string;
  cases: EvalCase[];
}

/* ---------- 严重度 ---------- */

/**
 * 按层给严重度权重 —— 顶层分数不是「通过率」，是**加权的分数**。
 *
 * 为什么不按通过率：对抗层挂一条和闲聊层挂一条，后果差着量级。
 * 前者可能是别人订单号漏出去了，后者是答得不够热情。用同一个 1 去数，
 * 等于宣称这两件事等价。
 *
 * 权重按「失败后果」给，不按用例数量：
 *   对抗 5 —— 数据越权 / 金额被改 / 注入得手，一条就是事故
 *   操作 3 —— 动钱的操作做错
 *   展示 2 —— 用户看到了错的数据
 *   闲聊 1 —— 体验问题
 *
 * 这个数是拍的，但它拍在明处、只有一处、可以改。比藏着一个「所有用例一样重」的隐含假设好。
 */
export const SEVERITY_BY_LAYER: Record<string, number> = {
  对抗: 5,
  操作: 3,
  展示: 2,
  闲聊: 1,
};

export function severityOf(c: { layer: string; weight?: number }): number {
  return (SEVERITY_BY_LAYER[c.layer] ?? 1) * (c.weight ?? 1);
}

/**
 * 报告里的层序。按「这一层发现问题有多难」排，不按字典序。
 *
 * 字典序排出来是 操作/对抗/闲聊/展示 —— 稳定但读不出意思，
 * 而且顺序会随层名变化跳来跳去，两次报告叠不到一起看。
 * 这个顺序和文档里介绍这些层的顺序一致：从最普通的展示，到最刁钻的对抗。
 */
export const LAYER_ORDER = ["展示", "操作", "闲聊", "对抗"];

export function layerRank(layer: string): number {
  const i = LAYER_ORDER.indexOf(layer);
  // 没列进来的层排最后，而不是排最前 —— 未知层不该顶到眼皮底下
  return i === -1 ? LAYER_ORDER.length : i;
}

/* ---------- 数据集内容哈希 ---------- */

/**
 * 只把**承载内容**的字段纳入哈希，且键排序、无多余空白。
 *
 * 为什么不能直接哈希整个文件：`review_status` 从 candidate 改成 approved、
 * 或者补一个 incident_id，都会让文件字节变化 —— 但那**不是**用例内容变了，
 * 拿它当「数据集变了」的信号会天天误报。反过来，把 input 或 expect 改了一个字，
 * 必须让哈希变。
 *
 * 所以哈希的对象是「这条用例在断言什么」，不是「这个文件长什么样」。
 */
function canonicalCase(c: EvalCase<unknown>): Record<string, unknown> {
  return {
    id: c.id,
    layer: c.layer,
    input: c.input,
    preset: c.preset ?? null,
    expect: c.expect,
  };
}

/**
 * 递归按键排序后序列化。
 *
 * 这里**不能**用 `JSON.stringify(v, keys)` 那个 replacer 数组的写法 ——
 * 它是对每一层递归生效的，而 `expect` 内部的键不在顶层键表里，
 * 于是 `expect` 会被序列化成 `{}`：**改期望值、哈希不变**。
 * 那样的哈希看着像在防「用例被悄悄改过」，实际什么都防不住。
 *
 * 教训和这个仓库其他地方一样：守卫要验证它会红。这条哈希有断言盯着（见 selftest 第十一节）。
 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function computeDatasetHash(cases: EvalCase<unknown>[]): string {
  const canonical = cases
    .map(canonicalCase)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const payload = stableStringify(canonical);
  return `sha256:${createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16)}`;
}

/* ---------- 结果与报告 ---------- */

export interface CaseResult {
  caseId: string;
  layer: string;
  status: CaseStatus;
  /** 0..1 这条用例的得分（本仓库是二元的：全对 1，否则 0，但接口留成连续值） */
  score: number;
  /** FAIL 时的原因 */
  reasons: string[];
  /** ERROR 时的原因。和 reasons 分开，因为它不是「哪里没做对」而是「没测出来」 */
  error: string;
  weight: number;
  input: string;
}

export interface CategoryStat {
  layer: string;
  total: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  /** 该层内部通过率，分子分母都只含 pass/fail */
  passRate: number;
}

export interface RunReport {
  runId: string;
  runAt: string;
  provider: string;
  datasetId: string;
  datasetVersion: string;
  datasetHash: string;
  gitCommit: string | null;

  results: CaseResult[];
  categoryStats: CategoryStat[];

  total: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;

  /** 通过率 = passed / (passed+failed)。ERROR 和 SKIP 都不进分母 */
  rawPassRate: number;
  /** 顶层数字：按层严重度加权的得分 */
  weightedScore: number;

  gatePassed: boolean;
  gateReasons: string[];
}

/**
 * 汇总。
 *
 * 分母的取法是这里唯一容易做错的地方：**ERROR 和 SKIP 都不进分母**。
 * 把 ERROR 算进分母，等于让基础设施故障拉低质量分；
 * 把 ERROR 算成通过，等于让机器坏了看起来一切正常。两种都是自欺。
 */
export function aggregate(input: {
  runId: string;
  runAt: string;
  provider: string;
  datasetId: string;
  datasetVersion: string;
  datasetHash: string;
  gitCommit: string | null;
  results: CaseResult[];
}): RunReport {
  const byLayer = new Map<string, CategoryStat>();
  let num = 0;
  let den = 0;

  for (const r of input.results) {
    const cs = byLayer.get(r.layer) ?? {
      layer: r.layer,
      total: 0,
      passed: 0,
      failed: 0,
      errored: 0,
      skipped: 0,
      passRate: 0,
    };
    cs.total += 1;
    if (r.status === "pass") cs.passed += 1;
    else if (r.status === "fail") cs.failed += 1;
    else if (r.status === "error") cs.errored += 1;
    else cs.skipped += 1;
    byLayer.set(r.layer, cs);

    if (r.status === "pass" || r.status === "fail") {
      den += r.weight;
      if (r.status === "pass") num += r.weight;
    }
  }

  for (const cs of byLayer.values()) {
    const scored = cs.passed + cs.failed;
    cs.passRate = scored === 0 ? 0 : cs.passed / scored;
  }

  const passed = input.results.filter((r) => r.status === "pass").length;
  const failed = input.results.filter((r) => r.status === "fail").length;
  const errored = input.results.filter((r) => r.status === "error").length;
  const skipped = input.results.filter((r) => r.status === "skip").length;
  const scoredTotal = passed + failed;

  return {
    runId: input.runId,
    runAt: input.runAt,
    provider: input.provider,
    datasetId: input.datasetId,
    datasetVersion: input.datasetVersion,
    datasetHash: input.datasetHash,
    gitCommit: input.gitCommit,
    results: input.results,
    categoryStats: [...byLayer.values()].sort((a, b) => layerRank(a.layer) - layerRank(b.layer)),
    total: input.results.length,
    passed,
    failed,
    errored,
    skipped,
    rawPassRate: scoredTotal === 0 ? 0 : passed / scoredTotal,
    weightedScore: den === 0 ? 0 : num / den,
    gatePassed: true,
    gateReasons: [],
  };
}
