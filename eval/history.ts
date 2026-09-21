/**
 * 评测存档与回归对比
 *
 * ## 为什么评测必须留档
 *
 * 一个只往 stdout 打印的评测，跑完就什么都没了。它无法回答三个问题：
 *   1. 这次 95% 和上次 95% 是同一批用例吗？
 *   2. 刚才改的那句 Prompt，是修好了一个用例，还是改坏了另外三个？
 *   3. 三个月后回头看，准确率是在涨还是在悄悄退？
 *
 * 第四阶段把「评测集建设」列为最容易被低估的隐藏关键路径，第六阶段更直接点名
 * 「评测集是活资产，不持续回灌线上 badcase 就会腐化」。腐化的前提是有东西可以腐化 ——
 * 所以第一件事是把每次结果落盘，让「变化」这件事变得可见。
 *
 * ## 存档里为什么要记 datasetHash 和 gitCommit
 *
 * 因为「通过率从 100% 掉到 92%」这句话本身没有信息量：它可能是代码改坏了，
 * 也可能是有人往用例集里加了两条本来就过不了的用例。这两个原因的处理方式完全相反
 * （一个回滚代码，一个评审用例），而光看通过率分不出来。
 *
 *   datasetHash 变了 → 变的是**考卷**
 *   datasetHash 没变 → 变的是**答题的**
 *
 * 有了这两个字段，上面那句话才有资格进入讨论。
 *
 * 存档落在 eval-runs/，不进版本控制（它是运行产物，不是源码）。
 */
import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CategoryStat, CaseResult, RunReport } from "./models";

const RUNS_DIR = join(process.cwd(), "eval-runs");
/** 追加式的趋势索引。一行一次运行 —— 不用读几十个 JSON 就能画出一条线 */
const INDEX_FILE = join(RUNS_DIR, "index.jsonl");

export interface FailureRecord {
  id: string;
  input: string;
  /** FAIL 的原因：哪里没做对 */
  reasons: string[];
}

export interface ErrorRecord {
  id: string;
  input: string;
  /** ERROR 的原因：没测出来。和 reasons 分开是有意的 */
  error: string;
}

export interface RunRecord {
  /** 本次跑的标识，同时是文件名 */
  runId: string;
  runAt: string;
  provider: string;
  /** 用例集标识与版本 */
  datasetId: string;
  datasetVersion: string;
  /**
   * 用例集**内容**哈希（只含 input/expect 这类承载断言的字段）。
   * 用它区分「考试内容变了」和「应试水平变了」—— 见文件头。
   */
  datasetHash: string;
  /** 跑这次评测时的代码版本。没有 git 时为 null */
  gitCommit: string | null;

  total: { ok: number; total: number };
  /** 四态分开存。只存一个 ok/total 的话，事后没人分得清那几条是失败还是崩溃 */
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  /** 通过率 = passed/(passed+failed)，异常和跳过都不进分母 */
  rawPassRate: number;
  /** 按层严重度加权后的得分，跨层比较用这个 */
  weightedScore: number;

  layers: CategoryStat[];
  failures: FailureRecord[];
  errors: ErrorRecord[];
  /** 本次有多少条用例因为没评审而没跑（隔离区） */
  quarantined: number;

  gatePassed: boolean;
  gateReasons: string[];
}

export interface RunStamp {
  runId: string;
  runAt: string;
}

function shortCommit(): string | null {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    // 没有 git（比如打了 zip 包）不该让评测跑不起来 —— 这只是个辅助信息
    return null;
  }
}

function stampId(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 本次运行的时间戳标识。聚合和存档共用同一份，避免两处各生成一个对不上 */
export function runStamp(now: Date = new Date()): RunStamp {
  return { runId: stampId(now), runAt: now.toISOString() };
}

/**
 * 从报告生成存档记录。
 *
 * 拿报告当唯一输入，而不是让调用方再喂一遍各项计数 ——
 * 两个地方各算一遍总数，迟早会出现「存档里的数」和「屏幕上的数」不一样，
 * 而那种 bug 最难发现：两个数字看着都合理。
 */
export function buildRecord(
  report: RunReport,
  extra: { quarantined?: number; results?: CaseResult[] } = {},
): RunRecord {
  const results = extra.results ?? report.results;
  return {
    runId: report.runId,
    runAt: report.runAt,
    provider: report.provider,
    datasetId: report.datasetId,
    datasetVersion: report.datasetVersion,
    datasetHash: report.datasetHash,
    gitCommit: shortCommit(),
    total: { ok: report.passed, total: report.passed + report.failed },
    passed: report.passed,
    failed: report.failed,
    errored: report.errored,
    skipped: report.skipped,
    rawPassRate: report.rawPassRate,
    weightedScore: report.weightedScore,
    layers: report.categoryStats,
    failures: results
      .filter((r) => r.status === "fail" && r.reasons.length > 0)
      .map((r) => ({ id: r.caseId, input: r.input, reasons: r.reasons })),
    errors: results
      .filter((r) => r.status === "error")
      .map((r) => ({ id: r.caseId, input: r.input, error: r.error })),
    quarantined: extra.quarantined ?? 0,
    gatePassed: report.gatePassed,
    gateReasons: report.gateReasons,
  };
}

export function saveRun(record: RunRecord): string {
  mkdirSync(RUNS_DIR, { recursive: true });
  const file = join(RUNS_DIR, `${record.runId}.json`);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  // 趋势索引：一行一次运行，只放看趋势用得上的字段。
  // 完整结果在同名 JSON 里 —— 索引只负责「一眼看出在涨还是在退」。
  appendFileSync(
    INDEX_FILE,
    `${JSON.stringify({
      runId: record.runId,
      runAt: record.runAt,
      provider: record.provider,
      datasetHash: record.datasetHash,
      gitCommit: record.gitCommit,
      passed: record.passed,
      failed: record.failed,
      errored: record.errored,
      skipped: record.skipped,
      rawPassRate: record.rawPassRate,
      weightedScore: record.weightedScore,
      gatePassed: record.gatePassed,
    })}\n`,
    "utf8",
  );
  return file;
}

/** 读取历史存档，按时间倒序。坏文件跳过而不是让整个评测挂掉。 */
export function listRuns(): RunRecord[] {
  let names: string[] = [];
  try {
    names = readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const runs: RunRecord[] = [];
  for (const name of names) {
    try {
      runs.push(JSON.parse(readFileSync(join(RUNS_DIR, name), "utf8")) as RunRecord);
    } catch {
      // 忽略
    }
  }
  return runs.sort((a, b) => b.runId.localeCompare(a.runId));
}

export interface IndexEntry {
  runId: string;
  runAt: string;
  provider: string;
  datasetHash: string;
  gitCommit: string | null;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  rawPassRate: number;
  weightedScore: number;
  gatePassed: boolean;
}

/** 趋势索引。老存档（早于这个字段）没有 index.jsonl 时返回空数组而不是报错。 */
export function readIndex(): IndexEntry[] {
  try {
    return readFileSync(INDEX_FILE, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as IndexEntry);
  } catch {
    return [];
  }
}

export interface Comparison {
  previous: RunRecord | null;
  /** 用例集内容是否一致 —— 不一致时逐条对比不可靠 */
  sameGolden: boolean;
  /** 这次挂了、上次没挂的（真回归）。只比 PASS→FAIL，异常不算回归 */
  regressed: FailureRecord[];
  /** 上次挂了、这次过了的 */
  fixed: FailureRecord[];
  /** 上次异常、这次好了的。单独一类 —— 机器修好了不是模型变准了 */
  recovered: ErrorRecord[];
  /** 新出现的异常。这类最该先看：分母悄悄变少了 */
  newErrors: ErrorRecord[];
  /** 总体通过数的变化 */
  totalDelta: number;
  /** 加权得分的变化（百分点） */
  scoreDelta: number;
  layerDeltas: { layer: string; from: string; to: string; delta: number }[];
}

const EMPTY: Comparison = {
  previous: null,
  sameGolden: true,
  regressed: [],
  fixed: [],
  recovered: [],
  newErrors: [],
  totalDelta: 0,
  scoreDelta: 0,
  layerDeltas: [],
};

export function compare(current: RunRecord, previous: RunRecord | null): Comparison {
  if (!previous) return { ...EMPTY };

  const prevFailed = new Set(previous.failures.map((f) => f.id));
  const currFailed = new Set(current.failures.map((f) => f.id));
  const prevErrored = new Set((previous.errors ?? []).map((e) => e.id));

  // 回归只看 PASS→FAIL。
  //
  // 上次通过、这次**异常**的那条不算回归 —— 它不是「变得不对了」，
  // 是「这次没测出来」。混进回归列表，CI 会在机器抖动时红，
  // 而一个会随机红的门禁，唯一的下场是被加 `continue-on-error`。
  const regressed = current.failures.filter((f) => !prevFailed.has(f.id));
  const fixed = previous.failures.filter((f) => !currFailed.has(f.id));
  const recovered = (previous.errors ?? []).filter(
    (e) => !(current.errors ?? []).some((c) => c.id === e.id),
  );
  const newErrors = (current.errors ?? []).filter((e) => !prevErrored.has(e.id));

  const layerNames = [
    ...new Set([...(previous.layers ?? []), ...(current.layers ?? [])].map((l) => l.layer)),
  ];
  const layerDeltas = layerNames.map((layer) => {
    const from = previous.layers?.find((l) => l.layer === layer);
    const to = current.layers?.find((l) => l.layer === layer);
    return {
      layer,
      from: from ? `${from.passed}/${from.passed + from.failed}` : "—",
      to: to ? `${to.passed}/${to.passed + to.failed}` : "—",
      delta: (to?.passed ?? 0) - (from?.passed ?? 0),
    };
  });

  return {
    previous,
    // 比哈希而不是比版本号：版本号是手写的，改内容忘了改版本号是常事，
    // 而那个失误恰好会让这道保护失效在最需要它的时候
    sameGolden: previous.datasetHash === current.datasetHash,
    regressed,
    fixed,
    recovered,
    newErrors,
    totalDelta: current.passed - previous.passed,
    scoreDelta: (current.weightedScore - previous.weightedScore) * 100,
    layerDeltas,
  };
}
