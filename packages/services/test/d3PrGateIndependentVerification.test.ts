import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import type { WorkItemStatusKey } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createGitRunner } from "../src/worktree/gitRunner.js";
import { createSquadIntegrationPublisher } from "../src/workitem/squadIntegrationPublisher.js";
import { createSquadOrchestrator } from "../src/workitem/squadOrchestrator.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import { createInboxItemRepo } from "../src/workitem/inboxItemRepo.js";
import { createWorkItemPullRequestEntry } from "../src/workitem/workItemPullRequestEntry.js";
import { createWorkItemPullRequestRepo } from "../src/workitem/workItemPullRequestRepo.js";

/* #8 D3（pr-gate）**独立复验**：不复用实现者夹具与假设，证据只以**裸 git / 裸 SQL** 为真源。

   本文件与 `d3PrGateFinalize.test.ts`（实现者）刻意分开的判据：
   · 夹具自建（含裸库、insteadOf 映射、计数 fetch stub），集成分支名**从 git refs 发现**，
     不手拼 `squad/integration/<slug>` 公式；
   · 状态断言走 `db.prepare(...)` 裸 SQL；远端/分支事实走裸 `git` 进程（不经过被测的 GitRunner）；
   · 期望的去重键字符串**手写**（不用 `computeInboxDedupKey` 反算自己的期望）。

   覆盖（本轮复验任务 1–5）：
   ① 降级三形态（no_token / no_remote / remote_not_github）：本地收尾照常 + 恰一条 Inbox + 零出站；
   ② 降级留痕去重：同因幂等、换因新条目（手写键为真源）；
   ③ 重驱闸按事实不按模式（两向）；
   ④ 终态 CAS（另一写者先落 done / 读到写之间被改 cancelled）+ 终态行 refresh 幂等；
   ⑤ pr-gate 全链（真 push 双端读数）+ local 行为中立锚点。 */

const run = promisify(execFile);

const WS = "d3-iv-ws";
const GITHUB_REMOTE = "https://github.com/iv-org/iv-repo.git";

type GitResult = { code: number; stdout: string; stderr: string };

/** 裸 git 进程（复验的读数面：不经过被测的 GitRunner 包装）。 */
async function gitRaw(args: string[], cwd?: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await run("git", args, cwd === undefined ? {} : { cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
      stderr: typeof failure.stderr === "string" ? failure.stderr : "",
    };
  }
}

/** 裸 git（必须成功；用于夹具搭建）。 */
async function gitOk(args: string[], cwd?: string): Promise<string> {
  const result = await gitRaw(args, cwd);
  assert.equal(result.code, 0, `git ${args.join(" ")} 必须成功：${result.stderr}`);
  return result.stdout.trim();
}

async function bareRefs(bareRoot: string): Promise<Map<string, string>> {
  const result = await gitRaw([
    "--git-dir",
    bareRoot,
    "for-each-ref",
    "--format=%(refname:short) %(objectname)",
  ]);
  assert.equal(result.code, 0, `读裸库 refs 失败：${result.stderr}`);
  const refs = new Map<string, string>();
  for (const line of result.stdout
    .trim()
    .split("\n")
    .filter((entry) => entry !== "")) {
    const [name, sha] = line.split(" ");
    refs.set(name!, sha!);
  }
  return refs;
}

/** 从 git 里**发现**本批的集成分支（不手拼命名公式）。 */
async function discoverIntegrationBranches(repoRoot: string): Promise<string[]> {
  const result = await gitRaw(
    ["for-each-ref", "--format=%(refname:short)", "refs/heads/squad/integration/"],
    repoRoot,
  );
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim() === "" ? [] : result.stdout.trim().split("\n");
}

function sqlOne<T>(db: DatabaseSync, sql: string, ...params: unknown[]): T {
  const row = db.prepare(sql).get(...(params as never[])) as T | undefined;
  assert.ok(row !== undefined, `裸 SQL 应有结果：${sql} ${JSON.stringify(params)}`);
  return row;
}

function sqlCount(db: DatabaseSync, sql: string, ...params: unknown[]): number {
  const row = sqlOne<{ n: number }>(db, sql, ...params);
  return row.n;
}

// ------------------------------------------------------------------------------------------------
// 计数 fetch stub（联网面全部截住；calls 是「有没有出站」的唯一证据）
// ------------------------------------------------------------------------------------------------

type StubCall = {
  method: string;
  url: string;
  head: string | null;
  body: Record<string, unknown> | null;
};

function makeFetchStub(respond: (call: StubCall) => Response | Promise<Response>): {
  impl: typeof fetch;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const call: StubCall = {
      method,
      url,
      head: body === null ? null : String(body["head"] ?? ""),
      body,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { impl, calls };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 一个「形状正确」的远端 PR 载荷（字段手写；不引用实现侧的映射）。 */
function prPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 9001,
    state: "open",
    draft: false,
    merged: false,
    merged_at: null,
    title: "独立复验批次",
    html_url: "https://github.com/iv-org/iv-repo/pull/9001",
    head: { ref: "squad/integration/unknown", sha: "sha-iv-9001" },
    mergeable: true,
    mergeable_state: "clean",
    ...over,
  };
}

// ------------------------------------------------------------------------------------------------
// 仓库夹具（自建；远程形态四档）
// ------------------------------------------------------------------------------------------------

type RemoteKind = "github_alias" | "none" | "plain_path" | "github_alias_dead";

type BatchFixture = {
  repoRoot: string;
  bareRoot: string | null;
  db: DatabaseSync;
  runtime: SquadRuntime;
  orchestrator: ReturnType<typeof createSquadOrchestrator>;
  fetchCalls: StubCall[];
  mainSha: () => Promise<string>;
  cleanup: () => void;
};

async function makeBatchFixture(options: {
  remote: RemoteKind;
  mode?: () => "local" | "pr-gate";
  token?: string;
  respond?: (call: StubCall) => Response | Promise<Response>;
}): Promise<BatchFixture> {
  const repoRoot = mkdtempSync(join(tmpdir(), "d3iv-repo-"));
  await gitOk(["init", "-q", "-b", "main"], repoRoot);
  await gitOk(["config", "user.email", "iv@example.com"], repoRoot);
  await gitOk(["config", "user.name", "iv"], repoRoot);
  writeFileSync(join(repoRoot, "seed.txt"), "seed\n");
  await gitOk(["add", "-A"], repoRoot);
  await gitOk(["commit", "-qm", "seed"], repoRoot);

  let bareRoot: string | null = null;
  if (options.remote !== "none") {
    bareRoot = mkdtempSync(join(tmpdir(), "d3iv-bare-"));
    await gitOk(["init", "-q", "--bare", "-b", "main", bareRoot]);
  }
  if (options.remote === "github_alias") {
    await gitOk(["remote", "add", "origin", GITHUB_REMOTE], repoRoot);
    await gitOk(["config", `url.${bareRoot!}.insteadOf`, GITHUB_REMOTE], repoRoot);
  } else if (options.remote === "plain_path") {
    await gitOk(["remote", "add", "origin", bareRoot!], repoRoot);
  } else if (options.remote === "github_alias_dead") {
    await gitOk(["remote", "add", "origin", GITHUB_REMOTE], repoRoot);
    await gitOk(
      [
        "config",
        `url.${join(tmpdir(), `d3iv-missing-${Date.now()}.git`)}.insteadOf`,
        GITHUB_REMOTE,
      ],
      repoRoot,
    );
  }

  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const stub = makeFetchStub(options.respond ?? (() => jsonResponse(prPayload(), 500)));
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: WS,
    readExperimentEnabled: () => true,
    ...(options.mode !== undefined ? { readSquadMergeMode: options.mode } : {}),
    readGithubPullRequestToken: () => options.token,
    githubFetch: stub.impl,
  });
  return {
    repoRoot,
    bareRoot,
    db,
    runtime,
    orchestrator: createSquadOrchestrator({ runtime }),
    fetchCalls: stub.calls,
    mainSha: async () => gitOk(["rev-parse", "refs/heads/main"], repoRoot),
    cleanup: () => {
      rmSync(repoRoot, { recursive: true, force: true });
      if (bareRoot !== null) rmSync(bareRoot, { recursive: true, force: true });
    },
  };
}

/** 批（父 + 子），子项推进到 in_progress（与生产派发后的形状一致）。 */
function seedBatch(fixture: BatchFixture): void {
  fixture.runtime.workItemService.create({
    id: "wi-iv-p",
    workspaceIdentity: WS,
    workspacePath: fixture.repoRoot,
    title: "独立复验批",
    assignee: { type: "squad", id: "sq-iv" },
  });
  fixture.runtime.workItemService.create({
    id: "wi-iv-c",
    workspaceIdentity: WS,
    workspacePath: fixture.repoRoot,
    title: "独立复验子项",
    parentId: "wi-iv-p",
    assignee: { type: "agent", id: "agent-iv" },
  });
  fixture.runtime.workItemService.transition("wi-iv-c", "in_progress", "todo");
}

/** 队员开树 → 提交 → 上报完成 → 审查通过（合入集成分支）→ 子项终态。返回集成分支名（从 git 发现）。 */
async function produceMergeAndFinish(fixture: BatchFixture): Promise<{
  integration: string;
  memberBranch: string;
  worktreePath: string;
}> {
  const opened = await fixture.runtime.lifecycle.openMemberRun({
    runId: "run-iv-1",
    workItemId: "wi-iv-c",
    parentWorkItemId: "wi-iv-p",
    agentId: "agent-iv",
    isLeaderTask: false,
  });
  assert.equal(opened.kind, "opened");
  writeFileSync(join(opened.worktreePath, "evidence.txt"), "independent\n");
  await gitOk(["add", "-A"], opened.worktreePath);
  await gitOk(["commit", "-qm", "independent evidence"], opened.worktreePath);

  await fixture.runtime.lifecycle.completeMemberRun({ runId: "run-iv-1" });
  const reviewed = await fixture.runtime.lifecycle.reviewMemberRun({
    runId: "run-iv-1",
    verdict: "approved",
  });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed));

  fixture.runtime.workItemService.transition("wi-iv-c", "done", "in_review");

  const integrations = await discoverIntegrationBranches(fixture.repoRoot);
  assert.equal(integrations.length, 1, `git 里应有恰一条集成分支：${JSON.stringify(integrations)}`);
  const memberBranch = sqlOne<{ branch: string }>(
    fixture.db,
    "SELECT branch FROM squad_runs WHERE run_id = ?",
    "run-iv-1",
  ).branch;
  return { integration: integrations[0]!, memberBranch, worktreePath: opened.worktreePath };
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  return (
    (await gitRaw(["rev-parse", "-q", "--verify", `refs/heads/${branch}`], repoRoot)).code === 0
  );
}

type InboxRow = { kind: string; severity: string; dedup_key: string; detail_json: string };

function inboxRows(db: DatabaseSync): InboxRow[] {
  return db
    .prepare(
      "SELECT kind, severity, dedup_key, detail_json FROM inbox_items WHERE workspace_key = ? ORDER BY created_at, id",
    )
    .all(WS) as unknown as InboxRow[];
}

// ------------------------------------------------------------------------------------------------
// ① 降级三形态（独立构造）：本地收尾照常 + 恰一条 Inbox（kind/severity/detail.code）+ 零请求
// ------------------------------------------------------------------------------------------------

const DEGRADE_FORMS = [
  {
    label: "no_token（有 GitHub 形态 remote，但没配 token）",
    code: "no_token",
    remote: "github_alias" as RemoteKind,
    token: undefined,
  },
  {
    label: "no_remote（配了 token，但仓库没有 origin）",
    code: "no_remote",
    remote: "none" as RemoteKind,
    token: "ghp_iv_token",
  },
  {
    label: "remote_not_github（origin 是本地路径）",
    code: "remote_not_github",
    remote: "plain_path" as RemoteKind,
    token: "ghp_iv_token",
  },
] as const;

for (const form of DEGRADE_FORMS) {
  test(`独立复验｜降级 ${form.label} ⇒ 本地收尾照常 + 恰一条 pr_gate_degraded + 零出站/零远端写`, async () => {
    const f = await makeBatchFixture({
      remote: form.remote,
      mode: () => "pr-gate",
      token: form.token,
    });
    try {
      seedBatch(f);
      const { integration, memberBranch, worktreePath } = await produceMergeAndFinish(f);
      const mainBefore = await f.mainSha();
      const bareBefore = f.bareRoot === null ? null : await bareRefs(f.bareRoot);

      await f.orchestrator.advanceAfterChildrenDone({
        workspaceKey: WS,
        parentWorkItemId: "wi-iv-p",
      });

      // 本地收尾照常（与 local 模式同形）：父项 done、成果落 main、集成分支删、队员抛弃。
      assert.equal(
        sqlOne<{ status: string }>(f.db, "SELECT status FROM work_items WHERE id = ?", "wi-iv-p")
          .status,
        "done",
        "降级 ⇒ 按本地形态收尾（批次照常落地）",
      );
      const mainAfter = await f.mainSha();
      assert.notEqual(mainAfter, mainBefore, "成果必须合回 main");
      assert.equal(
        (await gitRaw(["cat-file", "-e", "refs/heads/main:evidence.txt"], f.repoRoot)).code,
        0,
        "main 上应真有本批成果文件",
      );
      assert.equal(await branchExists(f.repoRoot, integration), false, "集成分支照本地模式删掉");
      assert.equal(
        await branchExists(f.repoRoot, memberBranch),
        false,
        "队员分支照常抛弃（降级不影响清理）",
      );
      assert.equal(existsSync(worktreePath), false, "队员工作树照常摘掉");
      assert.equal(
        sqlOne<{ status: string }>(
          f.db,
          "SELECT status FROM squad_runs WHERE run_id = ?",
          "run-iv-1",
        ).status,
        "discarded",
      );
      assert.equal(
        sqlCount(
          f.db,
          "SELECT COUNT(*) AS n FROM work_item_pull_requests WHERE workspace_key = ?",
          WS,
        ),
        0,
        "降级 ⇒ 没有任何 PR 关联行（没有开出去的 PR）",
      );

      // 零出站（fetch 计数是唯一证据）。
      assert.equal(f.fetchCalls.length, 0, "三档降级都在任何出站之前判定（零请求）");

      // 恰一条留痕：kind / severity / detail.code / 集成分支（与 git 发现的一致）/ 手写的去重键。
      const inbox = inboxRows(f.db);
      assert.equal(inbox.length, 1, `降级必须恰留一条痕（不静默）：${JSON.stringify(inbox)}`);
      assert.equal(inbox[0]!.kind, "pr_gate_degraded");
      assert.equal(inbox[0]!.severity, "attention");
      assert.equal(inbox[0]!.dedup_key, `pr_gate_degraded:wi-iv-p:${form.code}`);
      const detail = JSON.parse(inbox[0]!.detail_json) as Record<string, unknown>;
      assert.equal(detail["code"], form.code);
      assert.equal(detail["parentWorkItemId"], "wi-iv-p");
      assert.equal(detail["integrationBranch"], integration);
      assert.equal(detail["targetBranch"], "main");
      assert.ok(String(detail["reason"]).trim() !== "", "留痕必须带原因原文");

      // 零远端写（形态对应的可观测面：裸库 refs 一个不增）。
      if (f.bareRoot !== null && bareBefore !== null) {
        assert.deepEqual(
          [...(await bareRefs(f.bareRoot)).entries()],
          [...bareBefore.entries()],
          "降级不得往远端写任何 ref（含 push）",
        );
      } else {
        assert.equal(f.bareRoot, null, "无远端的形态本就没有可写的远端");
      }
    } finally {
      f.cleanup();
    }
  });
}

test("独立复验｜降级留痕去重（裸 SQL + 手写键为真源）：同因不重复、换因新条目", async () => {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const repo = createInboxItemRepo(db);
  const insert = (code: string, dedupKey: string): boolean =>
    repo.insertIfAbsent({
      workspaceKey: WS,
      workspacePath: "/tmp/d3-iv",
      kind: "pr_gate_degraded",
      dedupKey,
      title: "独立复验批",
      detail: { parentWorkItemId: "wi-iv-p", code, reason: `原因-${code}` },
      workItemId: "wi-iv-p",
    });

  assert.equal(insert("no_token", "pr_gate_degraded:wi-iv-p:no_token"), true);
  assert.equal(
    insert("no_token", "pr_gate_degraded:wi-iv-p:no_token"),
    false,
    "同因重投不得产生第二条（存储层唯一索引是幂等不变式）",
  );
  assert.equal(
    insert("no_remote", "pr_gate_degraded:wi-iv-p:no_remote"),
    true,
    "换因是新事实：新条目（否则「先配 token 再发现没 remote」的第二次降级不可见）",
  );
  assert.equal(
    sqlCount(db, "SELECT COUNT(*) AS n FROM inbox_items WHERE workspace_key = ?", WS),
    2,
  );
  // 另一父项 + 同因 ⇒ 也是新条目（键含父项）。
  const otherParent = repo.insertIfAbsent({
    workspaceKey: WS,
    workspacePath: "/tmp/d3-iv",
    kind: "pr_gate_degraded",
    dedupKey: "pr_gate_degraded:wi-iv-q:no_token",
    title: "另一批",
    detail: {},
    workItemId: "wi-iv-q",
  });
  assert.equal(otherParent, true);
  assert.equal(
    sqlCount(db, "SELECT COUNT(*) AS n FROM inbox_items WHERE workspace_key = ?", WS),
    3,
  );
});

// ------------------------------------------------------------------------------------------------
// ② 重驱闸按事实不按模式（两向）
// ------------------------------------------------------------------------------------------------

test("独立复验｜重驱闸（正向）：pr-gate 已发布的批，模式切回 local 再重驱 ⇒ 空转（远端已不可达也不抛、main 未动、零新请求）", async () => {
  let mode: "local" | "pr-gate" = "pr-gate";
  const f = await makeBatchFixture({
    remote: "github_alias",
    mode: () => mode,
    token: "ghp_iv_token",
    respond: (call) =>
      call.method === "POST"
        ? jsonResponse(prPayload({ head: { ref: call.head, sha: "sha-iv-pub" } }))
        : jsonResponse(prPayload(), 500),
  });
  try {
    seedBatch(f);
    const { integration } = await produceMergeAndFinish(f);
    await f.orchestrator.advanceAfterChildrenDone({
      workspaceKey: WS,
      parentWorkItemId: "wi-iv-p",
    });

    const postsAfterPublish = f.fetchCalls.filter((call) => call.method === "POST").length;
    assert.equal(postsAfterPublish, 1, "首次收尾恰开一次 PR");
    const mainAfterPublish = await f.mainSha();
    const rowBefore = sqlOne<{
      id: string;
      branch: string;
      snapshot_head_sha: string;
      state: string;
    }>(
      f.db,
      "SELECT id, branch, snapshot_head_sha, state FROM work_item_pull_requests WHERE workspace_key = ? AND work_item_id = ?",
      WS,
      "wi-iv-p",
    );
    assert.equal(rowBefore.branch, integration, "关联行的 head 是本批集成分支");
    assert.equal(rowBefore.state, "open");

    // 「用户把模式切回 local」：设置是运行期可改的。若闸按模式判，这一步会尝试本地收尾。
    mode = "local";
    // 远端不可达化：任何 push 都会响亮失败 ⇒ 「没抛」本身就是「没碰远端」的行为级证据。
    rmSync(f.bareRoot!, { recursive: true, force: true });

    await f.orchestrator.advanceAfterChildrenDone({
      workspaceKey: WS,
      parentWorkItemId: "wi-iv-p",
    });

    assert.equal(
      sqlOne<{ status: string }>(f.db, "SELECT status FROM work_items WHERE id = ?", "wi-iv-p")
        .status,
      "in_review",
      "重驱不得改状态（终态交 PR merge）",
    );
    assert.equal(
      await f.mainSha(),
      mainAfterPublish,
      "local 模式下重驱也不得把已发布的批合进 main",
    );
    assert.equal(
      (await gitRaw(["cat-file", "-e", "refs/heads/main:evidence.txt"], f.repoRoot)).code === 0,
      false,
      "main 上不得出现本批成果（同一批成果两处落地是被闸挡住的那件事）",
    );
    assert.equal(
      await branchExists(f.repoRoot, integration),
      true,
      "集成分支照旧保留（PR 的 head）",
    );
    assert.equal(
      f.fetchCalls.filter((call) => call.method === "POST").length,
      postsAfterPublish,
      "重驱不得再开第二次 PR",
    );
    assert.equal(f.fetchCalls.length, 1, "重驱整体零新请求");
    const rowAfter = sqlOne<{
      id: string;
      branch: string;
      snapshot_head_sha: string;
      state: string;
    }>(
      f.db,
      "SELECT id, branch, snapshot_head_sha, state FROM work_item_pull_requests WHERE workspace_key = ? AND work_item_id = ?",
      WS,
      "wi-iv-p",
    );
    assert.deepEqual(rowAfter, rowBefore, "关联行一字不动");
  } finally {
    f.cleanup();
  }
});

test("独立复验｜重驱闸（反向）：local 收尾过的批（无关联行）切到 pr-gate 再重驱 ⇒ 空转（零出站、零远端写）", async () => {
  let mode: "local" | "pr-gate" = "local";
  const f = await makeBatchFixture({
    remote: "github_alias",
    mode: () => mode,
    token: "ghp_iv_token",
    respond: () => jsonResponse(prPayload()),
  });
  try {
    seedBatch(f);
    const { integration } = await produceMergeAndFinish(f);
    await f.orchestrator.advanceAfterChildrenDone({
      workspaceKey: WS,
      parentWorkItemId: "wi-iv-p",
    });
    assert.equal(
      sqlOne<{ status: string }>(f.db, "SELECT status FROM work_items WHERE id = ?", "wi-iv-p")
        .status,
      "done",
      "local 收尾：父项 done",
    );
    assert.equal(await branchExists(f.repoRoot, integration), false, "local 收尾删掉集成分支");

    mode = "pr-gate";
    await f.orchestrator.advanceAfterChildrenDone({
      workspaceKey: WS,
      parentWorkItemId: "wi-iv-p",
    });

    assert.equal(
      f.fetchCalls.length,
      0,
      "闸按事实判（无分支、无关联行）⇒ 零出站，不因模式是 pr-gate 就去发布",
    );
    assert.deepEqual([...(await bareRefs(f.bareRoot!)).entries()], [], "远端零 ref（没有 push）");
    assert.equal(
      sqlOne<{ status: string }>(f.db, "SELECT status FROM work_items WHERE id = ?", "wi-iv-p")
        .status,
      "done",
      "重驱不得改写已结算的父项",
    );
    assert.equal(inboxRows(f.db).length, 0, "重驱空转不留痕");
  } finally {
    f.cleanup();
  }
});

test("独立复验｜重驱闸按事实（精度）：手工挂的**别的分支**的 PR 行不得被当成「本批已发布」⇒ 收尾照常发生", async () => {
  /* 「有没有关联行」与「本批那条 PR 在不在」是两件事：按前者判会让「用户手工挂过别的 PR」
     的工作项被**静默跳过整个收尾**（一整批成果没人合、也不报错）。 */
  const f = await makeBatchFixture({
    remote: "github_alias",
    mode: () => "pr-gate",
    token: "ghp_iv_token",
    respond: (call) =>
      call.method === "POST"
        ? jsonResponse(prPayload({ number: 9001, head: { ref: call.head, sha: "sha-iv-9001" } }))
        : jsonResponse(prPayload()),
  });
  try {
    seedBatch(f);
    const { integration } = await produceMergeAndFinish(f);
    // 用户手工挂的 PR（快照未拉 ⇒ branch 为 NULL 的形态 + 显式别的分支的形态，两种都试）。
    for (const [id, number, branch] of [
      ["pr-manual-null", 555, null],
      ["pr-manual-other", 556, "unrelated/branch"],
    ] as const) {
      f.db
        .prepare(
          `INSERT INTO work_item_pull_requests
             (id, workspace_key, workspace_path, work_item_id, repo_owner, repo_name, pr_number, title,
              html_url, branch, state, merged_at, api_mergeable, api_merge_state_status,
              snapshot_head_sha, snapshot_fetched_at, linked_by_kind, linked_by_id, created_at, updated_at)
           VALUES (?, ?, ?, 'wi-iv-p', 'iv-org', 'iv-repo', ?, ?, ?, ?, NULL, NULL, NULL, NULL,
                   '', NULL, 'human', 'u-iv', 500, 500)`,
        )
        .run(
          id,
          WS,
          f.repoRoot,
          number,
          `手工 ${number}`,
          `https://github.com/iv-org/iv-repo/pull/${number}`,
          branch,
        );
    }

    await f.orchestrator.advanceAfterChildrenDone({
      workspaceKey: WS,
      parentWorkItemId: "wi-iv-p",
    });

    assert.equal(
      f.fetchCalls.filter((call) => call.method === "POST").length,
      1,
      "手工挂的 PR 不算「本批已发布」：发布照常发生（闸不得静默跳过整批）",
    );
    const rows = f.db
      .prepare(
        "SELECT id, branch FROM work_item_pull_requests WHERE workspace_key = ? AND work_item_id = ? ORDER BY created_at, id",
      )
      .all(WS, "wi-iv-p") as unknown as Array<{ id: string; branch: string | null }>;
    assert.equal(rows.length, 3, "手工两条 + 本批一条");
    assert.equal(
      rows.filter((row) => row.branch === integration).length,
      1,
      "本批那条按分支可认出（判据是分支精确匹配）",
    );
    assert.equal(
      sqlOne<{ status: string }>(f.db, "SELECT status FROM work_items WHERE id = ?", "wi-iv-p")
        .status,
      "in_review",
    );
  } finally {
    f.cleanup();
  }
});

test("独立复验｜422 认回（崩溃窗口）：按 head **精确**认回本批那条；只有前缀命中别的批 ⇒ 不认回（failed）", async () => {
  /* 场景：「开 PR 之后、登记之前」崩溃 ⇒ 下一次重驱再推一次（幂等）并拿到 422。
     认回判据必须是 head **精确等于**集成分支 —— 前缀可能命中别的批，认错 PR 会把别人的 PR 挂上来且不报错。 */
  const f = await makeBatchFixture({ remote: "github_alias", token: "ghp_iv_422" });
  try {
    const integration = "squad/integration/iv-batch";
    await gitOk(["checkout", "-q", "-b", integration], f.repoRoot);
    writeFileSync(join(f.repoRoot, "evidence.txt"), "batch\n");
    await gitOk(["add", "-A"], f.repoRoot);
    await gitOk(["commit", "-qm", "batch work"], f.repoRoot);
    await gitOk(["checkout", "-q", "main"], f.repoRoot);

    const listedPrefixes: string[] = [];
    let listFails = false;
    const facts = (branch: string, number: number) => ({
      number,
      htmlUrl: `https://github.com/iv-org/iv-repo/pull/${number}`,
      snapshot: {
        state: "open" as const,
        mergedAt: null,
        title: `PR ${number}`,
        branch,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        headSha: `sha-${number}`,
        fetchedAt: 7,
      },
    });
    const repo = createWorkItemPullRequestRepo(f.db);
    const warnings: string[] = [];
    const publisher = (list: Array<{ number: number; branch: string }>) =>
      createSquadIntegrationPublisher({
        git: createGitRunner(),
        repoRoot: f.repoRoot,
        workspace: { key: WS, path: f.repoRoot },
        provider: {
          describe: () => ({ available: true }),
          fetchPullRequest: async () => ({
            ok: false,
            code: "unavailable",
            reason: "本用例不走读路径",
          }),
          createPullRequest: async () => ({
            ok: false,
            code: "http_error",
            status: 422,
            reason: "GitHub 返回 422：同 head 的 PR 已存在。",
          }),
          listOpenByBranchPrefix: async (input) => {
            listedPrefixes.push(input.prefix);
            if (listFails) {
              return { ok: false, code: "network_error", reason: "列举失败（stub）" };
            }
            return {
              ok: true,
              pullRequests: list.map((entry) => facts(entry.branch, entry.number)),
            };
          },
        },
        repo,
        now: () => 5_000,
        logWarn: (message) => {
          warnings.push(message);
        },
      });
    const input = {
      workItemId: "wi-iv-p",
      workItemTitle: "独立复验批",
      integration,
      target: "main",
    };

    // ① 列表里两条前缀命中：只有 head 精确等于集成分支的那条（72）被认回。
    const recovered = await publisher([
      { number: 71, branch: "squad/integration/iv-batch-extra" },
      { number: 72, branch: integration },
    ]).publishForReview(input);
    assert.equal(recovered.status, "published", JSON.stringify(recovered));
    const row = sqlOne<{ pr_number: number; branch: string; snapshot_head_sha: string }>(
      f.db,
      "SELECT pr_number, branch, snapshot_head_sha FROM work_item_pull_requests WHERE workspace_key = ? AND work_item_id = ?",
      WS,
      "wi-iv-p",
    );
    assert.equal(row.pr_number, 72, "认回的是 head 精确等于集成分支的那条（前缀命中别的批不算）");
    assert.equal(row.branch, integration);
    assert.equal(row.snapshot_head_sha, "sha-72");
    assert.deepEqual(listedPrefixes, [integration], "按集成分支前缀列举");
    assert.ok(
      warnings.some((message) => /认回/.test(message)),
      `认回必须留痕：${JSON.stringify(warnings)}`,
    );

    // ② 列表里只有**别的**批：不认回（否则会挂错 PR）⇒ failed 原样带出。
    const none = await publisher([
      { number: 73, branch: "squad/integration/iv-batch-extra" },
    ]).publishForReview(input);
    assert.equal(none.status, "failed", JSON.stringify(none));

    // ③ 列举本身失败（网络/HTTP）：不认回、不谎报成功，失败面响亮（带留痕）。
    listFails = true;
    const warnedBefore = warnings.length;
    const listDown = await publisher([]).publishForReview(input);
    assert.equal(listDown.status, "failed", JSON.stringify(listDown));
    assert.ok(
      warnings.length > warnedBefore,
      `列举失败必须留痕（否则「为什么没认回」在日志里查不出）：${JSON.stringify(warnings)}`,
    );
    assert.ok(
      warnings.some((message) => /认回失败/.test(message)),
      `留痕要说明是认回这一步失败的：${JSON.stringify(warnings)}`,
    );
  } finally {
    f.cleanup();
  }
});

// ------------------------------------------------------------------------------------------------
// ③ 终态 CAS（两形态）+ 终态行 refresh 幂等
// ------------------------------------------------------------------------------------------------

type TerminalFixture = {
  workspacePath: string;
  db: DatabaseSync;
  runtime: SquadRuntime;
  fetchCalls: string[];
  cleanup: () => void;
};

async function makeTerminalFixture(options: {
  respond: (url: string) => Response | Promise<Response>;
  onFetch?: () => void;
}): Promise<TerminalFixture> {
  const workspacePath = mkdtempSync(join(tmpdir(), "d3iv-term-"));
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const fetchCalls: string[] = [];
  const runtime = await createSquadRuntime({
    db,
    workspacePath,
    workspaceIdentity: WS,
    readExperimentEnabled: () => true,
    readGithubPullRequestToken: () => "ghp_iv_terminal",
    githubFetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push(url);
      options.onFetch?.();
      return options.respond(url);
    }) as typeof fetch,
  });
  return {
    workspacePath,
    db,
    runtime,
    fetchCalls,
    cleanup: () => {
      rmSync(workspacePath, { recursive: true, force: true });
      db.close();
    },
  };
}

function seedWorkItemRow(f: TerminalFixture, id: string, status: string): void {
  f.db
    .prepare(
      `INSERT INTO work_items
         (id, workspace_key, workspace_path, parent_id, stage, title, body, status,
          assignee_type, assignee_id, labels, properties, position, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, ?, '', ?, 'human', 'u-iv', '[]', '{}', 0, NULL, 1000, 1000)`,
    )
    .run(id, WS, f.workspacePath, `工作项 ${id}`, status);
}

function seedLinkedPrRow(
  f: TerminalFixture,
  input: { id: string; prNumber: number; createdAt: number },
): void {
  f.db
    .prepare(
      `INSERT INTO work_item_pull_requests
         (id, workspace_key, workspace_path, work_item_id, repo_owner, repo_name, pr_number, title,
          html_url, branch, state, merged_at, api_mergeable, api_merge_state_status,
          snapshot_head_sha, snapshot_fetched_at, linked_by_kind, linked_by_id, created_at, updated_at)
       VALUES (?, ?, ?, 'wi-iv-t', 'iv-org', 'iv-repo', ?, ?, ?, NULL, NULL, NULL, NULL, NULL,
               '', NULL, 'human', 'u-iv', ?, ?)`,
    )
    .run(
      input.id,
      WS,
      f.workspacePath,
      input.prNumber,
      `iv-org/iv-repo#${input.prNumber}`,
      `https://github.com/iv-org/iv-repo/pull/${input.prNumber}`,
      input.createdAt,
      input.createdAt,
    );
}

function mergedPayload(prNumber: number): Record<string, unknown> {
  return prPayload({
    number: prNumber,
    state: "closed",
    merged: true,
    merged_at: "2026-01-02T03:04:05Z",
    title: `已合并 PR ${prNumber}`,
    html_url: `https://github.com/iv-org/iv-repo/pull/${prNumber}`,
    head: { ref: "squad/integration/iv", sha: `sha-merged-${prNumber}` },
  });
}

function entryFor(f: TerminalFixture, warnings: string[]) {
  return createWorkItemPullRequestEntry({
    runtime: f.runtime,
    workspaceKey: WS,
    actor: () => ({ kind: "human", id: "u-iv" }),
    now: () => 2_000,
    logWarn: (message) => {
      warnings.push(message);
    },
  });
}

test("独立复验｜终态 CAS 竞态（另一写者在读之前已落 done）：不抛、不覆盖赢家、无回声", async () => {
  const f = await makeTerminalFixture({
    respond: (url) => jsonResponse(mergedPayload(url.endsWith("/7") ? 7 : 8)),
    onFetch: () => {
      // 另一个窗口（多窗口共库）在这一刻先落它自己的结论。
      f.db.prepare("UPDATE work_items SET status = 'done' WHERE id = 'wi-iv-t'").run();
    },
  });
  try {
    seedWorkItemRow(f, "wi-iv-t", "in_review");
    seedLinkedPrRow(f, { id: "pr-iv-7", prNumber: 7, createdAt: 1_000 });
    const warnings: string[] = [];

    const report = await entryFor(f, warnings).refresh({ workItemId: "wi-iv-t" });

    assert.deepEqual(
      report.mergedPullRequests.map((fact) => fact.prNumber),
      [7],
      "快照照刷：merged 事实仍报出",
    );
    assert.equal(
      sqlOne<{ status: string }>(f.db, "SELECT status FROM work_items WHERE id = ?", "wi-iv-t")
        .status,
      "done",
      "已终态 ⇒ 跳过终态判定（不抛不覆盖）",
    );
    assert.equal(
      sqlCount(
        f.db,
        "SELECT COUNT(*) AS n FROM work_item_activities WHERE workspace_key = ? AND kind = 'pr_merged'",
        WS,
      ),
      0,
      "未由本次驱动 ⇒ 无回声",
    );
  } finally {
    f.cleanup();
  }
});

test("独立复验｜终态 CAS 未命中（读到 in_review、写前被别的写者改 cancelled）：不抛、不覆盖、留痕、无回声", async () => {
  const f = await makeTerminalFixture({ respond: () => jsonResponse(mergedPayload(7)) });
  try {
    seedWorkItemRow(f, "wi-iv-t", "in_review");
    seedLinkedPrRow(f, { id: "pr-iv-7", prNumber: 7, createdAt: 1_000 });
    const warnings: string[] = [];

    /* 在**存储写口**（updateStatus，另一个 Host 的写入面）上模拟「CAS 窗口内被别人先写」：
       我方 transition 的目标写在真正执行前，先让「别人」落一次 cancelled（走同一条真实 CAS）。 */
    const repo = f.runtime.workItemRepo;
    const realUpdateStatus = repo.updateStatus.bind(repo);
    let competitorWrote = false;
    repo.updateStatus = (id: string, next: WorkItemStatusKey, expect: WorkItemStatusKey) => {
      if (!competitorWrote && next === "done") {
        competitorWrote = true;
        assert.equal(
          realUpdateStatus(id, "cancelled", expect),
          true,
          "赢家的写必须命中（模拟合法写者）",
        );
      }
      return realUpdateStatus(id, next, expect);
    };

    const report = await entryFor(f, warnings).refresh({ workItemId: "wi-iv-t" });

    assert.deepEqual(
      report.mergedPullRequests.map((fact) => fact.prNumber),
      [7],
    );
    assert.equal(
      sqlOne<{ status: string }>(f.db, "SELECT status FROM work_items WHERE id = ?", "wi-iv-t")
        .status,
      "cancelled",
      "输家不覆盖赢家（不抛、不抢写）",
    );
    assert.equal(
      sqlCount(
        f.db,
        "SELECT COUNT(*) AS n FROM work_item_activities WHERE workspace_key = ? AND kind = 'pr_merged'",
        WS,
      ),
      0,
      "CAS 未命中 ⇒ 无回声（回声是「由它驱动了终态」的证据）",
    );
    assert.ok(
      warnings.some((message) => /CAS|未命中|竞态/.test(message)),
      `CAS 输家必须留痕：${JSON.stringify(warnings)}`,
    );
  } finally {
    f.cleanup();
  }
});

test("独立复验｜终态行 refresh 幂等（回声不重复）+ 多条 merged 只由第一条驱动", async () => {
  const f = await makeTerminalFixture({
    respond: (url) => jsonResponse(mergedPayload(url.endsWith("/8") ? 8 : 7)),
  });
  try {
    seedWorkItemRow(f, "wi-iv-t", "in_review");
    seedLinkedPrRow(f, { id: "pr-iv-a", prNumber: 7, createdAt: 1_000 });
    seedLinkedPrRow(f, { id: "pr-iv-b", prNumber: 8, createdAt: 1_000 });
    const warnings: string[] = [];
    const entry = entryFor(f, warnings);

    const first = await entry.refresh({ workItemId: "wi-iv-t" });
    assert.deepEqual(
      first.mergedPullRequests.map((fact) => fact.prNumber),
      [7, 8],
      "两条 merged 事实都读得出",
    );
    assert.equal(
      sqlOne<{ status: string }>(f.db, "SELECT status FROM work_items WHERE id = ?", "wi-iv-t")
        .status,
      "done",
    );
    const echoes = f.db
      .prepare(
        "SELECT dedup_key, payload_json, actor_kind, actor_id FROM work_item_activities WHERE workspace_key = ? AND kind = 'pr_merged'",
      )
      .all(WS) as unknown as Array<{
      dedup_key: string;
      payload_json: string;
      actor_kind: string;
      actor_id: string;
    }>;
    assert.equal(echoes.length, 1, "多条 merged 只由第一条驱动：恰一枚回声");
    const firstRow = sqlOne<{ id: string; pr_number: number }>(
      f.db,
      "SELECT id, pr_number FROM work_item_pull_requests WHERE workspace_key = ? AND work_item_id = ? ORDER BY created_at, id LIMIT 1",
      WS,
      "wi-iv-t",
    );
    assert.equal(firstRow.pr_number, 7, "第一条按 (created_at, id) 主序");
    assert.equal(
      echoes[0]!.dedup_key,
      `pr:${firstRow.id}:merged`,
      "回声键由关联行 id 派生（形状手写核对）",
    );
    const payload = JSON.parse(echoes[0]!.payload_json) as Record<string, unknown>;
    assert.equal(payload["prNumber"], 7, "驱动的就是第一条");
    assert.equal(payload["url"], "https://github.com/iv-org/iv-repo/pull/7");
    assert.equal(echoes[0]!.actor_kind, "system", "外部信号驱动 = 系统主体");

    // 终态行再刷：快照照刷、状态不动、回声不重复。
    const again = await entry.refresh({ workItemId: "wi-iv-t" });
    assert.equal(again.items.length, 2);
    assert.ok(
      again.items.every((item) => item.outcome === "updated"),
      "已终态 ⇒ 快照照刷（设计 §4.2 的次序）",
    );
    assert.equal(
      sqlCount(
        f.db,
        "SELECT COUNT(*) AS n FROM work_item_activities WHERE workspace_key = ? AND kind = 'pr_merged'",
        WS,
      ),
      1,
      "回声幂等（终态判定跳过 + 键唯一索引双保险）",
    );

    // 存储层直接重投同一枚回声（绕过状态判定的那一层）：唯一索引必须咬住。
    f.runtime.activityProjector.pullRequestMerged({
      workspaceKey: WS,
      workspacePath: f.workspacePath,
      workItemId: "wi-iv-t",
      pullRequestId: firstRow.id,
      prNumber: 7,
      url: "https://github.com/iv-org/iv-repo/pull/7",
    });
    assert.equal(
      sqlCount(
        f.db,
        "SELECT COUNT(*) AS n FROM work_item_activities WHERE workspace_key = ? AND kind = 'pr_merged'",
        WS,
      ),
      1,
      "同键重投不得产生第二枚（存储层幂等）",
    );
  } finally {
    f.cleanup();
  }
});

// ------------------------------------------------------------------------------------------------
// ④ pr-gate 全链（真 push 双端裸 git 读数）+ local 行为中立锚点
// ------------------------------------------------------------------------------------------------

test("独立复验｜pr-gate 全链：真 push 到裸库（双端 sha 一致）/裸库 main 未动 → 开 PR → 等 merge → 一次刷新 ⇒ done + 回声", async () => {
  let merged = false;
  const f = await makeBatchFixture({
    remote: "github_alias",
    mode: () => "pr-gate",
    token: "ghp_iv_chain",
    respond: (call) => {
      if (call.method === "POST") {
        return jsonResponse(
          prPayload({
            number: 9001,
            title: String(call.body?.["title"] ?? "独立复验批次"),
            html_url: "https://github.com/iv-org/iv-repo/pull/9001",
            head: { ref: call.head, sha: "sha-iv-9001" },
          }),
        );
      }
      return jsonResponse(
        merged
          ? mergedPayload(9001)
          : prPayload({ number: 9001, head: { ref: "squad/integration/iv", sha: "sha-iv-9001" } }),
      );
    },
  });
  try {
    // —— 夹具自证：origin 写下的地址是 GitHub 形态，push 实际走 insteadOf 映射到本地裸库。——
    assert.equal(
      await gitOk(["config", "--get", "remote.origin.url"], f.repoRoot),
      GITHUB_REMOTE,
      "config 里写的是 GitHub 地址（实现读这份事实，而不是被 insteadOf 改写后的地址）",
    );
    assert.equal(
      await gitOk(["remote", "get-url", "origin"], f.repoRoot),
      f.bareRoot,
      "remote get-url 施加 insteadOf 改写（正因如此实现必须读 config）",
    );

    seedBatch(f);
    const mainBefore = await f.mainSha();
    // 生产形态的收尾：队员合并发生在收尾内部（pending 非空），集成分支名事后从 git 发现。
    const opened = await f.runtime.lifecycle.openMemberRun({
      runId: "run-iv-1",
      workItemId: "wi-iv-c",
      parentWorkItemId: "wi-iv-p",
      agentId: "agent-iv",
      isLeaderTask: false,
    });
    assert.equal(opened.kind, "opened");
    writeFileSync(join(opened.worktreePath, "evidence.txt"), "independent chain\n");
    await gitOk(["add", "-A"], opened.worktreePath);
    await gitOk(["commit", "-qm", "independent evidence"], opened.worktreePath);
    await f.runtime.lifecycle.completeMemberRun({ runId: "run-iv-1" });
    f.runtime.workItemService.transition("wi-iv-c", "done", "in_review");

    await f.orchestrator.advanceAfterChildrenDone({
      workspaceKey: WS,
      parentWorkItemId: "wi-iv-p",
    });

    const integrations = await discoverIntegrationBranches(f.repoRoot);
    assert.equal(integrations.length, 1);
    const integration = integrations[0]!;

    // ① 真 push：裸库里的 ref 真有提交，sha 与本地一致，内容（evidence.txt）可在裸库读到。
    const localSha = await gitOk(["rev-parse", `refs/heads/${integration}`], f.repoRoot);
    assert.equal(
      await gitOk(["--git-dir", f.bareRoot!, "rev-parse", `refs/heads/${integration}`]),
      localSha,
      "裸库 ref 必须真有这条提交（不是断言返回值）",
    );
    assert.equal(
      (await gitRaw(["--git-dir", f.bareRoot!, "cat-file", "-e", `${localSha}:evidence.txt`])).code,
      0,
      "裸库对象库里读得到本批文件",
    );
    // ② 裸库 main 未动（连 ref 都不存在）；本地 main 一字未改。
    assert.equal(
      (await gitRaw(["--git-dir", f.bareRoot!, "rev-parse", "-q", "--verify", "refs/heads/main"]))
        .code === 0,
      false,
      "pr-gate 不得往远端 main 写",
    );
    assert.equal(await f.mainSha(), mainBefore, "本地 main 一个字节不动（成果只在集成分支/远端）");
    // ③ PR 关联行（裸 SQL）：head = 集成分支、状态 = 创建响应、系统归因。
    const row = sqlOne<{
      id: string;
      branch: string;
      state: string;
      pr_number: number;
      html_url: string;
      snapshot_head_sha: string;
      linked_by_kind: string;
      linked_by_id: string;
    }>(
      f.db,
      "SELECT * FROM work_item_pull_requests WHERE workspace_key = ? AND work_item_id = ?",
      WS,
      "wi-iv-p",
    );
    assert.equal(row.branch, integration);
    assert.equal(row.state, "open");
    assert.equal(row.pr_number, 9001);
    assert.equal(row.html_url, "https://github.com/iv-org/iv-repo/pull/9001");
    assert.equal(row.snapshot_head_sha, "sha-iv-9001");
    assert.equal(row.linked_by_kind, "system");
    assert.equal(row.linked_by_id, "squad-runtime");
    // ④ 终态不由本地收尾给：父项留 in_review、集成分支保留；队员照常抛弃。
    assert.equal(
      sqlOne<{ status: string }>(f.db, "SELECT status FROM work_items WHERE id = ?", "wi-iv-p")
        .status,
      "in_review",
    );
    assert.equal(await branchExists(f.repoRoot, integration), true, "集成分支是 PR 的 head，保留");
    assert.equal(
      sqlOne<{ status: string }>(f.db, "SELECT status FROM squad_runs WHERE run_id = ?", "run-iv-1")
        .status,
      "discarded",
    );
    assert.equal(existsSync(opened.worktreePath), false);
    // ⑤ 开 PR 的形状（stub 记下的请求体）：head/base/title。
    const post = f.fetchCalls.find((call) => call.method === "POST")!;
    assert.equal(post.url, "https://api.github.com/repos/iv-org/iv-repo/pulls");
    assert.equal(post.head, integration);
    assert.equal(post.body?.["base"], "main");

    // ⑥ 远端把 PR 合并之后：一次刷新 ⇒ done + 恰一枚回声（第 21 枚）。
    merged = true;
    const warnings: string[] = [];
    const report = await entryFor(f, warnings).refresh({ workItemId: "wi-iv-p" });
    assert.deepEqual(
      report.mergedPullRequests.map((fact) => fact.prNumber),
      [9001],
    );
    assert.equal(
      sqlOne<{ status: string }>(f.db, "SELECT status FROM work_items WHERE id = ?", "wi-iv-p")
        .status,
      "done",
      "PR merge 驱动：in_review → done（唯一写者 = WorkItemService.transition）",
    );
    const echo = sqlOne<{ dedup_key: string; payload_json: string }>(
      f.db,
      "SELECT dedup_key, payload_json FROM work_item_activities WHERE workspace_key = ? AND kind = 'pr_merged'",
      WS,
    );
    assert.equal(echo.dedup_key, `pr:${row.id}:merged`);
    assert.equal((JSON.parse(echo.payload_json) as Record<string, unknown>)["prNumber"], 9001);

    // 再刷一次：幂等（回声仍一枚）。
    await entryFor(f, warnings).refresh({ workItemId: "wi-iv-p" });
    assert.equal(
      sqlCount(
        f.db,
        "SELECT COUNT(*) AS n FROM work_item_activities WHERE workspace_key = ? AND kind = 'pr_merged'",
        WS,
      ),
      1,
    );
    // 集成分支照旧在（合并后不清理：squad/integration 的回收不在 D3 范围；此处只钉「未被本链删掉」）。
    assert.equal(await branchExists(f.repoRoot, integration), true);
  } finally {
    f.cleanup();
  }
});

test("独立复验｜local 行为中立锚点：local + token + GitHub 形态 remote ⇒ 零出站零远端写，本地收尾与改前同形", async () => {
  let mode: "local" | "pr-gate" = "local";
  const f = await makeBatchFixture({
    remote: "github_alias",
    mode: () => mode,
    token: "ghp_iv_local",
    respond: () => jsonResponse(prPayload()),
  });
  try {
    seedBatch(f);
    const { integration, memberBranch } = await produceMergeAndFinish(f);
    const mainBefore = await f.mainSha();

    await f.orchestrator.advanceAfterChildrenDone({
      workspaceKey: WS,
      parentWorkItemId: "wi-iv-p",
    });

    assert.equal(f.fetchCalls.length, 0, "local 零出站（配置齐备也不许发请求）");
    assert.deepEqual([...(await bareRefs(f.bareRoot!)).entries()], [], "local 零远端写（不 push）");
    assert.equal(
      sqlOne<{ status: string }>(f.db, "SELECT status FROM work_items WHERE id = ?", "wi-iv-p")
        .status,
      "done",
    );
    assert.notEqual(await f.mainSha(), mainBefore, "成果合回 main");
    assert.equal(
      (await gitRaw(["cat-file", "-e", "refs/heads/main:evidence.txt"], f.repoRoot)).code,
      0,
    );
    assert.equal(await branchExists(f.repoRoot, integration), false, "集成分支照旧删掉");
    assert.equal(await branchExists(f.repoRoot, memberBranch), false, "队员分支照旧抛弃");
    assert.equal(
      sqlCount(
        f.db,
        "SELECT COUNT(*) AS n FROM work_item_pull_requests WHERE workspace_key = ?",
        WS,
      ),
      0,
      "local 不开 PR、零关联行",
    );
    assert.equal(inboxRows(f.db).length, 0, "local 模式没有降级留痕");
  } finally {
    f.cleanup();
  }
});
