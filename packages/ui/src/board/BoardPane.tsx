/**
 * 项目看板面板（卡 #32 树形只读视图；卡 #33 增看板/列表两视图与视图切换；
 * 卡 #34 增表格视图、卡片弹窗与依赖跳转）。
 *
 * 读取时机（消费契约 §1）：面板打开（挂载）/ 聚焦（切到该标签、窗口重新聚焦）/ 连接恢复时重读；
 * 另提供手动刷新（§1 时机 3 的无监听兜底，面板级按钮在所有空态可见）。本面板不监听
 * `.zcode/worktrees/`（契约 §7.4），也不写任何文件（§7.1）。
 *
 * 视图与打开态（卡 #33/#34）：
 * - 视图模式、表格列选择与**排序视角**记 sessionStorage（面板切标签会卸载，组件 state 保不住；
 *   排序视角自 #65 起进会话记忆）。列表/表格的**过滤条件**仍是本次打开内的临时状态
 *   （需求只要求「切换状态会话内保持」；过滤是临时视角，排序是用户显式选择）。
 * - 弹窗打开态：**宿主只持一个卡片 id**（同一时刻最多一个弹窗）；Esc 的键位判据在纯函数
 *   `boardCardDialogKeyIntent` 一处判定，这里只消费（同 `TaskFindDialog` 的 chat 浮层口径）。
 *   Tab 循环 containment 在弹窗壳内（`boardDialogTabIntent` 判边界）；关闭后焦点恢复到
 *   打开者（打开时按同一 `data-board-card` 锚点记录触发元素，#59 M4）。
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
  boardFoldIdsOfCard,
  withBoardFoldExpanded,
  withBoardFoldOpen,
  type BoardFoldState,
} from "./boardFoldState.js";
import { readBoardFoldState, writeBoardFoldState } from "./boardFoldMemory.js";
import { readBoardListSort, writeBoardListSort } from "./boardListSortMemory.js";
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
import type { BoardViewModel } from "./boardViewModel.js";

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
  // 上次成功读取的快照（#158；E7 §7.2）：断连时保留版面用；唯一写点见 refresh()。
  const lastReadyBoardRef = useRef<BoardViewModel | null>(null);
  // 视图模式：初值取会话记忆（切走再回来仍是上次看的视图），切换即记。
  const [viewMode, setViewMode] = useState<BoardViewMode>(() => readBoardViewMode());
  // 列表过滤/排序：过滤条件本次打开期间的临时状态（列表与表格共用；切视图不丢；关面板即回到默认）；
  // 排序视角初值取会话记忆（#65），切换即记——与视图模式/表格列选择同一先例。
  const [listControls, setListControls] = useState<BoardListControls>(() => ({
    ...EMPTY_BOARD_LIST_CONTROLS,
    sort: readBoardListSort(),
  }));
  // 表格列选择：会话内保持（与视图模式同一先例），切换即记。
  const [tableColumns, setTableColumns] = useState<BoardTableColumnVisibility>(() =>
    readBoardTableColumnVisibility(),
  );
  // 弹窗打开态（同一时刻至多一个）与跳转高亮落点（带 nonce：同目标重跳也重新起算）。
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  // 弹窗打开者记录（#59 M4 焦点闭环）：关闭（× / 遮罩 / Esc）后焦点回到打开它的卡片元素。
  // 打开链路 = 卡片 onClick/onKeyDown → onOpenCard(id) → 这里；触发元素按同一 `data-board-card`
  // 锚点定位（与跳转定位共用选择器）。跳转是「换目标」不是「关闭回退」——不抢目标滚动的焦点
  // （focus() 会滚动到焦点元素，会与跳转的滚动落点打架）。
  const dialogOpenerRef = useRef<HTMLElement | null>(null);
  const handleOpenCard = useCallback((id: string) => {
    dialogOpenerRef.current =
      typeof document === "undefined"
        ? null
        : document.querySelector<HTMLElement>(boardCardSelector(id));
    setOpenCardId(id);
  }, []);
  const handleCloseCard = useCallback(() => {
    setOpenCardId(null);
    const opener = dialogOpenerRef.current;
    dialogOpenerRef.current = null;
    if (opener && opener.isConnected) opener.focus();
  }, []);
  const [highlight, setHighlight] = useState<BoardCardHighlightState | null>(null);
  // 看板「已完成」列展开态（评审 #35-S1 二轮）：列改条件渲染后，折叠列里的卡不在 DOM 里，
  // 跳转揭示必须**先把展开态置真再滚**——因此展开态归宿主持有（与高亮同一次提交落在同一帧，
  // 滚动 effect 才找得到落点）。本列展开态仍随面板挂载（列级不落记忆）；分组/层折叠记忆见 foldState。
  const [kanbanCompletedExpanded, setKanbanCompletedExpanded] = useState(true);
  // 折叠默认态与记忆（#89/A4-3）：覆盖表（foldId → 用户显式展开态）初值取会话记忆；用户动作
  // 与跳转揭示都只改这一份状态，持久化集中在下面一条 effect（唯一写路径）。默认态仍由 AD-5
  // 单点规则按数据派生——没被动过的组不落键，数据变化时照新默认态走。
  const [foldState, setFoldState] = useState<BoardFoldState>(() => readBoardFoldState());
  useEffect(() => {
    writeBoardFoldState(foldState);
  }, [foldState]);
  const handleFoldToggle = useCallback((foldId: string, open: boolean) => {
    setFoldState((previous) => withBoardFoldOpen(previous, foldId, open));
  }, []);
  // 跳转揭示要按板面归属算祖先折叠层（`boardFoldIdsOfCard`）；非就绪态没有板面可算。
  const board = state.kind === "ready" ? state.board : null;
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

  // 过滤/排序控件变更：排序视角落会话记忆（#65）。幂等写入（过滤变更时写的也是当前排序值）——
  // 读回路径只有挂载一处（初值），写入点只有这里，不再多一条写路径。
  const handleListControlsChange = useCallback((controls: BoardListControls) => {
    writeBoardListSort(controls.sort);
    setListControls(controls);
  }, []);

  const refresh = useCallback(async () => {
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    const next = await loadBoardDocument({ fileService, workspacePath, isRpcReady });
    if (requestSeqRef.current !== seq) return;
    // 上次成功读取的快照（#158；E7 §7.2「未连接：保留上次快照但标陈旧」）：唯一写点在这里的
    // 成功分支；面板按 workspace 重建（宿主 key），快照不跨工作区。断连时 BoardPaneView
    // 用快照 + 状态行呈现，不清空版面；确定性判定（损坏/版本/空态）不吃快照。
    if (next.kind === "ready") lastReadyBoardRef.current = next.board;
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

  // Esc 关窗（仅打开态监听）：键位判据在纯函数，宿主只消费；关闭走 handleCloseCard（含焦点恢复）。
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
      handleCloseCard();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [openCardId, handleCloseCard]);

  // 跳转（弹窗 dependency 与提示条段落共用）：先关弹窗，再让目标卡在当前视图里「看得见」。
  const handleJumpToCard = useCallback(
    (target: BoardJumpTarget) => {
      setOpenCardId(null);
      // 过滤是临时视角：目标被筛掉就跳不到，先清筛子（排序视角保留）。
      setListControls((controls) => clearBoardListFilter(controls));
      // 折叠容器同理（#89/A4-3）：落点在折叠的层/组里就跳了个寂寞——先展开目标的祖先折叠层
      // （稿 → 期次 → epic；判据在 `boardFoldIdsOfCard` 单点）。表格的折叠层是条件渲染，
      // 展开必须走状态（DOM 侧 `details.open` 兜底只够树/列表/看板的原生折叠块）。
      if (board !== null) {
        setFoldState((previous) =>
          withBoardFoldExpanded(previous, boardFoldIdsOfCard(board, target.id)),
        );
      }
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
    [board, handleViewModeChange, viewMode],
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
      onListControlsChange={handleListControlsChange}
      tableColumns={tableColumns}
      onTableColumnsChange={handleTableColumnsChange}
      openCardId={openCardId}
      onOpenCard={handleOpenCard}
      onCloseCard={handleCloseCard}
      onJumpToCard={handleJumpToCard}
      highlightCardId={highlight?.id ?? null}
      kanbanCompletedExpanded={kanbanCompletedExpanded}
      onKanbanCompletedExpandedChange={setKanbanCompletedExpanded}
      fold={{ state: foldState, onToggle: handleFoldToggle }}
      unavailableSnapshot={state.kind === "unavailable" ? lastReadyBoardRef.current : null}
      onRefresh={() => void refresh()}
    />
  );
}
