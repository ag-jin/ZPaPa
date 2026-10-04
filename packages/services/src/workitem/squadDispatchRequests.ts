/* 派发请求的**常驻订阅出口**（Task 7 第 2 轮裁定，落点 ii）。

   为什么需要它：`SquadRuntime` 是**按目标现构、不缓存**的（确认 3），而工作项事件的订阅表在
   **实例内部** ⇒ 常驻侧（host 进程里的组合根）**订不到**某个实例的订阅表 —— 于是「队长派单只发一条
   `workitem.dispatch_requested`」在当前架构下**驱动不出 run**（事件发出去了，没有任何常驻订阅者收得到）。

   裁定给的解法：把**派发请求**这一格的出口做成**可注入的单例 hub**，由组合根建**一份**、注入给每个
   runtime（`createSquadRuntime` 的 `dispatchRequestHub`），runtime 在发出 `workitem.dispatch_requested`
   时一并 `publish`；组合根**订一次**（`createLocalServices` 里），转给 host 注入的派发执行体。
   **加法式**：既有的 `subscribeWorkItemEvents`（实例级订阅表）一字未改，既有调用方不受影响。

   本文件必须**浏览器安全**（它被 `squadRuntime.ts` 值导入，而该文件同时也被测试与 node 侧使用）：
   只 import type，不触达 `node:*`，因此不引入任何运行时依赖。文件里唯一的**值**导出是
   `DISPATCH_CAUSES`（成因闭集的常量数组，纯字面量）——它仍是零依赖，不破坏这条不变量。 */

import type { WorkItemDispatchAssignee } from "./workItemService.js";

/**
 * 派发的**成因**（闭集；`squad_runs.dispatch_cause` 列的取值域）。
 *
 * 为什么是闭集而不是自由文本：成因是台账上的**既成事实**，读回来要能直接分流（时间线从此能把
 * 「队长→队员」的弧线从渲染时推断升级为事实、区分用户改派与规则唤醒）。自由文本会让同一成因在库里
 * 长出多种拼法，读回时只能靠猜 —— 而猜错不报错。列值域与这里的常量**同源**（`DISPATCH_CAUSES`），
 * 读写两侧的守卫都取它，不存在「类型加了一档、守卫还认旧集」的静默分叉。
 *
 * · `leader_tool`：队长派单工具（`squad/assign-work-item`）发起的派发；
 * · `user_reassign`：用户在界面上改派（`reassignWorkItem`）发起的派发；
 * · `rule`：唤醒规则到点发起的派发 —— 它**不经**事件/hub（是 host 自己的入口），
 *   由派发桥就地归并（见 `SquadDispatchRequest.cause`）。
 *
 * **NULL 是列上的合法值**：遗留行 / 未知成因 —— 读回**不得猜**（`readDispatchCause` 对枚举外值响亮抛）。
 */
export const DISPATCH_CAUSES = ["leader_tool", "user_reassign", "rule"] as const;
export type DispatchCause = (typeof DISPATCH_CAUSES)[number];

/**
 * 用户侧子集（**不含 `rule`**）：`workitem.dispatch_requested` 事件载荷与常驻 hub 的派发请求只可能是
 * 这两者 —— 规则触发是 host 自己的接法，不经过服务面的事件链（那条链上没有第二个写入者）。
 * 收窄成子集而不是复用全集：让「事件载荷里冒出 `rule`」在**类型层**就不可表达
 * （宽松的联合放行后，写错的那条路径不会有任何编译错）。
 */
export type UserDispatchCause = Exclude<DispatchCause, "rule">;

/** 一条派发请求：**要开一个 run** 这条事实（不是工作项状态变迁）。 */
export type SquadDispatchRequest = {
  /** 被指派的工作项（run 挂在它下面）。 */
  workItemId: string;
  /**
   * 这次派发的**成因**（用户侧子集）：服务面在事件源头就分好（队长工具 vs UI 改派），
   * 本 hub 与 host 派发桥**只搬运、不二次判定**；`rule` 那一档由 host 在派发桥里就地归并
   * （规则到点的消息不经这条链）。
   */
  cause: UserDispatchCause;
  /**
   * 这次派发要派给**谁**：`{ type, id }`（`reassignWorkItem` / `assignWorkItem` 刚写进 `assignee` 的
   * 那个值）。**为什么是 assignee 而不是裸 `agentId`**：请求描述的是「要把这条活派给谁」这一**事实**，
   * 而小队也能被指派 —— 负责人是 `squad` 时派发路径解析出的是一条**队长 run**（`planDispatch` 从快照
   * 重读工作项，请求里的这个字段只用于 eventKey 命名与日志）。身份里带类型还避免「智能体 X」与
   * 「小队 X」在台账/日志里撞名（两个 id 空间彼此独立）。
   *
   * **不出现 `user`**：指派给人**不发**这条请求（人不需要被派 run ——「指派给人 = 等人自己动手」，
   * 见 `reassignWorkItem` 的语义 4），故这条事实里 run 的对象只可能是 agent / squad。
   */
  assignee: WorkItemDispatchAssignee;
  /** 目标 workspace：runtime 的**绑定值**（不是调用方传进来的，避免「读错的 workspace 上开 run」）。 */
  workspacePath: string;
  workspaceIdentity: string;
};

export type SquadDispatchRequestHub = {
  /** 发布一条派发请求（runtime 的 `emitWorkItemEvent` 里对 `dispatch_requested` 调它）。 */
  publish(request: SquadDispatchRequest): void;
  /** 订阅入口（组合根**订一次**）。返回解绑函数。 */
  subscribe(handler: (request: SquadDispatchRequest) => void): () => void;
};

/**
 * 造一个派发请求 hub。组合根建**一份**并注入给所有 runtime（「单例」指的是这个实例，
 * 不是模块级全局——模块级全局会让两次 `createLocalServices` 互相串台）。
 */
export function createSquadDispatchRequestHub(): SquadDispatchRequestHub {
  const handlers = new Set<(request: SquadDispatchRequest) => void>();
  return {
    publish(request) {
      // 逐个调用，与 runtime 的 `fanout` 同形：一个订阅者抛错不影响其余订阅者。
      for (const handler of handlers) handler(request);
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}
