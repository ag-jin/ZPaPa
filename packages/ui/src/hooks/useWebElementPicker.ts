import { useCallback, useEffect, useRef, useState } from "react";
import { TID_BROWSER_ELEMENT_PICKER_BAR } from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  dispatchWebElementContextAddToChat,
  isWebElementContextPayload,
  normalizeWebElementComment,
  type WebElementContextPayload,
} from "@/lib/webElementContext.js";
import {
  buildCancelWebElementPickerScript,
  buildWebElementPickerCommandScript,
  buildWebElementPickerScript,
  type WebElementAncestorStep,
  type WebElementPickerAdjustResult,
  type WebElementPickerPickResult,
  type WebElementPickerScriptLabels,
} from "@/lib/webElementPickerScript.js";

const LOG_PREFIX = "[UnifiedBrowserView]";

export type WebElementPickerPhase = "hover" | "adjust" | "comment";

/**
 * 拾取会话状态（浮条的唯一数据源）：
 * hover = 等点击，adjust = 层级滑轨，comment = 该元素评语待录入。
 * 元素确认后**先**派发再进 comment（chip 立即可见），评语是第二次派发（身份合并原位更新）。
 */
export interface WebElementPickerSession {
  phase: WebElementPickerPhase;
  chain: readonly WebElementAncestorStep[];
  chainTruncated: boolean;
  level: number;
  pickedCount: number;
  lastSelected: WebElementContextPayload | null;
}

export interface WebElementPickerSessionDriver {
  start: () => Promise<void>;
  cancel: () => Promise<void>;
  setLevel: (level: number) => void;
  confirmSelection: () => void;
  requestRepick: () => void;
  saveComment: (comment: string) => void;
  skipComment: () => void;
}

export interface WebElementPickerSessionDriverOptions {
  /** 每次调用都取最新值：会话可能跨越 webview 重建或 workspace 切换。 */
  getContext: () => {
    executeJs: (script: string) => Promise<unknown>;
    workspacePath: string;
    workspaceIdentity?: string;
    labels?: Partial<WebElementPickerScriptLabels>;
  };
  onSessionChange: (session: WebElementPickerSession | null) => void;
  /** 默认走 window CustomEvent（与既有 add-to-chat 链路一致），测试可注入收集器。 */
  dispatchPayload?: (payload: WebElementContextPayload) => void;
}

function isWebElementPickerPickResult(value: unknown): value is WebElementPickerPickResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as WebElementPickerPickResult;
  return (
    candidate.status === "cancelled" ||
    (candidate.status === "clicked" && Array.isArray(candidate.chain))
  );
}

function isWebElementPickerAdjustResult(value: unknown): value is WebElementPickerAdjustResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as WebElementPickerAdjustResult;
  return (
    candidate.status === "cancelled" ||
    candidate.status === "repick" ||
    (candidate.status === "selected" &&
      typeof candidate.element === "object" &&
      candidate.element !== null)
  );
}

function buildPayload(params: {
  element: Omit<WebElementContextPayload, "workspacePath">;
  workspacePath: string;
  workspaceIdentity?: string;
}): WebElementContextPayload | null {
  const payload: WebElementContextPayload = {
    ...params.element,
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
  };

  return isWebElementContextPayload(payload) ? payload : null;
}

function sanitizeUrlForLog(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/u)[0] ?? "";
  }
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 拾取会话循环（与 React 无关，便于单测直接驱动）：
 * 注入一次整脚本 → 每个元素 = pick() → beginAdjust() → 派发 → comment → 再 pick()。
 *
 * 错误收敛：首段注入失败**冒泡**（renderer 上横幅），其余阶段一律按 cancelled 静默收敛并 debug 记录。
 * 防串：每次 start/cancel 递增 generation，旧会话在途结果一律丢弃。
 */
export function createWebElementPickerSessionDriver(
  options: WebElementPickerSessionDriverOptions,
): WebElementPickerSessionDriver {
  const dispatchPayload = options.dispatchPayload ?? dispatchWebElementContextAddToChat;
  let generation = 0;
  let session: WebElementPickerSession | null = null;
  let commentWaiter: ((outcome: "continue" | "cancelled") => void) | null = null;
  let levelFrame: number | null = null;
  let pendingLevel: number | null = null;

  const isCurrent = (runId: number) => generation === runId;

  const emit = (next: WebElementPickerSession | null) => {
    session = next;
    options.onSessionChange(next);
  };

  const hoverSession = (pickedCount: number): WebElementPickerSession => ({
    phase: "hover",
    chain: [],
    chainTruncated: false,
    level: 0,
    pickedCount,
    lastSelected: null,
  });

  const executeJs = (script: string) => options.getContext().executeJs(script);

  const discardLevelFrame = () => {
    pendingLevel = null;
    if (levelFrame === null) {
      return;
    }
    if (typeof globalThis.cancelAnimationFrame === "function") {
      globalThis.cancelAnimationFrame(levelFrame);
    }
    levelFrame = null;
  };

  const settleComment = (outcome: "continue" | "cancelled") => {
    const waiter = commentWaiter;
    commentWaiter = null;
    waiter?.(outcome);
  };

  const waitForComment = (runId: number) =>
    new Promise<"continue" | "cancelled">((resolve) => {
      if (!isCurrent(runId)) {
        resolve("cancelled");
        return;
      }
      commentWaiter = resolve;
    });

  /** 滑轨每帧最多一次页内调用：拖动期间的中间档位直接合并掉。 */
  const flushLevel = () => {
    levelFrame = null;
    const next = pendingLevel;
    pendingLevel = null;
    if (next === null || !session || session.phase !== "adjust") {
      return;
    }
    const level = Math.max(0, Math.min(session.chain.length - 1, next));
    emit({ ...session, level });
    void executeJs(buildWebElementPickerCommandScript("showAncestor", level)).catch((error) => {
      logger.debug(`${LOG_PREFIX} 调整网页元素层级失败`, { error: describeError(error) });
    });
  };

  const waitForAdjust = async (
    adjustPromise: Promise<unknown>,
    runId: number,
  ): Promise<WebElementPickerAdjustResult> => {
    try {
      const value = await adjustPromise;
      return isCurrent(runId) && isWebElementPickerAdjustResult(value)
        ? value
        : { status: "cancelled" };
    } catch (error) {
      logger.debug(`${LOG_PREFIX} 层级调整阶段中断，按取消收敛`, {
        error: describeError(error),
      });
      return { status: "cancelled" };
    }
  };

  const waitForPick = async (
    pickPromise: Promise<unknown>,
    runId: number,
    logOnFailure: boolean,
  ): Promise<WebElementPickerPickResult> => {
    try {
      const value = await pickPromise;
      if (!isCurrent(runId)) {
        return { status: "cancelled" };
      }
      if (isWebElementPickerPickResult(value)) {
        return value;
      }
      if (value !== null && value !== undefined) {
        logger.warn(`${LOG_PREFIX} 网页元素选择返回了无法识别的结果`);
      }
      return { status: "cancelled" };
    } catch (error) {
      if (logOnFailure) {
        throw error;
      }
      logger.debug(`${LOG_PREFIX} 网页元素选择中断，按取消收敛`, {
        error: describeError(error),
      });
      return { status: "cancelled" };
    }
  };

  const setLevel = (level: number) => {
    if (!session || session.phase !== "adjust") {
      return;
    }
    pendingLevel = level;
    if (levelFrame !== null) {
      return;
    }
    if (typeof globalThis.requestAnimationFrame === "function") {
      levelFrame = globalThis.requestAnimationFrame(flushLevel);
      return;
    }
    flushLevel();
  };

  const confirmSelection = () => {
    if (!session || session.phase !== "adjust") {
      return;
    }
    void executeJs(buildWebElementPickerCommandScript("confirm")).catch((error) => {
      logger.debug(`${LOG_PREFIX} 确认网页元素选择失败`, { error: describeError(error) });
    });
  };

  const requestRepick = () => {
    if (!session || session.phase !== "adjust") {
      return;
    }
    void executeJs(buildWebElementPickerCommandScript("requestRepick")).catch((error) => {
      logger.debug(`${LOG_PREFIX} 重选网页元素失败`, { error: describeError(error) });
    });
  };

  const saveComment = (comment: string) => {
    if (!session || session.phase !== "comment" || !session.lastSelected) {
      return;
    }
    const normalized = normalizeWebElementComment(comment);
    if (normalized) {
      // 评语写入点之一（另一处是 chip 内联编辑）：这里规范化后按身份补派发，不回页面取数。
      dispatchPayload({ ...session.lastSelected, comment: normalized });
    }
    settleComment("continue");
  };

  const skipComment = () => {
    if (!session || session.phase !== "comment") {
      return;
    }
    settleComment("continue");
  };

  const cancel = async () => {
    generation += 1;
    discardLevelFrame();
    settleComment("cancelled");
    if (session !== null) {
      emit(null);
    }
    try {
      await executeJs(buildCancelWebElementPickerScript());
    } catch (error) {
      logger.debug(`${LOG_PREFIX} 取消网页元素选择失败`, { error: describeError(error) });
    }
  };

  const start = async () => {
    const runId = generation + 1;
    generation = runId;
    discardLevelFrame();
    settleComment("cancelled");
    emit(hoverSession(0));

    try {
      const context = options.getContext();
      const injectionScript = buildWebElementPickerScript(
        context.labels ? { labels: context.labels } : {},
      );
      // 首段是整脚本注入：失败必须冒泡，renderer 用它上 elementPickerFailed 横幅。
      let pickResult = await waitForPick(executeJs(injectionScript), runId, true);
      let pickedCount = 0;

      while (isCurrent(runId) && pickResult.status === "clicked") {
        // 顺序不变量：beginAdjust 必须与浮条渲染同 tick 发出（且先于按钮可见），
        // 页内 confirm/requestRepick 才有 pending promise 可落定。
        const adjustPromise = executeJs(buildWebElementPickerCommandScript("beginAdjust"));
        emit({
          phase: "adjust",
          chain: pickResult.chain,
          chainTruncated: pickResult.chainTruncated,
          level: 0,
          pickedCount,
          lastSelected: null,
        });

        const adjust = await waitForAdjust(adjustPromise, runId);
        if (!isCurrent(runId) || adjust.status === "cancelled") {
          break;
        }

        if (adjust.status === "selected") {
          const element = buildPayload({
            element: adjust.element,
            workspacePath: context.workspacePath,
            ...(context.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
          });
          if (!element) {
            logger.warn(`${LOG_PREFIX} 网页元素上下文无效，已丢弃`);
            break;
          }

          dispatchPayload(element);
          pickedCount += 1;
          logger.info(`${LOG_PREFIX} 网页元素上下文已加入聊天`, {
            tagName: element.tagName,
            url: sanitizeUrlForLog(element.pageUrl),
          });
          emit({
            phase: "comment",
            chain: pickResult.chain,
            chainTruncated: pickResult.chainTruncated,
            level: session?.level ?? 0,
            pickedCount,
            lastSelected: element,
          });

          const outcome = await waitForComment(runId);
          if (!isCurrent(runId) || outcome === "cancelled") {
            break;
          }
        }

        if (!isCurrent(runId)) {
          break;
        }
        // 回到 hover 继续选下一个；页内 Esc/取消由 pick 结果收敛为会话结束。
        emit(hoverSession(pickedCount));
        pickResult = await waitForPick(
          executeJs(buildWebElementPickerCommandScript("pick")),
          runId,
          false,
        );
      }
    } finally {
      if (isCurrent(runId)) {
        emit(null);
      }
    }
  };

  return { start, cancel, setLevel, confirmSelection, requestRepick, saveComment, skipComment };
}

interface UseWebElementPickerOptions {
  /**
   * 传输无关的脚本执行出口：把选择脚本送到目标网页并回传结果。
   * UnifiedBrowserView 走 renderer 侧的 `<webview>.executeJavaScript`（不是 main IPC）。
   */
  executeJs: (script: string) => Promise<unknown>;
  workspacePath: string;
  workspaceIdentity?: string;
  labels?: Partial<WebElementPickerScriptLabels>;
}

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

  const driverRef = useRef<WebElementPickerSessionDriver | null>(null);
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
