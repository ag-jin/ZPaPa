import { expandCustomCommandPrompt, type CustomCommandContent } from "@zcode/contracts";
import type { ZCodeSlashCommand } from "@zcode/shared";
import {
  ASK_MATT_FLOW_LANDING_OVERRIDES,
  ASK_MATT_FLOW_NO_COMMAND_SKILL_NAMES,
  ASK_MATT_FLOW_RENAMED_COMMANDS,
  type AskMattFlowLandingOverride,
  type AskMattFlowRenamedCommand,
} from "./ask-matt-flow-command-whitelist.js";
import {
  ASK_MATT_FLOW_SKILL_DESCRIPTIONS,
  ASK_MATT_FLOW_SKILL_DISABLE_MODEL_INVOCATION,
} from "./ask-matt-flow-skill-metadata.js";
import { ASK_MATT_FLOW_PACK_SKILL_NAMES } from "./app/ask-matt-flow-gate.js";

/**
 * 「ask-matt 开发流程」34 命令入口（卡 #226/F1 + #228/F3；设计稿 §2.3 + §6 D1/D5/D8/D9）。
 *
 * 单源派生：命令表由包内快照（bundled-skills/skills/.zcode-skills-snapshot.json，代码副本 =
 * ASK_MATT_FLOW_PACK_SKILL_NAMES）生成——快照技能清单 - 无命令件（D1）= 34 条入口；命令名默认取
 * 技能名，特例（换名三件 D5 / 落点注入 10 件 D8）由 ask-matt-flow-command-whitelist.ts 覆盖；
 * `description` 与 `disableModelInvocation` 取包内 SKILL.md 的上游 frontmatter 原文
 * （ask-matt-flow-skill-metadata.ts，D8 + §1.3 知情项一，v1 只登记不过滤）。
 * 白名单外的不一致由同源守卫四件套断言红（askMattFlowCommandParity.test.ts：快照 ↔ 注册面名单 ↔
 * 命令表 ↔ 白名单三类划分，含第④面落点注入件集合与裁决清单严格相等），快照增删技能而命令表未同步必红。
 *
 * 与内置 `/workflow` 同款：命令正文随 CLI 编译，不依赖可卸载插件；正文复用 contracts 的
 * custom command 展开规则（替换 `$ARGUMENTS` 并补充 `skills:` 前言）。前言把目标技能设为
 * **必须先行装载**的技能，所以「调起命令」落到技能装载上（调起进技能），而技能是否可装载由
 * 注册面门决定（app/ask-matt-flow-gate.ts，开态 37 件全注册）；两边同一个开关，关掉时目录与
 * 展开一起为零。
 *
 * 名字策略（D5 裁决 L1 命令层换名）：命令只是入口，不改写技能身份——重叠三件命令名 `/matt-*`、
 * 技能名与上游正文一字不动，`~/.zcode/agents/*.md` 的按名引用（如 `skills: [tdd]`）继续成立。
 * 命令名不进共享保留字表：实验默认关，关闭时同名用户自定义命令照常可用（开态由目录侧压过，
 * 见 zcode-protocol/slash-commands.ts）。
 *
 * 正文两段追加（D8/D9）：34 件一律追加同一段看板边界（项目根解析/扫描面纪律/禁 `.scratch/`/
 * 产品零板写者/实现收尾走看板管线，与 grill/to-spec/to-tickets 既有边界同款英文句式）；落点注入
 * 件另带本件定制的落点约定（D8 十件），两条实现入口（`/matt-implement` 与 `/implement-spec`）
 * 另带 D9 交接边界段（实现完成 ≠ 合并完成 / 产物交看板卡收口 / 绿数以看板为准）。
 */

export interface AskMattFlowCommandDefinition {
  /** `/` 目录里的命令名（不含斜杠）。 */
  name: string;
  /** 命令正文要求先装载的内置包技能名（ask-matt 原名，必须是注册面成员）。 */
  skill: string;
  /** `/` 目录与加号菜单展示用的一句话说明（包内 SKILL.md 上游英文原文）。 */
  description: string;
  /** 使用提示（`/name [args]`）。 */
  argumentHint: string;
  /** 展开正文（`$ARGUMENTS` 必须在场，否则参数会被追加成不受控的尾块）。 */
  body: string;
  /**
   * 上游 `disable-model-invocation` 标志（知情登记，§1.3 知情项一）：true = 上游只给用户的文本面命令。
   * 本产品的 34 入口统一合并该分界——v1 只登记不过滤（目录与展开都不用它做判据）。
   */
  disableModelInvocation: boolean;
}

/**
 * 通用边界段：34 件命令正文统一追加（D8「通用边界行全件」）。
 * 句式对齐 grill/to-spec/to-tickets 的既有 Landing convention（英文）。
 */
export const ASK_MATT_FLOW_GENERIC_BOUNDARY_BLOCK = [
  "Board boundary (this project):",
  "- `.zcode/` resolves against the board project root — the checkout that owns `.zcode/board/` —",
  "  never against the current working directory or a worktree copy.",
  "- The board's plan scan surface only reads `plans/` directories; hidden subdirectories,",
  "  `archive/`, `design/` and STALLED task directories are frozen exclusions. Never write",
  "  `.scratch/<feature>/` files, and never hand-write board files: the board compiler is the",
  "  only board writer.",
  "- Implementation and wrap-up stay with the board pipeline: the board card and its runs are the",
  "  execution record, and the board's own checks decide when work is done.",
].join("\n");

export interface BuildAskMattFlowCommandsInput {
  /** 快照技能清单（顺序即命令表顺序）；无命令件在此剔除。 */
  skillNames: readonly string[];
  /** 技能 → 上游英文描述（快照全覆盖；缺一件即抛错，由同源守卫先红）。 */
  descriptions: Readonly<Record<string, string>>;
  /** 技能 → 上游 `disable-model-invocation` 标志（快照全覆盖；知情登记，v1 不过滤）。 */
  disableModelInvocation: Readonly<Record<string, boolean>>;
  /** 换名件（命令名 ≠ 技能名，D5）。 */
  renamedCommands?: readonly AskMattFlowRenamedCommand[];
  /** 落点注入件（D8 十件：既有三件原样保留 + #228/F3 新增七件逐件定制落点约定）。 */
  landingOverrides?: readonly AskMattFlowLandingOverride[];
  /** 无命令件（D1；仍随包与注册，只是不带斜杠入口）。 */
  noCommandSkillNames?: readonly string[];
}

/**
 * 单源派生器：快照技能清单 → 34 条命令条目。
 * 顺序即快照顺序；换名/注入覆盖按技能名索引；无命令件直接跳过。
 */
export function buildAskMattFlowCommands(
  input: BuildAskMattFlowCommandsInput,
): AskMattFlowCommandDefinition[] {
  const noCommand = new Set(input.noCommandSkillNames ?? []);
  const renamed = new Map(
    (input.renamedCommands ?? []).map((entry) => [entry.skill, entry] as const),
  );
  const overrides = new Map((input.landingOverrides ?? []).map((entry) => [entry.skill, entry]));
  const known = new Set(input.skillNames);

  for (const skill of [...renamed.keys(), ...overrides.keys()]) {
    if (!known.has(skill)) {
      throw new Error(`ask-matt 命令白名单引用了快照之外的技能：${skill}`);
    }
  }

  return input.skillNames.flatMap((skill) => {
    if (noCommand.has(skill)) return [];
    const description = input.descriptions[skill];
    if (description === undefined || description.trim().length === 0) {
      throw new Error(`ask-matt 命令表缺少技能描述：${skill}（快照新增技能必须同步补描述）`);
    }
    const disableModelInvocation = input.disableModelInvocation[skill];
    if (disableModelInvocation === undefined) {
      throw new Error(`ask-matt 命令表缺少面向登记：${skill}（快照新增技能必须同步补录标志）`);
    }
    const override = overrides.get(skill);
    const renamedEntry = renamed.get(skill);
    const name = override?.name ?? renamedEntry?.name ?? skill;
    const baseBody =
      override?.body ??
      renamedEntry?.body ??
      [
        `Use the \`${skill}\` skill to carry out this request (ask-matt flow).`,
        "",
        "$ARGUMENTS",
        "",
      ].join("\n");
    return [
      {
        argumentHint: override?.argumentHint ?? `/${name}`,
        body: `${baseBody}\n${ASK_MATT_FLOW_GENERIC_BOUNDARY_BLOCK}\n`,
        description,
        disableModelInvocation,
        name,
        skill,
      },
    ];
  });
}

/** 34 条命令：包内快照（37 件）- 无命令三件（D1），换名三件（D5）+ 落点注入 10 件（D8）。 */
export const ASK_MATT_FLOW_COMMANDS: readonly AskMattFlowCommandDefinition[] =
  buildAskMattFlowCommands({
    descriptions: ASK_MATT_FLOW_SKILL_DESCRIPTIONS,
    disableModelInvocation: ASK_MATT_FLOW_SKILL_DISABLE_MODEL_INVOCATION,
    landingOverrides: ASK_MATT_FLOW_LANDING_OVERRIDES,
    noCommandSkillNames: ASK_MATT_FLOW_NO_COMMAND_SKILL_NAMES,
    renamedCommands: ASK_MATT_FLOW_RENAMED_COMMANDS,
    skillNames: ASK_MATT_FLOW_PACK_SKILL_NAMES,
  });

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
