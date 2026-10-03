import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PlatformChannels } from "@zcode/shared";

/**
 * T2 的证据（验收本体见 docs/superpowers/plans/2026-10-02-preview-update-channel.md 第四、五节）。
 *
 * 要拦的缺陷都是「静态可见 + 拨了不生效」这一类：
 *  - 开关拨了，`allowPrerelease`/`channel` 没重设 ⇒ 界面变了、过滤没变，须重启（缺口 A）；
 *  - 切通道清缓存漏项 ⇒ 旧通道版本被标成新通道；
 *  - 冷启动 provider 未 await 完就检查 ⇒ 首次检查用默认值；
 *  - 在「检查在飞 / 下载中 / 已下载待安装」时拨开关被**静默早退吞掉**（T2b 缺口）：
 *    不得什么都不做就当成功，必须记下待应用通道并在阻塞解除后真正应用。
 *
 * 因为 autoUpdater.ts 顶层 import electron 具名导出（纯 Node 下 `electron` 只解析成路径字符串），
 * 直接 import 会失败。这里按仓库既有做法用 `module.registerHooks`（同步钩子，无需额外 CLI flag）
 * 就地替换 electron / electron-updater / logger，从而能对
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
  _allowDowngrade: boolean;
  allowPrerelease: boolean;
  channel: string | null;
  allowDowngrade: boolean;
  setFeedURL: (options: unknown) => void;
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  on: (event: string, listener: (payload: unknown) => void) => void;
  autoDownload?: boolean;
  autoInstallOnAppQuit?: boolean;
  logger?: unknown;
};

// 「下一次 checkForUpdates 挂起」开关：用来复现「检查在飞时拨开关」。
let pendingCheckMode = false;
let resolvePendingCheck: (() => void) | null = null;

// 安装版本可覆盖：测「装了预览版 + 关开关 + 正式号更低」这一格需要当前版本是预览版。
let appVersionOverride: string | null = null;

// 事件监听器：initAutoUpdater 通过 on() 注册，用例通过 emit() 推进状态机。
const eventListeners = new Map<string, Array<(payload: unknown) => void>>();

const fakeUpdater: FakeUpdater = {
  _allowPrerelease: false,
  _channel: null,
  _allowDowngrade: false,
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
    // 忠实复刻 electron-updater 的副作用：`set channel` 每次赋值（**含赋 null**）都会
    // 把 allowDowngrade 置 true（node_modules/electron-updater/out/AppUpdater.js:28-46）。
    // 必须建模，否则「通道应用后显式关掉 allowDowngrade」这条断言即使被删掉也不会红。
    this._allowDowngrade = true;
    calls.push("allowDowngrade=true(channel-setter-side-effect)");
  },
  get allowDowngrade(): boolean {
    return this._allowDowngrade;
  },
  set allowDowngrade(value: boolean) {
    this._allowDowngrade = value;
    calls.push(`allowDowngrade=${value}`);
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
  downloadUpdate() {
    calls.push("downloadUpdate");
    // 故意保持挂起：真实下载要等 download-progress/update-downloaded 事件推动状态，
    // 若这里 resolve，downloadAvailableUpdate 的 .finally 会清掉 downloadCancellationToken，
    // 后续 download-progress 事件会被当成「陈旧进度」丢弃，测不到下载态。
    return new Promise<void>(() => {});
  },
  on(event: string, listener: (payload: unknown) => void) {
    const listeners = eventListeners.get(event) ?? [];
    listeners.push(listener);
    eventListeners.set(event, listeners);
  },
};

/** IPC handler：入口与真实运行一致（下载/取消都由真实 IPC 通道触发，而非直接调私有函数）。 */
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

const electronStub = {
  app: {
    isPackaged: true,
    getVersion: () => appVersionOverride ?? "3.16.3",
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
    handle(channel: string, handler: (...args: unknown[]) => unknown) {
      ipcHandlers.set(channel, handler);
    },
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
export class CancellationToken {
  cancelled = false;
  cancel() { this.cancelled = true; }
  dispose() {}
}
`,
  "stub:logger": `
export const logger = { info() {}, warn() {}, error() {}, debug() {} };
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

const autoUpdaterModulePromise = import("../src/main/autoUpdater.ts");

/* --------------------------------- 辅助 --------------------------------- */

const flush = () => new Promise<void>((resolveFlush) => setImmediate(resolveFlush));

/** 推一条 electron-updater 事件，驱动真实状态机（与主进程运行期同一条路径）。 */
function emit(event: string, payload?: unknown): void {
  for (const listener of eventListeners.get(event) ?? []) {
    listener(payload);
  }
}

function invokeIpc(channel: string, ...args: unknown[]): unknown {
  const handler = ipcHandlers.get(channel);
  assert.ok(handler, `未注册 IPC handler：${channel}`);
  // 真实 handler 的第一个参数是 IpcMainInvokeEvent；多数 handler 忽略它，带参的（如跳版本）需要它占位。
  return handler({} as never, ...args);
}

function resetFake(): void {
  fakeUpdater._allowPrerelease = false;
  fakeUpdater._channel = null;
  fakeUpdater._allowDowngrade = false;
  pendingCheckMode = false;
  resolvePendingCheck = null;
  appVersionOverride = null;
  calls.length = 0;
  // 监听器/handler 属于「上一次 initAutoUpdater」，清掉避免跨用例重复触发。
  eventListeners.clear();
  ipcHandlers.clear();
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

/* --------------- 事情一：阻塞态下拨开关不得被静默吞掉 --------------- */

test("S1(2)｜下载中拨开关：记待应用通道（不改通道、不打断下载），取消下载后真正应用", async () => {
  const { initAutoUpdater, refreshAutoUpdaterReleaseChannel, getAutoUpdaterState } =
    await autoUpdaterModulePromise;
  resetFake();
  await initAutoUpdater({
    settingService: createSettingService({ receivePreviewUpdates: false }) as never,
  });
  await flush();

  // 经真实事件 + 真实 IPC 入口驱动到「下载中」，不直接调私有函数。
  emit("update-available", { version: "3.20.0", files: [{ url: "x.zip", sha512: "h" }] });
  await flush();
  invokeIpc(PlatformChannels.DownloadUpdate);
  emit("download-progress", { percent: 10, transferred: 1, total: 10, bytesPerSecond: 1 });
  await flush();
  assert.equal(getAutoUpdaterState().kind, "download-progress", "前置：应处于「下载中」");

  refreshAutoUpdaterReleaseChannel(true, "test toggle on while downloading");
  await flush();
  assert.equal(fakeUpdater.allowPrerelease, false, "下载中不得立刻改通道（会抽走在途下载的产物）");
  assert.equal(fakeUpdater.channel, null);
  assert.equal(
    getAutoUpdaterState().kind,
    "download-progress",
    "下载中拨开关不得把下载打断（旧实现静默早退，也同时吞掉了这次拨动）",
  );

  // 取消下载是真实恢复路径：状态离开阻塞态 ⇒ 待应用通道必须真正落地。
  invokeIpc(PlatformChannels.CancelUpdateDownload);
  await flush();
  assert.equal(
    fakeUpdater.allowPrerelease,
    true,
    "阻塞解除后必须应用待处理通道（恢复静默早退 ⇒ 这里必红）",
  );
  assert.equal(fakeUpdater.channel, "preview");
});

test("S1(2)｜已下载待安装时拨开关：记待应用通道，就绪被放弃后真正应用", async () => {
  const { initAutoUpdater, refreshAutoUpdaterReleaseChannel, getAutoUpdaterState } =
    await autoUpdaterModulePromise;
  resetFake();
  await initAutoUpdater({
    settingService: createSettingService({ receivePreviewUpdates: false }) as never,
  });
  await flush();

  emit("update-downloaded", { version: "3.21.0" });
  await flush();
  assert.equal(getAutoUpdaterState().kind, "update-downloaded", "前置：应处于「已就绪」");

  refreshAutoUpdaterReleaseChannel(true, "test toggle on while ready");
  await flush();
  assert.equal(fakeUpdater.channel, null, "已就绪时不得立刻改通道（会丢弃已下载的安装包）");
  assert.equal(getAutoUpdaterState().kind, "update-downloaded", "就绪态拨开关不得被打断");

  // 就绪被放弃（staging / 安装失败）是真实恢复路径 ⇒ 待应用通道必须落地。
  emit("error", new Error("staging failed"));
  await flush();
  assert.equal(
    fakeUpdater.allowPrerelease,
    true,
    "就绪被放弃后必须应用待处理通道（恢复静默早退 ⇒ 这里必红）",
  );
  assert.equal(fakeUpdater.channel, "preview");
});

test("接线守卫｜待应用通道有唯一落地入口，且状态收口点会尝试落地", () => {
  const source = readFileSync(autoUpdaterSourcePath, "utf8");

  // 落地入口唯一：三处阻塞态判定收敛在一个函数里，避免某条恢复路径漏判。
  assert.equal(
    (source.match(/function isReleaseChannelChangeBlocked\(/g) ?? []).length,
    1,
    "阻塞判定必须唯一",
  );
  assert.equal(
    (source.match(/function tryApplyPendingReleaseChannelRefresh\(/g) ?? []).length,
    1,
    "落地入口必须唯一",
  );

  // 状态收口点（menuState 变更的唯一出口）会尝试落地 —— 否则「下载中/已就绪」的 pending
  // 只能靠某一条具体恢复分支去清，漏一条就是静默吞掉。
  const stateBlock = readTopLevelBlock(source, "function setAutoUpdaterMenuState(");
  assert.match(stateBlock, /tryApplyPendingReleaseChannelRefresh\(/);
  // refresh 在阻塞时只记 pending、不得再出现旧的静默早退日志。
  const refreshBlock = readTopLevelBlock(
    source,
    "export function refreshAutoUpdaterReleaseChannel(",
  );
  assert.match(refreshBlock, /pendingReleaseChannelRefresh = nextChannel/);
  assert.doesNotMatch(refreshBlock, /skip .*state=\$\{menuState\.kind\}/);
});

test("接线守卫｜未签名 mac 的「打开发布页」回退随当前通道指向", () => {
  const source = readFileSync(autoUpdaterSourcePath, "utf8");

  // 旧的固定 /releases/latest 会把预览用户送到正式版页，必须消失。
  assert.doesNotMatch(source, /GITHUB_RELEASES_PAGE_URL/, "固定发布页常量必须删除");
  const fallbackBlock = readTopLevelBlock(source, "export function checkForUpdateMenuClick(");
  assert.match(fallbackBlock, /getGitHubReleasesPageUrl\(\)/, "回退必须走随通道选择的 URL helper");
});

/* ------------------- 事情二：allowDowngrade 显式关掉（不依赖降级） ------------------- */

test("S6｜通道配置后 allowDowngrade 显式关掉（删掉那一行 ⇒ 必红）", async () => {
  const { initAutoUpdater, refreshAutoUpdaterReleaseChannel } = await autoUpdaterModulePromise;
  resetFake();
  await initAutoUpdater({
    settingService: createSettingService({ receivePreviewUpdates: false }) as never,
  });
  await flush();
  assert.equal(fakeUpdater.allowDowngrade, false, "冷启动（稳定通道）也不得允许降级");

  refreshAutoUpdaterReleaseChannel(true, "test toggle on");
  await flush();
  assert.equal(fakeUpdater.channel, "preview");
  assert.equal(
    fakeUpdater.allowDowngrade,
    false,
    "开启预览通道后必须显式关掉 allowDowngrade（channel setter 会把它置 true）",
  );

  refreshAutoUpdaterReleaseChannel(false, "test toggle off");
  await flush();
  assert.equal(fakeUpdater.channel, null);
  assert.equal(
    fakeUpdater.allowDowngrade,
    false,
    "channel=null 同样会触发 setter 副作用（赋 null 也置 true），必须再次关掉",
  );

  // 桩若没有忠实复刻 setter 副作用，本用例就是空断言 —— 这里钉住副作用确实发生过。
  const downgradeCalls = calls.filter((call) => call.startsWith("allowDowngrade="));
  assert.ok(
    downgradeCalls.includes("allowDowngrade=true(channel-setter-side-effect)"),
    "桩必须复刻 electron-updater channel setter 的副作用",
  );
  assert.equal(downgradeCalls.at(-1), "allowDowngrade=false", "最后一次赋值必须是把降级关掉");
});

test("接线守卫｜allowDowngrade 在通道应用函数内、且位于 channel 赋值之后，全仓仅一处", () => {
  const source = readFileSync(autoUpdaterSourcePath, "utf8");
  assert.equal(
    (source.match(/autoUpdater\.allowDowngrade =/g) ?? []).length,
    1,
    "allowDowngrade 只允许在应用函数里赋值一次",
  );
  const applyBlock = readTopLevelBlock(source, "function applyAutoUpdaterReleaseChannelConfig(");
  const channelIndex = applyBlock.indexOf('autoUpdater.channel = isPreview ? "preview" : null');
  const downgradeIndex = applyBlock.indexOf("autoUpdater.allowDowngrade = false");
  assert.ok(channelIndex >= 0, "找不到 channel 赋值");
  assert.ok(
    downgradeIndex > channelIndex,
    "必须在 channel 赋值之后显式关掉 allowDowngrade，否则会被 setter 副作用打开",
  );
  // 理由必须写进注释：为什么宁可停在预览版也不依赖降级。
  assert.match(applyBlock, /Squirrel/, "必须注明 mac Squirrel 对降级支持不完整这一理由");
});

/* ------------- 事情三：zcodeReleaseChannel 取不到 ⇒ 删净，不留半截 ------------- */

test("③(b)｜取不到的通道字段与恒不生效的 stale 守卫已连同依赖删净", () => {
  const source = readFileSync(autoUpdaterSourcePath, "utf8");

  // GitHub provider 的 UpdateInfo 从来不产出这些字段，平台 manifest 路径已删 ⇒ 恒为 null
  // ⇒ 守卫恒不生效、通道标注只能靠簿记值。半截留着比删掉更危险（读者会以为有保护）。
  assert.doesNotMatch(source, /zcodeReleaseChannel/, "不得留一个恒为 null 的通道字段");
  assert.doesNotMatch(source, /shouldIgnoreStaleAvailableUpdate/, "恒不生效的守卫必须删除");
  assert.doesNotMatch(
    source,
    /activeAutoUpdateCheckChannel/,
    "仅为该守卫服务的簿记变量必须一并删除",
  );
  assert.doesNotMatch(source, /readUpdateInfoReleaseChannel/, "读取该字段的实例方法必须一并删除");
  assert.doesNotMatch(source, /infoChannel/, "依赖该字段的中间变量不得残留（否则等于留了半截）");
});

test("③(b)｜通道标注取本次检查通道：preview 结果标 preview，跳过记录也进 preview 键", async () => {
  const { initAutoUpdater, getAutoUpdaterState } = await autoUpdaterModulePromise;
  resetFake();
  const settingService = createSettingService({ receivePreviewUpdates: true });
  await initAutoUpdater({ settingService: settingService as never });
  await flush();
  settingService.updates.length = 0;

  // GitHub provider 的 update-available payload 里没有通道字段（真实形态）。
  emit("update-available", { version: "3.17.0-preview.1" });
  await flush();
  await flush();

  const state = getAutoUpdaterState();
  assert.equal(state.kind, "update-available");
  assert.equal(state.channel, "preview", "通道标注必须随「本次检查所用通道」走，而不是默认 stable");

  // 跳过记录按通道分键：标错通道会把 preview 内容写进 stable 键（污染）。
  invokeIpc(PlatformChannels.SkipUpdateVersion, "3.17.0-preview.1");
  await flush();
  assert.ok(
    settingService.updates.some(
      (patch) =>
        (patch.skippedElectronUpdateVersions as Record<string, string> | undefined)?.preview ===
        "3.17.0-preview.1",
    ),
    `跳过记录必须进 preview 键，实际补丁：${JSON.stringify(settingService.updates)}`,
  );
});

/* --------------- 事情一：装了预览版 + 关开关 + 正式号更低 ⇒ 必须说清 --------------- */

test("①｜装了预览版 + 关开关 + 正式号更低 ⇒ idle 必须带上「回不到正式版」的事实", async () => {
  const { initAutoUpdater, getAutoUpdaterState } = await autoUpdaterModulePromise;
  resetFake();
  appVersionOverride = "3.17.0-preview.1";
  await initAutoUpdater({
    settingService: createSettingService({ receivePreviewUpdates: false }) as never,
  });
  await flush();

  // 正式版仍是更低的 3.16.3：既不允许降级、也没追上 ⇒ electron-updater 报 not-available。
  emit("update-not-available", { version: "3.16.3" });
  await flush();

  const state = getAutoUpdaterState();
  assert.equal(state.kind, "idle");
  assert.equal(state.channel, "stable", "idle 也要带已应用通道，界面才说得清在哪条通道");
  const notice = state.kind === "idle" ? state.upToDateNotice : undefined;
  assert.ok(notice, "这一格必须带可解释的事实，否则界面只能显示「已是最新」");
  assert.equal(notice.stableCatchUpPending, true);
  assert.equal(notice.channel, "stable");
  assert.equal(notice.currentVersion, "3.17.0-preview.1");
  assert.equal(notice.latestChannelVersion, "3.16.3");
});

test("①｜普通「已是最新」不带误导性说明：稳定版装稳定版 / 预览通道两格都不带", async () => {
  const { initAutoUpdater, getAutoUpdaterState } = await autoUpdaterModulePromise;

  // 格一：装的是稳定版，确认无更新 ⇒ 无该状态（不该惊吓普通用户）。
  resetFake();
  appVersionOverride = "3.16.3";
  await initAutoUpdater({
    settingService: createSettingService({ receivePreviewUpdates: false }) as never,
  });
  await flush();
  emit("update-not-available", { version: "3.16.3" });
  await flush();
  const stableState = getAutoUpdaterState();
  assert.equal(stableState.kind, "idle");
  assert.equal(
    stableState.kind === "idle" ? stableState.upToDateNotice : "sentinel",
    undefined,
    "稳定版已是最新时不得附带「回不到正式版」的说明",
  );

  // 格二：预览通道（开关打开）装预览版、确认无更新 ⇒ 检查就在预览通道上，不存在「回不去」。
  resetFake();
  appVersionOverride = "3.17.0-preview.1";
  await initAutoUpdater({
    settingService: createSettingService({ receivePreviewUpdates: true }) as never,
  });
  await flush();
  emit("update-not-available", { version: "3.17.0-preview.1" });
  await flush();
  const previewState = getAutoUpdaterState();
  assert.equal(previewState.kind, "idle");
  assert.equal(previewState.channel, "preview");
  assert.equal(
    previewState.kind === "idle" ? previewState.upToDateNotice : "sentinel",
    undefined,
    "预览通道下不该说「回不到正式版」",
  );
});

test("接线守卫｜手动检查的 up-to-date 结果同样带上事实（toast 不得只说「已是最新」）", () => {
  const source = readFileSync(autoUpdaterSourcePath, "utf8");
  const start = source.indexOf('autoUpdater.on("update-not-available"');
  const end = source.indexOf('autoUpdater.on("download-progress"');
  assert.ok(start >= 0 && end > start, "找不到 update-not-available 处理器");
  const block = source.slice(start, end);

  // 同一份事实必须同时落到「idle 状态」与「手动检查结果」两个出口：
  // 前者供设置页常驻显示，后者供用户点击检查后的 toast，少一个就有静默路径。
  assert.match(block, /buildUpToDateNotice\(info\.version\)/);
  assert.ok(
    (block.match(/upToDateNotice/g) ?? []).length >= 3,
    "idle 状态与手动检查结果都要带上 upToDateNotice",
  );
  assert.match(block, /kind: "up-to-date"/);
  assert.match(block, /channel: availableUpdateChannel/);
});
