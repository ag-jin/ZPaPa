import { useState } from "react";
import type { OptOutScope, WorkItemSubscriberRecord } from "@zcode/services";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  SUBSCRIPTION_STATUS_MESSAGE_IDS,
  confirmUnsubscribeScope,
  requestUnsubscribeConfirm,
  unsubscribeScopeChoices,
  workItemSubscriptionView,
  type SubscriptionIntent,
} from "./workItemSubscriptionViewModel.js";

/* SUB.3a：工作项**详情页**的订阅控件（状态三态 + 两档退订确认）。

   三条纪律：
   ① **不碰服务**：本组件只拿「读模型两格 + 一个意图回调」，写由页面的唯一执行器
      （`runCollaborationAction`）打出去 —— 组件自己 `useServices()` 就会长出第二条写路径；
   ② **判据全在纯函数里**：状态三态（`workItemSubscriptionView`）、有哪些档
      （`unsubscribeScopeChoices`）、确认了哪一档（`confirmUnsubscribeScope`）都不在 JSX 里重判；
   ③ **无乐观更新**：点完不做本地伪造（写完由页面刷新读模型，状态从服务面回来）。

   「两档确认」是一次模态：标题说清动作与后果（退订只影响通知、不改工作项、不动已有条目），
   两个按钮就是两档本身（只此条 / 此条及子项）—— 让用户在**知道范围**的前提下选，
   而不是先点「确定」再猜系统替他选了哪一档。对话框的开合是**呈现态**（`confirmOpen`）；
   真正被执行的档只从确认态机产出（见 `runScope`：`scope === null` ⇒ 一级都不执行）。

   为什么已退订（墓碑）也给「订阅」：墓碑不是终点 —— 用户改主意时唯一的复活入口就是这里
   （自动规则不会复活，见 SUB.1 的墓碑保护）。 */

export function WorkItemSubscriptionControl({
  subscribers,
  viewerActor,
  disabledReasonMessageId,
  onSetSubscription,
}: {
  /** 本工作项的**全部**订阅行（读模型原样：服务层不 filter，哪个是我的由纯函数判）。 */
  subscribers: readonly WorkItemSubscriberRecord[];
  /** 观察者身份（读模型的 `viewerActor`）：**只能**来自服务面，UI 不自造（D1-A）。 */
  viewerActor: { kind: string; id: string };
  /** 不可写的原因文案键（归档 / 读取失败；`null` = 可写）—— 判据单源在 `writeDisabledReason`。 */
  disabledReasonMessageId: string | null;
  /**
   * 订阅 / 退订意图（页面负责翻成服务面请求并落写；本组件不拼请求）。
   * **返回 Promise**：在途态由本组件自己持有（按钮禁用在飞的那一下），但它**不得 reject**
   * （失败由页面的动作错误条呈现）—— 见页面里 `runSubscription` 的收尾。
   */
  onSetSubscription: (intent: SubscriptionIntent) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string>) => intl.formatMessage({ id }, values);
  /** 确认框开合（**呈现态**：它不决定执行哪一档 —— 那是确认态机的活）。 */
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** 有写在途（本组件自己的呈现态：重复点 = 两次写入）。 */
  const [pending, setPending] = useState(false);
  const view = workItemSubscriptionView({ subscribers, viewerActor });
  const disabled = disabledReasonMessageId !== null || pending;

  /** 意图 → 页面（在途态包在这一次调用外层：写完才解锁，期间两个动作都禁用）。 */
  const submit = (intent: SubscriptionIntent): void => {
    setPending(true);
    void onSetSubscription(intent).finally(() => setPending(false));
  };

  return (
    <section
      data-testid="work-item-subscription"
      className={cn("flex flex-col gap-1 rounded-xl border border-card-border bg-card px-4 py-3")}
    >
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-ui-sm text-foreground-subtle">
          {t(SUBSCRIPTION_STATUS_MESSAGE_IDS.title)}
        </span>
        {/* 状态：三态各自的说法（关注中必须自报 reason、已退订必须自报范围）——占位符由映射给。 */}
        <span data-testid="work-item-subscription-status" className="text-ui-base text-foreground">
          {view.status === "none"
            ? t(SUBSCRIPTION_STATUS_MESSAGE_IDS.none)
            : view.status === "subscribed"
              ? t(SUBSCRIPTION_STATUS_MESSAGE_IDS.subscribed, { reason: t(view.reasonMessageId) })
              : t(SUBSCRIPTION_STATUS_MESSAGE_IDS.unsubscribed, { scope: t(view.scopeMessageId) })}
        </span>
        {view.status === "subscribed" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            data-testid="work-item-subscription-unsubscribe"
            onClick={() => setConfirmOpen(true)}
          >
            {t(SUBSCRIPTION_STATUS_MESSAGE_IDS.unsubscribe)}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            data-testid="work-item-subscription-subscribe"
            onClick={() => submit({ kind: "subscribe" })}
          >
            {t(SUBSCRIPTION_STATUS_MESSAGE_IDS.subscribe)}
          </Button>
        )}
      </span>
      {disabledReasonMessageId === null ? null : (
        <p
          className="text-ui-xs text-foreground-subtlest"
          data-testid="work-item-subscription-disabled"
        >
          {t(disabledReasonMessageId)}
        </p>
      )}
      {view.status !== "unsubscribed" ? null : (
        <p
          className="text-ui-xs text-foreground-subtlest"
          data-testid="work-item-subscription-tombstone-hint"
        >
          {t(SUBSCRIPTION_STATUS_MESSAGE_IDS.tombstoneHint)}
        </p>
      )}
      {confirmOpen ? (
        <UnsubscribeScopeDialog
          titleId={SUBSCRIPTION_STATUS_MESSAGE_IDS.unsubscribeTitle}
          descriptionId={SUBSCRIPTION_STATUS_MESSAGE_IDS.unsubscribeHint}
          pending={pending}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={(scope) => {
            setConfirmOpen(false);
            submit({ kind: "unsubscribe", scope });
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * **两档退订的确认框**（详情页订阅控件与收件箱行的「不再通知」共用一份）。
 *
 * 为什么必须是共用件：哪些档存在、各叫什么、点了之后**能不能执行**（确认态机）三件事
 * 在两个入口各写一遍，迟早一处多一档、一处少一层确认 —— 而退订范围猜错的表现是
 * 「我以为子项也不通知了」。调用方只给两句文案键与两个回调。
 *
 * 两个按钮**就是两档本身**（只此条 / 此条及子项）：让用户在知道范围的前提下选，
 * 而不是先点「确定」再猜系统替他选了哪一档。执行档只从确认态机产出（`scope === null` ⇒ 不执行）。
 */
export function UnsubscribeScopeDialog({
  titleId,
  descriptionId,
  titleValues,
  testId = "work-item-subscription-unsubscribe-confirm",
  pending,
  onCancel,
  onConfirm,
}: {
  titleId: string;
  descriptionId: string;
  /** 标题占位符（如 `{title}` = 哪条工作项；缺省 = 不带占位符的通用标题）。 */
  titleValues?: Record<string, string>;
  /** 根 testid（两个入口各一个：断言与 e2e 要能分辨是哪一处的确认框）。 */
  testId?: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (scope: OptOutScope) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string>) => intl.formatMessage({ id }, values);
  return (
    <AlertDialog open onOpenChange={(next) => (!next && !pending ? onCancel() : undefined)}>
      <AlertDialogContent data-testid={testId}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(titleId, titleValues)}</AlertDialogTitle>
          <AlertDialogDescription>{t(descriptionId)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending} onClick={onCancel}>
            {t("squad.common.cancel")}
          </AlertDialogCancel>
          {/* 两个按钮 = 两档本身（选项表来自纯函数：有哪些档、各叫什么都不在这里判）。 */}
          {unsubscribeScopeChoices().map((choice) => (
            <AlertDialogAction
              key={choice.scope}
              disabled={pending}
              data-testid={`${testId}-${choice.scope}`}
              onClick={(event) => {
                // 阻止 Radix 的默认关闭：关闭与执行都由调用方决定（失败时要能看见失败）。
                event.preventDefault();
                const decided = confirmUnsubscribeScope(requestUnsubscribeConfirm(choice.scope));
                if (decided.scope === null) return;
                onConfirm(decided.scope);
              }}
            >
              {t(choice.messageId)}
            </AlertDialogAction>
          ))}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
