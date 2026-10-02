import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * T2 的证据（验收本体见 docs/superpowers/plans/2026-10-02-preview-update-channel.md 第四、五节）。
 *
 * 要拦的缺陷都是「静态可见 + 拨了不生效」这一类：
 *  - 开关拨了，`allowPrerelease`/`channel` 没重设 ⇒ 界面变了、过滤没变，须重启（缺口 A）；
 *  - 切通道清缓存漏项 ⇒ 旧通道版本被标成新通道；
 *  - 冷启动 provider 未 await 完就检查 ⇒ 首次检查用默认值。
 *
 * 因为 autoUpdater.ts 顶层 import electron 具名导出（纯 Node 下 `electron` 只解析成路径字符串），
 * 直接 import 会失败。这里按仓库既有做法用 `module.registerHooks`（同步钩子，无需额外 CLI flag）
 * 就地替换 electron / electron-updater / logger / manifestUpdateProvider，从而能对
 * **真实的 autoUpdater.ts 行为**做断言，而不只是读源码文本。
 * 另有一小组源码接线守卫（与 schedulerWiring.test.ts 同源），用于钉住无法从外部观测的
 * 模块内私有缓存（readyUpdateVersion / availableUpdateChannel）。
 */

const testDir = dirname(fileURLToPath(import.meta.url));
const autoUpdaterSourcePath = resolve(testDir, "../src/main/autoUpdater.ts");

// 非 darwin：跳过 initAutoUpdater 里的 codesign 探测（T2 不涉及 mac DR 回退），
// 也让 shouldUseInAppAutoUpdate 走「非 darwin ⇒ true」的稳定分支。
Object.defineProperty(process, "platform", { value: "win32", configurable: true });

/* ----------------------------- 模块桩（hooks） ----------------------------- */

type RecordedCalls = string[];

const calls: RecordedCalls = [];

type FakeUpdater = {
  _allowPrerelease: boolean;
  _channel: string | null;
  allowPrerelease: boolean;
  channel: string | null;
  setFeedURL: (options: unknown) => void;
  checkForUpdates: () => Promise<unknown>;
  on: (...args: unknown[]) => void;
  autoDownload?: boolean;
  autoInstallOnAppQuit?: boolean;
  logger?: unknown;
};

// 「下一次 checkForUpdates 挂起」开关：用来复现「检查在飞时拨开关」。
let pendingCheckMode = false;
let resolvePendingCheck: (() => void) | null = null;

const fakeUpdater: FakeUpdater = {
  _allowPrerelease: false,
  _channel: null,
  get allowPrerelease(): boolean {
    return this._allowPrerelease;
  },
  set allowPrerelease(value: boolean) {
    this._allowPrerelease = value;
    calls.push(`allowPrerelease=${value}`);
  },
  get channel(): string | null {
    return this._channel;
  },
  set channel(value: string | null) {
    this._channel = value;
    calls.push(`channel=${value}`);
  },
  setFeedURL() {
    calls.push("setFeedURL");
  },
  checkForUpdates() {
    calls.push("checkForUpdates");
    if (pendingCheckMode) {
      pendingCheckMode = false;
      return new Promise((resolvePending) => {
        resolvePendingCheck = () => resolvePending(null);
      });
    }
    return Promise.resolve(null);
  },
  on() {
    // initAutoUpdater 注册事件监听；本文件的用例不 emit 事件。
  },
};

const electronStub = {
  app: {
    isPackaged: true,
    getVersion: () => "3.16.3",
    on() {},
    relaunch() {},
    exit() {},
    whenReady: () => Promise.resolve(),
  },
  BrowserWindow: {
    getAllWindows: () => [],
    getFocusedWindow: () => null,
  },
  ipcMain: {
    handle() {},
    on() {},
  },
  Menu: { getApplicationMenu: () => null, buildFromTemplate: () => ({}) },
  shell: { openExternal: () => Promise.resolve() },
};

const globalScope = globalThis as unknown as {
  __zcodeFakeUpdaterModule?: unknown;
  __zcodeElectronStub?: unknown;
};
globalScope.__zcodeFakeUpdaterModule = { autoUpdater: fakeUpdater };
globalScope.__zcodeElectronStub = electronStub;

const STUBS: Record<string, string> = {
  "stub:electron": `
const stub = globalThis.__zcodeElectronStub;
export const app = stub.app;
export const BrowserWindow = stub.BrowserWindow;
export const ipcMain = stub.ipcMain;
export const Menu = stub.Menu;
export const shell = stub.shell;
export default stub;
`,
  "stub:electron-updater": `
export default globalThis.__zcodeFakeUpdaterModule;
export class CancellationToken {}
`,
  "stub:logger": `
export const logger = { info() {}, warn() {}, error() {}, debug() {} };
`,
  "stub:manifest": `
export function getElectronReleasePlatform() { return "mac"; }
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
    if (specifier === "./manifestUpdateProvider.js") {
      return { url: "stub:manifest", shortCircuit: true };
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

const autoUpdaterModulePromise = import("../src/main/autoUpdater.ts");

/* --------------------------------- 辅助 --------------------------------- */

const flush = () => new Promise<void>((resolveFlush) => setImmediate(resolveFlush));

function resetFake(): void {
  fakeUpdater._allowPrerelease = false;
  fakeUpdater._channel = null;
  pendingCheckMode = false;
  resolvePendingCheck = null;
  calls.length = 0;
}

function createSettingService(
  initial: Record<string, unknown>,
  options?: { deferFirstGet?: boolean },
) {
  const state: Record<string, unknown> = {
    receivePreviewUpdates: false,
    autoDownloadAndInstallUpdates: false,
    ...initial,
  };
  const updates: Array<Record<string, unknown>> = [];
  let getCount = 0;
  return {
    state,
    updates,
    async get() {
      getCount += 1;
      if (options?.deferFirstGet && getCount === 1) {
        // 首次读设置跨一个宏任务返回：用来把「先应用配置、再检查」的死活摊开 ——
        // 少一个 await 时，首次 checkForUpdates 会抢在这次读之前。
        await new Promise((resolveGet) => setImmediate(resolveGet));
      }
      return { ...state };
    },
    async update(patch: unknown) {
      updates.push(patch as Record<string, unknown>);
      Object.assign(state, patch as Record<string, unknown>);
    },
  };
}

/** 取源码里一个顶层函数（从签名到下一个顶层 function/export function）的文本块。 */
function readTopLevelBlock(source: string, startMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `源码里找不到 ${startMarker}`);
  const rest = source.slice(start + startMarker.length);
  const nextIndex = rest.search(/\n(export )?(async )?function /);
  return nextIndex >= 0 ? rest.slice(0, nextIndex) : rest;
}

/* --------------------------------- 用例 --------------------------------- */

test("S1｜拨开关即时通道：allowPrerelease 与 channel 成对改变（删掉重设 ⇒ 必红）", async () => {
  const { initAutoUpdater, refreshAutoUpdaterReleaseChannel } = await autoUpdaterModulePromise;
  resetFake();
  const settingService = createSettingService({ receivePreviewUpdates: false });

  await initAutoUpdater({ settingService: settingService as never });
  await flush();
  // 冷启动稳定通道：初始化即配置好，明确不允 prerelease、channel 回默认。
  assert.equal(fakeUpdater.allowPrerelease, false);
  assert.equal(fakeUpdater.channel, null);

  refreshAutoUpdaterReleaseChannel(true, "test toggle on");
  await flush();
  assert.equal(fakeUpdater.allowPrerelease, true, "开启后必须允许 prerelease（否则收不到预览版）");
  assert.equal(
    fakeUpdater.channel,
    "preview",
    "开启后 channel 必须是 preview（否则 dev 预发布会毒死通道）",
  );

  refreshAutoUpdaterReleaseChannel(false, "test toggle off");
  await flush();
  assert.equal(fakeUpdater.allowPrerelease, false, "关闭后不得再收预览版");
  assert.equal(
    fakeUpdater.channel,
    null,
    "关闭后 channel 必须回默认，否则会去正式版要 preview-mac.yml",
  );
});

test("S1｜冷启动也按最新开关值配置（初始化路径同样调用共享配置函数）", async () => {
  const { initAutoUpdater } = await autoUpdaterModulePromise;

  resetFake();
  await initAutoUpdater({
    settingService: createSettingService({ receivePreviewUpdates: true }) as never,
  });
  await flush();
  assert.equal(fakeUpdater.allowPrerelease, true);
  assert.equal(fakeUpdater.channel, "preview");

  resetFake();
  await initAutoUpdater({
    settingService: createSettingService({ receivePreviewUpdates: false }) as never,
  });
  await flush();
  assert.equal(fakeUpdater.allowPrerelease, false);
  assert.equal(fakeUpdater.channel, null);
});

test("S2｜切通道清掉按通道分键的跳过版本（去掉清理 ⇒ 必红）", async () => {
  const { initAutoUpdater, refreshAutoUpdaterReleaseChannel } = await autoUpdaterModulePromise;
  resetFake();
  const settingService = createSettingService({
    receivePreviewUpdates: false,
    // 旧通道（stable）里被跳过的版本，切到 preview 后不得继续压制新通道。
    skippedElectronUpdateVersions: { stable: "3.16.3" },
  });

  await initAutoUpdater({ settingService: settingService as never });
  await flush();
  settingService.updates.length = 0;

  refreshAutoUpdaterReleaseChannel(true, "test toggle on");
  await flush();

  const cleared = settingService.updates.some(
    (patch) =>
      "skippedElectronUpdateVersions" in patch &&
      Object.keys(patch.skippedElectronUpdateVersions as Record<string, unknown>).length === 0,
  );
  assert.ok(
    cleared,
    "切通道必须把 skippedElectronUpdateVersions 清空，否则旧通道的跳过会带到新通道",
  );
});

test("S3｜冷启动先应用通道、再触发首次检查（去掉 await ⇒ 必红）", async () => {
  const { initAutoUpdater } = await autoUpdaterModulePromise;
  resetFake();
  // 首次读设置跨宏任务返回：没有 await 时，首次 checkForUpdates 会先于通道应用发生。
  const settingService = createSettingService(
    { receivePreviewUpdates: true },
    { deferFirstGet: true },
  );

  await initAutoUpdater({ settingService: settingService as never });
  await flush();

  const appliedChannelIndex = calls.indexOf("channel=preview");
  const appliedPrereleaseIndex = calls.indexOf("allowPrerelease=true");
  const firstCheckIndex = calls.indexOf("checkForUpdates");

  assert.ok(appliedChannelIndex >= 0, "冷启动必须应用 preview 通道");
  assert.ok(appliedPrereleaseIndex >= 0, "冷启动必须应用 allowPrerelease");
  assert.ok(firstCheckIndex >= 0, "冷启动必须触发首次检查");
  assert.ok(
    appliedChannelIndex < firstCheckIndex && appliedPrereleaseIndex < firstCheckIndex,
    `通道必须先于首次检查落地，实际调用序列：${calls.join(" -> ")}`,
  );
});

test("S1/S2｜检查在飞时拨开关：延后，且收口后真的应用（只重跑 check 不应用 ⇒ 必红）", async () => {
  const { initAutoUpdater, refreshAutoUpdaterReleaseChannel } = await autoUpdaterModulePromise;
  resetFake();
  const settingService = createSettingService({ receivePreviewUpdates: false });

  await initAutoUpdater({ settingService: settingService as never });
  await flush();

  // 让下一次 check 挂起：进入「检查在飞」。
  pendingCheckMode = true;
  refreshAutoUpdaterReleaseChannel(true, "test toggle on");
  await flush();
  assert.equal(fakeUpdater.channel, "preview", "首个（在飞前）开关照常立即生效");

  // 在飞期间再拨回稳定：必须只延后，不立刻改通道。
  refreshAutoUpdaterReleaseChannel(false, "test toggle off while in flight");
  await flush();
  assert.equal(fakeUpdater.channel, "preview", "在飞时不得立刻改通道（旧请求结果会错标）");

  // 在飞 check 收口 ⇒ 必须**真正应用**待处理通道，而不是只重跑一次检查。
  assert.ok(resolvePendingCheck, "应有一个挂起的 checkForUpdates");
  resolvePendingCheck();
  resolvePendingCheck = null;
  await flush();
  await flush();
  assert.equal(fakeUpdater.allowPrerelease, false, "收口后必须应用待处理通道的 allowPrerelease");
  assert.equal(fakeUpdater.channel, null, "收口后必须应用待处理通道的 channel");
});

test("接线守卫｜应用函数是唯一通道配置点，且两条路径都调它", () => {
  const source = readFileSync(autoUpdaterSourcePath, "utf8");

  const applyBlock = readTopLevelBlock(source, "function applyAutoUpdaterReleaseChannelConfig(");
  // 成对切换：两个字段必须在同一函数内一起写，且稳定分支回到 null。
  assert.match(applyBlock, /autoUpdater\.allowPrerelease = isPreview/);
  assert.match(applyBlock, /autoUpdater\.channel = isPreview \? "preview" : null/);
  assert.match(applyBlock, /provider: "github"/);

  // 全仓只此一处写这两个字段，避免又出现「初始化设了、拨开关没设」的分叉。
  assert.equal(
    (source.match(/autoUpdater\.allowPrerelease =/g) ?? []).length,
    1,
    "allowPrerelease 只允许在应用函数里赋值一次",
  );
  assert.equal(
    (source.match(/autoUpdater\.channel =/g) ?? []).length,
    1,
    "channel 只允许在应用函数里赋值一次",
  );

  // 两条路径都调它：初始化路径 + 拨开关路径。
  const initBlock = readTopLevelBlock(source, "async function applyGitHubUpdateProvider(");
  assert.match(initBlock, /applyAutoUpdaterReleaseChannelConfig\(/);
  const refreshBlock = readTopLevelBlock(
    source,
    "export function refreshAutoUpdaterReleaseChannel(",
  );
  assert.match(refreshBlock, /applyAutoUpdaterReleaseChannelConfig\(nextChannel\)/);
});

test("接线守卫｜切通道时清 readyUpdateVersion / availableUpdateChannel（模块内私有缓存）", () => {
  const source = readFileSync(autoUpdaterSourcePath, "utf8");
  const refreshBlock = readTopLevelBlock(
    source,
    "export function refreshAutoUpdaterReleaseChannel(",
  );

  // readyUpdateVersion：私有变量，外部不可观测；清了它才能避免旧通道已就绪的版本被当成新通道的。
  assert.match(refreshBlock, /clearReadyUpdateState\(\)/);
  // availableUpdateChannel：既是「当前应期待通道」，也是 stale 守卫的基准。
  assert.match(refreshBlock, /availableUpdateChannel = nextChannel/);
  // 按通道分键的跳过记录：行为层另有 S2 用例，这里钉住调用点不丢。
  assert.match(refreshBlock, /clearSkippedUpdateVersionsForChannelSwitch\(reason\)/);
  // 旧的「重新请求 manifest」是平台 manifest 时代的残留，通道配置必须在 check 之前应用。
  assert.doesNotMatch(refreshBlock, /refresh manifest channel/);
});

test("接线守卫｜冷启动 await 通道配置早于 startup 检查", () => {
  const source = readFileSync(autoUpdaterSourcePath, "utf8");
  const applyIndex = source.indexOf("await applyGitHubUpdateProvider(options);");
  const startupIndex = source.indexOf('triggerCheckForUpdates("startup");');

  assert.ok(applyIndex >= 0, "applyGitHubUpdateProvider 必须被 await（不是 void）");
  assert.equal(source.includes("void applyGitHubUpdateProvider"), false);
  assert.ok(startupIndex >= 0, "找不到 startup 检查触发点");
  assert.ok(applyIndex < startupIndex, "通道配置必须在 startup 检查之前完成");
});
