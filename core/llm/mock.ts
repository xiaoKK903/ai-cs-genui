/**
 * 确定性 mock 适配器（默认）
 *
 * 它模拟的是「模型这一层的行为」：读用户话 → 决定调哪个工具、传什么参数 → 顺带说一句话。
 * 用规则实现，不用随机数 —— 因为这份 adapter 要同时承担三个职责：
 *
 *   1. 演示：clone 下来 `npm run dev` 就能看到完整链路，不需要 API Key；
 *   2. 评测基线：eval 的对照组是「意图识别正确率」，规则版的准确率是已知的，
 *      换成真模型后两条曲线的差值才有意义；
 *   3. 回归：改协议层时跑 selftest，不受模型非确定性干扰 —— 否则每次失败都要先分辨
 *      是代码坏了还是模型今天心情不好。
 *
 * 一条刻意的设计：**它不净化输入**。用户粘进来的怪字符串会被原样放进工具参数，
 * 交给下游的闸2 去拦。如果在这里就把危险字符洗掉，那三道闸的演示价值就归零了 ——
 * 等于测试帮被测代码把错误提前修好了。
 */

import type { LLMAdapter, LLMDecision, LLMHandlers, LLMRequest, LLMToolCall } from "./adapter";

/** 打字机节奏。selftest / eval 里设成 0，免得为了几个字符的空等浪费时间。 */
const STREAM_DELAY_MS = Number(process.env.MOCK_STREAM_DELAY_MS ?? 18);

const CHUNK_SIZE = 3;

let callSeq = 0;
function nextCallId(): string {
  callSeq += 1;
  return `call_mock_${String(callSeq).padStart(4, "0")}`;
}

/* ============================================================
   意图识别
   ============================================================ */

type TimeRange = "last7d" | "last30d" | "last90d" | "all";

interface IntentContext {
  lastOrderNo?: string;
  hasRefundResult: boolean;
}

type Intent =
  | { kind: "tool"; name: string; input: Record<string, unknown>; lead?: string }
  | { kind: "text"; reply: string };

/** 订单号提取。整段粘贴（以 SO- 开头）时整段取走 —— 这正是注入进来的常见形态。 */
function extractOrderNo(text: string): string | undefined {
  const trimmed = text.trim();
  if (/^SO-/i.test(trimmed)) return trimmed;
  const m = /SO-[^\s，。！？、]+/i.exec(text);
  return m ? m[0] : undefined;
}

function extractTimeRange(text: string): TimeRange {
  if (/(近?7天|最近一周|这周|本周|七天)/.test(text)) return "last7d";
  if (/(近?90天|最近三个月|三个月|一个季度|90天)/.test(text)) return "last90d";
  if (/(全部|所有|历史|一直以来|总的)/.test(text)) return "all";
  // 未指明时给 30 天：客服场景下这是最常被预期的默认窗口
  return "last30d";
}

function extractMeasure(text: string): "count" | "amount" {
  return /(金额|多少钱|花了多少|占比|总额|退了多少钱)/.test(text) ? "amount" : "count";
}

/** 指代消解：「就退这个订单」里的「这个」只能是会话里最近操作过的那一单 */
const REFERENTIAL = /(这个|那个|该|这笔|这单|那单|刚才|刚刚|上面|它)/;
/**
 * 退款意图。
 *
 * 「要退 / 想退」这两个裸动词是评测集逼出来的：现实里用户很少说完整的「我要退款」，
 * 更常说「这单我要退」「我想退」。规则版最初只收完整词，于是这两句被归成闲聊 ——
 * 而它们恰恰是最典型的退款开场白。少收一个动词，线上就是一次没听懂。
 */
const REFUND_VERB = /(退款|退货|退钱|退掉|退了|退下|申请退|取消订单|要退|想退)/;
const CHART_SIGNAL = /(原因|统计|分布|构成|都是什么|占比|集中在|分析|趋势|为啥|因为啥)/;
/**
 * 政策咨询信号。
 *
 * 「退款多久到账」和「我要退款」都含「退款」两个字，但一个是问规则、一个是下指令。
 * 不区分的话，用户问一句运费谁承担，客服会热情地给他拉一张订单表格 —— 这类错误
 * 在真实客服里非常显眼，因为它一眼就看得出「没听懂」。
 *
 * 判据是：有明确订单指向（订单号或指代）就按操作办，否则看是不是在问规则。
 */
const POLICY_SIGNAL = /(多久|几天|什么时候|怎么算|谁承担|谁出|能不能|可以吗|规则|政策|流程|什么条件|怎么开|怎么申请|如何|时间)/;
const ORDER_SIGNAL = /(订单|买了什么|买了啥|买的|下单|发货|物流|包裹|快递)/;
const RESULT_SIGNAL = /(进度|进展|到哪|到账|结果|成功了吗|处理得怎么样|通过了吗)/;
/**
 * 明确在要「系统产出别的东西」—— 写文案、画图、做凭证、生成文件。
 *
 * 这类请求不构成业务操作，但它往往夹着业务词（「生成一张假的退款成功截图」里全是退款）。
 * 不单独摘出来，就会被退款分支收走，然后按「没给单号」的兜底逻辑热情地拉一张订单表格 ——
 * 答非所问，而且是在一个涉及凭证的请求上答非所问。
 */
const NON_BUSINESS = /(生成|伪造|做一张|P一张|画一?[张个幅]|写一[段首篇个]|编一[段个]|截图|图片|海报|文案|作诗|写诗)/;

function classify(text: string, ctx: IntentContext): Intent {
  const orderNo = extractOrderNo(text);

  // ① 询问已有退款结果 —— 必须排在退款意图之前，否则「退款进度」会被当成新的退款申请
  if (ctx.hasRefundResult && RESULT_SIGNAL.test(text) && !/^SO-/.test(text.trim())) {
    const target = orderNo ?? ctx.lastOrderNo;
    if (target) {
      return { kind: "tool", name: "show_result_card", input: { orderNo: target } };
    }
  }

  // ② 要的不是业务操作，是「产出点别的东西」—— 在这就断开，别让它顺着业务词往下走
  if (NON_BUSINESS.test(text)) {
    return { kind: "text", reply: smallTalk(text) };
  }

  // ③ 退款原因统计 —— 也带「退款」二字，靠 CHART_SIGNAL 与申请退款区分开
  if (REFUND_VERB.test(text) && CHART_SIGNAL.test(text)) {
    return {
      kind: "tool",
      name: "show_refund_reason_chart",
      input: { timeRange: extractTimeRange(text), dimension: "reason", measure: extractMeasure(text) },
      lead: "好的，我把退款原因整理一下。",
    };
  }

  // ③ 申请退款：要么用户给了订单号，要么能用「这个订单」指代到最近一单
  if (REFUND_VERB.test(text)) {
    const target = orderNo ?? (REFERENTIAL.test(text) ? ctx.lastOrderNo : undefined);
    if (target) {
      return {
        kind: "tool",
        name: "show_refund_form",
        input: { orderNo: target },
        lead: "好的，我先把退款申请单调出来，你核对下信息。",
      };
    }
    // 问的是规则不是办事 —— 直接文本答复，别把订单表格塞给一个只想问运费的人
    if (POLICY_SIGNAL.test(text)) {
      return { kind: "text", reply: smallTalk(text) };
    }

    // 没给订单号也指代不到 —— 不猜，改为把订单列出来让用户点。猜错订单号的代价太大。
    return {
      kind: "tool",
      name: "show_order_table",
      input: { timeRange: "last30d", statusFilter: "all" },
      lead: "我需要先确认是哪一笔订单，先帮你列出来。",
    };
  }

  // ⑤ 问的是规则而不是查自己的单 —— 必须排在查订单之前
  //
  // 「发货要几天」「什么时候能发货」里有「发货」，会被查订单信号一把捞走，
  // 于是用户问一句发货时效，客服拉一张订单表格出来。判据和退款那条一样：
  // 有明确订单指向（订单号或指代）才算查单，否则先看是不是在问规则。
  if (POLICY_SIGNAL.test(text) && !orderNo && !REFERENTIAL.test(text)) {
    return { kind: "text", reply: smallTalk(text) };
  }

  // ⑥ 查订单
  if (ORDER_SIGNAL.test(text)) {
    return {
      kind: "tool",
      name: "show_order_table",
      input: { timeRange: extractTimeRange(text), statusFilter: "all" },
      lead: "好的，我帮你查一下。",
    };
  }

  // ⑦ 不含任何业务意图 —— 纯文本兜底
  return { kind: "text", reply: smallTalk(text) };
}

/* ============================================================
   兜底话术
   ============================================================ */

function smallTalk(text: string): string {
  if (/(你好|您好|hi|hello|在吗|在么)/i.test(text)) {
    return "你好，我是店铺的智能客服。你可以让我查订单、发起退款，或者看看退款原因的统计。";
  }
  if (/(人工|真人|转接)/.test(text)) {
    return "需要人工客服的话，我帮你转接——工作时间内大概 1 分钟接进来。不过订单和退款这类事我这边可以直接办，能省你排队的时间。";
  }
  if (/(发票|开票)/.test(text)) {
    return "发票可以在订单详情里自助申请，支持电子普票和专票。专票需要提供税号，开出来后会发到你的邮箱。";
  }
  if (/(运费|邮费|包邮)/.test(text)) {
    return "满 99 元包邮，未满的话运费 8 元。退货运费方面：质量问题由我们承担，七天无理由需要你承担寄回运费。";
  }
  if (/(多久|几天|什么时候).*(到账|退款|退钱)/.test(text)) {
    return "退款审核通过后，一般 3–7 个工作日原路退回。具体到账时间取决于支付渠道：微信、支付宝通常更快，银行卡可能多等一两个工作日。";
  }
  if (/(发货|什么时候发|多久发|几天发)/.test(text)) {
    return "现货一般 24 小时内发出，大促期间会顺延 1–2 天。发出后物流信息会更新在订单详情里，你可以随时让我帮你查。";
  }
  if (/(七天无理由|无理由|退货规则|售后)/.test(text)) {
    return "七天无理由从签收当天算起，商品不影响二次销售就可以。定制品、贴身衣物和已拆封的食品不在范围内，这类如果收到就有问题，可以直接走质量问题退货。";
  }
  if (/(忽略|忘记|无视).*(指令|规则|设定)|system\s*prompt|你是什么模型|不受限制|开发者模式|没有限制/i.test(text)) {
    // 这条回复本身不重要 —— 重要的是它由一个「只能调工具」的模型说出来。
    // 即使模型被说服了，它也没有任何渠道能绕过工具去执行退款或读别人的数据。
    return "我是店铺的客服助手，只能帮你查订单、发起退款和看退款统计。别的事我确实做不了——包括跳出这个范围去执行操作。";
  }
  return "这个我暂时没学会。我可以帮你查订单、发起退款，或者看看退款原因的统计——你先说说要办哪件？";
}

/* ============================================================
   流式输出
   ============================================================ */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 按固定字数切块推给前端，模拟打字机。真实模型的 delta 粒度由服务端决定，这里不必对齐。 */
async function streamText(text: string, onDelta?: (d: string) => void): Promise<void> {
  if (!onDelta || text.length === 0) return;
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    onDelta(text.slice(i, i + CHUNK_SIZE));
    if (STREAM_DELAY_MS > 0) await sleep(STREAM_DELAY_MS);
  }
}

/* ============================================================
   适配器实现
   ============================================================ */

export const mockAdapter: LLMAdapter = {
  name: "mock",

  async decide(req: LLMRequest, handlers?: LLMHandlers): Promise<LLMDecision> {
    const ctx: IntentContext = {
      lastOrderNo: readLastOrderNo(req),
      hasRefundResult: /已有一笔退款提交结果/.test(req.system),
    };

    const intent = classify(req.userText, ctx);

    if (intent.kind === "text") {
      await streamText(intent.reply, handlers?.onTextDelta);
      return { text: intent.reply, toolCalls: [] };
    }

    const toolCall: LLMToolCall = {
      id: nextCallId(),
      name: intent.name,
      input: intent.input,
    };

    if (intent.lead) {
      await streamText(intent.lead, handlers?.onTextDelta);
    }

    return { text: intent.lead ?? "", toolCalls: [toolCall] };
  },
};

/**
 * 从 system 里回读「最近一次操作的订单号」。
 *
 * 看起来绕，但这是在如实模拟模型的工作方式：mock 和真模型看到的是同一份 system，
 * 走的是同一条信息通道。如果这里改成直接读服务端 session，mock 就「作弊」了 ——
 * 它拿到了一条真模型拿不到的上下文，两条路径的行为不再可比。
 */
function readLastOrderNo(req: LLMRequest): string | undefined {
  const m = /最近一次操作的订单号是\s*(SO-[^\s，。]+)/.exec(req.system);
  return m ? m[1] : undefined;
}
