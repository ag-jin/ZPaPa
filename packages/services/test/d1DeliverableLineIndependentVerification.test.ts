import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createCommentDispatchReceiptRepo } from "../src/workitem/commentDispatchReceiptRepo.js";
import { createSquadOrchestrator } from "../src/workitem/squadOrchestrator.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import { slugForId } from "../src/workitem/slug.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import { createWorkItemCollaborationService } from "../src/workitem/workItemCollaborationService.js";
import { createWorkItemCommentReactionRepo } from "../src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemCommentRepo } from "../src/workitem/workItemCommentRepo.js";
import { createWorkItemDecisionRepo } from "../src/workitem/workItemDecisionRepo.js";
import { createWorkItemDeliverableRecorder } from "../src/workitem/workItemDeliverableRecorder.js";
import {
  resolveDeliverableContentRoot,
  type WorkItemDeliverableRepo,
} from "../src/workitem/workItemDeliverableRepo.js";
import { planBranches } from "../src/worktree/branchNaming.js";
import type { GitRunResult, GitRunner } from "../src/worktree/gitRunner.js";

/* #7 交付物线 D1（D1a `bfc0395` + D1b `9e72470`/`a46ecac`）的**独立复验**（与实现者的
   `workItemDeliverable*.test.ts` 刻意分开：不复用其夹具与期望值）。

   三条自立之法：
   · **自造夹具**：仓库用裸 `git` 子进程现造现读（不 import `helpers/gitFixture`）；
   · **外部真源**：期望值来自 `git` 自己的输出与 `shasum -a 256`（不用 node:crypto 重算，
     避免「实现同一算法同一路径自证」）；
   · **只走生产入口**：组合根 `createSquadRuntime` / 编排器 / 生命周期 / 协作门面。 */

const run = promisify(execFile);

/** 裸 git（独立夹具）：失败也返回 code/stdout/stderr，不打桩、不复用生产 runner。 */
async function sh(cwd: string, args: string[]): Promise<GitRunResult> {
  try {
    const { stdout, stderr } = await run("git", args, { cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
      stderr: typeof failure.stderr === "string" ? failure.stderr : "",
    };
  }
}

/** 外部工具算 sha256（独立真源）。 */
async function sha256OfFile(path: string): Promise<string> {
  const { stdout } = await run("shasum", ["-a", "256", path]);
  return stdout.trim().split(/\s+/)[0]!;
}

/** 自造一次性仓库（已 init 到 main + 一次提交）。 */
async function newRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "d1v-"));
  await run("git", ["init", "-q", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.email", "d1v@test"], { cwd: root });
  await run("git", ["config", "user.name", "d1v"], { cwd: root });
  writeFileSync(join(root, "seed.txt"), "seed\n");
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["commit", "-qm", "seed"], { cwd: root });
  return root;
}

const WS = "d1v-ws";
const IDS = { parent: "d1v-p", child: "d1v-c", agent: "d1v-agent" };
const SYSTEM_ACTOR = { kind: "system", id: "squad-runtime" };
const HUMAN_ACTOR = { kind: "human", id: "d1v-human" };

async function setup() {
  const repoRoot = await newRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: WS,
    readExperimentEnabled: () => true,
  });
  const activities = createWorkItemActivityRepo(db);
  const insertItem = (id: string, status: string, parentId?: string): void => {
    runtime.workItemRepo.insert({
      id,
      workspaceIdentity: WS,
      workspacePath: repoRoot,
      ...(parentId !== undefined ? { parentId } : {}),
      title: `D1V ${id}`,
      body: "",
      status,
      assignee: { type: "agent", id: IDS.agent },
      labels: [],
      properties: {},
      position: 0,
    });
  };
  return {
    repoRoot,
    db,
    runtime,
    activities,
    insertItem,
    target: { path: repoRoot, identity: WS },
    timeline: (workItemId: string) => activities.listByWorkItem(WS, workItemId),
    orchestrator: createSquadOrchestrator({ runtime }),
    facade: createWorkItemCollaborationService({
      createRuntime: async () => runtime,
      getRepos: () => ({
        comments: createWorkItemCommentRepo(db),
        activities,
        decisions: createWorkItemDecisionRepo(db),
        reactions: createWorkItemCommentReactionRepo(db),
        receipts: createCommentDispatchReceiptRepo(db),
      }),
      localHumanActor: () => HUMAN_ACTOR,
    }),
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

/** 父项 + 子项一条批；返回生产命名规则现算的分支计划（不写死分支名）。 */
function planBatch(f: Fixture, ids = IDS) {
  f.insertItem(ids.parent, "in_review");
  f.insertItem(ids.child, "in_progress", ids.parent);
  return planBranches({
    workItemSlug: slugForId(ids.child),
    agentSlug: slugForId(ids.agent),
  });
}

/** 收 console.warn（组合根缺省 logWarn 就是它）——「warn 留痕」这条纪律必须在生产缺省路径上被看见。 */
async function withWarnCapture<T>(work: () => Promise<T>): Promise<{ result: T; warns: string[] }> {
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map((value) => (typeof value === "string" ? value : String(value))).join(" "));
  };
  try {
    return { result: await work(), warns };
  } finally {
    console.warn = original;
  }
}

/** 开树 → 在树里按序落文件并逐个提交 → 上报完成（→ run `produced`）。事实全由裸 git 造。 */
async function produce(
  f: Fixture,
  input: {
    runId: string;
    ids?: { parent: string; child: string; agent: string };
    commits: { file: string; content: string }[];
  },
): Promise<{ worktreePath: string; memberBranch: string; integrationBranch: string }> {
  const ids = input.ids ?? IDS;
  const plan = planBranches({
    workItemSlug: slugForId(ids.child),
    agentSlug: slugForId(ids.agent),
  });
  const opened = await f.runtime.lifecycle.openMemberRun({
    runId: input.runId,
    workItemId: ids.child,
    parentWorkItemId: ids.parent,
    agentId: ids.agent,
    isLeaderTask: false,
  });
  assert.equal(opened.kind, "opened", `开树失败：${JSON.stringify(opened)}`);
  if (opened.kind !== "opened") throw new Error("unreachable");
  for (const commit of input.commits) {
    writeFileSync(join(opened.worktreePath, commit.file), commit.content);
    const added = await sh(opened.worktreePath, ["add", "-A"]);
    assert.equal(added.code, 0, added.stderr);
    const committed = await sh(opened.worktreePath, ["commit", "-qm", `d1v ${commit.file}`]);
    assert.equal(committed.code, 0, committed.stderr);
  }
  await f.runtime.lifecycle.completeMemberRun({ runId: input.runId });
  return {
    worktreePath: opened.worktreePath,
    memberBranch: plan.member,
    integrationBranch: plan.integration,
  };
}

/* ---------------- ① run 级：独立 raw-git oracle 反向核对 ---------------- */

test("D1V-① run 级：approved ⇒ 恰一条；正文/stat/commit 数与独立 raw-git oracle 逐字节相等；回声先于 merged", async () => {
  const f = await setup();
  try {
    const plan = planBatch(f);
    await produce(f, {
      runId: "d1v-r1",
      commits: [
        { file: "one.txt", content: "one\n" },
        { file: "two.txt", content: "two\n" },
      ],
    });

    // ---- 独立 oracle（分支还活着时，由 git 自己回答「该存什么」）----
    const oracleDiff = (await sh(f.repoRoot, ["diff", "--no-color", `main...${plan.member}`]))
      .stdout;
    const oracleStat = (
      await sh(f.repoRoot, ["diff", "--no-color", "--stat", `main...${plan.member}`])
    ).stdout;
    const oracleCount = (
      await sh(f.repoRoot, ["rev-list", "--count", `main..${plan.member}`])
    ).stdout.trim();
    assert.equal(oracleCount, "2", "夹具事实：队员分支上有两个提交");
    assert.ok(oracleDiff.includes("+two"), `oracle 应含新增行：\n${oracleDiff}`);

    const outcome = await f.runtime.lifecycle.reviewMemberRun({
      runId: "d1v-r1",
      verdict: "approved",
    });
    assert.deepEqual({ ok: outcome.ok, merged: outcome.merged }, { ok: true, merged: true });

    const rows = f.runtime.deliverableRepo.listByRun("d1v-r1");
    assert.equal(rows.length, 1, "一条 run 至多一条自动 diff");
    const row = rows[0]!;
    assert.deepEqual(
      {
        id: row.id,
        kind: row.kind,
        dedupKey: row.dedupKey,
        runId: row.runId,
        workItemId: row.workItemId,
        actor: row.actor,
        metaBranch: row.meta.branch,
        metaBase: row.meta.base,
      },
      {
        id: "deliverable-deliverable-d1v-r1-diff",
        kind: "diff",
        dedupKey: "deliverable:d1v-r1:diff",
        runId: "d1v-r1",
        workItemId: IDS.child,
        actor: SYSTEM_ACTOR,
        metaBranch: plan.member,
        metaBase: "main",
      },
    );
    const contentPath = join(f.repoRoot, row.contentRef);
    assert.ok(existsSync(contentPath), `正文必须落盘：${contentPath}`);
    assert.equal(
      readFileSync(contentPath, "utf8"),
      oracleDiff,
      "正文 = 独立 raw-git 的同一范围 diff",
    );
    assert.equal(row.meta.statSummary, oracleStat, "stat 摘要 = git 自己的 --stat 原文");
    assert.equal(String(row.meta.commitCount), oracleCount, "commit 数 = git rev-list 的读数");
    assert.equal(row.contentSize, Buffer.byteLength(oracleDiff, "utf8"));
    assert.equal(row.contentSha, await sha256OfFile(contentPath), "sha 由外部工具 shasum 复核");

    // 回声：一枚、payload/键逐字、行序**先于** worktree_merged。
    const timeline = f.timeline(IDS.child);
    const echoes = timeline.filter((entry) => entry.kind === "deliverable_registered");
    assert.equal(echoes.length, 1);
    assert.deepEqual(
      { dedupKey: echoes[0]!.dedupKey, payload: echoes[0]!.payload, actor: echoes[0]!.actor },
      {
        dedupKey: `deliverable:${row.id}:registered`,
        payload: {
          kind: "diff",
          title: `队员 run 产出 diff（${plan.member}）`,
          deliverableId: row.id,
          runId: "d1v-r1",
        },
        actor: SYSTEM_ACTOR,
      },
    );
    const echoIndex = timeline.findIndex((entry) => entry.kind === "deliverable_registered");
    const mergedIndex = timeline.findIndex((entry) => entry.kind === "worktree_merged");
    assert.ok(
      echoIndex >= 0 && mergedIndex > echoIndex,
      `回声必须落在 merged 事实之前（echo=${echoIndex}, merged=${mergedIndex}）`,
    );
  } finally {
    rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

/* ---------------- ② 批级：集成分支删除后由真 git 反向核对 ---------------- */

test("D1V-② 批级：集成分支删除后仍捕到（baseSha=finalize 前独立读数）；main 上真有成果；回声先于父项 done", async () => {
  const f = await setup();
  try {
    const plan = planBatch(f);
    await produce(f, {
      runId: "d1v-r2",
      commits: [{ file: "batch.txt", content: "batch-content\n" }],
    });
    f.runtime.workItemService.transition(IDS.child, "done", "in_review");
    // finalize **之前**的 target sha：独立读数（不向实现要）。
    const baseSha = (await sh(f.repoRoot, ["rev-parse", "refs/heads/main"])).stdout.trim();

    await f.orchestrator.advanceAfterChildrenDone({
      workspaceKey: WS,
      parentWorkItemId: IDS.parent,
    });

    // 独立 git 读：成果真的落在 main 上（不是空转留痕）。
    assert.equal((await sh(f.repoRoot, ["show", "main:batch.txt"])).stdout, "batch-content\n");
    // 独立 git 读：队员与集成两条分支都被删了（「按分支名捕获」做不到的那一格）。
    for (const branch of [plan.member, plan.integration]) {
      const verify = await sh(f.repoRoot, ["rev-parse", "-q", "--verify", `refs/heads/${branch}`]);
      assert.notEqual(verify.code, 0, `分支 ${branch} 应已删除`);
    }

    // 批级行：挂父项、不挂 run。
    const rows = f.runtime.deliverableRepo.listByWorkItem(WS, IDS.parent);
    assert.equal(rows.length, 1, "父项恰一条批级 diff");
    const row = rows[0]!;
    assert.deepEqual(
      {
        id: row.id,
        kind: row.kind,
        dedupKey: row.dedupKey,
        runId: row.runId,
        workItemId: row.workItemId,
        actor: row.actor,
        batchLevel: row.meta.batchLevel,
        target: row.meta.target,
        baseSha: row.meta.baseSha,
      },
      {
        id: "deliverable-deliverable-d1v-p-batch-diff",
        kind: "diff",
        dedupKey: "deliverable:d1v-p:batch-diff",
        runId: null,
        workItemId: IDS.parent,
        actor: SYSTEM_ACTOR,
        batchLevel: true,
        target: "main",
        baseSha,
      },
    );
    // oracle：历史 sha 仍在 ⇒ baseSha..main 的 diff 现在还能独立复算。
    const oracleDiff = (await sh(f.repoRoot, ["diff", "--no-color", `${baseSha}..main`])).stdout;
    const oracleCount = (
      await sh(f.repoRoot, ["rev-list", "--count", `${baseSha}..main`])
    ).stdout.trim();
    const contentPath = join(f.repoRoot, row.contentRef);
    assert.equal(readFileSync(contentPath, "utf8"), oracleDiff);
    assert.equal(
      row.meta.statSummary,
      (await sh(f.repoRoot, ["diff", "--no-color", "--stat", `${baseSha}..main`])).stdout,
    );
    assert.equal(String(row.meta.commitCount), oracleCount);
    assert.equal(row.contentSha, await sha256OfFile(contentPath));
    assert.ok(oracleDiff.includes("+batch-content"), `批级正文应含本批成果：\n${oracleDiff}`);

    // 同一批里 run 级那一枚也在（两个产生点各自一条，键不互吞）。
    const runRows = f.runtime.deliverableRepo.listByRun("d1v-r2");
    assert.equal(runRows.length, 1, "批内 approved 臂同样留下 run 级一条");
    assert.equal(runRows[0]!.dedupKey, "deliverable:d1v-r2:diff");

    // 父项时间线：交付物回声**先于**父项 done 的状态迁移（收尾次序）。
    const parentTimeline = f.timeline(IDS.parent);
    const echoIndex = parentTimeline.findIndex((entry) => entry.kind === "deliverable_registered");
    const doneIndex = parentTimeline.findIndex(
      (entry) =>
        entry.kind === "status_changed" && (entry.payload as { to?: string }).to === "done",
    );
    assert.ok(echoIndex >= 0, "父项必须有交付物回声");
    assert.ok(doneIndex > echoIndex, `回声先于 done（echo=${echoIndex}, done=${doneIndex}）`);
  } finally {
    rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

/* ---------------- ③ 幂等：同 run 重放 / 手动 link 不幂等 ---------------- */

test("D1V-③ 同 run 两次 approved 重放 ⇒ 仍一条；分支内容已变也不二次覆盖正文", async () => {
  const f = await setup();
  try {
    planBatch(f);
    const { worktreePath, memberBranch } = await produce(f, {
      runId: "d1v-r3",
      commits: [{ file: "payload.txt", content: "first\n" }],
    });
    const firstOutcome = await f.runtime.lifecycle.reviewMemberRun({
      runId: "d1v-r3",
      verdict: "approved",
    });
    assert.equal(firstOutcome.ok, true);
    const first = f.runtime.deliverableRepo.listByRun("d1v-r3");
    assert.equal(first.length, 1);
    const firstText = readFileSync(join(f.repoRoot, first[0]!.contentRef), "utf8");

    // 重放 A：同一事实再走一次 approved（崩溃重驱 / 事件重复投递的等价物）。
    let replayNote: string;
    try {
      const again = await f.runtime.lifecycle.reviewMemberRun({
        runId: "d1v-r3",
        verdict: "approved",
      });
      replayNote = `返回 ok=${String(again.ok)}/merged=${String(again.merged)}`;
    } catch (error) {
      replayNote = `抛：${error instanceof Error ? error.message : String(error)}`;
    }
    const afterReplay = f.runtime.deliverableRepo.listByRun("d1v-r3");
    assert.equal(afterReplay.length, 1, `重放后仍恰一条（实况：${replayNote}）`);

    // 重放 B（对抗性）：队员分支上**再落一个提交** —— 此刻若重跑捕获，diff 必然不同。
    writeFileSync(join(worktreePath, "late.txt"), "late\n");
    assert.equal((await sh(worktreePath, ["add", "-A"])).code, 0);
    assert.equal((await sh(worktreePath, ["commit", "-qm", "late"])).code, 0);
    const movedDiff = (await sh(f.repoRoot, ["diff", "--no-color", `main...${memberBranch}`]))
      .stdout;
    assert.ok(movedDiff.includes("+late"), "分支确实变了（若重跑捕获会算出不同的正文）");

    await f.runtime.deliverableRecorder.recordRunDiff({
      record: f.runtime.squadRunRepo.get("d1v-r3")!,
      base: "main",
    });
    const afterSecondRecord = f.runtime.deliverableRepo.listByRun("d1v-r3");
    assert.equal(afterSecondRecord.length, 1, "同键重投不产生第二条");
    assert.equal(afterSecondRecord[0]!.contentSha, first[0]!.contentSha, "sha 仍是首投那份");
    assert.equal(
      readFileSync(join(f.repoRoot, first[0]!.contentRef), "utf8"),
      firstText,
      "正文不被二次覆盖（写一次不更新）",
    );
    assert.equal(
      f.timeline(IDS.child).filter((entry) => entry.kind === "deliverable_registered").length,
      1,
      "回声同样幂等",
    );
  } finally {
    rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test("D1V-④ 手动 link 同 URL 两次 ⇒ 两条（不幂等语义）；actor=human 与自动 system 可分", async () => {
  const f = await setup();
  try {
    f.insertItem("d1v-wi-link", "todo");
    const first = await f.facade.registerWorkItemDeliverableLink(f.target, {
      workItemId: "d1v-wi-link",
      title: "PR #7",
      url: "https://example.test/pr/7",
    });
    const second = await f.facade.registerWorkItemDeliverableLink(f.target, {
      workItemId: "d1v-wi-link",
      title: "PR #7（重贴）",
      url: "https://example.test/pr/7",
    });
    assert.notEqual(first.id, second.id, "每次登记新 id");
    assert.notEqual(first.dedupKey, second.dedupKey, "每次登记新键（不是幂等语义）");
    assert.deepEqual(
      {
        kind: first.kind,
        actor: first.actor,
        ref: first.contentRef,
        sha: first.contentSha,
        size: first.contentSize,
        runId: first.runId,
      },
      {
        kind: "link",
        actor: HUMAN_ACTOR,
        ref: "https://example.test/pr/7",
        sha: null,
        size: null,
        runId: null,
      },
    );
    const rows = f.runtime.deliverableRepo.listByWorkItem(WS, "d1v-wi-link");
    assert.equal(rows.length, 2, "同 URL 两次 = 两条独立事实");
    // 读模型（协作读）同样带出两条。
    const read = await f.facade.getWorkItemCollaboration(f.target, "d1v-wi-link");
    assert.equal(read?.deliverables.length, 2);
    const echoes = f.timeline("d1v-wi-link").filter((e) => e.kind === "deliverable_registered");
    assert.equal(echoes.length, 2);
    for (const echo of echoes) {
      assert.deepEqual(echo.actor, HUMAN_ACTOR, "手动登记的回声 actor = 操作者");
      assert.equal((echo.payload as { runId?: unknown }).runId, undefined, "手动登记不写 runId");
      assert.notDeepEqual(echo.actor, SYSTEM_ACTOR, "与自动捕获的 system 可分");
    }
    // link 不落盘（正文在外部）。
    const root = resolveDeliverableContentRoot(f.repoRoot);
    assert.equal(existsSync(root) ? readdirSync(root).length : 0, 0, "link 不得产生任何正文文件");
  } finally {
    rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

/* ---------------- ⑤ 不阻断（合并流照旧 + run 终态正确） ---------------- */

async function nonBlockingAssertions(f: Fixture, runId: string) {
  const outcome = await f.runtime.lifecycle.reviewMemberRun({ runId, verdict: "approved" });
  assert.deepEqual({ ok: outcome.ok, merged: outcome.merged }, { ok: true, merged: true });
  assert.equal(f.runtime.squadRunRepo.get(runId)?.status, "merged", "run 终态正确（merged）");
  assert.equal(f.runtime.deliverableRepo.listByRun(runId).length, 0, "零交付物行");
  assert.equal(
    f.timeline(IDS.child).filter((e) => e.kind === "deliverable_registered").length,
    0,
    "没有行就没有回声",
  );
  assert.equal(
    f.timeline(IDS.child).filter((e) => e.kind === "worktree_merged").length,
    1,
    "merged 事实照落",
  );
  assert.equal(
    f.runtime.workItemRepo.get(IDS.child)?.status,
    "in_review",
    "工作项流转不受留痕影响",
  );
}

test("D1V-⑤a 不阻断｜正文根被同名普通文件占住：合并照落、run merged、零行零回声 + 一条登记层 warn", async () => {
  const f = await setup();
  try {
    planBatch(f);
    await produce(f, { runId: "d1v-nb-a", commits: [{ file: "a.txt", content: "a\n" }] });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(f.repoRoot, ".zcode", "squad"), { recursive: true });
    writeFileSync(join(f.repoRoot, ".zcode", "squad", "deliverables"), "occupied\n");

    const { warns } = await withWarnCapture(() => nonBlockingAssertions(f, "d1v-nb-a"));
    assert.equal(warns.length, 1, `恰一条 warn，实得：${JSON.stringify(warns)}`);
    assert.match(warns[0]!, /登记失败/);
  } finally {
    rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test("D1V-⑤b 不阻断｜正文根存在但不可写（EACCES）：合并照落、run merged、零行零回声 + 一条登记层 warn", async () => {
  const f = await setup();
  const root = resolveDeliverableContentRoot(f.repoRoot);
  try {
    planBatch(f);
    await produce(f, { runId: "d1v-nb-b", commits: [{ file: "b.txt", content: "b\n" }] });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o555);

    // 夹具自检：这一刻根确实不可写（否则本形态什么都没验到）。
    assert.throws(
      () => writeFileSync(join(root, "fixture-probe.tmp"), "x"),
      /EACCES|permission denied/i,
      "夹具自检：正文根此刻确实拒绝写入",
    );
    const { warns } = await withWarnCapture(() => nonBlockingAssertions(f, "d1v-nb-b"));
    assert.equal(warns.length, 1, `恰一条 warn，实得：${JSON.stringify(warns)}`);
    assert.match(warns[0]!, /登记失败/);
    /* 观察（P3，见复验报告）：组合根缺省的 logWarn 是 `(message) => console.warn(message)` ——
       第二个参数（原始错误）被**丢掉**，故 default 路径下 warn 里看不到 EACCES 原文。
       行为不受影响（留痕仍在、层级可辨），但复盘时缺了「为什么」；本用例不钉这个缺口
       （修好它不该让用例变红），只钉「warn 存在且层级可辨」。 */
  } finally {
    if (existsSync(root)) chmodSync(root, 0o755);
    rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test("D1V-⑤c 不阻断｜git runner 全失败（捕获层）：合并照落、run merged、零行零回声 + 捕获层 warn", async () => {
  const f = await setup();
  try {
    planBatch(f);
    await produce(f, { runId: "d1v-nb-c", commits: [{ file: "c.txt", content: "c\n" }] });

    /* 组合根不给 git 注入点（`createSquadRuntime` 自造 runner），故用**生产工厂**造第二个登记面
       （git 恒失败），把它换到 runtime 手里那个**同一对象**的方法位上：lifecycle 持有的就是这个
       对象引用 ⇒ 走的仍是生产调用点，只是捕获侧的 git 起不来。 */
    const calls: string[][] = [];
    const deadGit: GitRunner = async (args) => {
      calls.push(args);
      return { code: 128, stdout: "", stderr: "fatal: 注入的 git 全失败" };
    };
    const warns: string[] = [];
    const deadRecorder = createWorkItemDeliverableRecorder({
      git: deadGit,
      repo: f.runtime.deliverableRepo,
      workspace: { key: WS, path: f.repoRoot },
      projector: f.runtime.activityProjector,
      logWarn: (message) => warns.push(message),
    });
    f.runtime.deliverableRecorder.recordRunDiff = deadRecorder.recordRunDiff;

    await nonBlockingAssertions(f, "d1v-nb-c");
    assert.equal(warns.length, 1, "恰一条 warn（不噪音）");
    assert.match(warns[0]!, /捕获失败/);
    assert.match(warns[0]!, /fatal: 注入的 git 全失败/, "warn 带 git 原文");
    assert.ok(calls.length >= 1, "失败确实发生在捕获的 git 调用上");
    assert.equal(calls[0]![0], "diff", "首个失败调用就是 diff 捕获");
  } finally {
    rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test("D1V-⑤d 不阻断｜登记面本身抛（写库失败）：合并照落、run merged、零行零回声 + 登记层 warn", async () => {
  const f = await setup();
  try {
    planBatch(f);
    await produce(f, { runId: "d1v-nb-d", commits: [{ file: "d.txt", content: "d\n" }] });

    // 捕获（真 git）照走，**登记**这一步抛：验证调用点的收敛覆盖「写库/落盘」而不只是「git」。
    const throwingRepo: WorkItemDeliverableRepo = {
      ...f.runtime.deliverableRepo,
      register: () => {
        throw new Error("注入：登记面写库失败");
      },
    };
    const warns: string[] = [];
    const brokenRecorder = createWorkItemDeliverableRecorder({
      git: f.runtime.git,
      repo: throwingRepo,
      workspace: { key: WS, path: f.repoRoot },
      projector: f.runtime.activityProjector,
      // 收集器**收第二参**（缺省 logWarn 会丢掉它，见 ⑤b 的观察）：这里要证明失败的归属。
      logWarn: (message, error) => warns.push(`${message} :: ${String(error)}`),
    });
    f.runtime.deliverableRecorder.recordRunDiff = brokenRecorder.recordRunDiff;

    await nonBlockingAssertions(f, "d1v-nb-d");
    assert.equal(warns.length, 1);
    assert.match(warns[0]!, /登记失败/, "失败归属登记层（与捕获层可分辨）");
    assert.match(warns[0]!, /注入：登记面写库失败/);
  } finally {
    rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test("D1V-⑤e 不阻断｜队长无分支：capture 静默跳过（零 git 调用/零行/零 warn），队长成功臂零交付物", async () => {
  const f = await setup();
  try {
    f.insertItem("d1v-leader-wi", "in_progress");
    const opened = await f.runtime.lifecycle.recordLeaderRun({
      runId: "d1v-leader",
      workItemId: "d1v-leader-wi",
      agentId: IDS.agent,
    });
    assert.equal(opened.recorded, true);
    const leaderRow = f.runtime.squadRunRepo.get("d1v-leader")!;
    assert.equal(leaderRow.branch, null, "队长行没有分支");

    // record 级闸：直接经登记面重放一次 —— 连 git 都不该问，也不该留 warn。
    const calls: string[][] = [];
    const countingGit: GitRunner = async (args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    };
    const warns: string[] = [];
    const recorder = createWorkItemDeliverableRecorder({
      git: countingGit,
      repo: f.runtime.deliverableRepo,
      workspace: { key: WS, path: f.repoRoot },
      logWarn: (message) => warns.push(message),
    });
    await recorder.recordRunDiff({ record: leaderRow, base: "main" });
    assert.deepEqual(calls, [], "队长 run 没有可捕获的分支：零 git 调用");
    assert.deepEqual(warns, [], "这不是失败：静默跳过，零 warn");
    assert.equal(f.runtime.deliverableRepo.listByRun("d1v-leader").length, 0);

    // 队长成功臂（生产入口）走完：不因无分支报错，也不产生任何交付物。
    await f.runtime.lifecycle.completeLeaderRun({ runId: "d1v-leader" });
    assert.equal(f.runtime.squadRunRepo.get("d1v-leader")?.status, "merged");
    assert.equal(f.runtime.deliverableRepo.listByRun("d1v-leader").length, 0);
    assert.equal(
      f.timeline("d1v-leader-wi").filter((e) => e.kind === "deliverable_registered").length,
      0,
      "队长链上没有任何交付物回声",
    );
  } finally {
    rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

/* ---------------- ⑥ 越界零副作用 + 路径逃逸形态 ---------------- */

test("D1V-⑥ 越界零副作用：{kind:'diff'} 形状透传 ⇒ 仍落 link、盘上零 diff 正文、归因不可伪造", async () => {
  const f = await setup();
  try {
    f.insertItem("d1v-wi-oob", "todo");
    const root = resolveDeliverableContentRoot(f.repoRoot);
    const before = existsSync(root) ? readdirSync(root).sort() : [];

    const registered = await f.facade.registerWorkItemDeliverableLink(f.target, {
      workItemId: "d1v-wi-oob",
      title: "伪装的 diff",
      url: "https://example.test/actually-a-link",
      kind: "diff",
      content: "diff --git a/x b/x\n+1\n",
      runId: "forged-run",
      actor: { kind: "system", id: "forged" },
    } as unknown as Parameters<typeof f.facade.registerWorkItemDeliverableLink>[1]);

    assert.equal(registered.kind, "link");
    const rows = f.runtime.deliverableRepo.listByWorkItem(WS, "d1v-wi-oob");
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.deepEqual(
      {
        kind: row.kind,
        ref: row.contentRef,
        sha: row.contentSha,
        size: row.contentSize,
        runId: row.runId,
        actor: row.actor,
      },
      {
        kind: "link",
        ref: "https://example.test/actually-a-link",
        sha: null,
        size: null,
        runId: null,
        actor: HUMAN_ACTOR,
      },
      "kind / 归因 / run 归属都不接受调用方伪造",
    );
    const after = existsSync(root) ? readdirSync(root).sort() : [];
    assert.deepEqual(after, before, "越界输入不得在盘上多出任何正文");
    assert.equal(after.filter((name) => name.endsWith(".diff")).length, 0);
    const detail = await f.facade.getWorkItemDeliverable(f.target, registered.id);
    assert.deepEqual(detail?.content, {
      presence: "external",
      url: "https://example.test/actually-a-link",
    });
  } finally {
    rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test("D1V-⑦ 路径逃逸两形态：diff 行 id 段逃逸零副作用拒写；content_ref 越界读回响亮拒", async () => {
  const f = await setup();
  try {
    f.insertItem("d1v-wi-escape", "todo");
    const root = resolveDeliverableContentRoot(f.repoRoot);
    const outside = [
      join(f.repoRoot, ".zcode", "escape.diff"),
      join(f.repoRoot, ".zcode", "squad", "escape.diff"),
      join(f.repoRoot, "escape.diff"),
    ];

    // 形态一（写侧，diff 行）：id 会拼进文件名 ⇒ 单段闸必须在写盘前响亮拒，且零文件零行。
    for (const id of ["../escape", "../../escape", "/tmp/d1v-escape", "a/../../escape"]) {
      assert.throws(
        () =>
          f.runtime.deliverableRepo.register({
            id,
            workspaceKey: WS,
            workspacePath: f.repoRoot,
            workItemId: "d1v-wi-escape",
            kind: "diff",
            title: "逃逸",
            content: "diff --git a/x b/x\n+1\n",
            actor: SYSTEM_ACTOR,
            dedupKey: `d1v-escape-${id}`,
            createdAt: 1,
          }),
        /id/,
        `diff 行的逃逸 id ${JSON.stringify(id)} 必须响亮拒`,
      );
    }
    for (const path of outside) {
      assert.equal(existsSync(path), false, `不得写出 ${path}`);
    }
    assert.equal(f.runtime.deliverableRepo.listByWorkItem(WS, "d1v-wi-escape").length, 0, "零行");

    /* 形态二（手动登记面，link 行）：`newId` 是登记面的注入位 —— 逃逸 id 源下，
       **安全不变式**是「越界路径上零文件」，本用例钉这一条（对「接受」与「拒绝」两种实况都成立）。
       实况观察：今天 link 行**不过**单段闸（`../../escape` 被接受，因为 link 不写正文文件、
       该闸只在 `writeDiffContent` 的路径上生效）—— 登记为 P3 纵深缺口（复现见复验报告），
       故这里刻意不钉「抛」也不钉「接受」，只钉零文件副作用。 */
    const hostile = createWorkItemDeliverableRecorder({
      git: f.runtime.git,
      repo: f.runtime.deliverableRepo,
      workspace: { key: WS, path: f.repoRoot },
      newId: () => "../../escape",
      logWarn: () => {},
    });
    try {
      hostile.registerLink({
        workItemId: "d1v-wi-escape",
        title: "逃逸",
        url: "https://example.test/x",
        actor: HUMAN_ACTOR,
      });
    } catch {
      // 接受与拒绝都允许；下面只断言「盘上不得出现越界文件」。
    }
    for (const path of outside) {
      assert.equal(existsSync(path), false, `不得写出 ${path}`);
    }
    assert.equal(
      existsSync(root) ? readdirSync(root).filter((n) => n.endsWith(".diff")).length : 0,
      0,
      "link 逃逸不得产生任何 diff 正文",
    );

    // 形态三（读侧）：库里被写坏的一行不得变成一次越界读。
    const good = f.runtime.deliverableRepo.register({
      id: "d1v-tamper",
      workspaceKey: WS,
      workspacePath: f.repoRoot,
      workItemId: "d1v-wi-escape",
      kind: "diff",
      title: "对账用",
      content: "diff --git a/x b/x\n+1\n",
      actor: SYSTEM_ACTOR,
      dedupKey: "d1v-tamper",
      createdAt: 1,
    });
    f.db
      .prepare("UPDATE work_item_deliverables SET content_ref = ? WHERE id = ?")
      .run(".zcode/squad/../../../outside.txt", good.id);
    assert.throws(
      () => f.runtime.deliverableRepo.get("d1v-tamper"),
      /正文根/,
      "content_ref 越出正文根 ⇒ 读回响亮抛（不静默当成缺失）",
    );
  } finally {
    rmSync(f.repoRoot, { recursive: true, force: true });
  }
});
