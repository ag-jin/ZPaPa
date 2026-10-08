import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createCommentDispatchReceiptRepo } from "../src/workitem/commentDispatchReceiptRepo.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import { createWorkItemCollaborationService } from "../src/workitem/workItemCollaborationService.js";
import { createWorkItemCommentReactionRepo } from "../src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemCommentRepo } from "../src/workitem/workItemCommentRepo.js";
import { createWorkItemDecisionRepo } from "../src/workitem/workItemDecisionRepo.js";

/* #8 D2 的**服务面缝合线**（门面 = UI 的唯一入口）：link / unlink / refresh 三口，
   以及离线缺省（没配 token）的完整体验。

   与实现者单测的差别：这里**从门面进**，走真 runtime + 真 repo + 真迁移，
   只有 GitHub 的 `fetch` 是注入的 stub（不联网）。因此它同时验证三件事：
   ① runtime 里的三件零件（repo / provider / sync）真的接上了（漏接必然红）；
   ② token 的读取口通向 provider（配了 token ⇒ 出站请求带 Bearer；没配 ⇒ 零出站）；
   ③ 离线缺省不是错误：refresh 返回 unavailable 报告、不抛，PR 列表与「未配置 token」状态照常可读。 */

const WS = "pr-facade-ws";
const HUMAN = { kind: "human" as const, id: "verify-human-pr" };

function readSource(relative: string): string {
  return readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), relative), "utf8");
}

/** GitHub `GET /pulls/{n}` 的响应 stub（形状取自 REST 文档；字段名不是我们自己的类型）。 */
function pullResponse(over: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      number: 7,
      state: "open",
      draft: false,
      merged: false,
      merged_at: null,
      title: "Add widget",
      head: { ref: "feat/widget", sha: "sha-head-1" },
      mergeable: true,
      mergeable_state: "clean",
      ...over,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function setup(options: { token?: string; fetchImpl?: typeof fetch } = {}) {
  const workspacePath = mkdtempSync(join(tmpdir(), "pr-facade-"));
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: typeof fetch =
    options.fetchImpl ??
    (async (input, init) => {
      fetchCalls.push({ url: String(input), init });
      return pullResponse();
    });
  let token = options.token;
  const runtimeOf = (identity = WS) =>
    createSquadRuntime({
      db,
      workspacePath,
      workspaceIdentity: identity,
      readExperimentEnabled: () => true,
      readGithubPullRequestToken: () => token,
      githubFetch: fetchImpl,
    });
  const repos = {
    comments: createWorkItemCommentRepo(db),
    activities: createWorkItemActivityRepo(db),
    decisions: createWorkItemDecisionRepo(db),
    reactions: createWorkItemCommentReactionRepo(db),
    receipts: createCommentDispatchReceiptRepo(db),
  };
  let clock = 1_000;
  const service = createWorkItemCollaborationService({
    createRuntime: async () => runtimeOf(),
    getRepos: () => repos,
    localHumanActor: () => HUMAN,
    now: () => clock++,
  });
  return {
    workspacePath,
    db,
    service,
    target: { path: workspacePath, identity: WS },
    fetchCalls,
    runtimeOf,
    setToken: (value: string | undefined) => {
      token = value;
    },
    /** 造一条本 workspace 的工作项（服务面按 workspace_key 校验它）。 */
    seedWorkItem: async (id = "wi-pr") => {
      (await runtimeOf()).workItemRepo.insert({
        id,
        workspaceIdentity: WS,
        workspacePath,
        title: "PR 集成工作项",
        body: "",
        status: "in_review",
        assignee: { type: "human", id: HUMAN.id },
        labels: [],
        properties: {},
        position: 0,
      });
    },
    cleanup: () => rmSync(workspacePath, { recursive: true, force: true }),
  };
}

test("门面 link｜URL 归一化 + 归因（linked_by=操作者）+ 派生 id/标题；读模型随读面返回", async () => {
  const f = setup();
  try {
    await f.seedWorkItem();
    const record = await f.service.linkWorkItemPullRequest(f.target, {
      workItemId: "wi-pr",
      url: "https://github.com/acme/widget/pulls/7/?diff=split",
    });
    assert.equal(record.repoOwner, "acme");
    assert.equal(record.repoName, "widget");
    assert.equal(record.prNumber, 7);
    assert.equal(record.htmlUrl, "https://github.com/acme/widget/pull/7", "存规范地址");
    assert.equal(
      record.id,
      "pr-wi-pr-acme-widget-7",
      "id 由业务键确定性派生（同一条关联恒同一 id）",
    );
    assert.equal(record.title, "acme/widget#7", "没给标题 ⇒ 派生可读标题（远端标题归快照）");
    assert.deepEqual(record.linkedBy, HUMAN, "归因 = 组合根注入的本地人类（UI 不拼身份）");
    assert.equal(record.state, null, "登记不等于拉取：快照态仍是未拉取");

    const read = await f.service.getWorkItemCollaboration(f.target, "wi-pr");
    assert.equal(read?.pullRequests.length, 1);
    assert.equal(read?.pullRequests[0]!.id, record.id);
    assert.deepEqual(
      read?.pullRequestProvider,
      {
        available: false,
        reason: "未配置 GitHub 访问令牌（PAT）：PR 快照不可用，PR 区只显示手动登记的链接。",
      },
      "离线缺省：读模型如实报告读数面不可用（界面据此显示「未配置 token」而不是错误）",
    );
    assert.equal(f.fetchCalls.length, 0, "登记不发请求（按需拉取：只有 refresh 触发）");
  } finally {
    f.cleanup();
  }
});

test("门面 link｜幂等（同 PR 换一种写法重投仍一条）；URL 非法与工作项不存在都响亮抛", async () => {
  const f = setup();
  try {
    await f.seedWorkItem();
    const first = await f.service.linkWorkItemPullRequest(f.target, {
      workItemId: "wi-pr",
      url: "https://github.com/acme/widget/pull/7",
      title: "手填标题",
    });
    const retry = await f.service.linkWorkItemPullRequest(f.target, {
      workItemId: "wi-pr",
      url: "https://github.com/acme/widget/pull/7/files",
    });
    assert.equal(retry.id, first.id);
    assert.equal(retry.title, "手填标题", "既存行不被改写（登记的是地址，刷新才改镜像列）");
    const read = await f.service.getWorkItemCollaboration(f.target, "wi-pr");
    assert.equal(read?.pullRequests.length, 1, "同一条关联只许一行");

    await assert.rejects(
      () =>
        f.service.linkWorkItemPullRequest(f.target, {
          workItemId: "wi-pr",
          url: "https://gitlab.com/acme/widget/merge_requests/7",
        }),
      /GitHub|github/i,
      "非 GitHub 地址不得静默降级成普通链接",
    );
    await assert.rejects(
      () =>
        f.service.linkWorkItemPullRequest(f.target, {
          workItemId: "wi-missing",
          url: "https://github.com/acme/widget/pull/9",
        }),
      /不存在|归档/,
      "挂到不存在的工作项必须响亮抛（静默建行会让它看起来记下了）",
    );
  } finally {
    f.cleanup();
  }
});

test("门面 unlink｜真删 + 跨 workspace 响亮拒；删不存在的行返回 false（不是错误）", async () => {
  const f = setup();
  try {
    await f.seedWorkItem();
    const record = await f.service.linkWorkItemPullRequest(f.target, {
      workItemId: "wi-pr",
      url: "https://github.com/acme/widget/pull/7",
    });
    assert.equal(
      await f.service.unlinkWorkItemPullRequest(f.target, { pullRequestId: record.id }),
      true,
    );
    assert.equal(
      await f.service.unlinkWorkItemPullRequest(f.target, { pullRequestId: record.id }),
      false,
      "再删一次 ⇒ false（不是错误）",
    );
    const read = await f.service.getWorkItemCollaboration(f.target, "wi-pr");
    assert.deepEqual(read?.pullRequests, []);

    // 别的 workspace 的行：按 id 直接删除 = 跨 workspace 写 ⇒ 响亮拒。
    const foreign = (await f.runtimeOf("another-ws")).pullRequestRepo.link({
      id: "pr-foreign",
      workspaceKey: "another-ws",
      workspacePath: f.workspacePath,
      workItemId: "wi-pr",
      repoOwner: "acme",
      repoName: "widget",
      prNumber: 9,
      htmlUrl: "https://github.com/acme/widget/pull/9",
      linkedBy: HUMAN,
      createdAt: 1,
    });
    await assert.rejects(
      () => f.service.unlinkWorkItemPullRequest(f.target, { pullRequestId: foreign.id }),
      /workspace/,
    );
  } finally {
    f.cleanup();
  }
});

test("门面 refresh｜离线缺省（没配 token）：报告都是 unavailable、**不抛**，快照态仍是「未拉取」", async () => {
  const f = setup();
  try {
    await f.seedWorkItem();
    await f.service.linkWorkItemPullRequest(f.target, {
      workItemId: "wi-pr",
      url: "https://github.com/acme/widget/pull/7",
    });
    const report = await f.service.refreshWorkItemPullRequests(f.target, { workItemId: "wi-pr" });
    assert.equal(report.providerAvailable, false);
    assert.match(report.providerUnavailableReason!, /令牌|token/i);
    assert.deepEqual(
      report.items.map((item) => item.outcome),
      ["unavailable"],
    );
    assert.ok(report.items[0]!.reason !== null, "要有原因（不静默）");
    assert.deepEqual(report.mergedPullRequests, []);
    assert.equal(f.fetchCalls.length, 0, "没配 token ⇒ 零出站");

    const read = await f.service.getWorkItemCollaboration(f.target, "wi-pr");
    assert.equal(read?.pullRequests[0]!.state, null, "离线形态不伪造快照态");
  } finally {
    f.cleanup();
  }
});

test("门面 refresh｜配了 token：真出站形状（Bearer + 规范 API 地址）+ 快照落库 + 可用性翻转", async () => {
  const f = setup();
  try {
    await f.seedWorkItem();
    await f.service.linkWorkItemPullRequest(f.target, {
      workItemId: "wi-pr",
      url: "https://github.com/acme/widget/pull/7",
    });
    f.setToken("ghp_facade_token");
    const report = await f.service.refreshWorkItemPullRequests(f.target, { workItemId: "wi-pr" });
    assert.equal(report.providerAvailable, true);
    assert.deepEqual(
      report.items.map((item) => [item.outcome, item.state]),
      [["updated", "open"]],
    );
    assert.equal(f.fetchCalls.length, 1);
    assert.equal(f.fetchCalls[0]!.url, "https://api.github.com/repos/acme/widget/pulls/7");
    const headers = f.fetchCalls[0]!.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer ghp_facade_token");

    const read = await f.service.getWorkItemCollaboration(f.target, "wi-pr");
    assert.equal(read?.pullRequests[0]!.state, "open");
    assert.equal(read?.pullRequests[0]!.snapshotHeadSha, "sha-head-1");
    assert.equal(
      typeof read?.pullRequests[0]!.snapshotFetchedAt,
      "number",
      "fetched_at 落库（呈现侧「快照于 …」的原料）",
    );
    assert.equal(read?.pullRequestProvider.available, true, "配上 token 后读数面即变为可用");
  } finally {
    f.cleanup();
  }
});

test("门面 refresh｜merged 读出（D3 的口）从库读回；D2 不驱动工作项状态（仍 in_review）", async () => {
  const f = setup({
    token: "ghp_facade_token",
    fetchImpl: (async () =>
      pullResponse({
        state: "closed",
        merged: true,
        merged_at: "2025-01-02T03:04:05Z",
        head: { ref: "feat/widget", sha: "sha-head-2" },
        mergeable: false,
        mergeable_state: "dirty",
      })) as typeof fetch,
  });
  try {
    await f.seedWorkItem();
    const record = await f.service.linkWorkItemPullRequest(f.target, {
      workItemId: "wi-pr",
      url: "https://github.com/acme/widget/pull/7",
    });
    const report = await f.service.refreshWorkItemPullRequests(f.target, { workItemId: "wi-pr" });
    assert.deepEqual(report.mergedPullRequests, [
      {
        pullRequestId: record.id,
        repoOwner: "acme",
        repoName: "widget",
        prNumber: 7,
        htmlUrl: "https://github.com/acme/widget/pull/7",
        mergedAt: 1735787045000,
      },
    ]);
    const read = await f.service.getWorkItemCollaboration(f.target, "wi-pr");
    assert.equal(read?.pullRequests[0]!.state, "merged");
    assert.equal(read?.pullRequests[0]!.apiMergeable, "CONFLICTING");
    assert.equal(read?.pullRequests[0]!.apiMergeStateStatus, "DIRTY");
    assert.equal(
      (await f.runtimeOf()).workItemRepo.get("wi-pr")!.status,
      "in_review",
      "D2 只报出 merged 事实，终态迁移是 D3 的事（唯一写者仍是 WorkItemService.transition）",
    );
  } finally {
    f.cleanup();
  }
});

test("守卫｜provider 与 sync 的构造点唯一在组合根（第二处实现会让快照口径分叉而不报错）", () => {
  const strip = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const runtime = strip(readSource("../src/workitem/squadRuntime.ts"));
  for (const token of ["createDefaultPullRequestProvider(", "createPullRequestSync("]) {
    assert.equal(
      runtime.split(token).length - 1,
      1,
      `squadRuntime.ts 必须恰有一处 ${token}（构造点唯一）`,
    );
  }
  // 门面只用类型 + URL 归一化纯函数；provider 的值构造不得出现在门面里（描述符必须浏览器安全）。
  const facade = strip(readSource("../src/workitem/workItemCollaborationService.ts"));
  assert.equal(facade.includes("createGitHubPullRequestProvider("), false);
  assert.equal(facade.includes("createNullPullRequestProvider("), false);
});
