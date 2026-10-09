import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import {
  createWorkItemCommentRepo,
  type AddWorkItemCommentInput,
} from "../src/workitem/workItemCommentRepo.js";

/* 协作域 X0.1：评论存储面的验收矩阵（任务卡断言要点 1–7）。 */

function setup() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return { db, repo: createWorkItemCommentRepo(db) };
}

const human: AddWorkItemCommentInput["author"] = { kind: "human", id: "hu-1" };

const input = (over: Partial<AddWorkItemCommentInput> = {}): AddWorkItemCommentInput => ({
  id: "c-1",
  workspaceKey: "ws",
  workspacePath: "/tmp/ws",
  workItemId: "wi-1",
  author: human,
  initiatedBy: human,
  body: "原文",
  normalizedBody: "原文",
  mentions: [],
  createdAt: 100,
  ...over,
});

test("写读往返：全字段一致（mentions JSON / inline 锚点 / sourceRun 可空）", () => {
  const { repo } = setup();
  repo.add(
    input({
      mentions: [
        { type: "agent", id: "ta-1" },
        { type: "all", id: "all" },
      ],
      command: "note",
      inline: { path: "a.ts", startLine: 3, baseRevision: "abc123" },
      sourceRun: { runId: "r-1", role: "member", agentId: "ta-9" },
      author: { kind: "agent", id: "ta-9", displayName: "队员" },
    }),
  );
  const read = repo.get("c-1")!;
  assert.equal(read.body, "原文");
  assert.equal(read.command, "note");
  assert.deepEqual(read.mentions, [
    { type: "agent", id: "ta-1" },
    { type: "all", id: "all" },
  ]);
  assert.deepEqual(read.inline, { path: "a.ts", startLine: 3, baseRevision: "abc123" });
  assert.deepEqual(read.sourceRun, { runId: "r-1", role: "member", agentId: "ta-9" });
  assert.equal(read.author.displayName, "队员");
  assert.equal(read.threadId, "c-1", "根评论 threadId = id");
  assert.equal(read.revision, 1);
  assert.equal(read.deletedAt, null);
  assert.equal(read.resolvedAt, null);
});

test("空白正文拒绝；幂等键重试返回既存行不写第二条", () => {
  const { repo, db } = setup();
  assert.throws(() => repo.add(input({ body: "   ", normalizedBody: "" })), /空白/);
  const first = repo.add(input({ clientRequestId: "req-1" }));
  const retry = repo.add(input({ id: "c-2", clientRequestId: "req-1", body: "重试" }));
  assert.equal(retry.id, first.id, "同 (workspace,author,clientRequestId) 重试返回既存行");
  const count = db.prepare("SELECT COUNT(*) AS n FROM work_item_comments").get() as { n: number };
  assert.equal(count.n, 1);
});

test("软删墓碑：只写 deleted_at，正文/作者一字不动；重复软删幂等；未知 id 响亮抛", () => {
  const { repo } = setup();
  repo.add(input());
  repo.softDelete("c-1");
  const deleted = repo.get("c-1")!;
  assert.ok(deleted.deletedAt !== null);
  assert.equal(deleted.body, "原文");
  assert.equal(deleted.author.id, "hu-1");
  const firstAt = deleted.deletedAt;
  repo.softDelete("c-1");
  assert.equal(repo.get("c-1")!.deletedAt, firstAt, "重复软删不重写时间戳");
  assert.throws(() => repo.softDelete("nope"), /无法软删/);
});

test("线程解决态：置/消各写一次；解决态不影响正文；未知 id 响亮抛", () => {
  const { repo } = setup();
  repo.add(input());
  repo.setResolved("c-1", true);
  assert.ok(repo.get("c-1")!.resolvedAt !== null);
  repo.setResolved("c-1", true); // 幂等
  repo.setResolved("c-1", false);
  assert.equal(repo.get("c-1")!.resolvedAt, null);
  assert.equal(repo.get("c-1")!.body, "原文");
  assert.throws(() => repo.setResolved("nope", true), /无法置解决态/);
});

test("读回闸：枚举外值与坏 JSON 响亮抛（readStatus 纪律）", () => {
  const { repo, db } = setup();
  repo.add(input());
  db.prepare("UPDATE work_item_comments SET command = 'bogus' WHERE id = 'c-1'").run();
  assert.throws(() => repo.get("c-1"), /command/);
  db.prepare("UPDATE work_item_comments SET command = 'none' WHERE id = 'c-1'").run();
  db.prepare("UPDATE work_item_comments SET mentions_json = '{bad' WHERE id = 'c-1'").run();
  assert.throws(() => repo.get("c-1"), /mentions_json/);
});

test("排序与隔离：同 createdAt 按 id；异己 workspace 读不回", () => {
  const { repo } = setup();
  repo.add(input({ id: "c-b", createdAt: 100 }));
  repo.add(input({ id: "c-a", createdAt: 100 }));
  repo.add(input({ id: "c-c", createdAt: 50 }));
  assert.deepEqual(
    repo.listByWorkItem("ws", "wi-1").map((c) => c.id),
    ["c-c", "c-a", "c-b"],
  );
  repo.add(input({ id: "c-x", workspaceKey: "ws2" }));
  assert.equal(repo.listByWorkItem("ws2", "wi-1").length, 1);
  assert.equal(repo.listByWorkItem("ws", "wi-1").length, 3, "异己 key 不串台");
});

test("Reaction：同 (comment,author,emoji) 幂等；不写派发相关列", () => {
  const { db, repo } = setup();
  repo.add(input());
  // 就地验证（轻实体，独立 repo 已在同文件族有专测——此处验证表存在与幂等键）。
  db.prepare(
    `INSERT OR IGNORE INTO work_item_comment_reactions (id, workspace_key, comment_id, author_kind, author_id, emoji, created_at)
     VALUES ('r-1', 'ws', 'c-1', 'human', 'hu-1', '👍', 1)`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO work_item_comment_reactions (id, workspace_key, comment_id, author_kind, author_id, emoji, created_at)
     VALUES ('r-2', 'ws', 'c-1', 'human', 'hu-1', '👍', 2)`,
  ).run();
  const count = db.prepare("SELECT COUNT(*) AS n FROM work_item_comment_reactions").get() as {
    n: number;
  };
  assert.equal(count.n, 1, "同键重投不产生第二行");
  const cols = (
    db.prepare("PRAGMA table_info(work_item_comment_reactions)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  assert.ok(!cols.some((c) => c.includes("dispatch")), "回应表无派发列（永不触发，§4.4）");
});

test("G7 扫描读面：listByWorkspace 覆盖全工作项、按 created_at/id 定序、workspace 隔离", () => {
  /* §8.4-3 半途事务扫描要按 workspace 枚举「已落库的评论事实」做反连接，
     故独立于 listByWorkItem 加一条读面；软删行照样读出——它是已发生的事实，
     扫描以「有没有 comment_created Activity」判定，不由这里替扫描先过滤。 */
  const { repo } = setup();
  repo.add(input({ id: "c-b", createdAt: 200, workItemId: "wi-2" }));
  repo.add(input({ id: "c-a", createdAt: 100, workItemId: "wi-1" }));
  repo.add(input({ id: "c-tie", createdAt: 200, workItemId: "wi-1" }));
  repo.add(input({ id: "c-other", workspaceKey: "ws2" }));
  repo.softDelete("c-a");

  assert.deepEqual(
    repo.listByWorkspace("ws").map((c) => c.id),
    ["c-a", "c-b", "c-tie"],
    "同 created_at 以 id 定序（与 listByWorkItem/listByThread 同一 ORDER），软删行仍在",
  );
  assert.deepEqual(
    repo.listByWorkspace("ws2").map((c) => c.id),
    ["c-other"],
  );
  assert.deepEqual(repo.listByWorkspace("ws-absent"), []);
});
