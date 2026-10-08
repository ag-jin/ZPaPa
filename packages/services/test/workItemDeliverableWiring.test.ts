import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { planBranches } from "../src/worktree/branchNaming.js";
import type { GitRunner } from "../src/worktree/gitRunner.js";
import { createSquadOrchestrator } from "../src/workitem/squadOrchestrator.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import { slugForId } from "../src/workitem/slug.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import { createWorkItemDeliverableRecorder } from "../src/workitem/workItemDeliverableRecorder.js";
import { createWorkItemDeliverableRepo } from "../src/workitem/workItemDeliverableRepo.js";
import type { SquadRunRecord } from "../src/workitem/squadRunRepo.js";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { makeRepo, realGit } from "./helpers/gitFixture.js";

/* #7 交付物 **D1b 接线半边**：两个自动产生点的**生产接线**（设计 §3.1/§3.3/§3.4）。

   断言全部落在**已落地的事实**上（`work_item_deliverables` 行 + 盘上正文 + Activity 行），
   期望值是手写字面量 / 独立真源（`branchNaming` 的命名规则、git 自己的 stat 文案）——
   键形状不经过被实现引用的计算函数，正文按「git 在同一个范围上会输出什么」现场核对。 */

const WS = "d1b-ws";

/** 真实 git 仓库 + `:memory:` 库 + 真 runtime（与 c3bRunProjectionWiring / batch 同款缝合）。 */
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
  const activities = createWorkItemActivityRepo(db);
  const timeline = (workItemId: string) => activities.listByWorkItem(WS, workItemId);
  const createItem = (
    id: string,
    status: "todo" | "in_progress" | "in_review",
    parentId?: string,
  ): void => {
    runtime.workItemRepo.insert({
      id,
      workspaceIdentity: WS,
      workspacePath: repoRoot,
      ...(parentId !== undefined ? { parentId } : {}),
      title: `D1b ${id}`,
      body: "",
      status,
      assignee: { type: "agent", id: "d1b-agent" },
      labels: [],
      properties: {},
      position: 0,
    });
  };
  return {
    repoRoot,
    runtime,
    activities,
    timeline,
    createItem,
    orchestrator: createSquadOrchestrator({ runtime }),
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

/** 「父项 + 子项」一条批（形状与生产一致：父项派给小队、子项派给队员）。 */
function planBatch(f: Fixture, ids: { parent: string; child: string; agent: string }) {
  f.createItem(ids.parent, "in_review");
  f.createItem(ids.child, "in_progress", ids.parent);
  return planBranches({
    workItemSlug: slugForId(ids.child),
    agentSlug: slugForId(ids.agent),
  });
}

/** 开树 + 提交一个文件 + 上报完成（→ run `produced`）。 */
async function produce(
  f: Fixture,
  input: {
    runId: string;
    parent: string;
    child: string;
    agent: string;
    file: string;
    content: string;
  },
): Promise<void> {
  const opened = await f.runtime.lifecycle.openMemberRun({
    runId: input.runId,
    workItemId: input.child,
    parentWorkItemId: input.parent,
    agentId: input.agent,
    isLeaderTask: false,
  });
  assert.equal(opened.kind, "opened");
  if (opened.kind !== "opened") return;
  writeFileSync(join(opened.worktreePath, input.file), input.content);
  const git = realGit(opened.worktreePath);
  for (const args of [
    ["add", "-A"],
    ["commit", "-qm", `${input.agent} work`],
  ]) {
    const result = await git(args, {});
    assert.equal(result.code, 0, `${args.join(" ")} 失败: ${result.stderr}`);
  }
  await f.runtime.lifecycle.completeMemberRun({ runId: input.runId });
}

const IDS = { parent: "wi-p", child: "wi-c", agent: "d1b-agent" };

/** 台账行的最小形状（登记面只读 runId / workItemId / agentId / branch / isLeaderTask）。 */
function runRecord(over: Partial<SquadRunRecord> & { runId: string }): SquadRunRecord {
  return {
    workspaceKey: WS,
    workspacePath: "/tmp/d1b-ws",
    workItemId: IDS.child,
    parentWorkItemId: IDS.parent,
    agentId: IDS.agent,
    isLeaderTask: false,
    branch: null,
    dirName: null,
    status: "produced",
    sessionId: null,
    dispatchCause: null,
    causedByRunId: null,
    settleReason: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as SquadRunRecord;
}

test("D1b-① run 级：approved 合并 ⇒ 交付物恰一条（id/键/元数据/真 diff 正文）+ 第 20 枚回声先于 merged 事实", async () => {
  const f = await setup();
  const { member: memberBranch } = planBatch(f, IDS);
  await produce(f, {
    runId: "r-1",
    parent: IDS.parent,
    child: IDS.child,
    agent: IDS.agent,
    file: "payload.txt",
    content: "hello\n",
  });

  const outcome = await f.runtime.lifecycle.reviewMemberRun({ runId: "r-1", verdict: "approved" });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.merged, true);

  const rows = f.runtime.deliverableRepo.listByRun("r-1");
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
      contentRef: row.contentRef,
    },
    {
      /* id 与键同源（机械替换），键形状 = `deliverable:<runId>:diff`（D1a 冻结）。 */
      id: "deliverable-deliverable-r-1-diff",
      kind: "diff",
      dedupKey: "deliverable:r-1:diff",
      runId: "r-1",
      workItemId: IDS.child,
      actor: { kind: "system", id: "squad-runtime" },
      contentRef: ".zcode/squad/deliverables/deliverable-deliverable-r-1-diff.diff",
    },
  );
  // 元数据：分支 / base / commit 数 / stat 摘要（都取自同一个范围）。
  assert.equal(row.meta.branch, memberBranch);
  assert.equal(row.meta.base, "main");
  assert.equal(row.meta.commitCount, 1);
  assert.match(String(row.meta.statSummary), /1 file changed, 1 insertion\(\+\)/);

  // 正文：真 git diff（字面量核对新增内容 + 大小与库中一致）。
  const text = readFileSync(join(f.repoRoot, row.contentRef), "utf8");
  assert.ok(text.includes("diff --git a/payload.txt b/payload.txt"), `正文不是真 diff:\n${text}`);
  assert.ok(text.includes("+hello"), `正文缺新增行:\n${text}`);
  assert.equal(row.contentSize, Buffer.byteLength(text, "utf8"));

  // 第 20 枚回声：一条，payload/actor/键逐字；且**先于** `worktree_merged`（事实先落）。
  const timeline = f.timeline(IDS.child);
  const echoes = timeline.filter((entry) => entry.kind === "deliverable_registered");
  assert.equal(echoes.length, 1);
  assert.deepEqual(
    {
      dedupKey: echoes[0]!.dedupKey,
      payload: echoes[0]!.payload,
      actor: echoes[0]!.actor,
    },
    {
      dedupKey: "deliverable:deliverable-deliverable-r-1-diff:registered",
      payload: {
        kind: "diff",
        title: `队员 run 产出 diff（${memberBranch}）`,
        deliverableId: "deliverable-deliverable-r-1-diff",
        runId: "r-1",
      },
      actor: { kind: "system", id: "squad-runtime" },
    },
  );
  const echoIndex = timeline.findIndex((entry) => entry.kind === "deliverable_registered");
  const mergedIndex = timeline.findIndex((entry) => entry.kind === "worktree_merged");
  assert.ok(echoIndex >= 0 && mergedIndex > echoIndex, "回声必须在 merged 事实之前落地");
});

test("D1b-② 登记失败不阻断：正文根被占（磁盘形态失败）⇒ 合并照常落地，只留一条 warn", async () => {
  const f = await setup();
  planBatch(f, IDS);
  await produce(f, {
    runId: "r-2",
    parent: IDS.parent,
    child: IDS.child,
    agent: IDS.agent,
    file: "payload.txt",
    content: "hello\n",
  });
  /* 把正文根**先占成一个文件**：`mkdirSync(root, {recursive:true})` 必抛（EEXIST/ENOTDIR），
     即「磁盘/权限形态的登记失败」的真实等价物 —— 不留任何测试专用注入点。 */
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(f.repoRoot, ".zcode", "squad"), { recursive: true });
  writeFileSync(join(f.repoRoot, ".zcode", "squad", "deliverables"), "not a directory\n");

  const outcome = await f.runtime.lifecycle.reviewMemberRun({ runId: "r-2", verdict: "approved" });

  // 合并这条事实照常落地：留痕失败**不得**把已成功的合并翻转成失败（设计 §8）。
  assert.equal(outcome.ok, true);
  assert.equal(outcome.merged, true);
  assert.equal(f.runtime.squadRunRepo.get("r-2")?.status, "merged");
  assert.deepEqual(f.runtime.deliverableRepo.listByRun("r-2"), []);
  assert.equal(
    f.timeline(IDS.child).filter((entry) => entry.kind === "deliverable_registered").length,
    0,
    "没有落库就没有回声（回声不得引用一条没登记上的交付物）",
  );
  assert.equal(
    f.timeline(IDS.child).filter((entry) => entry.kind === "worktree_merged").length,
    1,
    "merged 事实照落",
  );
});

/* ---------- 登记面自身的缝（组合根注入的那个模块面） ---------- */

/** git 侧一律失败的 runner（`code=1`）：捕获函数把它收敛成 `{ok:false, reason}`。 */
function failingGit(): { calls: string[][]; git: GitRunner } {
  const calls: string[][] = [];
  const git: GitRunner = async (args) => {
    calls.push(args);
    return { code: 1, stdout: "", stderr: "boom" };
  };
  return { calls, git };
}

test("D1b-③ 捕获失败（git 侧）不抛：留一条 warn、零行、零回声，调用方拿到正常返回", async () => {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const { calls, git } = failingGit();
  const warns: string[] = [];
  const recorder = createWorkItemDeliverableRecorder({
    git,
    repo: createWorkItemDeliverableRepo(db),
    workspace: { key: WS, path: repoRoot },
    logWarn: (message) => warns.push(message),
  });

  await recorder.recordRunDiff({
    record: runRecord({ runId: "r-fail", branch: "squad/member/wi-c/d1b-agent" }),
    base: "main",
  });

  assert.equal(calls.length, 1, "首个 git 调用失败即收敛（不留后续命令），调用方拿到的是失败原因");
  assert.deepEqual(createWorkItemDeliverableRepo(db).listByRun("r-fail"), []);
  assert.equal(warns.length, 1);
  assert.match(warns[0]!, /捕获失败/);
  assert.match(warns[0]!, /boom/, "warn 必须带 git 原文，否则复盘时不知道这次为什么没有交付物");
});

test("D1b-④ record 级闸：队长 run（branch=null）不捕获 —— 零 git 调用、零行、零 warn", async () => {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const { calls, git } = failingGit();
  const warns: string[] = [];
  const recorder = createWorkItemDeliverableRecorder({
    git,
    repo: createWorkItemDeliverableRepo(db),
    workspace: { key: WS, path: repoRoot },
    logWarn: (message) => warns.push(message),
  });

  await recorder.recordRunDiff({
    record: runRecord({ runId: "r-leader", branch: null, isLeaderTask: true }),
    base: "main",
  });

  assert.deepEqual(calls, [], "队长 run 没有分支：连 git 都不该问");
  assert.equal(warns.length, 0, "这不是失败：静默跳过，不留 warn 噪音");
  assert.deepEqual(createWorkItemDeliverableRepo(db).listByRun("r-leader"), []);
});

test("D1b-⑤ 幂等重驱：同一条 run 再登记一次 ⇒ 仍恰一条、正文不被二次覆盖", async () => {
  const f = await setup();
  planBatch(f, IDS);
  await produce(f, {
    runId: "r-5",
    parent: IDS.parent,
    child: IDS.child,
    agent: IDS.agent,
    file: "payload.txt",
    content: "hello\n",
  });
  await f.runtime.lifecycle.reviewMemberRun({ runId: "r-5", verdict: "approved" });
  const first = f.runtime.deliverableRepo.listByRun("r-5");
  assert.equal(first.length, 1);

  // 重驱同一事实（崩溃后重放的等价物）：登记面按同一 dedupKey 重投 ⇒ 返回既存行、正文不重写。
  const record = f.runtime.squadRunRepo.get("r-5")!;
  await f.runtime.deliverableRecorder.recordRunDiff({ record, base: "main" });

  const second = f.runtime.deliverableRepo.listByRun("r-5");
  assert.equal(second.length, 1, "同一条 run 的自动 diff 至多一条");
  assert.equal(second[0]!.id, first[0]!.id);
  assert.equal(second[0]!.createdAt, first[0]!.createdAt, "既存行原样返回（不更新）");
  assert.equal(second[0]!.contentSha, first[0]!.contentSha);
  assert.equal(
    f.timeline(IDS.child).filter((entry) => entry.kind === "deliverable_registered").length,
    1,
    "回声同样幂等（键由交付物 id 派生）",
  );
});

test("D1b-⑥ 批级：finalize 落地后捕「前后 sha 差」——分支已全删仍能捕，恰一条批级 diff + 回声", async () => {
  const f = await setup();
  const plan = planBatch(f, IDS);
  await produce(f, {
    runId: "r-6",
    parent: IDS.parent,
    child: IDS.child,
    agent: IDS.agent,
    file: "payload.txt",
    content: "hello\n",
  });
  f.runtime.workItemService.transition(IDS.child, "done", "in_review");
  // finalize 之前读一次 target sha（独立真源：git 自己回答 main 现在指着哪）。
  const headBefore = (
    await realGit(f.repoRoot)(["rev-parse", "refs/heads/main"], {})
  ).stdout.trim();

  await f.orchestrator.advanceAfterChildrenDone({
    workspaceKey: WS,
    parentWorkItemId: IDS.parent,
  });

  // 批级行：挂在**父项**上、不挂 run（runId=null）、键 = `deliverable:<parentId>:batch-diff`。
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
    },
    {
      id: "deliverable-deliverable-wi-p-batch-diff",
      kind: "diff",
      dedupKey: "deliverable:wi-p:batch-diff",
      runId: null,
      workItemId: IDS.parent,
      actor: { kind: "system", id: "squad-runtime" },
    },
  );
  assert.equal(row.meta.batchLevel, true);
  assert.equal(row.meta.target, "main");
  assert.equal(row.meta.baseSha, headBefore, "baseSha = finalize 之前读到的 target sha");
  /* 3 = 队员的 1 个内容提交 + 两枚 `--no-ff` 合并提交（member→integration、integration→main，
     `integrationMerge` 的合并一律显式 no-ff）—— 范围里的**全部**提交，不挑着数。 */
  assert.equal(row.meta.commitCount, 3);

  const text = readFileSync(join(f.repoRoot, row.contentRef), "utf8");
  assert.ok(text.includes("+hello"), `批级正文缺本批新增行:\n${text}`);
  assert.ok(text.includes("1 file changed, 1 insertion(+)") === false, "stat 不进正文");
  assert.match(String(row.meta.statSummary), /1 file changed, 1 insertion\(\+\)/);

  // 捕获时集成分支与队员分支**都已删**（这正是「按分支名捕获」做不到的一格）。
  assert.notEqual(
    (
      await realGit(f.repoRoot)(
        ["rev-parse", "-q", "--verify", `refs/heads/${plan.integration}`],
        {},
      )
    ).code,
    0,
    "集成分支已删",
  );
  assert.notEqual(
    (await realGit(f.repoRoot)(["rev-parse", "-q", "--verify", `refs/heads/${plan.member}`], {}))
      .code,
    0,
    "队员分支已删",
  );
  // 主分支上真的有这一批的成果（交付物记录的是「已落地」的事实，不是空转）。
  assert.equal((await realGit(f.repoRoot)(["show", "main:payload.txt"], {})).stdout, "hello\n");

  // 第 20 枚回声：挂父项、不带 runId（批级不挂 run）。
  const echoes = f.timeline(IDS.parent).filter((entry) => entry.kind === "deliverable_registered");
  assert.equal(echoes.length, 1);
  assert.deepEqual(
    { dedupKey: echoes[0]!.dedupKey, payload: echoes[0]!.payload, actor: echoes[0]!.actor },
    {
      dedupKey: "deliverable:deliverable-deliverable-wi-p-batch-diff:registered",
      payload: {
        kind: "diff",
        title: "整批合回 diff（main）",
        deliverableId: "deliverable-deliverable-wi-p-batch-diff",
      },
      actor: { kind: "system", id: "squad-runtime" },
    },
  );
});

/* ---------- 结构守卫（接线钉死：防「忘了接线、只留 warn」与「第二构造点」） ---------- */

const SERVICES_SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const readServiceSource = (relative: string) => readFileSync(join(SERVICES_SRC, relative), "utf8");

test("守卫｜两调用点各恰一处、构造点唯一在组合根（第二处实现会让键/归因分叉而不报错）", () => {
  const lifecycle = stripComments(readServiceSource("workitem/squadRunLifecycle.ts"));
  const orchestrator = stripComments(readServiceSource("workitem/squadOrchestrator.ts"));
  const runtime = stripComments(readServiceSource("workitem/squadRuntime.ts"));

  assert.equal(
    [...lifecycle.matchAll(/deps\.deliverableRecorder\?\.recordRunDiff\(/g)].length,
    1,
    "run 级捕获只准落在 reviewMemberRun 的 approved 臂（合并成后、分支被删前的唯一窗口）",
  );
  assert.equal(
    [...orchestrator.matchAll(/runtime\.deliverableRecorder\.recordBatchDiff\(/g)].length,
    1,
    "批级捕获只准落在 advanceAfterChildrenDone 的 finalize 落地臂",
  );
  for (const [name, source] of [
    ["squadRunLifecycle", lifecycle],
    ["squadOrchestrator", orchestrator],
  ] as const) {
    assert.ok(
      !source.includes("createWorkItemDeliverableRecorder("),
      `${name} 不得自建登记面：构造点唯一在组合根（漏接的表现是「合并照常、交付物永远没有」）`,
    );
  }
  assert.equal(
    [...runtime.matchAll(/createWorkItemDeliverableRecorder\(/g)].length,
    1,
    "组合根必须恰好构造一份登记面",
  );
  assert.match(
    runtime,
    /^\s+deliverableRecorder,$/m,
    "登记面必须以简写属性原样交给 createRunLifecycle",
  );
  assert.match(
    runtime,
    /^\s+deliverableRecorder,$/m,
    "登记面必须暴露在 runtime 上（编排器/服务面经它用）",
  );
  assert.match(runtime, /^\s+deliverableRepo,$/m, "存储面必须暴露在 runtime 上（读模型经它取数）");
});

test("守卫｜服务面 link-only：请求形状无 kind、门面不碰 repo 写口（手动 diff 在结构上写不出来）", () => {
  const facade = stripComments(readServiceSource("workitem/workItemCollaborationService.ts"));
  const requestBlock = facade.slice(
    facade.indexOf("export type RegisterWorkItemDeliverableLinkRequest = {"),
    facade.indexOf("};", facade.indexOf("export type RegisterWorkItemDeliverableLinkRequest = {")),
  );
  assert.ok(requestBlock.length > 0, "找不到手动登记的请求形状");
  assert.ok(
    !/^\s+kind\b/m.test(requestBlock),
    "手动登记请求**不得**带 kind：手动只开 link（diff 型只由自动捕获产生）",
  );
  assert.equal(
    [...facade.matchAll(/deliverableRepo\.register|deliverableRepo\.add/g)].length,
    0,
    "门面零 SQL / 零 repo 写口：写入唯一经 runtime.deliverableRecorder",
  );
  assert.equal(
    [...facade.matchAll(/deliverableRecorder\.registerLink\(/g)].length,
    1,
    "手动登记只经登记面的 registerLink 一处",
  );
});
