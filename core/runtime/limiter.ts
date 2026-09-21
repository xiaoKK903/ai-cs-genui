/**
 * 限流与并发闸（H3 + H1）
 *
 * 两种限制，防的是两件事：
 *
 *   令牌桶（按用户/会话）—— 防**单个**用户刷。一个人按住回车不放，
 *     不该让所有人的对话都变慢。所以桶的键是会话，不是全局。
 *
 *   并发闸（全局）—— 防**整体**过载。SSE 连接是长连接，每个连接都占着一份
 *     服务端资源直到本轮结束。没有上限的话，一个流量峰值能把所有连接一起拖住。
 *
 * 用内存实现而不是 Redis：这是个单实例演示项目，引入外部依赖换来的分布式一致性
 * 在这里没有对应的问题。真要多实例部署时，这两个类就是需要换掉的那两个 ——
 * 接口（tryAcquire / release / snapshot）是照着可替换设计的，调用方不用改。
 */

export interface LimiterSnapshot {
  /** 当前桶里的令牌数 */
  tokens: number;
  /** 被限流拒过多少次 —— 正常应该接近 0，持续上涨说明有人在刷或者配额定小了 */
  rejected: number;
}

/**
 * 令牌桶。
 *
 * 相比「每分钟最多 N 次」的固定窗口，桶的好处是允许**短暂的突发**：
 * 用户连问三句是正常的，只要长期速率不超标就该放行。固定窗口会把
 * 「59 秒 2 次 + 61 秒 2 次」判成两次超额，这是误伤。
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private rejected = 0;

  constructor(
    readonly capacity: number,
    /** 每秒补充多少令牌 */
    readonly refillPerSec: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefill = now();
  }

  tryAcquire(n = 1): boolean {
    const t = this.now();
    const elapsed = Math.max(0, t - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.lastRefill = t;

    if (this.tokens < n) {
      this.rejected += 1;
      return false;
    }
    this.tokens -= n;
    return true;
  }

  snapshot(): LimiterSnapshot {
    return { tokens: Math.floor(this.tokens), rejected: this.rejected };
  }
}

/** 按 key 懒创建桶。key 用会话 ID：限的是「谁在刷」，不是「刷了多少」。 */
export class KeyedRateLimiter {
  private buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {}

  tryAcquire(key: string): boolean {
    let b = this.buckets.get(key);
    if (!b) {
      b = new TokenBucket(this.capacity, this.refillPerSec);
      this.buckets.set(key, b);
    }
    return b.tryAcquire();
  }

  /**
   * 会话结束后清掉桶。
   *
   * 不清的话，这份 Map 会随会话数无限增长 —— 一个只在长跑之后才暴露的内存泄漏，
   * 本地开发永远看不到。清掉的代价只是用户下次回来时桶是满的，正是我们想要的。
   */
  forget(key: string): void {
    this.buckets.delete(key);
  }

  get size(): number {
    return this.buckets.size;
  }

  /** 仅测试用 */
  reset(): void {
    this.buckets.clear();
  }
}

/**
 * 并发闸：同时进行中的轮次上限。
 *
 * 这是 H1「最大连接保护」里和 SSE 连接数配套的另一半 ——
 * 连接数限制挡的是「挂着的连接」，并发闸挡的是「正在跑的轮次」。
 * 两者都要有：一个客户端可以只开一条连接但反复发请求。
 */
export class ConcurrencyGate {
  private inFlight = 0;
  private rejected = 0;
  private peak = 0;

  constructor(readonly limit: number) {}

  tryEnter(): boolean {
    if (this.inFlight >= this.limit) {
      this.rejected += 1;
      return false;
    }
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    return true;
  }

  leave(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  snapshot(): { inFlight: number; peak: number; rejected: number; limit: number } {
    return { inFlight: this.inFlight, peak: this.peak, rejected: this.rejected, limit: this.limit };
  }

  reset(): void {
    this.inFlight = 0;
    this.rejected = 0;
    this.peak = 0;
  }
}
