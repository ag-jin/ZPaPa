import { useCallback, useEffect, useState } from "react";
import type { InboxItem, ISquadRuntimeServiceShape } from "@zcode/services";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { toast } from "@/components/ui/toast.js";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { InboxList } from "./InboxList.js";
import {
  squadEntryErrorFeedback,
  squadServiceUnavailableFeedback,
  type SquadEntryFeedback,
} from "./squadEntryViewModel.js";
import {
  SQUAD_RUNTIME_SERVICE_UNAVAILABLE_CODE,
  resolveSquadRuntimeService,
} from "./squadRuntimeAccess.js";
import { squadEntryVisible } from "./squadEntryVisibility.js";
import {
  inboxViewState,
  type InboxSessionTarget,
  type InboxWorkItemTarget,
} from "./inboxViewModel.js";

/* 「收件箱」一级入口的**完整功能面**（用户 2026-10-03 裁定：一级导航「收件箱」；
   2026-10-04 本轮：跨项目的通知面）。本轮是**纯 UI**：服务面
   `listInboxItems` / `markInboxItemRead` / `archiveInboxItem` 已就绪，这里只投影与编排。

   与「智能体」「小队」「工作项」三面逐条同形（动作行常驻、两语文案、失败一律可见不吞错），
   **两处不同**（都不是疏漏）：
   ① **不取 workspace 目标**：收件箱是**跨项目**的通知面（服务面 `listInboxItems` 没有目标
      参数，repo 的 `listAll` 就是全库），页面上没有"当前项目"这个概念 —— 所以不接
      `workspacePath` props、不调 `squadWorkspaceTarget`，也没有"无激活工作区"横幅；
      每行自己带 `workspacePath` 说明它属于哪个项目。
   ② **不发快照**：数据是 `InboxItem[]` 而不是 `SquadSnapshot` ⇒ 状态机是收件箱自己的
      `inboxViewState`（两台输入不同；两条口径照搬，理由见该文件的 doc）。

   取数通路必须经 `resolveSquadRuntimeService`（缺服务时**响亮抛**），不得直接读 accessor 上的
   小队运行时成员（那条路会把"服务没接上"静默成 undefined，界面一片空白）。

   **归档没有二次确认 —— 这是有意为之**，不是漏做（结构守卫按"不得出现二次确认调用"钉住）：
   ① 归档**不是消失**：「显示已归档」开关能把归档行取回来，比"删除"轻得多；
   ② 这是收件箱的**主用法**（把"处理完了"一条条点掉），每条都弹确认会让人厌烦到不再用；
   ③ 服务面没有"取消归档"（repo 只有 `archive` 一个方向）⇒ 文案（按钮与成功提示）必须
      出现「归档」二字、**不写"删除"**，让人知道它留下的是什么：一条可再查看的归档记录。
   标已读同理没有确认（可逆性无关紧要的轻动作，且服务面保留首次时间戳 ⇒ 重复点无副作用）。

   实验开关关闭**不是门禁**：本页仍可用（读 / 标已读 / 归档都不经服务部门禁），横幅只是把
   "入口为什么不见了、已有的条目还能不能读"说清楚 —— spec §12 的呈现判据是 `squadEntryVisible`，
   本页复用它（同一份语义），不新造判据。

   **穿透**（本轮：把"只读的死信"接上"看到 → 处理"的闭环）：两条去处由 shell 注入，页面只把
   纯函数推出的**目标**原样转出去 —— 本页拿不到 tab store、也不该拿（跨 workspace 导航是
   shell 的事，与 `handleSelectTaskInChat` 同一条既有通路）。`onOpenWorkItem` / `onOpenSession`
   **必填而不是可选**：可选会留下"按钮在、点了没反应"的静默路径（`onOpenWorkItem?.(…)`
   无声吞掉），把契约钉在类型上（照 WorkItemsPage `onOpenSession` 的既定理由）。

   **点击不自动标已读 —— 有意为之**：穿透是"去处理"，标已读是"我知道它了"，两件事正交；
   自动标已读 = 替用户做决定（他可能只是想看一眼再回来处理），而且写动作失败时要么给一次
   假导航、要么吞掉失败，两种都不如"什么都不做"。**同样不自动归档**：归档 = "处理完了"，
   更不该替用户宣布。 */

export function InboxPage({
  onOpenWorkItem,
  onOpenSession,
}: {
  /** 「打开工作项」⇒ shell（跨 workspace 激活/补开 + 切到工作项页 + 聚焦那条）。 */
  onOpenWorkItem: (target: InboxWorkItemTarget) => void;
  /** 「打开会话」⇒ shell（经既有 handleSelectTaskInChat 打开 run 的会话）。 */
  onOpenSession: (target: InboxSessionTarget) => void;
}) {
  const { intl } = useZCodeIntl();
  const services = useServices();
  const { settings } = useSettings();

  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<SquadEntryFeedback | null>(null);
  /** 「显示已归档」开关（默认关 = 已归档不出现在列表，spec/计划口径）。它是**取数参数**：
      切换会让 `reload` 的依赖变化 ⇒ 重新取数（不是在前端过滤 —— 过滤会让"归档里还有多少条"
      这个事实永远读不到）。 */
  const [includeArchived, setIncludeArchived] = useState(false);
  /** 有请求在飞的条目 id（照 WorkItemsPage 的 busyWorkItemId 形态）。 */
  const [busyItemId, setBusyItemId] = useState<string | null>(null);

  const t = useCallback((id: string) => intl.formatMessage({ id }), [intl]);

  /** 提示一律**响亮**：warning 走 toast 变体；失败额外带原始细节（不吞错）。 */
  const notify = useCallback(
    (feedback: SquadEntryFeedback) => {
      const message = feedback.detail
        ? `${t(feedback.messageId)}：${feedback.detail}`
        : t(feedback.messageId);
      toast(message, feedback.tone === "warning" ? { variant: "warning" } : undefined);
    },
    [t],
  );

  /* 重载：**失败不清空已有条目** —— 刷新失败要变成 ready 之上的横幅，而不是把
     "你的收件箱清空了"这句话说出来（数据仍在，只是这次没读到）。
     `includeArchived` 是依赖的一部分：开关一拨就重新取数（服务面上已归档行默认不出现）。 */
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const service = resolveSquadRuntimeService(services);
      setItems(await service.listInboxItems({ includeArchived }));
      setFailure(null);
    } catch (error) {
      logger.error("[InboxPage] 读取收件箱失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      setFailure(
        (error as { code?: unknown } | null)?.code === SQUAD_RUNTIME_SERVICE_UNAVAILABLE_CODE
          ? squadServiceUnavailableFeedback()
          : squadEntryErrorFeedback(error),
      );
    } finally {
      setLoading(false);
    }
  }, [includeArchived, services]);

  // mount 一次（含开关变化导致的重新取数：依赖在 reload 上）。
  useEffect(() => {
    void reload();
  }, [reload]);

  /** 一次写动作的公共执行路径（照 WorkItemsPage 的 runAction）：置忙 → 调服务 →
      成功提示 + 重载 / 失败提示（不吞错）→ 复位。两个动作都走这里 ⇒ "失败可见"只有一处实现。 */
  const runAction = useCallback(
    async (
      itemId: string,
      action: (service: ISquadRuntimeServiceShape) => Promise<unknown>,
      successMessageId: string,
    ) => {
      setBusyItemId(itemId);
      try {
        await action(resolveSquadRuntimeService(services));
        notify({ tone: "success", messageId: successMessageId });
        await reload();
      } catch (error) {
        logger.warn("[InboxPage] 收件箱操作失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        notify(squadEntryErrorFeedback(error));
      } finally {
        setBusyItemId(null);
      }
    },
    [notify, reload, services],
  );

  const state = inboxViewState({ items, loading, failure });

  /* 「当前开关为关」（呈现判据复用 squadEntryVisible —— 同一份语义，不新造判据）。
     额外要求 `settings !== null`：`squadEntryVisible(null)` 判"不可见"是为了**藏入口**
     （先藏后显可以接受），而横幅反过来 —— 设置还没读出来就挂"实验已关闭"会在每次进入页面时
     先闪一条假横幅。读到了、且开关为关，才挂。 */
  const experimentOff = settings !== null && !squadEntryVisible(settings);

  return (
    <div data-testid="inbox-page" className="flex flex-col gap-4">
      {/* 动作行**常驻**：入口的可见性不得依赖取数成功（2026-10-03 用户实测教训）——
          读不通时置灰即可，藏掉入口会让人以为"产品没做这个功能"。 */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={loading}
          data-testid="inbox-refresh"
          onClick={() => {
            void reload();
          }}
        >
          {loading ? <Spinner className="size-3.5" /> : null}
          {t("squad.common.refresh")}
        </Button>
        {/* 「显示已归档」开关：按下态用 aria-pressed（照侧栏一级入口的既有手法）+
            `bg-selected` 可见底色；切换后重新取数（见 includeArchived 注释）。 */}
        <Button
          variant="outline"
          size="sm"
          aria-pressed={includeArchived}
          data-testid="inbox-show-archived"
          className={cn(includeArchived && "bg-selected text-foreground")}
          onClick={() => setIncludeArchived((current) => !current)}
        >
          {t("squad.inbox.showArchived")}
        </Button>
      </div>

      {/* 实验已关闭：呈现横幅（入口的隐藏由 squadEntryVisible 负责；门禁在服务层）。
          文案**不得**复用 squad.common.experimentOff（那句里的"名册管理"在收件箱上不成立）：
          这里要说的恰好相反 —— 入口没了，但已有条目仍可读、仍可归档。 */}
      {experimentOff ? (
        <Alert variant="warning" data-testid="inbox-experiment-off">
          <AlertTitle>{t("squad.inbox.experimentOff")}</AlertTitle>
        </Alert>
      ) : null}

      {/* 有数据但刷新失败 ⇒ 横幅（含原因 + 重试）；**不清空已有数据**。 */}
      {state.mode === "ready" && state.loadFailure ? (
        <Alert variant="destructive" data-testid="inbox-load-failure">
          <AlertTitle>{t("squad.inbox.loadFailed")}</AlertTitle>
          <AlertDescription>
            {t(state.loadFailure.messageId)}
            {state.loadFailure.detail ? `：${state.loadFailure.detail}` : ""}
          </AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void reload()}>
              {t("squad.common.refresh")}
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      {state.mode === "loading" ? (
        <div
          className="flex items-center gap-2 text-ui-base text-foreground-subtle"
          data-testid="inbox-loading"
        >
          <Spinner className="size-3.5" />
          {t("squad.inbox.loading")}
        </div>
      ) : null}

      {/* 无数据 + 失败 ⇒ 整页错误（**必须带原因**）+ 重试。 */}
      {state.mode === "error" ? (
        <Alert variant="destructive" data-testid="inbox-error">
          <AlertTitle>{t("squad.inbox.loadFailed")}</AlertTitle>
          <AlertDescription>
            {t(state.feedback.messageId)}
            {state.feedback.detail ? `：${state.feedback.detail}` : ""}
          </AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void reload()}>
              {t("squad.common.refresh")}
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      {state.mode === "ready" ? (
        <InboxList
          items={state.items}
          showArchived={includeArchived}
          busyItemId={busyItemId}
          onMarkRead={(item) => {
            void runAction(
              item.id,
              (service) => service.markInboxItemRead(item.id),
              "squad.inbox.markReadSucceeded",
            );
          }}
          onArchive={(item) => {
            void runAction(
              item.id,
              (service) => service.archiveInboxItem(item.id),
              "squad.inbox.archiveSucceeded",
            );
          }}
          onOpenWorkItem={onOpenWorkItem}
          onOpenSession={onOpenSession}
        />
      ) : null}
    </div>
  );
}
