/**
 * 评测趋势
 *
 * 跑法：npm run eval:trend [-- --last=20]
 *
 * ## 为什么要有这个，而不是直接看 eval-runs/ 里的 JSON
 *
 * `--strict` 只知道**上一次**。它能抓住「刚才那一下改坏了什么」，
 * 抓不住「最近十次每次掉 0.3%」—— 而后者才是真实项目里最常见的退化方式：
 * 没有任何一次改动坏到值得回滚，三个月后却发现准确率掉了 8 个点。
 *
 * 单次对比和趋势观察是两个不同的工具：
 *   单次对比回答「这次改动有没有问题」（CI 里卡关）
 *   趋势回答「我们是不是在往一个坏方向走」（人定期看）
 *
 * 数据来自 eval-runs/index.jsonl —— 每次运行追加一行，所以这个脚本
 * 不需要读几十个 JSON 文件就能画出一条线。
 */

import { readIndex } from "./history";
import type { IndexEntry } from "./history";

const args = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && args[i + 1] !== undefined && !args[i + 1].startsWith("--")) return args[i + 1];
  return undefined;
};

const last = Number(argValue("last") ?? "20");

const all = readIndex();
if (all.length === 0) {
  console.log("还没有任何评测存档。先跑一次 npm run eval。");
  process.exit(0);
}

const runs = all.slice(-last);
const pad = (s: string, n: number) =>
  s + " ".repeat(Math.max(0, n - [...s].reduce((w, ch) => w + (/[一-龥]/.test(ch) ? 2 : 1), 0)));

/**
 * 用方块字符画一条走势。
 *
 * 只画加权得分，不画通过率 —— 两个数字都画出来，人会本能地盯着「通过率」
 * 那个更好看的看。走势图只留一个数字，逼着看的人看那个真正跨层可比的。
 */
function sparkline(values: number[]): string {
  const blocks = "▁▂▃▄▅▆▇█";
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return values
    .map((v) => {
      // 全部相等时给中间高度：一条平线不该看起来像在缓慢上升
      if (hi === lo) return "▄";
      const i = Math.round(((v - lo) / (hi - lo)) * (blocks.length - 1));
      return blocks[i];
    })
    .join("");
}

console.log(`评测趋势（最近 ${runs.length} 次，共 ${all.length} 次存档）\n`);

console.log(
  `  ${pad("时间", 16)}${pad("provider", 10)}${"次数".padEnd(9)}${"加权得分".padEnd(10)}${"异常".padEnd(6)}${pad("commit", 9)}用例集`,
);
for (const r of runs) {
  const scored = `${r.passed}/${r.passed + r.failed}`;
  // 异常非零的那次整行标出来：那一次的比率都不可信，不该被当成一个数据点看
  const flag = r.errored > 0 ? "⚠" : " ";
  console.log(
    `  ${pad(r.runId, 16)}${pad(r.provider, 10)}${scored.padEnd(9)}${`${(r.weightedScore * 100).toFixed(1)}%`.padEnd(10)}${`${r.errored > 0 ? r.errored : "-"}`.padEnd(6)}${pad(r.gitCommit ?? "—", 9)}${r.datasetHash}${flag}`,
  );
}

const scores = runs.map((r) => r.weightedScore * 100);
const clean = runs.filter((r) => r.errored === 0);
console.log(`\n  加权得分走势  ${sparkline(clean.map((r) => r.weightedScore * 100))}`);
console.log(`                ${clean.length} 次无异常运行，${Math.min(...scores).toFixed(1)}% ~ ${Math.max(...scores).toFixed(1)}%`);

/**
 * 用例集换过几次 —— 这一行是「上面的走势能不能直接读」的前提。
 * 换过考卷的话，得分的起伏里混着难度变化，不能简单当成水平变化。
 */
const hashes = [...new Set(runs.map((r) => r.datasetHash))];
if (hashes.length === 1) {
  console.log(`\n  这段区间用例集没变过（${hashes[0]}）—— 上面的起伏是代码/模型造成的，可以直接读。`);
} else {
  console.log(`\n  ⚠ 这段区间用例集换过 ${hashes.length} 个版本：${hashes.join(" → ")}`);
  console.log("     换考卷的那几次之间不能直接比分数 —— 变的是题，不一定是水平。");
}

const lastFailed = runs[runs.length - 1].gatePassed;
console.log(`\n  最近一次门槛：${lastFailed ? "✓ 达标" : "✗ 未达标"}`);

/** 连续未达标的次数。一次没达标是意外，连着几次就是系统性问题了 */
let streak = 0;
for (let i = runs.length - 1; i >= 0; i -= 1) {
  if (runs[i].gatePassed) break;
  streak += 1;
}
if (streak >= 3) {
  console.log(`  已经连续 ${streak} 次没达标 —— 这不再是一次意外了。`);
}

export type { IndexEntry };
