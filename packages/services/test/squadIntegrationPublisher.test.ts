import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import {
  createNullPullRequestProvider,
  type CreatePullRequestInput,
  type PullRequestCreateResult,
  type PullRequestListResult,
  type PullRequestProvider,
  type RemotePullRequestFact,
} from "../src/workitem/pullRequestProvider.js";
import {
  createSquadIntegrationPublisher,
  parseGitHubRemoteUrl,
} from "../src/workitem/squadIntegrationPublisher.js";
import { createWorkItemPullRequestRepo } from "../src/workitem/workItemPullRequestRepo.js";
import { makeRepo, realGit } from "./helpers/gitFixture.js";

/* #8 D3：**pr-gate 收尾的发布面**（设计 §4.4 的 `pr-gate` 行：push 集成分支 + 开 PR + 登记）。

   为什么单独一个模块、且必须是**深模块**：push、开 PR、认回已存在的 PR、登记行四件事，
   编排器、崩溃重驱、将来的「手动重试发布」三处都要做 —— 删掉它，这三处各自长出一份判据
   （先推哪条、无 remote 怎么办、422 算不算失败），复杂度在 N 个调用点重现。

   本文件的 seam（全部**真 git + 内存库 + stub provider**，不联网）：
   · `git push` 走**真实现**（origin 用 `url.<本地裸库>.insteadOf` 把 GitHub 地址映射到本地裸库 ——
     「真推送」与「GitHub 形态的 origin」同时成立，不靠打桩自证）；
   · 网络面（开 PR / 列举）是注入的 fake —— 真网络是人工演示项。

   三档降级的判据都在**任何远端写之前**（读 token / 读 remote / 认 GitHub 形态），
   失败档（push 或开 PR 真失败）与降级档**分开报**：降级 = 改走本地收尾（批次照常落地），
   失败 = 响亮（批次停手，不假装收尾成功）。 */

const WS = "publisher-ws";
const GITHUB_REMOTE = "https://github.com/acme/widget.git";
const INTEGRATION = "squad/integration/wi-p";

const run = promisify(execFile);

/** 远端 PR 事实（stub 的返回原料；字段手写字面量，不从实现算）。 */
function remoteFact(over: Partial<RemotePullRequestFact> = {}): RemotePullRequestFact {
  return {
    number: 42,
    htmlUrl: "https://github.com/acme/widget/pull/42",
    snapshot: {
      state: "open",
      mergedAt: null,
      title: "批次 A",
      branch: INTEGRATION,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      headSha: "sha-int-1",
      fetchedAt: 555,
    },
    ...over,
  };
}

/** 计数与可编程返回的 provider stub（联网面全部在这里被截住）。 */
function stubProvider(over: {
  available?: boolean;
  create?: (input: CreatePullRequestInput) => PullRequestCreateResult;
  list?: (input: { prefix: string }) => PullRequestListResult;
}): { provider: PullRequestProvider; creates: CreatePullRequestInput[]; lists: string[] } {
  const creates: CreatePullRequestInput[] = [];
  const lists: string[] = [];
  const available = over.available ?? true;
  return {
    creates,
    lists,
    provider: {
      describe: () =>
        available ? { available: true } : { available: false, reason: "未配置 token（stub）" },
      fetchPullRequest: async () => ({
        ok: false,
        code: "unavailable",
        reason: "本用例不走读路径",
      }),
      createPullRequest: async (input) => {
        creates.push(input);
        if (over.create) return over.create(input);
        return { ok: true, pullRequest: remoteFact() };
      },
      listOpenByBranchPrefix: async (input) => {
        lists.push(input.prefix);
        if (over.list) return over.list(input);
        return { ok: true, pullRequests: [] };
      },
    },
  };
}

type RemoteKind = "github" | "none" | "non_github" | "unreachable_github";

/**
 * 真仓库夹具：main 有一次提交；集成分支 `squad/integration/wi-p` 上多一个提交（模拟队员成果已合入）；
 * 远端按 `remote` 三形态注入（github = 本地裸库经 insteadOf 承接；non_github = 本地裸库直连；
 * unreachable_github = GitHub 地址映射到一个不存在的本地路径 ⇒ push 必败且不触网）。
 */
async function setup(options: { remote: RemoteKind } = { remote: "github" }) {
  const repoRoot = await makeRepo();
  const git = realGit(repoRoot);
  const gitRun = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    const result = await git(args, {});
    assert.equal(result.code, 0, `git ${args.join(" ")} 失败：${result.stderr}`);
    return { stdout: result.stdout, stderr: result.stderr };
  };
  await gitRun(["checkout", "-q", "-b", INTEGRATION]);
  writeFileSync(join(repoRoot, "feature.txt"), "feature\n");
  await gitRun(["add", "-A"]);
  await gitRun(["commit", "-qm", "member work"]);
  await gitRun(["checkout", "-q", "main"]);

  let bareRoot: string | null = null;
  if (options.remote === "github" || options.remote === "non_github") {
    bareRoot = mkdtempSync(join(tmpdir(), "publisher-remote-"));
    await run("git", ["init", "-q", "--bare", "-b", "main", bareRoot]);
  }
  if (options.remote === "github") {
    await gitRun(["remote", "add", "origin", GITHUB_REMOTE]);
    await gitRun(["config", `url.${bareRoot!}.insteadOf`, GITHUB_REMOTE]);
  } else if (options.remote === "non_github") {
    await gitRun(["remote", "add", "origin", bareRoot!]);
  } else if (options.remote === "unreachable_github") {
    const missing = join(tmpdir(), `publisher-missing-${Date.now()}.git`);
    await gitRun(["remote", "add", "origin", GITHUB_REMOTE]);
    await gitRun(["config", `url.${missing}.insteadOf`, GITHUB_REMOTE]);
  }

  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const repo = createWorkItemPullRequestRepo(db);
  const warnings: string[] = [];
  const publisher = (provider: PullRequestProvider) =>
    createSquadIntegrationPublisher({
      git,
      repoRoot,
      workspace: { key: WS, path: repoRoot },
      provider,
      repo,
      now: () => 9_000,
      logWarn: (message) => warnings.push(message),
    });
  return {
    repoRoot,
    bareRoot,
    repo,
    publisher,
    warnings,
    integrationSha: (await gitRun(["rev-parse", "refs/heads/" + INTEGRATION])).stdout.trim(),
    remoteBranchSha: async (branch: string): Promise<string | null> => {
      if (bareRoot === null) return null;
      const result = await git(["rev-parse", "-q", "--verify", `refs/heads/${branch}`], {
        cwd: bareRoot,
      });
      return result.code === 0 ? result.stdout.trim() : null;
    },
    cleanup: () => {
      rmSync(repoRoot, { recursive: true, force: true });
      if (bareRoot !== null) rmSync(bareRoot, { recursive: true, force: true });
    },
  };
}

const publishInput = {
  workItemId: "wi-p",
  workItemTitle: "批次 A",
  integration: INTEGRATION,
  target: "main",
};

test("parseGitHubRemoteUrl｜https / ssh（两种写法）/ 带 .git 与尾斜杠都认；非 GitHub 与非远程形态一律 null", () => {
  for (const [url, expected] of [
    ["https://github.com/acme/widget.git", { repoOwner: "acme", repoName: "widget" }],
    ["https://github.com/acme/widget", { repoOwner: "acme", repoName: "widget" }],
    ["https://www.github.com/acme/widget.git/", { repoOwner: "acme", repoName: "widget" }],
    ["git@github.com:acme/widget.git", { repoOwner: "acme", repoName: "widget" }],
    ["ssh://git@github.com/acme/widget.git", { repoOwner: "acme", repoName: "widget" }],
  ] as Array<[string, { repoOwner: string; repoName: string }]>) {
    assert.deepEqual(parseGitHubRemoteUrl(url), expected, url);
  }
  for (const url of [
    "",
    "   ",
    "/tmp/remote.git",
    "file:///tmp/remote.git",
    "https://gitlab.com/acme/widget.git",
    "git@gitlab.com:acme/widget.git",
    "https://github.com/acme",
    "https://github.com/acme/widget/extra",
    "not a url",
  ]) {
    assert.equal(parseGitHubRemoteUrl(url), null, `必须不认：${url}`);
  }
});

test("发布成功｜真 push 到 origin（GitHub 形态）+ 开 PR + 登记行（分支/快照/系统归因）", async () => {
  const f = await setup({ remote: "github" });
  const { provider, creates } = stubProvider({});
  try {
    const outcome = await f.publisher(provider).publishForReview(publishInput);

    assert.equal(outcome.status, "published", JSON.stringify(outcome));
    // ① 远端真有这条分支，且 sha 与本地集成分支一致（真 push，不是打桩自证）。
    assert.equal(await f.remoteBranchSha(INTEGRATION), f.integrationSha);
    // ② 开 PR 的形状：owner/name 从 origin 解析出来；head/base/title 是事实。
    assert.equal(creates.length, 1);
    assert.deepEqual(
      {
        repoOwner: creates[0]!.repoOwner,
        repoName: creates[0]!.repoName,
        head: creates[0]!.head,
        base: creates[0]!.base,
        title: creates[0]!.title,
      },
      { repoOwner: "acme", repoName: "widget", head: INTEGRATION, base: "main", title: "批次 A" },
    );
    assert.match(creates[0]!.body ?? "", /wi-p/, "正文带工作项 id（人看得出这是哪条批）");
    // ③ 登记行：分支是登记时已知的 head；快照来自创建响应；归因=系统（自动，不是人贴的）。
    const row = f.repo.listByWorkItem(WS, "wi-p")[0]!;
    assert.equal(row.prNumber, 42);
    assert.equal(row.branch, INTEGRATION);
    assert.equal(row.state, "open");
    assert.equal(row.snapshotHeadSha, "sha-int-1");
    assert.equal(row.snapshotFetchedAt, 555);
    assert.equal(row.htmlUrl, "https://github.com/acme/widget/pull/42");
    assert.deepEqual(row.linkedBy, { kind: "system", id: "squad-runtime" });
    if (outcome.status === "published") assert.equal(outcome.pullRequest.id, row.id);

    // ④ 重投（崩溃重驱的形态）：同一 PR 不产生第二行（登记幂等），也不重复报错。
    const again = await f.publisher(provider).publishForReview(publishInput);
    assert.equal(again.status, "published");
    assert.equal(f.repo.listByWorkItem(WS, "wi-p").length, 1, "同一条 PR 只有一行");
  } finally {
    f.cleanup();
  }
});

test("降级①｜没配 token（null provider）：degraded=no_token，且**零远端写**（没 push、没开 PR、没登记行）", async () => {
  const f = await setup({ remote: "github" });
  // 本用例要的是**真正的离线 adapter**（null provider）；stub 只用来记「有没有被调用」。
  const { creates, lists } = stubProvider({});
  try {
    const outcome = await f
      .publisher(createNullPullRequestProvider())
      .publishForReview(publishInput);
    assert.equal(outcome.status, "degraded");
    if (outcome.status !== "degraded") return;
    assert.equal(outcome.code, "no_token");
    assert.match(outcome.reason, /token|令牌/i, "降级原因必须说清为什么降级（不静默）");
    assert.equal(await f.remoteBranchSha(INTEGRATION), null, "降级 ⇒ 一个字节都不该推到远端");
    assert.equal(f.repo.listByWorkItem(WS, "wi-p").length, 0);
    assert.equal(creates.length + lists.length, 0, "stub provider 的写/列举口一次都不该被调用");
  } finally {
    f.cleanup();
  }
});

test("降级②｜本仓库没有 remote：degraded=no_remote，在推送之前判定（零远端写、零出站）", async () => {
  const f = await setup({ remote: "none" });
  const { provider, creates } = stubProvider({});
  try {
    const outcome = await f.publisher(provider).publishForReview(publishInput);
    assert.equal(outcome.status, "degraded");
    if (outcome.status !== "degraded") return;
    assert.equal(outcome.code, "no_remote");
    assert.match(outcome.reason, /远端|remote/i);
    assert.equal(creates.length, 0);
    assert.equal(f.repo.listByWorkItem(WS, "wi-p").length, 0);
  } finally {
    f.cleanup();
  }
});

test("降级③｜origin 不是 GitHub（本地/其它托管）：degraded=remote_not_github，且**没有推送**", async () => {
  const f = await setup({ remote: "non_github" });
  const { provider, creates } = stubProvider({});
  try {
    const outcome = await f.publisher(provider).publishForReview(publishInput);
    assert.equal(outcome.status, "degraded");
    if (outcome.status !== "degraded") return;
    assert.equal(outcome.code, "remote_not_github");
    assert.match(outcome.reason, /GitHub/i);
    assert.equal(
      await f.remoteBranchSha(INTEGRATION),
      null,
      "降级在**推送之前**判定：远端一个字节都不写（不是推完才发现开不了 PR）",
    );
    assert.equal(creates.length, 0);
  } finally {
    f.cleanup();
  }
});

test("失败①｜push 真失败：failed（带 git 原文），不开 PR、不登记行（不假装收尾成功）", async () => {
  const f = await setup({ remote: "unreachable_github" });
  const { provider, creates } = stubProvider({});
  try {
    const outcome = await f.publisher(provider).publishForReview(publishInput);
    assert.equal(outcome.status, "failed");
    if (outcome.status !== "failed") return;
    assert.match(outcome.reason, /push|仓库|repository/i, "原因要带 git 原文（人才能修）");
    assert.equal(creates.length, 0, "推不上去就不该开 PR");
    assert.equal(f.repo.listByWorkItem(WS, "wi-p").length, 0);
  } finally {
    f.cleanup();
  }
});

test("失败②｜开 PR 真失败（500）：failed（带远端原因），不登记行", async () => {
  const f = await setup({ remote: "github" });
  const { provider } = stubProvider({
    create: () => ({
      ok: false,
      code: "http_error",
      status: 500,
      reason: "GitHub 返回 500：远端拒绝了这次创建。",
    }),
  });
  try {
    const outcome = await f.publisher(provider).publishForReview(publishInput);
    assert.equal(outcome.status, "failed");
    if (outcome.status !== "failed") return;
    assert.match(outcome.reason, /500/);
    assert.equal(f.repo.listByWorkItem(WS, "wi-p").length, 0);
  } finally {
    f.cleanup();
  }
});

test("崩溃窗口认回｜开 PR 返回 422（同 head 已存在）：按分支前缀列出并认回那条，登记成同一行", async () => {
  const f = await setup({ remote: "github" });
  const { provider, lists } = stubProvider({
    create: () => ({
      ok: false,
      code: "http_error",
      status: 422,
      reason: "GitHub 返回 422：这次创建被拒 —— 常见因：同 head 分支的 PR 已存在。",
    }),
    list: () => ({
      ok: true,
      pullRequests: [
        remoteFact({
          number: 77,
          htmlUrl: "https://github.com/acme/widget/pull/77",
          snapshot: {
            state: "open",
            mergedAt: null,
            title: "上一次崩溃前开出来的 PR",
            branch: "squad/integration/wi-other",
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            headSha: "sha-other",
            fetchedAt: 1,
          },
        }),
        remoteFact({
          number: 78,
          htmlUrl: "https://github.com/acme/widget/pull/78",
          snapshot: {
            state: "open",
            mergedAt: null,
            title: "本批的 PR（崩溃前已建）",
            branch: INTEGRATION,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            headSha: "sha-int-9",
            fetchedAt: 2,
          },
        }),
      ],
    }),
  });
  try {
    const outcome = await f.publisher(provider).publishForReview(publishInput);
    assert.equal(outcome.status, "published", JSON.stringify(outcome));
    assert.deepEqual(
      lists,
      [INTEGRATION],
      "按集成分支前缀列举（精确等于集成分支的那条才是本批的）",
    );
    const row = f.repo.listByWorkItem(WS, "wi-p")[0]!;
    assert.equal(row.prNumber, 78, "认回的是 head == 集成分支的那条，不是别的分支的");
    assert.equal(row.snapshotHeadSha, "sha-int-9");
    assert.equal(row.branch, INTEGRATION);
    assert.ok(
      f.warnings.some((message) => /认回|已存在/.test(message)),
      `认回这件事必须留痕（否则「PR 是哪来的」在日志里查不出）：${JSON.stringify(f.warnings)}`,
    );
  } finally {
    f.cleanup();
  }
});

test("崩溃窗口认回｜422 且列举里没有本批（真 422：无差异/分支不存在）：failed 原样带出原因", async () => {
  const f = await setup({ remote: "github" });
  const { provider } = stubProvider({
    create: () => ({
      ok: false,
      code: "http_error",
      status: 422,
      reason: "GitHub 返回 422：head 与 base 之间没有差异。",
    }),
    list: () => ({
      ok: true,
      // 列表里只有**别的**分支的 PR：本批的 PR 根本不存在（真 422：无差异 / base 不存在）。
      pullRequests: [
        remoteFact({
          number: 9,
          snapshot: {
            state: "open",
            mergedAt: null,
            title: "别的批的 PR",
            branch: "squad/integration/wi-other",
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            headSha: "sha-other",
            fetchedAt: 3,
          },
        }),
      ],
    }),
  });
  try {
    const outcome = await f.publisher(provider).publishForReview(publishInput);
    assert.equal(outcome.status, "failed");
    if (outcome.status !== "failed") return;
    assert.match(outcome.reason, /422/);
  } finally {
    f.cleanup();
  }
});
