import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import {
  SquadDispatchDisabledError,
  createSquadRuntimeService,
} from "../src/workitem/squadRuntimeService.js";
import {
  archiveSquadAndTransfer,
  createSquadRuntime,
  renderLeaderBriefingPrompt,
} from "../src/workitem/squadRuntime.js";
import { slugForId } from "../src/workitem/slug.js";
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
  await assert.rejects(() => runtime.lifecycle.computeActiveBranches("another-ws"), /ws/);
  await assert.rejects(
    () => runtime.lifecycle.reapStartupOrphans({ workspaceKey: "another-ws" }),
    /another-ws/,
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
  const svc = createSquadRuntimeService({
    createRuntime: async (t) => {
      seen.push(`${t.path}|${t.identity}`);
      return createSquadRuntime({
        db,
        workspacePath: repoRoot,
        workspaceIdentity: t.identity,
        readExperimentEnabled: () => true,
      });
    },
    readExperimentEnabled: async () => true,
    archiveSquadAndTransfer: async (_target, id) => archiveSquadAndTransfer(runtime, id),
  });
  await svc.assertDispatchEnabled(target("alpha"));
  await svc.getSnapshot(target("beta"));
  assert.deepEqual(seen, ["/tmp/alpha|alpha", "/tmp/beta|beta"]);
});
