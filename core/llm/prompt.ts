/**
 * System Prompt
 *
 * 「白名单纪律」三条逐字采用第三阶段文档 2.3 —— 这部分不随上下文变化，
 * 固定在最前面，既是为了稳定性，也是为了将来接 prompt caching 时能整块命中。
 *
 * 纪律之后另起一段放**动态上下文**（当前日期、最近操作的订单号、是否已有退款结果）。
 * 刻意分开写而不是拼进纪律里：纪律是「模型永远该守的」，上下文是「这一轮的事实」，
 * 混在一起会让模型把临时事实也当成规则，反过来也一样。
 *
 * 注意这套 prompt 的定位：它是第一道**软**约束。文档 2.3 的批注说得很直接 ——
 * 「不能只靠它，因为模型有非确定性，Prompt 会被绕过或失灵」。真正的保障在下游三道闸。
 */

export const SYSTEM_PROMPT = `你是客服助手。你只能通过调用以下工具来展示交互组件：
show_order_table / show_refund_form / show_refund_reason_chart / show_result_card。
规则：
1. 【白名单】你【不能】生成、描述或虚构任何未在上述工具列表中的组件；不确定时用纯文本回答。
2. 【数据不编造】你【不得】自行编造订单、金额、退款等业务数据；这些数据由工具内部从业务系统获取。
3. 【关键操作】退款的最终提交由用户在表单中确认并经系统校验执行，你【不能】直接执行退款或声称已完成退款。
开放咨询、政策解释、情感安抚等无需组件的场景，直接用文本回复。`;

export interface PromptContext {
  /** 当前日期（YYYY-MM-DD），用于相对时间表述对齐 */
  today: string;
  /** 最近一次操作的订单号，用于「就退这个订单」这类指代消解 */
  lastOrderNo?: string;
  /** 本轮之前是否已有退款处理结果可展示 */
  hasRefundResult: boolean;
}

/**
 * 拼装本轮 system。
 *
 * 动态段只描述**服务端已知的事实**，不写任何引导模型「应该调哪个工具」的提示 ——
 * 一旦在这里提示了工具名，意图识别的准确率就不再是模型能力的度量，
 * eval 也就失去意义了。
 */
export function buildSystemPrompt(ctx: PromptContext): string {
  const lines: string[] = [`当前日期：${ctx.today}。`];

  if (ctx.lastOrderNo) {
    lines.push(`用户最近一次操作的订单号是 ${ctx.lastOrderNo}，当用户用「这个订单」「刚才那笔」指代时指的是它。`);
  }
  if (ctx.hasRefundResult) {
    lines.push("本会话已有一笔退款提交结果，用户询问进展或结果时可据此回应。");
  }

  return `${SYSTEM_PROMPT}\n\n---\n\n${lines.join("\n")}`;
}
