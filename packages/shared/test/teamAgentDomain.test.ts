import assert from "node:assert/strict";
import test from "node:test";
import { teamAgentSchema } from "../src/team-agent.js";

// 记忆用稳定 id 做 key，因此 id 必填且不得为空（空 id 会让记忆跨智能体串台）。
test("teamAgent 必须有非空稳定 id", () => {
  const bad = teamAgentSchema.safeParse({ name: "a", systemPrompt: "s", memoryScope: "project", enabled: true });
  assert.equal(bad.success, false);
});

// id 为空串时必须被拒：记忆 key 由 id 派生，空 id 会让两个智能体的记忆串到同一目录。
// 上一条只省了 id 字段，验的是「必填」；去掉 schema 的 .min(1) 它仍绿，所以「非空」必须由本条承重。
test("空字符串 id 被拒绝", () => {
  const parsed = teamAgentSchema.safeParse({
    id: "", name: "a", systemPrompt: "s", memoryScope: "project", enabled: true,
  });
  assert.equal(parsed.success, false);
});

// strict schema：多余字段直接拒绝——这是「不绑 host」的机器化证明（决策 E）。
test("strict schema 拒绝 hostBinding 等未知字段", () => {
  const parsed = teamAgentSchema.safeParse({
    id: "ta_1", name: "a", systemPrompt: "s", memoryScope: "project", enabled: true,
    hostBinding: "h1", // 多余字段
  });
  assert.equal(parsed.success, false);
});
