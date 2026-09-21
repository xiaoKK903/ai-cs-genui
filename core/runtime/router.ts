/**
 * 意图预路由（H6 成本控制的第一刀）
 *
 * ## 省钱的正确姿势
 *
 * 客服对话里有一类消息根本不需要模型：开场白。真实会话里「在吗」这类
 * 空转消息占比不低，而每一次都要付一遍 system prompt（几百到上千 token）
 * 加上一次完整的模型往返。
 *
 * ## 保守到近乎偏执，是刻意的
 *
 * 预路由写宽了，省下的钱会被「答错」的成本一次性吃掉，而且是在最显眼的地方答错。
 * 所以这里的判据不是「短」「像寒暄」这类启发式，而是：**整条消息（去掉标点后）
 * 完全由寒暄词构成**。多一个字都不预路由，老老实实交给模型。
 *
 * 「退款」是两个字，「在吗」也是两个字。长度是最不该用来做这个判断的特征 ——
 * 这里曾经差点按字数写，那个版本会把所有两字业务词全部吞掉。
 *
 * ## 它和 FORCE_TEXT_ONLY 的区别
 *
 * FORCE_TEXT_ONLY 是**出问题时**的应急闸，关掉的是组件；
 * 预路由是**一直开着**的成本闸，省掉的是一次模型调用。
 * 前者是「不要卡片」，后者是「连模型都不用问」。
 */

/**
 * 整条消息只能由这些片段组成。列表短是特性不是缺陷 ——
 * 每加一个词都要先能回答「它有没有可能出现在一句真正的业务请求里吗」。
 */
const GREETING_TOKENS = [
  "你好",
  "您好",
  "hi",
  "hello",
  "嗨",
  "哈喽",
  "在吗",
  "在么",
  "在不在",
  "有人吗",
  "有人么",
  "客服",
  "在",
  "喂",
  "test",
  "测试",
];

/** 标点、空白、表情这类不携带意图的字符，比对前全部剥掉 */
const NOISE = /[\s。，、！？!?~～.,…·\-—_*^&%$#@+=[\]{}()（）【】"'"'`|\\/:;；：]/g;

/**
 * 句尾语气助词，剥一次再比对。
 *
 * 加这个是因为「你好呀」被漏掉了 —— 词表里当时只有「您好呀」，
 * 换成「你」就不认了。往词表里补组合是个无底洞（你好呀/你好啊/你好呢…），
 * 而这类词尾的规律很单纯：它们不携带任何意图，剥掉不影响语义。
 *
 * 只剥**结尾**的，不剥中间的 —— 中间出现这些字时它多半是词的一部分
 * （「哈喽」的哈、「哎呀」的呀），动了就会认错。
 */
const TAIL_PARTICLE = /[呀啊呢哦嘛啦吧呗哈咯哟]$/;

/**
 * 整条消息（剥离噪声后）是否只是寒暄。
 *
 * 实现上用的是「反复剥掉已知寒暄词，看最后剩不剩东西」，
 * 而不是正则 —— 正则拼这些词很快就会写出一个没人敢改的表达式。
 */
export function isPureGreeting(text: string): boolean {
  let rest = text.toLowerCase().replace(NOISE, "");
  if (!rest) return false; // 只有标点或全空：不预路由，让模型/闸去处理，别在这里悄悄吞掉

  // 反复剥尾部的语气词：「你好呀呀」也该算寒暄。上限几次是防御性的 ——
  // 正常的句子不会有十个连续的「呀」，真有的话说明它不是寒暄。
  for (let i = 0; i < 3 && TAIL_PARTICLE.test(rest); i += 1) rest = rest.slice(0, -1);
  if (!rest) return false; // 整个消息就是一串语气词，同上，不在这里吞掉

  let changed = true;
  while (changed && rest.length > 0) {
    changed = false;
    // 长词优先，否则「您好呀」会先被「您好」吃掉，剩下一个「呀」让整条判定失败
    for (const token of [...GREETING_TOKENS].sort((a, b) => b.length - a.length)) {
      if (rest.startsWith(token)) {
        rest = rest.slice(token.length);
        changed = true;
        break;
      }
    }
  }
  return rest.length === 0;
}

/** 预路由命中时返回的固定话术。语气和 smallTalk 保持一致，用户分辨不出走没走模型。 */
export const PREROUTE_GREETING_REPLY =
  "你好，我是店铺的智能客服。你可以让我查订单、发起退款，或者看看退款原因的统计——要办哪件，直接说就行。";

export interface PrerouteHit {
  reply: string;
  reason: string;
}

/**
 * 命中则返回固定话术，未命中返回 null（调用方照常走模型）。
 *
 * 返回值刻意是 null 而不是 `{hit: false}`：调用点写 `if (hit)` 就够了，
 * 少一层判断就少一处能写反的地方。
 */
export function preroute(text: string): PrerouteHit | null {
  if (isPureGreeting(text)) {
    return { reply: PREROUTE_GREETING_REPLY, reason: "纯寒暄，无需模型" };
  }
  return null;
}
