/**
 * 三层容器层的可折叠容器块单点（卡 #168 / A4-1b）：epic 章 / 期次组 = `<details>` 容器头装配，
 * 树形（#87 落位）与看板/列表（#168 接线）共用同一份实现——层头内容走
 * `BoardFeatureGroupHeaderContent` 的 `layer` 变体（同一零件），折叠指示符走 `BoardFoldIndicator`，
 * 锚点族（`data-board-epic*` / `data-board-phase*`）只此一份。
 *
 * 为什么单列一个模块：三个 details 视图的差异只有外壳类名（列宽/缩进/间距）与层头字号——
 * 装配（details/summary/指示符/层头零件/默认展开）逐字相同，各写一份早晚对不上（CR-S3 同款纪律）。
 * 表格视图无法嵌套 `<details>`（两级 colSpan 组行形态，B §4.3 L-4a），只复用本模块的
 * `boardLayerFeatureStub` 与既有的层头零件、以及本模块导出的折叠 id 生成（`boardFoldState`），
 * 不消费本组件。折叠默认态与记忆（#89 / A4-3）就落在这一个单点上。
 */
import type { ReactNode } from "react";
import { resolveBoardFoldOpen, type BoardFoldControls } from "./boardFoldState.js";
import { BoardFoldIndicator, boardFoldSummaryClickHandler } from "./boardFoldParts.js";
import {
  BoardFeatureGroupHeaderContent,
  type BoardGroupHeaderFeature,
  type BoardGroupHeaderLayer,
  type BoardGroupHeaderTitleSize,
} from "./boardNodeParts.js";

/**
 * 层头不是卡：占位字段面（层名/标题/计数走 `layer`，其余字段恒为空）。层头实际只消费 `title`
 *（epic 层 = 登记行标题；期次层无标题字段传空串）——四个视图的容器层共用同一份 stub（CR-S2）。
 */
export function boardLayerFeatureStub(title: string): BoardGroupHeaderFeature {
  return {
    no: null,
    label: null,
    planCode: null,
    title,
    stage: null,
    attention: [],
    blockers: [],
    status: null,
  };
}

/**
 * 容器层块（epic/期次）：差异全在类名与摘要行附加属性，装配与锚点由本组件单点产出。
 * 层不是卡：章头/组头整行是折叠落点（点击路由只走折叠，不落空跳转）。
 *
 * 折叠默认态与记忆（#89 / A4-3）：默认态由调用方按 AD-5 单点规则算好传入（`defaultExpanded`；
 * 层头零件没有成员信息，本组件不自算缺口/段位），用户覆盖从宿主 `fold` 读（`resolveBoardFoldOpen`
 * 单点）。`onToggle` 把真 `<details>` 的展开态原样回传宿主（宿主持有 + 会话记忆；DOM 原生切换
 * 是唯一交互来源，不另设受控开关）。
 */
export function BoardEpicLayerSection({
  layer,
  title,
  titleSize,
  className,
  summaryClassName,
  bodyClassName,
  summaryProps,
  foldId,
  defaultExpanded,
  fold,
  children,
}: {
  layer: BoardGroupHeaderLayer;
  /** epic 层 = 登记行标题；期次层无标题字段传空串。 */
  title: string;
  /** 层头标题字号档（闭集 #60/S-2：不再透传任意类串；缺省 = 组头零件的 sm）。 */
  titleSize?: BoardGroupHeaderTitleSize;
  /** 容器外壳类（半径/边框/间距按视图与层级降档）。 */
  className: string;
  summaryClassName: string;
  bodyClassName: string;
  /** 摘要行附加属性（看板窄列的折行锚点 `data-board-overflow-wrap` 等）。 */
  summaryProps?: Record<string, string>;
  /** 折叠 id（会话记忆键）：epic 层 = `epic:<码>`；期次层 = `phase:<码>#<期次序>`。 */
  foldId: string;
  /** 默认态（AD-5 单点规则派生：缺口展开 · 含活跃期次展开 · 全完成/全取消折叠）。 */
  defaultExpanded: boolean;
  /** 宿主持有的折叠控制（会话记忆）；缺省 = 只读渲染，按默认态。 */
  fold?: BoardFoldControls;
  children: ReactNode;
}) {
  const isEpic = layer.kind === "epic";
  const open = fold ? resolveBoardFoldOpen(fold.state, foldId, defaultExpanded) : defaultExpanded;
  return (
    <details
      {...(isEpic
        ? { "data-board-epic": layer.name, "data-board-epic-block": layer.name }
        : { "data-board-phase": layer.name, "data-board-phase-block": layer.name })}
      open={open || undefined}
      className={className}
    >
      <summary
        {...(isEpic
          ? { "data-board-epic-summary": layer.name }
          : { "data-board-phase-summary": layer.name })}
        {...(summaryProps ?? {})}
        {...(fold ? { onClick: boardFoldSummaryClickHandler(fold, foldId, open) } : {})}
        className={summaryClassName}
      >
        <BoardFoldIndicator />
        <BoardFeatureGroupHeaderContent
          feature={boardLayerFeatureStub(title)}
          layer={layer}
          {...(titleSize ? { titleSize } : {})}
        />
      </summary>
      <div className={bodyClassName}>{children}</div>
    </details>
  );
}
