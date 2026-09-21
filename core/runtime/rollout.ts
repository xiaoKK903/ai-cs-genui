/**
 * 灰度分桶
 *
 * ## 为什么分桶的键必须是会话，不能是随机数
 *
 * 抽签式的灰度（每次请求随机决定用新版本）在客服场景里是灾难：
 * 用户第一句拿到 v2 的图表、第二句拿到 v1 的，同一个会话里两种卡片交替出现。
 * 用户说不清哪里不对，只会觉得「这东西不太稳」。
 *
 * 所以分桶键取会话 ID，并且用**确定性哈希**：同一个会话永远落在同一个桶里。
 * 新会话才会被分到另一个版本。这是灰度能被人接受的最低要求 ——
 * 一个用户在一次对话里看到的行为，必须是一致的。
 *
 * ## 哈希为什么自己写
 *
 * FNV-1a 十行就写完了。用 crypto 的 sha256 也行，但那是为了「抗碰撞」——
 * 灰度分桶不需要抗碰撞，它需要的是**跨进程一致**（同一份配置在多个实例上
 * 必须算出同一个桶），而 FNV-1a 完全满足。为不需要的性质引入异步 API
 * 和一次哈希开销，不划算。
 *
 * ## 配置形态
 *
 *   ROLLOUT="RefundReasonChart@2=10"
 *
 * 读作：RefundReasonChart 的 v2 放给 10% 的会话，其余仍走 v1。
 * 没写进配置的组件一律走默认版本 —— **默认永远是旧版本**，
 * 这是灰度该有的缺省方向：新代码需要被明确地打开，而不是被意外地打开。
 */

/** FNV-1a 32 位。返回值落在 [0, 2^32)。 */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    // 乘 16777619 用移位加法实现，避免 32 位溢出后的精度问题
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * 把任意键稳定地映射到 [0, 100) 的桶号。
 *
 * 加 salt 是为了「换一个实验就换一批人」—— 否则同一个不幸的用户
 * 会在所有实验里都落在实验组（或者都落在对照组），样本是有偏的。
 */
export function bucketOf(key: string, salt = ""): number {
  return fnv1a(`${salt}:${key}`) % 100;
}

export interface RolloutRule {
  component: string;
  version: string;
  /** 放量百分比，0–100 */
  percent: number;
}

export interface RolloutPlan {
  rules: RolloutRule[];
  /** 配置原始文本，便于审计时回答「当时开的是什么」 */
  raw: string;
}

/**
 * 解析配置。格式：`OrderTable@1=100, RefundReasonChart@2=10`
 *
 * 解析失败的部分**跳过而不是抛错**：灰度配置写错一个字符就让整个服务起不来，
 * 是把配置问题升级成可用性问题。跳过的同时把原文记进 plan.raw，
 * 出问题时能看到「当时配的是什么」。
 */
export function parseRollout(raw: string): RolloutPlan {
  const rules: RolloutRule[] = [];
  for (const part of raw.split(",")) {
    const m = /^\s*([A-Za-z]+)@(\d+)\s*=\s*(\d{1,3})\s*$/.exec(part);
    if (!m) continue;
    const percent = Math.min(100, Math.max(0, Number(m[3])));
    rules.push({ component: m[1], version: m[2], percent });
  }
  return { rules, raw };
}

function currentPlan(): RolloutPlan {
  return parseRollout(process.env.ROLLOUT ?? "");
}

/**
 * 给定组件、会话键，选出该发哪个版本。
 *
 * 命中规则且落在桶内 → 新版本；否则 → 默认版本。
 * 同一个组件有多条规则时，**取第一条命中的**（配置里靠前的优先级更高），
 * 这样「先放 5% 的 v2、再放 50% 的 v3」这种叠加放量不需要额外语法。
 */
export function pickComponentVersion(
  component: string,
  sessionKey: string,
  fallback = "1",
  plan: RolloutPlan = currentPlan(),
): string {
  for (const rule of plan.rules) {
    if (rule.component !== component) continue;
    if (bucketOf(sessionKey, `${component}@${rule.version}`) < rule.percent) {
      return rule.version;
    }
  }
  return fallback;
}
