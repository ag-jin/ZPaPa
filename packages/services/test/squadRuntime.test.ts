import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import {
  SquadDispatchDisabledError,
  createSquadRuntimeService,
  type SquadWorkspaceTarget,
} from "../src/workitem/squadRuntimeService.js";
import {
  archiveSquadAndTransfer,
  createSquadRuntime,
  renderLeaderBriefingPrompt,
} from "../src/workitem/squadRuntime.js";
import { hasInProgressLeaderRun } from "../src/workitem/squadRunLifecycle.js";
import { slugForId } from "../src/workitem/slug.js";
import type { WorkItemEvent } from "../src/workitem/workItemService.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* 组合根装配 + 冻结契约的机器化证明（recon.md C6：这些零件出厂即「零生产调用方」，本文件是第一个调用方）。

   覆盖三块：
   1. 装配与「同一条连接」（recon.md F3）；
   2. 运行生命周期机械半（先落台账后建树、活跃集合口径、启动回收、审查三分支）；
   3. 门禁单点（确认 2）+ workspace 目标绑定（确认 3 / 裁定 4）的失败路径。 */

const target = (identity: string) => ({ path: `/tmp/${identity}`, identity });

async function makeMemoryDb(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return db;
}

/** 默认装配：真实临时 git 仓库 + 内存库，绑定 workspace "ws"，门禁打开。 */
async function setup() {
  const repoRoot = await makeRepo();
  const db = await makeMemoryDb();
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: "ws",
    readExperimentEnabled: () => true,
  });
  return { repoRoot, db, runtime };
}

/** 开关关闭的装配（确认 2 的失败路径）。 */
async function disabledSetup(value = false) {
  const repoRoot = await makeRepo();
  const db = await makeMemoryDb();
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: "ws",
    readExperimentEnabled: () => value,
  });
  return { repoRoot, db, runtime };
}

/** 可切换开关的装配 + 服务层（三个入口共用同一判据的机器化证明）。 */
async function controllableSetup() {
  const { repoRoot, db, runtime } = await setup();
  // 快照式的同步开关：runtime 与「呈现用」的异步读取都从这里取，测试里用一个变量模拟设置变更。
  const state = { enabled: true };
  const runtimeForTarget = async (_t: { path: string; identity: string }) =>
    createSquadRuntime({
      db,
      workspacePath: repoRoot,
      workspaceIdentity: "ws",
      readExperimentEnabled: () => state.enabled,
    });
  const svc = createSquadRuntimeService({
    createRuntime: runtimeForTarget,
    readExperimentEnabled: async () => state.enabled,
    // 注入形态是 `(target, id)`：组合根按目标现构 runtime 后再调那个组合函数（见 node.ts）。
    archiveSquadAndTransfer: async (_target, id) => archiveSquadAndTransfer(runtime, id),
  });
  return {
    repoRoot,
    db,
    runtime,
    svc,
    setEnabled: (value: boolean) => {
      state.enabled = value;
    },
  };
}

// ---------- 1. 装配 ----------

test("装配后 repo / service / 工具都在，且 base 分支来自真实 HEAD", async () => {
  const { runtime } = await setup();
  assert.equal(typeof runtime.workItemRepo.insert, "function");
  assert.equal(typeof runtime.wakeRuleRepo.listReady, "function");
  assert.equal(typeof runtime.workItemService.transition, "function");
  assert.equal(typeof runtime.squadService.create, "function");
  assert.equal(typeof runtime.teamAgentService.create, "function");
  assert.equal(typeof runtime.lifecycle.openMemberRun, "function");
  // 裁定 4 / 确认 3：runtime 与目标 workspace **一一对应**，绑定字段就写在这里。
  assert.deepEqual(runtime.boundWorkspace, { path: runtime.boundWorkspace.path, identity: "ws" });
  // makeRepo 用 `git init -b main`，所以 HEAD 解析必须给出 main（不是硬编码的猜测）。
  assert.equal(runtime.baseBranch, "main");
});

// T1 交接项 1（taskIndexRepo.openSharedDatabase 的落点）：三个 repo 必须吃**同一条**连接。
// 用内存库当判据：另开一条连接会是**另一个空库**（连表都没有），所以只要经注入句柄写入的行
// 能被 runtime 的 repo 读到（反之亦然），就证明两边是同一条连接，而非「同一个文件的两条连接」。
test("runtime 的三个 repo 与注入句柄是同一条连接（recon.md F3）", async () => {
  const { repoRoot, db, runtime } = await setup();

  // ① 注入句柄写 → workItemRepo 读
  db.prepare(
    `INSERT INTO work_items (id, workspace_key, workspace_path, parent_id, stage, title, body, status,
      assignee_type, assignee_id, labels, properties, position, archived_at, created_at, updated_at)
     VALUES (?, ?, ?, NULL, NULL, ?, '', 'todo', 'user', 'u1', '[]', '{}', 0, NULL, 1, 1)`,
  ).run("wi-probe", "ws", repoRoot, "probe");
  assert.equal(runtime.workItemRepo.get("wi-probe")?.title, "probe");

  // ② wakeRuleRepo 写 → 注入句柄读
  runtime.wakeRuleRepo.insert({
    id: "wr-probe",
    workItemId: "wi-probe",
    kind: "at",
    mode: "once",
    at: 1,
    fireCount: 0,
    revision: 0,
    enabled: true,
  });
  const ruleRow = db.prepare("SELECT work_item_id FROM wake_rules WHERE id = ?").get("wr-probe") as
    | { work_item_id: string }
    | undefined;
  assert.equal(ruleRow?.work_item_id, "wi-probe");

  // ③ squadRunRepo 写（经生命周期）→ 注入句柄读
  await runtime.lifecycle.openMemberRun({
    runId: "r-conn",
    workItemId: "wi-c",
    parentWorkItemId: "wi-p",
    agentId: "ta-c",
    isLeaderTask: false,
  });
  const runRow = db.prepare("SELECT status FROM squad_runs WHERE run_id = ?").get("r-conn") as
    | { status: string }
    | undefined;
  assert.equal(runRow?.status, "open");
});

// base 分支**绝不猜 "main"**（brief 的冻结契约）：解析失败就抛，否则整批成果会合到别的分支上。
test("非 git 目录 + 未显式给 base ⇒ 构造时抛（不猜 main）", async () => {
  const plain = mkdtempSync(join(tmpdir(), "not-a-repo-"));
  const db = await makeMemoryDb();
  await assert.rejects(
    () =>
      createSquadRuntime({
        db,
        workspacePath: plain,
        workspaceIdentity: "ws",
        readExperimentEnabled: () => true,
      }),
    /base 分支/,
  );
});

// 补集方向：显式给 base（且目录**不是** git 仓库）时构造成功，证明这条路上真的没有跑 HEAD 解析。
test("显式给 baseBranch ⇒ 跳过 HEAD 解析（非 git 目录也能构造）", async () => {
  const plain = mkdtempSync(join(tmpdir(), "not-a-repo-"));
  const db = await makeMemoryDb();
  const runtime = await createSquadRuntime({
    db,
    workspacePath: plain,
    workspaceIdentity: "ws",
    baseBranch: "release/2.0",
    readExperimentEnabled: () => true,
  });
  assert.equal(runtime.baseBranch, "release/2.0");
});

test("显式给的 baseBranch 为空白 ⇒ 抛（不许静默回退到 HEAD 解析）", async () => {
  const plain = mkdtempSync(join(tmpdir(), "not-a-repo-"));
  const db = await makeMemoryDb();
  await assert.rejects(
    () =>
      createSquadRuntime({
        db,
        workspacePath: plain,
        workspaceIdentity: "ws",
        baseBranch: "   ",
        readExperimentEnabled: () => true,
      }),
    /base 分支/,
  );
});

// ---------- 2. 运行生命周期（机械半） ----------

/* slug 的确定性、唯一性与安全性（spec §6.2：启动回收要靠它认清活跃分支）。
   直接取 sha256 前 16 hex 而不是「归一化 id」：归一化会把 `A-B` 与 `a_b` 映成同一个 slug，
   两个工作项于是共用分支与目录——互相覆盖成果**且不报错**。 */
test("slugForId：确定、对 id 唯一、且恒为合法单路径段", () => {
  assert.equal(slugForId("wi-1"), slugForId("wi-1"));
  // 与 sha256 前 16 hex 一致 ⇒ 别的进程/别的语言都能复算出同一个值（重启后仍能认出活跃分支）。
  assert.equal(slugForId("wi-1"), createHash("sha256").update("wi-1").digest("hex").slice(0, 16));
  // 归一化会撞车的两个 id，在这里必须给出不同 slug。
  assert.notEqual(slugForId("A-B"), slugForId("a_b"));
  // 任意 id（中文、空格、斜杠、`..`、大写）都产出同一形状的安全 slug ⇒ 过得了 assertSafeSlug。
  for (const id of ["中文 id", "a/b", "..", "UPPER_CASE"]) {
    assert.match(slugForId(id), /^[a-z0-9]{16}$/, `id=${JSON.stringify(id)}`);
  }
});

// 开树必须**先落台账后建树**：反过来（树建成了而台账没写）在两者之间崩溃，
// 队员的未提交成果会被启动回收当孤儿收掉——「审查被拒必须存活到合并」就落空了。
test("openMemberRun 先落台账再建树", async () => {
  const { runtime } = await setup();
  const out = await runtime.lifecycle.openMemberRun({
    runId: "run-1",
    workItemId: "wi-c",
    parentWorkItemId: "wi-p",
    agentId: "ta-a",
    isLeaderTask: false,
  });
  const row = runtime.squadRunRepo.get("run-1")!;
  assert.equal(row.status, "open");
  assert.equal(row.dirName, out.worktreePath.split("/").at(-1));
  assert.equal(row.branch, out.branch);
  assert.ok(out.branch.startsWith("squad/member/"));
  assert.ok((await runtime.worktreeManager.list()).some((e) => e.path === out.worktreePath));
  // slug 是 16 位 hex（确定性、对 id 唯一），分支与目录都从它派生。
  assert.ok(out.branch.includes(slugForId("wi-c")));
  assert.ok(out.branch.includes(slugForId("ta-a")));
});

// 同 runId 重复 ⇒ 台账主键冲突**响亮失败**，且不得在失败前多挂一棵树
// （静默复用旧行会让两次 run 的成果落进同一个身份里）。
test("openMemberRun 同 runId 重复 ⇒ 抛，且不重复建树", async () => {
  const { runtime } = await setup();
  const request = {
    runId: "r-dup",
    workItemId: "wi-c",
    parentWorkItemId: "wi-p",
    agentId: "ta-a",
    isLeaderTask: false,
  };
  await runtime.lifecycle.openMemberRun(request);
  const before = (await runtime.worktreeManager.list()).length;
  await assert.rejects(() => runtime.lifecycle.openMemberRun(request), /UNIQUE|run_id/);
  assert.equal((await runtime.worktreeManager.list()).length, before);
});

/* `isLeaderTask` 只被**记录**，本层不因它分叉（brief 的机械半明文如此）。
   把这条钉住，免得后来者以为「带 true 进来就不会开树」——那是一个静默的行为差异：
   「队长 run 不建工作树」（spec §6.1/§6.2）由**调用方**决定要不要调本方法，不在这里猜。 */
test("openMemberRun 记录 isLeaderTask，但不因它改变动作", async () => {
  const { runtime } = await setup();
  const out = await runtime.lifecycle.openMemberRun({
    runId: "r-lead",
    workItemId: "wi-lead",
    parentWorkItemId: "wi-p",
    agentId: "ta-lead",
    isLeaderTask: true,
  });
  const row = runtime.squadRunRepo.get("r-lead")!;
  assert.equal(row.isLeaderTask, true);
  assert.equal(row.branch, out.branch);
  assert.equal(row.dirName, out.worktreePath.split("/").at(-1));
});

// 残枝（分支已存在、但没挂任何工作树）⇒ 响亮失败；台账行**已落**（先落台账的次序是有意的：
// 宁可在台账里留一条 open 行下次启动处理，也不要在树建好后才写台账——后者会丢未提交成果）。
test("openMemberRun 撞残枝 ⇒ 抛，且台账行已落（先落台账）", async () => {
  const { repoRoot, runtime } = await setup();
  const branch = `squad/member/${slugForId("wi-stale")}/${slugForId("ta-s")}`;
  const stray = await runtime.git(["branch", branch, "main"], { cwd: repoRoot });
  assert.equal(stray.code, 0, stray.stderr);
  await assert.rejects(
    () =>
      runtime.lifecycle.openMemberRun({
        runId: "r-stale",
        workItemId: "wi-stale",
        parentWorkItemId: "wi-p",
        agentId: "ta-s",
        isLeaderTask: false,
      }),
    /已被另一工作树占用|already exists/,
  );
  assert.equal(runtime.squadRunRepo.get("r-stale")?.status, "open");
});

test("openMemberRun 的 base 分支不存在 ⇒ 抛", async () => {
  const repoRoot = await makeRepo();
  const db = await makeMemoryDb();
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: "ws",
    baseBranch: "no-such-base",
    readExperimentEnabled: () => true,
  });
  await assert.rejects(
    () =>
      runtime.lifecycle.openMemberRun({
        runId: "r-badbase",
        workItemId: "wi-b",
        parentWorkItemId: "wi-p",
        agentId: "ta-b",
        isLeaderTask: false,
      }),
    /no-such-base|invalid reference|not a valid object name/,
  );
});

// 硬约束 2：`open`（在跑）/`produced`（已产出未合并）/`rejected`（被打回待修）**都算活跃**。
// 少了 `rejected`，被打回待修的队员工作树会在下次启动被静默回收（spec §16 S5 失效）。
test("computeActiveBranches 覆盖 open / produced / rejected，且不含已合并", async () => {
  const { runtime } = await setup();
  const a = await runtime.lifecycle.openMemberRun({
    runId: "r-a",
    workItemId: "wi-a",
    parentWorkItemId: "wi-p",
    agentId: "ta-a",
    isLeaderTask: false,
  });
  await runtime.lifecycle.openMemberRun({
    runId: "r-b",
    workItemId: "wi-b",
    parentWorkItemId: "wi-p",
    agentId: "ta-b",
    isLeaderTask: false,
  });
  await runtime.lifecycle.openMemberRun({
    runId: "r-c",
    workItemId: "wi-c",
    parentWorkItemId: "wi-p",
    agentId: "ta-c",
    isLeaderTask: false,
  });
  await runtime.lifecycle.completeMemberRun({ runId: "r-b" }); // → produced
  await runtime.lifecycle.reviewMemberRun({ runId: "r-c", verdict: "rejected" }); // → rejected
  runtime.squadRunRepo.setStatus("r-a", "merged");
  const active = (await runtime.lifecycle.computeActiveBranches("ws")).sort();
  assert.deepEqual(
    active,
    [runtime.squadRunRepo.get("r-b")!.branch, runtime.squadRunRepo.get("r-c")!.branch].sort(),
  );
  assert.equal(active.includes(a.branch), false);
});

// 台账是**持久**的：换一个 runtime 实例（模拟重启）仍能算出同一批活跃分支。
test("重启后 computeActiveBranches 仍然正确（台账持久）", async () => {
  const repoRoot = await makeRepo();
  const db = await makeMemoryDb();
  const mk = () =>
    createSquadRuntime({
      db,
      workspacePath: repoRoot,
      workspaceIdentity: "ws",
      readExperimentEnabled: () => true,
    });
  const first = await mk();
  await first.lifecycle.openMemberRun({
    runId: "r-p",
    workItemId: "wi-p2",
    parentWorkItemId: "wi-p",
    agentId: "ta-p",
    isLeaderTask: false,
  });
  const restart = await mk();
  assert.equal((await restart.lifecycle.computeActiveBranches("ws")).length, 1);
});

// 启动回收**必须**用同一个口径来源：造一个不在活跃集合里的孤儿树 + 一个待修树，
// 回收后只有孤儿被收。
test("reapStartupOrphans 只收活跃集合外的树", async () => {
  const { runtime } = await setup();
  const kept = await runtime.lifecycle.openMemberRun({
    runId: "r-keep",
    workItemId: "wi-k",
    parentWorkItemId: "wi-p",
    agentId: "ta-k",
    isLeaderTask: false,
  });
  await runtime.lifecycle.openMemberRun({
    runId: "r-drop",
    workItemId: "wi-d",
    parentWorkItemId: "wi-p",
    agentId: "ta-d",
    isLeaderTask: false,
  });
  const dropDir = runtime.squadRunRepo.get("r-drop")!.dirName!;
  runtime.squadRunRepo.setStatus("r-drop", "merged"); // 已合并 ⇒ 不再活跃
  const out = await runtime.lifecycle.reapStartupOrphans({ workspaceKey: "ws" });
  assert.ok(out.reclaimed.includes(dropDir));
  assert.ok(out.kept.includes(kept.worktreePath.split("/").at(-1)!));
});

// 补集方向：活跃集合**为空**时要真把孤儿全收掉（这条最容易被「没东西就早退」的实现混过去）。
test("reapStartupOrphans：活跃集合为空时收掉全部队员树", async () => {
  const { runtime } = await setup();
  const one = await runtime.lifecycle.openMemberRun({
    runId: "r-x",
    workItemId: "wi-x",
    parentWorkItemId: "wi-p",
    agentId: "ta-x",
    isLeaderTask: false,
  });
  // 台账推到终态（merged）⇒ 活跃集合为空；此时那棵树是孤儿，必须被收掉。
  runtime.squadRunRepo.setStatus("r-x", "merged");
  const out = await runtime.lifecycle.reapStartupOrphans({ workspaceKey: "ws" });
  assert.ok(out.reclaimed.includes(one.worktreePath.split("/").at(-1)!));
  assert.deepEqual(await runtime.lifecycle.computeActiveBranches("ws"), []);
});

// completeMemberRun：产出即推进到 produced，并把工作项推到 in_review（**唯一写者仍是工作项服务**）。
test("completeMemberRun ⇒ run 置 produced 且工作项置 in_review", async () => {
  const { repoRoot, runtime } = await setup();
  const item = runtime.workItemService.create({
    workspaceIdentity: "ws",
    workspacePath: repoRoot,
    title: "t",
    assignee: { type: "agent", id: "ta-a" },
  });
  assert.equal(runtime.workItemService.transition(item.id, "in_progress", "todo"), true);
  await runtime.lifecycle.openMemberRun({
    runId: "r-prod",
    workItemId: item.id,
    parentWorkItemId: "wi-p",
    agentId: "ta-a",
    isLeaderTask: false,
  });
  await runtime.lifecycle.completeMemberRun({ runId: "r-prod" });
  assert.equal(runtime.squadRunRepo.get("r-prod")?.status, "produced");
  assert.equal(runtime.workItemRepo.get(item.id)?.status, "in_review");
});

// CAS 未命中**不抛**：产物已经产出，工作项状态推进是附带动作（spec §5.7 第 5 项：
// 不匹配则丢弃并记事件，不报错）。若在这里抛，队员的成果会因为父项状态被别人改过而丢失。
test("completeMemberRun：工作项 CAS 未命中不抛（runs 仍推进）", async () => {
  const { repoRoot, runtime } = await setup();
  const item = runtime.workItemService.create({
    workspaceIdentity: "ws",
    workspacePath: repoRoot,
    title: "t",
    assignee: { type: "agent", id: "ta-a" },
  }); // 停在 todo ⇒ transition(in_review, expect in_progress) 必然未命中
  await runtime.lifecycle.openMemberRun({
    runId: "r-cas",
    workItemId: item.id,
    parentWorkItemId: "wi-p",
    agentId: "ta-a",
    isLeaderTask: false,
  });
  await runtime.lifecycle.completeMemberRun({ runId: "r-cas" });
  assert.equal(runtime.squadRunRepo.get("r-cas")?.status, "produced");
  assert.equal(runtime.workItemRepo.get(item.id)?.status, "todo");
});

test("completeMemberRun 未知 runId ⇒ 抛（台账没有删除路径，行缺失只可能是 runId 算错）", async () => {
  const { runtime } = await setup();
  await assert.rejects(() => runtime.lifecycle.completeMemberRun({ runId: "nope" }), /nope/);
});

// 审查通过：合到集成分支（整批再合回主分支是批次层的事），run 置 merged。
test("reviewMemberRun approved ⇒ 合入集成分支并置 merged", async () => {
  const { repoRoot, runtime } = await setup();
  const opened = await runtime.lifecycle.openMemberRun({
    runId: "r-ok",
    workItemId: "wi-ok",
    parentWorkItemId: "wi-p",
    agentId: "ta-ok",
    isLeaderTask: false,
  });
  await runtime.lifecycle.completeMemberRun({ runId: "r-ok" });
  const outcome = await runtime.lifecycle.reviewMemberRun({ runId: "r-ok", verdict: "approved" });
  assert.deepEqual(outcome, { ok: true, merged: true });
  assert.equal(runtime.squadRunRepo.get("r-ok")?.status, "merged");
  // 集成分支确实存在（否则「合到集成分支」只是一句结论）。
  const integration = `squad/integration/${slugForId("wi-ok")}`;
  const exists = await runtime.git(["rev-parse", "-q", "--verify", `refs/heads/${integration}`], {
    cwd: repoRoot,
  });
  assert.equal(exists.code, 0, exists.stderr);
  // 队员工作树不在这里删：抛弃由批次层在收尾时做（spec §6.2「合并后才抛弃」）。
  assert.ok((await runtime.worktreeManager.list()).some((e) => e.path === opened.worktreePath));
});

// 审查打回：**工作树一个字节不动**（spec §6.2 / §16 S5），返回 kept，
// 且活跃集合里仍然有它（否则下次启动回收会把它静默收掉）。
test("reviewMemberRun rejected ⇒ run 置 rejected、工作树不动、仍在活跃集合", async () => {
  const { runtime } = await setup();
  const opened = await runtime.lifecycle.openMemberRun({
    runId: "r-rej",
    workItemId: "wi-rej",
    parentWorkItemId: "wi-p",
    agentId: "ta-rej",
    isLeaderTask: false,
  });
  await runtime.lifecycle.completeMemberRun({ runId: "r-rej" });
  const outcome = await runtime.lifecycle.reviewMemberRun({ runId: "r-rej", verdict: "rejected" });
  assert.deepEqual(outcome, { ok: true, merged: false, kept: true });
  assert.equal(runtime.squadRunRepo.get("r-rej")?.status, "rejected");
  assert.ok((await runtime.worktreeManager.list()).some((e) => e.path === opened.worktreePath));
  assert.ok((await runtime.lifecycle.computeActiveBranches("ws")).includes(opened.branch));
});

test("reviewMemberRun 未知 runId ⇒ 抛", async () => {
  const { runtime } = await setup();
  await assert.rejects(
    () => runtime.lifecycle.reviewMemberRun({ runId: "ghost", verdict: "approved" }),
    /ghost/,
  );
});

// `branch_missing`：队员分支在审查前消失（被外部清理、残枝丢失）⇒ 必须给出**可区分**的 reason，
// 而不是被归成 conflict（上层据此决定「重开一棵」还是「当冲突处理」，混在一起就分不出来）。
// 删掉队员分支后即在本层的 ReviewOutcome 里可达，不需要 Wave 1 的编排。
test("reviewMemberRun approved：队员分支不存在 ⇒ reason=branch_missing", async () => {
  const { repoRoot, runtime } = await setup();
  const opened = await runtime.lifecycle.openMemberRun({
    runId: "r-gone",
    workItemId: "wi-gone",
    parentWorkItemId: "wi-p",
    agentId: "ta-g",
    isLeaderTask: false,
  });
  await runtime.lifecycle.completeMemberRun({ runId: "r-gone" });
  // 先摘工作树、后删分支（顺序契约见 deleteBranch 注释：还挂着工作树的分支 git 不让删）。
  await runtime.worktreeManager.remove(opened.worktreePath.split("/").at(-1)!);
  const deleted = await runtime.git(["branch", "-D", opened.branch], { cwd: repoRoot });
  assert.equal(deleted.code, 0, deleted.stderr);

  const outcome = await runtime.lifecycle.reviewMemberRun({ runId: "r-gone", verdict: "approved" });
  assert.ok(outcome.ok === false, "队员分支不存在必须 ok:false（不能报成功）");
  assert.equal(outcome.reason, "branch_missing");
  assert.ok(outcome.detail.includes(opened.branch), `detail 应点名缺失的分支：${outcome.detail}`);
  // 分支不存在时**不准**把台账推进成 merged（否则收尾层会以为这批已经落地）。
  assert.equal(runtime.squadRunRepo.get("r-gone")?.status, "produced");
});

/* approved 的**真冲突**分支：两名队员各自从 base 开分支、各改**同一文件的同一行**，
   串行 approve 进**同一个集成分支**（集成分支按 workItemSlug 派生 ⇒ 同一 workItemId 即同一条）。

   为什么必须用真 git 构造而不是打桩：冲突的判据是 git 自己给的（`merge` 的退出码 + MERGE_HEAD），
   打桩只会验证「我们以为自己会怎么处理」。三条不变量：
   ① `mergeMember` 返回 `{ ok:false, reason:"conflict" }`（`reviewMemberRun` 原样透出）；
   ② 台账**保持 `produced`**（不得因冲突被推进）；
   ③ **不写工作项 `status`**（`blocked` + Inbox 属 Wave 2 的批次层，本层不许写）。 */
test("reviewMemberRun approved 真冲突 ⇒ conflict，台账仍 produced，且不写工作项状态", async () => {
  const { repoRoot, runtime } = await setup();
  // 同一个工作项 ⇒ 同一个集成分支（planBranches 的 integration 只由 workItemSlug 派生）。
  const item = runtime.workItemService.create({
    workspaceIdentity: "ws",
    workspacePath: repoRoot,
    title: "conflict",
    assignee: { type: "agent", id: "ta-a" },
  });
  assert.equal(runtime.workItemService.transition(item.id, "in_progress", "todo"), true);

  const memberA = await runtime.lifecycle.openMemberRun({
    runId: "r-cf-a",
    workItemId: item.id,
    parentWorkItemId: "wi-p",
    agentId: "ta-a",
    isLeaderTask: false,
  });
  const memberB = await runtime.lifecycle.openMemberRun({
    runId: "r-cf-b",
    workItemId: item.id,
    parentWorkItemId: "wi-p",
    agentId: "ta-b",
    isLeaderTask: false,
  });

  // 两人改**同一文件的同一行**，各自提交到自己的队员分支。
  writeFileSync(join(memberA.worktreePath, "shared.txt"), "A\n");
  writeFileSync(join(memberB.worktreePath, "shared.txt"), "B\n");
  for (const [worktree, message] of [
    [memberA.worktreePath, "A"],
    [memberB.worktreePath, "B"],
  ] as const) {
    const added = await runtime.git(["add", "shared.txt"], { cwd: worktree });
    assert.equal(added.code, 0, added.stderr);
    const committed = await runtime.git(["commit", "-m", message], { cwd: worktree });
    assert.equal(committed.code, 0, committed.stderr);
  }

  // **串行**：A 先并入（集成分支在此刻从 base 派生），B 随后必然冲突。
  await runtime.lifecycle.completeMemberRun({ runId: "r-cf-a" });
  assert.deepEqual(
    await runtime.lifecycle.reviewMemberRun({ runId: "r-cf-a", verdict: "approved" }),
    {
      ok: true,
      merged: true,
    },
  );
  await runtime.lifecycle.completeMemberRun({ runId: "r-cf-b" });
  const conflict = await runtime.lifecycle.reviewMemberRun({
    runId: "r-cf-b",
    verdict: "approved",
  });

  // ① 结局是**真冲突**（reason 恰为 conflict，而不是别的失败被归成冲突），并带 git 原文供归因。
  assert.ok(conflict.ok === false, "approved 的冲突必须走 ok:false 分支");
  assert.equal(conflict.reason, "conflict");
  assert.ok(conflict.detail.length > 0, "冲突必须带 git 原文（否则上层无从归因）");
  // 在 merger 层再证一次：同一位置、同一判定来源（`mergeMember` 直接给出 conflict）。
  const direct = await runtime.integrationMerger.mergeMember({
    integration: `squad/integration/${slugForId(item.id)}`,
    member: memberB.branch,
  });
  assert.ok(direct.ok === false);
  assert.equal(direct.reason, "conflict");

  // ② 台账保持 produced（冲突既不推进、也不回退状态）。
  assert.equal(runtime.squadRunRepo.get("r-cf-b")?.status, "produced");
  // ③ 不写工作项 status（仍是 in_review，没有被写成 blocked）。
  assert.equal(runtime.workItemRepo.get(item.id)?.status, "in_review");
});

// 工作项事件的**唯一出口**（`subscribeWorkItemEvents`）：订阅 → transition ⇒ 收到 status_changed；
// 取消后不再收到。这条出口此前只有「一个 Set + delete」三行保证，没有任何直接用例
// （Wave 1 A 才是第一个真实订阅者），于是「转发断了一根线」不会有任何信号。
test("subscribeWorkItemEvents：多订阅者都收到，取消者不再收到，dispose 清空", async () => {
  const { repoRoot, runtime } = await setup();
  const item = runtime.workItemService.create({
    workspaceIdentity: "ws",
    workspacePath: repoRoot,
    title: "t",
    assignee: { type: "agent", id: "ta-a" },
  });
  const first: WorkItemEvent[] = [];
  const second: WorkItemEvent[] = [];
  const offFirst = runtime.subscribeWorkItemEvents((event) => first.push(event));
  const offSecond = runtime.subscribeWorkItemEvents((event) => second.push(event));

  assert.equal(runtime.workItemService.transition(item.id, "in_progress", "todo"), true);
  assert.deepEqual(first, [
    { kind: "workitem.status_changed", id: item.id, from: "todo", to: "in_progress" },
  ]);
  assert.deepEqual(second, first, "两个订阅者都应收到同一个事件");

  offSecond();
  assert.equal(runtime.workItemService.transition(item.id, "in_review", "in_progress"), true);
  assert.equal(first.length, 2);
  assert.equal(second.length, 1, "取消订阅后不得再收到事件");

  offFirst();
  assert.equal(runtime.workItemService.transition(item.id, "done", "in_review"), true);
  assert.equal(first.length, 2, "两个订阅都取消后无人再收到");

  // dispose 清空本域自持的订阅表（它不关 db —— 连接归组合根）。
  const afterDispose: WorkItemEvent[] = [];
  runtime.subscribeWorkItemEvents((event) => afterDispose.push(event));
  runtime.dispose();
  assert.equal(runtime.workItemService.transition(item.id, "closed", "done"), true);
  assert.equal(afterDispose.length, 0, "dispose 之后订阅表应为空");
});

// 抛弃：摘树 + 删分支 + 置 discarded，且不再算活跃（否则下次启动会对着一条已抛弃的分支空转）。
test("discardMemberRun ⇒ 摘树删分支并置 discarded", async () => {
  const { runtime } = await setup();
  const opened = await runtime.lifecycle.openMemberRun({
    runId: "r-throw",
    workItemId: "wi-throw",
    parentWorkItemId: "wi-p",
    agentId: "ta-throw",
    isLeaderTask: false,
  });
  await runtime.lifecycle.discardMemberRun({ runId: "r-throw" });
  assert.equal(runtime.squadRunRepo.get("r-throw")?.status, "discarded");
  assert.equal(
    (await runtime.worktreeManager.list()).some((e) => e.path === opened.worktreePath),
    false,
  );
  assert.deepEqual(await runtime.lifecycle.computeActiveBranches("ws"), []);
});

// 三段简报的渲染：host 派发桥把 briefing 变成 prompt，三段都必须到场且各带标题。
test("渲染出的队长 prompt 含三段标题", () => {
  const prompt = renderLeaderBriefingPrompt({
    squadId: "sq_1",
    leaderAgentId: "ta_lead",
    roster: [{ agentId: "ta_lead", role: "leader" }, { agentId: "ta_a" }],
    protocol: "PROTOCOL-BODY",
    instructions: { stopCondition: "s", maxRounds: "1" },
  });
  assert.ok(prompt.includes("## 花名册"));
  assert.ok(prompt.includes("## 操作协议"));
  assert.ok(prompt.includes("PROTOCOL-BODY"));
  assert.ok(prompt.includes("## 队长指令"));
  assert.ok(prompt.includes("stopCondition"));
  // 三段标题的**次序**固定：先是谁、再是机制、最后是用户意图（读的人按这个次序建立模型）。
  assert.ok(prompt.indexOf("## 花名册") < prompt.indexOf("## 操作协议"));
  assert.ok(prompt.indexOf("## 操作协议") < prompt.indexOf("## 队长指令"));
  // 花名册逐人列出（少一个人不会报错，只会让队长对着不完整的名册派单）。
  assert.ok(prompt.includes("ta_lead"));
  assert.ok(prompt.includes("ta_a"));
});

// ---------- 3. workspace 目标绑定（裁定 4 / 确认 3） ----------

// 确认 3：runtime 为**目标**而构造，内部遇到异己 workspaceKey ⇒ 响亮抛错。
// 静默按传入值操作 = 在另一个 workspace 上读写（用户看到的是「我明明没建过」）。
test("runtime 拒绝异己 workspaceKey（带两侧的值）", async () => {
  const { runtime } = await setup(); // setup 绑定的是 "ws"
  // 断言**两侧的值**都被点到名。只 match `/ws/` 是弱断言：收到的 `another-ws` 里也含 "ws"，
  // 于是「错误里只说了收到什么、没说绑定什么」也能通过，等于没验证「带两侧的值」。
  const error = await runtime.lifecycle.computeActiveBranches("another-ws").then(
    () => null,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof Error, "异己 workspaceKey 必须响亮抛错");
  assert.match(error.message, /本方绑定「ws」/);
  assert.match(error.message, /收到「another-ws」/);
  await assert.rejects(
    () => runtime.lifecycle.reapStartupOrphans({ workspaceKey: "another-ws" }),
    /收到「another-ws」/,
  );
});

// 补集方向：**自己的** workspaceKey 必须放行（闸不能收得把正常调用也拒了）。
test("runtime 接受自己的 workspaceKey", async () => {
  const { runtime } = await setup();
  assert.deepEqual(await runtime.lifecycle.computeActiveBranches("ws"), []);
});

// ---------- 4. 门禁单点（确认 2 / spec §5.7.6） ----------

test("开关关闭 ⇒ assertDispatchEnabled 抛 SquadDispatchDisabledError", async () => {
  const { runtime } = await disabledSetup();
  const error = await runtime.assertDispatchEnabled().catch((e: unknown) => e);
  assert.ok(error instanceof SquadDispatchDisabledError);
  assert.equal((error as SquadDispatchDisabledError).code, "squad_dispatch_disabled");
});

test("开关打开 ⇒ assertDispatchEnabled 放行（补集方向）", async () => {
  const { runtime } = await setup();
  await runtime.assertDispatchEnabled();
});

/* 门禁判定**不依赖 git 解析**（复审 Minor 14 的裁定）：门禁回答的是「现在允不允许新派发」，
   与目标 workspace 是不是一个可用的 git 仓库无关。先前实现是「先建 runtime 再问它」，
   而 runtime 构造期要跑 `git symbolic-ref`（失败即抛）⇒ 在**非 git 目标**上关闭开关时，
   调用方拿到的是「base 分支解析失败」而不是门禁结论，上层按错误码分流就分不出来
   （界面会把「实验关了」显示成「workspace 坏了」）。

   补集方向一起写上（免得把「门禁前置」误读成「非 git 目标也能派发」）：开关**打开**且目标不是 git 仓库时
   仍然抛 base 分支错误 —— 真正去建工作项/开工作树本来就需要一个可用的 workspace。 */
test("非 git 目标 + 开关关闭 ⇒ 得到门禁错误（而非 base 分支错误）", async () => {
  const plain = mkdtempSync(join(tmpdir(), "not-a-repo-"));
  const db = await makeMemoryDb();
  const noRepo: SquadWorkspaceTarget = { path: plain, identity: "plain" };
  // 工厂**真的去建 runtime**（会跑 git 解析）：若门禁在构造之后判，关闭场景会先抛 base 分支错误。
  const makeService = (enabled: boolean) =>
    createSquadRuntimeService({
      createRuntime: (t) =>
        createSquadRuntime({
          db,
          workspacePath: t.path,
          workspaceIdentity: t.identity,
          readExperimentEnabled: () => enabled,
        }),
      readExperimentEnabled: async () => enabled,
      archiveSquadAndTransfer: async () => {},
    });

  const off = makeService(false);
  const error = await off.assertDispatchEnabled(noRepo).then(
    () => null,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof SquadDispatchDisabledError, `应给门禁错误，实际：${String(error)}`);
  assert.equal(error.code, "squad_dispatch_disabled");
  // 补集方向①：开关**打开**时，门禁在非 git 目标上**放行**（它压根不碰 git）——
  // 这一格与下面那格合起来才说明「门禁前置」不是「把非 git 目标也放过去派发」。
  await makeService(true).assertDispatchEnabled(noRepo);
  // 补集方向②：真正需要 workspace 的操作（建工作项）在开关打开时仍抛 base 分支错误 ——
  // 说明「base 分支错误」并没有消失，它只是**不再冒充门禁结论**。
  await assert.rejects(
    () =>
      makeService(true).createWorkItem(noRepo, {
        title: "t",
        assignee: { type: "agent", id: "ta-a" },
      }),
    /base 分支/,
  );
  // 两个入口在开关关闭时**在构造 runtime 之前**过闸（同一判据）⇒ 非 git 目标上拿到门禁错误。
  await assert.rejects(
    () => off.createWorkItem(noRepo, { title: "t", assignee: { type: "agent", id: "ta-a" } }),
    (caught: unknown) => caught instanceof SquadDispatchDisabledError,
  );
  await assert.rejects(
    () =>
      off.openMemberRun(noRepo, {
        runId: "r-x",
        workItemId: "wi-x",
        parentWorkItemId: "wi-p",
        agentId: "ta-a",
        isLeaderTask: false,
      }),
    (caught: unknown) => caught instanceof SquadDispatchDisabledError,
  );
});

// 确认 2：**三个入口共用同一判据**。至少覆盖「界面触发」与「规则 tick」两条：
// ① 规则 tick 走 assertDispatchEnabled；② 界面触发走 createWorkItem（指派即入队）；
// ③ 队长的派单工具与 ① 的队员段都汇到 openMemberRun。
test("开关关闭 ⇒ 界面触发（createWorkItem）与规则 tick 都被拦", async () => {
  const { runtime, svc, setEnabled } = await controllableSetup();
  setEnabled(false);
  await assert.rejects(() => svc.assertDispatchEnabled(target("ws")), /squad_dispatch_disabled/);
  await assert.rejects(
    () => svc.createWorkItem(target("ws"), { title: "t", assignee: { type: "agent", id: "ta-a" } }),
    /squad_dispatch_disabled/,
  );
  await assert.rejects(
    () =>
      svc.openMemberRun(target("ws"), {
        runId: "r-blocked",
        workItemId: "wi-blocked",
        parentWorkItemId: "wi-p",
        agentId: "ta-a",
        isLeaderTask: false,
      }),
    /squad_dispatch_disabled/,
  );
  // 被拦下时**不得**留下任何派发痕迹（拦在入口，不是拦在半路）。
  assert.equal(runtime.squadRunRepo.get("r-blocked"), null);
  assert.equal(runtime.workItemRepo.listByWorkspace("ws").length, 0);
});

// 补集方向：开关打开时这两条入口都要真走通（否则「拦住了」可能是因为压根没实现）。
test("开关打开 ⇒ createWorkItem / openMemberRun 走通，且落在 runtime 绑定的 workspace", async () => {
  const { runtime, svc } = await controllableSetup();
  const item = await svc.createWorkItem(target("ws"), {
    title: "t",
    assignee: { type: "agent", id: "ta-a" },
  });
  // 写入用的 workspace 列取自 runtime.boundWorkspace（runtime 才是「为哪个 workspace 而构造」的权威）。
  assert.equal(item.workspaceIdentity, "ws");
  assert.equal(item.workspacePath, runtime.boundWorkspace.path);
  const opened = await svc.openMemberRun(target("ws"), {
    runId: "r-open",
    workItemId: item.id,
    parentWorkItemId: "wi-p",
    agentId: "ta-a",
    isLeaderTask: false,
  });
  assert.equal(runtime.squadRunRepo.get("r-open")?.status, "open");
  assert.ok(opened.branch.startsWith("squad/member/"));
});

// 确认 2：**在途 run 不中断** —— 这是 spec §5.7.6 与 §16 S14 明文要求的那一半。
// 关掉开关后：已有的 open run 台账与工作树**一个字节不动**，且不发出任何取消。
test("开关关闭 ⇒ 在途 run 不被中断", async () => {
  const { runtime, svc, setEnabled } = await controllableSetup();
  const opened = await runtime.lifecycle.openMemberRun({
    runId: "r-live",
    workItemId: "wi-l",
    parentWorkItemId: "wi-p",
    agentId: "ta-l",
    isLeaderTask: false,
  });
  const before = runtime.squadRunRepo.get("r-live")!;
  setEnabled(false);
  await assert.rejects(() => svc.assertDispatchEnabled(target("ws")), /squad_dispatch_disabled/);
  assert.equal(runtime.squadRunRepo.get("r-live")!.status, "open"); // 台账不变
  assert.equal(runtime.squadRunRepo.get("r-live")!.branch, opened.branch); // 分支字段不变
  assert.ok((await runtime.worktreeManager.list()).some((e) => e.path === opened.worktreePath)); // 树还在
  // 门禁只读设置、只抛错：连 updatedAt 都不该动（动了就说明某处写了一次 run 行）。
  assert.equal(runtime.squadRunRepo.get("r-live")!.updatedAt, before.updatedAt);
});

// 收尾在途 run 不属「新派发」⇒ **不过门禁**（spec §5.7.6 只停新派发；若这里也拦，
// 关掉开关会把正在跑的那批 run 卡死在中间状态）。同理：审查、回收也不拦。
test("开关关闭 ⇒ complete / review / reap 不受门禁影响", async () => {
  const { runtime, svc, setEnabled } = await controllableSetup();
  const opened = await svc.openMemberRun(target("ws"), {
    runId: "r-tail",
    workItemId: "wi-tail",
    parentWorkItemId: "wi-p",
    agentId: "ta-tail",
    isLeaderTask: false,
  });
  setEnabled(false);
  await svc.completeMemberRun(target("ws"), { runId: "r-tail" });
  assert.equal(runtime.squadRunRepo.get("r-tail")?.status, "produced");
  assert.deepEqual(
    await svc.reviewMemberRun(target("ws"), { runId: "r-tail", verdict: "rejected" }),
    {
      ok: true,
      merged: false,
      kept: true,
    },
  );
  const reaped = await svc.reapStartupOrphans(target("ws"));
  assert.ok(reaped.kept.includes(opened.worktreePath.split("/").at(-1)!));
});

// 快照：`enabled` 只供 UI **呈现**（隐藏/禁用入口），它不是门禁；门禁是 assertDispatchEnabled。
test("getSnapshot 给出呈现用的 enabled 与绑定的 workspace 数据", async () => {
  const { runtime, svc } = await controllableSetup();
  runtime.workItemService.create({
    workspaceIdentity: "ws",
    workspacePath: runtime.boundWorkspace.path,
    title: "t",
    assignee: { type: "agent", id: "ta-a" },
  });
  const snapshot = await svc.getSnapshot(target("ws"));
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.workItems.length, 1);
  assert.equal(snapshot.runs.length, 0);
  assert.deepEqual(snapshot.squads, []);
  assert.deepEqual(snapshot.teamAgents, []);
});

// 服务层的每个方法都必须显式带目标（裁定 4：没有环境绑定、没有隐式默认 ⇒ 结构上不存在「取首个」）。
// 这里用「目标与 runtime 不匹配时会被 runtime 自己挡住」来钉这条：
// createRuntime 收到的是**调用方传的** target，而不是某个全局默认值。
test("每个方法都带着调用方的 target 进 createRuntime（无隐式默认）", async () => {
  const repoRoot = await makeRepo();
  const db = await makeMemoryDb();
  const seen: string[] = [];
  // 这一个工厂是**所有**方法（含 archiveSquadAndTransfer）的 runtime 来路。
  // 先前这里把这条闭包写成 `archiveSquadAndTransfer(runtime, id)`，而 `runtime` 不在作用域内：
  // 闭包从不被调用 ⇒ 测试全绿，一旦真走到就是 `ReferenceError`。修法不是删掉它（那会让
  // 「每个方法都带 target」这条断言漏掉归档这一格），而是让它**真的被走到**（见下面的 assert.rejects）。
  const runtimeFor = async (t: { path: string; identity: string }) => {
    seen.push(`${t.path}|${t.identity}`);
    return createSquadRuntime({
      db,
      workspacePath: repoRoot,
      workspaceIdentity: t.identity,
      readExperimentEnabled: () => true,
    });
  };
  const svc = createSquadRuntimeService({
    createRuntime: runtimeFor,
    readExperimentEnabled: async () => true,
    archiveSquadAndTransfer: async (t, id) => archiveSquadAndTransfer(await runtimeFor(t), id),
  });
  // 两格需要 runtime 的方法：各自带着**调用方传的** target 进工厂（不是某个全局默认值）。
  await svc.getSnapshot(target("alpha"));
  await svc.getSnapshot(target("beta"));
  assert.deepEqual(seen, ["/tmp/alpha|alpha", "/tmp/beta|beta"]);
  // `assertDispatchEnabled` 是**有意**不建 runtime 的那一格（门禁不依赖 git 解析，见「非 git 目标…」用例），
  // 所以它不出现在 `seen` 里 —— 这条断言把那件事也钉住，免得有人「顺手」把它改回去。
  await svc.assertDispatchEnabled(target("zeta"));
  assert.deepEqual(seen, ["/tmp/alpha|alpha", "/tmp/beta|beta"]);
  // 归档一个**不存在**的小队：组合函数抛「小队不存在」，错误里带着刚传进去的 id。
  // 这条断言的作用不是测归档（另有专门文件），而是把那格闭包**跑到**：
  // 它证明 runtime 是按调用方的 target 现构的（`seen` 随之增长，且用到了 t.identity）。
  await assert.rejects(
    () => svc.archiveSquadAndTransfer(target("gamma"), "sq-missing"),
    /sq-missing/,
  );
  assert.deepEqual(seen, ["/tmp/alpha|alpha", "/tmp/beta|beta", "/tmp/gamma|gamma"]);
});

/* ---------- 5. 队长 run 的台账写入口（spec §5.7(1)：可查到、可判「进行中」；**只登记不执行**） ----------

   缺口背景：此前服务面没有队长 run 的写入口，而 `openMemberRun` 传 `isLeaderTask: true`
   **照样开树**（那是给队员用的）⇒ 队长 run 完全不进台账。后果是 §5.7(1)「队长 run **进行中**时
   重复指派合并为同一次」**没有判据**（无记录 ⇒ 无从判「进行中」），且 `getSnapshot().runs`
   永远看不见队长 run。下面四条把「登记了什么 / 不影响什么 / 怎么判进行中 / 重复怎么办」逐格钉住。 */

// ① 只登记一行：无工作树、branch/dirName 为 null、isLeaderTask=true、status=open、sessionId=null；
//    且**不改工作项状态**（§5.7(2) 队长 run 不改父项状态）—— 这正是它与 openMemberRun 的区别
//    （后者会开树 + 派生分支 + 之后由 completeMemberRun 推工作项）。
test("recordLeaderRun 只登记一行：无工作树，且不动工作项状态", async () => {
  const { repoRoot, runtime } = await setup();
  const item = runtime.workItemService.create({
    workspaceIdentity: "ws",
    workspacePath: repoRoot,
    title: "队长 run 的目标项",
    assignee: { type: "user", id: "u1" },
  });
  const statusBefore = runtime.workItemRepo.get(item.id)!.status;
  const treesBefore = (await runtime.worktreeManager.list()).length;

  await runtime.lifecycle.recordLeaderRun({
    runId: "r-lead-1",
    workItemId: item.id,
    agentId: "ta-lead",
  });

  const row = runtime.squadRunRepo.get("r-lead-1")!;
  assert.equal(row.isLeaderTask, true); // 与队员行可区分的**身份**判据
  assert.equal(row.branch, null); // 无工作树 ⇒ 无分支
  assert.equal(row.dirName, null);
  assert.equal(row.status, "open");
  assert.equal(row.sessionId, null);
  assert.equal(row.agentId, "ta-lead");
  assert.equal(row.workItemId, item.id);
  assert.equal(row.parentWorkItemId, item.id); // 缺省取自身（与队员「无父项」同口径）
  assert.equal(row.workspaceKey, "ws");
  assert.equal(row.workspacePath, repoRoot);
  // 只登记不执行：一棵树都没开；工作项状态一个字节不动。
  assert.equal((await runtime.worktreeManager.list()).length, treesBefore, "队长 run 不得开工作树");
  assert.equal(runtime.workItemRepo.get(item.id)!.status, statusBefore, "队长 run 不改工作项状态");
});

// ② 区分 + 零污染：队长行对 activeBranches **零贡献**，回收器视它如无物（行为与「没有队长行」一致）；
//    同父项的队员行不受任何影响（回归）。
test("队长行对 activeBranches 零贡献；回收器视它如无物；队员行不受影响", async () => {
  const { runtime } = await setup();
  const member = await runtime.lifecycle.openMemberRun({
    runId: "r-mem",
    workItemId: "wi-mem",
    parentWorkItemId: "wi-parent",
    agentId: "ta-mem",
    isLeaderTask: false,
  });
  await runtime.lifecycle.recordLeaderRun({
    runId: "r-lead-2",
    workItemId: "wi-lead",
    parentWorkItemId: "wi-parent", // 与队员行同一个父项
    agentId: "ta-lead",
  });

  // 队员行不受影响（回归）：它的 branch 照旧、仍在活跃集合里。
  assert.deepEqual(await runtime.lifecycle.computeActiveBranches("ws"), [member.branch]);
  // 同父项两行都在台账里，但只有队员行有分支 —— 这正是 orchestrator `memberRuns` 的判据：
  // 本层要的是「有没有可操作的分支」这件事实，不是「谁发起的」这个身份。
  const siblings = runtime.squadRunRepo.listByParent("wi-parent");
  assert.equal(siblings.length, 2);
  assert.deepEqual(
    siblings.filter((record) => record.branch !== null).map((record) => record.runId),
    ["r-mem"],
  );
  // 回收：队员树被保住（在活跃集合里），队长行不产生任何待回收物 ⇒ 结果与「只有队员行」一致。
  const reaped = await runtime.lifecycle.reapStartupOrphans({ workspaceKey: "ws" });
  assert.ok(reaped.kept.includes(member.worktreePath.split("/").at(-1)!));
  assert.deepEqual(await runtime.lifecycle.computeActiveBranches("ws"), [member.branch]);
});

// ③ 可见 + 「进行中」读法：队长行进 `listActive` ⇒ `getSnapshot().runs` 里看得见；
//    读法 = 在 `runs` 里按 `workItemId` + `isLeaderTask` 过滤（`listActive` 已排除终态）。
//    终态（这里用失败出口把它置 discarded）⇒ 判定随之变假：判据是**活的**，不是恒真。
test("getSnapshot().runs 可见队长行；按 workItemId+isLeaderTask 即「进行中」读法", async () => {
  const { runtime, svc } = await controllableSetup();
  const item = runtime.workItemService.create({
    workspaceIdentity: "ws",
    workspacePath: runtime.boundWorkspace.path,
    title: "t",
    assignee: { type: "user", id: "u1" },
  });
  await svc.recordLeaderRun(target("ws"), {
    runId: "r-lead-3",
    workItemId: item.id,
    agentId: "ta-lead",
  });

  const snapshot = await svc.getSnapshot(target("ws"));
  assert.ok(
    snapshot.runs.some((record) => record.runId === "r-lead-3" && record.isLeaderTask),
    "getSnapshot().runs 必须看得见队长 run（此前只显示队员 run）",
  );
  // 读法的落点（spec §5.7(1)，给**重复指派合并**用）：该工作项有没有**未终态**的队长行。
  const inProgress = (runs: typeof snapshot.runs): boolean =>
    runs.some((record) => record.workItemId === item.id && record.isLeaderTask);
  assert.equal(inProgress(snapshot.runs), true, "登记后即「进行中」");

  // 终态（失败出口把该 run 移出活跃集）⇒ 同一读法必须变假。
  await svc.failMemberRun(target("ws"), { runId: "r-lead-3", reason: "测试：模拟失败出口" });
  const after = await svc.getSnapshot(target("ws"));
  assert.equal(
    inProgress(after.runs),
    false,
    "离开活跃集后「进行中」必须为假（否则判据恒真、重复指派被永久合并）",
  );
});

// ④ 重复登记同 runId ⇒ **响亮抛**（与 openMemberRun 同口径，不静默复用旧行）：
//    静默复用会让两次 run 的成果落进同一个身份里。
test("recordLeaderRun 同 runId 重复 ⇒ 抛", async () => {
  const { runtime } = await setup();
  const request = { runId: "r-lead-dup", workItemId: "wi-ld", agentId: "ta-lead" };
  await runtime.lifecycle.recordLeaderRun(request);
  await assert.rejects(() => runtime.lifecycle.recordLeaderRun(request), /UNIQUE|run_id/);
  assert.equal(runtime.squadRunRepo.listByWorkItem("wi-ld").length, 1);
});

/* ---------- 5.5. 存储层不变式：同一工作项**至多一条活跃队长行**（并发下的兜底） ----------

   判据的**读法**（`hasInProgressLeaderRun`）是给「决定」用的；但两条派发**并发**时，各自读到的快照
   都可能早于对方的写入 ⇒ 光靠读法挡不住「起两条队长 run」（两个会话干同一件事）。
   所以**写入口**必须原子地兜住这条不变式：登记语句自带「同一工作项没有活跃队长行」的前置
   （单条 `INSERT … WHERE NOT EXISTS …`，SQLite 下即原子），并把「本次被并入」如实告诉调用方 ——
   不是静默少一行（上层以为起了 run、台账里却没有，是最坏的形态）。 */

test("同一工作项已有活跃队长行 ⇒ 再登记并入（不产生第二行），并如实告诉调用方", async () => {
  const { runtime } = await setup();
  const first = await runtime.lifecycle.recordLeaderRun({
    runId: "r-l-one",
    workItemId: "wi-l-one",
    agentId: "ta-l",
  });
  assert.deepEqual(first, { recorded: true }, "第一条正常登记");

  const second = await runtime.lifecycle.recordLeaderRun({
    runId: "r-l-two",
    workItemId: "wi-l-one",
    agentId: "ta-l",
  });
  assert.deepEqual(
    second,
    { recorded: false, reason: "in_progress_run_exists" },
    "第二条必须**并入**并如实回报，不得静默少一行",
  );
  assert.equal(runtime.squadRunRepo.get("r-l-two"), null, "不得产生第二行");
  assert.equal(runtime.squadRunRepo.listByWorkItem("wi-l-one").length, 1);

  // 终态之后**必须**能再登记：否则一条残留的活跃行会把该工作项的所有后续指派**永久吃掉**（且不报错）。
  await runtime.lifecycle.completeLeaderRun({ runId: "r-l-one" });
  assert.deepEqual(
    await runtime.lifecycle.recordLeaderRun({
      runId: "r-l-three",
      workItemId: "wi-l-one",
      agentId: "ta-l",
    }),
    { recorded: true },
    "队长行终态后必须能重新登记（不是永久吃掉）",
  );

  // 不变式的键是**工作项**：别的工作项不受影响。
  assert.deepEqual(
    await runtime.lifecycle.recordLeaderRun({
      runId: "r-l-other",
      workItemId: "wi-l-other",
      agentId: "ta-l",
    }),
    { recorded: true },
    "另一个工作项不受影响",
  );
});

/* ---------- 6. 队长 run 的**终态事实**（spec §5.7(1)：终态后「进行中」**必须**判为假） ----------

   上一轮只补了「登记」（`recordLeaderRun` ⇒ `open`），于是**成功的队长行长驻 `open`** ⇒
   「该工作项有没有进行中的队长 run」（`hasInProgressLeaderRun`）**恒为真** ⇒ §5.7(1) 的
   「重复指派合并为一次」会把该工作项的所有后续指派**永久吃掉**（且不报错）。
   下面把终态写入口（成功 `completeLeaderRun` / 失败 `failMemberRun`）、可判定性（读法随终态变假）、
   对称性（队员行回归 / activeBranches 与回收器不变 / 跨终态响亮抛）逐格钉住。 */

// ① 成功 ⇒ 行长到**终态**（`merged`）、**不在 listActive()**，且**一个字都不写工作项**（§5.7(2)）。
//    这三条一起才说明「它离开了活跃集，但没有越权做队员那一步（推工作项）」。
test("completeLeaderRun：成功 ⇒ 队长行到终态（merged）且不在 listActive；工作项状态不动", async () => {
  const { repoRoot, runtime } = await setup();
  const item = runtime.workItemService.create({
    workspaceIdentity: "ws",
    workspacePath: repoRoot,
    title: "队长终态的目标项",
    assignee: { type: "user", id: "u1" },
  });
  const statusBefore = runtime.workItemRepo.get(item.id)!.status;
  await runtime.lifecycle.recordLeaderRun({
    runId: "r-lt-1",
    workItemId: item.id,
    agentId: "ta-lead",
  });
  // 前置（夹具必须有区分力）：登记后是 open、**在**活跃集里 —— 否则「终态后离开」证明不了任何事。
  assert.equal(runtime.squadRunRepo.get("r-lt-1")!.status, "open");
  assert.ok(
    runtime.squadRunRepo.listActive("ws").some((record) => record.runId === "r-lt-1"),
    "登记后必须在活跃集里，终态那一步才有可断言的变化",
  );

  await runtime.lifecycle.completeLeaderRun({ runId: "r-lt-1" });

  assert.equal(
    runtime.squadRunRepo.get("r-lt-1")!.status,
    "merged",
    "队长 run 成功 ⇒ 终态（它没有队员的 review/merge 那一步，run 结束即收口）",
  );
  assert.ok(
    !runtime.squadRunRepo.listActive("ws").some((record) => record.runId === "r-lt-1"),
    "终态的队长行**不得**留在活跃集（否则「进行中」恒真）",
  );
  assert.equal(
    runtime.workItemRepo.get(item.id)!.status,
    statusBefore,
    "§5.7(2)：队长 run 不改父项状态（套上 completeMemberRun 的 in_review 会写坏父项）",
  );
});

// ② 失败/中止 ⇒ 有归宿：离开活跃集（`discarded`），且**可被 listByWorkItem 看到**（留痕不丢，
//    台账没有删除路径）。走既有 `failMemberRun` —— 与队员同一条出口，不另立第二份规则。
test("队长 run 失败/中止 ⇒ 离开活跃集（failMemberRun 收口为 discarded）且行仍可查", async () => {
  const { runtime } = await setup();
  await runtime.lifecycle.recordLeaderRun({
    runId: "r-lt-fail",
    workItemId: "wi-lt-fail",
    agentId: "ta-lead",
  });
  assert.ok(
    runtime.squadRunRepo.listActive("ws").some((record) => record.runId === "r-lt-fail"),
    "失败前它在活跃集里（夹具区分力的前提）",
  );

  await runtime.lifecycle.failMemberRun({ runId: "r-lt-fail", reason: "队长会话终态=failed" });

  assert.equal(runtime.squadRunRepo.get("r-lt-fail")!.status, "discarded", "失败有归宿");
  assert.ok(
    !runtime.squadRunRepo.listActive("ws").some((record) => record.runId === "r-lt-fail"),
    "失败后必须离开活跃集",
  );
  // 留痕不丢：行还在（只是状态变了），事后能看出「这条 run 跑过、没跑成」。
  assert.equal(runtime.squadRunRepo.listByWorkItem("wi-lt-fail").length, 1);
});

// ③ 可判定性：§5.7(1) 的「进行中」读法（`hasInProgressLeaderRun`）在登记后为真、**终态后必须为假**。
//    这一格是本次任务的**逆推起点**：§5.7(1) ⇒ 终态后必须能判定「无进行中的队长 run」。
test("§5.7(1) 读法 hasInProgressLeaderRun：进行中为真，completeLeaderRun 之后为假", async () => {
  const { runtime, svc } = await controllableSetup();
  const item = runtime.workItemService.create({
    workspaceIdentity: "ws",
    workspacePath: runtime.boundWorkspace.path,
    title: "读法目标项",
    assignee: { type: "user", id: "u1" },
  });
  await svc.recordLeaderRun(target("ws"), {
    runId: "r-lt-read",
    workItemId: item.id,
    agentId: "ta-lead",
  });

  const before = await svc.getSnapshot(target("ws"));
  assert.equal(
    hasInProgressLeaderRun(before.runs, item.id),
    true,
    "登记后即「进行中」（这正是合并判据该命中的时刻）",
  );

  await svc.completeLeaderRun(target("ws"), { runId: "r-lt-read" });

  const after = await svc.getSnapshot(target("ws"));
  assert.equal(
    hasInProgressLeaderRun(after.runs, item.id),
    false,
    "终态之后「进行中」必须为假 —— 否则该判据恒真、该工作项的后续指派被永久合并",
  );
});

// ④ §6.2：队长行的终态**不得**影响工作树生命周期。同一父项下队员行与队长行并存，
//    队长行走到终态后：`activeBranches` 仍是队员那条、回收器照样保住队员的工作树。
test("队长行终态不影响 activeBranches / 回收器；同父项的队员行不受影响（回归）", async () => {
  const { runtime } = await setup();
  const member = await runtime.lifecycle.openMemberRun({
    runId: "r-lt-mem",
    workItemId: "wi-lt-mem",
    parentWorkItemId: "wi-lt-parent",
    agentId: "ta-mem",
    isLeaderTask: false,
  });
  await runtime.lifecycle.recordLeaderRun({
    runId: "r-lt-sibling",
    workItemId: "wi-lt-sibling",
    parentWorkItemId: "wi-lt-parent",
    agentId: "ta-lead",
  });
  assert.deepEqual(await runtime.lifecycle.computeActiveBranches("ws"), [member.branch]);

  await runtime.lifecycle.completeLeaderRun({ runId: "r-lt-sibling" });

  // 队长行到终态对活跃集合**零影响**：它本来就没有分支（按 `branch !== null` 投影时被滤掉）。
  assert.deepEqual(
    await runtime.lifecycle.computeActiveBranches("ws"),
    [member.branch],
    "队长 run 无工作树：它的终态不得改变 activeBranches（§6.2）",
  );
  // 回收器视队长行如无物：队员树被保住（在活跃集合里），队长行不产生任何待回收物。
  const reaped = await runtime.lifecycle.reapStartupOrphans({ workspaceKey: "ws" });
  assert.ok(reaped.kept.includes(member.worktreePath.split("/").at(-1)!));
  assert.deepEqual(await runtime.lifecycle.computeActiveBranches("ws"), [member.branch]);
});

// ⑤ 终态后再写一次：**同态幂等**（重投同一条「成功」事实不报错）、**跨终态响亮抛**
//    （一条已按失败收口的 run 不能被改写成「成功」—— 那会掩盖它当初为什么没跑完）。
//    与 failMemberRun 的口径一致（discarded 幂等；非 open 抛）。
test("completeLeaderRun 同态幂等；跨终态（discarded 之后写成功）响亮抛", async () => {
  const { runtime } = await setup();
  await runtime.lifecycle.recordLeaderRun({
    runId: "r-lt-idem",
    workItemId: "wi-lt-idem",
    agentId: "ta-lead",
  });
  await runtime.lifecycle.completeLeaderRun({ runId: "r-lt-idem" });
  // 幂等：同一条「成功」事实被重投（终态重放 / 双路径）不报错、也不再动任何东西。
  await runtime.lifecycle.completeLeaderRun({ runId: "r-lt-idem" });
  assert.equal(runtime.squadRunRepo.get("r-lt-idem")!.status, "merged");

  // 跨终态：先按失败收口，再想把它改写成成功 ⇒ 必须响亮抛，且**不落盘**（状态仍是 discarded）。
  await runtime.lifecycle.recordLeaderRun({
    runId: "r-lt-cross",
    workItemId: "wi-lt-cross",
    agentId: "ta-lead",
  });
  await runtime.lifecycle.failMemberRun({ runId: "r-lt-cross", reason: "先失败" });
  await assert.rejects(
    () => runtime.lifecycle.completeLeaderRun({ runId: "r-lt-cross" }),
    /不是 open|跨终态/,
  );
  assert.equal(
    runtime.squadRunRepo.get("r-lt-cross")!.status,
    "discarded",
    "跨终态改写必须被拒且不落盘（否则失败原因被抹掉）",
  );
});

// ⑥ 只收队长行：对**队员行**调用 completeLeaderRun ⇒ 响亮抛，且队员行一个字节不动。
//    防的是最坏形态：把一条从未合并的队员分支置 `merged`，编排器随后按「merged 且有分支」
//    把它连树带枝当「已合并」丢弃 —— 成果未落地就被删，且不报错。
test("completeLeaderRun 只收队长行：对队员行调用 ⇒ 抛，且队员行状态/活跃集合不变", async () => {
  const { runtime } = await setup();
  const member = await runtime.lifecycle.openMemberRun({
    runId: "r-lt-notleader",
    workItemId: "wi-lt-notleader",
    parentWorkItemId: "wi-lt-notleader",
    agentId: "ta-mem",
    isLeaderTask: false,
  });
  await assert.rejects(
    () => runtime.lifecycle.completeLeaderRun({ runId: "r-lt-notleader" }),
    /不是队长 run/,
  );
  assert.equal(runtime.squadRunRepo.get("r-lt-notleader")!.status, "open", "队员行不得被改写");
  assert.deepEqual(await runtime.lifecycle.computeActiveBranches("ws"), [member.branch]);
});

// ⑦ 未命中 runId ⇒ 响亮抛（与 failMemberRun / requireRun 同一口径：静默 no-op 会让调用方
//    以为收口成功，而那条 run 仍停在旧状态）。
test("completeLeaderRun 对不存在的 runId ⇒ 响亮抛", async () => {
  const { runtime } = await setup();
  await assert.rejects(
    () => runtime.lifecycle.completeLeaderRun({ runId: "r-lt-missing" }),
    /没有 runId/,
  );
});
