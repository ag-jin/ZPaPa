import { expandCustomCommandPrompt, type CustomCommandContent } from "@zcode/contracts";
import type { ZCodeSlashCommand } from "@zcode/shared";

/**
 * 「ask-matt 开发流程」的三个内置命令（卡 #204/A3）：`/grill`、`/to-spec`、`/to-tickets`。
 *
 * 与内置 `/workflow` 同款：命令正文随 CLI 编译，不依赖可卸载插件；正文复用 contracts 的
 * custom command 展开规则（替换 `$ARGUMENTS` 并补充 `skills:` 前言）。前言把目标技能设为
 * **必须先行装载**的技能，所以「调起命令」落到技能装载上（调起进技能），而技能是否可装载由
 * 注册面门决定（app/ask-matt-flow-gate.ts）；两边同一个开关，关掉时目录与展开一起为零。
 *
 * 名字策略（用户原话「保留 ask-matt 原名」）：命令名取卡文点名的入口名（grill/to-spec/to-tickets），
 * 目标技能名一律用上游原名（grilling/to-spec/to-tickets）——命令只是入口，不改写技能身份，
 * 于是 Skill 清单里看到的仍是 mattpocock 原始技能名。
 *
 * 命令名不进共享保留字表：实验默认关，关闭时同名用户自定义命令必须照常可用
 * （目录侧只在开态压过自定义同名命令，见 zcode-protocol/slash-commands.ts）。
 */

export interface AskMattFlowCommandDefinition {
  /** `/` 目录里的命令名（不含斜杠）。 */
  name: string;
  /** 命令正文要求先装载的内置包技能名（ask-matt 原名，必须是注册面成员）。 */
  skill: string;
  /** `/` 目录与加号菜单展示用的一句话说明。 */
  description: string;
  /** 使用提示（`/name [args]`）。 */
  argumentHint: string;
  /** 展开正文（`$ARGUMENTS` 必须在场，否则参数会被追加成不受控的尾块）。 */
  body: string;
}

export const ASK_MATT_FLOW_COMMANDS: readonly AskMattFlowCommandDefinition[] = [
  {
    argumentHint: "/grill [what to grill]",
    body: [
      "Use the `grilling` skill to interview me relentlessly about this plan, decision, or idea",
      "until we reach a shared understanding. Work the design tree in rounds: ask the whole",
      "frontier now, facts are your job, decisions are mine.",
      "",
      "$ARGUMENTS",
      "",
    ].join("\n"),
    description: "Grill me about a plan or idea until we share one understanding (ask-matt flow).",
    name: "grill",
    skill: "grilling",
  },
  {
    argumentHint: "/to-spec [task-id | reference]",
    body: [
      "Use the `to-spec` skill to turn the current conversation into a spec and land it as a plan",
      "draft in this project's board task directory. The issue tracker here is the board's plan",
      "scan surface: do NOT publish to GitHub or any external tracker, and do NOT interview me;",
      "synthesize what you already know.",
      "",
      "Landing convention (overrides the skill's tracker and filename defaults):",
      "- Write exactly one file: `.zcode/<task-id>/plans/plan-<slug>.md`.",
      "- `<task-id>` is the board task directory id: take it from the arguments below when they name",
      "  one, otherwise use the task directory already agreed in this conversation (for example the",
      "  `/grill` slug). If neither is settled, ask me for the id before writing.",
      "- `<slug>` is a short lowercase dash-case topic slug.",
      "- The file must pass the board compiler's assignment identity gate: the stem matches",
      "  `plan-*.md` and the first heading line is the H1 title (`# ...`); the body keeps the spec",
      "  sections from the skill's template.",
      "- Ticket-shaped items must use the board card line template: `- [ ] <title>` with the label",
      "  lines `目标:` / `交付面全量枚举:` (items split by ① ② ③ …) / `验收:` — at minimum these",
      "  lines; the full template also carries `责任:` and `用户原话引用:` (both are required sections,",
      "  and the dispatch prompt builder refuses a card that misses one). For a dependency",
      "  write `> blocked-by: <稳定号>` (assigned dependencies only; the reference slot takes stable",
      "  numbers and nothing else). Before the card has a number, hold the slot with the draft",
      "  placeholder `> blocked: 等待 <目标> 拆卡后补号` and replace it with `> blocked-by: <稳定号>`",
      "  once the number is assigned.",
      "- Never hand-write `<!-- zcode-board: no=... -->` markers; number assignment is the board",
      "  compiler's `--assign` job (this product writes no board file directly).",
      "",
      "$ARGUMENTS",
      "",
    ].join("\n"),
    description: "Turn this conversation into a spec (ask-matt flow).",
    name: "to-spec",
    skill: "to-spec",
  },
  {
    argumentHint: "/to-tickets [task-id | reference]",
    body: [
      "Use the `to-tickets` skill to break the plan, spec, or current conversation into",
      "tracer-bullet tickets, each declaring its blocking edges. The configured tracker here is the",
      "board's plan scan surface: the tickets are card lines in a plan draft under",
      "`.zcode/<task-id>/plans/`, not one file per ticket — do NOT publish to GitHub or any",
      "external tracker, and do NOT write `.scratch/<feature>/issues/` files.",
      "",
      "Landing convention (overrides the skill's tracker and filename defaults):",
      "- Write the approved ticket entries as board card lines inside the task's plan draft",
      "  `.zcode/<task-id>/plans/plan-*.md` — by default extend the plan draft just produced by",
      "  /to-spec; when no draft exists yet, create `plan-<slug>.md` with an H1 title first. Keep",
      "  the skill's breakdown and quiz process, and write the cards in dependency order (blockers",
      "  first) so assignment follows the frontier order top to bottom.",
      "- `<task-id>` is the board task directory id: take it from the arguments below when they name",
      "  one, otherwise use the task directory already agreed in this conversation. If neither is",
      "  settled, ask me for the id before writing.",
      "- `.zcode/` resolves against the board project root — the checkout that owns `.zcode/board/`",
      "  — never against the current working directory or a worktree copy: a draft written inside",
      "  a worktree is not on the scan surface. Hidden subdirectories, `archive/`, `design/` and",
      "  STALLED task directories are outside the scan surface.",
      "- The file must pass the board compiler's assignment identity gate: the stem matches",
      "  `plan-*.md` and the first heading line is the H1 title (`# ...`).",
      "- Each card uses the board card line template: `- [ ] <title>` with the label lines `目标:` /",
      "  `交付面全量枚举:` (items split by ① ② ③ …) / `验收:` — at minimum these lines; the full",
      "  template also carries `责任:` (recommended — the dispatch prompt reads this role line;",
      "  a card without it is still accepted, only the role is left unspecified) and `用户原话引用:`.",
      "  The two required sections are `交付面全量枚举:` and `用户原话引用:`; the dispatch prompt",
      "  builder refuses a card that misses either one (exit 3).",
      "- Dependencies: write `> blocked-by: <稳定号>` only when the blocking card already has a",
      "  stable number. For a card blocked by another card in the same draft (no number yet), hold",
      "  the slot with the draft placeholder `> blocked: 等待 <目标> 拆卡后补号`; number assignment",
      "  does NOT rewrite that placeholder, so after the user approves the breakdown run the board",
      "  compiler's `--assign` against the board project root, read the assigned numbers back from",
      "  the `<!-- zcode-board: no=N -->` markers written into the same file, replace every",
      "  placeholder with `> blocked-by: <稳定号>`, and recompile. An unreplaced placeholder leaves",
      "  the card out of the frontier too: it stays blocked with a readable reason until replaced.",
      "  Never leave a title in the reference slot: it is rejected (no dependency edge), keeps the",
      "  card out of the frontier permanently, and `--check` stays green — the frontier silently",
      "  loses the card.",
      "- Never hand-write `<!-- zcode-board: no=... -->` markers; number assignment is the board",
      "  compiler's `--assign` job (this product writes no board file directly).",
      "",
      "$ARGUMENTS",
      "",
    ].join("\n"),
    description: "Split a plan or spec into blocking-aware tickets (ask-matt flow).",
    name: "to-tickets",
    skill: "to-tickets",
  },
];

function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

/** 命令名判据（归一化斜杠与大小写）：目录侧用它让开态的内置命令压过同名自定义命令。 */
export function isAskMattFlowCommandName(name: string): boolean {
  const normalized = normalizeCommandName(name);
  return ASK_MATT_FLOW_COMMANDS.some((command) => command.name === normalized);
}

/** `/` 面板与加号菜单的目录项；开关未显式 true 时零目录（实验默认关，不留半件入口）。 */
export function listAskMattFlowSlashCommands(enabled: boolean | undefined): ZCodeSlashCommand[] {
  if (enabled !== true) return [];
  return ASK_MATT_FLOW_COMMANDS.map((command) => ({
    description: command.description,
    inputHint: command.argumentHint,
    name: command.name,
    source: "builtin" as const,
  }));
}

/** 命令正文的 custom command 视图：metadata.skills 即「先装载该技能」的强制前言。 */
function toCustomCommandContent(command: AskMattFlowCommandDefinition): CustomCommandContent {
  const bytes = Buffer.byteLength(command.body);
  return {
    bytesRead: bytes,
    content: command.body,
    metadata: {
      allowedTools: [],
      argumentHint: command.argumentHint,
      description: command.description,
      disableNonInteractive: false,
      frontmatterKeys: ["description", "argument-hint", "skills"],
      name: command.name,
      path: `builtin:${command.name}`,
      rootPath: "builtin:",
      scope: "system",
      skills: [command.skill],
      source: "zcode",
    },
    sizeBytes: bytes,
    truncated: false,
  };
}

/**
 * 输入 `/grill ...` 等命令时的展开。调用方必须先判定开关；本函数只解析命令名，
 * 不认识的名字返回 undefined（交回既有自定义命令解析，行为不变）。
 */
export function resolveAskMattFlowPromptCommand(name: string, args: string): string | undefined {
  const normalized = normalizeCommandName(name);
  const command = ASK_MATT_FLOW_COMMANDS.find((candidate) => candidate.name === normalized);
  if (!command) return undefined;
  return expandCustomCommandPrompt({ args, command: toCustomCommandContent(command) }).prompt;
}
