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

/* 工作项**标签**（欠账 #11 的 v1，2026-10-07 裁定）在服务面的写路径用例：
   ① 建项带标签（`createWorkItem({labels})`）⇒ 归一化后落盘、读回逐字相等；
   ② 超限**响亮拒且不落盘**（不静默截断、不留半截行）；
   ③ 编辑标签（`updateWorkItem({patch:{labels}})`）只改 labels 一列。

   装配照 workItemContentUpdate.test.ts / squadTimelineData.test.ts 的同一先例：真实 git 仓库 +
   `:memory:` sqlite + 真实 runtime + 真实服务面 —— 不给服务面塞桩，否则断言的是桩的行为。
   断言读**实体状态**（直接读库列 + 快照读回）：返回值是调用方给的那份数据的回声。

   归一化判据的唯一实现在 shared（`parseWorkItemLabels`），本文件不复制它的规则表，只钉
   「服务面把它用在两个写入口上」这一件事。 */

const target = (identity: string): SquadWorkspaceTarget => ({
  path: `/tmp/${identity}`,
  identity,
});

const WS = target("ws");

async function makeService() {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const state = { enabled: true };
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
    db,
    squadRuntimeService,
    setExperimentEnabled: (value: boolean) => {
      state.enabled = value;
    },
  };
}

/** 直接读库：`labels` 列的**原始文本**（不经 repo 的 JSON.parse 映射）。 */
function readLabelsColumn(db: DatabaseSync, id: string): string | undefined {
  const row = db.prepare("SELECT labels FROM work_items WHERE id = ?").get(id) as
    | { labels: string }
    | undefined;
  return row?.labels;
}

/** 直接读库：整行计数（超限时证明「一行都没落」）。 */
function countRows(db: DatabaseSync): number {
  const row = db.prepare("SELECT count(*) AS n FROM work_items").get() as { n: number };
  return row.n;
}

// ---------- ① 建项带标签 ----------

test("createWorkItem 带标签：归一化后落盘（逗号/换行切分、trim、丢空、去重保序），读回逐字相等", async () => {
  const { db, squadRuntimeService } = await makeService();

  const item = await squadRuntimeService.createWorkItem(WS, {
    title: "带标签的活",
    assignee: { type: "user", id: "user" },
    labels: ["  前端 , 紧急\n后端 ,, 前端 "],
  });

  assert.deepEqual(
    item.labels,
    ["前端", "紧急", "后端"],
    "返回值即归一化结果（首次出现为准、保序）",
  );
  assert.equal(
    readLabelsColumn(db, item.id),
    JSON.stringify(["前端", "紧急", "后端"]),
    "库列是 JSON 文本（存储格式不变），内容是归一化后的值",
  );
  const readBack = (await squadRuntimeService.getSnapshot(WS)).workItems.find(
    (entry) => entry.id === item.id,
  );
  assert.deepEqual(readBack?.labels, ["前端", "紧急", "后端"], "快照读回同值");
});

test("createWorkItem 不带标签 ⇒ 落空数组（现状口径不变）", async () => {
  const { db, squadRuntimeService } = await makeService();
  const item = await squadRuntimeService.createWorkItem(WS, {
    title: "没标签",
    assignee: { type: "user", id: "user" },
  });
  assert.deepEqual(item.labels, []);
  assert.equal(readLabelsColumn(db, item.id), "[]");
});

// 上限是**响亮**的（不得静默截断成 10 条）：提交 11 个标签而界面显示 10 个，
// 用户以为自己写进去了 —— 那正是「安静丢数据」的形态。
test("createWorkItem 超条数上限（11 条）⇒ 响亮抛，且一行都不落盘", async () => {
  const { db, squadRuntimeService } = await makeService();
  const before = countRows(db);

  await assert.rejects(
    () =>
      squadRuntimeService.createWorkItem(WS, {
        title: "十一个标签",
        assignee: { type: "user", id: "user" },
        labels: [Array.from({ length: 11 }, (_, index) => `t${index}`).join(",")],
      }),
    // 文案必须说清**哪条上限**、**超了多少**（用户据此才能改）：判据在 shared，措辞也在 shared 单源。
    /标签超过条数上限 10（给了 11 条）/,
    "超限必须响亮拒（静默截断 = 用户以为写进去了）",
  );
  assert.equal(countRows(db), before, "被拒的建项不得留下半截行");
});

test("createWorkItem 超单条长度上限（33 字符）⇒ 响亮抛，且一行都不落盘", async () => {
  const { db, squadRuntimeService } = await makeService();
  const before = countRows(db);
  const tooLong = "y".repeat(33);

  await assert.rejects(
    () =>
      squadRuntimeService.createWorkItem(WS, {
        title: "超长标签",
        assignee: { type: "user", id: "user" },
        labels: [tooLong],
      }),
    (error: Error) =>
      error.message.includes("超过单条长度上限 32") && error.message.includes(tooLong),
    "文案必须带上那条超长标签的原文与长度上限",
  );
  assert.equal(countRows(db), before);
});

test("createWorkItem 恰好 10 条 / 恰好 32 字符 ⇒ 收下（上限两侧的另一侧）", async () => {
  const { squadRuntimeService } = await makeService();
  const exactly = [...Array.from({ length: 9 }, (_, index) => `t${index}`), "x".repeat(32)];
  const item = await squadRuntimeService.createWorkItem(WS, {
    title: "恰好到顶",
    assignee: { type: "user", id: "user" },
    labels: [exactly.join(",")],
  });
  assert.deepEqual(item.labels, exactly, "恰好到顶必须收下 —— 边界不能差一位");
});

// ---------- ② 编辑标签（既有 updateWorkItem 的白名单多一位） ----------

test("updateWorkItem 改标签：只改 labels 一列，title/body/status/assignee/archived_at 逐列不变", async () => {
  const { db, squadRuntimeService } = await makeService();
  const item = await squadRuntimeService.createWorkItem(WS, {
    title: "原标题",
    body: "原正文",
    assignee: { type: "user", id: "user" },
    labels: ["旧"],
  });
  const before = db
    .prepare(
      "SELECT title, body, status, assignee_type, assignee_id, archived_at FROM work_items WHERE id = ?",
    )
    .get(item.id) as Record<string, unknown>;

  const updated = await squadRuntimeService.updateWorkItem(WS, {
    id: item.id,
    patch: { labels: ["新, 再次\n 新 "] },
  });

  assert.deepEqual(updated.labels, ["新", "再次"], "归一化 + 去重（重复的「新」只留一个）");
  assert.equal(readLabelsColumn(db, item.id), JSON.stringify(["新", "再次"]));
  const after = db
    .prepare(
      "SELECT title, body, status, assignee_type, assignee_id, archived_at FROM work_items WHERE id = ?",
    )
    .get(item.id) as Record<string, unknown>;
  assert.deepEqual(after, before, "白名单之外的五列逐列不变（编辑标签不是一次整包覆写）");
});

test("updateWorkItem 改标签超限 ⇒ 响亮抛，库里仍是上一次的标签", async () => {
  const { db, squadRuntimeService } = await makeService();
  const item = await squadRuntimeService.createWorkItem(WS, {
    title: "原标题",
    assignee: { type: "user", id: "user" },
    labels: ["保留我"],
  });

  await assert.rejects(
    () =>
      squadRuntimeService.updateWorkItem(WS, {
        id: item.id,
        patch: { labels: Array.from({ length: 11 }, (_, index) => `t${index}`) },
      }),
    /标签/,
  );
  assert.equal(
    readLabelsColumn(db, item.id),
    JSON.stringify(["保留我"]),
    "被拒的编辑不得动库里的旧值（不得先写后校验）",
  );
});

// 清空标签是**合法动作**（不是空 patch）：`labels: []` 与「没给 labels」是两件事。
test("updateWorkItem 清空标签（labels: []）⇒ 写空数组而不是被当成空 patch", async () => {
  const { db, squadRuntimeService } = await makeService();
  const item = await squadRuntimeService.createWorkItem(WS, {
    title: "原标题",
    assignee: { type: "user", id: "user" },
    labels: ["要删掉"],
  });

  const updated = await squadRuntimeService.updateWorkItem(WS, {
    id: item.id,
    patch: { labels: [] },
  });
  assert.deepEqual(updated.labels, []);
  assert.equal(readLabelsColumn(db, item.id), "[]");
});
