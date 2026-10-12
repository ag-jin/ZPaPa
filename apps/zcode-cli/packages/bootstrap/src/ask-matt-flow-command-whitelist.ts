/**
 * 「ask-matt 开发流程」34 命令装配的**三类特例白名单**（卡 #226/F1；设计稿 §2.3 + §6 D1/D5/D8）。
 *
 * 命令表由包内快照单源派生（ask-matt-flow-commands.ts 的生成器）：快照技能清单 - 无命令件 = 34 条。
 * 派生规则覆盖不到的特例全部集中在本文件，白名单外出现不一致即由同源守卫红（四件套断言）。
 *
 * 三类特例：
 * 1. **换名件（D5）**：命令名 ≠ 技能名，`/matt-*` 前缀；技能名与上游正文一字不动。命名重叠三件
 *    （implement/tdd/code-review）与 ZCode 自身流程同名，L1 命令层换名一次性绕开改写上游文本、
 *    快照身份与用户 agent 引用面（`~/.zcode/agents/*.md` 的 `skills: [tdd]` 继续按技能名解析）。
 * 2. **落点注入件**：#204/A5/A7/A8 已交付的三条入口正文（grill/to-spec/to-tickets）——命令正文
 *    注入任务目录、计划稿落点与发号纪律；grilling→grill 的入口名也属于本类的既有形态。正文
 *    原样保留（A5/A7/A8 的落地断言按展开正文钉死），通用边界段由派生器统一追加。
 * 3. **无命令件（D1）**：平台不适用三件（tracker 已是看板 / 无 Claude CLI 载体 / Claude Code 专用
 *    hooks）——37 件仍全随包并全注册（开态），只是不带斜杠入口。/ask-matt 保留轻命令（地图与路由
 *    入口），由派生器按原名生成。
 */

/** 换名件：命令名 ≠ 技能名（D5），技能名与技能文本不动。 */
export interface AskMattFlowRenamedCommand {
  /** 目标技能名（上游原名，注册面成员）。 */
  skill: string;
  /** `/` 目录里的命令名（不含斜杠）。 */
  name: string;
}

/** 落点注入件：既有命令正文（含入口名与使用提示）逐件保留。 */
export interface AskMattFlowLandingOverride {
  /** 目标技能名（上游原名，注册面成员）。 */
  skill: string;
  /** `/` 目录里的命令名（不含斜杠）。 */
  name: string;
  /** 使用提示（`/name [args]`）。 */
  argumentHint: string;
  /** 注入正文（`$ARGUMENTS` 必须在场；通用边界段由派生器统一追加）。 */
  body: string;
}

/** D5 裁决：三重叠件命令层换名（`/matt-implement`、`/matt-tdd`、`/matt-code-review`）。 */
export const ASK_MATT_FLOW_RENAMED_COMMANDS: readonly AskMattFlowRenamedCommand[] = [
  { name: "matt-implement", skill: "implement" },
  { name: "matt-tdd", skill: "tdd" },
  { name: "matt-code-review", skill: "code-review" },
];

/** D1 裁决：三件平台不适用、不带命令入口（仍随包 + 开态注册，可用 $skill 直接装载）。 */
export const ASK_MATT_FLOW_NO_COMMAND_SKILL_NAMES: readonly string[] = [
  "setup-matt-pocock-skills",
  "claude-handoff",
  "git-guardrails-claude-code",
];

/**
 * 落点注入件：A3/A5/A7/A8 已交付三条入口正文原样保留（grilling 的入口名 grill 亦属本件）。
 * 正文改动会直接改真实 /grill、/to-spec、/to-tickets 的运行态契约——本类只增不改。
 */
export const ASK_MATT_FLOW_LANDING_OVERRIDES: readonly AskMattFlowLandingOverride[] = [
  {
    argumentHint: "/grill [what to grill]",
    body: [
      "Use the `grilling` skill to interview me relentlessly about this plan, decision, or idea",
      "until we reach a shared understanding. Work the design tree in rounds: ask the whole",
      "frontier now, facts are your job, decisions are mine.",
      "",
      "Landing convention (this project):",
      "- Before the first round, derive one kebab-case task slug from the topic of this conversation",
      "  and show it to me for confirmation; I can rename it, and nothing is created before I confirm.",
      "  A slug is lowercase words joined by single dashes, like this project's task directories.",
      "- If the slug collides with an entry that already exists under `.zcode/` — `board/`, `plans/`,",
      "  `design/`, `archive/`, `worktrees/` — or with an existing task id, pick a different slug",
      "  and tell me why: a colliding slug writes into that entry instead of starting a task of",
      "  its own.",
      "- On my confirmation, the slug becomes the task directory id that /to-spec and /to-tickets",
      "  take later. Create `.zcode/<task-id>/design/` in the board project root immediately —",
      "  before the first round.",
      "- If `design/grill-notes.md` already exists when the interview starts — a resume after a",
      "  compact or clear, or a later /grill on the same task — do NOT overwrite it and do NOT",
      "  start a new one: read the file first, all three sections, restore the context it records,",
      "  continue from the settled decisions under `## 已定决策`, and treat `## 待定问题` as the",
      "  frontier for the next round. Never re-ask a question already settled in the notes, and",
      "  never restart the interview from scratch.",
      "- Only when `design/grill-notes.md` does not exist yet, start it as a placeholder with",
      "  this skeleton:",
      "",
      "  ## 已定决策",
      "  ## 待定问题",
      "  ## 下一步",
      "",
      "- Keep `design/grill-notes.md` current while the interview runs: append each round's outcome",
      "  as soon as it settles, never batch the notes to the end — real-time notes survive a",
      "  compact or clear. The three sections mean:",
      "  - `## 已定决策` — one line per decision I have settled, in the order settled.",
      "  - `## 待定问题` — the frontier questions still open (asked and unanswered, or not yet asked).",
      "  - `## 下一步` — one line naming the immediate next action (next round, /to-spec, ...).",
      "- `.zcode/` resolves against the board project root — the checkout that owns `.zcode/board/` —",
      "  never against the current working directory or a worktree copy: a task directory created",
      "  inside a worktree is not the project's and is lost with it.",
      "- The board's plan scan surface only reads `plans/` directories; hidden subdirectories,",
      "  `archive/`, `design/` and STALLED task directories are frozen exclusions. Keep the notes",
      "  in `design/` and never write them under `plans/`: a non-plan file there can be published",
      "  on the board as a draft — a ghost card with no accepted card text.",
      "",
      "$ARGUMENTS",
      "",
    ].join("\n"),
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
    name: "to-tickets",
    skill: "to-tickets",
  },
];
