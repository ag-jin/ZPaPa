import type { InlineAnchor, MentionRef } from "./workItemCommentRepo.js";

/* 协作域 X1.1：评论解析器（纯函数，无 IO——可穷举）。
   词法与 UI 侧 mention 同源先例（不另建 shared 词法文件——少一个跨包面，漂移时再合并）：
   · `packages/ui/src/mentions/mentionMarkdown.ts:4`（@[a-zA-Z0-9._-]+ 形态）
   · `:76-78`（生成 @label）；`subagentsMentionProvider.ts:33-77`（value: agent.name）
   · `WorkspaceShellLayout.tsx:1163-1177`（DM 预填 @${agentName} ）
   ⇒ mention = **`@` + agent 名称**（非 id）。 */

/** mention 词元：@ 后跟名称字符（与 UI mentionMarkdown 同字符集）。 */
const MENTION_TOKEN = /[a-zA-Z0-9._\-\u4e00-\u9fa5]+/g;
/** 行首或空白后的 @ 才算 mention 边界（邮箱/代码中的 @ 不算）。 */
const MENTION_AT = /(?:^|(?<=\s))@/g;

export type ParsedMention =
  | { kind: "agent"; name: string; agentId: string }
  | { kind: "squad"; name: string; squadId: string }
  | { kind: "human"; name: string }
  | { kind: "all" }
  /** 名册里缺席或重名：解析出 token 但**不猜**身份——是否触发由调用方（X1.2）裁决。 */
  | { kind: "unresolved"; name: string; reason: "absent" | "ambiguous"; candidates?: string[] };

export type CommentParseResult = {
  /** 原文里出现的全部 mention token 的结构化结论（含 @all 与未解析项）。 */
  mentions: ParsedMention[];
  /** `/note` 解析结果；未知 slash 命令**响亮抛**（不静默降级——客户端不得各自猜）。 */
  command: "none" | "note";
  /** 去命令前缀正文（展示；原文由调用方存 body 列，§12.1-4）。 */
  normalizedBody: string;
  /** 内联锚点由调用方随评论携带（本卡不解析代码位置文本——锚点是结构化输入不是词法）。 */
  inline: InlineAnchor | null;
};

/** 名册形状：名称 → id（重名由调用方的名册构造给出 ambiguous 标记）。 */
export type RosterIndex = {
  /** 唯一名称 ⇒ agentId。 */
  agentsByName: Map<string, string>;
  /** 重名集合（同名的多个 agentId）。 */
  ambiguousAgentNames: Set<string>;
  /** 小队名 → squadId。 */
  squadsByName: Map<string, string>;
  /** 已知人类成员名（@人名 抑制隐式路由的判定输入——本层只标记 kind:"human"）。 */
  humanNames: Set<string>;
};

export const EMPTY_ROSTER_INDEX: RosterIndex = {
  agentsByName: new Map(),
  ambiguousAgentNames: new Set(),
  squadsByName: new Map(),
  humanNames: new Set(),
};

/** 已知 slash 命令闭集（§4.2：未知命令不得静默降级）。 */
const KNOWN_COMMANDS = ["note"] as const;

const NOTE_PREFIX = "/note";

function resolveToken(token: string, roster: RosterIndex): ParsedMention {
  if (token === "all") return { kind: "all" };
  if (roster.ambiguousAgentNames.has(token)) {
    return { kind: "unresolved", name: token, reason: "ambiguous" };
  }
  const agentId = roster.agentsByName.get(token);
  if (agentId !== undefined) return { kind: "agent", name: token, agentId };
  const squadId = roster.squadsByName.get(token);
  if (squadId !== undefined) return { kind: "squad", name: token, squadId };
  if (roster.humanNames.has(token)) return { kind: "human", name: token };
  return { kind: "unresolved", name: token, reason: "absent" };
}

/**
 * 解析评论文本。纯函数：同输入两次调用逐字节相同；无 IO/无时钟。
 * 顺序：先剥命令前缀（`/note`），再扫 mention token（最长匹配由正则的贪婪词元天然保证）。
 * 未知 `/xxx` 前缀 ⇒ 抛错（调用方决定如何呈现——不是把客户端的猜测藏进解析器）。
 */
export function parseComment(
  body: string,
  roster: RosterIndex = EMPTY_ROSTER_INDEX,
  inline: InlineAnchor | null = null,
): CommentParseResult {
  let command: "none" | "note" = "none";
  let normalizedBody = body;

  const firstLine = body.slice(0, body.indexOf("\n") === -1 ? undefined : body.indexOf("\n"));
  const commandMatch = firstLine.match(/^(\/[a-zA-Z0-9_-]+)(\s|$)/);
  if (commandMatch) {
    const slash = commandMatch[1]!.slice(1);
    if (!(KNOWN_COMMANDS as readonly string[]).includes(slash)) {
      throw new Error(
        `未知评论命令「/${slash}」：已知命令闭集为 ${KNOWN_COMMANDS.join("/")}。` +
          "不得静默当普通文本（客户端各自猜会让同一输入两处两种结果）。",
      );
    }
    command = "note";
    normalizedBody = body.slice(commandMatch[1]!.length).replace(/^\s+/, "");
  }

  const mentions: ParsedMention[] = [];
  const seen = new Set<string>();
  const text = normalizedBody;
  for (const atMatch of text.matchAll(MENTION_AT)) {
    // 从 @ 后取贪婪词元（最长匹配：@ann-lee 不会被 @ann 抢先——正则吃到非边界字符为止）。
    const rest = text.slice((atMatch.index ?? 0) + 1);
    const tokenMatch = rest.match(MENTION_TOKEN.source ? new RegExp(MENTION_TOKEN.source) : /x/);
    const token = tokenMatch?.[0];
    if (!token || token.length === 0) continue;
    const key = token;
    if (seen.has(key)) continue;
    seen.add(key);
    mentions.push(resolveToken(token, roster));
  }

  return { mentions, command, normalizedBody, inline };
}

/** 供存储层（X1.2）把 ParsedMention 压成 MentionRef 快照。 */
export function toMentionRefs(mentions: readonly ParsedMention[]): MentionRef[] {
  return mentions.flatMap((mention): MentionRef[] => {
    switch (mention.kind) {
      case "all":
        return [{ type: "all", id: "all" }];
      case "agent":
        return [{ type: "agent", id: mention.agentId }];
      case "squad":
        return [{ type: "squad", id: mention.squadId }];
      default:
        // human 不进 mention 快照（不是触发对象）；unresolved 同理（不猜身份）。
        return [];
    }
  });
}
