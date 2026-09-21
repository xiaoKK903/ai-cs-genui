/**
 * 注入检测 —— 闸1 / 闸2 共用
 *
 * 一个必须先想清楚的问题：**这套架构里，注入到底从哪儿进来？**
 *
 * 答案不是「模型自由生成的 HTML」—— 组件由服务端注册表渲染，模型碰不到 DOM，
 * 这条攻击面在架构上就不存在。真正的入口只有两个：
 *
 *   ① 模型产出的工具入参（字符串部分）；
 *   ② 用户填进表单、又被回填进 props 的文本。
 *
 * 这两处的共同点是「外部字符串最终会流进业务系统」。所以检测的重点不是 XSS 本身，
 * 而是**任何试图越出「一个订单号 / 一段备注」这个语义边界的字符串**。
 *
 * 需要说明的是：这是软防线。真正的兜底在业务系统 —— 订单号在数据层做格式约束、
 * 查询走参数化、字段长度在 Schema 层封顶。注入检测的价值是「提早发现有人在试」，
 * 而不是「拦住了就安全了」。
 */

export interface InjectionHit {
  /** 命中位置，如 $.props.fields[4].value */
  path: string;
  /** 命中类型 */
  kind: "html" | "instruction" | "sql" | "invisible";
  /** 命中片段（截断，不把完整载荷写进日志） */
  sample: string;
}

interface Rule {
  kind: InjectionHit["kind"];
  label: string;
  pattern: RegExp;
}

const RULES: Rule[] = [
  // —— 标记注入：试图往渲染层塞可执行内容
  { kind: "html", label: "script 标签", pattern: /<\s*script/i },
  { kind: "html", label: "内联框架", pattern: /<\s*iframe/i },
  { kind: "html", label: "外部资源标签", pattern: /<\s*(img|svg|object|embed|link|style|meta)\b/i },
  { kind: "html", label: "内联事件处理器", pattern: /\bon[a-z]+\s*=/i },
  { kind: "html", label: "javascript 协议", pattern: /javascript\s*:/i },
  { kind: "html", label: "data:text/html", pattern: /data\s*:\s*text\/html/i },

  // —— 指令注入：试图改写模型的行为约束
  { kind: "instruction", label: "忽略前序指令（英文）", pattern: /(ignore|disregard)\s+(all\s+)?(previous|above|prior)\s+(instruction|prompt|rule)/i },
  { kind: "instruction", label: "索取系统提示", pattern: /(system\s*prompt|reveal\s+your\s+(instruction|prompt))/i },
  { kind: "instruction", label: "忽略前序指令（中文）", pattern: /(忽略|忘记|无视)(之前|上面|以上|先前|前面)的?(所有)?(指令|要求|规则|设定)/ },
  { kind: "instruction", label: "角色改写", pattern: /(你现在是|从现在开始你扮演|忘记你是一个)/ },
  { kind: "instruction", label: "对话模板标记", pattern: /(<\|[^|]{0,24}\|>|\[INST\]|\[\/INST\]|###\s*(system|instruction|assistant))/i },

  // —— SQL 注入：orderNo 这类字符串最终会进查询
  { kind: "sql", label: "UNION 注入", pattern: /\bunion\s+(all\s+)?select\b/i },
  { kind: "sql", label: "破坏性语句", pattern: /\b(drop|truncate|alter)\s+(table|database)\b/i },
  { kind: "sql", label: "恒真条件", pattern: /(\bor\s+1\s*=\s*1\b|'\s*or\s*'[^']*'\s*=\s*')/i },
  { kind: "sql", label: "注释截断", pattern: /(--\s*$|;\s*--|\/\*)/ },

  // —— 不可见字符：常用于绕过基于关键字的检测
  { kind: "invisible", label: "零宽/双向控制字符", pattern: /[​-‏‪-‮⁠﻿]/ },
];

/** 单条字符串扫描。命中即返回（同一路径不重复报）。 */
export function scanString(value: string, path: string): InjectionHit[] {
  const hits: InjectionHit[] = [];
  for (const rule of RULES) {
    const m = rule.pattern.exec(value);
    if (m) {
      hits.push({
        path,
        kind: rule.kind,
        sample: `${rule.label}：${truncate(m[0])}`,
      });
    }
  }
  return hits;
}

/**
 * 递归扫描任意结构里的**所有字符串值**（键名也扫 —— 往 key 里塞载荷同样能穿层）。
 *
 * 深度上限 8：正常 props 不超过 4 层，超出说明结构异常，直接不再深入。
 */
export function detectInjection(value: unknown, path = "$", depth = 0): InjectionHit[] {
  if (depth > 8) return [];
  if (typeof value === "string") return scanString(value, path);

  if (Array.isArray(value)) {
    return value.flatMap((item, i) => detectInjection(item, `${path}[${i}]`, depth + 1));
  }

  if (value && typeof value === "object") {
    const hits: InjectionHit[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof k === "string") hits.push(...scanString(k, `${path}.<key>`));
      hits.push(...detectInjection(v, `${path}.${k}`, depth + 1));
    }
    return hits;
  }

  return [];
}

function truncate(s: string, max = 40): string {
  const clean = s.replace(/\s+/g, " ");
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export function summarizeHits(hits: InjectionHit[], limit = 2): string {
  const head = hits.slice(0, limit).map((h) => `${h.path} ${h.sample}`);
  const more = hits.length > limit ? ` 等 ${hits.length} 处` : "";
  return head.join("；") + more;
}
