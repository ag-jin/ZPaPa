// 内置技能包（apps/zcode-cli/packages/bundled-skills）的构建级断言：卡 #203（A2 全库 bundled 入包）。
//
// 为什么这组用例承重：apt-matt 全库（mattpocock/skills，MIT）随包分发，运行形态有三条互相不重叠的
// 解析路径——① 文件系统原地读（桌面/远端 stage：入口旁 packages/bundled-skills）；② SEA 二进制按内容
// hash 解压（<cli storage>/bundled-skills/<hash>/）；③ 打包清单（运行时必需路径 / SEA 采集 / 桌面 stage /
// 远端 stage）。三条路径各自维护清单，历史上「漏改一处」会直接挂 build 或发出半包技能，所以这里逐形态
// 断言「技能文件可枚举 + 可加载」，而不是只断言某个常量：
//
//   - 形态①：resolveBundledSkillRoots 在入口旁布局下解析到包，NodeSkillAdapter 枚举/加载全库技能；
//   - 形态②：collectSeaBundledSkillAssets 收全库 → 用真实读取器（fake node:sea 只提供 sea 边界）
//            按 hash 解压 → 与形态①同一技能集合；
//   - 清单：运行时必需路径 === SEA 采集必需路径，且 pack 顶层只有 skills/（桌面/远端整目录拷贝的完整性前提）。
//
// 反例（突变）必咬：必需资产缺失拒绝收包、技能正文变化必改 manifest hash、资产 sha 不符不落半包。

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeSkillAdapter } from "@zcode/adapters/skills";
import {
  BUNDLED_SKILL_PACK_REQUIRED_PATHS,
  resolveBundledSkillRoots,
} from "../src/app/bundled-skills.js";
import {
  bundledSkillPackRequiredPaths,
  collectSeaBundledSkillAssets,
} from "../../cli/scripts/sea-bundled-skill-assets.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../../../..");
const packRoot = join(repoRoot, "apps", "zcode-cli", "packages", "bundled-skills");
const skillsRoot = join(packRoot, "skills");
/** 快照记录放在 skills/ 内：桌面/远端 stage 与 SEA 采集都是整目录收/拷，记录随资产一起走。 */
const snapshotFileName = ".zcode-skills-snapshot.json";
const snapshotPath = join(skillsRoot, snapshotFileName);
/** 产品内置技能（dynamic-workflows）不属于上游库快照，单独列出。 */
const builtinSkillNames = ["dynamic-workflows"];

interface SkillsSnapshotRecord {
  capturedAt: string;
  contentSha256: string;
  license: string;
  skills: string[];
  source: string;
  version: 1;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listDirectoryNames(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

async function walkFiles(relativeTo: string, directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    // 与 SEA 采集同一口径：只排除 .DS_Store（快照记录是 dot 文件，必须随包走）。
    if (entry.name === ".DS_Store") continue;
    const fullPath = join(directory, entry.name);
    const relativePath = join(relativeTo, entry.name).split("\\").join("/");
    if (entry.isDirectory()) {
      found.push(...(await walkFiles(relativePath, fullPath)));
      continue;
    }
    if (entry.isFile()) found.push(relativePath);
  }
  return found.sort();
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function readSnapshot(): Promise<SkillsSnapshotRecord> {
  return JSON.parse(await readFile(snapshotPath, "utf8")) as SkillsSnapshotRecord;
}

/** 与快照记录同一算法：库内每个文件 `${相对 skills/ 的路径}\n${sha256}\n` 按路径排序拼接。 */
async function computeLibraryDigest(skillNames: readonly string[]): Promise<string> {
  const lines: string[] = [];
  for (const skillName of skillNames) {
    for (const relativePath of await walkFiles(skillName, join(skillsRoot, skillName))) {
      lines.push(`${relativePath}\n${await sha256File(join(skillsRoot, relativePath))}\n`);
    }
  }
  lines.sort();
  return createHash("sha256").update(lines.join("")).digest("hex");
}

async function withStagedSkillPack<T>(task: (stagedRoot: string) => Promise<T>): Promise<T> {
  const stagedRoot = await mkdtemp(join(tmpdir(), "zcode-bundled-skills-stage-"));
  try {
    // 桌面与远端 stage 的落点同形：<zcode.cjs 所在目录>/packages/bundled-skills（prepare-agent-node-bundle
    // 与 prepare-prebuilds 的 stagedPath）。
    await cp(packRoot, join(stagedRoot, "packages", "bundled-skills"), { recursive: true });
    await writeFile(join(stagedRoot, "zcode.cjs"), "// entry placeholder\n", "utf8");
    return await task(stagedRoot);
  } finally {
    await rm(stagedRoot, { force: true, recursive: true });
  }
}

/** 只在一次解析内替换入口路径（桌面/远端布局按入口目录解析），退出时恢复。 */
async function withEntrypoint<T>(entryPath: string, task: () => Promise<T>): Promise<T> {
  const originalArgv1 = process.argv[1];
  process.argv[1] = entryPath;
  try {
    return await task();
  } finally {
    if (originalArgv1 === undefined) delete process.argv[1];
    else process.argv[1] = originalArgv1;
  }
}

async function discoverSkillNames(skillsDirectory: string): Promise<string[]> {
  const adapter = new NodeSkillAdapter();
  const outcome = await adapter.discoverSkills({
    roots: [
      {
        path: skillsDirectory,
        priority: 1_000_000,
        scope: "system",
        source: "bundled",
      },
    ],
    workingDirectory: repoRoot,
  });
  assert.deepEqual(
    outcome.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
    `内置技能包不应有错误级诊断：${JSON.stringify(outcome.diagnostics)}`,
  );
  return outcome.skills.map((skill) => skill.name);
}

test("技能包携带快照记录声明的全库技能，记录与磁盘一一对应", async () => {
  const record = await readSnapshot();
  assert.equal(record.version, 1);
  assert.equal(record.source, "https://github.com/mattpocock/skills");
  assert.equal(record.license, "MIT");

  const onDisk = (await listDirectoryNames(skillsRoot)).filter(
    (name) => !builtinSkillNames.includes(name),
  );
  assert.deepEqual([...record.skills].sort(), onDisk, "快照记录的技能列表必须与磁盘目录一一对应");

  // 卡文点名的流程技能必须在（全库入包的验收面）。
  for (const required of [
    "ask-matt",
    "code-review",
    "codebase-design",
    "domain-modeling",
    "grill-with-docs",
    "grilling",
    "handoff",
    "implement",
    "tdd",
    "to-spec",
    "to-tickets",
  ]) {
    assert.ok(record.skills.includes(required), `快照应包含 ${required}`);
  }

  for (const skillName of record.skills) {
    assert.ok(
      await pathExists(join(skillsRoot, skillName, "SKILL.md")),
      `${skillName} 缺少 SKILL.md`,
    );
  }

  // 记录的 contentSha256 是升级时对比上游 diff 的身份；与磁盘不符即记录失效。
  assert.equal(
    record.contentSha256,
    await computeLibraryDigest(record.skills),
    "快照记录的 contentSha256 必须与包内技能文件一致",
  );
});

test("形态一（桌面/远端 stage：入口旁原地读）：全库技能可枚举可加载", async () => {
  await withStagedSkillPack(async (stagedRoot) => {
    const roots = await withEntrypoint(join(stagedRoot, "zcode.cjs"), () =>
      resolveBundledSkillRoots({ cliStorageRoot: join(stagedRoot, "storage") }),
    );
    assert.equal(roots.length, 1, "入口旁 packages/bundled-skills 必须解析出唯一技能根");
    const [root] = roots;
    assert.equal(root?.path, join(stagedRoot, "packages", "bundled-skills", "skills"));
    assert.equal(root?.scope, "system");
    assert.equal(root?.source, "bundled");

    const record = await readSnapshot();
    assert.deepEqual(
      await discoverSkillNames(root!.path),
      [...record.skills, ...builtinSkillNames].sort(),
      "形态一必须枚举出全库技能 + 内置 dynamic-workflows",
    );

    const adapter = new NodeSkillAdapter();
    const loaded = await adapter.loadSkill({
      name: "grilling",
      roots,
      workingDirectory: repoRoot,
    });
    assert.equal(loaded.metadata.name, "grilling");
    assert.ok(loaded.content.length > 0, "加载出的技能正文不能为空");
    assert.equal(loaded.truncated, false);
  });
});

test("形态二（SEA：按内容 hash 解压）：资产收全库且解压后与原地形态同集合", async () => {
  const stagingDirectory = await mkdtemp(join(tmpdir(), "zcode-sea-skill-assets-"));
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-sea-skill-storage-"));
  try {
    // 采集面：与 build-sea 同一入口（root = apps/zcode-cli）。
    const { assets, manifest } = await collectSeaBundledSkillAssets({
      root: join(repoRoot, "apps", "zcode-cli"),
      stagingDirectory,
    });
    const expectedFiles = await walkFiles("skills", skillsRoot);
    assert.deepEqual(
      manifest.files.map((file: { path: string }) => file.path).sort(),
      expectedFiles,
      "SEA 清单必须收全 skills/ 下每个文件（不是只收必需三件）",
    );
    for (const file of expectedFiles) {
      const assetKey = `zcode-bundled-skills/${file}`;
      assert.ok(assets[assetKey], `资产缺少 ${assetKey}`);
      assert.equal(
        (await stat(assets[assetKey])).size,
        (await stat(join(packRoot, file))).size,
        `${assetKey} 大小应与源文件一致`,
      );
    }

    // 读取面：只替换 node:sea 边界，解压/校验/marker 全走真实读取器。
    const originalGetBuiltinModule = process.getBuiltinModule;
    const fakeSea = {
      getAsset: (key: string) => {
        if (key !== "zcode-bundled-skills/manifest.json") throw new Error(`unknown asset: ${key}`);
        return JSON.stringify(manifest);
      },
      getRawAsset: (key: string) => readFileSyncFrom(assets, key),
      isSea: () => true,
    };
    process.getBuiltinModule = ((id: string) =>
      id === "node:sea" ? fakeSea : originalGetBuiltinModule.call(process, id)) as typeof process.getBuiltinModule;
    try {
      const roots = await resolveBundledSkillRoots({ cliStorageRoot: storageRoot });
      assert.equal(roots.length, 1, "SEA 形态必须解析出技能根");
      assert.equal(
        roots[0]?.path,
        join(storageRoot, "bundled-skills", manifest.hash, "skills"),
        "SEA 形态的技能根必须是按内容 hash 解压出来的目录",
      );

      const record = await readSnapshot();
      assert.deepEqual(
        await discoverSkillNames(roots[0]!.path),
        [...record.skills, ...builtinSkillNames].sort(),
        "SEA 形态必须与原地形态枚举出同一技能集合",
      );
      assert.equal(
        await readFile(join(roots[0]!.path, snapshotFileName), "utf8"),
        await readFile(snapshotPath, "utf8"),
        "快照记录必须随 SEA 资产一起解压",
      );
    } finally {
      process.getBuiltinModule = originalGetBuiltinModule;
    }
  } finally {
    await rm(stagingDirectory, { force: true, recursive: true });
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test("反例：SEA 采集缺必需资产即拒绝收包", async () => {
  const fakeCliRoot = await mkdtemp(join(tmpdir(), "zcode-sea-pack-missing-"));
  try {
    await cp(packRoot, join(fakeCliRoot, "packages", "bundled-skills"), { recursive: true });
    await rm(join(fakeCliRoot, "packages", "bundled-skills", "skills", "dynamic-workflows", "patterns.md"));
    await assert.rejects(
      () =>
        collectSeaBundledSkillAssets({
          root: fakeCliRoot,
          stagingDirectory: join(fakeCliRoot, "staging"),
        }),
      /Missing bundled skill pack required asset/,
    );
  } finally {
    await rm(fakeCliRoot, { force: true, recursive: true });
  }
});

test("反例：技能正文变化必改 SEA manifest hash（收包范围覆盖全库）", async () => {
  const fakeCliRoot = await mkdtemp(join(tmpdir(), "zcode-sea-pack-mutation-"));
  try {
    await cp(packRoot, join(fakeCliRoot, "packages", "bundled-skills"), { recursive: true });
    const first = await collectSeaBundledSkillAssets({
      root: fakeCliRoot,
      stagingDirectory: join(fakeCliRoot, "staging-1"),
    });
    const skillFile = join(fakeCliRoot, "packages", "bundled-skills", "skills", "tdd", "SKILL.md");
    await writeFile(skillFile, `${await readFile(skillFile, "utf8")}\n<!-- mutation -->\n`);
    const second = await collectSeaBundledSkillAssets({
      root: fakeCliRoot,
      stagingDirectory: join(fakeCliRoot, "staging-2"),
    });
    assert.notEqual(
      first.manifest.hash,
      second.manifest.hash,
      "库内技能正文变化必须改变 manifest hash（否则升级后二进制仍复用旧包）",
    );
  } finally {
    await rm(fakeCliRoot, { force: true, recursive: true });
  }
});

test("反例：SEA 资产 sha 不符时不落半包", async () => {
  const stagingDirectory = await mkdtemp(join(tmpdir(), "zcode-sea-skill-tampered-"));
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-sea-skill-tampered-storage-"));
  try {
    const { assets, manifest } = await collectSeaBundledSkillAssets({
      root: join(repoRoot, "apps", "zcode-cli"),
      stagingDirectory,
    });
    const tamperedManifest = {
      ...manifest,
      files: manifest.files.map((file: { path: string; sha256: string }, index: number) =>
        index === 0 ? { ...file, sha256: "0".repeat(64) } : file,
      ),
    };

    const originalGetBuiltinModule = process.getBuiltinModule;
    const fakeSea = {
      getAsset: (key: string) => {
        if (key !== "zcode-bundled-skills/manifest.json") throw new Error(`unknown asset: ${key}`);
        return JSON.stringify(tamperedManifest);
      },
      getRawAsset: (key: string) => readFileSyncFrom(assets, key),
      isSea: () => true,
    };
    process.getBuiltinModule = ((id: string) =>
      id === "node:sea" ? fakeSea : originalGetBuiltinModule.call(process, id)) as typeof process.getBuiltinModule;
    try {
      const roots = await resolveBundledSkillRoots({ cliStorageRoot: storageRoot });
      for (const root of roots) {
        assert.ok(
          !root.path.startsWith(storageRoot),
          `sha 不符时不得使用半包：${root.path}`,
        );
      }
      assert.equal(
        await pathExists(join(storageRoot, "bundled-skills", manifest.hash)),
        false,
        "sha 不符的临时目录必须被清理，不能留下半包目录",
      );
    } finally {
      process.getBuiltinModule = originalGetBuiltinModule;
    }
  } finally {
    await rm(stagingDirectory, { force: true, recursive: true });
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test("清单一致性：运行时必需路径 === SEA 采集必需路径，且 pack 顶层只有 skills/", async () => {
  assert.deepEqual(
    [...bundledSkillPackRequiredPaths].sort(),
    [...BUNDLED_SKILL_PACK_REQUIRED_PATHS].sort(),
    "运行时必需路径与 SEA 采集必需路径必须同集合（漏改一处即发出残包）",
  );
  for (const requiredPath of BUNDLED_SKILL_PACK_REQUIRED_PATHS) {
    assert.ok(
      await pathExists(join(packRoot, ...requiredPath.split("/"))),
      `必需资产缺失：${requiredPath}`,
    );
  }

  // 桌面 prepare-agent-node-bundle 与 scripts/prepare-prebuilds 都只整目录拷贝 topLevelPaths: ["skills"]。
  // pack 顶层多出别的东西就会被这两处静默丢掉 —— 所以「全部资产都在 skills/ 下」是清单同步的前提。
  const topLevel = (await readdir(packRoot, { withFileTypes: true }))
    .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(topLevel, ["skills"], "内置技能包顶层只允许 skills/，否则桌面/远端 stage 会漏拷");
});

/** 从 SEA 采集返回的 assets 映射里取原始字节（真实读取器走的就是 getRawAsset）。 */
function readFileSyncFrom(assets: Record<string, string>, key: string): Buffer {
  const sourcePath = assets[key];
  if (!sourcePath) throw new Error(`unknown asset: ${key}`);
  return readFileSync(sourcePath);
}
