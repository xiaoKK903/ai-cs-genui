/**
 * 用量记账（H6）
 *
 * ## 为什么成本必须被看见
 *
 * 「客服 Agent 一个月烧了多少钱」这个问题，如果上线时答不出来，
 * 等能答出来的时候通常已经超预算了。成本控制的第一步不是省，
 * 而是**把花费摊到每一次调用上**——有了这个，才能回答「哪个会话在烧钱」
 * 「预路由到底省了多少」。
 *
 * ## 记账粒度选在会话，不是因为用户
 *
 * 按会话累计，才能在出现异常会话（一个会话几百次调用）时定位到它。
 * 全局一个总数做不到这件事：总数涨了，但你不知道是谁。
 *
 * ## 单位是 token，不是钱
 *
 * 不同模型的单价不一样，而且会变。把价格写死在代码里，
 * 模型一涨价，这个文件就变成了一份过期的报价单 —— 比没有更糟，
 * 因为它看起来是权威的。这里只记 token，换算成钱是看板那一层的事。
 */

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface CostSnapshot extends Usage {
  calls: number;
  /** 预路由省下的模型调用次数 */
  savedCalls: number;
}

export class CostLedger {
  private perKey = new Map<string, CostSnapshot>();
  private saved = 0;

  record(key: string, usage: Usage): void {
    const cur = this.perKey.get(key) ?? { inputTokens: 0, outputTokens: 0, calls: 0, savedCalls: 0 };
    cur.inputTokens += usage.inputTokens;
    cur.outputTokens += usage.outputTokens;
    cur.calls += 1;
    this.perKey.set(key, cur);
  }

  /** 预路由命中时调一次 —— 省下的那一次也要记，否则「省了多少」永远说不清 */
  recordSaved(key: string): void {
    const cur = this.perKey.get(key) ?? { inputTokens: 0, outputTokens: 0, calls: 0, savedCalls: 0 };
    cur.savedCalls += 1;
    this.perKey.set(key, cur);
    this.saved += 1;
  }

  snapshot(key: string): CostSnapshot {
    return this.perKey.get(key) ?? { inputTokens: 0, outputTokens: 0, calls: 0, savedCalls: 0 };
  }

  total(): CostSnapshot & { sessions: number } {
    const out = { inputTokens: 0, outputTokens: 0, calls: 0, savedCalls: 0, sessions: this.perKey.size };
    for (const v of this.perKey.values()) {
      out.inputTokens += v.inputTokens;
      out.outputTokens += v.outputTokens;
      out.calls += v.calls;
      out.savedCalls += v.savedCalls;
    }
    return out;
  }

  /**
   * 会话级预算上限。
   *
   * 触顶后的动作是**降级成文本**而不是拒绝服务：用户还能把话说完、
   * 还能拿到订单信息，只是不再渲染组件。一个把用户彻底挡在门外的成本控制，
   * 是拿可用性换成本，通常不划算。
   */
  overBudget(key: string, maxCalls: number): boolean {
    return this.snapshot(key).calls >= maxCalls;
  }

  forget(key: string): void {
    this.perKey.delete(key);
  }

  reset(): void {
    this.perKey.clear();
    this.saved = 0;
  }
}
