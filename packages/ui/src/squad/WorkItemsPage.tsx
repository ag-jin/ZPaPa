import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkItem } from "@zcode/shared";
import type { SquadSnapshot, ISquadRuntimeServiceShape } from "@zcode/services";
import { toast } from "@/components/ui/toast.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { WorkItemDialogSubmitInput } from "./SquadCreateDialogs.js";
import { WorkItemsPageDialogs } from "./WorkItemsPageDialogs.js";
import { SquadRunsReview } from "./SquadRunsReview.js";
import { WakeRulesSection } from "./WakeRulesSection.js";
import { WorkItemsSurface } from "./WorkItemsSurface.js";
import { WorkItemsViewsSection } from "./WorkItemsViewsSection.js";
import { useWorkItemsViewsBridge } from "./useWorkItemsViewsBridge.js";
import {
  SQUAD_DISCARD_CONFIRM_IDLE,
  cancelSquadDiscard,
  confirmSquadDiscard,
  executeSquadDiscard,
  requestSquadDiscard,
  reviewOutcomeFeedback,
  squadDiscardableWorkItemIds,
  squadEntryErrorFeedback,
  squadServiceUnavailableFeedback,
  type SquadEntryFeedback,
} from "./squadEntryViewModel.js";
import {
  SQUAD_RUNTIME_SERVICE_UNAVAILABLE_CODE,
  resolveSquadRuntimeService,
  squadWorkspaceTarget,
} from "./squadRuntimeAccess.js";
import { squadSurfaceViewState } from "./squadSurfaceViewModel.js";
import { type WorkItemBulkFailure, type WorkItemBulkTarget } from "./workItemBulkViewModel.js";
import { useWorkItemBulk } from "./useWorkItemBulk.js";
import type { WorkItemInlineEditPatch } from "./workItemInlineEditViewModel.js";
import { WorkItemsPageActions } from "./WorkItemsPageActions.js";
import { WorkItemsPageStatus } from "./WorkItemsPageStatus.js";
import {
  workItemSurfaceDefaultState,
  type WorkItemSurfaceState,
} from "./workItemSurfaceViewModel.js";
import { workItemCreateEnabled, type WorkItemLaneDimension } from "./workItemsViewModel.js";

/* 「工作项」一级入口的**完整功能面**（用户 2026-10-03 裁定：入口不藏设置；「UI 功能需要打磨
   完整，不要缺少东西」）。树形看板（父项批次 → 子项）/ 新建 / 编辑 / 改派 / 放弃整批 / 待收尾
   运行的审查（通过 / 打回 / 打开会话），以及空态、加载态、错误态（带原因与重试）、实验已关闭
   横幅、两语文案 —— 一个都不少。

   为什么目标 workspace 从 **props** 拿（与 SquadAgentsPage / SquadsPage 同款理由）：本页由
   WorkspaceShellLayout 渲染，shell 手里就有 `workspaceAbsPath` / `workspaceIdentity`；
   再从 tab store 读一份等于同一语义两处来源 —— shell 显示的项目与页面查询的项目可能分叉，
   而分叉不报错。`onOpenSession` 也由 shell 注入（run 的会话穿透走 shell 既有的
   `handleSelectTaskInChat`，本页不自己拼导航）。

   取数通路必须经 `resolveSquadRuntimeService`（缺服务时**响亮抛**），不得直接读 accessor 上的
   小队运行时成员（那条路会把"服务没接上"静默成 undefined，界面一片空白）。
   **不是门禁**：`snapshot.enabled === false` 只用来挂横幅；拦新派发是服务层单点
   `assertDispatchEnabled` 的事（这里不写第二份判据）。编辑 / 审查 / 放弃在实验关闭时
   本页**仍可用** —— 服务面那几个方法有意不过门禁（见 squadRuntimeService 的 doc）。

   状态机与行动作在 squadSurfaceViewModel（面无关的纯函数，三个面**共用同一份**实现）；
   看板排树与新建判据在 workItemsViewModel；本页只做投影（`snapshot.workItems` / `snapshot.runs`）
   与编排。 */

export function WorkItemsPage({
  workspacePath,
  workspaceIdentity,
  focusWorkItemId,
  onFocusConsumed,
  onOpenWorkItemDetail,
  onOpenSession,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 收件箱「打开工作项」带进来的**一次性聚焦意图**（照 openAutomationId 的先例：
      shell 透传 → 看板聚焦/确认缺席后消费）。`null` / 缺省 = 没有待消费的意图。

      为什么这层只透传不消费：**可靠渲染的那份列表在看板里**（页面拿到的 snapshot 在 ready 态
      才交给看板；"目标在不在列表"只有拿着渲染后的行才答得准）。页面若在这里判一遍
      `snapshot.workItems.some(...)`，等于给"在不在列表"开第二处判据，且看不到归档过滤等
      行级事实（第二处判据与第一处不一致时不报错）。 */
  focusWorkItemId?: string | null;
  /** 看板消费完聚焦意图后的回调（清掉意图，避免每次回到本页再聚焦一次）。 */
  onFocusConsumed?: () => void;
  /** B5.1：打开某条工作项的详情页（由 shell 注入；返回目标由 App 的意图态决定 = 本页）。
      必填而不是可选：可选会留下「行点得开、点了没反应」的静默路径。 */
  onOpenWorkItemDetail: (workItemId: string) => void;
  /** 打开某个 run 的独立会话（由 shell 注入：目标 workspace 就是本页那个）。
      必填而不是可选：可选会留下"按钮在、点了没反应"的静默路径（onOpenSession?.(…) 无声吞掉）
      —— shell 恒会传（`handleSelectTaskInChat` 接线），把契约钉在类型上。 */
  onOpenSession: (sessionId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const services = useServices();

  const target = useMemo(
    () => squadWorkspaceTarget(workspacePath, workspaceIdentity),
    [workspacePath, workspaceIdentity],
  );

  const [snapshot, setSnapshot] = useState<SquadSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<SquadEntryFeedback | null>(null);
  /** 有请求在飞的工作项行 id（照 SquadMinimalView 的 busyRunId 形态）；新建走 `*`（不会撞上真实 id）。 */
  const [busyWorkItemId, setBusyWorkItemId] = useState<string | null>(null);
  const [busyRunId, setBusyRunId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    { kind: "create" } | { kind: "edit"; item: WorkItem } | null
  >(null);
  /** 「放弃整批」的**二次确认**状态（纯逻辑在视图模型：点按钮只进入待确认态，执行只发生在确认路径）。 */
  const [discardConfirm, setDiscardConfirm] = useState(SQUAD_DISCARD_CONFIRM_IDLE);
  const [discardingId, setDiscardingId] = useState<string | null>(null);
  /** 正在改派的那一条（`null` = 对话框没开）。单开一个状态而不是塞进 `dialog` 判别联合：
      它带自己那条提交路径（同值可能返回 `assigned:false`，要显示「未变更」而不是「已保存」），
      揉进新建 / 编辑那条 `runAction`（成功即 `setDialog(null)`）会把两处语义搅混。 */
  const [reassignTarget, setReassignTarget] = useState<WorkItem | null>(null);
  /* 展开了时间线的**那一条**批根（一次只展开一批：状态就是一个 id）。收起/切换都只改这一处，
     不做展开态记忆；SquadTimelineSection 随条件渲染挂载/卸载，数据随之丢弃。 */
  const [expandedTimelineWorkItemId, setExpandedTimelineWorkItemId] = useState<string | null>(null);
  /* 看板分组维度（欠账 #15，2026-10-07 裁定 Q2/Q4）：**会话内**状态（与展开态同类）。默认
     `statusCategory`（2026-10-09 用户裁定「默认按阶段进行分组」；「不分组」保留为可选项）。刻意
     **不持久化**：本域无偏好持久化先例，新增 store/设置项就是一个新真相源 + 广播回环风险。 */
  const [laneDimension, setLaneDimension] = useState<WorkItemLaneDimension>("statusCategory");
  /* Surface 状态（阶段二 · T-P2-R1）：视图模式 / 本地搜索 / 过滤 / 排序 / 列配置 —— 与 `laneDimension`
     同款（**会话内**状态、刻意不持久化：本域无偏好持久化先例，新增 store 就是新真相源 + 广播回环）。
     状态在这里（而不是宿主里）：控件带渲染在**动作行**（取数失败时也要常驻），宿主只消费。
     迁移只有一处实现（`applyWorkItemSurfaceIntent` 纯函数）—— 控件只回传意图，不自己 setState。 */
  const [surface, setSurface] = useState<WorkItemSurfaceState>(workItemSurfaceDefaultState);
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

  /* 重载：**失败不清空已有快照** —— 刷新失败要变成 ready 之上的横幅，而不是把
     "你的工作项都没了"这句话说出来（数据仍在，只是这次没读到）。 */
  const reload = useCallback(async () => {
    if (!target) return;
    setLoading(true);
    try {
      const service = resolveSquadRuntimeService(services);
      setSnapshot(await service.getSnapshot(target));
      setFailure(null);
    } catch (error) {
      logger.error("[WorkItemsPage] 读取工作项失败", {
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
  }, [services, target]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /* 保存视图 + 拖拽改序的**接线层**（T-P2-R6b）：服务访问点、状态机与页面状态的耦合都在
     `useWorkItemsViewsBridge`（判据在纯函数、会话状态在 `useWorkItemViews`；本页只编排）。
     接线层拿到的三个页面动作（Surface 意图折叠 / 换分组 / 拖拽落点）直接投影给控件带与宿主。 */
  const viewsBridge = useWorkItemsViewsBridge({
    services,
    target,
    surface,
    laneDimension,
    setSurface,
    setLaneDimension,
    notify,
    reload,
    markBusy: setBusyWorkItemId,
  });
  const views = viewsBridge.views;

  /**
   * 一次写动作的公共执行路径：置忙 → 调服务 → 成功提示 + 重载 / 失败提示（不吞错）→ 复位。
   * 所有写动作（新建 / 编辑）都走这里，于是"失败可见"只有一处实现。
   */
  const runAction = useCallback(
    async (
      workItemId: string,
      action: (service: ISquadRuntimeServiceShape) => Promise<unknown>,
      successMessageId: string,
    ) => {
      if (!target) return;
      setBusyWorkItemId(workItemId);
      try {
        await action(resolveSquadRuntimeService(services));
        setDialog(null);
        notify({ tone: "success", messageId: successMessageId });
        await reload();
      } catch (error) {
        logger.warn("[WorkItemsPage] 工作项操作失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        notify(squadEntryErrorFeedback(error));
      } finally {
        setBusyWorkItemId(null);
      }
    },
    [notify, reload, services, target],
  );

  /** 审查裁决：四种结果各有其词（`reviewOutcomeFeedback`），失败同样可见（不吞错）。 */
  const review = useCallback(
    async (runId: string, verdict: "approved" | "rejected") => {
      if (!target) return;
      setBusyRunId(runId);
      try {
        const outcome = await resolveSquadRuntimeService(services).reviewMemberRun(target, {
          runId,
          verdict,
        });
        notify(reviewOutcomeFeedback(outcome));
        await reload();
      } catch (error) {
        logger.warn("[WorkItemsPage] 审查裁决失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        notify(squadEntryErrorFeedback(error));
      } finally {
        setBusyRunId(null);
      }
    },
    [notify, reload, services, target],
  );

  /**
   * 「放弃整批」的**唯一执行点**（只在确认对话框的确认动作里被调到）。
   *
   * 执行目标必须来自 `confirmSquadDiscard` 的返回值：那是本页里**唯一**能产出「可执行的那一条」
   * 的地方，`workItemId` 为 `null`（= 没确认过）时直接返回 —— 「未确认就执行」在接线层面也
   * 凑不出来（页面里不出现 `discardBatch`；服务调用只在 `executeSquadDiscard` 一处）。
   * 状态与执行分离：先把待确认态收回到空闲（对话框随之关闭）再执行，重复点确认不会执行第二次。
   */
  const runDiscard = useCallback(async () => {
    const decision = confirmSquadDiscard(discardConfirm);
    setDiscardConfirm(decision.next);
    if (!target || decision.workItemId === null) return;
    setDiscardingId(decision.workItemId);
    try {
      // 成功与失败都有可见归宿：executeSquadDiscard 把两种结果都翻成提示（失败带原始细节）。
      notify(
        await executeSquadDiscard({
          service: resolveSquadRuntimeService(services),
          target,
          decision,
        }),
      );
      await reload();
    } catch (error) {
      // 取数通路缺失（服务没接上）在这里冒出：不吞，翻成可见提示。
      logger.warn("[WorkItemsPage] 放弃整批失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      notify(squadEntryErrorFeedback(error));
    } finally {
      setDiscardingId(null);
    }
  }, [discardConfirm, notify, reload, services, target]);

  const state = squadSurfaceViewState({ hasTarget: target !== null, snapshot, loading, failure });

  /** 给了「放弃整批」入口的工作项（破坏性动作的判据在视图模型里，可被 node:test 钉住）。 */
  const discardableIds = useMemo(
    () => (snapshot ? squadDiscardableWorkItemIds(snapshot) : new Set<string>()),
    [snapshot],
  );
  /** 待确认的那一条：取不到（快照刚变过）就不渲染对话框 —— 绝不用一个「大概的那条」去确认删除。 */
  const discardTargetItem =
    snapshot && discardConfirm.pendingWorkItemId
      ? (snapshot.workItems.find((item) => item.id === discardConfirm.pendingWorkItemId) ?? null)
      : null;

  /* 新建 / 编辑共用一个对话框：提交期间（busyWorkItemId 非空）忽略重复提交 ——
     表单是同一份实现，重复点提交不该建出两条工作项。 */
  const submitDialog = useCallback(
    (input: WorkItemDialogSubmitInput) => {
      if (busyWorkItemId !== null || !target) return;
      if (input.mode === "create") {
        void runAction(
          "*",
          (service) =>
            service.createWorkItem(target, {
              title: input.title,
              body: input.body,
              parentId: input.parentId,
              assignee: input.assignee,
              labels: input.labels,
              // 三项 Surface 字段（阶段一轮 C）：表单已经归一化（`null` = 未设置），服务面原样收下。
              priority: input.priority,
              startDate: input.startDate,
              dueDate: input.dueDate,
            }),
          "squad.workItems.created",
        );
        return;
      }
      // 编辑：只把标题 / 正文 / 标签 / 三项 Surface 字段交给服务面（`updateWorkItem` 的白名单
      // 就是这六个）——指派与父项不在编辑里（理由见 WorkItemDialog 的注释）。标签**必传**：它是
      // 表单的当前值（空文本 = 清空标签），漏传会被服务面读成「没提这个字段」而保留旧值。
      // 三项 Surface 字段同理（`null` = 清回未设置）
      if (dialog?.kind !== "edit") return;
      const id = dialog.item.id;
      void runAction(
        id,
        (service) =>
          service.updateWorkItem(target, {
            id,
            patch: {
              title: input.title,
              body: input.body,
              labels: input.labels,
              priority: input.priority,
              startDate: input.startDate,
              dueDate: input.dueDate,
            },
          }),
        "squad.workItems.updated",
      );
    },
    [busyWorkItemId, dialog, runAction, target],
  );

  /**
   * 行内编辑的提交路径（阶段一轮 D）：**写路径与对话框那条同源**（都是 `updateWorkItem`），
   * 但失败归宿不同 —— 行内编辑失败要**就地**说（保留用户的输入、不清行），不是「关掉对话框 +
   * 一条 toast」。所以它自成一条（照 `submitReassign` 的先例），**不揉进 `runAction`**。
   *
   * 三条纪律：
   * ① patch 是看板经纯函数产出的形状（`{title}` / `{priority}`），这里**原样**并入请求 ——
   *   不做第二次字段名映射（多一次映射就多一次「界面改 A、请求里发 B」的机会）；
   * ② **无乐观更新**：成功之后才 `reload()`，行上显示的值永远来自服务回读；
   * ③ 失败返回原因（不吞），由看板就地显示；返回 `null` = 成功，看板据此收起草稿。
   */
  const submitInlineEdit = useCallback(
    async (item: WorkItem, patch: WorkItemInlineEditPatch): Promise<SquadEntryFeedback | null> => {
      if (!target) return squadServiceUnavailableFeedback();
      setBusyWorkItemId(item.id);
      try {
        await resolveSquadRuntimeService(services).updateWorkItem(target, { id: item.id, patch });
        await reload();
        return null;
      } catch (error) {
        logger.warn("[WorkItemsPage] 行内编辑失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        return squadEntryErrorFeedback(error);
      } finally {
        setBusyWorkItemId(null);
      }
    },
    [reload, services, target],
  );

  /* 新建可不可点：纯函数 workItemCreateEnabled（有目标 + 已取到快照）。
     快照没读到（加载中/失败）时置灰 —— 对话框的指派人 / 父项候选来自快照，读不到就开不出
     有选择的表单（「点得开但通往死路」比置灰更糟）；按钮本身**始终渲染**。 */
  const createDisabled = !workItemCreateEnabled({ hasTarget: target !== null, snapshot });

  /* ---------- 批量工具栏（阶段二 · T-P2-R5）----------

     状态机（选择集 / 批量模式 / 取值草稿 / 上次结果 + 收敛与逐条执行）在 `useWorkItemBulk`；
     页面只负责**写路径**：注入单条写入口（唯一写路径 `updateWorkItem`）与回读刷新。 */
  const writeBulkRow = useCallback(
    (row: WorkItemBulkTarget) => {
      /* 目标缺席时**响亮抛**（批量入口在无工作区/未就绪时置灰，正常走不到这里）；失败由
         executor 逐条归拢成可见结果，不吞。 */
      if (target === null) throw new Error("[WorkItemsPage] 批量写缺少 workspace 目标");
      return resolveSquadRuntimeService(services).updateWorkItem(target, {
        id: row.id,
        patch: row.patch,
      });
    },
    [services, target],
  );
  const logBulkFailures = useCallback((failures: WorkItemBulkFailure[]) => {
    logger.warn("[WorkItemsPage] 批量写有失败行", {
      failed: failures.length,
      workItemIds: failures.map((failure) => failure.workItemId),
    });
  }, []);
  const bulk = useWorkItemBulk({
    workItems: snapshot === null ? null : snapshot.workItems,
    surface,
    write: writeBulkRow,
    reload,
    onFailures: logBulkFailures,
  });

  /**
   * 改派的提交路径（**有意不走 `runAction`**）：`runAction` 的语义是「新建 / 编辑成功 ⇒
   * `setDialog(null)` + 一条成功提示」，而改派多一种结论 —— 服务面在**同值**时短路并回
   * `{assigned:false}`（同一事实重投不产生第二次动作；重复指派给同一对象不该再起一次 run），
   * 界面必须显示「未变更」而不是「已保存」。形态与 `runAction` 对齐（置忙 → 调服务 → 成功提示 +
   * 重载 / 失败提示 → 复位），但**不揉进它的语义**（把 `assigned:false` 塞进「成功即 setDialog(null)
   * 的那条路」会让两个结论共用一条提示，改一处漏一处）。busy 期间重复提交在此被挡（同款前置判断）。
   * 失败时**不关对话框**（与 runAction 一致：失败要能看见，重试就在眼前）。
   */
  const submitReassign = useCallback(
    (assignee: WorkItem["assignee"]) => {
      const item = reassignTarget;
      if (busyWorkItemId !== null || !target || item === null) return;
      void (async () => {
        setBusyWorkItemId(item.id);
        try {
          const outcome = await resolveSquadRuntimeService(services).reassignWorkItem(target, {
            workItemId: item.id,
            assignee,
          });
          setReassignTarget(null);
          notify({
            tone: "success",
            messageId: outcome.assigned
              ? "squad.workItems.reassigned"
              : "squad.workItems.reassignUnchanged",
          });
          await reload();
        } catch (error) {
          logger.warn("[WorkItemsPage] 改派失败", {
            error: error instanceof Error ? error.message : String(error),
          });
          notify(squadEntryErrorFeedback(error));
        } finally {
          setBusyWorkItemId(null);
        }
      })();
    },
    [busyWorkItemId, notify, reassignTarget, reload, services, target],
  );

  /** 「时间线」展开钮：同一条再点 = 收起；点别的条 = 换过去（换过去 = 旧的卸载、数据丢弃）。 */
  const toggleTimeline = useCallback((item: WorkItem) => {
    setExpandedTimelineWorkItemId((previous) => (previous === item.id ? null : item.id));
  }, []);

  return (
    <div data-testid="work-items-page" className="flex flex-col gap-4">
      {/* 视图区（T-P2-R6b）：条 + 三个对话框（portal；装配区只投影状态机）。 */}
      <WorkItemsViewsSection bridge={viewsBridge} />

      {/* Persistent actions stay above status projection so failure states keep the entry visible.
          The action component owns the single data-testid="work-items-create" button and its
          disabled={createDisabled} projection. */}
      <WorkItemsPageActions
        targetAvailable={target !== null}
        loading={loading}
        createDisabled={createDisabled}
        laneDimension={laneDimension}
        onLaneDimensionChange={viewsBridge.changeLaneDimension}
        surface={surface}
        onSurfaceIntent={viewsBridge.applySurfaceIntent}
        baseline={views.baseline}
        bulk={bulk.toolbar}
        t={t}
        onReload={() => void reload()}
        onCreate={() => setDialog({ kind: "create" })}
      />

      <WorkItemsPageStatus state={state} t={t} onReload={() => void reload()} />

      {state.mode === "ready" ? (
        <>
          <WorkItemsSurface
            workItems={state.snapshot.workItems}
            snapshot={state.snapshot}
            discardableIds={discardableIds}
            busyWorkItemId={discardingId ?? busyWorkItemId}
            timelineExpandedWorkItemId={expandedTimelineWorkItemId}
            laneDimension={laneDimension}
            surface={surface}
            onSurfaceIntent={viewsBridge.applySurfaceIntent}
            selection={bulk.selection}
            focusWorkItemId={focusWorkItemId}
            onFocusConsumed={onFocusConsumed}
            onEdit={(item) => setDialog({ kind: "edit", item })}
            onInlineEdit={submitInlineEdit}
            onReassign={(item) => setReassignTarget(item)}
            onDiscard={(workItemId) => {
              // **只进入待确认态**：真正的删除必须经对话框确认（不得一键即毁）。
              setDiscardConfirm(requestSquadDiscard(workItemId));
            }}
            onToggleTimeline={toggleTimeline}
            onOpenWorkItemDetail={onOpenWorkItemDetail}
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            onOpenSession={onOpenSession}
            onReorderPosition={viewsBridge.movePosition}
            onQuickCreate={viewsBridge.createWorkItem}
          />
          <SquadRunsReview
            runs={state.snapshot.runs}
            busyRunId={busyRunId}
            onReview={(runId, verdict) => {
              void review(runId, verdict);
            }}
            onOpenSession={onOpenSession}
          />
          {/* 「唤醒规则」分区（spec §11.1 / UI 方案「项目窗口 ▸ 规则」的承诺）。**次序**：看板
              （干活的地方）→ 待收尾运行（裁决队列）→ 规则（未来排班的配置）—— 配置面放在动作面
              之后。规则不混进「自动化」页：spec §5.6 里 cron 自动化与唤醒规则是两套分工的机制，
              混排会让用户读成一套。取数 / 写动作 / 四态都在分区里自含（理由见其文件头），
              本页只把工作项（行标题 + 建规则宿主候选）投影给它。 */}
          <WakeRulesSection
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            workItems={state.snapshot.workItems}
          />
        </>
      ) : null}

      <WorkItemsPageDialogs
        snapshot={snapshot}
        targetAvailable={target !== null}
        dialog={dialog}
        reassignTarget={reassignTarget}
        discardTargetItem={discardTargetItem}
        discarding={discardingId !== null}
        busyWorkItemId={busyWorkItemId}
        onCancelDiscard={() => setDiscardConfirm(cancelSquadDiscard())}
        onConfirmDiscard={() => {
          void runDiscard();
        }}
        onCloseWorkItem={() => setDialog(null)}
        onSubmitWorkItem={submitDialog}
        onCloseReassign={() => setReassignTarget(null)}
        onSubmitReassign={submitReassign}
      />
    </div>
  );
}
