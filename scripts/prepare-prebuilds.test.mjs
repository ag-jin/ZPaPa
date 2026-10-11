// 远端 stage 形态的内置技能包断言：卡 #203（A2 全库 bundled 入包）。
//
// 为什么这组用例承重：远端 agent 跑的是 mock-cdn glm 组件里的 zcode.cjs，技能包由本脚本
// stageRemoteBundledSkillPack 落进 glm/<platform>/packages/bundled-skills（与桌面
// prepare-agent-node-bundle 同一份 stagedPath/topLevelPaths 语义）。这条链上的拷贝只整目录拷 skills/，
// 一旦 pack 里出现顶层新目录或必需资产被裁掉，远端会静默少技能——所以这里跑真实 stage 代码断言：
//
//   - 整库（mattpocock 全库 + 内置 dynamic-workflows + 快照记录）都落到 glm 目标目录，正文与源一致；
//   - 必需三件在 stage 结果里存在（脚本自身的 access 校验会失败即抛，这里显式复核）；
//   - 可重跑：同一目标目录再 stage 一次仍完整（构建重跑不产生半包）。
//
// 运行：node --test scripts/prepare-prebuilds.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageRemoteBundledSkillPack } from "./prepare-prebuilds.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const packRoot = join(rootDir, "apps", "zcode-cli", "packages", "bundled-skills");
const snapshotFileName = ".zcode-skills-snapshot.json";
/** 产品内置技能（dynamic-workflows）不属于上游库快照。 */
const builtinSkillNames = ["dynamic-workflows"];
/** 与运行时 / SEA 采集 / 远端合同同集合的必需三件。 */
const requiredRelativePaths = [
  "skills/dynamic-workflows/SKILL.md",
  "skills/dynamic-workflows/patterns.md",
  "skills/dynamic-workflows/examples.md",
];

test("远端 stage：整库技能落到 glm/*/packages/bundled-skills（含快照记录，可重跑）", async () => {
  const glmDir = await mkdtemp(join(tmpdir(), "zcode-glm-stage-"));
  try {
    const record = JSON.parse(await readFile(join(packRoot, "skills", snapshotFileName), "utf8"));
    assert.ok(record.skills.length > 0, "快照记录必须声明技能清单");

    await stageRemoteBundledSkillPack(glmDir);
    // 重跑一次：构建重跑（CI 复用同一 glm 目录）不得产生半包。
    await stageRemoteBundledSkillPack(glmDir);

    const stagedPackRoot = join(glmDir, "packages", "bundled-skills");
    for (const skillName of [...record.skills, ...builtinSkillNames]) {
      const stagedSkillFile = join(stagedPackRoot, "skills", skillName, "SKILL.md");
      assert.ok(existsSync(stagedSkillFile), `远端 stage 缺少技能：${skillName}`);
      assert.equal(
        (await stat(stagedSkillFile)).size,
        (await stat(join(packRoot, "skills", skillName, "SKILL.md"))).size,
        `远端 stage 的技能正文大小应与源一致：${skillName}`,
      );
    }
    assert.ok(
      existsSync(join(stagedPackRoot, "skills", snapshotFileName)),
      "远端 stage 必须带上快照记录（升级时按它对比上游 diff）",
    );
    for (const relativePath of requiredRelativePaths) {
      assert.ok(
        existsSync(join(stagedPackRoot, ...relativePath.split("/"))),
        `远端 stage 缺少必需资产：${relativePath}`,
      );
    }
  } finally {
    await rm(glmDir, { force: true, recursive: true });
  }
});
