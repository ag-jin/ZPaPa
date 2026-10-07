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
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/* B5.2 轮 2：评论软删的**二次确认**（设计案 §3.3「删除」行）。

   为什么必须是模态确认：软删把正文替换成墓碑、子回复留在原地，**不可恢复**（设计案 §3.3
   明文「不承诺恢复」）。误触一次就换不回来，所以「先确认」是它的正确性要求，不是交互偏好。
   文案说清三件事（删什么、留什么、能不能恢复），而不是一句「确定吗」。

   为什么用 `AlertDialog` + `destructive`：与仓内既有的破坏性确认同一形态
   （`SquadDiscardDialog` / `StorageCleanConfirmDialog`）—— 焦点陷阱与 Esc 行为不必重新论证，
   「危险按钮长什么样」在仓里只有一种。

   本组件**不做任何执行**：只把「确认 / 取消」两个意图交回调用方；实际执行落在
   `WorkItemDetailPage` 的**唯一**动作执行点，且只有确认分支会产出可执行的 commentId
   （见视图模型的 `confirmCommentDelete`）。 */

export function WorkItemCommentDeleteDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  /** 正在执行：禁用两个按钮，避免「点两次确认」这种半程输入。 */
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  return (
    <AlertDialog open onOpenChange={(next) => (!next && !pending ? onCancel() : undefined)}>
      <AlertDialogContent data-testid="work-item-comment-delete-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("squad.workItemDetail.comment.deleteTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("squad.workItemDetail.comment.deleteDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending} onClick={onCancel}>
            {t("squad.common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(event) => {
              // 阻止 Radix 的默认关闭行为：关闭由调用方在执行完成之后决定（失败时要能看见失败）。
              event.preventDefault();
              onConfirm();
            }}
          >
            {t("squad.workItemDetail.comment.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
