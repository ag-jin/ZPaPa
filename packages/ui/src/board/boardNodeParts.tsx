/**
 * 看板四视图共用的节点零件（卡 #33；卡 #35 增 `BoardNodeBadges` 角标簇单点装配；
 * 卡 #90 / A4-4 把徽章簇与角标零件拆到 `boardBadgeParts`——组头零件新增让本文件逼近行数上限，
 * 拆文件不拆语义；既有导入面经下面一段**原样再导出**）。
 *
 * 本文件余下：编号零件、容器层头内容单点（含层计数片与 rollup 缺口徽章）、责任管线。
 */
import { Fragment, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { BOARD_WARNING_BADGE_CLASS, BoardNodeBadges, BoardStageBadge } from "./boardBadgeParts.js";
import {
  BOARD_COUNT_MESSAGE_IDS,
  boardEpicStatusMessageId,
  formatBoardCountText,
  formatBoardFeatureId,
  formatBoardNodeId,
} from "./boardPresentation.js";
import type { BoardAttentionCode } from "./boardViewModel.js";

/**
 * 徽章零件导入面原样再导出（拆文件不拆接口；既有调用点与测试零改动）：
 * 段位徽章 / 状态色点 / 缺口徽章 / 草案与受阻角标 / 执行角色徽记 / 角标簇。
 */
export {
  BoardActiveRunBadge,
  BoardAttentionBadges,
  BoardBlockerBadge,
  BoardDraftBadge,
  BoardNodeBadges,
  BoardStageBadge,
  BoardStatusDot,
} from "./boardBadgeParts.js";

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
/** 计数片外观单点（稿层「张卡」与层头「稿/期」同一形态；lightweight 只调底色强调度）。 */
const COUNT_CHIP_CLASS =
  "shrink-0 rounded-md px-1.5 py-0.5 text-ui-xs tabular-nums text-foreground-subtle";

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
   * rollup 缺口计数（卡 #90 / A4-4；AD-6）：该层**实际承载**成员稿的 attention 码条数之和
   * （单点 `boardLayerGapCount`）。`0`/缺省 → 不渲染缺口徽章（日常零噪声）；计数片之后渲染，
   * 与「名 + 计数 + rollup 缺口徽章」的 AD-6 形态一致。
   */
  gapCount?: number | null;
  /**
   * 层终态（§10.5；当前只有 epic 层承载）：登记行 `status` 原值——`cancelled`/`archived`
   * 渲染终态标注（词条单点在零件内），其余/缺省不标注。**成员活跃不复活终态**：这里只读登记行。
   */
  status?: string | null;
}

/**
 * 分组头所需的最小字段面：树形传原始特性节点、看板/列表传视图节点——同一零件不挑来源。
 * 层头占位面（`boardLayerFeatureStub`）在容器层模块 `boardEpicLayerSections`（#168 单点）。
 */
export interface BoardGroupHeaderFeature {
  no: number | null;
  label: string | null;
  planCode: string | null;
  title: string;
  stage: string | null;
  attention: BoardAttentionCode[];
  blockers: readonly unknown[];
  status: string | null;
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
  feature: BoardGroupHeaderFeature;
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
  // 层终态标注（只认登记行枚举值；未知取值不标注）——判据单点在 `boardPresentation`（弹窗同用）。
  const layerStatusMessageId = boardEpicStatusMessageId(layer?.status ?? null);
  /**
   * 计数片二选一（#87 判别联合）：条件必须是 `props.layer`（对 props 本身判别）——
   * 这样 else 分支里 `props.cardCount` 才被收窄为 `number`，两条计数路径不可能并存。
   */
  const countChips = props.layer ? (
    <>
      {props.layer.phaseCount === undefined || props.layer.phaseCount === null ? null : (
        <span
          data-board-layer-phase-count={props.layer.phaseCount}
          // D5 消歧（A4-4 收口）：计数片只有词条短形态，全文语义进原生 title（悬停可查）。
          title={intl.formatMessage({ id: "board.layer.phaseCountTitle" })}
          className={cn(COUNT_CHIP_CLASS, lightweight ? "" : "bg-surface")}
        >
          {formatBoardCountText(
            props.layer.phaseCount,
            BOARD_COUNT_MESSAGE_IDS.layerPhaseCount,
            intl.formatMessage,
          )}
        </span>
      )}
      <span
        data-board-layer-plan-count={props.layer.planCount}
        title={intl.formatMessage({ id: "board.layer.planCountTitle" })}
        className={cn(COUNT_CHIP_CLASS, lightweight ? "" : "bg-surface")}
      >
        {formatBoardCountText(
          props.layer.planCount,
          BOARD_COUNT_MESSAGE_IDS.layerPlanCount,
          intl.formatMessage,
        )}
      </span>
    </>
  ) : (
    <span
      data-board-feature-card-count={props.cardCount}
      className={cn(COUNT_CHIP_CLASS, lightweight ? "" : "bg-surface")}
    >
      {formatBoardCountText(
        props.cardCount,
        BOARD_COUNT_MESSAGE_IDS.featureCardCount,
        intl.formatMessage,
      )}
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
        // 截断恢复路径（F2，A4-1 第四绿移交）：标题没有「展开全文」落点（epic 弹窗头复用本零件，
        // 同为截断形态）——截断全文进原生 title（#59 姿态「信息不丢」）；空标题（期次层无标题
        // 字段）不落空 title 属性。
        {...(feature.title ? { title: feature.title } : {})}
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
      {typeof props.layer?.gapCount === "number" && props.layer.gapCount > 0 ? (
        // rollup 缺口徽章（卡 #90 / A4-4；AD-6）：层承载成员有缺口时的计数信号——折叠态也不埋缺口。
        // 形态与卡级缺口徽章同款（warning 描边 + 省略号防线 + 全文 title）。
        <Badge
          variant="outline"
          data-board-layer-gap-count={props.layer.gapCount}
          data-board-overflow-clip=""
          title={formatBoardCountText(
            props.layer.gapCount,
            BOARD_COUNT_MESSAGE_IDS.layerGapCount,
            intl.formatMessage,
          )}
          className={BOARD_WARNING_BADGE_CLASS}
        >
          <span data-board-overflow-ellipsis="" className="min-w-0 truncate">
            {formatBoardCountText(
              props.layer.gapCount,
              BOARD_COUNT_MESSAGE_IDS.layerGapCount,
              intl.formatMessage,
            )}
          </span>
        </Badge>
      ) : null}
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
