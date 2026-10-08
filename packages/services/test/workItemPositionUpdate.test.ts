import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import { createSquadOrchestrator } from "../src/workitem/squadOrchestrator.js";
import { archiveSquadAndTransfer, createSquadRuntime } from "../src/workitem/squadRuntime.js";
import {
  createSquadRuntimeService,
  type ISquadRuntimeService,
  type SquadWorkspaceTarget,
} from "../src/workitem/squadRuntimeService.js";
import { createWorkItemRepo, type WorkItemRepo } from "../src/workitem/workItemRepo.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* 工作项**手工排序位**（`position`，R6 看板拖拽改序的服务面半边：T-P2-R6s）的写入用例。

   为什么 position 能进内容白名单：看板拖拽要落的是「用户把这个条放到这个次序」这一条事实，
   而 `manual` 排序的次序判据就是 `position → created_at → id`（repo 三条 list 语句同款）。
   没有可写的 position，拖拽就只能是一次界面内的临时重排 —— 刷新即回原样。

   两条纪律（与 0018 三个内容字段同款，逐条可验收）：
   ① **REAL 原样**：`position` 是 `REAL` 列，小数与负数逐字节落库读回，**不做**整数化
      （整数化会把「A 与 B 之间」的插入点压成并列，拖拽后的次序就不再是用户看到的次序）；
   ② **patch 子集语义**：没给的字段（含 position）一律不动现值 —— 只给 position 的 patch
      也是合法写（不是空 patch），`position: 0` 同样是一个**给过的值**（不得按 falsy 跳过）。

   断言读**库里的原始列**（不经 repo 的映射）：映射层写错列名也会显示成一个看似正确的值。 */

const target = (identity: string): SquadWorkspaceTarget => ({ path: `/tmp/${identity}`, identity });
const WS = target("ws");

const RAW_POSITION = "SELECT position FROM work_items WHERE id = ?";

function makeDb(): { db: DatabaseSync; repo: WorkItemRepo } {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return { db, repo: createWorkItemRepo(db) };
}

const insertRow = (repo: WorkItemRepo, id: string, over: Record<string, unknown> = {}): void => {
  repo.insert({
    id,
    workspaceIdentity: "ws",
    workspacePath: "/tmp/ws",
    title: "原标题",
    body: "原正文",
    status: "todo",
    assignee: { type: "user", id: "u1" },
    labels: [],
    properties: {},
    position: 0,
    ...over,
  } as Parameters<WorkItemRepo["insert"]>[0]);
};

const rawPosition = (db: DatabaseSync, id: string): number =>
  (db.prepare(RAW_POSITION).get(id) as { position: number }).position;

/** 真实 runtime + 真实服务面（照 workItemContentWhitelistVerification.test.ts 的装配法）。 */
async function makeService() {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const state = { enabled: true };
  const createRuntime = async (t: SquadWorkspaceTarget): Promise<SquadRuntime> =>
    createSquadRuntime({
      db,
      workspacePath: repoRoot,
      workspaceIdentity: t.identity,
      readExperimentEnabled: () => state.enabled,
    });
  const squadRuntimeService: ISquadRuntimeService = createSquadRuntimeService({
    createRuntime,
    readExperimentEnabled: async () => state.enabled,
    archiveSquadAndTransfer: async (t, id) => archiveSquadAndTransfer(await createRuntime(t), id),
    createOrchestrator: createSquadOrchestrator,
  });
  return { db, squadRuntimeService };
}

// ---------- repo 层：REAL 原样 + patch 子集语义 ----------

test("repo｜position 写 REAL 小数（2.5）：原样落库并读回（不做整数化）", () => {
  const { db, repo } = makeDb();
  insertRow(repo, "wi-1");

  assert.equal(repo.updateContent("wi-1", { position: 2.5 }), true, "只给 position 也是合法写");
  assert.equal(rawPosition(db, "wi-1"), 2.5, "库里存的就是 2.5（REAL 原样，不得被整数化）");
  assert.equal(repo.get("wi-1")?.position, 2.5, "读回同一结论（映射层不得再取整）");
  db.close();
});

test("repo｜不传 position ⇒ 现值不动（patch 子集语义，与 title/body 同款）", () => {
  const { db, repo } = makeDb();
  insertRow(repo, "wi-1", { position: 1.5 });

  assert.equal(repo.updateContent("wi-1", { title: "新标题" }), true);
  assert.equal(repo.get("wi-1")?.title, "新标题", "给过的字段照写（否则用例证明不了子集语义）");
  assert.equal(rawPosition(db, "wi-1"), 1.5, "没给的 position 不得被顺手写成默认值");
  db.close();
});

test("repo｜`position: 0` 是**给过的值**：照写且返回 true（不得按 falsy 跳过）", () => {
  const { db, repo } = makeDb();
  insertRow(repo, "wi-1", { position: 4.5 });

  assert.equal(repo.updateContent("wi-1", { position: 0 }), true, "0 是合法次序值，不是空 patch");
  assert.equal(rawPosition(db, "wi-1"), 0);
  db.close();
});

test("repo｜position 写负数（-3.25）：原样落库并读回", () => {
  const { db, repo } = makeDb();
  insertRow(repo, "wi-1");

  assert.equal(repo.updateContent("wi-1", { position: -3.25 }), true);
  assert.equal(rawPosition(db, "wi-1"), -3.25, "负数同样是合法次序值（排序方向由消费方决定）");
  assert.equal(repo.get("wi-1")?.position, -3.25);
  db.close();
});

test("repo｜只写 position ⇒ **整行**除 position / updated_at 外逐列不变", () => {
  const { db, repo } = makeDb();
  insertRow(repo, "wi-1", {
    priority: "urgent",
    startDate: "2026-10-08",
    dueDate: "2026-12-31",
    creator: { kind: "human", id: "local-user" },
    labels: ["甲", "乙"],
  });
  const columns =
    "id, workspace_key, workspace_path, parent_id, stage, title, body, status, assignee_type, assignee_id, labels, properties, position, archived_at, priority, start_date, due_date, creator_kind, creator_id, creator_display_name, identifier_seq";
  const readAll = (): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(
        db.prepare(`SELECT ${columns} FROM work_items WHERE id = 'wi-1'`).get() as Record<
          string,
          unknown
        >,
      ).filter(([column]) => column !== "updated_at"),
    );
  const before = readAll();

  assert.equal(repo.updateContent("wi-1", { position: 8.25 }), true);
  assert.deepEqual(
    readAll(),
    { ...before, position: 8.25 },
    "写位次只动 position 一列：别的列（含其他白名单字段）逐列不变",
  );
  db.close();
});

// ---------- 服务面：position 透传（不过门禁、不二次判断） ----------

test("服务面｜position 写入（2.5 / 负数）逐字节读回，返回实体同值", async () => {
  const { db, squadRuntimeService } = await makeService();
  const item = await squadRuntimeService.createWorkItem(WS, {
    title: "待排序",
    assignee: { type: "user", id: "user" },
  });

  const moved = await squadRuntimeService.updateWorkItem(WS, {
    id: item.id,
    patch: { position: 2.5 },
  });
  assert.equal(moved.position, 2.5, "返回实体带写盘后的位次");
  assert.equal(rawPosition(db, item.id), 2.5, "库里逐字节是 2.5");

  const movedAgain = await squadRuntimeService.updateWorkItem(WS, {
    id: item.id,
    patch: { position: -0.5 },
  });
  assert.equal(movedAgain.position, -0.5);
  assert.equal(rawPosition(db, item.id), -0.5);
});

test("服务面｜省略 position ⇒ 现值不动（与既有字段同一份子集语义）", async () => {
  const { db, squadRuntimeService } = await makeService();
  const item = await squadRuntimeService.createWorkItem(WS, {
    title: "先定位",
    assignee: { type: "user", id: "user" },
  });
  await squadRuntimeService.updateWorkItem(WS, { id: item.id, patch: { position: 3.5 } });

  const renamed = await squadRuntimeService.updateWorkItem(WS, {
    id: item.id,
    patch: { title: "改个名" },
  });
  assert.equal(renamed.title, "改个名");
  assert.equal(rawPosition(db, item.id), 3.5, "改标题不得把用户的拖拽位次清掉");
});
