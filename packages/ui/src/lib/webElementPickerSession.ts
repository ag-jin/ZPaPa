import { logger } from "@/logger.js";
import {
  dispatchWebElementContextAddToChat,
  getWebElementContextDedupeKey,
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

export type WebElementPickerPhase = "hover" | "adjust";

/**
 * 拾取会话状态（浮条的唯一数据源）：
 * hover = 等点击，adjust = 层级滑轨 + 就地评语框。
 * 「加入对话」= 确认当前层级元素与评语**一次**派发（评语空则不带 comment 字段）。
 */
export interface WebElementPickerSession {
  phase: WebElementPickerPhase;
  chain: readonly WebElementAncestorStep[];
  chainTruncated: boolean;
  level: number;
  /** 已确认元素的身份去重计数（与 chip 的身份合并口径一致）。 */
  pickedCount: number;
}

export interface WebElementPickerSessionDriver {
  start: () => Promise<void>;
  cancel: () => Promise<void>;
  setLevel: (level: number) => void;
  /** 携带本轮评语（可空）：页内 confirm 落定元素负载后，与评语一并派发。 */
  confirmSelection: (comment?: string) => void;
  requestRepick: () => void;
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

/** 页内元素负载 → 上下文 payload（补齐 workspace 身份并按既有契约校验）。 */
export function buildWebElementContextPayload(params: {
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
 * 注入一次整脚本 → 每个元素 = pick() → beginAdjust() →「加入对话」一次派发 → 再 pick()。
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
  /** 本轮「加入对话」带上来的评语（渲染侧写入点规范化），随 confirm 落定一次性取用。 */
  let pendingComment = "";
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

  const confirmSelection = (comment?: string) => {
    if (!session || session.phase !== "adjust") {
      return;
    }
    // 评语随确认同行：写入点规范化一次，页内只需落定元素负载（不回页面取数、也不二次派发）。
    pendingComment = normalizeWebElementComment(comment);
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

  const cancel = async () => {
    generation += 1;
    discardLevelFrame();
    pendingComment = "";
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
    pendingComment = "";
    emit(hoverSession(0));

    try {
      const context = options.getContext();
      const injectionScript = buildWebElementPickerScript(
        context.labels ? { labels: context.labels } : {},
      );
      // 首段是整脚本注入：失败必须冒泡，renderer 用它上 elementPickerFailed 横幅。
      let pickResult = await waitForPick(executeJs(injectionScript), runId, true);
      // 计数与 chip 的身份合并同口径：同一元素重选只算一条，否则浮条会比 composer 多报。
      const pickedKeys = new Set<string>();
      let pickedCount = 0;

      while (isCurrent(runId) && pickResult.status === "clicked") {
        // 顺序不变量：beginAdjust 必须与浮条渲染同 tick 发出（且先于按钮可见），
        // 页内 confirm/requestRepick 才有 pending promise 可落定。
        const adjustPromise = executeJs(buildWebElementPickerCommandScript("beginAdjust"));
        pendingComment = "";
        emit({
          phase: "adjust",
          chain: pickResult.chain,
          chainTruncated: pickResult.chainTruncated,
          level: 0,
          pickedCount,
        });

        const adjust = await waitForAdjust(adjustPromise, runId);
        if (!isCurrent(runId) || adjust.status === "cancelled") {
          break;
        }

        if (adjust.status === "selected") {
          const element = buildWebElementContextPayload({
            element: adjust.element,
            workspacePath: context.workspacePath,
            ...(context.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
          });
          if (!element) {
            logger.warn(`${LOG_PREFIX} 网页元素上下文无效，已丢弃`);
            break;
          }

          const comment = pendingComment;
          pendingComment = "";
          // 单次派发：元素与评语同一次提交（chip 身份合并负责重选同元素的原位更新）。
          dispatchPayload(comment ? { ...element, comment } : element);
          pickedKeys.add(getWebElementContextDedupeKey(element));
          pickedCount = pickedKeys.size;
          logger.info(`${LOG_PREFIX} 网页元素上下文已加入聊天`, {
            tagName: element.tagName,
            url: sanitizeUrlForLog(element.pageUrl),
          });
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

  return { start, cancel, setLevel, confirmSelection, requestRepick };
}
