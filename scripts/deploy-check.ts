/**
 * 部署检查 —— 「能部署」得有一个可执行的判据
 *
 * 跑法：
 *   npm run build && npm run check:deploy
 *
 * ## 为什么这个检查必须存在
 *
 * 前面所有的检查（selftest / eval / persistence-check）都是**进程内**的：
 * 直接 import 模块、直接调函数。这批检查证明的是「逻辑是对的」，
 * 证明不了「这个东西能作为一个服务跑起来」。
 *
 * 这两件事之间的差距不是理论上的。`next dev` 能跑而 `next build` 挂掉的例子
 * 有一整类：只在服务端出现的 `node:` 内置模块被打进了客户端包、Edge runtime
 * 不支持某个 API、动态导入的路径在打包后变了…… 这些在 dev 模式下**全都是绿的**，
 * 因为它们要么没被编译、要么按需编译。等发现的时候通常是在部署流水线里 ——
 * 也就是说，一个「本地全绿」的仓库可以在第一次部署时才发现跑不起来。
 *
 * ## 这个检查刻意不 mock 的两处
 *
 * ① **跑的是生产构建产物**（`next start`，不是 `next dev`）。dev 模式有
 *    按需编译和更宽松的模块解析，拿它验证「能不能部署」等于没验。
 *
 * ② **OTLP 接收端是一个真的 HTTP server**，跑在本进程里，收的是生产进程
 *    真的发出来的字节。所以这里验的不是「sink 被调用了」，是「出网的那份报文
 *    里有什么」。可观测性那一节最要命的性质恰好是这一条：脱敏是不是真的生效，
 *    只有在报文**已经离开进程**之后才谈得上验证。
 *
 * ## 一条分岔的断言
 *
 * 同一个 canary（用户原话里的手机号）在两条腿上的去向必须**相反**：
 *   - 本地 `.audit/turns.jsonl` —— 必须**有**（不然出事时查不了）
 *   - 出境的 OTLP 报文 —— 必须**没有**（不然就是泄露）
 *
 * 这一条如果不分岔，只验一半都是自欺：只查本地会漏掉泄露，
 * 只查出境会漏掉「脱敏脱到自己人也没法排查」这个反向故障。
 */

export {};

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

/* ============================================================
   断言与收尾
   ============================================================ */

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${detail ? ` —— ${detail}` : ""}`);
  if (!cond) failed += 1;
}

const cleanups: (() => void | Promise<void>)[] = [];
async function cleanup(): Promise<void> {
  for (const fn of cleanups.reverse()) {
    try {
      await fn();
    } catch {
      /* 收尾失败不该盖过真正的失败原因 */
    }
  }
}

/* ============================================================
   前置：必须已经有生产构建产物
   ============================================================ */

if (!existsSync(join(process.cwd(), ".next", "BUILD_ID"))) {
  console.error("没有找到 .next/BUILD_ID —— 先跑 `npm run build`。");
  console.error("（这个检查刻意不替你 build：它要验的就是构建产物，不是源码。）");
  process.exit(1);
}

/**
 * canary：用户原话里塞一个手机号。
 *
 * 选手机号而不是随便一串随机字符，是因为它是**真实客服对话里真的会出现**的东西，
 * 而且形状固定、容易在报文里搜。用一串 `CANARY123` 之类的标记测出来的绿，
 * 说明不了真实场景下会不会漏 —— 真实泄露从来不长得像测试标记。
 *
 * 两轮对话是刻意的，因为**一轮验不出脱敏的反面**：
 *
 *   A 轮（查订单）的必填参数 `timeRange` 是 enum —— 值应当出境。
 *   B 轮（退款）的必填参数 `orderNo` 是自由字符串 —— 值**不**出境，只出键名。
 *
 * 只跑其中一轮都会得到一个假的绿：只跑 A 会以为「什么都出境」（其实就差 orderNo
 * 这一类），只跑 B 会以为「什么都不出境」（其实是把 enum 也一起脱没了）。
 * 脱敏这件事的正确性是一个**逐字段的判定**，所以必须有至少一个该出境的正例
 * 和一个不该出境的负例同时在场，否则断言只是「有东西发出去了」。
 */
const CANARY = "13800138000";
const SESSION_A = "sess_deploy_check_a1";

/** B 轮用的订单号：它是一条**真实存在**的可退款订单，会被当参数传给工具 */
const ORDER_NO = "SO-20260910-6620";
const SESSION_B = "sess_deploy_check_b2";

const userTextA = `帮我看看我最近30天的订单，我的手机号是${CANARY}`;
const userTextB = `我要退款 ${ORDER_NO}，联系我${CANARY}`;

/* ============================================================
   ① 接收端：一个真的 HTTP server
   ============================================================ */

interface Received {
  url: string;
  contentType: string;
  raw: string;
}
const received: Received[] = [];

const receiver = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    received.push({
      url: req.url ?? "",
      contentType: String(req.headers["content-type"] ?? ""),
      raw,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});
await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
cleanups.push(() => new Promise<void>((r) => receiver.close(() => r())));
const receiverPort = (receiver.address() as AddressInfo).port;
const receiverUrl = `http://127.0.0.1:${receiverPort}/v1/traces`;

/* ============================================================
   ② 起生产服务
   ============================================================ */

const appPort = 3400 + Math.floor(Math.random() * 100);

const child = spawn(
  process.execPath,
  [join("node_modules", "next", "dist", "bin", "next"), "start", "-p", String(appPort)],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      // 观测链路全套从环境变量组装 —— 这一条本身就是被测对象：
      // getSink 在生产进程里真的能凭 env 把 sink 装起来吗
      OBSERVABILITY_OTLP_ENDPOINT: receiverUrl,
      OBSERVABILITY_SALT: "deploy-check-salt",
      OBSERVABILITY_SAMPLE_RATE: "1",
      OBSERVABILITY_SERVICE_NAME: "ai-cs-genui",
      // 演示节奏归零，检查不该为了打字机效果空等
      MOCK_STREAM_DELAY_MS: "0",
      MOCK_TOOL_DELAY_MS: "0",
      AUDIT_LOG: "on",
      LLM_PROVIDER: "mock",
      // 独立的库文件：这个检查会反复跑，不该往开发用的 data/app.db 里塞会话。
      // 和 persistence-check 同一个理由 —— 检查脚本不该有副作用留在开发数据上。
      DB_PATH: "data/deploy-check.db",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
cleanups.push(() => {
  if (!child.killed) child.kill();
});
child.stdout.on("data", () => {});
let appStderr = "";
child.stderr.on("data", (c) => (appStderr += c));

const base = `http://127.0.0.1:${appPort}`;

/** 等端口真的能用。next start 起来要一两秒，固定 sleep 是碰运气 */
async function waitReady(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(base, { signal: AbortSignal.timeout(1500) });
      // 只要能回一个 HTTP 状态码，就说明端口在监听、服务在跑
      if (res.status > 0) return true;
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

console.log("\n部署检查（跑的是生产构建产物，不是 dev）\n");

const ready = await waitReady(30_000);
check(
  "生产构建能作为服务启动（`next build` 产物 + `next start`）",
  ready,
  ready ? `端口 ${appPort}` : `30s 内没起来${appStderr ? `，stderr：${appStderr.slice(0, 400)}` : ""}`,
);

if (!ready) {
  await cleanup();
  console.log(`\n失败：${failed} 项\n`);
  process.exit(1);
}

/* ============================================================
   ③ 真的走一轮对话
   ============================================================ */

interface Round {
  stream: string;
  events: string[];
  correlationId: string;
}

/**
 * 走一轮真实对话，读完整条 SSE。
 *
 * `sessionId` 每轮不同是刻意的：同一个会话里第二轮会带上一轮的状态
 * （最近订单号之类的会话记忆），而那会让「这一轮到底调没调工具」变得不好判断。
 * 这个检查要的是「干净的一轮」，不是「有记忆的一轮」。
 */
async function runRound(message: string, sessionId: string): Promise<Round> {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, message }),
  });

  let stream = "";
  // 事件流有超时兜底：一个挂在生产构建里的 SSE 会让这个检查永远等下去，
  // 而「永远等下去」在 CI 上表现为超时失败，看不出是哪一环坏的。
  const reader = res.body?.getReader();
  const decode = new TextDecoder();
  const deadline = Date.now() + 20_000;
  while (reader && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    stream += decode.decode(value, { stream: true });
    if (stream.includes("event: done")) break;
  }

  return {
    stream,
    events: [...stream.matchAll(/^event: (.+)$/gm)].map((m) => m[1]),
    correlationId: /"correlationId":"([^"]+)"/.exec(stream)?.[1] ?? "",
  };
}

const roundA = await runRound(userTextA, SESSION_A);
check("A 轮：一轮对话跑到了 done", roundA.events.includes("done"), roundA.events.join(",") || "（没收到任何事件）");
check(
  "A 轮：组件真的渲染出来了（有 component 事件，不是被降级成纯文本）",
  roundA.events.includes("component"),
  roundA.events.filter((e) => e === "component").length + " 个 component 事件",
);
check(
  "A 轮：能从事件流里取到 correlationId（否则后面按 ID 反查的断言全部无意义）",
  roundA.correlationId !== "",
);

const roundB = await runRound(userTextB, SESSION_B);
check(
  "B 轮：退款意图走到工具调用（没有工具调用的话，下面那条「参数值不出境」就是空验）",
  /"tool":"show_refund_form"/.test(roundB.stream) || roundB.stream.includes("show_refund_form"),
  roundB.events.join(",") || "（没收到任何事件）",
);

/* ============================================================
   ④ 本地那条腿：原文必须留在自己人手里
   ============================================================ */

const auditPath = join(process.cwd(), ".audit", "turns.jsonl");
const auditRaw = existsSync(auditPath) ? readFileSync(auditPath, "utf8") : "";
const auditLines = auditRaw
  .split("\n")
  .filter((l) => roundA.correlationId !== "" && l.includes(roundA.correlationId));

check("本地审计里有 A 轮这一条", auditLines.length > 0, `.audit/turns.jsonl`);
check(
  "本地审计里**留着**用户原话（脱敏只作用于出境那份，不是把本地的也洗了）",
  auditLines.some((l) => l.includes(CANARY)),
  "留原文才谈得上事后追责",
);

/* ============================================================
   ⑤ 出境那条腿：报文里必须干干净净
   ============================================================ */

/**
 * 上报是异步的，给它一点时间。
 *
 * 但不能用固定 sleep 蒙 —— 那样在慢机器上会变成随机失败。所以是轮询等条件成立，
 * 超时才算失败。轮询的判据是「两轮都收到了」，不是「等够了」。
 */
const otlpDeadline = Date.now() + 10_000;
while (received.length < 2 && Date.now() < otlpDeadline) {
  await new Promise((r) => setTimeout(r, 150));
}

check(
  "生产进程凭环境变量把 OTLP 出口装起来了，并且两轮都真的发出来了",
  received.length >= 2,
  received.length > 0 ? `${received.length} 次投递到 ${received[0].url}` : "10s 内一次都没收到",
);
check(
  "报文的 Content-Type 是 application/json（OTLP/HTTP 的协议约定，缺了端点会拒收）",
  received.every((r) => r.contentType.includes("application/json")),
  received.map((r) => r.contentType).join(" | ") || "（无）",
);

const payload = received.map((r) => r.raw).join("\n");

check("出境的报文里搜不到用户手机号（两轮的原话里都有）", !payload.includes(CANARY), CANARY);
check("出境的报文里搜不到 sessionId 原值", !payload.includes(SESSION_A) && !payload.includes(SESSION_B));
check(
  "出境的报文里搜不到用户原话的任何片段",
  !payload.includes("帮我看看我最近") && !payload.includes("联系我"),
  "整句话都不该出现，不只是手机号",
);

// 反向断言：脱敏不等于「什么都上报不了」。全脱光的话，出境的 trace
// 就只是一堆时间戳，跨轮次聚合这件事（「这个用户是不是每次都失败」）压根做不了。
check(
  "脱敏之后仍然**可关联**：报文里有 user.hash / session.hash",
  payload.includes("user.hash") && payload.includes("session.hash"),
);

/**
 * 下面这一对是整份检查里最要紧的两条：**逐字段判定的正例和负例**。
 *
 * 判定规则来自工具自己的 Schema（见 core/observability/redact.ts），
 * 所以正确行为是「同一个工具的不同参数，一个出境一个不出境」——
 * 任何一刀切的实现（全报或全不报）都会在这两条里挂掉一条。
 */
check(
  "该出境的出境了：`timeRange` 声明了 enum → 报文里有它的**值** `last30d`",
  payload.includes("last30d"),
  "这一条挡的是「为了安全把什么都脱光」——那样脱敏是达标了，可观测性也一起没了",
);
check(
  "不该出境的没出境：`orderNo` 是自由字符串 → 报文里有**键名**但没有值",
  payload.includes("orderNo") && !payload.includes(ORDER_NO),
  `键名在、值 ${ORDER_NO} 不在`,
);
check(
  "报文里带上了工具调用的键名（不带值也是对分析有用的信号）",
  payload.includes("tool.0.name"),
);

/* ============================================================
   ⑥ 结构：真的是 OTLP，不是一坨自造 JSON
   ============================================================ */

interface ResourceSpan {
  resource?: { attributes?: unknown[] };
  scopeSpans?: { spans?: unknown[] }[];
}

/** 找第一份**真的带 span** 的报文来验结构：投递可能分批发，不是每份都完整 */
function firstWithSpans(): ResourceSpan[] {
  for (const r of received) {
    try {
      const parsed = JSON.parse(r.raw) as { resourceSpans?: ResourceSpan[] };
      const rs = parsed.resourceSpans ?? [];
      if (rs.some((x) => (x.scopeSpans ?? []).some((s) => (s.spans ?? []).length > 0))) return rs;
    } catch {
      /* 不是 JSON 的那份由下面「能被解析成 OTLP 结构」那条报出来 */
    }
  }
  return [];
}

const resourceSpans = firstWithSpans();
const spans = resourceSpans.flatMap((rs) => rs.scopeSpans?.flatMap((ss) => ss.spans ?? []) ?? []);

check("报文能被解析成 OTLP 的 resourceSpans 结构（标准后端能收）", resourceSpans.length > 0);
check("resource 里声明了 service.name", JSON.stringify(resourceSpans[0]?.resource ?? {}).includes("service.name"));
check("spans 非空（不是只发了个壳）", spans.length > 0, `${spans.length} 个 span`);

const firstSpan = spans[0] as { traceId?: string; spanId?: string; startTimeUnixNano?: string } | undefined;
check("traceId 是 32 位十六进制、spanId 是 16 位（长度错了后端会静默丢）",
  /^[0-9a-f]{32}$/.test(firstSpan?.traceId ?? "") && /^[0-9a-f]{16}$/.test(firstSpan?.spanId ?? ""),
  `traceId=${firstSpan?.traceId ?? "无"} spanId=${firstSpan?.spanId ?? "无"}`);
check("时间戳是纳秒字符串（OTLP/JSON 的约定，写成毫秒数字后端会当成 1970 年）",
  /^\d{19}$/.test(firstSpan?.startTimeUnixNano ?? ""), firstSpan?.startTimeUnixNano ?? "无");

/* ============================================================
   收尾
   ============================================================ */

await cleanup();
console.log(failed === 0 ? "\n全部通过\n" : `\n失败：${failed} 项\n`);
process.exit(failed === 0 ? 0 : 1);
