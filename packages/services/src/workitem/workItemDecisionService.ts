import { randomUUID } from "node:crypto";
import type { WorkItemActivityRepo } from "./workItemActivityRepo.js";
import type { AuthorRef } from "./workItemCommentRepo.js";
import type {
  WorkItemDecisionKind,
  WorkItemDecisionRecord,
  WorkItemDecisionRepo,
} from "./workItemDecisionRepo.js";
import { WORK_ITEM_DECISION_KINDS } from "./workItemDecisionRepo.js";
import type { WorkItemRepo } from "./workItemRepo.js";

/* C3.1：Decision 写入服务面（spec §3.3/§3.4；任务卡 §4.2）。

   为什么是**独立深模块**而不是往 CommentService 上加方法：决定与评论是两类事实（§2.2 三实体分离），
   而且本服务的**依赖集是有意封顶的**——只有 `decisions` / `activities` / `workItems`（+ 注入的
   now/newId）。没有 runs / receipts / 义务表 / WorkItemService ⇒「决定不派发、不改状态、不开 run」
   不是靠自觉，而是**结构上的不可能**（同 workItemDecisionRepo 结构上无 status 列的手法；§5.2 禁令
   的守卫测试在本文件对应的 `workItemDecisionGuards.test.ts`）。

   写入顺序（§5.1：先验证身份，再写实体，再写关联 Activity）：
   ① 闭集与父规则校验（全部发生在写任何事实之前——坏请求绝不留孤儿）；② 决定行（dedupKey 幂等）；
   ③ 一枚 `decision_created` 活动，**带 decisionId 锚**（缺锚 UI 会静默降级成「关联活动不可用」）。
   两条 dedupKey 都由下面的**导出纯函数**生成：形状只有这一处（写者形状见 spec §8.1），重投时
   `repo.add` 返回既存行（含原 id）⇒ 活动键与原次相同 ⇒ 活动也不翻倍。 */

/**
 * 决定行的写者幂等键（spec §8.1：「同一明确决定请求重试不产生重复决定」）。
 *
 * 形状：`decision:<workItemId>:<subject>:<initiatedBy.kind>:<initiatedBy.id>:<sourceRequestId>`
 * ——**该字符串永不解析**（只作等值与唯一索引）：`subject` 是任意文本（可含 `:`），
 * 一旦有人开始解析它，就会重蹈 P1 游标「自己拼的字符串自己读不回」的覆辙。
 */
export function computeDecisionDedupKey(input: {
  workItemId: string;
  subject: string;
  initiatedBy: AuthorRef;
  sourceRequestId: string;
}): string {
  return `decision:${input.workItemId}:${input.subject}:${input.initiatedBy.kind}:${input.initiatedBy.id}:${input.sourceRequestId}`;
}

/** 活动行的幂等键：**同一决策只写一枚** `decision_created`（`decisionId` 是事实身份）。 */
export function computeDecisionActivityDedupKey(decisionId: string): string {
  return `decision:${decisionId}:created`;
}

/**
 * `reopened` 的合法父 kind（任务卡 §2.2）。
 * 「重开一条仍在提议中的决定」没有意义（它的处置就是接受/拒绝）⇒ 服务面响亮拒绝。
 * `proposal` 因此是 reopened 的**死格**：UI 的候选集窄于本表只是可用性问题，
 * 一旦 UI 比本表宽（把 proposal 放进候选），服务面仍会拒——判据单源在这里。
 */
const REOPENABLE_PARENT_KINDS: readonly WorkItemDecisionKind[] = [
  "accepted",
  "rejected",
  "superseded",
];

export type CreateDecisionInput = {
  workspaceKey: string;
  /** 逻辑身份见 workspaceKey；此列只作审计与呈现（与评论族同口径）。 */
  workspacePath: string;
  workItemId: string;
  /** 五值闭集（任务卡 §2.2）；闭集外响亮抛，不落任何事实。 */
  kind: WorkItemDecisionKind;
  /** 被裁决的事项（trim 后非空；**不设长度上限**——规格未裁，不发明）。 */
  subject: string;
  rationale?: string;
  /** `superseded` / `reopened` 必填，且父必须存在、同 workspace、同工作项、非自身。 */
  parentDecisionId?: string;
  /** v1 门面不传（恒 null）：线程选择器还没有消费方。 */
  threadId?: string;
  /** 作出裁决者（人类入口 = 组合根注入的本地人类身份）。 */
  author: AuthorRef;
  /** 顶层人类归因；缺省 = author（人类直接操作时二者同体）。 */
  initiatedBy?: AuthorRef;
  /** v1 门面不传（人类不伪造 run 归属）；带它时只落决定行，见 createDecision 注释。 */
  sourceRunId?: string;
  /** 幂等键的一部分（§8.1）：UI 每次「提交动作」生成一次，重试沿用同一个。 */
  sourceRequestId: string;
  /** 可选预生成 id（测试确定性）；缺省 newId()。 */
  id?: string;
  /** 缺省 now()。 */
  effectiveAt?: number;
};

export interface WorkItemDecisionService {
  createDecision(input: CreateDecisionInput): WorkItemDecisionRecord;
}

/**
 * **依赖集封顶**（结构红线）：只有决定/活动/工作项三个 repo 与两个注入口。
 * 改这个类型即编译错——这正是「决定链拿不到 runs/receipts/状态机」的技术保证。
 */
export type WorkItemDecisionServiceDeps = {
  decisions: WorkItemDecisionRepo;
  activities: WorkItemActivityRepo;
  /** 工作项存在性/归档判定（归档项允许写决定——写事实不因归档被拒，与评论「可审计不可派发」同族）。 */
  workItems: WorkItemRepo;
  /** 时钟（测试可注入）；缺省 Date.now。 */
  now?: () => number;
  /** id 生成（测试可注入）；缺省 randomUUID。 */
  newId?: () => string;
};

export function createWorkItemDecisionService(
  deps: WorkItemDecisionServiceDeps,
): WorkItemDecisionService {
  const newId = deps.newId ?? (() => randomUUID());
  const now = deps.now ?? (() => Date.now());

  return {
    createDecision(input) {
      // ① 校验全部在写任何事实之前：坏请求绝不留孤儿行（与 CommentService 先验证后写同款纪律）。
      if (!(WORK_ITEM_DECISION_KINDS as readonly string[]).includes(input.kind)) {
        throw new Error(
          `work_item_decisions.kind 拒绝非法值「${String(input.kind)}」：kind 是五值闭集（§2.2/§3.4），` +
            "闭集外一律响亮拒绝，不落任何事实。",
        );
      }
      if (input.subject.trim() === "") {
        throw new Error(
          "决定的 subject 不得为空白：subject 是被裁决的事项（§3.4），空事项的决定没有审计意义，" +
            "一律响亮拒绝（trim 判据是服务面的，UI 侧重复一份只是为了可用性）。",
        );
      }
      const workItem = deps.workItems.getIncludingArchived(input.workItemId);
      if (!workItem) {
        throw new Error(
          `工作项「${input.workItemId}」不存在：决定必须指向本 workspace 的工作项（§5.1），` +
            "不写指向空气的孤儿决定。",
        );
      }
      if (workItem.workspaceIdentity !== input.workspaceKey) {
        throw new Error(
          `工作项「${input.workItemId}」属于 workspace「${workItem.workspaceIdentity}」，` +
            `与传入的「${input.workspaceKey}」不一致：跨 workspace 引用一律响亮拒绝（§8.5）。`,
        );
      }
      /* ② 父规则（任务卡 §2.2）：superseded/reopened 父必填；给了父就必须能回答「父是谁」——
         存在、同 workspace、同工作项、非自身；reopened 另限父 kind ∈ {accepted, rejected, superseded}。 */
      if (input.parentDecisionId === undefined) {
        if (input.kind === "superseded" || input.kind === "reopened") {
          throw new Error(
            `决定 kind=${input.kind} 必须带 parentDecisionId：${input.kind === "superseded" ? "取代" : "重新审议"}` +
              "一条决定而不指出被取代/被重审的是哪条，时间线就回答不出「后来由什么取代」（§3.4），一律响亮拒绝。",
          );
        }
      } else {
        // 自身引用在存在性之前判：预生成 id 与父相同时，repo 的资源占用会让它落成「写入后读不回」的不可达态。
        if (input.id !== undefined && input.id === input.parentDecisionId) {
          throw new Error(
            `父决定「${input.parentDecisionId}」不能是本次决定自身（id 相同）：自指的取代/重审在图上是环，` +
              "一律响亮拒绝。",
          );
        }
        const parent = deps.decisions.get(input.parentDecisionId);
        if (parent === null) {
          throw new Error(
            `父决定「${input.parentDecisionId}」不存在：parentDecisionId 必须指向已存在的决定（§3.4），` +
              "一律响亮拒绝。",
          );
        }
        if (parent.workspaceKey !== input.workspaceKey || parent.workItemId !== input.workItemId) {
          throw new Error(
            `父决定「${parent.id}」属于 (workspace=${parent.workspaceKey}, workItem=${parent.workItemId})，` +
              `与本次决定的 (workspace=${input.workspaceKey}, workItem=${input.workItemId}) 不一致：` +
              "跨 workspace / 跨工作项的父链一律响亮拒绝（§3.4）。",
          );
        }
        if (input.kind === "reopened" && !REOPENABLE_PARENT_KINDS.includes(parent.kind)) {
          throw new Error(
            `reopened 的父决定 kind=「${parent.kind}」不在 {accepted, rejected, superseded} 内：` +
              "重开一条仍在提议中的决定没有意义（它的处置就是接受/拒绝），一律响亮拒绝。",
          );
        }
      }
      // ③ 写决定行（dedupKey 幂等）→ ④ 写带 decisionId 锚的活动行。
      const timestamp = input.effectiveAt ?? now();
      const initiatedBy = input.initiatedBy ?? input.author;
      const decision = deps.decisions.add({
        id: input.id ?? newId(),
        workspaceKey: input.workspaceKey,
        workspacePath: input.workspacePath,
        workItemId: input.workItemId,
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
        ...(input.parentDecisionId !== undefined
          ? { parentDecisionId: input.parentDecisionId }
          : {}),
        author: input.author,
        ...(input.sourceRunId !== undefined ? { sourceRunId: input.sourceRunId } : {}),
        initiatedBy,
        kind: input.kind,
        subject: input.subject,
        selection: {},
        ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
        evidence: [],
        effectiveAt: timestamp,
        dedupKey: computeDecisionDedupKey({
          workItemId: input.workItemId,
          subject: input.subject,
          initiatedBy,
          sourceRequestId: input.sourceRequestId,
        }),
        createdAt: timestamp,
      });
      deps.activities.add({
        id: `activity-${decision.id}-created`,
        workspaceKey: decision.workspaceKey,
        workspacePath: decision.workspacePath,
        workItemId: decision.workItemId,
        kind: "decision_created",
        occurredAt: timestamp,
        actor: decision.author,
        initiatedBy: decision.initiatedBy,
        decisionId: decision.id,
        /* 活动**不带 sourceRun**：输入只有 runId 时，角色（leader|member|standalone）无从得知，
           而活动读回纪律要求「有 source_run_id 就必须有合法角色，不得猜」（0013 的历史教训）。
           v1 门面不传 sourceRunId，故这一格当前恒 null；agent 工具面带 run 归属时须扩为完整
           SourceRunRef 才能同时写两面——登记在交接产物里，不在这里发明角色。 */
        payload: { kind: decision.kind, parentDecisionId: decision.parentDecisionId },
        dedupKey: computeDecisionActivityDedupKey(decision.id),
        createdAt: timestamp,
      });
      return decision;
    },
  };
}
