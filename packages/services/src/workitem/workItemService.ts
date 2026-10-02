import {
  WORK_ITEM_MAX_CHILDREN,
  WORK_ITEM_MAX_DEPTH,
  type WorkItem,
  type WorkItemStatusKey,
} from "@zcode/shared";
import { randomUUID } from "node:crypto";
import type { WorkItemRepo } from "./workItemRepo.js";

/* 工作项事件：状态的每次真实变迁、「父项子项全部终态」，以及「请把这条工作项派给这位队员」。
   派发方（小队运行时）据此唤醒队长——提前或漏发都会造成重复派发或永久挂起，所以事件形状必须窄而准。

   `workitem.dispatch_requested`（Important-1，2026-10-02 裁定）：队长派单工具（`squad/assign-work-item`）
   的语义是「**改负责人 + 发出派发事件**」——它**不直接开 run**（§5.1「多路输入、一处写入」：三路输入
   都不直接改状态，只发同一形状的派发事件；§5.6「`@` ≠ 指派」不许把「指派」与「派发」揉成一步）。
   它经**唯一出口**（`SquadRuntime.subscribeWorkItemEvents` 的那张订阅表）发出，形状与状态变迁事件同壳，
   故消费方按 `kind` 分流即可（未知 kind 一律忽略，向后兼容）。 */
export type WorkItemEvent =
  | { kind: "workitem.status_changed"; id: string; from: WorkItemStatusKey; to: WorkItemStatusKey }
  | { kind: "workitem.child_completed"; parentId: string }
  | { kind: "workitem.dispatch_requested"; workItemId: string; agentId: string };

export interface CreateWorkItemInput {
  workspaceIdentity: string;
  workspacePath: string;
  title: string;
  body?: string;
  parentId?: string;
  stage?: number;
  assignee: WorkItem["assignee"];
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
}): WorkItemService {
  const { repo, emit } = deps;

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
        labels: [],
        properties: {},
        position: 0,
      };
      repo.insert(item);
      return item;
    },

    transition(id, next, expect) {
      // CAS 未命中说明前置已变（并发派发）——此时不得发事件，否则下游会重复动作。
      if (!repo.updateStatus(id, next, expect)) return false;
      emit({ kind: "workitem.status_changed", id, from: expect, to: next });

      // 终态判定不比较键名：repo.areAllChildrenTerminal 内部按 category（isTerminalWorkItemStatus）
      // 判定，本层只消费它。零子项返回 false，所以无子项的父项不会被自身的流转误判为子项完成。
      const parentId = repo.get(id)?.parentId;
      if (parentId && repo.areAllChildrenTerminal(parentId)) {
        emit({ kind: "workitem.child_completed", parentId });
      }
      return true;
    },
  };
}
