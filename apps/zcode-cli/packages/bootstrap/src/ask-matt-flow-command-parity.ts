import { isReservedZCodeSlashCommandName } from "./slash-command-surface.js";

/**
 * 「ask-matt 34 命令装配」四件套**同源漂移检查器**（卡 #226/F1；设计稿 §2.3）。
 *
 * 单一技能清单真源 = 包内快照（skills/.zcode-skills-snapshot.json）。四个消费端：
 *   ① 快照清单；② 注册面名单（ask-matt-flow-gate.ts 的 ASK_MATT_FLOW_PACK_SKILL_NAMES，开态全注册）；
 *   ③ 命令表（快照派生：34 条 = 37 件 - 无命令件）；④ 三类白名单划分（换名/落点注入/无命令）。
 * 任一端的漂移（上游升级漏改、手改命令表、白名单漏配/多配、命令名进保留字表）都在这里点名；
 * 返回空数组 = 四件套一致。构建级用例（askMattFlowCommandParity.test.ts）以真实快照 + 突变输入
 * 双向实证（未变异零漂移、快照增删改名必红）。
 *
 * 纯函数：不接受文件系统与运行期状态，快照内容由调用方读出——便于突变验证在内存里构造
 * 「快照已变、其余未变」的场景。
 */
export interface AskMattFlowCommandTableEntry {
  /** 命令名（不含斜杠）。 */
  name: string;
  /** 目标技能名（注册面成员）。 */
  skill: string;
}

export interface AskMattFlowCommandParityInput {
  /** 包内快照技能清单（唯一真源）。 */
  snapshotSkillNames: readonly string[];
  /** 注册面名单常量（应对等于快照）。 */
  packSkillNames: readonly string[];
  /** 命令表（name/skill 投影即可）。 */
  commandTable: readonly AskMattFlowCommandTableEntry[];
  /** 无命令件名单（D1）。 */
  noCommandSkillNames: readonly string[];
  /** 白名单换名/入口名映射（技能 → 命令名；命令名 ≠ 技能名的全部特例）。 */
  nameOverrides: Readonly<Record<string, string>>;
}

export function findAskMattFlowCommandTableDrift(input: AskMattFlowCommandParityInput): string[] {
  const problems: string[] = [];
  const snapshot = new Set(input.snapshotSkillNames);
  const pack = new Set(input.packSkillNames);
  const noCommand = new Set(input.noCommandSkillNames);
  const commandSkills = new Set(input.commandTable.map((command) => command.skill));
  const expectedOverrides = new Map(Object.entries(input.nameOverrides));

  // ① 快照 ↔ ② 注册面名单：双向一致（快照增删技能而名单未同步 = 漏注册/误注册）。
  for (const skill of snapshot) {
    if (!pack.has(skill)) problems.push(`注册面名单缺少快照技能：${skill}`);
  }
  for (const skill of pack) {
    if (!snapshot.has(skill)) problems.push(`注册面名单多出快照外技能：${skill}`);
  }

  // ③ 命令表 ↔ ④ 无命令名单：两者互补覆盖快照且互斥。
  for (const skill of noCommand) {
    if (!snapshot.has(skill)) problems.push(`无命令名单含快照外技能：${skill}`);
    if (commandSkills.has(skill)) problems.push(`技能同时出现在命令表与无命令名单：${skill}`);
  }
  for (const skill of commandSkills) {
    if (!snapshot.has(skill)) problems.push(`命令表含快照外技能：${skill}`);
  }
  for (const skill of snapshot) {
    if (!commandSkills.has(skill) && !noCommand.has(skill)) {
      problems.push(`快照技能无覆盖（既无命令也不在无命令名单）：${skill}`);
    }
  }

  // 命令表自身：技能与命令名都不得重复。
  for (const [label, keys] of [
    ["技能", input.commandTable.map((command) => command.skill)],
    ["命令名", input.commandTable.map((command) => command.name)],
  ] as const) {
    const seen = new Set<string>();
    for (const key of keys) {
      if (seen.has(key)) problems.push(`命令表${label}重复：${key}`);
      seen.add(key);
    }
  }

  // 换名/入口名白名单：实际「命令名 ≠ 技能名」集合必须与白名单映射严格相等（漏配/多配必红）。
  const actualOverrides = new Map<string, string>();
  for (const command of input.commandTable) {
    if (command.name !== command.skill) actualOverrides.set(command.skill, command.name);
  }
  for (const [skill, name] of actualOverrides) {
    const expected = expectedOverrides.get(skill);
    if (expected === undefined) {
      problems.push(`命令名偏离技能名但不在白名单：${skill} → /${name}`);
    } else if (expected !== name) {
      problems.push(`白名单换名不一致：${skill} 期望 /${expected}，实际 /${name}`);
    }
  }
  for (const [skill, name] of expectedOverrides) {
    if (!actualOverrides.has(skill)) {
      problems.push(`白名单映射未生效（命令名仍是技能名）：${skill} → /${name}`);
    }
    if (!snapshot.has(skill)) problems.push(`白名单引用了快照外技能：${skill}`);
  }

  // 命令名与共享保留字表互斥（34 名一律不进表：实验关态交还用户命令名）。
  for (const command of input.commandTable) {
    if (isReservedZCodeSlashCommandName(command.name)) {
      problems.push(`命令名进了共享保留字表：/${command.name}`);
    }
  }

  return problems;
}
