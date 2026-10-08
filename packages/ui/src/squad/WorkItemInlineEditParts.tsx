import type { ReactNode } from "react";
import { WORK_ITEM_PRIORITY_KEYS, type WorkItemPriorityKey } from "@zcode/shared";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkItemInlineEditFailure } from "./useWorkItemInlineEdit.js";
import {
  WORK_ITEM_PRIORITY_CLEAR_VALUE,
  workItemInlinePrioritySelectValue,
} from "./workItemInlineEditViewModel.js";
import { WORK_ITEM_PRIORITY_MESSAGE_IDS } from "./workItemPropertiesViewModel.js";

/* 工作项**行内编辑**的两块呈现零件（阶段一轮 D）：就地失败原因 + 优先级 picker。

   为什么在这一个文件里（而不是塞回 `WorkItemsBoard.tsx`）：看板已经 323 个代码行，
   oxlint 的 max-lines 上限是 400 —— 编辑器全塞进去必然越线，越线之后只剩「加 disable」一条路
   （那是把上限变成摆设）。拆件只搬**呈现**：判据在 `workItemInlineEditViewModel`（纯函数），
   交互状态在 `useWorkItemInlineEdit`，零件在这里 —— 看板的 `renderRow` 仍是唯一的行渲染点。

   两个零件都不碰服务、不碰判据：picker 只把选中值交给调用方，失败行只把文案画出来。 */

/** 就地失败原因：文案 + 原始值（`{value}` 占位）；带细节时照页面提示的拼法一并显示（不吞错）。 */
export function WorkItemInlineEditFailureLine({ failure }: { failure: WorkItemInlineEditFailure }) {
  const { intl } = useZCodeIntl();
  const text = intl.formatMessage({ id: failure.messageId }, { value: failure.value });
  return (
    <p
      className="relative z-10 text-ui-xs text-destructive"
      data-testid="work-item-inline-edit-error"
    >
      {failure.detail === undefined ? text : `${text}：${failure.detail}`}
    </p>
  );
}

/**
 * 优先级 picker（点徽标即入口）：四档 + 「清除」。
 *
 * 触发器的内容由调用方给（有值时是轮 C 的徽标 —— 外观属于「行词汇」，只有看板那个「拥有者」
 * 能定义它，本文件不该自带第二份）；**未设置**时本组件自己画一枚中性占位 chip：不给入口就
 * 永远设不上这一档，而占位的外观类名**仍由调用方传入**（同一个理由：一份外观）。
 *
 * `null` 在领域里是「清回未设置」，UI 取值域里用哨兵值表示它
 * （@radix-ui 的 item 不接受空串：空串被它保留给 placeholder，传进去会直接抛）。
 */
export function WorkItemPriorityPicker({
  priority,
  busy,
  onPick,
  unsetClassName,
  children,
}: {
  /** 当前显示值（含**待写值**：失败时保留用户刚选的那一档，不静默回退）。 */
  priority: WorkItemPriorityKey | null;
  busy: boolean;
  onPick: (selectValue: string) => void;
  /** 未设置时占位 chip 的外观类名（由行词汇的拥有者传入 —— 一份外观）。 */
  unsetClassName: string;
  children: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Select
      value={workItemInlinePrioritySelectValue(priority)}
      onValueChange={onPick}
      disabled={busy}
    >
      <SelectTrigger
        size="xs"
        variant="ghost"
        data-testid="work-item-priority-picker"
        aria-label={intl.formatMessage({ id: "squad.workItems.priority" })}
        className="pointer-events-auto relative z-10 h-auto shrink-0 gap-0 rounded-sm border-0 p-0"
      >
        {priority === null ? (
          <span className={unsetClassName} data-testid="work-item-priority-unset">
            {intl.formatMessage({ id: "squad.workItems.priority.unset" })}
          </span>
        ) : (
          children
        )}
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={WORK_ITEM_PRIORITY_CLEAR_VALUE} data-testid="work-item-priority-clear">
          {intl.formatMessage({ id: "squad.workItems.priority.unset" })}
        </SelectItem>
        {WORK_ITEM_PRIORITY_KEYS.map((key) => (
          <SelectItem key={key} value={key}>
            {intl.formatMessage({ id: WORK_ITEM_PRIORITY_MESSAGE_IDS[key] })}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
