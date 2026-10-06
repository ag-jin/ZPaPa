/* X2.2 独立复验（test-verifier）：验收卡 §5.7「不撞车（核心）」的**合成行为级**用例。

   任务卡要求的四条（重投恰一次 / 不重复 Run / 不复活 / 与队列-义务回路不撞车）里，
   前三条在 desktop 侧只有纯函数与结构守卫证据（host 执行体不可 import）；本文件在**可独立
   运行的缝合面**上把第四条走通：真实 runtime + 真实 git 工作树 + 真实评论服务 + 真实义务表，
   按 host 真实发生顺序编排 —— 评论 pending →（别的派发占了活跃 run）→ 补投走同一
   `openMemberRun` → 义务表**一行** → 结算 → 认领**恰一次** → 重放 → receipt 收敛。

   期望值取契约面（outcome 七值闭集、义务表唯一键、`SQUAD_RUN_ACTIVE_STATUSES` 活跃口径），
   不读实现中间量。host 的「谁在什么时候调这两个入口」仍属结构面（见 desktop 用例）。

   第二个用例（X2.2 复验发现，如实登记）：**同对重放要求前一条 run 的分支已被回收**——
   分支名是 (workItem, agent) 的函数（`planBranches`），失败 run 的分支要等
   `reapStartupOrphans` 才释放；在此之前重放会「撞分支名」确定性失败。同一条 `openMemberRun`
   也被 R2 改派义务重放使用 ⇒ 这是 C 组既有约束、不是 X2.2 引入，但它落在本卡
   「义务到期后重放恰一次」的判据面内，故必须留下可复现的实体证据。 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { computeCommentDispatchKey } from "../src/workitem/commentDispatchKey.js";
import { createCommentDispatchReceiptRepo } from "../src/workitem/commentDispatchReceiptRepo.js";
import { createCommentService } from "../src/workitem/commentService.js";
import type { SquadDispatchRequest } from "../src/workitem/squadDispatchRequests.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import { createWorkItemCommentRepo, type AuthorRef } from "../src/workitem/workItemCommentRepo.js";
import { createWorkItemCommentReactionRepo } from "../src/workitem/workItemCommentReactionRepo.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import { makeRepo } from "./helpers/gitFixture.js";

const WS = "vx-pipe-ws";
const CLOCK = 633_000;
const HUMAN: AuthorRef = { kind: "human", id: "vx-pipe-human", displayName: "人" };

/** 缝合夹具：真实 git 仓库 + 真实 runtime + 评论服务（消费 runtime 的同一批 repo）。 */
async function setup() {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: WS,
    readExperimentEnabled: () => true,
  });
  // 门面有闸：有定义 ⇒ openMemberRun 走「容量/排队/义务」的裁决（无定义则直开，覆盖不到本用例）。
  const agent = runtime.teamAgentService.create({
    name: "collide",
    systemPrompt: "s",
    memoryScope: "project",
    maxConcurrentRuns: 1,
  });
  const itemId = "vx-pipe-wi";
  runtime.workItemRepo.insert({
    id: itemId,
    workspaceIdentity: WS,
    workspacePath: repoRoot,
    title: "不撞车",
    body: "",
    status: "todo",
    assignee: { type: "agent", id: agent.id },
    labels: [],
    properties: {},
    position: 0,
  });
  const receipts = createCommentDispatchReceiptRepo(db);
  const published: SquadDispatchRequest[] = [];
  const service = createCommentService({
    comments: createWorkItemCommentRepo(db),
    activities: createWorkItemActivityRepo(db),
    receipts,
    reactions: createWorkItemCommentReactionRepo(db),
    runs: runtime.squadRunRepo,
    deferred: runtime.squadDeferredDispatchRepo,
    workItems: runtime.workItemRepo,
    roster: { listAgents: () => [{ id: agent.id, name: "collide" }], listSquads: () => [] },
    readDispatchEnabled: () => true,
    publishDispatchRequest: (request) => published.push(request),
    now: () => CLOCK,
    newId: () => "vx-pipe-gen",
  });
  const dispatchKey = computeCommentDispatchKey({
    workspaceKey: WS,
    workItemId: itemId,
    targetAgentId: agent.id,
    commentId: "vx-pipe-c1",
  });
  const openFor = (runId: string, origin?: "comment") =>
    runtime.lifecycle.openMemberRun({
      runId,
      workItemId: itemId,
      parentWorkItemId: itemId,
      agentId: agent.id,
      isLeaderTask: false,
      ...(origin !== undefined ? { origin } : {}),
    });
  const activeRunIds = (): string[] => runtime.squadRunRepo.listActive(WS).map((row) => row.runId);
  const ledger = (): Array<[string, string]> =>
    runtime.squadRunRepo.listByWorkspace(WS).map((row) => [row.runId, row.status]);
  const branchExists = async (branch: string): Promise<boolean> =>
    (await runtime.git(["rev-parse", "-q", "--verify", `refs/heads/${branch}`], { cwd: repoRoot }))
      .code === 0;

  /* ① 评论先到：此刻没有任何执行载体 ⇒ 队列状态窗落 pending 并**外发**一次。 */
  const created = service.createComment({
    workspaceKey: WS,
    workspacePath: repoRoot,
    workItemId: itemId,
    id: "vx-pipe-c1",
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "@collide 处理一下",
  });
  assert.equal(
    created.dispatches[0]?.outcome,
    "pending",
    "前置：无执行载体 ⇒ pending（不是 deferred/coalesced）",
  );
  assert.deepEqual(
    published.map((request) => [request.dispatchKey, request.cause, request.targetAgentId]),
    [[dispatchKey, "comment", agent.id]],
    "pending 才外发；成因 comment；目标 = 点名者",
  );

  /* ② 补投前窗口变化：别的派发先给同一 (workItem, agent) 开了一条活跃 run（占树 + 占容量）。 */
  const other = await openFor("vx-pipe-other");
  assert.equal(other.kind, "opened");
  const otherBranch = other.kind === "opened" ? other.branch : "";
  assert.deepEqual(activeRunIds(), ["vx-pipe-other"]);

  /* ③ 补投 = 经同一 openMemberRun（目标/身份取自 receipt 事实）⇒ 不建第二条 run，落义务一行。 */
  const redispatch = await openFor(dispatchKey, "comment");
  assert.equal(redispatch.kind, "deferred", "活跃 run 占对 ⇒ 登记完成重放义务（不排队不注入）");
  assert.deepEqual(
    ledger(),
    [["vx-pipe-other", "open"]],
    "补投不得抢开 run（§5.2 评论侧只有请求事实）",
  );
  assert.deepEqual(
    runtime.squadDeferredDispatchRepo
      .list(WS)
      .map((row) => [row.runId, row.origin, row.dispatchCause]),
    [[dispatchKey, "comment", null]],
    "义务表**恰一行**、id = 请求身份、来源 = comment（不撞队列/改派义务）",
  );
  // 结算回写（host 拿到 deferred 落点后写）：只动未收敛两值。
  assert.equal(
    receipts.settleIfUnsettled({ dispatchKey, outcome: "deferred", updatedAt: CLOCK + 1 }),
    true,
  );
  assert.deepEqual(
    receipts.listUnsettledByWorkspace(WS).map((row) => [row.dispatchKey, row.outcome]),
    [[dispatchKey, "deferred"]],
    "补投扫描的取数面：本 workspace 只剩这一条未收敛",
  );
  return {
    runtime,
    receipts,
    dispatchKey,
    openFor,
    activeRunIds,
    ledger,
    branchExists,
    repoRoot,
    otherBranch,
  };
}

test("X2.2 不撞车（合成）：占树 run 收尾并回收分支后 ⇒ 认领恰一次、重放恰一次、receipt 收敛", async () => {
  const f = await setup();
  /* ④ 占树的 run 收尾（失败）⇒ 义务到期，认领**恰一次**（第二次为空）。 */
  await f.runtime.lifecycle.failMemberRun({
    runId: "vx-pipe-other",
    reason: "verify-no-collision",
  });
  assert.deepEqual(f.activeRunIds(), [], "收尾后目标对离开活跃集（义务的到期判据）");
  assert.deepEqual(
    f.runtime.squadDeferredDispatchRepo.claimDue(WS).map((row) => row.runId),
    [f.dispatchKey],
    "到期认领恰一次",
  );
  assert.deepEqual(
    f.runtime.squadDeferredDispatchRepo.claimDue(WS),
    [],
    "重复认领为空（恰一次的负向半边）",
  );

  /* ⑤ 回收失败 run 的残枝（生产里由启动回收器做）后，重放经唯一实现真开一条。 */
  const reap = await f.runtime.lifecycle.reapStartupOrphans({ workspaceKey: WS });
  assert.ok(
    reap.reclaimedBranches.includes(f.otherBranch),
    `失败 run 的分支应先被回收，实际 reclaimed=${JSON.stringify(reap.reclaimedBranches)}`,
  );
  assert.equal(await f.branchExists(f.otherBranch), false, "前置：残枝已删");
  const replay = await f.openFor(f.dispatchKey, "comment");
  assert.equal(replay.kind, "opened", "义务重放 = 真开 run（不是把义务行当 run 现造）");
  assert.equal(
    f.receipts.settleIfUnsettled({
      dispatchKey: f.dispatchKey,
      outcome: "opened",
      updatedAt: CLOCK + 2,
    }),
    true,
  );

  /* 终局事实：同对活跃 run 恒 ≤ 1；未收敛面为空；义务已履行。 */
  assert.deepEqual(f.activeRunIds(), [f.dispatchKey], "活跃集恰一条：没有任何一格多开了 run");
  assert.deepEqual(
    f.ledger().sort(),
    [
      [f.dispatchKey, "open"],
      ["vx-pipe-other", "discarded"],
    ],
    "全量台账：重放行 open，占树行已是终态",
  );
  assert.deepEqual(f.runtime.squadDeferredDispatchRepo.list(WS), [], "义务已履行（行删除）");
  assert.deepEqual(
    f.receipts.listUnsettledByWorkspace(WS),
    [],
    "收敛终局：未收敛面为空（补投扫描此后一行就走完）",
  );
});

test("X2.2 复验发现：残枝未回收时同对重放确定性失败，台账留下「有行无树」的 open 行", async () => {
  const f = await setup();
  await f.runtime.lifecycle.failMemberRun({
    runId: "vx-pipe-other",
    reason: "verify-no-collision",
  });
  assert.deepEqual(
    f.runtime.squadDeferredDispatchRepo.claimDue(WS).map((row) => row.runId),
    [f.dispatchKey],
    "前置：义务已被认领（claimDue 是删除式认领）",
  );
  // 不回收残枝就直接重放（host 的结算事件会立刻走到这一步）：撞分支名 ⇒ 确定性失败。
  await assert.rejects(
    () => f.openFor(f.dispatchKey, "comment"),
    /已被另一工作树占用|already exists/,
    "同一 (workItem, agent) 的分支名是确定的：残枝未回收 ⇒ 重放撞名",
  );
  assert.equal(await f.branchExists(f.otherBranch), true, "此时残枝确实还在（不是测试夹具有问题）");

  /* 事实面（建树失败后库里到底是什么 —— 生命周期契约是「台账先行」，行不因建树失败消失）： */
  const row = f.runtime.squadRunRepo.get(f.dispatchKey)!;
  assert.equal(row.status, "open", "台账行保留在 open（建树失败不回滚登记）");
  assert.equal(row.sessionId, null, "没有会话（失败发生在建会话之前）");
  const trees = await f.runtime.worktreeManager.list();
  assert.equal(trees.length, 1, "只剩失败 run 留下的那棵残树（重放没有新增第二棵）");
  assert.equal(trees[0]!.branch, f.otherBranch, "残树就是失败 run 的分支（尚未回收）");
  assert.deepEqual(
    f.activeRunIds(),
    [f.dispatchKey],
    "活跃集因此多了一条「有行无树」的 run（不是 0 条）",
  );
  assert.deepEqual(
    f.runtime.squadDeferredDispatchRepo.list(WS),
    [],
    "义务已被消耗：不再有义务通道兜它",
  );
  assert.deepEqual(
    f.receipts.listUnsettledByWorkspace(WS).map((r) => [r.dispatchKey, r.outcome]),
    [[f.dispatchKey, "deferred"]],
    "receipt 仍停 deferred：下次扫描仍会读到它",
  );

  /* 再扫一次：残行（有行无树）+ 分支仍被未回收的活树占着 ⇒ **等待型结论**（C1 插队轮修）：
     既不复用别人的树，也不把这条请求结算掉（结算是终局 ⇒ 它从此没有可执行的 run 身份）。
     修前这里返回 `{ kind: "already_registered" }`，host 手里没有工作树 ⇒ 按队员缺树判
     **permanent 失败** ⇒ 评论 receipt 落终局 failed —— 即使回收器随后会清残枝，请求也永不执行。
     修后 receipt 保持未收敛，等回收器清残枝后重投自愈（那时残行按 `opened` 重开新树）。 */
  assert.deepEqual(await f.openFor(f.dispatchKey, "comment"), {
    kind: "residual_blocked",
    branch: f.otherBranch,
  });
  assert.equal(await f.branchExists(f.otherBranch), true, "幂等臂不回补残枝：残枝只能等回收器");
});
