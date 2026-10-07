import { resolveWorkspaceKey, type WorkItem } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  CommentDispatchReceiptRepo,
  CommentDispatchReceiptRecord,
} from "./commentDispatchReceiptRepo.js";
import type { CommentService, CreateCommentResult } from "./commentService.js";
import type { SquadRuntime } from "./squadContracts.js";
import type { SquadWorkspaceTarget } from "./squadRuntimeService.js";
import type { WorkItemActivityRepo, WorkItemActivityRecord } from "./workItemActivityRepo.js";
import type {
  WorkItemCommentReactionRepo,
  WorkItemCommentReactionRecord,
} from "./workItemCommentReactionRepo.js";
import type {
  AuthorRef,
  InlineAnchor,
  WorkItemCommentRepo,
  WorkItemCommentRecord,
} from "./workItemCommentRepo.js";
import type { WorkItemDecisionRepo, WorkItemDecisionRecord } from "./workItemDecisionRepo.js";

/* B5.1 轮 1 / B5.2 轮 2：工作项**协作门面**（设计案开放问题 1 的答复，任务卡 §2.2/§2.3）。
   —— 轮 1 落下**读**（`getWorkItemCollaboration`），轮 2 落下**四个写入口**（§5.2）。

   为什么是**独立描述符**而不是往 `ISquadRuntimeService` 上加一个方法：
   · 语义上它是「按 (workspace, workItemId) 寻址的**一次聚合读**」，与 `getSnapshot` 的
     「workspace 全量最小视图」不是一件事 —— 快照被看板 / agent 详情 / 规则分区共用，
     把按工作项无界的追加式事实（评论 + sequence 单调的 Activity）塞进去，会让每次看板加载
     替所有工作项付代价，且失败域无法分离（协作读失败必须让概览继续显示，§3.4）；
   · 该描述符**不新增任何 IPC handler / 协议 schema**：host 侧 `ServiceCollection.register`
     即把 channel 暴露在线路上，renderer 侧补一行 `ProxyChannel.toService` 即可。

   **本文件必须保持浏览器安全**（`packages/services/src/index.ts` 用**值**导入导出描述符，
   renderer 要经它取数）：对 node 侧模块（四个 repo + receipt repo + CommentService）**只用
   `import type`**，与 `squadRuntimeService.ts` 同款纪律（browserSafeRootEntry.test.ts 守这条）。
   写入口的**实现体**不 import 任何生命周期写接口（run 创建/队长登记/派发规划），也不碰
   义务表 —— 它只把「写到哪、写什么、幂等键」转给组合根构造的 `CommentService`（§5.2：
   评论链不得自己开 run）。

   门面语义纪律（§2.3，逐条落）：
   ① workspace 唯一权威 = `runtime.boundWorkspace` 推到 `resolveWorkspaceKey` 的那一条式子；
      调用方传进来的 `target` 只用于**构造 runtime**，不参与任何 key 计算（读与写同一口径）；
   ② `getIncludingArchived` 命中但属异己 workspace ⇒ **响亮抛**（§8.5）；不命中 ⇒ `null`；
      归档行**照返回**（否则设计案 §4.1 的归档态不可达）；
   ③ **排序零重排**：五个数组原样来自 repo（本层不 sort、不 filter、不 derive —— 第二份判据
      与 repo 漂移时不报错，时间线会静默换序）；
   ④ **不过门禁**：读不是新派发（与 listSquadRuns / listWakeRules / listInboxItems 同款理由）；
   ⑤ **写只经 CommentService**：门面不碰 receipt/run/义务三个面，也不存在 `.add(` / `UPDATE`；
   ⑥ 响应分组在 UI（`reactions` 扁平返回，`groupCommentReactions` 是 UI 受测纯函数）；
   ⑦ 懒取 repo、未注入 ⇒ 响亮抛（同 `requireInboxItemRepo` 的理由：静默空表会把
      「这份服务面没接通」伪装成「这条工作项没有任何协作数据」）。 */

/** 一次读取的全部事实：五面 + 工作项本体 + 观察者身份。五个数组的排序**原样来自 repo**。 */
export type WorkItemCollaborationRead = {
  /** 含**归档行**（`archivedAt` 有值）——设计案 §4.1 要求归档项仍可寻址并显示 composer 禁用原因。 */
  workItem: WorkItem;
  /**
   * **观察者身份**（D1-A：组合根注入的本地人类 `AuthorRef`）。
   *
   * 为什么由读面给出而不是 UI 自己造一个：设计案 §12-2 明文「不应在 UI 自行决定权限」，
   * 且 §3.1 的 `author` 是**审计事实** —— UI 编一个 id 就是把审计写坏。C5 的「我已回应」
   * 判据（`groupCommentReactions` 的 `mine`）也只能拿**同一份**身份算，否则同一个人
   * 在「写」与「读」两侧会得到两个身份。
   */
  viewerActor: AuthorRef;
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

/**
 * 发一条人类评论（B5.2 轮 2）。
 *
 * **不含 `actor`**（D1-A 落地）：身份由组合根的 `localHumanActor` 注入一次，服务面自取 ——
 * 任务卡 §2.2 的正文写明「workspaceKey/Path、initiatedBy 默认值、sourceRun 全部由服务面派生，
 * UI 只给『写到哪、写什么、幂等键』」，且 §5.6 的 A 案把 `actor` 的来源定为组合根
 * （「UI 只传 workItemId/body/…，服务面自取 actor」）。UI 结构上拿不到也不构造身份。
 */
export type CreateWorkItemCommentRequest = {
  workItemId: string;
  body: string;
  inline?: InlineAnchor | null;
  /** 回复的直接父评论（缺省 = 顶层评论）。线程根由 CommentService 从父行推出。 */
  parentCommentId?: string;
  /**
   * **幂等键**（§8.1）：UI 每次「提交动作」生成一次，重试沿用**同一个** —— 换新键会让一次
   * 重试在库里长成两条评论（用户看到自己说了两遍）。
   */
  clientRequestId: string;
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

  /* ---------- 轮 2：四个写入口（§5.2；形状与 CommentService 四方法一一对应） ---------- */

  /** 发评论：写评论事实 + Activity + 按队列状态窗裁决落 receipt（派发实际执行归 host）。 */
  createWorkItemComment(
    target: SquadWorkspaceTarget,
    input: CreateWorkItemCommentRequest,
  ): Promise<CreateCommentResult>;
  /** 软删（墓碑）：评论照在、正文由 UI 折叠；永不触发派发（§4.4）。 */
  softDeleteWorkItemComment(
    target: SquadWorkspaceTarget,
    input: { commentId: string },
  ): Promise<WorkItemCommentRecord>;
  /** 线程解决态：**仅线程根**可置/消（回复行由 CommentService 响亮拒绝）。 */
  setWorkItemCommentResolved(
    target: SquadWorkspaceTarget,
    input: { commentId: string; resolved: boolean },
  ): Promise<WorkItemCommentRecord>;
  /** 表情回应：轻实体幂等落盘，永不触发派发（§4.4）。 */
  addWorkItemCommentReaction(
    target: SquadWorkspaceTarget,
    input: { commentId: string; emoji: string },
  ): Promise<WorkItemCommentReactionRecord>;
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
  /**
   * **本地人类身份的唯一来源**（D1-A：组合根注入**一次**）。
   *
   * 为什么必填而不是可选：可选会让「没接身份」表现成 `undefined` 被当作一个 id 写进审计列
   * （评论的作者变成空串），而空串在界面上看起来只是没填名字。必填 ⇒ 漏接是**编译错**。
   */
  localHumanActor: () => AuthorRef;
  /**
   * 四个写入口的转发目标：**组合根构造的 `CommentService`**，按本次 runtime 的零件装（§5.2）。
   *
   * 为什么是「按 runtime 造」而不是「组合根里建一个单例」：评论服务的名册（agent/小队）与
   * workItem/run/义务三个 repo 都是**按 workspace** 的，而 runtime 是按目标现构、不缓存的
   * （见 createSquadRuntimeFor）。一个跨目标的单例会让名册与 repo 落到「第一个用它的 workspace」上
   * —— 表现为「在 A 项目评论却触发了 B 项目的 agent」，且不报错。
   * 本文件只持有**类型**（`import type`），不 import 任何生命周期写接口（§5.2 结构负向见测试）。
   *
   * **可选**：只消费读面的装配（以及读面测试）不必构造评论服务；缺它时四个写入口**响亮抛**
   * （`requireCommentService`），而不是静默 no-op。
   */
  createCommentService?: (runtime: SquadRuntime) => CommentService;
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

  /** 身份缺失的同一道兜底（见 deps.localHumanActor 的理由：不许把空身份写进审计列）。 */
  const requireLocalHumanActor = (): AuthorRef => {
    const actor = deps.localHumanActor?.();
    if (!actor) {
      throw new Error(
        "工作项协作门面未接通本地人类身份：组合根必须注入 localHumanActor（D1-A）。" +
          "静默用一个空身份会把评论作者写成查不出是谁的行，故一律抛。",
      );
    }
    return actor;
  };

  const requireCommentService = (runtime: SquadRuntime): CommentService => {
    if (!deps.createCommentService) {
      throw new Error(
        "工作项协作写门面未接通：组合根没有注入 createCommentService。" +
          "静默 no-op（或本地假装写成功）会让用户以为话已经发出去了，故一律抛。",
      );
    }
    return deps.createCommentService(runtime);
  };

  /* workspace 的唯一口径与来源（读与写**共用这一条**式子）：runtime 的绑定值 ——
     调用方传的 target 只用于现构 runtime，不参与任何 key/path 计算。 */
  const boundWorkspaceOf = (runtime: SquadRuntime) => ({
    workspaceKey: resolveWorkspaceKey({
      workspacePath: runtime.boundWorkspace.path,
      workspaceIdentity: runtime.boundWorkspace.identity,
    }),
    workspacePath: runtime.boundWorkspace.path,
  });

  return {
    async getWorkItemCollaboration(target, workItemId) {
      const runtime = await deps.createRuntime(target);
      const { workspaceKey } = boundWorkspaceOf(runtime);
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
        // 观察者身份与写入口的 actor 同源（同一次 requireLocalHumanActor 调用口径）。
        viewerActor: requireLocalHumanActor(),
        comments,
        activities: repos.activities.listByWorkItem(workspaceKey, workItemId),
        decisions: repos.decisions.listByWorkItem(workspaceKey, workItemId),
        reactions: comments.flatMap((comment) => repos.reactions.listByComment(comment.id)),
        receipts: repos.receipts.listByWorkItem(workspaceKey, workItemId),
      };
    },

    /* ---------- 轮 2：四个写入口 ----------
       四条写法完全同形：**现构 runtime → 取绑定 workspace → 交给 CommentService**。
       门面在这一层只做两件事，别的什么都不做：
       · 把「写到哪」定死成本次 runtime 的绑定值（调用方无法指定 key/path —— 那正是「写错库」的唯一入口）；
       · 把「谁写的」定死成组合根注入的本地人类身份（UI 零身份拼装，D1-A）。
       `initiatedBy` 一律缺省（CommentService 的缺省 = actor，人类直接操作时二者同体）；
       `sourceRun` 一律不传（人类 composer 不伪造 run 归属）。异常与返回形状**原样透传**。 */

    async createWorkItemComment(target, input) {
      const runtime = await deps.createRuntime(target);
      const { workspaceKey, workspacePath } = boundWorkspaceOf(runtime);
      const actor = requireLocalHumanActor();
      return requireCommentService(runtime).createComment({
        workspaceKey,
        workspacePath,
        workItemId: input.workItemId,
        author: actor,
        initiatedBy: actor,
        body: input.body,
        ...(input.inline !== undefined ? { inline: input.inline } : {}),
        ...(input.parentCommentId !== undefined ? { parentCommentId: input.parentCommentId } : {}),
        // 幂等键必带：缺了它重试就是第二条评论（§8.1）。
        clientRequestId: input.clientRequestId,
      });
    },

    async softDeleteWorkItemComment(target, input) {
      const runtime = await deps.createRuntime(target);
      const { workspaceKey } = boundWorkspaceOf(runtime);
      return requireCommentService(runtime).softDeleteComment({
        commentId: input.commentId,
        workspaceKey,
        actor: requireLocalHumanActor(),
      });
    },

    async setWorkItemCommentResolved(target, input) {
      const runtime = await deps.createRuntime(target);
      const { workspaceKey } = boundWorkspaceOf(runtime);
      return requireCommentService(runtime).setCommentResolved({
        commentId: input.commentId,
        workspaceKey,
        resolved: input.resolved,
        actor: requireLocalHumanActor(),
      });
    },

    async addWorkItemCommentReaction(target, input) {
      const runtime = await deps.createRuntime(target);
      const { workspaceKey } = boundWorkspaceOf(runtime);
      return requireCommentService(runtime).addCommentReaction({
        commentId: input.commentId,
        workspaceKey,
        emoji: input.emoji,
        author: requireLocalHumanActor(),
      });
    },
  };
}
