import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import {
  createCommentDispatchReceiptRepo,
  type AddCommentDispatchReceiptInput,
} from "../src/workitem/commentDispatchReceiptRepo.js";

/* 协作域 X1.2：评论派发 receipt 存储面（0012 迁移）。
   dispatchKey 是请求身份（§8.1 独立构造，不复用 eventKey 拼接格式）；同键重投不写第二条。 */

function setup() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return { db, repo: createCommentDispatchReceiptRepo(db) };
}

const receipt = (
  over: Partial<AddCommentDispatchReceiptInput> = {},
): AddCommentDispatchReceiptInput => ({
  dispatchKey: "cd-1",
  workspaceKey: "ws",
  workItemId: "wi-1",
  targetAgentId: "ta-a",
  commentId: "c-1",
  threadId: "c-1",
  source: "mention_agent",
  outcome: "pending",
  detail: { triggerSource: "mention_agent" },
  createdAt: 100,
  ...over,
});

test("写读往返：全字段一致；detail 缺省为空对象；listByWorkItem 按 workspace 隔离", () => {
  const { repo } = setup();
  repo.insertIfAbsent(receipt({ attemptCount: 3 }));
  repo.insertIfAbsent(receipt({ dispatchKey: "cd-2", detail: undefined }));
  const read = repo.get("cd-1");
  assert.ok(read);
  assert.equal(read.workspaceKey, "ws");
  assert.equal(read.workItemId, "wi-1");
  assert.equal(read.targetAgentId, "ta-a");
  assert.equal(read.commentId, "c-1");
  assert.equal(read.threadId, "c-1");
  assert.equal(read.source, "mention_agent");
  assert.equal(read.outcome, "pending");
  assert.deepEqual(read.detail, { triggerSource: "mention_agent" });
  assert.equal(read.attemptCount, 3);
  assert.equal(read.createdAt, 100);
  assert.equal(read.updatedAt, 100);
  assert.deepEqual(repo.get("cd-2")!.detail, {});
  assert.deepEqual(
    repo.listByWorkItem("ws", "wi-1").map((r) => r.dispatchKey),
    ["cd-1", "cd-2"],
  );
  assert.deepEqual(repo.listByWorkItem("ws2", "wi-1"), [], "异己 workspace 不串台");
  assert.equal(repo.get("不存在"), null);
});

test("receipt 幂等：同 dispatchKey 重投返回既存行，不写第二条、不覆盖既存 outcome", () => {
  const { repo, db } = setup();
  const first = repo.insertIfAbsent(receipt({ outcome: "pending", createdAt: 100 }));
  const retry = repo.insertIfAbsent(
    receipt({ outcome: "coalesced", attemptCount: 7, createdAt: 999, detail: { late: true } }),
  );
  assert.equal(retry.dispatchKey, first.dispatchKey);
  assert.equal(retry.outcome, "pending", "首写即事实：重投不得改写队列状态窗的结论");
  assert.equal(retry.createdAt, 100);
  assert.deepEqual(retry.detail, { triggerSource: "mention_agent" });
  const count = db.prepare("SELECT COUNT(*) AS n FROM comment_dispatch_receipts").get() as {
    n: number;
  };
  assert.equal(count.n, 1);
});

test("读回闸：枚举外 outcome/source 与坏 detail JSON 响亮抛（readStatus 纪律）", () => {
  const { repo, db } = setup();
  repo.insertIfAbsent(receipt());
  db.prepare(
    "UPDATE comment_dispatch_receipts SET outcome = 'bogus' WHERE dispatch_key = 'cd-1'",
  ).run();
  assert.throws(() => repo.get("cd-1"), /outcome/);
  db.prepare(
    "UPDATE comment_dispatch_receipts SET outcome = 'pending' WHERE dispatch_key = 'cd-1'",
  ).run();
  db.prepare(
    "UPDATE comment_dispatch_receipts SET source = 'bogus' WHERE dispatch_key = 'cd-1'",
  ).run();
  assert.throws(() => repo.get("cd-1"), /source/);
  db.prepare(
    "UPDATE comment_dispatch_receipts SET source = 'mention_agent' WHERE dispatch_key = 'cd-1'",
  ).run();
  db.prepare(
    "UPDATE comment_dispatch_receipts SET detail_json = '{bad' WHERE dispatch_key = 'cd-1'",
  ).run();
  assert.throws(() => repo.get("cd-1"), /detail_json/);
});

test("写路径闸：闭集外 outcome/source 拒绝落盘", () => {
  const { repo, db } = setup();
  assert.throws(
    () => repo.insertIfAbsent(receipt({ outcome: "done" as never })),
    /outcome.*拒绝写入/,
  );
  assert.throws(
    () => repo.insertIfAbsent(receipt({ source: "guess" as never })),
    /source.*拒绝写入/,
  );
  const count = db.prepare("SELECT COUNT(*) AS n FROM comment_dispatch_receipts").get() as {
    n: number;
  };
  assert.equal(count.n, 0, "非法值绝不落盘");
});
