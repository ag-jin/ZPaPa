import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import {
  createSquadDeferredDispatchRepo,
  type SquadDeferredDispatchRecord,
} from "../src/workitem/squadDeferredDispatchRepo.js";

/* C2：deferred 重放义务表（S6 §12.1-2「运行中不排队不注入，登记完成后重放义务」的载体）。
   义务 ≠ 排队：排队等容量；义务等**目标对离开活跃集**（produced/rejected 仍占树）。
   资格判据不同故分表——混进队列表会被统一当 queued 推进，开出撞活分支的树。 */

function setup() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return { db, repo: createSquadDeferredDispatchRepo(db) };
}

const obligation = (over: Partial<SquadDeferredDispatchRecord> = {}): SquadDeferredDispatchRecord => ({
  runId: "obl-1",
  workspaceKey: "ws",
  workItemId: "wi-1",
  agentId: "ta-a",
  dispatchCause: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

test("原子登记：首条 true；同 (workspace,workItem,agent) 第二条 false（并入，不另起行）", () => {
  const { repo, db } = setup();
  assert.equal(repo.insertIfAbsent(obligation({ runId: "obl-1" })), true);
  assert.equal(
    repo.insertIfAbsent(obligation({ runId: "obl-2" })),
    false,
    "同目标已有义务 ⇒ 并入既存行（义务键唯一，不产生第二行）",
  );
  const rows = db
    .prepare("SELECT run_id FROM squad_run_deferred_dispatches")
    .all() as Array<{ run_id: string }>;
  assert.deepEqual(rows.map((r) => r.run_id), ["obl-1"]);
  // 不同目标各自成行。
  assert.equal(repo.insertIfAbsent(obligation({ runId: "obl-3", workItemId: "wi-2" })), true);
});

test("find / list：按键取、按 workspace 列（台账序）", () => {
  const { repo } = setup();
  repo.insertIfAbsent(obligation({ runId: "obl-1", workItemId: "wi-1", createdAt: 5 }));
  repo.insertIfAbsent(obligation({ runId: "obl-2", workItemId: "wi-2", createdAt: 9 }));
  assert.equal(repo.find("ws", "wi-1", "ta-a")!.runId, "obl-1");
  assert.equal(repo.find("ws", "wi-x", "ta-a"), null);
  assert.deepEqual(
    repo.list("ws").map((r) => r.runId),
    ["obl-1", "obl-2"],
  );
});

test("fulfill 删除义务；未命中响亮抛（静默 no-op 会让重放义务凭空滞留）", () => {
  const { repo } = setup();
  repo.insertIfAbsent(obligation({ runId: "obl-1" }));
  repo.fulfill("ws", "wi-1", "ta-a");
  assert.equal(repo.find("ws", "wi-1", "ta-a"), null);
  assert.throws(() => repo.fulfill("ws", "wi-1", "ta-a"), /义务/);
});

test("跨重启持久：义务事实不靠内存", () => {
  const dir = mkdtempSync(join(tmpdir(), "squad-deferred-"));
  try {
    const dbPath = join(dir, "tasks.db");
    const db = new DatabaseSync(dbPath);
    runTasksDatabaseMigrations(db);
    createSquadDeferredDispatchRepo(db).insertIfAbsent(
      obligation({ runId: "obl-1", dispatchCause: "leader_tool" }),
    );
    db.close();
    const reopened = new DatabaseSync(dbPath);
    const found = createSquadDeferredDispatchRepo(reopened).find("ws", "wi-1", "ta-a");
    assert.equal(found!.runId, "obl-1");
    assert.equal(found!.dispatchCause, "leader_tool");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
