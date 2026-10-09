/**
 * 项目看板面板（卡 #32 树形只读视图；卡 #33 增看板/列表两视图与视图切换；
 * 卡 #34 增表格视图、卡片弹窗与依赖跳转）。
 *
 * 读取时机（消费契约 §1）：面板打开（挂载）/ 聚焦（切到该标签、窗口重新聚焦）时重读；
 * 另提供手动刷新（§1 时机 3 的无监听兜底）。本面板不监听 `.zcode/worktrees/`（契约 §7.4），
 * 也不写任何文件（§7.1）。
 *
 * 视图与打开态（卡 #33/#34）：
 * - 视图模式与表格列选择记 sessionStorage（面板切标签会卸载，组件 state 保不住）；
 *   列表/表格的过滤与排序是本次打开内的临时状态（需求只要求「切换状态会话内保持」）。
 * - 弹窗打开态：**宿主只持一个卡片 id**（同一时刻最多一个弹窗）；Esc 的键位判据在纯函数
 *   `boardCardDialogKeyIntent` 一处判定，这里只消费（同 `TaskFindDialog` 的 chat 浮层口径）。
 * - 依赖跳转：关弹窗 → 清过滤（目标可能被筛掉）→ 必要时切列表视图（看板列不渲染无段位节点）
 *   → 高亮目标卡并滚动到它；高亮有时限，到点自动清除。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { BoardPaneView } from "./BoardPaneView.js";
import { boardCardDialogKeyIntent, type BoardDialogJumpTarget } from "./boardDialogViewModel.js";
import { boardCardSelector } from "./boardCardInteraction.js";
import {
  readBoardTableColumnVisibility,
  writeBoardTableColumnVisibility,
} from "./boardTableColumnMemory.js";
import type { BoardTableColumnVisibility } from "./boardTableViewModel.js";
import { readBoardViewMode, writeBoardViewMode } from "./boardViewModeMemory.js";
import {
  clearBoardListFilter,
  EMPTY_BOARD_LIST_CONTROLS,
  type BoardListControls,
  type BoardViewMode,
} from "./boardViewsViewModel.js";
import { boardJumpRequiresListView } from "./boardDialogViewModel.js";
import { loadBoardDocument, type BoardPaneLoadState } from "./loadBoardDocument.js";

/** 跳转高亮时限（毫秒）：滚动落点看得到即可，不长期改写卡片配色。 */
const HIGHLIGHT_DURATION_MS = 2400;

export interface BoardPaneProps {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** 面板当前可见且是活动标签：聚焦时按契约 §1 重读。 */
  focused: boolean;
}

export function BoardPane({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  focused,
}: BoardPaneProps) {
  const services = useWorkspaceServices(workspacePath, remoteSessionId, workspaceIdentity);
  const fileService = services.fileService;
  const [state, setState] = useState<BoardPaneLoadState>({ kind: "loading" });
  // 视图模式：初值取会话记忆（切走再回来仍是上次看的视图），切换即记。
  const [viewMode, setViewMode] = useState<BoardViewMode>(() => readBoardViewMode());
  // 列表过滤/排序：本次打开期间的临时状态（列表与表格共用；切视图不丢；关面板即回到默认）。
  const [listControls, setListControls] = useState<BoardListControls>(EMPTY_BOARD_LIST_CONTROLS);
  // 表格列选择：会话内保持（与视图模式同一先例），切换即记。
  const [tableColumns, setTableColumns] = useState<BoardTableColumnVisibility>(() =>
    readBoardTableColumnVisibility(),
  );
  // 弹窗打开态（同一时刻至多一个）与跳转高亮落点。
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [highlightCardId, setHighlightCardId] = useState<string | null>(null);
  // 读数防竞态：旧请求的结果不得覆盖新请求（切工作区/连续刷新都会触发并发读）。
  const requestSeqRef = useRef(0);

  const handleViewModeChange = useCallback((mode: BoardViewMode) => {
    writeBoardViewMode(mode);
    setViewMode(mode);
  }, []);

  const handleTableColumnsChange = useCallback((columns: BoardTableColumnVisibility) => {
    writeBoardTableColumnVisibility(columns);
    setTableColumns(columns);
  }, []);

  const refresh = useCallback(async () => {
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    const next = await loadBoardDocument({ fileService, workspacePath });
    if (requestSeqRef.current !== seq) return;
    setState(next);
  }, [fileService, workspacePath]);

  // 时机 1：面板打开（挂载）即读。
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 时机 1/2：从非聚焦变为聚焦（切回该标签）时重读一次。
  // 初值取当前 focused：挂载时若面板本就是聚焦态，上面的挂载 effect 已经读过，
  // 这里不能再把「挂载」误判成「刚从非聚焦变为聚焦」而重复读一次。
  const wasFocusedRef = useRef(focused);
  useEffect(() => {
    const becameFocused = focused && !wasFocusedRef.current;
    wasFocusedRef.current = focused;
    if (becameFocused) {
      void refresh();
    }
  }, [focused, refresh]);

  // 时机 2：窗口重新聚焦时重读（仅面板可见时监听）。
  useEffect(() => {
    if (!focused) return;
    const handleWindowFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", handleWindowFocus);
    return () => {
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [focused, refresh]);

  // Esc 关窗（仅打开态监听）：键位判据在纯函数，宿主只消费。
  useEffect(() => {
    if (openCardId === null) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        boardCardDialogKeyIntent({ key: event.key, defaultPrevented: event.defaultPrevented }) !==
        "close"
      ) {
        return;
      }
      event.preventDefault();
      setOpenCardId(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [openCardId]);

  // 依赖跳转：先关弹窗，再让目标卡在当前视图里「看得见」。
  const handleJumpToCard = useCallback(
    (target: BoardDialogJumpTarget) => {
      setOpenCardId(null);
      // 过滤是临时视角：目标被筛掉就跳不到，先清筛子（排序视角保留）。
      setListControls((controls) => clearBoardListFilter(controls));
      // 看板列视图不渲染段位缺省/不认识的节点（§13.2 未定位提示）：切列表视图兜底。
      if (boardJumpRequiresListView(viewMode, target)) {
        handleViewModeChange("list");
      }
      setHighlightCardId(target.id);
    },
    [handleViewModeChange, viewMode],
  );

  // 滚动到跳转落点；高亮到点自动清除（面板重渲染不改变时限语义）。
  useEffect(() => {
    if (highlightCardId === null) return;
    const element =
      typeof document === "undefined"
        ? null
        : document.querySelector(boardCardSelector(highlightCardId));
    element?.scrollIntoView({ block: "center" });
    const timer = window.setTimeout(() => {
      setHighlightCardId(null);
    }, HIGHLIGHT_DURATION_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [highlightCardId]);

  return (
    <BoardPaneView
      state={state}
      viewMode={viewMode}
      onViewModeChange={handleViewModeChange}
      listControls={listControls}
      onListControlsChange={setListControls}
      tableColumns={tableColumns}
      onTableColumnsChange={handleTableColumnsChange}
      openCardId={openCardId}
      onOpenCard={setOpenCardId}
      onCloseCard={() => setOpenCardId(null)}
      onJumpToCard={handleJumpToCard}
      highlightCardId={highlightCardId}
      onRefresh={() => void refresh()}
    />
  );
}
