import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import {
  createWorkItemViewRepo,
  type WorkItemViewInsert,
  type WorkItemViewOwner,
  type WorkItemViewRepo,
} from "../src/workitem/workItemViewRepo.js";

/* `work_item_views` 存储面（R6a 切片 2）的直接用例。

   三条本文件承重的纪律（逐条对应 multica 先例，见
   reports/2026-10-09-saved-views-multica-evidence.md §1/§2）：
   ① **读权谓词在 SQL 里**（`owner` 分支 OR `visibility='workspace'` 分支）：
      owner 谓词的两列必须一起比（`owner_kind` + `owner_id`），且整个 OR 必须被括号圈住 ——
      `workspace_key` 与 OR 的优先级写错时，**别的 workspace 的共享视图会被读出来**，且不报错。
   ② **revision 是 CAS**：`UPDATE … WHERE id=? AND workspace_key=? AND revision=?` 恰命中一行才算成功；
      未命中（含并发改动）⇒ 返回 null 且**一字不改**（先读后写在并发下会把「别人刚改的」盖掉）。
   ③ **query/display 是不透明 JSON 文档**：原样存取（不解释 facet）、坏形状读回**响亮抛**
      （手改库造出的数组若被静默交出去，界面会按「视图定义」渲染一份非定义的东西）。 */

const WS = "ws-a";

const owner = (id: string, kind = "human"): WorkItemViewOwner => ({ kind, id });

function makeRepo(): { db: DatabaseSync; repo: WorkItemViewRepo } {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return { db, repo: createWorkItemViewRepo(db) };
}

let seq = 0;
function insert(repo: WorkItemViewRepo, over: Partial<WorkItemViewInsert> = {}): string {
  const id = over.id ?? `view-${++seq}`;
  repo.insert({
    id,
    workspaceKey: WS,
    owner: owner("local-user"),
    name: "我的视图",
    scopeType: "workspace",
    visibility: "private",
    definitionVersion: 1,
    query: { statusFilters: ["todo"] },
    display: { viewMode: "board" },
    createdAt: 100,
    updatedAt: 100,
    ...over,
  });
  return id;
}

test("repo｜insert + get：逐字段读回；query/display 原样 round-trip；revision 从 1 起", () => {
  const { db, repo } = makeRepo();
  const id = insert(repo, {
    query: { statusFilters: ["todo", "in_progress"], priorityFilters: [] },
    display: { viewMode: "table", columns: ["title", "priority"] },
    name: "高优待办",
    scopeType: "my",
    visibility: "private",
  });

  const view = repo.get(WS, id);
  assert.ok(view);
  assert.deepEqual(view, {
    id,
    workspaceKey: WS,
    owner: owner("local-user"),
    name: "高优待办",
    scopeType: "my",
    visibility: "private",
    definitionVersion: 1,
    query: { statusFilters: ["todo", "in_progress"], priorityFilters: [] },
    display: { viewMode: "table", columns: ["title", "priority"] },
    revision: 1,
    createdAt: 100,
    updatedAt: 100,
  });
  db.close();
});

test("repo｜get 是 workspace 隔离的：同 id 异 workspace 读不到（SQL 层租户守卫）", () => {
  const { db, repo } = makeRepo();
  const id = insert(repo);
  assert.ok(repo.get(WS, id));
  assert.equal(repo.get("ws-b", id), null, "跨 workspace 读同 id 必须落空（不靠调用方比对）");
  db.close();
});

test("repo｜listVisible：owner 全见、shared 全见、他人 private 不见、异 workspace shared 不见", () => {
  const { db, repo } = makeRepo();
  const me = owner("local-user");
  const other = owner("someone-else");
  const a = insert(repo, { name: "我的私有", visibility: "private", createdAt: 1 });
  const b = insert(repo, {
    name: "别人的共享",
    owner: other,
    visibility: "workspace",
    createdAt: 2,
  });
  const c = insert(repo, { name: "我的共享", visibility: "workspace", createdAt: 3 });
  const hidden = insert(repo, { name: "别人的私有", owner: other, visibility: "private" });
  /* 异 workspace 的行**必须是 shared**：这正是读权谓词括号写错时会漏出来的那一类
     （`workspace_key` 与 OR 的优先级一错，别的 workspace 的共享视图就会被读出来）——
     若这里用 private，变异跑红不了，用例就成了摆设。 */
  const foreign = insert(repo, {
    name: "异 workspace 共享",
    workspaceKey: "ws-b",
    visibility: "workspace",
  });

  const listed = repo.listVisible(WS, me);
  assert.deepEqual(
    listed.map((view) => view.id),
    [a, b, c],
    "读权谓词 = (owner 两列都比) OR (visibility='workspace')，且整体被 workspace_key 圈住",
  );
  assert.ok(
    !listed.some((view) => view.id === hidden),
    "他人 private 不得出现（存在性也不许泄露）",
  );
  assert.ok(!listed.some((view) => view.id === foreign), "异 workspace 的 shared 不得出现");
  db.close();
});

test("repo｜listVisible 排序确定（created_at ASC, id ASC）且上限 200（multica LIMIT 200）", () => {
  const { db, repo } = makeRepo();
  const me = owner("local-user");
  // 同刻并列：排序必须由 id 做 tie-break，否则每次读的次序都可能不同（呈现像「有人在动」）。
  insert(repo, { id: "v-b", createdAt: 5 });
  insert(repo, { id: "v-a", createdAt: 5 });
  insert(repo, { id: "v-c", createdAt: 4 });
  assert.deepEqual(
    repo.listVisible(WS, me).map((view) => view.id),
    ["v-c", "v-a", "v-b"],
  );

  // 上限：直接 SQL 灌到 205 条（同一 owner + shared 混合），多出的一律不进结果。
  const raw = db.prepare(
    `INSERT INTO work_item_views (id, workspace_key, owner_kind, owner_id, name, scope_type,
       visibility, definition_version, query, display, revision, created_at, updated_at)
     VALUES (?, ?, 'human', 'bulk', '批量', 'workspace', ?, 1, '{}', '{}', 1, ?, ?)`,
  );
  for (let i = 0; i < 205; i++)
    raw.run(`bulk-${String(i).padStart(3, "0")}`, WS, i % 2 === 0 ? "workspace" : "private", i, i);
  const capped = repo.listVisible(WS, owner("bulk"));
  assert.equal(capped.length, 200, "列表硬上限 200（滥用兜底，不是分页）");
  assert.equal(capped[0]?.id, "bulk-000", "取的是最旧的 200 条（ORDER BY created_at ASC）");
  assert.equal(capped.at(-1)?.id, "bulk-199");
  db.close();
});

test("repo｜countByOwner：只数本 workspace 本人的行（shared 也算他的；他人/异 workspace 不算）", () => {
  const { db, repo } = makeRepo();
  const me = owner("local-user");
  insert(repo, { visibility: "private" });
  insert(repo, { visibility: "workspace" });
  insert(repo, { owner: owner("someone-else"), visibility: "workspace" });
  insert(repo, { workspaceKey: "ws-b" });
  insert(repo, { owner: owner("local-user", "agent") });
  assert.equal(repo.countByOwner(WS, me), 2, "配额按 (workspace, owner) 计，不看 visibility");
  assert.equal(repo.countByOwner(WS, owner("local-user", "agent")), 1, "owner_kind 同列参与计数");
  db.close();
});

test("repo｜update：CAS 命中 ⇒ 字段改写 + revision+1；未命中 ⇒ null 且一字不改", () => {
  const { db, repo } = makeRepo();
  const id = insert(repo, { name: "旧名" });

  const updated = repo.update({
    workspaceKey: WS,
    id,
    expectedRevision: 1,
    patch: { name: "新名", visibility: "workspace", query: { statusFilters: ["done"] } },
    updatedAt: 555,
  });
  assert.ok(updated);
  assert.deepEqual(
    { ...updated, query: updated.query },
    {
      id,
      workspaceKey: WS,
      owner: owner("local-user"),
      name: "新名",
      scopeType: "workspace",
      visibility: "workspace",
      definitionVersion: 1,
      query: { statusFilters: ["done"] },
      display: { viewMode: "board" },
      revision: 2,
      createdAt: 100,
      updatedAt: 555,
    },
    "命中：给的字段改写、没给的字段原样（display 未给 ⇒ 保持）、revision+1",
  );

  const missed = repo.update({
    workspaceKey: WS,
    id,
    expectedRevision: 1,
    patch: { name: "过期写" },
    updatedAt: 999,
  });
  assert.equal(missed, null, "旧 revision 再写 ⇒ 未命中（409 的存储半边）");
  assert.equal(repo.get(WS, id)?.name, "新名", "未命中必须一字不改（先读后写会盖掉别人刚改的）");
  assert.equal(repo.get(WS, id)?.revision, 2, "未命中不得 bump revision");
  assert.equal(
    repo.update({ workspaceKey: WS, id, expectedRevision: 2, patch: {}, updatedAt: 1 }),
    null,
    "空 patch 未命中（不执行「不 SET 任何列」的空写）",
  );
  db.close();
});

test("repo｜update 是 workspace 隔离的：异 workspace 的 id 改不动", () => {
  const { db, repo } = makeRepo();
  const id = insert(repo);
  assert.equal(
    repo.update({
      workspaceKey: "ws-b",
      id,
      expectedRevision: 1,
      patch: { name: "越权改" },
      updatedAt: 1,
    }),
    null,
  );
  assert.equal(repo.get(WS, id)?.name, "我的视图");
  db.close();
});

test("repo｜remove：命中删掉（get 落空）、再删未命中 false", () => {
  const { db, repo } = makeRepo();
  const id = insert(repo);
  assert.equal(repo.remove(WS, id), true);
  assert.equal(repo.get(WS, id), null);
  assert.equal(repo.remove(WS, id), false, "恰命中一行才算删除（静默 no-op 会让界面以为删掉了）");
  assert.equal(repo.remove("ws-b", id), false, "异 workspace 删不掉");
  db.close();
});

test("repo｜读回纪律：非对象定义（手改库/跨版本残留造出的形状）⇒ 读回响亮抛，不把数组当视图定义", () => {
  /* 造一个**没有 CHECK 的**工作项视图表来模拟「手改库 / 跨版本残留」：DDL 里的 CHECK 是写入侧
     的最后一道，读回侧仍要有自己的判据 —— 直接 SELECT 出来交给界面会渲染一份非定义的东西。 */
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE work_item_views (
    id TEXT PRIMARY KEY, workspace_key TEXT NOT NULL, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,
    name TEXT NOT NULL, scope_type TEXT NOT NULL, scope_id TEXT, scope_variant TEXT,
    visibility TEXT NOT NULL DEFAULT 'private', definition_version INTEGER NOT NULL DEFAULT 1,
    query TEXT NOT NULL, display TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  const repo = createWorkItemViewRepo(db);
  const raw = db.prepare(
    `INSERT INTO work_item_views (id, workspace_key, owner_kind, owner_id, name, scope_type,
       visibility, definition_version, query, display, revision, created_at, updated_at)
     VALUES (?, ?, 'human', 'u', '视图', 'workspace', 'private', 1, ?, ?, 1, 1, 1)`,
  );
  raw.run("bad-query", WS, "[1,2]", "{}");
  raw.run("bad-display", WS, "{}", '"scalar"');
  assert.throws(
    () => repo.get(WS, "bad-query"),
    /定义/,
    "query 是数组 ⇒ 读回响亮抛（不得静默把它交出去）",
  );
  assert.throws(() => repo.get(WS, "bad-display"), /定义/, "display 是标量 ⇒ 读回响亮抛");
  assert.throws(() => repo.listVisible(WS, owner("u")), /定义/, "列表读回同一条纪律");
  db.close();
});

test("repo｜DB CHECK 是存储层最后一道：my ⇒ private 由 repo 写路径之外也拦得住（裸 SQL 直写）", () => {
  const { db } = makeRepo();
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO work_item_views (id, workspace_key, owner_kind, owner_id, name, scope_type,
             visibility, definition_version, query, display, revision, created_at, updated_at)
           VALUES ('x', ?, 'human', 'u', '视图', 'my', 'workspace', 1, '{}', '{}', 1, 1, 1)`,
        )
        .run(WS),
    /CHECK/i,
    "绕过 repo 的裸写同样被 DB CHECK 拒绝（内存 CHECK 是唯一不能被绕过的那道）",
  );
  db.close();
});
