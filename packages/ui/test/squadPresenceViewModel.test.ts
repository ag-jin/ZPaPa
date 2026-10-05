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
  assert.equal(idle.workload, "idle", "无 open 无 queued ⇒ idle（runningCount=0 不渲染 Working·0）");
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
