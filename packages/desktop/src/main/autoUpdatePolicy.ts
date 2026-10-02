/**
 * 自动更新的**纯判定**逻辑。
 *
 * 为什么不放在 autoUpdater.ts 里：那个模块在顶层 import electron 的具名导出
 * （`app` / `BrowserWindow` / ...），在纯 Node 测试环境里 `electron` 只解析成
 * 一个路径字符串，具名导入直接报 "does not provide an export named ..."，
 * 于是这些判定无法被单测覆盖。而它们恰恰是「mac 能不能自动更新」的判定核心 ——
 * 一旦写错，用户要么收不到更新、要么点了更新没反应，都属于静默失效。
 * 因此按仓库既有做法（参见 scheduler/misfireDecision.ts）把纯逻辑摊出来单独测。
 */

import type { ElectronReleaseChannel } from "@zcode/shared";

/**
 * 应用是否带 designated requirement（DR）—— 即 Squirrel.Mac 能否初始化。
 *
 * 背景（2026-09-29 实测）：Squirrel.Mac 初始化时要取当前应用的
 * `SecCodeCopyDesignatedRequirement`；**完全未签名**的应用取不到，原生
 * `setFeedURL()` 抛 `Could not get code signature for running application`。
 * 即未签名包不是「安装时被拒」，而是连更新器都起不来。
 *
 * @param exitCode codesign 的退出码（非 0 通常意味着未签名）
 * @param stdout   codesign 的标准输出
 * @param stderr   codesign 的标准错误（未签名时这里会写
 *                 "code object is not signed at all"）
 */
export function parseMacDesignatedRequirement(
  exitCode: number | null,
  stdout: string,
  stderr: string,
): boolean {
  // 未签名：codesign 以非 0 退出。不把 stderr 文本当判据 —— 它是本地化的，
  // 退出码才是稳定契约。
  if (exitCode !== 0) return false;
  const combined = `${stdout}\n${stderr}`;
  // ad-hoc 与正式签名的 DR 分别是 identifier 型与 cdhash 型，两者都能让 Squirrel 取到 DR。
  return /designated\s*=>/i.test(combined) || /\bidentifier\s+"/i.test(combined);
}

/**
 * 打包态 `.app` bundle 路径（从可执行文件路径上溯三层）。
 *
 * 不能用 `app.getAppPath()`：打包后它指向 `Contents/Resources/app.asar`，
 * 而 asar 自身没有代码签名，`codesign -d -r- app.asar` 会报
 * "code object is not signed at all"，把正常签名的应用误判成未签名（已实测）。
 * 可执行文件位于 `<X>.app/Contents/MacOS/<name>`，因此上溯三层即 bundle 根。
 */
export function resolveMacAppBundlePath(execPath: string): string {
  const parts = execPath.split("/").filter((part) => part.length > 0);
  // 期望 .../X.app/Contents/MacOS/<name> → 去掉最后三层
  if (parts.length <= 3) return execPath;
  return `/${parts.slice(0, -3).join("/")}`;
}

/**
 * 是否允许**应用内**更新（下载 + 安装），而不是只打开发布页。
 *
 * - 未打包（dev）：沿用既有 dev 分支 —— 没有可被安装器接管的发布包上下文。
 * - 非 darwin（win32 / linux）：维持既有行为，electron-updater 各自有实现。
 * - darwin：必须先确认能取到 DR，否则应用内更新必然失败；
 *   此时回退到打开发布页，而不是让用户点了更新没反应。
 */
export function shouldUseInAppAutoUpdate(params: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  devAutoUpdateEnabled: boolean;
  /** 仅 darwin 有意义：应用是否带 DR（由 codesign 探测得出）。 */
  macHasDesignatedRequirement?: boolean;
}): boolean {
  if (!params.isPackaged) return params.devAutoUpdateEnabled;
  if (params.platform !== "darwin") return true;
  return params.macHasDesignatedRequirement === true;
}

function mapElectronReleaseArch(arch: string): string {
  switch (arch) {
    case "arm64":
      return "aarch64";
    case "x64":
      return "x86_64";
    case "ia32":
      return "x86";
    default:
      return arch;
  }
}

function mapElectronReleasePlatform(platform: NodeJS.Platform): string {
  switch (platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    default:
      return platform;
  }
}

/**
 * 当前运行平台的 electron 更新平台标识（如 `darwin-arm64` / `windows-x64`）。
 *
 * 原属 `manifestUpdateProvider.ts`（平台 manifest 更新源）。该文件在本分支是死代码、
 * 已被删，但 autoUpdater.ts 仍用它打通道应用日志，故迁到这里 —— 本模块是
 * autoUpdater.ts **已经依赖**且**无 electron 依赖**的纯逻辑模块，不必新增模块边，
 * 也仍可被单测覆盖（这是「不留下悬空 import」的最小改法）。
 *
 * `TEST_UPDATER_ARCH` 是 manifest 时代的测试缝，随函数一并保留以保持行为不变；
 * 仓库内已无任何调用方设置它（grep 零命中），后续可考虑删除。
 */
export function getElectronReleasePlatform(
  platform: NodeJS.Platform = process.platform,
  arch = process.env["TEST_UPDATER_ARCH"] || process.arch,
): string {
  return `${mapElectronReleasePlatform(platform)}-${mapElectronReleaseArch(arch)}`;
}

/**
 * 「打开发布页」回退该指向哪个页面 —— 必须随**当前通道**走。
 *
 * 背景：未签名 mac（取不到 DR，Squirrel 起不来）的应用内更新不可用，手动检查退化为
 * `shell.openExternal(发布页)`。此时若固定用 `/releases/latest`，GitHub 会重定向到
 * **最新正式版**（prerelease 不计入 latest）⇒ 预览用户被送到正式版页，与
 * 「开启后将最快、提前体验」的承诺矛盾。
 *
 * 取舍：预览通道指向**完整发布列表**而不是 `?q=prerelease%3Atrue` 过滤页 ——
 * 过滤页会把正式版一并藏掉，而预览用户正需要看到「取代当前预览号的正式版」
 * （`X.Y.Z-preview.N < X.Y.Z`，见 docs/superpowers/plans/2026-10-02-preview-update-channel.md 第二节）。
 * 列表页会把 prerelease 带 Pre-release 徽标一并列出，两类都能取到。
 */
export function resolveGitHubReleasesPageUrl(
  owner: string,
  repo: string,
  channel: ElectronReleaseChannel,
): string {
  const releasesBase = `https://github.com/${owner}/${repo}/releases`;
  return channel === "preview" ? releasesBase : `${releasesBase}/latest`;
}
