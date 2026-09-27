import type { BrowserViewScreenshotSurfacePreparePayload } from "@zcode/shared";
import { useCallback, type CSSProperties } from "react";
import { UnifiedBrowserView } from "@/browser-use/UnifiedBrowserView.js";
import { cn } from "@/components/lib/utils.js";
import { TabsContent } from "@/components/ui/tabs.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import { buildTunnelUrl, resolveRemoteLoopbackTarget } from "@/lib/remoteLoopbackPreview.js";
import type { BrowserSidePaneMetadata, BrowserUseSidePaneTab } from "@/lib/workspaceSidePane.js";

interface BrowserUseSidePaneContentProps {
  tab: BrowserUseSidePaneTab;
  isPanelVisible: boolean;
  isSelected: boolean;
  isCurrentTask: boolean;
  screenshotSurfaceRequest: BrowserViewScreenshotSurfacePreparePayload | null;
  initialUrl?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  residencyGeneration?: number;
  onUrlChange(url: string): void;
  onPageMetadataChange(metadata: BrowserSidePaneMetadata): void;
}

/** browser-use 专用 TabsContent：非活动 tab 仅在截图准备期间保留真实合成布局。 */
export function BrowserUseSidePaneContent({
  tab,
  isPanelVisible,
  isSelected,
  isCurrentTask,
  screenshotSurfaceRequest,
  initialUrl,
  workspacePath,
  workspaceIdentity,
  residencyGeneration,
  onUrlChange,
  onPageMetadataChange,
}: BrowserUseSidePaneContentProps): React.JSX.Element {
  // 当前 tab 所属 workspace 的服务面与远端判定：远程 tab 解析到对端 scoped
  // services，本地 tab 解析到本机。隧道解析必须用 isRemoteTarget 判断 ——
  // 本地项目访问回环要保持原样（服务就在本机，转发反而错）。
  const workspaceServicesResolution = useWorkspaceServicesResolution(
    workspacePath,
    tab.remoteSessionId ?? null,
    workspaceIdentity ?? null,
  );
  const workspaceServices = workspaceServicesResolution.services;
  const isRemoteWorkspace = workspaceServicesResolution.isRemoteTarget;

  /**
   * 回环预览隧道（工单 08）：目标 URL 指向回环且当前是**远程 workspace**时，
   * 请 Controller 为该端口开隧道，返回隧道地址；其余情况原样返回。
   *
   * 判定规则在 lib/remoteLoopbackPreview（纯函数、有测试）。
   */
  const resolveLoopbackUrl = useCallback(
    async (url: string): Promise<string> => {
      const target = resolveRemoteLoopbackTarget(url, { isRemoteWorkspace });
      if (target.kind !== "remote-loopback") {
        return url;
      }
      const controller = workspaceServices.windowControllerService;
      if (!controller?.openRemoteLoopbackTunnel) {
        // 对端/宿主不支持时按原地址加载：本地回环服务仍可用（若项目本就是本机的），
        // 不做静默改写以免把"不支持"伪装成"已转发"。
        return url;
      }
      try {
        const { localPort } = await controller.openRemoteLoopbackTunnel({
          scope: {
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
          },
          remotePort: target.remotePort,
        });
        return buildTunnelUrl(url, localPort);
      } catch (error) {
        // 建不起来时抛给调用方按原地址尝试 —— 由既有加载失败路径呈现错误，
        // 不要在这里吞掉后假装成功（那会得到一张空白页且没有线索）。
        logger.warn("[浏览器] 回环隧道建立失败", {
          remotePort: target.remotePort,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    [
      isRemoteWorkspace,
      workspaceIdentity,
      workspacePath,
      workspaceServices.windowControllerService,
    ],
  );
  // 截图 surface 不能依赖收起的 ResizablePanel 提供尺寸：面板宽度为 0 时，Electron
  // guest 会被 Chromium 当成没有 compositor surface，capturePage 会直接失败。把同一份
  // TabsContent 临时固定到窗口内的合成层，并用接近透明的 opacity 隔离视觉；完全移到窗口外
  // 会被 Viz 视为 offscreen 而继续返回 UnknownVizError。它仍不参与右侧布局，也不卸载 guest。
  const screenshotSurfaceStyle: CSSProperties | undefined = screenshotSurfaceRequest
    ? {
        position: "fixed",
        left: 0,
        top: 0,
        // 固定层超过窗口时，Fit 误以为 viewport 能完整显示；Windows 高 DPI
        // 的 Chromium 会裁剪超出可见范围的 guest raster，native 截图归一后横向拉伸。
        // 以宿主窗口为上限，让 Fit 按真实可见画布缩放，保持逻辑 viewport 与用户偏好。
        width: `${screenshotSurfaceRequest.viewport.width}px`,
        height: `${screenshotSurfaceRequest.viewport.height + 48}px`,
        maxWidth: screenshotSurfaceRequest.surfaceScaleMode === "unscaled" ? undefined : "100vw",
        maxHeight: screenshotSurfaceRequest.surfaceScaleMode === "unscaled" ? undefined : "100vh",
        pointerEvents: "none",
        // opacity=0 会让 Chromium 丢弃 guest layer；0.001 保留 compositor surface，视觉上不可见。
        opacity: 0.001,
      }
    : undefined;

  return (
    <TabsContent
      value={tab.id}
      forceMount
      aria-hidden={!isSelected}
      inert={!isSelected ? true : undefined}
      data-browser-use-tab-id={tab.tabId}
      data-browser-screenshot-surface-state={screenshotSurfaceRequest ? "preparing" : undefined}
      className={cn(
        "h-full min-h-0 bg-background",
        isSelected
          ? "relative z-10 flex"
          : screenshotSurfaceRequest
            ? "pointer-events-none fixed z-0 flex overflow-hidden"
            : "hidden",
      )}
      style={screenshotSurfaceStyle}
    >
      <UnifiedBrowserView
        browserKey={tab.tabId}
        isResidencyRestore={tab.residency === "restoring"}
        isVisible={isPanelVisible && isSelected}
        isSelected={isSelected}
        isCurrentTask={isCurrentTask}
        screenshotSurfaceRequest={screenshotSurfaceRequest}
        initialUrl={initialUrl}
        faviconUrl={tab.faviconUrl}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        workspaceKey={tab.workspaceKey ?? (workspaceIdentity?.trim() || workspacePath)}
        remoteSessionId={tab.remoteSessionId ?? undefined}
        resolveLoopbackUrl={resolveLoopbackUrl}
        sessionId={tab.sessionId}
        residencyGeneration={tab.residencyGeneration ?? residencyGeneration}
        browserUseOperationUntil={tab.browserUseOperationUntil}
        browserResizeBaselineVersion={tab.browserUseResizeBaselineVersion}
        onUrlChange={onUrlChange}
        onPageMetadataChange={onPageMetadataChange}
      />
    </TabsContent>
  );
}
