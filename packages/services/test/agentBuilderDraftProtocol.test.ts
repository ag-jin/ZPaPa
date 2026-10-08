import assert from "node:assert/strict";
import test from "node:test";
import { agentBuilderDraftSchema, type AgentBuilderDraft } from "@zcode/shared";
import { mergeAgentBuilderDraft, readAgentDraftBlock } from "../src/agentbuilder/draftProtocol.js";

/* 草稿协议解析（设计报告 §4-D2「三重防御」）：模型每轮回复尾随一个 <agent_draft> JSON 块。
   这一层是**纯函数**：输入模型原文，输出「给用户看的回复」+「解析出的原始载荷」。
   载荷是否合规由服务面判定（见 agentBuilderService 的降级轮），这里只钉解析本身。 */

test("合法尾随块：正文保留、载荷解析为对象", () => {
  const parsed = readAgentDraftBlock(
    '好的，我先给一版草稿。\n<agent_draft>{"name":"审查员","memoryScope":"project"}</agent_draft>',
  );
  assert.equal(parsed.reply, "好的，我先给一版草稿。");
  assert.deepEqual(parsed.payload, { name: "审查员", memoryScope: "project" });
});

// ---------- 协议矩阵：三重防御逐层 ----------

test("防御②：块内 JSON 被 markdown 围栏包住时仍能解析", () => {
  const parsed = readAgentDraftBlock(
    [
      "先问两个问题。",
      "<agent_draft>",
      "```json",
      '{"name":"A","skills":["x"]}',
      "```",
      "</agent_draft>",
    ].join("\n"),
  );
  assert.deepEqual(parsed.payload, { name: "A", skills: ["x"] });
  assert.equal(parsed.reply, "先问两个问题。");
});

// 模型常在 systemPrompt 里写完整 Markdown，字面换行是 CLI 模型最常见的违规形态（multica 实测同款）。
test("防御③：字符串内裸换行被修复（结构非法不救，只救字符串内控制字符）", () => {
  const parsed = readAgentDraftBlock(
    [
      '<agent_draft>{"name":"审查员","systemPrompt":"# 角色',
      "你是审查员。",
      "",
      "# 约束",
      '只读。"}</agent_draft>',
    ].join("\n"),
  );
  assert.deepEqual(parsed.payload, {
    name: "审查员",
    systemPrompt: "# 角色\n你是审查员。\n\n# 约束\n只读。",
  });
});

test("标签缺失：payload 为 null，回复原文照常返回（降级轮的输入）", () => {
  const parsed = readAgentDraftBlock("你觉得这个智能体应该叫什么？");
  assert.equal(parsed.payload, null);
  assert.equal(parsed.reply, "你觉得这个智能体应该叫什么？");
});

test("空块 / 非对象载荷 / 结构非法：payload 为 null（不造假草稿）", () => {
  for (const raw of [
    "<agent_draft></agent_draft>",
    "<agent_draft>   </agent_draft>",
    "<agent_draft>not json</agent_draft>",
    "<agent_draft>[1,2,3]</agent_draft>",
    '<agent_draft>"just a string"</agent_draft>',
    "<agent_draft>{'name':'单引号'}</agent_draft>",
    // 结构错误（缺逗号）**不得**被修复成另一个意思。
    '<agent_draft>{"name":"A" "skills":[]}</agent_draft>',
  ]) {
    assert.equal(readAgentDraftBlock(raw).payload, null, `${raw} 不应解析出载荷`);
  }
});

test("非对象载荷同样被剥出可见回复（用户不该在聊天里看到机器载荷）", () => {
  const parsed = readAgentDraftBlock("先说结论。\n<agent_draft>not json</agent_draft>");
  assert.equal(parsed.reply, "先说结论。");
  assert.equal(parsed.payload, null);
});

/* 系统提示词里内嵌了草稿模板，模型偶尔把模板原样回显一遍再给真草稿 —— 取**最后**一个块。 */
test("两个块：取最后一个（模板回显不得压过真草稿），两个都从可见回复里剥掉", () => {
  const parsed = readAgentDraftBlock(
    [
      '格式如下：<agent_draft>{"name":"","description":"","systemPrompt":""}</agent_draft>',
      "这是我给你的草稿。",
      '<agent_draft>{"name":"真草稿"}</agent_draft>',
    ].join("\n"),
  );
  assert.deepEqual(parsed.payload, { name: "真草稿" });
  assert.equal(parsed.reply, "格式如下：\n这是我给你的草稿。");
});

// 未闭合块（模型被截断）：载荷不可用，但块本身绝不能留在可见回复里。
test("未闭合块：从可见回复里剥掉，payload 为 null", () => {
  const parsed = readAgentDraftBlock('先问一句。\n<agent_draft>{"name":"中断');
  assert.equal(parsed.reply, "先问一句。");
  assert.equal(parsed.payload, null);
});

test("正文夹带解释：JSON 前后有文字时仍能取到区间", () => {
  const parsed = readAgentDraftBlock(
    '这是我的一版草稿：\n<agent_draft>以下是 JSON：{"name":"A"} 就这样。</agent_draft>',
  );
  assert.deepEqual(parsed.payload, { name: "A" });
});

// ---------- 合并纪律：逐字段、防御、保持现值 ----------

const current: AgentBuilderDraft = {
  name: "旧名字",
  description: "旧描述",
  systemPrompt: "旧提示词",
  skills: ["old"],
  memoryScope: "user",
  permissionMode: "auto",
};

test("合并：给出的字段更新，未给出的字段保持现值（不整包替换）", () => {
  assert.deepEqual(mergeAgentBuilderDraft(current, { name: "新名字" }), {
    ...current,
    name: "新名字",
  });
  assert.deepEqual(mergeAgentBuilderDraft(current, {}), current);
  // 类型不对的字段按「未给出」处理：其余字段照常更新（不因一个坏字段报废整轮）。
  assert.deepEqual(mergeAgentBuilderDraft(current, { name: 42, description: "新描述" }), {
    ...current,
    description: "新描述",
  });
});

/* 越权字段（§4-D4「永不生成」那一列）没有通路进结果：草稿 schema 里根本不存在这些键，
   合并层也不读它们。mcpServers 是重点 —— 它可能含 env/token。 */
test("越权字段：mcpServers / tools / id / color / enabled 一律被丢弃", () => {
  const merged = mergeAgentBuilderDraft(current, {
    name: "新名字",
    mcpServers: { "code-search": { command: "npx", env: { TOKEN: "secret" } } },
    tools: ["Bash"],
    disallowedTools: ["WebFetch"],
    id: "ta_1",
    color: "red",
    enabled: false,
    archivedAt: 1,
    provenance: { source: "ai_builder" },
    modelSelection: { providerId: "p", modelId: "m" },
  });
  assert.deepEqual(merged, { ...current, name: "新名字" });
  // 机器化证明：结果里连敏感键的影子都没有（不是"值为空"，是键不存在）。
  const serialized = JSON.stringify(merged);
  for (const forbidden of ["mcpServers", "tools", "TOKEN", "secret", "id", "color"]) {
    assert.equal(serialized.includes(forbidden), false, `结果里不得出现 ${forbidden}`);
  }
});

test("空草稿：空对象不改变任何字段（也不被当成降级）", () => {
  assert.deepEqual(mergeAgentBuilderDraft(current, {}), current);
});

test("skills：去空、去重保序、钳个数与单令牌长度；[] 是显式清空", () => {
  const merged = mergeAgentBuilderDraft(current, {
    skills: ["  review ", "review", "", "git", 42, "x".repeat(80)],
  });
  assert.deepEqual(merged.skills, ["review", "git", "x".repeat(60)]);
  assert.deepEqual(mergeAgentBuilderDraft(current, { skills: [] }).skills, []);
  // 非数组（含 null）＝ 未提供，保持现值。
  assert.deepEqual(mergeAgentBuilderDraft(current, { skills: null }).skills, current.skills);
  assert.deepEqual(mergeAgentBuilderDraft(current, { skills: "review" }).skills, current.skills);
  // 个数上限：多出的被截掉，不是整条拒绝。
  const many = Array.from({ length: 30 }, (_, index) => `s${index}`);
  assert.deepEqual(mergeAgentBuilderDraft(current, { skills: many }).skills, many.slice(0, 20));
});

test("memoryScope：合法枚举更新，非法值保持现值", () => {
  assert.equal(mergeAgentBuilderDraft(current, { memoryScope: "local" }).memoryScope, "local");
  for (const bad of ["global", "", 7, null, ["user"]]) {
    assert.equal(
      mergeAgentBuilderDraft(current, { memoryScope: bad }).memoryScope,
      current.memoryScope,
      `memoryScope=${JSON.stringify(bad)} 应保持现值`,
    );
  }
});

test("permissionMode 三态：缺席保持现值、null 清回未设置、枚举更新、非法保持现值", () => {
  assert.equal(mergeAgentBuilderDraft(current, {}).permissionMode, "auto");
  assert.equal(mergeAgentBuilderDraft(current, { permissionMode: null }).permissionMode, null);
  assert.equal(mergeAgentBuilderDraft(current, { permissionMode: "plan" }).permissionMode, "plan");
  assert.equal(mergeAgentBuilderDraft(current, { permissionMode: "yolo" }).permissionMode, "auto");
  // 已经是 null 时，缺席也不得被"补"回一个值。
  const unset: AgentBuilderDraft = { ...current, permissionMode: null };
  assert.equal(mergeAgentBuilderDraft(unset, {}).permissionMode, null);
});

test("文本字段：空白视为未提供（不清空已有值），超长按码点截断", () => {
  for (const blank of ["", "   ", "\n\t "]) {
    assert.equal(mergeAgentBuilderDraft(current, { name: blank }).name, current.name);
  }
  assert.equal(
    mergeAgentBuilderDraft(current, { description: "d".repeat(500) }).description,
    "d".repeat(200),
  );
  assert.equal(
    mergeAgentBuilderDraft(current, { systemPrompt: "s".repeat(30_000) }).systemPrompt.length,
    20_000,
  );
  assert.equal(mergeAgentBuilderDraft(current, { name: "x".repeat(100) }).name, "x".repeat(60));
  // 首个字段超长时那个字段本身仍被截断保留（不是整条丢弃）。
  assert.equal(mergeAgentBuilderDraft(current, { name: "新名字" }).name, "新名字");
});

/* 不变量（§5.1）：服务面交出去的草稿**永远**通过 agentBuilderDraftSchema ——
   否则调用方（表单预填）就得自己再防一遍。矩阵：每个坏值 × 每个字段都过一遍 schema。 */
test("不变量：任意载荷的合并结果都通过 agentBuilderDraftSchema", () => {
  const payloads: Record<string, unknown>[] = [
    {},
    { name: "" },
    { name: "N", description: "D", systemPrompt: "S", skills: ["a"], memoryScope: "user" },
    { name: 1, description: null, systemPrompt: [], skills: {}, memoryScope: 0, permissionMode: 1 },
    { skills: ["x".repeat(200)] },
    { permissionMode: null },
    { systemPrompt: "S".repeat(50_000) },
  ];
  for (const payload of payloads) {
    const merged = mergeAgentBuilderDraft(current, payload);
    assert.equal(
      agentBuilderDraftSchema.safeParse(merged).success,
      true,
      `合并结果必须过 schema：${JSON.stringify(payload).slice(0, 60)}`,
    );
    // 且不得返回入参对象本身的可变共享引用（调用方改结果不该改到入参）。
    if (merged !== current) {
      merged.skills.push("mutated");
      assert.equal(current.skills.includes("mutated"), false, "结果与入参不得共享数组引用");
    }
  }
});
