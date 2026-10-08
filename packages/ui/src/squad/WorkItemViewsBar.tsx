import { LayoutGrid } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { WORK_ITEM_VIEW_ANCHOR_ID, type WorkItemViewTab } from "./workItemViewsViewModel.js";

/* 工作项**视图条**（阶段二 · T-P2-R6b）：内建锚「全部」+ 保存视图**同一列**的标签 + [⧉] 菜单。

   形态取证（reports/2026-10-09-saved-views-multica-evidence.md §8）：一行横排标签 + 常驻 [⧉] 菜单
   （New view / Manage views）；内建锚与保存视图同一扁平列表，锚点**永不可隐藏**；当前打开的视图
   高亮（multica 用 promoted tab 保证它"永不消失"，ZPaPa v1 用一行可换行布局 —— 见下）。

   本组件**只投影 + 回传意图**：标签从哪来（`workItemViewTabs`）、点开是谁、管理面板开不开，
   全在页面与其状态机（`useWorkItemViews`）。组件里不出现任何服务调用、不持有状态 ——
   "视图条上的权限/次序"只有一处判据。

   已知差距（登记，不静默）：multica 的**溢出 more + 离屏测量镜像 + promoted tab** 与
   **标签拖拽排序（prefs {hidden, order}）** 本轮未做（验收项里没有它们，而它们的文案会超出
   破例键额）；这里用 `flex-wrap` 让标签换行显示，等效保证「当前打开的视图不会消失」。 */

export function WorkItemViewsBar({
  tabs,
  activeViewId,
  busy,
  disabled,
  onOpen,
  onNew,
  onManage,
}: {
  tabs: WorkItemViewTab[];
  /** 当前打开的标签（`null` = 内建锚）。 */
  activeViewId: string | null;
  /** 写动作在飞（建/改/删）：标签点击与菜单一律置灰，避免半程输入。 */
  busy: boolean;
  /** 没有可用读写面（无 workspace 目标）：入口**不消失**，只置灰（既有姿态）。 */
  disabled: boolean;
  onOpen: (viewId: string | null) => void;
  onNew: () => void;
  onManage: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  return (
    <div
      role="group"
      aria-label={t("squad.workItems.views.label")}
      className="flex flex-wrap items-center gap-1.5"
      data-testid="work-item-views-bar"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeViewId || (tab.builtin && activeViewId === null);
        return (
          <Button
            key={tab.id}
            type="button"
            size="sm"
            variant={active ? "secondary" : "ghost"}
            className="max-w-40 truncate"
            /* 当前打开的标签用 `aria-pressed` 表达"选中"：读屏听得出"这是我现在看的视图"，
               不靠颜色（DESIGN：状态不只用颜色编码）。 */
            aria-pressed={active}
            data-testid="work-item-view-tab"
            data-view-id={tab.id}
            data-active={active ? "true" : "false"}
            disabled={busy}
            onClick={() => onOpen(tab.id === WORK_ITEM_VIEW_ANCHOR_ID ? null : tab.id)}
          >
            {tab.nameId === null ? tab.name : t(tab.nameId)}
          </Button>
        );
      })}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t("squad.workItems.views.label")}
            data-testid="work-item-views-menu"
            disabled={busy || disabled}
          >
            <LayoutGrid aria-hidden className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem data-testid="work-item-view-new" onSelect={onNew}>
            {t("squad.workItems.views.new")}
          </DropdownMenuItem>
          <DropdownMenuItem data-testid="work-item-view-manage" onSelect={onManage}>
            {t("squad.workItems.views.manage")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
