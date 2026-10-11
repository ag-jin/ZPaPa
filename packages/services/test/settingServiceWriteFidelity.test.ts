import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSettingService } from "../src/setting/settingService.js";

/**
 * 卡 #177（63-1）P5：setting.json 跨进程写保真。
 *
 * 现场（`.zcode/board/evidence/debug-toggle/trace.md`，2026-10-10）：桌面端与 web dev 共用
 * `~/.zcode/v2/setting.json`，写盘是「以写方 schema 重读合并后整文件覆盖」（settingService
 * writeSettings）。写方 schema 不认识的既有键（另一进程新版本写入的实验开关）会被 parse 剥掉，
 * 于是每次保存都永久删除新键——日志里 71 次写、终态文件缺键。
 *
 * 夹具形态：文件里先放「其它 schema 进程写入、当前写方 schema 不认识」的键
 * （`experimentalAgentSquadsEnabled`/`squadMergeMode` 在 main 的 shared/services 里零命中），
 * 再经本进程的正常保存路径写盘，断言这些键仍在。这正是「旧 schema 进程写不回退新键」的最小再现。
 */

interface SettingsFixture {
  readonly home: string;
  readonly settingsFile: string;
}

async function withSettingsHome(
  initialSettings: Record<string, unknown>,
  run: (fixture: SettingsFixture) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "zcode-setting-write-fidelity-"));
  const previousDesktopHome = process.env.ZCODE_DESKTOP_HOME_DIR;
  process.env.ZCODE_DESKTOP_HOME_DIR = home;
  try {
    const settingsDir = join(home, ".zcode", "v2");
    await mkdir(settingsDir, { recursive: true });
    const settingsFile = join(settingsDir, "setting.json");
    await writeFile(settingsFile, JSON.stringify(initialSettings, null, 2));
    await run({ home, settingsFile });
  } finally {
    if (previousDesktopHome === undefined) {
      delete process.env.ZCODE_DESKTOP_HOME_DIR;
    } else {
      process.env.ZCODE_DESKTOP_HOME_DIR = previousDesktopHome;
    }
    await rm(home, { recursive: true, force: true });
  }
}

async function readSettingsFile(settingsFile: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(settingsFile, "utf8")) as Record<string, unknown>;
}

test("跨 schema 写保真：写方 schema 不认识的既有键在写盘后仍保留", async () => {
  await withSettingsHome(
    {
      localePreference: "zh-CN",
      experimentalAgentSquadsEnabled: true,
      squadMergeMode: "auto",
    },
    async ({ settingsFile }) => {
      const service = createSettingService();
      await service.update({ localePreference: "en-US" });

      const persisted = await readSettingsFile(settingsFile);
      assert.equal(persisted.localePreference, "en-US");
      assert.equal(persisted.experimentalAgentSquadsEnabled, true);
      assert.equal(persisted.squadMergeMode, "auto");
    },
  );
});

test("写保真边界：已知键非法值回落 schema 默认值，不回填文件旧值；同文件未知键保留", async () => {
  await withSettingsHome(
    {
      localePreference: "fr-FR",
      experimentalAgentSquadsEnabled: true,
    },
    async ({ settingsFile }) => {
      const service = createSettingService();
      await service.update({ memoryEnabled: true });

      const persisted = await readSettingsFile(settingsFile);
      // 未知键保留不能变成「把无法解析的已知键也一并搬回来」。
      assert.equal(persisted.localePreference, "system");
      assert.equal(persisted.memoryEnabled, true);
      assert.equal(persisted.experimentalAgentSquadsEnabled, true);
    },
  );
});

test("写保真边界：遗留回滚字段（legacy rollback）与未知键在同一次写盘里都保留", async () => {
  await withSettingsHome(
    {
      modelProviderFamilyModes: { zai: "apiKey", bigmodel: "apiKey" },
      modelProviderFamilySelectedKeys: { zai: "api-key:builtin:zai" },
      experimentalAgentSquadsEnabled: true,
    },
    async ({ settingsFile }) => {
      const service = createSettingService();
      await service.update({ locale: "en-US" });

      const persisted = await readSettingsFile(settingsFile);
      assert.deepEqual(persisted.modelProviderFamilyModes, { zai: "apiKey", bigmodel: "apiKey" });
      assert.deepEqual(persisted.modelProviderFamilySelectedKeys, { zai: "api-key:builtin:zai" });
      assert.equal(persisted.experimentalAgentSquadsEnabled, true);
    },
  );
});
