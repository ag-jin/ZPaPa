import { useCallback, useEffect, useRef } from "react";
import type { IPlatformService } from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  collectClosedRemoteWorkspaceKeys,
  collectClosedRemoteWorkspaceSessionIds,
  collectSessionsToDisposeOnTabRemoval,
  remoteWorkspaceKey,
} from "@/root/remoteWorkspaceTabLifecycleDecision.js";
import { useDeviceSessionStore } from "@/store/deviceSessionStore.js";
import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
  unbindRemoteWorkspaceIdentity,
  unbindRemoteWorkspacePath,
  unregisterRemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import { isWorkspaceTab, type WindowTabState, type WorkspaceTabState } from "@/store/tabStore.js";

export function useRemoteWorkspaceTabLifecycle({
  tabs,
  activeWorkspaceTab,
  platform,
  onRemoteWorkspaceTabsClosed,
}: {
  tabs: WindowTabState[];
  activeWorkspaceTab: WorkspaceTabState | null;
  platform: IPlatformService;
  onRemoteWorkspaceTabsClosed?: (workspaceKeys: string[]) => void;
}) {
  const previousWorkspaceTabsRef = useRef<WindowTabState[]>([]);
  const rememberedSessionIdsByWorkspaceKeyRef = useRef<Map<string, string>>(new Map());

  /**
   * 该 sessionId 是否属于设备级连接（连接归设备所有，不随 tab 存亡）。
   *
   * 用「会话是否登记在设备 store 里」判定，而不是看 tab 上有没有 projection 标记：
   * 投射 tab 可能处于断开态（remoteSessionId 已清），而普通远程 tab 也可能带
   * projection 之外的来源。以连接的真实归属为准，判据唯一。
   */
  const isDeviceOwnedSessionId = useCallback(
    (sessionId: string) =>
      Object.values(useDeviceSessionStore.getState().sessionsByDeviceKey).some(
        (session) => session.sessionId === sessionId,
      ),
    [],
  );

  useEffect(() => {
    const previousWorkspaceTabs = previousWorkspaceTabsRef.current.filter(isWorkspaceTab);
    const nextWorkspaceTabs = tabs.filter(isWorkspaceTab);
    const closedRemoteWorkspaceKeys = collectClosedRemoteWorkspaceKeys(
      previousWorkspaceTabs,
      nextWorkspaceTabs,
      isDeviceOwnedSessionId,
    );
    const closedRemoteSessionIds = collectClosedRemoteWorkspaceSessionIds(
      previousWorkspaceTabs,
      nextWorkspaceTabs,
      rememberedSessionIdsByWorkspaceKeyRef.current,
      isDeviceOwnedSessionId,
    );
    if (closedRemoteWorkspaceKeys.length > 0) {
      onRemoteWorkspaceTabsClosed?.(closedRemoteWorkspaceKeys);
      for (const workspaceKey of closedRemoteWorkspaceKeys) {
        rememberedSessionIdsByWorkspaceKeyRef.current.delete(workspaceKey);
      }
    }
    for (const tab of nextWorkspaceTabs) {
      const workspaceKey = remoteWorkspaceKey(tab);
      if (workspaceKey && tab.remoteSessionId) {
        rememberedSessionIdsByWorkspaceKeyRef.current.set(workspaceKey, tab.remoteSessionId);
      }
    }

    for (const sessionId of closedRemoteSessionIds) {
      void (async () => {
        try {
          // 断连事件会先清掉 tab 上的 remoteSessionId，导致下方正常移除流程
          // 无法释放该 session。这里使用记忆的 sessionId 补齐“断连后再关闭 tab”的清理路径。
          await platform.disposeRemoteSession(sessionId);
        } catch (error) {
          logger.warn("[Root] 释放断连远程 session 失败:", { sessionId, error });
        } finally {
          unregisterRemoteWorkspaceSession(sessionId);
        }
      })();
    }

    for (const previousTab of previousWorkspaceTabs) {
      const stillExists = nextWorkspaceTabs.some((nextTab) => nextTab.id === previousTab.id);
      if (stillExists) {
        continue;
      }

      if (!previousTab.remoteSessionId) {
        continue;
      }

      const survivingRemoteTab = nextWorkspaceTabs.find((nextTab) => {
        if (!nextTab.remoteSessionId) {
          return false;
        }

        if (previousTab.workspaceIdentity && nextTab.workspaceIdentity) {
          return nextTab.workspaceIdentity === previousTab.workspaceIdentity;
        }

        return nextTab.workspacePath === previousTab.workspacePath;
      });

      if (survivingRemoteTab?.remoteSessionId) {
        // 之前只按 workspacePath 维护映射，关闭同路径 remote tab 时会把另一个远端 tab 一起“解绑”。
        // 这里优先复用幸存 tab 的绑定，并同步刷新 workspaceIdentity 映射，避免后续 RPC 命中错误 session。
        bindRemoteWorkspacePath(
          survivingRemoteTab.workspacePath,
          survivingRemoteTab.remoteSessionId,
        );
        if (survivingRemoteTab.workspaceIdentity) {
          bindRemoteWorkspaceIdentity(
            survivingRemoteTab.workspaceIdentity,
            survivingRemoteTab.remoteSessionId,
          );
        }
      } else {
        unbindRemoteWorkspacePath(previousTab.workspacePath);
        if (previousTab.workspaceIdentity) {
          unbindRemoteWorkspaceIdentity(previousTab.workspaceIdentity);
        }
      }
    }

    // 应自动释放的 session：判定收在 remoteWorkspaceTabLifecycleDecision（纯函数、可单测）。
    // 设备级会话在这里被排除 —— 那是本次重设计的核心不变量：一台设备的所有项目
    // 投射 tab 共享同一个 remoteSessionId，若照旧 dispose，用户关掉最后一个项目
    // 就会断掉整条 SSH 连接，设备条目退化成裸 user@host:port 且无法重连（用户实测）。
    const disposedSessionIds = new Set(
      collectSessionsToDisposeOnTabRemoval(
        previousWorkspaceTabs,
        nextWorkspaceTabs,
        isDeviceOwnedSessionId,
      ),
    );
    for (const previousTab of previousWorkspaceTabs) {
      const sessionId = previousTab.remoteSessionId;
      if (!sessionId || !disposedSessionIds.has(sessionId)) {
        continue;
      }
      if (isDeviceOwnedSessionId(sessionId)) {
        logger.info("[Root] 设备级会话不随投射 tab 释放，保留连接", {
          workspacePath: previousTab.workspacePath,
          sessionId,
        });
        continue;
      }
      // 同一 session 可能对应多个已关闭 tab，只释放一次。
      disposedSessionIds.delete(sessionId);
      const workspacePath = previousTab.workspacePath;
      void (async () => {
        try {
          logger.info("[Root] remote workspace tab 已移除，主动释放远程 session", {
            workspacePath,
            workspaceIdentity: previousTab.workspaceIdentity,
            sessionId,
          });
          await platform.disposeRemoteSession(sessionId);
        } catch (error) {
          logger.warn("[Root] 释放远程 session 失败:", {
            sessionId,
            error,
          });
        } finally {
          unregisterRemoteWorkspaceSession(sessionId);
        }
      })();
    }

    previousWorkspaceTabsRef.current = nextWorkspaceTabs;
  }, [onRemoteWorkspaceTabsClosed, platform, tabs]);

  useEffect(() => {
    if (!activeWorkspaceTab?.remoteSessionId) {
      return;
    }

    // 同一路径的多个 remote tab 之间切换时，不能只在建连时绑定一次路径映射，
    // 否则切换后映射仍停留在旧 tab，按 workspacePath 解析服务的 hook 仍可能命中旧 session。
    // 这里在 active tab 切换后把路径与 workspaceIdentity 映射刷新到当前 tab，保证 workspace 级 RPC 跟着当前 tab 走。
    bindRemoteWorkspacePath(activeWorkspaceTab.workspacePath, activeWorkspaceTab.remoteSessionId);
    if (activeWorkspaceTab.workspaceIdentity) {
      bindRemoteWorkspaceIdentity(
        activeWorkspaceTab.workspaceIdentity,
        activeWorkspaceTab.remoteSessionId,
      );
    }
  }, [
    activeWorkspaceTab?.remoteSessionId,
    activeWorkspaceTab?.workspaceIdentity,
    activeWorkspaceTab?.workspacePath,
  ]);
}
