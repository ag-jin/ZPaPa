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
  ISquadRuntimeService,
  type SquadWorkspaceTarget,
} from "../src/workitem/squadRuntimeService.js";
import {
  WORK_ITEM_VIEWS_PER_OWNER_MAX,
  WORK_ITEM_VIEW_FORBIDDEN_CODE,
  WORK_ITEM_VIEW_INVALID_CODE,
  WORK_ITEM_VIEW_NOT_FOUND_CODE,
  WORK_ITEM_VIEW_QUOTA_EXCEEDED_CODE,
  WORK_ITEM_VIEW_REVISION_CONFLICT_CODE,
} from "../src/workitem/workItemViewService.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* 保存视图**服务面**（`ISquadRuntimeService` 的六件：list / create / patch / delete + prefs get / put，
   R6a 切片 3/4）用例。装配照 `workItemSurfaceFieldsRuntimeService.test.ts` 的同一先例：真实 git 仓库 +
   `:memory:` sqlite + 真实 runtime + 真实服务面（不给服务面塞桩，否则断言的是桩的行为）。

   本文件承重的四组判据（逐条与 multica 取证对齐，见
   reports/2026-10-09-saved-views-multica-evidence.md §1/§2/§7）：
   ① **权限矩阵**（owner / 非 owner × private / shared × 读 / 改 / 删）：越权读与不存在**同码**
      （私有视图的存在性不泄露）；非 owner 改共享 ⇒ forbidden（看得见但改不动）。
   ② **my ⇒ private 两处写路径**：create **强制**（multica 同款改写，不报错）、patch **响亮拒绝**
      （非 private）。DB CHECK 在迁移用例里（第三处）。
   ③ **revision 409**：patch 必填 expectedRevision；CAS 未命中 ⇒ 冲突码且**一字不改**。
   ④ **query / display / prefs 只校验「是 JSON object」**（数组 / 标量 / null 一律拒）+ 128KiB 上限；
      服务端**不解释** facet（加 facet 不需要动服务端）。

   身份：视图 owner = 组合根注入的 `localHumanActor`（与 0018 创建人同一处定义点）；调用方**不能**
   自证身份（六件都没有 owner 入参）。未注入 ⇒ 响亮抛（用例 H）。 */

const ACTOR: WorkItemCreator = { kind: "human", id: "local-user" };
const OTHER: WorkItemCreator = { kind: "human", id: "someone-else" };

const target = (identity: string): SquadWorkspaceTarget => ({ path: `/tmp/${identity}`, identity });
const WS = target("ws-a");
const WS_OTHER = target("ws-b");

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return db;
}

/** 一次世界：一条 db + 一个按目标现构的 runtime 工厂 + 可造多个身份的服务面（共享同一条库）。 */
async function makeWorld(): Promise<{
  db: DatabaseSync;
  service: ISquadRuntimeService;
  serviceFor: (actor: WorkItemCreator | null) => ISquadRuntimeService;
  setEnabled: (enabled: boolean) => void;
}> {
  const repoRoot = await makeRepo();
  const db = makeDb();
  const state = { enabled: true };
  const createRuntime = async (t: SquadWorkspaceTarget): Promise<SquadRuntime> =>
    createSquadRuntime({
      db,
      workspacePath: repoRoot,
      workspaceIdentity: t.identity,
      readExperimentEnabled: () => state.enabled,
    });
  const serviceFor = (actor: WorkItemCreator | null): ISquadRuntimeService =>
    createSquadRuntimeService({
      createRuntime,
      readExperimentEnabled: async () => state.enabled,
      archiveSquadAndTransfer: async (t, id) => archiveSquadAndTransfer(await createRuntime(t), id),
      createOrchestrator: createSquadOrchestrator,
      ...(actor === null ? {} : { localHumanActor: () => actor }),
    });
  return {
    db,
    service: serviceFor(ACTOR),
    serviceFor,
    setEnabled: (value) => (state.enabled = value),
  };
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

const viewCount = (db: DatabaseSync): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM work_item_views").get() as { n: number }).n;

const rawView = (db: DatabaseSync, id: string): Record<string, unknown> | undefined => {
  const row = db
    .prepare(
      `SELECT name, owner_kind, owner_id, scope_type, visibility, definition_version, query,
              display, revision
       FROM work_item_views WHERE id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  return row ? { ...row } : undefined;
};

// ---------- A. create / list 形状与文档闸 ----------

test("A1｜create → list 逐字段读回：owner = 注入身份、revision 1、query/display 原样", async () => {
  const { db, service } = await makeWorld();
  const created = await service.createWorkItemView(WS, {
    name: "高优待办",
    scopeType: "workspace",
    visibility: "workspace",
    query: { statusFilters: ["todo"], priorityFilters: ["urgent", "high"] },
    display: { viewMode: "list", sortBy: "priority" },
  });
  assert.deepEqual(
    {
      owner: created.owner,
      name: created.name,
      scopeType: created.scopeType,
      visibility: created.visibility,
      definitionVersion: created.definitionVersion,
      query: created.query,
      display: created.display,
      revision: created.revision,
      workspaceKey: created.workspaceKey,
    },
    {
      owner: { kind: "human", id: "local-user" },
      name: "高优待办",
      scopeType: "workspace",
      visibility: "workspace",
      definitionVersion: 1,
      query: { statusFilters: ["todo"], priorityFilters: ["urgent", "high"] },
      display: { viewMode: "list", sortBy: "priority" },
      revision: 1,
      workspaceKey: "ws-a",
    },
  );
  assert.deepEqual(
    (await service.listWorkItemViews(WS)).map((view) => view.id),
    [created.id],
    "写盘后立刻出现在可见列表里（读回不是把入参原样回抛）",
  );
  db.close();
});

test("A2｜create 缺省：visibility=private、display={}、definitionVersion=1；get 无行 prefs = {}", async () => {
  const { service } = await makeWorld();
  const created = await service.createWorkItemView(WS, {
    name: "默认档",
    scopeType: "workspace",
    query: { statusFilters: [] },
  });
  assert.equal(created.visibility, "private", "缺省 private（multica 的 DEFAULT 同款）");
  assert.deepEqual(created.display, {}, "display 缺省 = 空文档");
  assert.equal(created.definitionVersion, 1);
  assert.deepEqual(
    await service.getWorkItemViewPrefs(WS),
    {},
    "无行 ⇒ 空文档 {}（不是 null、不是 404 —— multica no-rows 分支同款）",
  );
});

test("A3｜create my 档强制 private：显式传 workspace 也被改写成 private（裸读库证）", async () => {
  const { db, service } = await makeWorld();
  const created = await service.createWorkItemView(WS, {
    name: "我的视角",
    scopeType: "my",
    visibility: "workspace",
    query: {},
  });
  assert.equal(
    created.visibility,
    "private",
    "my 档共享没有意义 ⇒ 强制 private（multica 同款改写）",
  );
  assert.equal(rawView(db, created.id)?.visibility, "private", "裸读库：落盘的也是 private");
  assert.equal(rawView(db, created.id)?.scope_type, "my");
  db.close();
});

test("A4｜name 1..80 按码点计：80 枚 emoji 合法、81 枚 / 空串 / 非字符串 ⇒ invalid 且不落盘", async () => {
  const { db, service } = await makeWorld();
  const ok = await service.createWorkItemView(WS, {
    name: "😀".repeat(80),
    scopeType: "workspace",
    query: {},
  });
  assert.equal([...ok.name].length, 80);
  for (const badName of ["", "x".repeat(81), "😀".repeat(81), 42 as never]) {
    await rejectsWithCode(
      () => service.createWorkItemView(WS, { name: badName, scopeType: "workspace", query: {} }),
      WORK_ITEM_VIEW_INVALID_CODE,
    );
  }
  assert.equal(viewCount(db), 1, "被拒的 create 不得落盘");
  db.close();
});

test("A5｜query / display 只认 JSON object：数组 / 标量 / null / undefined ⇒ invalid 且不落盘", async () => {
  const { db, service } = await makeWorld();
  for (const bad of [[1, 2], "x", 3, null, undefined]) {
    await rejectsWithCode(
      () =>
        service.createWorkItemView(WS, {
          name: "坏文档",
          scopeType: "workspace",
          query: bad as never,
        }),
      WORK_ITEM_VIEW_INVALID_CODE,
    );
  }
  await rejectsWithCode(
    () =>
      service.createWorkItemView(WS, {
        name: "坏 display",
        scopeType: "workspace",
        query: {},
        display: [1] as never,
      }),
    WORK_ITEM_VIEW_INVALID_CODE,
  );
  assert.equal(viewCount(db), 0, "四条坏文档一条都不许落盘");
  db.close();
});

test("A6｜definitionVersion / scopeType / visibility 闭集与正整数闸（响亮，不静默改写）", async () => {
  const { service } = await makeWorld();
  const create = (over: Record<string, unknown>) =>
    service.createWorkItemView(WS, {
      name: "形状",
      scopeType: "workspace",
      query: {},
      ...over,
    } as never);
  await rejectsWithCode(() => create({ scopeType: "project" }), WORK_ITEM_VIEW_INVALID_CODE);
  await rejectsWithCode(() => create({ visibility: "team" }), WORK_ITEM_VIEW_INVALID_CODE);
  await rejectsWithCode(() => create({ definitionVersion: 0 }), WORK_ITEM_VIEW_INVALID_CODE);
  await rejectsWithCode(() => create({ definitionVersion: 1.5 }), WORK_ITEM_VIEW_INVALID_CODE);
  const versioned = await create({ definitionVersion: 3 });
  assert.equal(versioned.definitionVersion, 3, "正整数原样存（服务端只存不解释）");
});

test("A7｜载荷上限：query 超过 128KiB ⇒ invalid；恰好小文档 ⇒ 放行", async () => {
  const { service } = await makeWorld();
  const huge = { blob: "x".repeat(128 * 1024) };
  await rejectsWithCode(
    () => service.createWorkItemView(WS, { name: "巨型", scopeType: "workspace", query: huge }),
    WORK_ITEM_VIEW_INVALID_CODE,
  );
  const fine = await service.createWorkItemView(WS, {
    name: "正常",
    scopeType: "workspace",
    query: { blob: "x".repeat(1000) },
  });
  assert.ok(fine.id);
});

// ---------- B. 权限矩阵 ----------

test("B1｜list：owner 见自己的 private + 所有 shared；非 owner 只共享、不见他人 private", async () => {
  const { service, serviceFor } = await makeWorld();
  const other = serviceFor(OTHER);
  const minePrivate = await service.createWorkItemView(WS, {
    name: "我的私有",
    scopeType: "workspace",
    query: {},
  });
  const mineShared = await service.createWorkItemView(WS, {
    name: "我的共享",
    scopeType: "workspace",
    visibility: "workspace",
    query: {},
  });
  const theirPrivate = await other.createWorkItemView(WS, {
    name: "他的私有",
    scopeType: "workspace",
    query: {},
  });
  const theirShared = await other.createWorkItemView(WS, {
    name: "他的共享",
    scopeType: "workspace",
    visibility: "workspace",
    query: {},
  });

  assert.deepEqual(
    (await service.listWorkItemViews(WS)).map((view) => view.id).sort(),
    [minePrivate.id, mineShared.id, theirShared.id].sort(),
    "读权 = owner 或 shared（multica canReadIssueView 同款）",
  );
  assert.deepEqual(
    (await other.listWorkItemViews(WS)).map((view) => view.id).sort(),
    [theirPrivate.id, theirShared.id, mineShared.id].sort(),
  );
});

test("B1b｜list 带观察者归属：按 (kind, id) 两列与注入身份比；同一行对不同观察者相反", async () => {
  const { db, service, serviceFor } = await makeWorld();
  const other = serviceFor(OTHER);
  /* 同 id 不同 kind：owner 是**两列** —— `agent:local-user` 与 `human:local-user` 不是同一个人
     （与 UI 侧曾用 (kind, id) 比对的那条判据同一份语义，现在只在服务面算一次）。 */
  const twin = serviceFor({ kind: "agent", id: "local-user" });
  const mine = await service.createWorkItemView(WS, {
    name: "我的共享",
    scopeType: "workspace",
    visibility: "workspace",
    query: {},
  });
  const theirs = await other.createWorkItemView(WS, {
    name: "他的共享",
    scopeType: "workspace",
    visibility: "workspace",
    query: {},
  });
  const twinView = await twin.createWorkItemView(WS, {
    name: "同名 agent 的共享",
    scopeType: "workspace",
    visibility: "workspace",
    query: {},
  });

  const flagsFor = async (actor: ISquadRuntimeService): Promise<Map<string, unknown>> =>
    new Map((await actor.listWorkItemViews(WS)).map((view) => [view.id, view.ownedByViewer]));
  const asMe = await flagsFor(service);
  assert.equal(asMe.get(mine.id), true, "自己建的 ⇒ true");
  assert.equal(
    asMe.get(theirs.id),
    false,
    "别人共享的 ⇒ false（看得见 ≠ 是我的：改/删的入口据此收敛）",
  );
  assert.equal(
    asMe.get(twinView.id),
    false,
    "id 相同但 kind 不同（agent ≠ human）⇒ 不是同一个人（owner 是两列一起比）",
  );
  const asOther = await flagsFor(other);
  assert.equal(asOther.get(mine.id), false, "同一行在别人的列表里不是我的（归属随观察者变）");
  assert.equal(asOther.get(theirs.id), true, "镜像方向同样成立");
  db.close();
});

test("B2｜patch 权限：owner 可改；非 owner 改共享 ⇒ forbidden；改他人私有 ⇒ not_found（同码）", async () => {
  const { db, serviceFor } = await makeWorld();
  const owner = serviceFor(ACTOR);
  const other = serviceFor(OTHER);
  const shared = await owner.createWorkItemView(WS, {
    name: "共享视图",
    scopeType: "workspace",
    visibility: "workspace",
    query: {},
  });
  const privateView = await owner.createWorkItemView(WS, {
    name: "私有视图",
    scopeType: "workspace",
    query: {},
  });

  const patched = await owner.patchWorkItemView(WS, {
    id: shared.id,
    expectedRevision: 1,
    patch: { name: "我改名" },
  });
  assert.equal(patched.name, "我改名");
  assert.equal(patched.revision, 2);

  await rejectsWithCode(
    () =>
      other.patchWorkItemView(WS, {
        id: shared.id,
        expectedRevision: 2,
        patch: { name: "越权改" },
      }),
    WORK_ITEM_VIEW_FORBIDDEN_CODE,
  );
  const hiddenMessage = await rejectsWithCode(
    () =>
      other.patchWorkItemView(WS, {
        id: privateView.id,
        expectedRevision: 1,
        patch: { name: "看不见也要改" },
      }),
    WORK_ITEM_VIEW_NOT_FOUND_CODE,
  );
  const missingMessage = await rejectsWithCode(
    () =>
      other.patchWorkItemView(WS, {
        id: "no-such-view",
        expectedRevision: 1,
        patch: { name: "不存在" },
      }),
    WORK_ITEM_VIEW_NOT_FOUND_CODE,
  );
  assert.match(hiddenMessage, /不存在，或你无权读/);
  assert.match(
    missingMessage,
    /不存在，或你无权读/,
    "越权读与不存在**同码同文案**（存在性不泄露）",
  );
  assert.equal(rawView(db, shared.id)?.revision, 2, "越权 patch 不得 bump revision");
  assert.equal(rawView(db, privateView.id)?.revision, 1, "他人私有视图一个字都不许动");
  db.close();
});

test("B3｜delete 权限矩阵与 patch 同款：owner OK；非 owner shared ⇒ forbidden、他人 private / 不存在 ⇒ not_found", async () => {
  const { db, serviceFor } = await makeWorld();
  const owner = serviceFor(ACTOR);
  const other = serviceFor(OTHER);
  const shared = await owner.createWorkItemView(WS, {
    name: "共享",
    scopeType: "workspace",
    visibility: "workspace",
    query: {},
  });
  const privateView = await owner.createWorkItemView(WS, {
    name: "私有",
    scopeType: "workspace",
    query: {},
  });
  const own = await owner.createWorkItemView(WS, {
    name: "要删",
    scopeType: "workspace",
    query: {},
  });

  await rejectsWithCode(
    () => other.deleteWorkItemView(WS, { id: shared.id }),
    WORK_ITEM_VIEW_FORBIDDEN_CODE,
  );
  await rejectsWithCode(
    () => other.deleteWorkItemView(WS, { id: privateView.id }),
    WORK_ITEM_VIEW_NOT_FOUND_CODE,
  );
  await rejectsWithCode(
    () => other.deleteWorkItemView(WS, { id: "no-such-view" }),
    WORK_ITEM_VIEW_NOT_FOUND_CODE,
  );
  assert.equal(viewCount(db), 3, "越权删除不得删掉任何行");

  await owner.deleteWorkItemView(WS, { id: own.id });
  assert.equal(rawView(db, own.id), undefined, "owner 删自己的视图真的删掉了");
  await rejectsWithCode(
    () => owner.deleteWorkItemView(WS, { id: own.id }),
    WORK_ITEM_VIEW_NOT_FOUND_CODE,
  );
  db.close();
});

test("B4｜workspace 隔离：异 workspace 的 list 看不见、patch/delete 够不着（跨目标不得串台）", async () => {
  const { db, service } = await makeWorld();
  const created = await service.createWorkItemView(WS, {
    name: "共享",
    scopeType: "workspace",
    visibility: "workspace",
    query: {},
  });
  assert.deepEqual(
    await service.listWorkItemViews(WS_OTHER),
    [],
    "shared 只共享给**同一个** workspace",
  );
  await rejectsWithCode(
    () =>
      service.patchWorkItemView(WS_OTHER, {
        id: created.id,
        expectedRevision: 1,
        patch: { name: "x" },
      }),
    WORK_ITEM_VIEW_NOT_FOUND_CODE,
  );
  await rejectsWithCode(
    () => service.deleteWorkItemView(WS_OTHER, { id: created.id }),
    WORK_ITEM_VIEW_NOT_FOUND_CODE,
  );
  assert.equal(rawView(db, created.id)?.revision, 1, "跨 workspace 的写一个字都没落");
  db.close();
});

// ---------- C. revision 409 ----------

test("C1｜patch 是 CAS：revision 命中 ⇒ +1；旧 revision 再写 ⇒ 冲突码且一字不改", async () => {
  const { db, service } = await makeWorld();
  const created = await service.createWorkItemView(WS, {
    name: "第一版",
    scopeType: "workspace",
    query: { statusFilters: ["todo"] },
  });
  const second = await service.patchWorkItemView(WS, {
    id: created.id,
    expectedRevision: 1,
    patch: { name: "第二版", query: { statusFilters: ["done"] } },
  });
  assert.equal(second.revision, 2);
  assert.equal(second.name, "第二版");

  await rejectsWithCode(
    () =>
      service.patchWorkItemView(WS, {
        id: created.id,
        expectedRevision: 1,
        patch: { name: "基于旧版的写" },
      }),
    WORK_ITEM_VIEW_REVISION_CONFLICT_CODE,
  );
  const row = rawView(db, created.id);
  assert.equal(row?.revision, 2, "冲突写不得 bump revision");
  assert.equal(row?.name, "第二版", "冲突写一字不改（先读后写会盖掉别人刚改的）");
  assert.equal(row?.query, JSON.stringify({ statusFilters: ["done"] }));
  db.close();
});

test("C2｜patch 的 expectedRevision 必填且为正整数；空 patch ⇒ invalid（不做空写）", async () => {
  const { service } = await makeWorld();
  const created = await service.createWorkItemView(WS, {
    name: "待改",
    scopeType: "workspace",
    query: {},
  });
  for (const bad of [0, -1, 1.5, "1" as never, undefined as never]) {
    await rejectsWithCode(
      () =>
        service.patchWorkItemView(WS, {
          id: created.id,
          expectedRevision: bad as number,
          patch: { name: "x" },
        }),
      WORK_ITEM_VIEW_INVALID_CODE,
    );
  }
  await rejectsWithCode(
    () => service.patchWorkItemView(WS, { id: created.id, expectedRevision: 1, patch: {} }),
    WORK_ITEM_VIEW_INVALID_CODE,
  );
});

test("C3｜patch 未给字段保持现值（全量定义式：给的字段才写）", async () => {
  const { service } = await makeWorld();
  const created = await service.createWorkItemView(WS, {
    name: "原名",
    scopeType: "workspace",
    query: { statusFilters: ["todo"] },
    display: { viewMode: "board" },
  });
  const patched = await service.patchWorkItemView(WS, {
    id: created.id,
    expectedRevision: 1,
    patch: { display: { viewMode: "table" } },
  });
  assert.equal(patched.name, "原名", "未给的 name 保持现值");
  assert.deepEqual(patched.query, { statusFilters: ["todo"] }, "未给的 query 保持现值");
  assert.deepEqual(patched.display, { viewMode: "table" });
  assert.equal(patched.scopeType, "workspace", "scopeType 不在 patch 面（归属轴不可改）");
});

// ---------- D. my 档 patch 拒绝 ----------

test("D1｜patch 把 my 档改成 shared ⇒ invalid（multica「my views are always private」）；改回 private 放行", async () => {
  const { db, service } = await makeWorld();
  const created = await service.createWorkItemView(WS, {
    name: "我的视角",
    scopeType: "my",
    query: {},
  });
  await rejectsWithCode(
    () =>
      service.patchWorkItemView(WS, {
        id: created.id,
        expectedRevision: 1,
        patch: { visibility: "workspace" },
      }),
    WORK_ITEM_VIEW_INVALID_CODE,
  );
  assert.equal(rawView(db, created.id)?.visibility, "private", "被拒的 patch 不落盘");
  assert.equal(rawView(db, created.id)?.revision, 1);
  const ok = await service.patchWorkItemView(WS, {
    id: created.id,
    expectedRevision: 1,
    patch: { visibility: "private", name: "改名" },
  });
  assert.equal(ok.name, "改名");
  assert.equal(ok.revision, 2);
  db.close();
});

// ---------- E. 配额 ----------

test("E1｜配额 100：满额 ⇒ quota 码且不落盘；删一条后又能建（边界恰在 100）", async () => {
  const { db, service } = await makeWorld();
  const raw = db.prepare(
    `INSERT INTO work_item_views (id, workspace_key, owner_kind, owner_id, name, scope_type,
       visibility, definition_version, query, display, revision, created_at, updated_at)
     VALUES (?, 'ws-a', 'human', 'local-user', '批量', 'workspace', 'private', 1, '{}', '{}', 1, 1, 1)`,
  );
  for (let i = 0; i < WORK_ITEM_VIEWS_PER_OWNER_MAX; i++)
    raw.run(`seed-${String(i).padStart(3, "0")}`);
  await rejectsWithCode(
    () => service.createWorkItemView(WS, { name: "第 101 条", scopeType: "workspace", query: {} }),
    WORK_ITEM_VIEW_QUOTA_EXCEEDED_CODE,
  );
  assert.equal(
    viewCount(db),
    WORK_ITEM_VIEWS_PER_OWNER_MAX,
    "超限的 create 必须**在写之前**被拦下",
  );
  db.prepare("DELETE FROM work_item_views WHERE id = 'seed-000'").run();
  const created = await service.createWorkItemView(WS, {
    name: "第 100 条",
    scopeType: "workspace",
    query: {},
  });
  assert.ok(created.id, "删掉一条后配额重新可用（边界恰在 100）");
  db.close();
});

test("E2｜配额只算自己的：别人的 100 条不挤占我的额度（owner_kind + owner_id 两列）", async () => {
  const { db, serviceFor } = await makeWorld();
  const raw = db.prepare(
    `INSERT INTO work_item_views (id, workspace_key, owner_kind, owner_id, name, scope_type,
       visibility, definition_version, query, display, revision, created_at, updated_at)
     VALUES (?, 'ws-a', 'human', 'someone-else', '他的', 'workspace', 'private', 1, '{}', '{}', 1, 1, 1)`,
  );
  for (let i = 0; i < WORK_ITEM_VIEWS_PER_OWNER_MAX; i++)
    raw.run(`their-${String(i).padStart(3, "0")}`);
  const mine = await serviceFor(ACTOR).createWorkItemView(WS, {
    name: "我的第一条",
    scopeType: "workspace",
    query: {},
  });
  assert.ok(mine.id, "配额是每 owner 的（别人的额度与我无关）");
  db.close();
});

// ---------- F. prefs ----------

test("F1｜prefs：put 后 get 读回同一文档；整文档覆盖（不带旧键，无 revision）", async () => {
  const { db, service } = await makeWorld();
  const doc = { hidden: ["builtin:all"], order: ["view:v2", "view:v1"] };
  assert.deepEqual(await service.putWorkItemViewPrefs(WS, { prefs: doc }), doc);
  assert.deepEqual(await service.getWorkItemViewPrefs(WS), doc);
  const overwritten = await service.putWorkItemViewPrefs(WS, { prefs: { order: ["view:v1"] } });
  assert.deepEqual(overwritten, { order: ["view:v1"] });
  assert.deepEqual(
    await service.getWorkItemViewPrefs(WS),
    { order: ["view:v1"] },
    "整文档覆盖：旧的 hidden 键必须消失（merge 会把用户删掉的条目复活）",
  );
  const rows = db.prepare("SELECT COUNT(*) AS n FROM work_item_view_prefs").get() as { n: number };
  assert.equal(rows.n, 1, "同 owner 覆盖写不长第二行");
  db.close();
});

test("F2｜prefs 是每 owner 一份：非 owner 读到空文档、写自己的互不干扰", async () => {
  const { service, serviceFor } = await makeWorld();
  const other = serviceFor(OTHER);
  await service.putWorkItemViewPrefs(WS, { prefs: { tag: "mine" } });
  assert.deepEqual(await other.getWorkItemViewPrefs(WS), {}, "别人的偏好读不到（按 owner 隔离）");
  await other.putWorkItemViewPrefs(WS, { prefs: { tag: "theirs" } });
  assert.deepEqual(await service.getWorkItemViewPrefs(WS), { tag: "mine" });
  assert.deepEqual(await other.getWorkItemViewPrefs(WS), { tag: "theirs" });
});

test("F3｜prefs 只认 JSON object（数组/标量/null ⇒ invalid 且不落盘）+ 载荷上限", async () => {
  const { db, service } = await makeWorld();
  await service.putWorkItemViewPrefs(WS, { prefs: { hidden: [] } });
  for (const bad of [[1], "x", 7, null] as const) {
    await rejectsWithCode(
      () => service.putWorkItemViewPrefs(WS, { prefs: bad as never }),
      WORK_ITEM_VIEW_INVALID_CODE,
    );
  }
  await rejectsWithCode(
    () => service.putWorkItemViewPrefs(WS, { prefs: { blob: "x".repeat(128 * 1024) } }),
    WORK_ITEM_VIEW_INVALID_CODE,
  );
  assert.deepEqual(await service.getWorkItemViewPrefs(WS), { hidden: [] }, "被拒的 put 不改文档");
  db.close();
});

test("F4｜prefs 与门禁无关：实验开关关掉后六件照常可用（视图不是派发）", async () => {
  const { service, setEnabled } = await makeWorld();
  setEnabled(false);
  const created = await service.createWorkItemView(WS, {
    name: "关闸后",
    scopeType: "workspace",
    query: {},
  });
  await service.putWorkItemViewPrefs(WS, { prefs: {} });
  assert.equal((await service.listWorkItemViews(WS)).length, 1);
  await service.patchWorkItemView(WS, {
    id: created.id,
    expectedRevision: 1,
    patch: { name: "改" },
  });
  await service.deleteWorkItemView(WS, { id: created.id });
});

// ---------- G. 身份未接通 + 挂载 ----------

test("G1｜组合根未注入 localHumanActor：六件全部响亮抛（视图没有 owner 就没有权限语义）", async () => {
  const { serviceFor } = await makeWorld();
  const anonymous = serviceFor(null);
  const calls: Array<[string, () => Promise<unknown>]> = [
    ["list", () => anonymous.listWorkItemViews(WS)],
    [
      "create",
      () => anonymous.createWorkItemView(WS, { name: "x", scopeType: "workspace", query: {} }),
    ],
    [
      "patch",
      () => anonymous.patchWorkItemView(WS, { id: "x", expectedRevision: 1, patch: { name: "y" } }),
    ],
    ["delete", () => anonymous.deleteWorkItemView(WS, { id: "x" })],
    ["getPrefs", () => anonymous.getWorkItemViewPrefs(WS)],
    ["putPrefs", () => anonymous.putWorkItemViewPrefs(WS, { prefs: {} })],
  ];
  for (const [label, call] of calls) {
    await assert.rejects(call, /本机操作者身份/, `${label} 必须响亮抛（不许造无主视图）`);
  }
});

test("G2｜六件挂在 ISquadRuntimeService 上（描述符频道不变；六件都是函数）", async () => {
  const { service } = await makeWorld();
  for (const name of [
    "listWorkItemViews",
    "createWorkItemView",
    "patchWorkItemView",
    "deleteWorkItemView",
    "getWorkItemViewPrefs",
    "putWorkItemViewPrefs",
  ] as const) {
    assert.equal(
      typeof service[name],
      "function",
      `${name} 必须挂上服务面（漏挂 = 界面报 not a function）`,
    );
  }
  assert.equal(
    (ISquadRuntimeService as unknown as { channelName: string }).channelName,
    "squad-runtime",
    "描述符频道名一字不动（renderer 侧的 accessor 按它找服务）",
  );
});
