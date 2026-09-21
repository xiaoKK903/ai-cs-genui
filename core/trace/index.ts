/**
 * 双层 trace
 *
 * 一次 GenUI 交互要能回答两类完全不同的问题，用一份记录答不了：
 *
 *   **执行 trace** —— 慢在哪？
 *     「意图识别 12ms / 工具执行 3ms / 闸2 校验 1ms / 首帧 340ms」
 *     它面向可用性，判据是耗时和状态。correlationId 把一次对话轮次的
 *     服务端、SSE、前端三段串起来 —— 用户报「点了没反应」时，
 *     得能顺着这个 ID 查到是没下发、下发被拦、还是前端没渲染。
 *
 *   **论证 trace** —— 凭什么？
 *     「为什么给用户看的是退款表单而不是订单表格」——即 TraceStep.evidenceRefs。
 *     它面向正确性与合规：金额卡片里的数字出自哪个接口、哪条记录，
 *     退款拦截的理由是哪一条规则。出事时这是唯一能自证的东西。
 *
 * 两者同写在一份 trace 里但不混用：执行 trace 每步都有，论证 trace 只在
 * 「做了判断」的步骤上有内容。硬凑成一份的后果是，排查性能问题时要在
 * 一堆业务依据里找耗时，反之亦然。
 *
 * 审计落盘是 append-only 的 JSONL。不写「当前状态」而写「事件流」，
 * 是因为状态可以被后一次写覆盖，而事后追责要的恰恰是覆盖之前发生过什么。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TraceStep, TurnTrace } from "../protocol/types";

const AUDIT_DIR = join(process.cwd(), ".audit");
const AUDIT_FILE = join(AUDIT_DIR, "turns.jsonl");

function auditEnabled(): boolean {
  const v = (process.env.AUDIT_LOG ?? "on").trim().toLowerCase();
  return v !== "off" && v !== "false" && v !== "0";
}

/**
 * 审计落盘。
 *
 * 刻意做成「失败不影响主流程」：磁盘满、只读文件系统、Serverless 无持久卷 ——
 * 这些都不该让一次正常的客服对话挂掉。代价是审计可能丢，所以生产环境应该
 * 把这里换成真正的日志管道，而不是依赖本地文件。
 */
export function writeAudit(record: Record<string, unknown>): void {
  if (!auditEnabled()) return;
  try {
    mkdirSync(AUDIT_DIR, { recursive: true });
    appendFileSync(AUDIT_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, "utf8");
  } catch {
    // 审计降级：不阻断对话
  }
}

/**
 * 按 correlationId 把一轮的记录捞回来。
 *
 * 同时匹配 parentCorrelationId：用户点了按钮产生的是**新一轮**（有自己的 ID），
 * 但它逻辑上属于原来那次对话。只按自己的 ID 查，会漏掉「按钮之后发生了什么」——
 * 而那一段往往是出问题的部分。
 */
export function readAudit(correlationId: string, limit = 20): Record<string, unknown>[] {
  try {
    if (!existsSync(AUDIT_FILE)) return [];
    const lines = readFileSync(AUDIT_FILE, "utf8").split("\n");
    const out: Record<string, unknown>[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record.correlationId === correlationId || record.parentCorrelationId === correlationId) {
          out.push(record);
        }
      } catch {
        // 半行（进程被杀时正在写）—— 跳过，不让它拖垮整个查询
      }
    }
    return out.slice(-limit);
  } catch {
    return [];
  }
}

export class TraceBuilder {
  readonly correlationId: string;
  private readonly startedAt = Date.now();
  private readonly steps: TraceStep[] = [];
  private degraded = false;
  private readonly gates: TurnTrace["gates"] = {
    gate1: { attempts: 0, passed: false },
    gate2: { passed: false },
    gate3: { passed: false },
  };

  constructor(correlationId: string) {
    this.correlationId = correlationId;
  }

  /**
   * 包一段执行并计时。
   *
   * fn 抛错时不吞异常 —— 记一笔 failed，再原样抛出去让上层决定怎么降级。
   * 在这里「处理」异常会让调用方以为成功了。
   */
  async run<T>(
    name: string,
    fn: () => Promise<T> | T,
    detail?: string,
    evidenceRefs?: string[],
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await fn();
      this.steps.push({ name, status: "ok", startedAt, ms: Date.now() - startedAt, detail, evidenceRefs });
      return result;
    } catch (err) {
      this.steps.push({
        name,
        status: "failed",
        startedAt,
        ms: Date.now() - startedAt,
        detail: err instanceof Error ? err.message : String(err),
        evidenceRefs,
      });
      throw err;
    }
  }

  /** 记一步已经发生的事（无耗时意义，比如「命中某条规则」） */
  note(name: string, detail: string, evidenceRefs?: string[]): void {
    this.steps.push({ name, status: "ok", startedAt: Date.now(), ms: 0, detail, evidenceRefs });
  }

  /** 标记本轮发生了降级。降级不是失败 —— 用户仍然拿到了正确内容，只是没穿卡片。 */
  markDegraded(reason: string): void {
    this.degraded = true;
    this.steps.push({ name: "degrade", status: "degraded", startedAt: Date.now(), ms: 0, detail: reason });
  }

  gate1(attempts: number, passed: boolean, error?: string): void {
    this.gates.gate1 = { attempts, passed, error };
  }

  gate2(passed: boolean, rejected?: string): void {
    this.gates.gate2 = { passed, rejected };
  }

  gate3(passed: boolean, rejected?: string): void {
    this.gates.gate3 = { passed, rejected };
  }

  finish(): TurnTrace {
    return {
      correlationId: this.correlationId,
      startedAt: this.startedAt,
      totalMs: Date.now() - this.startedAt,
      degraded: this.degraded,
      steps: this.steps,
      gates: this.gates,
    };
  }
}
