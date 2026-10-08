import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Spinner } from "@/components/ui/spinner.js";
import {
  WORK_ITEM_VIEW_MODES,
  WORK_ITEM_VIEW_MODE_MESSAGE_IDS,
  type WorkItemSurfaceIntent,
  type WorkItemSurfaceState,
  type WorkItemViewMode,
} from "./workItemSurfaceViewModel.js";
import type { WorkItemLaneDimension } from "./workItemsViewModel.js";

/** 三个维度的文案键（闭集：加维度时这里必须跟着改 —— 与 `WorkItemLaneDimension` 同源）。 */
const LANE_DIMENSION_MESSAGE_IDS: Record<WorkItemLaneDimension, string> = {
  none: "squad.workItems.lane.dimension.none",
  statusCategory: "squad.workItems.lane.dimension.statusCategory",
  assignee: "squad.workItems.lane.dimension.assignee",
};

/** Persistent page actions. Visibility is independent of snapshot readiness. */
export function WorkItemsPageActions({
  targetAvailable,
  loading,
  createDisabled,
  laneDimension,
  onLaneDimensionChange,
  surface,
  onSurfaceIntent,
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
  t: (id: string) => string;
  onReload: () => void;
  onCreate: () => void;
}) {
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
          {(Object.keys(LANE_DIMENSION_MESSAGE_IDS) as WorkItemLaneDimension[]).map((dimension) => (
            <SelectItem key={dimension} value={dimension}>
              {t(LANE_DIMENSION_MESSAGE_IDS[dimension])}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
