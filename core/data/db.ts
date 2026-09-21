/**
 * 持久化层 —— SQLite（Node 内置 `node:sqlite`，零第三方依赖）
 *
 * ## 为什么必须换掉内存 Map
 *
 * 前三轮的设计把「退款」定义成一条不可逆的资金操作链路，幂等是它的硬红线。
 * 内存存储在演示时看不出问题，但进程一重启，幂等键、退款单据、会话上下文全部归零 ——
 * 同一个退款请求会在重启后被当成新请求**再执行一次**。
 *
 * 这不是「演示简化」，这是把幂等这条红线做成了假的：真正的幂等必须跨进程存活。
 * 所以这里不只是「换个存储」，而是把第四阶段红线 #2（金额与扣款在服务端 + 幂等）
 * 从「逻辑上正确」变成「物理上成立」。
 *
 * ## 为什么是 SQLite 而不是 Postgres / Redis
 *
 * 生产环境这两者都该在（订单库 + 会话缓存），第四阶段也明确要求会话状态外置。
 * 但演示项目要求 clone 下来零配置可跑，引 Postgres 就把「零依赖离线可跑」这条设计原则破了。
 *
 * `node:sqlite` 是 Node 22.5+ 的内置模块：不引入任何第三方包，却提供真实的
 * 事务、唯一约束与持久化语义。关键收益是**幂等靠 UNIQUE 约束兜底，而不是靠内存 Map 的运气** ——
 * 并发下两个请求同时进来，数据库层面的唯一索引保证只有一个能成功。
 *
 * 换存储只需改这一个文件：上层（order-service / session）只依赖函数签名。
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * 表结构版本。
 * 改 schema 时 +1，并在 upgrade() 里补上对应的升级步骤 ——
 * 演示项目的库文件是可以随时删掉重建的，但迁移机制本身要留着，
 * 因为「schema 怎么演进」是面试里绕不开的一问，没有迁移能力的持久化层是不完整的。
 */
const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  id           TEXT PRIMARY KEY,
  user_id      TEXT    NOT NULL,
  item_name    TEXT    NOT NULL,
  amount_cents INTEGER NOT NULL,
  status       TEXT    NOT NULL,
  placed_at    TEXT    NOT NULL,
  masked_phone TEXT    NOT NULL,
  address      TEXT    NOT NULL,
  refundable   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, placed_at DESC);

CREATE TABLE IF NOT EXISTS refund_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT    NOT NULL,
  order_id     TEXT    NOT NULL,
  reason       TEXT    NOT NULL,
  amount_cents INTEGER NOT NULL,
  requested_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refund_history_user ON refund_history(user_id, requested_at DESC);

-- 退款单据。
--
-- 主键是自增 id 而不是 idempotency_key：被拒绝的提交也要留档（可追溯、可告警），
-- 而同一个幂等键在「先被拒、后补正资料再提交」的场景下会出现多条。
-- 真正的幂等约束交给下面那个**部分唯一索引** —— 只对成功单据生效。
CREATE TABLE IF NOT EXISTS refunds (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key  TEXT    NOT NULL,
  refund_id        TEXT    NOT NULL,
  order_id         TEXT    NOT NULL,
  user_id          TEXT    NOT NULL,
  amount_cents     INTEGER NOT NULL,
  status           TEXT    NOT NULL,
  expected_arrival TEXT    NOT NULL,
  reject_reason    TEXT,
  trace_id         TEXT    NOT NULL,
  created_at       TEXT    NOT NULL
);
-- 幂等的物理保证：同一幂等键只可能有一条「成功」单据，并发下由数据库拒绝第二条。
CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_idem
  ON refunds(idempotency_key) WHERE status = 'submitted';
CREATE INDEX IF NOT EXISTS idx_refunds_inflight ON refunds(order_id, user_id, status);

CREATE TABLE IF NOT EXISTS sessions (
  session_id         TEXT PRIMARY KEY,
  user_id            TEXT    NOT NULL,
  last_order_no      TEXT,
  last_refund_result TEXT,
  live_instances     TEXT    NOT NULL DEFAULT '{}',
  turns              TEXT    NOT NULL DEFAULT '[]',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS seq (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
`;

export function resolveDbPath(): string {
  const raw = process.env.DB_PATH?.trim();
  if (!raw) return resolve(process.cwd(), "data", "app.db");
  return raw === ":memory:" ? raw : resolve(process.cwd(), raw);
}

/**
 * dev 模式下 Next.js 会反复重新执行模块（热重载），
 * 挂在 globalThis 上避免每次热更都新开一个连接把文件句柄耗掉。
 */
const globalForDb = globalThis as unknown as { __csDb?: DatabaseSync };

export function getDb(): DatabaseSync {
  if (globalForDb.__csDb) return globalForDb.__csDb;

  const path = resolveDbPath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const conn = new DatabaseSync(path);
  // WAL：读写不互斥，SSE 长连接期间写审计不会阻塞读订单
  conn.exec("PRAGMA journal_mode = WAL");
  conn.exec("PRAGMA foreign_keys = ON");
  conn.exec("PRAGMA busy_timeout = 5000");
  conn.exec(SCHEMA);
  upgrade(conn);

  globalForDb.__csDb = conn;
  return conn;
}

function upgrade(conn: DatabaseSync): void {
  const row = conn.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  const current = Number(row?.user_version ?? 0);
  if (current === SCHEMA_VERSION) return;

  // 版本 0 → 1：初始建表已由上面的 CREATE TABLE IF NOT EXISTS 完成，这里只记录版本。
  // 后续破坏性变更在这里写 ALTER，而不是让使用者删库重来。
  conn.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/** 仅供测试：关闭并丢弃连接，下次 getDb() 重新打开。 */
export function closeDb(): void {
  globalForDb.__csDb?.close();
  globalForDb.__csDb = undefined;
}

/**
 * 原子自增，用于生成业务单号。
 *
 * 不能用 `SELECT COUNT(*) + 1`：并发下两个请求会读到同一个 count 生成同一个单号。
 * 这条 UPDATE ... RETURNING 是原子的，SQLite 的写锁保证不会重号。
 */
export function nextSeq(name: string): number {
  const row = getDb()
    .prepare(
      `INSERT INTO seq(name, value) VALUES(?, 1)
       ON CONFLICT(name) DO UPDATE SET value = value + 1
       RETURNING value`,
    )
    .get(name) as { value: number };
  return Number(row.value);
}
