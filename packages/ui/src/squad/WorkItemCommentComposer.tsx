import { useCallback, useMemo, useRef, useState } from "react";
import type { WorkItemCommentRecord } from "@zcode/services";
import { CloudOff, StickyNote } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { WorkItemMentionMenu } from "./WorkItemMentionMenu.js";
import type { MentionRoster } from "./workItemCollaborationViewModel.js";
import {
  draftHasContent,
  draftHasNotePrefix,
  resolveSubmitId,
  toggleNotePrefix,
} from "./workItemCollaborationViewModel.js";
import {
  activeMentionQuery,
  buildMentionMenu,
  mentionOptionInsertText,
  moveMentionSelection,
} from "./workItemMentionViewModel.js";

/* B5.1 轮 1 / B5.2 轮 2：人类评论 composer（设计案 §4）。

   轮 2 起**真的写**：提交把 `(workItemId, body, parentCommentId, clientRequestId)` 交给页面的
   唯一动作执行点（本组件不 import 任何服务/仓储，也不自己刷新任何事实源）。
   本轮**没有**乐观插入：提交中只显示「正在发送」并禁用重复提交，**不**在时间线里凭空插一条
   看起来已落库的评论 —— 失败时那条假评论会留在一个「看起来发出去了」的位置上。

   幂等键（§8.1）：`clientRequestId` 在一次**提交动作**内稳定，重试沿用同一个键
   （`resolveSubmitId` 是受测纯函数），成功后清空 ⇒ 下一条评论是一次新的提交动作。
   失败**不丢草稿**：原文留在编辑器里，配一个「重试发送」。

   本地草稿语义（回复上下文、`/note` 显式模式、`@` 补全）从轮 1 原样保留 —— 它们都不落盘，
   也不认定派发目标（客户端补全只是输入辅助，设计案 §4.2）。

   `WORK_ITEM_COMMENT_SUBMIT_ENABLED` 是**唯一**的写面开关位（轮 1 留的接线点，轮 2 打开）：
   回退整条写入面时只改这一处。 */

export const WORK_ITEM_COMMENT_SUBMIT_ENABLED = true;

/** 提交禁用理由的帮助文案锚点（`aria-describedby` 指向它，不靠悬停才看得到）。 */
const SUBMIT_REASON_ID = "work-item-comment-submit-reason";

/**
 * 幂等键的生成（UI 里**唯一**造 id 的地方）。`crypto.randomUUID` 在非安全上下文/旧宿主里可能缺席，
 * 那时退回「时间戳 + 随机后缀」——两者都只为「同一次提交动作内的稳定性」服务，
 * 唯一性只要在本机、本会话内够用（跨会话撞键会被当成同一次重投，故带随机后缀而不是纯计数器）。
 */
function newSubmitRequestId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `comment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  );
}

export function WorkItemCommentComposer({
  roster,
  replyTarget,
  onCancelReply,
  disabledReasonMessageId,
  onSubmit,
}: {
  /** `null` = 名册不可用（快照读失败）：必须**说出来**，不静默不出菜单（设计案 §4.2）。 */
  roster: MentionRoster | null;
  /** 正在回复的那条评论（`null` = 顶层评论）。 */
  replyTarget: WorkItemCommentRecord | null;
  onCancelReply: () => void;
  /** 不可写的原因文案键（归档 / 读取失败）；`null` = 可写（写面已接通，无额外原因）。 */
  disabledReasonMessageId: string | null;
  /** 提交：由页面执行（写 + 只刷新协作读模型）。**拒绝** = 未写入（本组件据此保留草稿）。 */
  onSubmit: (input: {
    body: string;
    parentCommentId?: string;
    clientRequestId: string;
  }) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const [draft, setDraft] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  /* Escape 关闭候选：**不**改草稿（丢一个字都不行 —— 用户打的可能就是他想说的）。
     任何一次输入都把菜单放回来（再打一个字符 = 新的一次补全意图）。 */
  const [mentionDismissed, setMentionDismissed] = useState(false);
  /** 提交幂等键：一次提交动作内稳定，成功后清空（见 `resolveSubmitId`）。 */
  const [clientRequestId, setClientRequestId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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

  const hasContent = draftHasContent(draft);
  /* 禁用理由的优先级（设计案 §4.1）：写面不可用（归档 / 读取失败）> 没有内容。
     两者都必须**说出来**，而不是给一个点了没反应的按钮。 */
  const reasonMessageId =
    disabledReasonMessageId ??
    (hasContent ? null : "squad.workItemDetail.comment.submitDisabled.empty");
  const reasonText = reasonMessageId === null ? null : t(reasonMessageId);
  const canSubmit =
    WORK_ITEM_COMMENT_SUBMIT_ENABLED && disabledReasonMessageId === null && hasContent && !sending;

  /** 补全插入：把末尾的 `@token` 换成显示名称（重名项不可插入）。 */
  const insertMention = useCallback((insertText: string) => {
    setDraft(
      (previous) =>
        `${previous.replace(/(?:^|\s)@[^\s@]*$/, (match) => match.replace(/@[^\s@]*$/, insertText))} `,
    );
    setSelectedIndex(0);
    textareaRef.current?.focus();
  }, []);

  /**
   * 提交（含重试）。同一函数同时承担首次与重试：重试沿用**同一个** `clientRequestId`
   * —— 换键会让一次重试在库里长成两条评论，而两条都是「成功」。
   */
  const submit = useCallback(async () => {
    if (!canSubmit) return;
    const requestId = resolveSubmitId(clientRequestId, "send", newSubmitRequestId);
    setClientRequestId(requestId);
    setSending(true);
    setSendFailed(false);
    try {
      await onSubmit({
        body: draft,
        ...(replyTarget === null ? {} : { parentCommentId: replyTarget.id }),
        clientRequestId: requestId!,
      });
      // 成功：清草稿、清键（下一次提交是新动作）、收起回复上下文（那条回复已经发出去了）。
      setDraft("");
      setClientRequestId(resolveSubmitId(requestId, "sent", newSubmitRequestId));
      setMentionDismissed(false);
      onCancelReply();
    } catch {
      // 失败：草稿与幂等键**都留着**（原文不能丢，重试必须沿用同一个键）。
      setClientRequestId(resolveSubmitId(requestId, "failed", newSubmitRequestId));
      setSendFailed(true);
    } finally {
      setSending(false);
    }
  }, [canSubmit, clientRequestId, draft, onSubmit, onCancelReply, replyTarget]);

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
    // Cmd/Ctrl+Enter 提交；单独 Enter 是换行（设计案 §4.1）。
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
      return;
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
          disabled={!canSubmit}
          title={reasonText ?? undefined}
          aria-describedby={SUBMIT_REASON_ID}
          data-testid="work-item-comment-submit"
          onClick={() => void submit()}
        >
          {sending
            ? t("squad.workItemDetail.comment.sending")
            : t("squad.workItemDetail.comment.add")}
        </Button>
      </div>

      {/* 「禁用理由必须通过帮助文案/可访问名称表达」（设计案 §4.1）——不用悬停才看得到的说法。 */}
      <p id={SUBMIT_REASON_ID} className="text-ui-xs text-foreground-subtlest">
        {reasonText ?? ""}
      </p>

      {sendFailed ? (
        <p
          role="alert"
          data-testid="work-item-comment-send-failure"
          className="flex flex-wrap items-center gap-2 text-ui-xs text-destructive"
        >
          {t("squad.workItemDetail.comment.sendFailed")}
          {/* 重试：同一个幂等键、同一份草稿 —— 一次成功只落一条评论。 */}
          <Button size="xs" variant="outline" disabled={!canSubmit} onClick={() => void submit()}>
            {t("squad.workItemDetail.comment.retrySend")}
          </Button>
        </p>
      ) : null}
    </section>
  );
}
