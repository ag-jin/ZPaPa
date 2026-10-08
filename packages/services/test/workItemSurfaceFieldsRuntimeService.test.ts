import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { WorkItemCreator } from "@zcode/shared";
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

/* 工作项 **Surface 新字段的服务面**（`ISquadRuntimeService.createWorkItem` / `updateWorkItem`，
   0018 · 阶段一 R1）用例。装配照 `workItemContentUpdate.test.ts` 的同一先例：真实 git 仓库 +
   `:memory:` sqlite + 真实 runtime + 真实服务面 —— 不给服务面塞桩，否则断言的是桩的行为。

   三条本文件承重的纪律：
   ① **创建人由组合根注入**（`localHumanActor`，即 `LOCAL_HUMAN_ACTOR` 那一处定义），**不是**
      UI/调用方传的身份 —— 断言读**库里的原始三列**，读回值必须是注入的身份；未注入 ⇒ NULL，
      **绝不**拿 `assignee` 冒充（指名道姓的两件事）。
   ② 新字段的**写入口径**与既有内容字段同一条：闭集外优先级 / 坏日期**响亮抛**且**在写之前**
      （库保持旧值）；越权键（`status` / `creator_*` / `identifier_seq`）结构上写不进去。
   ③ 快照（读模型）与裸读库两处都要看到新值 —— 只改一处而另一处不变，正是「界面看着改了、
      库里没改」的形态。 */

const target = (identity: string): SquadWorkspaceTarget => ({ path: `/tmp/${identity}`, identity });
const WS = target("ws");

const ACTOR: WorkItemCreator = { kind: "human", id: "local-user" };

async function makeService(options: { localHumanActor?: () => WorkItemCreator } = {}) {
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
    ...(options.localHumanActor ? { localHumanActor: options.localHumanActor } : {}),
  });
  return { db, squadRuntimeService };
}

/** 直接读库：新字段的**原始列**（不经 repo 映射，映射层写错列名时读回仍是 undefined）。 */
function readSurfaceRow(db: DatabaseSync, id: string): Record<string, unknown> | undefined {
  const row = db
    .prepare(
      `SELECT priority, start_date, due_date, creator_kind, creator_id, creator_display_name,
              identifier_seq, status, assignee_id
       FROM work_items WHERE id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  return row ? { ...row } : undefined;
}

test("服务面创建带优先级 / 起始 / 截止：裸读库 + 快照都读回同一份值", async () => {
  const { db, squadRuntimeService } = await makeService({ localHumanActor: () => ACTOR });
  const item = await squadRuntimeService.createWorkItem(WS, {
    title: "带字段",
    assignee: { type: "user", id: "u1" },
    priority: "urgent",
    startDate: "2026-10-08",
    dueDate: "2026-12-31",
  });
  assert.equal(item.priority, "urgent");
  assert.equal(item.startDate, "2026-10-08");
  assert.equal(item.dueDate, "2026-12-31");
  assert.equal(readSurfaceRow(db, item.id)?.priority, "urgent");
  assert.equal(readSurfaceRow(db, item.id)?.start_date, "2026-10-08");
  assert.equal(readSurfaceRow(db, item.id)?.due_date, "2026-12-31");
  const snapshot = await squadRuntimeService.getSnapshot(WS);
  const fromSnapshot = snapshot.workItems.find((entry) => entry.id === item.id);
  assert.equal(fromSnapshot?.priority, "urgent");
  assert.equal(fromSnapshot?.dueDate, "2026-12-31");
});

test("创建人＝组合根注入的操作者（库里三列 = 注入身份，不是 assignee）", async () => {
  const { db, squadRuntimeService } = await makeService({ localHumanActor: () => ACTOR });
  const item = await squadRuntimeService.createWorkItem(WS, {
    title: "谁建的",
    assignee: { type: "agent", id: "ta-1" },
  });
  assert.deepEqual(readSurfaceRow(db, item.id), {
    priority: null,
    start_date: null,
    due_date: null,
    creator_kind: "human",
    creator_id: "local-user",
    creator_display_name: null,
    identifier_seq: 1,
    status: "todo",
    assignee_id: "ta-1",
  });
  assert.deepEqual(item.creator, { kind: "human", id: "local-user" });
});

// 未注入身份（组合根没接上）时创建人保持 NULL：宁可空着，也不拿 assignee 冒充 ——
// 「谁按下的创建」与「派给谁」是两件事，混淆会让审计链说谎。
test("未注入操作者身份：创建人三列保持 NULL（不拿 assignee 冒充）", async () => {
  const { db, squadRuntimeService } = await makeService();
  const item = await squadRuntimeService.createWorkItem(WS, {
    title: "身份未知",
    assignee: { type: "user", id: "u1" },
  });
  const row = readSurfaceRow(db, item.id);
  assert.equal(row?.creator_kind, null);
  assert.equal(row?.creator_id, null);
  assert.equal(row?.creator_display_name, null);
  assert.equal(item.creator, undefined);
});

test("连续创建两条：identifier_seq 由语句内生成（1、2），服务面读回同一个号", async () => {
  const { db, squadRuntimeService } = await makeService({ localHumanActor: () => ACTOR });
  const first = await squadRuntimeService.createWorkItem(WS, {
    title: "一号",
    assignee: { type: "user", id: "u1" },
  });
  const second = await squadRuntimeService.createWorkItem(WS, {
    title: "二号",
    assignee: { type: "user", id: "u1" },
  });
  assert.equal(first.identifierSeq, 1);
  assert.equal(second.identifierSeq, 2);
  assert.equal(readSurfaceRow(db, first.id)?.identifier_seq, 1);
  assert.equal(readSurfaceRow(db, second.id)?.identifier_seq, 2);
});

test("服务面创建闭集外优先级 / 坏日期：响亮抛且不落盘", async () => {
  const { db, squadRuntimeService } = await makeService({ localHumanActor: () => ACTOR });
  const before = (db.prepare("SELECT COUNT(*) AS n FROM work_items").get() as { n: number }).n;
  await assert.rejects(
    () =>
      squadRuntimeService.createWorkItem(WS, {
        title: "坏优先级",
        assignee: { type: "user", id: "u1" },
        priority: "none" as never,
      }),
    /优先级/,
  );
  await assert.rejects(
    () =>
      squadRuntimeService.createWorkItem(WS, {
        title: "坏日期",
        assignee: { type: "user", id: "u1" },
        startDate: "2026-02-29",
      }),
    /日期/,
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM work_items").get() as { n: number }).n,
    before,
  );
});

test("updateWorkItem 改优先级 / 起始 / 截止：落库 + 读回；显式 null 清回未设置", async () => {
  const { db, squadRuntimeService } = await makeService({ localHumanActor: () => ACTOR });
  const item = await squadRuntimeService.createWorkItem(WS, {
    title: "待编辑",
    assignee: { type: "user", id: "u1" },
    priority: "low",
  });
  const updated = await squadRuntimeService.updateWorkItem(WS, {
    id: item.id,
    patch: { priority: "high", startDate: "2026-10-08", dueDate: "2026-11-11" },
  });
  assert.equal(updated.priority, "high");
  assert.equal(updated.startDate, "2026-10-08");
  assert.equal(updated.dueDate, "2026-11-11");
  assert.equal(readSurfaceRow(db, item.id)?.priority, "high");
  assert.equal(readSurfaceRow(db, item.id)?.start_date, "2026-10-08");
  assert.equal(readSurfaceRow(db, item.id)?.due_date, "2026-11-11");

  const cleared = await squadRuntimeService.updateWorkItem(WS, {
    id: item.id,
    patch: { priority: null },
  });
  assert.equal(cleared.priority, undefined, "清回未设置");
  assert.equal(readSurfaceRow(db, item.id)?.priority, null);
  assert.equal(cleared.startDate, "2026-10-08", "未给的字段原样保留");
});

test("updateWorkItem 闭集外优先级 / 坏日期：响亮抛且库里保持旧值（写之前过闸）", async () => {
  const { db, squadRuntimeService } = await makeService({ localHumanActor: () => ACTOR });
  const item = await squadRuntimeService.createWorkItem(WS, {
    title: "拒绝改坏",
    assignee: { type: "user", id: "u1" },
    priority: "medium",
    dueDate: "2026-12-31",
  });
  await assert.rejects(
    () =>
      squadRuntimeService.updateWorkItem(WS, {
        id: item.id,
        patch: { priority: "blocker" as never },
      }),
    /优先级/,
  );
  await assert.rejects(
    () => squadRuntimeService.updateWorkItem(WS, { id: item.id, patch: { dueDate: "2026-13-01" } }),
    /日期/,
  );
  const row = readSurfaceRow(db, item.id);
  assert.equal(row?.priority, "medium");
  assert.equal(row?.due_date, "2026-12-31");
});

// 越权键（内容编辑白名单之外）：服务面**重建** patch（只取白名单字段），越权列一个字都不动；
// 只给越权键 ⇒ 服务面按「空 patch」响亮抛（不静默 no-op）。
test("updateWorkItem 越权键：status / creator_* / identifier_seq 写不进去；只给越权键 ⇒ 响亮抛", async () => {
  const { db, squadRuntimeService } = await makeService({ localHumanActor: () => ACTOR });
  const item = await squadRuntimeService.createWorkItem(WS, {
    title: "越权尝试",
    assignee: { type: "user", id: "u1" },
  });
  const before = readSurfaceRow(db, item.id);
  await assert.rejects(
    () =>
      squadRuntimeService.updateWorkItem(WS, {
        id: item.id,
        patch: {
          status: "done",
          creator_kind: "system",
          creator_id: "someone",
          identifier_seq: 99,
        } as never,
      }),
    /编辑工作项失败/,
  );
  assert.deepEqual(readSurfaceRow(db, item.id), before, "越权键不得改动任何列");

  const mixed = await squadRuntimeService.updateWorkItem(WS, {
    id: item.id,
    patch: { title: "合法改动", status: "done", identifier_seq: 99 } as never,
  });
  assert.equal(mixed.title, "合法改动");
  assert.equal(readSurfaceRow(db, item.id)?.status, "todo", "status 的唯一写者仍是 transition");
  assert.equal(readSurfaceRow(db, item.id)?.identifier_seq, 1, "identifier_seq 不可改");
});
