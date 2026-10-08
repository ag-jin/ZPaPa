import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_BUILDER_DRAFT_FIELDS_HINT,
  buildAgentBuilderSystemPrompt,
} from "../src/agentbuilder/systemPrompt.js";

/* 访谈系统提示词的**纪律条款**（设计报告 §4-D1/D4，译自 multica `agent_builder.go:19-40`）。

   测的是「这些条款必须在场」，不是逐字文本 —— 措辞可以改，条款不能丢：
   追问形态、草稿块契约、生成边界（不生成 mcpServers/tools）、不自称已创建、不碰密钥、回复语言。 */

const zhPrompt = buildAgentBuilderSystemPrompt({ locale: "zh-CN" });
const enPrompt = buildAgentBuilderSystemPrompt({ locale: "en-US" });

test("追问形态：首轮即出草稿 + 每轮最多两个聚焦追问（两语都在）", () => {
  assert.match(zhPrompt, /首轮/, "中文版必须要求首轮就给出草稿");
  assert.match(zhPrompt, /最多\s*两(个|条)追问|最多两个问题/, "中文版必须写明每轮最多两个追问");
  assert.match(enPrompt, /at most two/i, "英文版必须写明每轮最多两个追问");
  assert.match(enPrompt, /first turn|immediately|right away/i, "英文版必须要求首轮即出草稿");
});

test("草稿块契约：标签、单行 JSON 不进围栏、六个字段名逐个在场（两语一致）", () => {
  for (const prompt of [zhPrompt, enPrompt]) {
    assert.match(prompt, /<agent_draft>/);
    assert.match(prompt, /<\/agent_draft>/);
    assert.match(prompt, /JSON/);
    assert.ok(!/```json[\s\S]*<agent_draft>/.test(prompt), "模板示例不得写成围栏 JSON 块");
  }
  // 字段名是协议的一部分：两语提示词必须是**同一组键**（换语言不能换协议）。
  for (const prompt of [zhPrompt, enPrompt]) {
    for (const field of [
      "name",
      "description",
      "systemPrompt",
      "skills",
      "memoryScope",
      "permissionMode",
    ]) {
      assert.ok(prompt.includes(field), `提示词必须点名 ${field}`);
    }
  }
  assert.equal(AGENT_BUILDER_DRAFT_FIELDS_HINT.includes("mcpServers"), false);
});

test("生成边界：明令不得生成 mcpServers / tools / 模型 / 密钥（永不生成列）", () => {
  for (const prompt of [zhPrompt, enPrompt]) {
    assert.match(prompt, /mcpServers|MCP/, "必须点名 mcpServers 不许生成");
    assert.match(prompt, /tools|工具白名单|工具清单/, "必须点名 tools 不许生成");
    assert.match(prompt, /密钥|secrets?|token/i, "必须明令不碰密钥/token");
  }
});

test("不自称已创建：草稿必须由用户在界面上审阅确认后才落盘", () => {
  assert.match(zhPrompt, /不要?声称|不得声称|不要说.*已创建|尚未创建/, "中文版必须禁止自称已创建");
  assert.match(
    enPrompt,
    /never (claim|say|state)[\s\S]{0,40}(created|creation)/i,
    "英文版必须禁止自称已创建",
  );
});

test("历史信封纪律：当前权威草稿在最末一条信封里（模型要知道往哪读）", () => {
  for (const prompt of [zhPrompt, enPrompt]) {
    assert.match(prompt, /current_draft/, "必须点名信封里的 current_draft 字段");
  }
});

test("回复语言跟随界面 locale（两语各自要求自己的语言）", () => {
  assert.match(zhPrompt, /简体中文|中文/, "中文界面的提示词要求中文回复");
  assert.match(enPrompt, /English/i, "英文界面要求英文回复");
  assert.notEqual(zhPrompt, enPrompt, "两种语言必须是两份提示词（不是同一份加一行）");
});
