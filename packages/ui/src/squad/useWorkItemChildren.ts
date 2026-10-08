import { useCallback, useEffect, useRef, useState } from "react";
import type { SquadSnapshot, SquadWorkspaceTarget } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { squadEntryErrorFeedback, type SquadEntryFeedback } from "./squadEntryViewModel.js";
import { resolveSquadRuntimeService } from "./squadRuntimeAccess.js";
import {
  executeWorkItemQuickCreate,
  type WorkItemQuickCreateRequest,
} from "./workItemQuickCreateViewModel.js";

/* 详情页「子项」区的**数据面 + 唯一写路径**（阶段三 · T-P3-R3）。

   为什么独立成 hook（而不是留在页面里）：`WorkItemDetailPage.tsx` 已到 `max-lines = 400` 的硬线
   （页面是串行点：概览 / 交付物 / PR / 协作 / 决定 / 订阅都挂在它身上，本轮还要挂子项区）。
   与 `useWorkItemCollaboration` / `useWorkItemsViewsBridge` 同一手法：判据在纯函数
   （`workItemChildrenViewModel`），状态机与接线在本层，页面只挂载。

   两条纪律：
   ① **名册读取由页面注入**（`readRoster`）：`.getSnapshot(target)` 的唯一调用点在页面
      （页面守卫按源码数恰一处；写入路径不得再取一次快照）—— 本层只管「什么时候读、读失败
      算什么」，不自己造第二份读、也不自己拼 target。
   ② **子项创建 = 唯一写路径**：只经 `createWorkItem`（服务面唯一创建入口）+ P3-R1 的
      执行编排 `executeWorkItemQuickCreate`（成功才回读名册、失败不回读、失败原文照实带回）。
      本层不造行、不做乐观插入 —— 新行只能由回读后的名册投影出来。

   失败域：名册读取失败是**辅助失败域**（不把整页打红）：`rosterFailure` 原样带出，由子项区
   的「名册读不到」说明行与 composer 的「名册不可用」说明行各自承接；成功读取会清掉它。 */

export function useWorkItemChildren(input: {
  /** 目标 workspace（`null` = 没有激活工作区：不读也不写）。 */
  target: SquadWorkspaceTarget | null;
  /** 名册读取（**页面注入**：唯一一处 `.getSnapshot(target)` 在页面）。 */
  readRoster: (target: SquadWorkspaceTarget) => Promise<SquadSnapshot>;
}): {
  /** 名册（快照）；`null` = 还没读到（loading / 失败由 `rosterFailure` 分）。 */
  roster: SquadSnapshot | null;
  /** 名册读取失败的原因（原样带出）；`null` = 没失败（与「零子项」是两件事）。 */
  rosterFailure: string | null;
  /** 子项创建的唯一写路径：`null` = 成功（新行由回读后的名册投影出来）。 */
  createChildWorkItem: (request: WorkItemQuickCreateRequest) => Promise<SquadEntryFeedback | null>;
} {
  const { target, readRoster } = input;
  const services = useServices();
  const [roster, setRoster] = useState<SquadSnapshot | null>(null);
  const [rosterFailure, setRosterFailure] = useState<string | null>(null);
  /* 过期响应丢弃：慢的旧请求回来时不得覆盖新 target 的结果（否则切 workspace 会串数据）。 */
  const requestSeq = useRef(0);

  /** 读一次名册：成功 ⇒ 换新快照并清失败；失败 ⇒ **清快照**并留原因（两格不会同时有值）。 */
  const reloadRoster = useCallback(async () => {
    if (!target) return;
    const seq = (requestSeq.current += 1);
    try {
      const snapshot = await readRoster(target);
      if (seq !== requestSeq.current) return;
      setRoster(snapshot);
      setRosterFailure(null);
    } catch (error) {
      if (seq !== requestSeq.current) return;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("[WorkItemDetailPage] 读取名册失败", { error: message });
      setRoster(null);
      setRosterFailure(message);
    }
  }, [readRoster, target]);

  useEffect(() => {
    void reloadRoster();
  }, [reloadRoster]);

  /**
   * 子项创建的**唯一写路径**（与 P3-R1 接线层同款）：
   * `createWorkItem` 单源 → 成功才回读名册 → 失败把服务面原文翻成可就地显示的原因。
   */
  const createChildWorkItem = useCallback(
    (request: WorkItemQuickCreateRequest): Promise<SquadEntryFeedback | null> => {
      if (!target) return Promise.resolve({ tone: "error", messageId: "squad.common.noWorkspace" });
      return executeWorkItemQuickCreate({
        request,
        create: (input) => resolveSquadRuntimeService(services).createWorkItem(target, input),
        reload: reloadRoster,
      }).catch((error: unknown) => squadEntryErrorFeedback(error));
    },
    [services, target, reloadRoster],
  );

  return { roster, rosterFailure, createChildWorkItem };
}
