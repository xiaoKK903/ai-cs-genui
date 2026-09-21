/**
 * MCP 服务端 —— stdio 入口
 *
 * 跑法：
 *   npm run mcp
 *
 * **但别拿 `npm run mcp` 当客户端的启动命令。** npm 会在 stdout 打一段
 * `> ai-cs-genui@0.1.0 mcp` 的横幅，客户端会把那行当成一条 JSON-RPC 报文去解析，
 * 然后握手在第一个字节就崩掉（实测踩过）。配置里要直接写命令本身：
 *
 * 接到 MCP 客户端上（以 Claude Desktop 为例，`claude_desktop_config.json`）：
 *
 *   {
 *     "mcpServers": {
 *       "ai-cs-genui": {
 *         "command": "npx",
 *         "args": ["tsx", "<到这个仓库的绝对路径>/mcp/main.ts"]
 *       }
 *     }
 *   }
 *
 * ## 这个进程代表谁
 *
 * stdio 是本地传输：一个进程，一个用户。所以身份在**启动时**确定，
 * 从环境变量读，缺省是演示用户。这不是偷懒 —— 在 stdio 上「每次调用从参数里取身份」
 * 等于把身份交给调用方决定，那是把鉴权做成了摆设。
 *
 * 换成 HTTP/SSE 传输之后，这里必须是真正的认证（token → userId），
 * 而且要在握手阶段就定下来。详见文件末尾。
 *
 * ## 关于 stdout 的一条硬规矩
 *
 * **stdout 只用来发协议报文。** 任何调试输出、日志、启动横幅都必须走 stderr ——
 * 往 stdout 多写一行，客户端就会把那行当成一条 JSON-RPC 报文去解析，
 * 然后整个连接在一句「我的服务启动了」上崩掉。这个坑很经典，所以启动时
 * 一个字都不往 stdout 打。
 */

import { DEMO_SESSION_USER_ID } from "../core/data/order-service";
import { ensureSeeded } from "../core/data/seed";
import { getOrCreateSession } from "../core/data/session";
import { createMcpServer, runStdio } from "./server";

/* ---------- 身份 ---------- */

const userId = process.env.MCP_SESSION_USER_ID?.trim() || DEMO_SESSION_USER_ID;
const sessionId = process.env.MCP_SESSION_ID?.trim() || "mcp_stdio";

// 首次启动写种子数据。MCP 进程可能先于 Web 应用启动，
// 不在这里 ensure 的话，第一个查询会得到「你暂时没有订单」——
// 那不是错误，只是空，所以最难发现。
ensureSeeded();

const session = getOrCreateSession(sessionId, userId);

if (session.userId !== userId) {
  // 会话 id 撞上了别的用户：宁可换一个会话，也不复用。
  // 复用等于让这个 MCP 客户端拿到另一个人的会话状态（最近订单号、最近退款结果）。
  process.stderr.write(
    `[mcp] 会话 ${sessionId} 属于 ${session.userId}，与请求的 ${userId} 不一致 —— 已中止\n`,
  );
  process.exit(1);
}

/* ---------- 跑起来 ---------- */

async function* stdinLines(): AsyncIterable<string> {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk as string;
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      yield buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf("\n");
    }
  }
  // 最后一行可能没有换行符收尾。丢掉它等于丢掉最后一条报文 ——
  // 而客户端在管道里写一条就关掉的场景（脚本化调用）恰恰是这样。
  if (buffer.trim() !== "") yield buffer;
}

process.stderr.write(
  `[mcp] ai-cs-genui MCP 服务端就绪 · 会话 ${sessionId} · 用户 ${userId} · 传输 stdio\n`,
);

await runStdio(createMcpServer({ session }), {
  lines: stdinLines(),
  write(line) {
    process.stdout.write(`${line}\n`);
  },
  onError(err) {
    process.stderr.write(`[mcp] 处理器异常：${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  },
});

process.stderr.write("[mcp] 输入结束，退出\n");

/* ============================================================
   换成网络传输要补什么（这一版没做，写下来免得被当成已经做了）
   ============================================================

   1. 认证。stdio 用「进程即用户」绕过了这个问题，HTTP 绕不过去。
      每个连接必须带 token，且在 initialize 阶段就把 userId 定下来、
      之后所有请求复用它 —— 不能每次调用从 params 里取身份，
      那正是这个接口形状极力避免的东西。

   2. 会话隔离。多客户端意味着多会话，`getOrCreateSession` 的
      会话 id 必须来自认证后的身份，不能来自客户端传的字符串。

   3. 限流。现在只有进程内的 ConcurrencyGate，多实例下要挪到外部存储。

   4. 审计。本地 JSONL 在无持久卷的环境里会丢，要换成日志管道。
      （这一条和 README §11 里列的是同一个边界，不是新问题。）

   5. Origin 校验。MCP 规范专门提过：HTTP 传输上不校验 Origin，
      等于允许任意网页对着本地端口发起请求。
   ============================================================ */
