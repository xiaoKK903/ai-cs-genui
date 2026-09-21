/**
 * 熔断器（H3）
 *
 * ## 它和超时、限流各管什么
 *
 *   超时：单次调用别等太久
 *   限流：保护我们自己不被打垮
 *   熔断：上游已经不行了，别再一遍遍去撞
 *
 * 三件事缺一不可。只有超时时，模型服务抖动期间每一轮请求都要**等满超时**才失败：
 * 用户等 10 秒拿到一句「稍后再试」，而这 10 秒里我们还在持续给一个已经挂掉的上游加压，
 * 把抖动拖成雪崩。
 *
 * ## 三态
 *
 *   closed   正常放行
 *   open     连续失败到阈值 → 快速失败，请求根本不发出去
 *   halfOpen 冷却结束 → 放**一个**探针过去；成功则闭合，失败则重新计时
 *
 * half-open 只放一个探针是刻意的：放开一批流量去试一个可能还没恢复的上游，
 * 等于把刚过去的故障重演一遍。探针的意义是探，不是恢复。
 *
 * ## 为什么是「连续失败」而不是「失败率」
 *
 * 客服流量在一天里分布极不均匀，失败率窗口在低峰期几乎没有统计意义
 * （三分钟里两次请求、错一次，失败率 50%）。连续失败计数在小样本下同样可靠，
 * 不需要额外维护滑动窗口。
 */

export type BreakerState = "closed" | "open" | "halfOpen";

export interface BreakerOptions {
  /** 连续失败多少次后跳闸 */
  threshold?: number;
  /** 跳闸后多久放一个探针（毫秒） */
  cooldownMs?: number;
  /** 注入时钟，测试里用来免等真实冷却 */
  now?: () => number;
}

export interface BreakerSnapshot {
  state: BreakerState;
  consecutiveFailures: number;
  /** 已经跳闸过几次 —— 上线后这个数字应该长期是 0，涨了就是要看的地方 */
  trips: number;
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private state_: BreakerState = "closed";
  private probesInFlight = 0;
  private trips = 0;

  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(
    readonly name: string,
    opts: BreakerOptions = {},
  ) {
    this.threshold = opts.threshold ?? 3;
    this.cooldownMs = opts.cooldownMs ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * 现在能不能发请求。
   *
   * 注意 half-open 下只放一个：拿到许可的调用方必须最终调 onSuccess/onFailure，
   * 否则探针卡住，熔断器会一直停在 half-open 不再放行。这条约束由 withBreaker 保证。
   */
  allow(): boolean {
    if (this.state_ === "closed") return true;

    if (this.state_ === "open") {
      if (this.now() - this.openedAt < this.cooldownMs) return false;
      this.state_ = "halfOpen";
      this.probesInFlight = 0;
    }

    if (this.probesInFlight >= 1) return false;
    this.probesInFlight += 1;
    return true;
  }

  onSuccess(): void {
    if (this.state_ === "halfOpen") this.probesInFlight = Math.max(0, this.probesInFlight - 1);
    this.failures = 0;
    this.state_ = "closed";
  }

  onFailure(): void {
    if (this.state_ === "halfOpen") this.probesInFlight = Math.max(0, this.probesInFlight - 1);
    this.failures += 1;
    if (this.state_ === "halfOpen" || this.failures >= this.threshold) {
      if (this.state_ !== "open") this.trips += 1;
      this.state_ = "open";
      this.openedAt = this.now();
    }
  }

  snapshot(): BreakerSnapshot {
    // 冷却已经过了，但还没人来探 —— 对外如实报 halfOpen，别让面板显示一个已经该合的闸
    const state =
      this.state_ === "open" && this.now() - this.openedAt >= this.cooldownMs ? "halfOpen" : this.state_;
    return { state, consecutiveFailures: this.failures, trips: this.trips };
  }

  /** 仅测试用：把手动改过的状态清干净 */
  reset(): void {
    this.failures = 0;
    this.openedAt = 0;
    this.state_ = "closed";
    this.probesInFlight = 0;
    this.trips = 0;
  }
}

export class CircuitOpenError extends Error {
  constructor(readonly breaker: string) {
    super(`${breaker} 已熔断，本轮快速失败`);
    this.name = "CircuitOpenError";
  }
}

/**
 * 把熔断器套在任意异步调用上。
 *
 * 只有「拿到了许可」的调用才会走到 onSuccess/onFailure —— 被快速失败拒掉的那次
 * 不该计入失败数，否则拒绝本身会把闸门焊死，永远等不到冷却结束。
 */
export async function withBreaker<T>(breaker: CircuitBreaker, work: () => Promise<T>): Promise<T> {
  if (!breaker.allow()) throw new CircuitOpenError(breaker.name);
  try {
    const out = await work();
    breaker.onSuccess();
    return out;
  } catch (err) {
    breaker.onFailure();
    throw err;
  }
}
