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
 * 存档落在 eval-runs/，不进版本控制（它是运行产物，不是源码）。
 */

import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RUNS_DIR = join(process.cwd(), "eval-runs");

export interface LayerStat {
  layer: string;
  ok: number;
  total: number;
}

export interface FailureRecord {
  id: string;
  input: string;
  reasons: string[];
}

export interface RunRecord {
  /** 本次跑的标识，同时是文件名 */
  runId: string;
  runAt: string;
  provider: string;
  /** 用例集版本。与上次不同时，逐条对比会失真，只能看总数 */
  goldenVersion: string;
  /** 跑这次评测时的代码版本。没有 git 时为 null */
  gitCommit: string | null;
  total: { ok: number; total: number };
  layers: LayerStat[];
  failures: FailureRecord[];
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

export function buildRecord(input: {
  provider: string;
  goldenVersion: string;
  layers: LayerStat[];
  failures: FailureRecord[];
}): RunRecord {
  const now = new Date();
  const total = input.layers.reduce((s, l) => s + l.total, 0);
  const ok = input.layers.reduce((s, l) => s + l.ok, 0);
  return {
    runId: stampId(now),
    runAt: now.toISOString(),
    provider: input.provider,
    goldenVersion: input.goldenVersion,
    gitCommit: shortCommit(),
    total: { ok, total },
    layers: input.layers,
    failures: input.failures,
  };
}

export function saveRun(record: RunRecord): string {
  mkdirSync(RUNS_DIR, { recursive: true });
  const file = join(RUNS_DIR, `${record.runId}.json`);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
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

export interface Comparison {
  previous: RunRecord | null;
  /** 用例集版本是否一致 —— 不一致时逐条对比不可靠 */
  sameGolden: boolean;
  /** 这次挂了、上次没挂的（真回归） */
  regressed: FailureRecord[];
  /** 上次挂了、这次过了的 */
  fixed: FailureRecord[];
  /** 总体通过数的变化 */
  totalDelta: number;
  layerDeltas: { layer: string; from: string; to: string; delta: number }[];
}

export function compare(current: RunRecord, previous: RunRecord | null): Comparison {
  if (!previous) {
    return {
      previous: null,
      sameGolden: true,
      regressed: [],
      fixed: [],
      totalDelta: 0,
      layerDeltas: [],
    };
  }

  const prevFailed = new Map(previous.failures.map((f) => [f.id, f]));
  const currFailed = new Map(current.failures.map((f) => [f.id, f]));

  const regressed = current.failures.filter((f) => !prevFailed.has(f.id));
  const fixed = previous.failures.filter((f) => !currFailed.has(f.id));

  const layers = [...new Set([...previous.layers, ...current.layers].map((l) => l.layer))];
  const layerDeltas = layers.map((layer) => {
    const from = previous.layers.find((l) => l.layer === layer);
    const to = current.layers.find((l) => l.layer === layer);
    return {
      layer,
      from: from ? `${from.ok}/${from.total}` : "—",
      to: to ? `${to.ok}/${to.total}` : "—",
      delta: (to?.ok ?? 0) - (from?.ok ?? 0),
    };
  });

  return {
    previous,
    sameGolden: previous.goldenVersion === current.goldenVersion,
    regressed,
    fixed,
    totalDelta: current.total.ok - previous.total.ok,
    layerDeltas,
  };
}
