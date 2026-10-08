import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import {
  createWorkItemSubscriberRepo,
  type WorkItemSubscriberRepo,
} from "../src/workitem/workItemSubscriberRepo.js";
import { OPT_OUT_SCOPES, SUBSCRIBER_REASONS } from "../src/workitem/subscriberFacts.js";

/* SUB.1 存储面：`work_item_subscribers` 的读写单源。

   本文件只测**存储面**（表形状/唯一键/闭集双闸/tombstone 单列语义/排序/双向读），
   六 reason 的事实驱动与消解规则在 `workItemSubscriberReconciler.test.ts`。

   期望值来源：拆解报告 §2.1 冻结的表形状与四条规则（逐字抄录，不在测试里重算实现的口径）。 */

const WS = { key: "ws-sub", path: "/tmp/ws-sub" };
const ITEM = "wi-sub";

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return db;
}

function fresh(): { db: DatabaseSync; repo: WorkItemSubscriberRepo } {
  const db = openDb();
  return { db, repo: createWorkItemSubscriberRepo(db) };
}

function active(
  input: {
    reason?: string;
    subjectType?: string;
    subjectId?: string;
    workItemId?: string;
    createdAt?: number;
    id?: string;
  } = {},
) {
  return {
    id: input.id,
    workspaceKey: WS.key,
    workspacePath: WS.path,
    workItemId: input.workItemId ?? ITEM,
    subjectType: input.subjectType ?? "human",
    subjectId: input.subjectId ?? "local-user",
    reason: input.reason ?? "creator",
    createdAt: input.createdAt ?? 1_000,
  } as Parameters<WorkItemSubscriberRepo["upsertActive"]>[0];
}

function rowCount(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM work_item_subscribers").get() as { n: number }).n;
}

function rawRow(db: DatabaseSync, id: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM work_item_subscribers WHERE id = ?").get(id) as Record<
    string,
    unknown
  >;
}

// ---------------------------------------------------------------------------
// 写入：活动行 upsert（存储层幂等，不「先查后插」）
// ---------------------------------------------------------------------------

test("存储｜活动行 upsert：新行落全部列；同键重投不产第二行、不改 created_at、返回 false", () => {
  const { db, repo } = fresh();
  const input = active({ reason: "creator", createdAt: 1_000, id: "s-1" });
  assert.equal(repo.upsertActive(input), true, "首次写入真的插入了行");
  const first = rawRow(db, "s-1");
  assert.deepEqual(
    {
      workspace_key: first.workspace_key,
      workspace_path: first.workspace_path,
      work_item_id: first.work_item_id,
      subject_type: first.subject_type,
      subject_id: first.subject_id,
      reason: first.reason,
      opt_out_scope: first.opt_out_scope,
      tombstoned_at: first.tombstoned_at,
      created_at: first.created_at,
    },
    {
      workspace_key: WS.key,
      workspace_path: WS.path,
      work_item_id: ITEM,
      subject_type: "human",
      subject_id: "local-user",
      reason: "creator",
      opt_out_scope: "issue",
      tombstoned_at: null,
      created_at: 1_000,
    },
    "新行的列值与入参逐字一致（活动行恒 issue、tombstone 为空）",
  );

  // 同事实重投：同一个入参第二次调用不得产生第二行、不得改写 created_at。
  assert.equal(repo.upsertActive(active({ id: "s-2" })), false, "同键第二次不写（存储层幂等）");
  assert.equal(rowCount(db), 1, "唯一键兜住：只有一行");
  assert.equal(rawRow(db, "s-1").created_at, 1_000, "重投不改 created_at（不产生新时间戳）");
});

test("存储｜活动行 upsert 是「最近事实胜」：活动行改 reason，同一行不新增", () => {
  const { db, repo } = fresh();
  repo.upsertActive(active({ reason: "creator", createdAt: 1_000, id: "s-1" }));
  assert.equal(
    repo.upsertActive(active({ reason: "commenter", createdAt: 2_000, id: "s-2" })),
    true,
    "活动行上的新事实改写 reason",
  );
  assert.equal(rowCount(db), 1, "仍是一行（reason 是这行上的字段，不是键的一部分）");
  const row = rawRow(db, "s-1");
  assert.equal(row.reason, "commenter");
  assert.equal(row.created_at, 1_000, "改写 reason 不动 created_at（关系从第一次建立算起）");
});

test("存储｜闭集写闸：闭集外的 reason / subject_type / scope 一律抛且不落盘", () => {
  const { db, repo } = fresh();
  assert.throws(
    () => repo.upsertActive(active({ reason: "bystander" })),
    /reason/,
    "reason 闭集外必须写抛",
  );
  assert.throws(
    () => repo.upsertActive(active({ subjectType: "system" })),
    /subject_type/,
    "subject_type 闭集外（system 不是订阅主体）必须写抛",
  );
  assert.throws(
    () => repo.upsertTombstone({ ...active(), scope: "workspace" as never }),
    /opt_out_scope/,
    "opt_out_scope 闭集外必须写抛",
  );
  assert.equal(rowCount(db), 0, "被拒的三次都不得留下半行");
  // 闭集常量本身是契约（与 DDL 的列取值域同源）：六 reason / 三主体 / 两档范围。
  assert.deepEqual(
    [...SUBSCRIBER_REASONS],
    ["creator", "assignee", "commenter", "mentioned", "delegated", "manual"],
  );
  assert.deepEqual([...OPT_OUT_SCOPES], ["issue", "subtree"]);
});

test("存储｜闭集读闸：手改库造出的枚举外值在**读回时**响亮抛（不静默按默认值处理）", () => {
  const { db, repo } = fresh();
  const insert = (id: string, reason: string, scope: string, subjectType: string) =>
    db
      .prepare(
        `INSERT INTO work_item_subscribers (
           id, workspace_key, workspace_path, work_item_id, subject_type, subject_id,
           reason, opt_out_scope, tombstoned_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`,
      )
      .run(id, WS.key, WS.path, ITEM, subjectType, id, reason, scope);
  insert("bad-reason", "creator_v2", "issue", "human");
  insert("bad-scope", "creator", "everything", "human");
  insert("bad-subject", "creator", "issue", "robot");
  assert.throws(() => repo.listByWorkItem(WS.key, ITEM), /reason/);
  db.prepare("DELETE FROM work_item_subscribers WHERE id = 'bad-reason'").run();
  assert.throws(() => repo.listByWorkItem(WS.key, ITEM), /opt_out_scope/);
  db.prepare("DELETE FROM work_item_subscribers WHERE id = 'bad-scope'").run();
  assert.throws(() => repo.listByWorkItem(WS.key, ITEM), /subject_type/);
});

// ---------------------------------------------------------------------------
// tombstone：显式退订（单列语义 + 首次时刻保留 + 未命中响亮抛）
// ---------------------------------------------------------------------------

test("存储｜显式退订：无行 ⇒ 建 tombstone 行（reason=manual 承载用户意愿）；有行 ⇒ 保留首次时刻、更新范围", () => {
  const { db, repo } = fresh();
  repo.upsertTombstone({ ...active({ id: "s-t1", createdAt: 1_000 }), scope: "issue" });
  const first = rawRow(db, "s-t1");
  assert.equal(first.tombstoned_at, 1_000, "tombstone 行带退订时刻");
  assert.equal(first.opt_out_scope, "issue");
  assert.equal(first.reason, "manual", "凭空退订的行只有一个人可解释的来源：用户自己");
  assert.equal(rowCount(db), 1);

  repo.upsertTombstone({ ...active({ id: "s-t2", createdAt: 5_000 }), scope: "subtree" });
  assert.equal(rowCount(db), 1, "仍是同一行（退订是同一关系的状态，不新增行）");
  const second = rawRow(db, "s-t1");
  assert.equal(second.opt_out_scope, "subtree", "用户改主意换档 ⇒ 范围跟着改");
  assert.equal(second.tombstoned_at, 1_000, "首次退订时刻不被后来的调用改写（COALESCE 口径）");

  repo.upsertTombstone({ ...active({ id: "s-t3", createdAt: 9_000 }), scope: "subtree" });
  assert.equal(rawRow(db, "s-t1").tombstoned_at, 1_000, "同事实重投不改时间戳");
});

test("存储｜显式复活：清 tombstone 且 reason 归 manual、范围回到 issue；未命中响亮抛", () => {
  const { db, repo } = fresh();
  assert.throws(
    () =>
      repo.clearTombstone({
        workspaceKey: WS.key,
        workItemId: ITEM,
        subjectType: "human",
        subjectId: "local-user",
      }),
    /没有/,
    "无行可言复活：静默 no-op 会让界面以为订阅成功了",
  );
  repo.upsertActive(active({ reason: "creator", id: "s-1", createdAt: 1_000 }));
  repo.upsertTombstone({ ...active({ id: "s-1" }), scope: "subtree" });
  repo.clearTombstone({
    workspaceKey: WS.key,
    workItemId: ITEM,
    subjectType: "human",
    subjectId: "local-user",
  });
  const row = rawRow(db, "s-1");
  assert.equal(row.tombstoned_at, null, "复活 = 清掉墓碑");
  assert.equal(row.reason, "manual", "复活只能由用户手动作成 ⇒ reason 归 manual");
  assert.equal(row.opt_out_scope, "issue", "活动行恒 issue（范围只在 tombstone 行上有语义）");
  assert.equal(row.created_at, 1_000, "复活不动 created_at");
});

test("存储｜tombstone 是自动规则的**禁区**：活动 upsert 不得复活、manual 行不得被改写", () => {
  const { db, repo } = fresh();
  repo.upsertTombstone({ ...active({ id: "s-t1", createdAt: 1_000 }), scope: "subtree" });
  assert.equal(
    repo.upsertActive(active({ reason: "commenter", createdAt: 2_000 })),
    false,
    "已退订的行对自动事实不变（用户说过「不想收」）",
  );
  const tomb = rawRow(db, "s-t1");
  assert.equal(tomb.tombstoned_at, 1_000, "墓碑仍在");
  assert.equal(tomb.reason, "manual", "reason 不被自动事实改写");

  const { db: db2, repo: repo2 } = fresh();
  repo2.upsertActive(active({ reason: "manual", id: "s-m", createdAt: 1_000 }));
  assert.equal(
    repo2.upsertActive(active({ reason: "assignee", createdAt: 2_000 })),
    false,
    "manual 行受保护：自动事实既不删也不改写",
  );
  assert.equal(rawRow(db2, "s-m").reason, "manual");
  assert.equal(rowCount(db2), 1);
});

// ---------------------------------------------------------------------------
// 自动撤销：删行（只删「负责人关系」的活动自动行）
// ---------------------------------------------------------------------------

test("存储｜自动撤销：删负责人关系的活动自动行；manual / tombstone / 非负责人 reason 的行原样保留", () => {
  const { db, repo } = fresh();
  const key = (subjectId: string) => ({
    workspaceKey: WS.key,
    workItemId: ITEM,
    subjectType: "agent" as const,
    subjectId,
  });
  repo.upsertActive({
    ...active({
      subjectType: "agent",
      subjectId: "ag-1",
      reason: "assignee",
      id: "s-a1",
      createdAt: 1,
    }),
  });
  repo.upsertActive({
    ...active({
      subjectType: "agent",
      subjectId: "ag-2",
      reason: "commenter",
      id: "s-a2",
      createdAt: 2,
    }),
  });
  repo.upsertActive({
    ...active({
      subjectType: "agent",
      subjectId: "ag-3",
      reason: "manual",
      id: "s-a3",
      createdAt: 3,
    }),
  });
  repo.upsertTombstone({
    ...active({
      subjectType: "agent",
      subjectId: "ag-4",
      reason: "delegated",
      id: "s-a4",
      createdAt: 4,
    }),
    scope: "issue",
  });
  assert.equal(
    rawRow(db, "s-a4").reason,
    "manual",
    "凭空退订的 tombstone 行只有用户自己这个来源（reason 归 manual）",
  );

  assert.equal(repo.revokeAssignment(key("ag-1")), true, "负责人活动行被撤销");
  assert.equal(rawRow(db, "s-a1"), undefined, "撤销 = 删行（关系不再存在）");
  assert.equal(
    repo.revokeAssignment(key("ag-2")),
    false,
    "仅因评论在册的行不是负责人关系：撤销不适用（删了就是静默丢事实）",
  );
  assert.equal(repo.revokeAssignment(key("ag-3")), false, "manual 行不可被自动规则删除");
  assert.equal(
    repo.revokeAssignment(key("ag-4")),
    false,
    "tombstone 行不可被自动规则删除（那是用户的意愿，不是可撤销的关系）",
  );
  assert.equal(rowCount(db), 3, "除被撤销的那一行外三行都在");
  assert.equal(rawRow(db, "s-a3").reason, "manual");
  assert.equal(rawRow(db, "s-a4").tombstoned_at, 4, "tombstone 行仍在（撤销触不到它）");
});

// ---------------------------------------------------------------------------
// 读：双向（按工作项 / 按主体）+ 固定排序
// ---------------------------------------------------------------------------

test("存储｜双向读与固定排序：按工作项、按主体各一条 SQL；排序恒 created_at ASC, id ASC", () => {
  const { db, repo } = fresh();
  const insert = (id: string, workItemId: string, subjectId: string, createdAt: number) =>
    db
      .prepare(
        `INSERT INTO work_item_subscribers (
           id, workspace_key, workspace_path, work_item_id, subject_type, subject_id,
           reason, opt_out_scope, tombstoned_at, created_at
         ) VALUES (?, ?, ?, ?, 'human', ?, 'creator', 'issue', NULL, ?)`,
      )
      .run(id, WS.key, WS.path, workItemId, subjectId, createdAt);
  // 同刻并列按 id 升序定序（在存储顺序之外另有一条确定序列）。
  insert("s-b", ITEM, "u-b", 1_000);
  insert("s-a", ITEM, "u-a", 1_000);
  insert("s-c", ITEM, "u-c", 2_000);
  insert("s-d", "wi-other", "u-a", 3_000);
  insert("s-e", "wi-other", "u-b", 4_000);
  db.prepare(
    `INSERT INTO work_item_subscribers (
       id, workspace_key, workspace_path, work_item_id, subject_type, subject_id,
       reason, opt_out_scope, tombstoned_at, created_at
     ) VALUES ('s-x', 'ws-other', '/tmp/other', ?, 'human', 'u-a', 'creator', 'issue', NULL, 1)`,
  ).run(ITEM);

  assert.deepEqual(
    repo.listByWorkItem(WS.key, ITEM).map((row) => row.id),
    ["s-a", "s-b", "s-c"],
    "按工作项：只读本 workspace 本工作项的**全部**行（含 tombstone），排序 created_at ASC, id ASC",
  );
  assert.deepEqual(
    repo.listBySubject(WS.key, "human", "u-a").map((row) => row.id),
    ["s-a", "s-d"],
    "按主体：跨工作项（SUB.2 的收件人解析要用这一口），排除异己 workspace 的同 id 行",
  );
  assert.equal(
    repo.get({ workspaceKey: WS.key, workItemId: ITEM, subjectType: "human", subjectId: "u-a" })
      ?.id,
    "s-a",
  );
  assert.equal(
    repo.get({ workspaceKey: WS.key, workItemId: ITEM, subjectType: "human", subjectId: "absent" }),
    null,
    "没有就是 null（不是错误）",
  );

  const record = repo.listByWorkItem(WS.key, ITEM)[0]!;
  assert.equal(record.workspaceKey, WS.key);
  assert.equal(record.workspacePath, WS.path);
  assert.equal(record.workItemId, ITEM);
  assert.equal(record.subjectType, "human");
  assert.equal(record.subjectId, "u-a");
  assert.equal(record.reason, "creator");
  assert.equal(record.optOutScope, "issue");
  assert.equal(record.tombstonedAt, null);
  assert.equal(record.createdAt, 1_000);
});
