import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import type { SquadMergeMode } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createSquadOrchestrator } from "../src/workitem/squadOrchestrator.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import { createWorkItemPullRequestEntry } from "../src/workitem/workItemPullRequestEntry.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import { slugForId } from "../src/workitem/slug.js";
import { makeRepo, realGit } from "./helpers/gitFixture.js";

/* #8 D3：**pr-gate 模式的整批收尾**（设计 §4.4 的 `pr-gate` 行：finalize 改 push + 开 PR，
   终态交 PR merge）。

   与本地模式的差异（本文件逐条钉住）：
   · 集成分支**推到远端**并**开 PR**（不是合回本地 target）；本地 target 一个字节不动；
   · **父项留 `in_review`**（终态交 PR merge —— 由 `workItemPullRequestEntry.refresh` 的终态驱动给）；
   · 集成分支**保留**（它是 PR 的 head；本地模式在这里删它）；
   · 队员 run 照常抛弃（成果已在集成分支上、也已推到远端 —— 清理与本地模式同款）；
   · 幂等重驱闸的判据从「集成分支不在」变成「**本批已发布过 PR**」（分支还在，故旧判据失效）。

   外部世界（GitHub REST）用**注入的 fetch stub** 截住（真网络是人工演示项）；git 侧全真
   （push 走 `url.<本地裸库>.insteadOf` 映射 —— 真推送 + GitHub 形态的 origin 同时成立）。
   三档降级（没 token / 没远端 / 远端不是 GitHub）⇒ 改走本地形态收尾 + 收件箱留痕。 */

const WS = "pr-gate-ws";
const TOKEN = "ghp_pr_gate_stub_token";
const GITHUB_REMOTE = "https://github.com/acme/widget.git";
const run = promisify(execFile);

/** GitHub REST stub：POST /pulls 回创建响应（head 取请求体里的 head，同真实 GitHub），
 *  并记录每次调用（用例据此断言「有没有发出去」「发了几次」）。 */
function githubStub(): {
  impl: typeof fetch;
  calls: Array<{
    method: string;
    url: string;
    op: string | null;
    body: Record<string, unknown> | null;
  }>;
} {
  const calls: Array<{
    method: string;
    url: string;
    op: string | null;
    body: Record<string, unknown> | null;
  }> = [];
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method, url, op: body === null ? null : String(body.head ?? ""), body });
    const payload = {
      number: 42,
      state: "open",
      draft: false,
      merged: false,
      merged_at: null,
      title: (body?.title as string | undefined) ?? "批次 A",
      html_url: "https://github.com/acme/widget/pull/42",
      head: { ref: body?.head ?? "unknown", sha: "sha-int-published" },
      mergeable: true,
      mergeable_state: "clean",
    };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

async function setup(options: {
  mode?: SquadMergeMode;
  token?: string;
  remote: "github" | "none" | "non_github" | "unreachable_github";
  fetchImpl?: typeof fetch;
}): Promise<{
  repoRoot: string;
  runtime: SquadRuntime;
  orchestrator: ReturnType<typeof createSquadOrchestrator>;
  remoteBranchSha: (branch: string) => Promise<string | null>;
  branchHeadSha: (branch: string) => Promise<string>;
  fetchCalls: Array<{ method: string; url: string; op: string | null }>;
  cleanup: () => void;
}> {
  const repoRoot = await makeRepo();
  const git = realGit(repoRoot);
  const gitRun = async (args: string[]): Promise<string> => {
    const result = await git(args, {});
    assert.equal(result.code, 0, `git ${args.join(" ")} 失败：${result.stderr}`);
    return result.stdout.trim();
  };

  let bareRoot: string | null = null;
  if (options.remote === "github" || options.remote === "non_github") {
    bareRoot = mkdtempSync(join(tmpdir(), "pr-gate-remote-"));
    await run("git", ["init", "-q", "--bare", "-b", "main", bareRoot]);
  }
  if (options.remote === "github") {
    await gitRun(["remote", "add", "origin", GITHUB_REMOTE]);
    await gitRun(["config", `url.${bareRoot!}.insteadOf`, GITHUB_REMOTE]);
  } else if (options.remote === "non_github") {
    await gitRun(["remote", "add", "origin", bareRoot!]);
  } else if (options.remote === "unreachable_github") {
    const missing = join(tmpdir(), `pr-gate-missing-${Date.now()}.git`);
    await gitRun(["remote", "add", "origin", GITHUB_REMOTE]);
    await gitRun(["config", `url.${missing}.insteadOf`, GITHUB_REMOTE]);
  }

  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const stub = githubStub();
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: WS,
    readExperimentEnabled: () => true,
    readSquadMergeMode: () => options.mode ?? "local",
    readGithubPullRequestToken: () => options.token,
    githubFetch: options.fetchImpl ?? stub.impl,
  });
  return {
    repoRoot,
    db,
    runtime,
    orchestrator: createSquadOrchestrator({ runtime }),
    remoteBranchSha: async (branch: string) => {
      if (bareRoot === null) return null;
      const result = await git(["rev-parse", "-q", "--verify", `refs/heads/${branch}`], {
        cwd: bareRoot,
      });
      return result.code === 0 ? result.stdout.trim() : null;
    },
    branchHeadSha: (branch: string) => gitRun(["rev-parse", `refs/heads/${branch}`]),
    fetchCalls: stub.calls,
    cleanup: () => {
      rmSync(repoRoot, { recursive: true, force: true });
      if (bareRoot !== null) rmSync(bareRoot, { recursive: true, force: true });
    },
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

/** 工作项活动（时间线回声）的读回口：与 runtime 同一库、真 repo（不经过任何门面）。 */
function activitiesOf(f: Fixture, workItemId: string) {
  return createWorkItemActivityRepo(f.db).listByWorkItem(WS, workItemId);
}

/** 一条「父项 + 一个子项」的批（与 squadOrchestrator.batch.test.ts 同形，本文件自持一份）。 */
async function batchWithOneChild(f: Fixture) {
  const parent = f.runtime.workItemService.create({
    id: "wi-p",
    workspaceIdentity: WS,
    workspacePath: f.repoRoot,
    title: "批次 A",
    assignee: { type: "squad", id: "sq1" },
  });
  f.runtime.workItemService.create({
    id: "wi-c",
    workspaceIdentity: WS,
    workspacePath: f.repoRoot,
    title: "子任务",
    parentId: parent.id,
    assignee: { type: "agent", id: "ta-a" },
  });
  f.runtime.workItemService.transition("wi-c", "in_progress", "todo");
  f.runtime.workItemService.transition(parent.id, "in_review", "todo");
  return { parentId: parent.id };
}

/** 队员开树 + 提交一个文件 + 上报完成（run → produced、子项 → in_review）。 */
async function produce(f: Fixture): Promise<{ branch: string }> {
  const opened = await f.runtime.lifecycle.openMemberRun({
    runId: "r-a",
    workItemId: "wi-c",
    parentWorkItemId: "wi-p",
    agentId: "ta-a",
    isLeaderTask: false,
  });
  writeFileSync(join(opened.worktreePath, "feature.txt"), "feature\n");
  const git = realGit(opened.worktreePath);
  for (const args of [
    ["add", "-A"],
    ["commit", "-qm", "member work"],
  ]) {
    const result = await git(args, {});
    assert.equal(result.code, 0, `${args.join(" ")} 失败：${result.stderr}`);
  }
  await f.runtime.lifecycle.completeMemberRun({ runId: "r-a" });
  return { branch: opened.branch };
}

/** 把子项推到终态（批的触发条件）。 */
function finishChild(f: Fixture): void {
  f.runtime.workItemService.transition("wi-c", "done", "in_review");
}

function status(f: Fixture, id: string): string {
  const item = f.runtime.workItemRepo.get(id);
  assert.ok(item, `工作项 ${id} 应当存在`);
  return item.status;
}

function runStatus(f: Fixture, runId: string): string {
  const record = f.runtime.squadRunRepo.get(runId);
  assert.ok(record, `run ${runId} 应当存在`);
  return record.status;
}

async function branchExists(f: Fixture, branch: string): Promise<boolean> {
  return (
    (
      await f.runtime.git(["rev-parse", "-q", "--verify", `refs/heads/${branch}`], {
        cwd: f.repoRoot,
      })
    ).code === 0
  );
}

function integrationBranch(): string {
  return `squad/integration/${slugForId("wi-c")}`;
}

/** 本地 target 上有没有这个文件（用 code 判：不存在 ⇒ 非 0，不打桩）。 */
async function targetHasFile(f: Fixture, file: string): Promise<boolean> {
  const result = await f.runtime.git(["cat-file", "-e", `refs/heads/main:${file}`], {
    cwd: f.repoRoot,
  });
  return result.code === 0;
}

test("pr-gate 发布｜push 集成分支 + 开 PR + 登记行；父项留 in_review、集成分支保留、本地 target 未动、队员已清理", async () => {
  const f = await setup({ mode: "pr-gate", token: TOKEN, remote: "github" });
  try {
    const { parentId } = await batchWithOneChild(f);
    await produce(f);
    finishChild(f);

    await f.orchestrator.advanceAfterChildrenDone({
      workspaceKey: WS,
      parentWorkItemId: parentId,
    });

    const integration = integrationBranch();
    // ① 远端真有集成分支，sha 与本地一致（真 push）。
    assert.equal(
      await f.remoteBranchSha(integration),
      await f.branchHeadSha(integration),
      "集成分支必须真的推到了 origin",
    );
    // ② PR 行：分支=登记时已知的 head、状态=创建响应里的 open、归因=系统。
    const rows = f.runtime.pullRequestRepo.listByWorkItem(WS, parentId);
    assert.equal(rows.length, 1, "本批恰一条 PR 关联");
    assert.equal(rows[0]!.prNumber, 42);
    assert.equal(rows[0]!.branch, integration);
    assert.equal(rows[0]!.state, "open");
    assert.equal(rows[0]!.snapshotHeadSha, "sha-int-published");
    assert.equal(rows[0]!.linkedBy.kind, "system");
    // ③ 终态**不**由本地收尾给：父项停在 in_review 等 PR merge。
    assert.equal(
      status(f, parentId),
      "in_review",
      "pr-gate 的终态交 PR merge（设计 §4.4）：本地收尾不得抢先把父项置 done",
    );
    // ④ 本地 target 一个字节不动（成果只在集成分支/远端）。
    assert.equal(await targetHasFile(f, "feature.txt"), false, "本地 main 不得带上本批成果");
    // ⑤ 集成分支保留（PR 的 head）；队员 run 照常抛弃（成果已在分支上）。
    assert.equal(await branchExists(f, integration), true, "集成分支是 PR 的 head，不能删");
    assert.equal(runStatus(f, "r-a"), "discarded");
    // ⑥ 开 PR 的形状：head=集成分支、base=main。
    const created = f.fetchCalls.filter((call) => call.method === "POST");
    assert.equal(created.length, 1);
    assert.match(created[0]!.url, /\/repos\/acme\/widget\/pulls$/);
    assert.equal(created[0]!.op, integration);
  } finally {
    f.cleanup();
  }
});

test("pr-gate 重驱闸｜已发布的批被重投（同一次收尾再来一遍）⇒ 空转：不重复 push、不重复开 PR、状态一字不动", async () => {
  const f = await setup({ mode: "pr-gate", token: TOKEN, remote: "github" });
  try {
    const { parentId } = await batchWithOneChild(f);
    await produce(f);
    finishChild(f);
    await f.orchestrator.advanceAfterChildrenDone({
      workspaceKey: WS,
      parentWorkItemId: parentId,
    });
    const postsAfterFirst = f.fetchCalls.filter((call) => call.method === "POST").length;
    const rowsAfterFirst = f.runtime.pullRequestRepo.listByWorkItem(WS, parentId);
    assert.equal(postsAfterFirst, 1);

    // 重投（重连 / 重复挂订阅 / 调用方重试的形态）：事件驱动路径的幂等口径。
    await f.orchestrator.advanceAfterChildrenDone({
      workspaceKey: WS,
      parentWorkItemId: parentId,
    });

    assert.equal(
      f.fetchCalls.filter((call) => call.method === "POST").length,
      1,
      "重驱不得再开第二次 PR（旧判据「集成分支不在」在 pr-gate 下失效，必须按「本批已发布」判）",
    );
    assert.deepEqual(
      f.runtime.pullRequestRepo.listByWorkItem(WS, parentId).map((row) => row.id),
      rowsAfterFirst.map((row) => row.id),
      "关联行一字不动（不新增、不改写）",
    );
    assert.equal(status(f, parentId), "in_review", "重驱不得改状态");
    assert.equal(await branchExists(f, integrationBranch()), true, "集成分支照旧保留");
  } finally {
    f.cleanup();
  }
});

/** 降级三形态的公共断言：统一收尾为**本地形态**（成果落 target、父项 done、集成分支删）+ 一条留痕。 */
async function expectDegradedToLocal(f: Fixture, expectedCode: string): Promise<void> {
  const integration = integrationBranch();
  assert.equal(status(f, "wi-p"), "done", "降级 ⇒ 按本地形态收尾（批次照常落地）");
  assert.equal(await targetHasFile(f, "feature.txt"), true, "降级 ⇒ 成果合回本地 target");
  assert.equal(await branchExists(f, integration), false, "降级 ⇒ 集成分支照本地模式删掉");
  assert.equal(
    f.runtime.pullRequestRepo.listByWorkItem(WS, "wi-p").length,
    0,
    "降级 ⇒ 一条 PR 关联都不该有（没有开出去的 PR）",
  );
  assert.equal(f.fetchCalls.length, 0, "降级的三档都在任何出站之前判定（零请求）");
  const inbox = f.runtime.inboxItemRepo.listByWorkspace(WS);
  assert.equal(inbox.length, 1, "降级必须留痕（不静默）");
  assert.equal(inbox[0]!.kind, "pr_gate_degraded");
  assert.equal(inbox[0]!.severity, "attention");
  assert.equal(inbox[0]!.detail["code"], expectedCode);
  assert.equal(inbox[0]!.detail["integrationBranch"], integration);
  assert.ok(String(inbox[0]!.detail["reason"]).trim() !== "", "留痕要带原因原文");
}

test("降级①｜pr-gate 但没配 token ⇒ 本地收尾 + pr_gate_degraded(no_token)", async () => {
  const f = await setup({ mode: "pr-gate", token: undefined, remote: "github" });
  try {
    const { parentId } = await batchWithOneChild(f);
    await produce(f);
    finishChild(f);
    await f.orchestrator.advanceAfterChildrenDone({
      workspaceKey: WS,
      parentWorkItemId: parentId,
    });
    await expectDegradedToLocal(f, "no_token");
  } finally {
    f.cleanup();
  }
});

test("降级②｜pr-gate 但本仓库没有远端 ⇒ 本地收尾 + pr_gate_degraded(no_remote)", async () => {
  const f = await setup({ mode: "pr-gate", token: TOKEN, remote: "none" });
  try {
    const { parentId } = await batchWithOneChild(f);
    await produce(f);
    finishChild(f);
    await f.orchestrator.advanceAfterChildrenDone({
      workspaceKey: WS,
      parentWorkItemId: parentId,
    });
    await expectDegradedToLocal(f, "no_remote");
  } finally {
    f.cleanup();
  }
});

test("降级③｜pr-gate 但远端不是 GitHub ⇒ 本地收尾 + pr_gate_degraded(remote_not_github)，且**没有 push**", async () => {
  const f = await setup({ mode: "pr-gate", token: TOKEN, remote: "non_github" });
  try {
    const { parentId } = await batchWithOneChild(f);
    await produce(f);
    finishChild(f);
    await f.orchestrator.advanceAfterChildrenDone({
      workspaceKey: WS,
      parentWorkItemId: parentId,
    });
    await expectDegradedToLocal(f, "remote_not_github");
    assert.equal(
      await f.remoteBranchSha(integrationBranch()),
      null,
      "降级在推送之前判定：本地远端（裸库）一个字节都不该写",
    );
  } finally {
    f.cleanup();
  }
});

test("pr-gate 真失败（push 被拒）⇒ 响亮抛；父项留 in_review、集成分支保留、本地 target 未动、零关联行", async () => {
  const f = await setup({ mode: "pr-gate", token: TOKEN, remote: "unreachable_github" });
  try {
    const { parentId } = await batchWithOneChild(f);
    await produce(f);
    finishChild(f);
    await assert.rejects(
      () =>
        f.orchestrator.advanceAfterChildrenDone({
          workspaceKey: WS,
          parentWorkItemId: parentId,
        }),
      /推送集成分支到 origin 失败/,
      "推送失败必须响亮（不降级：远端那条路已开始走，悄悄改回本地会让同一批成果两处落地）",
    );
    assert.equal(status(f, parentId), "in_review");
    assert.equal(await branchExists(f, integrationBranch()), true);
    assert.equal(await targetHasFile(f, "feature.txt"), false, "本地 target 一个字节不动");
    assert.equal(f.runtime.pullRequestRepo.listByWorkItem(WS, parentId).length, 0);
    assert.equal(
      f.runtime.inboxItemRepo.listByWorkspace(WS).length,
      0,
      "失败不是降级：不留 pr_gate_degraded（那是「照常收尾但换了条路」的记录）",
    );
  } finally {
    f.cleanup();
  }
});

test("local 模式（开关关闭态）｜有 GitHub remote 且配了 token：**零出站、零远端写**，本地收尾与改前一致", async () => {
  /* 行为中立的锚点（简报的硬要求）：缺省/显式 local 时，pr-gate 的那条路一步都不该走 ——
     配置齐备（token + GitHub remote）也不许发一个请求、不许往远端推一个字节。 */
  const f = await setup({ mode: "local", token: TOKEN, remote: "github" });
  try {
    const { parentId } = await batchWithOneChild(f);
    await produce(f);
    finishChild(f);
    await f.orchestrator.advanceAfterChildrenDone({
      workspaceKey: WS,
      parentWorkItemId: parentId,
    });

    assert.equal(f.fetchCalls.length, 0, "local 模式零出站（配置齐备也不许发请求）");
    assert.equal(
      await f.remoteBranchSha(integrationBranch()),
      null,
      "local 模式零远端写（不 push）",
    );
    assert.equal(status(f, parentId), "done", "本地收尾照旧：父项 done");
    assert.equal(await targetHasFile(f, "feature.txt"), true, "成果合回本地 target");
    assert.equal(await branchExists(f, integrationBranch()), false, "集成分支照旧删掉");
    assert.equal(f.runtime.pullRequestRepo.listByWorkItem(WS, parentId).length, 0);
    assert.equal(f.runtime.inboxItemRepo.listByWorkspace(WS).length, 0, "local 模式没有降级留痕");
  } finally {
    f.cleanup();
  }
});

test("pr-gate **全链**｜push+开 PR+登记 ⇒ 父项留 in_review；PR 被合并后一次刷新 ⇒ done + 回声（同一条链跨两个缝合面）", async () => {
  /* 本用例把两半接起来跑（stub 网络 + 真 git/真库/真状态机）：
     ① pr-gate 收尾（写路径：POST /pulls）；
     ② 远端把 PR 合并之后的一次按需刷新（读路径：GET /pulls/42）⇒ 终态驱动。
     「等 merge」这一段用 stub 的**状态翻转**表达（真实等待由人操作 GitHub 完成）。 */
  let merged = false;
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const payload = {
      number: 42,
      state: merged ? "closed" : "open",
      draft: false,
      merged,
      merged_at: merged ? "2025-01-02T03:04:05Z" : null,
      title: (body?.title as string | undefined) ?? "批次 A",
      html_url: "https://github.com/acme/widget/pull/42",
      head: { ref: body?.head ?? "squad/integration/wi-c", sha: "sha-pr-head" },
      mergeable: true,
      mergeable_state: "clean",
    };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const f = await setup({ mode: "pr-gate", token: TOKEN, remote: "github", fetchImpl });
  try {
    const { parentId } = await batchWithOneChild(f);
    await produce(f);
    finishChild(f);
    await f.orchestrator.advanceAfterChildrenDone({
      workspaceKey: WS,
      parentWorkItemId: parentId,
    });

    // ① 发布完成：PR 行在、父项等验收、集成分支保留（PR head）。
    assert.equal(status(f, parentId), "in_review", "发布完成 ⇒ 留 in_review 等 PR merge");
    const row = f.runtime.pullRequestRepo.listByWorkItem(WS, parentId)[0]!;
    assert.equal(row.state, "open");
    assert.equal(await branchExists(f, integrationBranch()), true);
    assert.equal(f.runtime.pullRequestRepo.listByWorkItem(WS, parentId).length, 1);

    // ② 远端合并后的一次按需刷新（走协作入口——终态驱动的调用点）。
    merged = true;
    const entry = createWorkItemPullRequestEntry({
      runtime: f.runtime,
      workspaceKey: WS,
      actor: () => ({ kind: "human", id: "u-1" }),
      now: () => 12_345,
    });
    const report = await entry.refresh({ workItemId: parentId });

    assert.deepEqual(
      report.mergedPullRequests.map((fact) => fact.prNumber),
      [42],
      "刷新报出 merged 事实（D2 的读出）",
    );
    assert.equal(status(f, parentId), "done", "PR merge 驱动：父项 in_review → done");
    const echoes = activitiesOf(f, parentId).filter((row) => row.kind === "pr_merged");
    assert.equal(echoes.length, 1, "时间线回声恰一条（第 21 枚）");
    assert.equal(echoes[0]!.payload["prNumber"], 42);
    assert.ok(
      calls.some((call) => call.startsWith("POST ")),
      "写路径确实出过站（开 PR）",
    );
    assert.ok(
      calls.some((call) => call.startsWith("GET ")),
      "读路径确实出过站（刷新快照）",
    );
  } finally {
    f.cleanup();
  }
});
