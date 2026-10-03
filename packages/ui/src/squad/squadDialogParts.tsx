import { useId, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Label } from "@/components/ui/label.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";

/* 三个创建 / 编辑表单（协作智能体 / 小队 / 工作项，都在 SquadCreateDialogs）**共用的外壳与原语**。

   为什么单拆一层：`SquadCreateDialogs.tsx` 收下工作项表单的「创建 / 编辑两用」泛化后越过了
   max-lines（400）的 lint 硬门槛 —— 把**与业务字段无关**的三件套（对话框壳、单控件字段、
   成组字段）机械拆到这里，表单本体仍全部留在原文件（B3 的落点不变，零行为变化）。
   这与仓内既有做法同款：单文件不越 400 行时优先拆"与语义无关的呈现层"。 */

/** 三个表单共用的外壳：标题 + 说明 + 提交/取消。 */
export function CreateDialogShell({
  titleId,
  submitLabelId,
  onSubmit,
  onClose,
  canSubmit,
  children,
}: {
  titleId: string;
  /** 提交按钮文案；省略即「创建」（编辑模式传「保存」——同一个表单不抄第二份）。 */
  submitLabelId?: string;
  onSubmit: () => void;
  onClose: () => void;
  canSubmit: boolean;
  children: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    onSubmit();
  };
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      {/* 圆角由 DialogContent 原语给出（rounded-2xl，spec §11.3 的对话框层级）。 */}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: titleId })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "squad.common.dialogHint" })}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="flex flex-col gap-3">{children}</div>
          <SettingsFormActions>
            <Button type="button" variant="outline" onClick={onClose}>
              {intl.formatMessage({ id: "squad.common.cancel" })}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {intl.formatMessage({ id: submitLabelId ?? "squad.common.submit" })}
            </Button>
          </SettingsFormActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 单控件字段：用 `htmlFor`/`id` 把标签与控件关联（house style：见 HookForm.tsx）。
    控件 id 由 `useId()` 生成，避免多个对话框里的字面量 id 撞车。 */
export function Field({
  labelId,
  children,
}: {
  labelId: string;
  children: (controlId: string) => ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const controlId = useId();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={controlId}>{intl.formatMessage({ id: labelId })}</Label>
      {children(controlId)}
    </div>
  );
}

/** 一组控件（多选队员）的字段：用 `role="group"` + `aria-labelledby` 关联组名，
    而不是让 `label` 的 `htmlFor` 指向一个不存在的控件。 */
export function FieldGroup({ labelId, children }: { labelId: string; children: ReactNode }) {
  const { intl } = useZCodeIntl();
  const groupId = useId();
  return (
    <div className="flex flex-col gap-1" role="group" aria-labelledby={groupId}>
      <span id={groupId} className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: labelId })}
      </span>
      {children}
    </div>
  );
}
