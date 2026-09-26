import { useMemo } from "react";
import { isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";

function isLocalWorkspaceTab(tab: WorkspaceTabState): boolean {
  return !tab.remoteSessionId && !tab.remoteTarget && !tab.workspaceIdentity;
}

/** 远程项目 tab（远程 workspace，含 SSH/WSL/Docker）。 */
export function isRemoteProjectTab(tab: WorkspaceTabState): boolean {
  return Boolean(tab.remoteSessionId || tab.remoteTarget || tab.workspaceIdentity);
}

export function useLocalWorkspaceScopes({
  workspaceTabs,
  includeRemoteProjectTabs = false,
}: {
  workspaceTabs: WorkspaceTabState[];
  /**
   * 是否把「远程项目 tab」一并纳入查询。
   *
   * 默认 false：pinned 查询、Automation 项目下拉等只面向本机已打开的本地 workspace；
   * 远端 workspace 若兜底混入，会在缺 remoteSessionId 时落到本地服务，导致同路径任务串读。
   *
   * 需要展示「被连项目的会话」时传 true（会话列表/时间线）：远端 CLI 以本地视角写库，
   * 会话键就是项目真实路径，因此调用方必须同时把 scope 的 workspaceIdentity 置空
   * （见 useGroupedTaskView 的 buildWorkspaceScopes），否则会按 remote:* 身份键查询而查不到。
   */
  includeRemoteProjectTabs?: boolean;
}): WorkspaceTabState[] {
  return useMemo(
    () =>
      workspaceTabs.filter((tab) => {
        if (!isWorkspaceTab(tab)) return false;
        if (isLocalWorkspaceTab(tab)) return true;
        return includeRemoteProjectTabs && isRemoteProjectTab(tab) && Boolean(tab.workspacePath);
      }),
    [includeRemoteProjectTabs, workspaceTabs],
  );
}
