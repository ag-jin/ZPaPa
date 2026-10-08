import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { WorkItem } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";

/* 工作项存储面（`workItemRepo`）在 0018 之后的**新字段读写 + 序号生成**用例。

   两条纪律在这里落地，且都只能靠**裸读库**证明（经映射读回会把「列名写错」也显示成 undefined）：

   ① `identifier_seq` 由 **INSERT 语句内部**生成（`COALESCE((SELECT MAX(...) …), 0) + 1`），
      与 0011 Activity 序号同款理由：多窗口 Host 共用同一 tasks-index 库文件，JS 先查后插 / 内存
      counter 在跨连接并发下会重号，而重号被唯一索引拒绝时**已经晚了一步**（调用方那次创建失败）。
      本文件用**两个连接**交替插入证明序号每次取自库（内存 counter 会在这里撞唯一索引）。
   ② 新列 NULL 语义保真：没给的字段读回 `undefined`（不是 `null`、不是编造的默认值）。

   越权列（`status` / `archived_at` / `assignee_*` / `properties` / `creator_*` /
   `identifier_seq`）**没有更新面**：`updateContent` 的逐字段 SET 拼接让它们结构上写不进去
   （多带的键不参与拼接，且没有任何白名单字段时返回 false，绝不发空 UPDATE）。
   （`position` 在 R6 起是**白名单内**字段 —— 看板拖拽改序，见 `workItemPositionUpdate.test.ts`。） */

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return db;
}

function wi(over: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    workspaceIdentity: "ws",
    workspacePath: "/tmp/ws",
    title: over.id,
    body: "",
    status: "todo",
    assignee: { type: "user", id: "u1" },
    labels: [],
    properties: {},
    position: 0,
    ...over,
  } as WorkItem;
}

const rawSeq = (db: DatabaseSync, id: string): number | null =>
  (
    db.prepare("SELECT identifier_seq FROM work_items WHERE id = ?").get(id) as {
      identifier_seq: number | null;
    }
  ).identifier_seq;

test("插入返回语句内生成的序号，且与库里的值一致（1 起）", () => {
  const db = openDb();
  const repo = createWorkItemRepo(db);
  const first = repo.insert(wi({ id: "a" }));
  const second = repo.insert(wi({ id: "b" }));
  assert.equal(first, 1);
  assert.equal(second, 2);
  assert.equal(rawSeq(db, "a"), 1);
  assert.equal(rawSeq(db, "b"), 2);
  db.close();
});

test("插入序号是**每 workspace** 的：异 workspace 各自从 1 起", () => {
  const db = openDb();
  const repo = createWorkItemRepo(db);
  assert.equal(repo.insert(wi({ id: "a1", workspaceIdentity: "ws-a" })), 1);
  assert.equal(repo.insert(wi({ id: "b1", workspaceIdentity: "ws-b" })), 1);
  assert.equal(repo.insert(wi({ id: "a2", workspaceIdentity: "ws-a" })), 2);
  db.close();
});

/* 两个**真实连接**（同一文件库）交替插入 —— 模拟多窗口 Host 的同库并发：
   若序号来自「repo 构造时读一次 / 上一次读到的最大值」这类内存事实，第二条就会撞
   `UNIQUE(workspace_key, identifier_seq)`；只有「每条 INSERT 自己从库里取 MAX」才连得上号。 */
test("跨连接交替插入：序号每次从库里取（内存 counter 会在这里撞唯一索引）", () => {
  const dir = mkdtempSync(join(tmpdir(), "zpapa-0018-"));
  const path = join(dir, "tasks-index.sqlite");
  const dbA = new DatabaseSync(path);
  runTasksDatabaseMigrations(dbA);
  const dbB = new DatabaseSync(path);
  try {
    const repoA = createWorkItemRepo(dbA);
    const repoB = createWorkItemRepo(dbB);
    assert.equal(repoA.insert(wi({ id: "a-1" })), 1);
    assert.equal(repoB.insert(wi({ id: "b-1" })), 2, "第二个连接必须看见第一个连接写下的号");
    assert.equal(repoA.insert(wi({ id: "a-2" })), 3, "回到第一个连接仍是库里最大号 + 1");
    assert.deepEqual([rawSeq(dbA, "a-1"), rawSeq(dbB, "b-1"), rawSeq(dbA, "a-2")], [1, 2, 3]);
  } finally {
    dbA.close();
    dbB.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("顺序生成写在 INSERT 语句里（源码守卫：不得 JS 先查后插 / 内存 counter）", () => {
  const source = readFileSync(new URL("../src/workitem/workItemRepo.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /COALESCE\(\(SELECT MAX\(identifier_seq\) FROM work_items WHERE workspace_key = \?\), 0\) \+ 1/,
    "identifier_seq 必须由 INSERT…SELECT 语句内的 MAX+1 生成（与 0011 Activity 序号同款）",
  );
  // 反向：单独先查 MAX 再用字面量插入（TOCTOU）在源码里不得出现。
  assert.doesNotMatch(
    source,
    /SELECT COALESCE\(MAX\(identifier_seq\)/,
    "不得先查 MAX 再由 JS 传给 INSERT（跨连接并发下会重号）",
  );
});

test("新列读写：priority / 日期 / 创建人逐字落库并读回", () => {
  const db = openDb();
  const repo = createWorkItemRepo(db);
  repo.insert(
    wi({
      id: "full",
      priority: "urgent",
      startDate: "2026-10-08",
      dueDate: "2026-12-31",
      creator: { kind: "human", id: "local-user", displayName: "本机用户" },
    }),
  );
  const item = repo.get("full");
  assert.equal(item?.priority, "urgent");
  assert.equal(item?.startDate, "2026-10-08");
  assert.equal(item?.dueDate, "2026-12-31");
  assert.deepEqual(item?.creator, {
    kind: "human",
    id: "local-user",
    displayName: "本机用户",
  });
  assert.equal(item?.identifierSeq, 1);
  // 裸读：库里存的就是这两个字符串（不经任何时刻转换）。
  const raw = db
    .prepare(
      "SELECT priority, start_date, due_date, creator_kind, creator_id FROM work_items WHERE id='full'",
    )
    .get() as Record<string, string>;
  assert.deepEqual(
    { ...raw },
    {
      priority: "urgent",
      start_date: "2026-10-08",
      due_date: "2026-12-31",
      creator_kind: "human",
      creator_id: "local-user",
    },
  );
  db.close();
});

test("新列 NULL 语义保真：没给的字段读回 undefined（不编默认值、不落 'none'）", () => {
  const db = openDb();
  const repo = createWorkItemRepo(db);
  repo.insert(wi({ id: "bare" }));
  const item = repo.get("bare");
  assert.equal(item?.priority, undefined);
  assert.equal(item?.startDate, undefined);
  assert.equal(item?.dueDate, undefined);
  assert.equal(item?.creator, undefined);
  const raw = db
    .prepare(
      "SELECT priority, start_date, due_date, creator_kind, creator_id, creator_display_name FROM work_items WHERE id='bare'",
    )
    .get() as Record<string, string | null>;
  assert.deepEqual(
    { ...raw },
    {
      priority: null,
      start_date: null,
      due_date: null,
      creator_kind: null,
      creator_id: null,
      creator_display_name: null,
    },
  );
  db.close();
});

test("创建人只写 kind/id 时读回不带 displayName（不落空串）", () => {
  const db = openDb();
  const repo = createWorkItemRepo(db);
  repo.insert(wi({ id: "creator-min", creator: { kind: "agent", id: "ta-1" } }));
  assert.deepEqual(repo.get("creator-min")?.creator, { kind: "agent", id: "ta-1" });
  assert.equal(
    (
      db.prepare("SELECT creator_display_name FROM work_items WHERE id='creator-min'").get() as {
        creator_display_name: string | null;
      }
    ).creator_display_name,
    null,
  );
  db.close();
});

/* 内容编辑白名单（`updateContent`）在 0018 扩到 6 个字段，R6 再加 `position` 第 7 个
   （position 的用例在 `workItemPositionUpdate.test.ts`）。三条纪律：
   ① 新内容字段可写（含**清回未设置**：显式 `null` 是「清空」这个合法动作，不是空 patch ——
      与 `labels: []` 同款）；
   ② 越权键（status / archived_at / assignee / creator_* / identifier_seq）**不参与 SET**；
   ③ 只给越权键 ⇒ 一行都不写且返回 false（不发「不 SET 任何列」的 UPDATE）。 */
test("updateContent 新字段：priority / start_date / due_date 可写，显式 null 清回未设置", () => {
  const db = openDb();
  const repo = createWorkItemRepo(db);
  repo.insert(wi({ id: "edit", priority: "low", startDate: "2026-01-01", dueDate: "2026-02-01" }));
  assert.equal(
    repo.updateContent("edit", {
      priority: "high",
      startDate: "2026-03-03",
      dueDate: "2026-04-04",
    }),
    true,
  );
  const changed = repo.get("edit");
  assert.equal(changed?.priority, "high");
  assert.equal(changed?.startDate, "2026-03-03");
  assert.equal(changed?.dueDate, "2026-04-04");
  assert.equal(repo.updateContent("edit", { priority: null }), true);
  assert.equal(repo.get("edit")?.priority, undefined, "清回未设置（读取面 undefined）");
  assert.equal(rawSeq(db, "edit"), 1, "identifier_seq 不可改（无更新面）");
  db.close();
});

test("updateContent 越权键：不 SET 任何列且恰命中一行才算成功（含只给越权键 ⇒ false）", () => {
  const db = openDb();
  const repo = createWorkItemRepo(db);
  repo.insert(wi({ id: "guard", status: "todo", priority: "urgent" }));
  const before = {
    ...(db
      .prepare(
        "SELECT title, body, status, assignee_type, assignee_id, archived_at, position, properties, labels, priority, start_date, due_date, creator_kind, identifier_seq FROM work_items WHERE id='guard'",
      )
      .get() as Record<string, unknown>),
  };

  assert.equal(
    repo.updateContent("guard", {
      status: "done",
      archived_at: 123,
      creator_kind: "system",
      identifier_seq: 99,
      assignee_id: "u2",
    } as never),
    false,
    "只给白名单外的键 = 空 patch（不 SET 任何列）⇒ false",
  );
  assert.deepEqual(
    {
      ...(db
        .prepare(
          "SELECT title, body, status, assignee_type, assignee_id, archived_at, position, properties, labels, priority, start_date, due_date, creator_kind, identifier_seq FROM work_items WHERE id='guard'",
        )
        .get() as Record<string, unknown>),
    },
    before,
    "越权键不得写进任何列（逐字段拼接把它们忽略掉）",
  );

  assert.equal(repo.updateContent("guard", { title: "改了", status: "done" } as never), true);
  const after = repo.get("guard");
  assert.equal(after?.title, "改了");
  assert.equal(after?.status, "todo", "status 的唯一写者仍是 transition，不受内容编辑影响");
  assert.equal(after?.identifierSeq, 1);
  db.close();
});

test("updateContent 对已归档行返回 false（新字段不绕过归档语义）", () => {
  const db = openDb();
  const repo = createWorkItemRepo(db);
  repo.insert(wi({ id: "archived", archivedAt: 100 }));
  assert.equal(repo.updateContent("archived", { priority: "high" }), false);
  assert.equal(repo.get("archived"), null);
  db.close();
});
