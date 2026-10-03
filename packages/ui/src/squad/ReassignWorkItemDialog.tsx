import { useState } from "react";
import type { SquadSnapshot } from "@zcode/services";
import type { WorkItem } from "@zcode/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  assigneeOptionValue,
  parseAssigneeValue,
  resolveAssigneeName,
  workItemAssigneeOptions,
} from "./squadEntryViewModel.js";
import { CreateDialogShell, Field } from "./squadDialogParts.js";

/* 「改派」对话框（看板行「改派」钮的落点）：把既有工作项改给 user / agent / squad。
   复用 `squadDialogParts` 的壳与原语（与三个创建 / 编辑表单同款外观与焦点行为）。

   三条纪律：
   1. **候选与解析都不另写**：候选用既有 `workItemAssigneeOptions(snapshot)`（停用 / 归档对象不进候选
      —— 给了再被拒等于替用户制造一次失败），取值用既有 `parseAssigneeValue`。本组件只做投影。
   2. **初值 = 当前 assignee 反解出的 value**（`assigneeOptionValue`）。当前值不在候选里
      （智能体已归档 / 小队被删）时**把它补进选项**（只用于显示，仍走同一编码）——不补的话触发器
      是空的，用户看不出这条活现在指给谁；这里**不是**第二份候选：候选本体仍是
      `workItemAssigneeOptions` 的输出，补的只是「当前这一条」。
      原样提交同值不产生任何变更（服务面短路 ⇒「未变更」），故这一格是安全的（理由见
      `assigneeOptionValue` 的注释）。
   3. **本组件不执行任何服务调用**：只把选定的 `assignee` 原样交回 `onSubmit`（执行在页面里，
      与三个表单同款）；提交期间由页面禁重复提交。 */

export function ReassignWorkItemDialog({
  workItem,
  snapshot,
  onClose,
  onSubmit,
}: {
  workItem: WorkItem;
  snapshot: SquadSnapshot;
  onClose: () => void;
  /** 提交选定的负责人（已由 `parseAssigneeValue` 解回 `WorkItem["assignee"]`）。 */
  onSubmit: (assignee: WorkItem["assignee"]) => void;
}) {
  const { intl } = useZCodeIntl();
  const options = workItemAssigneeOptions(snapshot);
  const currentValue = assigneeOptionValue(workItem.assignee);
  const [value, setValue] = useState(currentValue);

  // 当前指派不在候选里 ⇒ 补一条「当前」用于显示（见函数头第 2 条；不额外造编码，值仍来自反解）。
  const selectableOptions = options.some((option) => option.value === currentValue)
    ? options
    : [
        {
          value: currentValue,
          kind: workItem.assignee.type,
          id: workItem.assignee.id,
          name: resolveAssigneeName(snapshot, workItem.assignee) ?? "",
        },
        ...options,
      ];

  return (
    <CreateDialogShell
      titleId="squad.workItems.reassignTitle"
      submitLabelId="squad.workItems.reassign"
      onClose={onClose}
      canSubmit={value.length > 0}
      onSubmit={() => onSubmit(parseAssigneeValue(value))}
    >
      <Field labelId="squad.common.assignee">
        {(controlId) => (
          <Select value={value} onValueChange={setValue}>
            <SelectTrigger id={controlId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {selectableOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.kind === "user"
                    ? intl.formatMessage({ id: "squad.common.assignee.user" })
                    : option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>
    </CreateDialogShell>
  );
}
