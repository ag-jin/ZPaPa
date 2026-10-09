import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Spinner } from "@/components/ui/spinner.js";
import { WorkItemBulkToolbar, type WorkItemBulkToolbarInput } from "./WorkItemBulkToolbar.js";
import { WorkItemProjectFilter } from "./WorkItemProjectFilter.js";
import type { WorkItemProjectsHandle } from "./useWorkItemProjects.js";
import {
  WORK_ITEM_SURFACE_SEARCH_DEBOUNCE_MS,
  resolveWorkItemSurfaceSearchKeyIntent,
  workItemSurfaceControlsDisabledReason,
  workItemSurfaceSearchDraftFollows,
  workItemSurfaceTwinControlLabel,
} from "./workItemSurfaceControlsViewModel.js";
import {
  WORK_ITEM_PRIORITY_FILTER_MESSAGE_IDS,
  WORK_ITEM_PRIORITY_FILTER_VALUES,
  WORK_ITEM_SORT_DIRECTIONS,
  WORK_ITEM_SORT_DIRECTION_MESSAGE_IDS,
  WORK_ITEM_SORT_MESSAGE_IDS,
  WORK_ITEM_STATUS_FILTER_MESSAGE_IDS,
  WORK_ITEM_STATUS_FILTER_VALUES,
  WORK_ITEM_VIEW_MODES,
  WORK_ITEM_VIEW_MODE_MESSAGE_IDS,
  workItemSurfaceHasActiveQuery,
  workItemSurfaceSearchText,
  type WorkItemPriorityFilterValue,
  type WorkItemSortDirection,
  type WorkItemSortKey,
  type WorkItemStatusFilterValue,
  type WorkItemSurfaceIntent,
  type WorkItemSurfaceState,
  type WorkItemViewMode,
} from "./workItemSurfaceViewModel.js";
import {
  WORK_ITEM_LANE_DIMENSION_MESSAGE_IDS,
  type WorkItemLaneDimension,
} from "./workItemsViewModel.js";
import {
  workItemSortKeysForLaneDimension,
  workItemViewHasIncrement,
  type WorkItemViewBaseline,
} from "./workItemViewsViewModel.js";

/** Persistent page actions. Visibility is independent of snapshot readiness. */
export function WorkItemsPageActions({
  targetAvailable,
  loading,
  createDisabled,
  laneDimension,
  onLaneDimensionChange,
  surface,
  onSurfaceIntent,
  baseline = null,
  workItemProjects,
  bulk,
  t,
  onReload,
  onCreate,
}: {
  targetAvailable: boolean;
  loading: boolean;
  createDisabled: boolean;
  /** 看板分组维度（会话内状态；页面拥有，本组件只投影与回传意图）。 */
  laneDimension: WorkItemLaneDimension;
  onLaneDimensionChange: (dimension: WorkItemLaneDimension) => void;
  /** Surface 状态（会话内状态；页面拥有）——本组件只**投影**它、只**回传意图**。
      控件带（视图切换 + 过滤 + 搜索 + 排序 + 列配置）由 T-P2-R4 在本组件同一处扩展：
      宿主与页面因此不是并行作业的写入点（阶段二 §6.3 串行点纪律）。 */
  surface: WorkItemSurfaceState;
  onSurfaceIntent: (intent: WorkItemSurfaceIntent) => void;
  /** 保存视图的基准态（T-P2-R6b）：固定值锁定 + 「清除筛选」回视图条件。
      **可选**：缺省 = 没有打开视图（内建锚）⇒ 逐格走 R1 的既有行为 —— 既有调用方（测试与
      将来的其它宿主）不必为了"没有视图"多传一个 `null`。 */
  baseline?: WorkItemViewBaseline | null;
  /** 项目清单与内联新建的**唯一 handle**（页面经接线层注入；缺省 ⇒ 项目过滤只给「无项目」这一档
      —— 与拾取器/看板同一份清单，第二个通道 = 两处迟早说的不是一件事）。本组件只用它的 `.projects`。 */
  workItemProjects?: WorkItemProjectsHandle;
  /** 批量工具栏（T-P2-R5）：状态与草稿都在页面（本组件只**挂载**它，并把手里那份置灰原因
      传下去 —— 「取数不可用 = 置灰 + 原因」只有 `workItemSurfaceControlsDisabledReason` 一份判据）。 */
  bulk: WorkItemBulkToolbarInput;
  t: (id: string) => string;
  onReload: () => void;
  onCreate: () => void;
}) {
  /* ---------- 本地搜索：本地草稿 + 防抖提交（判据在 workItemSurfaceControlsViewModel） ----------

     为什么要有草稿：输入框如果把 `surface.search` 直接绑成 value，那么每次敲字都得**立刻**
     提交（否则框里显示不出新字），而立即提交 = 每敲一个字重跑一次宿主的三视图投影 ——
     长名册上肉眼可见地卡。草稿进、防抖出，两者都由纯判据管口径（延迟常量 + 回声判别）。 */
  const [searchDraft, setSearchDraft] = useState(surface.search);
  /** 上次**提交出去**的值：用来区分「权威值是我的回声」与「权威值被别处改了」。 */
  const lastEmittedSearchRef = useRef(surface.search);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 输入法组合态：中文输入法的 Enter 是候选确认，不是提交（照行内编辑的既有做法）。 */
  const composingRef = useRef(false);

  const cancelPendingSearch = useCallback(() => {
    if (searchTimerRef.current === null) return;
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = null;
  }, []);

  /** 立刻提交（Enter / 清除）：先撤掉待触发的定时器 —— 用户要的是"现在就是这个结果"。 */
  const commitSearch = useCallback(
    (value: string) => {
      cancelPendingSearch();
      lastEmittedSearchRef.current = value;
      onSurfaceIntent({ kind: "setSearch", search: value });
    },
    [cancelPendingSearch, onSurfaceIntent],
  );

  /** 敲字：草稿先落（输入框立刻有反馈），提交排进防抖窗口。 */
  const scheduleSearch = useCallback(
    (value: string) => {
      cancelPendingSearch();
      searchTimerRef.current = setTimeout(() => {
        searchTimerRef.current = null;
        lastEmittedSearchRef.current = value;
        onSurfaceIntent({ kind: "setSearch", search: value });
      }, WORK_ITEM_SURFACE_SEARCH_DEBOUNCE_MS);
    },
    [cancelPendingSearch, onSurfaceIntent],
  );

  /* 权威值被**别处**改了（「清除筛选」/ Esc / R6 的命名视图还原）⇒ 草稿跟随。
     跟随的时候必须**一并撤掉待触发的定时器**：否则那个草稿会在防抖窗口结束后把用户刚清掉的
     查询又写回去（界面看着清空了，200ms 后自己长回来）。 */
  useEffect(() => {
    if (
      !workItemSurfaceSearchDraftFollows({
        authoritative: surface.search,
        lastEmitted: lastEmittedSearchRef.current,
      })
    ) {
      return;
    }
    lastEmittedSearchRef.current = surface.search;
    cancelPendingSearch();
    setSearchDraft(surface.search);
  }, [surface.search, cancelPendingSearch]);

  /** 卸载时清定时器：组件没了还给父级写意图 = 对已卸载的页面改状态。 */
  useEffect(() => cancelPendingSearch, [cancelPendingSearch]);

  /** 「清除」只在真有可清的文本时出现（只空格 = 不是生效查询，与 `hasActiveQuery` 同一条口径）。 */
  const searchClearVisible = workItemSurfaceSearchText(searchDraft).length > 0;

  /* 保存视图（T-P2-R6b）的两处投影，判据全在纯函数里：
     · 固定值锁定：视图真的约束了某一维 ⇒ 该维下拉**勾选且禁用**（multica baseline 同款）；
     · 「清除筛选」的可点性：有视图时问"相对视图有没有增量"（视图固定值不是增量 ——
       打开一个视图就让清除钮常亮，用户点了什么也不会变）。 */
  const lockedStatus = baseline?.locked.statusCategory === true;
  const lockedPriority = baseline?.locked.priority === true;
  /* R-P2：项目维的锁定与另两维同款（视图固定了项目条件 ⇒ 控件锁定）。 */
  const lockedProject = baseline?.locked.project === true;
  const clearEnabled =
    baseline === null
      ? workItemSurfaceHasActiveQuery(surface)
      : workItemViewHasIncrement(surface, baseline);

  /* 取数不可用时：控件**不消失**，只是置灰 + 给出原因（与刷新 / 新建同一条姿态）。
     判据在纯函数里；组件只把结论投影到每个控件上。视图切换与分组**不在**这个范围里：
     它们是纯视图设置（不需要读到数据），置灰范围只覆盖「需要数据的控件」。 */
  const controlsDisabledReason = workItemSurfaceControlsDisabledReason({
    targetAvailable,
    dataUnavailable: createDisabled,
    loading,
  });
  const controlsDisabled = controlsDisabledReason !== null;
  const disabledTitle = controlsDisabledReason === null ? undefined : t(controlsDisabledReason);

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {/* 视图切换（阶段二）：常驻在动作行（与刷新 / 新建同排）—— 它不是"设置"，而是当前视图的
          一部分；默认 = 看板（既有用户看到的界面零变化）。控件只回传意图，判据在纯函数里。 */}
      <Select
        value={surface.view}
        onValueChange={(value) =>
          onSurfaceIntent({ kind: "setView", view: value as WorkItemViewMode })
        }
      >
        <SelectTrigger
          size="sm"
          aria-label={t("squad.workItems.view.label")}
          data-testid="work-items-view-mode"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {WORK_ITEM_VIEW_MODES.map((view) => (
            <SelectItem key={view} value={view}>
              {t(WORK_ITEM_VIEW_MODE_MESSAGE_IDS[view])}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* 过滤 facet（T-P2-R4）：两个下拉同属「筛选」一组（组名给它俩，读屏听到的是
          「筛选 组 → 状态 / 优先级 下拉」而不是四个没有归属的控件）。取值闭集、选项文案、
          过滤判据全在 R1 的 `workItemSurfaceViewModel` —— 本组件只投影取值、只回传意图。 */}
      <div
        role="group"
        aria-label={t("squad.workItems.filter.label")}
        className="flex flex-wrap items-center gap-2"
      >
        <Select
          value={surface.filter.statusCategory}
          onValueChange={(value) =>
            onSurfaceIntent({ kind: "setStatusFilter", value: value as WorkItemStatusFilterValue })
          }
        >
          <SelectTrigger
            size="sm"
            disabled={controlsDisabled || lockedStatus}
            title={disabledTitle}
            aria-label={t("squad.workItems.field.status")}
            data-testid="work-items-status-filter"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WORK_ITEM_STATUS_FILTER_VALUES.map((value) => (
              <SelectItem key={value} value={value}>
                {t(WORK_ITEM_STATUS_FILTER_MESSAGE_IDS[value])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* 优先级 facet：`unset`（未设置）是独立一档 —— 「没人定过」与「显式选了某一档」不是同一态，
            不单列就等于存量行这一态永远查不出来（口径见 R1 的类型注释）。 */}
        <Select
          value={surface.filter.priority}
          onValueChange={(value) =>
            onSurfaceIntent({
              kind: "setPriorityFilter",
              value: value as WorkItemPriorityFilterValue,
            })
          }
        >
          <SelectTrigger
            size="sm"
            disabled={controlsDisabled || lockedPriority}
            title={disabledTitle}
            aria-label={t("squad.workItems.priority")}
            data-testid="work-items-priority-filter"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WORK_ITEM_PRIORITY_FILTER_VALUES.map((value) => (
              <SelectItem key={value} value={value}>
                {t(WORK_ITEM_PRIORITY_FILTER_MESSAGE_IDS[value])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* 项目过滤（R-P2）：与状态/优先级同一组（读屏听到「筛选 组 → 状态 / 优先级 / 项目」）。
          多选 + 「无项目」独立开关 + chips 回显，判据/语义全在 `WorkItemProjectFilter` 与
          `workItemSurfaceViewModel`（本组件只投影取值、只回传意图）。 */}
        <WorkItemProjectFilter
          filter={surface.filter}
          projects={workItemProjects?.projects ?? null}
          disabled={controlsDisabled}
          title={disabledTitle}
          locked={lockedProject}
          onIntent={onSurfaceIntent}
        />
      </div>
      {/* 搜索（T-P2-R4）：受控草稿 + 防抖提交；`type="text"` 是**有意**的 ——
          `type="search"` 在 WebKit/Chromium 下自带「Esc 清空输入框」（且与是否显示原生取消按钮
          有关），那条路径会绕过本组件的键盘判据，同一个 Esc 于是在两种输入类型下走两套语义。
          这里只保留一条路径：Esc 由 `resolveWorkItemSurfaceSearchKeyIntent` 判、立刻提交清空。 */}
      <div className="relative">
        <Input
          type="text"
          size="sm"
          className="w-44 pr-6 text-mobile-input-safe md:text-ui-base/relaxed"
          disabled={controlsDisabled}
          title={disabledTitle}
          aria-label={t("squad.workItems.search.label")}
          placeholder={t("squad.workItems.search.placeholder")}
          data-testid="work-items-search"
          value={searchDraft}
          onChange={(event) => {
            setSearchDraft(event.target.value);
            scheduleSearch(event.target.value);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onKeyDown={(event) => {
            /* 键位 → 意图的判据在纯函数里（可逐格测）：组合期一律 ignore、Enter = 立刻提交、
               Escape = 清空、**Tab 放行**（吃了它键盘焦点就出不去）。本层只执行结论。 */
            const intent = resolveWorkItemSurfaceSearchKeyIntent({
              key: event.key,
              compositionActive: composingRef.current,
              isComposing: event.nativeEvent.isComposing,
            });
            if (intent === "ignore") return;
            event.preventDefault();
            if (intent === "commit") {
              commitSearch(searchDraft);
              return;
            }
            setSearchDraft("");
            commitSearch("");
          }}
        />
        {searchClearVisible ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute right-0 top-1/2 -translate-y-1/2 text-foreground-subtle"
            disabled={controlsDisabled}
            title={disabledTitle}
            aria-label={t("squad.workItems.search.clear")}
            data-testid="work-items-search-clear"
            onClick={() => {
              setSearchDraft("");
              commitSearch("");
            }}
          >
            <X className="size-3.5" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {/* 排序（T-P2-R4）：键 + 方向两个下拉。方向在「手动顺序」下不生效（R1 的比较函数对
          `manual` 返回 0），但仍可预设 —— 不给它一个**说不出来**的置灰状态（零键增：
          没有"手动顺序没有方向"这一枚键，就不得造这个态）。 */}
      <Select
        value={surface.sort.key}
        onValueChange={(value) =>
          onSurfaceIntent({ kind: "setSortKey", key: value as WorkItemSortKey })
        }
      >
        <SelectTrigger
          size="sm"
          disabled={controlsDisabled}
          title={disabledTitle}
          aria-label={t("squad.workItems.sort.label")}
          data-testid="work-items-sort-key"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {workItemSortKeysForLaneDimension(laneDimension).map((key) => (
            <SelectItem key={key} value={key}>
              {t(WORK_ITEM_SORT_MESSAGE_IDS[key])}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={surface.sort.direction}
        onValueChange={(value) =>
          onSurfaceIntent({ kind: "setSortDirection", direction: value as WorkItemSortDirection })
        }
      >
        <SelectTrigger
          size="sm"
          disabled={controlsDisabled}
          title={disabledTitle}
          aria-label={workItemSurfaceTwinControlLabel(
            t("squad.workItems.sort.label"),
            t(WORK_ITEM_SORT_DIRECTION_MESSAGE_IDS[surface.sort.direction]),
          )}
          data-testid="work-items-sort-direction"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {WORK_ITEM_SORT_DIRECTIONS.map((direction) => (
            <SelectItem key={direction} value={direction}>
              {t(WORK_ITEM_SORT_DIRECTION_MESSAGE_IDS[direction])}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* 「清除筛选」：清搜索 + 两个 facet（**不清**视图 / 排序 / 列配置 —— 用户点的是
          "去掉这个筛选条件"，不是"把我配好的视图重置"，折叠口径见 `applyWorkItemSurfaceIntent`）。
          可点性问 `workItemSurfaceHasActiveQuery` 一处（"只有空格"这类输入在它那里与这里口径一致）。 */}
      <Button
        variant="outline"
        size="sm"
        disabled={controlsDisabled || !clearEnabled}
        title={disabledTitle}
        data-testid="work-items-filter-clear"
        onClick={() => onSurfaceIntent({ kind: "clearQuery" })}
      >
        {t("squad.workItems.filter.clear")}
      </Button>
      {/* 分组选择器（欠账 #15）：常驻在动作行（与刷新 / 新建同排）—— 它不是"设置"，
          而是看板当前视图的一部分；默认选项 = 不分组（既有视图零变化）。 */}
      <Select
        value={laneDimension}
        onValueChange={(value) => onLaneDimensionChange(value as WorkItemLaneDimension)}
      >
        <SelectTrigger
          size="sm"
          aria-label={t("squad.workItems.lane.dimension")}
          data-testid="work-items-lane-dimension"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(WORK_ITEM_LANE_DIMENSION_MESSAGE_IDS) as WorkItemLaneDimension[]).map(
            (dimension) => (
              <SelectItem key={dimension} value={dimension}>
                {t(WORK_ITEM_LANE_DIMENSION_MESSAGE_IDS[dimension])}
              </SelectItem>
            ),
          )}
        </SelectContent>
      </Select>
      {/* 批量工具栏（T-P2-R5）：挂在动作行里（与视图切换 / 过滤同排）—— 它是**当前视图的动作面**，
          不是「设置」；取数不可用时同样只置灰 + 原因（复用上面那份判据的结论）。 */}
      <WorkItemBulkToolbar disabledReason={controlsDisabledReason} {...bulk} />
      <Button
        variant="outline"
        size="sm"
        disabled={!targetAvailable || loading}
        data-testid="work-items-refresh"
        onClick={onReload}
      >
        {loading ? <Spinner className="size-3.5" /> : null}
        {t("squad.common.refresh")}
      </Button>
      <Button
        size="sm"
        disabled={createDisabled}
        data-testid={"work-items-create"}
        /* Static source guards intentionally anchor the persistent entry in the page contract. */
        onClick={onCreate}
      >
        {t("squad.workItems.create")}
      </Button>
    </div>
  );
}
