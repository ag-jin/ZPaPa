// 「ask-matt 开发流程」注册面断言（卡 #204/A3：命令注册 + 重叠件剔除）。
//
// 为什么这组用例承重：mattpocock/skills 全库随 CLI 分发（#203/A2 入包），但**注册面**（哪些技能
// 可被发现、可被 Skill 工具加载）由本卡按「ask-matt 开发流程」实验开关决定：
//   - 开关关闭（含未设置 / 未加载）：内置包全库零注册 —— 关掉的实验不得在 Skill 清单里留半件；
//   - 开关打开：全库注册，**重叠件 implement/tdd/code-review 恒不注册**（用户原话「带但不注册重叠件」，
//     A2 已核定清单：这三件与 ZCode 自身开发流程重叠，重复提供会给出两条互相竞争的流程）；
//   - dynamic-workflows（产品内置技能，非上游快照库）由动态工作流门独立控制，2×2 乘积态互不牵连。
//
// 断言走真实资产（apps/zcode-cli/packages/bundled-skills）+ 真实 NodeSkillAdapter：发现面与加载面
// 必须给出同一结论（禁用件在 loadSkill 也必须取不到）。名单以包内快照为身份真源，代码常量与快照
// 的漂移由本文件第一条用例守卫。

import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeSkillAdapter } from "@zcode/adapters/skills";
import type { SkillRoot } from "@zcode/contracts";
import {
  ASK_MATT_FLOW_OVERLAP_SKILL_NAMES,
  ASK_MATT_FLOW_PACK_SKILL_NAMES,
  collectAskMattFlowDisabledSkillPaths,
  resolveBundledSkillDisabledPaths,
} from "../src/app/ask-matt-flow-gate.js";

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

test("漂移守卫：登记名单常量与包内快照一一对应（升级快照必须同步两处）", async () => {
  assert.deepEqual(
    [...ASK_MATT_FLOW_PACK_SKILL_NAMES].sort(),
    await readSnapshotSkillNames(),
    "ASK_MATT_FLOW_PACK_SKILL_NAMES 必须与 skills/.zcode-skills-snapshot.json 逐项一致",
  );

  // 重叠件必须真实存在于包内（否则「带文件」前提不成立），且与包名单互不重复。
  const onDisk = (await readdir(skillsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
  for (const overlap of ASK_MATT_FLOW_OVERLAP_SKILL_NAMES) {
    assert.ok(onDisk.includes(overlap), `重叠件 ${overlap} 必须随包携带（带文件、不注册）`);
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
  // 判据与 A1 的 askMattFlowEntryVisible 同源：只有显式 true 才注册。
  assert.deepEqual(collectAskMattFlowDisabledSkillPaths([bundledRoot], undefined), [
    ...collectAskMattFlowDisabledSkillPaths([bundledRoot], false),
  ]);
});

test("开关打开：全库注册、重叠三件剔除，流程三技能可解析到 bundled 正文", async () => {
  const adapter = adapterWithDisabledPaths(
    collectAskMattFlowDisabledSkillPaths([bundledRoot], true),
  );
  const names = await discoverNames(adapter);

  const expected = [
    ...ASK_MATT_FLOW_PACK_SKILL_NAMES.filter(
      (name) => !ASK_MATT_FLOW_OVERLAP_SKILL_NAMES.includes(name),
    ),
    "dynamic-workflows",
  ].sort();
  assert.deepEqual(names, expected, "开关打开 = 全库注册（重叠件除外）+ 内置 dynamic-workflows");

  for (const overlap of ASK_MATT_FLOW_OVERLAP_SKILL_NAMES) {
    assert.ok(!names.includes(overlap), `重叠件 ${overlap} 在开态也不得注册（恒不注册）`);
    await assert.rejects(
      adapter.loadSkill({ name: overlap, roots: [bundledRoot], workingDirectory: repoRoot }),
      /Skill not found/,
      `重叠件 ${overlap} 的加载面必须与发现面一致：不可加载`,
    );
  }

  // 流程三命令的目标技能必须可解析到包内正文（面板「调起进技能」的注册前提）。
  for (const registered of ["grilling", "to-spec", "to-tickets"]) {
    const loaded = await adapter.loadSkill({
      name: registered,
      roots: [bundledRoot],
      workingDirectory: repoRoot,
    });
    assert.equal(loaded.metadata.name, registered);
    assert.ok(loaded.content.length > 0, `技能 ${registered} 的 bundled 正文不得为空`);
    assert.ok(loaded.metadata.path.startsWith(skillsRoot), `${registered} 必须解析到内置包路径`);
  }
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
      assert.equal(
        names.includes("grilling"),
        askMatt,
        `流程技能只随 ask-matt 门（askMatt=${askMatt}, dwf=${dynamicWorkflow}）`,
      );
      for (const overlap of ASK_MATT_FLOW_OVERLAP_SKILL_NAMES) {
        assert.ok(!names.includes(overlap), `重叠件在所有乘积格都不得注册：${overlap}`);
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
  for (const overlap of ASK_MATT_FLOW_OVERLAP_SKILL_NAMES) {
    assert.ok(
      combined.includes(join(skillsRoot, overlap, "SKILL.md")),
      `重叠件 ${overlap} 必须恒在禁用集`,
    );
  }
  assert.ok(
    !combined.includes(join(skillsRoot, "grilling", "SKILL.md")),
    "开态下流程技能不得被误伤",
  );
});
