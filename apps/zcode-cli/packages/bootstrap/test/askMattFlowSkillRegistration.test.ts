// 「ask-matt 开发流程」注册面断言（卡 #226/F1 起：开态 37 件全注册；原 #204/A3 卡）。
//
// 为什么这组用例承重：mattpocock/skills 全库随 CLI 分发（#203/A2 入包），但**注册面**（哪些技能
// 可被发现、可被 Skill 工具加载）由「ask-matt 开发流程」实验开关决定：
//   - 开关关闭（含未设置 / 未加载）：内置包全库零注册 —— 关掉的实验不得在 Skill 清单里留半件；
//   - 开关打开：**全库 37 件全注册**（卡 #226 起）。#204 的「重叠三件恒不注册」已由 §6 D5 裁决
//     退役：重叠三件改走命令层换名（/matt-implement、/matt-tdd、/matt-code-review），目标技能仍用
//     上游原名注册——命令要能装载目标技能，且用户 agent 军团按技能名引用（`skills: [tdd]`）需要
//     纯产品环境下按名装载；
//   - dynamic-workflows（产品内置技能，非上游快照库）由动态工作流门独立控制，2×2 乘积态互不牵连。
//
// 断言走真实资产（apps/zcode-cli/packages/bundled-skills）+ 真实 NodeSkillAdapter / 二次发现面：
// 发现面与加载面必须给出同一结论。名单以包内快照为身份真源，代码常量与快照的漂移由本文件第一条
// 用例守卫。U3（纯产品环境 agent 引用面）在隔离 HOME 下实证：无 ~/.zcode/skills 用户件时，
// tdd/code-review/implement 仍可按名装载到内置包正文。

import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeSkillAdapter } from "@zcode/adapters/skills";
import type { SkillRoot } from "@zcode/contracts";
import {
  ASK_MATT_FLOW_PACK_SKILL_NAMES,
  collectAskMattFlowDisabledSkillPaths,
  resolveBundledSkillDisabledPaths,
} from "../src/app/ask-matt-flow-gate.js";
import { inspectZCodeSkill } from "../src/skills.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../../../..");
const skillsRoot = join(repoRoot, "apps", "zcode-cli", "packages", "bundled-skills", "skills");
const snapshotPath = join(skillsRoot, ".zcode-skills-snapshot.json");

/** 与 resolveBundledSkillRoots 产出同形（构建级用例直接指向仓库内真实资产，不经过入口候选目录）。 */
const bundledRoot: SkillRoot = {
  path: skillsRoot,
  priority: 1_000_000,
  scope: "system",
  source: "bundled",
};

function adapterWithDisabledPaths(disabledPaths: readonly string[]): NodeSkillAdapter {
  return new NodeSkillAdapter({ disabledPaths: [...disabledPaths] });
}

async function discoverNames(adapter: NodeSkillAdapter): Promise<string[]> {
  const outcome = await adapter.discoverSkills({
    roots: [bundledRoot],
    workingDirectory: repoRoot,
  });
  assert.deepEqual(
    outcome.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
    `真实技能包不应有错误级诊断：${JSON.stringify(outcome.diagnostics)}`,
  );
  return outcome.skills.map((skill) => skill.name).sort();
}

async function readSnapshotSkillNames(): Promise<string[]> {
  const record = JSON.parse(await readFile(snapshotPath, "utf8")) as { skills: string[] };
  return [...record.skills].sort();
}

/** 隔离用户技能根（~/.zcode/skills 本机装有同名件）：纯产品环境实验的前提。 */
async function withIsolatedHome<T>(
  task: (env: { homeDirectory: string; workingDirectory: string }) => Promise<T>,
): Promise<T> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "zcode-ask-matt-reg-home-"));
  const workingDirectory = await mkdtemp(join(tmpdir(), "zcode-ask-matt-reg-ws-"));
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

test("漂移守卫：登记名单常量与包内快照一一对应（升级快照必须同步两处）", async () => {
  assert.deepEqual(
    [...ASK_MATT_FLOW_PACK_SKILL_NAMES].sort(),
    await readSnapshotSkillNames(),
    "ASK_MATT_FLOW_PACK_SKILL_NAMES 必须与 skills/.zcode-skills-snapshot.json 逐项一致",
  );

  // 快照 37 件必须逐一真实存在于包内（开态全注册的前提），且名单无重复。
  const onDisk = (await readdir(skillsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
  for (const skill of ASK_MATT_FLOW_PACK_SKILL_NAMES) {
    assert.ok(onDisk.includes(skill), `快照件 ${skill} 必须随包携带`);
  }
  assert.equal(new Set(ASK_MATT_FLOW_PACK_SKILL_NAMES).size, ASK_MATT_FLOW_PACK_SKILL_NAMES.length);

  // 产品内置技能不属于上游快照库：不得混入登记名单（dynamic-workflows 有自己的门）。
  assert.ok(!ASK_MATT_FLOW_PACK_SKILL_NAMES.includes("dynamic-workflows"));
});

test("开关关闭：内置包全库零注册，dynamic-workflows 不受牵连", async () => {
  const adapter = adapterWithDisabledPaths(
    collectAskMattFlowDisabledSkillPaths([bundledRoot], false),
  );
  assert.deepEqual(await discoverNames(adapter), ["dynamic-workflows"]);
});

test("开关未设置 / 未加载（undefined）按关闭处理：同样零注册", () => {
  // 判据与 A1 的 askMattEntryVisible 同源：只有显式 true 才注册。
  assert.deepEqual(collectAskMattFlowDisabledSkillPaths([bundledRoot], undefined), [
    ...collectAskMattFlowDisabledSkillPaths([bundledRoot], false),
  ]);
});

test("开关打开：37 件全注册（含重叠三件），全部可解析到 bundled 正文", async () => {
  const adapter = adapterWithDisabledPaths(
    collectAskMattFlowDisabledSkillPaths([bundledRoot], true),
  );
  const names = await discoverNames(adapter);

  const expected = [...ASK_MATT_FLOW_PACK_SKILL_NAMES, "dynamic-workflows"].sort();
  assert.deepEqual(names, expected, "开关打开 = 全库 37 件全部注册 + 内置 dynamic-workflows");

  // 发现面与加载面同结论：全库每一件都能按名装载到包内正文（含重叠三件——命令/agent 的装载前提）。
  for (const skill of ASK_MATT_FLOW_PACK_SKILL_NAMES) {
    const loaded = await adapter.loadSkill({
      name: skill,
      roots: [bundledRoot],
      workingDirectory: repoRoot,
    });
    assert.equal(loaded.metadata.name, skill);
    assert.ok(loaded.content.length > 0, `技能 ${skill} 的 bundled 正文不得为空`);
    assert.ok(loaded.metadata.path.startsWith(skillsRoot), `${skill} 必须解析到内置包路径`);
  }
});

test("U3 实证 · 纯产品环境（无用户技能根）：agent 按名引用的 tdd/code-review/implement 可装载", async () => {
  await withIsolatedHome(async (env) => {
    // 纯产品环境：隔离 HOME 后 ~/.zcode/skills 不存在，用户根同名件不参与（用户目录顶替面）。
    // agent 军团（~/.zcode/agents/*.md 的 skills: [tdd] 等，用户域，不在本仓）按技能名引用；
    // 本用例实证产品侧注册面在开态能按原名装载，L1 命令层换名不影响该引用面。
    for (const name of ["tdd", "code-review", "implement"]) {
      const inspection = await inspectZCodeSkill({
        askMattFlowEnabled: true,
        name,
        skipUserConfig: true,
        workingDirectory: env.workingDirectory,
      });
      assert.equal(inspection.skill.metadata.name, name);
      assert.ok(
        inspection.skill.metadata.path.startsWith(skillsRoot),
        `${name} 必须解析到内置包路径（纯产品环境无用户件）：${inspection.skill.metadata.path}`,
      );
      assert.ok(inspection.skill.content.length > 0, `${name} 正文不得为空`);
    }

    // 反例（同一发现面、同一环境）：关态按名取不到——注册面确实受开关门控制，不是恒可见。
    await assert.rejects(
      inspectZCodeSkill({
        name: "tdd",
        skipUserConfig: true,
        workingDirectory: env.workingDirectory,
      }),
      /Skill not found/,
      "关态纯产品环境不得按名装载 tdd（杜绝半件）",
    );
  });
});

test("2×2 乘积态：ask-matt 注册面 × 动态工作流门互不影响", async () => {
  for (const askMatt of [false, true]) {
    for (const dynamicWorkflow of [false, true]) {
      const disabledPaths = resolveBundledSkillDisabledPaths({
        askMattFlowEnabled: askMatt,
        bundledSkillRoots: [bundledRoot],
        configDisabledPaths: [],
        dynamicWorkflowEnabled: dynamicWorkflow,
      });
      const names = await discoverNames(adapterWithDisabledPaths(disabledPaths));

      assert.equal(
        names.includes("dynamic-workflows"),
        dynamicWorkflow,
        `dynamic-workflows 只随动态工作流门（askMatt=${askMatt}, dwf=${dynamicWorkflow}）`,
      );
      for (const probe of ["grilling", "implement", "tdd", "code-review"]) {
        assert.equal(
          names.includes(probe),
          askMatt,
          `${probe} 只随 ask-matt 门（askMatt=${askMatt}, dwf=${dynamicWorkflow}）`,
        );
      }
    }
  }
});

test("组合门单点：resolveBundledSkillDisabledPaths 汇总 config/动态工作流/ask-matt 三路禁用", () => {
  const combined = resolveBundledSkillDisabledPaths({
    askMattFlowEnabled: true,
    bundledSkillRoots: [bundledRoot],
    configDisabledPaths: ["/tmp/user-skill/SKILL.md"],
    dynamicWorkflowEnabled: false,
  });
  assert.ok(combined.includes("/tmp/user-skill/SKILL.md"), "用户配置禁用保持在场");
  assert.ok(
    combined.includes(join(skillsRoot, "dynamic-workflows", "SKILL.md")),
    "动态工作流关闭时 dynamic-workflows 被剔除",
  );
  assert.equal(
    collectAskMattFlowDisabledSkillPaths([bundledRoot], true).length,
    0,
    "开态 ask-matt 门零禁用（37 件全注册）",
  );
  for (const skill of ASK_MATT_FLOW_PACK_SKILL_NAMES) {
    assert.ok(
      !combined.includes(join(skillsRoot, skill, "SKILL.md")),
      `开态下 ${skill} 不得被 ask-matt 门误伤`,
    );
  }
});
