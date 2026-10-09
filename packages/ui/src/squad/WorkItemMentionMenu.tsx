import { useEffect, useRef } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { MentionOption } from "./workItemMentionViewModel.js";

/* B5.1 轮 1：`@` 补全菜单（设计案 §4.2）——`role="listbox"` 的紧凑候选表。

   本组件**只画**（候选来自 `buildMentionMenu` 的投影），选择/插入/关闭的编排在 composer：
   键盘 ↑↓ 用 `moveMentionSelection`（索引算术可测），Enter/Tab 插入、Escape 关闭。

   为什么用 `onMouseDown` 而不是 `onClick`：点候选时 textarea 会先失焦 ⇒ 菜单在 click 之前就被
   关闭，插入落空（经典竞态）。mousedown 早于 blur，先 `preventDefault` 保住焦点再插入。

   人类候选**不出现**：本轮不伪造人类名册（C3）；重名项可见但不可插入（`ambiguous`）。 */

export function WorkItemMentionMenu({
  options,
  selectedIndex,
  onSelect,
}: {
  options: MentionOption[];
  /** -1 = 没有选中项（空候选或刚打开）。 */
  selectedIndex: number;
  onSelect: (option: MentionOption) => void;
}) {
  const { intl } = useZCodeIntl();
  const listRef = useRef<HTMLUListElement | null>(null);

  // 键盘选择时把选中项滚进视野（列表可能比面板长）。
  useEffect(() => {
    const selected = listRef.current?.querySelector('[aria-selected="true"]');
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  return (
    <ul
      ref={listRef}
      role="listbox"
      data-testid="work-item-mention-menu"
      aria-label={intl.formatMessage({ id: "squad.workItemDetail.comment.placeholder" })}
      className="mt-1 max-h-56 overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-sm"
    >
      {options.map((option, index) => (
        <li key={option.key}>
          <div
            role="option"
            aria-selected={index === selectedIndex}
            aria-disabled={option.ambiguous}
            data-testid={`work-item-mention-option-${option.id}`}
            onMouseDown={(event) => {
              event.preventDefault();
              if (!option.ambiguous) onSelect(option);
            }}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-ui-sm",
              index === selectedIndex ? "bg-selected" : "hover:bg-hover",
              option.ambiguous && "cursor-not-allowed opacity-60",
            )}
          >
            {option.colorClass ? (
              <span aria-hidden className={cn("size-2 shrink-0 rounded-full", option.colorClass)} />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-foreground">{option.name}</span>
            <span className="shrink-0 text-ui-xs text-foreground-subtlest">
              {option.type === "agent"
                ? intl.formatMessage({ id: "squad.workItemDetail.comment.author.agent" })
                : option.type === "squad"
                  ? intl.formatMessage({ id: "squad.workItemDetail.comment.sourceRole.leader" })
                  : null}
            </span>
            {option.ambiguous ? (
              <span className="shrink-0 text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: "squad.workItemDetail.mention.ambiguous" })}
              </span>
            ) : null}
            {option.hintMessageId ? (
              <span className="shrink-0 text-ui-xs text-foreground-subtlest">
                {intl.formatMessage({ id: option.hintMessageId })}
              </span>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
