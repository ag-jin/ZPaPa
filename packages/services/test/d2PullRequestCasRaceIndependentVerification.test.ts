import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createCommentDispatchReceiptRepo } from "../src/workitem/commentDispatchReceiptRepo.js";
import {
  type PullRequestFetchResult,
  type PullRequestProvider,
} from "../src/workitem/pullRequestProvider.js";
import { createPullRequestSync, type PullRequestSync } from "../src/workitem/pullRequestSync.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import { createWorkItemCollaborationService } from "../src/workitem/workItemCollaborationService.js";
import { createWorkItemCommentReactionRepo } from "../src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemCommentRepo } from "../src/workitem/workItemCommentRepo.js";
import { createWorkItemDecisionRepo } from "../src/workitem/workItemDecisionRepo.js";
import {
  createWorkItemPullRequestRepo,
  type PullRequestSnapshot,
  type WorkItemPullRequestRepo,
} from "../src/workitem/workItemPullRequestRepo.js";

/* #8 D2 **独立复验**（test-verifier）：快照 CAS 的**反向核对**与**在途双刷新竞态**。

   复核对象是设计 §4.2 的那条：慢响应不得覆盖更新 head 的快照。
   · 反向构造：**先正常拉两次**（首拉 → head 前进），再让一个「为旧 head 拉的」响应到达 ——
     它必须被整条丢弃，且 `report` 如实标 `discarded_stale`（不静默）。
   · 竞态构造：**两个刷新同时在途**，后发先至 —— 恰一个赢家，另一个被 CAS 拒，
     库里是赢家的完整快照（不许出现「新 state 配旧 head」的半新半旧行）。
   · 结果的读回用**裸 SQL**（不经过 repo 的映射层）：夹具与断言都不复用实现的读路径。 */

const WS = "cas-ws";
const ORIGIN = "https://github.com";

function setup() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const repo = createWorkItemPullRequestRepo(db);
  link(repo, 7, "pr-7");
  return { db, repo };
}

function link(repo: WorkItemPullRequestRepo, number: number, id: string) {
  return repo.link({
    id,
    workspaceKey: WS,
    workspacePath: "/tmp/cas-ws",
    workItemId: "wi-1",
    repoOwner: "acme",
    repoName: "widget",
    prNumber: number,
    htmlUrl: `${ORIGIN}/acme/widget/pull/${number}`,
    linkedBy: { kind: "human", id: "u-1" },
    createdAt: 100 + number,
  });
}

function snapshot(over: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    state: "open",
    mergedAt: null,
    title: "Add widget",
    branch: "feat/widget",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    headSha: "head-1",
    fetchedAt: 200,
    ...over,
  };
}

/** 裸 SQL 读整行（复验不看 repo 的 mapper —— 「列到底是几」由库里说了算）。 */
function rawRow(db: DatabaseSync, id: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM work_item_pull_requests WHERE id = ?").get(id) as Record<
    string,
    unknown
  >;
}

/** 把「另一次更晚的刷新」模拟成外部写者（裸 SQL，绕过 repo 的 CAS 入口）。 */
function externalRefreshLands(db: DatabaseSync, id: string, head: string, at: number): void {
  db.prepare(
    `UPDATE work_item_pull_requests
        SET title = ?, branch = ?, state = ?, merged_at = ?, api_mergeable = ?,
            api_merge_state_status = ?, snapshot_head_sha = ?, snapshot_fetched_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    "Newer title",
    "feat/newer",
    "merged",
    1_700_000_000_000,
    "CONFLICTING",
    "DIRTY",
    head,
    at,
    at,
    id,
  );
}

function providerOf(handler: (url: string, call: number) => PullRequestFetchResult): {
  calls: string[];
  provider: PullRequestProvider;
} {
  const calls: string[] = [];
  return {
    calls,
    provider: {
      describe: () => ({ available: true }),
      async fetchPullRequest(url) {
        calls.push(url);
        return handler(url, calls.length);
      },
    },
  };
}

function syncOf(provider: PullRequestProvider, repo: WorkItemPullRequestRepo): PullRequestSync {
  return createPullRequestSync({ provider, repo, workspace: { key: WS } });
}

/* ---------------- ① 首拉 → head 推进 → 陈旧响应（四列不变的加强版：整行不变） ---------------- */

test("CAS 反向核对｜首拉成功 → 更晚的快照先落地 → 为旧 head 拉的响应整条被拒（裸 SQL 逐列比对）", async () => {
  const { db, repo } = setup();
  let call = 0;
  /** 「更晚的刷新」落地后库里那一行（外部写者写完立刻读；它是本用例的期望真源）。 */
  let winnerRow: Record<string, unknown> | null = null;
  const { provider } = providerOf(() => {
    call += 1;
    if (call === 1) {
      // 首拉：pin 是空串，写 head-1。
      return { ok: true, snapshot: snapshot({ headSha: "head-1", fetchedAt: 200 }) };
    }
    /* 第二次：在响应到达之前，**另一次更晚的刷新**已经把快照推进到 head-2（外部写者，裸 SQL）。
       我们这次响应基于 pin=""（拉取前读到的），必须被整条丢弃。 */
    externalRefreshLands(db, "pr-7", "head-2", 300);
    winnerRow = rawRow(db, "pr-7");
    return {
      ok: true,
      snapshot: snapshot({ headSha: "head-1", fetchedAt: 250, state: "open", mergedAt: null }),
    };
  });
  const sync = syncOf(provider, repo);

  const first = await sync.refreshForWorkItem({ workItemId: "wi-1" });
  assert.equal(first.items[0]!.outcome, "updated");
  assert.equal(rawRow(db, "pr-7").snapshot_head_sha, "head-1");

  const second = await sync.refreshForWorkItem({ workItemId: "wi-1" });
  assert.equal(second.items[0]!.outcome, "discarded_stale", "陈旧响应必须被标出来（不静默）");
  assert.match(second.items[0]!.reason ?? "", /head|陈旧|取代/i, "拒写必须带原因");
  assert.equal(
    second.items[0]!.state,
    "merged",
    "report 里是**库里真正的事实**（新值），不是被丢弃的那次响应（open）",
  );

  const after = rawRow(db, "pr-7");
  assert.ok(winnerRow, "外部写者必须已落地");
  for (const column of [
    "title",
    "branch",
    "state",
    "merged_at",
    "api_mergeable",
    "api_merge_state_status",
    "snapshot_head_sha",
    "snapshot_fetched_at",
    "updated_at",
  ]) {
    assert.equal(
      after[column],
      winnerRow![column],
      `${column} 必须仍是更晚那次刷新的值（陈旧响应整条丢弃：镜像列 + 快照列一起）`,
    );
  }
  /* 陈旧响应的每个可辨别值都不得出现（防「整行相等」被同值巧合蒙过）。 */
  assert.notEqual(after.title, "Add widget");
  assert.notEqual(after.state, "open");
  assert.notEqual(after.snapshot_head_sha, "head-1");
  assert.notEqual(after.snapshot_fetched_at, 250);
  assert.equal(after.state, "merged");
  assert.equal(after.snapshot_head_sha, "head-2");
  assert.equal(after.snapshot_fetched_at, 300);
  assert.equal(after.merged_at, 1_700_000_000_000);

  /* 反向的一半：把响应换成**基于当前 pin** 的（head-2 → head-3）⇒ 必须写得进去。
     否则「CAS 拒写」可能只是把一切都拒了（全拒也能让上面那条绿）。 */
  const third = providerOf(() => ({
    ok: true,
    snapshot: snapshot({ headSha: "head-3", state: "closed", fetchedAt: 400 }),
  }));
  const advanced = await syncOf(third.provider, repo).refreshForWorkItem({ workItemId: "wi-1" });
  assert.equal(advanced.items[0]!.outcome, "updated", "基于当前 pin 的响应必须正常落地");
  assert.equal(rawRow(db, "pr-7").snapshot_head_sha, "head-3");
  assert.equal(rawRow(db, "pr-7").state, "closed");
  db.close();
});

/* ---------------- ② 在途双刷新竞态：后发先至 ---------------- */

test("竞态｜两个刷新同时在途（后发先至）：恰一个 updated、一个 discarded_stale，库里是赢家完整快照", async () => {
  const { db, repo } = setup();
  /* 两方都在 pin="" 时开始拉；用 deferred 控制**响应到达的顺序**：B 先到（赢），A 后到（应被拒）。 */
  const pending: Array<(result: PullRequestFetchResult) => void> = [];
  const provider: PullRequestProvider = {
    describe: () => ({ available: true }),
    fetchPullRequest: () =>
      new Promise<PullRequestFetchResult>((resolve) => {
        pending.push(resolve);
      }),
  };
  const sync = syncOf(provider, repo);

  const a = sync.refreshForWorkItem({ workItemId: "wi-1" });
  const b = sync.refreshForWorkItem({ workItemId: "wi-1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 2, "两个刷新都已在途");

  // B 先落地：head-B / merged。
  pending[1]!({
    ok: true,
    snapshot: snapshot({
      title: "B title",
      branch: "feat/b",
      state: "merged",
      mergedAt: 2_000,
      mergeable: "UNKNOWN",
      mergeStateStatus: "BEHIND",
      headSha: "head-B",
      fetchedAt: 500,
    }),
  });
  const bReport = await b;
  assert.equal(bReport.items[0]!.outcome, "updated");

  // A 后到：它基于 pin=""（拉取前读的 pin），而库里已是 head-B ⇒ 必须被拒，不得覆盖 B。
  pending[0]!({
    ok: true,
    snapshot: snapshot({
      title: "A title",
      branch: "feat/a",
      state: "open",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      headSha: "head-A",
      fetchedAt: 400,
    }),
  });
  const aReport = await a;
  assert.equal(aReport.items[0]!.outcome, "discarded_stale", "后到的旧响应必须被 CAS 拒");

  const outcomes = [aReport.items[0]!.outcome, bReport.items[0]!.outcome].sort();
  assert.deepEqual(outcomes, ["discarded_stale", "updated"], "恰一个赢家");

  const row = rawRow(db, "pr-7");
  assert.deepEqual(
    {
      title: row.title,
      branch: row.branch,
      state: row.state,
      merged_at: row.merged_at,
      api_mergeable: row.api_mergeable,
      api_merge_state_status: row.api_merge_state_status,
      snapshot_head_sha: row.snapshot_head_sha,
      snapshot_fetched_at: row.snapshot_fetched_at,
      updated_at: row.updated_at,
    },
    {
      title: "B title",
      branch: "feat/b",
      state: "merged",
      merged_at: 2_000,
      api_mergeable: "UNKNOWN",
      api_merge_state_status: "BEHIND",
      snapshot_head_sha: "head-B",
      snapshot_fetched_at: 500,
      updated_at: 500,
    },
    "库里必须是赢家（B）的完整快照：不许「B 的 head 配 A 的 state」这类半新半旧行",
  );
  assert.deepEqual(
    aReport.mergedPullRequests.map((fact) => fact.pullRequestId),
    ["pr-7"],
    "merged 读出取库里的现状（赢家是 merged）",
  );
  db.close();
});

test("竞态｜同一 pin 的两次刷新都基于空 pin 首拉：第二次必被拒（CAS 的比较对象是库里的 pin）", async () => {
  const { db, repo } = setup();
  /* 这个构造与上一个互补：两方**顺序**到达（不是交错），但第二方的 expectHeadSha 仍是 ""，
     因为它在第一方写库**之前**读的 pin —— 少了 CAS 就会把第一方的 head 覆盖成第二条的。 */
  const seq: PullRequestFetchResult[] = [
    { ok: true, snapshot: snapshot({ headSha: "first", state: "open", fetchedAt: 10 }) },
    { ok: true, snapshot: snapshot({ headSha: "second", state: "closed", fetchedAt: 20 }) },
  ];
  let call = 0;
  const { provider } = providerOf(() => seq[call++]!);
  const sync = syncOf(provider, repo);

  // 两个 refresh 并发（JS 单线程：两个都先读 pin，再 await fetch）。
  const [r1, r2] = await Promise.all([
    sync.refreshForWorkItem({ workItemId: "wi-1" }),
    sync.refreshForWorkItem({ workItemId: "wi-1" }),
  ]);
  const outcomes = [r1.items[0]!.outcome, r2.items[0]!.outcome].sort();
  assert.deepEqual(outcomes, ["discarded_stale", "updated"]);
  assert.equal(rawRow(db, "pr-7").snapshot_head_sha, "first", "先写者（first）是赢家");
  assert.equal(rawRow(db, "pr-7").state, "open");
  db.close();
});

/* ---------------- ③ 回归面：读模型的八格（含 D1 交付物与 D2 的 PR 两格） ---------------- */

test("读模型｜协作聚合读恰十键（workItem/viewerActor + 八格数据面），D1 交付物与 D2 PR 两格并存且离线缺省可读", async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "d2-read-"));
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  try {
    const runtime = await createSquadRuntime({
      db,
      workspacePath,
      workspaceIdentity: WS,
      readExperimentEnabled: () => true,
      // 不注入 token ⇒ null adapter（离线缺省形态）。
    });
    runtime.workItemRepo.insert({
      id: "wi-read",
      workspaceIdentity: WS,
      workspacePath,
      title: "读模型工作项",
      body: "",
      status: "todo",
      assignee: { type: "user", id: "u-1" },
      labels: [],
      properties: {},
      position: 0,
    });
    const service = createWorkItemCollaborationService({
      createRuntime: async () => runtime,
      getRepos: () => ({
        comments: createWorkItemCommentRepo(db),
        activities: createWorkItemActivityRepo(db),
        decisions: createWorkItemDecisionRepo(db),
        reactions: createWorkItemCommentReactionRepo(db),
        receipts: createCommentDispatchReceiptRepo(db),
      }),
      localHumanActor: () => ({ kind: "human", id: "u-1" }),
      now: () => 1,
    });
    const read = await service.getWorkItemCollaboration(
      { path: workspacePath, identity: WS },
      "wi-read",
    );
    assert.ok(read, "读面必须返回真行");
    assert.deepEqual(
      Object.keys(read!).sort(),
      [
        "activities",
        "comments",
        "decisions",
        "deliverables",
        "pullRequestProvider",
        "pullRequests",
        "reactions",
        "receipts",
        "viewerActor",
        "workItem",
      ].sort(),
      "D1 交付物格与 D2 PR 两格必须同时在读模型里（缺一格 ⇒ 详情页某区静默空转）",
    );
    assert.deepEqual(read!.deliverables, [], "D1 交付物格仍按 workspace+item 口径可读");
    assert.deepEqual(read!.pullRequests, [], "D2 PR 清单格可读（离线缺省下为空）");
    assert.deepEqual(
      read!.pullRequestProvider,
      { available: false, reason: read!.pullRequestProvider.reason },
      "读数面可用性同步返回（未注入 token ⇒ unavailable）",
    );
    assert.equal(read!.pullRequestProvider.available, false);
    assert.match(read!.pullRequestProvider.reason ?? "", /token|令牌/i);

    /* **零出站（装配级）**：不注入 token 的 runtime 在整条门面链路上不得碰一次网络。
       探针挂在 globalThis.fetch（runtime 未注入 githubFetch 时的缺省出站口）。 */
    const originalFetch = globalThis.fetch;
    let probes = 0;
    globalThis.fetch = (async () => {
      probes += 1;
      throw new Error("离线缺省不得出站");
    }) as typeof fetch;
    try {
      const link = await service.linkWorkItemPullRequest(
        { path: workspacePath, identity: WS },
        { workItemId: "wi-read", url: "https://github.com/acme/widget/pull/7" },
      );
      assert.equal(link.state, null, "登记不发请求、不伪造快照态");
      assert.equal(link.snapshotHeadSha, "");
      const report = await service.refreshWorkItemPullRequests(
        { path: workspacePath, identity: WS },
        { workItemId: "wi-read" },
      );
      assert.equal(report.providerAvailable, false);
      assert.deepEqual(
        report.items.map((item) => [item.prNumber, item.outcome]),
        [[7, "unavailable"]],
        "没配 token ⇒ 每条 unavailable（报告照出，不抛）",
      );
      assert.deepEqual(report.mergedPullRequests, []);
      assert.equal(probes, 0, "整个链路一次出站都没有");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
    db.close();
  }
});

/* ---------------- ④ D2/D3 边界（装配级）：快照刷新不得动工作项状态 ---------------- */

test("边界｜配 token 真刷到 merged：mergedPullRequests 报出，但工作项状态一字不动（终态判定是 D3）", async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "d2-boundary-"));
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  try {
    const runtime = await createSquadRuntime({
      db,
      workspacePath,
      workspaceIdentity: WS,
      readExperimentEnabled: () => true,
      readGithubPullRequestToken: () => "ghp_verify_boundary",
      githubFetch: (async () =>
        new Response(
          JSON.stringify({
            number: 7,
            state: "closed",
            draft: false,
            merged: true,
            merged_at: "2025-01-02T03:04:05Z",
            title: "Merged widget",
            head: { ref: "feat/widget", sha: "sha-merged" },
            mergeable: true,
            mergeable_state: "clean",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });
    runtime.workItemRepo.insert({
      id: "wi-boundary",
      workspaceIdentity: WS,
      workspacePath,
      title: "边界工作项",
      body: "",
      status: "in_review",
      assignee: { type: "user", id: "u-1" },
      labels: [],
      properties: {},
      position: 0,
    });
    const service = createWorkItemCollaborationService({
      createRuntime: async () => runtime,
      getRepos: () => ({
        comments: createWorkItemCommentRepo(db),
        activities: createWorkItemActivityRepo(db),
        decisions: createWorkItemDecisionRepo(db),
        reactions: createWorkItemCommentReactionRepo(db),
        receipts: createCommentDispatchReceiptRepo(db),
      }),
      localHumanActor: () => ({ kind: "human", id: "u-1" }),
      now: () => 1,
    });
    const target = { path: workspacePath, identity: WS };
    await service.linkWorkItemPullRequest(target, {
      workItemId: "wi-boundary",
      url: "https://github.com/acme/widget/pull/7",
    });
    const report = await service.refreshWorkItemPullRequests(target, {
      workItemId: "wi-boundary",
    });

    assert.deepEqual(
      report.items.map((item) => [item.prNumber, item.outcome, item.state]),
      [[7, "updated", "merged"]],
      "在线形态：快照刷新成功且状态是 merged",
    );
    assert.deepEqual(
      report.mergedPullRequests.map((fact) => [fact.prNumber, fact.mergedAt]),
      [[7, 1735787045000]],
      "D3 的口：merged 事实读自库（含 merged_at 的 ms 值）",
    );
    assert.equal(
      runtime.workItemRepo.get("wi-boundary")!.status,
      "in_review",
      "D2 不做终态判定：工作项状态必须一字不动（唯一写者仍是 WorkItemService.transition，D3 在调用点做）",
    );
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
    db.close();
  }
});
