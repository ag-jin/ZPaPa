import { useCallback, useEffect, useRef, useState } from "react";
import type { SquadWorkspaceTarget, WorkItemReactionRecord } from "@zcode/services";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { resolveSquadRuntimeService } from "./squadRuntimeAccess.js";

/* 工作项回应的**读取**（阶段三 · T-P3-R5u）。

   为什么单独成模块（与可写的 `useWorkItemReactions` 分开）：peek 只挂**这一枚** ——
   面板零写调用这条纪律要能**按模块**咬住（`workItemPeek.test.ts` 的禁用词表扫面板源码，
   而「面板 import 了哪个模块」由本模块的拆分与结构守卫共同钉住：读路径不 import 任何写方法）。

   状态机只有三格（比协作读面简单：回应没有墓碑 / 没有「刷新失败保留旧值」这类语义）：
     （target 或 id 为空）⇒ 不读（rows=null / failure=null）
     读到 ⇒ rows = 服务面返回（**原样、插入序**；聚合是 UI 的活）
     读失败 ⇒ failure = 服务面原文（rows 保持上一次的值 —— 有数据时不把已读到的事实抹掉）

   两条纪律：
   ① **换条目先清空**：`(target, workItemId)` 一变就把 rows 置空再读 —— 上一条的回应画在新条目
      名下是静默错位（界面上没有任何错误可看），与 `workItemPeekView` 的换条目判据同款。
   ② **过期响应丢弃**：慢的旧请求回来时不得覆盖新目标的结果（切 workspace / 切条目时串数据）。

   `commitRows` 是给写路径留的**收编口**：`setWorkItemReaction` 返回的就是操作后该工作项的
   全部行，那份返回即一次最新读结果 —— 由写路径交回本层收编（行集只有这一个状态所有者，
   写路径不另建第二份行集）。

   为什么用 `useOptionalServices`（而不是 `useServices`）：本行挂在**概览尾部**，而概览在组件测试
   里是**不套 ServiceProvider** 直接渲染的（那份逐字节搬件基线就是这么渲染的）—— `useServices`
   在那种上下文会直接抛，把一份只读的辅助区变成整页崩点。没有服务访问面 ⇒ **不读**
   （rows 保持 null = 界面整块不渲染；不造一份假数据，也不吞「服务没接上」这件事：
   服务面缺失（访问面在、但取不到 squadRuntimeService）仍然**响亮抛**，见 `resolveSquadRuntimeService`）。 */

/** 一整份反应行（服务面原样、插入序）；`null` = 还没读到（由调用方各自表达：整块不渲染）。 */
export type WorkItemReactionRows = WorkItemReactionRecord[];

export function useWorkItemReactionRows(input: {
  target: SquadWorkspaceTarget | null;
  workItemId: string | null;
}): {
  /** `null` = 还没读到（含读失败但从未读到）；`[]` = 读到了、确实还没有人回应。 */
  rows: WorkItemReactionRecord[] | null;
  /** 读失败的原因（服务面原文）；`null` = 没失败。 */
  failure: string | null;
  reload: () => void;
  /** 把一次写返回的行集收编为本层的新值（读的失败格同时清空）。 */
  commitRows: (next: WorkItemReactionRecord[]) => void;
} {
  const { target, workItemId } = input;
  const services = useOptionalServices();
  const [rows, setRows] = useState<WorkItemReactionRecord[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    if (!target || !workItemId || !services) {
      requestSeq.current += 1;
      setRows(null);
      setFailure(null);
      return;
    }
    const seq = (requestSeq.current += 1);
    try {
      const next = await resolveSquadRuntimeService(services).listWorkItemReactions(target, {
        workItemId,
      });
      if (seq !== requestSeq.current) return;
      setRows(next);
      setFailure(null);
    } catch (error) {
      if (seq !== requestSeq.current) return;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("[useWorkItemReactionRows] 读取表情回应失败", { error: message });
      setFailure(message);
    }
  }, [services, target, workItemId]);

  useEffect(() => {
    /* 换条目：先清空再读（旧条目的回应不得画在新条目名下）。 */
    setRows(null);
    setFailure(null);
    void load();
  }, [load]);

  const commitRows = useCallback((next: WorkItemReactionRecord[]) => {
    setRows(next);
    setFailure(null);
  }, []);

  return { rows, failure, reload: () => void load(), commitRows };
}
