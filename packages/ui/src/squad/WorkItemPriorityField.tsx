import { WORK_ITEM_PRIORITY_KEYS } from "@zcode/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Field } from "./squadDialogParts.js";
import { WORK_ITEM_PRIORITY_CLEAR_VALUE } from "./workItemInlineEditViewModel.js";
import { WORK_ITEM_PRIORITY_MESSAGE_IDS } from "./workItemPropertiesViewModel.js";

/* 工作项表单（创建 / 编辑双用对话框）的**优先级字段** —— 从 `SquadCreateDialogs` 里单独成模块。

   两件事必须同处一屏才读得出来（分开就会重演轮 D 的那半个缺陷）：
   ① **「未设置」是一个哨兵取值，不是空串**：Radix 的 Select 把空串保留给「没有选中」（placeholder），
      `SelectItem` 拿到空串会**直接抛**（打开下拉即崩）。行内 picker 在轮 D 已用
      `WORK_ITEM_PRIORITY_CLEAR_VALUE` 修过，对话框这一份当时没跟上 —— 同一个缺陷的第二处，
      故这里**复用同一个哨兵常量**（两个哨兵 = 两套「未设置」，选中态会飘）；
   ② **提交口径仍是既有纯函数**：表单把哨兵译回空串（`workItemPriorityFieldInput`），
      `parseWorkItemSurfaceFields` 再把空白读成 `null`（清回未设置）。
      翻译恰在这一处：散到调用面就会出现「下拉看着是未设置、提交却写了别的值」。

   选项表由 `workItemPrioritySelectOptions()` 单源给出（哨兵 + shared 四档）：
   调用方不手抄第二份清单，「取值全员非空」这件事因此可以在测试里逐项判。 */

/** 一项下拉取值 → 文案键（`value` 是 UI 取值域的字符串：哨兵或档位）。 */
export type WorkItemPrioritySelectOption = {
  value: string;
  messageId: string;
};

/** 「未设置」项的文案键（与行内 picker 同一个词：未设置就是未设置）。 */
export const WORK_ITEM_PRIORITY_UNSET_MESSAGE_ID = "squad.workItems.priority.unset";

/**
 * 选项表单源：**哨兵首项**（未设置不是一个档位，故排在四档之前）+ shared 的四档（顺序原样）。
 * 取值必须全员非空 —— 空串会让 Radix 的 `SelectItem` 在打开下拉时抛。
 */
export function workItemPrioritySelectOptions(): WorkItemPrioritySelectOption[] {
  return [
    { value: WORK_ITEM_PRIORITY_CLEAR_VALUE, messageId: WORK_ITEM_PRIORITY_UNSET_MESSAGE_ID },
    ...WORK_ITEM_PRIORITY_KEYS.map((key) => ({
      value: key as string,
      messageId: WORK_ITEM_PRIORITY_MESSAGE_IDS[key],
    })),
  ];
}

/**
 * 下拉取值 → 表单口径的**输入原文**（`""` = 未设置，其余原样）。
 * 这是 UI 侧唯一的翻译：服务面判据（`parseWorkItemSurfaceFields` → shared）不认哨兵。
 */
export function workItemPriorityFieldInput(selectValue: string): string {
  return selectValue === WORK_ITEM_PRIORITY_CLEAR_VALUE ? "" : selectValue;
}

/** 优先级字段：标签 + 下拉（受控取值由调用方持有；本组件不解析、不提交）。 */
export function WorkItemPriorityField({
  value,
  onChange,
}: {
  /** 下拉取值（哨兵或档位）——未设置必须传哨兵，不得传空串（理由见文件头注）。 */
  value: string;
  onChange: (next: string) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Field labelId="squad.workItems.priority">
      {(controlId) => (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger id={controlId} data-testid="work-item-priority-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {workItemPrioritySelectOptions().map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {intl.formatMessage({ id: option.messageId })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </Field>
  );
}
