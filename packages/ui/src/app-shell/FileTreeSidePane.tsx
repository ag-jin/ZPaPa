import { memo } from "react";
import { WorkspaceFileTree } from "@/WorkspaceFileTree.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { FileTreeSidePaneTab } from "@/lib/workspaceSidePane.js";

/**
 * 右侧面板里的文件树。
 *
 * 文件树 tab 是 workspace 级单例（固定 id），所以切换对话时**不卸载**：树自身的展开状态、
 * 搜索词与滚动位置因此跨对话保留，回到原对话不需要重新展开一遍目录。
 *
 * 预览 source 必须带上 tab 里的 workspace 作用域（而不是宿主当前 workspace）：树可以查看
 * 非当前 workspace 的目录（聊天里点外部目录、任务列表里的其他项目），PreviewPane 需要正确
 * 的 host 才能读取远程文件。
 */
export const FileTreeSidePane = memo(function FileTreeSidePane({
  tab,
  canOpenLocalFileManager = false,
  activePreviewPath,
  onClose,
  onOpenBrowserUrl,
  onOpenCodeViewer,
}: {
  tab: FileTreeSidePaneTab;
  canOpenLocalFileManager?: boolean;
  activePreviewPath?: string | null;
  onClose: () => void;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <WorkspaceFileTree
      workspacePath={tab.workspacePath}
      workspaceName={tab.workspaceName ?? undefined}
      workspaceIdentity={tab.workspaceIdentity ?? undefined}
      workspaceRemoteSessionId={tab.workspaceRemoteSessionId ?? undefined}
      revealPath={tab.revealPath ?? undefined}
      temporaryExternalDirectory={tab.temporaryExternalDirectory}
      canOpenLocalFileManager={canOpenLocalFileManager}
      activePreviewPath={activePreviewPath}
      // 左栏时代的「返回任务」在右栏 tab 里指错了地方：这里的动作是关掉面板。
      closeLabel={intl.formatMessage({ id: "common.close" })}
      onClose={onClose}
      onOpenBrowserUrl={onOpenBrowserUrl}
      onOpenPreview={(source) => {
        onOpenCodeViewer?.({
          ...source,
          workspacePath: tab.workspacePath,
          ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
          ...(tab.workspaceRemoteSessionId
            ? { workspaceRemoteSessionId: tab.workspaceRemoteSessionId }
            : {}),
        });
      }}
    />
  );
});
