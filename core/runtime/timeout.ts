/**
 * 超时 —— 生产缺口的通用底座（H2 取数、H3 模型都要它）
 *
 * ## 为什么这是上线前必须补的一条
 *
 * 一个没有超时的 `await` 是一条**无限长的等待**。上游没挂、只是慢的时候，
 * 本地一切指标都正常：连接还在、CPU 不高、错误率也没涨。唯一在变的是
 * 用户那头的输入框一直转。这类「慢故障」比宕机更难被发现，因为它不触发任何报警阈值。
 *
 * ## 一个刻意的语义选择：放弃等待，而不是取消对方
 *
 * 底层 promise 该跑完还是跑完，我们只是不再等它。真模型 SDK 自带取消能力，
 * 但这里不依赖它 —— 统一在这一层断开，调用方拿到的永远是一个确定的错误，
 * 而不是「取决于上游实现」的运气行为。代价是可能有一次白跑的调用，
 * 收益是排查问题时只需要看一个地方。
 */

export class TimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly ms: number,
  ) {
    super(`${label} 超过 ${ms}ms 未返回`);
    this.name = "TimeoutError";
  }
}

/**
 * 给任意 promise 套一个截止时间。
 *
 * `ms <= 0` 或非有限值时直接放行 —— 用来表达「这条路径不设超时」，
 * 而不是「立即超时」。演示模式（mock）下延迟本来就极小，
 * 设成 0 是把它明确关掉，不是把它变成一定会炸。
 */
export async function withTimeout<T>(
  work: Promise<T> | (() => Promise<T>),
  ms: number,
  label: string,
): Promise<T> {
  const promise = typeof work === "function" ? work() : work;
  if (!Number.isFinite(ms) || ms <= 0) return promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
      }),
    ]);
  } finally {
    // 不 clear 的话，这个定时器会把进程多留 ms 毫秒 —— 在测试里表现为「跑完了不退出」
    if (timer) clearTimeout(timer);
  }
}

/** 从环境变量读一个毫秒值，非法时用兜底。写成函数是为了每轮都重新读，方便演示时改。 */
export function msFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}
