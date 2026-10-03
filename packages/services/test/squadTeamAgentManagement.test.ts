import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { TeamAgent } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { resolveSquadAgentRoot } from "../src/teams/teamAgentStorage.js";
import type { TeamAgentEditablePatch } from "../src/teams/teamAgentService.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import { createSquadOrchestrator } from "../src/workitem/squadOrchestrator.js";
import { archiveSquadAndTransfer, createSquadRuntime } from "../src/workitem/squadRuntime.js";
import {
  createSquadRuntimeService,
  type ISquadRuntimeService,
  type SquadWorkspaceTarget,
} from "../src/workitem/squadRuntimeService.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* 协作智能体**名册管理**三个服务面方法（updateTeamAgent / setTeamAgentEnabled / archiveTeamAgent，
   2026-10-03 加法）的用例。装配照 squadProtocolMethods.test.ts 的同一先例：真实 git 仓库 +
   `:memory:` sqlite + 真实 runtime + 真实服务面 —— 不给服务面塞桩，否则断言的是桩的行为而不是实现。

   为什么断言必须读**实体状态**（服务读回 / 直接读 `<ws>/.zcode/squad/agents/<id>.json`）：
   返回值是调用方给的那份数据的回声，读盘才有独立信息。尤其"白名单承重"一格 ——
   `enabled` / `archivedAt` 是否被越权改写，只有写盘后的文件说了算。

   口径纪律：目标 workspace **显式构造**并用 `seenTargets` 证明服务把**调用方给的**目标原样
   交给 runtime（没有隐式默认 workspace）；写者纪律不变（服务面只经注入的 teamAgentService）。 */

const target = (identity: string): SquadWorkspaceTarget => ({
  path: `/tmp/${identity}`,
  identity,
});

async function makeMemoryDb(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return db;
}

/** 真实 runtime + 真实服务面（照 squadProtocolMethods.test.ts 的装配法）。 */
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
function readDefinitionFile(repoRoot: string, id: string): TeamAgent {
  return JSON.parse(readFileSync(join(resolveSquadAgentRoot(repoRoot), `${id}.json`), "utf8"));
}

const WS = target("ws");

/** 建一个智能体（名册管理用例的起点）。 */
async function createAgent(service: ISquadRuntimeService, name = "张三"): Promise<TeamAgent> {
  return service.createTeamAgent(WS, {
    name,
    systemPrompt: "你是张三",
    memoryScope: "project",
  });
}

test("updateTeamAgent 改三项可编辑字段，快照读回新值", async () => {
  const { squadRuntimeService } = await makeService();
  const agent = await createAgent(squadRuntimeService);

  const updated = await squadRuntimeService.updateTeamAgent(WS, {
    id: agent.id,
    patch: { name: "李四", systemPrompt: "你是李四", memoryScope: "user" },
  });
  assert.equal(updated.id, agent.id, "编辑不换身份：id 不变（记忆 key 以 id 为准）");

  const snapshot = await squadRuntimeService.getSnapshot(WS);
  const readBack = snapshot.teamAgents.find((entry) => entry.id === agent.id);
  assert.ok(readBack, "编辑后仍然列在快照里");
  assert.equal(readBack.name, "李四");
  assert.equal(readBack.systemPrompt, "你是李四");
  assert.equal(readBack.memoryScope, "user");
});

test("updateTeamAgent：id 不存在 ⇒ 响亮抛，且不动其它已有智能体", async () => {
  const { repoRoot, squadRuntimeService } = await makeService();
  const agent = await createAgent(squadRuntimeService);
  const before = readDefinitionFile(repoRoot, agent.id);

  await assert.rejects(
    () =>
      squadRuntimeService.updateTeamAgent(WS, {
        id: "不存在",
        patch: { name: "谁" },
      }),
    /协作智能体不存在：不存在/,
    "静默 no-op 会让界面以为改成功了",
  );

  // 其它智能体逐字未动（直接读盘）。
  assert.deepEqual(readDefinitionFile(repoRoot, agent.id), before);
});

// 白名单是**运行期**的承重墙：patch 多带 enabled / archivedAt 时不得被整包展开写进盘里。
test("updateTeamAgent：白名单外的字段（enabled / archivedAt）不得被悄悄改掉", async () => {
  const { repoRoot, squadRuntimeService } = await makeService();
  const agent = await createAgent(squadRuntimeService);

  // 绕过类型限制模拟「调用方透传了运行时多出来的键」（反序列化载荷 / 手写对象）。
  const hostilePatch = {
    name: "王五",
    enabled: false,
    archivedAt: 123,
  } as TeamAgentEditablePatch;
  await squadRuntimeService.updateTeamAgent(WS, { id: agent.id, patch: hostilePatch });

  const onDisk = readDefinitionFile(repoRoot, agent.id);
  assert.equal(onDisk.name, "王五", "白名单内的字段照常写入");
  assert.equal(onDisk.enabled, true, "enabled 必须原样保留（它有自己的入口 setEnabled）");
  assert.equal(onDisk.archivedAt, undefined, "archivedAt 必须原样保留（它有自己的入口 archive）");
});

test("setTeamAgentEnabled：停用 / 启用都被读回", async () => {
  const { repoRoot, squadRuntimeService } = await makeService();
  const agent = await createAgent(squadRuntimeService);

  await squadRuntimeService.setTeamAgentEnabled(WS, { id: agent.id, enabled: false });
  assert.equal(readDefinitionFile(repoRoot, agent.id).enabled, false);
  assert.equal(
    (await squadRuntimeService.getSnapshot(WS)).teamAgents.find((entry) => entry.id === agent.id)
      ?.enabled,
    false,
  );

  await squadRuntimeService.setTeamAgentEnabled(WS, { id: agent.id, enabled: true });
  assert.equal(readDefinitionFile(repoRoot, agent.id).enabled, true);
});

// 归档 ≠ 消失（spec §16 S10）：只加时间戳，定义文件与快照里的条目都还在。
test("archiveTeamAgent：archivedAt 为时间戳，定义文件仍在、快照仍列得到", async () => {
  const { repoRoot, squadRuntimeService } = await makeService();
  const agent = await createAgent(squadRuntimeService);
  const before = Date.now();

  await squadRuntimeService.archiveTeamAgent(WS, { id: agent.id });

  const onDisk = readDefinitionFile(repoRoot, agent.id);
  assert.equal(typeof onDisk.archivedAt, "number", "归档写的是时间戳");
  assert.ok(onDisk.archivedAt >= before, `时间戳应为本次归档时刻，实际 ${onDisk.archivedAt}`);
  assert.ok(
    existsSync(join(resolveSquadAgentRoot(repoRoot), `${agent.id}.json`)),
    "归档不是硬删：定义文件必须还在（记忆也保留）",
  );
  const snapshot = await squadRuntimeService.getSnapshot(WS);
  assert.ok(
    snapshot.teamAgents.some((entry) => entry.id === agent.id),
    "归档 ≠ 消失：快照仍列得到它（由上层决定是否隐藏）",
  );
});

test("setTeamAgentEnabled / archiveTeamAgent：id 不存在 ⇒ 响亮抛", async () => {
  const { squadRuntimeService } = await makeService();

  await assert.rejects(
    () => squadRuntimeService.setTeamAgentEnabled(WS, { id: "不存在", enabled: false }),
    /协作智能体不存在：不存在/,
  );
  await assert.rejects(
    () => squadRuntimeService.archiveTeamAgent(WS, { id: "不存在" }),
    /协作智能体不存在：不存在/,
  );
});

test("目标纪律：三个方法都把调用方给的目标原样交给 runtime（没有隐式默认 workspace）", async () => {
  const { squadRuntimeService, seenTargets } = await makeService();
  const agent = await createAgent(squadRuntimeService);
  seenTargets.length = 0;

  const given: SquadWorkspaceTarget = { path: "/tmp/given-ws", identity: "given" };
  await squadRuntimeService.updateTeamAgent(given, { id: agent.id, patch: { name: "改" } });
  await squadRuntimeService.setTeamAgentEnabled(given, { id: agent.id, enabled: false });
  await squadRuntimeService.archiveTeamAgent(given, { id: agent.id });

  assert.deepEqual(
    seenTargets,
    ["/tmp/given-ws|given", "/tmp/given-ws|given", "/tmp/given-ws|given"],
    "三次调用都必须带着调用方显式给的目标（原样透传，不挑不猜）",
  );
});

// 名册管理**不过门禁**（§5.7.6 只停新派发）：开关关掉时三个方法照常可用。
// 这不是"漏判"：门禁的唯一判据在 assertDispatchEnabled，名册管理不产生新派发。
test("名册管理不受实验开关影响（不过门禁）：关掉开关后编辑 / 停用 / 归档仍可用", async () => {
  const { repoRoot, squadRuntimeService, setExperimentEnabled } = await makeService();
  const agent = await createAgent(squadRuntimeService);

  setExperimentEnabled(false);

  const updated = await squadRuntimeService.updateTeamAgent(WS, {
    id: agent.id,
    patch: { name: "开关关了也能改名" },
  });
  assert.equal(updated.name, "开关关了也能改名");
  await squadRuntimeService.setTeamAgentEnabled(WS, { id: agent.id, enabled: false });
  assert.equal(readDefinitionFile(repoRoot, agent.id).enabled, false);
  await squadRuntimeService.archiveTeamAgent(WS, { id: agent.id });
  assert.equal(typeof readDefinitionFile(repoRoot, agent.id).archivedAt, "number");
});
