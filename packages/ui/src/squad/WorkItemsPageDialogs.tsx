import type { WorkItem } from "@zcode/shared";
import type { SquadSnapshot } from "@zcode/services";
import { WorkItemDialog, type WorkItemDialogSubmitInput } from "./SquadCreateDialogs.js";
import { ReassignWorkItemDialog } from "./ReassignWorkItemDialog.js";
import { SquadDiscardDialog } from "./SquadDiscardDialog.js";
import type { WorkItemProjectsHandle } from "./useWorkItemProjects.js";

/**
 * WorkItemsPage 的对话框装配区：只投影页面已经拥有的状态，并把用户意图回传给页面。
 *
 * 服务调用、刷新、确认判据和页面级状态仍由 WorkItemsPage 唯一拥有；本组件不读 store、
 * 不解析 target，也不执行动作。snapshot + targetAvailable 是对话框可安全装配的唯一输入。
 */
export function WorkItemsPageDialogs({
  snapshot,
  targetAvailable,
  dialog,
  reassignTarget,
  discardTargetItem,
  discarding,
  busyWorkItemId,
  workItemProjects,
  onCancelDiscard,
  onConfirmDiscard,
  onCloseWorkItem,
  onSubmitWorkItem,
  onCloseReassign,
  onSubmitReassign,
}: {
  snapshot: SquadSnapshot | null;
  targetAvailable: boolean;
  dialog: { kind: "create" } | { kind: "edit"; item: WorkItem } | null;
  reassignTarget: WorkItem | null;
  discardTargetItem: WorkItem | null;
  discarding: boolean;
  busyWorkItemId: string | null;
  /** 项目清单与内联新建的**唯一 handle**（R-P2；页面经接线层注入）：新建表单的项目选择器与
      「新建项目…」都只读它（本组件不取服务）。 */
  workItemProjects?: WorkItemProjectsHandle;
  onCancelDiscard: () => void;
  onConfirmDiscard: () => void;
  onCloseWorkItem: () => void;
  onSubmitWorkItem: (input: WorkItemDialogSubmitInput) => void;
  onCloseReassign: () => void;
  onSubmitReassign: (assignee: WorkItem["assignee"]) => void;
}) {
  const canRenderDialogs = snapshot !== null && targetAvailable;

  return (
    <>
      {discardTargetItem ? (
        <SquadDiscardDialog
          workItem={discardTargetItem}
          pending={discarding}
          onCancel={onCancelDiscard}
          onConfirm={onConfirmDiscard}
        />
      ) : null}

      {canRenderDialogs && dialog?.kind === "create" ? (
        <WorkItemDialog
          snapshot={snapshot}
          onClose={onCloseWorkItem}
          onSubmit={onSubmitWorkItem}
          {...(workItemProjects === undefined ? {} : { workItemProjects })}
        />
      ) : null}

      {canRenderDialogs && dialog?.kind === "edit" ? (
        <WorkItemDialog
          snapshot={snapshot}
          onClose={onCloseWorkItem}
          onSubmit={onSubmitWorkItem}
          mode="edit"
          titleId="squad.workItems.editTitle"
          submitLabelId="squad.common.save"
          /* 初值来自**条目本身**（未设置 ⇒ undefined ⇒ 表单显示空白 /「未设置」）：
             不回填等于「编辑一次就把库里已有的值清空」，且不报错。 */
          initial={{
            title: dialog.item.title,
            body: dialog.item.body,
            labels: dialog.item.labels,
            priority: dialog.item.priority,
            startDate: dialog.item.startDate,
            dueDate: dialog.item.dueDate,
          }}
        />
      ) : null}

      {canRenderDialogs && reassignTarget ? (
        <ReassignWorkItemDialog
          workItem={reassignTarget}
          snapshot={snapshot}
          onClose={onCloseReassign}
          onSubmit={onSubmitReassign}
        />
      ) : null}
    </>
  );
}
