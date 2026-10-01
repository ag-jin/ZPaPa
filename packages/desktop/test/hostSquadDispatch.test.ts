import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SQUAD_DISPATCH_DISABLED_CODE, SquadDispatchDisabledError } from "@zcode/services";
import { createBoundSessionExecutingProbe } from "../src/host/boundSessionBusyGate.js";
import { decideSquadDispatch, isSquadDispatchDisabledError } from "../src/host/squadDispatch.js";

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
  const branch = src.slice(start, start + 6000);
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

// 硬约束 1 的**行为**证据（不只是源码文本）：投影判据（tasks-index 里残留的 status=running）
// 与强探测的结论会**相反**——强探测读 Agent runtime 快照，残留行不会被当成忙。
test("投影是 running 但 runtime 未在执行 ⇒ 强探测判不忙，派发放行", async () => {
  const probe = createBoundSessionExecutingProbe({
    // 只有投影（旧栈的任务状态）说「在跑」，runtime 快照里没有任何真实阻塞运行态。
    agentService: { readSession: async () => ({ runtime: {}, projection: {} }) as never },
    logWarn: () => {},
  });
  assert.equal(await probe({ sessionId: "s-1", workspacePath: "/ws" }), false);
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
