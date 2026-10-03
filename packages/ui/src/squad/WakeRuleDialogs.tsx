import type { CreateWakeRuleRequest, UpdateWakeRuleRequest } from "@zcode/services";
import type { WakeRule, WorkItem } from "@zcode/shared";
import { CreateWakeRuleDialog } from "./CreateWakeRuleDialog.js";
import { wakeRuleDialogInitial } from "./wakeRulesViewModel.js";

/* 唤醒规则的**两个对话框挂载点**（新建 / 编辑）——机械拆分，理由与 `squadDialogParts.tsx` 同款：
   `WakeRulesSection.tsx` 收下编辑 / 删除两个动作后越过了 oxlint 的 max-lines（400）硬门槛，
   把「与业务逻辑无关的接线」搬到这里（**零行为变化**：状态、写路径、校验、初值映射全不在本文件）。

   为什么不把这些搬去别处而保留在分区里（分层的既定口径，见分区的头注释）：
   · 对话框的**开关状态**（`createOpen` / `editTarget`）与**写动作**（createWakeRule / updateWakeRule
     的提交路径）都归分区持有 —— 本组件只把它们接到同一份表单上（表单本体在
     `CreateWakeRuleDialog`，校验核心在 `wakeRulesViewModel`）。
   · 两个对话框**必须是同一份表单**（`mode` / `initial` / `titleId` / `submitLabelId` 是仅有的差异），
     故两个挂载点也必须挨着写在这里，谁都不能在别处再抄一份。 */

export function WakeRuleDialogs({
  workItems,
  createOpen,
  creating,
  onCloseCreate,
  onSubmitCreate,
  editTarget,
  editBusy,
  onCloseEdit,
  onSubmitEdit,
}: {
  /** 规则宿主候选（= 当前项目的工作项）。 */
  workItems: WorkItem[];
  /** 新建对话框开关（分区状态；宿主候选为空时分区不会开它）。 */
  createOpen: boolean;
  /** 新建在飞（提交期间禁重复提交 —— 壳的 canSubmit）。 */
  creating: boolean;
  onCloseCreate: () => void;
  /** 新建提交（分区已用 `buildCreateWakeRuleInput` 校验过；本组件只转交）。 */
  onSubmitCreate: (input: CreateWakeRuleRequest) => void;
  /** 编辑对象（`null` = 编辑对话框没开；初值由 `wakeRuleDialogInitial` 从这里映射）。 */
  editTarget: WakeRule | null;
  /** 单飞在飞（分区透传）：编辑期间禁重复提交。 */
  editBusy: boolean;
  onCloseEdit: () => void;
  /** 编辑提交（分区已用 `buildUpdateWakeRuleInput` 校验过；patch 不含 workItemId）。 */
  onSubmitEdit: (patch: UpdateWakeRuleRequest) => void;
}) {
  return (
    <>
      {createOpen ? (
        <CreateWakeRuleDialog
          workItems={workItems}
          busy={creating}
          onClose={onCloseCreate}
          onSubmit={(submit) => {
            if (submit.mode === "create") onSubmitCreate(submit.input);
          }}
        />
      ) : null}
      {/* 编辑 = **同一份表单**的 edit 模式：工作项只读（挂载对象不可改）、其余字段填初值、
          标题 / 提交文案换掉。 */}
      {editTarget ? (
        <CreateWakeRuleDialog
          workItems={workItems}
          busy={editBusy}
          mode="edit"
          initial={wakeRuleDialogInitial(editTarget)}
          titleId="squad.rules.editTitle"
          submitLabelId="squad.common.save"
          onClose={onCloseEdit}
          onSubmit={(submit) => {
            if (submit.mode === "edit") onSubmitEdit(submit.patch);
          }}
        />
      ) : null}
    </>
  );
}
