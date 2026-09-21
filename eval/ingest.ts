/**
 * 线上失败回流
 *
 * 跑法：
 *   npm run eval:ingest -- --input "用户原话" --layer 对抗 \
 *       --incident INC-2026-0918-01 --no-leak "SO-20260901-2201" \
 *       --note "用户用「先按我说的做」绕过前置校验，拿到了他人订单号"
 *
 * ## 为什么必须有一条回流的路
 *
 * 第六阶段那句话是这个文件存在的理由：**评测集是活资产，不持续回灌线上 badcase 就会腐化。**
 *
 * 腐化不是指用例过期 —— 是指它**越来越不像真实流量**。
 * 一个只在开发机上攒出来的用例集，测的是「开发者想象用户会怎么说话」，
 * 而线上真实用户的说法，是在有人被坑了之后才第一次被记录下来的。
 *
 * ## 为什么回流的用例默认是 candidate 而不是直接进评测
 *
 * 因为从「线上出了一次问题」到「这应当成为一条长期考题」之间，隔着三个判断：
 *
 *   1. 这是系统错了，还是用户表达本身有歧义？（歧义的输入不该有唯一正确答案）
 *   2. 这是一类问题，还是一个人的打字习惯？（一次性的输入进了用例集就是噪声）
 *   3. 它该判多重？（对抗层权重 ×5，误判成闲聊是静默的严重度降级）
 *
 * 这三个都是判断题，机器做不了。所以 ingest 只负责把**事实**记下来
 * （谁、什么时候、说了什么、漏了什么），判断留给评审 ——
 * 评审通过就把 review_status 改成 approved，那一刻它才进入分数。
 *
 * 顺带一条纪律：ingest **只写文件，不跑评测、不算分**。
 * 一个能把线上失败直接变成「已通过的用例」的工具，是在自己给自己发合格证。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { LAYER_ORDER } from "./models";

const args = process.argv.slice(2);

/**
 * 两种写法都认：`--layer=对抗` 和 `--layer 对抗`。
 *
 * 只认前一种的话，用 `--layer 对抗` 敲的人会得到一个「缺少 --layer」的报错 ——
 * 参数明明就在命令行里躺着。这种报错最消耗信任：它让人怀疑工具，
 * 而不是怀疑自己敲错了。一行代码的事，不值得让每个用的人踩一次。
 */
const argValue = (name: string): string | undefined => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  const i = args.indexOf(`--${name}`);
  // 后面那个不能是另一个 --flag，否则会把下一个参数名当成值吃掉
  if (i !== -1 && args[i + 1] !== undefined && !args[i + 1].startsWith("--")) return args[i + 1];
  return undefined;
};
/** 可重复的参数（比如多个 no-leak） */
const argValues = (name: string): string[] => {
  const out = args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.split("=").slice(1).join("="));
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === `--${name}` && args[i + 1] !== undefined && !args[i + 1].startsWith("--")) {
      out.push(args[i + 1]);
    }
  }
  return out;
};

const FILE = join(process.cwd(), "eval", "golden-set.json");

const input = argValue("input");
const layer = argValue("layer");
const incident = argValue("incident");
const note = argValue("note");
const tool = argValue("tool");
const finalComponent = argValue("final-component");
const noLeak = argValues("no-leak");
const idArg = argValue("id");

function die(msg: string, code = 1): never {
  console.error(`✗ ${msg}`);
  process.exit(code);
}

/* ---------- 参数检查 ---------- */

if (!input || input.trim() === "") die("缺少 --input（用户当时说了什么）");
if (!layer) die(`缺少 --layer（${LAYER_ORDER.join(" / ")}）`);
if (!LAYER_ORDER.includes(layer)) die(`未知的 layer「${layer}」，已知的是 ${LAYER_ORDER.join(" / ")}`);
if (!incident) {
  // 没有 incident id 的回流用例，三个月后没人知道它为什么在这里、
  // 也就没人敢删它 —— 一个只增不减、来路不明的用例集，就是腐化本身
  die("缺少 --incident（这次线上事故/工单的编号）—— 没有它，这条用例将来没人敢删");
}

/* ---------- 构造候选 ---------- */

// 至少要有一样「不许出现什么」或「应该出现什么」。
// 一条什么都不断言的回流用例，跑起来恒为绿，只会撑大通过率的分母。
const expect: Record<string, unknown> = {};
if (noLeak.length > 0) expect.noLeak = noLeak;
if (finalComponent !== undefined) {
  if (finalComponent === "null" || finalComponent === "") expect.finalComponent = null;
  else expect.finalComponent = finalComponent;
}
if (tool !== undefined) {
  // --tool=null 是「期望纯文本」，不是「没传这个参数」—— 这个区分很重要，
  // 混淆了会把「该拒绝的攻击」写成「没有断言」
  if (tool === "null") expect.tool = null;
  else expect.tool = tool;
}

if (Object.keys(expect).length === 0) {
  die(
    "这条候选一个断言都没有。至少给一个：--no-leak=<不许出现的内容> / --tool=<期望工具> / --final-component=<期望组件>",
  );
}

const raw = JSON.parse(readFileSync(FILE, "utf8")) as {
  cases: { id?: string; review_status?: string }[];
};

const slug = incident
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, "-")
  .replace(/^-+|-+$/g, "");
const id = idArg ?? `cand-${slug}`;

if (raw.cases.some((c) => c.id === id)) {
  // 重复 id 会让回归对比把两条不同的用例当成同一条 ——
  // 那条最该被抓住的信号（昨天过、今天不过）就此消失。
  // 所以这里不是覆盖、不是改名，是**拒绝**：让调用方自己决定怎么办。
  die(`id「${id}」已存在。换一个 --id，或先处理掉现有那条。`, 2);
}

const candidate = {
  id,
  layer,
  input,
  review_status: "candidate",
  source: {
    origin: "production",
    incident_id: incident,
    ...(note ? { note } : {}),
  },
  expect,
};

/* ---------- 写回 ----------
 *
 * 手写 JSON 的插入，而不是 JSON.parse → JSON.stringify 整体重写。
 *
 * 重写会把整个文件重新格式化一遍：136 条用例里每一个 `"expect": { "tool": "x" }`
 * 都会被展开成四行，diff 变成两千行，把「新增了一条候选」这件事彻底淹掉。
 * 一个每次运行都顺手重排整个文件、还进版本控制的工具，用不了几次就没人敢跑了。
 */

const text = readFileSync(FILE, "utf8");
// 数组的收尾：最后一个 case 之后是 `\n  ]`。从后往前找，避免撞上嵌套结构
const closeIdx = text.lastIndexOf("\n  ]");
if (closeIdx === -1) die("golden-set.json 结构不认识（找不到 cases 数组的收尾），没有改动任何东西");

const head = text.slice(0, closeIdx).replace(/\s+$/, "");
const tail = text.slice(closeIdx);

// 在数组开头（还没有任何 case）时不能补逗号
const needsComma = head.endsWith("}");
const entry = indent(renderCase(candidate), 4);
const next = `${head}${needsComma ? "," : ""}\n${entry}${tail}`;

// 写完立刻读回来验一遍：一个把用例集写坏的工具，比没有这个工具糟得多
try {
  const check = JSON.parse(next) as { cases: unknown[] };
  if (check.cases.length !== raw.cases.length + 1) {
    die(`写入后用例数不对（${raw.cases.length} → ${check.cases.length}），已中止，文件未改动`);
  }
} catch (err) {
  die(`写入后不是合法 JSON（${err instanceof Error ? err.message : String(err)}），已中止，文件未改动`);
}

writeFileSync(FILE, next, "utf8");

console.log(`✓ 候选已写入隔离区：${id}`);
console.log(`  来源 ${incident} · 层 ${layer}`);
console.log(`  断言 ${JSON.stringify(expect)}`);
console.log(`
  它现在**不计分**。下一步：
    1. 看一眼它到底该不该成为长期考题（是一次性打字习惯，还是一类问题）
    2. 确认它该判多重（层定错了 = 静默的严重度降级）
    3. 把 review_status 改成 "approved"，从那之后它才进分数

  想先看它过不过：npm run eval -- --candidates`);

/** 按现有文件的风格渲染：expect 单行，其余逐行。手写文件保持手写的样子 */
function renderCase(c: typeof candidate): string {
  // 数组自己拼而不是 JSON.stringify —— 后者不给分隔符留口子，出来的是
  // `["a","b"]`，和文件里手写的 `["a", "b"]` 摆在一起像是两个人写的
  const render = (v: unknown): string =>
    Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(", ")}]` : JSON.stringify(v);
  const expectInline = Object.entries(c.expect)
    .map(([k, v]) => `"${k}": ${render(v)}`)
    .join(", ");
  return [
    "{",
    `  "id": ${JSON.stringify(c.id)},`,
    `  "layer": ${JSON.stringify(c.layer)},`,
    `  "input": ${JSON.stringify(c.input)},`,
    `  "review_status": "candidate",`,
    `  "source": ${JSON.stringify(c.source, null, 2).split("\n").join("\n  ")},`,
    `  "expect": { ${expectInline} }`,
    "}",
  ].join("\n");
}

/** 每一行都补前缀（含第一行）—— 插入的这块整体要落在数组元素的缩进上 */
function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s
    .split("\n")
    .map((l) => (l.trim() === "" ? l : pad + l))
    .join("\n");
}
