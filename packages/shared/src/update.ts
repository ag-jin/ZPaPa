import type { ElectronReleaseChannel, Locale } from "./protocol.js";

export interface PostUpdateReleaseNotesPayload {
  version: string;
  title: string;
  markdown: string;
  releaseDate?: string;
  releaseNotesByLocale?: Partial<Record<Locale, { title: string; markdown: string }>>;
}

/**
 * 「已确认无可用更新」时附带的事实，让界面能说清**通道**状态，而不是只回一句「已是最新」。
 *
 * 存在的理由（T3）：装了预览版 `3.17.0-preview.1` 的用户关掉「接受预览版更新」开关后，
 * 通道回到 stable，GitHub 上最新的正式版可能仍是更低号（如 `3.16.3`）。此时既不允许降级、
 * 正式版也还没追上来，检查结果就是 not-available —— 界面若只显示「已是最新」，
 * 用户会以为一切正常，实则回不到正式版（且开关文案承诺过「关闭后将随着版本发布节奏获得推送」）。
 * main 侧用 semver 把这个事实算好，renderer 只负责措辞，避免在 UI 里再实现一套版本比较。
 */
export interface UpdateUpToDateNotice {
  /** 本次「已确认无更新」的检查所用的取清单通道。 */
  channel: ElectronReleaseChannel;
  /** 当前运行版本（main 侧真值）。 */
  currentVersion: string;
  /** 该通道上看到的最新版本号。 */
  latestChannelVersion: string;
  /**
   * 装了预览版 + 检查通道是正式版 + 正式版号低于当前版本 ⇒ **暂时无法回到正式版**，
   * 需等正式版号追上方可自动升级。为 `true` 时界面**必须**解释原因，不得只说「已是最新」。
   */
  stableCatchUpPending: boolean;
}

/**
 * 用户从菜单手动点击"检查更新"后，main 进程回传给 renderer 的结果。
 * Renderer 根据 kind 展示对应的 toast；不要与启动时的自动 check 混用。
 */
export type UpdateCheckResultPayload =
  | {
      kind: "up-to-date";
      currentVersion: string;
      /** 已确认无可用更新时的通道事实（见 UpdateUpToDateNotice）；普通「已是最新」不带。 */
      upToDateNotice?: UpdateUpToDateNotice;
    }
  | {
      kind: "available";
      version: string;
      channel?: ElectronReleaseChannel;
      releaseNotes?: PostUpdateReleaseNotesPayload;
    }
  | { kind: "downloading"; version: string }
  | { kind: "already-downloading"; version: string; progress: string }
  | { kind: "ready"; version: string }
  | { kind: "dev-skipped" }
  /** 当前构建不支持应用内安装(如取不到代码签名 DR 的 macOS),已代用户打开外部下载页面。 */
  | { kind: "open-page"; url: string }
  | { kind: "error"; message: string };

/**
 * 桌面自动更新器的持续状态，用于同步原生菜单和 Windows 自绘标题栏菜单。
 */
export type UpdateStatePayload =
  | {
      kind: "idle";
      enabled: boolean;
      /** 已应用的取清单通道；有它界面在任何时刻都能说清「当前拿到的是哪个通道」。 */
      channel?: ElectronReleaseChannel;
      /** 已确认无可用更新时的通道事实（见 UpdateUpToDateNotice）。 */
      upToDateNotice?: UpdateUpToDateNotice;
    }
  | { kind: "checking"; enabled: boolean }
  | {
      kind: "update-available";
      enabled: boolean;
      version: string;
      channel?: ElectronReleaseChannel;
      releaseNotes?: PostUpdateReleaseNotesPayload;
    }
  | {
      kind: "download-progress";
      enabled: boolean;
      progress: string;
      transferredBytes?: number;
      totalBytes?: number;
      version?: string;
      channel?: ElectronReleaseChannel;
      releaseNotes?: PostUpdateReleaseNotesPayload;
    }
  | {
      kind: "update-downloaded";
      enabled: boolean;
      version: string;
      channel?: ElectronReleaseChannel;
      releaseNotes?: PostUpdateReleaseNotesPayload;
    };
