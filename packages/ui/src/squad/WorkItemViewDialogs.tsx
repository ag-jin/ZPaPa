import { useId, useState } from "react";
import type { WorkItemViewRecord } from "@zcode/services";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Field } from "./squadDialogParts.js";
import type { WorkItemViewFormSubmit, WorkItemViewsController } from "./useWorkItemViews.js";
import {
  workItemViewDialogProjection,
  workItemViewNameSubmitValue,
  type WorkItemViewManageRow,
  type WorkItemViewSummaryEntry,
} from "./workItemViewsViewModel.js";

/* 保存视图的三个对话框（阶段二 · T-P2-R6b）：表单（新建 / 编辑）、删除确认、管理面板。

   形态取证（reports/2026-10-09-saved-views-multica-evidence.md §8）：新建/编辑是**对话框非 inline**
   （名称 + 可见性 + "这一份定义说的是什么"的摘要 + Cancel/Create(Update)）；删除要**说清后果**
   （只删视图、不删工作项）；管理面板列出可见视图并给出行内编辑/删除。

   三条纪律（与域内既有对话框同款）：① 组件**不执行任何服务调用**（提交把整份意图交回页面）；
   ② 权限的**判据**不在这里（`row.canManage` 来自纯函数，本层只投影三态）；③ 禁用必须**说得出原因**
   （名字为空 / 不可管理的编辑钮都带 `title`）。 */

/** 摘要行的取值分隔符：语言中立（与 `workItemSurfaceTwinControlLabel` 同一条理由 —— en 文案不用全角标点）。 */
const SUMMARY_VALUE_SEPARATOR = " · ";

export function WorkItemViewFormDialog({
  titleId,
  initialName,
  initialShared,
  visibilityLocked,
  summary,
  pending,
  onClose,
  onSubmit,
}: {
  /** 对话框标题：新建（`views.new`）或另存为（`views.saveAs`）或编辑（`views.edit`）。 */
  titleId: string;
  /** `my` 档只读视图的名字（新建时为空串）。 */
  initialName: string;
  initialShared: boolean;
  /** 可见性控件**锁死**（`my` 档恒私有 ⇒ 整个控件不渲染；见 `workItemViewVisibilityLocked`）。 */
  visibilityLocked: boolean;
  summary: WorkItemViewSummaryEntry[];
  pending: boolean;
  onClose: () => void;
  onSubmit: (submit: WorkItemViewFormSubmit) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const sharedControlId = useId();
  const [name, setName] = useState(initialName);
  const [shared, setShared] = useState(initialShared);
  const submitName = workItemViewNameSubmitValue(name);
  const canSubmit = submitName !== null && !pending;
  return (
    <Dialog open onOpenChange={(next) => (next || pending ? undefined : onClose())}>
      <DialogContent data-testid="work-item-view-form-dialog">
        <DialogHeader>
          <DialogTitle>{t(titleId)}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmit) return;
            onSubmit({ name: submitName, shared });
          }}
        >
          <div className="flex flex-col gap-3">
            <Field labelId="squad.common.name">
              {(controlId) => (
                <Input
                  id={controlId}
                  data-testid="work-item-view-name"
                  autoFocus
                  value={name}
                  placeholder={t("squad.workItems.views.namePlaceholder")}
                  onChange={(event) => setName(event.target.value)}
                />
              )}
            </Field>
            {visibilityLocked ? null : (
              <div className="flex items-center gap-2">
                <Checkbox
                  id={sharedControlId}
                  data-testid="work-item-view-shared"
                  checked={shared}
                  onCheckedChange={(next) => setShared(next === true)}
                />
                <Label htmlFor={sharedControlId}>{t("squad.workItems.views.shared")}</Label>
              </div>
            )}
            {/* 摘要："我要存的是什么" —— 逐行取自同一套闭集词汇（不抄第二份）。 */}
            <dl className="flex flex-col gap-1" data-testid="work-item-view-summary">
              {summary.map((entry) => (
                <div key={entry.labelId} className="flex gap-2 text-ui-xs">
                  <dt className="shrink-0 text-foreground-subtle">{t(entry.labelId)}</dt>
                  <dd className="text-foreground">
                    {entry.valueIds.map((valueId) => t(valueId)).join(SUMMARY_VALUE_SEPARATOR)}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
                {t("squad.common.cancel")}
              </Button>
              <Button
                type="submit"
                className="ml-auto"
                disabled={!canSubmit}
                data-testid="work-item-view-submit"
              >
                {t("squad.workItems.views.save")}
              </Button>
            </div>
            {/* 禁用理由必须**说得出**：名字为空/超长（与服务面同一把尺子）时说清是哪一种。 */}
            <p
              className="text-ui-xs text-foreground-subtlest"
              data-testid="work-item-view-submit-reason"
            >
              {submitName === null ? t("squad.workItems.views.namePlaceholder") : ""}
            </p>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function WorkItemViewDeleteDialog({
  view,
  pending,
  onCancel,
  onConfirm,
}: {
  view: WorkItemViewRecord;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <AlertDialog open onOpenChange={(next) => (!next && !pending ? onCancel() : undefined)}>
      <AlertDialogContent data-testid="work-item-view-delete-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {intl.formatMessage(
              { id: "squad.workItems.views.deleteConfirmTitle" },
              { name: view.name },
            )}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {intl.formatMessage({ id: "squad.workItems.views.deleteConfirmBody" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending} onClick={onCancel}>
            {intl.formatMessage({ id: "squad.common.cancel" })}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            data-testid="work-item-view-delete-confirm"
            onClick={(event) => {
              // 关闭由调用方在**执行完成**后决定（失败时要能看见失败）。
              event.preventDefault();
              onConfirm();
            }}
          >
            {intl.formatMessage({ id: "squad.workItems.views.delete" })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function WorkItemViewsManageDialog({
  rows,
  pending,
  onClose,
  onEdit,
  onDelete,
  onSaveAs,
}: {
  rows: WorkItemViewManageRow[];
  pending: boolean;
  onClose: () => void;
  onEdit: (view: WorkItemViewRecord) => void;
  onDelete: (view: WorkItemViewRecord) => void;
  /** 另存为：把这一条的定义复制成一条新视图（非 owner 也能用 —— multica 的 Save as 入口）。 */
  onSaveAs: (view: WorkItemViewRecord) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  return (
    <Dialog open onOpenChange={(next) => (next || pending ? undefined : onClose())}>
      <DialogContent data-testid="work-item-view-manage-dialog">
        <DialogHeader>
          <DialogTitle>{t("squad.workItems.views.manage")}</DialogTitle>
        </DialogHeader>
        <ul className="flex flex-col" data-testid="work-item-view-manage-list">
          {rows.map((row) => (
            <li
              key={row.view.id}
              data-view-id={row.view.id}
              data-testid="work-item-view-manage-row"
              className="flex items-center gap-2 border-b border-border py-1.5 last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate text-ui-base text-foreground">
                {row.tab.name}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending || row.canManage === false}
                aria-disabled={row.canManage === false}
                data-testid="work-item-view-manage-edit"
                onClick={() => onEdit(row.view)}
              >
                {t("squad.workItems.views.edit")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending}
                data-testid="work-item-view-manage-save-as"
                onClick={() => onSaveAs(row.view)}
              >
                {t("squad.workItems.views.saveAs")}
              </Button>
              {/* 删除**不渲染**（不是置灰）：multica 同款 —— 一个永远点不动的删除钮只会被读成故障。 */}
              {row.canManage === false ? null : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  data-testid="work-item-view-manage-delete"
                  onClick={() => onDelete(row.view)}
                >
                  {t("squad.workItems.views.delete")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 页面的**保存视图对话框装配区**（照 `WorkItemsPageDialogs` 的先例）：只投影状态机已经拥有的
 * 状态、把用户意图原样回传 —— 本组件不读 store、不解析 target、不执行任何服务调用。
 *
 * 三个对话框的标题/初值全部由状态机那份 `dialog` 推导（不在页面里再判一遍该显示哪个标题）。
 */
export function WorkItemViewDialogs({ controller }: { controller: WorkItemViewsController }) {
  const { dialog, summary, busy, manageOpen, manageRows, deleteTarget } = controller;
  if (deleteTarget !== null) {
    return (
      <WorkItemViewDeleteDialog
        view={deleteTarget}
        pending={busy}
        onCancel={controller.cancelDelete}
        onConfirm={() => void controller.runDelete()}
      />
    );
  }
  if (dialog !== null) {
    const projection = workItemViewDialogProjection(dialog);
    return (
      <WorkItemViewFormDialog
        /* 标题 / 名字初值 / 可见性初值与锁死全部来自纯函数的投影（组件不判一遍）。 */
        titleId={projection.titleId}
        initialName={projection.initialName}
        initialShared={projection.initialShared}
        visibilityLocked={projection.visibilityLocked}
        summary={summary}
        pending={busy}
        onClose={controller.closeDialog}
        onSubmit={(submit) => void controller.submitDialog(submit)}
      />
    );
  }
  if (!manageOpen) return null;
  return (
    <WorkItemViewsManageDialog
      rows={manageRows}
      pending={busy}
      onClose={controller.closeManage}
      onEdit={controller.openEditDialog}
      onDelete={controller.confirmDelete}
      onSaveAs={(view) => controller.openCreateDialog(view.id)}
    />
  );
}
