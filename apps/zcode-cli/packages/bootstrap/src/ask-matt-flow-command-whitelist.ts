/**
 * 「ask-matt 开发流程」34 命令装配的**三类特例白名单**（卡 #226/F1 + #228/F3；设计稿 §2.3 + §6 D1/D5/D8/D9）。
 *
 * 命令表由包内快照单源派生（ask-matt-flow-commands.ts 的生成器）：快照技能清单 - 无命令件 = 34 条。
 * 派生规则覆盖不到的特例全部集中在本文件，白名单外出现不一致即由同源守卫红（四件套断言；
 * #228/F3 起第④面 = 落点注入件集合与裁决清单严格相等，非预期同名 override 必红）。
 *
 * 三类特例：
 * 1. **换名件（D5）**：命令名 ≠ 技能名，`/matt-*` 前缀；技能名与上游正文一字不动。命名重叠三件
 *    （implement/tdd/code-review）与 ZCode 自身流程同名，L1 命令层换名一次性绕开改写上游文本、
 *    快照身份与用户 agent 引用面（`~/.zcode/agents/*.md` 的 `skills: [tdd]` 继续按技能名解析）。
 *    换名件可携带定制正文（#228/F3 的 D9 交接文案用在 `/matt-implement` 上）。
 * 2. **落点注入件（D8）**：#228/F3 起共 10 件——A5/A7/A8 已交付的三条入口正文
 *    （grill/to-spec/to-tickets，**只增不改**：正文原样保留，A5/A7/A8 的落地断言按展开正文钉死）
 *    + #228/F3 新增七件（triage/wayfinder/prototype/research/implement-spec/diagnosing-bugs/
 *    improve-codebase-architecture）逐件定制落点约定。grilling→grill 的入口名也属于本类的既有形态；
 *    通用边界段由派生器统一追加。裁决清单见 askMattFlowCommandParity.test.ts 的
 *    VERDICT_LANDING_OVERRIDE_SKILLS（10 件；撞洞登记：设计稿第 8 名 grill-with-docs 与卡文
 *    算术 3+7=10 冲突，停在卡外）。
 * 3. **无命令件（D1）**：平台不适用三件（tracker 已是看板 / 无 Claude CLI 载体 / Claude Code 专用
 *    hooks）——37 件仍全随包并全注册（开态），只是不带斜杠入口。/ask-matt 保留轻命令（地图与路由
 *    入口），由派生器按原名生成。
 */

/** 换名件：命令名 ≠ 技能名（D5），技能名与技能文本不动；可携带定制正文（D9 交接文案）。 */
export interface AskMattFlowRenamedCommand {
  /** 目标技能名（上游原名，注册面成员）。 */
  skill: string;
  /** `/` 目录里的命令名（不含斜杠）。 */
  name: string;
  /**
   * 定制正文（可选；#228/F3 的 D9 交接文案用在 `/matt-implement` 上）。缺省时正文取派生模板
   * （`Use the <skill> skill …` + `$ARGUMENTS`），通用边界段始终由派生器统一追加。
   */
  body?: string;
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

/**
 * D9 交接边界段（#228/F3；设计稿 §6 D9 裁决「轻量旁路 + 交接文案」）：两条实现入口命令
 * （`/matt-implement` 与 `/implement-spec`）共用同一段成文——实现完成 ≠ 合并完成、产物交看板卡
 * 收口、绿数统计以看板为准（方法层 vs 统计层两句话消歧）。它挡住的是「绕过 integrator 唯一出口」
 * 的旁路（C 红队最易掩盖三条之三）：绕过会让 `--check` 对账反复点名 → 豁免滥用 → 机械性瓦解。
 * 走白名单正文而不是技能文本：上游技能正文一字不动（D5/MIT 保真），边界只在命令层成文。
 */
export const ASK_MATT_FLOW_HANDOFF_BOUNDARY_BLOCK = [
  "Board handoff (this project):",
  "- Implementation complete is not merge complete: nothing produced by this command is done",
  "  until the board card that owns the work is closed through the board pipeline (dispatch",
  "  record, the board's own checks, and the integrator merge).",
  "- Hand the artifacts over to the board card: the branch, the commits, the tests and the review",
  "  evidence are the card's material — record them in the card's run instead of declaring the",
  "  work finished here.",
  "- Green counts come from the board: the verification count that decides anything is the card's",
  "  run record, not a summary printed by this command.",
].join("\n");

/** D5 裁决：三重叠件命令层换名（`/matt-implement`、`/matt-tdd`、`/matt-code-review`）。 */
export const ASK_MATT_FLOW_RENAMED_COMMANDS: readonly AskMattFlowRenamedCommand[] = [
  {
    // D9：换名件同样可携带定制正文——实现入口的正文必须成文与看板四绿管线的交接边界。
    body: [
      "Use the `implement` skill to carry out this request (ask-matt flow).",
      "",
      ASK_MATT_FLOW_HANDOFF_BOUNDARY_BLOCK,
      "",
      "$ARGUMENTS",
      "",
    ].join("\n"),
    name: "matt-implement",
    skill: "implement",
  },
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
 * 落点注入件 10 件（D8 强覆盖，三绿 P1 承接口径「F3 扩到 10 件」）。
 * - 既有三件：A3/A5/A7/A8 已交付的入口正文（grilling 的入口名 grill 亦属本件），**只增不改**——
 *   正文改动会直接改真实 /grill、/to-spec、/to-tickets 的运行态契约（A5/A7/A8 落地断言钉死）。
 * - 新增七件（#228/F3）：triage/wayfinder（请求面与地图落计划稿卡行）、prototype（一次性产物
 *   离扫描面）、research（笔记落任务设计区）、implement-spec（spec/票 → 卡行 + D9 交接）、
 *   diagnosing-bugs（诊断进卡级 run）、improve-codebase-architecture（报告留 OS 临时区、候选进看板流）。
 *   每件正文钉本件的默认落点假设与看板口径的差异点（上游默认：GitHub tracker / .scratch/ 草稿 /
 *   仓库内自由选址），缺件注入 = 板上来料为零的静默失败。
 * 成员资格由 parity 第④面与裁决清单严格相等守卫（见 ask-matt-flow-command-parity.ts）。
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
  {
    argumentHint: "/triage [what to look at]",
    body: [
      "Use the `triage` skill to move requests through the triage state machine (ask-matt flow).",
      "",
      "Landing convention (overrides the skill's tracker defaults):",
      "- The issue tracker here is the board: requests live in the plan drafts under",
      "  `.zcode/<task-id>/plans/` and on the compiled board — do NOT post to GitHub or any",
      "  external tracker, and do NOT write `.scratch/<feature>/issues/` files.",
      "- Triage outcomes land on the board as card lines in the plan draft: an agent-ready brief",
      "  becomes a card line carrying the two required sections (`交付面全量枚举:` /",
      "  `用户原话引用:`), never a tracker comment. The card line is the handover artifact; the",
      "  board compiler stays the only board writer (number assignment is its `--assign` job).",
      "- Working notes that must survive a compact (triage notes, partial findings) go under",
      "  `.zcode/<task-id>/design/`; `.zcode/` resolves against the board project root, the",
      "  checkout that owns `.zcode/board/` — never a worktree copy.",
      "",
      "$ARGUMENTS",
      "",
    ].join("\n"),
    name: "triage",
    skill: "triage",
  },
  {
    argumentHint: "/wayfinder [loose idea]",
    body: [
      "Use the `wayfinder` skill to chart a shared map of decision tickets (ask-matt flow).",
      "",
      "Landing convention (overrides the skill's tracker defaults):",
      "- The tracker here is the board's plan scan surface: chart the map and its decision tickets",
      "  as card lines in the plan draft `.zcode/<task-id>/plans/plan-<slug>.md` — do NOT create",
      "  GitHub issues or any external tracker entries, and do NOT write",
      "  `.scratch/<feature>/issues/` files.",
      "- Ticket blocking edges are the card line's dependency slot: `> blocked-by: <稳定号>` once",
      "  the blocking card has a number (stable numbers only), or the draft placeholder",
      "  `> blocked: 等待 <目标> 拆卡后补号` before that. A ticket is claimed through the board:",
      "  one ticket per board run, claim before working.",
      "- Map sections that must persist (destination, decisions so far, fog) land under",
      "  `.zcode/<task-id>/design/`; the board card and its runs remain the execution record, and",
      "  the board compiler stays the only board writer.",
      "",
      "$ARGUMENTS",
      "",
    ].join("\n"),
    name: "wayfinder",
    skill: "wayfinder",
  },
  {
    argumentHint: "/prototype [the design question]",
    body: [
      "Use the `prototype` skill to build a throwaway prototype that answers one design question",
      "(ask-matt flow).",
      "",
      "Landing convention (overrides the skill's capture defaults):",
      "- Keep the throwaway artifact off the board's plan scan surface: never write it under",
      "  `.zcode/<task-id>/plans/` (a non-plan file there is published as a ghost draft), never",
      "  under `.scratch/`, and never on the main branch.",
      "- Capture the prototype on a throwaway branch as the skill says, and put the context",
      "  pointer plus the verdict (the question and its answer) under `.zcode/<task-id>/design/`",
      "  and on the board card — the card and its runs are the execution record; the branch alone",
      "  is not.",
      "- Fold the validated decision into the real code through the board card's own lifecycle",
      "  (worktree discipline, the card's checks, integrator merge).",
      "",
      "$ARGUMENTS",
      "",
    ].join("\n"),
    name: "prototype",
    skill: "prototype",
  },
  {
    argumentHint: "/research [the question]",
    body: [
      "Use the `research` skill to investigate this question and capture the findings (ask-matt",
      "flow); spin up the background agent as the skill says.",
      "",
      "Landing convention (overrides the skill's save-location default):",
      "- Save the findings as one Markdown file under `.zcode/<task-id>/design/` (the design area)",
      "  — never under `plans/` (the plan scan surface: a non-plan file there is published as a",
      "  draft) and never under `.scratch/`.",
      "- `.zcode/` resolves against the board project root, the checkout that owns",
      "  `.zcode/board/` — never a worktree copy; say the path back to the user when the file is",
      "  written, and record the pointer on the board card.",
      "",
      "$ARGUMENTS",
      "",
    ].join("\n"),
    name: "research",
    skill: "research",
  },
  {
    argumentHint: "/implement-spec [spec reference]",
    body: [
      "Use the `implement-spec` skill to implement a specification's tickets in code (ask-matt",
      "flow).",
      "",
      "Landing convention (overrides the skill's tracker defaults):",
      "- The spec and its tickets here are the board plan draft",
      "  `.zcode/<task-id>/plans/plan-<slug>.md` and its card lines — not GitHub issues and not",
      "  `.scratch/<feature>/issues/` files. Each ticket in the task graph maps to a board card;",
      "  read the graph's frontier off the board's cards, not off an external tracker.",
      "- Per-ticket branches and worktrees follow the board's worktree discipline, and every",
      "  ticket's work is recorded in its board card and that card's runs — the card, not the PR",
      "  alone, is the execution record.",
      "",
      ASK_MATT_FLOW_HANDOFF_BOUNDARY_BLOCK,
      "",
      "$ARGUMENTS",
      "",
    ].join("\n"),
    name: "implement-spec",
    skill: "implement-spec",
  },
  {
    argumentHint: "/diagnosing-bugs [symptom]",
    body: [
      "Use the `diagnosing-bugs` skill to diagnose this bug (ask-matt flow).",
      "",
      "Landing convention (this project):",
      "- Run the fix through the board card's lifecycle: the reproduction, the tight pass/fail",
      "  loop and the regression test are recorded on the board card (its runs are the execution",
      "  record), and the card is closed through the board pipeline — a commit message alone is",
      "  not the record.",
      "- Temporary probes and throwaway harnesses are deleted before the card closes; anything",
      "  that must survive a compact (captured traces, redacted evidence) goes under",
      "  `.zcode/<task-id>/design/`.",
      "- `.zcode/` resolves against the board project root, the checkout that owns",
      "  `.zcode/board/` — never a worktree copy.",
      "",
      "$ARGUMENTS",
      "",
    ].join("\n"),
    name: "diagnosing-bugs",
    skill: "diagnosing-bugs",
  },
  {
    argumentHint: "/improve-codebase-architecture [direction]",
    body: [
      "Use the `improve-codebase-architecture` skill to surface deepening opportunities (ask-matt",
      "flow).",
      "",
      "Landing convention (this project):",
      "- Keep the HTML report in the OS temp directory as the skill says: nothing lands in the",
      "  repo and nothing lands on the board's plan scan surface (`plans/`).",
      "- A candidate you decide to pursue becomes a board idea, not a tracker issue: take it",
      "  through `/grill` → `/to-spec` → `/to-tickets` so it lands as a plan draft and card lines",
      "  under `.zcode/<task-id>/plans/`; notes that must persist go under",
      "  `.zcode/<task-id>/design/`. Never post to GitHub or any external tracker.",
      "",
      "$ARGUMENTS",
      "",
    ].join("\n"),
    name: "improve-codebase-architecture",
    skill: "improve-codebase-architecture",
  },
];
