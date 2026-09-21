/**
 * 轻量 JSON Schema 校验器（零依赖）
 *
 * 为什么手写而不是引 ajv：这个项目的核心论点是「协议层能被信任，是因为每一层
 * 都不信任上一层，而不是因为模型每次都听话」。校验器是这套论点的执行者，它必须
 * 足够小、足够可读，让人能一眼确认它没漏判。生产环境可以直接换成 ajv ——
 * 组件契约（core/protocol/schema.ts）用的是标准 JSON Schema 子集，替换成本为零。
 *
 * 支持的关键字：type / properties / required / items / enum / additionalProperties /
 * anyOf / minItems / maxItems / minLength / maxLength / minimum / maximum
 */

import type { JsonSchema } from "./schema";

export interface ValidationIssue {
  /** JSON 路径，如 $.fields[1].editable */
  path: string;
  message: string;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function checkType(expected: JsonSchema["type"], value: unknown): boolean {
  const actual = typeOf(value);
  switch (expected) {
    case "integer":
      return actual === "number" && Number.isInteger(value as number);
    case "number":
      return actual === "number" && Number.isFinite(value as number);
    default:
      return actual === expected;
  }
}

/**
 * 校验 value 是否满足 schema。返回全部未通过项（不是遇到第一个就返回），
 * 便于降级时把原因一次性写进 trace。
 */
export function validate(schema: JsonSchema, value: unknown, path = "$"): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // anyOf：任一分支通过即视为通过，否则汇总各分支的首要问题
  if (schema.anyOf && schema.anyOf.length > 0) {
    const branches = schema.anyOf.map((s) => validate(s, value, path));
    if (!branches.some((b) => b.length === 0)) {
      const expected = schema.anyOf
        .map((s) => s.type ?? "?")
        .join(" | ");
      issues.push({
        path,
        message: `不满足任一允许的类型（期望 ${expected}，实际 ${typeOf(value)}）`,
      });
      return issues;
    }
    return issues;
  }

  if (schema.type && !checkType(schema.type, value)) {
    issues.push({ path, message: `类型错误：期望 ${schema.type}，实际 ${typeOf(value)}` });
    return issues;
  }

  if (schema.enum && !schema.enum.includes(value as string | number)) {
    issues.push({
      path,
      message: `取值不在枚举内：${JSON.stringify(value)}（允许：${schema.enum.join(" / ")}）`,
    });
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push({ path, message: `长度小于下限 ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push({ path, message: `长度超过上限 ${schema.maxLength}` });
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ path, message: `小于下限 ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({ path, message: `超过上限 ${schema.maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push({ path, message: `元素个数少于 ${schema.minItems}` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push({ path, message: `元素个数超过 ${schema.maxItems}` });
    }
    if (schema.items) {
      value.forEach((item, i) => {
        issues.push(...validate(schema.items as JsonSchema, item, `${path}[${i}]`));
      });
    }
  }

  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;

    for (const key of schema.required ?? []) {
      if (!(key in obj) || obj[key] === undefined) {
        issues.push({ path: `${path}.${key}`, message: "缺少必填字段" });
      }
    }

    if (schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in obj && obj[key] !== undefined) {
          issues.push(...validate(sub, obj[key], `${path}.${key}`));
        }
      }
    }

    // additionalProperties: false —— 挡住一切计划外字段。
    // 这是「模型不能往 props 里塞私货」的关键一条。
    if (schema.additionalProperties === false) {
      const allowed = new Set([
        ...Object.keys(schema.properties ?? {}),
        ...(schema.required ?? []),
      ]);
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) {
          issues.push({ path: `${path}.${key}`, message: "出现 Schema 未声明的字段" });
        }
      }
    }
  }

  return issues;
}

export function isValid(schema: JsonSchema, value: unknown): boolean {
  return validate(schema, value).length === 0;
}

/** 把校验问题压成一行，便于写进 trace / 降级提示 */
export function summarizeIssues(issues: ValidationIssue[], limit = 3): string {
  const head = issues.slice(0, limit).map((i) => `${i.path} ${i.message}`);
  const more = issues.length > limit ? ` 等 ${issues.length} 项` : "";
  return head.join("；") + more;
}
