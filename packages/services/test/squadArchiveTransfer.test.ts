import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { archiveSquadAndTransfer, createSquadRuntime } from "../src/workitem/squadRuntime.js";
import { createSquadRuntimeService } from "../src/workitem/squadRuntimeService.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* #9 归档转交（spec §3.10 生命周期细节 / §16 S10「归档交接」）。

   归档小队 ⇒ 其工作项指派**转交队长**。不转交的后果不会报错：归档后留下的指派指向一个
   不再接派发的小队（`planDispatch` 会按「已归档」skip，进 Inbox）——静默挂着，没有 run，
   要靠人去 Inbox 里反推「这个工作项为什么不动」。

   本文件用**真实的组合**（createSquadRuntime + createSquadRuntimeService）验证：
   转交发生在 `SquadService` **之外**（`archive(id)` 保持 F8 的无依赖签名，只做归档）。 */

async function setup() {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: "ws",
    readExperimentEnabled: () => true,
  });
  const target = { path: repoRoot, identity: "ws" };
  const svc = createSquadRuntimeService({
    createRuntime: async () => runtime,
    readExperimentEnabled: async () => true,
    // 注入形态是 `(target, id)`：组合根按目标现构 runtime 后再调那个组合函数（见 node.ts）。
    // 这里直接复用同一个 runtime（同一 db ⇒ 同一份台账），验证的是组合逻辑而不是装配。
    archiveSquadAndTransfer: async (_target, id) => archiveSquadAndTransfer(runtime, id),
  });
  return { repoRoot, runtime, svc, target };
}

/** 建一支「1 队长 + 1 队员」的小队，返回三人组（leader / member / squad）。 */
function makeSquad(runtime: Awaited<ReturnType<typeof setup>>["runtime"]) {
  const leader = runtime.teamAgentService.create({
    name: "L",
    systemPrompt: "s",
    memoryScope: "project",
  });
  const member = runtime.teamAgentService.create({
    name: "M",
    systemPrompt: "s",
    memoryScope: "project",
  });
  const squad = runtime.squadService.create({
    name: "sq",
    leaderAgentId: leader.id,
    members: [member.id],
    instructions: { stopCondition: "s", maxRounds: "1" },
  });
  return { leader, member, squad };
}

function makeItem(
  runtime: Awaited<ReturnType<typeof setup>>["runtime"],
  repoRoot: string,
  title: string,
  assignee: { type: "user" | "agent" | "squad"; id: string },
) {
  return runtime.workItemService.create({
    workspaceIdentity: "ws",
    workspacePath: repoRoot,
    title,
    assignee,
  });
}

// spec §3.10 / §16 S10：归档小队 ⇒ 其工作项指派与排班**转交队长**。
test("archive 把该小队的指派转交队长", async () => {
  const { repoRoot, runtime, svc, target } = await setup();
  const { leader, squad } = makeSquad(runtime);
  const item = makeItem(runtime, repoRoot, "t", { type: "squad", id: squad.id });

  await svc.archiveSquadAndTransfer(target, squad.id);

  assert.deepEqual(runtime.workItemRepo.get(item.id)!.assignee, { type: "agent", id: leader.id });
  // 归档本身也生效（转交不是「顺手跳过归档」的借口）。
  assert.ok(runtime.squadService.get(squad.id)!.archivedAt !== undefined);
});

// #9 的**复查口径**：转交之后，还有没有指向已归档小队的指派？——`listByAssignee` 必须给出空集。
// 多个工作项都要转（只转第一个是最容易漏的半拉子实现）。
test("转交覆盖该小队的全部工作项，且不留残余指派", async () => {
  const { repoRoot, runtime, svc, target } = await setup();
  const { leader, squad } = makeSquad(runtime);
  const items = [
    makeItem(runtime, repoRoot, "a", { type: "squad", id: squad.id }),
    makeItem(runtime, repoRoot, "b", { type: "squad", id: squad.id }),
    makeItem(runtime, repoRoot, "c", { type: "squad", id: squad.id }),
  ];

  await svc.archiveSquadAndTransfer(target, squad.id);

  for (const item of items) {
    assert.deepEqual(runtime.workItemRepo.get(item.id)!.assignee, { type: "agent", id: leader.id });
  }
  assert.deepEqual(runtime.workItemRepo.listByAssignee("squad", squad.id), []);
});

// 补集方向：**不该动**的指派一个都不许动。转交按 `assignee = (squad, id)` 过滤，
// 不是「把工作区里所有指派改成队长」——后者会把别人的活静默改派。
test("转交不误伤：别的 agent / 别的 squad 的指派原样保留", async () => {
  const { repoRoot, runtime, svc, target } = await setup();
  const { leader, member, squad } = makeSquad(runtime);
  const other = makeSquad(runtime);
  const mine = makeItem(runtime, repoRoot, "mine", { type: "squad", id: squad.id });
  const otherAgent = makeItem(runtime, repoRoot, "other-agent", { type: "agent", id: member.id });
  const otherSquad = makeItem(runtime, repoRoot, "other-squad", {
    type: "squad",
    id: other.squad.id,
  });

  await svc.archiveSquadAndTransfer(target, squad.id);

  assert.deepEqual(runtime.workItemRepo.get(mine.id)!.assignee, { type: "agent", id: leader.id });
  assert.deepEqual(runtime.workItemRepo.get(otherAgent.id)!.assignee, {
    type: "agent",
    id: member.id,
  });
  assert.deepEqual(runtime.workItemRepo.get(otherSquad.id)!.assignee, {
    type: "squad",
    id: other.squad.id,
  });
  assert.ok(runtime.squadService.get(other.squad.id)!.archivedAt === undefined);
});

// 该小队没有工作项时归档仍然成功：不能因为「没东西可转交」就抛
// （否则「先建档再归档」这种正常路径会被一个空集卡住）。
test("没有工作项的小队也能归档", async () => {
  const { runtime, svc, target } = await setup();
  const { squad } = makeSquad(runtime);
  await svc.archiveSquadAndTransfer(target, squad.id);
  assert.ok(runtime.squadService.get(squad.id)!.archivedAt !== undefined);
});

// 幂等/修复路径：已归档的小队再调一次，仍然把（此前漏转的）指派转交过去。
// 这条覆盖「转交与归档中途崩溃」的恢复：`SquadService.archive` 对已归档行早退，
// 所以转交**不能**藏在它里面（藏进去的话这一格永远修不回来）。
test("重复归档仍然转交（崩溃后修复路径）", async () => {
  const { repoRoot, runtime, svc, target } = await setup();
  const { leader, squad } = makeSquad(runtime);
  // 模拟「归档完成了、转交没落」的残局：先直接归档，再补一条指向该小队的指派。
  runtime.squadService.archive(squad.id);
  const late = makeItem(runtime, repoRoot, "late", { type: "squad", id: squad.id });

  await svc.archiveSquadAndTransfer(target, squad.id);

  assert.deepEqual(runtime.workItemRepo.get(late.id)!.assignee, { type: "agent", id: leader.id });
  assert.deepEqual(runtime.workItemRepo.listByAssignee("squad", squad.id), []);
});

// 小队不存在 ⇒ 抛（静默「当作已归档」会让调用方以为转交完成了）。
test("小队不存在 ⇒ 抛", async () => {
  const { svc, target } = await setup();
  await assert.rejects(() => svc.archiveSquadAndTransfer(target, "no-such-squad"), /no-such-squad/);
});
