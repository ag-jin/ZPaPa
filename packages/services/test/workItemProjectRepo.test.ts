import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import {
  createWorkItemProjectRepo,
  isProjectShortCodeConflict,
} from "../src/workitem/workItemProjectRepo.js";

/* 工作项**项目**的存储面（`projects`，迁移 0022；R-P1 切片 2）。

   形态取自 multica（`server/migrations/034_projects.up.sql` + `035` + `166`，证据
   `reports/2026-10-09-multica-issue-project-binding.md` A1），本仓三条自己的纪律：
   ① **workspace 隔离写进每条 SQL**（`workspace_key` 是 WHERE 的一部分）：异己 workspace 的同 id
      读不到、也改不动 —— 第二份「先读再比 key」的判据会与 SQL 漂移，且漂移不报错；
   ② **短码唯一由存储层兜底**（唯一索引 + 冲突错误模式识别），不做先查后插（并发下两次查都会
      看不到对方）；
   ③ **工作项挂接是另一张表的写**（`bindWorkItem` / `remove` 里的 `UPDATE work_items`）：
      项目维度不新开第二条「写 work_items」的旁路，挂接与置空都只经本模块。 */

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return db;
}

const BASE = {
  id: "p-1",
  workspaceKey: "ws-a",
  name: "平台重构",
  shortCode: "PLT",
  status: "planned" as const,
  createdAt: 100,
  updatedAt: 100,
};

function insertItem(db: DatabaseSync, id: string, workspaceKey = "ws-a"): void {
  db.prepare(
    `INSERT INTO work_items (id, workspace_key, workspace_path, parent_id, stage, title, body,
       status, assignee_type, assignee_id, labels, properties, position, archived_at, created_at, updated_at)
     VALUES (?, ?, '/tmp/ws', NULL, NULL, ?, '', 'todo', 'user', 'hu-1', '[]', '{}', 0, NULL, 1, 1)`,
  ).run(id, workspaceKey, `标题 ${id}`);
}

function rawItem(
  db: DatabaseSync,
  id: string,
): { project_id: string | null; identifier_prefix: string | null } {
  // node:sqlite 的行是 null-prototype 对象：摊成普通对象，deepEqual 才比字段而不是原型。
  const row = db
    .prepare("SELECT project_id, identifier_prefix FROM work_items WHERE id = ?")
    .get(id) as { project_id: string | null; identifier_prefix: string | null };
  return { project_id: row.project_id, identifier_prefix: row.identifier_prefix };
}

test("repo｜CRUD：insert → get 逐字段读回（NULL ⇒ undefined）；list 按 created_at,id；update 逐字段 patch；remove 恰命中一行", () => {
  const db = makeDb();
  const repo = createWorkItemProjectRepo(db);
  const created = repo.insert({
    ...BASE,
    description: "把老的 runner 拆掉",
    icon: "🚀",
    priority: "high",
    startDate: "2026-10-01",
    dueDate: "2026-12-31",
  });
  assert.deepEqual(
    { ...created },
    {
      id: "p-1",
      workspaceKey: "ws-a",
      name: "平台重构",
      shortCode: "PLT",
      description: "把老的 runner 拆掉",
      icon: "🚀",
      status: "planned",
      priority: "high",
      startDate: "2026-10-01",
      dueDate: "2026-12-31",
      createdAt: 100,
      updatedAt: 100,
    },
    "写入返回读回的形状（不是把入参原样回抛）",
  );
  // 可空字段：未给 ⇒ 列 NULL ⇒ 读回 undefined（「未设置」只有一种形态）。
  repo.insert({ ...BASE, id: "p-2", shortCode: "OPS", createdAt: 101, updatedAt: 101 });
  const nullable = repo.get("ws-a", "p-2");
  assert.ok(nullable);
  assert.equal(nullable.description, undefined);
  assert.equal(nullable.icon, undefined);
  assert.equal(nullable.priority, undefined);
  assert.equal(nullable.startDate, undefined);
  assert.equal(nullable.dueDate, undefined);
  assert.deepEqual(
    repo.listByWorkspace("ws-a").map((row) => row.id),
    ["p-1", "p-2"],
    "列表按 created_at ASC, id ASC（同刻行次序确定，不随存储引擎抖动）",
  );

  // update：给了哪个字段才写哪个字段；null = 清回未设置（与「没给」区分）。
  const updated = repo.update({
    workspaceKey: "ws-a",
    id: "p-1",
    patch: {
      name: "平台重构 v2",
      status: "in_progress",
      priority: null,
      dueDate: "2027-01-31",
      icon: null,
    },
    updatedAt: 200,
  });
  assert.ok(updated, "命中一行 ⇒ 返回改写后的行");
  assert.deepEqual(
    {
      name: updated.name,
      status: updated.status,
      priority: updated.priority,
      dueDate: updated.dueDate,
      icon: updated.icon,
      description: updated.description,
      shortCode: updated.shortCode,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    },
    {
      name: "平台重构 v2",
      status: "in_progress",
      priority: undefined,
      dueDate: "2027-01-31",
      icon: undefined,
      description: "把老的 runner 拆掉",
      shortCode: "PLT",
      createdAt: 100,
      updatedAt: 200,
    },
    "patch 子集语义：未给的字段不动（description/shortCode/createdAt），null 清空（priority/icon）",
  );
  assert.equal(
    repo.update({ workspaceKey: "ws-a", id: "p-1", patch: {}, updatedAt: 300 }),
    null,
    "空 patch 直接未命中（不执行「不 SET 任何列」的空写）",
  );
  assert.equal(
    repo.update({ workspaceKey: "ws-a", id: "nope", patch: { name: "x" }, updatedAt: 300 }),
    null,
    "未命中（id 算错 / 异 workspace）返回 null，调用方据此响亮抛",
  );

  assert.equal(repo.remove("ws-a", "p-2"), true, "恰命中一行 ⇒ true");
  assert.equal(repo.remove("ws-a", "p-2"), false, "再删一次 ⇒ false（不存在就是不存在）");
  assert.equal(repo.get("ws-a", "p-1")?.id, "p-1", "remove 只删目标行");
  db.close();
});

test("repo｜workspace 隔离：同 id/同短码跨 workspace 各自成立；异己 workspace 读不到也改不动", () => {
  const db = makeDb();
  const repo = createWorkItemProjectRepo(db);
  repo.insert({ ...BASE });
  // 同短码在另一个 workspace 合法（唯一键带 workspace 前缀）。
  repo.insert({ ...BASE, id: "p-other", workspaceKey: "ws-b" });
  assert.equal(repo.get("ws-b", "p-other")?.id, "p-other");
  assert.equal(repo.get("ws-b", "p-1"), null, "异 workspace 的同 id 读不到（SQL 层租户守卫）");
  assert.deepEqual(
    repo.listByWorkspace("ws-b").map((row) => row.id),
    ["p-other"],
    "列表只含本 workspace 的行",
  );
  assert.equal(
    repo.update({ workspaceKey: "ws-b", id: "p-1", patch: { name: "越界改" }, updatedAt: 9 }),
    null,
    "异 workspace 改不动（未命中 ⇒ null）",
  );
  assert.equal(repo.get("ws-a", "p-1")?.name, "平台重构", "越界 update 没有落下任何改动");
  assert.equal(repo.remove("ws-b", "p-1"), false, "异 workspace 删不掉");
  assert.equal(repo.get("ws-a", "p-1")?.id, "p-1", "越界 remove 没有删掉目标行");
  db.close();
});

test("repo｜短码唯一：同 workspace 重复 ⇒ 存储层 UNIQUE 冲突（可被 isProjectShortCodeConflict 识别），不静默改码", () => {
  const db = makeDb();
  const repo = createWorkItemProjectRepo(db);
  repo.insert({ ...BASE });
  let conflict: unknown;
  try {
    repo.insert({ ...BASE, id: "p-2" });
  } catch (error) {
    conflict = error;
  }
  assert.ok(conflict instanceof Error, "重复短码必须抛（不得静默改名/改名落库）");
  assert.equal(
    isProjectShortCodeConflict(conflict),
    true,
    "冲突可被模式识别（服务面据此给稳定错误码，而不是把原生错误原文漏给用户）",
  );
  assert.equal(
    isProjectShortCodeConflict(new Error("UNIQUE constraint failed: work_items.id")),
    false,
    "别处的唯一冲突不得被误认成短码冲突",
  );
  assert.equal(
    repo.listByWorkspace("ws-a").length,
    1,
    "冲突那次没有留下半截行（插入要么整行成立、要么被拒）",
  );
  db.close();
});

test("repo｜bindWorkItem：挂接写 project_id + 前缀快照；置空两者同 NULL；未归档才命中（归档/未知/异 workspace ⇒ false）", () => {
  const db = makeDb();
  const repo = createWorkItemProjectRepo(db);
  repo.insert({ ...BASE });
  insertItem(db, "wi-a");
  insertItem(db, "wi-b", "ws-b");
  db.prepare(
    `INSERT INTO work_items (id, workspace_key, workspace_path, parent_id, stage, title, body,
       status, assignee_type, assignee_id, labels, properties, position, archived_at, created_at, updated_at)
     VALUES ('wi-archived', 'ws-a', '/tmp/ws', NULL, NULL, '归档项', '', 'todo', 'user', 'hu-1',
       '[]', '{}', 0, 500, 1, 1)`,
  ).run();

  assert.equal(
    repo.bindWorkItem({
      workspaceKey: "ws-a",
      workItemId: "wi-a",
      projectId: "p-1",
      identifierPrefix: "PLT",
    }),
    true,
    "挂接恰命中一行 ⇒ true",
  );
  assert.deepEqual(
    rawItem(db, "wi-a"),
    { project_id: "p-1", identifier_prefix: "PLT" },
    "两列同写",
  );

  assert.equal(
    repo.bindWorkItem({
      workspaceKey: "ws-a",
      workItemId: "wi-a",
      projectId: null,
      identifierPrefix: null,
    }),
    true,
  );
  assert.deepEqual(
    rawItem(db, "wi-a"),
    { project_id: null, identifier_prefix: null },
    "置空 = 回无项目：两列同置 NULL（清零后编号显示回落 #N）",
  );

  // 未命中三种：归档行（repo 一律把归档当不存在）、未知 id、异 workspace 的行。
  assert.equal(
    repo.bindWorkItem({
      workspaceKey: "ws-a",
      workItemId: "wi-archived",
      projectId: "p-1",
      identifierPrefix: "PLT",
    }),
    false,
    "归档行不可挂接（未命中 ⇒ false，调用方响亮抛）",
  );
  assert.equal(
    repo.bindWorkItem({
      workspaceKey: "ws-a",
      workItemId: "nope",
      projectId: "p-1",
      identifierPrefix: "PLT",
    }),
    false,
  );
  assert.equal(
    repo.bindWorkItem({
      workspaceKey: "ws-a",
      workItemId: "wi-b",
      projectId: "p-1",
      identifierPrefix: "PLT",
    }),
    false,
    "异 workspace 的工作项不可挂接（SQL 的 workspace_key 守卫）",
  );
  assert.deepEqual(rawItem(db, "wi-b"), { project_id: null, identifier_prefix: null });
  db.close();
});

test("repo｜读回双闸：闭集外 priority 响亮抛（不静默当未设置）；列上合法值原样读回", () => {
  const db = makeDb();
  const repo = createWorkItemProjectRepo(db);
  repo.insert({ ...BASE, priority: "urgent" });
  assert.equal(repo.get("ws-a", "p-1")?.priority, "urgent");
  // 绕过写入口直改库（跨版本残留 / 手改库的形态）：读回必须响亮，不得当成 undefined。
  db.prepare("UPDATE projects SET priority = 'someday' WHERE id = 'p-1'").run();
  assert.throws(
    () => repo.get("ws-a", "p-1"),
    /priority 读回非法值「someday」/,
    "闭集外档位读回即抛（静默按未设置会让用户设过的档位凭空消失）",
  );
  db.close();
});

test("repo｜remove = 置空挂接 + 删行：本 workspace 挂到该项目的行全部解绑、前缀快照保留；异 workspace 的行不动", () => {
  const db = makeDb();
  const repo = createWorkItemProjectRepo(db);
  repo.insert({ ...BASE });
  repo.insert({ ...BASE, id: "p-keep", shortCode: "KEEP" });
  insertItem(db, "wi-1");
  insertItem(db, "wi-2");
  insertItem(db, "wi-keep");
  insertItem(db, "wi-other", "ws-b");
  repo.bindWorkItem({
    workspaceKey: "ws-a",
    workItemId: "wi-1",
    projectId: "p-1",
    identifierPrefix: "PLT",
  });
  repo.bindWorkItem({
    workspaceKey: "ws-a",
    workItemId: "wi-2",
    projectId: "p-1",
    identifierPrefix: "PLT",
  });
  repo.bindWorkItem({
    workspaceKey: "ws-b",
    workItemId: "wi-other",
    projectId: "p-1",
    identifierPrefix: "PLT",
  });
  // 挂到别的项目的行不受影响。
  repo.bindWorkItem({
    workspaceKey: "ws-a",
    workItemId: "wi-keep",
    projectId: "p-keep",
    identifierPrefix: "KEEP",
  });

  assert.equal(repo.remove("ws-a", "p-1"), true);
  assert.equal(repo.get("ws-a", "p-1"), null, "行已删除");
  assert.deepEqual(
    rawItem(db, "wi-1"),
    { project_id: null, identifier_prefix: "PLT" },
    "挂接置 NULL（multica ON DELETE SET NULL 的等价物）；前缀快照保留（已签发的编号不重写）",
  );
  assert.deepEqual(rawItem(db, "wi-2"), { project_id: null, identifier_prefix: "PLT" });
  assert.deepEqual(
    rawItem(db, "wi-other"),
    { project_id: "p-1", identifier_prefix: "PLT" },
    "异 workspace 的行不得被本 workspace 的删项目波及",
  );
  assert.deepEqual(
    rawItem(db, "wi-keep"),
    { project_id: "p-keep", identifier_prefix: "KEEP" },
    "挂到别的项目的行不动",
  );
  assert.equal(repo.get("ws-a", "p-keep")?.id, "p-keep", "同 workspace 的别的项目仍在");
  db.close();
});
