import { useRef, useState } from "react";
import { Globe2Icon, MessageSquareTextIcon, MousePointer2Icon, Trash2Icon } from "lucide-react";
import {
  TID_WEB_ELEMENT_CHIP_COMMENT_EDIT,
  TID_WEB_ELEMENT_CHIP_COMMENT_INPUT,
} from "@zcode/shared";
import type { AttachmentHoverCardContentProps } from "@/components/ai-elements/attachments.js";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import type { WebElementContextComposerAttachment } from "@/lib/webElementContext.js";
import { ContextAttachmentPill } from "@/v4/composer/ContextAttachmentPill.js";

function getElementTitle(context: WebElementContextComposerAttachment) {
  return (
    context.accessibleName || context.text || context.selector || context.tagName.toLowerCase()
  );
}

function getElementMeta(context: WebElementContextComposerAttachment) {
  const role = context.role ? `role=${context.role}` : null;
  const tagName = context.tagName.toLowerCase();
  return [tagName, role].filter(Boolean).join(" · ");
}

export function WebElementContextAttachmentChip({
  contexts,
  contentAlign = "start",
  onRemove,
  onRemoveAll,
  onEditComment,
}: {
  contexts: readonly WebElementContextComposerAttachment[];
  contentAlign?: AttachmentHoverCardContentProps["align"];
  onRemove?: (id: string) => void;
  onRemoveAll?: () => void;
  /** 不传即只读（历史消息行复用同一个 chip）；传了才显示「编辑评语」入口。 */
  onEditComment?: (id: string, comment: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const compositionActiveRef = useRef(false);

  if (contexts.length === 0) {
    return null;
  }

  const label = intl.formatMessage(
    {
      id: contexts.length === 1 ? "chat.webElements.one" : "chat.webElements.many",
    },
    { count: String(contexts.length) },
  );
  const removeLabel = intl.formatMessage({ id: "chat.webElements.remove" });
  const commentLabel = intl.formatMessage({ id: "chat.webElements.comment" });
  const editCommentLabel = intl.formatMessage({ id: "chat.webElements.editComment" });
  const saveCommentLabel = intl.formatMessage({ id: "chat.webElements.saveComment" });
  const cancelCommentLabel = intl.formatMessage({ id: "chat.webElements.cancelComment" });

  const startEditing = (context: WebElementContextComposerAttachment) => {
    setEditingId(context.id);
    setDraft(context.comment ?? "");
    compositionActiveRef.current = false;
  };

  const stopEditing = () => {
    setEditingId(null);
    setDraft("");
    compositionActiveRef.current = false;
  };

  return (
    <ContextAttachmentPill
      contentAlign={contentAlign}
      icon={<MousePointer2Icon className="size-4 shrink-0 text-foreground-subtle" />}
      label={label}
      onRemoveAll={onRemoveAll}
      removeLabel={removeLabel}
    >
      {contexts.map((context) => {
        const editing = editingId === context.id;
        return (
          <div
            key={context.id}
            className="group/context flex min-h-7 cursor-default gap-2 rounded-lg px-2 py-1 text-ui-base/relaxed text-foreground hover:bg-menu-hover"
          >
            <Globe2Icon className="mt-1 size-4 shrink-0 text-foreground-subtle" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                <div className="min-w-0 flex-1 truncate font-medium">
                  {getElementTitle(context)}
                </div>
                {onEditComment && !editing ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="size-5 shrink-0 rounded-sm text-foreground-subtle opacity-0 transition-opacity hover:text-foreground group-hover/context:opacity-100 focus-visible:opacity-100"
                    data-testid={`${TID_WEB_ELEMENT_CHIP_COMMENT_EDIT}-${context.id}`}
                    aria-label={editCommentLabel}
                    title={editCommentLabel}
                    onClick={(event) => {
                      event.stopPropagation();
                      startEditing(context);
                    }}
                  >
                    <MessageSquareTextIcon className="size-3.5" />
                  </Button>
                ) : null}
              </div>
              <div className="truncate font-mono text-ui-base text-foreground-subtle">
                {getElementMeta(context)}
              </div>
              <div className="truncate text-ui-base text-foreground-subtlest">
                {context.pageTitle || context.pageUrl}
              </div>
              {context.comment && !editing ? (
                <div className="truncate text-ui-base text-foreground">
                  <span className="text-foreground-subtle">{commentLabel}：</span>
                  {context.comment}
                </div>
              ) : null}
              {editing ? (
                <div className="mt-1 flex flex-col gap-1">
                  <Textarea
                    autoFocus
                    rows={2}
                    value={draft}
                    data-testid={TID_WEB_ELEMENT_CHIP_COMMENT_INPUT}
                    aria-label={editCommentLabel}
                    placeholder={commentLabel}
                    className="min-h-12 resize-none border-input-border bg-input text-ui-base placeholder:text-foreground-subtlest hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0"
                    onChange={(event) => setDraft(event.target.value)}
                    onCompositionStart={() => {
                      compositionActiveRef.current = true;
                    }}
                    onCompositionEnd={() => {
                      compositionActiveRef.current = false;
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Escape") {
                        return;
                      }
                      if (
                        isImeComposingKeyEvent({
                          compositionActive: compositionActiveRef.current,
                          isComposing: event.nativeEvent.isComposing,
                        })
                      ) {
                        // 中文/日文输入法下 Esc 是取消候选词，不关闭评语编辑。
                        return;
                      }
                      // Esc 与「取消」同义：只丢弃草稿，不动已保存的评语。
                      event.preventDefault();
                      event.stopPropagation();
                      stopEditing();
                    }}
                  />
                  <div className="flex items-center justify-end gap-1">
                    <Button type="button" size="xs" variant="ghost" onClick={stopEditing}>
                      {cancelCommentLabel}
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      onClick={(event) => {
                        event.stopPropagation();
                        onEditComment?.(context.id, draft);
                        stopEditing();
                      }}
                    >
                      {saveCommentLabel}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
            {onRemove ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="mt-0.5 size-5 shrink-0 rounded-sm text-foreground-subtle opacity-0 transition-opacity hover:text-foreground group-hover/context:opacity-100"
                aria-label={removeLabel}
                title={removeLabel}
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(context.id);
                }}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            ) : null}
          </div>
        );
      })}
    </ContextAttachmentPill>
  );
}
