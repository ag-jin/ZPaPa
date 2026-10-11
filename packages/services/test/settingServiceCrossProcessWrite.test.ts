import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSettingService } from "../src/setting/settingService.js";

/**
 * 卡 #177（63-1）跨进程写竞态夹具：setting.json 被多进程共享（桌面端 / web dev / 其它构建），
 * 各进程写盘是「以写方 schema 重读合并后整文件覆盖」，没有跨进程锁（last-writer-wins）。
 *
 * 这里用**真实子进程**跑真实 settingService（不是同进程模拟）：
 *  - 顺序写：子进程写后主进程再写，写方 schema 不认识的既有键必须活着穿过两次覆盖；
 *  - 并发竞态：两条写链同时落盘，未知键不得被任一方擦掉，文件不得撕裂（仍可解析）。
 * 现场依据：`.zcode/board/evidence/debug-toggle/trace.md`（71 次写、终态文件缺键）。
 */

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const WRITER_SCRIPT = fileURLToPath(
  new URL("./settingServiceCrossProcessWriter.ts", import.meta.url),
);
/** 其它 schema 进程写入、当前写方 schema 不认识的键（main 的 shared/services 零命中）。 */
const FOREIGN_KEY = "experimentalAgentSquadsEnabled";

async function withSharedSettingsHome(
  initialSettings: Record<string, unknown>,
  run: (fixture: { readonly home: string; readonly settingsFile: string }) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "zcode-setting-cross-process-"));
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

async function readSettingsFile(settingsFile: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(settingsFile, "utf8")) as Record<string, unknown>;
}

test("跨进程顺序写：子进程写后主进程再写，未知键与两次写的已知键都保留", async () => {
  await withSharedSettingsHome({ [FOREIGN_KEY]: true }, async ({ home, settingsFile }) => {
    await runChildWriter(home, { locale: "en-US" });
    await createSettingService().update({ memoryEnabled: true });

    const persisted = await readSettingsFile(settingsFile);
    assert.equal(persisted[FOREIGN_KEY], true);
    assert.equal(persisted.locale, "en-US");
    assert.equal(persisted.memoryEnabled, true);
  });
});

test("跨进程并发写竞态：未知键在并发写后仍保留，文件保持可解析", async () => {
  await withSharedSettingsHome({ [FOREIGN_KEY]: true }, async ({ home, settingsFile }) => {
    const childWrite = runChildWriter(home, { localePreference: "en-US" });
    const parentWrite = createSettingService().update({ memoryEnabled: true });
    await Promise.all([childWrite, parentWrite]);

    // last-writer-wins 下两条已知写谁最后落盘不确定；未知键是两条写链都必须带过覆盖的既有事实。
    const persisted = await readSettingsFile(settingsFile);
    assert.equal(persisted[FOREIGN_KEY], true);
  });
});
