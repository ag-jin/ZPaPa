import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronRightIcon, MousePointerClickIcon } from "lucide-react";
import {
  TID_BROWSER_ELEMENT_PICKER_BAR,
  TID_BROWSER_ELEMENT_PICKER_COMMENT_ADD_BUTTON,
  TID_BROWSER_ELEMENT_PICKER_COMMENT_INPUT,
  TID_BROWSER_ELEMENT_PICKER_COMMENT_SKIP_BUTTON,
  TID_BROWSER_ELEMENT_PICKER_CONFIRM_BUTTON,
  TID_BROWSER_ELEMENT_PICKER_DONE_BUTTON,
  TID_BROWSER_ELEMENT_PICKER_LEVEL_BREADCRUMB,
  TID_BROWSER_ELEMENT_PICKER_LEVEL_SLIDER,
  TID_BROWSER_ELEMENT_PICKER_REPICK_BUTTON,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import type { WebElementPickerSession } from "@/lib/webElementPickerSession.js";

interface WebElementPickerBarProps {
  session: WebElementPickerSession;
  onSetLevel: (level: number) => void;
  onConfirm: () => void;
  onRepick: () => void;
  onDone: () => void;
  onSaveComment: (comment: string) => void;
  onSkipComment: () => void;
}

/**
 * 网页元素拾取浮条：hover 提示 / 层级滑轨 / 评语录入三态，绝对定位悬浮在 webview 视口底部。
 *
 * 纯受控组件（草稿除外）：状态全部来自 `useWebElementPicker` 的 session，
 * 动作原样转发给 hook —— 页内状态机与 renderer 之间只有 executeJs 一条通道。
 */
export function WebElementPickerBar({
  session,
  onSetLevel,
  onConfirm,
  onRepick,
  onDone,
  onSaveComment,
  onSkipComment,
}: WebElementPickerBarProps) {
  const { intl } = useZCodeIntl();
  const [comment, setComment] = useState("");
  const compositionActiveRef = useRef(false);

  useEffect(() => {
    if (session.phase !== "comment") {
      setComment("");
      compositionActiveRef.current = false;
    }
  }, [session.phase]);

  const hintLabel = intl.formatMessage({ id: "browser.elementPicker.bar.hint" });
  const adjustHintLabel = intl.formatMessage({ id: "browser.elementPicker.bar.adjustHint" });
  const sliderLabel = intl.formatMessage({ id: "browser.elementPicker.bar.sliderLabel" });
  const repickLabel = intl.formatMessage({ id: "browser.elementPicker.bar.repick" });
  const confirmLabel = intl.formatMessage({ id: "browser.elementPicker.bar.confirm" });
  const doneLabel = intl.formatMessage({ id: "browser.elementPicker.bar.done" });
  const chainTruncatedLabel = intl.formatMessage({
    id: "browser.elementPicker.bar.chainTruncated",
  });
  const commentPlaceholder = intl.formatMessage({
    id: "browser.elementPicker.comment.placeholder",
  });
  const addCommentLabel = intl.formatMessage({ id: "browser.elementPicker.comment.add" });
  const skipCommentLabel = intl.formatMessage({ id: "browser.elementPicker.comment.skip" });

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") {
      return;
    }

    if (session.phase === "comment") {
      if (
        isImeComposingKeyEvent({
          compositionActive: compositionActiveRef.current,
          isComposing: event.nativeEvent.isComposing,
        })
      ) {
        // 中文/日文输入法下 Esc 是取消候选词，不是弃评语。
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      // Esc 与「跳过」同义：只丢弃本次评语草稿，不退出会话。
      setComment("");
      onSkipComment();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (session.phase === "adjust") {
      onRepick();
      return;
    }
    onDone();
  };

  const chainLength = session.chain.length;
  const maxLevel = Math.max(0, chainLength - 1);
  const breadcrumb = [...session.chain]
    .sort((left, right) => right.level - left.level)
    .map((step) => ({
      ...step,
      current: step.level === session.level,
    }));

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
            data-testid={TID_BROWSER_ELEMENT_PICKER_DONE_BUTTON}
            onClick={onDone}
          >
            {doneLabel}
          </Button>
        </div>
      ) : null}

      {session.phase === "adjust" ? (
        <>
          <div className="flex min-w-0 items-center gap-1 overflow-hidden">
            <div
              data-testid={TID_BROWSER_ELEMENT_PICKER_LEVEL_BREADCRUMB}
              className="flex min-w-0 items-center gap-1 overflow-hidden font-mono text-foreground-subtle"
            >
              {breadcrumb.map((step, index) => (
                <span key={step.level} className="flex min-w-0 items-center gap-1">
                  {index > 0 ? <ChevronRightIcon className="size-3 shrink-0" /> : null}
                  <span
                    className={cn(
                      "truncate",
                      step.current && "rounded-sm bg-surface px-1 font-medium text-foreground",
                    )}
                  >
                    {step.label}
                  </span>
                </span>
              ))}
              {session.chainTruncated ? (
                <span className="flex min-w-0 items-center gap-1">
                  <ChevronRightIcon className="size-3 shrink-0" />
                  <span className="truncate" title={chainTruncatedLabel}>
                    …
                  </span>
                </span>
              ) : null}
            </div>
            <span className="whitespace-nowrap pl-1 text-foreground-subtle">{adjustHintLabel}</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={maxLevel}
              value={Math.min(session.level, maxLevel)}
              disabled={chainLength <= 1}
              aria-label={sliderLabel}
              data-testid={TID_BROWSER_ELEMENT_PICKER_LEVEL_SLIDER}
              onChange={(event) => onSetLevel(Number(event.target.value))}
              className="h-7 w-40 accent-primary"
            />
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
              data-testid={TID_BROWSER_ELEMENT_PICKER_CONFIRM_BUTTON}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              data-testid={TID_BROWSER_ELEMENT_PICKER_DONE_BUTTON}
              onClick={onDone}
            >
              {doneLabel}
            </Button>
          </div>
        </>
      ) : null}

      {session.phase === "comment" ? (
        <div className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
          <div className="truncate font-mono text-foreground-subtle">
            {session.lastSelected?.selector ?? session.lastSelected?.tagName ?? ""}
          </div>
          <Textarea
            autoFocus
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
              data-testid={TID_BROWSER_ELEMENT_PICKER_COMMENT_SKIP_BUTTON}
              onClick={onSkipComment}
            >
              {skipCommentLabel}
            </Button>
            <Button
              type="button"
              size="xs"
              data-testid={TID_BROWSER_ELEMENT_PICKER_COMMENT_ADD_BUTTON}
              onClick={() => onSaveComment(comment)}
            >
              {addCommentLabel}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
