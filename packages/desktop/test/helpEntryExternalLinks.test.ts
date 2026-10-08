import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DesktopCommandIds,
  ZPAPA_COMMUNITY_URL,
  ZPAPA_ISSUE_NEW_URL,
  type Locale,
} from "@zcode/shared";

/**
 * 帮助菜单「问题上报 / 用户社群」在 desktop 主进程的最终落点。
 *
 * 两个入口在 UI（工作区帮助菜单）与原生菜单/命令面板都汇总到
 * `executeDesktopCommand`，最终只在 main 里 `shell.openExternal` 一次：
 * 必须硬指 ZPaPa GitHub 仓库，不再读远端/本地 config 的 feedback_url / community_urls。
 * 这里对真实 desktopCommandHandlers 行为断言（electron 用 registerHooks 就地替换）。
 */

const testDir = dirname(fileURLToPath(import.meta.url));

/** shell.openExternal 的调用记录，用例之间清空。 */
const opened: string[] = [];

const electronStub = {
  app: {
    isPackaged: true,
    getAppPath: () => testDir,
    getVersion: () => "0.0.0-test",
    on() {},
    relaunch() {},
    exit() {},
  },
  BrowserWindow: {
    getAllWindows: () => [],
    getFocusedWindow: () => null,
  },
  dialog: {
    showMessageBox: async () => ({ response: 0 }),
    showMessageBoxSync: () => 0,
  },
  session: {
    fromPartition: () => ({ clearStorageData: async () => {} }),
  },
  shell: {
    openExternal: (url: string) => {
      opened.push(url);
      return Promise.resolve();
    },
  },
  ipcMain: { handle() {}, on() {} },
  Menu: { getApplicationMenu: () => null, buildFromTemplate: () => ({}) },
  nativeTheme: { shouldUseDarkColors: false, on() {} },
  webContents: { getAllWebContents: () => [] },
};

const globalScope = globalThis as unknown as { __zcodeElectronStub?: unknown };
globalScope.__zcodeElectronStub = electronStub;

const STUBS: Record<string, string> = {
  "stub:electron": `
const stub = globalThis.__zcodeElectronStub;
export const app = stub.app;
export const BrowserWindow = stub.BrowserWindow;
export const dialog = stub.dialog;
export const session = stub.session;
export const shell = stub.shell;
export const ipcMain = stub.ipcMain;
export const Menu = stub.Menu;
export const nativeTheme = stub.nativeTheme;
export const webContents = stub.webContents;
export default stub;
`,
  "stub:logger": `
export const logger = { info() {}, warn() {}, error() {}, debug() {} };
`,
  // desktopCommandHandlers 经 ./autoUpdater.js 拉进 electron-updater；
  // 这个用例不测更新器，按既有测试的桩法替换掉。
  "stub:electron-updater": `
const autoUpdater = {
  on() {},
  checkForUpdates: async () => null,
  downloadUpdate: async () => null,
  quitAndInstall() {},
  setFeedURL() {},
};
export class CancellationToken {
  cancelled = false;
  cancel() { this.cancelled = true; }
  dispose() {}
}
export default { autoUpdater };
`,
};

nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "electron") {
      return { url: "stub:electron", shortCircuit: true };
    }
    if (specifier === "electron-updater") {
      return { url: "stub:electron-updater", shortCircuit: true };
    }
    if (specifier === "./logger.js") {
      return { url: "stub:logger", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = STUBS[url];
    if (source) {
      return { format: "module", shortCircuit: true, source };
    }
    return nextLoad(url, context);
  },
});

const handlersModulePromise = import("../src/main/desktopCommandHandlers.ts");

function createCommandOptions(command: (typeof DesktopCommandIds)[keyof typeof DesktopCommandIds]) {
  const warnings: unknown[][] = [];
  return {
    command,
    logger: {
      info() {},
      warn(...args: unknown[]) {
        warnings.push(args);
      },
      error() {},
    },
    updateZCodeStdioTapDevMenuState() {},
    onZCodeEndpointChanged() {},
    onRelaunchApp: async () => {},
    settingService: {
      get: async () => ({}),
      update: async () => {},
    },
    credentialsDir: testDir,
    currentApplicationLocale: "zh-CN" as Locale,
    warnings,
  };
}

test("OpenFeedback：主进程外开 GitHub 新建 issue（不经内置反馈弹窗/config）", async () => {
  const { executeDesktopCommand } = await handlersModulePromise;
  opened.length = 0;
  const options = createCommandOptions(DesktopCommandIds.OpenFeedback);
  await executeDesktopCommand(options);
  assert.deepEqual(opened, [ZPAPA_ISSUE_NEW_URL]);
  assert.equal(ZPAPA_ISSUE_NEW_URL, "https://github.com/ag-jin/ZPaPa/issues/new");
  assert.deepEqual(options.warnings, [], "目标已硬指 GitHub，不应再有 config 缺失告警");
});

test("OpenCommunity：主进程外开 GitHub Discussions（不再按语言解析 community_urls）", async () => {
  const { executeDesktopCommand } = await handlersModulePromise;
  opened.length = 0;
  const options = createCommandOptions(DesktopCommandIds.OpenCommunity);
  options.currentApplicationLocale = "en-US" as Locale;
  await executeDesktopCommand(options);
  assert.deepEqual(opened, [ZPAPA_COMMUNITY_URL]);
  assert.equal(ZPAPA_COMMUNITY_URL, "https://github.com/ag-jin/ZPaPa/discussions");
  assert.deepEqual(options.warnings, [], "目标已硬指 GitHub，不应再有 config 缺失告警");
});
