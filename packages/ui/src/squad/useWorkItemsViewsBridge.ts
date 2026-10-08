import { useCallback, useMemo, type Dispatch, type SetStateAction } from "react";
import type { IServiceAccessor, SquadWorkspaceTarget, WorkItemViewRecord } from "@zcode/services";
import { logger } from "@/logger.js";
import { squadEntryErrorFeedback, type SquadEntryFeedback } from "./squadEntryViewModel.js";
import { resolveSquadRuntimeService } from "./squadRuntimeAccess.js";
import type { WorkItemPositionPlan } from "./workItemPositionViewModel.js";
import { executeWorkItemPositionPlan } from "./workItemPositionViewModel.js";
import {
  executeWorkItemQuickCreate,
  type WorkItemQuickCreateRequest,
} from "./workItemQuickCreateViewModel.js";
import type { WorkItemSurfaceIntent, WorkItemSurfaceState } from "./workItemSurfaceViewModel.js";
import {
  useWorkItemViews,
  type WorkItemViewIo,
  type WorkItemViewsController,
} from "./useWorkItemViews.js";
import {
  applyWorkItemSurfaceIntentWithBaseline,
  normalizeWorkItemSurfaceForLaneDimension,
} from "./workItemViewsViewModel.js";
import type { WorkItemLaneDimension } from "./workItemsViewModel.js";

/* 「工作项」页面里 **保存视图 + 拖拽改序** 的接线层（阶段二 · T-P2-R6b）。

   为什么单独一层（与 `useWorkItemBulk` 同款理由）：`WorkItemsPage` 已到 `max-lines = 400` 的硬线，
   而这一面的加法（服务访问点 / 状态机 / Surface 折叠的视图语义 / 拖拽写路径）约八十行 ——
   塞进页面会把"编排"和"接线"混成一团。

   分层（照阶段二的既定做法）：
   · **判据**（定义形状、seed、baseline、可用排序档、位置计划）在 `workItemViewsViewModel` /
     `workItemPositionViewModel`（纯函数，逐格可测）；
   · **会话状态**（列表 / 打开态 / 对话框 / 删除确认）在 `useWorkItemViews`（状态机）；
   · **本层只有接线**：服务访问点（`resolveSquadRuntimeService` 那一处）、把 seed 灌进页面持有的
     state、把 Surface 意图折叠到视图语义上、把拖拽计划落到 `updateWorkItem` 这条唯一写路径。
   **本地调整不回写定义**：本层只在三条显式动作（保存 / 另存为 / 编辑）里调写方法。 */

/** 接线层的返回形状（视图区组件据此投影；类型由实现推导，不手抄第二份）。 */
export type WorkItemsViewsBridge = ReturnType<typeof useWorkItemsViewsBridge>;

export function useWorkItemsViewsBridge(input: {
  services: IServiceAccessor;
  /** 目标 workspace（`null` = 没有激活工作区 ⇒ 视图条只置灰，不消失）。 */
  target: SquadWorkspaceTarget | null;
  surface: WorkItemSurfaceState;
  laneDimension: WorkItemLaneDimension;
  /** 页面持有的 Surface / 分组状态（本层只**写**，不持有）。 */
  setSurface: Dispatch<SetStateAction<WorkItemSurfaceState>>;
  setLaneDimension: Dispatch<SetStateAction<WorkItemLaneDimension>>;
  /** 可见提示的**唯一**出口（页面注入：toast + 细节）。 */
  notify: (feedback: SquadEntryFeedback) => void;
  /** 快照回读（拖拽改序写完要重进页面看新序）。 */
  reload: () => Promise<void>;
  /** 写动作期间的行忙标记（页面注入：`*` = 「有写动作在飞」）。 */
  markBusy: (busyWorkItemId: string | null) => void;
}): {
  views: WorkItemViewsController;
  /** 视图条的读写面是否就绪（没有目标 ⇒ 条只置灰）。 */
  ioReady: boolean;
  applySurfaceIntent: (intent: WorkItemSurfaceIntent) => void;
  changeLaneDimension: (dimension: WorkItemLaneDimension) => void;
  movePosition: (plan: WorkItemPositionPlan) => void;
  /** 快速创建的写路径（T-P3-R1）：`null` = 成功（新行由回读后的快照投影出来）。 */
  createWorkItem: (request: WorkItemQuickCreateRequest) => Promise<SquadEntryFeedback | null>;
  openView: (viewId: string | null) => void;
  openCreateDialog: (sourceViewId?: string) => void;
  openManage: () => void;
  openEditDialog: (view: WorkItemViewRecord) => void;
} {
  const {
    services,
    target,
    surface,
    laneDimension,
    setSurface,
    setLaneDimension,
    notify,
    reload,
    markBusy,
  } = input;

  /* 读写面**唯一一处**接线（状态机只消费它）：六件 RPC 里 UI 用到四件 —— list / create /
     patch / delete。prefs（视图条显隐与次序）本轮未接（验收项里没有它，登记给 T-P2-V）。 */
  const viewIo = useMemo<WorkItemViewIo | null>(() => {
    if (!target) return null;
    return {
      list: () => resolveSquadRuntimeService(services).listWorkItemViews(target),
      create: (input2) => resolveSquadRuntimeService(services).createWorkItemView(target, input2),
      patch: (input2) => resolveSquadRuntimeService(services).patchWorkItemView(target, input2),
      remove: (id) => resolveSquadRuntimeService(services).deleteWorkItemView(target, { id }),
    };
  }, [services, target]);

  const notifyViewError = useCallback(
    (error: unknown) => {
      logger.warn("[WorkItemsPage] 保存视图操作失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      notify(squadEntryErrorFeedback(error));
    },
    [notify],
  );
  /* 视图消失（被删 / 无权）⇒ 退出到默认标签并**说一次**（静默退出会让用户以为界面自己跳了）。 */
  const notifyViewMissing = useCallback(() => {
    notify({ tone: "warning", messageId: "squad.workItems.views.missingToast" });
  }, [notify]);

  const views = useWorkItemViews({
    io: viewIo,
    /* 归属不用接线层给：**读面逐行带回** `ownedByViewer`（`listWorkItemViews` 按注入身份算），
       状态机的标签/管理面板投影直接消费它。UI 没有身份链（D1-A：不许自造身份）—— R6b 期间的
       `owner: null` 占位曾让「编辑禁用 / 删除不渲染」两个分支不可达（T-P2-V §9-2），已拆。 */
    surface,
    laneDimension,
    /* 首开 seed 的落地口：状态在页面（R1 冻结），本层只把 seed 灌进去。 */
    applySeed: (seed) => {
      setSurface(seed.surface);
      setLaneDimension(seed.laneDimension);
    },
    onError: notifyViewError,
    onMissing: notifyViewMissing,
  });

  /* Surface 意图的**唯一**折叠点：有视图打开时 `clearQuery` 回到视图条件（"清空筛选" ≠ 重置视图），
     其余意图逐格走 R1 的折叠（判据全在纯函数里，本层不判）。 */
  const applySurfaceIntent = useCallback(
    (intent: WorkItemSurfaceIntent) => {
      setSurface((current) =>
        applyWorkItemSurfaceIntentWithBaseline(current, intent, views.baseline),
      );
    },
    [setSurface, views.baseline],
  );

  /* 换分组维度：把当前排序档归一到新维度下可用的档（手动档在按指派分组下不可用 ⇒ 强制回落）。
     "控件里没有的档不能留在状态里"这条判据在纯函数里（含 hydrate 的路径逐格可测）。 */
  const changeLaneDimension = useCallback(
    (dimension: WorkItemLaneDimension) => {
      setLaneDimension(dimension);
      setSurface((current) => normalizeWorkItemSurfaceForLaneDimension(current, dimension));
    },
    [setLaneDimension, setSurface],
  );

  /* 拖拽改序的**唯一**执行点：纯函数算好的计划逐条经 `updateWorkItem`（position 白名单已通），
     写完回读（无乐观更新）。失败**不吞**：翻成可见提示（拖拽失败必须看得见）。 */
  const movePosition = useCallback(
    (plan: WorkItemPositionPlan) => {
      if (!target) return;
      markBusy("*");
      void (async () => {
        try {
          await executeWorkItemPositionPlan({
            plan,
            write: (update) =>
              resolveSquadRuntimeService(services).updateWorkItem(target, {
                id: update.workItemId,
                patch: { position: update.position },
              }),
          });
          await reload();
        } catch (error) {
          logger.warn("[WorkItemsPage] 拖拽改序失败", {
            error: error instanceof Error ? error.message : String(error),
          });
          notify(squadEntryErrorFeedback(error));
        } finally {
          markBusy(null);
        }
      })();
    },
    [markBusy, notify, reload, services, target],
  );

  /**
   * 快速创建的**唯一写路径**（T-P3-R1）：服务访问点、忙标记、失败归类、**服务回读**都在这里
   * —— 与 `movePosition` 同款分工（页面的 `max-lines` 硬线是这一层存在的理由）。
   *
   * 三条纪律（与执行编排 `executeWorkItemQuickCreate` 一一对应）：
   * ① 只经 `createWorkItem`（服务面唯一创建入口，**不直写 repo、不拼第二条请求**）；
   * ② 成功之后才 `reload()`（**无乐观插入**：新行由快照投影，本层不造行、不回传"刚建的那条"）；
   * ③ **失败不吞**：返回 `SquadEntryFeedback`（门禁 / 无工作区 / 未知失败带原始 `detail`），
   *    由快速创建条就地显示并保留用户输入；没有 workspace 目标时返回「无激活工作区」这条
   *    原因文案，**不去调服务**（"点得动但写不下去"的一条静默路径）。这一格是**防御**：
   *    宿主的提交钮在无目标时已经置灰（`workItemCreateEnabled`），正常走不到。
   */
  const createWorkItem = useCallback(
    async (request: WorkItemQuickCreateRequest): Promise<SquadEntryFeedback | null> => {
      if (!target) return { tone: "error", messageId: "squad.common.noWorkspace" };
      markBusy("*");
      try {
        const feedback = await executeWorkItemQuickCreate({
          request,
          create: (input) => resolveSquadRuntimeService(services).createWorkItem(target, input),
          reload,
        });
        if (feedback !== null) {
          logger.warn("[WorkItemsPage] 快速创建失败", {
            messageId: feedback.messageId,
            error: feedback.detail,
          });
        }
        return feedback;
      } finally {
        markBusy(null);
      }
    },
    [markBusy, reload, services, target],
  );

  return {
    views,
    ioReady: viewIo !== null,
    applySurfaceIntent,
    changeLaneDimension,
    movePosition,
    createWorkItem,
    openView: views.open,
    openCreateDialog: views.openCreateDialog,
    openManage: views.openManage,
    openEditDialog: views.openEditDialog,
  };
}
