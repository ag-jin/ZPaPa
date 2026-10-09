import type { WorkItem } from "@zcode/shared";
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

/* 「放弃整批」的**二次确认**（spec §6.3「整批可整体放弃」）。

   为什么它必须是**模态确认**而不是「点一下就走」：这个动作**破坏且不可撤销** —— 删掉这一批的
   队员分支与集成分支、清掉它们的工作树，并把父项判为放弃。误触一次就换不回来任何东西，
   所以「先确认」是它的**正确性**要求。确认文案必须**说清后果**（删什么、留什么、之后会怎样），
   而不是一句「确定吗」——用户要能在按下之前判断这件事该不该做。

   为什么用 `AlertDialog`（既有原语）而不是新造一个：仓内破坏性确认已有先例
   （`StorageCleanConfirmDialog` / `PluginUninstallConfirmDialog`），沿用同一形态与同一个 `destructive`
   变体，既不用重新论证焦点陷阱与 Esc 行为，也让「危险按钮长什么样」在仓里只有一种。

   本组件**不做任何执行**：只把「确认 / 取消」这两个意图原样交回调用方（`onConfirm` / `onCancel`）。
   执行落在 `executeSquadDiscard`，而它只接受 `confirmSquadDiscard` 产出的目标 —— 见视图模型里的说明。 */

export function SquadDiscardDialog({
  workItem,
  pending,
  onCancel,
  onConfirm,
}: {
  workItem: WorkItem;
  /** 正在执行：禁用两个按钮，避免「点两次确认」这种半程输入。 */
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <AlertDialog open onOpenChange={(next) => (!next && !pending ? onCancel() : undefined)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {intl.formatMessage({ id: "squad.discard.title" }, { title: workItem.title })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {intl.formatMessage({ id: "squad.discard.description" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending} onClick={onCancel}>
            {intl.formatMessage({ id: "squad.common.cancel" })}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(event) => {
              // 阻止 Radix 的默认关闭行为：关闭由调用方在**执行完成**后决定（失败时要能看见失败）。
              event.preventDefault();
              onConfirm();
            }}
          >
            {intl.formatMessage({ id: "squad.discard.confirm" })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
