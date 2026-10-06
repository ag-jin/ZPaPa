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
  commentObligationReplayFacts,
  commentReceiptSettlementFor,
  decideSquadDispatch,
  isSquadDispatchDisabledError,
  isUnsettledCommentDispatchReceipt,
  ledgerActionForRunClass,
  replayChannelForObligationOrigin,
  selectStaleLeaderRuns,
  watchLeaderRunSettlement,
  watchMemberRunSettlement,
  type SquadMemberRunTerminalOutcome,
} from "../src/host/squadDispatch.js";

const base = {
  // 门禁结论**由服务层给出**（本函数不读开关）：dispatchEnabled 是「服务层说可以派发」这一事实，
  // 名称刻意不叫 enabled —— 免得下一个人以为可以在这里自己读一次 appSettings。
  dispatchEnabled: true,
  databaseReady: true,
  busy: false,
  kind: "leader" as const,
  // 「该工作项有没有进行中的队长 run」——**服务层台账**给出的事实（`hasInProgressLeaderRun`
  // 是唯一读法），本函数只搬运；默认 false = 目前没有队长 run 在跑。
  leaderRunInProgress: false,
  briefingPrompt: "P",
  memberPrompt: "P",
  standalonePrompt: "P",
  worktree: undefined,
};

test("服务层说门禁关 ⇒ skip，不派发", () => {
  assert.deepEqual(decideSquadDispatch({ ...base, dispatchEnabled: false }), {
    action: "skip",
    reason: "disabled_by_service",
  });
});

test("数据库未就绪 ⇒ skip", () => {
  assert.deepEqual(decideSquadDispatch({ ...base, databaseReady: false }), {
    action: "skip",
    reason: "not_ready",
  });
});

// 硬约束 1：绑定会话忙 ⇒ **deferred**（等待型重投），不是失败、也不排队堆积。
test("绑定会话忙 ⇒ defer", () => {
  assert.deepEqual(decideSquadDispatch({ ...base, busy: true }), {
    action: "defer",
    reason: "bound_session_busy",
  });
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
  const src = readFileSync(
    join(resolve(dirname(fileURLToPath(import.meta.url)), "../src"), "host/index.ts"),
    "utf8",
  );
  /* 2026-10-02 第 2 轮裁定把实现体抽成 `runSquadDispatch`（规则到点与队长派单**两条入口共用**），
     故这里按**结构边界**取区域（从函数签名到消息处理器之间），不再用固定字节窗口：窗口是脆的
     （原来的 6000 在 Wave 2 的追加后只剩 46 字符余量），而这条断言的本意是「派发路径用强探测」，
     不是「那段代码不超过 N 字节」。 */
  const start = src.indexOf("async function runSquadDispatch(");
  assert.ok(start >= 0, "host 里没有 runSquadDispatch（派发桥实现体）");
  const end = src.indexOf('parentPort.on("message",', start);
  assert.ok(end > start, "找不到消息处理器边界");
  const branch = src.slice(start, end);
  assert.match(branch, /createBoundSessionExecutingProbe/);
  assert.doesNotMatch(branch, /assertBoundSessionDispatchable/);
});

// 确认 2 的机器化守卫：**门禁的唯一读取点在服务层**。
// desktop 侧任何一处读这个字段，都意味着判据被复制成了第二份 —— 而三份判据正是
// 「改一处漏一处 ⇒ 关掉实验照旧派发」的形态。
test("desktop 侧任何文件都不读 experimentalAgentSquadsEnabled", () => {
  const desktopSrc = join(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src"),
    "..",
    "..",
    "..",
    "packages",
    "desktop",
    "src",
  );
  // 递归遍历 desktop/src，任何一个文件出现该字段即红。
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        /\.tsx?$/.test(entry.name) &&
        readFileSync(full, "utf8").includes("experimentalAgentSquadsEnabled")
      ) {
        hits.push(full);
      }
    }
  };
  walk(desktopSrc);
  assert.deepEqual(
    hits,
    [],
    `门禁判据只能有一处（服务层）；desktop 侧不应读取该字段：${hits.join(", ")}`,
  );
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
  if (out.action === "dispatch")
    assert.equal(out.workspacePath, "/repo/.worktree/a", "队员在独立工作树里干活");
});

/* ── 单独安排的智能体（spec §6.1）：直接在工作区改 ──

   三件事一起钉：① 它**没有**工作树也必须派发（不得落进「队员缺树 ⇒ fail」那一格）；
   ② 会话 workspace 是 undefined（由调用点用消息里的 workspace = 目标工作区，不是工作树）；
   ③ prompt 用**单独安排**的文案（不是队员那段「不要改主工作区」——那对它是反的）。
   去掉 `ledgerActionForRunClass` 里 standalone 那一支（退回「一律开树」）会让 ① 的输入变得不可构造，
   而下面的 `ledgerActionForRunClass("standalone") === "none"` 会直接红。 */
test("单独安排的智能体：无工作树 ⇒ 仍 dispatch，workspace 用目标工作区、prompt 用单独安排文案", () => {
  const out = decideSquadDispatch({
    ...base,
    kind: "standalone",
    memberPrompt: "M",
    standalonePrompt: "S",
  });
  assert.equal(out.action, "dispatch", "单独安排没有工作树是**正确形状**（§6.1），不得判成失败");
  assert.ok(out.action === "dispatch" && out.prompt === "S", "必须是单独安排的文案");
  if (out.action === "dispatch") {
    assert.equal(out.workspacePath, undefined, "没有工作树 ⇒ 会话落在消息里的目标工作区（§6.1）");
  }
});

// 台账动作按类别查表：这是「非队长 ⇒ 开树」那个缺陷的**唯一**落点，故逐格钉死。
test("台账动作按类别分流：队员开树 / 队长只登记 / 单独安排两者都不做", () => {
  assert.equal(ledgerActionForRunClass("member"), "open_member_run");
  assert.equal(ledgerActionForRunClass("leader"), "record_leader_run");
  assert.equal(
    ledgerActionForRunClass("standalone"),
    "none",
    "单独安排不得开工作树、也不得登记台账行（§6.1：没有合并那一步，也就没有工作树/孤儿问题）",
  );
});

// 补集方向：判定次序里「队员缺树 ⇒ fail」只对 `member` 生效，不得误伤另外两类
//（队长与单独安排**本来就没有**工作树，把这条判据套上去会把正确的派发判成失败）。
test("缺树 fail 只对队员生效：队长与单独安排缺树都不 fail", () => {
  for (const kind of ["leader", "standalone"] as const) {
    const out = decideSquadDispatch({ ...base, kind });
    assert.equal(out.action, "dispatch", `${kind} 缺树是正确形状，不得判 fail`);
  }
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
      readSession: async () => ({ runtime: { activeTurnId: "turn-1" }, projection: {} }) as never,
    },
    logWarn: () => {},
  });
  assert.equal(await probe({ sessionId: "s-1", workspacePath: "/ws" }), true);
  assert.deepEqual(decideSquadDispatch({ ...base, busy: true }), {
    action: "defer",
    reason: "bound_session_busy",
  });
});

/* ── §5.7(1)/S13：队长 run 进行中时的重复指派**合并**为同一次 ──

   这一条以前只有**读法**（服务层导出的 `hasInProgressLeaderRun`）而没有**行为**：它零生产调用方，
   于是同一工作项被指派两次就会起两条队长 run —— 两个会话干同一件事，而 §5.7(1) 要求
   「合并为同一次（不排队堆积）」。判据仍然只有一处（服务层那个读法），本函数只把它搬进来做决定。 */
test("队长 run 进行中 ⇒ skip(leader_run_merged)：并入同一次，不起第二次 run", () => {
  assert.deepEqual(decideSquadDispatch({ ...base, leaderRunInProgress: true }), {
    action: "skip",
    reason: "leader_run_merged",
  });
});

// 次序：**合并判据必须排在忙检查之前**。排在后面的话，重投会先拿到 defer（等队长跑完），
// 之后照样起第二次 run —— 那正是 S13 要禁的「排队的第二次 run」。这一格是唯一能观测该次序的输入。
test("次序：队长进行中 ＞ busy —— 忙也先合并，不得先 defer 事后补起第二次 run", () => {
  assert.deepEqual(decideSquadDispatch({ ...base, leaderRunInProgress: true, busy: true }), {
    action: "skip",
    reason: "leader_run_merged",
  });
});

// 该判据**只对队长**成立：队员与单独安排的智能体各有自己的幂等口径
//（队员：同一 `eventKey` 撞台账主键；单独安排：压根不登记台账行，「进行中」无从谈起）。
// 套到那两类身上，会把一次正常的派发静默吞掉。
test("队长进行中判据不误伤队员 / 单独安排", () => {
  const member = decideSquadDispatch({
    ...base,
    kind: "member",
    worktree: { branch: "squad/member/a", worktreePath: "/repo/.worktree/a" },
    leaderRunInProgress: true,
  });
  assert.equal(member.action, "dispatch", "队员派发不受队长判据影响");
  const standalone = decideSquadDispatch({
    ...base,
    kind: "standalone",
    leaderRunInProgress: true,
  });
  assert.equal(standalone.action, "dispatch", "单独安排不登记台账行，也谈不上「进行中」");
});

/* ── 启动**和解**的判据（§5.7(1) 的另一面）：哪些残留队长行已经没有东西会把它推向终态 ──

   一条卡在 `open` 的队长行会让该工作项**后续的所有指派被静默并入**（用户看到「点了指派没反应」，
   而且是永久的）。这四条把「收谁、不收谁」逐格钉死。 */
test("启动和解：会话不在执行的队长行必须被收（否则该工作项的指派被永久静默吃掉）", () => {
  assert.deepEqual(
    selectStaleLeaderRuns({
      activeRuns: [{ runId: "r-dead", isLeaderTask: true, sessionId: "s-dead" }],
      executingSessionIds: new Set(["s-live"]),
    }),
    ["r-dead"],
  );
});

test("启动和解：正在执行的队长行不得被收（那会把一条在跑的 run 判死）", () => {
  assert.deepEqual(
    selectStaleLeaderRuns({
      activeRuns: [{ runId: "r-live", isLeaderTask: true, sessionId: "s-live" }],
      executingSessionIds: new Set(["s-live"]),
    }),
    [],
  );
});

test("启动和解：未绑会话的历史行同样收（启动时刻它只可能来自上一个进程）", () => {
  assert.deepEqual(
    selectStaleLeaderRuns({
      activeRuns: [{ runId: "r-unbound", isLeaderTask: true, sessionId: null }],
      executingSessionIds: new Set(),
    }),
    ["r-unbound"],
  );
});

test("启动和解只收队长行：队员行（不在执行）不得被这里收掉（有树有枝，规则不同）", () => {
  assert.deepEqual(
    selectStaleLeaderRuns({
      activeRuns: [
        { runId: "r-mem", isLeaderTask: false, sessionId: "s-gone" },
        { runId: "r-lead", isLeaderTask: true, sessionId: "s-gone" },
      ],
      executingSessionIds: new Set(),
    }),
    ["r-lead"],
    "队员行的归宿是它自己的终态回调 + 启动回收器（§6.2 / S5：产出必须活到合并）",
  );
});

// 判定次序本身是契约（brief Step 3 第 7 条自上而下）：
// 库未就绪 → 门禁 → 队员缺树（配置错，最该响亮）→ 队长进行中（合并）→ 忙（等一会）→ 派发。
// 每一对相邻判据都要能分出「谁先谁后」，否则同一事实会拿到两种结论。
// （「队员缺树」与「队长进行中」在 `kind` 上不相交、谁先谁后不可观测；与忙那一对的次序是**必需**的。）
test("判定次序：not_ready ＞ disabled ＞ 队员缺树 ＞ 队长进行中 ＞ busy ＞ dispatch", () => {
  assert.deepEqual(
    decideSquadDispatch({ ...base, databaseReady: false, dispatchEnabled: false, busy: true }),
    { action: "skip", reason: "not_ready" },
  );
  assert.deepEqual(
    decideSquadDispatch({ ...base, dispatchEnabled: false, busy: true, kind: "member" }),
    { action: "skip", reason: "disabled_by_service" },
  );
  // 队员缺树比忙更严重：忙只是「等一会」，缺树说明这次派发的配置错了（会改主工作区）。
  assert.deepEqual(decideSquadDispatch({ ...base, busy: true, kind: "member" }), {
    action: "fail",
    reason: "member_run_requires_worktree",
  });
  // 合并比忙更靠前：忙着的那次很可能**正是**那条进行中的队长 run 本身。
  assert.deepEqual(decideSquadDispatch({ ...base, busy: true, leaderRunInProgress: true }), {
    action: "skip",
    reason: "leader_run_merged",
  });
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
    completeMemberRun: (settledRunId) =>
      runtime.lifecycle.completeMemberRun({ runId: settledRunId }),
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
    completeMemberRun: (settledRunId) =>
      runtime.lifecycle.completeMemberRun({ runId: settledRunId }),
    logInfo: () => {},
    logError: () => {},
  });
  // 用户插话 / 上一轮残留的终态：不是这次 run 的产出，不得把台账推到 produced。
  terminal!({ inputId: "别的轮次", outcome: "succeeded" });
  await flushMicrotasks();
  assert.equal(runtime.squadRunRepo.get(runId)?.status, "open");
});

// 失败/中止**不得**冒充产出：completeMemberRun 会把 run 置 produced、工作项推 in_review。
// 本用例只覆盖 `watchMemberRunSettlement` 这一层（它不负责动用失败出口）；**生产上**由 host 的订阅闭包
// 用服务面的 `failMemberRun` 把它移出活跃集（服务面已于 2026-10-02 补上该出口，见
// `squadRuntimeRecovery.test.ts` 的 Important-3 用例与 `squadWiring.test.ts` 的接线守卫）。
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
    completeMemberRun: (settledRunId) =>
      runtime.lifecycle.completeMemberRun({ runId: settledRunId }),
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
  // 文案在 2026-10-02 的 doc 修正后指向**真正的归宿**（host 订阅闭包里的 failMemberRun）——
  // 断言「留痕里说清了这是未产出」而不是旧的「台账仍为 open」字样（后者已过时：失败出口早就补上了）。
  assert.match(errors[0] ?? "", /未产出/);
  assert.match(errors[0] ?? "", /failMemberRun/);
});

/* ── 订阅句柄的释放（Minor-2）──

   复审发现：`params.subscribe(...)` 返回的 `{ dispose() }` **既没保存也没释放**，而 cron 侧
   （`cronRunSubscriptions`）会存起来、在终态后 dispose()。于是本处**每次派发都新增一个永不解绑的
   监听器**（终态到达后也不解绑），随派发次数累积。裁定：照 cron 的形态——保存句柄、终态后 dispose()。
   下面三条用**实体状态断言**（dispose 真的被调用了几次），不是只看返回字符串。 */

test("终态到达 ⇒ 释放订阅句柄（成功后不再累积监听器；别轮的终态不解绑）", async () => {
  const { runtime, workItem } = await makeRuntimeWithWorkItem();
  const runId = "e:id:squad:wi-dispose-ok:1:0";
  await runtime.lifecycle.openMemberRun({
    runId,
    workItemId: workItem.id,
    parentWorkItemId: workItem.id,
    agentId: "ta-dispose-ok",
    isLeaderTask: false,
  });
  let disposed = 0;
  let terminal: ((outcome: SquadMemberRunTerminalOutcome) => void) | undefined;
  watchMemberRunSettlement({
    runId,
    traceId: runId,
    subscribe: (listener) => {
      terminal = listener;
      return {
        dispose: () => {
          disposed += 1;
        },
      };
    },
    completeMemberRun: (settledRunId) =>
      runtime.lifecycle.completeMemberRun({ runId: settledRunId }),
    logInfo: () => {},
    logError: () => {},
  });
  assert.equal(disposed, 0, "订阅后、终态前不得解绑");
  // 别轮终态不是本次 run 的收口 ⇒ 必须继续等，不得提前解绑（否则本次终态会漏掉）。
  terminal!({ inputId: "别的轮次", outcome: "succeeded" });
  await flushMicrotasks();
  assert.equal(disposed, 0, "inputId 不匹配 ⇒ 不结算也不解绑");
  // 本轮终态到达 ⇒ 收口完成，句柄必须释放。
  terminal!({ inputId: runId, outcome: "succeeded" });
  await flushMicrotasks();
  assert.equal(disposed, 1, "终态到达后必须解绑（否则每次派发累积一个监听器）");
  assert.equal(runtime.squadRunRepo.get(runId)?.status, "produced", "解绑不影响产出入账");
});

test("终态是 failed/stopped（放弃收口）⇒ 同样释放订阅句柄", async () => {
  const { runtime, workItem } = await makeRuntimeWithWorkItem();
  const runId = "e:id:squad:wi-dispose-fail:1:0";
  await runtime.lifecycle.openMemberRun({
    runId,
    workItemId: workItem.id,
    parentWorkItemId: workItem.id,
    agentId: "ta-dispose-fail",
    isLeaderTask: false,
  });
  let disposed = 0;
  let terminal: ((outcome: SquadMemberRunTerminalOutcome) => void) | undefined;
  watchMemberRunSettlement({
    runId,
    traceId: runId,
    subscribe: (listener) => {
      terminal = listener;
      return {
        dispose: () => {
          disposed += 1;
        },
      };
    },
    completeMemberRun: (settledRunId) =>
      runtime.lifecycle.completeMemberRun({ runId: settledRunId }),
    logInfo: () => {},
    logError: () => {},
  });
  terminal!({ inputId: runId, outcome: "stopped" });
  await flushMicrotasks();
  assert.equal(disposed, 1, "失败/中止的终态也是收口的尽头：句柄必须释放");
});

test("同一 runId 重新订阅（重投）⇒ 先撤下旧句柄，不累积", () => {
  const runId = "e:id:squad:wi-resub:1:0";
  let disposedFirst = 0;
  let disposedSecond = 0;
  const subscribeFirst = () => ({
    dispose: () => {
      disposedFirst += 1;
    },
  });
  const subscribeSecond = () => ({
    dispose: () => {
      disposedSecond += 1;
    },
  });
  const base = {
    runId,
    traceId: runId,
    completeMemberRun: async () => {},
    logInfo: () => {},
    logError: () => {},
  };
  watchMemberRunSettlement({ ...base, subscribe: subscribeFirst });
  assert.equal(disposedFirst, 0);
  // 重投同一条事实会重新订阅（可能换了 taskId）：旧句柄必须先撤下。
  watchMemberRunSettlement({ ...base, subscribe: subscribeSecond });
  assert.equal(disposedFirst, 1, "重新订阅前必须撤下旧句柄（否则每次重投都多一个监听器）");
  assert.equal(disposedSecond, 0, "新句柄仍在生效，不得误撤");
});

// 「放弃」的另一形态：订阅本身抛（拿不到句柄）⇒ 响亮留痕，且撤下同 runId 的旧句柄、不留半个句柄。
test("订阅本身抛 ⇒ 响亮留痕，并撤下旧句柄（不留半个句柄）", () => {
  const runId = "e:id:squad:wi-subfail:1:0";
  let disposedOld = 0;
  // 先成功订阅一次（重投前的那次）。
  watchMemberRunSettlement({
    runId,
    traceId: runId,
    subscribe: () => ({
      dispose: () => {
        disposedOld += 1;
      },
    }),
    completeMemberRun: async () => {},
    logInfo: () => {},
    logError: () => {},
  });
  assert.equal(disposedOld, 0);
  // 重投这次订阅抛：旧句柄必须被撤下，且失败要响亮（没有订阅就没有收口，run 会停在 open）。
  const errors: string[] = [];
  watchMemberRunSettlement({
    runId,
    traceId: runId,
    subscribe: () => {
      throw new Error("subscribe boom");
    },
    completeMemberRun: async () => {},
    logInfo: () => {},
    logError: (message) => errors.push(message),
  });
  assert.equal(disposedOld, 1, "订阅抛时旧句柄必须已撤下（不留半个句柄）");
  assert.equal(errors.length, 1, "订阅失败必须响亮留痕");
  assert.match(errors[0] ?? "", /订阅失败/);
});

/* ── 队长 run 的终态收口（P2b 余项）：走**与队员同一条出口**，成功入账动作不同 ──

   上一轮的缺口：`recordLeaderRun` 只把队长行登记成 `open`，而队长 run 没有队员那一步 review/merge
   ⇒ **成功的队长行长驻 `open`** ⇒ §5.7(1)「进行中」恒真 ⇒ 重复指派被永久合并。
   这里用**真实 runtime + 真实 sqlite 台账**驱动 `watchLeaderRunSettlement`，断言的是**实体状态**
   （`squadRunRepo.get(...).status`）：去掉 `completeLeaderRun` 的调用，本用例必须红。 */

test("队长 run 的终态收口：真实台账行从 open 走到终态（merged），且不动工作项状态", async () => {
  const { runtime, workItem } = await makeRuntimeWithWorkItem();
  const runId = "e:leader:wi-ls:1:0";
  // 派发桥的队长分支：只登记、不建树（队长无工作树，spec §6.1/§6.2），此时状态是 open。
  await runtime.lifecycle.recordLeaderRun({
    runId,
    workItemId: workItem.id,
    agentId: "ta-lead",
  });
  assert.equal(runtime.squadRunRepo.get(runId)?.status, "open", "登记后是 open（还没跑完）");
  assert.ok(
    runtime.squadRunRepo.listActive("ws").some((record) => record.runId === runId),
    "open 的队长行落在活跃集合里 —— 这正是「永不收缩、判据恒真」的那一格",
  );

  const logs: string[] = [];
  let terminal: ((outcome: SquadMemberRunTerminalOutcome) => void) | undefined;
  watchLeaderRunSettlement({
    runId,
    traceId: runId,
    subscribe: (listener) => {
      terminal = listener;
      return { dispose: () => {} };
    },
    completeLeaderRun: (settledRunId) =>
      runtime.lifecycle.completeLeaderRun({ runId: settledRunId }),
    logInfo: (message) => logs.push(message),
    logError: (message) => logs.push(message),
  });
  assert.equal(typeof terminal, "function", "订阅必须发生在 sendPrompt 之前，否则终态会被漏掉");

  // 终态到达（成功）⇒ 队长行收口到终态。
  terminal!({ inputId: runId, outcome: "succeeded" });
  await flushMicrotasks();

  assert.equal(
    runtime.squadRunRepo.get(runId)?.status,
    "merged",
    "队长 run 结束必须离开活跃集（否则 §5.7(1) 的「进行中」恒真）",
  );
  assert.ok(
    !runtime.squadRunRepo.listActive("ws").some((record) => record.runId === runId),
    "终态之后不得再留在活跃集",
  );
  assert.equal(
    runtime.workItemRepo.get(workItem.id)?.status,
    "in_progress",
    "§5.7(2)：队长 run **不得**改父项状态（套上 completeMemberRun 会推成 in_review）",
  );
  assert.ok(
    logs.some((line) => line.includes("merged")),
    "收口要留痕",
  );
});

test("队长 run 终态只认本次派发那一轮（inputId 不匹配 ⇒ 不结算，仍是 open）", async () => {
  const { runtime, workItem } = await makeRuntimeWithWorkItem();
  const runId = "e:leader:wi-ls-2:1:0";
  await runtime.lifecycle.recordLeaderRun({ runId, workItemId: workItem.id, agentId: "ta-lead" });
  let terminal: ((outcome: SquadMemberRunTerminalOutcome) => void) | undefined;
  watchLeaderRunSettlement({
    runId,
    traceId: runId,
    subscribe: (listener) => {
      terminal = listener;
      return { dispose: () => {} };
    },
    completeLeaderRun: (settledRunId) =>
      runtime.lifecycle.completeLeaderRun({ runId: settledRunId }),
    logInfo: () => {},
    logError: () => {},
  });
  // 用户插话 / 上一轮残留的终态：不是这次 run 的收官，不得把台账推到终态。
  terminal!({ inputId: "别的轮次", outcome: "succeeded" });
  await flushMicrotasks();
  assert.equal(runtime.squadRunRepo.get(runId)?.status, "open");
});

// 失败/中止**不得**冒充成功：唯一的成功入账动作是 `completeLeaderRun`（会置 merged）。
// 本用例只覆盖 `watchLeaderRunSettlement` 这一层（它不负责动用失败出口）；**生产上**由 host 的订阅闭包
// 用服务面的 `failMemberRun` 把它移出活跃集（与队员同一条出口）。
test("队长 run 终态是 failed/stopped ⇒ 不入账（仍是 open），但必须响亮留痕", async () => {
  const { runtime, workItem } = await makeRuntimeWithWorkItem();
  const runId = "e:leader:wi-ls-3:1:0";
  await runtime.lifecycle.recordLeaderRun({ runId, workItemId: workItem.id, agentId: "ta-lead" });
  const errors: string[] = [];
  let terminal: ((outcome: SquadMemberRunTerminalOutcome) => void) | undefined;
  watchLeaderRunSettlement({
    runId,
    traceId: runId,
    subscribe: (listener) => {
      terminal = listener;
      return { dispose: () => {} };
    },
    completeLeaderRun: (settledRunId) =>
      runtime.lifecycle.completeLeaderRun({ runId: settledRunId }),
    logInfo: () => {},
    logError: (message) => errors.push(message),
  });
  terminal!({ inputId: runId, outcome: "failed", error: "boom" });
  await flushMicrotasks();
  assert.equal(runtime.squadRunRepo.get(runId)?.status, "open", "失败不等于成功收口");
  assert.equal(errors.length, 1, "必须有一条 error 留痕（静默停在 open 才是要避免的）");
  assert.match(errors[0] ?? "", /未产出/);
  assert.match(errors[0] ?? "", /failMemberRun/);
});

test("队长 run 终态到达 ⇒ 释放订阅句柄（终态后不累积监听器）", async () => {
  const { runtime, workItem } = await makeRuntimeWithWorkItem();
  const runId = "e:leader:wi-ls-dispose:1:0";
  await runtime.lifecycle.recordLeaderRun({ runId, workItemId: workItem.id, agentId: "ta-lead" });
  let disposed = 0;
  let terminal: ((outcome: SquadMemberRunTerminalOutcome) => void) | undefined;
  watchLeaderRunSettlement({
    runId,
    traceId: runId,
    subscribe: (listener) => {
      terminal = listener;
      return {
        dispose: () => {
          disposed += 1;
        },
      };
    },
    completeLeaderRun: (settledRunId) =>
      runtime.lifecycle.completeLeaderRun({ runId: settledRunId }),
    logInfo: () => {},
    logError: () => {},
  });
  assert.equal(disposed, 0, "订阅后、终态前不得解绑");
  terminal!({ inputId: runId, outcome: "succeeded" });
  await flushMicrotasks();
  assert.equal(disposed, 1, "终态到达后必须解绑（否则每次派发累积一个监听器）");
  assert.equal(runtime.squadRunRepo.get(runId)?.status, "merged", "解绑不影响终态入账");
});

/* ---------- C4b：推进回路的结构守卫（行为级端到端归 T8 打包态） ---------- */

test("守卫｜队列推进回路接线齐全：结算回调 → advanceSquadQueueAfterSettlement → runSquadDispatch(重放) + 启动第四步", () => {
  const host = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/host/index.ts"),
    "utf8",
  );
  // ① 组合根回调接线（onSquadRunSettled → advance）。
  assert.match(
    host,
    /onSquadRunSettled: \(settlement\) =>\s*advanceSquadQueueAfterSettlement\(/,
    "结算事实必须接到推进回路（组合根 options）",
  );
  // ② 推进重投走唯一派发实现，且 trigger=replay（区别于人发起/规则到点）。
  assert.match(host, /trigger: "replay",/, "重投必须用 replay 触发源（语义与审计可区分）");
  // ③ A1 重验存在：排队行重投前判工作项终态/归档与名册（不验即复活已取消工作项的派发）。
  const advanceSlice = host.slice(
    host.indexOf("async function advanceSquadQueueAfterSettlement"),
    host.indexOf("async function dispatchSquadAssignment"),
  );
  // 分段验：排队循环与义务循环**各自**要重验（全函数 includes 会被另一循环的同款调用误绿）。
  const queuedLoop = advanceSlice.slice(0, advanceSlice.indexOf("claimDueSquadDeferredObligations"));
  const obligationLoop = advanceSlice.slice(advanceSlice.indexOf("claimDueSquadDeferredObligations"));
  for (const [name, loop] of [["排队行", queuedLoop], ["义务", obligationLoop]] as const) {
    assert.ok(loop.includes("isTerminalWorkItemStatus("), `${name}推进必须重验工作项终态（A1）`);
    assert.ok(loop.includes("archivedAt !== undefined"), `${name}推进必须重验归档（工作项与名册，A1）`);
  }
  assert.ok(advanceSlice.includes("discardQueuedSquadRun"), "重验不过必须收口排队行（不静默滞留）");
  assert.ok(advanceSlice.includes("claimDueSquadDeferredObligations"), "义务到期认领必须走服务面（恰一次）");
  assert.ok(advanceSlice.includes("failMemberRun"), "A2：认领后派发失败必须收口 open 行（防僵尸占容量）");
  // ④ 启动第四步（queue reconciliation）挂在第三步之后。
  const settleIdx = host.indexOf("await settleStaleLeaderRunsBestEffort(activeServices, candidates);");
  const queueIdx = host.indexOf('"queue reconciliation"');
  assert.ok(settleIdx >= 0 && queueIdx > settleIdx, "启动扫描第四步必须排在队长和解（第三步）之后");
});

/* ═══════════════ X2.1：评论派发通道（B/C） ═══════════════

   host 的派发桥不可在测试进程里整体运行（Electron parentPort / git / 会话），故这一轮把
   **分流判据与落定映射**抽成纯函数（可行为断言），接线（谁调谁、以什么身份调）用源码守卫钉。
   本节的每条断言都对应一个具体缺陷形态：评论义务走错重放账、queued 记成 failed、
   评论入口把 assignee 当目标、分流被摘除。 */

test("X2.1 重放分流：origin 决定重放通道（comment 不得走 R2 通道）", () => {
  assert.equal(replayChannelForObligationOrigin("reassign"), "reassign_replay");
  assert.equal(
    replayChannelForObligationOrigin("comment"),
    "comment_replay",
    "评论义务必须走评论重放账（目标可从 receipt 取，不必等于 assignee）",
  );
  assert.throws(
    () => replayChannelForObligationOrigin("bogus" as never),
    /origin/,
    "闭集外来源不得静默落到某条通道（静默 = 评论义务被 R2 重放）",
  );
});

test("X2.1 落定映射：四类派发结论如实映射（queued/coalesced/deferred 不得记 failed）", () => {
  assert.deepEqual(commentReceiptSettlementFor({ kind: "dispatched" }), { outcome: "opened" });
  assert.deepEqual(commentReceiptSettlementFor({ kind: "queued" }), { outcome: "queued" });
  assert.deepEqual(commentReceiptSettlementFor({ kind: "coalesced" }), { outcome: "coalesced" });
  assert.deepEqual(commentReceiptSettlementFor({ kind: "deferred" }), { outcome: "deferred" });
});

test("X2.1 落定映射：skip/门禁 ⇒ blocked（受限状态可审计）；其它失败按 permanent 分格；transient 不落定", () => {
  assert.deepEqual(
    commentReceiptSettlementFor({ kind: "blocked", reason: "指派的小队已归档：按归档语义跳过本次派发" }),
    { outcome: "blocked", detail: { reason: "指派的小队已归档：按归档语义跳过本次派发" } },
  );
  assert.deepEqual(commentReceiptSettlementFor({ kind: "failed", error: "work item not found: wi-x" }), {
    outcome: "failed",
    detail: { reason: "work item not found: wi-x" },
  });
  assert.equal(
    commentReceiptSettlementFor({ kind: "retry" }),
    null,
    "transient / 桥不可用 ⇒ 保持 pending 等重投，不得记 failed（那会把可重试写成终局失败）",
  );
});

test("X2.1 未收敛判定：pending/deferred 可认领；五个终局值不再执行", () => {
  assert.equal(isUnsettledCommentDispatchReceipt("pending"), true);
  assert.equal(isUnsettledCommentDispatchReceipt("deferred"), true);
  for (const terminal of ["opened", "queued", "coalesced", "blocked", "failed"] as const) {
    assert.equal(isUnsettledCommentDispatchReceipt(terminal), false, `${terminal} 是终局，不得重发执行`);
  }
});

test("X2.1 义务重放的事实校验：receipt 与义务必须同源（缺失/目标不符/工作项不符一律拒）", () => {
  const obligation = { runId: "cdk-1", workItemId: "wi-1", agentId: "ta-z" };
  const receipt = {
    dispatchKey: "cdk-1",
    workItemId: "wi-1",
    targetAgentId: "ta-z",
    outcome: "deferred" as const,
  };
  assert.deepEqual(commentObligationReplayFacts({ receipt, obligation }), {
    ok: true,
    dispatchKey: "cdk-1",
    targetAgentId: "ta-z",
    workItemId: "wi-1",
  });
  // receipt 缺失（数据被清 / 取错 workspace）：不得凭义务行现造 run。
  assert.equal(commentObligationReplayFacts({ receipt: null, obligation }).ok, false);
  // 目标与义务不符：不得把评论请求派给一个不是 receipt 里那个目标的人。
  assert.equal(
    commentObligationReplayFacts({
      receipt: { ...receipt, targetAgentId: "ta-other" },
      obligation,
    }).ok,
    false,
  );
  // 工作项不符：不得把评论请求挂到别的工作项上。
  assert.equal(
    commentObligationReplayFacts({ receipt: { ...receipt, workItemId: "wi-2" }, obligation }).ok,
    false,
  );
  // 身份不符：义务 id 与 receipt 主键必须同源（同一条请求的两个面）。
  assert.equal(
    commentObligationReplayFacts({
      receipt: { ...receipt, dispatchKey: "cdk-2" },
      obligation,
    }).ok,
    false,
  );
});

const hostSource = (): string =>
  readFileSync(
    join(resolve(dirname(fileURLToPath(import.meta.url)), "../src"), "host/index.ts"),
    "utf8",
  );

test("X2.1 接线：评论派发入口走唯一派发实现，eventKey=dispatchKey、目标来自 receipt", () => {
  const host = hostSource();
  const start = host.indexOf("async function dispatchCommentDispatch(");
  assert.ok(start >= 0, "host 没有评论派发入口（dispatchCommentDispatch）");
  const end = host.indexOf("async function dispatchSquadAssignment(", start);
  assert.ok(end > start, "找不到评论派发入口的结束边界");
  const body = host.slice(start, end);
  assert.match(body, /await runSquadDispatch\(/, "评论派发必须共用唯一派发实现（不另写建会话+发 prompt）");
  assert.match(body, /trigger: "comment"/, "评论派发必须用自己的 trigger 变体分流");
  assert.match(body, /targetAgentId: receipt\.targetAgentId/, "目标取自 receipt（B-1：可以是 assignee 之外的人）");
  assert.match(body, /eventKey: receipt\.dispatchKey/, "run 身份 = 评论 dispatchKey（同一评论重投落同一条 run）");
  assert.match(body, /settleCommentDispatchReceipt\(/, "每个结局都要回写 receipt outcome（七值闭集）");
  assert.match(body, /getCommentDispatchReceipt\(/, "评论派发入口按身份读 receipt 事实（不凭请求现造）");
});

test("X2.1 接线：义务重放的 origin 分流在 R2 重放之前（摘除 ⇒ 评论义务被 R2 通道重放）", () => {
  const host = hostSource();
  const start = host.indexOf("async function advanceSquadQueueAfterSettlement(");
  const end = host.indexOf("async function dispatchCommentDispatch(", start);
  assert.ok(start >= 0 && end > start, "找不到推进函数边界");
  const loop = host.slice(start, end);
  const splitAt = loop.indexOf("replayChannelForObligationOrigin(");
  const r2At = loop.indexOf("eventKey: obligation.runId");
  const commentCallAt = loop.indexOf("replayCommentObligation(");
  assert.ok(splitAt >= 0, "义务重放必须按 origin 分流（claimDue 读回的来源）");
  assert.ok(commentCallAt > splitAt, "comment 义务必须先进入评论重放通道");
  assert.ok(r2At > splitAt, "R2 重放（eventKey=obligation.runId）只属于 reassign 通道");
  assert.ok(commentCallAt < r2At, "分流必须发生在 R2 重放之前（否则评论义务先被 R2 消费）");
});

test("X2.1 接线：评论变体的成因只搬运（msg.cause），派发桥不写死任何成因档位", () => {
  const host = hostSource();
  const start = host.indexOf("async function runSquadDispatch(");
  const end = host.indexOf('parentPort.on("message",', start);
  const branch = host.slice(start, end);
  // 既有守卫的表达式原样保留（rule 就地、replay 带台账原成因、user/comment 搬运 msg.cause）。
  assert.match(
    branch,
    /msg\.trigger === "rule"\s*\?\s*"rule"\s*:\s*msg\.trigger === "replay"\s*\?\s*msg\.replayCause\s*:\s*msg\.cause/,
  );
  assert.doesNotMatch(branch, /dispatchCause\s*=\s*"(?:leader_tool|user_reassign|rule|comment)"/);
  // 评论变体必须带显式目标（B-1 的目标覆盖入参），否则会退回 assignee 推导。
  assert.match(branch, /targetOverride/, "评论派发必须把 targetAgentId 交给 planDispatch 的覆盖入参");
});
