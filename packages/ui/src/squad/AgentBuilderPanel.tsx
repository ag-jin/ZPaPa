import type { AgentBuilderDraft } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { Textarea } from "@/components/ui/textarea.js";
import { cn } from "@/components/lib/utils.js";
import {
  agentBuilderAwaitingReply,
  agentBuilderDraftHasContent,
  agentBuilderDraftSummary,
  type AgentBuilderFailure,
  type AgentBuilderMessage,
  type AgentBuilderSession,
} from "./agentBuilderViewModel.js";

/* 访谈面板的**呈现层**（纯 props，无状态、无服务调用）。

   为什么与 Dialog 壳分开：Radix 的 Portal 在服务端渲染下不产出任何标记（`mounted` 仍是 false），
   所以「面板长什么样」如果只挂在壳里，就只能靠人眼验收。拆出来之后四种形态
   （首帧 / 等待中 / 失败 / 降级轮）都能用 renderToStaticMarkup 钉住 ——
   这是仓内既定的 UI 验证手法（见 workItemProperties / d2PullRequestUi 的复验）。

   圆角：本面板渲染在对话框壳内，而**壳不计入内容层级**（DESIGN.md「Radius ▸ Dialogs」）
   ⇒ 转写气泡、空态提示、草稿卡这三个同层容器都是该对话框的**第一层内容容器** = rounded-xl
   （聊天气泡同一条口径，见「Chat, Tooling, and Developer UI」）。把它们降到 rounded-lg 会让
   面板看起来"陷进"对话框里 —— 守卫见 squadEntryStyleConformance.test.ts。 */

export function AgentBuilderPanel({
  session,
  answer,
  serviceAvailable,
  onAnswerChange,
  onSend,
  onRetry,
  onStop,
  onOpenManualForm,
}: {
  session: AgentBuilderSession;
  answer: string;
  /** false = 当前 accessor 上没有访谈服务（面板给原因，两个出口仍可用）。 */
  serviceAvailable: boolean;
  onAnswerChange: (value: string) => void;
  onSend: () => void;
  onRetry: () => void;
  onStop: () => void;
  onOpenManualForm: (draft: AgentBuilderDraft | null) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const pending = session.status === "pending";
  const draftReady = agentBuilderDraftHasContent(session.draft);
  const awaitingReply =
    !pending && session.failure === null && agentBuilderAwaitingReply(session.messages);

  return (
    <>
      {!serviceAvailable ? (
        <Alert variant="destructive" data-testid="agent-builder-service-unavailable">
          <AlertTitle>{t("squad.agentBuilder.failureTitle")}</AlertTitle>
          <AlertDescription>{t("squad.agentBuilder.serviceUnavailable")}</AlertDescription>
        </Alert>
      ) : null}

      <AgentBuilderTranscript messages={session.messages} />

      {pending ? (
        <div
          className="flex items-center justify-between gap-2 text-ui-sm text-foreground-subtle"
          data-testid="agent-builder-pending"
        >
          <span className="flex items-center gap-2">
            <Spinner className="size-3.5" />
            {t("squad.agentBuilder.thinking")}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={onStop}>
            {t("squad.agentBuilder.stop")}
          </Button>
        </div>
      ) : null}

      {session.failure ? (
        <AgentBuilderFailureNotice
          failure={session.failure}
          canRetry={serviceAvailable}
          onRetry={onRetry}
          onManualCreate={() => onOpenManualForm(session.draft)}
        />
      ) : null}

      {/* 停止 / 失败之后：本轮用户消息还没有回复 —— 常驻「重试本轮」（重发同一条答案）。 */}
      {awaitingReply ? (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="agent-builder-retry"
            disabled={!serviceAvailable}
            onClick={onRetry}
          >
            {t("squad.agentBuilder.retryTurn")}
          </Button>
        </div>
      ) : null}

      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <Textarea
          value={answer}
          rows={3}
          data-testid="agent-builder-input"
          disabled={pending || !serviceAvailable}
          placeholder={t("squad.agentBuilder.inputPlaceholder")}
          onChange={(event) => onAnswerChange(event.target.value)}
          onKeyDown={(event) => {
            // Ctrl/Cmd+Enter 发送（Enter 留给换行：访谈里的回答常常是多行的）。
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              onSend();
            }
          }}
        />
        <div className="flex justify-end">
          <Button
            type="submit"
            size="sm"
            data-testid="agent-builder-send"
            disabled={pending || !serviceAvailable || answer.trim().length === 0}
          >
            {t("squad.agentBuilder.send")}
          </Button>
        </div>
      </form>

      <AgentBuilderDraftPreview
        draft={session.draft}
        degraded={session.messages.at(-1)?.degraded === true}
      />

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="outline"
          data-testid="agent-builder-manual"
          onClick={() => onOpenManualForm(session.draft)}
        >
          {t("squad.agentBuilder.manualCreate")}
        </Button>
        <Button
          type="button"
          data-testid="agent-builder-confirm"
          disabled={!draftReady}
          title={draftReady ? undefined : t("squad.agentBuilder.draftEmpty")}
          onClick={() => onOpenManualForm(session.draft)}
        >
          {t("squad.agentBuilder.confirmDraft")}
        </Button>
      </div>
    </>
  );
}

/** 对话转写（纯展示）：降级轮的回复带「本轮草稿未更新」标注。 */
export function AgentBuilderTranscript({ messages }: { messages: readonly AgentBuilderMessage[] }) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  if (messages.length === 0) {
    return (
      <p
        className="rounded-xl border border-border bg-input/20 px-3 py-2 text-ui-sm text-foreground-subtle"
        data-testid="agent-builder-transcript-empty"
      >
        {t("squad.agentBuilder.emptyHint")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="agent-builder-transcript">
      {messages.map((message, index) => (
        <div
          key={`${index}-${message.role}`}
          data-testid={`agent-builder-message-${message.role}`}
          className={cn(
            "rounded-xl border px-3 py-2 text-ui-sm whitespace-pre-wrap",
            message.role === "user"
              ? "border-border bg-input/20 text-foreground"
              : "border-transparent bg-surface-hover text-foreground",
          )}
        >
          <span className="mb-1 block text-ui-xs text-foreground-subtlest">
            {message.role === "user"
              ? t("squad.agentBuilder.you")
              : t("squad.agentBuilder.assistant")}
          </span>
          {message.content}
          {message.degraded ? (
            <span
              className="mt-1 block text-ui-xs text-destructive"
              data-testid="agent-builder-degraded"
            >
              {t("squad.agentBuilder.degradedNotice")}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** 失败条（纯展示）：两档文案 + 「重试本轮」/「改为手动创建」（模型不可用那档引导手动创建）。 */
export function AgentBuilderFailureNotice({
  failure,
  canRetry,
  onRetry,
  onManualCreate,
}: {
  failure: AgentBuilderFailure;
  canRetry: boolean;
  onRetry: () => void;
  onManualCreate: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  return (
    <Alert variant="destructive" data-testid="agent-builder-failure">
      <AlertTitle>{t("squad.agentBuilder.failureTitle")}</AlertTitle>
      <AlertDescription>
        {failure.kind === "model-unavailable"
          ? t("squad.agentBuilder.failureModelUnavailable")
          : t("squad.agentBuilder.failureRequestFailed")}
        {"："}
        {failure.message}
      </AlertDescription>
      <AlertAction>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="agent-builder-retry-from-failure"
          disabled={!canRetry}
          onClick={onRetry}
        >
          {t("squad.agentBuilder.retryTurn")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="agent-builder-manual-from-failure"
          onClick={onManualCreate}
        >
          {t("squad.agentBuilder.manualCreate")}
        </Button>
      </AlertAction>
    </Alert>
  );
}

/** 草稿只读预览（紧凑卡片）：名称 / 一句话 / 提示词摘要与字数 / 技能 / 两处枚举。 */
export function AgentBuilderDraftPreview({
  draft,
  degraded,
}: {
  draft: AgentBuilderDraft | null;
  /** 本轮草稿未更新（降级轮）：卡片明说，免得用户以为改了其实没改。 */
  degraded?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  if (draft === null) {
    return (
      <div
        className="rounded-xl border border-dashed border-border px-3 py-2 text-ui-sm text-foreground-subtle"
        data-testid="agent-builder-draft-empty"
      >
        {t("squad.agentBuilder.draftEmpty")}
      </div>
    );
  }
  const summary = agentBuilderDraftSummary(draft);
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-border bg-input/20 px-3 py-2"
      data-testid="agent-builder-draft"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-ui-xs text-foreground-subtlest">
          {t("squad.agentBuilder.draftTitle")}
        </span>
        {degraded ? (
          <span className="text-ui-xs text-destructive" data-testid="agent-builder-draft-stale">
            {t("squad.agentBuilder.degradedNotice")}
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 text-ui-sm text-foreground">
        <span className="font-medium" data-testid="agent-builder-draft-name">
          {summary.name.length > 0 ? summary.name : t("squad.agentBuilder.draftUnnamed")}
        </span>
        {summary.description.length > 0 ? (
          <span className="text-foreground-subtle">{summary.description}</span>
        ) : null}
        <span className="whitespace-pre-wrap text-foreground-subtle">{summary.promptExcerpt}</span>
        <span className="text-ui-xs text-foreground-subtlest">
          {t("squad.agentBuilder.draftPromptLength", { count: summary.promptLength })}
        </span>
      </div>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-ui-xs text-foreground-subtle">
        <div className="flex gap-1">
          <dt>{t("squad.common.memoryScope")}</dt>
          <dd>{t(summary.memoryScopeMessageId)}</dd>
        </div>
        <div className="flex gap-1">
          <dt>{t("squad.common.permissionMode")}</dt>
          <dd>{t(summary.permissionModeMessageId)}</dd>
        </div>
        <div className="flex gap-1">
          <dt>{t("squad.common.skills")}</dt>
          <dd>{summary.skills.length > 0 ? summary.skills.join("、") : "—"}</dd>
        </div>
      </dl>
    </div>
  );
}
