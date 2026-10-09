import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import type { WorkItemReactionGroup } from "./workItemReactionsViewModel.js";

/* 工作项回应的**聚合 chip 组**（阶段三 · T-P3-R5u；纯呈现，两态：

   · **只读**（`onToggle` 缺席）= peek 的形态 —— 结构上零按钮、零 `aria-pressed`：面板里没有
     任何写入入口（peek 零写纪律，由 `workItemPeek.test.ts` 的禁用词表守着）。
   · **可点**（`onToggle` 给出）= 详情页固定行的形态 —— 每枚 chip 是按钮，`aria-pressed` 只在
     「我」**可判定**时给出（`reactedByMe === null` 时不给：不假装「不是我」，评论回应同款），
     在途（`pendingEmoji`）只禁用那一枚（其余照常可点 —— 整组冻结会让人以为界面卡了）。

   chip 的内容就是取证报告 §1 Q3 的两件：**emoji + count**，全量平铺、不折叠、不截断、
   顺序 = 传入的分组次序（= 行插入序）。「谁反应了」（名字列表）v1 不做（hover/长按名单
   登记为已知差距），故 chip 的可及名称只带 emoji 与计数。

   品牌色只标**可判定的**「我」（`text-brand` + 淡底 + 品牌描边，照 DESIGN 的 brand 用法：
   稀疏、只做强调，不做整面填充）。 */

const CHIP_CLASSNAME =
  "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-ui-sm leading-none";

export function WorkItemReactionChips({
  groups,
  onToggle,
  pendingEmoji = null,
}: {
  /** 聚合分组（次序即呈现次序；不折叠 —— 折叠是「数不全」的另一种说法）。 */
  groups: WorkItemReactionGroup[];
  /** 点某一枚 chip：给出 = 可点（详情页）；缺席 = 只读（peek）。 */
  onToggle?: (emoji: string) => void;
  /** 在途的那一枚（禁用；其余照常可点）。 */
  pendingEmoji?: string | null;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  return (
    <span data-testid="work-item-reaction-chips" className="flex flex-wrap items-center gap-1">
      {groups.map((group) => {
        const label = t("squad.workItemDetail.reactions.chip", {
          emoji: group.emoji,
          count: group.count,
        });
        const mine = group.reactedByMe === true;
        const className = cn(
          CHIP_CLASSNAME,
          mine ? "border-brand/30 bg-brand/10 text-brand" : "border-border text-foreground-subtle",
          onToggle !== undefined && group.reactedByMe === null && "border-dashed",
        );
        const content = (
          <>
            <span aria-hidden>{group.emoji}</span>
            <span className="tabular-nums">{group.count}</span>
          </>
        );
        return onToggle === undefined ? (
          <span
            key={group.emoji}
            data-testid={`work-item-reaction-chip-${group.emoji}`}
            aria-label={label}
            className={className}
          >
            {content}
          </span>
        ) : (
          <button
            key={group.emoji}
            type="button"
            data-testid={`work-item-reaction-chip-${group.emoji}`}
            aria-label={label}
            /* 身份不可判定 ⇒ 不给 pressed 状态（`null` 不是 `false`）。 */
            {...(group.reactedByMe === null ? {} : { "aria-pressed": mine })}
            disabled={pendingEmoji === group.emoji}
            onClick={() => onToggle(group.emoji)}
            className={cn(className, "enabled:hover:border-border-hover")}
          >
            {content}
          </button>
        );
      })}
    </span>
  );
}
