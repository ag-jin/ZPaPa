import { Folder, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  workItemSurfaceProjectFilterActive,
  type WorkItemSurfaceFilter,
  type WorkItemSurfaceIntent,
} from "./workItemSurfaceViewModel.js";
import {
  workItemProjectFilterOptions,
  workItemProjectText,
  type WorkItemProjectOption,
} from "./workItemProjectViewModel.js";

/* 动作行里的**项目过滤**（R-P2 项目绑定 · UI 轮；语义真源 multica A4：
   `issues-header.tsx:505-580` 的 Project 子菜单 + `view-store.ts:247-256` 的
   `projectFilters: string[]` + `includeNoProject: boolean`）。

   三条口径：
   ① **多选 + 独立的「无项目」开关**（不是单选、不是「一次只看一个项目」的 tab）；
      「无项目」不是一个项目，故不是一个 id，而是它自己那一枚 checkbox；
   ② **控件只回传意图**（与状态/优先级/视图/分组同一条纪律）：状态怎么变只有
      `applyWorkItemSurfaceIntent` 一处实现 —— 两处各写一遍 setState，迟早让「清除筛选」
      漏掉这一维（漏掉的表现是界面看着清了、结果里还在筛）；
   ③ **过滤态 chips 回显**：勾了哪些项目就在控件旁显示可移除的 chip（点 = 同一枚 toggle 意图，
      与菜单里取消勾选是同一个动作的两条路径）—— 多选控件的可读性靠它，不然「现在筛着什么」
      只有展开菜单才看得见。清单还没读到（`projects === null`）时 chip 回落 id（有事实说不出名字
      时不编名字，也不假装没筛）。

   清单渲染不显示计数：动作行拿不到工作项行集（计数要第二份投影 = 第二个真相源），
   而「筛了几条」由过滤后的行集自己说。 */

/** chip 的**中性**外观（与行上的项目 chip 同一套 token：项目是分类、不编码状态）。 */
const PROJECT_FILTER_CHIP_CLASSNAME =
  "inline-flex items-center gap-1 rounded-sm bg-surface px-1.5 py-0.5 text-ui-xs text-foreground-subtle hover:bg-hover";

export function WorkItemProjectFilter({
  filter,
  projects,
  disabled,
  title,
  locked,
  onIntent,
}: {
  /** 当前过滤状态（页面持有；本组件只读）。 */
  filter: WorkItemSurfaceFilter;
  /** 项目清单（`null` = 还没读到 ⇒ 只给「无项目」这一档 —— 不假装清单是空的）。 */
  projects: readonly WorkItemProjectOption[] | null;
  disabled: boolean;
  /** 置灰原因（与另两维共用同一份判据的结论）。 */
  title?: string;
  /** 视图固定了项目维（`baseline.locked.project`）⇒ 控件锁定（与另两维同款）。 */
  locked?: boolean;
  onIntent: (intent: WorkItemSurfaceIntent) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const options = projects ?? [];
  const active = workItemSurfaceProjectFilterActive(filter);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || locked === true}
            title={title}
            aria-label={t("squad.workItems.project")}
            data-testid="work-items-project-filter"
          >
            <Folder aria-hidden className="size-3.5" />
            {t("squad.workItems.project")}
            {/* 「这一维生效了」的可见回显（chips 才是细节；触发器上只给一个「有筛选」的记号）。 */}
            {active ? (
              <X aria-hidden className="size-3" data-testid="work-items-project-filter-active" />
            ) : null}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {/* 选项清单从**纯函数**来（「无项目」恒第一 + 每项目一项；清单缺席 ⇒ 只有「无项目」）。
              第一枚「无项目」是这一维最常用的一档（存量行都没有项目），与 multica `:549-566` 同位。 */}
          {workItemProjectFilterOptions(projects).map((option) =>
            option.kind === "none" ? (
              <DropdownMenuCheckboxItem
                key="none"
                checked={filter.includeNoProject}
                data-testid="work-items-project-option-none"
                onSelect={() => onIntent({ kind: "toggleNoProjectFilter" })}
              >
                {t("squad.workItems.project.none")}
              </DropdownMenuCheckboxItem>
            ) : (
              <DropdownMenuCheckboxItem
                key={option.id}
                checked={filter.projectIds.includes(option.id)}
                data-testid={`work-items-project-option-${option.id}`}
                onSelect={() => onIntent({ kind: "toggleProjectFilter", projectId: option.id })}
              >
                {option.name}
              </DropdownMenuCheckboxItem>
            ),
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* 过滤态 chips（回显 + 一键移除）：与菜单里的取消勾选是**同一个意图**。 */}
      {[...filter.projectIds].map((projectId) => (
        <button
          key={projectId}
          type="button"
          data-testid="work-items-project-filter-chip"
          disabled={disabled || locked === true}
          onClick={() => onIntent({ kind: "toggleProjectFilter", projectId })}
          className={PROJECT_FILTER_CHIP_CLASSNAME}
        >
          {workItemProjectText({ projectId, projects: options })}
          <X aria-hidden className="size-3" />
        </button>
      ))}
      {filter.includeNoProject ? (
        <button
          type="button"
          data-testid="work-items-project-filter-chip-none"
          disabled={disabled || locked === true}
          onClick={() => onIntent({ kind: "toggleNoProjectFilter" })}
          className={PROJECT_FILTER_CHIP_CLASSNAME}
        >
          {t("squad.workItems.project.none")}
          <X aria-hidden className="size-3" />
        </button>
      ) : null}
    </>
  );
}
