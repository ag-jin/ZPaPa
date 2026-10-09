import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_BUILDER_ERROR_CODES } from "@zcode/services";
import type { AgentBuilderDraft } from "@zcode/shared";
import {
  agentBuilderAwaitingReply,
  agentBuilderDraftHasContent,
  agentBuilderDraftSummary,
  agentBuilderDraftToTeamAgentInitial,
  agentBuilderFailureOf,
  agentBuilderHistoryOf,
  agentBuilderSessionOnFailure,
  agentBuilderSessionOnResult,
  agentBuilderSessionOnSend,
  agentBuilderSessionOnStop,
  emptyAgentBuilderSession,
} from "../src/squad/agentBuilderViewModel.js";

/* AgentBuilder 访谈面板的**纯函数层**（设计报告 §5.4 的四条 UI 路在这一层逐条钉住）：
   状态迁移（发一轮 / 成功 / 降级 / 失败 / 停止）、失败分流（模型不可用 vs 请求失败）、
   草稿 → 表单初值映射（§4-D4 的生成边界在这里是可断言的事实：越权字段没有通路）。
   组件只做渲染与调用编排，判定一律不写在 JSX 里（与 squadSurfaceViewModel 同款纪律）。 */

const draft: AgentBuilderDraft = {
  name: "周报助手",
  description: "每周五汇总研发进展",
  systemPrompt: "# 角色\n你是周报助手",
  skills: ["wiki", "git"],
  memoryScope: "project",
  permissionMode: "plan",
};

// ---------- ① 状态迁移：访谈 → 预填 ----------

test("发一轮：用户消息进转写、进入 pending、清掉上一次失败", () => {
  const session = agentBuilderSessionOnSend(emptyAgentBuilderSession(), "  帮我建个周报助手  ");
  assert.deepEqual(session.messages, [{ role: "user", content: "帮我建个周报助手" }]);
  assert.equal(session.status, "pending");
  assert.equal(session.failure, null);
  // 空输入不产生一轮（点发送不该把空气发给模型）。
  assert.deepEqual(agentBuilderSessionOnSend(emptyAgentBuilderSession(), "   ").messages, []);
});

test("成功一轮：回复进转写、草稿更新、回到 idle；历史按序（可直接喂给服务）", () => {
  const sent = agentBuilderSessionOnSend(emptyAgentBuilderSession(), "帮我建个周报助手");
  const done = agentBuilderSessionOnResult(sent, {
    reply: "先问两个问题：给谁看？多久一次？",
    draft,
    degraded: false,
  });
  assert.equal(done.status, "idle");
  assert.equal(done.failure, null);
  assert.deepEqual(done.draft, draft);
  assert.deepEqual(done.messages, [
    { role: "user", content: "帮我建个周报助手" },
    { role: "assistant", content: "先问两个问题：给谁看？多久一次？" },
  ]);
  assert.deepEqual(agentBuilderHistoryOf(done.messages), [
    { role: "user", content: "帮我建个周报助手" },
    { role: "assistant", content: "先问两个问题：给谁看？多久一次？" },
  ]);
});

// ---------- ② 降级轮 → 重试成功 ----------

test("降级轮：助手消息带 degraded 标记、草稿原样（不更新）、可继续对话", () => {
  const sent = agentBuilderSessionOnSend(emptyAgentBuilderSession(), "面向研发团队");
  const degraded = agentBuilderSessionOnResult(sent, {
    reply: "我觉得可以先这样。",
    draft: null,
    degraded: true,
  });
  assert.equal(degraded.messages.at(-1)?.degraded, true);
  assert.equal(degraded.draft, null, "降级轮草稿不动");
  assert.equal(degraded.status, "idle");
  assert.equal(agentBuilderAwaitingReply(degraded.messages), false, "降级轮也是有回复的一轮");
});

test("重试本轮：失败后用户消息仍是最末一条 ⇒ awaitingReply 为真，重发同一条答案", () => {
  const sent = agentBuilderSessionOnSend(emptyAgentBuilderSession(), "面向研发团队");
  const failed = agentBuilderSessionOnFailure(sent, agentBuilderFailureOf(new Error("ECONNRESET")));
  assert.equal(failed.status, "idle");
  assert.equal(failed.failure?.kind, "request-failed");
  assert.equal(agentBuilderAwaitingReply(failed.messages), true, "本轮没有回复 ⇒ 可重试");
  // 重试就是把同一条答案再发一次：转写不需要改，只是重新进入 pending。
  const retry = { ...failed, status: "pending" as const, failure: null };
  assert.deepEqual(retry.messages, failed.messages);
  const recovered = agentBuilderSessionOnResult(retry, {
    reply: "好的。",
    draft,
    degraded: false,
  });
  assert.equal(recovered.failure, null);
  assert.deepEqual(recovered.draft, draft);
});

test("停止：回到 idle，但**保留**刚发出的用户消息（否则「重试本轮」无话可发）", () => {
  const sent = agentBuilderSessionOnSend(emptyAgentBuilderSession(), "面向研发团队");
  const stopped = agentBuilderSessionOnStop(sent);
  assert.equal(stopped.status, "idle");
  assert.deepEqual(stopped.messages, sent.messages);
  assert.equal(agentBuilderAwaitingReply(stopped.messages), true);
});

// ---------- ③ 失败分流：模型不可用 → 手动创建 ----------

test("失败分流：模型不可用单成一档（引导去手动创建），其余一律按请求失败处理", () => {
  const unavailable = agentBuilderFailureOf(
    Object.assign(new Error("没有可用的模型"), {
      code: AGENT_BUILDER_ERROR_CODES.modelUnavailable,
    }),
  );
  assert.equal(unavailable.kind, "model-unavailable");
  assert.equal(unavailable.message, "没有可用的模型", "原始原因照带（不吞错）");

  const failed = agentBuilderFailureOf(
    Object.assign(new Error("模型请求失败。"), { code: AGENT_BUILDER_ERROR_CODES.requestFailed }),
  );
  assert.equal(failed.kind, "request-failed");

  // 两档与服务的错误 taxonomy 同形：没有 code 的错误（传输层 / 未知）归请求失败 ——
  // 它们的界面动作与「重试本轮」完全相同，多造一档只会多一个没有行为差异的分支。
  for (const other of [new Error("boom"), "boom", null, undefined]) {
    assert.equal(agentBuilderFailureOf(other).kind, "request-failed");
  }
  // 非 Error 也要给出可读文案（不能显示 [object Object] 或空白）。
  assert.ok(agentBuilderFailureOf("boom").message.length > 0);
});

// ---------- ④ 草稿 → 表单初值（§4-D4 生成边界） ----------

test("预填映射：六个生成字段进初值，越权字段没有任何通路", () => {
  const initial = agentBuilderDraftToTeamAgentInitial(draft);
  assert.deepEqual(initial, {
    name: "周报助手",
    systemPrompt: "# 角色\n你是周报助手",
    memoryScope: "project",
    description: "每周五汇总研发进展",
    skills: ["wiki", "git"],
    permissionMode: "plan",
  });
  const serialized = JSON.stringify(initial);
  for (const forbidden of [
    "mcpServers",
    "tools",
    "disallowedTools",
    "modelSelection",
    "color",
    "maxConcurrentRuns",
    "enabled",
    "provenance",
  ]) {
    assert.equal(
      serialized.includes(forbidden),
      false,
      `${forbidden} 不在生成边界内（由用户在表单里自己选）`,
    );
    assert.equal(Object.hasOwn(initial, forbidden), false);
  }
  // 空字段不落成"空字符串"：undefined 让表单用默认值（空描述不该占一个槽位）。
  const sparse = agentBuilderDraftToTeamAgentInitial({
    name: "只有名字",
    description: "",
    systemPrompt: "",
    skills: [],
    memoryScope: "user",
    permissionMode: null,
  });
  assert.deepEqual(sparse, { name: "只有名字", systemPrompt: "", memoryScope: "user" });
});

test("草稿映射与入参不共享可变引用（skills 换新数组）", () => {
  const initial = agentBuilderDraftToTeamAgentInitial(draft);
  initial.skills?.push("mutated");
  assert.deepEqual(draft.skills, ["wiki", "git"], "改初值不得改到草稿");
});

test("去确认的闸：草稿有内容才可确认（空草稿仍可「改为手动创建」）", () => {
  assert.equal(agentBuilderDraftHasContent(draft), true);
  assert.equal(agentBuilderDraftHasContent(null), false);
  assert.equal(
    agentBuilderDraftHasContent({ ...draft, name: "", systemPrompt: "" }),
    true,
    "描述也算内容",
  );
  assert.equal(
    agentBuilderDraftHasContent({
      name: "",
      description: "  ",
      systemPrompt: "",
      skills: [],
      memoryScope: "project",
      permissionMode: null,
    }),
    false,
    "全空白 = 没有草稿可确认",
  );
});

// ---------- ⑤ 预览卡片的事实（组件只负责画） ----------

test("预览摘要：名字/描述/提示词摘要与字数/技能/两处枚举文案键", () => {
  const summary = agentBuilderDraftSummary(draft);
  assert.equal(summary.name, "周报助手");
  assert.equal(summary.description, "每周五汇总研发进展");
  assert.equal(summary.promptExcerpt, "# 角色\n你是周报助手");
  assert.equal(summary.promptLength, draft.systemPrompt.length);
  assert.deepEqual(summary.skills, ["wiki", "git"]);
  assert.equal(summary.memoryScopeMessageId, "squad.common.memoryScope.project");
  assert.equal(summary.permissionModeMessageId, "squad.common.permissionMode.plan");

  // 未设置的权限模式走「跟随默认」文案键；长提示词只截断、不改写（预览就是原文前缀）。
  const longPrompt = `a\n\n${"b".repeat(400)}`;
  const long = agentBuilderDraftSummary({
    ...draft,
    permissionMode: null,
    systemPrompt: longPrompt,
  });
  assert.equal(long.permissionModeMessageId, "squad.common.permissionMode.unset");
  assert.ok(long.promptExcerpt.length < long.promptLength);
  assert.ok(longPrompt.startsWith(long.promptExcerpt), "摘要必须是原文前缀（不重写内容）");
  assert.ok(
    agentBuilderDraftSummary(draft).promptExcerpt.length === draft.systemPrompt.length,
    "短提示词不改写（原样预览）",
  );
});
