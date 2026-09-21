/**
 * 用例集体检
 *
 * 跑法：npm run eval:validate
 *
 * ## 为什么评测之前要先查用例集
 *
 * 评测的结论完全建立在「用例集本身是对的」这个前提上，而那个前提没人检查。
 * 一条 `expect` 写成空对象的用例，跑出来永远是绿的 —— 它什么都没断言，
 * 却会实实在在地抬高通过率的分母。一条 id 重复的用例，会让回归对比把两条
 * 不同的用例当成同一条，于是「昨天过今天不过」永远抓不到。
 *
 * 这类问题的共同点是：**它们让评测变绿**。所以靠看报告发现不了，
 * 只能在评测开始之前单独查一遍。
 *
 * 这里查的都是「一定是错的」的东西，不查风格（比如用例该写多少条、
 * 输入该长什么样）—— 那些是判断题，交给评审，不该让脚本替人拍板。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { computeDatasetHash, LAYER_ORDER } from "./models";
import type { ReviewStatus } from "./models";

const REVIEW_STATUSES: ReviewStatus[] = ["approved", "candidate", "deprecated"];

/** Expect 里算得上「一条断言」的键。全都没有，这条用例就没在考任何东西 */
const ANCHOR_KEYS = [
  "tool",
  "anyOf",
  "forbiddenTools",
  "finalComponent",
  "noRawHtml",
  "noLeak",
  "componentFields",
] as const;

interface RawCase {
  id?: unknown;
  layer?: unknown;
  input?: unknown;
  expect?: unknown;
  review_status?: unknown;
  weight?: unknown;
  source?: unknown;
}

interface RawSet {
  dataset_id?: unknown;
  version?: unknown;
  cases?: unknown;
}

const problems: string[] = [];
const warnings: string[] = [];
const bad = (m: string) => problems.push(m);
const warn = (m: string) => warnings.push(m);

const raw = JSON.parse(
  readFileSync(join(process.cwd(), "eval", "golden-set.json"), "utf8"),
) as RawSet;

/* ---------- 数据集级别 ---------- */

if (typeof raw.dataset_id !== "string" || raw.dataset_id.trim() === "") {
  // 没有 id 的用例集，留档之后无法回答「这个 95% 是哪份考卷的 95%」
  bad("缺少 dataset_id");
}
if (typeof raw.version !== "string" || raw.version.trim() === "") {
  bad("缺少 version");
}
if (!Array.isArray(raw.cases)) {
  bad("cases 不是数组");
}

const cases = (Array.isArray(raw.cases) ? raw.cases : []) as RawCase[];

if (cases.length === 0) {
  bad("用例集是空的");
}

/* ---------- 逐条 ---------- */

const seen = new Set<string>();
const knownLayers = new Set(LAYER_ORDER);

for (const [i, c] of cases.entries()) {
  // 用位置兜底，因为 id 本身可能就是缺的那个 —— 报错信息里总得指得到某一行
  const where = typeof c.id === "string" && c.id ? c.id : `#${i}`;

  if (typeof c.id !== "string" || c.id.trim() === "") {
    bad(`${where}：缺少 id`);
  } else if (seen.has(c.id)) {
    // 重复 id 的后果比看起来严重：回归对比按 id 配对，重复会让两条用例
    // 在历史里互相顶替，「昨天过今天不过」这条最该被抓住的信号直接消失
    bad(`${c.id}：id 重复`);
  } else {
    seen.add(c.id);
  }

  if (typeof c.input !== "string" || c.input.trim() === "") {
    bad(`${where}：缺少 input`);
  }

  if (typeof c.layer !== "string") {
    bad(`${where}：缺少 layer`);
  } else if (!knownLayers.has(c.layer)) {
    // 未知的层名会掉进 severityOf 的兜底权重 1（= 闲聊），
    // 一条对抗用例被当成闲聊计分，是静默的严重度降级
    bad(`${where}：未知的 layer「${c.layer}」，已知的是 ${LAYER_ORDER.join(" / ")}`);
  }

  const status = c.review_status ?? "approved";
  if (typeof status !== "string" || !REVIEW_STATUSES.includes(status as ReviewStatus)) {
    bad(`${where}：未知的 review_status「${String(c.review_status)}」`);
  }

  if (c.weight !== undefined && (typeof c.weight !== "number" || c.weight <= 0)) {
    bad(`${where}：weight 必须是正数，现在是 ${String(c.weight)}`);
  }

  const expect = c.expect;
  if (expect === null || typeof expect !== "object" || Array.isArray(expect)) {
    bad(`${where}：expect 不是对象`);
    continue;
  }

  const e = expect as Record<string, unknown>;
  const anchors = ANCHOR_KEYS.filter((k) => e[k] !== undefined);
  if (anchors.length === 0) {
    // 空 expect 是这个文件里唯一「查出来一定是 bug」的东西：
    // 它跑起来恒为绿，还会把通过率的分母撑大
    bad(`${where}：expect 里没有任何断言（${ANCHOR_KEYS.join(" / ")} 一个都没有）`);
  }

  if (status === "approved" && anchors.length === 0) {
    warn(`${where}：已批准但没有断言锚点`);
  }

  if (e.noLeak !== undefined) {
    if (!Array.isArray(e.noLeak) || e.noLeak.length === 0) {
      bad(`${where}：noLeak 必须是非空数组`);
    } else if (e.noLeak.some((s) => typeof s !== "string" || s.trim() === "")) {
      // 空字符串会让 includes("") 恒为真 —— 整条用例从此永远是红的
      bad(`${where}：noLeak 里有空字符串（includes("") 恒真，这条会永远失败）`);
    }
  }

  if (e.anyOf !== undefined && (!Array.isArray(e.anyOf) || e.anyOf.length === 0)) {
    bad(`${where}：anyOf 必须是非空数组`);
  }

  if (e.tool !== undefined && e.anyOf !== undefined) {
    // 两个都写时，跑评测那侧只认 anyOf，tool 会被静默忽略 ——
    // 写的人以为自己在收紧，实际那条约束根本没生效
    warn(`${where}：同时写了 tool 和 anyOf，判定时只认 anyOf（tool 被忽略）`);
  }

  // 候选用例必须说清它从哪来。一条来路不明的候选进了隔离区，
  // 评审的人无从判断它值不值得转正
  if (status === "candidate" && (c.source === undefined || typeof c.source !== "object")) {
    warn(`${where}：候选用例没写 source，评审时看不出它从哪来`);
  }
}

/* ---------- 报告 ---------- */

const hash = computeDatasetHash(cases as never);
const counts = REVIEW_STATUSES.map((s) => {
  const n = cases.filter((c) => (c.review_status ?? "approved") === s).length;
  return `${s} ${n}`;
}).join(" · ");

console.log(`用例集 ${String(raw.dataset_id)} v${String(raw.version)} · ${hash}`);
console.log(`${cases.length} 条 · ${counts}`);
const byLayer = LAYER_ORDER.filter((l) => cases.some((c) => c.layer === l))
  .map((l) => `${l} ${cases.filter((c) => c.layer === l).length}`)
  .join(" · ");
console.log(`分层：${byLayer}`);

if (warnings.length > 0) {
  console.log(`\n提醒（${warnings.length}，不拦人）`);
  for (const w of warnings) console.log(`  · ${w}`);
}

if (problems.length > 0) {
  console.log(`\n✗ 用例集有 ${problems.length} 处问题：`);
  for (const p of problems) console.log(`  · ${p}`);
  console.log("\n这些问题都会让评测**变绿**，所以在跑评测之前先修掉。");
  process.exit(1);
}

console.log("\n✓ 用例集通过体检");
