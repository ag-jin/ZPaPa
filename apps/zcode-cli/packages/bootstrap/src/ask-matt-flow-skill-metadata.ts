/**
 * 包内快照 37 件技能的**上游 frontmatter 元数据副本**（卡 #226/F1；设计稿 §2.3 + D8 + §1.3 知情项一）。
 *
 * 一、`description`（英文原文，零翻译维护）：命令表的 `description` 由本记录机械派生。不手写不等于
 * 不守卫：`askMattFlowCommandParity.test.ts` 逐件解析包内 `skills/<name>/SKILL.md` 的 frontmatter
 * 与这里比对，任何一边改动而另一边不同步都会红。快照 JSON（`.zcode-skills-snapshot.json`）只记录
 * 技能名清单与整库摘要，逐件原文住在各技能自己的 SKILL.md（同一份被 contentSha256 覆盖的 vendored
 * 资产）——本记录是该原文在命令面的副本。
 *
 * 二、`disable-model-invocation`（知情登记）：上游 37 件中 22 件带 `true`（文本面命令，只给用户）
 * 与 15 件不带（模型侧可引用）。用户的 34 入口把上游分界统一合并——命令表按件记录该标志（v1 只
 * 登记、不过滤，34 条一律可用户调起；未来若启用过滤，判据就在这里）。
 *
 * 升级上游快照时：先更新包内技能文件与快照，再按 SKILL.md 新 frontmatter 更新本记录（守卫会点名
 * 差异件）。两条记录都覆盖快照全部 37 件（含无命令三件）：新增技能必须同时补录，遗漏即红。
 */
export const ASK_MATT_FLOW_SKILL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "ask-matt": "Ask which skill or flow fits your situation. A router over the skills in this repo.",
  "claude-handoff":
    "Hand the current conversation off to a fresh background agent that picks up the work immediately.",
  "code-review":
    'Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes: Standards (does the code follow this repo\'s documented coding standards?) and Spec (does the code match what the originating issue/spec asked for?). Runs both reviews in parallel sub-agents and reports them side by side. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to "review since X".',
  "codebase-design":
    "Shared vocabulary for designing deep modules. Use when the user wants to design or improve a module's interface, find deepening opportunities, decide where a seam goes, make code more testable or AI-navigable, or when another skill needs the deep-module vocabulary.",
  "diagnosing-bugs":
    'Diagnosis loop for hard bugs and performance regressions. Use when the user says "diagnose"/"debug this", or reports something broken/throwing/failing/slow.',
  "domain-modeling":
    "Build and sharpen a project's domain model. Use when discussing codebase terminology, writing or editing a CONTEXT.md, or recording or editing an ADR.",
  "git-guardrails-claude-code":
    "Set up Claude Code hooks to block dangerous git commands (push, reset --hard, clean, branch -D, etc.) before they execute. Use when user wants to prevent destructive git operations, add git safety hooks, or block git push/reset in Claude Code.",
  "grill-me": "A relentless interview to sharpen a plan or design.",
  "grill-with-docs":
    "A relentless interview to sharpen a plan or design, which also creates docs (ADR's and glossary) as we go.",
  grilling:
    "Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.",
  handoff: "Compact the current conversation into a handoff document for another agent to pick up.",
  implement: "Implement a piece of work based on a spec or set of tickets.",
  "implement-spec": "Implement a specification in code.",
  "improve-codebase-architecture":
    "Scan a codebase for deepening opportunities, present them as a visual HTML report, then grill through whichever one you pick.",
  "loop-me": "Grill me about specs for the workflows I want to build, within this workspace.",
  "migrate-to-shoehorn":
    "Migrate test files from `as` type assertions to @total-typescript/shoehorn. Use when user mentions shoehorn, wants to replace `as` in tests, or needs partial test data.",
  prototype:
    "Build a throwaway prototype to answer a design question. Use when the user wants to sanity-check whether a state model or logic feels right, or explore what a UI should look like.",
  research:
    "Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a background agent.",
  "resolving-merge-conflicts":
    "Use when you need to resolve an in-progress git merge/rebase conflict.",
  retro: "Conduct a retrospective on a coding session.",
  "scaffold-exercises":
    "Create exercise directory structures with sections, problems, solutions, and explainers that pass linting. Use when user wants to scaffold exercises, create exercise stubs, or set up a new course section.",
  "setup-matt-pocock-skills":
    "Configure this repo for the engineering skills: set up its issue tracker, triage label vocabulary, and domain doc layout. Run once before first use of the other engineering skills.",
  "setup-pre-commit":
    "Set up Husky pre-commit hooks with lint-staged (Prettier), type checking, and tests in the current repo. Use when user wants to add pre-commit hooks, set up Husky, configure lint-staged, or add commit-time formatting/typechecking/testing.",
  "setup-ts-deep-modules":
    "Wire dependency-cruiser into a TypeScript repo so each package is a deep module, with implementation hidden in subfolders and reachable only through its entry-point files. User-invoked.",
  tdd: 'Test-driven development. Use when the user wants to build features or fix bugs test-first, mentions "red-green-refactor", or wants integration tests.',
  teach: "Teach the user a new skill or concept, within this workspace.",
  "to-questionnaire":
    "Turn a decision you can't fully answer into a questionnaire for someone else to fill in.",
  "to-spec":
    "Turn the current conversation into a spec and publish it to the project issue tracker: no interview, just synthesis of what you've already discussed.",
  "to-tickets":
    "Break a plan, spec, or the current conversation into a set of tracer-bullet tickets, each declaring its blocking edges, published to the configured tracker (edges as text in one file per ticket locally, or native blocking links on a real tracker).",
  triage:
    "Move issues and external PRs through a state machine of triage roles, categorise, verify, grill if needed, and write agent-ready briefs.",
  "wait-what": "Stop. That last message did not land: re-pitch it.",
  wayfinder:
    "Plan a huge chunk of work (more than one agent session can hold) as a shared map of decision tickets on your issue tracker, and resolve them one at a time until the way to the destination is clear.",
  wizard:
    "Generate an interactive bash wizard that walks a human through steps only they can perform. Use when provisioning infrastructure, setting up credentials or CI secrets, walking an unfamiliar third-party dashboard, or running a one-off migration or cutover. Don't invoke this for steps the agent can perform itself.",
  "writing-beats":
    "Writing, exploit; assemble raw material into a journey of beats, grounding each term before a beat leans on it.",
  "writing-for-agents":
    "Writing documents for agents. Use when creating or editing skills, or modifying AGENTS.md or CLAUDE.md.",
  "writing-fragments": "Writing, explore: mine raw fragments, no structure yet.",
  "writing-shape": "Writing, exploit: shape raw material into an article, paragraph by paragraph.",
};

/**
 * 上游 `disable-model-invocation: true` 的逐件副本（22/37；其中命令面 20/34）。
 * 语义 = 上游把该技能标为文本面命令（只给用户）；本产品的 34 入口统一合并该分界，
 * 本记录 v1 只作知情登记（命令表字段 `disableModelInvocation`），不参与任何过滤。
 */
export const ASK_MATT_FLOW_SKILL_DISABLE_MODEL_INVOCATION: Readonly<Record<string, boolean>> = {
  "ask-matt": true,
  "claude-handoff": true,
  "code-review": false,
  "codebase-design": false,
  "diagnosing-bugs": false,
  "domain-modeling": false,
  "git-guardrails-claude-code": false,
  "grill-me": true,
  "grill-with-docs": true,
  grilling: false,
  handoff: true,
  implement: true,
  "implement-spec": true,
  "improve-codebase-architecture": true,
  "loop-me": true,
  "migrate-to-shoehorn": false,
  prototype: false,
  research: false,
  "resolving-merge-conflicts": false,
  retro: true,
  "scaffold-exercises": false,
  "setup-matt-pocock-skills": true,
  "setup-pre-commit": false,
  "setup-ts-deep-modules": true,
  tdd: false,
  teach: true,
  "to-questionnaire": true,
  "to-spec": true,
  "to-tickets": true,
  triage: true,
  "wait-what": true,
  wayfinder: true,
  wizard: false,
  "writing-beats": true,
  "writing-for-agents": false,
  "writing-fragments": true,
  "writing-shape": true,
};
