import assert from "node:assert/strict";
import test from "node:test";
import type { AgentBuilderDraft } from "@zcode/shared";
import {
  AGENT_BUILDER_INPUT_PREFIX,
  buildAgentBuilderMessages,
  clampAgentBuilderHistory,
  encodeAgentBuilderTurn,
} from "../src/agentbuilder/envelope.js";

/* 上行信封（设计报告 §5.3 数据流）：每轮把「用户的回答 + 当前草稿 + 可选值域」重新申明一遍，
   模型只能从申明过的取值里挑 —— 与 multica 的 `encodeBuilderInput` 同形
   （`builder-protocol.ts:122-174`：每轮重申完整决策上下文）。 */

const draft: AgentBuilderDraft = {
  name: "审查员",
  description: "审查提交",
  systemPrompt: "# 角色\n你是审查员",
  skills: ["review"],
  memoryScope: "project",
  permissionMode: "plan",
};

function decodeEnvelope(encoded: string): Record<string, unknown> {
  assert.ok(
    encoded.startsWith(AGENT_BUILDER_INPUT_PREFIX),
    "信封必须以固定前缀开头（模型按前缀识别这是机器载荷）",
  );
  return JSON.parse(encoded.slice(AGENT_BUILDER_INPUT_PREFIX.length)) as Record<string, unknown>;
}

test("信封：用户原文 + 当前草稿 + 可选值域内联（memoryScope / permissionMode）", () => {
  const payload = decodeEnvelope(encodeAgentBuilderTurn("帮我建个代码审查员", draft));
  assert.equal(payload.user_request, "帮我建个代码审查员");
  assert.deepEqual(payload.current_draft, draft);
  assert.deepEqual(payload.available_memory_scopes, ["user", "project", "local"]);
  assert.deepEqual(payload.available_permission_modes, ["auto", "plan"]);
  // 目录里没有的东西不许出现（tools / 模型 / 成员 / 技能清单本版都不生成）。
  for (const forbidden of ["available_runtime_models", "available_workspace_skills", "tools"]) {
    assert.equal(JSON.stringify(payload).includes(forbidden), false, `信封不得携带 ${forbidden}`);
  }
});

test("信封：首轮无草稿时省略 current_draft（不是 null —— 历史轮同款）", () => {
  const payload = decodeEnvelope(encodeAgentBuilderTurn("我想做一个帮忙写周报的智能体", null));
  assert.equal(payload.user_request, "我想做一个帮忙写周报的智能体");
  assert.equal(Object.hasOwn(payload, "current_draft"), false);
});

test("消息装配：system 在最前，历史按序在后，本轮信封在最后", () => {
  const messages = buildAgentBuilderMessages({
    systemPrompt: "SYS",
    history: [
      { role: "user", content: "我想做一个帮忙写周报的智能体" },
      { role: "assistant", content: "好的，先问两个问题。<agent_draft>{}</agent_draft>" },
    ],
    draft,
    answer: "面向研发团队，每周五出",
  });
  assert.equal(messages.length, 4);
  assert.deepEqual(messages[0], { role: "system", content: "SYS" });
  assert.equal(messages[1]?.role, "user");
  assert.deepEqual(
    decodeEnvelope(String(messages[1]?.content)).user_request,
    "我想做一个帮忙写周报的智能体",
  );
  // 历史用户轮不再重申草稿（当轮草稿无从得知）；权威草稿只在最末一条信封里。
  assert.equal(Object.hasOwn(decodeEnvelope(String(messages[1]?.content)), "current_draft"), false);
  // assistant 轮原样进 messages：它自带的 <agent_draft> 块是"上几轮说了什么"的证据。
  assert.equal(messages[2]?.content, "好的，先问两个问题。<agent_draft>{}</agent_draft>");
  assert.equal(messages[2]?.role, "assistant");
  assert.deepEqual(decodeEnvelope(String(messages[3]?.content)).current_draft, draft);
  assert.equal(decodeEnvelope(String(messages[3]?.content)).user_request, "面向研发团队，每周五出");
});

// 上下文长度控制（设计报告 §D1）：超过 30 条丢弃中段最旧的轮次，但**保留首条用户目标消息**
// —— 首条是"我要个什么智能体"的目标陈述，丢了模型会忘了为什么访谈。
test("历史钳制：不超限原样返回（同一引用）；超限丢中段保首条与最近轮次", () => {
  const short = Array.from({ length: 30 }, (_, index) => ({
    role: "user" as const,
    content: `m${index}`,
  }));
  assert.equal(clampAgentBuilderHistory(short), short, "未超限不得拷贝");

  const long = Array.from({ length: 41 }, (_, index) => ({
    role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `m${index}`,
  }));
  const clamped = clampAgentBuilderHistory(long);
  assert.equal(clamped.length, 30);
  assert.equal(clamped[0]?.content, "m0", "首条用户目标必须保留");
  assert.equal(clamped.at(-1)?.content, "m40", "最近一轮必须保留");
  assert.equal(clamped[1]?.content, "m12", "被丢弃的是中段最旧的 11 条（41 保 30）");
});
