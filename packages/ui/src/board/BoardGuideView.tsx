/**
 * 指引面（guide 面，卡 #136 / C3-1）：板级执行摘要置顶条（五槽） + 主体「正在执行的计划」区块。
 *
 * 动线（itw-20261011-5c30 拍板 · 计划优先轴；E7 §3.1/§3.3 L1）：
 *   打开看板第一眼 = 现在在执行什么 → 每个计划的完成进度（计数 + 微条）→ 计划内
 *   可执行前沿队列（点行 → 既有卡片弹窗，L2 下钻）。四段派生是唯一事实来源（契约 §13.6）：
 *   槽位计数、队列成员与顺序全部来自 `boardGuideViewModel` 的投影，本组件只装配。
 *
 * 视图边界（契约 §13.6）：不写板文件、不解析真相源、不自算 `stage`/`attention`；
 * 缺四段（旧编译器产物）→ 指名重编译，不自行派生兜底。
 *
 * 骨架范围（C3-1）：五槽条 + 计划区块骨架；五槽下钻归 C3-2（#137）、完整前沿队列归 C3-3（#138）。
 * C3-3（#138）已落：计划块内的行入口升级为**完整前沿队列**（frontier 成员全量、frontier 序直读；
 * 行含处置指引——「下一步」接手位 + 已解除依赖计数片，均直读 frontier 条目字段；零前沿给空态文案）；
 * 计划块（队列分组）排序 = 活跃置顶 → 纯期次序（A4 单点比较器）→ 无期次殿后（判据在 viewModel）。
 * C3-2（#137）已落：五槽升级为可点落点（`BoardGuideSlotTile.onActivate` → 宿主的既有视图切换 +
 * 列表控制；零槽点击给空态指引、不落死跳转；缺四段槽不上可点态）——落点判据在
 * `boardGuideViewModel.boardGuideSlotDrilldownTarget` 一处，本组件只回传意图。
 * #139（C3-4）已把计数胶囊/微条零件完整化（`boardGuideParts`）：计划级进度胶囊（已完成/总卡 ·
 * 百分比 + 微条）与期次/功能级摘要行计数胶囊（`[N 张卡]` 与 rollup 缺口徽章，与 A4 组头同源）；
 * 本组件的计划块只做摆放接线，计数全部直读投影（禁自算）。
 *
 * 视觉准入（itw-20261011-9003；四绿 ui-designer 复核口径）：主体文字（标题/卡名/摘要行、队列行
 * 处置指引，摘要行为门禁枚举的运营信息承载）`text-ui-base`(14px)；辅助/元数据行（标签、空态）
 * `text-ui-sm`；每行信息点 ≤4 组、留白 `p-3`/`gap-2` 起——「一扫可读」优先于「信息全」。
 * 计划头行 = 编号/名 + 计数胶囊 + 缺口徽章；进度胶囊「计数 · 百分比」收敛为一个信息组 + 微条同排。
 * 活跃计划置顶带共享状态点（`BoardStatusDot`）辨识：复用既有零件，不新造色点/大面积色块。
 *
 * 手机窄面降级形态（#141 / C3-6；E7 §8.2 响应式与触摸约束）——**降级不降可读**：
 * - 查询容器 = 本面根（`@container`，inline-size）：降级按**面板可用宽**判定（手机 Web 视口 =
 *   面板宽；桌面窄侧栏同款语义），不按 viewport（侧栏宽度与视口无关，媒体查询会判错）。
 * - 窄档 breaker = 容器 < 24rem（Tailwind `@max-sm`）；320/375 两档下行内形态：
 *   ① 计划头计数簇（`data-board-guide-plan-meta`）与队列行二次信息组（`data-board-guide-queue-meta`）
 *      整组 `basis-full` 折到次行——首行留给「名字/卡号 + 标题」一扫可读，二次信息不消失只换行；
 *   ② 队列行窄面限高 ≥44px（`min-h-11`）——行即 L2 下钻落点，触摸命中区不足易误触；
 *   ③ 槽条基准收窄（`boardGuideParts` 的 `@max-sm:basis-20`）保持两行内。
 * - 字号底线不破：降级只动基准/边距/折行，不动 `text-ui-*` 档（标签 ≥12px、主文字 ≥14px）。
 * - 信息不丢：超长接手位角色名（`nextAssignee`）走 `truncate + 原生 title` 防线（#138 P3-2 收口），
 *   宽面（≥24rem）保持单行同排与既有紧凑密度（降级形态不落到宽面）。
 */
import { useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { boardCardOpenProps } from "./boardCardInteraction.js";
import {
  BoardGuidePlanCardCountCapsule,
  BoardGuidePlanProgressCapsule,
  BoardGuidePlanRollupGapBadge,
  BoardGuideSlotTile,
  BOARD_GUIDE_SLOT_MESSAGE_IDS,
} from "./boardGuideParts.js";
import {
  boardGuideSlotActivation,
  buildBoardGuideSummary,
  type BoardGuidePlan,
  type BoardGuideQueueRow,
  type BoardGuideSlotKey,
} from "./boardGuideViewModel.js";
import { BOARD_COUNT_CHIP_CLASS, BoardNodeNumber, BoardStatusDot } from "./boardNodeParts.js";
import {
  BOARD_COUNT_MESSAGE_IDS,
  formatBoardCountText,
  formatBoardRelativeTime,
} from "./boardPresentation.js";
import type { BoardViewModel } from "./boardViewModel.js";

export interface BoardGuideViewProps {
  board: BoardViewModel;
  /** 卡片打开路由（既有弹窗宿主状态；缺省 = 只读渲染，行不可点）。 */
  onOpenCard?: (id: string) => void;
  /**
   * 槽下钻派发（卡 #137/C3-2；缺省 = 只读渲染，槽不可点）：宿主按
   * `boardGuideSlotDrilldownTarget` 落到既有视图/过滤——指引面不自己切视图，只回传意图
   * （与卡行 `onOpenCard` 同款单向派发；禁第二路由）。
   */
  onDrillToSlot?: (slot: BoardGuideSlotKey) => void;
  /** 相对时间的「现在」（毫秒）；缺省取渲染时刻（测试注入固定值）。 */
  now?: number;
}

/** 可执行前沿队列行（#138/C3-3：处置指引 + L2 下钻 = 点行开既有卡片弹窗）。 */
function BoardGuideQueueRowLine({
  row,
  planCode,
  onOpenCard,
}: {
  row: BoardGuideQueueRow;
  planCode: string | null;
  onOpenCard?: (id: string) => void;
}) {
  const { intl } = useZCodeIntl();
  // 处置指引文案（同一字符串喂可见文本与原生 title：截断后全文仍可得，不另拼第二份）。
  const nextAssigneeText =
    row.nextAssignee === null
      ? null
      : intl.formatMessage({ id: "board.guide.queue.next" }, { role: row.nextAssignee });
  return (
    <div
      data-board-card={row.id}
      data-board-guide-queue-row=""
      {...boardCardOpenProps({ id: row.id, ...(onOpenCard ? { onOpenCard } : {}) })}
      // 触摸命中区（卡 #141/C3-6；E7 §8.2「触摸目标至少 44px」）：窄容器（`@max-sm` <24rem）
      // 下限高 44px（`min-h-11`）——行点击后即 L2 下钻（既有弹窗路由），命中区不足时容易误触。
      // `flex-wrap` 常驻：宽面全部单行（无换行机会），窄面由二次信息组的 `basis-full` 触发折行。
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-1.5 py-1 @max-sm:min-h-11 hover:bg-surface-hover"
    >
      <BoardNodeNumber no={row.no} label={row.label} planCode={planCode} short />
      {/* 标题截断防线：完整标题进原生 title（信息不丢）。 */}
      <span title={row.title} className="min-w-0 flex-1 truncate text-ui-base text-foreground">
        {row.title}
      </span>
      {/* 二次信息组（依赖计数片 + 处置指引；卡 #141/C3-6）：窄容器（`@max-sm` <24rem）下整组
          `basis-full` 让位折到次行——窄面首行留给「卡号 + 标题」做一扫可读，二次信息不消失
          只是换行（对比：宽面同排，零信息取舍）。组内 `min-w-0` 让处置指引能收缩截断。 */}
      <span
        data-board-guide-queue-meta=""
        className="flex min-w-0 items-center gap-2 @max-sm:basis-full"
      >
        {/* 计数片（已解除依赖条数；`title` 带依赖号明细）：frontier 条目字段直读，零条不落片；
            计数词条走单点 `formatBoardCountText`（单/复数两键，count===1 走单数——#138 S1 回修）。 */}
        {row.resolvedDeps.length > 0 ? (
          <span
            data-board-guide-queue-deps={row.resolvedDeps.length}
            title={row.resolvedDeps.map((no) => `#${no}`).join(", ")}
            className={cn(BOARD_COUNT_CHIP_CLASS, "text-ui-base")}
          >
            {formatBoardCountText(
              row.resolvedDeps.length,
              BOARD_COUNT_MESSAGE_IDS.guideQueueDeps,
              intl.formatMessage,
            )}
          </span>
        ) : null}
        {/* 处置指引（行内主文字之一，≥14px 档）：接手位直读 frontier.nextAssignee；未指派不猜。
            截断防线（#141 收口 #138 P3-2/随行登记项）：超长角色名（如 exhaustive-reverse-auditor）
            在 <360px 档会超宽——`min-w-0 flex-1 truncate` 收缩出省略号，全文进原生 title（不溢出、
            不丢信息）；字号不降档（≥text-ui-base），`flex-1` 供窄面折行后独占次行余宽。 */}
        {row.nextAssignee !== null ? (
          <span
            data-board-guide-queue-next={row.nextAssignee}
            title={nextAssigneeText ?? undefined}
            className="min-w-0 flex-1 truncate text-ui-base text-foreground-subtle"
          >
            {nextAssigneeText}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** 单个计划区块：名 + 完成进度（进度胶囊/微条）+ 期次/完成情况摘要行 + 可执行前沿队列
 *（frontier 成员全量、frontier 序直读；零前沿给空态文案——队列契约见 #138/C3-3）。 */
function BoardGuidePlanBlock({
  plan,
  onOpenCard,
}: {
  plan: BoardGuidePlan;
  onOpenCard?: (id: string) => void;
}) {
  const { intl } = useZCodeIntl();
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
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
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
        {/* 计数簇（卡数胶囊 + rollup 缺口徽章；卡 #141/C3-6）：窄容器（`@max-sm` <24rem）下整组
            `basis-full` 让位折到次行——计划名独占首行（宽度不够时真换行，不是算术推演；
            宽面同排不变）。计数信息不消失，只是换行。 */}
        <span
          data-board-guide-plan-meta=""
          className="flex min-w-0 items-center gap-2 @max-sm:basis-full"
        >
          {/* 期次/功能级摘要行的计数胶囊（#139）：与 A4 组头 `[N 张卡]` 同源同值（AD-6 名+计数）。 */}
          <BoardGuidePlanCardCountCapsule count={plan.total} />
          {/* rollup 缺口徽章（#139/AD-6）：只在有缺口时落章——0 = 日常零噪声（与 A4 层头同判据）。 */}
          {plan.gapCount > 0 ? <BoardGuidePlanRollupGapBadge gapCount={plan.gapCount} /> : null}
        </span>
      </div>
      <BoardGuidePlanProgressCapsule
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
      {plan.queue.length > 0 ? (
        <div data-board-guide-plan-queue="" className="flex flex-col gap-0.5">
          {plan.queue.map((row) => (
            <BoardGuideQueueRowLine
              key={row.id}
              row={row}
              planCode={plan.planCode}
              {...(onOpenCard ? { onOpenCard } : {})}
            />
          ))}
        </div>
      ) : (
        // 队列空态（#138）：无可执行卡也给明确文案，不留空壳（与五槽零值同款姿态）。
        <div data-board-guide-queue-empty="" className="px-1.5 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "board.guide.queue.empty" })}
        </div>
      )}
    </article>
  );
}

export function BoardGuideView({ board, onOpenCard, onDrillToSlot, now }: BoardGuideViewProps) {
  const { intl } = useZCodeIntl();
  const summary = buildBoardGuideSummary(board);
  // 零槽点击的空态指引（卡 #137/C3-2；本地呈现态）：点零槽**不跳转**（不落死跳转），
  // 就近给一条可读指引；点非零槽下钻时清掉。
  const [emptySlotHint, setEmptySlotHint] = useState<BoardGuideSlotKey | null>(null);
  const handleSlotActivate = (key: string) => {
    const slot = summary.slots.find((entry) => entry.key === key);
    if (!slot) return;
    if (boardGuideSlotActivation(slot) === "drill") {
      setEmptySlotHint(null);
      onDrillToSlot?.(slot.key);
      return;
    }
    // 0 = 显式空槽：给明确空态指引。缺四段（null）的槽压根不上可点态（见下），到不了这里。
    setEmptySlotHint(slot.key);
  };
  const latestActivityHint =
    summary.latestActivityAt !== null
      ? formatBoardRelativeTime(summary.latestActivityAt, now ?? Date.now(), intl.formatMessage)
      : null;
  return (
    <div
      data-board-view="guide"
      data-board-guide=""
      data-board-guide-index-state={summary.indexAvailable ? "ready" : "missing"}
      // 窄面容条件上下文（卡 #141/C3-6）：本面即查询容器（`@container`，inline-size）——
      // 降级形态按**面板可用宽**判定（手机 Web 视口 = 面板宽；桌面窄侧栏同款语义），
      // 不用 viewport 媒体查询（侧栏宽度与视口无关，媒体查询会判错）。
      className="@container flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pt-3 pb-4"
    >
      <div data-board-guide-slots="" className="flex min-w-0 flex-wrap gap-2">
        {summary.slots.map((slot) => (
          <BoardGuideSlotTile
            key={slot.key}
            slot={slot}
            {...(slot.key === "recent" && latestActivityHint !== null
              ? { hint: latestActivityHint }
              : {})}
            // 可点判据 = 有宿主派发（只读渲染不上可点态）且有落点（缺四段 → 不猜）；0 槽仍可点
            // ——点击给空态指引而不是跳转（卡文验收）。
            {...(onDrillToSlot && boardGuideSlotActivation(slot) !== "none"
              ? { onActivate: handleSlotActivate }
              : {})}
          />
        ))}
      </div>
      {emptySlotHint !== null ? (
        // 零槽的空态指引（role=status：读屏可感知；锚点给浏览器断言）。
        <div
          data-board-guide-slot-empty={emptySlotHint}
          role="status"
          className="rounded-lg border border-border/50 bg-surface px-3 py-2 text-ui-sm text-foreground-subtle"
        >
          {intl.formatMessage(
            { id: "board.guide.slot.emptyHint" },
            { slot: intl.formatMessage({ id: BOARD_GUIDE_SLOT_MESSAGE_IDS[emptySlotHint] }) },
          )}
        </div>
      ) : null}
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
