// eslint-disable-next-line typescript-eslint/triple-slash-reference -- 与 schedulerWakeTick.test.ts 同一处声明（不为本文件另写一份）
/// <reference path="../../services/src/runtime-tools/node-forge.d.ts" />
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { deriveZCodeTaskStatusFromSessionSnapshot } from "@zcode/shared";
import { SQUAD_DISPATCH_DISABLED_CODE, SquadDispatchDisabledError } from "@zcode/services";
import { createSquadRuntime } from "@zcode/services/node";
import { runTasksDatabaseMigrations } from "../../services/src/session/tasksDatabase/migrations.js";
import { createBoundSessionExecutingProbe } from "../src/host/boundSessionBusyGate.js";
import {
  decideSquadDispatch,
  isSquadDispatchDisabledError,
  watchMemberRunSettlement,
  type SquadMemberRunTerminalOutcome,
} from "../src/host/squadDispatch.js";

const base = {
  // 门禁结论**由服务层给出**（本函数不读开关）：dispatchEnabled 是「服务层说可以派发」这一事实，
  // 名称刻意不叫 enabled —— 免得下一个人以为可以在这里自己读 appSettings。
  dispatchEnabled: true, databaseReady: true, busy: false, kind: "leader" as const,
  briefingPrompt: "P", memberPrompt: "P", worktree: undefined,
};

test("服务层说门禁关 ⇒ skip，不派发", () => {
  assert.deepEqual(decideSquadDispatch({ ...base, dispatchEnabled: false }), {
    action: "skip", reason: "disabled_by_service",
  });
});

test("数据库未就绪 ⇒ skip", () => {
  assert.deepEqual(decideSquadDispatch({ ...base, databaseReady: false }), {
    action: "skip", reason: "not_ready",
  });
});

// 硬约束 1：绑定会话忙 ⇒ **deferred**（等待型重投），不是失败、也不排队堆积。
test("绑定会话忙 ⇒ defer", () => {
  assert.deepEqual(decideSquadDispatch({ ...base, busy: true }), { action: "defer", reason: "bound_session_busy" });
});

test("开关开、库就绪、不忙 ⇒ dispatch 并带上 prompt", () => {
  const out = decideSquadDispatch(base);
  assert.equal(out.action, "dispatch");
  assert.ok(out.action === "dispatch" && out.prompt === "P");
});

// 队员 run 必须先开树：没有 worktree 就派发 = 队员直接改主工作区（spec §6.1 的隔离承诺落空）。
test("队员 run 缺 worktree ⇒ 响亮失败，不派发", () => {
  const out = decideSquadDispatch({ ...base, kind: "member" });
  assert.equal(out.action, "fail");
});

// 硬约束 1 的机器化守卫：小队派发这一支必须用**强探测**，
// 不得照抄 off-peak 的投影判据（残留 running 行会让派发被永久卡死）。
test("小队派发分支用的是强探测，不是 off-peak 的投影判据", () => {
  const src = readFileSync(join(resolve(dirname(fileURLToPath(import.meta.url)), "../src"), "host/index.ts"), "utf8");
  const start = src.indexOf("HostMessageTypes.SquadWake");
  assert.ok(start >= 0, "host 里没有 SquadWake 分支");
  /* 窗口是「够覆盖到强探测那一行」的上界，不是契约：原值 6000 在 Wave 2 的追加（失败路径上的
     订阅解绑）之后只剩 46 字符余量 —— 那是**脆的**，下一次正当的追加就会把断言变成假红
     （断言的本意是「本分支用强探测」，而不是「分支不超过 N 字节」）。放宽到 20000
     （与 squadWiring.test.ts 同口径），并保留两条断言的语义不变。 */
  const branch = src.slice(start, start + 20_000);
  assert.match(branch, /createBoundSessionExecutingProbe/);
  assert.doesNotMatch(branch, /assertBoundSessionDispatchable/);
});

// 确认 2 的机器化守卫：**门禁的唯一读取点在服务层**。
// desktop 侧任何一处读这个字段，都意味着判据被复制成了第二份 —— 而三份判据正是
// 「改一处漏一处 ⇒ 关掉实验照旧派发」的形态。
test("desktop 侧任何文件都不读 experimentalAgentSquadsEnabled", () => {
  const desktopSrc = join(resolve(dirname(fileURLToPath(import.meta.url)), "../src"), "..", "..", "..",
    "packages", "desktop", "src");
  // 递归遍历 desktop/src，任何一个文件出现该字段即红。
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && readFileSync(full, "utf8").includes("experimentalAgentSquadsEnabled")) {
        hits.push(full);
      }
    }
  };
  walk(desktopSrc);
  assert.deepEqual(hits, [], `门禁判据只能有一处（服务层）；desktop 侧不应读取该字段：${hits.join(", ")}`);
});

/* ── 本任务补齐的矩阵格 ── */

test("门禁错误按**稳定 code** 判，不按文案", () => {
  // 真实错误类（服务层抛的）必须被认出来。
  assert.equal(isSquadDispatchDisabledError(new SquadDispatchDisabledError()), true);
  // 只把码写在文案里、没有 code 字段的错误**不得**被误认（否则「读文案」就成了第二份判据）。
  assert.equal(
    isSquadDispatchDisabledError(new Error(`[${SQUAD_DISPATCH_DISABLED_CODE}] 实验功能已关闭`)),
    false,
  );
  assert.equal(isSquadDispatchDisabledError(undefined), false);
});

// 隔离承诺的落点：队员 run 的会话 workspace 是工作树，不是主工作区。
test("队员 run 有工作树 ⇒ dispatch，prompt 用队员文案、workspace 用工作树", () => {
  const out = decideSquadDispatch({
    ...base,
    kind: "member",
    memberPrompt: "M",
    worktree: { branch: "squad/member/a", worktreePath: "/repo/.worktree/a" },
  });
  assert.equal(out.action, "dispatch");
  assert.ok(out.action === "dispatch" && out.prompt === "M");
  if (out.action === "dispatch") assert.equal(out.workspacePath, "/repo/.worktree/a", "队员在独立工作树里干活");
});

test("队长 run 不携带工作树（session workspace 由调用点用消息里的 workspace）", () => {
  const out = decideSquadDispatch({ ...base, briefingPrompt: "L" });
  assert.equal(out.action, "dispatch");
  assert.ok(out.action === "dispatch" && out.prompt === "L");
  if (out.action === "dispatch") assert.equal(out.workspacePath, undefined);
});

// 硬约束 1 的**行为**证据（不只是源码文本）：投影判据与强探测的结论会**相反**。
// 夹具必须**有区分力**：空投影只能证明「什么都没有时不忙」，恰好绕过了真正会卡死派发的那一格 ——
// 崩溃/强杀留下的**残留投影**（`session.status=running` + 保留的 turn 边界 `currentTurnId`）。
// 这一格里，按投影派生任务状态的旧判据会说「在跑」（runner 已崩，残留行可以停留数月），
// 而强探测只认 runtime 的真实阻塞态（`runtime.activeTurnId`）⇒ 判不忙、放行。
// 三件事一起断言：① 同一夹具的投射结论确实是 running；② 强探测判不忙；③ 派发因此放行。
test("投影是 running（残留 turn 边界）但 runtime 未在执行 ⇒ 强探测判不忙，派发放行", async () => {
  const staleProjectionSnapshot = {
    // 残留投影：会话状态还是 running，投影里还留着上一轮的 turn 边界（完成后会保留）。
    session: { status: "running" },
    projection: { currentTurnId: "turn-done" },
    // runtime 快照里**没有**任何真实阻塞运行态（没有 activeTurnId / 待批权限 / 在跑的工具调用）。
    runtime: {},
    messages: [],
  } as never;
  // ① 旧判据（按投影派生任务状态，off-peak 的 `status === "running"` 同源）在这一格会判「在跑」。
  assert.equal(
    deriveZCodeTaskStatusFromSessionSnapshot(staleProjectionSnapshot),
    "running",
    "夹具必须有区分力：同一快照按投影派生出来是 running，否则这条用例证明不了强探测更准",
  );
  const probe = createBoundSessionExecutingProbe({
    agentService: { readSession: async () => staleProjectionSnapshot },
    logWarn: () => {},
  });
  // ② 强探测读 runtime：残留投影不算忙。
  assert.equal(await probe({ sessionId: "s-1", workspacePath: "/ws" }), false);
  // ③ 结论落到派发决策上：放行，不是 defer。
  assert.equal(decideSquadDispatch({ ...base, busy: false }).action, "dispatch");
});

test("runtime 真在执行 ⇒ 强探测判忙 ⇒ defer", async () => {
  const probe = createBoundSessionExecutingProbe({
    agentService: {
      readSession: async () =>
        ({ runtime: { activeTurnId: "turn-1" }, projection: {} }) as never,
    },
    logWarn: () => {},
  });
  assert.equal(await probe({ sessionId: "s-1", workspacePath: "/ws" }), true);
  assert.deepEqual(decideSquadDispatch({ ...base, busy: true }), {
    action: "defer",
    reason: "bound_session_busy",
  });
});

// 判定次序本身是契约（brief Step 3 第 7 条自上而下）：
// 库未就绪 → 门禁 → 队员缺树（配置错，最该响亮）→ 忙（等一会）→ 派发。
// 每一对相邻判据都要能分出「谁先谁后」，否则同一事实会拿到两种结论。
test("判定次序：not_ready ＞ disabled ＞ 队员缺树 ＞ busy ＞ dispatch", () => {
  assert.deepEqual(
    decideSquadDispatch({ ...base, databaseReady: false, dispatchEnabled: false, busy: true }),
    { action: "skip", reason: "not_ready" },
  );
  assert.deepEqual(
    decideSquadDispatch({ ...base, dispatchEnabled: false, busy: true, kind: "member" }),
    { action: "skip", reason: "disabled_by_service" },
  );
  // 队员缺树比忙更严重：忙只是「等一会」，缺树说明这次派发的配置错了（会改主工作区）。
  assert.deepEqual(
    decideSquadDispatch({ ...base, busy: true, kind: "member" }),
    { action: "fail", reason: "member_run_requires_worktree" },
  );
  assert.deepEqual(decideSquadDispatch({ ...base, busy: true }), {
    action: "defer",
    reason: "bound_session_busy",
  });
});

/* ── 队员 run 的终态收口（Important-D）：闭环的最后一环 ──

   冻结面把 `completeMemberRun` 的调用者写明是「host 派发桥」。没有这一步时每条队员 run 都停在
   `open` ⇒ 永远算「活跃」（`listActive`）⇒ 工作树与分支永远不被回收，且没人能从台账看出它早跑完了。
   这里用**真实的 runtime + 真实的 git 工作树 + 真实的 sqlite 台账**驱动收口，断言的是**实体状态**
   （`squadRunRepo.get(...).status`），不是某个返回值 —— 去掉 `completeMemberRun` 的调用，本用例必须红。 */

const run = promisify(execFile);

/** 一次性临时 git 仓库：`createSquadRuntime` 要解析 base 分支，开树真的要 `git worktree add`。 */
async function makeRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "squad-wake-"));
  await run("git", ["init", "-q", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.email", "t@t"], { cwd: root });
  await run("git", ["config", "user.name", "t"], { cwd: root });
  writeFileSync(join(root, "a.txt"), "1\n");
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["commit", "-qm", "init"], { cwd: root });
  return root;
}

/** 真实 runtime（git 仓库 + 内存库 + 迁移），并预置一个 in_progress 的工作项。 */
async function makeRuntimeWithWorkItem() {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: "ws",
    readExperimentEnabled: () => true,
  });
  const workItem = runtime.workItemService.create({
    workspaceIdentity: "ws",
    workspacePath: repoRoot,
    title: "T",
    assignee: { type: "user", id: "u1" },
  });
  // completeMemberRun 的工作项 CAS 是 `in_review ← in_progress`，故先把工作项推到 in_progress。
  assert.equal(runtime.workItemService.transition(workItem.id, "in_progress", "todo"), true);
  return { runtime, workItem };
}

/** 让 `void completeMemberRun(...)` 那条微任务链跑完（收口是异步的，断言前必须给它一拍）。 */
const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("队员 run 的终态收口：真实台账行从 open 走到产出入账（produced + 工作项 in_review）", async () => {
  const { runtime, workItem } = await makeRuntimeWithWorkItem();
  const runId = "e:id:squad:wi-1:3:0";
  // 派发桥第一步：队员 run 先开树（台账先落行、再建树），此时状态是 open。
  await runtime.lifecycle.openMemberRun({
    runId,
    workItemId: workItem.id,
    parentWorkItemId: workItem.id,
    agentId: "ta-a",
    isLeaderTask: false,
  });
  assert.equal(runtime.squadRunRepo.get(runId)?.status, "open", "开树后是 open（还没产出）");
  assert.ok(
    runtime.squadRunRepo.listActive("ws").some((record) => record.runId === runId),
    "open 的 run 落在活跃集合里 —— 这正是「永不收缩」的那一格",
  );

  // 派发桥的收口：在「发 prompt」之前订阅终态。
  const logs: string[] = [];
  let terminal: ((outcome: SquadMemberRunTerminalOutcome) => void) | undefined;
  watchMemberRunSettlement({
    runId,
    traceId: runId,
    subscribe: (listener) => {
      terminal = listener;
      return { dispose: () => {} };
    },
    completeMemberRun: (settledRunId) => runtime.lifecycle.completeMemberRun({ runId: settledRunId }),
    logInfo: (message) => logs.push(message),
    logError: (message) => logs.push(message),
  });
  assert.equal(typeof terminal, "function", "订阅必须发生在 sendPrompt 之前，否则终态会被漏掉");

  // 终态到达（成功）⇒ 产出入账。
  terminal!({ inputId: runId, outcome: "succeeded" });
  await flushMicrotasks();

  assert.equal(
    runtime.squadRunRepo.get(runId)?.status,
    "produced",
    "run 必须从 open 前进到 produced（产出入账）",
  );
  assert.equal(
    runtime.workItemRepo.get(workItem.id)?.status,
    "in_review",
    "产出即推工作项到 in_review（走工作项服务，唯一写者不变）",
  );
  assert.ok(
    logs.some((line) => line.includes("produced")),
    "入账要留痕",
  );
});

test("终态收口只认本次派发那一轮（inputId 不匹配 ⇒ 不结算）", async () => {
  const { runtime, workItem } = await makeRuntimeWithWorkItem();
  const runId = "e:id:squad:wi-2:1:0";
  await runtime.lifecycle.openMemberRun({
    runId,
    workItemId: workItem.id,
    parentWorkItemId: workItem.id,
    agentId: "ta-b",
    isLeaderTask: false,
  });
  let terminal: ((outcome: SquadMemberRunTerminalOutcome) => void) | undefined;
  watchMemberRunSettlement({
    runId,
    traceId: runId,
    subscribe: (listener) => {
      terminal = listener;
      return { dispose: () => {} };
    },
    completeMemberRun: (settledRunId) => runtime.lifecycle.completeMemberRun({ runId: settledRunId }),
    logInfo: () => {},
    logError: () => {},
  });
  // 用户插话 / 上一轮残留的终态：不是这次 run 的产出，不得把台账推到 produced。
  terminal!({ inputId: "别的轮次", outcome: "succeeded" });
  await flushMicrotasks();
  assert.equal(runtime.squadRunRepo.get(runId)?.status, "open");
});

// 失败/中止**不得**冒充产出：completeMemberRun 会把 run 置 produced、工作项推 in_review。
// 服务面没有 failed/discard 出口 ⇒ 那一行的归宿是响亮留痕（台账仍在 open），不是静默。
test("终态是 failed/stopped ⇒ 不入账（仍是 open），但必须响亮留痕", async () => {
  const { runtime, workItem } = await makeRuntimeWithWorkItem();
  const runId = "e:id:squad:wi-3:1:0";
  await runtime.lifecycle.openMemberRun({
    runId,
    workItemId: workItem.id,
    parentWorkItemId: workItem.id,
    agentId: "ta-c",
    isLeaderTask: false,
  });
  const errors: string[] = [];
  let terminal: ((outcome: SquadMemberRunTerminalOutcome) => void) | undefined;
  watchMemberRunSettlement({
    runId,
    traceId: runId,
    subscribe: (listener) => {
      terminal = listener;
      return { dispose: () => {} };
    },
    completeMemberRun: (settledRunId) => runtime.lifecycle.completeMemberRun({ runId: settledRunId }),
    logInfo: () => {},
    logError: (message) => errors.push(message),
  });
  terminal!({ inputId: runId, outcome: "failed", error: "boom" });
  await flushMicrotasks();
  assert.equal(runtime.squadRunRepo.get(runId)?.status, "open", "失败不等于产出");
  assert.equal(
    runtime.workItemRepo.get(workItem.id)?.status,
    "in_progress",
    "工作项也不得被推到 in_review",
  );
  assert.equal(errors.length, 1, "必须有一条 error 留痕（静默停在 open 才是要避免的）");
  assert.match(errors[0] ?? "", /open/);
});
