import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { MousePointerClickIcon } from "lucide-react";
import {
  TID_BROWSER_ELEMENT_PICKER_BAR,
  TID_BROWSER_ELEMENT_PICKER_CANCEL_BUTTON,
  TID_BROWSER_ELEMENT_PICKER_COMMENT_ADD_BUTTON,
  TID_BROWSER_ELEMENT_PICKER_COMMENT_INPUT,
  TID_BROWSER_ELEMENT_PICKER_LEVEL_BREADCRUMB,
  TID_BROWSER_ELEMENT_PICKER_LEVEL_SLIDER,
  TID_BROWSER_ELEMENT_PICKER_REPICK_BUTTON,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import type { WebElementPickerSession } from "@/lib/webElementPickerSession.js";

interface WebElementPickerBarProps {
  session: WebElementPickerSession;
  onSetLevel: (level: number) => void;
  /** 唯一确认：当前层级元素 + 草稿评语（可空）一次提交。 */
  onAddComment: (comment: string) => void;
  onRepick: () => void;
  onCancel: () => void;
}

/**
 * 网页元素拾取浮条：hover 提示 / 调整阶段（一行层级指示 + 滑轨 + 就地评语框 + 动作行），
 * 绝对定位悬浮在 webview 视口底部。
 *
 * 层级与评语合成一个阶段（用户实测反馈：祖先链不必逐个列出，确认一次提交）：
 * 滑轨正下方就是评语框，「加入对话」把当前层级元素与评语一起加入对话 —— 没有第二次确认。
 *
 * 纯受控组件（草稿除外）：状态全部来自 `useWebElementPicker` 的 session，
 * 动作原样转发给 hook —— 页内状态机与 renderer 之间只有 executeJs 一条通道。
 */
export function WebElementPickerBar({
  session,
  onSetLevel,
  onAddComment,
  onRepick,
  onCancel,
}: WebElementPickerBarProps) {
  const { intl } = useZCodeIntl();
  const [comment, setComment] = useState("");
  const compositionActiveRef = useRef(false);
  // 草稿只属于「当前这一轮」：额度变化（同一 chain 对象）不清，换元素或退出调整阶段就清，
  // 免得上一条评语串到下一个元素上。
  const roundChain = session.phase === "adjust" ? session.chain : null;

  useEffect(() => {
    setComment("");
    compositionActiveRef.current = false;
  }, [roundChain]);

  const hintLabel = intl.formatMessage({ id: "browser.elementPicker.bar.hint" });
  const adjustHintLabel = intl.formatMessage({ id: "browser.elementPicker.bar.adjustHint" });
  const sliderLabel = intl.formatMessage({ id: "browser.elementPicker.bar.sliderLabel" });
  const repickLabel = intl.formatMessage({ id: "browser.elementPicker.bar.repick" });
  const cancelLabel = intl.formatMessage({ id: "browser.elementPicker.bar.cancel" });
  const levelIndicatorLabel = intl.formatMessage({
    id: "browser.elementPicker.bar.levelIndicator",
  });
  const chainTruncatedLabel = intl.formatMessage({
    id: "browser.elementPicker.bar.chainTruncated",
  });
  const commentPlaceholder = intl.formatMessage({
    id: "browser.elementPicker.comment.placeholder",
  });
  const addCommentLabel = intl.formatMessage({ id: "browser.elementPicker.comment.add" });

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") {
      return;
    }

    const eventFromCommentInput =
      event.target instanceof Element &&
      event.target.closest(`[data-testid="${TID_BROWSER_ELEMENT_PICKER_COMMENT_INPUT}"]`) !== null;
    if (eventFromCommentInput) {
      if (
        isImeComposingKeyEvent({
          compositionActive: compositionActiveRef.current,
          isComposing: event.nativeEvent.isComposing,
        })
      ) {
        // 中文/日文输入法下 Esc 是取消候选词，不是弃草稿。
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      // 评语框内 Esc = 只丢弃草稿，不退出会话、也不重选。
      setComment("");
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (session.phase === "adjust") {
      onRepick();
      return;
    }
    onCancel();
  };

  const chainLength = session.chain.length;
  const maxLevel = Math.max(0, chainLength - 1);
  const level = Math.min(session.level, maxLevel);
  const levelIndicator = intl.formatMessage(
    { id: "browser.elementPicker.bar.levelIndicator" },
    { n: level + 1, total: chainLength },
  );

  return (
    <div
      data-testid={TID_BROWSER_ELEMENT_PICKER_BAR}
      role="toolbar"
      aria-label={session.phase === "adjust" ? adjustHintLabel : hintLabel}
      className="absolute bottom-3 left-1/2 z-30 flex w-fit max-w-[calc(100%-1.5rem)] -translate-x-1/2 flex-col gap-2 rounded-xl border border-popover-border bg-popover px-3 py-2 text-ui-base text-foreground shadow-md"
      onKeyDown={handleKeyDown}
    >
      {session.phase === "hover" ? (
        <div className="flex items-center gap-2">
          <MousePointerClickIcon className="size-4 shrink-0 text-foreground-subtle" />
          <span className="whitespace-nowrap">{hintLabel}</span>
          {session.pickedCount > 0 ? (
            <span className="whitespace-nowrap text-foreground-subtle">
              {intl.formatMessage(
                { id: "browser.elementPicker.bar.selectedCount" },
                { count: session.pickedCount },
              )}
            </span>
          ) : null}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            data-testid={TID_BROWSER_ELEMENT_PICKER_CANCEL_BUTTON}
            onClick={onCancel}
          >
            {cancelLabel}
          </Button>
        </div>
      ) : null}

      {session.phase === "adjust" ? (
        <div className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <div
              data-testid={TID_BROWSER_ELEMENT_PICKER_LEVEL_BREADCRUMB}
              className="flex min-w-0 items-center gap-1 font-mono"
            >
              <span className="truncate font-medium">{session.chain[level]?.label}</span>
              {session.chainTruncated ? (
                <span className="shrink-0 text-foreground-subtle" title={chainTruncatedLabel}>
                  …
                </span>
              ) : null}
            </div>
            <span className="shrink-0 text-foreground-subtle" title={levelIndicatorLabel}>
              {levelIndicator}
            </span>
            <span className="truncate text-foreground-subtle">{adjustHintLabel}</span>
          </div>
          <input
            type="range"
            min={0}
            max={maxLevel}
            value={level}
            disabled={chainLength <= 1}
            aria-label={sliderLabel}
            data-testid={TID_BROWSER_ELEMENT_PICKER_LEVEL_SLIDER}
            onChange={(event) => onSetLevel(Number(event.target.value))}
            className="h-7 w-full accent-primary"
          />
          <Textarea
            rows={3}
            value={comment}
            data-testid={TID_BROWSER_ELEMENT_PICKER_COMMENT_INPUT}
            aria-label={commentPlaceholder}
            placeholder={commentPlaceholder}
            className="min-h-16 resize-none border-input-border bg-input placeholder:text-foreground-subtlest hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0"
            onChange={(event) => setComment(event.target.value)}
            onCompositionStart={() => {
              compositionActiveRef.current = true;
            }}
            onCompositionEnd={() => {
              compositionActiveRef.current = false;
            }}
          />
          <div className="flex items-center justify-end gap-1">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              data-testid={TID_BROWSER_ELEMENT_PICKER_REPICK_BUTTON}
              onClick={onRepick}
            >
              {repickLabel}
            </Button>
            <Button
              type="button"
              size="xs"
              data-testid={TID_BROWSER_ELEMENT_PICKER_COMMENT_ADD_BUTTON}
              onClick={() => onAddComment(comment)}
            >
              {addCommentLabel}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              data-testid={TID_BROWSER_ELEMENT_PICKER_CANCEL_BUTTON}
              onClick={onCancel}
            >
              {cancelLabel}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
