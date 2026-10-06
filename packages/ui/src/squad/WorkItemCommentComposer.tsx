import { useCallback, useMemo, useRef, useState } from "react";
import type { WorkItemCommentRecord } from "@zcode/services";
import { CloudOff, StickyNote } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { WorkItemMentionMenu } from "./WorkItemMentionMenu.js";
import type { MentionRoster } from "./workItemCollaborationViewModel.js";
import { draftHasNotePrefix, toggleNotePrefix } from "./workItemCollaborationViewModel.js";
import {
  activeMentionQuery,
  buildMentionMenu,
  mentionOptionInsertText,
  moveMentionSelection,
} from "./workItemMentionViewModel.js";

/* B5.1 轮 1：人类评论 composer 的**交互外壳**（设计案 §4）。

   **本轮刻意不可用**：写入面（轮 2 的四个写入口 + D1 的本地人类身份）还没接通。
   按设计案 §10 轮 1 的明文要求，这里给「明确不可用 + 原因」，**不**用本地状态模拟落库、
   **不**乐观插入、**不**伪造已写入的 Comment —— 一个「看起来发出去了、其实什么都没发生」的
   输入框比一个禁用态坏得多（用户会以为话已经说给人了）。

   本轮真正能用的只有**本地草稿**语义：回复上下文（切给哪条评论）、`/note` 显式模式、
   `@` 补全候选 —— 它们都不落盘，也不认定派发目标（客户端补全只是输入辅助，设计案 §4.2）。

   `WORK_ITEM_COMMENT_SUBMIT_ENABLED` 是**唯一**的可点性判据（轮 2 接线时只改这一处 +
   在 `onSubmit` 里调用服务）。 */

export const WORK_ITEM_COMMENT_SUBMIT_ENABLED = false;

/** 提交禁用理由的帮助文案锚点（`aria-describedby` 指向它，不靠悬停才看得到）。 */
const SUBMIT_REASON_ID = "work-item-comment-submit-reason";

export function WorkItemCommentComposer({
  roster,
  replyTarget,
  onCancelReply,
  disabledReasonMessageId,
}: {
  /** `null` = 名册不可用（快照读失败）：必须**说出来**，不静默不出菜单（设计案 §4.2）。 */
  roster: MentionRoster | null;
  /** 正在回复的那条评论（`null` = 顶层评论）。 */
  replyTarget: WorkItemCommentRecord | null;
  onCancelReply: () => void;
  /** 不可用的原因文案键（归档 / 读取失败 / 写面未接通），经 aria + 帮助文案表达。
      缺省 = 写面未接通 —— 轮 1 的通用真相（页面只在归档 / 刷新失败时覆盖它）。 */
  disabledReasonMessageId?: string;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const [draft, setDraft] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  /* Escape 关闭候选：**不**改草稿（丢一个字都不行 —— 用户打的可能就是他想说的）。
     任何一次输入都把菜单放回来（再打一个字符 = 新的一次补全意图）。 */
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const reasonMessageId =
    disabledReasonMessageId ?? "squad.workItemDetail.comment.disabled.writeUnavailable";

  const noteMode = draftHasNotePrefix(draft);
  const mentionQuery = useMemo(() => activeMentionQuery(draft), [draft]);
  const mentionMenu = useMemo(
    () =>
      mentionQuery === null || mentionDismissed
        ? null
        : buildMentionMenu({ roster, query: mentionQuery.query }),
    [mentionQuery, mentionDismissed, roster],
  );
  const options = mentionMenu?.kind === "ready" ? mentionMenu.options : [];
  const reasonText = t(reasonMessageId);

  /** 补全插入：把末尾的 `@token` 换成显示名称（重名项不可插入）。 */
  const insertMention = useCallback((insertText: string) => {
    setDraft(
      (previous) =>
        `${previous.replace(/(?:^|\s)@[^\s@]*$/, (match) => match.replace(/@[^\s@]*$/, insertText))} `,
    );
    setSelectedIndex(0);
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionQuery !== null && mentionMenu?.kind === "ready") {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((previous) =>
          moveMentionSelection(previous, event.key === "ArrowDown" ? 1 : -1, options.length),
        );
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionDismissed(true);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const option = options[selectedIndex];
        const insertText = option ? mentionOptionInsertText(option) : null;
        if (insertText !== null) {
          event.preventDefault();
          insertMention(insertText);
          return;
        }
      }
    }
    if (event.key === "Escape" && replyTarget !== null) {
      event.preventDefault();
      onCancelReply();
    }
  };

  return (
    <section
      data-testid="work-item-comment-composer"
      className="flex flex-col gap-2 rounded-lg border border-input-border bg-input p-3"
    >
      {replyTarget ? (
        <div
          data-testid="work-item-comment-reply-context"
          className="flex items-center gap-2 text-ui-xs text-foreground-subtle"
        >
          <span>
            {t("squad.workItemDetail.comment.replyingTo", {
              name: replyTarget.author.displayName ?? replyTarget.author.id,
            })}
          </span>
          <Button size="xs" variant="ghost" onClick={onCancelReply}>
            {t("squad.workItemDetail.comment.cancelReply")}
          </Button>
        </div>
      ) : null}

      <Textarea
        ref={textareaRef}
        data-testid="work-item-comment-input"
        aria-label={t("squad.workItemDetail.comment.placeholder")}
        placeholder={t("squad.workItemDetail.comment.placeholder")}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setMentionDismissed(false);
        }}
        onKeyDown={handleKeyDown}
        /* 草稿编辑**保持可用**（回复上下文 / `/note` / `@` 补全都是本地语义）；
           不可用的是**提交**（写面未接通）—— 见下面的 SUBMIT_ENABLED。 */
        className="text-mobile-input-safe md:text-ui-base"
      />

      {mentionQuery !== null && mentionMenu?.kind === "ready" ? (
        <WorkItemMentionMenu
          options={options}
          selectedIndex={selectedIndex}
          onSelect={(option) => {
            const insertText = mentionOptionInsertText(option);
            if (insertText !== null) insertMention(insertText);
          }}
        />
      ) : null}
      {roster === null ? (
        <p
          data-testid="work-item-comment-mention-unavailable"
          className="flex items-center gap-1 text-ui-xs text-foreground-subtle"
        >
          <CloudOff aria-hidden className="size-3.5" />
          {t("squad.workItemDetail.mention.rosterUnavailable")}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          variant={noteMode ? "secondary" : "ghost"}
          aria-pressed={noteMode}
          data-testid="work-item-comment-note-toggle"
          onClick={() => setDraft((previous) => toggleNotePrefix(previous, !noteMode))}
        >
          <StickyNote aria-hidden className="size-3.5" />
          {t("squad.workItemDetail.comment.note")}
        </Button>
        {noteMode ? (
          <span className={cn("text-ui-xs text-foreground-subtlest")}>
            {t("squad.workItemDetail.comment.noteHint")}
          </span>
        ) : null}
        <Button
          size="sm"
          variant="default"
          className="ml-auto"
          disabled={!WORK_ITEM_COMMENT_SUBMIT_ENABLED}
          title={reasonText}
          aria-describedby={SUBMIT_REASON_ID}
          data-testid="work-item-comment-submit"
        >
          {t("squad.workItemDetail.comment.add")}
        </Button>
      </div>

      {/* 「禁用理由必须通过帮助文案/可访问名称表达」（设计案 §4.1）——不用悬停才看得到的说法。 */}
      <p id={SUBMIT_REASON_ID} className="text-ui-xs text-foreground-subtlest">
        {reasonText}
      </p>
    </section>
  );
}
