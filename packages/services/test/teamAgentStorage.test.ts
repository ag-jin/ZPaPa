import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  deleteTeamAgent, listTeamAgents, readTeamAgent, resolveSquadAgentRoot, writeTeamAgent,
} from "../src/teams/teamAgentStorage.js";

test("定义落在实验命名空间，可写可读可删", () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  const root = resolveSquadAgentRoot(ws);
  assert.ok(root.endsWith(join(".zcode", "squad", "agents")));
  writeTeamAgent(root, { id: "ta_1", name: "审查者", systemPrompt: "s", memoryScope: "project", enabled: true });
  assert.equal(readTeamAgent(root, "ta_1")?.name, "审查者");
  assert.equal(listTeamAgents(root).length, 1);
  deleteTeamAgent(root, "ta_1");
  assert.equal(listTeamAgents(root).length, 0);
});

// 删除整个实验命名空间不应牵连现有 subagent 目录。
test("实验命名空间与现有 agents 目录互不相干", () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  assert.equal(resolveSquadAgentRoot(ws).includes(join(".zcode", "agents")), false);
});

// 上一条只锁路径字符串，锁不住「根目录上移到 .zcode」这类改动（".zcode" 不含 ".zcode/agents" 子串，
// 却会把现有 subagent 目录一起删掉）。这里做承重证明：真的删掉整个实验命名空间，现有 subagent 必须原封不动。
test("删掉整个实验命名空间后，现有 subagent 定义仍在", () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  const legacyAgentFile = join(ws, ".zcode", "agents", "legacy.md");
  mkdirSync(dirname(legacyAgentFile), { recursive: true });
  writeFileSync(legacyAgentFile, "# 现有 subagent\n");
  const root = resolveSquadAgentRoot(ws);
  writeTeamAgent(root, { id: "ta_1", name: "a", systemPrompt: "s", memoryScope: "project", enabled: true });
  rmSync(dirname(root), { recursive: true, force: true }); // 整块删除 .zcode/squad/
  assert.equal(existsSync(legacyAgentFile), true);
});

// 一个坏文件只该丢掉它自己：手改坏 / 半截 JSON 的定义若让整份列表崩，用户将看不到任何队友。
test("列表跳过无法解析的文件，其余定义照常返回", () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  const root = resolveSquadAgentRoot(ws);
  writeTeamAgent(root, { id: "ta_ok", name: "好的", systemPrompt: "s", memoryScope: "project", enabled: true });
  writeFileSync(join(root, "ta_broken.json"), "{ 不是合法 JSON");
  const agents = listTeamAgents(root);
  assert.equal(agents.length, 1);
  assert.equal(agents[0]?.id, "ta_ok");
});

/* ---------- spec §17 登记的隐患：id 直接进文件路径 → 未校验可逃出实验命名空间 ----------
   P0 留白、P1 未闭合的写法是 `` `${id}.json` `` 直接 join，故 `id = "../evil"` 会落到
   `<ws>/.zcode/evil.json`（实验命名空间之外）。修复点是 `definitionPath` 这一处收口：
   写 / 读 / 删三条路径都经过它，所以这一道闸就是三条路径的闸。
   用**真实临时目录**逐格验证（不假设 join 对 ".." 的归一化行为）。 */

/** 一切「不是单路径段」的取值。新增非法形态加这里，而不是另起一条测试。 */
const ILLEGAL_IDS = [
  "../evil", // 逃到 .zcode/squad 之外
  "a/b", // 多段
  "", // 空 id：记忆 key 依赖它，schema 已先拦一层
  "..", // 父目录自身
  ".", // 目录自身
  "./evil", // 带当前目录前缀的多段写法
  "/tmp/evil", // 绝对路径
  "a\\b", // Windows 分隔符：同一份数据可能在 Windows 上被读（与 squadStorage 同款拦截）
] as const;

function definitionOf(id: string) {
  return { id, name: "x", systemPrompt: "s", memoryScope: "project" as const, enabled: true };
}

test("writeTeamAgent 拒绝一切非单路径段的 id", () => {
  const root = resolveSquadAgentRoot(mkdtempSync(join(tmpdir(), "ws-")));
  // 先写一个合法定义：证明这道闸只拦逃逸形态、不误伤正常 id（否则「一律拒绝」也能过）。
  writeTeamAgent(root, definitionOf("ta_ok"));
  for (const bad of ILLEGAL_IDS) {
    assert.throws(
      () => writeTeamAgent(root, definitionOf(bad)),
      /id/,
      `writeTeamAgent 应拒绝 id=${JSON.stringify(bad)}`,
    );
  }
});

test("readTeamAgent 拒绝一切非单路径段的 id（读侧过同一道闸）", () => {
  const root = resolveSquadAgentRoot(mkdtempSync(join(tmpdir(), "ws-")));
  for (const bad of ILLEGAL_IDS) {
    assert.throws(
      () => readTeamAgent(root, bad),
      /id/,
      `readTeamAgent 应拒绝 id=${JSON.stringify(bad)}`,
    );
  }
});

test("deleteTeamAgent 拒绝一切非单路径段的 id（删侧过同一道闸）", () => {
  const root = resolveSquadAgentRoot(mkdtempSync(join(tmpdir(), "ws-")));
  for (const bad of ILLEGAL_IDS) {
    assert.throws(
      () => deleteTeamAgent(root, bad),
      /id/,
      `deleteTeamAgent 应拒绝 id=${JSON.stringify(bad)}`,
    );
  }
});

// 「响亮失败」的承重证明：拒绝之后盘上不能留下逃逸产物（静默改名 / 写到别处都会在这里露馅）。
test("被拒绝的逃逸 id 不在命名空间之外留下任何文件", () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  const root = resolveSquadAgentRoot(ws);
  writeTeamAgent(root, definitionOf("ta_ok")); // 先建目录，否则逃逸会因「父目录不存在」而假绿
  for (const bad of ["../evil", "../../evil"] as const) {
    assert.throws(() => writeTeamAgent(root, definitionOf(bad)), /id/);
    assert.throws(() => deleteTeamAgent(root, bad), /id/);
  }
  // 逃逸若成功，evil.json 会落在下面这几个位置（join 归一化 ".." 之后）。
  assert.equal(existsSync(join(ws, ".zcode", "evil.json")), false);
  assert.equal(existsSync(join(ws, "evil.json")), false);
  assert.equal(existsSync(join(ws, ".zcode", "squad", "evil.json")), false);
});

// 第三条读路径（列目录）不能被新闸门打断：文件名派生的 id 天然是单段，
// 但盘上可能存在畸形文件名（`..json` → id 为 "."），此时必须只跳过它自己。
test("listTeamAgents 不受畸形文件名影响，好定义照常返回", () => {
  const root = resolveSquadAgentRoot(mkdtempSync(join(tmpdir(), "ws-")));
  writeTeamAgent(root, definitionOf("ta_ok"));
  writeFileSync(join(root, "..json"), "{}");
  assert.deepEqual(
    listTeamAgents(root).map((agent) => agent.id),
    ["ta_ok"],
  );
});

/* mcpServers 的校验在 schema 上（shared），写入收口 `writeTeamAgent` 先 parse ⇒ 畸形配置在
   **落盘前**被拒、且不留半截文件；没有该字段的存量定义零改写、零迁移。 */
test("writeTeamAgent 落盘前拒绝畸形 mcpServers；存量定义（无该字段）照旧合法", () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  const root = resolveSquadAgentRoot(ws);
  for (const broken of [
    { broken: "npx" },
    { broken: { args: ["-y"] } },
    { "": { command: "npx" } },
  ]) {
    assert.throws(
      () =>
        writeTeamAgent(root, {
          id: "ta_bad",
          name: "a",
          systemPrompt: "s",
          memoryScope: "project",
          enabled: true,
          mcpServers: broken,
        }),
      `mcpServers=${JSON.stringify(broken)} 必须在写盘前被拒`,
    );
  }
  assert.equal(existsSync(join(root, "ta_bad.json")), false, "被拒的定义不得留下任何文件");

  // 空 map 是**合法值**（v1 不做「空 map = 严格空集/屏蔽继承」，设计 §3.1）：落盘、读回都是空表。
  writeTeamAgent(root, {
    id: "ta_empty",
    name: "e",
    systemPrompt: "s",
    memoryScope: "project",
    enabled: true,
    mcpServers: {},
  });
  assert.deepEqual(readTeamAgent(root, "ta_empty")?.mcpServers, {});

  writeTeamAgent(root, {
    id: "ta_old",
    name: "o",
    systemPrompt: "s",
    memoryScope: "project",
    enabled: true,
  });
  assert.equal("mcpServers" in (readTeamAgent(root, "ta_old") ?? {}), false, "存量定义零改写");
});
