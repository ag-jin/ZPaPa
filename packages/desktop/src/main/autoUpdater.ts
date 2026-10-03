/* eslint-disable max-lines -- autoUpdater 需要集中维护 Electron 事件、菜单状态与 IPC 交互，过度拆分会让更新状态流更难追踪 */
import type { ISettingService } from "@zcode/services";
import {
  DEFAULT_LOCALE,
  desktopMenuMessageIds,
  formatDesktopMenuMessage,
  getDesktopMenuMessage,
  PlatformChannels,
  ZCODE_VERSION,
  type ElectronReleaseChannel,
  type Locale,
  type PostUpdateReleaseNotesPayload,
  type UpdateCheckResultPayload,
  type UpdateStatePayload,
  type UpdateUpToDateNotice,
} from "@zcode/shared";
import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import { execFile } from "node:child_process";
import pkg, { CancellationToken } from "electron-updater";
import {
  getElectronReleasePlatform,
  parseMacDesignatedRequirement,
  resolveGitHubReleasesPageUrl,
  resolveMacAppBundlePath,
  shouldUseInAppAutoUpdate,
} from "./autoUpdatePolicy.js";
import semver from "semver";
import { logger } from "./logger.js";
const { autoUpdater } = pkg;

export const CHECK_FOR_UPDATE_MENU_ID = "check-for-update";
const AUTO_UPDATE_POLL_INTERVAL_MS = 60 * 60 * 1000;
// 更新通道(离线裁剪版):改用 GitHub Releases(ag-jin/ZPaPa)。
// Windows 与 macOS 都走 electron-updater 的 GitHub provider 完整自动更新。
// （旧注释称「macOS 未签名 → Squirrel 静默安装会被签名校验拒绝」，2026-09-29 实测更精确：
//  完全未签名时 Squirrel **连初始化都做不到**（取不到 designated requirement，
//  原生 setFeedURL 抛 "Could not get code signature for running application"）；
//  打包侧因此总是给 identity —— 有证书用 Developer ID，无证书用 ad-hoc + 显式
//  identifier 型 DR，见 electron-builder.config.js 的 writeMacRequirementsFile。
//  运行期判定见 autoUpdatePolicy.ts。）
const GITHUB_UPDATE_OWNER = "ag-jin";
const GITHUB_UPDATE_REPO = "ZPaPa";
const UPDATE_FEED_URL_ENV = "ZCODE_UPDATE_FEED_URL";
const UPDATE_FEED_URL_SWITCH = "--zcode-update-feed-url";
const DEV_AUTO_UPDATE_ENV = "ZCODE_AUTO_UPDATE_DEV";
const DEV_AUTO_UPDATE_SWITCH = "--zcode-auto-update-dev";
const DEV_AUTO_UPDATE_VERSION_ENV = "ZCODE_AUTO_UPDATE_DEV_VERSION";
const DEV_AUTO_UPDATE_VERSION_SWITCH = "--zcode-auto-update-dev-version";
let readyUpdateVersion: string | null = null;
let readyUpdateReleaseNotes: PostUpdateReleaseNotesPayload | null = null;
let readyUpdateRestoredFromPendingReleaseNotes = false;
let menuLocale: Locale = DEFAULT_LOCALE;
let manualCheckWebContentsId: number | null = null;
let pendingPostUpdateReleaseNotes: PostUpdateReleaseNotesPayload | null = null;
let deliveredPostUpdateReleaseNotesWebContentsId: number | null = null;
let autoUpdatePollTimer: NodeJS.Timeout | null = null;
let checkForUpdatesInFlight = false;
let autoUpdateCheckGeneration = 0;
let activeAutoUpdateCheckId: number | null = null;
let settlingAutoUpdateCheckId: number | null = null;
let availableUpdateReleaseNotes: PostUpdateReleaseNotesPayload | null = null;
let availableUpdateChannel: ElectronReleaseChannel = "stable";
let downloadingUpdateVersion: string | null = null;
let downloadingUpdateReleaseNotes: PostUpdateReleaseNotesPayload | null = null;
let downloadingUpdateChannel: ElectronReleaseChannel | null = null;
let downloadCancellationToken: CancellationToken | null = null;
let readyUpdateChannel: ElectronReleaseChannel | null = null;
// 拨开关时若通道**此刻不能安全落地**（检查在飞 / 正在下载 / 已下载待安装），只记下待应用
// 通道，绝不静默丢弃这次拨动：等阻塞解除后由 tryApplyPendingReleaseChannelRefresh 真正应用
// （重设 allowPrerelease/channel + 清通道缓存）。判定与落地见 isReleaseChannelChangeBlocked
// 与 tryApplyPendingReleaseChannelRefresh 的注释。
let pendingReleaseChannelRefresh: ElectronReleaseChannel | null = null;
let onBeforeQuitAndInstall: (() => void | Promise<void>) | undefined;
const acknowledgedPostUpdateReleaseNotesVersions = new Set<string>();
const cancelledDownloadTokens = new WeakSet<CancellationToken>();
let pendingCancelledDownloadErrorCount = 0;
let autoUpdaterSettingService: SettingServiceLike | undefined;
// initAutoUpdater({ enabled: false }) 只清轮询并 return，electron-updater 实例保持未配置
// （占位 feed、autoDownload 默认值）。任何漏改成按身份判断的入口若仍调用手动检查，
// 都会对占位 feed 发真实请求。这里记住“本 flavor 已禁用”，让手动检查在模块内部 fail-closed。
let autoUpdaterDisabledForProductFlavor = false;
/**
 * 本次运行是否支持**应用内**更新（下载 + 安装）。由 initAutoUpdater 按运行期事实设置，
 * 供 checkForUpdateMenuClick 决定「进状态机」还是「打开发布页」。
 * 默认 false：初始化之前的不确定态不谎称支持。
 */
let inAppAutoUpdateAvailable = false;

type SettingServiceLike = Pick<ISettingService, "get" | "update">;

type ReleaseNoteInfoLike = {
  note?: string | null;
  version?: string | null;
};

type UpdateDownloadedInfoLike = {
  version: string;
  path?: string | null;
  files?: Array<{ url?: string | null } | null> | null;
  packages?: Record<string, { path?: string | null } | null> | null;
  releaseName?: string | null;
  releaseNotes?: string | ReleaseNoteInfoLike[] | null;
  releaseDate?: string | Date | null;
  releaseNotesByLocale?: Partial<
    Record<
      Locale,
      | string
      | {
          title?: string | null;
          markdown?: string | null;
          releaseNotes?: string | ReleaseNoteInfoLike[] | null;
        }
      | null
    >
  > | null;
};

type RuntimeUpdateFeedSource = { url: string };

type AutoUpdaterMenuState = UpdateStatePayload;
let menuState: AutoUpdaterMenuState = { kind: "idle", enabled: true };

export type ForceAutoUpdateState =
  | { kind: "checking" }
  | { kind: "downloading"; version?: string; progress?: string }
  | { kind: "ready"; version?: string }
  | { kind: "installing" }
  | { kind: "error"; message: string }
  | { kind: "dev-skipped"; message?: string };

let activeForceAutoUpdateListener: ((state: ForceAutoUpdateState) => void) | null = null;
const autoUpdaterStateListeners = new Set<(state: UpdateStatePayload) => void>();
let forceAutoUpdateLastLoggedProgressBucket: number | null = null;

interface InitAutoUpdaterOptions {
  enabled?: boolean;
  onBeforeQuitAndInstall?: () => void | Promise<void>;
  settingService?: SettingServiceLike;
  locale?: Locale;
  updateFeedSource?: RuntimeUpdateFeedSource;
  deviceMid?: string;
  resolveEndpointOrigin?: () => string | Promise<string>;
}

let quitAndInstallInFlight = false;
let devAutoUpdateVersionOverride: string | null = null;

type MutableAutoUpdaterForDev = typeof autoUpdater & {
  currentVersion?: semver.SemVer;
  forceDevUpdateConfig?: boolean;
};

function isTruthyRuntimeFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function readCommandLineSwitchValue(name: string): string | null {
  const prefix = `${name}=`;
  for (const arg of process.argv) {
    if (arg === name) {
      return "";
    }
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return null;
}

function isDevAutoUpdateEnabled(): boolean {
  return (
    isTruthyRuntimeFlag(process.env[DEV_AUTO_UPDATE_ENV]) ||
    readCommandLineSwitchValue(DEV_AUTO_UPDATE_SWITCH) !== null
  );
}

/**
 * 应用是否带 designated requirement（DR）—— 即 Squirrel.Mac 能否初始化。
 * 判定逻辑在 autoUpdatePolicy.ts（纯函数、可单测），这里只负责执行 codesign。
 */
async function probeMacCodeSignature(appBundlePath: string): Promise<boolean> {
  return new Promise<boolean>((resolveProbe) => {
    execFile(
      "codesign",
      ["-d", "-r-", appBundlePath],
      { encoding: "utf8", timeout: 5_000 },
      (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code === "string" && !stdout && !stderr) {
          // 命令本身不可用（无 codesign / 超时）：保守判定为「不支持应用内更新」，
          // 让用户走发布页下载，而不是停在一个注定失败的下载流程里。
          logger.warn(`[auto-update] mac code signature probe failed: ${String(error.message)}`);
          resolveProbe(false);
          return;
        }
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : 0;
        resolveProbe(parseMacDesignatedRequirement(code, stdout ?? "", stderr ?? ""));
      },
    );
  });
}

function canUseAutoUpdaterInCurrentRuntime(): boolean {
  return app.isPackaged || isDevAutoUpdateEnabled();
}

function shouldRelaunchForDevAutoUpdateInstall(): boolean {
  return !app.isPackaged && isDevAutoUpdateEnabled();
}

function getCurrentAppVersionForUpdate(): string {
  return devAutoUpdateVersionOverride ?? app.getVersion();
}

function resolveDevAutoUpdateVersion(): string | null {
  const configuredVersion =
    process.env[DEV_AUTO_UPDATE_VERSION_ENV]?.trim() ||
    readCommandLineSwitchValue(DEV_AUTO_UPDATE_VERSION_SWITCH)?.trim() ||
    ZCODE_VERSION;
  const parsed = semver.parse(configuredVersion);
  if (!parsed) {
    logger.warn(`[auto-update] ignore invalid dev update version=${configuredVersion}`);
    return null;
  }
  return parsed.format();
}

function applyDevAutoUpdateRuntimeOverrides(): void {
  devAutoUpdateVersionOverride = null;
  if (app.isPackaged || !isDevAutoUpdateEnabled()) {
    return;
  }

  const devVersion = resolveDevAutoUpdateVersion();
  const parsedVersion = devVersion ? semver.parse(devVersion) : null;
  const mutableAutoUpdater = autoUpdater as MutableAutoUpdaterForDev;
  mutableAutoUpdater.forceDevUpdateConfig = true;
  if (parsedVersion) {
    devAutoUpdateVersionOverride = parsedVersion.format();
    // Electron 开发态 app.getVersion() 读取的是 desktop 运行壳版本，
    // 不一定跟产品版本一致。验证自动更新时需要显式把 electron-updater 的
    // currentVersion 改成产品版本，否则 3.3.1 -> 3.3.2 这类流程无法复现。
    mutableAutoUpdater.currentVersion = parsedVersion;
  }

  logger.info(
    `[auto-update] dev update enabled version=${devAutoUpdateVersionOverride ?? app.getVersion()}`,
  );
}

function normalizeVersionForCompare(version: string): string | null {
  return semver.valid(semver.coerce(version.trim()));
}

function isVersionGreaterThan(candidateVersion: string, baselineVersion: string): boolean {
  const candidate = normalizeVersionForCompare(candidateVersion);
  const baseline = normalizeVersionForCompare(baselineVersion);
  if (candidate && baseline) {
    return semver.gt(candidate, baseline);
  }

  return candidateVersion.trim() !== baselineVersion.trim();
}

function shouldDownloadAvailableUpdate(version: string): boolean {
  if (readyUpdateRestoredFromPendingReleaseNotes) {
    return true;
  }

  return !readyUpdateVersion || isVersionGreaterThan(version, readyUpdateVersion);
}

function canPollForUpdatesFromState(state: AutoUpdaterMenuState): boolean {
  return state.kind === "idle" || state.kind === "update-downloaded";
}

function getAutoUpdaterReleaseChannelForCurrentState(): ElectronReleaseChannel {
  switch (menuState.kind) {
    case "update-available":
      return menuState.channel ?? availableUpdateChannel;
    case "download-progress":
      return menuState.channel ?? downloadingUpdateChannel ?? availableUpdateChannel;
    case "update-downloaded":
      return menuState.channel ?? readyUpdateChannel ?? availableUpdateChannel;
    default:
      return availableUpdateChannel;
  }
}

function beginAutoUpdateCheck(): number {
  checkForUpdatesInFlight = true;
  autoUpdateCheckGeneration += 1;
  activeAutoUpdateCheckId = autoUpdateCheckGeneration;
  settlingAutoUpdateCheckId = null;
  return activeAutoUpdateCheckId;
}

/**
 * 通道变更此刻是否被阻塞 —— 三种状态下不能立刻把新通道写进 electron-updater：
 *
 * - **检查在飞**：旧请求返回时会把旧通道的版本标成新通道（见 refreshAutoUpdaterReleaseChannel）。
 * - **下载中**：在途下载的产物属于**旧通道**，此刻重设 allowPrerelease/channel 并清缓存，
 *   等于把用户正在下载的东西从脚下抽走。
 * - **已下载待安装**：已就绪的安装包同理属于旧通道，不该因为一次拨动就被丢弃。
 *
 * 三种情况一律「记下待应用通道、等解除后再应用」，故统一收敛到这一个判定里 ——
 * 分散写会让某条恢复路径漏判，表现成拨了开关却永远不生效（静默吞掉）。
 */
function isReleaseChannelChangeBlocked(): boolean {
  return (
    checkForUpdatesInFlight ||
    menuState.kind === "download-progress" ||
    menuState.kind === "update-downloaded"
  );
}

/**
 * 把「待应用通道」真正落地 —— **唯一落地入口**。
 *
 * 仍在阻塞态时保留 pending，交由下一次状态收敛再试；因此拨动只会**延后**到安全时刻
 * （检查收口、下载失败/取消/被跳过、就绪态被安装或放弃），绝不会被静默吞掉。
 * 返回是否本轮真的应用了，便于日志与测试区分「延后」与「落地」。
 */
function tryApplyPendingReleaseChannelRefresh(reason: string): boolean {
  const pendingChannel = pendingReleaseChannelRefresh;
  if (!pendingChannel || isReleaseChannelChangeBlocked()) {
    return false;
  }

  pendingReleaseChannelRefresh = null;
  refreshAutoUpdaterReleaseChannel(
    pendingChannel === "preview",
    `${reason} pending release channel refresh`,
  );
  return true;
}

function completeAutoUpdateCheck(reason: string, checkId: number | null): void {
  if (checkId !== null && activeAutoUpdateCheckId !== checkId) {
    return;
  }

  checkForUpdatesInFlight = false;
  activeAutoUpdateCheckId = null;
  settlingAutoUpdateCheckId = null;

  // 检查收口是一个落地时机；但若此刻正在下载/已就绪，pending 会被保留到那一态解除。
  tryApplyPendingReleaseChannelRefresh(reason);
}

function finishAutoUpdateCheck(reason: string, checkId: number | null): void {
  if (
    checkId !== null &&
    activeAutoUpdateCheckId === checkId &&
    settlingAutoUpdateCheckId === checkId
  ) {
    return;
  }

  completeAutoUpdateCheck(reason, checkId);
}

function settleAutoUpdateCheckResult(
  reason: string,
  work: () => Promise<void> | void,
): Promise<void> {
  const checkId = activeAutoUpdateCheckId;
  if (!checkForUpdatesInFlight || checkId === null) {
    return Promise.resolve(work());
  }

  settlingAutoUpdateCheckId = checkId;
  try {
    return Promise.resolve(work()).finally(() => {
      // electron-updater 的 checkForUpdates() Promise 只代表请求返回，
      // 不会等待 update-available 里读取设置、跳过版本、自动下载等异步状态处理。
      // 这里让一次 check 的互斥范围覆盖“请求 + 结果处理”，避免通道刷新或手动检查抢在旧结果写状态前启动。
      completeAutoUpdateCheck(reason, checkId);
    });
  } catch (error) {
    completeAutoUpdateCheck(reason, checkId);
    return Promise.reject(error);
  }
}

/**
 * 已确认「无可用更新」时，判断是否需要给界面一段额外解释。
 *
 * 触发场景（验收格「装了预览版 + 关开关 + 正式号更低」）：用户装了 `3.17.0-preview.1`，
 * 关掉「接受提前收到预览版更新」开关 ⇒ 通道回到 stable，GitHub 上最新正式版仍是 `3.16.3`。
 * 既不允许降级、正式版又没追上来 ⇒ electron-updater 报 not-available。此时若界面只说
 * 「已是最新」，用户就以为一切正常，实则回不到正式版 —— 与开关文案「关闭后将随着版本发布
 * 节奏获得版本推送更新」不符。这里用 semver 把事实算准，renderer 只负责措辞。
 *
 * 只在真正会让人困惑时附带（正式版号更低），普通「已是最新」不加重负担。
 */
function buildUpToDateNotice(infoVersion: string): UpdateUpToDateNotice | undefined {
  const currentVersion = getCurrentAppVersionForUpdate();
  const channel: ElectronReleaseChannel = autoUpdater.allowPrerelease ? "preview" : "stable";
  // 「正式版号更低」用 semver 判定，而不是字符串比较：`3.17.0` vs `3.17.0-preview.1` 的
  // 大小关系只有 semver 能给对（预览版恒小于同号正式版）。
  const stableCatchUpPending =
    channel === "stable" &&
    semver.prerelease(currentVersion) !== null &&
    semver.lt(infoVersion, currentVersion) === true;
  if (!stableCatchUpPending) {
    return undefined;
  }

  return { channel, currentVersion, latestChannelVersion: infoVersion, stableCatchUpPending };
}

function buildUpdateDownloadedState(version: string): AutoUpdaterMenuState {
  return {
    kind: "update-downloaded",
    enabled: true,
    version,
    ...(readyUpdateChannel ? { channel: readyUpdateChannel } : {}),
    ...(readyUpdateReleaseNotes ? { releaseNotes: readyUpdateReleaseNotes } : {}),
  };
}

function buildUpdateAvailableState(
  version: string,
  releaseNotes: PostUpdateReleaseNotesPayload | null,
  channel: ElectronReleaseChannel,
): AutoUpdaterMenuState {
  return {
    kind: "update-available",
    enabled: true,
    version,
    channel,
    ...(releaseNotes ? { releaseNotes } : {}),
  };
}

function notifyForceAutoUpdate(state: ForceAutoUpdateState) {
  activeForceAutoUpdateListener?.(state);
}

function getForceAutoUpdateNoUpdateMessage(): string {
  return menuLocale === "zh-CN"
    ? "未找到可安装更新，请使用手动升级。"
    : "No installable update was found. Use manual update instead.";
}

function normalizeProgressPercent(progress: unknown): string | undefined {
  if (typeof progress !== "object" || progress === null || !("percent" in progress)) {
    return undefined;
  }

  const percent = Number((progress as { percent?: unknown }).percent);
  if (!Number.isFinite(percent)) {
    return undefined;
  }

  return Math.max(0, Math.min(100, percent)).toFixed(0);
}

function logForceAutoUpdateProgress(progress: string | undefined) {
  if (!progress) {
    return;
  }

  const bucket = Math.floor(Number(progress) / 10) * 10;
  if (bucket === forceAutoUpdateLastLoggedProgressBucket) {
    return;
  }
  forceAutoUpdateLastLoggedProgressBucket = bucket;
  logger.info(`[force-update] 自动升级下载进度 ${progress}%`);
}

function buildDownloadProgressState(
  progress: string,
  byteProgress?: { transferredBytes: number; totalBytes: number },
): AutoUpdaterMenuState {
  return {
    kind: "download-progress",
    enabled: false,
    progress,
    ...(byteProgress ? byteProgress : {}),
    ...(downloadingUpdateVersion ? { version: downloadingUpdateVersion } : {}),
    ...(downloadingUpdateChannel ? { channel: downloadingUpdateChannel } : {}),
    ...(downloadingUpdateReleaseNotes ? { releaseNotes: downloadingUpdateReleaseNotes } : {}),
  };
}

async function quitAndInstallUpdate(rejectUnavailable = false) {
  if (
    menuState.kind === "update-downloaded" &&
    readyUpdateVersion &&
    readyUpdateRestoredFromPendingReleaseNotes
  ) {
    const restoredVersion = readyUpdateVersion;
    const restoredReleaseNotes = readyUpdateReleaseNotes;
    const restoredChannel = readyUpdateChannel ?? availableUpdateChannel;
    logger.warn(
      `[auto-update] restage restored pending update before install version=${restoredVersion}`,
    );
    clearReadyUpdateState();
    availableUpdateReleaseNotes = restoredReleaseNotes;
    setAutoUpdaterMenuState(
      buildUpdateAvailableState(restoredVersion, restoredReleaseNotes, restoredChannel),
    );
    if (await shouldAutoDownloadAndInstallUpdates(autoUpdaterSettingService)) {
      downloadAvailableUpdate("restored-pending-install");
    }
    return;
  }

  if (menuState.kind !== "update-downloaded" || !readyUpdateVersion) {
    // renderer 可能因为旧 UpdateReady 缓存残留而展示“重启以更新”，
    // 但 main 在 staging error 后已经清掉 ready。此时不能再执行退出准备或调用
    // quitAndInstall，否则会杀掉 host 进程却没有安装器接管，表现成按钮没反应。
    logger.warn(`[auto-update] ignore quitAndInstall request: state=${menuState.kind}`);
    if (rejectUnavailable) {
      throw new Error(`Update is not ready to install: state=${menuState.kind}`);
    }
    return;
  }

  if (quitAndInstallInFlight) {
    logger.info("[auto-update] quitAndInstall already in flight");
    return;
  }
  quitAndInstallInFlight = true;
  logger.info("[auto-update] user requested quit and install");
  // macOS 上 quitAndInstall() 在关窗前不会先走 app.before-quit。
  // 如果仍然只靠 before-quit 去放行窗口 close，现有的“红绿灯关闭=隐藏窗口”逻辑会把退出拦住，
  // 表现成点击更新后界面消失但进程没退、安装流程也不再继续。
  // 这里先通知主进程进入“允许真正关窗”的状态，再把控制权交给 updater。
  try {
    // Windows 更新会替换 resources/glm 等随包资源；
    // 若 quitAndInstall 先于 host/agent 子进程完成退出，安装器可能在文件仍被占用时开始覆盖，
    // 最终留下“应用能启动但 bundled agent 丢失”的半更新状态。
    // 这里显式等待主进程完成退出准备，再进入安装器，尽量把资源替换和子进程回收时序拉直。
    await onBeforeQuitAndInstall?.();
  } catch (error) {
    // 安装前退出准备是释放 host/agent 与 resources/glm 文件锁的硬前置条件。
    // 如果这里失败后仍启动安装器，Windows 可能在资源仍被占用时覆盖安装目录，形成半更新。
    quitAndInstallInFlight = false;
    handleAutoUpdateFailure(error, "prepare quit and install failed");
    if (rejectUnavailable) {
      throw error;
    }
    return;
  }

  try {
    if (shouldRelaunchForDevAutoUpdateInstall()) {
      // 开发态只用于验证服务端 manifest、下载进度和安装入口 UI 闭环，
      // 未打包应用没有可被安装器接管的真实发布包上下文。这里改为重启当前 dev app，
      // 避免点击“重启以更新”执行退出准备后停在无响应状态。
      logger.info("[auto-update] dev update install fallback: relaunch app");
      app.relaunch();
      app.exit(0);
      return;
    }

    // 3.3.0 的 Windows 自定义 PowerShell delayed launcher 在 detached/hidden
    // 模式下可能只创建 powershell.exe，却没有稳定执行到安装器启动，用户看到应用关闭但版本不变。
    // 这里恢复 electron-updater 原生安装入口，避免把“launcher 进程创建成功”误当成更新已接管。
    autoUpdater.quitAndInstall();
  } finally {
    quitAndInstallInFlight = false;
  }
}

function updateMenuItemLabel(label: string, enabled: boolean) {
  const menu = Menu.getApplicationMenu();
  const item = menu?.getMenuItemById(CHECK_FOR_UPDATE_MENU_ID);
  if (item) {
    item.label = label;
    item.enabled = enabled;
  }
}

function getMenuItemLabel(state: AutoUpdaterMenuState): string {
  switch (state.kind) {
    case "checking":
      return getDesktopMenuMessage(menuLocale, desktopMenuMessageIds.helpCheckingForUpdates);
    case "update-available":
      return formatDesktopMenuMessage(
        menuLocale,
        desktopMenuMessageIds.helpUpdateAvailableVersion,
        { version: state.version },
      );
    case "download-progress":
      return formatDesktopMenuMessage(
        menuLocale,
        desktopMenuMessageIds.helpDownloadingUpdateProgress,
        { progress: state.progress },
      );
    case "update-downloaded":
      return formatDesktopMenuMessage(menuLocale, desktopMenuMessageIds.helpRestartToUpdate, {
        version: state.version,
      });
    case "idle":
    default:
      return getDesktopMenuMessage(menuLocale, desktopMenuMessageIds.helpCheckForUpdates);
  }
}

function syncMenuItemState() {
  updateMenuItemLabel(getMenuItemLabel(menuState), menuState.enabled);
}

function isSameAutoUpdaterMenuState(left: AutoUpdaterMenuState, right: AutoUpdaterMenuState) {
  if (left.kind !== right.kind || left.enabled !== right.enabled) {
    return false;
  }

  switch (left.kind) {
    case "update-available":
      return (
        right.kind === left.kind &&
        right.version === left.version &&
        right.channel === left.channel &&
        JSON.stringify(right.releaseNotes ?? null) === JSON.stringify(left.releaseNotes ?? null)
      );
    case "update-downloaded":
      return (
        right.kind === left.kind &&
        right.version === left.version &&
        right.channel === left.channel &&
        JSON.stringify(right.releaseNotes ?? null) === JSON.stringify(left.releaseNotes ?? null)
      );
    case "download-progress":
      return (
        right.kind === left.kind &&
        right.progress === left.progress &&
        right.version === left.version &&
        right.channel === left.channel &&
        JSON.stringify(right.releaseNotes ?? null) === JSON.stringify(left.releaseNotes ?? null)
      );
    case "idle":
      // idle 也带内容（已应用通道 + 「回不到正式版」的事实），不能像 checking 那样无条件判等 ——
      // 否则两条内容不同的 idle 之间不会广播，设置页会停在旧结论上。
      return (
        right.kind === left.kind &&
        right.channel === left.channel &&
        JSON.stringify(right.upToDateNotice ?? null) ===
          JSON.stringify(left.upToDateNotice ?? null)
      );
    case "checking":
    default:
      return true;
  }
}

function broadcastAutoUpdaterState() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(PlatformChannels.UpdateStateChanged, menuState);
    }
  }
}

export function onAutoUpdaterStateChanged(listener: (state: UpdateStatePayload) => void) {
  autoUpdaterStateListeners.add(listener);
  return () => {
    autoUpdaterStateListeners.delete(listener);
  };
}

function setAutoUpdaterMenuState(nextState: AutoUpdaterMenuState) {
  if (isSameAutoUpdaterMenuState(menuState, nextState)) {
    return;
  }

  menuState = nextState;
  syncMenuItemState();
  broadcastAutoUpdaterState();
  for (const listener of autoUpdaterStateListeners) {
    listener(menuState);
  }

  // 单一收口点：状态每离开「下载中 / 已就绪」一次，就尝试把拨开关时记下的待应用通道落地。
  // 放在这里而不是逐条恢复分支里，是为了不漏任何一条恢复路径（下载失败、取消、跳过、
  // 就绪被放弃…）—— 漏一条就等于静默吞掉一次拨动。阻塞中（含检查在飞）时本调用是无害 no-op。
  tryApplyPendingReleaseChannelRefresh("menu state settled");
}

function findLiveWindowByWebContentsId(webContentsId: number | null) {
  if (webContentsId == null) {
    return null;
  }

  return (
    BrowserWindow.getAllWindows().find(
      (win) => !win.isDestroyed() && win.webContents.id === webContentsId,
    ) ?? null
  );
}

function deriveReleaseNotesTitle(markdown: string, version: string) {
  const firstHeading = markdown
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("# ") && line.length > 2);

  return firstHeading ? firstHeading.slice(2).trim() : `Release v${version}`;
}

function normalizeReleaseNotesMarkdown(
  releaseNotes: UpdateDownloadedInfoLike["releaseNotes"],
): string | null {
  if (typeof releaseNotes === "string") {
    const markdown = releaseNotes.trim();
    return markdown === "" ? null : markdown;
  }

  if (!Array.isArray(releaseNotes)) {
    return null;
  }

  const markdown = releaseNotes
    .map((item) => (typeof item?.note === "string" ? item.note.trim() : ""))
    .filter((item) => item.length > 0)
    .join("\n\n")
    .trim();

  return markdown === "" ? null : markdown;
}

function normalizeLocalizedReleaseNotes(
  version: string,
  releaseNotesByLocale: UpdateDownloadedInfoLike["releaseNotesByLocale"],
): PostUpdateReleaseNotesPayload["releaseNotesByLocale"] | undefined {
  const localized: PostUpdateReleaseNotesPayload["releaseNotesByLocale"] = {};
  if (!releaseNotesByLocale || typeof releaseNotesByLocale !== "object") {
    return undefined;
  }

  for (const locale of ["zh-CN", "en-US"] as const) {
    const entry = releaseNotesByLocale[locale];
    if (!entry) {
      continue;
    }

    const markdown =
      typeof entry === "string"
        ? normalizeReleaseNotesMarkdown(entry)
        : normalizeReleaseNotesMarkdown(entry.markdown ?? entry.releaseNotes);
    if (!markdown) {
      continue;
    }

    localized[locale] = {
      title:
        typeof entry === "object" && entry.title?.trim()
          ? entry.title.trim()
          : deriveReleaseNotesTitle(markdown, version),
      markdown,
    };
  }

  return Object.keys(localized).length > 0 ? localized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function redactUpdateFeedUrlForLog(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    if (url.search) {
      url.search = "?<redacted>";
    }
    url.hash = "";
    return url.toString();
  } catch {
    return "<invalid-url>";
  }
}

function readSwitchValue(argv: readonly string[], switchName: string): string | undefined {
  const equalsPrefix = `${switchName}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (arg.startsWith(equalsPrefix)) {
      return arg.slice(equalsPrefix.length).trim() || undefined;
    }
    if (arg === switchName) {
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        return next.trim() || undefined;
      }
      return undefined;
    }
  }
  return undefined;
}

export function resolveUpdateFeedSourceFromStartupConfig(
  options: {
    argv?: readonly string[];
    env?: Record<string, string | undefined>;
  } = {},
): RuntimeUpdateFeedSource | undefined {
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;
  const feedUrl = readSwitchValue(argv, UPDATE_FEED_URL_SWITCH) ?? env[UPDATE_FEED_URL_ENV]?.trim();
  if (!feedUrl) {
    return undefined;
  }
  // 更新源覆盖仅供开发构建联调;正式包按 isPackaged 忽略,避免更新请求被环境变量/启动参数改道
  if (app.isPackaged) {
    logger.warn(
      `[auto-update] ignore update feed override in packaged app: ${redactUpdateFeedUrlForLog(feedUrl)}`,
    );
    return undefined;
  }
  return { url: feedUrl };
}

async function resolveUpdateReleaseChannel(
  settingService: SettingServiceLike | undefined,
): Promise<ElectronReleaseChannel> {
  if (!settingService) {
    return "stable";
  }

  try {
    const settings = await settingService.get();
    return settings.receivePreviewUpdates === true ? "preview" : "stable";
  } catch (error) {
    logger.warn("[auto-update] read preview update setting failed:", error);
    return "stable";
  }
}

async function syncAutoUpdateCheckChannelFromSettings(
  checkId: number,
  settingService: SettingServiceLike | undefined,
  reason: string,
): Promise<void> {
  const nextChannel = await resolveUpdateReleaseChannel(settingService);
  if (activeAutoUpdateCheckId !== checkId) {
    return;
  }

  if (availableUpdateChannel !== nextChannel) {
    logger.info(
      `[auto-update] ${reason}: check channel ${availableUpdateChannel} -> ${nextChannel}`,
    );
  }
  // 通道已由 applyAutoUpdaterReleaseChannelConfig 在 check 之前落到 electron-updater 上；
  // 这里把簿记通道对齐到设置值，让本次结果被标成**正确的**通道（update-available 的
  // channel 标注与 skippedElectronUpdateVersions 分键都取它）。冷启动若不在此对齐，
  // 首次检查仍用默认 stable 作簿记，preview 结果会被标成 stable。
  availableUpdateChannel = nextChannel;
}

/**
 * 把「通道」应用到 electron-updater 的取清单配置上。
 *
 * **初始化和拨开关两条路径都必须调它，且都在 `checkForUpdates()` 之前调** ——
 * 只改设置或只清缓存都不足以让开关生效（见下）。
 *
 * ⚠️ `allowPrerelease` 与 `channel` 必须**成对**切换，单独改任一个都会弄坏一条通道：
 *
 * - **预览** ⇒ `allowPrerelease=true` + `channel="preview"`。
 *   只置 `allowPrerelease=true` 时，GitHubProvider 在 `channel` 与版本 prerelease 段
 *   都为 null 的前提下会取 atom feed 的**第一条且完全不筛**（GitHubProvider.js:53-56）。
 *   仓库里 `dev` 滚动预发布每次 delete+recreate、时间最新 ⇒ 极可能就是第一条 ⇒ 去它上面
 *   要 `latest*.yml`，而它刻意不传 ⇒ 回退仍落在同一 tag ⇒ 抛
 *   `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`，**预览通道整体坏掉**。
 *   置 `channel="preview"` 后，选择循环（GitHubProvider.js:58-82）按「tag 的 prerelease
 *   标识 === 当前通道」筛选，`dev`（`semver.prerelease("dev")` 为 null）被跳过。
 *   注意：标识必须恰为 `preview`，文件名与标识字符串绑定（事实 1 的回退前提）。
 *
 * - **稳定** ⇒ `allowPrerelease=false` + `channel=null`（`channel` getter 为
 *   `updater.channel || options.channel`，置 null 即回默认 `latest*.yml`）。
 *   若残留 `channel="preview"`，GitHubProvider 的 else 分支会去**正式版** Release 上要
 *   `preview-mac.yml` ⇒ 404，且此时**不许回退** ⇒ **把稳定通道弄坏**。
 *
 * `setFeedURL` 一并放这里：它重建 provider（`clientPromise`），与通道配置同批生效，
 * 避免 feed 与通道来自不同批次的错配。
 * 通道应用后**显式**把 `allowDowngrade` 关掉（成因见函数体内注释）：不依赖降级回正式版，
 * 因为 mac Squirrel 的降级支持不完整、很可能静默不生效。
 */
function applyAutoUpdaterReleaseChannelConfig(channel: ElectronReleaseChannel): void {
  // 离线裁剪版:更新源从 ZCode 平台 manifest({endpoint}/api/v1/releases/electron/manifest)
  // 切换到 GitHub Releases。**Windows 与 macOS 都走 electron-updater 完整自动更新**
  // （mac 自 398fc33 起支持；这里配的 provider 就是它的更新源，不只是版本检查元数据）。
  // 只有 DR 探测失败（未签名包，Squirrel 起不来）时 macOS 才退化为打开发布页 ——
  // 分支在 checkForUpdateMenuClick 里消费 inAppAutoUpdateAvailable，判定见 autoUpdatePolicy。
  autoUpdater.setFeedURL({
    provider: "github",
    owner: GITHUB_UPDATE_OWNER,
    repo: GITHUB_UPDATE_REPO,
  });
  const isPreview = channel === "preview";
  autoUpdater.allowPrerelease = isPreview;
  autoUpdater.channel = isPreview ? "preview" : null;
  // electron-updater 的 channel setter 有副作用：只要赋一次值（**包括赋 null**）就把
  // allowDowngrade 置 true（node_modules/electron-updater/out/AppUpdater.js:28-46 的
  // `set channel`）。这里显式关掉，**不依赖降级**：
  // mac 的 Squirrel 对降级支持并不完整，依赖它很可能**静默不生效** —— 那就成了
  // 「用户以为回到了正式版、其实没有」。宁可不降级、并把状态显示清楚（见 buildUpToDateNotice
  // 与设置页/更新弹窗的通道说明），也不要一个可能不生效的降级。
  // 版本序回到正式版仍由 `-preview.N < X.Y.Z` 的 semver 排序负责（正式版号一追上就自动升级）。
  autoUpdater.allowDowngrade = false;
  logger.info(
    `[auto-update] release channel applied platform=${getElectronReleasePlatform()} repo=${GITHUB_UPDATE_OWNER}/${GITHUB_UPDATE_REPO} channel=${channel} prerelease=${isPreview}`,
  );
}

async function applyGitHubUpdateProvider(options: InitAutoUpdaterOptions): Promise<void> {
  // 冷启动：先从设置解析通道，再统一应用。await 由 initAutoUpdater 保证 —— 通道必须先于
  // 首次 checkForUpdates 落地，否则首次检查仍用默认值（stable、不看 prerelease），开关形同虚设。
  applyAutoUpdaterReleaseChannelConfig(await resolveUpdateReleaseChannel(options.settingService));
}

function pickFallbackReleaseNotesMarkdown(
  localized: PostUpdateReleaseNotesPayload["releaseNotesByLocale"] | undefined,
): string | null {
  return (
    localized?.[menuLocale]?.markdown ??
    localized?.["zh-CN"]?.markdown ??
    localized?.["en-US"]?.markdown ??
    null
  );
}

function normalizeReleaseDate(
  releaseDate: UpdateDownloadedInfoLike["releaseDate"],
): string | undefined {
  if (releaseDate instanceof Date && !Number.isNaN(releaseDate.getTime())) {
    return releaseDate.toISOString();
  }
  if (typeof releaseDate !== "string") {
    return undefined;
  }
  const trimmed = releaseDate.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toPostUpdateReleaseNotesPayload(
  info: UpdateDownloadedInfoLike,
): PostUpdateReleaseNotesPayload | null {
  const releaseNotesByLocale = normalizeLocalizedReleaseNotes(
    info.version,
    info.releaseNotesByLocale,
  );
  const markdown =
    normalizeReleaseNotesMarkdown(info.releaseNotes) ??
    pickFallbackReleaseNotesMarkdown(releaseNotesByLocale);
  if (!markdown) {
    return null;
  }

  const title = info.releaseName?.trim() || deriveReleaseNotesTitle(markdown, info.version);
  const releaseDate = normalizeReleaseDate(info.releaseDate);
  return {
    version: info.version,
    title,
    markdown,
    ...(releaseDate ? { releaseDate } : {}),
    ...(releaseNotesByLocale ? { releaseNotesByLocale } : {}),
  };
}

async function persistPendingPostUpdateReleaseNotes(
  settingService: SettingServiceLike,
  payload: PostUpdateReleaseNotesPayload,
  reason: string,
) {
  if (acknowledgedPostUpdateReleaseNotesVersions.has(payload.version)) {
    logger.info(
      `[auto-update] skip persisting acknowledged post-update release notes (${reason}) version=${payload.version}`,
    );
    return;
  }

  await settingService.update({ pendingPostUpdateReleaseNotes: payload });
  pendingPostUpdateReleaseNotes = payload;
  deliveredPostUpdateReleaseNotesWebContentsId = null;
  logger.info(
    `[auto-update] persisted post-update release notes (${reason}) version=${payload.version}`,
  );
}

/**
 * 待展示说明里的 version 来自「已下载的安装包」；当前进程版本在安装完成前仍可能是旧版，
 * 此时待展示版本高于当前运行版本属于正常中间态，不能丢弃。
 * 若用户跳过自动更新链路（官网安装包等）直接升到更高版本，磁盘里可能仍残留更早一次下载写入的 pending，
 * 此时待展示版本低于已安装版本，应在启动时丢弃，否则会弹出旧版更新说明。
 */
function shouldDiscardStalePendingReleaseNotes(
  pendingVersion: string,
  appVersion: string,
): boolean {
  const pending = pendingVersion.trim();
  const current = appVersion.trim();
  if (pending === current) {
    return false;
  }

  const pendingCoerced = semver.valid(semver.coerce(pending));
  const appCoerced = semver.valid(semver.coerce(current));
  if (!pendingCoerced || !appCoerced) {
    return false;
  }

  return semver.lt(pendingCoerced, appCoerced);
}

function isPendingReleaseNotesForFutureVersion(payload: PostUpdateReleaseNotesPayload): boolean {
  return isVersionGreaterThan(payload.version, getCurrentAppVersionForUpdate());
}

function isDevSquirrelReadyError(error: unknown): boolean {
  if (
    app.isPackaged ||
    !isDevAutoUpdateEnabled() ||
    process.platform !== "darwin" ||
    !isRecord(error)
  ) {
    return false;
  }

  return error.domain === "SQRLUpdaterErrorDomain" && error.code === 2;
}

async function clearPendingPostUpdateReleaseNotes(
  settingService: SettingServiceLike,
  reason: string,
) {
  if (!pendingPostUpdateReleaseNotes) {
    return;
  }

  const version = pendingPostUpdateReleaseNotes.version;
  await settingService.update({ pendingPostUpdateReleaseNotes: undefined });
  pendingPostUpdateReleaseNotes = null;
  deliveredPostUpdateReleaseNotesWebContentsId = null;
  logger.info(`[auto-update] cleared post-update release notes (${reason}) version=${version}`);
}

function sendManualCheckResult(payload: UpdateCheckResultPayload) {
  const webContentsId = manualCheckWebContentsId;
  if (webContentsId == null) return;
  manualCheckWebContentsId = null;

  const win = findLiveWindowByWebContentsId(webContentsId);
  if (!win) {
    logger.info(
      `[auto-update] manual check result dropped, target webContents ${webContentsId} gone`,
    );
    return;
  }
  logger.info(`[auto-update] manual check result → wc=${webContentsId}: ${payload.kind}`);
  win.webContents.send(PlatformChannels.UpdateCheckResult, payload);
}

function clearAvailableUpdateState() {
  availableUpdateReleaseNotes = null;
}

function clearDownloadingUpdateState() {
  downloadingUpdateVersion = null;
  downloadingUpdateReleaseNotes = null;
  downloadingUpdateChannel = null;
}

function clearReadyUpdateState() {
  readyUpdateVersion = null;
  readyUpdateReleaseNotes = null;
  readyUpdateChannel = null;
  readyUpdateRestoredFromPendingReleaseNotes = false;
}

function clearPersistedPostUpdateReleaseNotesForVersion(version: string, reason: string) {
  if (pendingPostUpdateReleaseNotes?.version === version) {
    pendingPostUpdateReleaseNotes = null;
    deliveredPostUpdateReleaseNotesWebContentsId = null;
  }

  const settingService = autoUpdaterSettingService;
  if (!settingService) {
    return;
  }

  void (async () => {
    try {
      const settings = await settingService.get();
      if (settings.pendingPostUpdateReleaseNotes?.version !== version) {
        return;
      }

      await settingService.update({ pendingPostUpdateReleaseNotes: undefined });
      logger.info(`[auto-update] cleared post-update release notes (${reason}) version=${version}`);
    } catch (error) {
      logger.warn(`[auto-update] clear post-update release notes (${reason}) failed:`, error);
    }
  })();
}

function isCancelledDownload(cancellationToken: CancellationToken, error: unknown): boolean {
  return (
    cancelledDownloadTokens.has(cancellationToken) ||
    (cancellationToken.cancelled && isDownloadCancellationError(error))
  );
}

function isDownloadCancellationError(error: unknown): boolean {
  return error instanceof Error && error.message === "cancelled";
}

function markCancelledDownload(cancellationToken: CancellationToken) {
  cancelledDownloadTokens.add(cancellationToken);
  pendingCancelledDownloadErrorCount += 1;
}

function shouldIgnoreCancelledDownloadError(error: unknown): boolean {
  if (pendingCancelledDownloadErrorCount <= 0 || !isDownloadCancellationError(error)) {
    return false;
  }

  pendingCancelledDownloadErrorCount -= 1;
  return true;
}

function handleAutoUpdateFailure(error: unknown, source: string) {
  const message = error instanceof Error ? error.message : String(error);
  const failedDownload =
    menuState.kind === "download-progress"
      ? {
          version: downloadingUpdateVersion ?? menuState.version,
          releaseNotes: downloadingUpdateReleaseNotes ?? menuState.releaseNotes ?? null,
          channel: downloadingUpdateChannel ?? menuState.channel ?? availableUpdateChannel,
        }
      : downloadCancellationToken && downloadingUpdateVersion
        ? {
            version: downloadingUpdateVersion,
            releaseNotes: downloadingUpdateReleaseNotes ?? null,
            channel: downloadingUpdateChannel ?? availableUpdateChannel,
          }
        : null;
  if (
    menuState.kind === "update-downloaded" &&
    readyUpdateVersion &&
    isDevSquirrelReadyError(error)
  ) {
    // 开发态验证真实测试环境 manifest 时，macOS Squirrel 仍可能在
    // update-downloaded 后补一个 code=2 staging 错误。生产包必须清掉失败的 ready，
    // 但开发态需要保留 ready 状态来验证“重启以更新”交互闭环。
    logger.warn(
      `[auto-update] ignore dev Squirrel ready error after ${source} version=${readyUpdateVersion}: ${message}`,
    );
    setAutoUpdaterMenuState(buildUpdateDownloadedState(readyUpdateVersion));
    return;
  }

  logger.error(`[auto-update] ${source}:`, error);
  if (menuState.kind === "update-downloaded" && readyUpdateVersion) {
    const failedReadyVersion = readyUpdateVersion;
    // macOS Squirrel 可能在 update-downloaded 后才发现包无法 stage。
    // 如果继续保留 ready 缓存，renderer 会一直展示“重启以更新”，再次点击只会调用一个已失败的安装上下文。
    clearReadyUpdateState();
    clearPersistedPostUpdateReleaseNotesForVersion(
      failedReadyVersion,
      `${source}-after-ready-error`,
    );
    logger.info(`[auto-update] cleared ready update after ${source} version=${failedReadyVersion}`);
  }
  clearAvailableUpdateState();
  clearDownloadingUpdateState();
  if (failedDownload?.version && !readyUpdateVersion && !activeForceAutoUpdateListener) {
    // 用户点击“下载更新”后如果下载启动或 staging 很快失败，
    // 清空 available/downloading 并广播 idle 会让 renderer 入口和弹窗同时消失。
    // 失败并不等同于用户跳过该版本，应退回“发现更新”状态，让用户能看到并重试下载。
    availableUpdateReleaseNotes = failedDownload.releaseNotes;
    availableUpdateChannel = failedDownload.channel;
    setAutoUpdaterMenuState(
      buildUpdateAvailableState(
        failedDownload.version,
        failedDownload.releaseNotes,
        failedDownload.channel,
      ),
    );
  } else {
    setAutoUpdaterMenuState(
      readyUpdateVersion
        ? buildUpdateDownloadedState(readyUpdateVersion)
        : { kind: "idle", enabled: true },
    );
  }
  notifyForceAutoUpdate({ kind: "error", message });
  sendManualCheckResult({ kind: "error", message });
}

async function isSkippedUpdateVersion(
  version: string,
  channel: ElectronReleaseChannel,
  settingService: SettingServiceLike | undefined,
): Promise<boolean> {
  if (!settingService || activeForceAutoUpdateListener) {
    return false;
  }

  // 用户手动检查更新代表重新关注被跳过的版本。
  // 即使持久化清理还没落盘，这一轮也不能继续把同版本更新当作 up-to-date 隐藏掉。
  if (manualCheckWebContentsId != null) {
    return false;
  }

  try {
    const settings = await settingService.get();
    return settings.skippedElectronUpdateVersions?.[channel]?.trim() === version.trim();
  } catch (error) {
    logger.warn("[auto-update] read skipped update version failed:", error);
    return false;
  }
}

async function shouldAutoDownloadAndInstallUpdates(
  settingService: SettingServiceLike | undefined,
): Promise<boolean> {
  if (!settingService) {
    return false;
  }

  try {
    return (await settingService.get()).autoDownloadAndInstallUpdates === true;
  } catch (error) {
    logger.warn("[auto-update] read auto download preference failed:", error);
    return false;
  }
}

async function skipAvailableUpdateVersion(
  version: string,
  settingService: SettingServiceLike | undefined,
): Promise<void> {
  if (activeForceAutoUpdateListener) {
    logger.info(`[auto-update] ignore skip version=${version}: force update active`);
    return;
  }

  if (
    (menuState.kind !== "update-available" && menuState.kind !== "download-progress") ||
    menuState.version !== version
  ) {
    logger.info(`[auto-update] ignore skip version=${version}: state=${menuState.kind}`);
    return;
  }

  const channel =
    menuState.channel ??
    (menuState.kind === "download-progress" ? downloadingUpdateChannel : availableUpdateChannel) ??
    availableUpdateChannel;
  if (downloadCancellationToken) {
    markCancelledDownload(downloadCancellationToken);
    downloadCancellationToken.cancel();
    logger.info(
      `[auto-update] skipped downloading version; cancel active download channel=${channel} version=${version}`,
    );
  }

  // 下载态弹窗仍需要允许用户跳过当前版本。
  // 如果 main 只接受 update-available，UI 中点击“跳过此版本”会变成 no-op；
  // 这里在持久化跳过前取消当前下载，并清理下载态，避免后台继续拉取已跳过版本。
  clearAvailableUpdateState();
  clearDownloadingUpdateState();
  setAutoUpdaterMenuState(
    readyUpdateVersion
      ? buildUpdateDownloadedState(readyUpdateVersion)
      : { kind: "idle", enabled: true },
  );

  if (!settingService) {
    logger.warn(
      `[auto-update] skipped version not persisted because setting service is missing version=${version}`,
    );
    return;
  }

  try {
    const settings = await settingService.get();
    await settingService.update({
      skippedElectronUpdateVersions: {
        ...settings.skippedElectronUpdateVersions,
        [channel]: version,
      },
    });
    logger.info(`[auto-update] skipped version persisted channel=${channel} version=${version}`);
  } catch (error) {
    logger.error("[auto-update] persist skipped update version failed:", error);
  }
}

async function clearSkippedUpdateVersionForManualCheck(
  channel: ElectronReleaseChannel,
  settingService: SettingServiceLike | undefined,
): Promise<void> {
  if (!settingService) {
    return;
  }

  try {
    const settings = await settingService.get();
    const skippedVersions = settings.skippedElectronUpdateVersions;
    const skippedVersion = skippedVersions?.[channel]?.trim();
    if (!skippedVersion) {
      return;
    }

    const nextSkippedVersions = { ...skippedVersions };
    delete nextSkippedVersions[channel];
    await settingService.update({
      skippedElectronUpdateVersions: nextSkippedVersions,
    });
    logger.info(
      `[auto-update] manual check cleared skipped update channel=${channel} version=${skippedVersion}`,
    );
  } catch (error) {
    logger.warn("[auto-update] clear skipped update version failed:", error);
  }
}

/**
 * 切换通道时清掉「按通道分键」的跳过版本记录。
 *
 * 理由：`skippedElectronUpdateVersions` 按 `stable | preview` 分键（validationAppSettings.ts）。
 * 不清就会把**旧通道**里被跳过的版本带到**新通道**上继续压制 —— 用户在预览通道跳过过
 * `3.17.0-preview.1`，切回稳定后同一串版本仍会被当成「已跳过」，表现为切换后莫名收不到更新。
 * 通道切换等于重新关注版本流，故两个键一起清。
 */
function clearSkippedUpdateVersionsForChannelSwitch(reason: string): void {
  const settingService = autoUpdaterSettingService;
  if (!settingService) {
    return;
  }

  void (async () => {
    try {
      const settings = await settingService.get();
      const skippedVersions = settings.skippedElectronUpdateVersions;
      if (!skippedVersions || Object.keys(skippedVersions).length === 0) {
        return;
      }

      await settingService.update({ skippedElectronUpdateVersions: {} });
      logger.info(`[auto-update] cleared skipped update versions on channel switch (${reason})`);
    } catch (error) {
      logger.warn(
        `[auto-update] clear skipped update versions on channel switch (${reason}) failed:`,
        error,
      );
    }
  })();
}

function downloadAvailableUpdate(reason = "renderer") {
  if (!canUseAutoUpdaterInCurrentRuntime()) {
    logger.info(`[auto-update] skip ${reason} download: not packaged`);
    return;
  }

  if (menuState.kind === "update-downloaded") {
    logger.info(`[auto-update] skip ${reason} download: update already ready`);
    return;
  }

  if (menuState.kind === "download-progress") {
    logger.info(`[auto-update] skip ${reason} download: download already in progress`);
    return;
  }

  if (downloadCancellationToken) {
    logger.info(`[auto-update] skip ${reason} download: download already requested`);
    return;
  }

  if (menuState.kind !== "update-available") {
    logger.info(`[auto-update] skip ${reason} download: state=${menuState.kind}`);
    return;
  }

  downloadingUpdateVersion = menuState.version;
  downloadingUpdateReleaseNotes = menuState.releaseNotes ?? availableUpdateReleaseNotes;
  downloadingUpdateChannel = menuState.channel ?? availableUpdateChannel;
  // electron-updater 如果命中本地已下载缓存，会在 downloadUpdate() 内直接触发
  // update-downloaded。这里不能先广播 0% 下载态，否则用户会先看到“下载中”，
  // 再跳到“已下载”；真实下载态改由第一条 download-progress 事件驱动。
  notifyForceAutoUpdate({
    kind: "downloading",
    version: downloadingUpdateVersion,
    progress: "0",
  });

  const cancellationToken = new CancellationToken();
  downloadCancellationToken = cancellationToken;
  void autoUpdater
    .downloadUpdate(cancellationToken)
    .catch((error) => {
      if (isCancelledDownload(cancellationToken, error)) {
        logger.info(`[auto-update] ${reason} download cancelled`);
        return;
      }
      // 下载由用户点击或强更 gate 显式触发，Promise reject 也必须立即反馈。
      // 不能只依赖 electron-updater 后续是否额外触发 error 事件，否则 UI 会卡在下载态。
      handleAutoUpdateFailure(error, "download update failed");
    })
    .finally(() => {
      if (downloadCancellationToken === cancellationToken) {
        downloadCancellationToken = null;
      }
      cancellationToken.dispose();
    });
}

function cancelDownloadingUpdate(reason = "renderer") {
  if (activeForceAutoUpdateListener) {
    logger.info(`[auto-update] skip ${reason} cancel download: force update active`);
    return;
  }

  if (menuState.kind !== "download-progress" || !downloadCancellationToken) {
    logger.info(`[auto-update] skip ${reason} cancel download: state=${menuState.kind}`);
    return;
  }

  const version = downloadingUpdateVersion;
  const releaseNotes = downloadingUpdateReleaseNotes;
  const channel = downloadingUpdateChannel ?? availableUpdateChannel;
  const cancellationToken = downloadCancellationToken;
  markCancelledDownload(cancellationToken);
  cancellationToken.cancel();
  logger.info(
    `[auto-update] ${reason}: cancel download channel=${channel} version=${version ?? "unknown"}`,
  );

  // 取消下载不是跳过版本，只回退到发现更新状态，保留同一份 manifest 信息让用户可以稍后重试。
  clearDownloadingUpdateState();
  if (version) {
    availableUpdateReleaseNotes = releaseNotes;
    availableUpdateChannel = channel;
    setAutoUpdaterMenuState(buildUpdateAvailableState(version, releaseNotes, channel));
    return;
  }

  setAutoUpdaterMenuState(
    readyUpdateVersion
      ? buildUpdateDownloadedState(readyUpdateVersion)
      : { kind: "idle", enabled: true },
  );
}

export function setAutoUpdaterMenuLocale(locale: Locale) {
  menuLocale = locale;

  // 检查更新菜单项会被 updater 的异步状态流反复改写。
  // 如果只在创建菜单时翻译一次，后续 checking/downloading 阶段又会退回英文。
  // 这里把 locale 和当前 updater 状态一起保存，确保每次重建菜单或切语言后都能按最新状态重新渲染。
  syncMenuItemState();
}

export async function hydratePendingPostUpdateReleaseNotes(settingService: SettingServiceLike) {
  const settings = await settingService.get();
  pendingPostUpdateReleaseNotes = settings.pendingPostUpdateReleaseNotes ?? null;
  deliveredPostUpdateReleaseNotesWebContentsId = null;

  if (pendingPostUpdateReleaseNotes) {
    logger.info(
      `[auto-update] hydrated pending post-update release notes version=${pendingPostUpdateReleaseNotes.version}`,
    );
  }

  if (
    pendingPostUpdateReleaseNotes &&
    shouldDiscardStalePendingReleaseNotes(
      pendingPostUpdateReleaseNotes.version,
      getCurrentAppVersionForUpdate(),
    )
  ) {
    logger.info(
      `[auto-update] discard stale post-update release notes pending=${pendingPostUpdateReleaseNotes.version} app=${getCurrentAppVersionForUpdate()}`,
    );
    await clearPendingPostUpdateReleaseNotes(
      settingService,
      "hydrate-pending-older-than-installed-app",
    );
  }

  if (
    pendingPostUpdateReleaseNotes &&
    isPendingReleaseNotesForFutureVersion(pendingPostUpdateReleaseNotes)
  ) {
    // 用户下载完成但尚未安装时重启应用，electron-updater 的内存 ready 状态会丢失，
    // 但本地 pending 包和版本说明仍在。这里用“pending 版本高于当前版本”恢复待安装状态，
    // 避免已有缓存时仍提示“下载更新”，点击后又被 dev staging 错误打回 idle。
    readyUpdateVersion = pendingPostUpdateReleaseNotes.version;
    readyUpdateReleaseNotes = pendingPostUpdateReleaseNotes;
    readyUpdateRestoredFromPendingReleaseNotes = true;
    setAutoUpdaterMenuState(buildUpdateDownloadedState(readyUpdateVersion));
    logger.info(
      `[auto-update] restored ready update from pending release notes version=${readyUpdateVersion}`,
    );
  }
}

export function syncReadyUpdateToWindow(win: BrowserWindow) {
  if (!readyUpdateVersion || win.isDestroyed()) {
    return;
  }

  // update-downloaded 可能发生在 renderer React effect 还没挂好之前，
  // 甚至发生在窗口 reload / 新开窗口之前。这里把“已有可安装更新”视为一份持久状态，
  // 在窗口后续就绪时补发一次，避免按钮只靠那次瞬时事件而丢失。
  logger.info(
    `[auto-update] sync ready update to window ${win.webContents.id}: ${readyUpdateVersion}`,
  );
  win.webContents.send(PlatformChannels.UpdateReady, readyUpdateVersion);
}

export function getAutoUpdaterState(): UpdateStatePayload {
  return menuState;
}

export function refreshAutoUpdaterReleaseChannel(
  receivePreviewUpdates: boolean,
  reason = "settings receivePreviewUpdates changed",
) {
  const nextChannel: ElectronReleaseChannel = receivePreviewUpdates ? "preview" : "stable";

  if (!canUseAutoUpdaterInCurrentRuntime()) {
    logger.info(`[auto-update] skip ${reason}: not packaged`);
    return;
  }

  if (isReleaseChannelChangeBlocked()) {
    // 用户可能在**启动检查尚未完成**、**正在下载**或**已下载待安装**时切换 preview 开关。
    // 此刻不能安全落地（原因见 isReleaseChannelChangeBlocked），但**不能静默丢弃**这次拨动 ——
    // 那会让界面开关变了、通道却永远不换，与「开启后将最快体验」的当下时态矛盾。
    // 这里只记录待应用通道，等阻塞解除后由 tryApplyPendingReleaseChannelRefresh 真正应用
    // （重设 allowPrerelease/channel + 清通道缓存），而不是只重跑一次 check。
    pendingReleaseChannelRefresh = nextChannel;
    logger.info(
      `[auto-update] defer ${reason}: state=${menuState.kind} inFlight=${checkForUpdatesInFlight}, next channel=${nextChannel}`,
    );
    return;
  }

  const currentChannel = getAutoUpdaterReleaseChannelForCurrentState();
  if (currentChannel === nextChannel) {
    logger.info(`[auto-update] skip ${reason}: channel unchanged (${nextChannel})`);
    return;
  }

  logger.info(`[auto-update] ${reason}: apply release channel ${currentChannel} -> ${nextChannel}`);
  // 拨开关立即生效的关键：成对重设 electron-updater 的通道配置（见
  // applyAutoUpdaterReleaseChannelConfig 的成因说明），再清掉通道相关缓存。
  applyAutoUpdaterReleaseChannelConfig(nextChannel);
  // availableUpdateChannel 必须跟着走：它是本次及后续检查结果的通道标注基准
  // （update-available 的 channel 字段、skippedElectronUpdateVersions 的分键都由它决定）。
  availableUpdateChannel = nextChannel;
  clearAvailableUpdateState();
  // 旧通道下已准备好的更新、以及按通道分键的跳过记录，都不属于新通道 ——
  // 不清就会把旧通道的版本标成新通道的版本（`refreshAutoUpdaterReleaseChannel` 注释承诺过、但此前没做）。
  clearReadyUpdateState();
  clearSkippedUpdateVersionsForChannelSwitch(reason);
  setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  const checkId = beginAutoUpdateCheck();
  autoUpdater
    .checkForUpdates()
    .catch((err) => {
      logger.error(`[auto-update] ${reason} check failed:`, err);
      setAutoUpdaterMenuState(
        readyUpdateVersion
          ? buildUpdateDownloadedState(readyUpdateVersion)
          : { kind: "idle", enabled: true },
      );
    })
    .finally(() => {
      finishAutoUpdateCheck(reason, checkId);
    });
}

export function syncAutoUpdaterStateToWindow(win: BrowserWindow) {
  if (win.isDestroyed()) {
    return;
  }

  win.webContents.send(PlatformChannels.UpdateStateChanged, menuState);
}

export function syncPostUpdateReleaseNotesToWindow(win: BrowserWindow) {
  if (!pendingPostUpdateReleaseNotes || win.isDestroyed()) {
    return;
  }

  if (isPendingReleaseNotesForFutureVersion(pendingPostUpdateReleaseNotes)) {
    // pending release notes 是下载完成时写入的；若版本仍高于当前 app，
    // 说明更新尚未安装，不能提前作为“安装后说明”发给 renderer 静默 ack。
    return;
  }

  const assignedWindow = findLiveWindowByWebContentsId(
    deliveredPostUpdateReleaseNotesWebContentsId,
  );
  if (assignedWindow && assignedWindow.webContents.id !== win.webContents.id) {
    return;
  }

  deliveredPostUpdateReleaseNotesWebContentsId = win.webContents.id;
  logger.info(
    `[auto-update] sync post-update release notes to window ${win.webContents.id}: ${pendingPostUpdateReleaseNotes.version}`,
  );
  win.webContents.send(PlatformChannels.PostUpdateReleaseNotes, pendingPostUpdateReleaseNotes);
}

export async function acknowledgePostUpdateReleaseNotes(
  version: string,
  settingService: SettingServiceLike,
) {
  if (!pendingPostUpdateReleaseNotes) {
    logger.info(
      `[auto-update] ignore release notes ack without pending payload version=${version}`,
    );
    return;
  }

  if (pendingPostUpdateReleaseNotes.version !== version) {
    logger.warn(
      `[auto-update] ignore release notes ack version mismatch expected=${pendingPostUpdateReleaseNotes.version} actual=${version}`,
    );
    return;
  }

  acknowledgedPostUpdateReleaseNotesVersions.add(version);
  await clearPendingPostUpdateReleaseNotes(settingService, "renderer-acknowledged");
}

export async function initAutoUpdater(options: InitAutoUpdaterOptions = {}): Promise<void> {
  if (options.enabled === false) {
    autoUpdaterDisabledForProductFlavor = true;
    if (autoUpdatePollTimer) {
      clearInterval(autoUpdatePollTimer);
      autoUpdatePollTimer = null;
    }
    logger.info("[auto-update] disabled for this desktop product flavor");
    return;
  }
  autoUpdaterDisabledForProductFlavor = false;
  if (!canUseAutoUpdaterInCurrentRuntime()) return;

  // 应用内更新不可用时（例如未签名/异常构建），入口必须回退到打开发布页，
  // 而不是「点了没反应」。该标志在 checkForUpdateMenuClick 里被消费。
  // darwin 需要问代码签名（Squirrel 能否初始化），故这一步是异步的。
  inAppAutoUpdateAvailable = shouldUseInAppAutoUpdate({
    platform: process.platform,
    isPackaged: app.isPackaged,
    devAutoUpdateEnabled: isDevAutoUpdateEnabled(),
    ...(process.platform === "darwin" && app.isPackaged
      ? {
          macHasDesignatedRequirement: await probeMacCodeSignature(
            resolveMacAppBundlePath(process.execPath),
          ),
        }
      : {}),
  });
  if (!inAppAutoUpdateAvailable) {
    logger.warn(
      "[auto-update] in-app update unavailable; manual check will open the releases page instead",
    );
  }

  onBeforeQuitAndInstall = options.onBeforeQuitAndInstall;
  if (options.locale) {
    menuLocale = options.locale;
  }
  autoUpdaterSettingService = options.settingService;

  if (autoUpdatePollTimer) {
    clearInterval(autoUpdatePollTimer);
    autoUpdatePollTimer = null;
  }
  checkForUpdatesInFlight = false;
  activeAutoUpdateCheckId = null;
  settlingAutoUpdateCheckId = null;
  pendingReleaseChannelRefresh = null;
  devAutoUpdateVersionOverride = null;
  availableUpdateChannel = "stable";
  clearAvailableUpdateState();
  clearDownloadingUpdateState();
  applyDevAutoUpdateRuntimeOverrides();

  logger.info(`[auto-update] initializing, current version: ${getCurrentAppVersionForUpdate()}`);

  // 已下载旧版本后，feed 继续推进到更高版本时，主进程必须先比较远端版本和 ready 版本，
  // 再决定是否下载。若继续让 electron-updater 自动下载，它只会按当前 app 版本判断，
  // 导致 `3.1.2` 已 ready `3.1.3` 时每次轮询都可能重复下载 `3.1.3`。
  autoUpdater.autoDownload = false;
  // Windows/NSIS 在窗口关闭后会异步启动安装；如果用户紧接着关机，安装器可能被系统中断，
  // 留下半更新状态并导致下次启动失败。
  // 这里仅在 Windows 关闭“退出即自动安装”，要求用户显式点更新；其他平台保持原有行为，避免改动既有升级链路。
  autoUpdater.autoInstallOnAppQuit = process.platform !== "win32";
  autoUpdater.logger = logger;
  // 必须先 await 完通道配置再注册/触发检查：否则首次 checkForUpdates 可能与
  // resolveUpdateReleaseChannel 的读取竞态，用默认 stable 值发请求（拨开关前的旧缺陷形态）。
  await applyGitHubUpdateProvider(options);

  const triggerCheckForUpdates = (reason: string) => {
    if (checkForUpdatesInFlight) {
      logger.info(`[auto-update] skip ${reason}: check already in flight`);
      return;
    }

    // 发布链路即使改成“安装包先、latest 后”，CDN 生效仍可能晚于客户端的轮询节奏。
    // 如果 checking / downloading 阶段继续并发触发 checkForUpdates，会把同一轮更新流重复拉起，
    // 造成无效请求、噪音日志，甚至把用户看到的菜单状态来回覆盖，所以自动轮询只在 idle 或
    // update-downloaded 态进入；后者继续轮询是为了发现取代已下载版本的新版本。
    if (reason === "poll" && !canPollForUpdatesFromState(menuState)) {
      logger.info(`[auto-update] skip ${reason}: state=${menuState.kind}`);
      return;
    }

    const checkId = beginAutoUpdateCheck();
    const checkForUpdatesPromise = options.settingService
      ? (async () => {
          await syncAutoUpdateCheckChannelFromSettings(checkId, options.settingService, reason);
          await autoUpdater.checkForUpdates();
        })()
      : autoUpdater.checkForUpdates();

    checkForUpdatesPromise
      .catch((err) => {
        // 强更弹窗可能复用启动期后台检查；如果 checkForUpdates 直接 reject 且没有后续 error 事件，
        // 只写日志会让弹窗停在 checking。这里复用失败收敛逻辑，把状态恢复并反馈给强更监听。
        handleAutoUpdateFailure(err, `${reason} check failed`);
      })
      .finally(() => {
        finishAutoUpdateCheck(reason, checkId);
      });
  };

  autoUpdater.on("checking-for-update", () => {
    logger.info("[auto-update] checking for update...");
    setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  });

  autoUpdater.on("update-available", (info: UpdateDownloadedInfoLike) => {
    logger.info(`[auto-update] new version available: ${info.version}`);

    void settleAutoUpdateCheckResult("update available", async () => {
      if (!shouldDownloadAvailableUpdate(info.version)) {
        const readyVersion = readyUpdateVersion ?? info.version;
        logger.info(
          `[auto-update] keep downloaded update version=${readyVersion}; remote=${info.version}`,
        );
        setAutoUpdaterMenuState(buildUpdateDownloadedState(readyVersion));
        sendManualCheckResult({ kind: "ready", version: readyVersion });
        return;
      }

      // GitHub provider 的 UpdateInfo 不带通道字段（旧平台 manifest 才能带，已废弃），
      // 所以通道标注只能取**本次检查所用的通道**：availableUpdateChannel 在 begin 时对齐
      // 设置值，且 isReleaseChannelChangeBlocked 保证检查在飞时不会改它 ⇒ 不存在
      // 「旧通道结果被标成新通道」的窗口，因此这里不需要（也没有可用的）per-response 通道标记。
      const channel = availableUpdateChannel;
      if (await isSkippedUpdateVersion(info.version, channel, options.settingService)) {
        logger.info(
          `[auto-update] ignore skipped update channel=${channel} version=${info.version}`,
        );
        clearAvailableUpdateState();
        setAutoUpdaterMenuState({ kind: "idle", enabled: true, channel });
        sendManualCheckResult({
          kind: "up-to-date",
          currentVersion: getCurrentAppVersionForUpdate(),
        });
        return;
      }

      availableUpdateReleaseNotes = toPostUpdateReleaseNotesPayload(info);
      if (readyUpdateRestoredFromPendingReleaseNotes) {
        // pendingPostUpdateReleaseNotes 只能证明“曾经下载完成并持久化了版本说明”，
        // 不能恢复当前进程里的 electron-updater downloadedUpdateHelper、Squirrel.Mac proxy server
        // 或 native staged update。遇到 manifest 再次确认同版本可用时必须清掉伪 ready，
        // 重新 downloadUpdate，让缓存命中/重新下载后的 update-downloaded 建立真实安装上下文。
        clearReadyUpdateState();
      }
      setAutoUpdaterMenuState(
        buildUpdateAvailableState(info.version, availableUpdateReleaseNotes, channel),
      );

      if (activeForceAutoUpdateListener) {
        downloadAvailableUpdate("force-update");
        return;
      }

      if (await shouldAutoDownloadAndInstallUpdates(options.settingService)) {
        // 功能原因：自动下载偏好属于 main 进程更新状态机，不能依赖 renderer 弹窗是否打开。
        // 检测到更新后复用手动下载入口，保持取消、缓存命中、失败恢复等行为完全一致。
        downloadAvailableUpdate("auto-download");
        return;
      }

      sendManualCheckResult({
        kind: "available",
        version: info.version,
        channel,
        ...(availableUpdateReleaseNotes ? { releaseNotes: availableUpdateReleaseNotes } : {}),
      });
    }).catch((error) => {
      handleAutoUpdateFailure(error, "update available failed");
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    void settleAutoUpdateCheckResult("update not available", () => {
      logger.info(
        `[auto-update] already up to date (local=${getCurrentAppVersionForUpdate()}, remote=${info.version})`,
      );
      if (readyUpdateVersion) {
        setAutoUpdaterMenuState(buildUpdateDownloadedState(readyUpdateVersion));
        sendManualCheckResult({ kind: "ready", version: readyUpdateVersion });
        return;
      }

      clearAvailableUpdateState();
      clearDownloadingUpdateState();
      // 「已是最新」有时会掩盖「回不到正式版」：装了预览版、关掉开关后，通道回到 stable，
      // 若最新的正式版号仍低于当前运行的预览版，electron-updater 因为不允许降级（见
      // applyAutoUpdaterReleaseChannelConfig）只会给出 not-available。把事实带给界面，
      // 让界面说清「暂时无法回到正式版，需要等正式版追上方可」，不得静默只显示「已是最新」。
      const upToDateNotice = buildUpToDateNotice(info.version);
      setAutoUpdaterMenuState({
        kind: "idle",
        enabled: true,
        channel: availableUpdateChannel,
        ...(upToDateNotice ? { upToDateNotice } : {}),
      });
      // 强制升级弹窗复用启动期检查时，也必须在无可用更新时给出闭环反馈，避免一直停在 checking。
      notifyForceAutoUpdate({
        kind: "error",
        message: getForceAutoUpdateNoUpdateMessage(),
      });
      sendManualCheckResult({
        kind: "up-to-date",
        currentVersion: getCurrentAppVersionForUpdate(),
        ...(upToDateNotice ? { upToDateNotice } : {}),
      });
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    // 用户快速取消下载后，electron-updater 可能还会补发旧下载流的 progress。
    // 如果继续接收这个陈旧事件，UI 会从“可更新”被重新推回“下载中”，看起来像取消后卡住。
    if (!downloadCancellationToken || downloadCancellationToken.cancelled) {
      return;
    }

    if (menuState.kind !== "download-progress" && menuState.kind !== "update-available") {
      return;
    }

    const normalizedProgress = normalizeProgressPercent(progress) ?? progress.percent.toFixed(0);
    logger.info(
      `[auto-update] download progress: ${progress.percent.toFixed(1)}% (${(progress.bytesPerSecond / 1024).toFixed(0)} KB/s, ${(progress.transferred / 1024 / 1024).toFixed(1)}/${(progress.total / 1024 / 1024).toFixed(1)} MB)`,
    );
    if (menuState.kind === "update-available") {
      clearAvailableUpdateState();
    }
    setAutoUpdaterMenuState(
      buildDownloadProgressState(normalizedProgress, {
        transferredBytes: progress.transferred,
        totalBytes: progress.total,
      }),
    );
    logForceAutoUpdateProgress(normalizedProgress);
    notifyForceAutoUpdate({
      kind: "downloading",
      ...(downloadingUpdateVersion ? { version: downloadingUpdateVersion } : {}),
      progress: normalizedProgress,
    });
  });

  autoUpdater.on("update-downloaded", (info: UpdateDownloadedInfoLike) => {
    readyUpdateVersion = info.version;
    readyUpdateRestoredFromPendingReleaseNotes = false;
    readyUpdateChannel = downloadingUpdateChannel ?? availableUpdateChannel;
    readyUpdateReleaseNotes =
      toPostUpdateReleaseNotesPayload(info) ?? downloadingUpdateReleaseNotes;
    clearAvailableUpdateState();
    clearDownloadingUpdateState();
    logger.info(
      `[auto-update] downloaded: ${info.version}, ${process.platform === "win32" ? "waiting for explicit install" : "ready to install on quit or explicit install"}`,
    );
    setAutoUpdaterMenuState(buildUpdateDownloadedState(info.version));
    notifyForceAutoUpdate({ kind: "ready", version: info.version });

    if (activeForceAutoUpdateListener) {
      notifyForceAutoUpdate({ kind: "installing" });
      void quitAndInstallUpdate();
    }

    if (options.settingService) {
      const releaseNotesPayload = readyUpdateReleaseNotes;
      const persistTask = releaseNotesPayload
        ? persistPendingPostUpdateReleaseNotes(
            options.settingService,
            releaseNotesPayload,
            "update-downloaded",
          )
        : clearPendingPostUpdateReleaseNotes(
            options.settingService,
            "update-downloaded-without-release-notes",
          );

      void persistTask.catch((error) => {
        logger.error("[auto-update] persist post-update release notes failed:", error);
      });
    }

    for (const win of BrowserWindow.getAllWindows()) {
      syncReadyUpdateToWindow(win);
    }
  });

  autoUpdater.on("error", (err) => {
    if (shouldIgnoreCancelledDownloadError(err)) {
      // electron-updater 在取消下载后可能异步补发 error("cancelled")。
      // 用户取消已经把状态恢复到可重试的 update-available，迟到取消事件不能再清空入口。
      logger.info("[auto-update] ignore delayed error from cancelled download");
      return;
    }

    void settleAutoUpdateCheckResult("error", () => {
      handleAutoUpdateFailure(err, "error");
    });
  });

  ipcMain.handle(PlatformChannels.QuitAndInstallUpdate, () =>
    // renderer 只有在 IPC reject 时才知道安装器没有接管。ready 失效或
    // 退出准备失败不能返回成功 ACK，否则“重启以更新”会永久保持 pending。
    quitAndInstallUpdate(true),
  );
  ipcMain.on(PlatformChannels.QuitAndInstallUpdate, () => {
    void quitAndInstallUpdate();
  });
  ipcMain.handle(PlatformChannels.DownloadUpdate, () => {
    downloadAvailableUpdate("renderer");
  });
  ipcMain.handle(PlatformChannels.CancelUpdateDownload, () => {
    cancelDownloadingUpdate("renderer");
  });
  ipcMain.handle(PlatformChannels.SkipUpdateVersion, async (_event, version: unknown) => {
    const validatedVersion = typeof version === "string" ? version.trim() : "";
    if (!validatedVersion) {
      logger.warn("[auto-update] ignore empty skipped update version");
      return;
    }
    await skipAvailableUpdateVersion(validatedVersion, options.settingService);
  });

  triggerCheckForUpdates("startup");

  autoUpdatePollTimer = setInterval(() => {
    triggerCheckForUpdates("poll");
  }, AUTO_UPDATE_POLL_INTERVAL_MS);
  autoUpdatePollTimer.unref?.();
}

export function requestForceAutoUpdate(
  onStateChange: (state: ForceAutoUpdateState) => void,
  reason = "force-update",
  _minimumVersion?: string,
) {
  const dispose = () => {
    if (activeForceAutoUpdateListener === onStateChange) {
      activeForceAutoUpdateListener = null;
    }
  };

  activeForceAutoUpdateListener = onStateChange;
  forceAutoUpdateLastLoggedProgressBucket = null;
  logger.info(`[force-update] 自动升级开始 reason=${reason}`);
  onStateChange({ kind: "checking" });

  if (!canUseAutoUpdaterInCurrentRuntime()) {
    const message = "not packaged";
    logger.info(`[force-update] 自动升级跳过：${message}`);
    onStateChange({ kind: "dev-skipped", message });
    return dispose;
  }

  if (menuState.kind === "update-downloaded") {
    onStateChange({ kind: "installing" });
    void quitAndInstallUpdate();
    return dispose;
  }

  if (menuState.kind === "update-available") {
    downloadAvailableUpdate("force-update");
    return dispose;
  }

  if (menuState.kind === "download-progress") {
    onStateChange({
      kind: "downloading",
      ...("version" in menuState && menuState.version ? { version: menuState.version } : {}),
      progress: menuState.progress,
    });
    return dispose;
  }

  if (checkForUpdatesInFlight) {
    logger.info(`[force-update] 自动升级复用进行中的更新检查`);
    return dispose;
  }

  const checkId = beginAutoUpdateCheck();
  setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  autoUpdater
    .checkForUpdates()
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[auto-update] ${reason} check failed:`, err);
      setAutoUpdaterMenuState(
        readyUpdateVersion
          ? buildUpdateDownloadedState(readyUpdateVersion)
          : { kind: "idle", enabled: true },
      );
      onStateChange({ kind: "error", message });
    })
    .finally(() => {
      finishAutoUpdateCheck(reason, checkId);
    });

  return () => {
    if (activeForceAutoUpdateListener === onStateChange) {
      activeForceAutoUpdateListener = null;
    }
  };
}

/**
 * 「打开发布页」回退该指向的 URL —— 随**当前已应用**通道走。
 *
 * 判据取 `autoUpdater.allowPrerelease`（applyAutoUpdaterReleaseChannelConfig 刚写下的真值），
 * 而不是 `availableUpdateChannel`：后者是菜单/状态簿记，冷启动首次 check 落地前仍是初始
 * `"stable"`，会让预览用户也被送到正式版页（页面选择本身的成因见 autoUpdatePolicy 的
 * resolveGitHubReleasesPageUrl 注释）。
 */
function getGitHubReleasesPageUrl(): string {
  return resolveGitHubReleasesPageUrl(
    GITHUB_UPDATE_OWNER,
    GITHUB_UPDATE_REPO,
    autoUpdater.allowPrerelease ? "preview" : "stable",
  );
}

export function checkForUpdateMenuClick(originWindow?: BrowserWindow | null) {
  logger.info("[auto-update] user clicked Check for Updates");

  const targetWindow =
    originWindow && !originWindow.isDestroyed()
      ? originWindow
      : (BrowserWindow.getFocusedWindow() ??
        BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ??
        null);

  if (!targetWindow) {
    logger.warn("[auto-update] manual check: no target window to report to");
    return;
  }

  if (!canUseAutoUpdaterInCurrentRuntime()) {
    logger.info("[auto-update] skip manual check: not packaged");
    targetWindow.webContents.send(PlatformChannels.UpdateCheckResult, {
      kind: "dev-skipped",
    } satisfies UpdateCheckResultPayload);
    return;
  }

  if (autoUpdaterDisabledForProductFlavor) {
    // 入口本应已按产品身份隐藏；这里是最后一道闸，不让未初始化的 updater 实例向占位 feed 发请求。
    // 必须排在「回退打开发布页」之前：Preview 身份连发布页都不该引导 —— 那里是生产产物，
    // 本 flavor 的正规行为是 fail-closed 地回 dev-skipped。
    logger.info("[auto-update] skip manual check: updater disabled for this product flavor");
    targetWindow.webContents.send(PlatformChannels.UpdateCheckResult, {
      kind: "dev-skipped",
    } satisfies UpdateCheckResultPayload);
    return;
  }

  if (!inAppAutoUpdateAvailable) {
    // 已打包但判定不支持应用内更新（例如未签名/异常构建）。不能静默留在状态机里 ——
    // 那会让用户点了「检查更新」没有任何反应。打开发布页是这类环境的正规出口。
    // 页面随当前通道选（预览用户必须看得到 prerelease），理由见 getGitHubReleasesPageUrl。
    const releasesPageUrl = getGitHubReleasesPageUrl();
    logger.warn(`[auto-update] in-app update unavailable: open releases page ${releasesPageUrl}`);
    void shell.openExternal(releasesPageUrl);
    targetWindow.webContents.send(PlatformChannels.UpdateCheckResult, {
      kind: "open-page",
      url: releasesPageUrl,
    } satisfies UpdateCheckResultPayload);
    return;
  }

  if (menuState.kind === "update-downloaded") {
    // 菜单文案已经切到“重启以更新”，如果仍只发 ready toast，
    // 用户点击系统菜单不会安装更新，而顶部按钮会安装，两个入口语义不一致。
    // 这里复用按钮背后的安装逻辑，让菜单点击真正触发重启安装。
    void quitAndInstallUpdate();
    return;
  }
  if (menuState.kind === "download-progress") {
    targetWindow.webContents.send(PlatformChannels.UpdateCheckResult, {
      kind: "already-downloading",
      version: downloadingUpdateVersion ?? readyUpdateVersion ?? "",
      progress: menuState.progress,
    } satisfies UpdateCheckResultPayload);
    return;
  }
  if (menuState.kind === "update-available") {
    targetWindow.webContents.send(PlatformChannels.UpdateCheckResult, {
      kind: "available",
      version: menuState.version,
      ...(menuState.channel ? { channel: menuState.channel } : {}),
      ...(menuState.releaseNotes ? { releaseNotes: menuState.releaseNotes } : {}),
    } satisfies UpdateCheckResultPayload);
    return;
  }

  if (checkForUpdatesInFlight) {
    logger.info("[auto-update] skip manual check: check already in flight");
    targetWindow.webContents.send(PlatformChannels.UpdateCheckResult, {
      kind: "error",
      message: "Update check already in progress.",
    } satisfies UpdateCheckResultPayload);
    return;
  }

  manualCheckWebContentsId = targetWindow.webContents.id;
  const manualCheckChannel = getAutoUpdaterReleaseChannelForCurrentState();
  // Windows 自绘菜单不能只等 electron-updater 的 checking 事件。
  // 某些环境里用户点击后会先重新打开菜单，如果事件尚未送达 renderer，就仍显示“检查更新”。
  // 这里在发起手动检查前先落一份稳定状态，后续 download-progress 再覆盖成百分比。
  setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  const checkId = beginAutoUpdateCheck();
  void (async () => {
    await clearSkippedUpdateVersionForManualCheck(manualCheckChannel, autoUpdaterSettingService);
    await autoUpdater.checkForUpdates();
  })()
    .catch((err) => {
      logger.error("[auto-update] manual check failed:", err);
      sendManualCheckResult({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      finishAutoUpdateCheck("manual check", checkId);
    });
}
