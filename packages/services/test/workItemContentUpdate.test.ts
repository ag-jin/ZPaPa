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
import { makeRepo } from "./helpers/gitFixture.js";

/* 工作项**内容编辑**服务面方法（updateWorkItem，2026-10-03 加法）的用例。
   装配照 squadRosterManagement.test.ts 的同一先例：真实 git 仓库 + `:memory:` sqlite +
   真实 runtime + 真实服务面 —— 不给服务面塞桩，否则断言的是桩的行为而不是实现。

   为什么断言必须读**实体状态**（getSnapshot 读回 / 直接读库表）：返回值是调用方给的那份
   数据的回声，读盘（这里是读库）才有独立信息。

   口径纪律：目标 workspace **显式构造**并用 `seenTargets` 证明服务把**调用方给的**目标
   原样交给 runtime（没有隐式默认 workspace）；写者纪律：status 仍只经 WorkItemService 的
   transition（本方法不碰它），内容走 repo 的专用写入口 —— 白名单承重由「多带的键必须被
   忽略」那条用例钉住。 */

const target = (identity: string): SquadWorkspaceTarget => ({
  path: `/tmp/${identity}`,
  identity,
});

async function makeMemoryDb(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return db;
}

/** 真实 runtime + 真实服务面（照 squadRosterManagement.test.ts 的装配法）。 */
async function makeService() {
  const repoRoot = await makeRepo();
  const db = await makeMemoryDb();
  const state = { enabled: true };
  /** 记录服务面收到的目标 —— 证明服务面把**调用方给的**目标原样交给 runtime。 */
  const seenTargets: string[] = [];
  const createRuntime = async (t: SquadWorkspaceTarget): Promise<SquadRuntime> => {
    seenTargets.push(`${t.path}|${t.identity}`);
    return createSquadRuntime({
      db,
      workspacePath: repoRoot,
      workspaceIdentity: t.identity,
      readExperimentEnabled: () => state.enabled,
    });
  };
  const squadRuntimeService: ISquadRuntimeService = createSquadRuntimeService({
    createRuntime,
    readExperimentEnabled: async () => state.enabled,
    archiveSquadAndTransfer: async (t, id) => archiveSquadAndTransfer(await createRuntime(t), id),
    createOrchestrator: createSquadOrchestrator,
  });
  return {
    repoRoot,
    db,
    squadRuntimeService,
    seenTargets,
    setExperimentEnabled: (value: boolean) => {
      state.enabled = value;
    },
  };
}

/** 直接读库：行的实体状态（不经服务、不经 repo 的 rowToWorkItem 映射）。 */
function readRow(db: DatabaseSync, id: string) {
  return db
    .prepare(
      "SELECT title, body, status, assignee_type, assignee_id, archived_at FROM work_items WHERE id = ?",
    )
    .get(id) as
    | {
        title: string;
        body: string;
        status: string;
        assignee_type: string;
        assignee_id: string;
        archived_at: number | null;
      }
    | undefined;
}

const WS = target("ws");

/** 建一条工作项（内容编辑用例的起点）。指派给用户，与小队运行期无关。 */
async function createItem(service: ISquadRuntimeService, title = "原始标题") {
  return service.createWorkItem(WS, {
    title,
    body: "原始正文",
    assignee: { type: "user", id: "user" },
  });
}

test("updateWorkItem 改标题：快照读回 + 直接读库都是新值", async () => {
  const { db, squadRuntimeService } = await makeService();
  const item = await createItem(squadRuntimeService);

  const updated = await squadRuntimeService.updateWorkItem(WS, {
    id: item.id,
    patch: { title: "新标题" },
  });
  assert.equal(updated.id, item.id, "编辑不换身份：id 不变");
  assert.equal(updated.title, "新标题");
  assert.equal(updated.body, "原始正文", "未给的字段（body）原样保留");

  assert.equal(readRow(db, item.id)?.title, "新标题", "直接读库也要是新值");
  const snapshot = await squadRuntimeService.getSnapshot(WS);
  assert.equal(
    snapshot.workItems.find((entry) => entry.id === item.id)?.title,
    "新标题",
    "快照读回新值",
  );
});

test("updateWorkItem 改正文：快照读回 + 直接读库都是新值", async () => {
  const { db, squadRuntimeService } = await makeService();
  const item = await createItem(squadRuntimeService);

  const updated = await squadRuntimeService.updateWorkItem(WS, {
    id: item.id,
    patch: { body: "新正文" },
  });
  assert.equal(updated.title, "原始标题", "未给的字段（title）原样保留");
  assert.equal(updated.body, "新正文");
  assert.equal(readRow(db, item.id)?.body, "新正文");
  assert.equal(
    (await squadRuntimeService.getSnapshot(WS)).workItems.find((entry) => entry.id === item.id)
      ?.body,
    "新正文",
  );
});

test("updateWorkItem 同时改标题与正文：两者都写盘", async () => {
  const { db, squadRuntimeService } = await makeService();
  const item = await createItem(squadRuntimeService);

  const updated = await squadRuntimeService.updateWorkItem(WS, {
    id: item.id,
    patch: { title: "双双新标题", body: "双双新正文" },
  });
  assert.equal(updated.title, "双双新标题");
  assert.equal(updated.body, "双双新正文");
  assert.equal(readRow(db, item.id)?.title, "双双新标题");
  assert.equal(readRow(db, item.id)?.body, "双双新正文");
});

// 白名单承重：`updateContent` 的 SET 子句**逐字段拼接**（只认 title / body），不做整包展开
// —— 运行期多带的键必须被忽略，否则 patch 上恰好同名于别的列（status / assignee_type /
// archived_at）的键就能绕开白名单写到不该写的列上。
// 变异 S1：把实现改成整包展开（把 patch 的键直接拼进 SET）⇒ 本用例必红（status 被写成 done）。
test("updateWorkItem 白名单承重：patch 多带的 status / assignee / archivedAt 一律被忽略", async () => {
  const { db, squadRuntimeService } = await makeService();
  const item = await createItem(squadRuntimeService);
  const before = readRow(db, item.id);
  assert.ok(before, "起点行必须在库");

  const updated = await squadRuntimeService.updateWorkItem(WS, {
    id: item.id,
    // 运行期多带的键（类型系统挡不住真实调用方的越界键，故这里按提交口径 `as never` 强行塞入）。
    patch: {
      title: "标题照写",
      status: "done",
      assignee: { type: "agent", id: "ta_hacked" },
      archivedAt: 12345,
    } as never,
  });

  assert.equal(updated.title, "标题照写", "白名单内的字段照常写入");
  const after = readRow(db, item.id);
  assert.ok(after, "行仍在");
  assert.equal(after.status, before.status, "白名单外的 status 必须原样不变");
  assert.equal(after.assignee_type, before.assignee_type, "白名单外的 assignee 必须原样不变");
  assert.equal(after.assignee_id, before.assignee_id);
  assert.equal(after.archived_at, before.archived_at, "白名单外的 archivedAt 必须原样不变");
  // 快照也读回同一结论（映射层不得把没写的东西读成"写了"）。
  const snapshot = await squadRuntimeService.getSnapshot(WS);
  const readBack = snapshot.workItems.find((entry) => entry.id === item.id);
  assert.equal(readBack?.status, before.status);
  assert.deepEqual(readBack?.assignee, { type: before.assignee_type, id: before.assignee_id });
});

// 空 patch（两个字段都 undefined）⇒ repo 直接 false ⇒ 服务面**响亮抛**（不得静默成功）。
// 变异：把 repo 的空 patch 分支改成「照常执行一次不 SET 任何列的 UPDATE」并且返回 true
// ⇒ 本用例必红（服务面会返回"成功"，而库里什么都没改）。
test("updateWorkItem 空 patch ⇒ 响亮抛（不得静默成功）", async () => {
  const { squadRuntimeService } = await makeService();
  const item = await createItem(squadRuntimeService);

  await assert.rejects(
    () => squadRuntimeService.updateWorkItem(WS, { id: item.id, patch: {} }),
    /编辑工作项失败/,
    "空 patch 静默成功会让界面以为改成功了，而库里一个字都没改",
  );
});

test("updateWorkItem：id 不存在 / 已归档 ⇒ 响亮抛", async () => {
  const { db, squadRuntimeService } = await makeService();

  await assert.rejects(
    () => squadRuntimeService.updateWorkItem(WS, { id: "不存在", patch: { title: "谁" } }),
    /编辑工作项失败/,
    "静默 no-op 会让界面以为改成功了",
  );

  // 已归档 = 等同不存在（repo 的两个写入口都过滤 archived_at IS NULL）。
  // 工作项归档在服务面**没有路径**（本轮明确不做），故这里直接改库模拟归档态。
  const item = await createItem(squadRuntimeService);
  db.prepare("UPDATE work_items SET archived_at = ? WHERE id = ?").run(Date.now(), item.id);
  await assert.rejects(
    () => squadRuntimeService.updateWorkItem(WS, { id: item.id, patch: { title: "改归档行" } }),
    /编辑工作项失败/,
    "已归档行不可写（未命中 ⇒ 响亮抛，不得静默当作成功）",
  );
  assert.equal(readRow(db, item.id)?.title, "原始标题", "已归档行一个字都不许被改");
});

// 内容编辑**不过门禁**（§5.7.6 只停新派发）：开关关掉时照常可用。
// 这不是"漏判"：门禁的唯一判据在 assertDispatchEnabled，改标题不产生新派发。
test("工作项内容编辑不受实验开关影响（不过门禁）：关掉开关后仍可用", async () => {
  const { db, squadRuntimeService, setExperimentEnabled } = await makeService();
  const item = await createItem(squadRuntimeService);

  setExperimentEnabled(false);

  const updated = await squadRuntimeService.updateWorkItem(WS, {
    id: item.id,
    patch: { title: "开关关了也能改标题" },
  });
  assert.equal(updated.title, "开关关了也能改标题");
  assert.equal(readRow(db, item.id)?.title, "开关关了也能改标题");
});

test("目标纪律：updateWorkItem 把调用方给的目标原样交给 runtime（没有隐式默认 workspace）", async () => {
  const { squadRuntimeService, seenTargets } = await makeService();
  const item = await createItem(squadRuntimeService);
  seenTargets.length = 0;

  const given: SquadWorkspaceTarget = { path: "/tmp/given-ws", identity: "given" };
  await squadRuntimeService.updateWorkItem(given, { id: item.id, patch: { title: "改" } });

  assert.deepEqual(
    seenTargets,
    ["/tmp/given-ws|given"],
    "调用必须带着调用方显式给的目标（原样透传，不挑不猜）",
  );
});
