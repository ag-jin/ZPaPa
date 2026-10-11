/**
 * 表格层组行（#89/A4-3 自 BoardTableView 拆出）：epic / 期次两级 colSpan 组行的折叠控件装配。
 *
 * 表格无法嵌套 `<details>`（B §4.3 L-4a：两级 colSpan 组行、列配置不动），折叠 = **子行条件渲染**
 * + `BoardFoldToggleButton`（`aria-expanded` 表达状态、词条给可及名称）。层头内容走单点零件
 * `BoardFeatureGroupHeaderContent` 的 `layer` 变体；折叠默认态与用户覆盖由调用方解析后传入
 * （判据在 `boardFoldState` 单点，本模块不重算缺口/段位）。拆文件理由同 `boardFoldParts`
 * （行数上限；组件语义不变）。
 */
import { boardLayerFeatureStub } from "./boardEpicLayerSections.js";
import type { BoardEpicItemContainer } from "./boardEpicContainers.js";
import { boardEpicFoldId, boardPhaseFoldId } from "./boardFoldState.js";
import { BoardFoldToggleButton } from "./boardFoldParts.js";
import { BoardFeatureGroupHeaderContent } from "./boardNodeParts.js";
import type { BoardListGroup } from "./boardViewsViewModel.js";

/**
 * epic 层组行（#168 三层容器第一层；表格形态 = colSpan 全列的单行 `<tbody>`）：层名（登记码）+
 * 登记行标题 + 终态标注 + 稿数/期数；**层不是卡**：无卡片锚点、无弹窗落点（退化形态同 tree）。
 * 折叠（#89/A4-3）：层组行是真折叠控件（`aria-expanded` + 共享按钮零件），折叠 = 子行条件渲染
 * （表格无法嵌套 `<details>`）；折叠态仍显示层计数（收起不等于信息消失）。
 */
export function BoardTableEpicRow({
  container,
  columnCount,
  expanded,
  onToggle,
}: {
  container: BoardEpicItemContainer<BoardListGroup>;
  columnCount: number;
  expanded: boolean;
  onToggle?: ((foldId: string, open: boolean) => void) | undefined;
}) {
  return (
    <tbody data-board-epic={container.epic.code} data-board-epic-block={container.epic.code}>
      <tr
        data-board-epic-summary={container.epic.code}
        className="border-b border-border/40 bg-surface/50"
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
                status: container.epic.status,
              }}
              titleClassName="text-ui-sm font-medium text-foreground"
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
}: {
  phase: BoardEpicItemContainer<BoardListGroup>["phases"][number];
  /** 所属 epic 码（折叠 id = `phase:<码>#<期次序>`）。 */
  epicCode: string;
  columnCount: number;
  expanded: boolean;
  onToggle?: ((foldId: string, open: boolean) => void) | undefined;
}) {
  return (
    <tbody data-board-phase={phase.name} data-board-phase-block={phase.name}>
      <tr data-board-phase-summary={phase.name} className="border-b border-border/40">
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
              layer={{ kind: "phase", name: phase.name, planCount: phase.items.length }}
              titleClassName="text-ui-xs font-medium text-foreground-subtle"
            />
          </div>
        </td>
      </tr>
    </tbody>
  );
}
