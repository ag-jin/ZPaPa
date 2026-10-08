import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import { createSquadOrchestrator } from "../src/workitem/squadOrchestrator.js";
import { archiveSquadAndTransfer, createSquadRuntime } from "../src/workitem/squadRuntime.js";
import { createWorkItemRepo, type WorkItemRepo } from "../src/workitem/workItemRepo.js";
import {
  createSquadRuntimeService,
  type ISquadRuntimeService,
  type SquadWorkspaceTarget,
} from "../src/workitem/squadRuntimeService.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* `updateContent` 的 **SET 白名单**（#11 v1 的硬守卫）与标签写路径的**独立注入式复验**
   （test-verifier，2026-10-07）。

   白名单承重（拆解 §3.2 / M1 结构守卫）：`updateContent` 是工作项**内容**的唯一写入口，
   `status` / `archived_at` / `assignee_*` / `properties` / `creator_*` / `identifier_seq` 都**另有
   唯一写者**（R6 起 `position` 是**内容型**字段：看板拖拽改序经同一条白名单写入，见
   `workItemPositionUpdate.test.ts`）。逐字段 SET 拼接（patch 里出现哪个字段才 SET 哪个）是
   「运行期多带的键写不进别的列」的实现；本文件从**两道防线**分别验证这条守卫**不是空跑**：
   · 防线 A（服务面）：调用方把越界键塞进 `patch` ⇒ 服务面**重建** patch（只取白名单三字段）；
   · 防线 B（repo）：越界键直接送到 `updateContent` ⇒ 逐字段拼接把它们忽略掉，且**一行都不写**
     （没有任何白名单字段时返回 false，绝不发空 UPDATE）。

   断言读**库里的原始列**（不经 repo 的映射），并对「只该变的列变了、其余列逐列不变」逐条比对。 */

const target = (identity: string): SquadWorkspaceTarget => ({ path: `/tmp/${identity}`, identity });
const WS = target("ws");

const WRITE_STATE_COLUMNS =
  "SELECT title, body, status, assignee_type, assignee_id, archived_at, position, properties, labels FROM work_items WHERE id = ?";

type Row = {
  title: string;
  body: string;
  status: string;
  assignee_type: string;
  assignee_id: string;
  archived_at: number | null;
  position: number;
  properties: string;
  labels: string;
};

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

const readRow = (db: DatabaseSync, id: string): Row =>
  db.prepare(WRITE_STATE_COLUMNS).get(id) as Row;

/** 真实 runtime + 真实服务面（照 workItemLabels.test.ts 的装配法）。 */
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

// ---------- 防线 A：服务面（越界键在服务面就被丢掉） ----------

test("白名单（防线 A）｜服务面重建 patch：白名单字段照写，越界键（status/archived_at/properties/assignee）一律写不进", async () => {
  const { db, squadRuntimeService } = await makeService();
  const item = await squadRuntimeService.createWorkItem(WS, {
    title: "原标题",
    assignee: { type: "user", id: "user" },
    labels: ["原标签"],
  });
  const before = readRow(db, item.id);

  // 模拟「调用方绕过类型把越界键塞进 patch」（RPC 传参 / 未类型化调用方都可能长这样）。
  // `position` 在 R6 起是**白名单内**字段（越界键的名单里不再有它）。
  await squadRuntimeService.updateWorkItem(WS, {
    id: item.id,
    patch: {
      title: "改过的标题",
      status: "done",
      archived_at: 123,
      position: 7.5,
      properties: { 偷偷: "写进去" },
      assignee_type: "agent",
      assignee_id: "ta-9",
      labels: ["改过的标签", "改过的标签", " 又一个 "],
    },
  } as unknown as { id: string; patch: { title?: string; body?: string } });

  const after = readRow(db, item.id);
  assert.equal(after.title, "改过的标题", "白名单内的字段要真的写进去（否则用例证明不了守卫）");
  assert.deepEqual(
    JSON.parse(after.labels),
    ["改过的标签", "又一个"],
    "白名单内新增的 labels 也按归一化写入",
  );
  assert.equal(after.position, 7.5, "白名单内新增的 position（REAL）原样写入，不得整数化");
  for (const column of [
    "body",
    "status",
    "assignee_type",
    "assignee_id",
    "archived_at",
    "properties",
  ] as const) {
    assert.deepEqual(
      after[column],
      before[column],
      `越界列 ${column} 逐列不变（status 的唯一写者是 transition；归档另有出口）`,
    );
  }
});

// ---------- 防线 B：repo（越界键被逐字段 SET 拼接忽略） ----------

test("白名单（防线 B）｜repo 层：patch 带越界键 ⇒ 只写白名单列（含 position），越界列逐列不变", () => {
  const { db, repo } = makeDb();
  insertRow(repo, "wi-1");
  const before = readRow(db, "wi-1");

  const smuggled = {
    title: "白名单内的新标题",
    position: 9.5,
    status: "done",
    archived_at: 456,
    assignee_type: "agent",
    assignee_id: "ta-9",
    properties: { 越界: true },
  } as unknown as Parameters<WorkItemRepo["updateContent"]>[1];

  assert.equal(repo.updateContent("wi-1", smuggled), true, "命中一行且给了字段 ⇒ 返回 true");
  const after = readRow(db, "wi-1");
  assert.equal(after.title, "白名单内的新标题");
  assert.equal(after.position, 9.5, "白名单内的 position（REAL）原样写入");
  for (const column of [
    "status",
    "assignee_type",
    "assignee_id",
    "archived_at",
    "properties",
  ] as const) {
    assert.deepEqual(after[column], before[column], `越界列 ${column} 不得被 patch 里的同名键改写`);
  }
  assert.equal(repo.get("wi-1")?.status, "todo", "读回也仍是原状态（status 只经 transition 变）");
});

test("白名单（防线 B）｜repo 层：只带越界键 ⇒ 返回 false 且**一行都不写**（不发空 UPDATE）", () => {
  const { db, repo } = makeDb();
  insertRow(repo, "wi-1");
  const before = readRow(db, "wi-1");

  const onlySmuggled = { status: "done", archived_at: 789 } as unknown as Parameters<
    WorkItemRepo["updateContent"]
  >[1];
  assert.equal(
    repo.updateContent("wi-1", onlySmuggled),
    false,
    "没有白名单字段 ⇒ 未命中（响亮错误留给调用方）",
  );
  assert.deepEqual(readRow(db, "wi-1"), before, "整行逐列不变");

  assert.equal(repo.updateContent("wi-1", {}), false, "空 patch 同样返回 false");
  assert.deepEqual(readRow(db, "wi-1"), before);
});

test("白名单（防线 B）｜repo 层：`labels: []` 是**合法写**（清空），不是空 patch", () => {
  const { db, repo } = makeDb();
  insertRow(repo, "wi-1", { labels: ["a", "b"] });
  assert.equal(
    readRow(db, "wi-1").labels,
    JSON.stringify(["a", "b"]),
    "前提：库里已有标签（JSON 文本列）",
  );

  assert.equal(repo.updateContent("wi-1", { labels: [] }), true, "清空标签必须真的落库");
  assert.equal(readRow(db, "wi-1").labels, "[]");
  assert.equal(repo.get("wi-1")?.labels.length, 0, "读回是空数组");
});

test("白名单（防线 B）｜repo 层不做第二份判据：越界数据（重复/超限）原样 JSON 落盘（闸在上游）", () => {
  const { db, repo } = makeDb();
  insertRow(repo, "wi-1");
  // 设计裁定：归一化与上限判据只有**一处**（shared 纯函数，由两个写入口在写前调用）；
  // repo 只负责 JSON 序列化。所以绕过服务面直接调 repo 时，越界值会原样落盘 —— 这不是
  // 「repo 的漏洞」，而是「闸只有一道、且在上游」的必然表现：本用例把它钉住，防止有人
  // 在 repo 里补一份「顺手去重 / 截断」（那就是第二份判据，静默半截写入）。
  const eleven = Array.from({ length: 11 }, (_, index) => `t${index}`);
  assert.equal(repo.updateContent("wi-1", { labels: [...eleven, "t0"] }), true);
  assert.equal(
    readRow(db, "wi-1").labels,
    JSON.stringify([...eleven, "t0"]),
    "repo 层不做去重/截断（判据单源在 shared；写入口在写前过闸并响亮拒绝）",
  );
});

// ---------- 标签与状态键零耦合（行为面） ----------

test("零耦合｜改标签不动状态：标签写入前后 status/archived_at 等状态列逐列不变", async () => {
  const { db, squadRuntimeService } = await makeService();
  const item = await squadRuntimeService.createWorkItem(WS, {
    title: "活",
    assignee: { type: "user", id: "user" },
    labels: ["甲"],
  });
  const before = readRow(db, item.id);
  assert.equal(before.status, "todo", "建项初始状态是 todo（标签不影响初始状态）");

  await squadRuntimeService.updateWorkItem(WS, { id: item.id, patch: { labels: ["乙", "丙"] } });
  const after = readRow(db, item.id);
  assert.equal(after.status, "todo", "改标签不是一次状态迁移");
  assert.equal(after.archived_at, null, "改标签不归档");
  assert.equal(after.assignee_type, before.assignee_type);
  assert.equal(after.assignee_id, before.assignee_id);
  assert.deepEqual(JSON.parse(after.labels), ["乙", "丙"]);
});

test("零耦合｜标签超限被拒时，库里的**状态列与标签列**都不变（拒绝发生在写之前）", async () => {
  const { db, squadRuntimeService } = await makeService();
  const item = await squadRuntimeService.createWorkItem(WS, {
    title: "活",
    assignee: { type: "user", id: "user" },
    labels: ["保留"],
  });
  const before = readRow(db, item.id);

  await assert.rejects(
    () =>
      squadRuntimeService.updateWorkItem(WS, {
        id: item.id,
        patch: {
          title: "不该写进去的新标题",
          labels: Array.from({ length: 11 }, (_, index) => `t${index}`),
        },
      }),
    /标签/,
    "超限必须响亮抛（不得静默截断后写入）",
  );
  assert.deepEqual(readRow(db, item.id), before, "被拒的编辑整行不变（含同一次 patch 里的 title）");
});
