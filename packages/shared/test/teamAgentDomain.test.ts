import assert from "node:assert/strict";
import test from "node:test";
import { teamAgentSchema } from "../src/team-agent.js";

// 记忆用稳定 id 做 key，因此 id 必填且不得为空（空 id 会让记忆跨智能体串台）。
test("teamAgent 必须有非空稳定 id", () => {
  const bad = teamAgentSchema.safeParse({ name: "a", systemPrompt: "s", memoryScope: "project", enabled: true });
  assert.equal(bad.success, false);
});

// strict schema：多余字段直接拒绝——这是「不绑 host」的机器化证明（决策 E）。
test("strict schema 拒绝 hostBinding 等未知字段", () => {
  const parsed = teamAgentSchema.safeParse({
    id: "ta_1", name: "a", systemPrompt: "s", memoryScope: "project", enabled: true,
    hostBinding: "h1", // 多余字段
  });
  assert.equal(parsed.success, false);
});
