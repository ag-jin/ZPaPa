/**
 * epic 弹窗（卡 #90 / A4-4；AD-6「epic 弹窗退化形态：指针下钻，不自算段位」+ C4-2）。
 *
 * 「退化」的边界（A4-1 已定）：epic **不是卡**——没有稳定号，所以不走卡片弹窗那条路由
 * （不做 `boardCardOpenProps` / `data-board-card` 落点，也不伪装成卡片）；弹窗内容也只有
 * epic 真有的事实：名 + 计数（N 期次 · M 卡）+ rollup 缺口徽章（头行整段复用组头单点零件）
 * + **段位构成**（AD-6「rollup 段位入 L2 层」）+ **期次指针**（点即下钻到该期次容器）。
 * 没有 run/lastRun/证据/时间线区块——不编造 epic 层不存在的字段。
 *
 * 不自算段位：构成只按成员**已有段位词**分布（`boardLayerStageComposition`），不合成
 * 「epic 段位」这类词表外概念；终态标注只认登记行枚举（`boardEpicStatusMessageId`）。
 *
 * 外壳与区块壳走共用单点 `BoardDialogShell`（与卡片弹窗同一份）；Esc 判据复用
 * `boardCardDialogKeyIntent`（宿主消费），壳内不判第二遍键位。
 */
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { BoardDialogShell, DialogSection } from "./BoardDialogShell.js";
import { buildBoardEpicDialog } from "./boardDialogViewModel.js";
import { boardLayerFeatureStub } from "./boardEpicLayerSections.js";
import { BoardFeatureGroupHeaderContent } from "./boardNodeParts.js";
import { formatBoardStageText } from "./boardPresentation.js";
import type { BoardViewModel } from "./boardViewModel.js";

export interface BoardEpicDialogProps {
  board: BoardViewModel;
  /** epic 登记码（打开态宿主持有此码；无登记行 → 什么都不渲染，不留幽灵弹窗）。 */
  code: string;
  /** 关闭（× / 遮罩 / 宿主消费的 Esc）。 */
  onClose?: () => void;
  /** 期次指针下钻（展开该期次祖先层并滚动/高亮到容器，由宿主执行）。 */
  onDrillToPhase?: (epicCode: string, phase: number) => void;
}

export function BoardEpicDialog({ board, code, onClose, onDrillToPhase }: BoardEpicDialogProps) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const model = buildBoardEpicDialog(board, code);
  if (model === null) return null;
  const close = onClose ?? (() => {});
  return (
    <BoardDialogShell
      ariaLabel={model.title}
      identityProps={{ "data-board-epic-dialog": model.code }}
      onClose={close}
    >
      {/* 头行 = 组头单点零件的 epic 层变体（名 + 计数 + rollup 缺口 + 终态）——弹窗不另拼一份。 */}
      <div data-board-dialog-section="header" className="flex items-start gap-2 px-3 py-2">
        <BoardFeatureGroupHeaderContent
          feature={boardLayerFeatureStub(model.title)}
          layer={{
            kind: "epic",
            name: model.code,
            planCount: model.planCount,
            phaseCount: model.phaseCount,
            gapCount: model.gapCount,
            status: model.status,
          }}
          titleSize="sm"
        />
        <Button
          autoFocus
          type="button"
          size="icon-sm"
          variant="ghost"
          data-board-epic-dialog-close="button"
          aria-label={t("board.dialog.close")}
          onClick={close}
        >
          <XIcon className="size-4" />
        </Button>
      </div>
      {model.composition.length > 0 ? (
        // 段位构成（L2 rollup；AD-6「rollup 段位入 L2 层」）：成员已有段位词的分布，不自算 epic 段位。
        <DialogSection name="composition" title={t("board.epic.dialog.rollup")}>
          <ul
            data-board-epic-dialog-composition=""
            className="flex flex-wrap items-center gap-x-3 gap-y-1"
          >
            {model.composition.map((row) => (
              <li
                key={row.stage ?? "__no_stage__"}
                {...(row.stage === null
                  ? { "data-board-epic-dialog-stage-none": row.count }
                  : { "data-board-epic-dialog-stage": row.stage })}
                className="flex items-baseline gap-1 text-ui-xs"
              >
                <span className="text-foreground">
                  {row.stage === null
                    ? t("board.epic.dialog.noStage")
                    : (formatBoardStageText(row.stage, intl.formatMessage) ?? row.stage)}
                </span>
                <span className="tabular-nums text-foreground-subtle">{row.count}</span>
              </li>
            ))}
          </ul>
        </DialogSection>
      ) : null}
      {model.phases.length > 0 ? (
        // 期次指针（C4-2 指针下钻）：整行是按钮——点即下钻到该期次容器；行内计数/缺口仍走组头零件。
        <DialogSection name="phases" title={t("board.epic.dialog.phases")}>
          <ul className="flex flex-col gap-1">
            {model.phases.map((pointer) => (
              <li key={pointer.name}>
                <button
                  type="button"
                  data-board-epic-drill={pointer.name}
                  aria-label={intl.formatMessage(
                    { id: "board.epic.dialog.drill" },
                    { name: pointer.name },
                  )}
                  onClick={() => onDrillToPhase?.(model.code, pointer.phase)}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-surface-hover focus-visible:bg-surface-hover"
                >
                  <BoardFeatureGroupHeaderContent
                    feature={boardLayerFeatureStub("")}
                    layer={{
                      kind: "phase",
                      name: pointer.name,
                      planCount: pointer.planCount,
                      gapCount: pointer.gapCount,
                    }}
                  />
                </button>
              </li>
            ))}
          </ul>
        </DialogSection>
      ) : null}
    </BoardDialogShell>
  );
}
