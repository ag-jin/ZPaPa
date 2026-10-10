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
 * 溢出防线（#54-3；省略号形态 #59 S-3(a)）：窄容器（看板 w-56 列）里长徽章不得撑出列盒。
 * `Badge` 是 inline-flex——`text-overflow` 不作用于匿名文本项（Chromium 直接硬裁），
 * 因此文本移入内层 `span`（`truncate`）承载省略号；外层 `max-w-full` 兜底为裁切（不撑宽宿主），
 * 全文进 `title` 悬停可查（信息不丢，与路径截断同款姿态）。
 * `data-board-overflow-clip` / `data-board-overflow-ellipsis`（#59 S-4）是守卫断言的 data 锚点
 * ——不绑 CSS 类名。
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
            data-board-overflow-clip=""
            title={text}
            className="min-w-0 max-w-full border-warning/40 bg-warning/10 text-warning"
          >
            <span data-board-overflow-ellipsis="" className="min-w-0 truncate">
              {text}
            </span>
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

/**
 * 执行角色徽记（标记 `data-board-active-run`，与表格责任管线列同源字段）。
 *
 * 溢出防线（#59 M3）：角色名是板上动态文本（长中文/远端 agent 名），窄列里不得撑宽宿主——
 * `min-w-0 max-w-full` + 内层 `span` 省略号（与缺口徽章同一形态），全文进 `title`。
 */
export function BoardActiveRunBadge({ role }: { role: string }) {
  const { intl } = useZCodeIntl();
  const text = formatBoardActiveRunText(role, intl.formatMessage);
  return (
    <Badge
      variant="secondary"
      data-board-active-run={role}
      data-board-overflow-clip=""
      title={text}
      className="min-w-0 max-w-full"
    >
      <span data-board-overflow-ellipsis="" className="min-w-0 truncate">
        {text}
      </span>
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
        // 合并徽章（#54-5）：单一视觉单元，两个锚点各保留原值；省略号形态与缺口徽章一致（#59 S-3(a)）。
        <Badge
          variant="outline"
          data-board-attention="unmerged-worktree"
          data-board-blockers={blockers}
          data-board-overflow-clip=""
          title={intl.formatMessage({ id: "board.attention.unmergedBlocked" })}
          className="min-w-0 max-w-full border-warning/40 bg-warning/10 text-warning"
        >
          <span data-board-overflow-ellipsis="" className="min-w-0 truncate">
            {intl.formatMessage({ id: "board.attention.unmergedBlocked" })}
          </span>
        </Badge>
      ) : (
        <BoardBlockerBadge count={blockers} />
      )}
      {activeRunRole ? <BoardActiveRunBadge role={activeRunRole} /> : null}
      {showStatusDot ? <BoardStatusDot status={status} /> : null}
    </span>
  );
}

/** 计数片外观单点（稿层「张卡」与层头「稿/期」同一形态；lightweight 只调底色强调度）。 */
const COUNT_CHIP_CLASS =
  "shrink-0 rounded-md px-1.5 py-0.5 text-ui-xs tabular-nums text-foreground-subtle";

/**
 * 折叠指示符（#55 S-3；#87 起树形容器头/稿块使用；A4-1b 起与列表分组头共用一份——届时替换 BoardListView 内联件）：原生 `<details>/<summary>`
 * 已向辅助技术暴露展开态，缺的是**视觉**指示符——装饰性 chevron（`aria-hidden`，`group-open:`
 * 旋转），不写伪 `aria-expanded`、不夺由内容构成的可及名称。宿主 `<details>` 必须带 `group` 类。
 */
export function BoardFoldIndicator() {
  return (
    <span
      aria-hidden="true"
      data-board-fold-indicator=""
      className="shrink-0 text-ui-xs text-foreground-subtle transition-transform group-open:rotate-90"
    >
      ▸
    </span>
  );
}

/**
 * epic 登记行终态标注词条（§10.5；A4-1）：只认登记行枚举值（cancelled/archived）——
 * 不认识的取值不标注（不猜语义、不把未知值当进行态）。cancelled 复用 `board.status.cancelled`
 * （同词同义）；archived 只在 epic 壳层出现，单列键。
 */
const LAYER_STATUS_MESSAGE_IDS: Record<string, string> = {
  cancelled: "board.status.cancelled",
  archived: "board.epic.archived",
};

/**
 * 容器层头（卡 #87 / A4-1 tracer 接口；A4-1b 三视图复用同一份，禁二份实现）：
 * 三层容器的 epic / 期次层头身份与计数。
 *
 * 层名渲染进**稿层编号位**（`BoardNodeNumber` 同位同款）：epic 层 = 4 位登记码（`KANB`）；
 * 期次层 = 显示层双字段合成名（`KANB1`，AD-3）——合成名只作容器层名，不进卡编号命名空间（AD-2）。
 * 计数片走层词条（`board.layer.*`）：epic 层 = 稿数 + 期数两片；期次层 = 稿数一片。
 * 层头不是卡：无号、无段位；终态标注（§10.5）也在这份零件里渲染（占段位徽章位，登记行 `status` 唯一承载）。
 */
export interface BoardGroupHeaderLayer {
  kind: "epic" | "phase";
  /** 层名（显示层）：epic 码（`KANB`）/ 期次合成名（`KANB1`）。 */
  name: string;
  /** 稿数（epic 层 = 成员稿数；期次层 = 该期稿数）——层实际承载的成员数。 */
  planCount: number;
  /** 期次数（epic 层次级片）；phase 层不传/传 null（不渲染该片）。 */
  phaseCount?: number | null;
  /**
   * 层终态（§10.5；当前只有 epic 层承载）：登记行 `status` 原值——`cancelled`/`archived`
   * 渲染终态标注（词条单点在零件内），其余/缺省不标注。**成员活跃不复活终态**：这里只读登记行。
   */
  status?: string | null;
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
 *
 * 计数片二选一（#87：`layer` 与 `cardCount` 互斥的判别联合）——层头传 `layer`（层名 + 层计数），
 * 稿层传 `cardCount`（`[N 张卡]`，四视图现状）；不给两条计数路径并存的机会。
 */
export type BoardFeatureGroupHeaderContentProps = {
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
} & (
  | { layer: BoardGroupHeaderLayer; cardCount?: never }
  | { layer?: null | undefined; cardCount: number }
);

export function BoardFeatureGroupHeaderContent(props: BoardFeatureGroupHeaderContentProps) {
  const {
    feature,
    layer = null,
    lightweight = false,
    titleRegionProps = null,
    titleClassName,
    titleAccessory = null,
  } = props;
  const { intl } = useZCodeIntl();
  // 层终态标注（只认登记行枚举值；未知取值不标注）。
  const layerStatusMessageId =
    layer?.status != null ? (LAYER_STATUS_MESSAGE_IDS[layer.status] ?? null) : null;
  /**
   * 计数片二选一（#87 判别联合）：条件必须是 `props.layer`（对 props 本身判别）——
   * 这样 else 分支里 `props.cardCount` 才被收窄为 `number`，两条计数路径不可能并存。
   */
  const countChips = props.layer ? (
    <>
      {props.layer.phaseCount === undefined || props.layer.phaseCount === null ? null : (
        <span
          data-board-layer-phase-count={props.layer.phaseCount}
          className={cn(COUNT_CHIP_CLASS, lightweight ? "" : "bg-surface")}
        >
          {intl.formatMessage({ id: "board.layer.phaseCount" }, { count: props.layer.phaseCount })}
        </span>
      )}
      <span
        data-board-layer-plan-count={props.layer.planCount}
        className={cn(COUNT_CHIP_CLASS, lightweight ? "" : "bg-surface")}
      >
        {intl.formatMessage({ id: "board.layer.planCount" }, { count: props.layer.planCount })}
      </span>
    </>
  ) : (
    <span
      data-board-feature-card-count={props.cardCount}
      className={cn(COUNT_CHIP_CLASS, lightweight ? "" : "bg-surface")}
    >
      {intl.formatMessage({ id: "board.feature.cardCount" }, { count: props.cardCount })}
    </span>
  );
  const numberAndTitle = (
    <>
      {layer ? (
        // 层头身份位（A4-1）：epic 码 / 期次合成名——与稿层编号同位同款（mono 小字弱强调）。
        <span
          data-board-layer-kind={layer.kind}
          data-board-layer-name={layer.name}
          className="shrink-0 font-mono text-ui-xs text-foreground-subtle"
        >
          {layer.name}
        </span>
      ) : (
        <BoardNodeNumber
          no={feature.no}
          label={feature.label}
          planCode={feature.planCode}
          variant="feature"
        />
      )}
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
      {layerStatusMessageId ? (
        // 层终态标注（#87；§10.5）：占段位徽章位——层不是卡，没有段位；终态由登记行唯一承载。
        <Badge variant="secondary" data-board-layer-status={layer?.status ?? null}>
          {intl.formatMessage({ id: layerStatusMessageId })}
        </Badge>
      ) : lightweight ? null : (
        <BoardStageBadge stage={feature.stage} />
      )}
      <BoardNodeBadges
        attention={feature.attention}
        blockers={feature.blockers.length}
        lastRun={null}
        draft={false}
        activeRunRole={null}
        status={feature.status}
        {...(lightweight ? { className: "opacity-70" } : {})}
      />
      {countChips}
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
              // 长角色名防线（#59 N2）：角色文本自身可截断、全文进 title，行高与扫读稳定。
              title={role}
              className={cn(
                "min-w-0 max-w-full truncate text-ui-xs",
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
