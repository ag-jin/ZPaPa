import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { WorkItem } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { applyWorkItemAssignee } from "../src/workitem/workItemAssignee.js";
import { archiveSquadAndTransfer, createSquadRuntime } from "../src/workitem/squadRuntime.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import { createWorkItemActivityProjector } from "../src/workitem/workItemActivityProjector.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";
import { createWorkItemService, type WorkItemEvent } from "../src/workitem/workItemService.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* C3b.1：投影的**生产接线**（设计 §3.2 逐枚落位 / §9 C3b.1 验收 ①–③⑥）。

   断言全部落在**已落库的事实**上（activities 行 / 工作项行 / 事件序列），不是返回值回声。
   期望值是手写字面量（独立真源 = 设计 §5 表 + spec §8.1「CAS 未命中不得补发伪造的 status_changed」）。 */

const WORKSPACE = { path: "/tmp/c3b1-wiring-ws", identity: "c3b1-wiring-ws" };
const CLOCK = 1_700_000_000_000;

function setup(options: { now?: () => number } = {}) {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const workItems = createWorkItemRepo(db);
  const activities = createWorkItemActivityRepo(db);
  const events: WorkItemEvent[] = [];
  const warnings: string[] = [];
  const projector = createWorkItemActivityProjector({
    activities,
    now: options.now ?? (() => CLOCK),
    logWarn: (message) => warnings.push(message),
  });
  const service = createWorkItemService({
    repo: workItems,
    emit: (event) => events.push(event),
    activityProjector: projector,
  });
  const createItem = (overrides: Partial<WorkItem> = {}): WorkItem =>
    service.create({
      workspaceIdentity: WORKSPACE.identity,
      workspacePath: WORKSPACE.path,
      title: "网关改造",
      body: "",
      assignee: { type: "user", id: "u-1" },
      ...(overrides.id !== undefined ? { id: overrides.id } : {}),
      ...(overrides.assignee !== undefined ? { assignee: overrides.assignee } : {}),
    });
  return { db, workItems, activities, events, warnings, projector, service, createItem };
}

test("transition：CAS 命中 ⇒ 恰一枚 status_changed；CAS 未命中 ⇒ 零枚（不得补发伪造事实）", () => {
  const f = setup();
  const item = f.createItem();

  assert.equal(f.service.transition(item.id, "in_progress", "todo"), true, "第一次 CAS 应命中");
  const afterHit = f.activities.listByWorkItem(WORKSPACE.identity, item.id);
  assert.equal(afterHit.length, 1, "命中恰投影一枚");
  assert.equal(afterHit[0]!.kind, "status_changed");
  assert.equal(afterHit[0]!.dedupKey, `status:${item.id}:todo:in_progress:${CLOCK}`);
  assert.deepEqual(afterHit[0]!.payload, { from: "todo", to: "in_progress" });

  // 前置已不是 todo ⇒ CAS 未命中 = 事实未发生（spec §8.1）：不得投影、不得发事件。
  assert.equal(f.service.transition(item.id, "done", "todo"), false);
  assert.equal(
    f.activities.listByWorkItem(WORKSPACE.identity, item.id).length,
    1,
    "CAS 未命中不得投影（与既有「未命中不得补发」纪律同一条）",
  );
  assert.equal(f.events.filter((event) => event.kind === "workitem.status_changed").length, 1);
});

/* ---------- 真实组合（runtime）上的两个 assignee 写者 ---------- */

/** 真 git 仓库 + `:memory:` 库 + 真 runtime（与 squadReassign / squadArchiveTransfer 同款装配）。 */
async function makeRuntimeFixture() {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: WORKSPACE.identity,
    readExperimentEnabled: () => true,
  });
  // 与 runtime 同一条 db：读回口径与生产读面一致（repo 只是这条连接的薄壳）。
  const activities = createWorkItemActivityRepo(db);
  const createItem = (assignee: WorkItem["assignee"]): WorkItem =>
    runtime.workItemService.create({
      workspaceIdentity: WORKSPACE.identity,
      workspacePath: WORKSPACE.path,
      title: "网关改造",
      body: "",
      assignee,
    });
  return { repoRoot, runtime, activities, createItem };
}

test("改派写者：真改派 ⇒ 恰一枚 assignee_changed（cause 原样透传）；同值 skip ⇒ 零枚", async () => {
  const f = await makeRuntimeFixture();
  const item = f.createItem({ type: "agent", id: "ta-a" });

  const outcome = applyWorkItemAssignee(
    f.runtime,
    { workItemId: item.id, assignee: { type: "user", id: "u-1" } },
    { sameAssignee: "skip", cause: "user_reassign" },
  );
  assert.deepEqual(outcome, { assigned: true });
  const rows = f.activities.listByWorkItem(WORKSPACE.identity, item.id);
  assert.equal(rows.length, 1, "真改派恰投影一枚");
  assert.equal(rows[0]!.kind, "assignee_changed");
  assert.deepEqual(rows[0]!.payload, {
    from: { type: "agent", id: "ta-a" },
    to: { type: "user", id: "u-1" },
    cause: "user_reassign",
  });
  assert.ok(
    rows[0]!.dedupKey.startsWith(`assignee:${item.id}:agent:ta-a:user:u-1:`),
    "键形状与冻结口径逐段一致（尾段是投影时刻的毫秒）",
  );
  assert.match(rows[0]!.dedupKey, /:\d+$/, "尾段是毫秒时间戳");

  // 同一事实重投（同值 skip）：不写、不发 ⇒ 也不得投影（不得凭空多一条时间线）。
  applyWorkItemAssignee(
    f.runtime,
    { workItemId: item.id, assignee: { type: "user", id: "u-1" } },
    { sameAssignee: "skip", cause: "user_reassign" },
  );
  assert.equal(
    f.activities.listByWorkItem(WORKSPACE.identity, item.id).length,
    1,
    "同值 skip 零枚（与「不写不发」同一条纪律）",
  );
});

test("改派写者：队长派单工具成因（leader_tool）原样进 payload（投影只搬运、不二次判定）", async () => {
  const f = await makeRuntimeFixture();
  const item = f.createItem({ type: "squad", id: "sq-1" });

  applyWorkItemAssignee(
    f.runtime,
    { workItemId: item.id, assignee: { type: "agent", id: "ta-b" } },
    { sameAssignee: "reapply", cause: "leader_tool" },
  );

  const rows = f.activities.listByWorkItem(WORKSPACE.identity, item.id);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.payload, {
    from: { type: "squad", id: "sq-1" },
    to: { type: "agent", id: "ta-b" },
    cause: "leader_tool",
  });
});

test("归档转交写者：逐项恰一枚 assignee_changed，无 cause（不发明闭集外值）", async () => {
  const f = await makeRuntimeFixture();
  const leader = f.runtime.teamAgentService.create({
    name: "L",
    systemPrompt: "s",
    memoryScope: "project",
  });
  const member = f.runtime.teamAgentService.create({
    name: "M",
    systemPrompt: "s",
    memoryScope: "project",
  });
  const squad = f.runtime.squadService.create({
    name: "sq",
    leaderAgentId: leader.id,
    members: [member.id],
    instructions: { stopCondition: "s", maxRounds: "1" },
  });
  const items = [
    f.createItem({ type: "squad", id: squad.id }),
    f.createItem({ type: "squad", id: squad.id }),
  ];

  await archiveSquadAndTransfer(f.runtime, squad.id);

  for (const item of items) {
    const rows = f.activities.listByWorkItem(WORKSPACE.identity, item.id);
    assert.equal(rows.length, 1, `工作项 ${item.id} 的转交恰投影一枚`);
    assert.equal(rows[0]!.kind, "assignee_changed");
    assert.deepEqual(rows[0]!.payload, {
      from: { type: "squad", id: squad.id },
      to: { type: "agent", id: leader.id },
    });
    assert.ok(!("cause" in rows[0]!.payload), "归档转交不是派发：不得伪造成因");
    assert.ok(
      rows[0]!.dedupKey.startsWith(`assignee:${item.id}:squad:${squad.id}:agent:${leader.id}:`),
    );
  }
});

test("接线钉死：createSquadRuntime 恒构造投影器，且 transition 经它投影（防「忘了接线、只留 warn」）", async () => {
  const f = await makeRuntimeFixture();
  assert.ok(f.runtime.activityProjector, "runtime 契约上恒有投影器（组合根不得漏接）");

  const item = f.createItem({ type: "user", id: "u-1" });
  assert.equal(f.runtime.workItemService.transition(item.id, "in_progress", "todo"), true);
  const rows = f.activities.listByWorkItem(WORKSPACE.identity, item.id);
  assert.equal(rows.length, 1, "经 runtime 的 transition 必须投影（证明服务面拿到了同一个投影器）");
  assert.equal(rows[0]!.kind, "status_changed");
});
