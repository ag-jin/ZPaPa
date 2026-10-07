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

/* ---------- X2.1：host 派发推进的回写口（settleIfUnsettled） ----------

   receipt 首写即事实（insertIfAbsent 幂等），但「评论请求是否真的派出去」要在 host 执行后才落定：
   pending/deferred 是**未收敛**（等 host 执行 / 等义务重放），其余五值是终局。
   回写口必须**条件更新**（只认领未收敛的行）：双向保护 ——
   ① 已终局的行不得被迟到的重投覆写（首写结论是事实）；② 两路并发（在线入口 + 义务重放）
      只有一个赢家（changes===1 即认领），输家不改写。 */

test("X2.1 回写：pending/deferred 可收敛；终局 outcome 不得被覆写", () => {
  const { repo, db } = setup();
  repo.insertIfAbsent(receipt({ outcome: "pending" }));
  assert.equal(
    repo.settleIfUnsettled({
      dispatchKey: "cd-1",
      outcome: "opened",
      detail: { runId: "cd-1" },
      updatedAt: 200,
    }),
    true,
    "pending 可收敛（本次认领）",
  );
  const settled = repo.get("cd-1")!;
  assert.equal(settled.outcome, "opened");
  assert.deepEqual(settled.detail, { runId: "cd-1" }, "detail 回写为该次执行的落点");
  assert.equal(settled.updatedAt, 200);
  assert.equal(settled.createdAt, 100, "created_at 不动（首写时间戳是事实）");
  // 已终局 ⇒ 迟到的第二路不得覆写（返回 false，调用方据此留痕）。
  assert.equal(
    repo.settleIfUnsettled({
      dispatchKey: "cd-1",
      outcome: "failed",
      detail: { late: true },
      updatedAt: 300,
    }),
    false,
    "opened 是终局：重投/并发第二路不得把它改写成 failed",
  );
  assert.equal(repo.get("cd-1")!.outcome, "opened");
  // deferred 也是未收敛（义务重放后回写）。
  repo.insertIfAbsent(receipt({ dispatchKey: "cd-2", outcome: "deferred" }));
  assert.equal(
    repo.settleIfUnsettled({ dispatchKey: "cd-2", outcome: "queued", updatedAt: 201 }),
    true,
  );
  // 未命中的 dispatchKey ⇒ false（不静默造行）。
  assert.equal(
    repo.settleIfUnsettled({ dispatchKey: "不存在", outcome: "opened", updatedAt: 1 }),
    false,
  );
  const count = db.prepare("SELECT COUNT(*) AS n FROM comment_dispatch_receipts").get() as {
    n: number;
  };
  assert.equal(count.n, 2, "回写只改行，绝不新增/删除");
});

test("X2.1 回写：闭集外 outcome 拒绝落盘（写路径闸同款）", () => {
  const { repo } = setup();
  repo.insertIfAbsent(receipt());
  assert.throws(
    () => repo.settleIfUnsettled({ dispatchKey: "cd-1", outcome: "done" as never, updatedAt: 2 }),
    /outcome.*拒绝写入/,
  );
  assert.equal(repo.get("cd-1")!.outcome, "pending", "非法值绝不落盘（原行保持）");
});
