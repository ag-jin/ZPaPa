import type { WorkItem } from "@zcode/shared";
import type { SquadSnapshot } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SUBAGENT_COLOR_CLASS, resolveSubagentColorFromName } from "@/lib/subagentColors.js";
import { resolveAssigneeName } from "./squadEntryViewModel.js";
import { flattenWorkItemBoard, workItemStatusMessageId } from "./workItemsViewModel.js";

/* 「工作项」页面的**纯呈现**看板（取数与动作都在 WorkItemsPage）。

   拆出来是为了两件事（与 SquadAgentsList / SquadsList 同款）：① 单文件不越 400 行；
   ② 列表与动作解耦后，「哪些行给哪些按钮」与「树怎么压平」只在共享纯函数里出现
   （`flattenWorkItemBoard` / `squadDiscardableWorkItemIds`），本层只照结论画。

   **空态在这里**（空看板 + 引导）：空态不是"没有内容"，而是"这里该有什么、怎么开始"
   的那句话，与列表是同一条渲染分支，分开写会漂移。

   缩进沿用 `WikiCatalogTree` 的既有手法（`paddingLeft: depth * 12 + 8` px）：深度由纯函数
   算好，本层只负责按它缩进 —— 组件里递归 = 不可测。 */

const LIST_CLASSNAME = "flex flex-col gap-2";
/** 行容器：比所在卡片（rounded-xl）低一级（spec §11.3 的圆角层级）。 */
const ROW_CLASSNAME = "rounded-lg border border-border px-3 py-2";

/**
 * 指派人前面的圆点（**只表达身份，不编码状态**，spec §11.3）：
 * · 智能体 ⇒ 实心点，用它自带的 `color`；未设色时按名字稳定取一个（照 SquadAgentsList）；
 * · 小队 ⇒ **没有 `color` 字段**（实体如此），用一个中性空心圆环（`border`，非九色板）——
 *   与智能体的实心点只差"型别"，不差"状态"；不替它编一个颜色（编出来的颜色是假的）；
 * · 用户 ⇒ 不画点（"我"由本地化文案表达，不需要身份色）。
 */
function AssigneeMarker({
  snapshot,
  assignee,
}: {
  snapshot: SquadSnapshot;
  assignee: WorkItem["assignee"];
}) {
  if (assignee.type === "user") return null;
  if (assignee.type === "agent") {
    const agent = snapshot.teamAgents.find((entry) => entry.id === assignee.id);
    return (
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          SUBAGENT_COLOR_CLASS[
            agent?.color ?? resolveSubagentColorFromName(agent?.name ?? assignee.id)
          ],
        )}
        aria-hidden
      />
    );
  }
  return (
    <span className="size-2 shrink-0 rounded-full border border-foreground-subtlest" aria-hidden />
  );
}

export function WorkItemsBoard({
  workItems,
  snapshot,
  discardableIds,
  busyWorkItemId,
  onEdit,
  onDiscard,
}: {
  workItems: WorkItem[];
  snapshot: SquadSnapshot;
  /** 「放弃整批」入口出现的工作项（判据见 `squadDiscardableWorkItemIds`：只有**破坏性**动作才需要判据）。 */
  discardableIds: ReadonlySet<string>;
  busyWorkItemId: string | null;
  onEdit: (item: WorkItem) => void;
  /** 点「放弃整批」⇒ **只进入待确认态**（本层拿不到服务，结构上不可能直接执行）。 */
  onDiscard: (workItemId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });

  if (workItems.length === 0) {
    return (
      <div className="flex flex-col gap-1" data-testid="work-items-empty">
        <p className="text-ui-base text-foreground">{t("squad.workItems.empty")}</p>
        <p className="text-ui-sm text-foreground-subtlest">{t("squad.workItems.emptyHint")}</p>
      </div>
    );
  }

  return (
    <ul className={LIST_CLASSNAME} data-testid="work-items-list">
      {flattenWorkItemBoard(workItems).map(({ item, depth }) => {
        const assigneeName = resolveAssigneeName(snapshot, item.assignee);
        const busy = busyWorkItemId === item.id;
        return (
          <li
            key={item.id}
            data-work-item-id={item.id}
            data-depth={depth}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
            className={cn(ROW_CLASSNAME, "flex items-center justify-between gap-3")}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="break-words text-ui-base text-foreground">{item.title}</span>
              {/* 状态徽标：六态各自文案（`WORK_ITEM_STATUS_MESSAGE_IDS` 强制穷尽）。 */}
              <span className="shrink-0 text-ui-xs text-foreground-subtle">
                {t(workItemStatusMessageId(item.status))}
              </span>
              <span className="flex shrink-0 items-center gap-1.5 text-ui-xs text-foreground-subtle">
                <AssigneeMarker snapshot={snapshot} assignee={item.assignee} />
                {/* `null` = 指派给当前用户；由这里的本地化文案补上，纯函数不碰 i18n。 */}
                {assigneeName ?? t("squad.common.assignee.user")}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                data-testid="work-item-edit"
                onClick={() => onEdit(item)}
              >
                {t("squad.common.edit")}
              </Button>
              {/* 放弃整批：只给判据（纯函数）认下的行；点它**只进入待确认态**。 */}
              {discardableIds.has(item.id) ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  data-testid="work-item-discard"
                  onClick={() => onDiscard(item.id)}
                >
                  {t("squad.discard.action")}
                </Button>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
