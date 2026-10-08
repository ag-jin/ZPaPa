import { useCallback, useEffect, useRef, useState } from "react";
import { TID_BROWSER_ELEMENT_PICKER_BAR } from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  createWebElementPickerSessionDriver,
  type WebElementPickerPhase,
  type WebElementPickerSession,
} from "@/lib/webElementPickerSession.js";
import type { WebElementPickerScriptLabels } from "@/lib/webElementPickerScript.js";

const LOG_PREFIX = "[UnifiedBrowserView]";

interface UseWebElementPickerOptions {
  /**
   * 传输无关的脚本执行出口：把选择脚本送到目标网页并回传结果。
   * UnifiedBrowserView 走 renderer 侧的 `<webview>.executeJavaScript`，不是 main IPC。
   */
  executeJs: (script: string) => Promise<unknown>;
  workspacePath: string;
  workspaceIdentity?: string;
  labels?: Partial<WebElementPickerScriptLabels>;
}

/**
 * 网页元素拾取会话的 React 外壳：只持有会话状态与焦点兜底，
 * 循环本身在 `createWebElementPickerSessionDriver`（与 React 无关，可直接单测）。
 */
export function useWebElementPicker({
  executeJs,
  workspacePath,
  workspaceIdentity,
  labels,
}: UseWebElementPickerOptions) {
  const [isPicking, setIsPicking] = useState(false);
  const [session, setSession] = useState<WebElementPickerSession | null>(null);
  const activePickerRunRef = useRef(0);
  // executeJs 引用可能随每次渲染变化；用 ref 固定，避免 useCallback 依赖它而频繁重建。
  const executeJsRef = useRef(executeJs);
  executeJsRef.current = executeJs;
  const contextRef = useRef({ workspacePath, workspaceIdentity, labels });
  contextRef.current = { workspacePath, workspaceIdentity, labels };
  const phaseRef = useRef<WebElementPickerPhase | null>(null);
  phaseRef.current = session?.phase ?? null;

  const driverRef = useRef<ReturnType<typeof createWebElementPickerSessionDriver> | null>(null);
  if (!driverRef.current) {
    driverRef.current = createWebElementPickerSessionDriver({
      getContext: () => ({
        executeJs: (script) => executeJsRef.current(script),
        workspacePath: contextRef.current.workspacePath,
        workspaceIdentity: contextRef.current.workspaceIdentity,
        labels: contextRef.current.labels,
      }),
      onSessionChange: setSession,
    });
  }
  const driver = driverRef.current;

  const cancelPicking = useCallback(async () => {
    activePickerRunRef.current += 1;
    setIsPicking(false);
    await driver.cancel();
  }, [driver]);

  const startPicking = useCallback(async () => {
    const runId = activePickerRunRef.current + 1;
    activePickerRunRef.current = runId;
    setIsPicking(true);
    logger.info(`${LOG_PREFIX} 开始网页元素选择`);

    try {
      // 首段注入失败会冒泡：UnifiedBrowserView 用它上 elementPickerFailed 横幅。
      await driver.start();
    } finally {
      if (activePickerRunRef.current === runId) {
        setIsPicking(false);
      }
    }
  }, [driver]);

  const togglePicking = useCallback(async () => {
    if (isPicking) {
      await cancelPicking();
      return;
    }
    await startPicking();
  }, [cancelPicking, isPicking, startPicking]);

  const setLevel = useCallback(
    (level: number) => {
      driver.setLevel(level);
    },
    [driver],
  );

  const confirmSelection = useCallback(() => {
    driver.confirmSelection();
  }, [driver]);

  const requestRepick = useCallback(() => {
    driver.requestRepick();
  }, [driver]);

  const saveComment = useCallback(
    (comment: string) => {
      driver.saveComment(comment);
    },
    [driver],
  );

  const skipComment = useCallback(() => {
    driver.skipComment();
  }, [driver]);

  useEffect(() => {
    if (!isPicking) {
      return;
    }

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      // 浮条内部自己处理 Esc（评语框内只弃草稿，层级态回 hover），这里跳过以免双触发。
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(`[data-testid="${TID_BROWSER_ELEMENT_PICKER_BAR}"]`)
      ) {
        return;
      }

      event.preventDefault();
      // 焦点在 guest 页面内时由注入脚本处理 Esc；焦点还在外层工具栏时这里兜底，
      // 按当前阶段收敛：评语态弃草稿回 hover、层级态重选、hover 态退出会话。
      const phase = phaseRef.current;
      if (phase === "comment") {
        driver.skipComment();
        return;
      }
      if (phase === "adjust") {
        driver.requestRepick();
        return;
      }
      void cancelPicking();
    };

    window.addEventListener("keydown", handleWindowKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleWindowKeyDown, true);
    };
  }, [cancelPicking, driver, isPicking]);

  useEffect(() => {
    return () => {
      void cancelPicking();
    };
  }, [cancelPicking]);

  return {
    cancelPicking,
    isPicking,
    startPicking,
    togglePicking,
    session,
    setLevel,
    confirmSelection,
    requestRepick,
    saveComment,
    skipComment,
  };
}
