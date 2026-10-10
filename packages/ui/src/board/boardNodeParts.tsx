/**
 * 看板四视图共用的节点零件（卡 #33；卡 #35 增 `BoardNodeBadges` 角标簇单点装配）。
 *
 * 单点纪律：段位徽章 / 状态色点 / 缺口徽章 / 编号角标 / 角标簇在树形、看板、列表、弹窗
 * 各处**同一实现**—— 文案与 data 锚点只此一份，视图层只决定摆在哪（契约 §13.2 各格要求的呈现元素）。
 */
import { Fragment, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  boardStatusDotClassName,
  formatAttentionBadgeText,
  formatBoardActiveRunText,
  formatBoardFeatureId,
  formatBoardNodeId,
  formatBoardStageText,
} from "./boardPresentation.js";
import type { BoardAttentionCode, BoardLastRun } from "./boardViewModel.js";

/** 段位徽章：可见文本走词条（评审 S5），`data-board-stage` 保留字段原值（锚点不本地化）。 */
export function BoardStageBadge({ stage }: { stage: string | null }) {
  const { intl } = useZCodeIntl();
  const label = formatBoardStageText(stage, intl.formatMessage);
  if (label === null) return null;
  return (
    <Badge variant="secondary" data-board-stage={stage} className="shrink-0">
      {label}
    </Badge>
  );
}

/** status 四态色点（词汇与 progress.json 完全一致，契约 §3.2；未知状态不猜色）。 */
export function BoardStatusDot({ status }: { status: string | null }) {
  const className = boardStatusDotClassName(status);
  if (!className) return null;
  return (
    <span
      data-board-status={status}
      aria-hidden="true"
      className={cn("size-2 shrink-0 rounded-full", className)}
    />
  );
}

/**
 * 四缺口码徽章（文案逐字，契约 §4；`interrupted-resume` 的 #N 取自该卡 lastRun.stoppedAt）。
 *
 * 溢出防线（#54-3）：窄容器（看板 w-56 列）里长徽章不得撑出列盒——徽章允许收缩并按需截断
 * （`min-w-0 max-w-full truncate`），全文进 `title` 悬停可查（信息不丢，与路径截断同款姿态）。
 */
export function BoardAttentionBadges({
  attention,
  lastRun,
}: {
  attention: BoardAttentionCode[];
  lastRun: BoardLastRun | null;
}) {
  const { intl } = useZCodeIntl();
  return (
    <>
      {attention.map((code) => {
        const text = formatAttentionBadgeText(code, lastRun, intl.formatMessage);
        return (
          <Badge
            key={code}
            variant="outline"
            data-board-attention={code}
            title={text}
            className="min-w-0 max-w-full truncate border-warning/40 bg-warning/10 text-warning"
          >
            {text}
          </Badge>
        );
      })}
    </>
  );
}

/**
 * 编号（#46 B1）：`计划码-层级`（如 UI01-1.2）/ 无计划码 `ID-<label>`；`short`（同一计划
 * 分组内：树形/列表/表格）只显示层级（1.2）。`no`/`label` 缺省是合法形态 → 「未领号」角标
 * （契约 §3.3）；`data-board-node-id` 锚点携带最终形态文本（测试与定位不绑 CSS 类）。
 */
export function BoardNodeNumber({
  no,
  label,
  planCode = null,
  short = false,
  variant = "task",
}: {
  no: number | null;
  label: string | null;
  planCode?: string | null;
  short?: boolean;
  /** "task"（默认）：计划码-层级 / ID-<label>；"feature"：计划码本身（UI01）/ ID-<label>。 */
  variant?: "task" | "feature";
}) {
  const { intl } = useZCodeIntl();
  const text =
    variant === "feature"
      ? formatBoardFeatureId({ no, label, planCode })
      : formatBoardNodeId({ no, label, planCode }, { short });
  if (text === null) {
    return (
      <Badge variant="outline" data-board-unassigned="" className="shrink-0">
        {intl.formatMessage({ id: "board.unassigned" })}
      </Badge>
    );
  }
  return (
    <span
      data-board-node-id={text}
      className="shrink-0 font-mono text-ui-xs text-foreground-subtle"
    >
      {text}
    </span>
  );
}

/** `draft: true` → 「草案」角标；`blockers` 非空 → 「受阻 N」（契约 §3.3）。 */
export function BoardDraftBadge() {
  const { intl } = useZCodeIntl();
  return (
    <Badge variant="secondary" data-board-draft="" className="shrink-0">
      {intl.formatMessage({ id: "board.draft" })}
    </Badge>
  );
}

export function BoardBlockerBadge({ count }: { count: number }) {
  const { intl } = useZCodeIntl();
  if (count <= 0) return null;
  return (
    <Badge variant="outline" data-board-blockers={count} className="shrink-0">
      {intl.formatMessage({ id: "board.blockedByCount" }, { count })}
    </Badge>
  );
}

/** 执行角色徽记（标记 `data-board-active-run`，与表格的 `activeRun` 列同源字段）。 */
export function BoardActiveRunBadge({ role }: { role: string }) {
  const { intl } = useZCodeIntl();
  return (
    <Badge variant="secondary" data-board-active-run={role} className="shrink-0">
      {formatBoardActiveRunText(role, intl.formatMessage)}
    </Badge>
  );
}

/**
 * 卡片角标簇（四视图共用，评审 #33-S3）：草案 → 缺口徽章 → 受阻 N → 执行角色 → 状态点。
 * 单点必要性：树形/看板/列表/弹窗各自拼一遍，四份的**顺序与取舍**早晚对不上
 * （角标属于节点自身字段，视图差异只在摆放位置）。段位徽章与编号不在簇内
 * ——它们在各视图的位置不同（行首/行尾），由视图自行摆放。
 *
 * `showStatusDot`（#46 B5）：弹窗里段位徽章已含状态，状态色点去重（其余三视图保留）。
 * `mergeUnmergedBlocked`（#54-5）：弹窗里「待合并」+「受阻 N」并列像两个独立问题 → 合并成
 * 单一徽章；**两个锚点各带原值**（`data-board-attention` / `data-board-blockers`），语义不丢。
 */
export function BoardNodeBadges({
  attention,
  blockers,
  lastRun,
  draft,
  activeRunRole,
  status,
  showStatusDot = true,
  mergeUnmergedBlocked = false,
  className,
}: {
  attention: BoardAttentionCode[];
  /** 节点自身的 blockers（特性级照实传；不借子树的值）。 */
  blockers: number;
  lastRun: BoardLastRun | null;
  draft: boolean;
  activeRunRole: string | null;
  status: string | null;
  showStatusDot?: boolean;
  mergeUnmergedBlocked?: boolean;
  /** 弱化形态（#54-9/P-2 跨列轻量分组头）：只调强调度，不改角标取舍。 */
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const unmerged = attention.includes("unmerged-worktree");
  const merged = mergeUnmergedBlocked && unmerged && blockers > 0;
  return (
    <span
      data-board-badges=""
      className={cn("flex min-w-0 flex-wrap items-center gap-1", className)}
    >
      {draft ? <BoardDraftBadge /> : null}
      <BoardAttentionBadges
        attention={merged ? attention.filter((code) => code !== "unmerged-worktree") : attention}
        lastRun={lastRun}
      />
      {merged ? (
        // 合并徽章（#54-5）：单一视觉单元，两个锚点各保留原值。
        <Badge
          variant="outline"
          data-board-attention="unmerged-worktree"
          data-board-blockers={blockers}
          title={intl.formatMessage({ id: "board.attention.unmergedBlocked" })}
          className="min-w-0 max-w-full truncate border-warning/40 bg-warning/10 text-warning"
        >
          {intl.formatMessage({ id: "board.attention.unmergedBlocked" })}
        </Badge>
      ) : (
        <BoardBlockerBadge count={blockers} />
      )}
      {activeRunRole ? <BoardActiveRunBadge role={activeRunRole} /> : null}
      {showStatusDot ? <BoardStatusDot status={status} /> : null}
    </span>
  );
}

/**
 * 特性分组头内容（#46 B3/B4 共用；#55 S-2 收敛树形手工装配）：编号（计划码 / ID-<label>）+
 * 名称 + 段位徽章 + 角标 + `[N 张卡]` 摘要。**不是独立卡**：各视图把它装进自己的分组行/摘要
 * （`<summary>`、分组 `<div>`、表头 `<tr>`），卡片锚点与视觉外壳由宿主决定。
 *
 * `lightweight`（#54-9/P-2，契约 §13.7 B3）：跨列随行的分组头降级轻量标签——段位徽章属于
 * 特性自己的列，跨列时不带；名称弱化为小字，角标与计数保留但压低强调度（缺口不许被埋）。
 *
 * 视图间差异作 props（#55 S-2，评审 #46 S-2）：`titleClassName`（树形大块用 base 字号）、
 * `titleAccessory`（树形特性头尾部的当前执行者徽记）；计数片 markup 单点化，不再各装配一份。
 */
export function BoardFeatureGroupHeaderContent({
  feature,
  cardCount,
  lightweight = false,
  titleRegionProps = null,
  titleClassName,
  titleAccessory = null,
}: {
  /** 分组头所需的最小字段面：树形传原始特性节点、看板/列表传视图节点——同一零件不挑来源。 */
  feature: {
    no: number | null;
    label: string | null;
    planCode: string | null;
    title: string;
    stage: string | null;
    attention: BoardAttentionCode[];
    blockers: readonly unknown[];
    status: string | null;
  };
  cardCount: number;
  lightweight?: boolean;
  /**
   * 开弹窗落点（#54-4 列表组头点击分区）：给了就把「编号 + 名称」包进这个落点 div 并展开
   * 这些 props（宿主用 `boardCardOpenProps` 生成，含 `data-board-card` 锚点与高亮），
   * 段位/角标/计数留在落点外——点它们走宿主容器（`<summary>`）的默认动作（折叠/展开）。
   * 不传 = 整行由宿主统一处理（看板分组头现状）。
   */
  titleRegionProps?: (Record<string, unknown> & { className?: string }) | null;
  /** 全量形态的标题字号（缺省 = 看板/列表的 sm；树形大块传 base）。 */
  titleClassName?: string;
  /** 标题后的附加片（树形当前执行者徽记；看板/列表不传）。 */
  titleAccessory?: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const numberAndTitle = (
    <>
      <BoardNodeNumber
        no={feature.no}
        label={feature.label}
        planCode={feature.planCode}
        variant="feature"
      />
      <span
        {...(feature.planCode !== null ? { "data-board-feature-code": feature.planCode } : {})}
        className={cn(
          "min-w-0 flex-1 truncate",
          lightweight
            ? "text-ui-xs text-foreground-subtle"
            : (titleClassName ?? "text-ui-sm font-medium text-foreground"),
        )}
      >
        {feature.title}
      </span>
      {titleAccessory}
    </>
  );
  return (
    <>
      {titleRegionProps ? (
        <div
          {...titleRegionProps}
          className={cn("flex min-w-0 flex-1 items-center gap-2", titleRegionProps.className ?? "")}
        >
          {numberAndTitle}
        </div>
      ) : (
        numberAndTitle
      )}
      {lightweight ? null : <BoardStageBadge stage={feature.stage} />}
      <BoardNodeBadges
        attention={feature.attention}
        blockers={feature.blockers.length}
        lastRun={null}
        draft={false}
        activeRunRole={null}
        status={feature.status}
        {...(lightweight ? { className: "opacity-70" } : {})}
      />
      <span
        data-board-feature-card-count={cardCount}
        className={cn(
          "shrink-0 rounded-md px-1.5 py-0.5 text-ui-xs tabular-nums text-foreground-subtle",
          lightweight ? "" : "bg-surface",
        )}
      >
        {intl.formatMessage({ id: "board.feature.cardCount" }, { count: cardCount })}
      </span>
    </>
  );
}

/**
 * 责任管线（#46 B6；#54-1 三态）：角色按管线序排列——
 *   - `currentAssignee`（"谁在做"）：主色加粗（`text-primary` + `font-medium`）；
 *   - `nextAssignee`（v2.3/#53"下一个接手人"，管线序首个无 done 证据角色）：次强调
 *     （`text-foreground` + `font-medium`）并带词条化「下一个」标记（`data-board-pipeline-next`）；
 *   - 管线序**早于** nextAssignee 的角色：有 done 证据 → 弱化（dim + 勾形，`data-board-pipeline-done`）。
 * 三者都来自板字段透传，**不在视图层自算**（契约 §13.7：nextAssignee 是编译器派生字段）。
 * `nextAssignee` 为 null（字段缺省或管线走完）时只画前两态——不编造接手位、也不把全管线画成已完成。
 */
export function BoardAssigneePipeline({
  assignees,
  currentAssignee,
  nextAssignee = null,
  className,
}: {
  assignees: string[];
  currentAssignee: string | null;
  nextAssignee?: string | null;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  if (assignees.length === 0) return null;
  const nextIndex = nextAssignee === null ? -1 : assignees.indexOf(nextAssignee);
  return (
    <span
      data-board-pipeline=""
      className={cn("flex min-w-0 flex-wrap items-center gap-1", className)}
    >
      {assignees.map((role, index) => {
        const current = role === currentAssignee;
        // 当前执行者优先：正在做的角色即使正是接手位，也不重复标「下一个」。
        const next = !current && index === nextIndex;
        const done = !current && nextIndex >= 0 && index < nextIndex;
        return (
          <Fragment key={role}>
            {index > 0 ? (
              <span aria-hidden="true" className="text-ui-xs text-foreground-subtle">
                →
              </span>
            ) : null}
            <span
              data-board-pipeline-role={role}
              {...(current ? { "data-board-pipeline-current": "true" } : {})}
              {...(next ? { "data-board-pipeline-next": role } : {})}
              {...(done ? { "data-board-pipeline-done": "true" } : {})}
              className={cn(
                "text-ui-xs",
                current
                  ? "font-medium text-primary"
                  : done
                    ? "text-foreground-subtlest line-through"
                    : next
                      ? "font-medium text-foreground"
                      : "text-foreground-subtle",
              )}
            >
              {done ? (
                <span aria-hidden="true" className="mr-0.5">
                  ✓
                </span>
              ) : null}
              {next ? (
                <span data-board-pipeline-next-marker="" className="mr-0.5 text-foreground-subtle">
                  {intl.formatMessage({ id: "board.pipeline.next" })}
                </span>
              ) : null}
              {role}
            </span>
          </Fragment>
        );
      })}
    </span>
  );
}
