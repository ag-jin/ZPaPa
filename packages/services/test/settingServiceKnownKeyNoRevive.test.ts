import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSettingService } from "../src/setting/settingService.js";

/**
 * 【验证者补充（#177 二绿复验，2026-10-11）】已知键删除语义跨进程不复活。
 *
 * 卡文核对项：未知键保留（retainUnknownSettingsFields）不得顺带把「写方 schema 认识、
 * 但当前事实是缺席」的已知键从旧文件里回填回来。settingService 里最典型的是
 * providerFamilyConnectionSelections 的显式删除语义（legacy team 连接不完整时，
 * 普通保存必须保持该键缺席，不能把 schema 默认 {} 落盘）。
 *
 * 夹具：初始文件含 legacy 不完整的 modelProviderFamilySelectedKeys（2 段 key，无组织号），
 * 首次保存删除该键；随后用**真实子进程**（settingServiceCrossProcessWriter.ts）再写一次，
 * 断言该已知键在两个进程的连续整文件覆盖后仍未复活，且 legacy 回滚字段不受影响。
 */

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const WRITER_SCRIPT = fileURLToPath(
  new URL("./settingServiceCrossProcessWriter.ts", import.meta.url),
);

/** legacy 不完整 team-plan key（productId:projectId 两段，缺 organizationId）→ 触发删除语义。 */
const INCOMPLETE_LEGACY_KEY = "team-plan:builtin:zai-coding-plan:product-1:project-1";

function runChildWriter(home: string, patch: Record<string, unknown>): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", WRITER_SCRIPT, home, JSON.stringify(patch)],
      {
        cwd: PACKAGE_DIR,
        env: { ...process.env, ZCODE_DESKTOP_HOME_DIR: home },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`子进程写者退出码 ${code}\n${output}`));
      }
    });
  });
}

test("跨进程已知键删除语义：写方删除 providerFamilyConnectionSelections 后，另一进程写不复活该键", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-setting-known-key-no-revive-"));
  const previousDesktopHome = process.env.ZCODE_DESKTOP_HOME_DIR;
  process.env.ZCODE_DESKTOP_HOME_DIR = home;
  try {
    const settingsDir = join(home, ".zcode", "v2");
    await mkdir(settingsDir, { recursive: true });
    const settingsFile = join(settingsDir, "setting.json");
    await writeFile(
      settingsFile,
      JSON.stringify(
        {
          modelProviderFamilyModes: { zai: "codingPlan" },
          modelProviderFamilySelectedKeys: { zai: INCOMPLETE_LEGACY_KEY },
        },
        null,
        2,
      ),
    );

    // 进程 A（本进程）：普通保存必须删除 providerFamilyConnectionSelections（schema 默认 {} 不落盘）。
    await createSettingService().update({ memoryEnabled: true });
    const afterFirstWrite = JSON.parse(await readFile(settingsFile, "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(
      Object.hasOwn(afterFirstWrite, "providerFamilyConnectionSelections"),
      false,
      "首次写后已知键 providerFamilyConnectionSelections 必须保持缺席（删除语义）",
    );

    // 进程 B（真实子进程）：再写一次；删除语义不得被未知键保留机制反向回填。
    await runChildWriter(home, { locale: "en-US" });
    const afterSecondWrite = JSON.parse(await readFile(settingsFile, "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(
      Object.hasOwn(afterSecondWrite, "providerFamilyConnectionSelections"),
      false,
      "另一进程写后 providerFamilyConnectionSelections 不得复活",
    );
    assert.equal(afterSecondWrite.locale, "en-US");
    assert.equal(afterSecondWrite.memoryEnabled, true);
    assert.deepEqual(afterSecondWrite.modelProviderFamilyModes, { zai: "codingPlan" });
    assert.deepEqual(afterSecondWrite.modelProviderFamilySelectedKeys, {
      zai: INCOMPLETE_LEGACY_KEY,
    });
  } finally {
    if (previousDesktopHome === undefined) {
      delete process.env.ZCODE_DESKTOP_HOME_DIR;
    } else {
      process.env.ZCODE_DESKTOP_HOME_DIR = previousDesktopHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});
