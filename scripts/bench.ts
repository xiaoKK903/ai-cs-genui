/**
 * 时延实测
 *
 * 跑法：
 *   npm run bench               # 按默认演示参数（打字机 18ms/块、取数 260ms）
 *   npm run bench -- --n=50     # 每类输入跑 50 次
 *
 * ## 这个脚本测什么、不测什么
 *
 * **测**服务端这一段：从收到请求到第一个字节出门（TTFB）、骨架屏下发时刻、
 * 组件信封下发时刻、整轮结束时刻。这些都在我们的进程里，测出来是多少就是多少。
 *
 * **不测** CLS。CLS 是浏览器的布局事实，取决于骨架屏占位的高度和组件渲染出来的
 * 高度差多少 —— 那需要真的把页面渲染一遍。用 Node 去「算」一个 CLS，
 * 得到的是一个看起来很像数字的东西，但它不反映任何真实用户的体验。
 * 与其在指标看板上放一个假的 CLS，不如在这里写清楚它没被测，
 * 并且在 README 里给出浏览器里怎么量（PerformanceObserver + layout-shift）。
 *
 * 第四阶段的指标表里 TTFB ≤ 1.0s 是可以在这里验的；CLS ≤ 0.1 不行。
 * 把能验的和不能验的分开写，比一个「全部通过」的假绿灯有用。
 *
 * ## 为什么用分位数而不是平均值
 *
 * 平均值会被两类东西带偏：一次 GC 停顿，或者一次冷启动。用户感知到的是
 * 「我这一把等了多久」，所以 p95 才是有意义的那个数 —— 它回答的是
 * 「最慢的那二十分之一有多慢」。
 */

export {};

import type { SSEEventName, SSEEventPayloadMap } from "../core/protocol/types";

process.env.DB_PATH = ":memory:";
process.env.AUDIT_LOG = "off";
// 这里刻意不动 MOCK_* 延迟：它们就是演示时用户真实看到的节奏

const args = process.argv.slice(2);
const argValue = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const N = Number(argValue("n") ?? "30");

const { getAdapter } = await import("../core/llm");
const { buildSystemPrompt } = await import("../core/llm/prompt");
const { getOrCreateSession, __resetSessions } = await import("../core/data/session");
const { dispatchToolCalls } = await import("../core/gateway/dispatch");
const { TraceBuilder } = await import("../core/trace");
const { newCorrelationId } = await import("../core/protocol/envelope");
const { DEMO_SESSION_USER_ID } = await import("../core/data/order-service");
const { __truncateAll, ensureSeeded } = await import("../core/data/seed");

/**
 * 挑三类输入，是因为它们的路径长度不一样：
 *   闲聊根本不调工具，量出来的是「纯模型 + 网络」的地板；
 *   展示要取数 + 渲染，是主路径；
 *   操作还要过退款表单的字段构造。
 * 只看一个平均值会把这三条路径糊在一起，掩盖掉最长的那条。
 */
const INPUTS = [
  { label: "闲聊", text: "你好" },
  { label: "展示", text: "看下我最近的订单" },
  { label: "操作", text: "给订单 SO-20260910-6620 退款" },
];

interface Sample {
  ttfb: number;
  skeleton: number | null;
  component: number | null;
  total: number;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function runOne(text: string, sessionId: string): Promise<Sample> {
  __truncateAll();
  ensureSeeded();

  const session = getOrCreateSession(sessionId, DEMO_SESSION_USER_ID);
  const trace = new TraceBuilder(newCorrelationId());
  const started = performance.now();

  let ttfb: number | null = null;
  let skeleton: number | null = null;
  let component: number | null = null;

  const emit = {
    closed: false,
    send<K extends SSEEventName>(event: K, _data: SSEEventPayloadMap[K]) {
      const at = performance.now() - started;
      if (ttfb === null) ttfb = at;
      if (event === "skeleton" && skeleton === null) skeleton = at;
      if (event === "component" && component === null) component = at;
    },
  };

  const system = buildSystemPrompt({
    today: new Date().toISOString().slice(0, 10),
    lastOrderNo: session.lastOrderNo,
    hasRefundResult: Boolean(session.lastRefundResult),
  });

  // 必须把 onTextDelta 接上，否则模型那段流式根本不会发生 ——
  // mock 在没有 handler 时会直接返回，量出来的 TTFB 会是个漂亮的 0ms。
  // 这类「因为没接上而显得很快」的数字，比没有数字更危险。
  const decision = await getAdapter().decide(
    { system, history: [], userText: text },
    { onTextDelta: (delta) => emit.send("text_delta", { delta, correlationId: "" }) },
  );
  await dispatchToolCalls(decision.toolCalls, {
    session,
    correlationId: newCorrelationId(),
    emit: emit as never,
    trace,
    textOnly: false,
  });

  const total = performance.now() - started;
  return { ttfb: ttfb ?? total, skeleton, component, total };
}

/* ---------- 跑 ---------- */

console.log(`时延实测 · provider=${getAdapter().name} · 每类 ${N} 次\n`);

const fmt = (v: number | null) => (v === null ? "—" : `${v.toFixed(0)}ms`);
const pad = (s: string, n: number) =>
  s + " ".repeat(Math.max(0, n - [...s].reduce((w, ch) => w + (/[一-龥]/.test(ch) ? 2 : 1), 0)));

console.log(`${pad("路径", 8)}${pad("指标", 14)}${"p50".padStart(8)}${"p95".padStart(8)}`);
console.log("─".repeat(40));

const allTotals: number[] = [];

for (const input of INPUTS) {
  const samples: Sample[] = [];
  for (let i = 0; i < N; i += 1) {
    __resetSessions();
    samples.push(await runOne(input.text, `bench_${i}`));
  }

  const rows: [string, number[]][] = [
    ["TTFB", samples.map((s) => s.ttfb)],
    ["骨架屏", samples.map((s) => s.skeleton).filter((v): v is number => v !== null)],
    ["组件信封", samples.map((s) => s.component).filter((v): v is number => v !== null)],
    ["整轮", samples.map((s) => s.total)],
  ];

  rows.forEach(([name, values], i) => {
    if (values.length === 0) return;
    const label = i === 0 ? input.label : "";
    console.log(
      `${pad(label, 8)}${pad(name, 14)}${fmt(percentile(values, 50)).padStart(8)}${fmt(percentile(values, 95)).padStart(8)}`,
    );
  });
  allTotals.push(...samples.map((s) => s.total));
}

console.log("─".repeat(40));
const p95 = percentile(allTotals, 95);
console.log(
  `\n全部路径 p95 整轮时延：${p95.toFixed(0)}ms —— 第四阶段门槛 TTFB ≤ 1000ms（上表 TTFB 行）`,
);

console.log(`
关于 TTFB 这一行：mock 下它恒为 0～1ms，因为那条路径上没有任何真实网络 ——
第一个字符是被「立即」推出去的，这不是优化出来的结果，是没有网络往返这个事实。
所以 mock 基线里真正有信息量的是「组件信封」和「整轮」两行（它们包含取数延迟）。
要看真实的 TTFB，得换真模型：LLM_PROVIDER=anthropic npm run bench
（那一次往返里包含模型的首 token 时间，才是这个指标真正在量的东西）。

未测：CLS ≤ 0.1。
  它是浏览器的布局事实，取决于骨架屏占位高度与组件实际渲染高度之差，
  需要真的把页面渲染一遍才能量。在 Node 里算出来的任何「CLS」都不反映用户体验，
  放进看板只会让人以为它被测过了。
  浏览器里怎么量（供后续补上）：
    new PerformanceObserver(list => { /* entry.value 累加即 CLS */ })
      .observe({ type: "layout-shift", buffered: true });
  关键点是只累加「非用户输入引起」的位移（entry.hadRecentInput === false），
  骨架屏→组件的替换如果是同高度互换，这一次替换对 CLS 的贡献是 0。`);
