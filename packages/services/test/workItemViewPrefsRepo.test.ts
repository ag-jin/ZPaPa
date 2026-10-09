import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import {
  createWorkItemViewPrefsRepo,
  type WorkItemViewOwner,
  type WorkItemViewPrefsRepo,
} from "../src/workitem/workItemViewPrefsRepo.js";

/* `work_item_view_prefs` 存储面（R6a 切片 4）的直接用例。

   形态照 multica `268_issue_view_preference.up.sql` + `issue_view_preference.go`：
   每 owner 每容器**一行**偏好文档，**整文档 upsert、last-write-wins、无 revision**（偏好不是共享事实，
   用不着 fencing）。三处与 multica 同款的落点：
   ① **无行 = 空文档**（`null` 在 repo 层如实表达「没有这行」；服务面把它折成 `{}` ——
      multica `GetIssueViewPreference` 的 no-rows 分支就是返回 `{}`，不是 404）；
   ② **整文档替换**（不是 merge）：`{hidden:[…]}` 覆盖掉旧文档后 `order` 键必须消失，
      merge 会把用户明确删掉的条目复活；
   ③ 主键 `(workspace_key, owner_kind, owner_id)`：同 owner 异 workspace 是两行、异 kind 也是两行。 */

const WS = "ws-a";
const owner = (id: string, kind = "human"): WorkItemViewOwner => ({ kind, id });

function makeRepo(): { db: DatabaseSync; repo: WorkItemViewPrefsRepo } {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return { db, repo: createWorkItemViewPrefsRepo(db) };
}

test("prefs repo｜无行 ⇒ null（不是空文档）；put 后 get 读回同一文档", () => {
  const { db, repo } = makeRepo();
  assert.equal(repo.get(WS, owner("u1")), null, "repo 层如实表达「没有这行」");
  const doc = { hidden: ["builtin:all"], order: ["view:v2", "view:v1"] };
  assert.deepEqual(
    repo.put({ workspaceKey: WS, owner: owner("u1"), prefs: doc, updatedAt: 10 }),
    doc,
  );
  assert.deepEqual(repo.get(WS, owner("u1")), doc);
  db.close();
});

test("prefs repo｜整文档替换（不是 merge）：覆盖后不带旧键", () => {
  const { db, repo } = makeRepo();
  repo.put({
    workspaceKey: WS,
    owner: owner("u1"),
    prefs: { hidden: ["view:a"], order: ["view:b"] },
    updatedAt: 10,
  });
  repo.put({ workspaceKey: WS, owner: owner("u1"), prefs: { hidden: [] }, updatedAt: 20 });
  assert.deepEqual(
    repo.get(WS, owner("u1")),
    { hidden: [] },
    "merge 会把用户删掉的 order 键复活 —— 偏好文档必须是整文档替换（last-write-wins）",
  );
  const count = db.prepare("SELECT COUNT(*) AS n FROM work_item_view_prefs").get() as { n: number };
  assert.equal(count.n, 1, "同键重复 put 不得长第二行（upsert）");
  const row = db.prepare("SELECT updated_at FROM work_item_view_prefs").get() as {
    updated_at: number;
  };
  assert.equal(row.updated_at, 20, "覆盖要连 updated_at 一起写");
  db.close();
});

test("prefs repo｜主键三列各自成行：异 workspace / 异 owner_kind 互不干扰", () => {
  const { db, repo } = makeRepo();
  repo.put({ workspaceKey: WS, owner: owner("u1"), prefs: { tag: "a" }, updatedAt: 1 });
  repo.put({ workspaceKey: "ws-b", owner: owner("u1"), prefs: { tag: "b" }, updatedAt: 1 });
  repo.put({ workspaceKey: WS, owner: owner("u1", "agent"), prefs: { tag: "c" }, updatedAt: 1 });
  assert.deepEqual(repo.get(WS, owner("u1")), { tag: "a" });
  assert.deepEqual(repo.get("ws-b", owner("u1")), { tag: "b" });
  assert.deepEqual(repo.get(WS, owner("u1", "agent")), { tag: "c" });
  db.close();
});

test("prefs repo｜读回纪律：非对象文档（手改库/跨版本残留）⇒ 读回响亮抛", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE work_item_view_prefs (
    workspace_key TEXT NOT NULL, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,
    prefs TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_key, owner_kind, owner_id)
  )`);
  const repo = createWorkItemViewPrefsRepo(db);
  db.prepare(
    "INSERT INTO work_item_view_prefs (workspace_key, owner_kind, owner_id, prefs, updated_at) VALUES (?,?,?,?,1)",
  ).run(WS, "human", "u1", "[1,2]");
  assert.throws(() => repo.get(WS, owner("u1")), /不是 JSON object/, "数组不是文档");
  db.close();
});
