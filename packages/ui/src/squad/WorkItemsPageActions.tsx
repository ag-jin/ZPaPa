import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Spinner } from "@/components/ui/spinner.js";
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
  t: (id: string) => string;
  onReload: () => void;
  onCreate: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
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
