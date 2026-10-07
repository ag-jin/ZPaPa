import assert from "node:assert/strict";
import test from "node:test";
import type { SquadRunRecord, SquadRunStatus } from "@zcode/services";
import type { TeamAgent } from "@zcode/shared";
import { buildAgentPresence } from "../src/squad/squadPresenceViewModel.js";

/* T5 presence view model 的判定矩阵（T4 裁定②③ + C5 数据源契约）：
   · working 判据 = status === "open"（**不是**活跃三态：produced/rejected 是「占树待人审」不是「在跑」）；
   · queued 只来自 C5 的 queuedRuns 契约字段（UI 不得从任何其它口径推测排队）；
   · 穷尽映射表（U 归属，先例 runReviewable）：Record<SquadRunStatus,…> 让加状态时编译强制到这里。 */

const agent = (over: Partial<TeamAgent> = {}): TeamAgent => ({
  id: "ta-1",
  name: "a",
  systemPrompt: "s",
  skills: [],
  memoryScope: "project",
  enabled: true,
  ...over,
});

const run = (over: Partial<SquadRunRecord> & { status: SquadRunStatus }): SquadRunRecord => ({
  runId: `run-${Math.random().toString(36).slice(2)}`,
  workspaceKey: "ws",
  workspacePath: "/tmp/ws",
  workItemId: "wi",
  parentWorkItemId: "wi",
  agentId: "ta-1",
  isLeaderTask: false,
  branch: null,
  dirName: null,
  sessionId: null,
  dispatchCause: null,
  causedByRunId: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

test("矩阵：availability——archivedAt 优先于 enabled；disabled 不给 workload", () => {
  const archived = buildAgentPresence(
    agent({ archivedAt: 1, enabled: false }),
    [run({ status: "open", agentId: "ta-1" })],
    [],
  );
  assert.equal(archived.availability, "archived", "归档优先（历史条目不可运行）");
  assert.equal(archived.workload, null, "归档不给工作档（不显示可运行状态）");

  const disabled = buildAgentPresence(agent({ enabled: false }), [run({ status: "open" })], []);
  assert.equal(disabled.availability, "disabled");
  assert.equal(disabled.workload, null, "停用不给工作档");
});

test("矩阵：working = count(open)（穷尽映射，非活跃三态）——produced/rejected/queued 不计", () => {
  const presence = buildAgentPresence(
    agent(),
    [
      run({ status: "open" }),
      run({ status: "open" }),
      run({ status: "produced" }),
      run({ status: "rejected" }),
      run({ status: "merged" }),
      run({ status: "discarded" }),
    ],
    [],
  );
  assert.equal(presence.workload, "working");
  assert.equal(presence.runningCount, 2, "只数 open（produced/rejected 占树≠在跑，T4 裁定②）");
  assert.equal(presence.queuedCount, 0);
});

test("矩阵：无 open 有 queued ⇒ queued；open+queued 并存 ⇒ working 双值；全无 ⇒ idle", () => {
  const queuedOnly = buildAgentPresence(agent(), [], [run({ status: "queued" })]);
  assert.equal(queuedOnly.workload, "queued");
  assert.equal(queuedOnly.queuedCount, 1);

  const both = buildAgentPresence(agent(), [run({ status: "open" })], [run({ status: "queued" })]);
  assert.equal(both.workload, "working", "working 优先呈现（排队作 +M 追加值，双值显示）");
  assert.equal(both.runningCount, 1);
  assert.equal(both.queuedCount, 1, "双值：working 时 queuedCount 仍要给出（+M 排队）");

  const idle = buildAgentPresence(agent(), [run({ status: "produced" })], []);
  assert.equal(
    idle.workload,
    "idle",
    "无 open 无 queued ⇒ idle（runningCount=0 不渲染 Working·0）",
  );
  assert.equal(idle.runningCount, 0);
});

test("口径：只数本 agent 的行（跨 agent 不串）；queuedRuns 同口径过滤", () => {
  const presence = buildAgentPresence(
    agent({ id: "ta-1" }),
    [run({ status: "open", agentId: "ta-2" }), run({ status: "open", agentId: "ta-1" })],
    [run({ status: "queued", agentId: "ta-2" }), run({ status: "queued", agentId: "ta-1" })],
  );
  assert.equal(presence.runningCount, 1);
  assert.equal(presence.queuedCount, 1);
});

/* ---------- T6：小队聚合 presence + 头像堆叠投影 ---------- */
import { buildSquadPresence } from "../src/squad/squadPresenceViewModel.js";
import type { Squad } from "@zcode/shared";

const squadOf = (over: Partial<Squad> & { members: Squad["members"] }): Squad => ({
  id: "sq-1",
  name: "s",
  leaderAgentId: "ta-1",
  instructions: { stopCondition: "x", maxRounds: "3" },
  enabled: true,
  ...over,
});
const member = (agentId: string) => ({ agentId });

test("聚合：runningCount = Σ 成员 count(open)（队长计入）；queued 同口径；跨队重复计数显式成立", () => {
  const roster = [agent({ id: "ta-1" }), agent({ id: "ta-2" }), agent({ id: "ta-3" })];
  const presence = buildSquadPresence(
    squadOf({ members: [member("ta-1"), member("ta-2")] }),
    roster,
    [
      run({ status: "open", agentId: "ta-1" }), // 队长在跑 ⇒ 计入（口径注意③）
      run({ status: "open", agentId: "ta-2" }),
      run({ status: "open", agentId: "ta-9" }), // 名册外/别队 agent ⇒ 不计（按成员过滤）
      run({ status: "produced", agentId: "ta-2" }),
    ],
    [run({ status: "queued", agentId: "ta-2" })],
  );
  assert.equal(presence.workload, "working");
  assert.equal(presence.runningCount, 2, "Σ 成员 count(open)（队长计入，produced 不计）");
  assert.equal(presence.queuedCount, 1);
  // 口径注意①（写死断言）：同一 agent 属两个队 ⇒ 两张卡各自全数——聚合是**按卡**口径，
  // 全局求和会重复；这是既定口径不是缺陷（S4 §2.6），UI 不得悄悄去重。
  const other = buildSquadPresence(
    squadOf({ id: "sq-2", members: [member("ta-2")] }),
    roster,
    [run({ status: "open", agentId: "ta-2" })],
    [],
  );
  assert.equal(other.runningCount, 1, "跨队成员在每张卡上都计（口径①：按卡不去重）");
});

test("头像堆叠：可见 3 + '+N'；成员数排除归档与名册外；归档小队不给 workload", () => {
  const roster = [
    agent({ id: "ta-1" }),
    agent({ id: "ta-2" }),
    agent({ id: "ta-3", archivedAt: 1 }), // 归档成员：不入头像与成员数
    agent({ id: "ta-4" }),
    agent({ id: "ta-5" }),
    agent({ id: "ta-6", name: "ghost" }), // 名册在但…
  ];
  const five = buildSquadPresence(
    squadOf({
      members: [member("ta-1"), member("ta-2"), member("ta-3"), member("ta-4"), member("ta-5")],
    }),
    roster,
    [],
    [],
  );
  assert.equal(five.activeMemberCount, 4, "归档成员不计（名册可变的口径注意②同源）");
  assert.equal(five.avatarStack.length, 3, "可见头像至多 3");
  assert.equal(five.avatarOverflow, 1, "溢出 +N");
  // 名册外成员（查不到定义）：不计入头像/成员数（不猜颜色不猜身份）。
  const ghost = buildSquadPresence(
    squadOf({ members: [member("ta-1"), member("ta-x")] }),
    roster,
    [],
    [],
  );
  assert.equal(ghost.activeMemberCount, 1, "名册外成员不计（口径注意②）");
  // 归档小队：availability=archived、无 workload（不显示可运行状态）。
  const archived = buildSquadPresence(
    squadOf({ archivedAt: 1, members: [member("ta-1")] }),
    roster,
    [run({ status: "open", agentId: "ta-1" })],
    [],
  );
  assert.equal(archived.availability, "archived");
  assert.equal(archived.workload, null);
});
