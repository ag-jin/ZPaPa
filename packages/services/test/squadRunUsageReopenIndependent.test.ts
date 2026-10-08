import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createSquadRuntime, type SquadRuntime } from "../src/workitem/squadRuntime.js";
import {
  isAwaitingBranchMemberRun,
  isSettleableResidualMemberRun,
  isTreelessOpenMemberRun,
} from "../src/workitem/squadRunLifecycle.js";
import type { SquadRunRecord, SquadRunUsageSnapshot } from "../src/workitem/squadRunRepo.js";

/* CT.V（#6 成本记账线整线独立复验）—— **重开联动**的独立复核（data plane，真 runtime）。

   两段各独立取证：
   ① **残行重开可达**：C1「结算 + 同 runId 重开」的残行形态（有行无树）经**真 lifecycle**
      重开后 ⇒ `session_id` 置回 null；此时该行仍 `usage_recorded_at IS NULL`（从未有过
      会话终态）⇒ 新会话的终态补拉**落得进去**（write-once 不挡路）——实现者结论的独立复现。
   ② **覆盖缺口现状钉住**：已记录的行在**今天的生产写者**下不可能回到 open：
      · 4 种终态（produced / merged / discarded / rejected，均带已记录用量）逐格走真
        `openMemberRun(same runId)` ⇒ 一律 `already_registered`、状态与用量逐列不动；
      · 三条重开判据（`isTreelessOpenMemberRun` / `isSettleableResidualMemberRun` /
        `isAwaitingBranchMemberRun`）对已记录形态逐条 false；
      · 但若**直接**把已记录行 setStatus 回 open（今日无此生产臂），write-once 会挡住新会话
        的覆盖 —— 这正是冲突登记的语义：缺口存在且被如实登记，不是被静默绕过。 */

const run = promisify(execFile);
const WS = "ctv-reopen-ws";

async function makeRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "ctv-reopen-"));
  await run("git", ["init", "-q", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.email", "t@t"], { cwd: root });
  await run("git", ["config", "user.name", "t"], { cwd: root });
  writeFileSync(join(root, "a.txt"), "1\n");
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["commit", "-qm", "init"], { cwd: root });
  return root;
}

async function makeRuntime(): Promise<{ repoRoot: string; runtime: SquadRuntime }> {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: WS,
    readExperimentEnabled: () => true,
  });
  return { repoRoot, runtime };
}

function addWorkItem(runtime: SquadRuntime, repoRoot: string, id: string): void {
  runtime.workItemRepo.insert({
    id,
    workspaceIdentity: WS,
    workspacePath: repoRoot,
    title: `标题-${id}`,
    body: "",
    status: "in_progress",
    assignee: { type: "user", id: "u1" },
    labels: [],
    properties: {},
    position: 0,
  });
}

const USAGE_LATE: SquadRunUsageSnapshot = {
  totalTokens: 424242,
  inputTokens: 111,
  outputTokens: 222,
  reasoningTokens: 333,
  cacheCreationTokens: 0,
  cacheReadTokens: 444,
  modelRequestCount: 5,
  modelErrorCount: 0,
};

test("重开联动①｜真 lifecycle 造残行 ⇒ 同 runId 重开 ⇒ 用量仍 NULL ⇒ 新会话补拉能落（write-once 不挡）", async () => {
  const { repoRoot, runtime } = await makeRuntime();
  const runId = "reopen-residual-1";
  const itemId = `wi-${runId}`;
  addWorkItem(runtime, repoRoot, itemId);

  const first = await runtime.lifecycle.openMemberRun({
    runId,
    workItemId: itemId,
    parentWorkItemId: itemId,
    agentId: "ta-reopen",
    isLeaderTask: false,
  });
  assert.equal(first.kind, "opened", "前置：第一次开跑建出真树");

  // 造 C1 残行形态（有行无树、分支无占用）：把刚建好的树与残枝收掉，再以同一 runId 重投。
  if (first.kind === "opened") {
    await run("git", ["worktree", "remove", "--force", first.worktreePath], { cwd: repoRoot });
    await run("git", ["branch", "-D", first.branch], { cwd: repoRoot });
  }

  const reopened = await runtime.lifecycle.openMemberRun({
    runId,
    workItemId: itemId,
    parentWorkItemId: itemId,
    agentId: "ta-reopen",
    isLeaderTask: false,
  });
  assert.equal(reopened.kind, "opened", "残行经真判据重开（C1：结算 + 同 runId 重开）");

  const afterReopen = runtime.squadRunRepo.get(runId)!;
  assert.equal(afterReopen.sessionId, null, "重开臂把 session_id 置回 null（另建会话）");
  assert.equal(
    afterReopen.usageRecordedAt,
    null,
    "重开前从未有过会话终态 ⇒ 用量仍 NULL（不存在「已被首写锁住」的前提）",
  );
  assert.equal(afterReopen.status, "open", "重开后的行是 open（等新会话终态）");

  // 新会话的终态补拉（数据面）：write-once 不挡 —— 因为首写从未发生。
  assert.deepEqual(runtime.squadRunRepo.recordUsage(runId, USAGE_LATE), { written: true });
  const recorded = runtime.squadRunRepo.get(runId)!;
  assert.deepEqual(
    [recorded.usageTotalTokens, recorded.usageReasoningTokens, typeof recorded.usageRecordedAt],
    [424242, 333, "number"],
    "重开后的第一次（也是唯一一次）落账成功 —— 记最后一次会话的累计值（Q5 冻结口径）",
  );
});

test("重开联动②｜已记录行（4 种终态）再调真 openMemberRun ⇒ already_registered，状态与用量逐列不动", async () => {
  const { repoRoot, runtime } = await makeRuntime();
  for (const status of ["produced", "merged", "discarded", "rejected"] as const) {
    const runId = `recorded-terminal-${status}`;
    const itemId = `wi-${runId}`;
    addWorkItem(runtime, repoRoot, itemId);
    // 真实终态行 + 真实落账（9 列同写同读）。
    runtime.squadRunRepo.insert({
      runId,
      workspaceKey: WS,
      workspacePath: repoRoot,
      workItemId: itemId,
      parentWorkItemId: itemId,
      agentId: "ta-terminal",
      isLeaderTask: false,
      branch: null,
      dirName: null,
      status,
      sessionId: "sess-done",
      dispatchCause: null,
      causedByRunId: null,
      openedAt: 1,
      settleReason: null,
      createdAt: 1,
      updatedAt: 1,
    });
    runtime.squadRunRepo.recordUsage(runId, USAGE_LATE);
    const before = runtime.squadRunRepo.get(runId)!;

    const again = await runtime.lifecycle.openMemberRun({
      runId,
      workItemId: itemId,
      parentWorkItemId: itemId,
      agentId: "ta-terminal",
      isLeaderTask: false,
    });
    assert.deepEqual(again, { kind: "already_registered" }, `${status}：不得被重开（不重复建树）`);

    const after = runtime.squadRunRepo.get(runId)!;
    assert.deepEqual(
      [after.status, after.usageTotalTokens, after.usageRecordedAt],
      [before.status, before.usageTotalTokens, before.usageRecordedAt],
      `${status}：状态与用量逐列不动（已记录行不是重开对象）`,
    );
  }
});

test("重开联动②｜三条重开判据对「已记录形态」逐条 false（结构前提：重开只认 open+无会话）", () => {
  const recorded: Pick<SquadRunRecord, "status" | "sessionId" | "branch" | "isLeaderTask"> = {
    status: "merged",
    sessionId: "sess-done",
    branch: "squad/member/aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbb",
    isLeaderTask: false,
  };
  const facts = {
    liveTreeBranches: new Set<string>(),
    liveTreeOfOtherRow: false,
    branchRefExists: false,
  };
  assert.equal(isTreelessOpenMemberRun(recorded, facts), false, "终态行不是残行");
  assert.equal(
    isSettleableResidualMemberRun(recorded, facts),
    false,
    "终态行不可「结算后立刻重开」",
  );
  assert.equal(isAwaitingBranchMemberRun(recorded), false, "终态行不是等待分支空出形态");
});

test("重开联动②｜缺口语义钉住：已记录行被**直接** setStatus 回 open（今日无生产臂）⇒ write-once 挡覆盖", async () => {
  const { repoRoot, runtime } = await makeRuntime();
  const runId = "recorded-forced-open";
  const itemId = `wi-${runId}`;
  addWorkItem(runtime, repoRoot, itemId);
  runtime.squadRunRepo.insert({
    runId,
    workspaceKey: WS,
    workspacePath: repoRoot,
    workItemId: itemId,
    parentWorkItemId: itemId,
    agentId: "ta-gap",
    isLeaderTask: false,
    branch: null,
    dirName: null,
    status: "merged",
    sessionId: "sess-first",
    dispatchCause: null,
    causedByRunId: null,
    openedAt: 1,
    settleReason: null,
    createdAt: 1,
    updatedAt: 1,
  });
  runtime.squadRunRepo.recordUsage(runId, USAGE_LATE);
  const firstRecordedAt = runtime.squadRunRepo.get(runId)!.usageRecordedAt;

  /* 模拟「已记录 + 回 open + 另建会话」这一**今日不可达**的形态（openMemberRun 的四条重开
     分支都要求 status==='open' 且 sessionId===null；已记录行的写入时机在终态之后）。 */
  runtime.squadRunRepo.setStatus(runId, "open", { sessionId: null, openedAt: Date.now() });
  const newer: SquadRunUsageSnapshot = { ...USAGE_LATE, totalTokens: 999999 };
  assert.deepEqual(
    runtime.squadRunRepo.recordUsage(runId, newer),
    { written: false },
    "冲突登记：write-once 挡住覆盖（新会话的 999999 落不进去）",
  );
  const after = runtime.squadRunRepo.get(runId)!;
  assert.deepEqual(
    [after.usageTotalTokens, after.usageRecordedAt],
    [USAGE_LATE.totalTokens, firstRecordedAt],
    "用量停在第一条会话；若将来出现该重开臂，需在 CT.1 让重开清 usage_recorded_at（本卡不改服务面）",
  );
});
