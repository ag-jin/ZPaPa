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

/* 工作项级 reactions 的**服务面**用例（`setWorkItemReaction` / `listWorkItemReactions`，
   P3-R5s 切片 3）。装配照 `workItemViewService.test.ts` / `workItemPositionUpdate.test.ts` 的同一先例：
   真实 git 仓库 + `:memory:` sqlite + 真实 runtime + 真实服务面（不给服务面塞桩）。

   本文件承重的六组判据：
   ① **幂等契约**（「命中冲突 = 无变化」）：重复 add 返回**同值**、库里恰一行、**不重写时间戳**；
      重复 remove 不报错且不再变（multica `issue_revision_test.go:842-883` 的 ZPaPa 对应物）。
   ② **作者的唯一来源是注入身份**（0018/0020 同款 `localHumanActor`）：调用方不能自证；
      未注入 ⇒ 两个方法都**响亮抛**（不写一行「无主反应」）。
   ③ **工作项归属**：不存在 / 已归档 / 跨 workspace 一律响亮抛且**零写入**（§8.5）。
   ④ **emoji 护栏在服务面**：仅拒空串与超长（宽松 32 字节上限，登记）；**不白名单**
      （32 字节边界的组合 emoji、自定义 token 都能落库 —— 存储不筛内容）。
   ⑤ **返回形状 = 操作后该工作项的全部行（插入序）**：UI 侧按 emoji 聚合
      （`{emoji,count,actors,reactedByMe}` 归 UI，服务面不预先分组）。
   ⑥ **不过门禁**：实验开关关掉后照常可用（reactions 与派发无关，与 `updateWorkItem` 同款）。 */

const ACTOR: WorkItemCreator = { kind: "human", id: "local-user" };
const OTHER: WorkItemCreator = { kind: "human", id: "someone-else" };

const target = (identity: string): SquadWorkspaceTarget => ({ path: `/tmp/${identity}`, identity });
const WS = target("ws-a");
const WS_OTHER = target("ws-b");

/** 每项一行（`get` 过滤归档；`getIncludingArchived` 才看得到 ）——插入用 repo 直插，不经派发门禁。 */
type ItemOverrides = { archivedAt?: number };

async function makeWorld(): Promise<{
  db: DatabaseSync;
  service: ISquadRuntimeService;
  serviceFor: (actor: WorkItemCreator | null, clock?: () => number) => ISquadRuntimeService;
  setEnabled: (enabled: boolean) => void;
  setClock: (value: number) => void;
  insertItem: (t: SquadWorkspaceTarget, id: string, over?: ItemOverrides) => Promise<void>;
}> {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const state = { enabled: true };
  let clock = 1_000;
  const createRuntime = async (t: SquadWorkspaceTarget): Promise<SquadRuntime> =>
    createSquadRuntime({
      db,
      workspacePath: repoRoot,
      workspaceIdentity: t.identity,
      readExperimentEnabled: () => state.enabled,
    });
  const serviceFor = (
    actor: WorkItemCreator | null,
    // 缺省时钟**每次调用前进一格**：插入序用例（created_at ASC）要求后写的时间戳更大 ——
    // 定死同一个时钟会让同刻行落进 id tie-break（那不是插入序）。要钉死某次调用用 A1 的显式传参。
    now: () => number = () => clock++,
  ): ISquadRuntimeService =>
    createSquadRuntimeService({
      createRuntime,
      readExperimentEnabled: async () => state.enabled,
      archiveSquadAndTransfer: async (t, id) => archiveSquadAndTransfer(await createRuntime(t), id),
      createOrchestrator: createSquadOrchestrator,
      now,
      ...(actor === null ? {} : { localHumanActor: () => actor }),
    });
  const insertItem = async (
    t: SquadWorkspaceTarget,
    id: string,
    over: ItemOverrides = {},
  ): Promise<void> => {
    (await createRuntime(t)).workItemRepo.insert({
      id,
      workspaceIdentity: t.identity,
      workspacePath: `/tmp/${t.identity}`,
      title: `项 ${id}`,
      body: "",
      status: "todo",
      assignee: { type: "user", id: "u1" },
      labels: [],
      properties: {},
      position: 0,
      ...over,
    });
  };
  await insertItem(WS, "wi-1");
  await insertItem(WS, "wi-2");
  await insertItem(WS_OTHER, "wi-cross");
  return {
    db,
    service: serviceFor(ACTOR),
    serviceFor,
    setEnabled: (value) => (state.enabled = value),
    setClock: (value) => (clock = value),
    insertItem,
  };
}

const rawCount = (db: DatabaseSync, workItemId: string): number =>
  (
    db
      .prepare("SELECT COUNT(*) AS n FROM work_item_reactions WHERE work_item_id = ?")
      .get(workItemId) as { n: number }
  ).n;

const rawRow = (db: DatabaseSync, workItemId: string): Record<string, unknown> | undefined => {
  const row = db
    .prepare(
      `SELECT id, workspace_key, work_item_id, author_kind, author_id, emoji, created_at
         FROM work_item_reactions WHERE work_item_id = ?`,
    )
    .get(workItemId) as Record<string, unknown> | undefined;
  return row ? { ...row } : undefined;
};

// ---------- A. 写入形状 / 返回形状 ----------

test("A1｜set on=true：恰写一行（库内逐列 = 注入身份 + 目标 workspace + 入参 emoji），返回操作后该工作项的全部行", async () => {
  const { db, serviceFor } = await makeWorld();
  // 固定时钟 + 固定 id：整条记录可与**字面量**逐字段对齐（不是拿实现算出来的值自证）。
  const service = serviceFor(ACTOR, () => 7_777);
  const rows = await service.setWorkItemReaction(WS, {
    workItemId: "wi-1",
    emoji: "👍",
    on: true,
  });
  assert.equal(rows.length, 1, "返回该工作项的反应行（不是 void、不是聚合分组）");
  assert.deepEqual(
    { ...rows[0], id: typeof rows[0]?.id },
    {
      id: "string",
      workspaceKey: "ws-a",
      workItemId: "wi-1",
      author: { kind: "human", id: "local-user" },
      emoji: "👍",
      createdAt: 7_777,
    },
    "返回形状 = 存储行（workspace 取目标绑定值、作者取注入身份、createdAt 取服务面时钟）",
  );
  assert.deepEqual(rawRow(db, "wi-1"), {
    id: rows[0]!.id,
    workspace_key: "ws-a",
    work_item_id: "wi-1",
    author_kind: "human",
    author_id: "local-user",
    emoji: "👍",
    created_at: 7_777,
  });
  db.close();
});

test("A2｜幂等：重复 on=true 返回**同值**、库里恰一行、既存行的时间戳不被重投改写", async () => {
  const { db, service, setClock } = await makeWorld();
  setClock(1_000);
  const first = await service.setWorkItemReaction(WS, {
    workItemId: "wi-1",
    emoji: "👍",
    on: true,
  });
  // 第二次换个时钟：若实现走「重写既存行」而不是 INSERT OR IGNORE + 回读，createdAt 会变。
  setClock(2_000);
  const second = await service.setWorkItemReaction(WS, {
    workItemId: "wi-1",
    emoji: "👍",
    on: true,
  });
  assert.deepEqual(second, first, "命中冲突 = 无变化：幂等语义返回同值");
  assert.equal(rawCount(db, "wi-1"), 1, "库里恰一行（同人同 emoji 不产生第二行）");
  assert.equal(rawRow(db, "wi-1")?.created_at, 1_000, "既存行的插入时间戳不被重投改写");
  db.close();
});

test("A3｜一人多 emoji 与多主体互不影响：返回插入序全部行、作者各自如实", async () => {
  const { db, service, serviceFor } = await makeWorld();
  await service.setWorkItemReaction(WS, { workItemId: "wi-1", emoji: "👍", on: true });
  await service.setWorkItemReaction(WS, { workItemId: "wi-1", emoji: "🎉", on: true });
  const other = serviceFor(OTHER);
  const rows = await other.setWorkItemReaction(WS, { workItemId: "wi-1", emoji: "👍", on: true });
  assert.equal(rows.length, 3, "同 emoji 换主体 = 另一行（唯一键含 author）");
  assert.deepEqual(
    rows.map((row) => [row.emoji, row.author.id]),
    [
      ["👍", "local-user"],
      ["🎉", "local-user"],
      ["👍", "someone-else"],
    ],
    "插入序（created_at ASC）：后来的同 emoji 不同主体排在末尾，不合并、不重排",
  );
  assert.equal(rawCount(db, "wi-1"), 3);
  db.close();
});

test("A4｜on=false 撤销：返回操作后的行；重复撤销不报错；不动别人的行", async () => {
  const { db, service, serviceFor } = await makeWorld();
  await service.setWorkItemReaction(WS, { workItemId: "wi-1", emoji: "👍", on: true });
  await serviceFor(OTHER).setWorkItemReaction(WS, { workItemId: "wi-1", emoji: "👍", on: true });

  const afterRemove = await service.setWorkItemReaction(WS, {
    workItemId: "wi-1",
    emoji: "👍",
    on: false,
  });
  assert.deepEqual(
    afterRemove.map((row) => row.author.id),
    ["someone-else"],
    "只撤掉自己的那一行（同 emoji 别人的反应照在）",
  );
  const retry = await service.setWorkItemReaction(WS, {
    workItemId: "wi-1",
    emoji: "👍",
    on: false,
  });
  assert.deepEqual(retry, afterRemove, "撤销不存在的反应 = 无变化、不报错（返回同值）");
  assert.equal(rawCount(db, "wi-1"), 1);
  db.close();
});

// ---------- B. emoji 护栏（服务面；存储不白名单） ----------

test("B1｜emoji 只剩两条闸：空串与超 32 字节拒（写之前，零行）；32 字节边界与自定义 token 都可落库", async () => {
  const { db, service } = await makeWorld();
  await assert.rejects(
    () => service.setWorkItemReaction(WS, { workItemId: "wi-1", emoji: "", on: true }),
    /emoji/,
    "空串必须被服务面拒绝（存储层 CHECK 是第二道，不能只靠它）",
  );
  await assert.rejects(
    () => service.setWorkItemReaction(WS, { workItemId: "wi-1", emoji: "x".repeat(33), on: true }),
    /emoji/,
    "超长必须被拒绝：护栏是防滥用（multica 服务端零校验，ZPaPa 只加这一条宽松上限）",
  );
  assert.equal(rawCount(db, "wi-1"), 0, "两次被拒都不许留下半行（写之前判）");

  // 32 字节边界（8 枚 4 字节 emoji）与非白名单内容：存储层不筛，服务面也不筛。
  const boundary = "👍".repeat(8);
  assert.equal(new TextEncoder().encode(boundary).length, 32, "边界值按字节算 = 32");
  await service.setWorkItemReaction(WS, { workItemId: "wi-1", emoji: boundary, on: true });
  await service.setWorkItemReaction(WS, {
    workItemId: "wi-1",
    emoji: ":custom_party_parrot:",
    on: true,
  });
  assert.equal(
    rawCount(db, "wi-1"),
    2,
    "边界值与自定义 token 都落库（白名单在 UI 层，不在服务面）",
  );
  db.close();
});

// ---------- C. 工作项归属（§8.5） ----------

test("C1｜工作项不存在：读与写同口径响亮抛，零写入", async () => {
  const { db, service } = await makeWorld();
  await assert.rejects(
    () => service.setWorkItemReaction(WS, { workItemId: "wi-missing", emoji: "👍", on: true }),
    /不存在/,
  );
  await assert.rejects(
    () => service.listWorkItemReactions(WS, { workItemId: "wi-missing" }),
    /不存在/,
  );
  assert.equal(rawCount(db, "wi-missing"), 0);
  db.close();
});

test("C2｜跨 workspace：异己工作项一律响亮拒（写零行、读不越界）；异 workspace 的同 id 行不出现在本 workspace 的读里", async () => {
  const { db, service } = await makeWorld();
  await assert.rejects(
    () => service.setWorkItemReaction(WS, { workItemId: "wi-cross", emoji: "👍", on: true }),
    /跨 workspace/,
    "目标指向别的 workspace 的工作项 ⇒ 响亮拒绝（不写进本 workspace 的表、也不写进别人的）",
  );
  await assert.rejects(
    () => service.listWorkItemReactions(WS, { workItemId: "wi-cross" }),
    /跨 workspace/,
  );
  assert.equal(rawCount(db, "wi-cross"), 0);

  // 存储层租户过滤：直接造一条**异 workspace**、同工作项 id 的行（绕过服务面），读不得串行。
  await service.setWorkItemReaction(WS, { workItemId: "wi-1", emoji: "👍", on: true });
  db.prepare(
    `INSERT INTO work_item_reactions (id, workspace_key, work_item_id, author_kind, author_id, emoji, created_at)
     VALUES ('r-foreign', 'ws-b', 'wi-1', 'human', 'local-user', '🎉', 5)`,
  ).run();
  const rows = await service.listWorkItemReactions(WS, { workItemId: "wi-1" });
  assert.deepEqual(
    rows.map((row) => row.emoji),
    ["👍"],
    "本 workspace 的读只出本 workspace 的行（workspace_key 是读路径的租户守卫）",
  );
  db.close();
});

test("C3｜已归档工作项：读与写都响亮抛（归档行视同不存在），零写入", async () => {
  const { db, service, insertItem } = await makeWorld();
  await insertItem(WS, "wi-archived", { archivedAt: 12_345 });
  await assert.rejects(
    () => service.setWorkItemReaction(WS, { workItemId: "wi-archived", emoji: "👍", on: true }),
    /已归档/,
  );
  await assert.rejects(
    () => service.listWorkItemReactions(WS, { workItemId: "wi-archived" }),
    /已归档/,
  );
  assert.equal(rawCount(db, "wi-archived"), 0);
  db.close();
});

// ---------- D. 身份注入链 ----------

test("D1｜未注入本机操作者身份：两个方法都响亮抛且零写入（不像 UI 自证身份）", async () => {
  const { db, serviceFor } = await makeWorld();
  const anonymous = serviceFor(null);
  await assert.rejects(
    () => anonymous.setWorkItemReaction(WS, { workItemId: "wi-1", emoji: "👍", on: true }),
    /localHumanActor|身份/,
  );
  await assert.rejects(
    () => anonymous.listWorkItemReactions(WS, { workItemId: "wi-1" }),
    /localHumanActor|身份/,
  );
  assert.equal(rawCount(db, "wi-1"), 0);
  db.close();
});

// ---------- E. 读取面与门禁 ----------

test("E1｜listWorkItemReactions：无反应 ⇒ 空数组（不是 undefined）；只读（行数不变）；插入序", async () => {
  const { db, service } = await makeWorld();
  assert.deepEqual(
    await service.listWorkItemReactions(WS, { workItemId: "wi-2" }),
    [],
    "零反应 = 空数组",
  );
  await service.setWorkItemReaction(WS, { workItemId: "wi-1", emoji: "🚀", on: true });
  await service.setWorkItemReaction(WS, { workItemId: "wi-1", emoji: "😕", on: true });
  const before = rawCount(db, "wi-1");
  const rows = await service.listWorkItemReactions(WS, { workItemId: "wi-1" });
  assert.deepEqual(
    rows.map((row) => row.emoji),
    ["🚀", "😕"],
    "插入序（先出现的排在前面；不按热度、不按 id 重排）",
  );
  assert.equal(rawCount(db, "wi-1"), before, "读不写库");
  assert.equal(rawCount(db, "wi-2"), 0, "读一个工作项不会碰到别的工作项");
  db.close();
});

test("E2｜不过门禁：实验开关关掉后 set / list 照常可用（reactions 与派发无关）", async () => {
  const { db, service, setEnabled } = await makeWorld();
  setEnabled(false);
  const rows = await service.setWorkItemReaction(WS, {
    workItemId: "wi-1",
    emoji: "👀",
    on: true,
  });
  assert.equal(rows.length, 1, "关掉实验开关只停新派发，不该连表情都不能加");
  assert.equal(
    (await service.listWorkItemReactions(WS, { workItemId: "wi-1" })).length,
    1,
    "读更不受门禁影响（与 listWakeRules / listWorkItemViews 同款）",
  );
  db.close();
});
