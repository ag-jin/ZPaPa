/**
 * 指引面（guide 面，卡 #136 / C3-1）：板级执行摘要置顶条（五槽） + 主体「正在执行的计划」区块。
 *
 * 动线（itw-20261011-5c30 拍板 · 计划优先轴；E7 §3.1/§3.3 L1）：
 *   打开看板第一眼 = 现在在执行什么 → 每个计划的完成进度（计数 + 微条）→ 计划内卡行入口
 *   （点卡 → 既有卡片弹窗，L3 详情）。四段派生是唯一事实来源（契约 §13.6）：
 *   槽位计数、计划内卡行成员与顺序全部来自 `boardGuideViewModel` 的投影，本组件只装配。
 *
 * 视图边界（契约 §13.6）：不写板文件、不解析真相源、不自算 `stage`/`attention`；
 * 缺四段（旧编译器产物）→ 指名重编译，不自行派生兜底。
 *
 * 骨架范围（C3-1）：五槽条 + 计划区块骨架；五槽下钻归 C3-2（#137）、完整前沿队列归 C3-3（#138）、
 * 计数胶囊零件归 C3-4（#139）。本组件里的行入口即 #138 的生长点（同一投影、同一卡行零件）。
 *
 * 视觉准入（itw-20261011-9003；四绿 ui-designer 复核口径）：主体文字（标题/卡名/摘要行，摘要行
 * 为门禁枚举的运营信息承载）`text-ui-base`(14px)；辅助/元数据行（接手位、标签、空态）`text-ui-sm`；
 * 每行信息点 ≤4 组、留白 `p-3`/`gap-2` 起——「一扫可读」优先于「信息全」。
 * 活跃计划置顶带共享状态点（`BoardStatusDot`）辨识：复用既有零件，不新造色点/大面积色块。
 */
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { boardCardOpenProps } from "./boardCardInteraction.js";
import { BoardGuidePlanProgressBar, BoardGuideSlotTile } from "./boardGuideParts.js";
import {
  buildBoardGuideSummary,
  type BoardGuideCardRow,
  type BoardGuidePlan,
} from "./boardGuideViewModel.js";
import { BoardNodeNumber, BoardStageBadge, BoardStatusDot } from "./boardNodeParts.js";
import { formatBoardRelativeTime } from "./boardPresentation.js";
import type { BoardViewModel } from "./boardViewModel.js";

export interface BoardGuideViewProps {
  board: BoardViewModel;
  /** 卡片打开路由（既有弹窗宿主状态；缺省 = 只读渲染，行不可点）。 */
  onOpenCard?: (id: string) => void;
  /** 相对时间的「现在」（毫秒）；缺省取渲染时刻（测试注入固定值）。 */
  now?: number;
}

/** 计划内卡行（L1 scan 档：短 ID + 标题前缀 + 主状态 + 接手位；点即开卡弹窗）。 */
function BoardGuideCardRowLine({
  row,
  planCode,
  onOpenCard,
}: {
  row: BoardGuideCardRow;
  planCode: string | null;
  onOpenCard?: (id: string) => void;
}) {
  return (
    <div
      data-board-card={row.id}
      {...boardCardOpenProps({ id: row.id, ...(onOpenCard ? { onOpenCard } : {}) })}
      className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-surface-hover"
    >
      <BoardNodeNumber no={row.no} label={row.label} planCode={planCode} short />
      {/* 标题截断防线：完整标题进原生 title（信息不丢；展开面归 #138 队列）。 */}
      <span title={row.title} className="min-w-0 flex-1 truncate text-ui-base text-foreground">
        {row.title}
      </span>
      <BoardStageBadge stage={row.stage} />
      {row.nextAssignee !== null ? (
        <span className="shrink-0 text-ui-sm text-foreground-subtle">{row.nextAssignee}</span>
      ) : null}
    </div>
  );
}

/** 单个计划区块：名 + 完成进度（计数 + 微条）+ 期次/完成情况摘要行 + 前沿行入口。 */
function BoardGuidePlanBlock({
  plan,
  onOpenCard,
}: {
  plan: BoardGuidePlan;
  onOpenCard?: (id: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const progressText =
    plan.total > 0
      ? intl.formatMessage(
          { id: "board.guide.plan.progress" },
          { completed: plan.completed, total: plan.total },
        )
      : intl.formatMessage({ id: "board.guide.plan.undesigned" });
  const summaryParts = [
    plan.stage,
    plan.phaseName,
    intl.formatMessage({ id: "board.guide.plan.frontier" }, { count: plan.frontierCount }),
    intl.formatMessage({ id: "board.guide.plan.active" }, { count: plan.activeCount }),
  ].filter((part): part is string => part !== null && part !== "");
  return (
    <article
      data-board-guide-plan={plan.featureId}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border/50 bg-surface p-3"
    >
      <div className="flex min-w-0 items-center gap-2">
        {/* 活跃计划置顶的视觉辨识（四绿 P2 回炉）：复用共享四态色点（`BoardStatusDot`，契约 §3.2）
            ——仅 `status=active` 的计划带头行点，非活跃不带（不给每块加装饰，也不新造色点样式）；
            点仅作视觉引导（`aria-hidden`），「执行中」文字仍在摘要行段位里可读。 */}
        {plan.statusActive ? <BoardStatusDot status="active" /> : null}
        <BoardNodeNumber
          no={plan.no}
          label={plan.label}
          planCode={plan.planCode}
          variant="feature"
        />
        <span
          title={plan.title}
          className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground"
        >
          {plan.title}
        </span>
        <span
          data-board-guide-plan-progress={`${plan.completed}/${plan.total}`}
          className="shrink-0 text-ui-base font-medium tabular-nums text-foreground"
        >
          {progressText}
        </span>
      </div>
      <BoardGuidePlanProgressBar
        completed={plan.completed}
        total={plan.total}
        label={intl.formatMessage(
          { id: "board.guide.plan.progressLabel" },
          { completed: plan.completed, total: plan.total },
        )}
      />
      {/* 摘要行 = 主体文字（四绿 P1 回炉）：段位·期次·前沿·在途 4 个运营信息点，门禁枚举
          「摘要行」与计划名/计数同为 ≥ text-ui-base(14px)；层级靠色阶（foreground-subtle）
          与字重（不加重）区分，不靠缩字号。 */}
      <div
        data-board-guide-plan-summary=""
        className="truncate text-ui-base text-foreground-subtle"
      >
        {summaryParts.join(" · ")}
      </div>
      {plan.rows.length > 0 ? (
        <div data-board-guide-plan-frontier="" className="flex flex-col gap-0.5">
          {plan.rows.map((row) => (
            <BoardGuideCardRowLine
              key={row.id}
              row={row}
              planCode={plan.planCode}
              {...(onOpenCard ? { onOpenCard } : {})}
            />
          ))}
        </div>
      ) : null}
      {plan.hiddenRows > 0 ? (
        // 裁剪量显式（完整队列归 C3-3/#138）：不静默丢行。
        <div data-board-guide-plan-more="" className="px-1.5 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "board.guide.plan.more" }, { count: plan.hiddenRows })}
        </div>
      ) : null}
    </article>
  );
}

export function BoardGuideView({ board, onOpenCard, now }: BoardGuideViewProps) {
  const { intl } = useZCodeIntl();
  const summary = buildBoardGuideSummary(board);
  const latestActivityHint =
    summary.latestActivityAt !== null
      ? formatBoardRelativeTime(summary.latestActivityAt, now ?? Date.now(), intl.formatMessage)
      : null;
  return (
    <div
      data-board-view="guide"
      data-board-guide=""
      data-board-guide-index-state={summary.indexAvailable ? "ready" : "missing"}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pt-3 pb-4"
    >
      <div data-board-guide-slots="" className="flex min-w-0 flex-wrap gap-2">
        {summary.slots.map((slot) => (
          <BoardGuideSlotTile
            key={slot.key}
            slot={slot}
            {...(slot.key === "recent" && latestActivityHint !== null
              ? { hint: latestActivityHint }
              : {})}
          />
        ))}
      </div>
      {!summary.indexAvailable ? (
        // 旧板（缺四段）：指名重编译——视图侧不自行派生兜底（契约 §13.6）。
        <div
          data-board-guide-recompile=""
          role="status"
          className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-sm text-foreground"
        >
          {intl.formatMessage({ id: "board.guide.recompile" })}
        </div>
      ) : null}
      <section data-board-guide-plans="" className="flex min-w-0 flex-col gap-2">
        <h2 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "board.guide.plans.title" })}
        </h2>
        {summary.plans.length === 0 ? (
          <div
            data-board-guide-plans-empty=""
            className="rounded-lg border border-border/50 bg-surface px-3 py-2 text-ui-sm text-foreground-subtle"
          >
            {intl.formatMessage({ id: "board.guide.plans.empty" })}
          </div>
        ) : null}
        {summary.plans.map((plan) => (
          <BoardGuidePlanBlock
            key={plan.featureId}
            plan={plan}
            {...(onOpenCard ? { onOpenCard } : {})}
          />
        ))}
      </section>
    </div>
  );
}
