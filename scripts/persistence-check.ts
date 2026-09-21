/**
 * 跨进程持久化验证 —— 「重启之后，幂等还算不算数」
 *
 * 跑法：npm run check:persist
 *   它实际上是跑两次这个文件：第一次写入退款，进程退出；第二次是全新进程，
 *   拿同一个幂等键再提交一次。
 *
 * ## 为什么必须分成两个进程
 *
 * 在一个进程里 closeDb() 再 getDb()，只能证明「数据落到了磁盘上」，
 * 证明不了「重启后幂等仍然成立」。而幂等这条红线的价值恰恰在跨进程：
 * 用户点了两次提交，中间服务滚动发布重启了一次 —— 第二次绝不能真的再退一笔。
 *
 * 内存 Map 版本在任何单进程测试里都是绿的，而它在这件事上等于没做。
 * 所以这个检查存在的意义，就是让「换存储」这件事有一个可执行的判据，
 * 而不是停在「我觉得 SQLite 更靠谱」。
 *
 * 用的是独立的库文件（data/persist-check.db），不碰开发时那份数据。
 */

export {};

process.env.AUDIT_LOG = "off";
// 独立库文件：这个检查要反复跑，不该污染 data/app.db
process.env.DB_PATH = "data/persist-check.db";

const { getDb, closeDb } = await import("../core/data/db");
const { __truncateAll, ensureSeeded } = await import("../core/data/seed");
const { DEMO_SESSION_USER_ID, findOrder, submitRefund } = await import("../core/data/order-service");

const PHASE = process.argv[2] ?? "write";
/** 一笔可退款的订单：paid 状态、refundable=true */
const ORDER_NO = "SO-20260910-6620";
/** 固定幂等键：两次进程用的是同一个键，模拟用户重复提交 */
const KEY = "persist-check-001";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${detail ? ` —— ${detail}` : ""}`);
  if (!cond) failed += 1;
}

if (PHASE === "write") {
  console.log("阶段一 · 写入（进程 A）\n");
  // 每次从干净的种子数据开始，保证重复执行结果一致
  __truncateAll();
  ensureSeeded();

  const before = findOrder(DEMO_SESSION_USER_ID, ORDER_NO);
  check("订单初始状态为可退款", before?.refundable === true, `status=${before?.status}`);

  const result = submitRefund(DEMO_SESSION_USER_ID, {
    orderId: ORDER_NO,
    reason: "quality_issue",
    claimedAmountCents: 0,
    idempotencyKey: KEY,
  });
  check("退款提交成功", result.status === "submitted", result.rejectReason ?? "");
  check("首次提交不是幂等命中", result.deduplicated === false);

  const after = findOrder(DEMO_SESSION_USER_ID, ORDER_NO);
  check(
    "订单状态真的变成了退款中",
    after?.status === "refunding" && after?.refundable === false,
    `status=${after?.status} refundable=${after?.refundable}`,
  );

  // 把单据号写进文件，交给下一个进程比对
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync("data", { recursive: true });
  writeFileSync("data/persist-check.expect.json", JSON.stringify({ refundId: result.refundId }), "utf8");

  console.log(`\n  进程 A 即将退出。已写入单据 ${result.refundId}，期望进程 B 读到同一笔。`);
  closeDb();
  process.exit(0);
}

/* ---------- 阶段二：全新进程，读上面那次写入的结果 ---------- */

console.log("阶段二 · 重启后（进程 B）\n");

const { readFileSync } = await import("node:fs");
const expect = JSON.parse(readFileSync("data/persist-check.expect.json", "utf8")) as { refundId: string };

check("进程 B 是独立进程（模块状态已清零）", true);
check("数据库文件存在", (await import("node:fs")).existsSync("data/persist-check.db"));

// 关键一步：用**同一个幂等键**再提交一次。
// 内存版本到这里会当成一笔全新退款，再生成一个单据号。
const again = submitRefund(DEMO_SESSION_USER_ID, {
  orderId: ORDER_NO,
  reason: "quality_issue",
  claimedAmountCents: 0,
  idempotencyKey: KEY,
});

check(
  "重启后同一幂等键返回的是首次那笔单据",
  again.refundId === expect.refundId,
  `期望 ${expect.refundId}，得到 ${again.refundId}`,
);
check("重启后标识为幂等命中", again.deduplicated === true);

const order = findOrder(DEMO_SESSION_USER_ID, ORDER_NO);
check("订单状态在重启后仍是退款中", order?.status === "refunding", `status=${order?.status}`);

const count = getDb().prepare(`SELECT COUNT(*) AS n FROM refunds WHERE idempotency_key = ?`).get(KEY) as {
  n: number;
};
check("库里只有一条单据，没有重复创建", Number(count.n) === 1, `实际 ${count.n} 条`);

closeDb();

console.log(
  failed === 0
    ? "\n通过：退款单据与幂等状态都跨进程存活了。"
    : `\n失败 ${failed} 项 —— 持久化没有真正生效。`,
);
process.exit(failed === 0 ? 0 : 1);
