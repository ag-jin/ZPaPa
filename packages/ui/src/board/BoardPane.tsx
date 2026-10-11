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
 * - 派发此卡（卡 #186；用户原话「直接引用卡片让会话去安排」）：弹窗内主入口与指引面队列行尾
 *   次入口都只把**卡引用**写进会话输入框草稿（`boardCardDispatch` + 既有文本注入通道的 store
 *   动作），本面板照旧**不写任何文件**、不自动执行、不绕编排者裁决；目标会话由消费侧
 *   `selectComposerTextInsertRequest` 单点判定（当前焦点会话，无会话时落草稿输入框）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { BoardPaneView } from "./BoardPaneView.js";
import { dispatchBoardCardReference, type BoardCardDispatchCard } from "./boardCardDispatch.js";
import {
  boardCardDialogKeyIntent,
  resolveBoardDialogNode,
  type BoardJumpTarget,
} from "./boardDialogViewModel.js";
import {
  boardCardSelector,
  boardEpicOpenSelector,
  boardPhaseSelector,
  boardRevealDetailsIntent,
  boardRevealKanbanColumnIntent,
  nextBoardCardHighlight,
  type BoardCardHighlightState,
} from "./boardCardInteraction.js";
import { phaseDisplayName } from "./boardEpicContainers.js";
import {
  boardFoldIdsOfCard,
  boardFoldIdsOfPhase,
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
import { boardGuideSlotDrilldownTarget, type BoardGuideSlotKey } from "./boardGuideViewModel.js";
import { loadBoardDocument, type BoardPaneLoadState } from "./loadBoardDocument.js";
import {
  applyBoardCardDetails,
  BoardCardDetailCache,
  findBoardTaskByNo,
  loadBoardCardDetail,
  resolveBoardCardDetailState,
} from "./boardCardDetail.js";
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
  // 卡详情按需读缓存（#219/D6）：每面板一份，代际 = 工作目录 + INDEX.updatedAt；
  // 板重编译（updatedAt 变）→ 换代整表失效；同会话内同卡不重复读。
  const cardDetailCacheRef = useRef(new BoardCardDetailCache());
  // 同代重试中的卡（#220/D7）：重读期间保留上次「暂不可读」呈现，不闪回 #183「板上未携带」假空态。
  const pendingDetailNosRef = useRef(new Set<number>());
  // 缓存内容变化（换代清空 / 新卡读到）时触发重渲染的修订号——缓存是 ref（渲染期读它），需显式驱动。
  const [detailRevision, setDetailRevision] = useState(0);
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
  // epic 弹窗打开态（#90/A4-4：宿主只持 epic 码；与卡片弹窗互斥——开一个关另一个）。
  const [openEpicCode, setOpenEpicCode] = useState<string | null>(null);
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
    setOpenEpicCode(null);
    setOpenCardId(id);
  }, []);
  const handleCloseCard = useCallback(() => {
    setOpenCardId(null);
    const opener = dialogOpenerRef.current;
    dialogOpenerRef.current = null;
    if (opener && opener.isConnected) opener.focus();
  }, []);
  // epic 弹窗的打开者记录同款（锚点 = `data-board-epic-open`，值 = epic 码）。
  const epicDialogOpenerRef = useRef<HTMLElement | null>(null);
  const handleOpenEpic = useCallback((code: string) => {
    epicDialogOpenerRef.current =
      typeof document === "undefined"
        ? null
        : document.querySelector<HTMLElement>(boardEpicOpenSelector(code));
    setOpenCardId(null);
    setOpenEpicCode(code);
  }, []);
  const handleCloseEpic = useCallback(() => {
    setOpenEpicCode(null);
    const opener = epicDialogOpenerRef.current;
    epicDialogOpenerRef.current = null;
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

  // 指引面五槽下钻（卡 #137/C3-2）：落点判据在纯函数 `boardGuideSlotDrilldownTarget` 一处
  // （视图 + 既有列表控制），宿主只消费既有两条派发路径——`handleListControlsChange`
  // （列表/表格的过滤/排序，含排序会话记忆）与 `handleViewModeChange`（视图模式，含会话记忆）。
  // 不新造导航状态、不复制路由：指引面回传意图，切视图与落点的唯一所有者仍是宿主这一份状态。
  const handleDrillToSlot = useCallback(
    (slot: BoardGuideSlotKey) => {
      const target = boardGuideSlotDrilldownTarget(slot);
      // 落点确定：列表/表格目标写显式控制（不吃上一次留下的筛子）；看板目标不消费列表控制
      // ——不把用户没选的排序写进会话记忆。
      if (target.controls) handleListControlsChange(target.controls);
      handleViewModeChange(target.mode);
    },
    [handleListControlsChange, handleViewModeChange],
  );

  const refresh = useCallback(async () => {
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    const next = await loadBoardDocument({ fileService, workspacePath, isRpcReady });
    if (requestSeqRef.current !== seq) return;
    // 上次成功读取的快照（#158；E7 §7.2「未连接：保留上次快照但标陈旧」）：唯一写点在这里的
    // 成功分支；面板按 workspace 重建（宿主 key），快照不跨工作区。断连时 BoardPaneView
    // 用快照 + 状态行呈现，不清空版面；确定性判定（损坏/版本/空态）不吃快照。
    if (next.kind === "ready") lastReadyBoardRef.current = next.board;
    // 详情缓存换代（#219/D6）：代际 = 工作目录 + 板上 updatedAt；换代即清空（板重编译后旧详情失效）。
    if (next.kind === "ready") {
      const generation = `${workspacePath}\u0000${next.board.updatedAt ?? ""}`;
      if (cardDetailCacheRef.current.begin(generation)) {
        setDetailRevision((revision) => revision + 1);
      }
    }
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

  // 卡详情按需读（#219/D6；契约 §15.3）：打开弹窗（或展开队列行）时，按索引携带的 `cardFile`
  // 指针读分片，扁平卡（cardFile=null）回落旧面 board.json 内联。仅薄索引面（screen 非 null）需要——
  // 旧面 board.json 的详情本就内联，不重复读。缓存命中即不读（同会话同卡一次）。
  useEffect(() => {
    if (openCardId === null || state.kind !== "ready") return;
    const board = state.board;
    if (board.screen === null) return; // 旧面（board.json）：详情已内联
    const node = resolveBoardDialogNode(board, openCardId);
    if (!node || node.kind !== "task" || node.no === null) return;
    const no = node.no;
    if (cardDetailCacheRef.current.get(no)) return; // 缓存命中（同代）
    const task = findBoardTaskByNo(board, no);
    if (!task) return;
    let cancelled = false;
    void (async () => {
      const result = await loadBoardCardDetail({
        fileService,
        workspacePath,
        task: { no, cardFile: task.cardFile },
        isRpcReady,
      });
      if (cancelled) return;
      cardDetailCacheRef.current.set(no, result);
      pendingDetailNosRef.current.delete(no);
      setDetailRevision((revision) => revision + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [openCardId, state, detailRevision, fileService, workspacePath, isRpcReady]);

  // 卡详情同代重试（#220/D7）：清该卡缓存条目 → 上面的按需读 effect 因缓存未命中重新读取。
  // 只对 `unavailable`（暂时读不到：断连 / 板文件超限截断）提供——`missing`（确定没有）重试无意义。
  // 重读期间保留上次「暂不可读」呈现（pending 集），不闪回 #183「板上未携带」假空态。
  const handleRetryCardDetail = useCallback((no: number) => {
    pendingDetailNosRef.current.add(no);
    cardDetailCacheRef.current.delete(no);
    setDetailRevision((revision) => revision + 1);
  }, []);

  // 打开卡的详情读取态（#220/D7 major①；2026-10-12 微修：**不限定板载入面**；
  // #221/D8 归并：首开在途窗口独立 `reading`——本卡详情需按需读（薄索引面：上面 effect 会发起读取）
  // 且缓存未命中 → 「读取中」，不落 #183「板上未携带」假空态）。
  // 判据单点在 `resolveBoardCardDetailState`（只看这张卡的读取结论——缓存 / 同代重试在途 / 首开在途；
  // 扁平卡（真实板当前形态）与分片卡同口径）；`loaded` 或详情已内联 → null（弹窗按现形态渲染）。
  const openCardDetailState: "reading" | "missing" | "unavailable" | null = (() => {
    if (openCardId === null || state.kind !== "ready") return null;
    const node = resolveBoardDialogNode(state.board, openCardId);
    if (!node || node.kind !== "task" || node.no === null) return null;
    return resolveBoardCardDetailState({
      no: node.no,
      cache: cardDetailCacheRef.current,
      pendingDetailNos: pendingDetailNosRef.current,
      // 与按需读 effect 同判据：薄索引面（screen 非 null）才有按需读链；旧面详情已内联。
      expectsRead: state.board.screen !== null,
    });
  })();

  // Esc 关窗（仅打开态监听）：键位判据在纯函数，宿主只消费；关闭走对应 handle（含焦点恢复）。
  // 两弹窗互斥（开一个关另一个）——Esc 只关当前那一个（卡片优先判存在性，实际不会同时开）。
  useEffect(() => {
    if (openCardId === null && openEpicCode === null) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        boardCardDialogKeyIntent({ key: event.key, defaultPrevented: event.defaultPrevented }) !==
        "close"
      ) {
        return;
      }
      event.preventDefault();
      if (openEpicCode !== null) handleCloseEpic();
      else handleCloseCard();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [openCardId, openEpicCode, handleCloseCard, handleCloseEpic]);

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

  // epic 弹窗期次指针下钻（#90/A4-4；C4-2）：关 epic 弹窗 → 清筛子（期次被筛掉就跳了个寂寞）
  // → 展开该期次的两层祖先折叠（`boardFoldIdsOfPhase` 单点）→ 看板「已完成」列先置展开
  // （条件渲染的容器要先回 DOM）→ 期次块高亮 + 滚动（落点选择器与卡片同一条渲染链路）。
  // 目标期次**未定位**（如成员段位缺省/不认识的期次——看板列装配按 §13.2 跳过，期次块不在 DOM；
  // 指针面来自全量归组，比视图装配面宽）＝**预期 no-op**：不展开任何可见层、不滚动、不提示——
  // 滚动 effect 查不到落点自然什么都不做（折叠 id 照记、高亮时限照常自清；不做视图切换兜底，
  // 与卡片跳转的切列表口径不同）。
  const handleDrillToPhase = useCallback(
    (epicCode: string, phase: number) => {
      setOpenEpicCode(null);
      setListControls((controls) => clearBoardListFilter(controls));
      setFoldState((previous) =>
        withBoardFoldExpanded(previous, boardFoldIdsOfPhase(epicCode, phase)),
      );
      if (viewMode === "kanban") setKanbanCompletedExpanded(true);
      setHighlight((previous) =>
        nextBoardCardHighlight(previous, phaseDisplayName(epicCode, phase)),
      );
    },
    [viewMode],
  );

  // 滚动到跳转落点；高亮到点自动清除（面板重渲染不改变时限语义）。
  // 落点两类（#90/A4-4 起）：卡片（`data-board-card`）与层块（期次 `data-board-phase-block`，
  // 指针下钻的落点）——同一 highlight 状态、同一滚动/时限，选择器按锚点族各查一次。
  useEffect(() => {
    if (highlight === null) return;
    const element =
      typeof document === "undefined"
        ? null
        : (document.querySelector(boardCardSelector(highlight.id)) ??
          document.querySelector(boardPhaseSelector(highlight.id)));
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

  // 派发此卡（卡 #186）：卡片弹窗内主入口 + 指引面队列行尾次入口共用这一条写路径。
  // 只把**卡引用**写进会话输入框草稿（唯一写路径 = 既有文本注入通道的 store 动作，
  // append 追加保留用户已输入内容），不写任何板文件、不自动执行、不绕编排者裁决；
  // 目标会话由消费侧 `selectComposerTextInsertRequest` 的 focused 单点判定（当前焦点会话，
  // 无会话时落草稿输入框），宿主不猜 session id。
  const handleDispatchCard = useCallback(
    (card: BoardCardDispatchCard) => {
      dispatchBoardCardReference({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        card,
        insert: useZCodeSessionStore.getState().requestComposerTextInsert,
      });
    },
    [workspaceIdentity, workspacePath],
  );

  // 详情补丁合并（#219/D6）：把已按需读到的卡详情合回视图模型，下游（弹窗/列表/表格）无感知。
  // 仅薄索引面（screen 非 null）需要；旧面详情已内联。`detailRevision` 驱动合并后的重渲染。
  const enrichedState: BoardPaneLoadState =
    state.kind === "ready" && state.board.screen !== null
      ? {
          kind: "ready",
          board: applyBoardCardDetails(state.board, cardDetailCacheRef.current.patches()),
        }
      : state;

  return (
    <BoardPaneView
      state={enrichedState}
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
      onDispatchCard={handleDispatchCard}
      openCardDetailState={openCardDetailState}
      onRetryCardDetail={handleRetryCardDetail}
      onDrillToSlot={handleDrillToSlot}
      highlightCardId={highlight?.id ?? null}
      kanbanCompletedExpanded={kanbanCompletedExpanded}
      onKanbanCompletedExpandedChange={setKanbanCompletedExpanded}
      fold={{ state: foldState, onToggle: handleFoldToggle }}
      unavailableSnapshot={state.kind === "unavailable" ? lastReadyBoardRef.current : null}
      openEpicCode={openEpicCode}
      onOpenEpic={handleOpenEpic}
      onCloseEpic={handleCloseEpic}
      onDrillToPhase={handleDrillToPhase}
      onRefresh={() => void refresh()}
    />
  );
}
