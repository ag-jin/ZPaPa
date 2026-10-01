import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createWakeRuleRepo } from "../src/workitem/wakeRuleRepo.js";

function setup() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return { db, repo: createWakeRuleRepo(db) };
}
const rule = (over = {}) => ({
  id: "w1", workItemId: "wi_1", kind: "every", mode: "continuous",
  intervalSeconds: 60, fireCount: 0, revision: 0, enabled: true, ...over,
} as never);

test("迁移建出 wake_rules 表", () => {
  const { db } = setup();
  assert.equal(
    db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='wake_rules'").get().c,
    1,
  );
});

test("listReady 只取到期且 enabled 的规则", () => {
  const { repo } = setup();
  repo.insert(rule({ id: "w_due", nextFireAt: 100 }));
  repo.insert(rule({ id: "w_future", nextFireAt: 999 }));
  repo.insert(rule({ id: "w_off", nextFireAt: 50, enabled: false }));
  assert.deepEqual(repo.listReady(200, 10).map((r) => r.id), ["w_due"]);
});

// revision fencing：过期 revision 的推进必须失败，防止编辑后旧派发覆盖新状态。
test("casAdvance 的 revision 不匹配则拒绝", () => {
  const { repo } = setup();
  repo.insert(rule({ id: "w1" }));
  assert.equal(repo.casAdvance("w1", 7, 200, 1), false);
  assert.equal(repo.get("w1")?.revision, 0);
});

test("casAdvance 命中则推进并 +1 revision", () => {
  const { repo } = setup();
  repo.insert(rule({ id: "w1" }));
  assert.equal(repo.casAdvance("w1", 0, 200, 1), true);
  const after = repo.get("w1")!;
  assert.equal(after.revision, 1);
  assert.equal(after.fireCount, 1);
  assert.equal(after.nextFireAt, 200);
});

test("casAdvance 可写入暂停原因", () => {
  const { repo } = setup();
  repo.insert(rule({ id: "w1" }));
  repo.casAdvance("w1", 0, null, 1, "max_fires");
  assert.equal(repo.get("w1")?.pausedReason, "max_fires");
});

/* ===== 以下为「穷举」矩阵补齐：给定 5 条覆盖了主路径，这里补上被留下的格子 ===== */

// casAdvance 矩阵没覆盖的一格：id 不存在。若实现对不存在的行也返回 true，
// 调用方会把「CAS 命中」当成「规则已推进」，静默丢掉一次派发。
test("casAdvance 对不存在的 id 返回 false", () => {
  const { repo } = setup();
  assert.equal(repo.casAdvance("ghost", 0, 200, 1), false);
});

// listReady 过滤矩阵的最后一格：disabled×未到点，外加 next_fire_at 为 NULL（尚无排期）。
// NULL 若被当成「到点」（如漏写 IS NOT NULL），无排期的规则会每 tick 被捞出。
test("listReady 排除未到点的禁用规则与 next_fire_at=NULL", () => {
  const { repo } = setup();
  repo.insert(rule({ id: "w_off_future", nextFireAt: 999, enabled: false }));
  repo.insert(rule({ id: "w_no_schedule" }));
  assert.deepEqual(repo.listReady(10_000, 10), []);
});

// limit 必须真的下推到 SQL：否则一次性把全库到期规则读进内存，扫表开销随规则数线性增长。
test("listReady 遵守 limit 且按 next_fire_at 升序", () => {
  const { repo } = setup();
  repo.insert(rule({ id: "w2", nextFireAt: 20 }));
  repo.insert(rule({ id: "w1", nextFireAt: 10 }));
  repo.insert(rule({ id: "w3", nextFireAt: 30 }));
  assert.deepEqual(repo.listReady(100, 2).map((r) => r.id), ["w1", "w2"]);
});

// listByWorkItem 是接口方法之一，且工作项删除/编辑时要按它清理规则，不能只靠全表扫。
test("listByWorkItem 只返回该工作项的规则", () => {
  const { repo } = setup();
  repo.insert(rule({ id: "a", workItemId: "wi_1" }));
  repo.insert(rule({ id: "b", workItemId: "wi_2" }));
  repo.insert(rule({ id: "c", workItemId: "wi_1" }));
  assert.deepEqual(repo.listByWorkItem("wi_1").map((r) => r.id), ["a", "c"]);
});

// 表列对齐：① PRAGMA 钉死列名全集(19 个 WakeRule 字段 → 19 列 + created_at/updated_at)。
// 缺列的后果不是报错而是**静默丢数据**，所以列名必须逐字冻结——WakeRule 增删字段而这里没跟上时，
// 本断言先炸；② 把每个字段都填上再读回，验证值也真的往返。两条合起来才覆盖「列在」与「值不丢」。
// 本测试只验**存储层**往返，不涉及 kind/mode 互斥（互斥由 validateWakeRule 负责，Repo 不重复校验）。
test("全部字段往返不丢：表列与 WakeRule 逐字段对齐", () => {
  const { db, repo } = setup();
  assert.deepEqual(
    (db.prepare("PRAGMA table_info(wake_rules)").all() as Array<{ name: string }>)
      .map((column) => column.name)
      .sort(),
    // 前 19 项逐个对应 WakeRule 字段（camelCase → snake_case），后两项是表自身的时间戳。
    [
      "id",
      "work_item_id",
      "kind",
      "mode",
      "at",
      "interval_seconds",
      "cron_expression",
      "timezone",
      "condition",
      "event_types",
      "filters",
      "next_fire_at",
      "max_fires",
      "fire_count",
      "paused_reason",
      "expires_at",
      "on_timeout",
      "revision",
      "enabled",
      "created_at",
      "updated_at",
    ].sort(),
  );

  const full = {
    id: "full",
    workItemId: "wi_full",
    kind: "event",
    mode: "continuous",
    at: 1,
    intervalSeconds: 2,
    cronExpression: "*/5 * * * *",
    timezone: "Asia/Shanghai",
    condition: { type: "issue_field", field: "status", equals: "done" },
    eventTypes: ["issue.updated"],
    filters: { label: "p1" },
    nextFireAt: 3,
    maxFires: 9,
    fireCount: 4,
    pausedReason: "rate",
    expiresAt: 5,
    onTimeout: "wake",
    revision: 6,
    enabled: false,
  } as never;
  repo.insert(full);
  assert.deepEqual(repo.get("full"), full);
});

// JSON 字段必须落成**文本**而不是被拆列：spec §3.5 未枚举 condition/filters 的键名，
// 拆列会把合法参数当未知列拒掉。这里直接看库里存的是字符串。
test("condition/filters/eventTypes 以文本 JSON 存取", () => {
  const { db, repo } = setup();
  repo.insert(rule({ id: "w1", condition: { type: "children_done" }, eventTypes: ["a"], filters: { k: 1 } }));
  const row = db.prepare("SELECT condition, event_types, filters FROM wake_rules WHERE id='w1'").get() as {
    condition: unknown;
    event_types: unknown;
    filters: unknown;
  };
  assert.equal(typeof row.condition, "string");
  assert.equal(typeof row.event_types, "string");
  assert.equal(typeof row.filters, "string");
});

// 两个部分索引必须真的建出，且 ready 索引带着部分条件——否则调度器扫表会退化成全表扫。
test("两个部分索引按声明建出", () => {
  const { db } = setup();
  const ready = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_wake_rules_ready'")
    .get() as { sql: string } | undefined;
  const byWorkItem = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_wake_rules_work_item'")
    .get() as { sql: string } | undefined;
  assert.match(ready?.sql ?? "", /ON wake_rules\s*\(next_fire_at\)/i);
  assert.match(ready?.sql ?? "", /WHERE enabled=1 AND next_fire_at IS NOT NULL/i);
  assert.match(byWorkItem?.sql ?? "", /ON wake_rules\s*\(work_item_id\)/i);
});

// 迁移幂等：同一库跑两次不得抛错，也不得把表重复建出（第二遍应命中账本直接跳过）。
test("迁移可重复应用（同一库跑两次）", () => {
  const { db } = setup();
  runTasksDatabaseMigrations(db);
  assert.equal(
    db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='wake_rules'").get().c,
    1,
  );
});
