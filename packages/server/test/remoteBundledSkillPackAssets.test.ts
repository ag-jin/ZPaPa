// 远端资产合同对内置技能包（apps/zcode-cli/packages/bundled-skills）的覆盖：卡 #203（A2 全库 bundled 入包）。
//
// 为什么这组用例承重：远端 agent 的运行形态是「zcode.cjs 旁原地读 packages/*」，内置技能包曾是这条链上
// 唯一没被 stage 的资产——开发态 SSH 部署只上传官方插件与 bundle，远端 agent 的 /workflow 会展开成
// 「先加载 dynamic-workflows 技能」而技能文件不存在。合同（本模块）与 stage 代码是两处平形清单，
// 历史上漏改会静默发出残缺远端。这里断言：
//
//   - 合同：远端必需路径里必须有内置技能包的必需资产，且每条都指向本地真实文件（不写幽灵路径）；
//   - stage：开发态 stage 真的把整库（含快照记录）复制进远端 packages/bundled-skills；
//   - 指纹：开发态部署指纹覆盖技能库内容（技能改动必须触发重部署，而不是复用旧远端）。

import assert from "node:assert/strict";
import test from "node:test";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME,
  REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS,
  buildRemoteAgentOfficialPluginRequiredPaths,
} from "@zcode/server/remote/zcodeAgentOfficialPluginAssets.js";
import {
  computeDevelopmentAgentAssetsSha256,
  stageDevelopmentAgentPackages,
} from "@zcode/server/remote/zcodeAgentDevDeploy.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../..");
const packagedCliRoot = join(repoRoot, "apps", "zcode-cli", "packages");
const packRoot = join(packagedCliRoot, "bundled-skills");
const snapshotFileName = ".zcode-skills-snapshot.json";
/** 产品内置技能（dynamic-workflows）不属于上游库快照。 */
const builtinSkillNames = ["dynamic-workflows"];

/** 与 bootstrap 的 BUNDLED_SKILL_PACK_REQUIRED_PATHS 同集合（独立字面量，交叉核对用）。 */
const expectedBundledSkillPackRequiredPaths = [
  "bundled-skills/skills/dynamic-workflows/SKILL.md",
  "bundled-skills/skills/dynamic-workflows/patterns.md",
  "bundled-skills/skills/dynamic-workflows/examples.md",
];

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("远端合同覆盖内置技能包：必需路径同集合且都指向本地真实资产", async () => {
  const remoteProviderDir = "/remote/provider";
  const requiredPaths = buildRemoteAgentOfficialPluginRequiredPaths(remoteProviderDir);
  const packagesPrefix = `${remoteProviderDir}/${REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME}/`;

  const bundledPackPaths = requiredPaths
    .filter((path) => path.includes(`${packagesPrefix}bundled-skills/`))
    .map((path) => path.slice(packagesPrefix.length))
    .sort();
  assert.deepEqual(
    bundledPackPaths,
    [...expectedBundledSkillPackRequiredPaths].sort(),
    "远端 packages 必需资产合同必须包含内置技能包的必需三件（与运行时/SEA 采集同集合）",
  );

  for (const relativePath of bundledPackPaths) {
    assert.ok(
      (REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS as readonly string[]).includes(
        relativePath,
      ),
      `${relativePath} 必须同时登记在相对路径清单（生产/开发两条链共用）`,
    );
    const localPath = join(packagedCliRoot, ...relativePath.split("/"));
    assert.ok(
      // 本地断言：合同里的路径必须真的存在，避免远端对着幽灵路径报缺失。
      await pathExists(localPath),
      `合同路径对应本地资产缺失：${localPath}`,
    );
  }
});

test("远端开发态 stage：整库复制到 packages/bundled-skills（含快照记录）", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-remote-agent-packages-"));
  try {
    const packagesDir = join(tempDir, REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME);
    await stageDevelopmentAgentPackages({ packagesDir, repoRoot });

    const stagedPackRoot = join(packagesDir, "bundled-skills");
    const record = JSON.parse(
      await readFile(join(packRoot, "skills", snapshotFileName), "utf8"),
    ) as { skills: string[] };
    for (const skillName of [...record.skills, ...builtinSkillNames]) {
      const stagedSkillFile = join(stagedPackRoot, "skills", skillName, "SKILL.md");
      assert.ok(await pathExists(stagedSkillFile), `远端 stage 缺少技能：${stagedSkillFile}`);
      assert.equal(
        await readFile(stagedSkillFile, "utf8"),
        await readFile(join(packRoot, "skills", skillName, "SKILL.md"), "utf8"),
        `远端 stage 的技能正文必须与源一致：${skillName}`,
      );
    }
    assert.equal(
      await readFile(join(stagedPackRoot, "skills", snapshotFileName), "utf8"),
      await readFile(join(packRoot, "skills", snapshotFileName), "utf8"),
      "远端 stage 必须带上快照记录（升级时按它对比上游）",
    );

    // 官方插件仍照旧 stage（本次改动不能顺手改掉插件链）。
    assert.ok(
      await pathExists(join(packagesDir, "browser-use-plugin", ".zcode-plugin", "plugin.json")),
      "官方插件 seed 资产必须仍被 stage",
    );
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("远端开发态部署指纹覆盖技能库：稳定且技能改动必改指纹", async () => {
  const fakeRepoRoot = await mkdtemp(join(tmpdir(), "zcode-remote-agent-hash-"));
  try {
    await cp(packRoot, join(fakeRepoRoot, "apps", "zcode-cli", "packages", "bundled-skills"), {
      recursive: true,
    });
    const bundlePath = join(
      fakeRepoRoot,
      "apps",
      "zcode-cli",
      "packages",
      "cli",
      "dist",
      "zcode.cjs",
    );
    await mkdir(dirname(bundlePath), { recursive: true });
    await writeFile(bundlePath, "// fake bundle\n", "utf8");
    await writeFakeBrowserUsePlugin(fakeRepoRoot);

    const first = await computeDevelopmentAgentAssetsSha256({
      localBundlePath: bundlePath,
      repoRoot: fakeRepoRoot,
    });
    const second = await computeDevelopmentAgentAssetsSha256({
      localBundlePath: bundlePath,
      repoRoot: fakeRepoRoot,
    });
    assert.equal(first, second, "同一份资产两次计算必须稳定（否则每次连接都重部署）");

    const skillFile = join(
      fakeRepoRoot,
      "apps",
      "zcode-cli",
      "packages",
      "bundled-skills",
      "skills",
      "ask-matt",
      "SKILL.md",
    );
    await writeFile(skillFile, `${await readFile(skillFile, "utf8")}\n<!-- mutation -->\n`);
    const mutated = await computeDevelopmentAgentAssetsSha256({
      localBundlePath: bundlePath,
      repoRoot: fakeRepoRoot,
    });
    assert.notEqual(mutated, first, "技能内容变化必须改变开发态指纹（否则远端复用旧技能包）");
  } finally {
    await rm(fakeRepoRoot, { force: true, recursive: true });
  }
});

/** 最小 browser-use 夹具：只满足远端合同声明的必需资产，避免整包 26MB 拷贝。 */
async function writeFakeBrowserUsePlugin(fakeRepoRoot: string): Promise<void> {
  const pluginRoot = join(fakeRepoRoot, "apps", "zcode-cli", "packages", "browser-use-plugin");
  const requiredPaths = REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS.filter(
    (relativePath) => relativePath.startsWith("browser-use-plugin/"),
  );
  for (const relativePath of requiredPaths) {
    const targetPath = join(pluginRoot, ...relativePath.split("/").slice(1));
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(
      targetPath,
      relativePath.endsWith("plugin.json")
        ? `${JSON.stringify({ name: "browser-use", version: "0.5.1" })}\n`
        : `// fixture: ${relativePath}\n`,
      "utf8",
    );
  }
  // 指纹哈希覆盖插件里的实际文件内容，空目录不影响；这里保证目录存在即可。
  await mkdir(join(pluginRoot, "dist"), { recursive: true });
}
