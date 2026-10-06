import { resolveWorkspaceKey, type WorkItem } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  CommentDispatchReceiptRepo,
  CommentDispatchReceiptRecord,
} from "./commentDispatchReceiptRepo.js";
import type { SquadRuntime } from "./squadContracts.js";
import type { SquadWorkspaceTarget } from "./squadRuntimeService.js";
import type { WorkItemActivityRepo, WorkItemActivityRecord } from "./workItemActivityRepo.js";
import type {
  WorkItemCommentReactionRepo,
  WorkItemCommentReactionRecord,
} from "./workItemCommentReactionRepo.js";
import type { WorkItemCommentRepo, WorkItemCommentRecord } from "./workItemCommentRepo.js";
import type { WorkItemDecisionRepo, WorkItemDecisionRecord } from "./workItemDecisionRepo.js";

/* B5.1 轮 1：工作项**协作读门面**（设计案开放问题 1 的答复，任务卡 §2.2/§2.3）。

   为什么是**独立描述符**而不是往 `ISquadRuntimeService` 上加一个方法：
   · 语义上它是「按 (workspace, workItemId) 寻址的**一次聚合读**」，与 `getSnapshot` 的
     「workspace 全量最小视图」不是一件事 —— 快照被看板 / agent 详情 / 规则分区共用，
     把按工作项无界的追加式事实（评论 + sequence 单调的 Activity）塞进去，会让每次看板加载
     替所有工作项付代价，且失败域无法分离（协作读失败必须让概览继续显示，§3.4）；
   · 该描述符**不新增任何 IPC handler / 协议 schema**：host 侧 `ServiceCollection.register`
     即把 channel 暴露在线路上，renderer 侧补一行 `ProxyChannel.toService` 即可。

   **本文件必须保持浏览器安全**（`packages/services/src/index.ts` 用**值**导入导出描述符，
   renderer 要经它取数）：对 node 侧模块（四个 repo + receipt repo）**只用 `import type`**，
   与 `squadRuntimeService.ts` 同款纪律（browserSafeRootEntry.test.ts 守这条）。

   门面语义纪律（§2.3，逐条落）：
   ① workspace 唯一权威 = `runtime.boundWorkspace` 推到 `resolveWorkspaceKey` 的那一条式子；
      调用方传进来的 `target` 只用于**构造 runtime**，不参与任何 key 计算；
   ② `getIncludingArchived` 命中但属异己 workspace ⇒ **响亮抛**（§8.5）；不命中 ⇒ `null`；
      归档行**照返回**（否则设计案 §4.1 的归档态不可达）；
   ③ **排序零重排**：五个数组原样来自 repo（本层不 sort、不 filter、不 derive —— 第二份判据
      与 repo 漂移时不报错，时间线会静默换序）；
   ④ **不过门禁**：读不是新派发（与 listSquadRuns / listWakeRules / listInboxItems 同款理由）；
   ⑤ **不写任何行**：本文件结构上不 import 派发/义务/run 三个面，也不存在 `.add(` / `UPDATE`；
   ⑥ 响应分组在 UI（`reactions` 扁平返回，`groupCommentReactions` 是 UI 受测纯函数）；
   ⑦ 懒取 repo、未注入 ⇒ 响亮抛（同 `requireInboxItemRepo` 的理由：静默空表会把
      「这份服务面没接通」伪装成「这条工作项没有任何协作数据」）。 */

/** 一次读取的全部事实：五面 + 工作项本体。五个数组的排序**原样来自 repo**。 */
export type WorkItemCollaborationRead = {
  /** 含**归档行**（`archivedAt` 有值）——设计案 §4.1 要求归档项仍可寻址并显示 composer 禁用原因。 */
  workItem: WorkItem;
  /** `WorkItemCommentRepo.listByWorkItem` 口径（createdAt ASC, id ASC）。 */
  comments: WorkItemCommentRecord[];
  /** `WorkItemActivityRepo.listByWorkItem` 口径（sequence ASC 主序）。 */
  activities: WorkItemActivityRecord[];
  /** `WorkItemDecisionRepo.listByWorkItem` 口径（effectiveAt ASC, id ASC）。 */
  decisions: WorkItemDecisionRecord[];
  /** 本工作项**全部评论**的回应，扁平（分组是 UI 纯函数 `groupCommentReactions` 的活）。 */
  reactions: WorkItemCommentReactionRecord[];
  /** `CommentDispatchReceiptRepo.listByWorkItem` 口径（createdAt ASC, dispatchKey ASC）。 */
  receipts: CommentDispatchReceiptRecord[];
};

export interface IWorkItemCollaborationService {
  /**
   * 按 (target, workItemId) 聚合读取。
   * · `null` = 本 workspace 内**没有这条工作项**（UI 的 not-found 分支，不是故障，不抛）；
   * · 跨 workspace 引用 ⇒ **响亮抛**（§8.5，不静默当不存在）；
   * · **不过门禁**：读不是新派发。
   */
  getWorkItemCollaboration(
    target: SquadWorkspaceTarget,
    workItemId: string,
  ): Promise<WorkItemCollaborationRead | null>;
}

export const IWorkItemCollaborationService =
  createServiceDescriptor<IWorkItemCollaborationService>("work-item-collaboration");

/** 五个只读 repo（由组合根懒取注入；未就绪时它们自己响亮抛）。 */
export type WorkItemCollaborationRepos = {
  comments: WorkItemCommentRepo;
  activities: WorkItemActivityRepo;
  decisions: WorkItemDecisionRepo;
  reactions: WorkItemCommentReactionRepo;
  receipts: CommentDispatchReceiptRepo;
};

export type WorkItemCollaborationServiceDeps = {
  /** 按目标现构 runtime（不缓存）——workspace 身份与「工作项在不在」的**唯一权威**。 */
  createRuntime: (target: SquadWorkspaceTarget) => Promise<SquadRuntime>;
  /** 懒取（`getInboxItemRepo` / `getCommentDispatchReceiptRepo` 同款：库在 ensureReady 后就绪）。 */
  getRepos: () => WorkItemCollaborationRepos;
};

export function createWorkItemCollaborationService(
  deps: WorkItemCollaborationServiceDeps,
): IWorkItemCollaborationService {
  /* 懒取口的缺失守卫：类型上 `getRepos` 是必填，但组合根是**运行时**接线（JS 侧漏接不会被类型挡住），
     而缺失的后果是「静默一片空白」——与「响亮失败优于静默」的既有纪律相悖，故仍在运行时兜一道。 */
  const requireRepos = (): WorkItemCollaborationRepos => {
    if (!deps.getRepos) {
      throw new Error(
        "工作项协作读门面未接通：组合根没有注入 getRepos（懒取 repo 口）。" +
          "静默返回空结果会把「这份服务面没接协作域」伪装成「这条工作项没有任何协作数据」，故一律抛。",
      );
    }
    return deps.getRepos();
  };

  return {
    async getWorkItemCollaboration(target, workItemId) {
      const runtime = await deps.createRuntime(target);
      // workspaceKey 的唯一口径与来源：runtime 的绑定值（与 squadRuntimeService 的 keyOf 同一条式子）。
      const workspaceKey = resolveWorkspaceKey({
        workspacePath: runtime.boundWorkspace.path,
        workspaceIdentity: runtime.boundWorkspace.identity,
      });
      // 含归档读回：归档项仍可寻址（「归档」与「不存在」必须可区分，见 WorkItemRepo 的 doc）。
      const workItem = runtime.workItemRepo.getIncludingArchived(workItemId);
      if (!workItem) return null;
      /* 已存在的行按**同一条式子**求它自己的 key 再比对：这是「取错了目标（接线 bug）」与
         「本 workspace 没有这条」的分界，静默当不存在会让前者伪装成后者的正常返回。 */
      const itemKey = resolveWorkspaceKey({
        workspacePath: workItem.workspacePath,
        workspaceIdentity: workItem.workspaceIdentity,
      });
      if (itemKey !== workspaceKey) {
        throw new Error(
          `工作项「${workItemId}」属于 workspace「${itemKey}」，与本次目标的「${workspaceKey}」不一致：` +
            "跨 workspace 引用一律响亮拒绝（§8.5）。",
        );
      }
      const repos = requireRepos();
      const comments = repos.comments.listByWorkItem(workspaceKey, workItemId);
      return {
        workItem,
        comments,
        activities: repos.activities.listByWorkItem(workspaceKey, workItemId),
        decisions: repos.decisions.listByWorkItem(workspaceKey, workItemId),
        reactions: comments.flatMap((comment) => repos.reactions.listByComment(comment.id)),
        receipts: repos.receipts.listByWorkItem(workspaceKey, workItemId),
      };
    },
  };
}
