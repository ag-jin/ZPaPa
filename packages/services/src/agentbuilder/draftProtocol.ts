/* AgentBuilder 访谈的**下行协议**：模型回复尾随一个 <agent_draft> JSON 块。

   为什么不是「纯 JSON 输出」：访谈回复天然是双载荷 —— 块外是给用户读的追问/解释，
   块内是驱动草稿的机器数据。这与 multica 的形态一致（取证见设计报告 §A2），
   三重防御也是照它的实测教训逐层加的（`builder-protocol.ts:37-99`）：

   ① 标签正则抽块（块可能未闭合、可能出现两次）；
   ② 宽容 JSON 抽取（模型常把 JSON 包进 markdown 围栏，或前后夹带解释）；
   ③ 字符串内裸换行修复（CLI 模型在 markdown 正文里留字面换行是常态）。

   越权字段（mcpServers / tools / id…）不在这里过滤：过滤是合并层的事，
   这里只负责「能不能解析成一个 JSON 对象」。 */

import {
  AGENT_BUILDER_DRAFT_LIMITS,
  TEAM_AGENT_MEMORY_SCOPES,
  TEAM_AGENT_PERMISSION_MODES,
  type AgentBuilderDraft,
} from "@zcode/shared";

const AGENT_DRAFT_BLOCK_RE = /<agent_draft>([\s\S]*?)<\/agent_draft>/g;
/** 未闭合的尾随块（模型被截断 / 只吐了开标签）。 */
const AGENT_DRAFT_TAIL_RE = /\s*<agent_draft>[\s\S]*$/;
const CODE_FENCE_RE = /```(?:json|JSON)?\s*([\s\S]*?)```/;

export interface AgentDraftBlockReadResult {
  /** 剥离草稿块后的自然语言回复（块外文字就是给用户看的追问/解释）。 */
  reply: string;
  /** 解析出的原始载荷；null = 本轮没有可用的草稿块。 */
  payload: Record<string, unknown> | null;
}

/**
 * 读一封模型回复：给出「给用户读的正文」与「解析出的载荷」。
 *
 * 两个刻意的取舍：
 * 1. **取最后一个块**（不是第一个）：系统提示词里内嵌了草稿模板，模型偶尔会把模板原样
 *    回显一遍再给真草稿；取后者才是它真正想提交的那一份。
 * 2. **无论如何都剥块**：解析失败的降级轮若把原始 JSON 留在正文里，用户会在聊天面板里
 *    看到一段机器载荷 —— 那正是 stripBuilderDraft 要解决的问题（multica 同款）。
 */
export function readAgentDraftBlock(content: string): AgentDraftBlockReadResult {
  const blocks = [...content.matchAll(AGENT_DRAFT_BLOCK_RE)].map((match) => match[1] ?? "");
  const lastBlock = blocks.at(-1);
  return {
    reply: stripAgentDraftBlocks(content),
    payload: lastBlock === undefined ? null : parseDraftPayload(lastBlock),
  };
}

/** 剥掉全部草稿块（含未闭合的尾随块），并去掉因此留下的空行。 */
export function stripAgentDraftBlocks(content: string): string {
  return content.replace(AGENT_DRAFT_BLOCK_RE, "").replace(AGENT_DRAFT_TAIL_RE, "").trim();
}

/**
 * 把载荷逐字段并进当前草稿。
 *
 * 三条纪律（multica `mergeBuilderDraft` 的移植位，`builder-protocol.ts:219-299`）：
 * 1. **逐字段**：只读认识的六个键，其余（含 mcpServers / tools / id / color）一律丢弃 ——
 *    越权字段不是"被覆盖"，而是根本没有通路进结果；
 * 2. **坏值不报废整轮**：某个字段类型不对就按「未给出」处理，其余字段照常合并；
 * 3. **空值不清空已有内容**：空串 / 纯空白的文本字段视为未提供（这是「返回的草稿
 *    name/systemPrompt 非空」这个不变量的执行点，用户要清空该在表单里改）。
 *
 * 另外两条与「谁持有草稿」有关的纪律：
 * 4. **内容全同 ⇒ 交回原引用**（对齐 `teamAgentService.update`）：UI 把它放在 React state 里，
 *    每次都被换成一个内容相同的对象只会平白触发重渲染；
 * 5. **有改动 ⇒ 逐字段新建 + skills 换新数组**：不让调用方的可变对象与草稿共享引用
 *    （`prefillFrom` 同款纪律）——共享数组会让「在 state 里改一个元素」静默漏掉重渲染。
 */
export function mergeAgentBuilderDraft(
  current: AgentBuilderDraft,
  payload: Record<string, unknown>,
): AgentBuilderDraft {
  const name = readDraftText(payload.name, AGENT_BUILDER_DRAFT_LIMITS.name) ?? current.name;
  const description =
    readDraftText(payload.description, AGENT_BUILDER_DRAFT_LIMITS.description) ??
    current.description;
  const systemPrompt =
    readDraftText(payload.systemPrompt, AGENT_BUILDER_DRAFT_LIMITS.systemPrompt) ??
    current.systemPrompt;
  const skills = readDraftSkills(payload.skills) ?? current.skills;
  const memoryScope = readDraftMemoryScope(payload.memoryScope) ?? current.memoryScope;
  const permissionModeField = readDraftPermissionMode(payload);
  const permissionMode =
    permissionModeField === undefined ? current.permissionMode : permissionModeField;

  if (
    name === current.name &&
    description === current.description &&
    systemPrompt === current.systemPrompt &&
    skills === current.skills &&
    memoryScope === current.memoryScope &&
    permissionMode === current.permissionMode
  ) {
    return current;
  }

  return { name, description, systemPrompt, skills: [...skills], memoryScope, permissionMode };
}

/** 文本字段：非字符串 / 空白 ⇒ 未提供；超长按字符（码点）截断而不是拒整轮。 */
function readDraftText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return clampByCodePoints(trimmed, maxLength);
}

/** 技能令牌：过滤非字符串/空、去重保序、逐个与整体都钳长度；`[]` = 显式清空。 */
function readDraftSkills(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const tokens: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const token = clampByCodePoints(item.trim(), AGENT_BUILDER_DRAFT_LIMITS.skill);
    if (token.length === 0 || tokens.includes(token)) continue;
    tokens.push(token);
    if (tokens.length >= AGENT_BUILDER_DRAFT_LIMITS.skills) break;
  }
  return tokens;
}

function readDraftMemoryScope(value: unknown): AgentBuilderDraft["memoryScope"] | null {
  return typeof value === "string" &&
    (TEAM_AGENT_MEMORY_SCOPES as readonly string[]).includes(value)
    ? (value as AgentBuilderDraft["memoryScope"])
    : null;
}

/** 三态：字段缺席 = 未提供（undefined）；显式 null = 清回未设置；非法值 = 未提供。 */
function readDraftPermissionMode(
  payload: Record<string, unknown>,
): AgentBuilderDraft["permissionMode"] | undefined {
  if (!Object.hasOwn(payload, "permissionMode")) return undefined;
  const value = payload.permissionMode;
  if (value === null) return null;
  return typeof value === "string" &&
    (TEAM_AGENT_PERMISSION_MODES as readonly string[]).includes(value)
    ? (value as "auto" | "plan")
    : undefined;
}

/** 按**码点**截断：按 UTF-16 下标切会把代理对劈成半个字符。 */
function clampByCodePoints(value: string, maxLength: number): string {
  return [...value].slice(0, maxLength).join("");
}

/** 宽容解析：围栏 → 裸区间 → 裸换行修复，逐层退让，最后仍要在 JSON.parse 面前过。 */
function parseDraftPayload(raw: string): Record<string, unknown> | null {
  const candidate = unwrapCodeFence(raw.trim());
  return parseJsonObject(candidate) ?? parseJsonObject(extractJsonObjectSlice(candidate));
}

function unwrapCodeFence(value: string): string {
  const fenced = CODE_FENCE_RE.exec(value);
  return (fenced?.[1] ?? value).trim();
}

/** 取第一个 `{` 到最后一个 `}` 的区间（模型在 JSON 前后夹带解释时退一步）。 */
function extractJsonObjectSlice(value: string): string {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  return start >= 0 && end > start ? value.slice(start, end + 1) : value;
}

function parseJsonObject(candidate: string): Record<string, unknown> | null {
  for (const text of [candidate, escapeJsonStringControlCharacters(candidate)]) {
    try {
      const value: unknown = JSON.parse(text);
      // 非对象（数组 / 数字 / 字符串）一律视为本块不可用：草稿的载荷必须是对象。
      return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      // 换一种修法再试；全都失败即本块不可用。
    }
  }
  return null;
}

/**
 * 只修 **JSON 字符串内**的控制字符（字面换行/回车/制表符），对象结构与其他语法一律不管 ——
 * 结构错了就该解析失败，而不是被"修"成另一个意思。
 */
function escapeJsonStringControlCharacters(value: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (const character of value) {
    if (!inString) {
      result += character;
      if (character === '"') inString = true;
      continue;
    }
    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      result += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      result += character;
      inString = false;
      continue;
    }
    if (character === "\n") {
      result += "\\n";
    } else if (character === "\r") {
      result += "\\r";
    } else if (character === "\t") {
      result += "\\t";
    } else {
      result += character;
    }
  }

  return result;
}
