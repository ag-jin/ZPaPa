import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { McpServerConfig, TeamAgent, TeamAgentEditablePatch } from "@zcode/shared";
import { createTeamAgentService } from "../src/teams/teamAgentService.js";
import { resolveSquadAgentRoot, writeTeamAgent } from "../src/teams/teamAgentStorage.js";

/* 独立复验（per-agent MCP 切片 1）：**编辑白名单与存储收口**。
   期望值取自需求契约：create 透传（省略不落盘）、update **整体替换**（不是按名并入）、
   `{}` 是合法值（= 回到「不覆盖」）、`undefined` = 保持原值、白名单外的字段一字不动、
   存量定义（没有该字段）零改写零迁移、非法形状在**落盘前**被拒且不留半截文件。
   本文件独立构造夹具（含直接读盘原文与 inode 判据），不复用实现者用例。 */

function setupRoot(): string {
  return resolveSquadAgentRoot(mkdtempSync(join(tmpdir(), "ws-")));
}

function service(root: string) {
  return createTeamAgentService({ root });
}

/** 直接读定义文件原文：断言「落盘」这一层的事实，而不是只看内存返回。 */
function rawDefinition(root: string, id: string): string {
  return readFileSync(join(root, `${id}.json`), "utf8");
}

const THREE_SERVERS: Record<string, McpServerConfig> = {
  搜索: { command: "npx", args: ["-y", "search-mcp"], env: { TOKEN: "tok-a" } },
  文档: { url: "https://docs.test/mcp", type: "http", headers: { Authorization: "Bearer b" } },
  内部: { command: "内部命令", args: [], isolation: "workspace" },
};

test("create 透传：内存返回、get 读回、落盘原文三处一致（含 env/headers 内容）", () => {
  const root = setupRoot();
  const svc = service(root);
  const created = svc.create({
    name: "带 MCP 的队友",
    systemPrompt: "s",
    memoryScope: "project",
    mcpServers: THREE_SERVERS,
  });

  assert.deepEqual(created.mcpServers, THREE_SERVERS, "create 必须透传整张 map");
  assert.deepEqual(svc.get(created.id)?.mcpServers, THREE_SERVERS, "读回一致");
  assert.deepEqual(
    JSON.parse(rawDefinition(root, created.id)).mcpServers,
    THREE_SERVERS,
    "落盘原文一致（凭据内容同信任域，不脱敏）",
  );
});

test("create 省略该字段 ⇒ 落盘原文里没有这个键（存量定义零改写、零迁移）", () => {
  const root = setupRoot();
  const svc = service(root);
  const plain = svc.create({ name: "没有 MCP 的队友", systemPrompt: "s", memoryScope: "project" });

  assert.equal("mcpServers" in (svc.get(plain.id) ?? {}), false);
  assert.equal(rawDefinition(root, plain.id).includes("mcpServers"), false, "文件里不该出现该键");
});

test("update 是整体替换：patch 里没有的 server 会被删掉（并入语义做不到这件事）", () => {
  const root = setupRoot();
  const svc = service(root);
  const agent = svc.create({
    name: "a",
    systemPrompt: "s",
    memoryScope: "project",
    mcpServers: THREE_SERVERS,
  });

  const replaced = svc.update(agent.id, {
    mcpServers: { 只留这一个: { command: "keep-cmd" } },
  });

  assert.deepEqual(replaced.mcpServers, { 只留这一个: { command: "keep-cmd" } });
  assert.deepEqual(svc.get(agent.id)?.mcpServers, { 只留这一个: { command: "keep-cmd" } });
  const onDisk = JSON.parse(rawDefinition(root, agent.id)).mcpServers;
  assert.deepEqual(Object.keys(onDisk), ["只留这一个"], "落盘也只剩 patch 里那一条");
  assert.equal(onDisk["搜索"], undefined, "旧条目不得残留（并入会让「删一个 server」永远做不到）");
  // 白名单之外的既有字段不受影响
  assert.equal(replaced.name, "a");
  assert.equal(replaced.enabled, true);
});

test("update 的 {} 与 undefined 严格区分：{} 清空（合法值），undefined 保持原值", () => {
  const root = setupRoot();
  const svc = service(root);
  const agent = svc.create({
    name: "a",
    systemPrompt: "s",
    memoryScope: "project",
    mcpServers: THREE_SERVERS,
  });

  // undefined（patch 里根本没这个键）⇒ 保持原值
  const untouched = svc.update(agent.id, { name: "改名" });
  assert.deepEqual(untouched.mcpServers, THREE_SERVERS, "没有这个键 ⇒ 保持原值（不是清空）");
  assert.equal(untouched.name, "改名");

  // 显式 undefined ⇒ 同样保持原值
  assert.deepEqual(
    svc.update(agent.id, { mcpServers: undefined }).mcpServers,
    THREE_SERVERS,
    "显式 undefined 也保持原值",
  );

  // {} ⇒ 合法值：该 agent 不再有自有 server
  const cleared = svc.update(agent.id, { mcpServers: {} });
  assert.deepEqual(cleared.mcpServers, {});
  assert.deepEqual(svc.get(agent.id)?.mcpServers, {});
  assert.deepEqual(JSON.parse(rawDefinition(root, agent.id)).mcpServers, {}, "落盘是空表");
});

test("update 拷贝而非赋值：改调用方的 patch 对象不得改写已落盘的定义", () => {
  const root = setupRoot();
  const svc = service(root);
  const agent = svc.create({ name: "a", systemPrompt: "s", memoryScope: "project" });

  const patchEntry = { command: "原始命令", args: ["--x"] };
  const patch: TeamAgentEditablePatch = { mcpServers: { s1: patchEntry } };
  const updated = svc.update(agent.id, patch);

  patchEntry.command = "事后改了";
  (patch.mcpServers as Record<string, { command: string }>).s2 = { command: "事后加的" };
  assert.notEqual(updated.mcpServers?.["s1"], patchEntry, "返回的条目必须是拷贝，不是同一个引用");
  assert.deepEqual(
    svc.get(agent.id)?.mcpServers,
    { s1: { command: "原始命令", args: ["--x"] } },
    "事后再改 patch 不得回流到定义",
  );
});

test("白名单仍是运行期承重墙：同一 patch 里夹带的 enabled/archivedAt/id 一律写不进去", () => {
  const root = setupRoot();
  const svc = service(root);
  const agent = svc.create({ name: "a", systemPrompt: "s", memoryScope: "project" });

  const smuggled = svc.update(agent.id, {
    mcpServers: { ok: { command: "ok-cmd" } },
    enabled: false,
    archivedAt: 12345,
    id: "ta_别的",
  } as unknown as TeamAgentEditablePatch);

  assert.deepEqual(smuggled.mcpServers, { ok: { command: "ok-cmd" } }, "白名单内字段正常生效");
  assert.equal(smuggled.enabled, true, "enabled 的入口是 setEnabled，不得从编辑里改");
  assert.equal(smuggled.archivedAt, undefined, "archivedAt 的入口是 archive/restore");
  assert.equal(smuggled.id, agent.id, "id 不可改");
});

test("内容全同 ⇒ 不重写盘（inode 不变）；有实质变更则确实重写（正对照，证明 inode 判据能看见写盘）", () => {
  const root = setupRoot();
  const svc = service(root);
  const agent = svc.create({
    name: "a",
    systemPrompt: "s",
    memoryScope: "project",
    mcpServers: THREE_SERVERS,
  });
  const path = join(root, `${agent.id}.json`);

  const before = statSync(path);
  const beforeBytes = rawDefinition(root, agent.id);
  // 逐字相同但**换了一个对象**：必须走 JSON 判等，而不是引用判等
  const same = svc.update(agent.id, { mcpServers: JSON.parse(JSON.stringify(THREE_SERVERS)) });
  const after = statSync(path);

  assert.deepEqual(same.mcpServers, THREE_SERVERS, "内容全同的 patch 不得改变定义");
  assert.equal(rawDefinition(root, agent.id), beforeBytes, "盘上原文一字不动");
  assert.equal(after.ino, before.ino, "重复保存同一份内容不该产生一次重写盘");

  // 正对照：有实质变更时必须重写（否则上面的 inode 判据可能根本看不见写盘）
  svc.update(agent.id, { mcpServers: { 只留: { command: "keep" } } });
  assert.notEqual(statSync(path).ino, before.ino, "实质变更必须落盘（inode 判据确实有效）");
});

test("存量定义（文件里没有该字段）经 update / setEnabled / archive 都零改写：不凭空长出这个键", () => {
  const root = setupRoot();
  const svc = service(root);
  mkdirSync(root, { recursive: true }); // 手写的存量定义：先有文件，才有服务
  const legacy: TeamAgent = {
    id: "ta_legacy",
    name: "老定义",
    systemPrompt: "s",
    skills: [],
    memoryScope: "project",
    enabled: true,
  };
  writeFileSync(join(root, "ta_legacy.json"), `${JSON.stringify(legacy, null, 2)}\n`);
  const legacyBytes = rawDefinition(root, "ta_legacy");

  assert.equal("mcpServers" in (svc.get("ta_legacy") ?? {}), false, "读回不含该键");
  assert.equal(rawDefinition(root, "ta_legacy"), legacyBytes, "纯读取不该改盘");

  svc.update("ta_legacy", { name: "改个名" });
  assert.equal(
    rawDefinition(root, "ta_legacy").includes("mcpServers"),
    false,
    "编辑不得迁移出新字段",
  );
  assert.equal(JSON.parse(rawDefinition(root, "ta_legacy")).name, "改个名");

  svc.archive("ta_legacy");
  svc.setEnabled("ta_legacy", false);
  const finalRaw = JSON.parse(rawDefinition(root, "ta_legacy"));
  assert.equal("mcpServers" in finalRaw, false, "状态类操作也不得迁移出新字段");
  assert.equal(finalRaw.enabled, false);
  assert.ok(typeof finalRaw.archivedAt === "number");
});

test("存储收口：非法 mcpServers 形状在写盘前被拒、不留半截文件；未知顶层字段仍被 strict 拒", () => {
  const root = setupRoot();
  const base = {
    id: "ta_x",
    name: "a",
    systemPrompt: "s",
    memoryScope: "project",
    enabled: true,
  } as const;

  const illegalShapes: readonly unknown[] = [
    { s: null },
    { s: 42 },
    { s: { command: 123 } },
    { s: { url: { nested: true } } },
    { s: { args: ["-y"] } },
    "npx -y some-mcp", // 整张 map 不是对象
  ];
  for (const mcpServers of illegalShapes) {
    assert.throws(
      () => writeTeamAgent(root, { ...base, mcpServers } as never),
      `mcpServers=${JSON.stringify(mcpServers)} 必须在落盘前被拒`,
    );
  }
  assert.equal(existsSync(join(root, "ta_x.json")), false, "被拒的定义不得留下半截文件");

  // 新字段不得松动既有 strict：未知顶层字段照旧拒绝（决策 E「不绑 host」的机器化证明）。
  assert.throws(
    () => writeTeamAgent(root, { ...base, hostBinding: "x" } as never),
    "strict schema 不得因为新增字段而放宽",
  );
  // 合法的空表可落盘（v1 不做「空 map = 严格空集」，空表就是「不覆盖」）
  writeTeamAgent(root, { ...base, mcpServers: {} } as never);
  assert.deepEqual(JSON.parse(rawDefinition(root, "ta_x")).mcpServers, {});
});
