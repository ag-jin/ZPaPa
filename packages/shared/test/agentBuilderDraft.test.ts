import assert from "node:assert/strict";
import test from "node:test";
import { agentBuilderDraftSchema, emptyAgentBuilderDraft } from "../src/agent-builder.js";
import { TEAM_AGENT_MEMORY_SCOPES } from "../src/team-agent.js";

// AgentBuilder 访谈草稿（设计报告 §4-D4 / §5.1）：模型每轮只能决定这六个字段，
// 且必须能被服务面当作「可安全映射进 CreateTeamAgentInput 的载荷」。
// 这里的用例钉住 schema 的形状与边界；解析/合并矩阵在 services 侧（draftProtocol）。

test("完整草稿通过校验：六个生成字段 + permissionMode 可为 null（= 未设置）", () => {
  const draft = {
    name: "代码审查员",
    description: "审查每次提交的变更",
    systemPrompt: "# 角色\n你是代码审查员",
    skills: ["review", "git"],
    memoryScope: "project" as const,
    permissionMode: "plan" as const,
  };
  assert.deepEqual(agentBuilderDraftSchema.parse(draft), draft);
  // 三态权限模式：auto / plan / null（未设置）都合法。
  assert.equal(
    agentBuilderDraftSchema.safeParse({ ...draft, permissionMode: "auto" }).success,
    true,
  );
  assert.equal(agentBuilderDraftSchema.safeParse({ ...draft, permissionMode: null }).success, true);
});

test("空草稿是合法起点（访谈第一轮之前/降级轮都可能没有模型输入）", () => {
  const empty = emptyAgentBuilderDraft();
  assert.deepEqual(agentBuilderDraftSchema.parse(empty), empty);
  assert.equal(empty.name, "");
  assert.equal(empty.systemPrompt, "");
  assert.deepEqual(empty.skills, []);
  assert.equal(empty.permissionMode, null);
});

/* 越权字段（§4-D4「永不生成」那一列）在**形状层**就进不来：草稿 schema 是 strict，
   多一个键即整条拒绝。mcpServers 是重点 —— 它可能含 env/token，任何一条通向草稿的
   路径都必须是"类型上不存在"，而不是"提示词里说不许"。 */
test("strict：越权字段（mcpServers / tools / id / color / provenance）整条拒绝", () => {
  const draft = emptyAgentBuilderDraft();
  for (const payload of [
    { ...draft, mcpServers: { "code-search": { command: "npx" } } },
    { ...draft, tools: ["Bash"] },
    { ...draft, disallowedTools: ["WebFetch"] },
    { ...draft, id: "ta_1" },
    { ...draft, color: "red" },
    { ...draft, enabled: true },
    { ...draft, provenance: { source: "ai_builder" } },
    { ...draft, modelSelection: { providerId: "p", modelId: "m" } },
  ]) {
    assert.equal(
      agentBuilderDraftSchema.safeParse(payload).success,
      false,
      `越权字段必须被拒：${JSON.stringify(payload).slice(0, 80)}`,
    );
  }
});

test("枚举与类型：非法 memoryScope / permissionMode / 缺字段 / 错类型都被拒", () => {
  const draft = emptyAgentBuilderDraft();
  for (const value of ["global", "", "PROJECT", 1, null]) {
    assert.equal(
      agentBuilderDraftSchema.safeParse({ ...draft, memoryScope: value }).success,
      false,
      `memoryScope=${JSON.stringify(value)} 应被拒`,
    );
  }
  for (const value of ["workspace", "private", true, 2]) {
    assert.equal(
      agentBuilderDraftSchema.safeParse({ ...draft, permissionMode: value }).success,
      false,
      `permissionMode=${JSON.stringify(value)} 应被拒（三态只有 auto / plan / null）`,
    );
  }
  for (const key of ["name", "description", "systemPrompt", "skills", "memoryScope"]) {
    const { [key as keyof typeof draft]: _omitted, ...withoutKey } = draft;
    assert.equal(
      agentBuilderDraftSchema.safeParse(withoutKey).success,
      false,
      `缺 ${key} 的草稿应被拒（六个字段在契约上恒在场，调用方不必猜）`,
    );
  }
  assert.equal(
    agentBuilderDraftSchema.safeParse({ ...draft, skills: ["a", 1] }).success,
    false,
    "skills 只收字符串",
  );
  assert.equal(
    agentBuilderDraftSchema.safeParse({ ...draft, name: 42 }).success,
    false,
    "name 只收字符串",
  );
});

/* 记忆作用域与落盘定义的取值域必须同源：草稿里写 "global" 通过了、落盘时被拒，
   会变成一次「表单说成功、服务拒了」的静默失败。 */
test("memoryScope 取值域与 teamAgentSchema 同源", () => {
  for (const scope of TEAM_AGENT_MEMORY_SCOPES) {
    assert.equal(
      agentBuilderDraftSchema.safeParse({ ...emptyAgentBuilderDraft(), memoryScope: scope })
        .success,
      true,
      `${scope} 应同时被草稿与落盘定义接受`,
    );
  }
  assert.equal(
    agentBuilderDraftSchema.safeParse({ ...emptyAgentBuilderDraft(), memoryScope: "global" })
      .success,
    false,
  );
});
