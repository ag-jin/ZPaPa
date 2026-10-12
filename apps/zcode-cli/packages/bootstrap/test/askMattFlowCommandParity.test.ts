// 「ask-matt 34 命令装配」四件套同源守卫（卡 #226/F1；设计稿 §2.3 + §6 D1/D5/D8）。
//
// 为什么这组用例承重：命令表是**单源派生**的产物——快照（skills/.zcode-skills-snapshot.json）
// 是唯一技能清单真源；命令表、注册面名单（ask-matt-flow-gate.ts 的 ASK_MATT_FLOW_PACK_SKILL_NAMES）、
// 三类白名单划分（换名/落点注入/无命令）都是它的消费端。任何一端与快照漂移（上游升级、手工改表、
// 白名单漏配/多配）都会静默漏入口或误注册，所以这里做全域覆盖断言：34+3 逐一点名、白名单外
// 不一致必红。**突变验证**：快照增/删/改名技能而其余三件未同步时，断言必须变红（本文件用
// 内存变异 + 纯函数漂移检查器实证；未同步的真实后果 = 构建级用例红）。
//
// 另：命令名与共享保留字表必须互斥（34 名一律不进 RESERVED_SLASH_COMMAND_NAMES，A3 裁定保留）——
// 实验关闭时同名用户自定义命令必须照常可用。
//
// 描述单源守卫：命令 description 取包内 SKILL.md 的上游英文原文（D8），本文件用独立解析器
// 逐件比对（改 SKILL.md 描述或改命令表描述，任一边不同步即红）。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ASK_MATT_FLOW_COMMANDS,
  listAskMattFlowSlashCommands,
  type AskMattFlowCommandDefinition,
} from "../src/ask-matt-flow-commands.js";
import {
  ASK_MATT_FLOW_LANDING_OVERRIDES,
  ASK_MATT_FLOW_NO_COMMAND_SKILL_NAMES,
  ASK_MATT_FLOW_RENAMED_COMMANDS,
} from "../src/ask-matt-flow-command-whitelist.js";
import { findAskMattFlowCommandTableDrift } from "../src/ask-matt-flow-command-parity.js";
import {
  ASK_MATT_FLOW_SKILL_DESCRIPTIONS,
  ASK_MATT_FLOW_SKILL_DISABLE_MODEL_INVOCATION,
} from "../src/ask-matt-flow-skill-metadata.js";
import { resolveZCodeBuiltinPromptCommand } from "../src/builtin-prompt-command.js";
import { ASK_MATT_FLOW_PACK_SKILL_NAMES } from "../src/app/ask-matt-flow-gate.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../../../..");
const skillsRoot = join(repoRoot, "apps", "zcode-cli", "packages", "bundled-skills", "skills");
const snapshotPath = join(skillsRoot, ".zcode-skills-snapshot.json");

function readSnapshotSkillNames(): string[] {
  const record = JSON.parse(readFileSync(snapshotPath, "utf8")) as { skills: string[] };
  return [...record.skills];
}

/** 白名单换名映射（技能 → 命令名）：只收「命令名 ≠ 技能名」的特例（换名三件 + grill 入口名）。 */
function whitelistNameOverrides(): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const entry of [...ASK_MATT_FLOW_RENAMED_COMMANDS, ...ASK_MATT_FLOW_LANDING_OVERRIDES]) {
    if (entry.name !== entry.skill) overrides[entry.skill] = entry.name;
  }
  return overrides;
}

function parityInput(snapshotSkillNames: readonly string[], table = ASK_MATT_FLOW_COMMANDS) {
  return {
    commandTable: table.map(({ name, skill }) => ({ name, skill })),
    nameOverrides: whitelistNameOverrides(),
    noCommandSkillNames: [...ASK_MATT_FLOW_NO_COMMAND_SKILL_NAMES],
    packSkillNames: [...ASK_MATT_FLOW_PACK_SKILL_NAMES],
    snapshotSkillNames: [...snapshotSkillNames],
  };
}

/** 独立解析器：读 SKILL.md frontmatter 的 description 单行标量（支持引号与 \" 反转义）。 */
function readSkillFrontmatterDescription(skillName: string): string {
  const content = readFileSync(join(skillsRoot, skillName, "SKILL.md"), "utf8");
  assert.ok(content.startsWith("---"), `${skillName}/SKILL.md 必须有 frontmatter`);
  const lines = content.split(/\r?\n/);
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  assert.ok(endIndex > 0, `${skillName}/SKILL.md frontmatter 必须闭合`);
  for (const line of lines.slice(1, endIndex)) {
    if (/^\s/.test(line)) continue;
    const match = /^description\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[1]!.trim();
    assert.ok(!/^[>|]/.test(value), `${skillName} 的 description 是块标量，解析器需扩展`);
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\(["\\])/g, "$1");
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    return value;
  }
  throw new Error(`${skillName}/SKILL.md 缺少 description`);
}

test("四件套同源：快照 ↔ 注册面名单 ↔ 命令表 ↔ 白名单三类划分，34+3 全域覆盖且零漂移", () => {
  const snapshotSkillNames = readSnapshotSkillNames();
  assert.equal(snapshotSkillNames.length, 37, "快照应为 37 件（A2 全库入包口径）");

  const drift = findAskMattFlowCommandTableDrift(parityInput(snapshotSkillNames));
  assert.deepEqual(drift, [], `四件套同源断言必须为零漂移：\n${drift.join("\n")}`);

  // 逐一点名：34 条命令技能 + 3 件无命令 = 37 件，无遗漏无重复。
  assert.equal(ASK_MATT_FLOW_COMMANDS.length, 34, "命令表 34 条");
  assert.equal(ASK_MATT_FLOW_NO_COMMAND_SKILL_NAMES.length, 3, "无命令件 3 条");
  assert.equal(
    ASK_MATT_FLOW_COMMANDS.length + ASK_MATT_FLOW_NO_COMMAND_SKILL_NAMES.length,
    snapshotSkillNames.length,
    "34 + 3 = 37：快照每一件恰好落在命令表或无命令名单之一",
  );

  // 表↔注册面同向：命令表目标技能 ⊆ 注册面名单；开态注册面零剔除（gate 行为见注册面套件）。
  for (const command of ASK_MATT_FLOW_COMMANDS) {
    assert.ok(
      ASK_MATT_FLOW_PACK_SKILL_NAMES.includes(
        command.skill as (typeof ASK_MATT_FLOW_PACK_SKILL_NAMES)[number],
      ),
      `命令 /${command.name} 的目标技能 ${command.skill} 必须是注册面成员`,
    );
  }
});

test("保留字互斥：34 命令名一律不进共享保留字表（实验关态交还用户命令名，A3 裁定保留）", async () => {
  const { isReservedZCodeSlashCommandName } = await import("../src/slash-command-surface.js");
  for (const command of ASK_MATT_FLOW_COMMANDS) {
    assert.ok(
      !isReservedZCodeSlashCommandName(command.name),
      `/${command.name} 不得进保留字表（否则关态占用用户命令名）`,
    );
  }
});

test("描述单源守卫：命令 description = 包内 SKILL.md frontmatter 原文（改任一边必红）", () => {
  const snapshotSkillNames = readSnapshotSkillNames();
  for (const skill of snapshotSkillNames) {
    const original = readSkillFrontmatterDescription(skill);
    assert.equal(
      ASK_MATT_FLOW_SKILL_DESCRIPTIONS[skill],
      original,
      `${skill} 的描述必须与包内 SKILL.md 原文逐字一致（D8 机械派生）`,
    );
  }
  assert.deepEqual(
    Object.keys(ASK_MATT_FLOW_SKILL_DESCRIPTIONS).sort(),
    [...snapshotSkillNames].sort(),
    "描述记录必须覆盖快照全部 37 件（新增技能必须补描述）",
  );
  for (const command of ASK_MATT_FLOW_COMMANDS) {
    assert.equal(
      command.description,
      ASK_MATT_FLOW_SKILL_DESCRIPTIONS[command.skill],
      `/${command.name} 的 description 必须取 ${command.skill} 的上游原文`,
    );
  }
});

/** 独立解析器：读 SKILL.md frontmatter 的 `disable-model-invocation: true`（缺省 = false）。 */
function readSkillFrontmatterDisableModelInvocation(skillName: string): boolean {
  const content = readFileSync(join(skillsRoot, skillName, "SKILL.md"), "utf8");
  const lines = content.split(/\r?\n/);
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  assert.ok(endIndex > 0, `${skillName}/SKILL.md frontmatter 必须闭合`);
  return lines
    .slice(1, endIndex)
    .some((line) => /^disable-model-invocation\s*:\s*true\s*$/.test(line));
}

test("知情登记守卫（§1.3 知情项一）：disable-model-invocation 逐件登记（22/37；命令面 20/34），v1 不过滤", () => {
  const snapshotSkillNames = readSnapshotSkillNames();
  const frontmatterFlags = new Map(
    snapshotSkillNames.map((skill) => [skill, readSkillFrontmatterDisableModelInvocation(skill)]),
  );

  // 登记覆盖 37 件且与 SKILL.md 逐件一致（改原文或改登记任一边必红）。
  assert.deepEqual(
    Object.keys(ASK_MATT_FLOW_SKILL_DISABLE_MODEL_INVOCATION).sort(),
    [...snapshotSkillNames].sort(),
    "面向登记必须覆盖快照全部 37 件",
  );
  for (const skill of snapshotSkillNames) {
    assert.equal(
      ASK_MATT_FLOW_SKILL_DISABLE_MODEL_INVOCATION[skill],
      frontmatterFlags.get(skill),
      `${skill} 的 disable-model-invocation 登记必须与 SKILL.md 原文一致`,
    );
  }
  assert.equal(
    [...frontmatterFlags.values()].filter(Boolean).length,
    22,
    "上游 22 件文本面命令（§1.3 知情项一的 22/15 分界）",
  );

  // 命令表逐件登记；命令面 20/34 带上游标志。
  for (const command of ASK_MATT_FLOW_COMMANDS) {
    assert.equal(
      command.disableModelInvocation,
      ASK_MATT_FLOW_SKILL_DISABLE_MODEL_INVOCATION[command.skill],
      `/${command.name} 的面向登记必须与技能元数据一致`,
    );
  }
  assert.equal(
    ASK_MATT_FLOW_COMMANDS.filter((command) => command.disableModelInvocation).length,
    20,
    "命令面 20/34 带上游 disable-model-invocation 标志",
  );

  // v1 不过滤：带上游标志的命令同样进目录、同样可展开。
  assert.equal(listAskMattFlowSlashCommands(true).length, 34, "v1 不过滤：目录 34 条全在");
  for (const command of ASK_MATT_FLOW_COMMANDS) {
    assert.ok(
      resolveZCodeBuiltinPromptCommand(`/${command.name} 参数`, { askMattFlowEnabled: true }),
      `v1 不过滤：/ ${command.name}（含带上游标志件）必须照常展开`,
    );
  }
});

test("突变验证：快照增/删/改名技能时四件套断言必红（未同步的漂移不能静默通过）", () => {
  const baseline = readSnapshotSkillNames();
  assert.deepEqual(
    findAskMattFlowCommandTableDrift(parityInput(baseline)),
    [],
    "对照组：未变异输入必须零漂移（否则突变实验无意义）",
  );

  const mutations: Array<{ label: string; mutate: (skills: string[]) => string[] }> = [
    { label: "快照新增技能", mutate: (skills) => [...skills, "brand-new-skill"] },
    { label: "快照删除技能", mutate: (skills) => skills.filter((skill) => skill !== "retro") },
    {
      label: "快照改名技能",
      mutate: (skills) => skills.map((skill) => (skill === "retro" ? "retro-renamed" : skill)),
    },
  ];
  for (const mutation of mutations) {
    const drift = findAskMattFlowCommandTableDrift(parityInput(mutation.mutate(baseline)));
    assert.ok(drift.length > 0, `${mutation.label}必须被四件套断言咬住（快照是唯一技能清单真源）`);
  }
});

test("突变验证：命令表/无命令名单/换名映射与快照不一致时断言必红", () => {
  const baseline = readSnapshotSkillNames();

  // 命令表漏一件（模拟升级快照后忘改命令表）。
  const dropped = ASK_MATT_FLOW_COMMANDS.filter((command) => command.skill !== "research");
  assert.ok(
    findAskMattFlowCommandTableDrift(parityInput(baseline, dropped)).length > 0,
    "命令表漏技能必须红",
  );

  // 命令表多一件（模拟白名单外多配）。
  const extra: AskMattFlowCommandDefinition[] = [
    ...ASK_MATT_FLOW_COMMANDS,
    {
      argumentHint: "/phantom",
      body: "$ARGUMENTS",
      description: "extra",
      disableModelInvocation: false,
      name: "phantom",
      skill: "phantom",
    },
  ];
  assert.ok(
    findAskMattFlowCommandTableDrift(parityInput(baseline, extra)).length > 0,
    "命令表多配技能必须红",
  );

  // 无命令名单漂移（把无命令件当命令件或反之）。
  const input = parityInput(baseline);
  assert.ok(
    findAskMattFlowCommandTableDrift({
      ...input,
      noCommandSkillNames: [...input.noCommandSkillNames, "retro"],
    }).length > 0,
    "无命令名单混入命令件必须红",
  );

  // 换名映射漂移（matt-tdd 映射被摘除，/tdd 原名回归）。
  const overrides = whitelistNameOverrides();
  delete overrides["tdd"];
  assert.deepEqual(
    findAskMattFlowCommandTableDrift({ ...input, nameOverrides: overrides }).length > 0,
    true,
    "换名映射漏配必须红",
  );
});
