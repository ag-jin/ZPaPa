import { useCallback } from "react";
import type { IServiceAccessor, SquadWorkspaceTarget } from "@zcode/services";
import { logger } from "@/logger.js";
import { squadEntryErrorFeedback, type SquadEntryFeedback } from "./squadEntryViewModel.js";
import { resolveSquadRuntimeService } from "./squadRuntimeAccess.js";

/* 「一次写动作」的公共执行路径（R-P2 项目绑定 · UI 轮从 `WorkItemsPage` 搬出）。

   为什么搬出来：`WorkItemsPage` 已到 `max-lines = 400` 的硬线（阶段三「不动 Page」的硬约束），
   而本项目绑定轮要往页面加四处接线（三处 props + 创建请求带 `projectId`）。照既有先例
   （`useWorkItemBulk` / `useWorkItemInlineEdit` / `useWorkItemsViewsBridge`）：**先抽件、再接线**
   —— 抽出来的这一段**没有判据**，只有「置忙 → 调服务 → 成功提示 + 回读 / 失败提示（不吞错）→ 复位」
   这条既有执行次序，行为逐字不变（`WorkItemsPage` 的既有用例与守卫仍咬同一处接线）。

   唯一所有者不变：服务访问点仍是 `resolveSquadRuntimeService`（缺服务时响亮抛），
   `notify` / `reload` / `markBusy` / 成功后收起对话框都由页面注入。 */

/** 一次写动作的执行器（与页面原先的 `runAction` 逐字同形：入参、次序、失败归宿都不变）。 */
export type WorkItemWriteAction = (
  workItemId: string,
  action: (service: ReturnType<typeof resolveSquadRuntimeService>) => Promise<unknown>,
  successMessageId: string,
) => Promise<void>;

export function useWorkItemsWriteAction(input: {
  services: IServiceAccessor;
  /** `null` = 没有激活工作区 ⇒ 直接返回（入口在无目标时已置灰，正常走不到）。 */
  target: SquadWorkspaceTarget | null;
  /** 可见提示的唯一出口（页面注入：toast + 细节）。 */
  notify: (feedback: SquadEntryFeedback) => void;
  /** 服务回读（成功后才调：写成了才刷新）。 */
  reload: () => Promise<void>;
  /** 成功之后收起对话框（页面的 `setDialog(null)`）。 */
  onSuccess: () => void;
  /** 写期间的行忙标记（页面注入：新建走 `*`）。 */
  markBusy: (busyWorkItemId: string | null) => void;
}): WorkItemWriteAction {
  const { services, target, notify, reload, onSuccess, markBusy } = input;
  return useCallback(
    async (
      workItemId: string,
      action: (service: ReturnType<typeof resolveSquadRuntimeService>) => Promise<unknown>,
      successMessageId: string,
    ) => {
      if (!target) return;
      markBusy(workItemId);
      try {
        await action(resolveSquadRuntimeService(services));
        onSuccess();
        notify({ tone: "success", messageId: successMessageId });
        await reload();
      } catch (error) {
        logger.warn("[WorkItemsPage] 工作项操作失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        notify(squadEntryErrorFeedback(error));
      } finally {
        markBusy(null);
      }
    },
    [markBusy, notify, onSuccess, reload, services, target],
  );
}
