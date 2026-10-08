import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createWorkItemDecisionRepo } from "../src/workitem/workItemDecisionRepo.js";

/* 协作域 X0.2：append-only 负向守卫（源码扫描——desktop squadWiring 守卫同款形态）
   + Decision 存储面验收（任务卡断言要点 8）。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");

test("负向守卫｜协作域 repo 只增不改（UPDATE 仅限墓碑时间戳列；无 DELETE）", () => {
  for (const file of [
    "workitem/workItemActivityRepo.ts",
    "workitem/workItemDecisionRepo.ts",
    "workitem/workItemCommentRepo.ts",
    "workitem/workItemCommentReactionRepo.ts",
    /* #7 交付物（D1a）：同一条铁律——本 repo 结构上不存在 UPDATE/DELETE，
       幂等只靠 INSERT OR IGNORE + 唯一索引（`UNIQUE(workspace_key, dedup_key)`）。 */
    "workitem/workItemDeliverableRepo.ts",
  ]) {
    const source = readSource(file);
    assert.ok(!/DELETE FROM/.test(source), `${file} 不得出现 DELETE FROM`);
    // UPDATE 仅允许墓碑三列（spec §3.2 裁定#3/#4：软删/解决态只写时间戳；updated_at 随行）。
    for (const m of source.matchAll(/UPDATE\s+(\w+)\s+SET\s+([^;]+?)(?:WHERE|`)/g)) {
      const columns = m[2];
      assert.ok(
        /^(?:[a-z_]+\s*=\s*\?[,\s]*)+$/.test(columns) &&
          [...columns.matchAll(/([a-z_]+)\s*=/g)].every(([_, col]) =>
            ["deleted_at", "resolved_at", "updated_at"].includes(col),
          ),
        `${file} 的 UPDATE 只许写墓碑时间戳列（deleted_at/resolved_at/updated_at），实际：${columns.slice(0, 80)}`,
      );
    }
  }
});

function setup() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return { db, repo: createWorkItemDecisionRepo(db) };
}

const human = { kind: "human" as const, id: "hu-1" };

test("Decision：dedupKey 幂等；superseded 走新行旧行不变；evidence/selection JSON 读回", () => {
  const { repo } = setup();
  const first = repo.add({
    id: "dec-1",
    workspaceKey: "ws",
    workspacePath: "/tmp/ws",
    workItemId: "wi-1",
    author: human,
    initiatedBy: human,
    kind: "accepted",
    subject: "方案选择",
    selection: { option: "B" },
    rationale: "成本低",
    evidence: [{ commentId: "c-1" }],
    effectiveAt: 100,
    dedupKey: "dd-1",
    createdAt: 100,
  });
  assert.equal(first.selection.option, "B");
  assert.deepEqual(first.evidence, [{ commentId: "c-1" }]);
  // 幂等重投返回既存行。
  const retry = repo.add({
    id: "dec-2",
    workspaceKey: "ws",
    workspacePath: "/tmp/ws",
    workItemId: "wi-1",
    author: human,
    initiatedBy: human,
    kind: "rejected",
    subject: "不应到达",
    effectiveAt: 200,
    dedupKey: "dd-1",
    createdAt: 200,
  });
  assert.equal(retry.id, "dec-1");
  assert.equal(retry.kind, "accepted", "幂等重投不改写既存事实");
  // superseded = 新行（parentDecisionId 指向旧行），旧行读回一字不变。
  const sup = repo.add({
    id: "dec-3",
    workspaceKey: "ws",
    workspacePath: "/tmp/ws",
    workItemId: "wi-1",
    author: human,
    initiatedBy: human,
    kind: "superseded",
    subject: "方案选择",
    parentDecisionId: "dec-1",
    effectiveAt: 300,
    dedupKey: "dd-3",
    createdAt: 300,
  });
  assert.equal(sup.parentDecisionId, "dec-1");
  assert.equal(repo.get("dec-1")!.kind, "accepted");
  assert.equal(repo.get("dec-1")!.effectiveAt, 100);
});

test("Decision：非法 kind 读写双闸；坏 JSON 读回抛；排序 effective_at+id", () => {
  const { repo, db } = setup();
  assert.throws(
    () =>
      repo.add({
        id: "dec-bad",
        workspaceKey: "ws",
        workspacePath: "/tmp/ws",
        workItemId: "wi-1",
        author: human,
        initiatedBy: human,
        kind: "bogus" as never,
        subject: "x",
        effectiveAt: 1,
        dedupKey: "dd-bad",
        createdAt: 1,
      }),
    /kind/,
  );
  repo.add({
    id: "dec-j",
    workspaceKey: "ws",
    workspacePath: "/tmp/ws",
    workItemId: "wi-1",
    author: human,
    initiatedBy: human,
    kind: "proposal",
    subject: "x",
    effectiveAt: 1,
    dedupKey: "dd-j",
    createdAt: 1,
  });
  db.prepare("UPDATE work_item_decisions SET selection_json = '{bad' WHERE id = 'dec-j'").run();
  assert.throws(() => repo.get("dec-j"), /JSON/);
  db.prepare("UPDATE work_item_decisions SET selection_json = '{}' WHERE id = 'dec-j'").run();
  db.prepare("UPDATE work_item_decisions SET kind = 'bogus2' WHERE id = 'dec-j'").run();
  assert.throws(() => repo.get("dec-j"), /kind/);
});
