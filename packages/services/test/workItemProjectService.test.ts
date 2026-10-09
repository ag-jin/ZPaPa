import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { formatWorkItemIdentifier } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import { archiveSquadAndTransfer, createSquadRuntime } from "../src/workitem/squadRuntime.js";
import {
  ISquadRuntimeService,
  createSquadRuntimeService,
  type SquadWorkspaceTarget,
} from "../src/workitem/squadRuntimeService.js";
import { createSquadOrchestrator } from "../src/workitem/squadOrchestrator.js";
import {
  WORK_ITEM_NOT_FOUND_CODE,
  WORK_ITEM_PROJECT_INVALID_CODE,
  WORK_ITEM_PROJECT_NOT_FOUND_CODE,
  WORK_ITEM_PROJECT_SHORT_CODE_CONFLICT_CODE,
} from "../src/workitem/workItemProjectService.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* 项目**服务面**（`ISquadRuntimeService` 的五件：list / create / update / delete + setWorkItemProject；
   R-P1 切片 3/4）用例。装配照 `workItemViewService.test.ts` 的同一先例：真实 git 仓库 +
   `:memory:` sqlite + 真实 runtime + 真实服务面（不给服务面塞桩，否则断言的是桩的行为）。

   本文件承重的四组判据（逐条与 multica 取证对齐，见
   `reports/2026-10-09-multica-issue-project-binding.md` A1/A2）：
   ① **CRUD 与 workspace 隔离**：短码同 workspace 唯一、跨 workspace 可同名；项目行不串台；
   ② **校验矩阵**：name 必填 / 短码闭集 / status 闭集 / priority 闭集 / 日历日期 —— 坏值**零落盘**；
   ③ **挂接矩阵**：`setWorkItemProject` 的 `projectId | null` 语义（未知/跨域项目拒、跨域工作项拒、
      置空 = 回无项目）+ 创建/编辑工作项两条写路径的前缀快照；
   ④ **删项目 = 置空挂接**（不重写已签发编号）——挂接行的读回证明。

   身份与时钟：与视图/reactions 同一手法（`now` / `newId` 由服务面边界取，测试可钉死）。 */

const target = (identity: string): SquadWorkspaceTarget => ({ path: `/tmp/${identity}`, identity });
const WS = target("ws-a");
const WS_OTHER = target("ws-b");

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return db;
}

async function makeWorld(): Promise<{
  db: DatabaseSync;
  service: ISquadRuntimeService;
  createRuntime: (t: SquadWorkspaceTarget) => Promise<SquadRuntime>;
  setEnabled: (enabled: boolean) => void;
}> {
  const repoRoot = await makeRepo();
  const db = makeDb();
  const state = { enabled: true };
  /* 单调时钟（测试可钉死）：`listProjects` 按 `created_at ASC, id ASC` 排序 —— 同刻行的次序
     由随机 UUID 决定，用真实 `Date.now()` 会让「刚建的行出现在列表里」这条断言随机翻红。
     给每次写入不同的 tick，顺序判据才是确定的（tie-break 由 repo 用例单独钉住）。 */
  let tick = 1_000;
  const now = (): number => (tick += 1);
  const createRuntime = async (t: SquadWorkspaceTarget): Promise<SquadRuntime> =>
    createSquadRuntime({
      db,
      workspacePath: repoRoot,
      workspaceIdentity: t.identity,
      readExperimentEnabled: () => state.enabled,
    });
  const service = createSquadRuntimeService({
    createRuntime,
    readExperimentEnabled: async () => state.enabled,
    archiveSquadAndTransfer: async (t, id) => archiveSquadAndTransfer(await createRuntime(t), id),
    createOrchestrator: createSquadOrchestrator,
    localHumanActor: () => ({ kind: "human", id: "local-user" }),
    now,
  });
  return { db, service, createRuntime, setEnabled: (value) => (state.enabled = value) };
}

/** 断言某次调用以指定稳定码拒绝（返回错误原文，便于细分断言）。 */
async function rejectsWithCode(operation: () => Promise<unknown>, code: string): Promise<string> {
  try {
    await operation();
  } catch (error) {
    assert.equal(
      (error as { code?: unknown }).code,
      code,
      `期望以 ${code} 拒绝，实际：${(error as Error).message}`,
    );
    return (error as Error).message;
  }
  throw new Error(`期望以 ${code} 拒绝，但调用成功了`);
}

const projectRows = (db: DatabaseSync): Array<{ id: string; name: string; short_code: string }> =>
  db.prepare("SELECT id, name, short_code FROM projects ORDER BY id").all() as never;

test("B1｜校验矩阵：name 必填、短码形状、status 闭集、priority 闭集、日历日期 —— 坏值一律 invalid 且零落盘", async () => {
  const { db, service } = await makeWorld();
  const cases: Array<[string, () => Promise<unknown>]> = [
    ["name 空串", () => service.createProject(WS, { name: "", shortCode: "PLT" })],
    ["name 纯空白", () => service.createProject(WS, { name: "   ", shortCode: "PLT" })],
    ["短码小写", () => service.createProject(WS, { name: "甲", shortCode: "plt" })],
    ["短码过短", () => service.createProject(WS, { name: "甲", shortCode: "P" })],
    ["短码过长", () => service.createProject(WS, { name: "甲", shortCode: "ABCDEFGHI" })],
    ["短码含连字符", () => service.createProject(WS, { name: "甲", shortCode: "PL-T" })],
    [
      "status 闭集外",
      () =>
        service.createProject(WS, { name: "甲", shortCode: "PLT", status: "archived" as never }),
    ],
    [
      "priority 闭集外",
      () =>
        service.createProject(WS, { name: "甲", shortCode: "PLT", priority: "someday" as never }),
    ],
    [
      "startDate 非法",
      () => service.createProject(WS, { name: "甲", shortCode: "PLT", startDate: "2026-02-29" }),
    ],
    [
      "dueDate 形状错",
      () => service.createProject(WS, { name: "甲", shortCode: "PLT", dueDate: "10/09/2026" }),
    ],
  ];
  for (const [label, run] of cases) {
    const message = await rejectsWithCode(run, WORK_ITEM_PROJECT_INVALID_CODE);
    assert.ok(message.length > 0, `${label}：错误文本必须有内容（UI 直接展示）`);
  }
  assert.equal(projectRows(db).length, 0, "全部坏值都没有留下半截行（先过闸后落盘）");
  db.close();
});

test("C1｜updateProject：子集 patch + null 清空；空 patch ⇒ invalid；不存在 / 异 workspace ⇒ not_found（同码）", async () => {
  const { db, service } = await makeWorld();
  const created = await service.createProject(WS, {
    name: "平台",
    shortCode: "PLT",
    description: "老说明",
    icon: "🚀",
    priority: "high",
    dueDate: "2026-12-31",
  });
  const other = await service.createProject(WS_OTHER, { name: "别人", shortCode: "OTH" });

  const updated = await service.updateProject(WS, {
    id: created.id,
    patch: { name: "平台 v2", status: "in_progress", icon: null, priority: null },
  });
  assert.deepEqual(
    {
      name: updated.name,
      status: updated.status,
      icon: updated.icon,
      priority: updated.priority,
      description: updated.description,
      dueDate: updated.dueDate,
      shortCode: updated.shortCode,
    },
    {
      name: "平台 v2",
      status: "in_progress",
      icon: undefined,
      priority: undefined,
      description: "老说明",
      dueDate: "2026-12-31",
      shortCode: "PLT",
    },
    "patch 子集语义：未给的字段不动；null 清回未设置",
  );
  // 空 patch 是调用方接线错误：响亮拒，不做空写。
  await rejectsWithCode(
    () => service.updateProject(WS, { id: created.id, patch: {} }),
    WORK_ITEM_PROJECT_INVALID_CODE,
  );
  await rejectsWithCode(
    () => service.updateProject(WS, { id: "nope", patch: { name: "x" } }),
    WORK_ITEM_PROJECT_NOT_FOUND_CODE,
  );
  await rejectsWithCode(
    () => service.updateProject(WS, { id: other.id, patch: { name: "越界改" } }),
    WORK_ITEM_PROJECT_NOT_FOUND_CODE,
  );
  assert.equal(
    (await service.listProjects(WS_OTHER))[0]?.name,
    "别人",
    "异 workspace 的 update 没有落下任何改动",
  );

  await rejectsWithCode(
    () => service.deleteProject(WS, { id: "nope" }),
    WORK_ITEM_PROJECT_NOT_FOUND_CODE,
  );
  await service.deleteProject(WS, { id: created.id });
  assert.deepEqual(
    (await service.listProjects(WS)).map((row) => row.id),
    [],
    "删后列表不再含该行",
  );
  assert.equal((await service.listProjects(WS_OTHER)).length, 1, "另一个 workspace 的项目不受影响");
  db.close();
});

test("C2｜deleteProject = 置空挂接：挂到该项目的行 project_id 回 null、前缀快照保留；再删一次 ⇒ not_found", async () => {
  const { db, service } = await makeWorld();
  const project = await service.createProject(WS, { name: "平台", shortCode: "PLT" });
  const item = await service.createWorkItem(WS, {
    title: "挂到项目的项",
    assignee: { type: "user", id: "hu-1" },
  });
  // 先经 setWorkItemProject 挂上（这条路径的用例在 D 组；此处只用其结果构造前置态）。
  const bound = await service.setWorkItemProject(WS, {
    workItemId: item.id,
    projectId: project.id,
  });
  assert.equal(bound.projectId, project.id);

  await service.deleteProject(WS, { id: project.id });
  const raw = db
    .prepare("SELECT project_id, identifier_prefix FROM work_items WHERE id = ?")
    .get(item.id) as { project_id: string | null; identifier_prefix: string | null };
  assert.equal(raw.project_id, null, "挂接置 NULL（multica ON DELETE SET NULL 的等价物）");
  assert.equal(raw.identifier_prefix, "PLT", "已签发编号的前缀快照保留（不重写历史编号）");
  await rejectsWithCode(
    () => service.deleteProject(WS, { id: project.id }),
    WORK_ITEM_PROJECT_NOT_FOUND_CODE,
  );
  db.close();
});

test("D1｜setWorkItemProject 挂接矩阵：未知/跨域项目拒、跨域与已归档工作项拒、置空 = 回无项目（零脏写）", async () => {
  const { db, service } = await makeWorld();
  const project = await service.createProject(WS, { name: "平台", shortCode: "PLT" });
  const otherProject = await service.createProject(WS_OTHER, { name: "别人", shortCode: "OTH" });
  const item = await service.createWorkItem(WS, {
    title: "甲",
    assignee: { type: "user", id: "hu-1" },
  });
  const otherItem = await service.createWorkItem(WS_OTHER, {
    title: "乙",
    assignee: { type: "user", id: "hu-1" },
  });
  // 归档行视同不存在：直接改库把行归档（没有归档用例的入口）。
  const archived = await service.createWorkItem(WS, {
    title: "丙",
    assignee: { type: "user", id: "hu-1" },
  });
  db.prepare("UPDATE work_items SET archived_at = 1 WHERE id = ?").run(archived.id);

  const rawOf = (id: string): { project_id: string | null; identifier_prefix: string | null } => {
    const row = db
      .prepare("SELECT project_id, identifier_prefix FROM work_items WHERE id = ?")
      .get(id) as { project_id: string | null; identifier_prefix: string | null };
    return { project_id: row.project_id, identifier_prefix: row.identifier_prefix };
  };
  assert.deepEqual(
    rawOf(item.id),
    { project_id: null, identifier_prefix: null },
    "未挂接的工作项两列都是 NULL（「无项目」是初始真相）",
  );

  await rejectsWithCode(
    () => service.setWorkItemProject(WS, { workItemId: item.id, projectId: "ghost" }),
    WORK_ITEM_PROJECT_NOT_FOUND_CODE,
  );
  await rejectsWithCode(
    () => service.setWorkItemProject(WS, { workItemId: item.id, projectId: otherProject.id }),
    WORK_ITEM_PROJECT_NOT_FOUND_CODE,
  );
  assert.deepEqual(
    rawOf(item.id),
    { project_id: null, identifier_prefix: null },
    "被拒的两次零写入",
  );
  await rejectsWithCode(
    () => service.setWorkItemProject(WS, { workItemId: otherItem.id, projectId: project.id }),
    WORK_ITEM_NOT_FOUND_CODE,
  );
  await rejectsWithCode(
    () => service.setWorkItemProject(WS, { workItemId: archived.id, projectId: project.id }),
    WORK_ITEM_NOT_FOUND_CODE,
  );
  assert.deepEqual(rawOf(otherItem.id), { project_id: null, identifier_prefix: null });
  assert.deepEqual(rawOf(archived.id), { project_id: null, identifier_prefix: null });

  const bound = await service.setWorkItemProject(WS, {
    workItemId: item.id,
    projectId: project.id,
  });
  assert.equal(bound.projectId, project.id, "读回带上 projectId");
  assert.equal(bound.identifierPrefix, "PLT", "读回带上短码前缀快照");
  assert.deepEqual(rawOf(item.id), { project_id: project.id, identifier_prefix: "PLT" });

  const cleared = await service.setWorkItemProject(WS, { workItemId: item.id, projectId: null });
  assert.equal(cleared.projectId, undefined, "置空 ⇒ 读模型回落 undefined（未设置只有一种形态）");
  assert.equal(cleared.identifierPrefix, undefined);
  assert.deepEqual(
    rawOf(item.id),
    { project_id: null, identifier_prefix: null },
    "置空 = 回无项目：两列同置 NULL",
  );
  db.close();
});

test("B2｜短码唯一：同 workspace 重复 ⇒ 稳定码 short_code_conflict；另一个 workspace 同名合法", async () => {
  const { db, service } = await makeWorld();
  const first = await service.createProject(WS, { name: "平台", shortCode: "PLT" });
  const message = await rejectsWithCode(
    () => service.createProject(WS, { name: "另一个平台", shortCode: "PLT" }),
    WORK_ITEM_PROJECT_SHORT_CODE_CONFLICT_CODE,
  );
  assert.match(message, /PLT/, "错误文本带短码原值");
  const other = await service.createProject(WS_OTHER, { name: "别人的平台", shortCode: "PLT" });
  assert.notEqual(other.id, first.id);
  assert.equal(projectRows(db).length, 2, "冲突那次没有留下行；跨 workspace 的同码各自成立");
  db.close();
});

test("E1｜createWorkItem 带 projectId：前缀快照同写；不带 = 无项目；未知/跨域项目拒且零落盘", async () => {
  const { db, service } = await makeWorld();
  const project = await service.createProject(WS, { name: "平台", shortCode: "PLT" });
  const otherProject = await service.createProject(WS_OTHER, { name: "别人", shortCode: "OTH" });

  const bound = await service.createWorkItem(WS, {
    title: "挂项目的项",
    assignee: { type: "user", id: "hu-1" },
    projectId: project.id,
  });
  assert.equal(bound.projectId, project.id, "创建返回的读模型带 projectId");
  assert.equal(bound.identifierPrefix, "PLT", "短码快照在创建那一刻就写入（编号 = PLT-{序号}）");
  assert.equal(bound.identifierSeq, 1, "序号语义不动：仍是每 workspace 序列");
  /* UI 轮（R-P2）的接缝：读模型两列 + shared 的显示纯函数拼出编号文本 —— 服务侧不断言「UI 怎么渲染」，
     但断言「接缝的两半都在手上」（这正是 UI 只调一次函数就能显示的契约）。 */
  assert.equal(
    formatWorkItemIdentifier({ prefix: bound.identifierPrefix, seq: bound.identifierSeq }),
    "PLT-1",
    "有项目 ⇒ {短码}-{序号}（multica 形态）",
  );

  const bare = await service.createWorkItem(WS, {
    title: "无项目的项",
    assignee: { type: "user", id: "hu-1" },
  });
  assert.equal(bare.projectId, undefined, "不传 projectId ⇒ 无项目（不是空串、不是默认项目）");
  assert.equal(bare.identifierPrefix, undefined, "无项目 ⇒ 无前缀（编号显示回落 #N）");
  assert.equal(bare.identifierSeq, 2, "无项目的工作项照常占号（identifier 是永久标签）");
  assert.equal(
    formatWorkItemIdentifier({ prefix: bare.identifierPrefix, seq: bare.identifierSeq }),
    "#2",
    "无项目 ⇒ 既有 #N 形态",
  );

  await rejectsWithCode(
    () =>
      service.createWorkItem(WS, {
        title: "坏项",
        assignee: { type: "user", id: "hu-1" },
        projectId: "ghost",
      }),
    WORK_ITEM_PROJECT_NOT_FOUND_CODE,
  );
  await rejectsWithCode(
    () =>
      service.createWorkItem(WS, {
        title: "跨域项",
        assignee: { type: "user", id: "hu-1" },
        projectId: otherProject.id,
      }),
    WORK_ITEM_PROJECT_NOT_FOUND_CODE,
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM work_items").get() as { n: number }).n,
    2,
    "被拒的两次建项没有落盘（先过闸后写入）",
  );
  db.close();
});

test("E2｜updateWorkItem 的 patch.projectId：改挂换前缀 / null 清空 / 未知拒；与内容 patch 可同批", async () => {
  const { db, service } = await makeWorld();
  const project = await service.createProject(WS, { name: "平台", shortCode: "PLT" });
  const other = await service.createProject(WS, { name: "运维", shortCode: "OPS" });
  const item = await service.createWorkItem(WS, {
    title: "甲",
    assignee: { type: "user", id: "hu-1" },
  });
  assert.equal(item.projectId, undefined);

  const bound = await service.updateWorkItem(WS, {
    id: item.id,
    patch: { projectId: project.id },
  });
  assert.equal(bound.projectId, project.id, "只给 projectId 也是有效 patch（不是空 patch）");
  assert.equal(bound.identifierPrefix, "PLT");

  const moved = await service.updateWorkItem(WS, {
    id: item.id,
    patch: { title: "甲 v2", projectId: other.id },
  });
  assert.equal(moved.title, "甲 v2", "内容字段与挂接同批生效");
  assert.equal(moved.projectId, other.id, "改挂 ⇒ projectId 换项目");
  assert.equal(moved.identifierPrefix, "OPS", "改挂 ⇒ 前缀快照跟着更新（编号 = OPS-{序号}）");

  const cleared = await service.updateWorkItem(WS, { id: item.id, patch: { projectId: null } });
  assert.equal(cleared.projectId, undefined, "置空 ⇒ 回无项目");
  assert.equal(cleared.identifierPrefix, undefined, "置空 ⇒ 前缀同置 NULL（显示回落 #N）");

  await service.setWorkItemProject(WS, { workItemId: item.id, projectId: project.id });
  await rejectsWithCode(
    () => service.updateWorkItem(WS, { id: item.id, patch: { projectId: "ghost" } }),
    WORK_ITEM_PROJECT_NOT_FOUND_CODE,
  );
  const after = await service.updateWorkItem(WS, { id: item.id, patch: { body: "改正文" } });
  assert.equal(after.projectId, project.id, "被拒的改挂没有改动既有挂接");
  assert.equal(after.identifierPrefix, "PLT", "前缀也没有被清掉（同生共死）");
  assert.equal(after.body, "改正文", "不涉及挂接的内容 patch 照常生效");
  assert.equal(
    after.projectId,
    project.id,
    "内容 patch 不得顺手清挂接（两列只在显式给 projectId 时动）",
  );
  db.close();
});

test("A1｜createProject → listProjects 逐字段读回：默认 status=planned、可空字段 undefined、workspaceKey=目标身份", async () => {
  const { db, service } = await makeWorld();
  const created = await service.createProject(WS, {
    name: "平台重构",
    shortCode: "PLT",
    description: "把老的 runner 拆掉",
    icon: "🚀",
    priority: "high",
    startDate: "2026-10-01",
    dueDate: "2026-12-31",
  });
  assert.deepEqual(
    {
      name: created.name,
      shortCode: created.shortCode,
      description: created.description,
      icon: created.icon,
      status: created.status,
      priority: created.priority,
      startDate: created.startDate,
      dueDate: created.dueDate,
      workspaceKey: created.workspaceKey,
    },
    {
      name: "平台重构",
      shortCode: "PLT",
      description: "把老的 runner 拆掉",
      icon: "🚀",
      status: "planned",
      priority: "high",
      startDate: "2026-10-01",
      dueDate: "2026-12-31",
      workspaceKey: "ws-a",
    },
    "创建返回读回的形状（status 缺省 planned；不是把入参原样回抛）",
  );
  // 最小输入：只有 name + shortCode ⇒ 其余可空字段读回 undefined（「未设置」只有一种形态）。
  const bare = await service.createProject(WS, { name: "运维", shortCode: "OPS" });
  assert.equal(bare.description, undefined);
  assert.equal(bare.icon, undefined);
  assert.equal(bare.priority, undefined);
  assert.equal(bare.startDate, undefined);
  assert.equal(bare.dueDate, undefined);
  assert.equal(bare.status, "planned");
  assert.equal(bare.id.length > 0, true, "id 由服务面生成");
  assert.equal(bare.createdAt > 0, true, "时间戳由服务面取");

  assert.deepEqual(
    (await service.listProjects(WS)).map((row) => row.id),
    [created.id, bare.id],
    "写入后立刻出现在列表里（读回不是把入参原样回抛）",
  );
  // 跨 workspace：同短码在另一目标合法；列表互不串台（SQL 层 workspace 守卫）。
  const other = await service.createProject(WS_OTHER, { name: "别人的平台", shortCode: "PLT" });
  assert.deepEqual(
    (await service.listProjects(WS_OTHER)).map((row) => row.id),
    [other.id],
    "另一 workspace 只看得见自己的项目",
  );
  assert.deepEqual(
    (await service.listProjects(WS)).map((row) => row.id),
    [created.id, bare.id],
    "本 workspace 列表不受另一 workspace 影响",
  );
  assert.equal(projectRows(db).length, 3, "三行都在库里（同短码两行分属两个 workspace）");
  db.close();
});
