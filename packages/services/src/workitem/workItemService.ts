import {
  WORK_ITEM_MAX_CHILDREN,
  WORK_ITEM_MAX_DEPTH,
  parseWorkItemLabels,
  resolveWorkItemDateOnly,
  resolveWorkItemPriority,
  workItemDateErrorMessage,
  workItemLabelsErrorMessage,
  workItemPriorityErrorMessage,
  type WorkItem,
  type WorkItemCreator,
  type WorkItemPriorityKey,
  type WorkItemStatusKey,
} from "@zcode/shared";
import { randomUUID } from "node:crypto";
import type { UserDispatchCause } from "./squadDispatchRequests.js";
import {
  subscriberFactsForCreatedWorkItem,
  type SubscriberFactRecorder,
} from "./subscriberFacts.js";
import type { WorkItemActivityProjector } from "./workItemActivityProjector.js";
import type { WorkItemRepo } from "./workItemRepo.js";

/* 工作项事件：状态的每次真实变迁、「父项子项全部终态」，以及「请把这条工作项派给这个对象」。
   派发方（小队运行时）据此唤醒队长——提前或漏发都会造成重复派发或永久挂起，所以事件形状必须窄而准。

   `workitem.dispatch_requested`（Important-1，2026-10-02 裁定）：队长派单工具（`squad/assign-work-item`）
   的语义是「**改负责人 + 发出派发事件**」——它**不直接开 run**（§5.1「多路输入、一处写入」：三路输入
   都不直接改状态，只发同一形状的派发事件；§5.6「`@` ≠ 指派」不许把「指派」与「派发」揉成一步）。
   它经**唯一出口**（`SquadRuntime.subscribeWorkItemEvents` 的那张订阅表）发出，形状与状态变迁事件同壳，
   故消费方按 `kind` 分流即可（未知 kind 一律忽略，向后兼容）。

   **载荷是 `assignee`（类型 + id），不是裸 `agentId`**（改派泛化，2026-10-03）：这条事件描述的事实是
   「要把这条活派给**谁**」，而"谁"不只有队员 —— 工作项也能被指派给**小队**（改派语义下这是常路：
   负责人是 squad ⇒ 派发路径解析出队长 run）。裸 `agentId` 只描述得了队员这一种，且把「智能体 X」
   与「小队 X」的 id 空间揉成一个字符串（它们彼此独立，同名不算同一对象）。

   **载荷还带 `cause`**（派发成因，2026-10-04）：成因不是渲染时推断，而是**派发时刻**就落下来的事实 ——
   两个发出点（队长派单工具 / UI 改派）各自在调用面显式给出，本事件原样带上；它随请求进常驻 hub、
   最终落 `squad_runs.dispatch_cause`（时间线据此把「队长→队员」弧线从推断升级为事实）。
   类型是**用户侧子集**（`rule` 不经这条链，由 host 的规则入口就地归并）。 */
export type WorkItemDispatchAssignee = { type: "agent" | "squad"; id: string };

export type WorkItemEvent =
  | { kind: "workitem.status_changed"; id: string; from: WorkItemStatusKey; to: WorkItemStatusKey }
  | { kind: "workitem.child_completed"; parentId: string }
  | {
      kind: "workitem.dispatch_requested";
      workItemId: string;
      assignee: WorkItemDispatchAssignee;
      cause: UserDispatchCause;
    };

export interface CreateWorkItemInput {
  workspaceIdentity: string;
  workspacePath: string;
  title: string;
  body?: string;
  parentId?: string;
  stage?: number;
  assignee: WorkItem["assignee"];
  /**
   * 标签原文（可选，`#11` v1）：按 `,` / 换行切分后交由 shared 的 `parseWorkItemLabels`
   * **归一化**（去重保序、上限 10 条 / 32 字符）。超限**响亮抛**且不落盘 —— 静默截断会让用户
   * 以为全部写进去了。规则不在这里写第二遍。
   */
  labels?: readonly string[];
  /* ---- Surface 对齐（0018）：新字段全部可选，缺省 = 未设置（NULL，不编默认值）---- */
  /**
   * 优先级（闭集 `urgent|high|medium|low`）。闭集外**响亮抛**且不落盘（`resolveWorkItemPriority`
   * 是唯一判据）；`null` / 省略 = 未设置。
   */
  priority?: WorkItemPriorityKey | null;
  /** 起始 / 截止：日历日期 `YYYY-MM-DD`（Q5）。坏日期**响亮抛**且不落盘。 */
  startDate?: string | null;
  dueDate?: string | null;
  /**
   * 创建人（谁按下创建）。**由服务入口注入**（组合根的本机操作者身份常量——即 node.ts 的唯一身份定义点），
   * 不是从表单/UI 传进来的身份；`null` / 省略 = 未知 —— **绝不**拿 `assignee` 冒充（两件事）。
   * 本层只负责落列，不做第二份身份判据。
   */
  creator?: WorkItemCreator | null;
  /** 可选：测试与幂等场景可自带 id；缺省时生成。 */
  id?: string;
}

export interface WorkItemService {
  create(input: CreateWorkItemInput): WorkItem;
  /** 唯一写 status 的入口：委托 repo 的 CAS，命中才发事件。 */
  transition(id: string, next: WorkItemStatusKey, expect: WorkItemStatusKey): boolean;
}

export function createWorkItemService(deps: {
  repo: WorkItemRepo;
  emit: (event: WorkItemEvent) => void;
  /**
   * 状态变迁的 Activity 投影（C3b.1，**可选加法**）：装配方（`createSquadRuntime`）恒传入，
   * 测试装配**不传也不报错**（缺省 = 不投影，行为与加法前逐字一致）。
   *
   * 为什么投影在**这里**：`transition` 是全仓 `status` 的唯一写者，三个生产调用点
   * （编排器父项流转 / 队员完成 / 子项收尾）自动全覆盖，零新增判据 —— 投影跟随事实的唯一写者。
   */
  activityProjector?: WorkItemActivityProjector;
  /**
   * 订阅事实出口（SUB.1，**可选加法**）：`create` 成功后按 `creator` 与创建时的 `assignee`
   * 两条事实报一次（订阅行由唯一 reconciler 写）。装配方（`createSquadRuntime`）恒传入；
   * 测试装配不传也不报错（缺省 = 不产订阅行，行为与加法前逐字一致）。
   *
   * 为什么接线在**这里**：`create` 是工作项事实的唯一创建点 —— 创建人与初始负责人都只在这里
   * 第一次成立，零新增判据。事实→reason 的映射在 `subscriberFacts`（生产点不自拼 reason 字面量）。
   */
  subscribers?: SubscriberFactRecorder;
}): WorkItemService {
  const { repo, emit, activityProjector } = deps;

  // 父链体检：父必须存在且未归档（repo.get 会过滤归档行），沿 parentId 上溯查环并计深度。
  // 环与深度都必须在这里拦下——Repo.insert 明确不查父链，漏检会把损坏的树写进库。
  function validateParent(parentId: string, newId: string): void {
    const parent = repo.get(parentId);
    if (!parent) throw new Error(`父工作项不存在或已归档：${parentId}`);

    // 深度按「含自身」计数：根节点深度 1，超过 WORK_ITEM_MAX_DEPTH 即拒绝。
    let depth = 1;
    let cursor: string | undefined = parentId;
    while (cursor) {
      if (cursor === newId) throw new Error(`工作项父子关系成环（cycle）：${newId}`);
      depth += 1;
      if (depth > WORK_ITEM_MAX_DEPTH) {
        throw new Error(`工作项层级超过深度上限 ${WORK_ITEM_MAX_DEPTH}：${newId}`);
      }
      cursor = repo.get(cursor)?.parentId;
    }

    if (repo.listChildren(parentId).length >= WORK_ITEM_MAX_CHILDREN) {
      throw new Error(`父工作项子项数量超过上限 ${WORK_ITEM_MAX_CHILDREN}：${parentId}`);
    }
  }

  return {
    // 新建不发事件：只有 transition 是状态变迁的唯一来源，create 期的 todo 是初值而非变迁。
    create(input) {
      const id = input.id ?? randomUUID();
      if (input.parentId !== undefined) validateParent(input.parentId, id);

      // 标签在**落盘之前**过归一化闸（`parseWorkItemLabels` 是唯一判据）：非 ok ⇒ 抛，
      // 于是超限输入不会留下一条「标签被悄悄砍掉」的行。`properties` 仍写 `{}`（v1 只读呈现，
      // 今天没有任何写者 —— 不在这里替设计造一个没裁过的类型契约）。
      const parsedLabels = parseWorkItemLabels(input.labels ?? []);
      if (parsedLabels.kind !== "ok") {
        throw new Error(workItemLabelsErrorMessage(parsedLabels));
      }

      /* 0018：优先级（闭集）与两个日历日期同样**先过闸、后落盘**，非 ok ⇒ 抛。
         判据只有 shared 一处实现；本层不预校验「二次判断」，也不静默折算（把看不懂的优先级
         当未设置、把不存在的日期落成空，都会让用户明确给过的值无声消失）。 */
      const priority = resolveWorkItemPriority(input.priority);
      if (priority.kind !== "ok") throw new Error(workItemPriorityErrorMessage(priority));
      const startDate = resolveWorkItemDateOnly(input.startDate);
      if (startDate.kind !== "ok") throw new Error(workItemDateErrorMessage(startDate));
      const dueDate = resolveWorkItemDateOnly(input.dueDate);
      if (dueDate.kind !== "ok") throw new Error(workItemDateErrorMessage(dueDate));

      const item: WorkItem = {
        id,
        workspaceIdentity: input.workspaceIdentity,
        workspacePath: input.workspacePath,
        parentId: input.parentId,
        stage: input.stage,
        title: input.title,
        body: input.body ?? "",
        status: "todo",
        assignee: input.assignee,
        labels: parsedLabels.labels,
        properties: {},
        position: 0,
        // 未设置（含显式 null）统一落成「不带这个键」：读取面只有 undefined 一种未设置形态。
        ...(priority.priority !== null ? { priority: priority.priority } : {}),
        ...(startDate.date !== null ? { startDate: startDate.date } : {}),
        ...(dueDate.date !== null ? { dueDate: dueDate.date } : {}),
        ...(input.creator !== undefined && input.creator !== null
          ? { creator: input.creator }
          : {}),
      };
      /* 序号由存储面语句内生成并回传（调用方**结构上无法传号**：CreateWorkItemInput 里没有
         这个字段）。返回的实体带上真实号 —— 否则调用方拿到的实体缺一列而库里有一列，两处分叉。 */
      const identifierSeq = repo.insert(item);
      /* 订阅事实（SUB.1）：**行落地之后**才报（订阅关系挂在一条真实存在的工作项上）。
         同刻两条事实（负责人 → 创建人）的次序是语义，见 `subscriberFactsForCreatedWorkItem`：
         同主体时 reason 落 `creator`，于是 spec §7.1 的「记录创建者，不因后续改派消失」成立。 */
      for (const fact of subscriberFactsForCreatedWorkItem({
        assignee: item.assignee,
        creator: item.creator,
      })) {
        deps.subscribers?.({ workItemId: id, fact });
      }
      return { ...item, identifierSeq };
    },

    transition(id, next, expect) {
      // CAS 未命中说明前置已变（并发派发）——此时不得发事件，否则下游会重复动作。
      if (!repo.updateStatus(id, next, expect)) return false;

      /* 投影（C3b.1）：**记录先于驱动**。CAS 已命中 ⇒ 变迁是既成事实，先在时间线留下回声，
         再把事件交给订阅者 —— 订阅者抛错不得让一条已经落地的事实失去时间线记录。
         投影自身**不会抛**（模块内 catch + logWarn，见 workItemActivityProjector 的失败面论证），
         且缺失投影面时整条 transition 行为与加法前逐字一致（`activityProjector` 可选）。
         末次 `repo.get` 的返回值同时供投影与父链判定用：CAS 命中后该行必然存在且未归档。 */
      const item = repo.get(id);
      if (item && activityProjector) {
        activityProjector.statusChanged({ item, from: expect, to: next });
      }

      emit({ kind: "workitem.status_changed", id, from: expect, to: next });

      // 终态判定不比较键名：repo.areAllChildrenTerminal 内部按 category（isTerminalWorkItemStatus）
      // 判定，本层只消费它。零子项返回 false，所以无子项的父项不会被自身的流转误判为子项完成。
      const parentId = item?.parentId;
      if (parentId && repo.areAllChildrenTerminal(parentId)) {
        emit({ kind: "workitem.child_completed", parentId });
      }
      return true;
    },
  };
}
