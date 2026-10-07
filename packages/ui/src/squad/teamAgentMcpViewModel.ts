import { teamAgentMcpServersSchema, type McpServerConfig } from "@zcode/shared";

/* 协作智能体**编辑面**上「per-agent MCP」的纯逻辑（设计 §3.6）：名字校验、逐条配置浅校验、
   传输类型推断、以及提交时的字段语义。组件（`TeamAgentMcpSection`）只做投影，判断都在这里 ——
   ui 包没有渲染设施（既有做法），行为必须落在能被 node:test 直接钉住的纯模块上。

   为什么校验不复用 host 侧 / services 侧的判据：那边判的是**落盘形状**（`teamAgentMcpServersSchema`
   逐条 safeParse），这里判的是**用户输入**（名字字符集、JSON 文本能否读成一条配置）。
   两者共用的是同一个 schema（下面 `parseMcpServerConfigText` 直接调它），不是同一份实现。 */

/** server 名字符集：对齐 multica agent 级对话框的 `^[A-Za-z0-9_-]+$`。
    空名在协议里会变成 `mcp__<server>__` 前缀的孤儿段，且与「同名覆盖」的判据互相矛盾 —— 在这里拒掉。 */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 名字校验的失败档位（i18n 键后缀：`squad.agentMcp.nameError.<issue>`）。 */
export type McpServerNameIssue = "required" | "format" | "duplicate";

/**
 * 校验「对话框里刚输入的名字」。三条判据（对齐 multica `mcp-server-dialog.tsx:283-293`）：
 *  · 空白 ⇒ `required`；字符集之外 ⇒ `format`；
 *  · 与**既有行**重名 ⇒ `duplicate`（`existingNames` 由调用方给出——它是当前 map 的键集，
 *    不是 workspace 级 server 名单：跨层同名是**覆盖**语义，合法且刻意）；
 *  · `keepName` = 编辑既有行时的原名字：沿用原名不算和自己重复。
 * 比较前两侧 trim（输入框允许手滑带上空白，但空白不是身份的一部分）。
 */
export function validateMcpServerName(
  name: string,
  existingNames: readonly string[],
  options?: { keepName?: string },
): McpServerNameIssue | null {
  const trimmed = name.trim();
  if (trimmed === "") return "required";
  if (!MCP_SERVER_NAME_PATTERN.test(trimmed)) return "format";
  if (trimmed === options?.keepName) return null;
  if (existingNames.includes(trimmed)) return "duplicate";
  return null;
}

/** 名字档位的文案键：与配置档位、传输档位同一棵子树（`squad.agentMcp.*`）。 */
export function mcpServerNameErrorMessageId(issue: McpServerNameIssue): string {
  return `squad.agentMcp.nameError.${issue}`;
}

/** 配置浅校验的失败档位（i18n 键后缀：`squad.agentMcp.jsonError.<issue>`）。 */
export type McpServerConfigIssue = "invalidJson" | "notObject" | "missingTransport" | "invalidShape";

export type McpServerConfigParseResult =
  | { ok: true; config: McpServerConfig }
  | { ok: false; issue: McpServerConfigIssue; messageId: string; detail?: string };

/** 占位 key：校验的是「这一条配置的值」的形状，名字的合法性归名字字段判（见 validateMcpServerName）。
    用占位名而不是用户正在输入的名字，是为了**归因正确**——否则一个空名字会让 JSON 框里报出
    「名字非法」，用户看着两个框不知道该改哪个。 */
const DRAFT_SERVER_KEY = "__draft__";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configFailure(issue: McpServerConfigIssue, detail?: string): McpServerConfigParseResult {
  return {
    ok: false,
    issue,
    messageId: `squad.agentMcp.jsonError.${issue}`,
    ...(detail !== undefined ? { detail } : {}),
  };
}

/**
 * 「名字 + JSON 配置」对话框里对配置文本的**浅校验**（设计 §3.6）：
 *  · 先 JSON.parse，失败 ⇒ `invalidJson`。**刻意不带出 JSON.parse 的消息** ——
 *    它在 node 里形如 `Unexpected token 'x', "{"a": x}" is not valid JSON`，会把用户输入（可能是 token）抄进界面与日志；
 *  · 再交给 shared 的 `teamAgentMcpServersSchema` 逐条 safeParse（落盘前同一把闸），
 *    失败取**首条** issue：`custom`（refine：「至少要有 command 或 url」）⇒ `missingTransport`，
 *    值这一层（path 长度 1）⇒ `notObject`，其余 ⇒ `invalidShape`；issue.message 作为 detail 透出
 *    （schema 的固定文案，不含内容）；
 *  · 通过 ⇒ 返回 schema 解析后的配置（开放形状：args/env/headers/timeoutMs 等原样保留，
 *    编辑既有条目往返不丢字段）。
 */
export function parseMcpServerConfigText(text: string): McpServerConfigParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return configFailure("invalidJson");
  }
  if (!isPlainObject(parsed)) return configFailure("notObject");
  const result = teamAgentMcpServersSchema.safeParse({ [DRAFT_SERVER_KEY]: parsed });
  if (result.success) {
    return { ok: true, config: result.data[DRAFT_SERVER_KEY] as McpServerConfig };
  }
  const issue = result.error.issues[0];
  if (!issue) return configFailure("invalidShape");
  const kind: McpServerConfigIssue =
    issue.code === "custom" ? "missingTransport" : issue.path.length === 1 ? "notObject" : "invalidShape";
  return configFailure(kind, issue.message);
}

/** 显示用的传输类型档位（设计 §3.6 的 chip）。 */
export type McpTransportKind = "stdio" | "http" | "sse" | "streamableHttp";

/**
 * 从配置推断传输类型：`command` 走 stdio、`url` 走 http，显式 `type` 里 `sse` /
 * `streamableHttp` 各自成档（设置页编辑 JSON 时会写上它们，不能显示成 http 误导用户）。
 *
 * 优先级与设置页列表（`McpServerList` 的行展示）一致：**command 赢 url** ——
 * 两个字段同时存在的配置按 stdio 连，显示也必须说 stdio，否则界面在撒谎。
 */
export function inferMcpTransport(config: McpServerConfig): McpTransportKind {
  if (typeof config.command === "string" && config.command.trim() !== "") return "stdio";
  const type = typeof config.type === "string" ? config.type.trim().toLowerCase() : "";
  if (type === "sse") return "sse";
  if (type === "streamablehttp" || type === "streamable-http") return "streamableHttp";
  return "http";
}

/** 传输类型文案键（`squad.agentMcp.transport.<kind>`）：编辑列表与详情页徽标共用一处。 */
export function mcpTransportMessageId(kind: McpTransportKind): string {
  return `squad.agentMcp.transport.${kind}`;
}

/** 一行 server 的展示投影：名字 + 传输类型（编辑列表与详情页徽标同一形状）。 */
export interface McpServerRow {
  name: string;
  transport: McpTransportKind;
}

/**
 * map ⇒ 行数组：**按名字排序**（与顺序无关的稳定呈现：JS 对象的键序在编辑往返里会漂，
 * 列表跟着漂会让用户以为配置被改了）。缺席 / 空 map 都是空数组 ——
 * 「空态」是呈现层的文案，不是这里的特殊返回值。
 */
export function listMcpServerEntries(
  servers: Record<string, McpServerConfig> | undefined,
): McpServerRow[] {
  if (!servers) return [];
  return Object.keys(servers)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({ name, transport: inferMcpTransport(servers[name] ?? {}) }));
}

/**
 * 表单 → 提交载荷的 `mcpServers` 片段（三态，必须能被读出来）：
 *  · 有 server ⇒ 提交**整张 map**（服务面 update 是整体替换，不是逐条合并）；
 *  · 空 map 且定义里**本来就有**这个字段（`initialHadServers`）⇒ 提交 `{}` ——
 *    服务面 `{}` 是「清空全部 server」的合法值，而 `undefined` 是「没提这个字段」（保持原值）；
 *  · 空 map 且定义里本来没有 ⇒ **不带字段**：不给存量定义文件凭空添一个空对象
 *    （「没有这个字段」= 该 agent 不覆盖任何 server，与空 map 在挂载语义上等价，但不写盘更诚实）。
 */
export function mcpServersSubmitPatch(
  servers: Record<string, McpServerConfig> | undefined,
  initialHadServers: boolean,
): { mcpServers?: Record<string, McpServerConfig> } {
  const entries = Object.entries(servers ?? {});
  if (entries.length > 0) return { mcpServers: Object.fromEntries(entries) };
  return initialHadServers ? { mcpServers: {} } : {};
}

/** 对话框「保存」的判据输入：两个字段的当前文本 + 既有行名（去重）+ 编辑本行时的原名。 */
export interface McpServerEntryDraft {
  name: string;
  configText: string;
  existingNames: readonly string[];
  keepName?: string;
}

/** 对话框「保存」的判据输出：两个行内档位 + 两条都干净时的可落盘条目。 */
export interface McpServerEntryValidation {
  nameIssue: McpServerNameIssue | null;
  configIssue: McpServerConfigIssue | null;
  configMessageId: string | null;
  configDetail?: string;
  /** `entry === null` = 不许保存；组件据此禁用保存按钮，不另写一份判据。 */
  entry: { name: string; config: McpServerConfig } | null;
}

/**
 * 把名字与配置两条校验合成对话框的**保存判据**（组件只渲染结果，不再自己判断）。
 * 两条都干净才产出 `entry`：名字用 trim 后的值（空白不是身份的一部分），配置用 schema 解析后的对象。
 * 两个档位**分别**给出（不短路）：用户改名字时配置那边的报错不该消失，反之亦然。
 */
export function validateMcpServerEntry(draft: McpServerEntryDraft): McpServerEntryValidation {
  const nameIssue = validateMcpServerName(draft.name, draft.existingNames, {
    // undefined = 新建（没有「原名」可沿用）；同名比较按值判，显式 undefined 与省略等价。
    keepName: draft.keepName,
  });
  const configResult = parseMcpServerConfigText(draft.configText);
  const validation: McpServerEntryValidation = {
    nameIssue,
    configIssue: configResult.ok ? null : configResult.issue,
    configMessageId: configResult.ok ? null : configResult.messageId,
    ...(configResult.ok || configResult.detail === undefined
      ? {}
      : { configDetail: configResult.detail }),
    entry: null,
  };
  if (nameIssue === null && configResult.ok) {
    validation.entry = { name: draft.name.trim(), config: configResult.config };
  }
  return validation;
}
