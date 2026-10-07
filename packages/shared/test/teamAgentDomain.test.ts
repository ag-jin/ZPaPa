import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TEAM_AGENT_MAX_CONCURRENT_RUNS,
  TEAM_AGENT_MAX_CONCURRENT_RUNS_LIMIT,
  resolveTeamAgentIdleTimeoutMinutes,
  resolveTeamAgentMaxConcurrentRuns,
  resolveTeamAgentRunTtlMinutes,
  resolveTeamAgentToolTimeoutMinutes,
  teamAgentSchema,
} from "../src/team-agent.js";

// 记忆用稳定 id 做 key，因此 id 必填且不得为空（空 id 会让记忆跨智能体串台）。
test("teamAgent 必须有非空稳定 id", () => {
  const bad = teamAgentSchema.safeParse({
    name: "a",
    systemPrompt: "s",
    memoryScope: "project",
    enabled: true,
  });
  assert.equal(bad.success, false);
});

// id 为空串时必须被拒：记忆 key 由 id 派生，空 id 会让两个智能体的记忆串到同一目录。
// 上一条只省了 id 字段，验的是「必填」；去掉 schema 的 .min(1) 它仍绿，所以「非空」必须由本条承重。
test("空字符串 id 被拒绝", () => {
  const parsed = teamAgentSchema.safeParse({
    id: "",
    name: "a",
    systemPrompt: "s",
    memoryScope: "project",
    enabled: true,
  });
  assert.equal(parsed.success, false);
});

// strict schema：多余字段直接拒绝——这是「不绑 host」的机器化证明（决策 E）。
test("strict schema 拒绝 hostBinding 等未知字段", () => {
  const parsed = teamAgentSchema.safeParse({
    id: "ta_1",
    name: "a",
    systemPrompt: "s",
    memoryScope: "project",
    enabled: true,
    hostBinding: "h1", // 多余字段
  });
  assert.equal(parsed.success, false);
});

// ---------- maxConcurrentRuns（C1，⑤刀 Concurrency 半边；默认 6 对齐 multica migration 023） ----------

const baseAgent = {
  id: "ta_1",
  name: "a",
  systemPrompt: "s",
  memoryScope: "project" as const,
  enabled: true,
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

test("看门狗阈值字段：可选、缺省不落盘；三个解析入口各自返回 shared 单源缺省", () => {
  // 缺省不落盘：不写这三个字段的存量定义照样合法，且解析出的就是裁定值（30 / 10 / 5）。
  const parsed = teamAgentSchema.parse(baseAgent);
  assert.equal("runTtlMinutes" in parsed, false, "缺省不落盘（存量文件零改写）");
  assert.equal(
    resolveTeamAgentRunTtlMinutes(parsed),
    30,
    "缺省 TTL = 30 分钟（用户 2026-10-07 裁定）",
  );
  assert.equal(resolveTeamAgentIdleTimeoutMinutes(parsed), 10, "缺省空闲阈值 = 10 分钟");
  assert.equal(resolveTeamAgentToolTimeoutMinutes(parsed), 5, "缺省工具阈值 = 5 分钟");

  // 显式值原样透传（per-agent 覆盖的唯一读取入口）。
  assert.equal(resolveTeamAgentRunTtlMinutes({ runTtlMinutes: 90 }), 90);
  assert.equal(resolveTeamAgentIdleTimeoutMinutes({ idleTimeoutMinutes: 2 }), 2);
  assert.equal(resolveTeamAgentToolTimeoutMinutes({ toolTimeoutMinutes: 1 }), 1);

  // 校验界：必须 ≥1 的整数（0 / 负数 / 小数 / 字符串一律拒绝——把错误挡在写盘前）。
  for (const bad of [0, -1, 1.5, "30"]) {
    const rejected = teamAgentSchema.safeParse({ ...baseAgent, runTtlMinutes: bad });
    assert.equal(rejected.success, false, `runTtlMinutes=${JSON.stringify(bad)} 应被拒绝`);
  }
});

// ---------- mcpServers（multica 欠账 #2：per-agent MCP 配置）----------

/* 字段形状与校验在 `team-agent-mcp.ts`（那里有形状/合并/转换的完整矩阵）；这里钉的是**它在定义里的位置**：
   可选、缺省不落盘、形状错误由 strict schema 在写盘前拒掉（存储层 writeTeamAgent 先 parse ⇒ 全写路径自动收口）。
   注意它与既有 subagent 的 `mcpServers`（`readonly string[]`，父会话已连 server 的**名单**）同名不同义：
   这里是**自足配置**（名字 → 完整 config），两者域隔离，不做兼容层（设计 §2.5）。 */
test("mcpServers 字段：可选（缺省不落盘）、合法 map 原样保留、形状错误被拒", () => {
  const omitted = teamAgentSchema.parse(baseAgent);
  assert.equal("mcpServers" in omitted, false, "缺省不落盘（存量定义零改写、零迁移）");

  const parsed = teamAgentSchema.parse({
    ...baseAgent,
    mcpServers: {
      "code-search": { command: "npx", args: ["-y", "code-search-mcp"] },
      "docs-http": { url: "https://docs.test/sse", type: "sse" },
    },
  });
  assert.deepEqual(
    parsed.mcpServers,
    {
      "code-search": { command: "npx", args: ["-y", "code-search-mcp"] },
      "docs-http": { url: "https://docs.test/sse", type: "sse" },
    },
    "合法 map 原样保留（校验只看形状，不剥字段）",
  );

  for (const bad of [
    { "": { command: "npx" } },
    { broken: {} },
    { broken: { args: ["-y"] } },
    { broken: "npx" },
  ]) {
    const rejected = teamAgentSchema.safeParse({ ...baseAgent, mcpServers: bad });
    assert.equal(rejected.success, false, `mcpServers=${JSON.stringify(bad)} 应被拒绝`);
  }
});
