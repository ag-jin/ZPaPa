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
