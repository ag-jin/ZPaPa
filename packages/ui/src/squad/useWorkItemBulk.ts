import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkItem } from "@zcode/shared";
import type { WorkItemBulkToolbarInput } from "./WorkItemBulkToolbar.js";
import {
  applyWorkItemBulkDraftIntent,
  executeWorkItemBulkEdit,
  workItemBulkClearSelection,
  workItemBulkDefaultDraft,
  workItemBulkPlan,
  workItemBulkReconcileSelection,
  workItemBulkSelectionAfterApply,
  workItemBulkSelectionEquals,
  workItemBulkToggleSelection,
  type WorkItemBulkDraft,
  type WorkItemBulkDraftIntent,
  type WorkItemBulkFailure,
  type WorkItemBulkWriter,
  type WorkItemRowSelection,
} from "./workItemBulkViewModel.js";
import {
  workItemSurfaceVisibleItems,
  type WorkItemSurfaceState,
} from "./workItemSurfaceViewModel.js";

/* 工作项**批量选择**的会话状态机（阶段二 · T-P2-R5）—— 状态、收敛与执行次序，**不含写路径**。

   为什么抽成 hook：`WorkItemsPage` 已到 `max-lines = 400` 的边缘（本轮的加法必须搬出去换余量，
   照 `useWorkItemInlineEdit` 的先例）；而"状态读不懂在哪"也是这一面的实际风险 —— 批量有四个状态
   （选择集 / 模式 / 草稿 / 上次结果）加两条判据（收敛、逐条执行）。

   分层：**判据**（可批量字段、选择集收敛、逐条 patch、结果汇总）在 `workItemBulkViewModel`（纯函数，
   逐格可测）；**状态机**（本文件：状态 + 投影 + 按次序调用写入口）；**写路径**仍只在页面 ——
   本层不 import 服务、不拼请求，单条写入口由页面**注入**（`write`）。 */

/** 写完之后要不要留痕（页面注入 logger；本层不 import 日志模块）。 */
export type WorkItemBulkFailureReporter = (failures: WorkItemBulkFailure[]) => void;

export function useWorkItemBulk(input: {
  /** 快照的就绪投影（未就绪 ⇒ `null`：没有可见行，也就没有可批量的对象）。 */
  workItems: WorkItem[] | null;
  /** Surface 状态（页面持有）：可见集 = 「收敛」与「逐条 patch」的输入。 */
  surface: WorkItemSurfaceState;
  /** 单条写入口（页面注入的**唯一**写路径：`(target) => service.updateWorkItem(...)`）。 */
  write: WorkItemBulkWriter;
  /** 写完之后以服务回读刷新（页面注入）。 */
  reload: () => Promise<void>;
  /** 有失败行时的留痕回调（可选：页面接 logger）。 */
  onFailures?: WorkItemBulkFailureReporter;
}): {
  /** 行选择投影（传给宿主 ⇒ 行模块）；未进入批量模式 ⇒ `undefined`（行结构零变化）。 */
  selection?: WorkItemRowSelection;
  /** 批量条的全部入参（控件带只挂载工具栏；置灰原因由控件带用同一份判据补上）。 */
  toolbar: WorkItemBulkToolbarInput;
} {
  const { workItems, surface, write, reload, onFailures } = input;

  const [active, setActive] = useState(false);
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [draft, setDraft] = useState<WorkItemBulkDraft>(workItemBulkDefaultDraft);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<WorkItemBulkToolbarInput["result"]>(null);

  /* 可见集：与宿主**同一个**纯函数、同一份状态入参（不是第二份判据 —— 宿主那份用于渲染，
     这里那份让选择集收敛到"用户此刻看得见的行"）。 */
  const visibleItems = useMemo(
    () =>
      workItems === null ? [] : workItemSurfaceVisibleItems({ items: workItems, state: surface }),
    [workItems, surface],
  );
  /* 选择集恒 ⊆ 可见 ∩ 可写（承重验收 2）：读时投影 + 变化后对齐下面两处。 */
  const selectedVisibleIds = useMemo(
    () => workItemBulkReconcileSelection({ selected: selectedIds, visible: visibleItems }),
    [selectedIds, visibleItems],
  );
  useEffect(() => {
    setSelectedIds((current) =>
      workItemBulkSelectionEquals(current, selectedVisibleIds) ? current : selectedVisibleIds,
    );
  }, [selectedVisibleIds]);

  const onDraftIntent = useCallback((intent: WorkItemBulkDraftIntent) => {
    setDraft((current) => applyWorkItemBulkDraftIntent(current, intent));
  }, []);

  /* 批量写的**唯一执行点**：逐条、串行，经注入的单条写入口（页面那一条 `updateWorkItem`）。
     四条纪律：① 无乐观更新（写完才 reload）；② 一条失败不中断其余；③ 部分失败**逐条**可见；
     ④ 服务没接上时每一条各自失败并各自给出原因（executor 内逐条 catch）。 */
  const apply = useCallback(async () => {
    if (applying) return;
    const plan = workItemBulkPlan({
      items: visibleItems,
      selectedIds: selectedVisibleIds,
      edit: draft,
    });
    if (plan.targets.length === 0 && plan.precheckFailures.length === 0) return;
    setApplying(true);
    try {
      const outcomes = await executeWorkItemBulkEdit({ plan, write });
      setResult(outcomes);
      /* 失败的行留在选择集里（下一动作通常是重试它），成功行退出 —— 判据在纯函数里。 */
      setSelectedIds((current) =>
        workItemBulkSelectionAfterApply({
          selected: current,
          failedIds: outcomes.failures.map((failure) => failure.workItemId),
        }),
      );
      if (outcomes.failures.length > 0) onFailures?.(outcomes.failures);
      await reload();
    } finally {
      setApplying(false);
    }
  }, [applying, draft, onFailures, reload, selectedVisibleIds, visibleItems, write]);

  return {
    selection: useMemo<WorkItemRowSelection | undefined>(
      () =>
        active
          ? {
              selectedIds: new Set(selectedVisibleIds),
              disabled: applying,
              onToggle: (workItemId: string) =>
                setSelectedIds((current) =>
                  workItemBulkToggleSelection({ selected: current, workItemId }),
                ),
            }
          : undefined,
      [active, applying, selectedVisibleIds],
    ),
    toolbar: useMemo<WorkItemBulkToolbarInput>(
      () => ({
        active,
        selectedCount: selectedVisibleIds.length,
        draft,
        applying,
        result,
        /* 开/关批量模式：退出时清选择集与上次结果（面板说的就是"这一批"，退出即作废），
           保留取值草稿（"我正要应用什么"是用户的意图，不该因为收起面板丢掉）。 */
        onToggleActive: () => {
          setActive((current) => !current);
          setSelectedIds(workItemBulkClearSelection());
          setResult(null);
        },
        onClear: () => setSelectedIds(workItemBulkClearSelection()),
        onDraftIntent,
        onApply: () => void apply(),
      }),
      [active, applying, apply, draft, onDraftIntent, result, selectedVisibleIds],
    ),
  };
}
