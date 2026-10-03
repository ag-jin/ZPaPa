import type { InboxItem } from "@zcode/services";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import {
  INBOX_KIND_MESSAGE_IDS,
  INBOX_SEVERITY_BADGE_CLASSES,
  INBOX_SEVERITY_MESSAGE_IDS,
  inboxItemDetailLine,
  inboxRowActions,
} from "./inboxViewModel.js";

/* 「收件箱」页面的**纯呈现**列表（取数与动作都在 InboxPage）。

   与 SquadsList / SquadRunsReview 逐条同形（同一套骨架、同一套 testid 形态）：拆出来是为了
   两件事 —— ① 单文件不越 400 行；② 列表与动作解耦后，"哪些行给哪些按钮"的判据只在纯函数
   `inboxRowActions` 一处出现（本层只照它画），页面只负责调服务。

   一行的四层信息（severity / kind / title / 次要行）**各有其职**：
   · severity 徽标 = "多急"（**语义色 token**，见 INBOX_SEVERITY_BADGE_CLASSES）；
   · kind 文案 = "这是什么"（`member_failed` 是中性词「运行失败」—— 队长 run 共用同一失败出口）；
   · title = 事的主体（工作项标题，拿不到时是产生点回落的 id）；
   · 次要行 = 细节（分支 / reason / agentId，取不到的片段在纯函数里已跳过，这里不会渲染出
     `undefined`）+ **所属项目**（跨项目面：每行自己说清是哪个 workspace 的事）
     + **相对时间**（复用既有 `formatTaskRelativeTime`，与侧栏任务行同一套词）。

   **空态在这里**（空列表 + 两行说明）：空态不是"没有内容"，而是"这里该有什么"的那句话。
   「已归档可用开关查看」这句提示**只在列表为空且开关没开时**给 —— 开关开着还是空，说明
   连归档里也没有，再提一句"可以查看归档"就是废话。 */

const LIST_CLASSNAME = "flex flex-col gap-2";
/** 行容器：比所在卡片（rounded-xl）低一级（spec §11.3 的圆角层级）。 */
const ROW_CLASSNAME = "rounded-lg border border-border px-3 py-2";

export function InboxList({
  items,
  showArchived,
  busyItemId,
  onMarkRead,
  onArchive,
}: {
  items: InboxItem[];
  /** 「显示已归档」开关的当前值：只影响空态那句提示（数据面的过滤在服务侧）。 */
  showArchived: boolean;
  /** 有请求在飞的行 id（照 SquadsList 的 busySquadId 形态）：该行动作按钮全部禁用。 */
  busyItemId: string | null;
  onMarkRead: (item: InboxItem) => void;
  onArchive: (item: InboxItem) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });

  if (items.length === 0) {
    return (
      <div className="flex flex-col gap-1" data-testid="inbox-empty">
        <p className="text-ui-base text-foreground">{t("squad.inbox.empty")}</p>
        {/* 仅在列表为空且**未开**开关时给（理由见文件头注）。 */}
        {!showArchived ? (
          <p className="text-ui-sm text-foreground-subtlest">{t("squad.inbox.emptyHint")}</p>
        ) : null}
      </div>
    );
  }

  return (
    <ul className={LIST_CLASSNAME} data-testid="inbox-list">
      {items.map((item) => {
        const actions = inboxRowActions(item);
        const detailLine = inboxItemDetailLine(item);
        const busy = busyItemId === item.id;
        return (
          <li
            key={item.id}
            data-inbox-id={item.id}
            className={cn(ROW_CLASSNAME, "flex items-start justify-between gap-3")}
          >
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <Badge
                  variant="secondary"
                  className={INBOX_SEVERITY_BADGE_CLASSES[item.severity]}
                  data-testid="inbox-severity"
                >
                  {t(INBOX_SEVERITY_MESSAGE_IDS[item.severity])}
                </Badge>
                <span className="text-ui-xs text-foreground-subtle">
                  {t(INBOX_KIND_MESSAGE_IDS[item.kind])}
                </span>
                <span className="break-words text-ui-base text-foreground">{item.title}</span>
                {/* 已归档徽标复用既有键（形容词，不新造一份文案）。归档行只显示它 + 无动作。 */}
                {item.archivedAt !== null ? (
                  <span className="text-ui-xs text-foreground-subtlest">
                    {t("squad.common.archived")}
                  </span>
                ) : null}
              </span>
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-xs text-foreground-subtle">
                {/* 次要行：纯函数已把取不到的片段跳过；`null` = 一个片段都没有 ⇒ 整段不渲染。 */}
                {detailLine ? <span className="break-words">{detailLine}</span> : null}
                {/* 所属项目：跨项目面的"这是哪个 workspace 的事"。长路径截断显示，
                    全文放 title（悬停可读）—— 截断是呈现，事实不丢。 */}
                <span
                  className="max-w-96 truncate text-foreground-subtlest"
                  title={item.workspacePath}
                >
                  {item.workspacePath}
                </span>
                <span className="shrink-0 text-foreground-subtlest">
                  {formatTaskRelativeTime(item.createdAt, intl)}
                </span>
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {/* 未读且未归档 ⇒ 标已读；已读 / 已归档 ⇒ 不给（判据在共享的 inboxRowActions，
                  本层只照它画）。轻动作无二次确认（理由见 InboxPage 的文件头注）。 */}
              {actions.canMarkRead ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  data-testid="inbox-mark-read"
                  onClick={() => onMarkRead(item)}
                >
                  {t("squad.inbox.markRead")}
                </Button>
              ) : null}
              {/* 归档：无二次确认（有意为之，见 InboxPage）；文案是「归档」不是"删除"
                  —— 归档行仍能被「显示已归档」取回来。 */}
              {actions.canArchive ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  data-testid="inbox-archive"
                  onClick={() => onArchive(item)}
                >
                  {t("squad.inbox.archive")}
                </Button>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
