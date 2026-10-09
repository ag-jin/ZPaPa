/* oxlint-disable eslint(max-lines) -- 门面契约（读模型 + 全部入口的纪律）与实现刻意同文件：
   本文件是「UI 只经这一个口碰协作域」的证明面，每个入口都是「现构 runtime → 取绑定 workspace →
   交给注入实现」的同形三行；按入口拆文件会让「某个入口忘了取绑定值」这类接线 bug 无处一眼对照，
   而它的表现（写到了别的 workspace）不报错。与 commentService.ts / squadRunRepo 的例外同款理由。 */
import { resolveWorkspaceKey, type SquadMergeMode, type WorkItem } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  CommentDispatchReceiptRepo,
  CommentDispatchReceiptRecord,
} from "./commentDispatchReceiptRepo.js";
/* C4.1：判据面是**值导入**（读面 canView 判据在这里调用）——该模块保持浏览器安全，
   故不会把 node 侧带进 renderer 包（browserSafeRootEntry.test.ts 的传递可达检查守这条）。 */
import {
  SINGLE_USER_ACCESS_POLICY,
  collaborationAccessDeniedMessage,
  resolveAccessSubject,
  type CollaborationAccessPolicy,
} from "./collaborationAccessPolicy.js";
import type {
  CommentFactsBackfillReport,
  CommentService,
  CreateCommentResult,
} from "./commentService.js";
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
import type {
  WorkItemDecisionKind,
  WorkItemDecisionRepo,
  WorkItemDecisionRecord,
} from "./workItemDecisionRepo.js";
/* C3.1：决定写入服务的**类型**引用（`import type` 会被编译擦除——该模块值导入加密内建模块，
   值导入会把 node 侧带进 renderer 包，browserSafeRootEntry.test.ts 守这条）。 */
import type { WorkItemDecisionService } from "./workItemDecisionService.js";
/* #7 D1b：交付物的两个**类型**引用（同款理由：交付物存储面值导入 node 侧内建模块
   —— 文件系统与加密 —— 值导入会把 node 侧带进 renderer 包）。 */
import type {
  WorkItemDeliverableDetail,
  WorkItemDeliverableRecord,
} from "./workItemDeliverableRepo.js";
/* #8 D2：PR 关联的**类型**引用（同款理由：存储面用 `node:sqlite` 的类型）+ 三口的**实现面**
   （`workItemPullRequestEntry`）：该模块与 provider / repo 一样保持浏览器安全（对 node 侧只用
   `import type`），值导入不会把 node 侧带进 renderer 包（browserSafeRootEntry.test.ts 守这条）。 */
import type { PullRequestSyncReport } from "./pullRequestSync.js";
import {
  createWorkItemPullRequestEntry,
  pullRequestProviderAvailability,
  requireOwnedWorkItem,
} from "./workItemPullRequestEntry.js";
import type { PullRequestRecord } from "./workItemPullRequestRepo.js";
/* SUB.1：订阅主体规范化与手动订阅事实的**入口**（值导入，浏览器安全：`subscriberFacts` 零 IO、
   零 `node:` 值导入）；订阅行类型与读取面只作类型引用。 */
import { subscriberSubjectOfActor } from "./subscriberFacts.js";
import type { OptOutScope } from "./subscriberFacts.js";
import type { WorkItemSubscriberRecord } from "./workItemSubscriberRepo.js";

/* B5.1 轮 1 / B5.2 轮 2：工作项**协作门面**（设计案开放问题 1 的答复，任务卡 §2.2/§2.3）。
   —— 轮 1 落下**读**（`getWorkItemCollaboration`），轮 2 落下**四个写入口**（§5.2），
   C3.1 再挂**第五个写入口**（决定）：实现是独立深模块 WorkItemDecisionService（决定不派发、不改状态）。

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
   ④ **读不是新派发，但读仍是 §9 的一轴**：读面过 `canView` 判据（C4.1）——缺省策略恒放行（单人产品），
      注入拒绝 ⇒ 响亮抛；「不过派遣门禁」的理由（与 listSquadRuns / listWakeRules / listInboxItems 同款）
      讲的是「门禁（派发开关）不管读」，与 §9 的 canView 不是一件事；
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
  /**
   * **本工作项的订阅行**（SUB.1）：`WorkItemSubscriberRepo.listByWorkItem` 口径
   * （`created_at ASC, id ASC`），含 tombstone 行（「已退订」是可观察状态）。
   *
   * 为什么带**该工作项的全部主体**而不是只带当前人类那一行：本层对数组**不 filter、不 derive**
   * （见上面纪律 ③）—— 过滤是呈现的活；且同一读面还要服务 SUB.2 的收件人解析与「谁在关注」的呈现。
   * 当前人类的行按 `viewerActor` 的规范化主体在数组里查得（写入口用的就是同一份规范化）。
   */
  subscribers: WorkItemSubscriberRecord[];
  /**
   * **交付物清单**（#7 D1b）：`WorkItemDeliverableRepo.listByWorkItem` 口径（createdAt ASC, id ASC），
   * 含两型（自动捕获的 `diff` / 手动登记的 `link`）。
   *
   * 为什么并入这一读面（设计 §3.1「无新服务」）：交付物与评论/决定/活动同属「按 (workspace, workItemId)
   * 寻址的一次聚合读」，失败域也同一族（协作读失败 ⇒ 概览照常，协作区降级）；另开一个描述符会让详情页
   * 为同一屏付两次往返、两套失败域。
   *
   * 只带**行**不带正文：清单走库、正文按 ref 按需取（`getWorkItemDeliverable`）——
   * diff 正文可达 MB 级，进读模型会让每次打开详情页都读一遍全部正文（设计 §3.2 的存储取舍）。
   */
  deliverables: WorkItemDeliverableRecord[];
  /**
   * **关联 PR 清单**（#8 D2）：`WorkItemPullRequestRepo.listByWorkItem` 口径（createdAt ASC, id ASC）。
   * 含「登记了但从未拉取快照」的行（`state === null`）——离线缺省形态下这就是全部内容。
   */
  pullRequests: PullRequestRecord[];
  /**
   * 读数面此刻的可用性（同步、零 IO）：`available: false` ⇒ 未配置 token。
   * UI 据此把快照态呈现为「未配置 token（只显示手动登记的链接）」而不是错误。
   */
  pullRequestProvider: { available: boolean; reason: string | null };
  /**
   * **整批收尾模式**（#8 D3）：`local`（本地合回）/ `pr-gate`（push + 开 PR，终态交 PR merge）。
   * 读面带它的唯一用途是呈现：pr-gate 而没配 token 时，收尾会降级为本地合并（收件箱留痕），
   * PR 区据此给出「为什么这里没有 PR」的一句说明（判据单源在 runtime 的现判读取口）。
   */
  mergeMode: SquadMergeMode;
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

/**
 * 记录一条决定（C3.1，spec §3.4；任务卡 §4.2 冻结形状）。
 *
 * **不含 `actor`**（同评论入口的 D1-A 口径）：作者由组合根注入的本地人类身份自取，UI 只给
 * 「写到哪、写什么、幂等键」。`selection` / `evidence` / `threadId` 不在 v1（恒 {} / [] / null）：
 * 子类型闭集未裁，给它一个 JSON 输入框 = 把「本地用户输坏 JSON ⇒ 决定记不下来」变成常态。
 */
export type CreateWorkItemDecisionRequest = {
  workItemId: string;
  /** 五值闭集（proposal/accepted/rejected/superseded/reopened）；服务面校验。 */
  kind: WorkItemDecisionKind;
  /** 被裁决的事项（trim 后非空；无长度上限）。 */
  subject: string;
  rationale?: string;
  /** superseded / reopened 必填，且父必须存在、同 workspace、同工作项、非自身。 */
  parentDecisionId?: string;
  /** **幂等键**（§8.1）：一次提交动作生成一次，失败重试沿用同一个（换新键会长出第二条决定）。 */
  sourceRequestId: string;
};

/**
 * 手动登记一条 **link** 交付物（#7 D1b，设计 §3.3「手动」）。
 *
 * **不含 `kind`**：手动登记只开 link 型（PR / 预览 / 文档 / 测试报告这类外部产物）；`diff` 型
 * 只能由自动捕获产生（它必须挂在一次真实的 git 事实之后 —— 手填的 diff 没有任何东西背书）。
 * 服务面在结构上就写不出「手动 diff」，不是靠运行时检查挡。
 *
 * **不含 `actor`**（同评论/决定入口的 D1-A 口径）：登记人由组合根注入的本地人类身份自取 ——
 * UI 只给「挂到哪、叫什么、指向哪」。
 */
export type RegisterWorkItemDeliverableLinkRequest = {
  workItemId: string;
  title: string;
  url: string;
  note?: string;
};

/* ---------- #8 D2：三个 PR 入口的入参形状 ---------- */

/**
 * 手动登记一条 PR 关联（设计 §4.2「服务面出口」）。
 *
 * **不含 `actor`**（同 D1-A 口径）：登记人 = 组合根注入的本地人类身份。
 * **不含 owner/repo/number**：它们从 `url` 归一化出来（唯一判据在服务面，UI 只贴地址）。
 * `title` 可省：省略时派生 `owner/name#number`；远端标题归快照（登记时不猜）。
 */
export type LinkWorkItemPullRequestRequest = {
  workItemId: string;
  /** GitHub PR 地址（`https://github.com/<owner>/<repo>/pull[s]/<n>` 或其页面变体）。 */
  url: string;
  title?: string;
};

/** 解除一条关联（按 id 寻址；不存在的 id 返回 false，不是错误）。 */
export type UnlinkWorkItemPullRequestRequest = {
  pullRequestId: string;
};

/**
 * 手动订阅 / 退订（SUB.1；UI 控件在 SUB.3a 接线）。
 *
 * 判别联合而不是「两个可空字段」：订**不存在范围**、退订**必须有范围**（两档：`issue` 只此条 /
 * `subtree` 此条及子项）。写成 `{subscribed, scope?}` 会让「退订但忘了范围」在类型上合法，
 * 落库时只能猜一个默认档 —— 猜错的表现是「我退订了，子项还在通知我」。
 */
export type SetWorkItemSubscriptionRequest =
  | { workItemId: string; subscribed: true }
  | { workItemId: string; subscribed: false; scope: OptOutScope };

/** 按需刷新（手动触发）一个工作项下全部已链接 PR 的快照。 */
export type RefreshWorkItemPullRequestsRequest = {
  workItemId: string;
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

  /* ---------- C3.1：第五个写入口（决定；任务卡 §4.1/§4.2） ---------- */

  /**
   * 记录一条决定：1 行决定 + 1 枚带 `decisionId` 锚的 `decision_created` 活动。
   * 决定**不派发、不改状态**（结构上拿不到 runs/receipts/状态机——见 WorkItemDecisionService）。
   */
  createWorkItemDecision(
    target: SquadWorkspaceTarget,
    input: CreateWorkItemDecisionRequest,
  ): Promise<WorkItemDecisionRecord>;

  /* ---------- SUB.1：第六个写入口（订阅 / 退订；UI 控件在 SUB.3a） ---------- */

  /**
   * 手动订阅 / 退订（用户显式意思，**唯一**能改订阅意愿的入口）。
   * · `subscribed: true` ⇒ 显式订阅：清墓碑、`reason` 归 `manual`（此后自动规则再也删不掉它）；
   * · `subscribed: false` + `scope` ⇒ 显式退订：落墓碑并承载退订范围（两档）。
   *
   * 返回写后的**本人类订阅行**（界面据此直接呈现「关注中 / 已退订」，不必二次读）。
   * 主体恒取组合根注入的本地人类身份（UI 零身份拼装，D1-A）；「工作项必须已存在且同 workspace」
   * 复用既有那一处判据（`requireOwnedWorkItem`），归档项与其余写入口同款被拒。
   */
  setWorkItemSubscription(
    target: SquadWorkspaceTarget,
    input: SetWorkItemSubscriptionRequest,
  ): Promise<WorkItemSubscriberRecord>;

  /* ---------- #7 D1b：交付物的读一条 + 手动登记（设计 §3.1「无新服务」的第二个面） ---------- */

  /**
   * 单条交付物的**正文读回**（三态：`file` 可读 / `missing` 正文缺失 / `external` 外部引用）。
   *
   * 为什么按需取而不是塞进读模型：diff 正文可达 MB 级，清单只需行；UI 展开某一条时才取它的正文
   * （设计 §3.2「清单查询走库、正文读取按 ref」）。
   * · id 不存在 ⇒ `null`（「没有这条」是正常状态，不是故障）；
   * · **跨 workspace 引用 ⇒ 响亮抛**（§8.5：与读面同一条纪律，不静默当不存在）。
   */
  getWorkItemDeliverable(
    target: SquadWorkspaceTarget,
    deliverableId: string,
  ): Promise<WorkItemDeliverableDetail | null>;

  /**
   * 手动登记一条 link 交付物：写交付物行 + 第 20 枚时间线回声（`deliverable_registered`，
   * actor = 操作者 —— 与自动捕获的 `system` 在时间线上可分辨）。
   *
   * 三条纪律：**只开 link**（见 `RegisterWorkItemDeliverableLinkRequest`）；**工作项必须已存在**
   * （静默建行会把链接挂到一个不存在的对象上 ⇒ 响亮抛）；**不做幂等**（人贴链接是意图行为，
   * 同 URL 重复贴由 UI 确认，而不是被键约束静默吞掉 —— 设计 §3.2）。
   */
  registerWorkItemDeliverableLink(
    target: SquadWorkspaceTarget,
    input: RegisterWorkItemDeliverableLinkRequest,
  ): Promise<WorkItemDeliverableRecord>;

  /* ---------- #8 D2：PR 关联与快照的三个入口（设计 §4.2 的服务面出口） ---------- */

  /**
   * 登记一条 PR 关联：URL 归一化（非 GitHub PR 地址**响亮抛**）+ 幂等落行 + 归因（操作者）。
   * **不发网络请求**（按需拉取：快照只由 `refreshWorkItemPullRequests` 触发）。
   */
  linkWorkItemPullRequest(
    target: SquadWorkspaceTarget,
    input: LinkWorkItemPullRequestRequest,
  ): Promise<PullRequestRecord>;

  /**
   * 解除一条关联（真删）。返回是否删到一行：`false` = 本来就没有（**不是错误** ——
   * 界面上的陈旧条目不该让用户看到一次报错）。跨 workspace 的 id ⇒ 响亮抛（§8.5）。
   */
  unlinkWorkItemPullRequest(
    target: SquadWorkspaceTarget,
    input: UnlinkWorkItemPullRequestRequest,
  ): Promise<boolean>;

  /**
   * 按需刷新该工作项下全部已链接 PR 的快照（**唯一的快照写入口**）。
   *
   * 未配 token ⇒ 报告每条 `unavailable` 且 `providerAvailable: false`（**不抛**：离线缺省形态
   * 不是错误）；HTTP/网络失败与防陈旧拒写各自带原因进报告（不静默）。
   * **不动工作项状态**：报告里的 `mergedPullRequests` 是 D3（终态驱动）要消费的口。
   */
  refreshWorkItemPullRequests(
    target: SquadWorkspaceTarget,
    input: RefreshWorkItemPullRequestsRequest,
  ): Promise<PullRequestSyncReport>;

  /* ---------- G7（§8.4-3）：半途事务扫描（启动期维护动作，非 UI 入口） ---------- */

  /**
   * **扫描并补齐本 workspace 缺失的派生 Activity**（崩溃残留回收）。
   *
   * 为什么挂在门面上而不是让 host 自己拼 repo：补写必须落在**写侧那张表**上 —— 由组合根复用
   * `createCommentServiceFor` 同一份 repo 构造（`deps.backfillCommentFacts`），host 侧零 repo、
   * 零连接、零键拼装。
   *
   * 幂等（Activity 的 dedupKey 唯一索引）⇒ 每次启动跑都安全；调用点是启动维护步骤，不是 UI 路径。
   * `workspaceKey` 由本层从 `runtime.boundWorkspace` 派生（与读写入口同一条式子，调用方不参与）。
   */
  backfillWorkItemCommentFacts(target: SquadWorkspaceTarget): Promise<CommentFactsBackfillReport>;
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
   * §9 三轴的判据面（C4.1）：读面 `getWorkItemCollaboration` 用它做 **canView** 判据。
   *
   * 缺省 = `SINGLE_USER_ACCESS_POLICY`（单人产品策略：人类恒可读，归档项照可读）——与两个写服务同款：
   * 缺省值就是当前产品的正确策略，不是「没接线的占位」。注入替代策略是读面唯一的拒绝路径来源
   * （注入拒绝 ⇒ 响亮抛，不返回 `null`：`null` 已被「本 workspace 没有这条」占用）。
   */
  accessPolicy?: CollaborationAccessPolicy;
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
  /**
   * C3.1 第五写入口（决定）的转发目标：**组合根构造的 `WorkItemDecisionService`**，按本次 runtime 装。
   *
   * 为什么同样走独立工厂注入、门面不自己 `new`：门面必须保持**零 SQL / 零 `.add(`**
   * （b52FacadeWriteVerification.test.ts 的既存断言），且决定服务值导入加密内建模块
   * （randomUUID）——门面是浏览器安全模块，不能值导入它。
   *
   * **可选**与 `createCommentService` 同理：缺它时第五写入口**响亮抛**（`requireDecisionService`），
   * 不静默 no-op（静默会让用户以为决定已经记下来了）。
   */
  createDecisionService?: (runtime: SquadRuntime) => WorkItemDecisionService;
  /**
   * G7（§8.4-3）半途事务扫描的转发目标：**组合根构造的补写实现**（复用评论族 repo 的同一份构造）。
   *
   * 为什么是注入而不是本文件 import 实现：`commentService.ts` 值导入加密内建模块（randomUUID），
   * 本文件必须保持浏览器安全（值导入会把 node 侧带进 renderer 包，browserSafeRootEntry.test.ts 守这条）
   * —— 与 `createCommentService` / `createDecisionService` 同款。
   *
   * 入参只有 `workspaceKey`（由本层从 runtime 绑定值派生）：补写是纯存储面动作，
   * 不需要 runtime，也就拿不到任何生命周期写入口。
   *
   * **可选**：只消费读面的装配不必构造它；缺它时 `backfillWorkItemCommentFacts` **响亮抛**
   * （`requireBackfillCommentFacts`）—— 静默 no-op 会让「崩溃残留没被回收」与「本来就没有残行」
   * 长得一模一样（挂点日志里那行「补 0 枚」也就失去了意义）。
   */
  backfillCommentFacts?: (workspaceKey: string) => CommentFactsBackfillReport;
  /**
   * 时钟注入面（#8 D2）：`link` 的 `created_at`/`updated_at` 取自它，缺省 `Date.now`。
   * 存在的唯一理由是让「登记时刻」这一格在测试里可钉死（与各 repo 的 `now?` 同一条惯例）。
   */
  now?: () => number;
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

  /** 第五写入口的同一道缺失守卫（C3.1；理由同上：静默 no-op 会让用户以为决定已经记下来了）。 */
  const requireDecisionService = (runtime: SquadRuntime): WorkItemDecisionService => {
    if (!deps.createDecisionService) {
      throw new Error(
        "工作项协作写门面未接通：组合根没有注入 createDecisionService。" +
          "静默 no-op 会让用户以为决定已经记下来了（时间线上却什么都没有），故一律抛。",
      );
    }
    return deps.createDecisionService(runtime);
  };

  /** 补写扫描的同一道缺失守卫（G7；理由见 `deps.backfillCommentFacts`）。 */
  const requireBackfillCommentFacts = (): ((
    workspaceKey: string,
  ) => CommentFactsBackfillReport) => {
    if (!deps.backfillCommentFacts) {
      throw new Error(
        "工作项协作门面未接通半途事务扫描：组合根没有注入 backfillCommentFacts（§8.4-3）。" +
          "静默 no-op 会让「崩溃残留没被回收」与「本来就没有残行」长得一模一样，故一律抛。",
      );
    }
    return deps.backfillCommentFacts;
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

  /* 「工作项必须存在且同 workspace」的判据（D1b 的交付物登记与 D2 的 PR 三口共用）与
     「读数面可用性」的归一都在 `workItemPullRequestEntry` 里 —— 本门面只引用，不再各自实现一份。 */

  const now = deps.now ?? (() => Date.now());

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
      /* §9 的 canView 判据（C4.1）：读面与五个写入口**并列**过同一份判据面（主体同源 =
         组合根注入的本地人类，经唯一的 `resolveAccessSubject` 派生）。位次在取任何 repo 之前：
         拒绝 ⇒ 响亮抛（**不返回 `null`**——`null` 已被「本 workspace 没有这条」占用，混用会把
         「权限被拒」显示成「工作项不存在」）。缺省策略恒放行，故本判据不改变任何既有读行为。 */
      const viewerActor = requireLocalHumanActor();
      const accessSubject = resolveAccessSubject({
        actor: viewerActor,
        initiatedBy: viewerActor,
      });
      const viewAccess = (deps.accessPolicy ?? SINGLE_USER_ACCESS_POLICY).canViewWorkItem(
        accessSubject,
        { workItemId, archivedAt: workItem.archivedAt ?? null },
      );
      if (!viewAccess.allowed) {
        throw new Error(collaborationAccessDeniedMessage(viewAccess.reason, accessSubject));
      }
      const repos = requireRepos();
      const comments = repos.comments.listByWorkItem(workspaceKey, workItemId);
      return {
        workItem,
        // 观察者身份与写入口的 actor 同源（同一次 requireLocalHumanActor 调用口径）。
        viewerActor,
        comments,
        activities: repos.activities.listByWorkItem(workspaceKey, workItemId),
        decisions: repos.decisions.listByWorkItem(workspaceKey, workItemId),
        reactions: comments.flatMap((comment) => repos.reactions.listByComment(comment.id)),
        receipts: repos.receipts.listByWorkItem(workspaceKey, workItemId),
        /* #7 D1b：交付物清单随同一次聚合读返回（**只带行**，正文按 ref 按需取）——
           口径与其它五面同一条：`workspaceKey` 取自本次 runtime 的绑定值，不取调用方传的 target。 */
        deliverables: runtime.deliverableRepo.listByWorkItem(workspaceKey, workItemId),
        /* #8 D2：PR 关联清单 + 读数面可用性（同步判据，零 IO）。离线缺省下这里返回
           `available: false` 而列表照常 —— 「没配 token」是配置状态，不是读失败。 */
        pullRequests: runtime.pullRequestRepo.listByWorkItem(workspaceKey, workItemId),
        /* SUB.1：本工作项的订阅行（含 tombstone）：原样来自 repo（本层不 sort / 不 filter）。 */
        subscribers: runtime.subscriberRepo.listByWorkItem(workspaceKey, workItemId),
        pullRequestProvider: pullRequestProviderAvailability(runtime),
        /* #8 D3：整批收尾模式（`local` / `pr-gate`）随读面带出。为什么读面要带它：
           pr-gate 的前置不满足时收尾会**降级为本地合并**（收件箱留痕），而详情页的 PR 区
           要能给出一句「这个工作项在等什么 / 为什么没开 PR」的说明 —— 那需要模式这一个事实。
           判据只有一个来源（runtime 的现判读取口），UI 不自己读设置、不再判一份。 */
        mergeMode: runtime.readSquadMergeMode(),
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

    /* C3.1：第五写入口。与四个评论入口同形——**现构 runtime → 取绑定 workspace → 交给
       WorkItemDecisionService**；门面只定「写到哪、谁写的」，父规则/闭集/幂等键全在服务面。 */
    async createWorkItemDecision(target, input) {
      const runtime = await deps.createRuntime(target);
      const { workspaceKey, workspacePath } = boundWorkspaceOf(runtime);
      const actor = requireLocalHumanActor();
      return requireDecisionService(runtime).createDecision({
        workspaceKey,
        workspacePath,
        workItemId: input.workItemId,
        kind: input.kind,
        subject: input.subject,
        author: actor,
        initiatedBy: actor,
        ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
        ...(input.parentDecisionId !== undefined
          ? { parentDecisionId: input.parentDecisionId }
          : {}),
        // 幂等键必带：缺了它重试就是第二条决定（§8.1）。
        sourceRequestId: input.sourceRequestId,
      });
    },

    /* SUB.1：第六写入口（订阅 / 退订）。与其余入口同形——**现构 runtime → 取绑定 workspace →
       交给订阅事实出口**：门面只定「谁（注入的本地人类，经唯一规范化单源）、对哪条工作项、
       想订阅还是退订（退订必带范围）」，判据与落库全在 `subscriberFacts` 的唯一 reconciler 路径上。
       返回写后的行：`manual_subscribe` / `manual_unsubscribe` 两条路径**恒存在一行**
       （订阅=插入或改写；退订=插入或更新墓碑），故这里拿不到行即为不可达态，响亮抛。 */
    async setWorkItemSubscription(target, input) {
      const runtime = await deps.createRuntime(target);
      const { workspaceKey } = boundWorkspaceOf(runtime);
      requireOwnedWorkItem(runtime, workspaceKey, input.workItemId, "订阅工作项");
      const subject = subscriberSubjectOfActor(requireLocalHumanActor());
      runtime.subscriberFacts({
        workItemId: input.workItemId,
        fact: input.subscribed
          ? { kind: "manual_subscribe", subject }
          : { kind: "manual_unsubscribe", subject, scope: input.scope },
      });
      const row = runtime.subscriberRepo.get({
        workspaceKey,
        workItemId: input.workItemId,
        subjectType: subject.kind,
        subjectId: subject.id,
      });
      if (row === null) {
        throw new Error(
          `订阅写入后读不到 (workspace=${workspaceKey}, workItem=${input.workItemId}, ` +
            `subject=${subject.kind}:${subject.id}) 的行：不可达态，须查订阅事实出口的接线。`,
        );
      }
      return row;
    },

    /* ---------- #7 D1b：交付物读一条 + 手动登记 ---------- */

    async getWorkItemDeliverable(target, deliverableId) {
      const runtime = await deps.createRuntime(target);
      const { workspaceKey } = boundWorkspaceOf(runtime);
      const detail = runtime.deliverableRepo.get(deliverableId);
      if (!detail) return null;
      /* 跨 workspace 引用 ⇒ 响亮抛（§8.5）：与读面同一条纪律 —— 静默返回别人 workspace 的正文，
         或者把它折成 `null` 假装「没有这条」，都会让「取错了目标」这类接线 bug 无声通过。 */
      if (detail.record.workspaceKey !== workspaceKey) {
        throw new Error(
          `交付物「${deliverableId}」属于 workspace「${detail.record.workspaceKey}」，` +
            `与本次目标的「${workspaceKey}」不一致：跨 workspace 引用一律响亮拒绝（§8.5）。`,
        );
      }
      return detail;
    },

    async registerWorkItemDeliverableLink(target, input) {
      const runtime = await deps.createRuntime(target);
      const { workspaceKey } = boundWorkspaceOf(runtime);
      /* **工作项必须已存在且同 workspace**（判据提取成 requireOwnedWorkItem：D2 的 PR 三口共用同一道，
         两处各写一份会在「归档项能不能挂」这类边界上分叉，而分叉不报错）。 */
      requireOwnedWorkItem(runtime, workspaceKey, input.workItemId, "登记交付物");
      /* 交付物登记面的唯一实现在 runtime 上（自动捕获与手动登记共用一份）：本层只定
         「谁写的」（注入的本地人类）与「挂到哪」，id/键派生、落库、回声全在登记面里。 */
      return runtime.deliverableRecorder.registerLink({
        workItemId: input.workItemId,
        title: input.title,
        url: input.url,
        ...(input.note !== undefined ? { note: input.note } : {}),
        actor: requireLocalHumanActor(),
      });
    },

    /* ---------- #8 D2：PR 关联的三个入口 ----------
       三条写法与四个评论入口同形：**现构 runtime → 取绑定 workspace → 交给实现面**。
       实现（URL 归一化 / 可寻址判据 / 归因 / 幂等落行）在 `workItemPullRequestEntry` 里 ——
       门面不写第二份（两处判据分叉的表现是「界面上拦住了而库里写进去了」，且不报错）。 */

    async linkWorkItemPullRequest(target, input) {
      const runtime = await deps.createRuntime(target);
      const { workspaceKey } = boundWorkspaceOf(runtime);
      return createWorkItemPullRequestEntry({
        runtime,
        workspaceKey,
        actor: requireLocalHumanActor,
        now,
      }).link(input);
    },

    async unlinkWorkItemPullRequest(target, input) {
      const runtime = await deps.createRuntime(target);
      const { workspaceKey } = boundWorkspaceOf(runtime);
      return createWorkItemPullRequestEntry({
        runtime,
        workspaceKey,
        actor: requireLocalHumanActor,
        now,
      }).unlink(input);
    },

    async refreshWorkItemPullRequests(target, input) {
      const runtime = await deps.createRuntime(target);
      const { workspaceKey } = boundWorkspaceOf(runtime);
      return createWorkItemPullRequestEntry({
        runtime,
        workspaceKey,
        actor: requireLocalHumanActor,
        now,
      }).refresh(input);
    },

    /* G7（§8.4-3）：半途事务扫描。与其余入口同形 —— **现构 runtime → 取绑定 workspace → 交给
       组合根注入的实现**；本层只定「扫哪个 workspace」，缺行判据/键构造/幂等全在 commentService。
       不经门禁（不是派发，是启动期维护）；不读 repo（`getRepos` 与本动作无关）。 */
    async backfillWorkItemCommentFacts(target) {
      const runtime = await deps.createRuntime(target);
      const { workspaceKey } = boundWorkspaceOf(runtime);
      return requireBackfillCommentFacts()(workspaceKey);
    },
  };
}
