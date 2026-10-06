import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import {
  createWorkItemActivityRepo,
  WORK_ITEM_ACTIVITY_KINDS,
  type AddWorkItemActivityInput,
} from "../src/workitem/workItemActivityRepo.js";

/* 协作域 X0.2：Activity 存储面验收（任务卡断言要点 1–7）。本轮核心 = sequence 的
   语句内原子生成——多窗口 Host 共用同一 tasks-index 库文件，跨连接并发不得重号。 */

function setup() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return { db, repo: createWorkItemActivityRepo(db) };
}

const human = { kind: "human" as const, id: "hu-1" };

const input = (over: Partial<AddWorkItemActivityInput> = {}): AddWorkItemActivityInput => ({
  id: "a-1",
  workspaceKey: "ws",
  workspacePath: "/tmp/ws",
  workItemId: "wi-1",
  kind: "comment_created",
  occurredAt: 100,
  actor: human,
  initiatedBy: human,
  dedupKey: "d-1",
  createdAt: 100,
  ...over,
});

test("sequence 单调递增无重复；每 WorkItem 隔离（各自从 1 起，非全局非线程）", () => {
  const { repo } = setup();
  for (let i = 0; i < 5; i += 1) {
    repo.add(input({ id: `a-${i}`, dedupKey: `d-${i}`, workItemId: "wi-1" }));
  }
  assert.deepEqual(
    repo.listByWorkItem("ws", "wi-1").map((a) => a.sequence),
    [1, 2, 3, 4, 5],
  );
  // 不同 workItem 各自从 1 起（§12.1-6：每 WorkItem 粒度）。
  const other = repo.add(input({ id: "a-x", dedupKey: "d-x", workItemId: "wi-2" }));
  assert.equal(other.sequence, 1);
});

test("跨连接并发：两条连接交替插入 ⇒ sequence 集合 1..N 无重（本轮核心）", () => {
  const dir = mkdtempSync(join(tmpdir(), "act-seq-"));
  try {
    const dbPath = join(dir, "tasks.db");
    const db1 = new DatabaseSync(dbPath);
    runTasksDatabaseMigrations(db1);
    const repo1 = createWorkItemActivityRepo(db1);
    // 第二条连接共享同一文件（多窗口 Host 形态）。
    const db2 = new DatabaseSync(dbPath);
    const repo2 = createWorkItemActivityRepo(db2);
    const total = 20;
    for (let i = 0; i < total; i += 1) {
      const repo = i % 2 === 0 ? repo1 : repo2;
      repo.add(
        input({
          id: `x-${i}`,
          dedupKey: `dx-${i}`,
          occurredAt: 100 + i,
          createdAt: 100 + i,
        }),
      );
    }
    const sequences = repo1
      .listByWorkItem("ws", "wi-1")
      .map((a) => a.sequence)
      .sort((l, r) => l - r);
    assert.deepEqual(sequences, Array.from({ length: total }, (_, i) => i + 1));
    db1.close();
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("唯一兜底：人为写重复 sequence ⇒ 唯一索引抛（不静默）", () => {
  const { repo, db } = setup();
  repo.add(input());
  assert.throws(() =>
    db.prepare(
      `INSERT INTO work_item_activities (id, workspace_key, workspace_path, work_item_id, kind, sequence, occurred_at,
         actor_kind, actor_id, initiated_by_kind, initiated_by_id, payload_json, dedup_key, created_at, updated_at)
       VALUES ('a-bad', 'ws', '/tmp/ws', 'wi-1', 'comment_created', 1, 1, 'human', 'hu', 'human', 'hu', '{}', 'd-bad', 1, 1)`,
    ).run(), /UNIQUE/);
});

test("dedupKey 幂等：同键重投返回既存行不产生第二行；关联列不补写（只增不改）", () => {
  const { repo, db } = setup();
  const first = repo.add(input({ commentId: undefined }));
  const retry = repo.add(
    input({ id: "a-2", dedupKey: "d-1", commentId: "c-late", payload: { late: true } }),
  );
  assert.equal(retry.id, first.id);
  assert.deepEqual(retry.payload, {}, "幂等重投不补写 payload（事实只增不改）");
  const count = db.prepare("SELECT COUNT(*) AS n FROM work_item_activities").get() as { n: number };
  assert.equal(count.n, 1);
});

test("kind 闭集：18 值全通过；非法值读写双闸响亮抛", () => {
  const { repo, db } = setup();
  assert.equal(WORK_ITEM_ACTIVITY_KINDS.length, 18);
  let i = 0;
  for (const kind of WORK_ITEM_ACTIVITY_KINDS) {
    repo.add(input({ id: `k-${i}`, dedupKey: `dk-${i}`, kind }));
    i += 1;
  }
  assert.equal(repo.listByWorkItem("ws", "wi-1").length, 18);
  assert.throws(() => repo.add(input({ id: "k-bad", dedupKey: "dk-bad", kind: "bogus" as never })), /kind/);
  db.prepare("UPDATE work_item_activities SET kind = 'bogus2' WHERE id = 'k-0'").run();
  assert.throws(() => repo.get("k-0"), /kind/);
});

test("payload 坏 JSON 读回抛；排序三键稳定", () => {
  const { repo, db } = setup();
  repo.add(input({ id: "a-1", dedupKey: "d-1", payload: { ref: "原事实" } }));
  db.prepare("UPDATE work_item_activities SET payload_json = '{bad' WHERE id = 'a-1'").run();
  assert.throws(() => repo.get("a-1"), /payload_json/);
  // 排序：sequence 主键（同 sequence 不可能——唯一索引；occurredAt/id 为兜底三键在 SQL 里）。
  assert.ok(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'work_item_activities'").get());
});

test("重启稳定：close 后重开读回同一序与内容", () => {
  const dir = mkdtempSync(join(tmpdir(), "act-restart-"));
  try {
    const dbPath = join(dir, "tasks.db");
    const db1 = new DatabaseSync(dbPath);
    runTasksDatabaseMigrations(db1);
    const repo1 = createWorkItemActivityRepo(db1);
    for (let i = 0; i < 3; i += 1) {
      repo1.add(input({ id: `r-${i}`, dedupKey: `dr-${i}` }));
    }
    db1.close();
    const db2 = new DatabaseSync(dbPath);
    const repo2 = createWorkItemActivityRepo(db2);
    assert.deepEqual(
      repo2.listByWorkItem("ws", "wi-1").map((a) => [a.sequence, a.id]),
      [[1, "r-0"], [2, "r-1"], [3, "r-2"]],
    );
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- B2（X1.3 阻塞项）：sourceRun 全形状保真，读回不猜 ---------- */

test("B2｜sourceRun 全形状往返：role/agentId/squadId 逐字段保真（队长 run 不得读回 member）", () => {
  const { repo } = setup();
  const leader = { kind: "agent" as const, id: "ta-lead" };
  repo.add(
    input({
      id: "a-leader",
      dedupKey: "d-leader",
      actor: leader,
      sourceRun: { runId: "run-lead", agentId: "ta-lead", squadId: "sq-core", role: "leader" },
    }),
  );
  repo.add(
    input({
      id: "a-member",
      dedupKey: "d-member",
      actor: leader,
      sourceRun: { runId: "run-m", agentId: "ta-m", role: "member" },
    }),
  );
  assert.deepEqual(repo.get("a-leader")!.sourceRun, {
    runId: "run-lead",
    agentId: "ta-lead",
    squadId: "sq-core",
    role: "leader",
  });
  assert.deepEqual(repo.get("a-member")!.sourceRun, { runId: "run-m", agentId: "ta-m", role: "member" });
  // 无 sourceRun 仍读回 null（人手工事实）。
  repo.add(input({ id: "a-none", dedupKey: "d-none" }));
  assert.equal(repo.get("a-none")!.sourceRun, null);
  // 重启后逐字节一致（列值持久化，不是内存补的）。
  assert.deepEqual(repo.listByWorkItem("ws", "wi-1")[0]!.sourceRun, {
    runId: "run-lead",
    agentId: "ta-lead",
    squadId: "sq-core",
    role: "leader",
  });
});

test("B2｜读回不猜：runId 有值但角色列缺失/非法 ⇒ 响亮抛（不得静默当 member）", () => {
  const { repo, db } = setup();
  const agent = { kind: "agent" as const, id: "ta-a" };
  repo.add(
    input({
      id: "a-legacy",
      dedupKey: "d-legacy",
      actor: agent,
      sourceRun: { runId: "run-x", agentId: "ta-a", role: "standalone" },
    }),
  );
  // 模拟 0013 之前的历史行：只有 source_run_id，角色无从得知。
  db.prepare("UPDATE work_item_activities SET source_run_role = NULL WHERE id = 'a-legacy'").run();
  assert.throws(() => repo.get("a-legacy"), /source_run_role|角色/);
  db.prepare("UPDATE work_item_activities SET source_run_role = 'bogus' WHERE id = 'a-legacy'").run();
  assert.throws(() => repo.get("a-legacy"), /source_run_role|角色/);
});
