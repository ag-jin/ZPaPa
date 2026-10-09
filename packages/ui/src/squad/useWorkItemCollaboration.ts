import { useCallback, useEffect, useRef, useState } from "react";
import type { SquadWorkspaceTarget, WorkItemCollaborationRead } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { resolveWorkItemCollaborationService } from "./workItemCollaborationAccess.js";

/* B5.1 轮 1：详情页协作读模型的**装载/刷新态机**（设计案 §3.4）。

   为什么把三格状态做成纯函数：ui 包没有渲染测试设施，「刷新失败保留旧值」这条纪律
   （§3.4「已有时间线保持可读；刷新失败不清空正文」）只能在纯函数上被钉住。

   状态机（四态；`ready` 的 `read === null` = 本条工作项不存在，与 `workItemId === null`
   渲染同一个 not-found 分支）：

     idle ──started──▶ loading ──succeeded(read)──▶ ready(read)
                        │                            │
                        ├──failed──▶ failed          ├──started──▶ ready(refreshing=true)   ← 保留旧数据
                        └──succeeded(null)──▶ ready(null)          └──failed──▶ ready(refreshFailure) ← 保留旧数据

   `failed` 只在**没有数据**时进入：有数据时退回 failed 会把已经读到的正文整片抹掉，
   而数据其实还在（只是这次没读到）。 */

export type WorkItemCollaborationState =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "ready";
      /** `null` = 本 workspace 内没有这条工作项（not-found 分支，不是故障）。 */
      read: WorkItemCollaborationRead | null;
      /** 后台刷新中：已有内容仍可读（非阻塞加载条），不退回骨架。 */
      refreshing: boolean;
      /** 上次刷新失败的原因（保留旧数据时的区域告警）；成功清空。 */
      refreshFailure: string | null;
    }
  | { status: "failed"; error: string };

export const WORK_ITEM_COLLABORATION_IDLE: WorkItemCollaborationState = { status: "idle" };

export function collaborationLoadStarted(
  state: WorkItemCollaborationState,
): WorkItemCollaborationState {
  return state.status === "ready"
    ? { status: "ready", read: state.read, refreshing: true, refreshFailure: null }
    : { status: "loading" };
}

export function collaborationLoadSucceeded(
  _state: WorkItemCollaborationState,
  read: WorkItemCollaborationRead | null,
): WorkItemCollaborationState {
  return { status: "ready", read, refreshing: false, refreshFailure: null };
}

export function collaborationLoadFailed(
  state: WorkItemCollaborationState,
  error: string,
): WorkItemCollaborationState {
  return state.status === "ready"
    ? { status: "ready", read: state.read, refreshing: false, refreshFailure: error }
    : { status: "failed", error };
}

export function useWorkItemCollaboration(input: {
  target: SquadWorkspaceTarget | null;
  /** `null` = 还没选中工作项（页面渲染 not-found 分支，不取数）。 */
  workItemId: string | null;
}): { state: WorkItemCollaborationState; reload: () => void } {
  const services = useServices();
  const { target, workItemId } = input;
  const [state, setState] = useState<WorkItemCollaborationState>(WORK_ITEM_COLLABORATION_IDLE);
  /* 过期响应丢弃：慢的旧请求回来时不得覆盖新 target/id 的结果（否则切条目会串数据）。 */
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    if (!target || !workItemId) {
      setState(WORK_ITEM_COLLABORATION_IDLE);
      return;
    }
    const seq = (requestSeq.current += 1);
    setState(collaborationLoadStarted);
    try {
      const service = resolveWorkItemCollaborationService(services);
      const read = await service.getWorkItemCollaboration(target, workItemId);
      if (seq !== requestSeq.current) return;
      setState((previous) => collaborationLoadSucceeded(previous, read));
    } catch (error) {
      if (seq !== requestSeq.current) return;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("[useWorkItemCollaboration] 读取协作数据失败", { error: message });
      setState((previous) => collaborationLoadFailed(previous, message));
    }
  }, [services, target, workItemId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { state, reload: () => void load() };
}
