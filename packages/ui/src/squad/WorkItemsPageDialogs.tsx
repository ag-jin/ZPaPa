import type { WorkItem } from "@zcode/shared";
import type { SquadSnapshot } from "@zcode/services";
import { WorkItemDialog, type WorkItemDialogSubmitInput } from "./SquadCreateDialogs.js";
import { ReassignWorkItemDialog } from "./ReassignWorkItemDialog.js";
import { SquadDiscardDialog } from "./SquadDiscardDialog.js";

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
          onConfirm={onConfirmDiscard}        />
      ) : null}

      {canRenderDialogs && dialog?.kind === "create" ? (
        <WorkItemDialog
          snapshot={snapshot}
          onClose={onCloseWorkItem}
          onSubmit={onSubmitWorkItem}
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
          initial={{ title: dialog.item.title, body: dialog.item.body, labels: dialog.item.labels }}
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
