/**
 * 上报前的脱敏
 *
 * ## 为什么这一步单独成一个文件
 *
 * 把 trace 导出到外部观测后端，等于**让用户数据穿过一次系统边界**。
 * 客服场景里这条边界穿得非常危险：工具入参里有订单号，用户原话里有手机号、
 * 身份证号、地址 —— 而观测后端通常是第三方的 SaaS。
 *
 * 所以规则必须先立起来，再谈导出。
 *
 * ## 白名单，不是黑名单
 *
 * 这是本节最重要的一条。黑名单（「这些字段要脱敏」）要求你**穷举所有敏感字段**，
 * 漏掉一个就是一次静默泄露 —— 而且加字段的人不会想起回来改这张表。
 * 白名单漏了只会少一个字段：损失是可见的（排查时发现少东西），不是静默的。
 *
 * ## 白名单从哪来：工具的 Schema，不是另一张手写表
 *
 * 这是第二个关键点。手写一张「哪些参数可以上报」的表，就等于把工具的
 * 参数契约抄了第二份 —— 而两份契约一定会漂移（这个仓库里已经有过一次
 * 同类教训，见 mcp/server.ts 关于 inputSchema 的注释）。
 *
 * 所以判定规则**直接从闸1 校验用的那份 JSON Schema 推出来**：
 *
 *   - 声明了 `enum`   → 取值来自有限集合，上报原值
 *   - `boolean`       → 上报
 *   - 数值且同时给了 `minimum` / `maximum` → 取值有界，上报
 *   - 其余（自由字符串、无界数值、对象、数组）→ **只上报键名，不报值**
 *
 * 落到这份代码上：`timeRange`（enum）上报 `last30d`，
 * 而 `orderNo`（`string` + minLength/maxLength，没有 enum）只上报
 * 「调用时带了 orderNo 这个参数」—— 值一个字节都不出网。
 *
 * 顺带一个好处：这个规则是**算出来的**，不是维护出来的。将来谁加一个新工具、
 * 新参数，脱敏行为自动跟着它的 Schema 走，不需要任何人记得回来改这里。
 */

import { createHash } from "node:crypto";
import { TOOL_DEFINITIONS } from "../tools/definitions";
import type { JsonSchema } from "../protocol/schema";

/**
 * 单向标识符。
 *
 * 用一个固定的盐 + sha256 取前 12 位。两个用途都要满足：
 *
 *   - **可关联**：同一个人在同一段时间里的所有轮次要能聚到一起，
 *     否则「这个用户是不是每次都失败」这类问题答不了；
 *   - **不可还原**：不能从哈希反推出用户 ID。所以是哈希，不是加密
 *     （加密意味着有人持有钥匙、也就意味着可能被解开）。
 *
 * 盐从环境变量读，缺省是个常量。真实部署**必须**设 `OBSERVABILITY_SALT` ——
 * 用固定盐的哈希在拿到用户 ID 全集之后是可以暴力枚举的（用户 ID 空间很小）。
 * 这一条写在 README §7 的已知边界里，不在这里假装它解决了。
 */
function salt(): string {
  return process.env.OBSERVABILITY_SALT?.trim() || "ai-cs-genui-dev-salt";
}

export function hashId(value: string): string {
  return `h_${createHash("sha256").update(`${salt()}:${value}`, "utf8").digest("hex").slice(0, 12)}`;
}

/**
 * 这个属性能不能上报原值。
 *
 * 注意判定的是**属性声明**，不是**实际值** —— 这一点是刻意的：
 * 如果按实际值判断（「看起来像订单号就脱敏」），规则就变成了猜，
 * 而且攻击者可以用一个「看起来不像」的值绕过去。按声明判断，
 * 安全性质由 Schema 保证，与实际传入什么无关。
 */
function exportableValue(schema: JsonSchema | undefined): boolean {
  if (!schema) return false;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return true;
  if (schema.type === "boolean") return true;
  // 数值：只有同时给了上下界才算「有界」。只给 minimum 的 `limit: 99999999`
  // 仍然可能是一个金额，所以要求两端都有。
  if ((schema.type === "integer" || schema.type === "number") && typeof schema.minimum === "number" && typeof schema.maximum === "number") {
    return true;
  }
  return false;
}

export interface RedactedArgs {
  /** 允许上报原值的参数 */
  values: Record<string, unknown>;
  /** 只上报「带了哪些参数」，值为脱敏占位符 */
  omitted: string[];
}

/**
 * 把一次工具调用的入参脱敏成可上报的形状。
 *
 * 未知工具（不在 TOOL_DEFINITIONS 里）走**最严**分支：全部只报键名、不报值。
 * 反过来的默认（未知就放行）会在加新工具时静默泄露 —— 而「新工具上线那天」
 * 恰恰是没人会想起脱敏这件事的一天。
 */
export function redactToolArgs(toolName: string, args: unknown): RedactedArgs {
  const def = TOOL_DEFINITIONS.find((t) => t.name === toolName);
  const isObject = args !== null && typeof args === "object" && !Array.isArray(args);
  const entries = isObject ? Object.entries(args as Record<string, unknown>) : [];

  // 未知工具：值一律不报，但**键名照报**。
  //
  // 不返回空对象是刻意的：一个没注册过的工具名被调用，本身是安全上要看见的事件
  // （可能是有人在试探，也可能是部署时工具清单没同步）。返回空的话，
  // 这条线索就静默消失了 —— 而且是消失得最不容易被察觉的那种（没报错、没计数）。
  if (!def) {
    return { values: {}, omitted: entries.map(([k]) => k) };
  }

  const props = (def.input_schema.properties ?? {}) as Record<string, JsonSchema>;
  const values: Record<string, unknown> = {};
  const omitted: string[] = [];

  for (const [key, value] of entries) {
    if (exportableValue(props[key])) {
      values[key] = value;
    } else {
      omitted.push(key);
    }
  }

  return { values, omitted };
}

/**
 * 用户原话**永远不上报**。
 *
 * 这不是「暂时先不报，以后再说」—— 是这条链路的设计前提。
 *
 * 理由很具体：客服对话里的用户原话，是整套系统里**唯一一个内容完全不可控**
 * 的字段。订单号还能靠 Schema 约束，原话不能 —— 用户会主动打出手机号、
 * 身份证号、银行卡号、家庭住址，而且往往是客服让他打的。
 *
 * 派生指标要的是「这一轮的规模和结果」，不是「用户说了什么」：
 * 字符数够回答「是不是长尾输入」，脱敏枚举够回答「哪一类请求在降级」。
 * 真要看原话，走本地 `.audit/turns.jsonl`（它本来就有，且不出网）。
 */
export function redactMessage(text: string): { length: number; lengthBucket: string } {
  const length = text.length;
  // 分桶而不是报精确值：精确长度在短文本上接近内容本身
  // （「我要退款」和「我要退货」长度一样，但 6 个字的消息集合本来就不大）
  const bucket = length <= 8 ? "0-8" : length <= 32 ? "9-32" : length <= 128 ? "33-128" : "129+";
  return { length, lengthBucket: bucket };
}
