import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CreateWorkItemViewInput,
  PatchWorkItemViewInput,
  WorkItemViewOwner,
  WorkItemViewRecord,
} from "@zcode/services";
import { WORK_ITEM_VIEW_REVISION_CONFLICT_CODE } from "@zcode/services";
import type { WorkItemSurfaceState } from "./workItemSurfaceViewModel.js";
import {
  WORK_ITEM_VIEW_DEFINITION_VERSION,
  workItemViewBaseline,
  workItemViewManageRows,
  workItemViewDefinitionSummary,
  workItemViewDisplayFromSurface,
  workItemViewListAfterLoad,
  workItemViewQueryFromSurface,
  type WorkItemViewDialog,
  type WorkItemViewFormSubmit,
  sanitizeWorkItemViewDisplay,
  sanitizeWorkItemViewQuery,
  workItemViewSeed,
  workItemViewTabs,
  type WorkItemViewBaseline,
  type WorkItemViewDisplayDocument,
  type WorkItemViewManageRow,
  type WorkItemViewQueryDocument,
  type WorkItemViewSummaryEntry,
  type WorkItemViewTab,
} from "./workItemViewsViewModel.js";
import type { WorkItemLaneDimension } from "./workItemsViewModel.js";

/* 工作项**保存视图**的会话状态机（阶段二 · T-P2-R6b）—— 状态、投影与三条写路径，**不含服务访问**。

   为什么抽成 hook（照 `useWorkItemBulk` 的先例）：`WorkItemsPage` 已到 `max-lines = 400` 的边缘，
   而"视图条的状态在哪"本身就是这一面的风险 —— 列表 / 打开态 / 对话框 / 删除确认 / 管理面板
   五块状态加三条写路径（建 / 改 / 删），揉进页面会把编排与状态混成一团。

   分层：**判据**（定义形状、首开 seed、baseline、权限投影、定义摘要）在 `workItemViewsViewModel`
   （纯函数，逐格可测）；**状态机**（本文件：状态 + 投影 + 调用注入的读写面）；**服务与 workspace
   目标**仍只在页面（本层不 import 服务实现、不解析 target —— 与 `useWorkItemBulk` 同款）。

   三条写路径的**共同纪律**（与 multica `issue_view.go` 同款）：
   · `create` 带上**当前定义**（首开种子就是它，所见即所存）；
   · `patch` 必带 `expectedRevision`（乐观并发；冲突 ⇒ 重拉列表 + 可见提示，绝不静默覆盖）；
   · `delete` 不带 revision（删除没有 fencing），删除前必须过一次二次确认（页面侧）。
   **本地调整不回写**：只有这三条路径会调写方法，Surface 的意图折叠（纯函数）碰不到它们。 */

/** 页面注入的读写面（唯一实现点在页面：`resolveSquadRuntimeService(services)` + `target`）。 */
export type WorkItemViewIo = {
  list: () => Promise<WorkItemViewRecord[]>;
  create: (input: CreateWorkItemViewInput) => Promise<WorkItemViewRecord>;
  patch: (input: PatchWorkItemViewInput) => Promise<WorkItemViewRecord>;
  remove: (id: string) => Promise<void>;
};

/* 对话框的两个**类型**（`WorkItemViewDialog` / `WorkItemViewFormSubmit`）住在视图模型里
   （它们是纯数据 + 投影函数的入参），这里只做**再导出** —— 消费方（对话框组件）的进口不变。 */
export type { WorkItemViewDialog, WorkItemViewFormSubmit } from "./workItemViewsViewModel.js";

/** 状态机的返回形状（页面的对话框装配区据此投影 —— 类型由实现推导，不手抄第二份）。 */
export type WorkItemViewsController = ReturnType<typeof useWorkItemViews>;

export function useWorkItemViews(input: {
  /** 有 workspace 目标且读写面已接线（`io === null` ⇒ 条上只剩内建锚，不可建）。 */
  io: WorkItemViewIo | null;
  /** 观察者身份：**读面没有带回它**（R6a 的 list 只回记录）⇒ 传 `null`（归属不可判定）。 */
  owner: WorkItemViewOwner | null;
  surface: WorkItemSurfaceState;
  laneDimension: WorkItemLaneDimension;
  /** 首开 seed 的落地口（页面注入：把 seed 灌进它持有的 surface + 分组状态）。 */
  applySeed: (seed: {
    surface: WorkItemSurfaceState;
    laneDimension: WorkItemLaneDimension;
  }) => void;
  /** 失败/消失的可见归宿（页面注入：翻成 toast；本层不 import 提示模块）。 */
  onError: (error: unknown) => void;
  onMissing: () => void;
}): {
  tabs: WorkItemViewTab[];
  /** 管理面板的行（记录 + 标签 + 管理权）：面板与条上菜单共用同一份判据。 */
  manageRows: WorkItemViewManageRow[];
  activeViewId: string | null;
  activeView: WorkItemViewRecord | null;
  /** 视图的基准态（固定值锁定 / 清空筛选回视图条件）；没有打开视图 ⇒ `null`。 */
  baseline: WorkItemViewBaseline | null;
  busy: boolean;
  open: (viewId: string | null) => void;
  /** 建视图的入口：`sourceViewId` 非空 = 从那条视图「另存为」（draft 取它的定义）。 */
  openCreateDialog: (sourceViewId?: string) => void;
  /** 编辑入口（管理面板的行）：draft = 打开那一刻的当前界面定义（编辑 = 把当前调整写回定义）。 */
  openEditDialog: (view: WorkItemViewRecord) => void;
  openManage: () => void;
  manageOpen: boolean;
  closeManage: () => void;
  dialog: WorkItemViewDialog | null;
  closeDialog: () => void;
  submitDialog: (submit: WorkItemViewFormSubmit) => Promise<void>;
  summary: WorkItemViewSummaryEntry[];
  deleteTarget: WorkItemViewRecord | null;
  confirmDelete: (view: WorkItemViewRecord) => void;
  cancelDelete: () => void;
  runDelete: () => Promise<void>;
} {
  const { io, owner, surface, laneDimension, applySeed, onError, onMissing } = input;

  const [views, setViews] = useState<WorkItemViewRecord[]>([]);
  /* 打开态是**页面内存态**（不写进任何存储）：恢复了已删视图的 id 会把用户困在"打开着一个
     不存在的视图"上（multica 同一条理由）。 */
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<WorkItemViewDialog | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WorkItemViewRecord | null>(null);

  /** 当前界面的定义（保存 / 另存为 / 编辑的"所见即所存"那一份）。 */
  const currentDraft = useCallback(
    () => ({
      query: workItemViewQueryFromSurface(surface),
      display: workItemViewDisplayFromSurface({ surface, laneDimension }),
    }),
    [laneDimension, surface],
  );

  /* 列表回读：**失败不清空已有列表**（与页面 reload 同一条姿态：刷新失败不该让条上的视图消失），
     但要让失败可见（`onError`）。收敛只做一件判据：当前打开的视图不在列表里 ⇒ 退出 + 报缺失。 */
  const reload = useCallback(async () => {
    if (io === null) {
      setViews([]);
      return;
    }
    try {
      const listed = await io.list();
      setViews(listed);
      setActiveViewId((current) => {
        const next = workItemViewListAfterLoad({ views: listed, activeViewId: current });
        if (next.missing) onMissing();
        return next.activeViewId;
      });
    } catch (error) {
      onError(error);
    }
  }, [io, onError, onMissing]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 打开视图（`null` = 内建锚）：把定义**首开 seed** 灌进 surface + 分组维度。 */
  const open = useCallback(
    (viewId: string | null) => {
      setActiveViewId(viewId);
      if (viewId === null) return;
      const target = views.find((view) => view.id === viewId);
      if (target === undefined) return;
      applySeed(workItemViewSeed(target));
    },
    [applySeed, views],
  );

  const activeView = useMemo(
    () => views.find((view) => view.id === activeViewId) ?? null,
    [activeViewId, views],
  );

  /** 写动作的公共执行路径：置忙 → 调注入的写面 → 失败可见（冲突额外重拉列表）→ 复位。 */
  const runWrite = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      try {
        await action();
      } catch (error) {
        // 乐观并发冲突：列表已被别处改过 ⇒ 重拉后再让用户决定（不静默覆盖别人的改动）。
        if ((error as { code?: unknown } | null)?.code === WORK_ITEM_VIEW_REVISION_CONFLICT_CODE) {
          await reload();
        }
        onError(error);
      } finally {
        setBusy(false);
      }
    },
    [onError, reload],
  );

  const openCreateDialog = useCallback(
    (sourceViewId?: string) => {
      const source =
        sourceViewId === undefined ? undefined : views.find((v) => v.id === sourceViewId);
      setDialog({
        kind: "create",
        sourceViewId: sourceViewId ?? null,
        draft:
          source === undefined
            ? currentDraft()
            : {
                /* 另存为：复制**源视图的定义**（不是当前界面状态 —— 那会把"我把 A 调过之后的
                   样子"存成"B 的副本"，而用户以为复制的是 B）。定义先过 sanitize（与服务面
                   读回的 opaque 文档同一道闸：闭集外的值不进新定义）。 */
                query: sanitizeWorkItemViewQuery(source.query),
                display: sanitizeWorkItemViewDisplay(source.display),
              },
      });
      setManageOpen(false);
    },
    [currentDraft, views],
  );

  const openEditDialog = useCallback(
    (view: WorkItemViewRecord) => {
      setDialog({ kind: "edit", view, draft: currentDraft() });
      setManageOpen(false);
    },
    [currentDraft],
  );

  const submitDialog = useCallback(
    async (submit: WorkItemViewFormSubmit) => {
      if (dialog === null || io === null) return;
      const { draft } = dialog;
      await runWrite(async () => {
        if (dialog.kind === "create") {
          const created = await io.create({
            name: submit.name,
            // 共享 ⇒ workspace 档；私有 ⇒ my 档（"我的视角"）。my 档恒私有的闸在服务面与 DB。
            scopeType: submit.shared ? "workspace" : "my",
            visibility: submit.shared ? "workspace" : "private",
            definitionVersion: WORK_ITEM_VIEW_DEFINITION_VERSION,
            query: draft.query,
            display: draft.display,
          });
          setDialog(null);
          await reload();
          /* 新建的视图**立刻打开**（multica 同款）：看到的条上多一枚标签并选中，且界面对齐它的定义。 */
          setActiveViewId(created.id);
          applySeed(workItemViewSeed(created));
          return;
        }
        await io.patch({
          id: dialog.view.id,
          expectedRevision: dialog.view.revision,
          patch: {
            name: submit.name,
            visibility: submit.shared ? "workspace" : "private",
            query: draft.query,
            display: draft.display,
          },
        });
        setDialog(null);
        await reload();
      });
    },
    [applySeed, dialog, io, reload, runWrite],
  );

  const runDelete = useCallback(async () => {
    const target = deleteTarget;
    if (target === null || io === null) return;
    await runWrite(async () => {
      await io.remove(target.id);
      setDeleteTarget(null);
      // 删的是正在看的这一条 ⇒ 先退出（reload 的缺失判据因此不会误报一次"视图消失"）。
      setActiveViewId((current) => (current === target.id ? null : current));
      await reload();
    });
  }, [deleteTarget, io, reload, runWrite]);

  const openManage = useCallback(() => setManageOpen(true), []);
  const closeManage = useCallback(() => setManageOpen(false), []);
  const closeDialog = useCallback(() => setDialog(null), []);
  const cancelDelete = useCallback(() => setDeleteTarget(null), []);
  const confirmDelete = useCallback((view: WorkItemViewRecord) => {
    setDeleteTarget(view);
    setManageOpen(false);
  }, []);

  return {
    tabs: useMemo(() => workItemViewTabs({ views, owner }), [owner, views]),
    manageRows: useMemo(() => workItemViewManageRows({ views, owner }), [owner, views]),
    activeViewId,
    activeView,
    baseline: useMemo(
      () => (activeView === null ? null : workItemViewBaseline(activeView)),
      [activeView],
    ),
    busy,
    open,
    openCreateDialog,
    openEditDialog,
    openManage,
    manageOpen,
    closeManage,
    dialog,
    closeDialog,
    submitDialog,
    summary: useMemo(
      () => (dialog === null ? [] : workItemViewDefinitionSummary(dialog.draft)),
      [dialog],
    ),
    deleteTarget,
    confirmDelete,
    cancelDelete,
    runDelete,
  };
}
