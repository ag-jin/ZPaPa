import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createCommentDispatchReceiptRepo } from "../src/workitem/commentDispatchReceiptRepo.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import { createWorkItemCollaborationService } from "../src/workitem/workItemCollaborationService.js";
import { createWorkItemCommentReactionRepo } from "../src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemCommentRepo } from "../src/workitem/workItemCommentRepo.js";
import { createWorkItemDecisionRepo } from "../src/workitem/workItemDecisionRepo.js";
import { createWorkItemPullRequestEntry } from "../src/workitem/workItemPullRequestEntry.js";

/* #8 D3：**PR merge 驱动终态**（设计 §4.2 的次序硬约束 / §7 的外联链）。

   ```
   读工作项当前状态 → 已终态：跳过终态判定（仍可刷新快照）
   → 快照刷新 → state=merged && 工作项 in_review ⇒ transition(done, expect=in_review)
       未命中 ⇒ 不抛（别人先动了状态，CAS 输家静默 + 留痕 —— 同 completeMemberRun 的纪律）
   → Activity 回声 pr_merged（**transition 命中才有**）
   ```

   驱动点是**调用点**（`workItemPullRequestEntry.refresh`，UI 的手动刷新直达）而不是同步深模块：
   `pullRequestSync` 拿不到状态机（D2 的结构守卫钉住），终态判定必须由拿得到 `workItemService` 的那一层做
   —— 唯一写者仍是 `WorkItemService.transition`（本片不新增任何状态写入路径）。

   本文件的 seam：真 runtime + 真迁移 + 真协作门面，网络面是注入的 fetch stub（真网络人工演示）。 */

const WS = "terminal-ws";
const HUMAN = { kind: "human" as const, id: "u-1" };

/** GitHub `GET /pulls/{n}` 的响应 stub：默认 **merged**（本文件的主题）。 */
function pullResponse(over: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      number: 7,
      state: "closed",
      draft: false,
      merged: true,
      merged_at: "2025-01-02T03:04:05Z",
      title: "Merged widget",
      head: { ref: "squad/integration/wi-terminal", sha: "sha-merged" },
      mergeable: true,
      mergeable_state: "clean",
      ...over,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function setup(
  options: { status?: "in_review" | "in_progress" | "done"; response?: () => Response } = {},
) {
  const workspacePath = mkdtempSync(join(tmpdir(), "terminal-"));
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const fetchCalls: string[] = [];
  const runtime = await createSquadRuntime({
    db,
    workspacePath,
    workspaceIdentity: WS,
    readExperimentEnabled: () => true,
    readGithubPullRequestToken: () => "ghp_terminal_stub",
    githubFetch: (async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      return (options.response ?? pullResponse)();
    }) as typeof fetch,
  });
  const repos = {
    comments: createWorkItemCommentRepo(db),
    activities: createWorkItemActivityRepo(db),
    decisions: createWorkItemDecisionRepo(db),
    reactions: createWorkItemCommentReactionRepo(db),
    receipts: createCommentDispatchReceiptRepo(db),
  };
  const service = createWorkItemCollaborationService({
    createRuntime: async () => runtime,
    getRepos: () => repos,
    localHumanActor: () => HUMAN,
    now: () => 1_000,
  });
  const target = { path: workspacePath, identity: WS };
  return {
    db,
    runtime,
    repos,
    service,
    target,
    fetchCalls,
    cleanup: () => {
      rmSync(workspacePath, { recursive: true, force: true });
      db.close();
    },
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

/** 造一条工作项（默认 `in_review` = 等验收态）+ 一条已链接的 PR。 */
async function seedLinkedWorkItem(
  f: Fixture,
  workItemId = "wi-terminal",
  status: "in_review" | "in_progress" | "done" = "in_review",
): Promise<void> {
  f.runtime.workItemRepo.insert({
    id: workItemId,
    workspaceIdentity: WS,
    workspacePath: f.target.path,
    title: "终端驱动工作项",
    body: "",
    status,
    assignee: { type: "human", id: HUMAN.id },
    labels: [],
    properties: {},
    position: 0,
  });
  await f.service.linkWorkItemPullRequest(f.target, {
    workItemId,
    url: "https://github.com/acme/widget/pull/7",
  });
}

function statusOf(f: Fixture, workItemId = "wi-terminal"): string {
  const item = f.runtime.workItemRepo.get(workItemId);
  assert.ok(item, `工作项 ${workItemId} 应当存在`);
  return item.status;
}

function prMergedActivities(f: Fixture, workItemId = "wi-terminal") {
  return f.repos.activities.listByWorkItem(WS, workItemId).filter((row) => row.kind === "pr_merged");
}

async function refresh(f: Fixture, workItemId = "wi-terminal") {
  return f.service.refreshWorkItemPullRequests(f.target, { workItemId });
}

test("终态驱动｜快照刷到 merged + 工作项 in_review ⇒ transition 转 done（同一写者）+ pr_merged 回声", async () => {
  const f = await setup();
  try {
    await seedLinkedWorkItem(f);
    const report = await refresh(f);

    assert.deepEqual(
      report.items.map((item) => [item.prNumber, item.outcome, item.state]),
      [[7, "updated", "merged"]],
      "报告形状不变（D2 的四档 + merged 读出照旧）",
    );
    assert.deepEqual(report.mergedPullRequests.map((fact) => fact.prNumber), [7]);
    assert.equal(statusOf(f), "done", "PR merged ⇒ 工作项 in_review→done（唯一写者不变）");

    const echoes = prMergedActivities(f);
    assert.equal(echoes.length, 1, "时间线回声恰一条");
    assert.equal(echoes[0]!.payload["prNumber"], 7);
    assert.equal(echoes[0]!.payload["url"], "https://github.com/acme/widget/pull/7");
    assert.deepEqual(echoes[0]!.actor, { kind: "system", id: "squad-runtime" });
    assert.equal(
      echoes[0]!.dedupKey,
      "pr:pr-wi-terminal-acme-widget-7:merged",
      "回声键由关联行 id 派生（形状冻结：pr:<pullRequestId>:merged）",
    );
  } finally {
    f.cleanup();
  }
});

test("终态驱动｜幂等：终态工作项再刷（快照照刷）⇒ 状态不动、回声不重复", async () => {
  const f = await setup();
  try {
    await seedLinkedWorkItem(f);
    await refresh(f);
    assert.equal(prMergedActivities(f).length, 1);

    const again = await refresh(f);
    assert.equal(again.items[0]!.outcome, "updated", "已终态 ⇒ 快照照刷（设计 §4.2 的次序）");
    assert.equal(statusOf(f), "done", "已终态：跳过终态判定，状态一字不动");
    assert.equal(prMergedActivities(f).length, 1, "回声幂等（同一条 PR 只留一枚）");
  } finally {
    f.cleanup();
  }
});

test("终态驱动｜非终态但**不在** in_review（如 in_progress）⇒ 状态不动、无回声（快照照刷）", async () => {
  const f = await setup();
  try {
    await seedLinkedWorkItem(f, "wi-terminal", "in_progress");
    const report = await refresh(f);
    assert.equal(report.items[0]!.state, "merged");
    assert.equal(statusOf(f), "in_progress", "PR merged 只对「等验收」的工作项构成终态信号");
    assert.equal(prMergedActivities(f).length, 0);
  } finally {
    f.cleanup();
  }
});

test("终态驱动｜CAS 竞态（读到 in_review、写前被别的窗口改了）⇒ **不抛**、留痕、无回声", async () => {
  const f = await setup();
  try {
    await seedLinkedWorkItem(f);
    const entry = createWorkItemPullRequestEntry({
      runtime: f.runtime,
      workspaceKey: WS,
      actor: () => HUMAN,
      now: () => 1_000,
      logWarn: (message) => {
        warnings.push(message);
      },
    });
    const warnings: string[] = [];
    // 模拟另一个 Host（多窗口共库）在「读到 in_review」与「CAS 写入」之间把行改成了 cancelled：
    // 用与 transition 同一条存储写（updateStatus 的 CAS）先落别人的结论，本次 expect 便不再命中。
    const realTransition = f.runtime.workItemService.transition.bind(f.runtime.workItemService);
    f.runtime.workItemService.transition = (id, next, expect) => {
      f.runtime.workItemRepo.updateStatus(id, "cancelled", expect);
      return realTransition(id, next, expect);
    };

    const report = await entry.refresh({ workItemId: "wi-terminal" });
    assert.equal(report.mergedPullRequests.length, 1, "快照照刷（merged 事实仍报出）");
    assert.equal(statusOf(f), "cancelled", "输家不覆盖赢家：状态是别人写下的结论");
    assert.equal(
      prMergedActivities(f).length,
      0,
      "transition 未命中 ⇒ 无回声（回声是「这次由它驱动了终态」的证据，不是「这条 PR merged」的复述）",
    );
    assert.ok(
      warnings.some((message) => /CAS|未命中|竞态/.test(message)),
      `CAS 输家必须留痕（不静默）：${JSON.stringify(warnings)}`,
    );
  } finally {
    f.cleanup();
  }
});
