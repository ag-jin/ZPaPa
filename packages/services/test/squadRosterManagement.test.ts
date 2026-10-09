import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Squad } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { resolveSquadDefinitionRoot } from "../src/teams/squadStorage.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import { createSquadOrchestrator } from "../src/workitem/squadOrchestrator.js";
import { archiveSquadAndTransfer, createSquadRuntime } from "../src/workitem/squadRuntime.js";
import {
  createSquadRuntimeService,
  type ISquadRuntimeService,
  type SquadWorkspaceTarget,
} from "../src/workitem/squadRuntimeService.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* 小队**名册管理**两个服务面方法（updateSquad / setSquadEnabled，2026-10-03 加法）的用例。
   装配照 squadTeamAgentManagement.test.ts 的同一先例：真实 git 仓库 + `:memory:` sqlite +
   真实 runtime + 真实服务面 —— 不给服务面塞桩，否则断言的是桩的行为而不是实现。

   为什么断言必须读**实体状态**（快照读回 / 直接读 `<ws>/.zcode/squad/squads/<id>.json`）：
   返回值是调用方给的那份数据的回声，读盘才有独立信息。

   口径纪律：目标 workspace **显式构造**并用 `seenTargets` 证明服务把**调用方给的**目标原样
   交给 runtime（没有隐式默认 workspace）；写者纪律不变（服务面只经注入的 squadService，
   归档**不新增方法**——UI 直接调既有的 archiveSquadAndTransfer，见本文件最后一条用例）。 */

const target = (identity: string): SquadWorkspaceTarget => ({
  path: `/tmp/${identity}`,
  identity,
});

async function makeMemoryDb(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return db;
}

/** 真实 runtime + 真实服务面（照 squadTeamAgentManagement.test.ts 的装配法）。 */
async function makeService() {
  const repoRoot = await makeRepo();
  const db = await makeMemoryDb();
  const state = { enabled: true };
  /** 记录服务面收到的目标 —— 证明服务面把**调用方给的**目标原样交给 runtime。 */
  const seenTargets: string[] = [];
  const createRuntime = async (t: SquadWorkspaceTarget): Promise<SquadRuntime> => {
    seenTargets.push(`${t.path}|${t.identity}`);
    return createSquadRuntime({
      db,
      workspacePath: repoRoot,
      workspaceIdentity: t.identity,
      readExperimentEnabled: () => state.enabled,
    });
  };
  const squadRuntimeService: ISquadRuntimeService = createSquadRuntimeService({
    createRuntime,
    readExperimentEnabled: async () => state.enabled,
    archiveSquadAndTransfer: async (t, id) => archiveSquadAndTransfer(await createRuntime(t), id),
    createOrchestrator: createSquadOrchestrator,
  });
  return {
    repoRoot,
    squadRuntimeService,
    seenTargets,
    setExperimentEnabled: (value: boolean) => {
      state.enabled = value;
    },
  };
}

/** 直接读盘：定义文件的实体状态（不经服务、不经 runtime）。 */
function readSquadFile(repoRoot: string, id: string): Squad {
  return JSON.parse(readFileSync(join(resolveSquadDefinitionRoot(repoRoot), `${id}.json`), "utf8"));
}

const WS = target("ws");

/** 建一支小队（名册管理用例的起点）。 */
async function createSquad(service: ISquadRuntimeService, name = "第 1 小队"): Promise<Squad> {
  return service.createSquad(WS, {
    name,
    leaderAgentId: "ta_lead",
    members: ["ta_m1"],
    instructions: { stopCondition: "全部 done 即收工", maxRounds: "5" },
  });
}

test("updateSquad 改名册四项，快照读回新值（指令未给的槽位保留）", async () => {
  const { squadRuntimeService } = await makeService();
  const squad = await createSquad(squadRuntimeService);

  const updated = await squadRuntimeService.updateSquad(WS, {
    id: squad.id,
    patch: {
      name: "第 2 小队",
      leaderAgentId: "ta_m1",
      members: ["ta_m1", "ta_m2"],
      instructions: { goal: "把网关改完" },
    },
  });
  assert.equal(updated.id, squad.id, "编辑不换身份：id 不变");

  const snapshot = await squadRuntimeService.getSnapshot(WS);
  const readBack = snapshot.squads.find((entry) => entry.id === squad.id);
  assert.ok(readBack, "编辑后仍然列在快照里");
  assert.equal(readBack.name, "第 2 小队");
  assert.equal(readBack.leaderAgentId, "ta_m1");
  assert.deepEqual(
    readBack.members.map((member) => [member.agentId, member.role]),
    [
      ["ta_m1", "leader"],
      ["ta_m2", undefined],
    ],
    "队长置首、其余按给定顺序（与 create 同一条组装规则）",
  );
  assert.equal(readBack.instructions.goal, "把网关改完");
  assert.equal(readBack.instructions.stopCondition, "全部 done 即收工", "未提供的槽位原样保留");
  assert.equal(readBack.instructions.maxRounds, "5");
});

test("setSquadEnabled：停用 / 启用都被读回（读盘 + 快照）", async () => {
  const { repoRoot, squadRuntimeService } = await makeService();
  const squad = await createSquad(squadRuntimeService);

  await squadRuntimeService.setSquadEnabled(WS, { id: squad.id, enabled: false });
  assert.equal(readSquadFile(repoRoot, squad.id).enabled, false);
  assert.equal(
    (await squadRuntimeService.getSnapshot(WS)).squads.find((entry) => entry.id === squad.id)
      ?.enabled,
    false,
  );

  await squadRuntimeService.setSquadEnabled(WS, { id: squad.id, enabled: true });
  assert.equal(readSquadFile(repoRoot, squad.id).enabled, true);
});

test("updateSquad / setSquadEnabled：id 不存在 ⇒ 响亮抛", async () => {
  const { squadRuntimeService } = await makeService();

  await assert.rejects(
    () => squadRuntimeService.updateSquad(WS, { id: "不存在", patch: { name: "谁" } }),
    /小队不存在：不存在/,
    "静默 no-op 会让界面以为改成功了",
  );
  await assert.rejects(
    () => squadRuntimeService.setSquadEnabled(WS, { id: "不存在", enabled: false }),
    /小队不存在：不存在/,
  );
});

// 名册管理**不过门禁**（§5.7.6 只停新派发）：开关关掉时两个方法照常可用。
// 这不是"漏判"：门禁的唯一判据在 assertDispatchEnabled，名册管理不产生新派发。
test("小队名册管理不受实验开关影响（不过门禁）：关掉开关后编辑 / 启停仍可用", async () => {
  const { repoRoot, squadRuntimeService, setExperimentEnabled } = await makeService();
  const squad = await createSquad(squadRuntimeService);

  setExperimentEnabled(false);

  const updated = await squadRuntimeService.updateSquad(WS, {
    id: squad.id,
    patch: { name: "开关关了也能改名" },
  });
  assert.equal(updated.name, "开关关了也能改名");
  await squadRuntimeService.setSquadEnabled(WS, { id: squad.id, enabled: false });
  assert.equal(readSquadFile(repoRoot, squad.id).enabled, false);
});

test("目标纪律：两个方法都把调用方给的目标原样交给 runtime（没有隐式默认 workspace）", async () => {
  const { squadRuntimeService, seenTargets } = await makeService();
  const squad = await createSquad(squadRuntimeService);
  seenTargets.length = 0;

  const given: SquadWorkspaceTarget = { path: "/tmp/given-ws", identity: "given" };
  await squadRuntimeService.updateSquad(given, { id: squad.id, patch: { name: "改" } });
  await squadRuntimeService.setSquadEnabled(given, { id: squad.id, enabled: false });

  assert.deepEqual(
    seenTargets,
    ["/tmp/given-ws|given", "/tmp/given-ws|given"],
    "两次调用都必须带着调用方显式给的目标（原样透传，不挑不猜）",
  );
});

// 归档**不新增方法**（本轮口径）：UI 直接调既有的 archiveSquadAndTransfer，经同一服务面
// 完成「转交 + 归档」。这条用例把 UI 将走的那条路原样跑通，防止有人日后又加第三个写入口。
test("归档经既有 archiveSquadAndTransfer：工作项转交队长 + 花名册与指令保留", async () => {
  const { repoRoot, squadRuntimeService } = await makeService();
  const squad = await createSquad(squadRuntimeService);
  const item = await squadRuntimeService.createWorkItem(WS, {
    title: "网关改造",
    assignee: { type: "squad", id: squad.id },
  });

  await squadRuntimeService.archiveSquadAndTransfer(WS, squad.id);

  const onDisk = readSquadFile(repoRoot, squad.id);
  assert.equal(typeof onDisk.archivedAt, "number", "归档写的是时间戳");
  assert.deepEqual(onDisk.members, squad.members, "归档不是硬删：花名册保留");
  assert.deepEqual(onDisk.instructions, squad.instructions, "指令保留");
  const snapshot = await squadRuntimeService.getSnapshot(WS);
  assert.deepEqual(
    snapshot.workItems.find((entry) => entry.id === item.id)?.assignee,
    { type: "agent", id: "ta_lead" },
    "指派给该小队的工作项转交给队长（这是确认文案里承诺的后果）",
  );
});
