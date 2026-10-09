/**
 * 项目看板面板（卡 #32）：按固定路径读 <工作目录>/.zcode/board/board.json 的只读树形视图。
 *
 * 读取时机（消费契约 §1）：面板打开（挂载）/ 聚焦（切到该标签、窗口重新聚焦）时重读；
 * 另提供手动刷新（§1 时机 3 的无监听兜底）。本面板不监听 `.zcode/worktrees/`（契约 §7.4），
 * 也不写任何文件（§7.1）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { BoardPaneView } from "./BoardPaneView.js";
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
  // 读数防竞态：旧请求的结果不得覆盖新请求（切工作区/连续刷新都会触发并发读）。
  const requestSeqRef = useRef(0);

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

  // 时机 1/2：从非聚焦变为聚焦（切回该标签）时重读一次；挂载态由上面的 effect 负责，不重复。
  const wasFocusedRef = useRef(false);
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

  return <BoardPaneView state={state} onRefresh={() => void refresh()} />;
}
