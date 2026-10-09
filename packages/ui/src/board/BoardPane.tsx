/**
 * 项目看板面板（卡 #32 树形只读视图；卡 #33 增看板/列表两视图与视图切换）。
 *
 * 读取时机（消费契约 §1）：面板打开（挂载）/ 聚焦（切到该标签、窗口重新聚焦）时重读；
 * 另提供手动刷新（§1 时机 3 的无监听兜底）。本面板不监听 `.zcode/worktrees/`（契约 §7.4），
 * 也不写任何文件（§7.1）。
 *
 * 视图状态（卡 #33）：视图模式记 sessionStorage（面板切标签会卸载，组件 state 保不住），
 * 列表的过滤/排序是本次打开内的临时状态（需求只要求「切换状态会话内保持」）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { BoardPaneView } from "./BoardPaneView.js";
import { readBoardViewMode, writeBoardViewMode } from "./boardViewModeMemory.js";
import {
  EMPTY_BOARD_LIST_CONTROLS,
  type BoardListControls,
  type BoardViewMode,
} from "./boardViewsViewModel.js";
import { loadBoardDocument, type BoardPaneLoadState } from "./loadBoardDocument.js";

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
  // 列表过滤/排序：本次打开期间的临时状态（切视图不丢；关面板即回到默认）。
  const [listControls, setListControls] = useState<BoardListControls>(EMPTY_BOARD_LIST_CONTROLS);
  // 读数防竞态：旧请求的结果不得覆盖新请求（切工作区/连续刷新都会触发并发读）。
  const requestSeqRef = useRef(0);

  const handleViewModeChange = useCallback((mode: BoardViewMode) => {
    writeBoardViewMode(mode);
    setViewMode(mode);
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

  return (
    <BoardPaneView
      state={state}
      viewMode={viewMode}
      onViewModeChange={handleViewModeChange}
      listControls={listControls}
      onListControlsChange={setListControls}
      onRefresh={() => void refresh()}
    />
  );
}
