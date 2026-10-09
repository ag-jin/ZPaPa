import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import {
  createNullPullRequestProvider,
  type PullRequestFetchResult,
  type PullRequestProvider,
} from "../src/workitem/pullRequestProvider.js";
import { createPullRequestSync } from "../src/workitem/pullRequestSync.js";
import {
  createWorkItemPullRequestRepo,
  type PullRequestSnapshot,
} from "../src/workitem/workItemPullRequestRepo.js";

/* #8 D2 的 **同步深模块** `pullRequestSync`（设计 §4.2）：按需（手动触发）刷新一个工作项下
   已链接 PR 的快照。

   本文件钉五条行为（provider 全部是**注入的 fake**，不联网）：
   ① 成功刷新 ⇒ 快照落库 + report；
   ② **head-SHA 防陈旧写**：拉取期间别的刷新先落地 ⇒ 本次响应整条丢弃，report 如实标
      `discarded_stale`（**不静默** —— 静默的陈旧拒写与「刷新成功」在界面上分不开）；
   ③ 单条失败不阻断其余（401/网络失败各自带原因回到 report）；
   ④ 未配 token（null provider）⇒ 每条标 `unavailable`、整份报告 providerAvailable=false，
      **不抛**（离线缺省形态不是错误）；
   ⑤ **merged 状态读出**：报告带出当前快照里 state=merged 的 PR —— 这是 D3（终态驱动）
      要消费的口；本模块**不做任何状态迁移**（结构上拿不到状态机，见文件末守卫）。 */

const WS = "sync-ws";
const ORIGIN = "https://github.com";

function setup() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const repo = createWorkItemPullRequestRepo(db);
  return { db, repo };
}

function snapshot(over: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    state: "open",
    mergedAt: null,
    title: "Add widget",
    branch: "feat/widget",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    headSha: "head-aaa",
    fetchedAt: 200,
    ...over,
  };
}

/** 记录调用顺序的 fake provider：`handler` 决定每条 URL 的返回。 */
function fakeProvider(handler: (url: string, call: number) => PullRequestFetchResult): {
  provider: PullRequestProvider;
  calls: string[];
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

function link(repo: ReturnType<typeof createWorkItemPullRequestRepo>, number: number, id: string) {
  return repo.link({
    id,
    workspaceKey: WS,
    workspacePath: "/tmp/sync-ws",
    workItemId: "wi-1",
    repoOwner: "acme",
    repoName: "widget",
    prNumber: number,
    htmlUrl: `${ORIGIN}/acme/widget/pull/${number}`,
    linkedBy: { kind: "human", id: "u-1" },
    createdAt: 100 + number,
  });
}

test("refresh｜成功：快照落库（镜像列 + head pin + fetched_at）并回 report（updated）", async () => {
  const { repo } = setup();
  link(repo, 7, "pr-7");
  const { provider, calls } = fakeProvider(() => ({ ok: true, snapshot: snapshot() }));
  const sync = createPullRequestSync({ provider, repo, workspace: { key: WS } });

  const report = await sync.refreshForWorkItem({ workItemId: "wi-1" });
  assert.deepEqual(calls, [`${ORIGIN}/acme/widget/pull/7`]);
  assert.equal(report.providerAvailable, true);
  assert.equal(report.providerUnavailableReason, null);
  assert.deepEqual(report.items, [
    {
      pullRequestId: "pr-7",
      repoOwner: "acme",
      repoName: "widget",
      prNumber: 7,
      htmlUrl: `${ORIGIN}/acme/widget/pull/7`,
      outcome: "updated",
      reason: null,
      state: "open",
      snapshotFetchedAt: 200,
    },
  ]);
  assert.deepEqual(report.mergedPullRequests, [], "open 不是 merged");

  const row = repo.get("pr-7")!;
  assert.equal(row.state, "open");
  assert.equal(row.snapshotHeadSha, "head-aaa");
  assert.equal(row.snapshotFetchedAt, 200);
  assert.equal(row.title, "Add widget", "镜像列随快照更新");
});

test("refresh｜head-SHA 防陈旧写：拉取期间更新的快照先落地 ⇒ 本次响应丢弃并如实标 discarded_stale", async () => {
  const { repo } = setup();
  link(repo, 7, "pr-7");
  /* 竞争模拟：我们的 fetch 在途时，另一次刷新（不同 head）先把快照写进库；
     随后我们这个「为旧 head 拉的」响应到达 —— 它必须被整条丢弃。 */
  const { provider } = fakeProvider(() => {
    repo.replaceSnapshot({
      id: "pr-7",
      expectHeadSha: "",
      snapshot: snapshot({ headSha: "head-newer", state: "merged", mergedAt: 999, fetchedAt: 300 }),
    });
    return {
      ok: true,
      snapshot: snapshot({ headSha: "head-older", state: "open", fetchedAt: 250 }),
    };
  });
  const sync = createPullRequestSync({ provider, repo, workspace: { key: WS } });

  const report = await sync.refreshForWorkItem({ workItemId: "wi-1" });
  assert.equal(report.items.length, 1);
  assert.equal(report.items[0]!.outcome, "discarded_stale");
  assert.match(report.items[0]!.reason!, /head|陈旧|取代/i, "拒写必须带原因（不静默）");
  assert.equal(
    report.items[0]!.state,
    "merged",
    "report 里是**库里真正的事实**（不是被丢弃的响应）",
  );

  const row = repo.get("pr-7")!;
  assert.equal(row.snapshotHeadSha, "head-newer");
  assert.equal(row.state, "merged");
  assert.equal(row.snapshotFetchedAt, 300, "陈旧响应没有动过任何一列");
  assert.equal(row.mergedAt, 999);
});

test("refresh｜失败面：单条 401 不阻断其余，两条各自带原因回到 report", async () => {
  const { repo } = setup();
  link(repo, 7, "pr-7");
  link(repo, 8, "pr-8");
  const { provider, calls } = fakeProvider((url) =>
    url.endsWith("/7")
      ? { ok: false, code: "http_error", status: 401, reason: "GitHub 返回 401：令牌无效。" }
      : { ok: true, snapshot: snapshot({ headSha: "head-8", state: "draft" }) },
  );
  const sync = createPullRequestSync({ provider, repo, workspace: { key: WS } });

  const report = await sync.refreshForWorkItem({ workItemId: "wi-1" });
  assert.equal(calls.length, 2, "第一条失败不影响第二条（不提前中止）");
  assert.deepEqual(
    report.items.map((item) => [item.prNumber, item.outcome]),
    [
      [7, "failed"],
      [8, "updated"],
    ],
  );
  assert.match(report.items[0]!.reason!, /401/);
  assert.equal(report.items[0]!.state, null, "失败的这条保持「未拉取」");
  assert.equal(repo.get("pr-7")!.state, null);
  assert.equal(repo.get("pr-8")!.state, "draft");
});

test("refresh｜离线缺省（null provider）：每条标 unavailable、报告整体 available=false，不抛", async () => {
  const { repo } = setup();
  link(repo, 7, "pr-7");
  const sync = createPullRequestSync({
    provider: createNullPullRequestProvider(),
    repo,
    workspace: { key: WS },
  });

  const report = await sync.refreshForWorkItem({ workItemId: "wi-1" });
  assert.equal(report.providerAvailable, false);
  assert.match(report.providerUnavailableReason!, /令牌|token/i);
  assert.deepEqual(
    report.items.map((item) => [item.outcome, item.reason !== null]),
    [["unavailable", true]],
  );
  assert.deepEqual(report.mergedPullRequests, []);
  assert.equal(repo.get("pr-7")!.state, null, "离线形态：快照态仍是「未拉取」（不伪造）");
});

test("refresh｜零链接：不调用 provider，报告空（provider 可用性照报）", async () => {
  const { repo } = setup();
  const { provider, calls } = fakeProvider(() => {
    throw new Error("零链接时不得发请求");
  });
  const sync = createPullRequestSync({ provider, repo, workspace: { key: WS } });
  const report = await sync.refreshForWorkItem({ workItemId: "wi-1" });
  assert.deepEqual(calls, []);
  assert.deepEqual(report.items, []);
  assert.equal(report.providerAvailable, true);
});

test("refresh｜merged 读出（D3 的口）：报告带出 state=merged 的 PR（含 mergedAt），不做任何迁移", async () => {
  const { repo } = setup();
  link(repo, 7, "pr-7");
  link(repo, 8, "pr-8");
  const { provider } = fakeProvider((url) =>
    url.endsWith("/7")
      ? {
          ok: true,
          snapshot: snapshot({ state: "merged", mergedAt: 1735787045000, headSha: "h7" }),
        }
      : { ok: true, snapshot: snapshot({ state: "open", headSha: "h8" }) },
  );
  const sync = createPullRequestSync({ provider, repo, workspace: { key: WS } });
  const report = await sync.refreshForWorkItem({ workItemId: "wi-1" });

  assert.deepEqual(report.mergedPullRequests, [
    {
      pullRequestId: "pr-7",
      repoOwner: "acme",
      repoName: "widget",
      prNumber: 7,
      htmlUrl: `${ORIGIN}/acme/widget/pull/7`,
      mergedAt: 1735787045000,
    },
  ]);
});

test("refresh｜workspace 隔离：别的 workspace 的同 workItemId 行不参与本次刷新", async () => {
  const { repo } = setup();
  link(repo, 7, "pr-7");
  repo.link({
    id: "pr-other",
    workspaceKey: "other-ws",
    workspacePath: "/tmp/other",
    workItemId: "wi-1",
    repoOwner: "acme",
    repoName: "widget",
    prNumber: 9,
    htmlUrl: `${ORIGIN}/acme/widget/pull/9`,
    linkedBy: { kind: "human", id: "u-1" },
    createdAt: 1,
  });
  const { provider, calls } = fakeProvider(() => ({ ok: true, snapshot: snapshot() }));
  const sync = createPullRequestSync({ provider, repo, workspace: { key: WS } });
  await sync.refreshForWorkItem({ workItemId: "wi-1" });
  assert.deepEqual(calls, [`${ORIGIN}/acme/widget/pull/7`]);
  assert.equal(repo.get("pr-other")!.state, null);
});

test("守卫｜同步模块零状态机 / 零派发 / 零 SQL：D3 的终态驱动必须经它给出的读出（结构上碰不到 transition）", () => {
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/workitem/pullRequestSync.ts"),
    "utf8",
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of [
    "transition",
    "updateStatus",
    "workItemService",
    "workItemRepo",
    "activityProjector",
    "openMemberRun",
    "planDispatch",
    "db.prepare",
    "UPDATE ",
    "DELETE FROM",
    "INSERT INTO",
  ]) {
    assert.ok(
      !code.includes(forbidden),
      `pullRequestSync.ts 不得出现 ${forbidden}：D2 只读快照 + 报出 merged 事实，` +
        "终态迁移是 D3 在调用点上做的（唯一写者仍是 WorkItemService.transition）",
    );
  }
});
