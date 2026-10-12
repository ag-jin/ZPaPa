// 「ask-matt 开发流程」二次发现面断言（卡 #205/A4，收口 #204 的 F2）。
//
// 为什么这组用例承重：会话运行注册面（create-app 的 skillPort）由 ask-matt 门决定（#204/A3），
// 但 `zcode skills list` / TUI 与工作区引用目录草稿走 bootstrap/src/skills.ts 的**独立发现面**
// （listZCodeSkills / inspectZCodeSkill）。两个面若判据分叉，就会出现「清单里看得见、会话里装不上」
// 的半态：关掉的实验在全库清单里留 37 件半成品，开态却仍把重叠三件摆出来。
// 本文件把二次发现面钉在与注册面**同一判据单点**（resolveBundledSkillDisabledPaths）上：
//   - 关态（含未提供 = fail-closed）：零 ask-matt 技能（含重叠件与流程三技能）；
//   - 开态：包内 34/37 可见（快照 37 件减重叠 3 件）、重叠件恒缺、流程三技能正文可达。
// 独立真源 = 包内快照文件（.zcode-skills-snapshot.json），不复算实现里的名单常量。
//
// 已知缺口（登记，不修，收口批裁量）：动态工作流门未接本面——dynamic-workflows 在二次发现面
// 与 dwf 开关无关地始终可见；本文件把它按现状钉住，防止静默漂移。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ASK_MATT_FLOW_OVERLAP_SKILL_NAMES,
  ASK_MATT_FLOW_PACK_SKILL_NAMES,
} from "../src/app/ask-matt-flow-gate.js";
import { inspectZCodeSkill, listZCodeSkills } from "../src/skills.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../../../..");
const skillsRoot = join(repoRoot, "apps", "zcode-cli", "packages", "bundled-skills", "skills");
const snapshotPath = join(skillsRoot, ".zcode-skills-snapshot.json");
const DYNAMIC_WORKFLOW_SKILL_NAME = "dynamic-workflows";

/**
 * 隔离用户技能根：~/.zcode/skills 在本机装有 implement / grilling 等同名技能（开发者机器常态），
 * 不隔离就会让「关态取不到」的断言在别人机器上时红时绿。homedir() 在 POSIX 读 $HOME，
 * Windows 读 USERPROFILE，两个都替换并在 finally 复原。
 */
async function withIsolatedHome<T>(
  task: (env: { homeDirectory: string; workingDirectory: string }) => Promise<T>,
): Promise<T> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "zcode-ask-matt-discovery-home-"));
  const workingDirectory = await mkdtemp(join(tmpdir(), "zcode-ask-matt-discovery-ws-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDirectory;
  process.env.USERPROFILE = homeDirectory;
  try {
    return await task({ homeDirectory, workingDirectory });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    await rm(homeDirectory, { force: true, recursive: true });
    await rm(workingDirectory, { force: true, recursive: true });
  }
}

async function listBundledSkillNames(options: {
  workingDirectory: string;
  askMattFlowEnabled?: boolean;
}): Promise<string[]> {
  const outcome = await listZCodeSkills({
    skipUserConfig: true,
    ...(options.askMattFlowEnabled === undefined
      ? {}
      : { askMattFlowEnabled: options.askMattFlowEnabled }),
    workingDirectory: options.workingDirectory,
  });
  // 只认内置包来源（bundled）：插件/项目/用户根在隔离环境里应为空，但断言不依赖这一点。
  return outcome.skills
    .filter((skill) => skill.source === "bundled")
    .map((skill) => skill.name)
    .sort();
}

async function readSnapshotSkillNames(): Promise<string[]> {
  const record = JSON.parse(await readFile(snapshotPath, "utf8")) as { skills: string[] };
  return [...record.skills].sort();
}

test("二次发现面 · 关态：零 ask-matt 技能（未提供 fail-closed 与显式 false 同结论）", async () => {
  await withIsolatedHome(async (env) => {
    for (const askMattFlowEnabled of [undefined, false]) {
      const names = await listBundledSkillNames({
        askMattFlowEnabled,
        workingDirectory: env.workingDirectory,
      });
      for (const name of ASK_MATT_FLOW_PACK_SKILL_NAMES) {
        assert.ok(
          !names.includes(name),
          `关态二次发现面不得出现 ask-matt 技能 ${name}：${names.join(",")}`,
        );
      }
      for (const flowSkill of ["grilling", "to-spec", "to-tickets"]) {
        assert.ok(!names.includes(flowSkill), `关态不得出现流程技能 ${flowSkill}`);
      }
      // 已知缺口登记：dynamic-workflows 由动态工作流门独立控制，本面未接该门（收口批裁量）。
      assert.ok(
        names.includes(DYNAMIC_WORKFLOW_SKILL_NAME),
        "二次发现面的 dynamic-workflows 现状（缺口未修）必须被显式钉住",
      );
    }
  });
});

test("二次发现面 · 关态：inspect 面与发现面同结论（流程技能与重叠件都取不到）", async () => {
  await withIsolatedHome(async (env) => {
    for (const name of ["grilling", "to-spec", "to-tickets", ...ASK_MATT_FLOW_OVERLAP_SKILL_NAMES]) {
      await assert.rejects(
        inspectZCodeSkill({ name, skipUserConfig: true, workingDirectory: env.workingDirectory }),
        /Skill not found/,
        `关态 inspect(${name}) 必须与发现面一致：不可取`,
      );
    }
  });
});

test("二次发现面 · 开态：包内 34/37 可见、重叠三件恒缺、流程三技能正文可达", async () => {
  await withIsolatedHome(async (env) => {
    // 独立真源：包内快照（37 件）减重叠件（3 件）= 开态应可见的 34 件。
    const snapshotNames = await readSnapshotSkillNames();
    assert.equal(snapshotNames.length, 37, "包内快照应是 37 件（A2 全库入包口径）");
    const expectedVisible = snapshotNames
      .filter((name) => !ASK_MATT_FLOW_OVERLAP_SKILL_NAMES.includes(name))
      .sort();
    assert.equal(expectedVisible.length, 34, "开态可见面应为 34/37（重叠件剔除后）");

    const names = await listBundledSkillNames({
      askMattFlowEnabled: true,
      workingDirectory: env.workingDirectory,
    });
    assert.deepEqual(
      names,
      [...expectedVisible, DYNAMIC_WORKFLOW_SKILL_NAME].sort(),
      "开态二次发现面 = 34 件非重叠 ask-matt 技能 + 既有 dynamic-workflows",
    );
    for (const overlap of ASK_MATT_FLOW_OVERLAP_SKILL_NAMES) {
      assert.ok(!names.includes(overlap), `重叠件 ${overlap} 在所有发现面恒不可见`);
    }

    // 流程三命令的目标技能必须能经二次发现面读到 bundled 正文（与注册面同一份资产）。
    for (const flowSkill of ["grilling", "to-spec", "to-tickets"]) {
      const inspection = await inspectZCodeSkill({
        askMattFlowEnabled: true,
        name: flowSkill,
        skipUserConfig: true,
        workingDirectory: env.workingDirectory,
      });
      assert.equal(inspection.skill.metadata.name, flowSkill);
      assert.ok(
        inspection.skill.metadata.path.startsWith(skillsRoot),
        `${flowSkill} 必须解析到内置包路径：${inspection.skill.metadata.path}`,
      );
    }
    for (const overlap of ASK_MATT_FLOW_OVERLAP_SKILL_NAMES) {
      await assert.rejects(
        inspectZCodeSkill({
          askMattFlowEnabled: true,
          name: overlap,
          skipUserConfig: true,
          workingDirectory: env.workingDirectory,
        }),
        /Skill not found/,
        `重叠件 ${overlap} 在开态也不得取到（带文件、不注册）`,
      );
    }
  });
});

test("装配挂点（源码守卫）：二次发现面经 A3 判据单点，且生产调用方传进程缓存门", () => {
  const skillsSource = readFileSync(resolve(testDir, "../src/skills.ts"), "utf8");
  assert.match(
    skillsSource,
    /resolveBundledSkillDisabledPaths\(/,
    "skills.ts 必须复用 A3 的判据单点组装禁用路径，不得就地第二实现",
  );
  assert.match(
    skillsSource,
    /askMattFlowEnabled: options\.askMattFlowEnabled/,
    "skills.ts 必须把调用方传入的 ask-matt 门透传给判据单点",
  );
  assert.doesNotMatch(
    skillsSource,
    /ASK_MATT_FLOW_PACK_SKILL_NAMES/,
    "skills.ts 不得复制 ask-matt 名单（名单唯一真源在 app/ask-matt-flow-gate.ts）",
  );

  const catalogSource = readFileSync(
    resolve(testDir, "../src/zcode-protocol/skill-reference-catalog.ts"),
    "utf8",
  );
  assert.match(
    catalogSource,
    /askMattFlowEnabled: context\.appRuntimePreferences\.askMattFlowEnabled/,
    "工作区引用目录草稿的发现面必须传进程缓存的 ask-matt 门（与 create-app 注册面同源）",
  );
});
