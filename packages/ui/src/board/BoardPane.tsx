/**
 * 项目看板面板（卡 #32 树形只读视图；卡 #33 增看板/列表两视图与视图切换；
 * 卡 #34 增表格视图、卡片弹窗与依赖跳转）。
 *
 * 读取时机（消费契约 §1）：面板打开（挂载）/ 聚焦（切到该标签、窗口重新聚焦）/ 连接恢复时重读；
 * 另提供手动刷新（§1 时机 3 的无监听兜底，面板级按钮在所有空态可见）。本面板不监听
 * `.zcode/worktrees/`（契约 §7.4），也不写任何文件（§7.1）。
 *
 * 视图与打开态（卡 #33/#34）：
 * - 视图模式与表格列选择记 sessionStorage（面板切标签会卸载，组件 state 保不住）；
 *   列表/表格的过滤与排序是本次打开内的临时状态（需求只要求「切换状态会话内保持」）。
 * - 弹窗打开态：**宿主只持一个卡片 id**（同一时刻最多一个弹窗）；Esc 的键位判据在纯函数
 *   `boardCardDialogKeyIntent` 一处判定，这里只消费（同 `TaskFindDialog` 的 chat 浮层口径）。
 * - 依赖跳转与提示条段落跳转：关弹窗 → 清过滤（目标可能被筛掉）→ 必要时切列表视图
 *   （看板列不渲染无段位节点）→ 展开折叠容器（已完成列置展开态；访谈汇总子区开 `<details>`）
 *   → 高亮目标卡并滚动到它。
 *   高亮状态带 nonce（同目标重跳也重新起算）；高亮有时限，到点自动清除。
 * - 连接门禁（评审 #32-P3）：RPC 未就绪（`connectionKind === "remote-waiting"`）不发读取，
 *   呈现「暂时不可读」而不是「损坏」；连接恢复时自动重读。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { BoardPaneView } from "./BoardPaneView.js";
import { boardCardDialogKeyIntent, type BoardJumpTarget } from "./boardDialogViewModel.js";
import {
  boardCardSelector,
  boardRevealDetailsIntent,
  boardRevealKanbanColumnIntent,
  nextBoardCardHighlight,
  type BoardCardHighlightState,
} from "./boardCardInteraction.js";
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
  const { services, rpcReady } = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
  );
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
  // 弹窗打开态（同一时刻至多一个）与跳转高亮落点（带 nonce：同目标重跳也重新起算）。
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<BoardCardHighlightState | null>(null);
  // 看板「已完成」列展开态（评审 #35-S1 二轮）：列改条件渲染后，折叠列里的卡不在 DOM 里，
  // 跳转揭示必须**先把展开态置真再滚**——因此展开态归宿主持有（与高亮同一次提交落在同一帧，
  // 滚动 effect 才找得到落点）。折叠态会话记忆是可选增强，本期不做（面板卸载即回到默认展开）。
  const [kanbanCompletedExpanded, setKanbanCompletedExpanded] = useState(true);
  // 读数防竞态：旧请求的结果不得覆盖新请求（切工作区/连续刷新都会触发并发读）。
  const requestSeqRef = useRef(0);
  // 连接门禁要在**读取时刻**取最新值（断连可能发生在读取途中）：渲染期同步 ref，读取回调再读它。
  const rpcReadyRef = useRef(rpcReady);
  rpcReadyRef.current = rpcReady;
  const isRpcReady = useCallback(() => rpcReadyRef.current, []);

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
    const next = await loadBoardDocument({ fileService, workspacePath, isRpcReady });
    if (requestSeqRef.current !== seq) return;
    setState(next);
  }, [fileService, workspacePath, isRpcReady]);

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

  // 连接恢复：从「未就绪」变为就绪时重读一次（否则面板会停在「暂时不可读」上等用户手点）。
  const wasRpcReadyRef = useRef(rpcReady);
  useEffect(() => {
    const recovered = rpcReady && !wasRpcReadyRef.current;
    wasRpcReadyRef.current = rpcReady;
    if (recovered) {
      void refresh();
    }
  }, [rpcReady, refresh]);

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

  // 跳转（弹窗 dependency 与提示条段落共用）：先关弹窗，再让目标卡在当前视图里「看得见」。
  const handleJumpToCard = useCallback(
    (target: BoardJumpTarget) => {
      setOpenCardId(null);
      // 过滤是临时视角：目标被筛掉就跳不到，先清筛子（排序视角保留）。
      setListControls((controls) => clearBoardListFilter(controls));
      // 看板列视图不渲染段位缺省/不认识的节点（§13.2 未定位提示）：切列表视图兜底。
      if (boardJumpRequiresListView(viewMode, target)) {
        handleViewModeChange("list");
      }
      // 落点在看板可折叠列（已完成）里：先置展开态（条件渲染的卡要先回 DOM，滚动才有着落）。
      // 判据在纯函数一处；这里与高亮同批更新，同一帧提交后下面的 effect 才滚得动。
      if (boardRevealKanbanColumnIntent(target.stage) === "expand") {
        setKanbanCompletedExpanded(true);
      }
      // nonce：同目标重跳也是新状态（滚动与高亮时限重新起算，评审 #34-P2）。
      setHighlight((previous) => nextBoardCardHighlight(previous, target.id));
    },
    [handleViewModeChange, viewMode],
  );

  // 滚动到跳转落点；高亮到点自动清除（面板重渲染不改变时限语义）。
  useEffect(() => {
    if (highlight === null) return;
    const element =
      typeof document === "undefined"
        ? null
        : document.querySelector(boardCardSelector(highlight.id));
    if (element) {
      // 折叠容器（访谈汇总子区，<details>）里的落点：先展开再滚，否则滚到了也看不见。
      // 看板「已完成」列不在此列：它按展开态条件渲染，宿主在 handleJumpToCard 里已先置展开。
      const details = element.closest("details");
      if (boardRevealDetailsIntent(details) === "expand" && details) details.open = true;
      element.scrollIntoView({ block: "center" });
    }
    const timer = window.setTimeout(() => {
      setHighlight(null);
    }, HIGHLIGHT_DURATION_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [highlight]);

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
      highlightCardId={highlight?.id ?? null}
      kanbanCompletedExpanded={kanbanCompletedExpanded}
      onKanbanCompletedExpandedChange={setKanbanCompletedExpanded}
      onRefresh={() => void refresh()}
    />
  );
}
