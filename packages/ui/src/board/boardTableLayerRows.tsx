/**
 * 表格层组行（#89/A4-3 自 BoardTableView 拆出）：epic / 期次两级 colSpan 组行的折叠控件装配。
 *
 * 表格无法嵌套 `<details>`（B §4.3 L-4a：两级 colSpan 组行、列配置不动），折叠 = **子行条件渲染**
 * + `BoardFoldToggleButton`（`aria-expanded` 表达状态、词条给可及名称）。层头内容走单点零件
 * `BoardFeatureGroupHeaderContent` 的 `layer` 变体；折叠默认态与用户覆盖由调用方解析后传入
 * （判据在 `boardFoldState` 单点，本模块不重算缺口/段位）。拆文件理由同 `boardFoldParts`
 * （行数上限；组件语义不变）。
 */
import { cn } from "@/components/lib/utils.js";
import { boardLayerFeatureStub } from "./boardEpicLayerSections.js";
import { boardEpicOpenProps } from "./boardCardInteraction.js";
import { boardLayerGapCount, type BoardEpicItemContainer } from "./boardEpicContainers.js";
import { boardEpicFoldId, boardPhaseFoldId } from "./boardFoldState.js";
import { BoardFoldToggleButton } from "./boardFoldParts.js";
import { BoardFeatureGroupHeaderContent } from "./boardNodeParts.js";
import type { BoardListGroup } from "./boardViewsViewModel.js";

/**
 * epic 层组行（#168 三层容器第一层；表格形态 = colSpan 全列的单行 `<tbody>`）：层名（登记码）+
 * 登记行标题 + 终态标注 + 稿数/期数；**层不是卡**：无卡片锚点——名/标题区开 epic 概览（#90/A4-4
 * 退化形态同 tree，`onOpenEpic`），折叠按钮仍只管折叠。
 * 折叠（#89/A4-3）：层组行是真折叠控件（`aria-expanded` + 共享按钮零件），折叠 = 子行条件渲染
 * （表格无法嵌套 `<details>`）；折叠态仍显示层计数（收起不等于信息消失）。
 */
export function BoardTableEpicRow({
  container,
  columnCount,
  expanded,
  onToggle,
  onOpenEpic,
  highlighted = false,
}: {
  container: BoardEpicItemContainer<BoardListGroup>;
  columnCount: number;
  expanded: boolean;
  onToggle?: ((foldId: string, open: boolean) => void) | undefined;
  /** epic 层头开弹窗回传（#90/A4-4；仅 epic 行——名/标题区成落点，折叠按钮仍只管折叠）。 */
  onOpenEpic?: (code: string) => void;
  /** 跳转/下钻高亮落点（#90/A4-4：层名命中 = 本行）。 */
  highlighted?: boolean;
}) {
  return (
    <tbody
      data-board-epic={container.epic.code}
      data-board-epic-block={container.epic.code}
      {...(highlighted ? { "data-board-layer-highlight": "true" } : {})}
    >
      <tr
        data-board-epic-summary={container.epic.code}
        // 高亮底色落在行上（F1-90：与 tree/list/kanban 的 `bg-warning/15` 同款；cn 后写覆盖恒定底）。
        className={cn(
          "border-b border-border/40 bg-surface/50",
          highlighted ? "bg-warning/15" : "",
        )}
      >
        <td colSpan={columnCount} className="px-2 py-1.5">
          {/* 溢出防线锚点（#59 S-4）：组行内容允许折行，不撑破表格盒。 */}
          <div data-board-overflow-wrap="" className="flex min-w-0 items-center gap-2">
            <BoardFoldToggleButton
              foldId={boardEpicFoldId(container.epic.code)}
              name={container.epic.code}
              expanded={expanded}
              layer
              {...(onToggle ? { onToggle } : {})}
            />
            <BoardFeatureGroupHeaderContent
              feature={boardLayerFeatureStub(container.epic.title)}
              layer={{
                kind: "epic",
                name: container.epic.code,
                planCount: container.items.length,
                phaseCount: container.phases.length,
                gapCount: boardLayerGapCount(container.items.map((group) => group.feature)),
                status: container.epic.status,
              }}
              {...(onOpenEpic
                ? {
                    titleRegionProps: {
                      "data-board-epic-open": container.epic.code,
                      ...boardEpicOpenProps({ code: container.epic.code, onOpenEpic }),
                    },
                  }
                : {})}
            />
          </div>
        </td>
      </tr>
    </tbody>
  );
}

/** 期次层组行（第二层；缩进一档，层名 = AD-3 合成名 + 该期实际承载稿数；层不是卡）。 */
export function BoardTablePhaseRow({
  phase,
  epicCode,
  columnCount,
  expanded,
  onToggle,
  highlighted = false,
}: {
  phase: BoardEpicItemContainer<BoardListGroup>["phases"][number];
  /** 所属 epic 码（折叠 id = `phase:<码>#<期次序>`）。 */
  epicCode: string;
  columnCount: number;
  expanded: boolean;
  onToggle?: ((foldId: string, open: boolean) => void) | undefined;
  /** 跳转/下钻高亮落点（#90/A4-4：期次名命中 = 本行）。 */
  highlighted?: boolean;
}) {
  return (
    <tbody
      data-board-phase={phase.name}
      data-board-phase-block={phase.name}
      {...(highlighted ? { "data-board-layer-highlight": "true" } : {})}
    >
      <tr
        data-board-phase-summary={phase.name}
        // 高亮底色落在行上（F1-90：与 tree/list/kanban 的 `bg-warning/15` 同款）。
        className={cn("border-b border-border/40", highlighted ? "bg-warning/15" : "")}
      >
        <td colSpan={columnCount} className="px-2 py-1.5 pl-5">
          <div data-board-overflow-wrap="" className="flex min-w-0 items-center gap-2">
            <BoardFoldToggleButton
              foldId={boardPhaseFoldId(epicCode, phase.phase)}
              name={phase.name}
              expanded={expanded}
              layer
              {...(onToggle ? { onToggle } : {})}
            />
            <BoardFeatureGroupHeaderContent
              feature={boardLayerFeatureStub("")}
              layer={{
                kind: "phase",
                name: phase.name,
                planCount: phase.items.length,
                gapCount: boardLayerGapCount(phase.items.map((group) => group.feature)),
              }}
              titleSize="xsSubtle"
            />
          </div>
        </td>
      </tr>
    </tbody>
  );
}
