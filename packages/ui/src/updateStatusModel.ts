import type {
  ElectronReleaseChannel,
  PostUpdateReleaseNotesPayload,
  UpdateStatePayload,
  UpdateUpToDateNotice,
} from "@zcode/shared";

export type UpdateStatusDialogPhase = "before-download" | "downloading" | "downloaded";

export type UpdateActionInFlight = "download" | "cancel" | "skip" | "restart" | null;

export type UpdateStatusViewModel = {
  dialogPhase: UpdateStatusDialogPhase;
  displayVersion: string | null;
  progressLabel: string | null;
  progressValue: number;
  releaseNotesPayload: PostUpdateReleaseNotesPayload | undefined;
  skippableVersion: string | null;
  updateChannel: ElectronReleaseChannel | undefined;
};

export function deriveUpdateStatusViewModel({
  legacyReadyVersion,
  updateState,
}: {
  legacyReadyVersion: string | null;
  updateState: UpdateStatePayload | null;
}): UpdateStatusViewModel {
  const isDownloadingUpdate = updateState?.kind === "download-progress";
  const readyVersion = resolveReadyVersion({ legacyReadyVersion, updateState });
  const progressVersion = isDownloadingUpdate ? updateState.version : null;
  const availableVersion = updateState?.kind === "update-available" ? updateState.version : null;
  const displayVersion =
    readyVersion ??
    progressVersion ??
    availableVersion ??
    // download-progress.version 是协议可选字段。下载态必须按 kind 保持 UI，
    // 否则某一帧缺少版本号会让入口卸载并关闭已打开弹窗。
    (isDownloadingUpdate ? "…" : null);

  return {
    dialogPhase: readyVersion
      ? "downloaded"
      : isDownloadingUpdate
        ? "downloading"
        : "before-download",
    displayVersion,
    progressLabel: getUpdateDownloadProgressLabel(updateState),
    progressValue: getUpdateDownloadProgressValue(updateState),
    releaseNotesPayload: getUpdateReleaseNotesPayload(updateState),
    skippableVersion:
      updateState?.kind === "update-available" || updateState?.kind === "download-progress"
        ? (updateState.version ?? null)
        : null,
    updateChannel:
      updateState?.kind === "update-available" ||
      updateState?.kind === "download-progress" ||
      updateState?.kind === "update-downloaded"
        ? updateState.channel
        : undefined,
  };
}

export function isUpdateActionCompleted(  action: UpdateActionInFlight,
  updateState: UpdateStatePayload | null,
) {
  return (
    // 点击下载后 main 侧可能先广播 checking/idle 等过渡态。
    // 这些状态不代表下载已经进入可观察阶段，不能释放按钮锁并触发弹窗卸载；
    // 只有真正进入下载进度或下载完成，才算下载命令完成。
    (action === "download" &&
      (updateState?.kind === "download-progress" || updateState?.kind === "update-downloaded")) ||
    (action === "cancel" && updateState?.kind !== "download-progress") ||
    (action === "skip" &&
      updateState?.kind !== "update-available" &&
      updateState?.kind !== "download-progress")
  );
}

/**
 * 设置页「更新通道」行的展示模型。
 *
 * 为什么需要它（T3 ①）：`updateChannel` 此前只在更新弹窗里算、无人消费，用户看不出自己
 * 拿的是预览版还是正式版；更要紧的是「装了预览版 + 关掉开关 + 正式版号还没追上来」这一格：
 * electron-updater 不允许降级、正式版又更低 ⇒ 结果是 not-available，界面若只说「已是最新」
 * 会让人以为一切正常，实则回不到正式版。`upToDateNotice` 由 main 用 semver 算好事实
 * （见 shared 的 UpdateUpToDateNotice），这里只做展示层映射。
 */
export type UpdateChannelSettingsView = {
  /** 当前生效通道：优先取 main 报来的已应用通道，拿不到时退回用户开关值。 */
  channel: ElectronReleaseChannel;
  /** 装了预览版 + 关着开关 + 正式版号更低 ⇒ 必须显示「暂时回不到正式版」的原因。 */
  stableCatchUpPending: boolean;
  /** 触发上述判断的正式版号（无该状态时为 null）。 */
  latestChannelVersion: string | null;
  /** 当前运行的版本（无该状态时为 null）。 */
  currentVersion: string | null;
};

export function deriveUpdateChannelSettingsView({
  appliedChannel,
  receivePreviewUpdates,
  upToDateNotice,
}: {
  appliedChannel: ElectronReleaseChannel | null;
  receivePreviewUpdates: boolean;
  upToDateNotice: UpdateUpToDateNotice | null;
}): UpdateChannelSettingsView {
  return {
    // main 的 idle 态带有「已应用通道」；冷启动尚未检查时退回开关值 —— 开关就是用户的通道选择。
    channel: appliedChannel ?? (receivePreviewUpdates ? "preview" : "stable"),
    stableCatchUpPending: upToDateNotice?.stableCatchUpPending === true,
    latestChannelVersion: upToDateNotice?.latestChannelVersion ?? null,
    currentVersion: upToDateNotice?.currentVersion ?? null,
  };
}

/**
 * 「已是最新」toast 该不该改成解释「回不到正式版」的文案。
 *
 * 判据与设置页同一份事实（main 算好的 UpdateUpToDateNotice）。把判断收敛在这里，
 * 是为了让「只说已是最新」这个静默失效路径有单一可测的出口。
 */
export function shouldExplainBlockedReturnToStable(
  upToDateNotice: UpdateUpToDateNotice | undefined,
): boolean {
  return upToDateNotice?.stableCatchUpPending === true;
}

function getUpdateDownloadProgressLabel(updateState: UpdateStatePayload | null) {
  if (updateState?.kind !== "download-progress") {
    return null;
  }

  const { totalBytes, transferredBytes } = updateState;
  if (
    typeof transferredBytes === "number" &&
    Number.isFinite(transferredBytes) &&
    transferredBytes >= 0 &&
    typeof totalBytes === "number" &&
    Number.isFinite(totalBytes) &&
    totalBytes > 0
  ) {
    return `${formatMegabytes(transferredBytes)} / ${formatMegabytes(totalBytes)}`;
  }

  // 下载进度文案已经改为展示已下载/总大小。只有百分比时继续显示
  // “0% / 42%” 会和新的大小口径冲突，且启动下载的临时态会残留一个 0%。
  return null;
}

function resolveReadyVersion({
  legacyReadyVersion,
  updateState,
}: {
  legacyReadyVersion: string | null;
  updateState: UpdateStatePayload | null;
}) {
  if (updateState?.kind === "update-downloaded") {
    return updateState.version;
  }

  // legacy UpdateReady 只是一份“曾经 ready”的缓存。
  // 一旦新的 UpdateState 已明确同步到 renderer，idle/checking/error 都应以新状态为准，
  // 不能继续用旧 version 撑出“重启以更新”按钮。
  return updateState === null ? legacyReadyVersion : null;
}

function getUpdateDownloadProgressValue(updateState: UpdateStatePayload | null) {
  const rawProgressValue =
    updateState?.kind === "download-progress" ? Number(updateState.progress) : 0;
  return Number.isFinite(rawProgressValue) ? Math.max(0, Math.min(100, rawProgressValue)) : 0;
}

function getUpdateReleaseNotesPayload(updateState: UpdateStatePayload | null) {
  return updateState?.kind === "update-available" ||
    updateState?.kind === "download-progress" ||
    updateState?.kind === "update-downloaded"
    ? updateState.releaseNotes
    : undefined;
}

function formatMegabytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
