import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { SQUAD_RUN_SCHEMA } from "../src/session/tasksDatabase/schema-v1.js";
import {
  createSquadRunRepo,
  SQUAD_RUN_STATUSES,
  type SquadRunRecord,
} from "../src/workitem/squadRunRepo.js";

function setup() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return { db, repo: createSquadRunRepo(db) };
}
const row = (over: Partial<SquadRunRecord> = {}): SquadRunRecord => ({
  runId: "run-1",
  workspaceKey: "ws",
  workspacePath: "/tmp/ws",
  workItemId: "wi-child",
  parentWorkItemId: "wi-parent",
  agentId: "ta-a",
  isLeaderTask: false,
  branch: "squad/member/aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbb",
  dirName: "aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb",
  status: "open",
  sessionId: null,
  // 缺省 = NULL（遗留行 / 未知成因语义）：用例只覆写自己关心的那一档。
  dispatchCause: null,
  causedByRunId: null,
  // 0014 两列：缺省 = 与 createdAt 同刻（直开行的常态形态；queued 行由语句强制 NULL，见队列用例）。
  openedAt: 1,
  settleReason: null,
  // 0015 九列：缺省 = 未记录（全 NULL）。**读回恒有值**（`rowToSquadRun` 原样映射列），
  // 故行字面量必须显式带上这 9 个键，否则「写入 → 读回」的 deepEqual 会因键集不同而假红。
  usageTotalTokens: null,
  usageInputTokens: null,
  usageOutputTokens: null,
  usageReasoningTokens: null,
  usageCacheCreationTokens: null,
  usageCacheReadTokens: null,
  usageModelRequestCount: null,
  usageModelErrorCount: null,
  usageRecordedAt: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

test("迁移建出 squad_runs 表与索引", () => {
  const { db } = setup();
  const t = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='squad_runs'")
    .all();
  assert.equal(t.length, 1);
  const i = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_squad_runs%'")
    .all();
  // C2（0009）后共 4 个：active / work_item + 队列唯一性部分索引 / 容量计数索引。
  assert.equal(i.length, 4);
});

// 硬约束 2 的落点：活跃集合必须**跨重启存活**，所以它是持久行而不是内存状态。
// 三个未合并状态里有任何一个漏掉，都会让「已产出未合并」（含被打回待修的）队员工作树
// 在下次启动被静默回收——S5「审查被拒不提前删」当场落空。
test("listActive 只取未合并的三个状态，且按 workspace 隔离", () => {
  const { repo } = setup();
  repo.insert(row({ runId: "r-open", status: "open" }));
  repo.insert(row({ runId: "r-produced", status: "produced" }));
  repo.insert(row({ runId: "r-rejected", status: "rejected" }));
  repo.insert(row({ runId: "r-merged", status: "merged" }));
  repo.insert(row({ runId: "r-discarded", status: "discarded" }));
  repo.insert(row({ runId: "r-other-ws", status: "open", workspaceKey: "ws2" }));
  assert.deepEqual(
    repo
      .listActive("ws")
      .map((r) => r.runId)
      .sort(),
    ["r-open", "r-produced", "r-rejected"],
  );
});

test("setStatus 推进状态并保留 dirName / sessionId", () => {
  const { repo } = setup();
  repo.insert(row({ runId: "r1" }));
  repo.setStatus("r1", "merged", { sessionId: "sess-1" });
  const after = repo.get("r1")!;
  assert.equal(after.status, "merged");
  assert.equal(after.sessionId, "sess-1");
  assert.equal(after.dirName, "aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb");
});

test("listByParent 取整批（含已收尾的）", () => {
  const { repo } = setup();
  repo.insert(row({ runId: "r1" }));
  repo.insert(row({ runId: "r2", status: "merged" }));
  repo.insert(row({ runId: "r3", parentWorkItemId: "wi-other", workItemId: "wi-x" }));
  assert.deepEqual(
    repo
      .listByParent("wi-parent")
      .map((r) => r.runId)
      .sort(),
    ["r1", "r2"],
  );
});

// 读回枚举列必须响亮失败：P1 的 wakeRuleRepo 已就此定过调（读回非法值抛，不静默按默认值处理）。
// 手改过库的行会把状态键换个名字，静默按默认值处理等于「工作项状态已经不对了但没人知道」。
test("读回枚举外状态抛错", () => {
  const { db, repo } = setup();
  repo.insert(row({ runId: "r1" }));
  db.prepare("UPDATE squad_runs SET status='bogus' WHERE run_id='r1'").run();
  assert.throws(() => repo.get("r1"), /status/);
});

test("写入未知状态抛错（不落盘）", () => {
  const { repo } = setup();
  repo.insert(row({ runId: "r1" }));
  assert.throws(() => repo.setStatus("r1", "bogus" as never), /status/);
  // 「不落盘」不是修辞：状态闸在 SQL 之前，非法值根本没机会写进列（否则读回校验会在
  // 下次启动才炸，把失败推迟到无人值守的时刻）。
  assert.equal(repo.get("r1")!.status, "open");
});

// 隔离要按**状态全集**逐格验：只测「别的 workspace 的 open 行不出现」会漏掉
// 「别的 workspace 的 merged / discarded 行混进结果」这类错法——SQL 少一个 workspace_key
// 条件时，多出来的正是这些行，而且不报错。
// C2 起：闭集含 queued（六个）。**期望值不变**即「queued 不入活跃集」的回归断言
//（排队行无树无会话，混进活跃集会污染快照/启动和解/队长判据——C0 2.1 的整表后果）。
test("listActive 的 workspace 隔离覆盖全部六个状态（queued 不入活跃集）", () => {
  const { repo } = setup();
  for (const status of SQUAD_RUN_STATUSES) {
    repo.insert(
      row({
        runId: `ws2-${status}`,
        workspaceKey: "ws2",
        status,
        // 排队行实体不变式：无树无分支（写路径闸会拒绝带 branch/dir_name 的 queued 行）。
        ...(status === "queued" ? { branch: null, dirName: null } : {}),
      }),
    );
  }
  repo.insert(row({ runId: "ws-open" }));
  assert.deepEqual(
    repo.listActive("ws").map((r) => r.runId),
    ["ws-open"],
  );
  assert.deepEqual(
    repo.listActive("ws2").map((r) => r.runId),
    ["ws2-open", "ws2-produced", "ws2-rejected"],
  );
});

/* ---------- C2：队列持久事实（路径 A：闭集扩 queued，活跃集三值不动） ---------- */

test("queued 行实体不变式：写路径拒绝带 branch/dir_name 的排队行", () => {
  const { repo } = setup();
  assert.throws(
    () => repo.insert(row({ runId: "q-bad", status: "queued" })),
    /queued/,
    "排队行无树无分支：insert 必须拒绝带 branch/dir_name 的 queued 行",
  );
  repo.insert(row({ runId: "q-ok", status: "queued", branch: null, dirName: null }));
  const queued = repo.get("q-ok")!;
  assert.equal(queued.status, "queued");
  assert.equal(queued.branch, null);
  assert.equal(queued.dirName, null);
});

test("insertMemberRunOrQueue：容量未满直开；满则排队；已有排队行则并入（留痕）", () => {
  const { repo, db } = setup();
  // 容量 1：第一条直开（open 行照既有形态落盘）。
  const first = repo.insertMemberRunOrQueue(row({ runId: "r-1", workItemId: "wi-1" }), 1);
  assert.equal(first.kind, "opened");
  assert.equal(repo.get("r-1")!.status, "open");

  // 容量满（count(open)≥1）且无排队行 ⇒ 新 runId 落 queued 行。
  const second = repo.insertMemberRunOrQueue(row({ runId: "r-2", workItemId: "wi-2" }), 1);
  assert.equal(second.kind, "queued");
  const queuedRow = repo.get("r-2")!;
  assert.equal(queuedRow.status, "queued");
  assert.equal(queuedRow.branch, null, "排队行不占树：branch 必须为 NULL");
  assert.equal(queuedRow.dirName, null, "排队行不占树：dir_name 必须为 NULL");

  // 容量满且已有 (workItem,agent) 之外……不——并入键是 (workspace,workItem,agent)：
  // 同 agent 的**另一个**工作项会各自排队；这里验「同 (workItem,agent) 第三次请求 ⇒ 并入既存排队行」。
  const third = repo.insertMemberRunOrQueue(row({ runId: "r-3", workItemId: "wi-2" }), 1);
  assert.equal(third.kind, "coalesced");
  assert.equal(third.targetRunId, "r-2", "并入目标 = 既存排队行 r-2（至多一个待开）");
  // 排队行总数仍为 1（部分唯一索引在语句前置之外再兜一层）。
  const queuedCount = db
    .prepare("SELECT COUNT(*) AS n FROM squad_runs WHERE status = 'queued'")
    .get() as { n: number };
  assert.equal(queuedCount.n, 1);
  // 并入留痕：明细表一行，幂等（同请求重投不重复计数）。（映射成标量数组再比：SQLite 行是
  // null 原型对象，与字面量 deepEqual 会因原型不同而假红。）
  const details = db
    .prepare("SELECT request_run_id, target_run_id FROM squad_run_coalesced_details")
    .all() as Array<{ request_run_id: string; target_run_id: string }>;
  assert.deepEqual(
    details.map((d) => [d.request_run_id, d.target_run_id]),
    [["r-3", "r-2"]],
  );
});

test("insertMemberRunOrQueue：不同工作项各自排队（唯一性按 (workspace,workItem,agent)）", () => {
  const { repo, db } = setup();
  assert.equal(
    repo.insertMemberRunOrQueue(row({ runId: "r-1", workItemId: "wi-1" }), 1).kind,
    "opened",
  );
  assert.equal(
    repo.insertMemberRunOrQueue(row({ runId: "r-2", workItemId: "wi-2" }), 1).kind,
    "queued",
  );
  assert.equal(
    repo.insertMemberRunOrQueue(row({ runId: "r-3", workItemId: "wi-3" }), 1).kind,
    "queued",
  );
  const queuedCount = db
    .prepare("SELECT COUNT(*) AS n FROM squad_runs WHERE status = 'queued'")
    .get() as { n: number };
  assert.equal(
    queuedCount.n,
    2,
    "不同 workItem 的排队行互不并入（键是 (workspace,workItem,agent)）",
  );
});

test("insertMemberRunOrQueue：容量放宽后恢复直开；produced/rejected 不占容量", () => {
  const { repo } = setup();
  assert.equal(
    repo.insertMemberRunOrQueue(row({ runId: "r-1", workItemId: "wi-1" }), 2).kind,
    "opened",
  );
  // produced 仍占树但**不占并发容量**（计数口径 = count(open)，C0 十点之 10）。
  repo.setStatus("r-1", "produced");
  assert.equal(
    repo.insertMemberRunOrQueue(row({ runId: "r-2", workItemId: "wi-2" }), 1).kind,
    "opened",
  );
});

test("listQueued：按台账序返回；跨重启持久", () => {
  const dir = mkdtempSync(join(tmpdir(), "squad-queue-"));
  try {
    const dbPath = join(dir, "tasks.db");
    const db = new DatabaseSync(dbPath);
    runTasksDatabaseMigrations(db);
    const repo = createSquadRunRepo(db);
    repo.insert(row({ runId: "r-1", workItemId: "wi-1" }));
    repo.insertMemberRunOrQueue(row({ runId: "q-1", workItemId: "wi-2", createdAt: 5 }), 1);
    repo.insertMemberRunOrQueue(row({ runId: "q-2", workItemId: "wi-3", createdAt: 9 }), 1);
    db.close();
    // 重开连接：排队事实仍在（持久，不靠内存）。
    const reopened = new DatabaseSync(dbPath);
    const repo2 = createSquadRunRepo(reopened);
    assert.deepEqual(
      repo2.listQueued("ws").map((r) => r.runId),
      ["q-1", "q-2"],
      "排队行跨重启可读，序 = ORDER_BY_CREATED",
    );
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discardQueuedRun：只收排队行；重复丢弃/非排队行响亮抛", () => {
  const { repo } = setup();
  repo.insert(row({ runId: "r-1", workItemId: "wi-1" }));
  const result = repo.insertMemberRunOrQueue(row({ runId: "q-1", workItemId: "wi-2" }), 1);
  assert.equal(result.kind, "queued");
  repo.discardQueuedRun("q-1");
  assert.equal(repo.get("q-1")!.status, "discarded", "丢弃出口：queued → discarded（终态）");
  assert.throws(() => repo.discardQueuedRun("q-1"), /queued/, "已终态的行不得再丢（响亮，不静默）");
  assert.throws(() => repo.discardQueuedRun("r-1"), /queued/, "open 行不走排队丢弃出口");
});

// 队长 run 不建工作树（spec §6.1），它的 branch / dirName 是 NULL。活跃集合按 status 过滤、
// **不**按 branch 是否为空过滤，所以队长 run 也必须出现在 listActive 里——它的成果同样未合并，
// 少算它会让「整批还没收尾」这件事在重启后消失。
test("listActive 含 branch / dirName 为 null 的队长 run", () => {
  const { repo } = setup();
  repo.insert(row({ runId: "r-leader", isLeaderTask: true, branch: null, dirName: null }));
  const active = repo.listActive("ws");
  assert.deepEqual(
    active.map((r) => r.runId),
    ["r-leader"],
  );
  assert.equal(active[0]!.branch, null);
  assert.equal(active[0]!.dirName, null);
  assert.equal(active[0]!.isLeaderTask, true);
});

test("get 未命中返回 null", () => {
  const { repo } = setup();
  assert.equal(repo.get("nope"), null);
});

/* ---------- 0015：用量记账 `recordUsage`（write-once 单点写） ---------- */

/** 一组独立字面量的用量快照（期望值不按实现的方式重算）。 */
const USAGE = {
  totalTokens: 12345,
  inputTokens: 10000,
  outputTokens: 2345,
  reasoningTokens: 678,
  cacheCreationTokens: 111,
  cacheReadTokens: 222,
  modelRequestCount: 7,
  modelErrorCount: 1,
} as const;

test("recordUsage 写入生效：8 数值列与入参逐一相等，usageRecordedAt 非空", () => {
  const { repo } = setup();
  repo.insert(row({ runId: "r-usage" }));
  assert.deepEqual(repo.recordUsage("r-usage", USAGE), { written: true });
  const after = repo.get("r-usage")!;
  assert.equal(after.usageTotalTokens, 12345);
  assert.equal(after.usageInputTokens, 10000);
  assert.equal(after.usageOutputTokens, 2345);
  assert.equal(after.usageReasoningTokens, 678);
  assert.equal(after.usageCacheCreationTokens, 111);
  assert.equal(after.usageCacheReadTokens, 222);
  assert.equal(after.usageModelRequestCount, 7);
  assert.equal(after.usageModelErrorCount, 1);
  assert.equal(typeof after.usageRecordedAt, "number", "存在性开关必须落定（NULL = 未记录）");
});

// write-once 的**直接**证据：来源是会话累计值，同一 run 重拉只会变大；取「先到者赢」让快照语义
// 明确（结算时刻的值）。`updated_at` 也不得动——它是「确实没写」的可观察证据（行内容逐列不变）。
test("recordUsage 二次调用 no-op：{written:false} 且行内容（含 updated_at）逐列不变", () => {
  const { db, repo } = setup();
  repo.insert(row({ runId: "r-usage" }));
  assert.deepEqual(repo.recordUsage("r-usage", USAGE), { written: true });
  const first = repo.get("r-usage")!;
  // SQLite 行是 null 原型对象，与字面量 deepEqual 会因原型不同而假红 ⇒ 先取原始列快照。
  const rawOf = () =>
    Object.fromEntries(
      Object.entries(
        db.prepare("SELECT * FROM squad_runs WHERE run_id = 'r-usage'").get() as Record<
          string,
          unknown
        >,
      ).sort(([a], [b]) => a.localeCompare(b)),
    );
  const rawFirst = rawOf();

  assert.deepEqual(
    repo.recordUsage("r-usage", { ...USAGE, totalTokens: 999999, inputTokens: 888888 }),
    { written: false },
    "已记录 ⇒ 合法重投的幂等返回（不是抛：查询面超时重发安全）",
  );

  assert.deepEqual(rawOf(), rawFirst, "二次调用不得改动任何列（含 updated_at：没写就是没写）");
  assert.deepEqual(repo.get("r-usage"), first, "读回与首次落账逐字段一致（没有被覆盖）");
});

// 未命中 runId 必须响亮失败（照 bindSession / setStatus 的同款裁定）：静默返回 {written:false}
// 会把「没有这一行」（接线 bug / 台账被删）混同「已记录」，而两者处置完全不同。
test("recordUsage 未命中 runId 抛错", () => {
  const { repo } = setup();
  assert.throws(() => repo.recordUsage("nope", USAGE), /runId/);
});

/* ---------- 0008：派发成因两列（`dispatch_cause` / `caused_by_run_id`） ---------- */

// 写读**往返**（含 NULL 往返）：NULL 是遗留行 / 未知成因的合法值（读回原样给 null，不得被猜成某档）。
test("dispatch_cause / caused_by_run_id 写读往返（含 NULL 与三档枚举）", () => {
  const { repo } = setup();
  repo.insert(row({ runId: "r-legacy" })); // 缺省 = NULL
  repo.insert(
    row({
      runId: "r-caused",
      dispatchCause: "leader_tool",
      causedByRunId: "r-lead-1",
    }),
  );
  repo.insert(row({ runId: "r-user", dispatchCause: "user_reassign" }));
  repo.insert(row({ runId: "r-rule", dispatchCause: "rule" }));

  const legacy = repo.get("r-legacy")!;
  assert.equal(legacy.dispatchCause, null, "缺省必须落 NULL（不猜任何一档）");
  assert.equal(legacy.causedByRunId, null, "缺省必须落 NULL");

  const caused = repo.get("r-caused")!;
  assert.equal(caused.dispatchCause, "leader_tool");
  assert.equal(caused.causedByRunId, "r-lead-1", "入边（哪个队长派的）必须逐字读回");

  assert.equal(repo.get("r-user")!.dispatchCause, "user_reassign");
  assert.equal(repo.get("r-rule")!.dispatchCause, "rule");
  assert.equal(repo.get("r-rule")!.causedByRunId, null, "非 leader_tool 派发没有入边");
});

// 队长行的写路径是另一条语句（`INSERT … SELECT`，值的最多、最易错位）——成因两列同样要落台。
// `assert.deepEqual(读回, 写入)` 是**参数错位**的直接证据：错位时会有别的值落在 dispatch_cause 上。
// 0014 加两列后占位从 15 变 17：这条断言同时钉住「两条语句的占位与参数个数逐参对齐」。
test("insertLeaderRunIfNotInProgress 的成因列同样落台（17 值占位逐参对齐）", () => {
  const { repo } = setup();
  const leader = row({
    runId: "r-lead",
    workItemId: "wi-parent",
    parentWorkItemId: "wi-parent",
    isLeaderTask: true,
    branch: null,
    dirName: null,
    dispatchCause: "rule",
  });
  assert.equal(repo.insertLeaderRunIfNotInProgress(leader), true);
  assert.deepEqual(repo.get("r-lead"), leader);
  // 并发兜底不受加列影响：同一工作项第二条活跃队长行仍被吃掉（且不落成第二条）。
  assert.equal(repo.insertLeaderRunIfNotInProgress(leader), false);
});

// 读回枚举必须响亮失败（照 readStatus 的同款理由）：成因决定「这条 run 是谁派的」——
// 时间线画「队长→队员」弧线读它。静默按 NULL 处理 = 库里明明写着值、读出来却是「不知道」，且不报错。
test("读回枚举外 dispatch_cause 抛错（NULL 合法，枚举外不是）", () => {
  const { db, repo } = setup();
  repo.insert(row({ runId: "r1", dispatchCause: "leader_tool" }));
  db.prepare("UPDATE squad_runs SET dispatch_cause='bogus' WHERE run_id='r1'").run();
  assert.throws(() => repo.get("r1"), /dispatch_cause/);
});

test("写入未知 dispatch_cause 抛错（不落盘）", () => {
  const { db, repo } = setup();
  assert.throws(
    () => repo.insert(row({ runId: "r1", dispatchCause: "bogus" as never })),
    /dispatch_cause/,
  );
  // 「不落盘」是字面意思：闸在 SQL 之前，非法值根本没机会写进列（否则读回校验会在下次启动才炸）。
  assert.equal((db.prepare("SELECT count(*) AS n FROM squad_runs").get() as { n: number }).n, 0);
  // 队长那条写路径同一道闸。
  assert.throws(
    () =>
      repo.insertLeaderRunIfNotInProgress(
        row({ runId: "r-lead", isLeaderTask: true, dispatchCause: "bogus" as never }),
      ),
    /dispatch_cause/,
  );
});

// 未知 runId 必须响亮失败（不是静默 no-op）：调用方以为在推进某个 run，行不在说明 runId 算错了
// 或台账被删；静默跳过会让这次 run 永远停在不一致的状态里而没人知道。
test("setStatus 未知 runId 抛错", () => {
  const { repo } = setup();
  assert.throws(() => repo.setStatus("nope", "produced"), /runId/);
});

test("setStatus 不带 patch 时不动 branch / dirName / sessionId", () => {
  const { repo } = setup();
  repo.insert(row({ runId: "r1", sessionId: "sess-orig" }));
  repo.setStatus("r1", "produced");
  const after = repo.get("r1")!;
  assert.equal(after.status, "produced");
  assert.equal(after.sessionId, "sess-orig");
  assert.equal(after.branch, "squad/member/aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbb");
  assert.equal(after.dirName, "aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb");
  // 推进状态必须留下时间痕迹：updatedAt 由 setStatus 自己戳，不沿用调用方给的值。
  assert.ok(after.updatedAt > after.createdAt, "setStatus 应刷新 updatedAt");
});

test("listByWorkItem 只取该工作项的 run", () => {
  const { repo } = setup();
  repo.insert(row({ runId: "r1", workItemId: "wi-child" }));
  repo.insert(row({ runId: "r2", workItemId: "wi-child", status: "merged" }));
  repo.insert(row({ runId: "r3", workItemId: "wi-other", parentWorkItemId: "wi-other" }));
  assert.deepEqual(
    repo.listByWorkItem("wi-child").map((r) => r.runId),
    ["r1", "r2"],
  );
});

// 台账是**逐字段落盘**：表少一列不会报错，只在写入 / 读回时静默丢字段。故列名逐一比对，
// 并配一条「写入 → 读回」的往返断言（含队长 run 的空 branch / dirName 与 0/1 布尔列）。
// 0008 追加的两列（`dispatch_cause` / `caused_by_run_id`）、0014 追加的两列
//（`opened_at` / `settle_reason`）与 0015 追加的 9 列用量（`usage_*`）必须在清单里，
// 且**在末尾**（与 ALTER TABLE 追加的位置一致）—— 少登记一列就会出现「写了没读回」的静默丢字段；
// **列名逐字**（拼错列名时读回恒 null，而 INSERT/UPDATE 都不报错）。
test("squad_runs 的列与 SquadRunRecord 逐字段对齐", () => {
  const { db } = setup();
  const columns = (
    db.prepare("PRAGMA table_info(squad_runs)").all() as Array<{ name: string }>
  ).map((column) => column.name);
  assert.deepEqual(columns, [
    "run_id",
    "workspace_key",
    "workspace_path",
    "work_item_id",
    "parent_work_item_id",
    "agent_id",
    "is_leader_task",
    "branch",
    "dir_name",
    "status",
    "session_id",
    "created_at",
    "updated_at",
    "dispatch_cause",
    "caused_by_run_id",
    "opened_at",
    "settle_reason",
    // 0015（#6 用量记账）：8 数值 + `usage_recorded_at` 存在性开关（NULL = 未记录 ≠ 0）。
    "usage_total_tokens",
    "usage_input_tokens",
    "usage_output_tokens",
    "usage_reasoning_tokens",
    "usage_cache_creation_tokens",
    "usage_cache_read_tokens",
    "usage_model_request_count",
    "usage_model_error_count",
    "usage_recorded_at",
  ]);
});

test("写入后逐字段读回一致（含队长 run 的空 branch / dirName）", () => {
  const { repo } = setup();
  const member = row();
  repo.insert(member);
  assert.deepEqual(repo.get("run-1"), member);

  const leader = row({
    runId: "run-leader",
    workItemId: "wi-parent",
    isLeaderTask: true,
    branch: null,
    dirName: null,
  });
  repo.insert(leader);
  assert.deepEqual(repo.get("run-leader"), leader);
});

// 与 workItemMigration 的「迁移可重复应用」同一条理由：账本会短路，证明不了 DDL 自身幂等，
// 必须绕开账本直接再执行一遍 SQUAD_RUN_SCHEMA（缺 IF NOT EXISTS 时会在这里抛 already exists）。
test("SQUAD_RUN_SCHEMA 可重复应用", () => {
  const { db } = setup();
  assert.doesNotThrow(
    () => db.exec(SQUAD_RUN_SCHEMA),
    "SQUAD_RUN_SCHEMA 不可重复应用（缺 IF NOT EXISTS 时会在这里抛 already exists）",
  );
});

// 硬约束 2 的**直接**证据：上面用的都是 `:memory:`，只能证明「同一条连接里读得到」。
// 启动回收跨的是**进程重启**，所以这里必须落到文件：写一行 → 关库 → 重新开库（等价于宿主重启）
// → listActive 仍给出未合并的那条。若活跃集合被做成内存态，这条必红。
test("台账跨重启存活：关库重开仍是未合并的活跃 run", () => {
  const dir = mkdtempSync(join(tmpdir(), "squad-runs-"));
  const path = join(dir, "tasks-index.sqlite");
  try {
    const writer = new DatabaseSync(path);
    runTasksDatabaseMigrations(writer);
    const repo = createSquadRunRepo(writer);
    repo.insert(row({ runId: "r-rejected", status: "rejected", workspaceKey: "ws" }));
    writer.close();

    const reader = new DatabaseSync(path);
    runTasksDatabaseMigrations(reader);
    const reopened = createSquadRunRepo(reader);
    assert.deepEqual(
      reopened.listActive("ws").map((r) => r.runId),
      ["r-rejected"],
    );
    reader.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
