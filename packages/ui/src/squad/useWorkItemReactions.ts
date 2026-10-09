import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthorRef, SquadWorkspaceTarget } from "@zcode/services";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { resolveSquadRuntimeService } from "./squadRuntimeAccess.js";
import { useWorkItemReactionRows } from "./useWorkItemReactionRows.js";
import {
  workItemReactionGroups,
  workItemReactionOwnEmojisAfterWrite,
  workItemReactionToggleOn,
  workItemReactionViewerAfterWrite,
  type WorkItemReactionGroup,
} from "./workItemReactionsViewModel.js";

/* 工作项回应的**写入**（阶段三 · T-P3-R5u）—— 全 UI 唯一的 `setWorkItemReaction` 调用点。

   读面复用 `useWorkItemReactionRows`（同一份读实现、同一套失败域；本层不重写一次取数），
   写返回经它的 `commitRows` 收编（行集只有那一个状态所有者）。

   写法四条（逐条对应验收 / 仓库纪律）：

   ① **无乐观插入**：点下之后只把那一枚置为 pending（禁用），**不动行集** —— 行集的唯一来源是
      服务面返回（`setWorkItemReaction` 返回的就是操作后该工作项的全部行）。本地拼一行会在失败时
      留下一个「看起来已经加上」的假事实（仓库纪律：只保留未提交草稿与 pending 覆盖层）。
   ② **服务返回替换**：写成功即用返回的行集覆盖（幂等命中返回同值 ⇒ 界面无抖动）。
      「同人同 emoji 恰一条」由迁移 0021 的五元组唯一键兜底，UI 不做第二份判据。
   ③ **身份靠学、不靠编**：`on` 的判据是 `workItemReactionToggleOn`（(kind,id) 两列都判）；
      身份不可判定时只能「置上」（幂等安全），并从写返回里**学**出本机操作者
      （恰一行新增 ⇒ 它的作者就是我；0 行 / ≥2 行不学）—— 学到之后此前留下的历史行也一并点亮。
   ④ **过期写返回丢弃**：写还没回来就切了 workspace / 条目 ⇒ 那份返回不再收编
      （同一目标代之外的行集不能落到新条目名下；与读路径的 seq 守卫同一条纪律）。

   失败**不吞**：置一条动作失败原因（与读失败同一格出口），行集保持上一次读到的值。 */

/** 目标代（`(target, workItemId)` 变化即换代）：写返回只在本代内被收编。
 *
 *  `target` 必须**按值稳定**（调用方 `useMemo`）：每次渲染都新造一个对象会让代每次 +1，
 *  在途的写返回会被误判过期（丢弃是无害的，但白丢一次刷新）。 */
function useTargetGeneration(input: {
  target: SquadWorkspaceTarget | null;
  workItemId: string | null;
}): () => number {
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
  }, [input.target, input.workItemId]);
  return useCallback(() => generation.current, []);
}

export function useWorkItemReactions(input: {
  target: SquadWorkspaceTarget | null;
  workItemId: string | null;
  /** 观察者身份（读面带回；缺席 = `null`，见上「身份靠学」）。 */
  viewerActor: AuthorRef | null;
}): {
  /** 聚合分组（次序 = 行插入序；0 反应 ⇒ 空数组 = 只画入口）。 */
  groups: WorkItemReactionGroup[];
  /** 读成功过（`null` 行集 = 还没读到：界面整块不渲染，不预判空态）。 */
  loaded: boolean;
  failure: string | null;
  pendingEmoji: string | null;
  toggle: (emoji: string) => Promise<void>;
  reload: () => void;
} {
  const { target, workItemId, viewerActor } = input;
  const services = useOptionalServices();
  const {
    rows,
    failure: readFailure,
    reload,
    commitRows,
  } = useWorkItemReactionRows({
    target,
    workItemId,
  });
  const generation = useTargetGeneration({ target, workItemId });
  const [learnedViewer, setLearnedViewer] = useState<AuthorRef | null>(null);
  const [ownEmojis, setOwnEmojis] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [pendingEmoji, setPendingEmoji] = useState<string | null>(null);
  const [writeFailure, setWriteFailure] = useState<string | null>(null);
  /* 切条目：本机集清零（它是「这一条工作项上我按过哪些」的知识；跨条目沿用会把 A 的我的
     回应标到 B 上）。学到的**身份**是「谁是我」（与条目无关）⇒ 沿用，历史行继续点亮。 */
  useEffect(() => {
    setOwnEmojis(new Set<string>());
  }, [target, workItemId]);
  /* 身份：传入的优先（读面身份是权威）；缺席时用本次会话从写返回里学到的。 */
  const viewer = viewerActor ?? learnedViewer;

  const toggle = useCallback(
    async (emoji: string): Promise<void> => {
      /* 没有服务访问面（概览在无 provider 的上下文里渲染）不可能触达：读到之后界面才画入口。 */
      if (!target || !workItemId || !services) return;
      const previousRows = rows ?? [];
      const previousEmojis = ownEmojis;
      const startedAt = generation();
      /* `on` 的判据在纯函数里（(kind,id) 两列都判；身份不可判定 ⇒ 查本机集，再没有就置上）。 */
      const on = workItemReactionToggleOn({
        rows: previousRows,
        viewerActor: viewer,
        ownEmojis: previousEmojis,
        emoji,
      });
      setPendingEmoji(emoji);
      setWriteFailure(null);
      try {
        const next = await resolveSquadRuntimeService(services).setWorkItemReaction(target, {
          workItemId,
          emoji,
          on,
        });
        if (generation() !== startedAt) return; // ④ 过期写返回丢弃
        setLearnedViewer((previous) =>
          workItemReactionViewerAfterWrite({
            previousRows,
            nextRows: next,
            viewerActor: viewerActor ?? previous,
          }),
        );
        setOwnEmojis(workItemReactionOwnEmojisAfterWrite({ previousEmojis, emoji, on }));
        commitRows(next);
      } catch (error) {
        if (generation() !== startedAt) return;
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[useWorkItemReactions] 写入表情回应失败", { error: message });
        setWriteFailure(message);
      } finally {
        setPendingEmoji(null);
      }
    },
    [services, target, workItemId, rows, viewer, ownEmojis, viewerActor, generation, commitRows],
  );

  return {
    groups: rows === null ? [] : workItemReactionGroups({ rows, viewerActor: viewer, ownEmojis }),
    loaded: rows !== null,
    failure: writeFailure ?? readFailure,
    pendingEmoji,
    toggle,
    reload,
  };
}
