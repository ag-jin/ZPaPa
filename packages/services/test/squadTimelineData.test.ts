import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { resolveWorkspaceKey } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import { createSquadOrchestrator } from "../src/workitem/squadOrchestrator.js";
import { archiveSquadAndTransfer, createSquadRuntime } from "../src/workitem/squadRuntime.js";
import type { SquadRunRecord } from "../src/workitem/squadRunRepo.js";
import {
  SquadDispatchDisabledError,
  createSquadRuntimeService,
  type ISquadRuntimeService,
  type SquadWorkspaceTarget,
} from "../src/workitem/squadRuntimeService.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* 「活动时间线」（规格 §11.2）**数据面**的用例：`SquadRunRepo.listByWorkspace` +
   `ISquadRuntimeService.listSquadRuns`（2026-10-04 加法）。

   装配照 squadRosterManagement.test.ts 的同一先例：真实 git 仓库 + `:memory:` sqlite +
   真实 runtime + 真实服务面 —— 不给服务面塞桩，否则断言的是桩的行为而不是实现。
   台账行经 `runtime.squadRunRepo.insert` 落盘（真 repo、真 SQL），不手写 SQL。

   本文件钉住的核心问题是**两个口径之差**：`listActive`（还欠收尾：回收 / 快照用）与
   `listByWorkspace`（全部历史：时间线用）**不得互相替代**。用错口径不会报错 ——
   终态 run 会从历史里凭空消失（或活跃判据把历史当在途），故两条口径各有一条对照断言。 */

const target = (identity: string): SquadWorkspaceTarget => ({
  path: `/tmp/${identity}`,
  identity,
});

const WS = target("ws");
/** 台账 workspace_key 与 runtime 的绑定值同源（C14：identity 非空时优先于 path）——
    造行时用它，不猜字面量（猜错会让「读不到」被误读成方法的 bug）。 */
const WS_KEY = resolveWorkspaceKey({ workspacePath: "/tmp/ws", workspaceIdentity: "ws" });

/** 造一条 run 行（只覆写用例关心的字段；默认值覆盖「活跃队员 run」这一最常见形态）。 */
const run = (over: Partial<SquadRunRecord> = {}): SquadRunRecord => ({
  runId: "run-1",
  workspaceKey: WS_KEY,
  workspacePath: "/tmp/ws",
  workItemId: "wi-child-1",
  parentWorkItemId: "wi-batch-1",
  agentId: "ta-member",
  isLeaderTask: false,
  branch: "squad/member/aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbb",
  dirName: "aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb",
  status: "open",
  sessionId: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

/** 真实 runtime + 真实服务面（照 squadRosterManagement.test.ts 的装配法）。
    `makeRuntime` 一并返回：用例要经**同一条 db 的真 repo** 造台账行。 */
async function makeService(): Promise<{
  repoRoot: string;
  squadRuntimeService: ISquadRuntimeService;
  makeRuntime: (t: SquadWorkspaceTarget) => Promise<SquadRuntime>;
  seenTargets: string[];
  setExperimentEnabled: (value: boolean) => void;
}> {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const state = { enabled: true };
  /** 记录服务面收到的目标 —— 证明服务面把**调用方给的**目标原样交给 runtime。 */
  const seenTargets: string[] = [];
  const makeRuntime = (t: SquadWorkspaceTarget): Promise<SquadRuntime> =>
    createSquadRuntime({
      db,
      workspacePath: repoRoot,
      workspaceIdentity: t.identity,
      readExperimentEnabled: () => state.enabled,
    });
  const createRuntime = async (t: SquadWorkspaceTarget): Promise<SquadRuntime> => {
    seenTargets.push(`${t.path}|${t.identity}`);
    return makeRuntime(t);
  };
  const squadRuntimeService: ISquadRuntimeService = createSquadRuntimeService({
    createRuntime,
    readExperimentEnabled: async () => state.enabled,
    archiveSquadAndTransfer: async (t, id) => archiveSquadAndTransfer(await createRuntime(t), id),
    createOrchestrator: createSquadOrchestrator,
  });
  return {
    repoRoot,
    squadRuntimeService,
    makeRuntime,
    seenTargets,
    setExperimentEnabled: (value: boolean) => {
      state.enabled = value;
    },
  };
}

// ---------- ① 两个口径对照 ----------

test("listSquadRuns 读得到终态行（merged / discarded）；快照的 listActive 口径读不到", async () => {
  const { squadRuntimeService, makeRuntime } = await makeService();
  const runtime = await makeRuntime(WS);
  runtime.squadRunRepo.insert(run({ runId: "run-open", status: "open", createdAt: 1 }));
  runtime.squadRunRepo.insert(
    run({ runId: "run-merged", status: "merged", createdAt: 2, updatedAt: 20 }),
  );
  runtime.squadRunRepo.insert(
    run({ runId: "run-discarded", status: "discarded", createdAt: 3, updatedAt: 30 }),
  );

  const all = await squadRuntimeService.listSquadRuns(WS);
  assert.deepEqual(
    all.map((record) => record.runId),
    ["run-open", "run-merged", "run-discarded"],
    "历史口径：全状态（含已收尾的），按 created_at ASC —— 时间线要把整段历史画出来",
  );
  assert.equal(
    all.find((record) => record.runId === "run-merged")?.updatedAt,
    20,
    "终态行连同它的收尾时刻一起读回（渲染层站点 endAt 的来源）",
  );

  // 对照：getSnapshot().runs 是 listActive 的「还欠收尾」口径 —— 终态行**必须不在**里面。
  // 这条对照是两条口径**不得互相替代**的直接证据：若有人把 listSquadRuns 实现成 listActive，
  // 上面那条断言红；若把快照改成全量，这里红。
  const active = (await squadRuntimeService.getSnapshot(WS)).runs;
  assert.deepEqual(
    active.map((record) => record.runId),
    ["run-open"],
    "活跃口径只列未合并的 run（并入终态会把回收/处置判据的历史当成在途）",
  );
});

test("listSquadRuns({ parentWorkItemId }) 只回本批：不混别的批、不混别的 workspace", async () => {
  const { squadRuntimeService, makeRuntime } = await makeService();
  const runtime = await makeRuntime(WS);
  runtime.squadRunRepo.insert(run({ runId: "run-a1", parentWorkItemId: "wi-batch-a" }));
  runtime.squadRunRepo.insert(
    run({
      runId: "run-a2",
      parentWorkItemId: "wi-batch-a",
      status: "merged",
      createdAt: 2,
      updatedAt: 9,
    }),
  );
  runtime.squadRunRepo.insert(
    run({ runId: "run-b1", parentWorkItemId: "wi-batch-b", createdAt: 3 }),
  );
  /* 别的 workspace 的 run 不能出现在**本 workspace 的全量**里（key 是那道条件）。
     它刻意用**另一个** parentWorkItemId：批次分支复用的是既有 `listByParent` 口径
     （只按 parent_work_item_id 过滤、不带 workspace_key），而工作项 id 全局唯一 ⇒
     真实数据里不存在「两条批同 id」的碰撞；拿它造合成碰撞来断言，等于把不可达数据上的
     行为写成期望。workspace 隔离在**定义它的地方**（listByWorkspace）钉。 */
  runtime.squadRunRepo.insert(
    run({ runId: "run-other-ws", workspaceKey: "ws-other", parentWorkItemId: "wi-batch-other" }),
  );

  assert.deepEqual(
    (await squadRuntimeService.listSquadRuns(WS, { parentWorkItemId: "wi-batch-a" })).map(
      (record) => record.runId,
    ),
    ["run-a1", "run-a2"],
    "批次过滤走 listByParent 口径：含终态行（这条批的完整历史）",
  );
  assert.deepEqual(
    (await squadRuntimeService.listSquadRuns(WS)).map((record) => record.runId),
    ["run-a1", "run-a2", "run-b1"],
    "不给批次 = 本 workspace 全部（别的 workspace 的行不得混入）",
  );
});

// ---------- ② 排序（created_at ASC, run_id ASC） ----------

test("同刻两条（同毫秒）按 run_id ASC 定序 —— 同刻站点的次序必须确定", async () => {
  const { squadRuntimeService, makeRuntime } = await makeService();
  const runtime = await makeRuntime(WS);
  /* 故意**逆序**插入（z 先、a 后）且 created_at 相同：只按 created_at 排时，两行的相对次序
     取决于存储顺序（插入顺序）⇒ 本用例红；`run_id` tie-break 才把它钉成 a → z。
     这正是 ORDER_BY_CREATED 存在的理由：同刻写入的 run 不得随存储顺序漂移。 */
  runtime.squadRunRepo.insert(run({ runId: "run-z", createdAt: 100, updatedAt: 100 }));
  runtime.squadRunRepo.insert(run({ runId: "run-a", createdAt: 100, updatedAt: 100 }));
  runtime.squadRunRepo.insert(run({ runId: "run-earlier", createdAt: 99, updatedAt: 99 }));

  assert.deepEqual(
    (await squadRuntimeService.listSquadRuns(WS)).map((record) => record.runId),
    ["run-earlier", "run-a", "run-z"],
    "先按 created_at 升序，同刻按 run_id 升序（时间线从左到右、同刻按 id 定序）",
  );
  // 批次分支与全量分支共用同一条 ORDER_BY_CREATED：同刻排序在那里也必须成立。
  assert.deepEqual(
    (await squadRuntimeService.listSquadRuns(WS, { parentWorkItemId: "wi-batch-1" })).map(
      (record) => record.runId,
    ),
    ["run-earlier", "run-a", "run-z"],
  );
});

// ---------- ③ 目标纪律 / 门禁 ----------

test("目标纪律：两个分支都把调用方给的目标原样交给 runtime（没有隐式默认 workspace）", async () => {
  const { squadRuntimeService, seenTargets } = await makeService();
  seenTargets.length = 0;

  const given: SquadWorkspaceTarget = { path: "/tmp/given-ws", identity: "given" };
  await squadRuntimeService.listSquadRuns(given);
  await squadRuntimeService.listSquadRuns(given, { parentWorkItemId: "wi-batch-a" });

  assert.deepEqual(
    seenTargets,
    ["/tmp/given-ws|given", "/tmp/given-ws|given"],
    "全量与批次两条分支都必须带着调用方显式给的目标（原样透传，不挑不猜）",
  );
});

// 读历史**不过门禁**（§5.7.6 只停新派发）：开关关掉后仍应能查看已经跑过什么。
// 对照断言（同装配里新派发确实被拦）证明开关真的关着，本用例不是因为「开关没生效」才通过。
test("读历史不过门禁：实验关掉后 listSquadRuns 照常读到（同装配的新派发被拦下）", async () => {
  const { squadRuntimeService, makeRuntime, setExperimentEnabled } = await makeService();
  const runtime = await makeRuntime(WS);
  runtime.squadRunRepo.insert(
    run({ runId: "run-merged", status: "merged", createdAt: 1, updatedAt: 2 }),
  );

  setExperimentEnabled(false);

  await assert.rejects(
    () =>
      squadRuntimeService.createWorkItem(WS, {
        title: "门禁对照：这条派发必须被拦",
        assignee: { type: "user", id: "user" },
      }),
    SquadDispatchDisabledError,
    "对照：同一装配下新派发确实被门禁拦下（证明开关真的关着）",
  );

  assert.deepEqual(
    (await squadRuntimeService.listSquadRuns(WS)).map((record) => record.runId),
    ["run-merged"],
    "读历史不是新派发：开关关闭不拦读取",
  );
});
