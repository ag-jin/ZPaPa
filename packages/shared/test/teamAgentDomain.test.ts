import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TEAM_AGENT_MAX_CONCURRENT_RUNS,
  TEAM_AGENT_MAX_CONCURRENT_RUNS_LIMIT,
  resolveTeamAgentMaxConcurrentRuns,
  teamAgentSchema,
} from "../src/team-agent.js";

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

// ---------- maxConcurrentRuns（C1，⑤刀 Concurrency 半边；默认 6 对齐 multica migration 023） ----------

const baseAgent = {
  id: "ta_1", name: "a", systemPrompt: "s", memoryScope: "project" as const, enabled: true,
};

test("maxConcurrentRuns 校验：1 与上限 16 通过，界外/非整数拒绝", () => {
  for (const ok of [1, 16]) {
    const parsed = teamAgentSchema.safeParse({ ...baseAgent, maxConcurrentRuns: ok });
    assert.equal(parsed.success, true, `maxConcurrentRuns=${ok} 应合法`);
  }
  // 0 / -1 越下界，17 越上界，1.5 非整数，"6" 非数字——都必须响亮拒绝（校验界挡在写盘前）。
  for (const bad of [0, -1, 17, 1.5, "6"]) {
    const parsed = teamAgentSchema.safeParse({ ...baseAgent, maxConcurrentRuns: bad });
    assert.equal(parsed.success, false, `maxConcurrentRuns=${JSON.stringify(bad)} 应被拒绝`);
  }
});

test("缺省解析：无字段 ⇒ 默认 6；显式 3 ⇒ 3（缺省与显式都经同一解析函数读）", () => {
  assert.equal(DEFAULT_TEAM_AGENT_MAX_CONCURRENT_RUNS, 6, "默认值单源常量 = 6（对齐 multica）");
  assert.equal(TEAM_AGENT_MAX_CONCURRENT_RUNS_LIMIT, 16, "上限单源常量 = 16");
  assert.equal(
    resolveTeamAgentMaxConcurrentRuns({ maxConcurrentRuns: undefined }),
    6,
    "缺省 ⇒ 6（闸/UI/详情页读同一处解析，不得各写一份 ?? 6）",
  );
  assert.equal(resolveTeamAgentMaxConcurrentRuns({ maxConcurrentRuns: 3 }), 3, "显式 3 ⇒ 3");
});
