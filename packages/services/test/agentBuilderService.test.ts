import assert from "node:assert/strict";
import test from "node:test";
import {
  agentBuilderDraftSchema,
  type AgentBuilderDraft,
  type ZCodeWorkspaceModelMessage,
} from "@zcode/shared";
import { AGENT_BUILDER_INPUT_PREFIX } from "../src/agentbuilder/envelope.js";
import {
  AGENT_BUILDER_ERROR_CODES,
  AgentBuilderError,
} from "../src/agentbuilder/agentBuilderErrors.js";
import {
  createAgentBuilderService,
  type AgentBuilderTextRequest,
} from "../src/agentbuilder/agentBuilderService.js";
import type { AgentBuilderTurn } from "../src/agentbuilder/agentBuilder.js";

/* AgentBuilder 服务面（设计报告 §5.4）：**接口即测试面** —— 注入 fake textGenerator /
   currentModelProvider，断言 reply / draft / degraded 三态、重试次数、以及真正发出去的
   messages 形状。不测到接口之内（提示词文本的条款另有 systemPrompt 单测）。

   四条降级/错误纪律（§4-D4）：
   - 输出不合规 ⇒ 追加纠错消息**重试一次**；
   - 再不合规 ⇒ 降级返回（草稿不动、degraded=true、不打断对话）；
   - 模型不可用 / 请求失败 ⇒ **响亮抛**（UI 渲染重试）；
   - 越权字段 ⇒ 丢弃（不是"降级"：本轮其余字段照常合并）。 */

const PREFERRED = { providerId: "anthropic", modelId: "claude-sonnet" } as const;

interface FakeCall {
  params: AgentBuilderTextRequest;
}

/** 按序返回预设响应；超出后重复最后一个。Error 实例表示该次调用抛错。 */
function createFakeTextGenerator(responses: ReadonlyArray<{ text: string } | Error>) {
  const calls: FakeCall[] = [];
  return {
    calls,
    async generateText(params: AgentBuilderTextRequest) {
      calls.push({ params });
      const response = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (response instanceof Error) throw response;
      return response ?? { text: "" };
    },
  };
}

function createService(options: {
  responses: ReadonlyArray<{ text: string } | Error>;
  preferred?: { providerId: string; modelId: string } | null;
  now?: () => number;
}) {
  const textGenerator = createFakeTextGenerator(options.responses);
  const service = createAgentBuilderService({
    textGenerator,
    currentModelProvider: {
      async readCurrentModel() {
        return options.preferred === undefined ? { ...PREFERRED } : options.preferred;
      },
    },
  });
  return { service, textGenerator };
}

function turn(role: "user" | "assistant", content: string): AgentBuilderTurn {
  return { role, content };
}

/** 解码第 index 条信封（测试用的独立读法：不经过实现里的任何解码函数）。 */
function decodeEnvelope(message: ZCodeWorkspaceModelMessage): Record<string, unknown> {
  assert.ok(message.content.startsWith(AGENT_BUILDER_INPUT_PREFIX));
  return JSON.parse(message.content.slice(AGENT_BUILDER_INPUT_PREFIX.length)) as Record<
    string,
    unknown
  >;
}

const HISTORY: AgentBuilderTurn[] = [
  turn("user", "我想做一个帮忙写周报的智能体"),
  turn("assistant", "好的，先问两个问题。<agent_draft>{}</agent_draft>"),
  turn("user", "面向研发团队，每周五出"),
];

// ---------- ① 合规输出 ----------

test("合规输出：reply 去块、draft 合并、degraded=false，且 messages 形状正确", async () => {
  const { service, textGenerator } = createService({
    responses: [
      {
        text: '好的，我理解了。\n<agent_draft>{"name":"周报助手","memoryScope":"project"}</agent_draft>',
      },
    ],
  });

  const result = await service.interviewTurn({
    workspacePath: "/w",
    history: HISTORY,
    draft: null,
  });

  assert.equal(result.reply, "好的，我理解了。");
  assert.equal(result.degraded, false);
  assert.deepEqual(result.draft, {
    name: "周报助手",
    description: "",
    systemPrompt: "",
    skills: [],
    memoryScope: "project",
    permissionMode: null,
  });
  assert.equal(agentBuilderDraftSchema.safeParse(result.draft).success, true, "返回值必过 schema");

  // 真正发出去的请求（归因、模型、messages 三段结构）。
  assert.equal(textGenerator.calls.length, 1);
  const params = textGenerator.calls[0]?.params;
  assert.equal(params?.querySource, "agent_builder");
  assert.deepEqual(params?.selection, PREFERRED, "未显式指定时跟随当前默认模型");
  assert.equal(params?.workspacePath, "/w");
  const messages = params?.messages ?? [];
  assert.equal(messages.length, 4, "system + 3 条历史 + 1 条本轮信封");
  assert.equal(messages[0]?.role, "system");
  assert.match(String(messages[0]?.content), /<agent_draft>/, "系统提示词里带草稿块契约");
  assert.equal(messages[2]?.role, "assistant");
  assert.equal(messages[2]?.content, HISTORY[1]?.content, "assistant 轮原样进 messages");
  const last = decodeEnvelope(messages[3]!);
  assert.equal(last.user_request, "面向研发团队，每周五出");
  assert.equal(Object.hasOwn(last, "current_draft"), false, "首轮无草稿 ⇒ 省略该键");
  assert.equal(
    Object.hasOwn(decodeEnvelope(messages[1]!), "current_draft"),
    false,
    "历史用户轮不重申草稿",
  );
});

test("越权字段：被丢弃但本轮不降级（其余字段照常合并）", async () => {
  const draft: AgentBuilderDraft = {
    name: "旧名",
    description: "",
    systemPrompt: "旧提示词",
    skills: [],
    memoryScope: "project",
    permissionMode: null,
  };
  const { service } = createService({
    responses: [
      {
        text: '给你。<agent_draft>{"name":"新名","mcpServers":{"x":{"command":"npx","env":{"TOKEN":"s"}}},"tools":["Bash"],"id":"ta_1"}</agent_draft>',
      },
    ],
  });

  const result = await service.interviewTurn({ workspacePath: "/w", history: HISTORY, draft });
  assert.equal(result.degraded, false);
  assert.equal(result.draft.name, "新名");
  assert.equal(result.draft.systemPrompt, "旧提示词", "未提及的字段保持现值");
  assert.equal(JSON.stringify(result.draft).includes("mcpServers"), false);
  assert.equal(JSON.stringify(result.draft).includes("TOKEN"), false);
});

// ---------- ② 输出不合规：纠错重试一次 ----------

test("输出不合规 ⇒ 追加纠错消息重试一次；重试成功则本轮正常（reply 用第一次的正文）", async () => {
  const { service, textGenerator } = createService({
    responses: [
      { text: "我先问两个问题：这个智能体主要给谁用？" },
      { text: '抱歉。\n<agent_draft>{"name":"周报助手"}</agent_draft>' },
    ],
  });

  const result = await service.interviewTurn({
    workspacePath: "/w",
    history: HISTORY,
    draft: null,
  });

  assert.equal(textGenerator.calls.length, 2, "不合规必须恰好重试一次");
  const retryMessages = textGenerator.calls[1]?.params.messages ?? [];
  assert.equal(retryMessages.length, 6, "重试请求 = 原 messages + 第一次原文 + 纠错消息");
  assert.equal(retryMessages[4]?.role, "assistant");
  assert.equal(retryMessages[4]?.content, "我先问两个问题：这个智能体主要给谁用？");
  assert.equal(retryMessages[5]?.role, "user");
  assert.match(String(retryMessages[5]?.content), /<agent_draft>/, "纠错消息要指明缺了什么");
  assert.equal(
    retryMessages[5]?.content.startsWith(AGENT_BUILDER_INPUT_PREFIX),
    false,
    "纠错消息是机器指令，不是用户信封",
  );

  assert.equal(result.degraded, false);
  assert.equal(result.draft.name, "周报助手");
  assert.equal(result.reply, "我先问两个问题：这个智能体主要给谁用？", "给用户看的正文取第一次");
});

test("重试仍不合规 ⇒ 降级轮：草稿原样（同一引用）、degraded=true、回复仍可见", async () => {
  const draft: AgentBuilderDraft = {
    name: "已有草稿",
    description: "d",
    systemPrompt: "s",
    skills: ["a"],
    memoryScope: "user",
    permissionMode: "auto",
  };
  const { service, textGenerator } = createService({
    responses: [
      { text: "我觉得可以先这样。<agent_draft>not json</agent_draft>" },
      { text: "还是没给出来。" },
    ],
  });

  const result = await service.interviewTurn({ workspacePath: "/w", history: HISTORY, draft });

  assert.equal(textGenerator.calls.length, 2, "只重试一次，不无限循环");
  assert.equal(result.degraded, true);
  assert.equal(result.draft, draft, "降级轮草稿原样返回入参（同一引用，不造新对象）");
  assert.equal(result.reply, "我觉得可以先这样。", "降级也要把正文交给用户（不打断对话）");
  assert.equal(result.reply.includes("not json"), false, "原始载荷不得漏进可见回复");
});

// ---------- ③ 错误形态（响亮抛） ----------

test("模型不可用：readCurrentModel 为空 ⇒ 抛 model-unavailable，且一个模型请求都不发", async () => {
  const { service, textGenerator } = createService({ responses: [{ text: "" }], preferred: null });

  await assert.rejects(
    () => service.interviewTurn({ workspacePath: "/w", history: HISTORY, draft: null }),
    (error: unknown) => {
      assert.ok(error instanceof AgentBuilderError, "必须是类型化错误");
      assert.equal(error.reason, "model-unavailable");
      assert.equal(error.code, AGENT_BUILDER_ERROR_CODES.modelUnavailable);
      return true;
    },
  );
  assert.equal(textGenerator.calls.length, 0);
});

test("请求失败：generateText 抛错 ⇒ 包成 request-failed（带原始细节）", async () => {
  const { service } = createService({ responses: [new Error("ECONNRESET")] });

  await assert.rejects(
    () => service.interviewTurn({ workspacePath: "/w", history: HISTORY, draft: null }),
    (error: unknown) => {
      assert.ok(error instanceof AgentBuilderError);
      assert.equal(error.reason, "request-failed");
      assert.equal(error.code, AGENT_BUILDER_ERROR_CODES.requestFailed);
      assert.equal(error.detail, "ECONNRESET", "原始原因必须带出来（不吞错）");
      return true;
    },
  );
});

// ---------- ④ 入参透传（显式模型 / 取消 / locale / 历史钳制） ----------

test("显式 selection 优先于当前默认模型", async () => {
  const { service, textGenerator } = createService({
    responses: [{ text: "<agent_draft>{}</agent_draft>" }],
  });
  const explicit = { providerId: "openai", modelId: "gpt-x", options: { reasoningLevel: "high" } };

  await service.interviewTurn({
    workspacePath: "/w",
    history: HISTORY,
    draft: null,
    selection: explicit,
  });

  assert.deepEqual(textGenerator.calls[0]?.params.selection, explicit);
});

test("取消：AbortSignal 原样透传给模型请求", async () => {
  const { service, textGenerator } = createService({
    responses: [{ text: "<agent_draft>{}</agent_draft>" }],
  });
  const controller = new AbortController();

  await service.interviewTurn({
    workspacePath: "/w",
    history: HISTORY,
    draft: null,
    signal: controller.signal,
  });

  assert.equal(textGenerator.calls[0]?.params.signal, controller.signal);
});

test("locale 决定系统提示词语言（跟随界面，两语各一份）", async () => {
  const zh = createService({ responses: [{ text: "<agent_draft>{}</agent_draft>" }] });
  await zh.service.interviewTurn({
    workspacePath: "/w",
    history: HISTORY,
    draft: null,
    locale: "zh-CN",
  });
  const en = createService({ responses: [{ text: "<agent_draft>{}</agent_draft>" }] });
  await en.service.interviewTurn({
    workspacePath: "/w",
    history: HISTORY,
    draft: null,
    locale: "en-US",
  });

  const zhSystem = String(zh.textGenerator.calls[0]?.params.messages[0]?.content);
  const enSystem = String(en.textGenerator.calls[0]?.params.messages[0]?.content);
  assert.match(zhSystem, /简体中文/);
  assert.match(enSystem, /English/);
});

test("历史钳制接入装配：41 条历史 ⇒ 发出去 1 + 30 + 1 条", async () => {
  const { service, textGenerator } = createService({
    responses: [{ text: "<agent_draft>{}</agent_draft>" }],
  });
  const long: AgentBuilderTurn[] = Array.from({ length: 41 }, (_, index) =>
    turn(index % 2 === 0 ? "user" : "assistant", `m${index}`),
  );

  await service.interviewTurn({ workspacePath: "/w", history: long, draft: null });

  const messages = textGenerator.calls[0]?.params.messages ?? [];
  assert.equal(messages.length, 32);
  assert.equal(messages[0]?.role, "system");
  assert.equal(decodeEnvelope(messages[1]!).user_request, "m0", "首条用户目标必须保留");
  assert.equal(decodeEnvelope(messages.at(-1)!).user_request, "m40", "本轮信封在最末");
});
