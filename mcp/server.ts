/**
 * MCP 服务端 —— 把 Agent 工具层暴露成 Model Context Protocol 的工具
 *
 * ## 为什么值得做
 *
 * 这套工具层原本只服务于本仓库自己的对话入口：模型由 `core/llm/` 的适配器调用，
 * 工具由 `core/gateway/dispatch.ts` 分发。整条链路是自洽的，但它**绑在这个应用上**。
 *
 * 换成 MCP 之后，同一个工具层可以被任何 MCP 客户端使用（Claude Desktop、IDE、
 * 别的 Agent 框架），而组件契约、三道闸、三条红线全部原样复用。这正是 §2
 * 「三层解耦」在真实世界里的一次兑现 —— 如果当初「选组件」这件事和 SSE 传输
 * 搅在一起，这里就得重写一遍。
 *
 * ## 为什么手写协议而不是引 @modelcontextprotocol/sdk
 *
 * 和这个仓库用 `node:sqlite` 而不引 ORM 是同一个判断：**这一层没有值得引入
 * 依赖的复杂度**。需要实现的是 JSON-RPC 2.0 的一个子集（initialize /
 * tools/list / tools/call / ping），约 200 行；换来的是一份可读的协议实现，
 * 以及能用「直接喂 JSON-RPC 报文」的方式测它（见 selftest 第十二节）。
 *
 * 反过来说清楚代价：手写的协议实现**没有跟随协议演进的保障**，也不会有
 * SDK 那些边界处理。真要长期维护，应该换 SDK。这一节的取舍写在这里，
 * 是为了让读的人知道这是权衡的结果，不是不知道有 SDK。
 *
 * ## MCP 不解决安全问题，它只是把安全问题挪了个位置
 *
 * 这一点必须先说清楚，否则「上了 MCP」很容易被当成「更安全」。
 *
 * 工具层原本的三条红线（数据权限只认登录态 / 金额服务端权威 / 全链路审计），
 * 靠的是 `ctx.session` 这个服务端会话。MCP 的 stdio 传输是一个本地进程、
 * 一个隐含用户，所以这里的做法是：**进程启动时绑定一个会话，之后所有调用都用它**。
 *
 * 有两条性质是白捡的，值得明确指出它们为什么白捡：
 *
 *   1. **工具 Schema 里从来没有「用户是谁」这个参数**（`additionalProperties: false`
 *      且 properties 里只有 timeRange / orderNo 这类查询意图）。所以 MCP 客户端
 *      **无法**通过传参来切换身份 —— 越权在这个接口形状上就不存在，
 *      不是靠运行时检查挡住的。
 *   2. **写操作不在 MCP 上**。这四个工具没有一个是写业务数据的：退款的提交走的是
 *      `component_action` 回填那条路径，而那条路径有自己的登录态校验。
 *      MCP 这边只暴露查询与表单渲染，是一个刻意的收窄。
 *
 * 而**不能**白捡的是这几样，代码里对应做了处理或明确留白：
 *
 *   - MCP 客户端是不受信任的调用方，参数必须重新过闸1（见 handleToolsCall）；
 *   - 网络传输（HTTP/SSE）下没有「进程即用户」这个前提，身份必须来自认证，
 *     这一版没有实现，因为 stdio 用不上；
 *   - 限流在这里只做了单进程内的保护，多客户端场景要看真实部署形态。
 */

import type { ServerSession } from "../core/data/session";
import { gate1ValidateToolInput, gate2CheckEnvelope, gate2CheckToolInput } from "../core/guardrails/gates";
import { newCorrelationId } from "../core/protocol/envelope";
import { TIMEOUTS, TimeoutError, withTimeout } from "../core/runtime";
import { TOOL_COMPONENT_MAP, TOOL_DEFINITIONS } from "../core/tools/definitions";
import { executeTool } from "../core/tools/execute";
import { TraceBuilder, writeAudit } from "../core/trace";

/* ============================================================
   协议常量
   ============================================================ */

/**
 * 本实现针对的协议版本。
 *
 * 写死一个而不是「支持所有版本」：一个声称支持多个版本的实现，
 * 必须有对不同版本行为差异的处理，否则那句声称是假的。
 * 版本协商的规则见 negotiateVersion。
 */
export const PROTOCOL_VERSION = "2025-06-18";

/** 本实现认识的版本，新的在前 */
export const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION];

/**
 * JSON-RPC 2.0 标准错误码 + MCP 自己加的两个。
 *
 * -32002（服务端未初始化）不在 JSON-RPC 2.0 里，是 MCP 的 SDK 约定的扩展码。
 * 单列出来加注释，是因为看到 -32002 的人第一反应会是「这码哪来的」。
 */
const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  /** MCP 扩展：initialize 还没完成就调用了别的方法 */
  NOT_INITIALIZED: -32002,
} as const;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export interface JsonRpcResult {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

function ok(id: JsonRpcId, result: unknown): JsonRpcResult {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/* ============================================================
   工具清单 → MCP 形状
   ============================================================ */

/**
 * 工具的展示名。
 *
 * MCP 的 `title` 是给**人**看的（客户端在「允许这个工具吗」的确认框里显示它），
 * 而 `description` 是给**模型**看的。两者受众不同，所以不能复用同一段文案 ——
 * description 里那些「不用于什么」的排除说明对人来说是噪声。
 */
const TOOL_TITLES: Record<string, string> = {
  show_order_table: "查看我的订单",
  show_refund_form: "申请退款",
  show_refund_reason_chart: "退款原因统计",
  show_result_card: "退款结果",
};

/**
 * 把内部 ToolDefinition 转成 MCP 的 Tool。
 *
 * 一个容易忽略的细节：同一份 JSON Schema，Anthropic API 管它叫 `input_schema`，
 * MCP 管它叫 `inputSchema`。这里只是换字段名，Schema 本身一个字节都不改 ——
 * 改了就会出现「模型看到的约束」和「闸1 校验的约束」不一致，
 * 而那种不一致的典型表现是：模型老老实实按 MCP 的 Schema 填参数，却被闸1 拒了。
 */
function toMcpTool(def: (typeof TOOL_DEFINITIONS)[number]): Record<string, unknown> {
  // 这四个工具都是只读的 —— 一个都不改业务数据。
  // 但 readOnlyHint 的语义是「不修改它的环境」，而 show_refund_form / show_result_card
  // 会写会话状态（最近订单号、最近退款结果），所以只给纯读的两个打这个标。
  // 宁可少标也不多标：客户端拿这个标决定要不要弹确认框，标错了就是替它做了错的决定。
  const pureRead = def.name === "show_order_table" || def.name === "show_refund_reason_chart";

  return {
    name: def.name,
    title: TOOL_TITLES[def.name],
    description: def.description,
    inputSchema: def.input_schema,
    annotations: {
      ...(pureRead ? { readOnlyHint: true } : {}),
      // 数据全来自本地业务系统这一个封闭来源，不接触开放世界
      openWorldHint: false,
    },
  };
}

/* ============================================================
   服务端
   ============================================================ */

export interface McpServerOptions {
  /**
   * 这次进程服务的会话。
   *
   * stdio 传输下一个进程就是一个用户，所以会话在启动时定死 ——
   * 而不是每次调用从参数里取。后者在 MCP 上等于把身份交给调用方决定。
   */
  session: ServerSession;
  serverName?: string;
  serverVersion?: string;
}

export interface McpServer {
  /** 处理一条报文。通知返回 null（JSON-RPC 规定通知不回复） */
  handle(raw: unknown): Promise<JsonRpcResult | JsonRpcError | null>;
  /** 握手完成了吗 */
  readonly ready: boolean;
}

export function createMcpServer(opts: McpServerOptions): McpServer {
  const { session } = opts;
  const serverName = opts.serverName ?? "ai-cs-genui";
  const serverVersion = opts.serverVersion ?? "0.1.0";

  let ready = false;

  /* ---------- initialize ---------- */

  /**
   * 版本协商。
   *
   * 规则和直觉相反，值得写下来：**客户端要了一个不支持的版本时，
   * 服务端不是报错，而是回一个自己支持的版本**。真正的失败判定权在客户端
   * （它若不支持我们回的版本，应当主动断开）。
   *
   * 按直觉写成「不支持就报错」的实现，会在客户端升级到新版本时直接连不上 ——
   * 而协议本来给了一条「退回旧版本继续用」的路。
   */
  function negotiateVersion(requested: unknown): string {
    if (typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
      return requested;
    }
    return PROTOCOL_VERSION;
  }

  function handleInitialize(id: JsonRpcId, params: unknown): JsonRpcResult | JsonRpcError {
    const p = (params ?? {}) as Record<string, unknown>;
    if (typeof p.protocolVersion !== "string") {
      // 这个字段缺失是真正的协议违规：没有它无法协商版本
      return fail(id, ERR.INVALID_PARAMS, "initialize 缺少 protocolVersion");
    }

    const version = negotiateVersion(p.protocolVersion);
    const clientInfo = (p.clientInfo ?? {}) as Record<string, unknown>;

    writeAudit({
      correlationId: `mcp_${Date.now().toString(36)}`,
      kind: "mcp_initialize",
      sessionId: session.sessionId,
      userId: session.userId,
      requestedVersion: p.protocolVersion,
      negotiatedVersion: version,
      clientName: typeof clientInfo.name === "string" ? clientInfo.name : undefined,
      clientVersion: typeof clientInfo.version === "string" ? clientInfo.version : undefined,
    });

    return ok(id, {
      protocolVersion: version,
      capabilities: {
        // listChanged: false —— 工具清单在进程生命周期内不变，
        // 声明 true 却不发通知，客户端会白等一个永远不会来的事件
        tools: { listChanged: false },
      },
      serverInfo: { name: serverName, version: serverVersion },
      // instructions 会进客户端的系统提示。写在这里的每一句都直接影响模型行为，
      // 所以只说这一层真正需要模型知道的事，不复述工具描述（那会重复一遍）
      instructions:
        "这是一个电商客服的工具集。所有工具都只能看到当前登录用户自己的数据，没有任何参数可以查询他人。" +
        "工具返回的组件信封（structuredContent.envelope）应当交给 GenUI 渲染器渲染；" +
        "配套的 text 块是同一份数据的自然语言摘要，给不支持结构化内容的客户端兜底。",
    });
  }

  /* ---------- tools/list ---------- */

  function handleToolsList(id: JsonRpcId): JsonRpcResult {
    return ok(id, { tools: TOOL_DEFINITIONS.map(toMcpTool) });
  }

  /* ---------- tools/call ---------- */

  /**
   * 工具调用。
   *
   * 每一道校验的位置都是刻意的，顺序不能换：
   *
   *   ① 工具名必须注册        → 协议错误（客户端调了一个不存在的工具）
   *   ② 闸1 Schema 校验       → 协议错误（参数不符合工具契约）
   *   ③ 闸2 入参注入扫描      → 工具执行错误（调用合法，但我们拒绝执行）
   *   ④ 执行（带超时）
   *   ⑤ 闸2 出参校验          → 通过则出信封，不通过降级成文本
   *
   * ② 和 ③ 的区别值得说清楚：**② 是「这个调用写错了」，③ 是「这个调用是恶意的」**。
   * 前者该让模型改参数重试，后者不该重试（重试只是给攻击者更多次机会），
   * 所以两者用不同的错误通道。
   */
  async function handleToolsCall(
    id: JsonRpcId,
    params: unknown,
  ): Promise<JsonRpcResult | JsonRpcError> {
    const p = (params ?? {}) as Record<string, unknown>;
    const name = p.name;
    // MCP 的字段名是 arguments（不是 Anthropic 的 input）—— 同一个东西，两个协议各叫各的
    const args = (p.arguments ?? {}) as Record<string, unknown>;

    if (typeof name !== "string") {
      return fail(id, ERR.INVALID_PARAMS, "tools/call 缺少 name");
    }
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      return fail(id, ERR.INVALID_PARAMS, "arguments 必须是对象");
    }

    const def = TOOL_DEFINITIONS.find((t) => t.name === name);
    if (!def) {
      // 未注册的工具名。规范给的就是协议错误（-32602），照做。
      return fail(id, ERR.INVALID_PARAMS, `Unknown tool: ${name}`);
    }

    const correlationId = newCorrelationId();
    const trace = new TraceBuilder(correlationId);

    // —— ② 闸1
    //
    // 这一步在原本的链路里由生成侧负责（模型适配器发出 tool_use 之后立刻验）。
    // 在 MCP 上它必须**重新做一遍**：调用方从「我们自己的适配器」变成了任意 MCP 客户端，
    // 那是一个不受信任的输入源。不重做的后果是，一个手写的 JSON-RPC 报文
    // 可以带着任意参数直接进业务查询 —— 闸2 只扫注入特征，不管 Schema。
    const gate1 = gate1ValidateToolInput(name, args);
    trace.gate1(1, gate1.passed, gate1.passed ? undefined : gate1.error);
    if (!gate1.passed) {
      writeAudit({
        correlationId,
        kind: "mcp_tool_rejected",
        sessionId: session.sessionId,
        userId: session.userId,
        tool: name,
        stage: "gate1",
        reason: gate1.error,
      });
      return fail(id, ERR.INVALID_PARAMS, gate1.error, { tool: name });
    }

    // —— ③ 闸2 入参
    const inputCheck = gate2CheckToolInput(name, args);
    if (!inputCheck.passed) {
      trace.gate2(false, inputCheck.reason);
      trace.markDegraded(inputCheck.reason);
      writeAudit({
        correlationId,
        kind: "mcp_tool_rejected",
        sessionId: session.sessionId,
        userId: session.userId,
        tool: name,
        stage: "gate2_input",
        reason: inputCheck.reason,
      });
      // 这里用 isError 而不是协议错误：调用本身是合法的，是我们拒绝执行它。
      // 用协议错误会把一次安全事件伪装成一次客户端 bug。
      return ok(
        id,
        toolError("这个请求我没法处理，换个说法我们再试一次？", { kind: "rejected", tool: name }),
      );
    }

    // —— ④ 执行
    const component = TOOL_COMPONENT_MAP[name];
    let outcome: Awaited<ReturnType<typeof executeTool>>;
    try {
      outcome = await trace.run(
        `tool:${name}`,
        () =>
          withTimeout(
            async () =>
              executeTool(name, args, { session, correlationId }),
            TIMEOUTS.tool,
            `tool:${name}`,
          ),
        undefined,
        [`tool:${name}`],
      );
    } catch (err) {
      const isTimeout = err instanceof TimeoutError;
      trace.note(isTimeout ? "取数超时" : "取数失败", err instanceof Error ? err.message : String(err));
      trace.markDegraded(isTimeout ? "取数超时" : "取数失败");
      return ok(
        id,
        toolError("系统响应有点慢，这笔我暂时没查出来。稍后再问我一次？", { kind: "timeout", tool: name }),
      );
    }

    // —— 拒绝执行（越权 / 订单不存在）
    //
    // 走 isError: false。两个理由：
    //   1. 工具**正确执行了**，结论是「不能做」—— 那是业务结论，不是故障。
    //      把它标成 error 会让客户端的告警面板上多出一堆「错误」，
    //      而真正的故障混在里面就看不见了。
    //   2. 更重要的是：这个分支对「订单不存在」和「订单属于别人」的措辞是**一致**的，
    //      正是为了不让用户探测他人订单是否存在。而 isError 这类标志天生是
    //      「客户端会记、会展示」的通道 —— 一旦将来有人在这里按不同原因分流，
    //      就会变成一个探测侧信道。
    if (outcome.kind === "refused") {
      trace.note("工具拒绝执行", outcome.reason);
      writeAudit({
        correlationId,
        kind: "mcp_tool_refused",
        sessionId: session.sessionId,
        userId: session.userId,
        tool: name,
        reason: outcome.reason,
      });
      return ok(id, toolResult(outcome.text, { kind: "refused", tool: name }));
    }

    if (outcome.kind === "text") {
      return ok(id, toolResult(outcome.text, { kind: "text", tool: name }));
    }

    // —— ⑤ 闸2 出参
    //
    // 出站前再查一遍，和网关里那条一样。这里查的对象是「我们即将交出去的信封」——
    // 交给的不是自家前端，而是一个我们不认识的客户端，更没有理由省这一步。
    const checked = gate2CheckEnvelope(outcome.envelope);
    if (!checked.passed) {
      trace.gate2(false, checked.reason);
      trace.markDegraded(checked.reason);
      // 降级成同一轮工具执行产生的摘要 —— 数据是对的，只是没穿上卡片
      return ok(
        id,
        toolResult(outcome.summary, { kind: "text", tool: name, degraded: true, reason: checked.reason }),
      );
    }

    trace.gate2(true);
    return ok(
      id,
      toolResult(outcome.summary, {
        kind: "component",
        tool: name,
        // 组件名也放一份：客户端要按它找渲染器，不该去信封里挖
        component: component ?? null,
        envelope: checked.envelope,
        correlationId,
      }),
    );

    function toolResult(text: string, structured: Record<string, unknown>): Record<string, unknown> {
      return {
        content: [
          { type: "text", text },
          // 规范对返回结构化内容的工具有一条 SHOULD：**同时**把序列化 JSON
          // 放进一个 text 块。理由是向后兼容 —— 老客户端不认识 structuredContent，
          // 只会读 content，不给它一份就什么都拿不到。
          { type: "text", text: JSON.stringify(structured) },
        ],
        structuredContent: structured,
        isError: false,
      };
    }

    function toolError(text: string, structured: Record<string, unknown>): Record<string, unknown> {
      return { content: [{ type: "text", text }], isError: true, structuredContent: structured };
    }
  }

  /* ---------- 分发 ---------- */

  return {
    get ready() {
      return ready;
    },

    async handle(raw: unknown): Promise<JsonRpcResult | JsonRpcError | null> {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return fail(null, ERR.INVALID_REQUEST, "报文必须是 JSON 对象");
      }
      const msg = raw as Record<string, unknown>;
      if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
        // id 读不到时用 null —— JSON-RPC 规定解析不出 id 的报错，id 就是 null
        const id = (typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null) as JsonRpcId;
        return fail(id, ERR.INVALID_REQUEST, "不是合法的 JSON-RPC 2.0 请求");
      }

      const method = msg.method;
      const id = (msg.id ?? null) as JsonRpcId;
      // id 缺失 = 通知。通知不回复，出错也不回复（JSON-RPC 2.0）
      const isNotification = msg.id === undefined;

      if (method === "initialize") {
        const res = handleInitialize(id, msg.params);
        return isNotification ? null : res;
      }

      if (method === "notifications/initialized") {
        ready = true;
        return null;
      }

      if (method === "ping") {
        return isNotification ? null : ok(id, {});
      }

      // 握手之前只认这三个。规范要求 initialize 必须是第一次交互 ——
      // 放过去的话，一个没协商版本的客户端会拿到按本实现默认行为产生的结果，
      // 而它以为自己按自己声明的版本在通信。
      if (!ready) {
        return isNotification
          ? null
          : fail(id, ERR.NOT_INITIALIZED, "服务端尚未完成初始化，请先调用 initialize");
      }

      if (method === "tools/list") {
        return isNotification ? null : handleToolsList(id);
      }

      if (method === "tools/call") {
        const res = await handleToolsCall(id, msg.params);
        return isNotification ? null : res;
      }

      return isNotification
        ? null
        : fail(id, ERR.METHOD_NOT_FOUND, `本服务端不实现 ${method}`);
    },
  };
}

/* ============================================================
   stdio 传输
   ============================================================ */

/**
 * 逐行处理一条输入流。
 *
 * MCP 的 stdio 传输是**换行分隔的 JSON**，不是 LSP 那套 `Content-Length` 头 ——
 * 两者都是「JSON-RPC over stdio」，很容易记混。用错的表现是握手就挂，
 * 而且挂得很难看（对方把整个头当成 JSON 解析）。
 *
 * 输入收成 `AsyncIterable<string>` 而不是回调/同步 read()，是为了让它能被测：
 * selftest 里直接传一个字符串数组，不需要真的起进程、也不需要往 stdin 里塞东西。
 * 一个只能靠起进程来测的协议实现，最后的结果通常是没测。
 */
export async function runStdio(
  server: McpServer,
  io: { lines: AsyncIterable<string>; write(line: string): void; onError?(e: unknown): void },
): Promise<void> {
  // 串行处理：MCP 允许并发请求，但这一版的工具都是本地只读 + 有并发闸，
  // 串行能保证「审计里的顺序 = 实际发生的顺序」，排查时不至于看到交错的记录。
  // 真要有并行需求，这里换成按 id 归集的并发队列即可。
  for await (const line of io.lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      // 解析失败要回 -32700 并**继续**读下一行 ——
      // 因为一行坏报文就把整个连接断掉，会让一个手抖的客户端再也连不上
      io.write(
        JSON.stringify(
          fail(null, ERR.PARSE, `报文不是合法 JSON：${err instanceof Error ? err.message : String(err)}`),
        ),
      );
      continue;
    }

    try {
      const res = await server.handle(parsed);
      if (res !== null) io.write(JSON.stringify(res));
    } catch (err) {
      // 处理器自己抛了 —— 这是本实现的 bug，不是调用方的错。
      // 回一个 -32603 让客户端能继续，同时把栈留给本地排查。
      io.onError?.(err);
      const id = ((parsed as { id?: JsonRpcId }).id ?? null) as JsonRpcId;
      io.write(
        JSON.stringify(fail(id, -32603, `服务端内部错误：${err instanceof Error ? err.message : String(err)}`)),
      );
    }
  }
}
