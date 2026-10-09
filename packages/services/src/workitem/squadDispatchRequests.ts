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
 *   由派发桥就地归并（见 `SquadDispatchRequest.cause`）；
 * · `comment`：评论触发（`@agent` / 隐式路由级联）发起的派发 —— spec §5.2 明文「评论成因必须
 *   另行扩展，不得把 `@` 伪装成 `user_reassign`」。它**也不经**改派事件链：出口是 CommentService
 *   的 dispatch receipt（0012）+ 派发请求 hub 的 comment 变体，host 侧由评论派发入口合并。
 *
 * **NULL 是列上的合法值**：遗留行 / 未知成因 —— 读回**不得猜**（`readDispatchCause` 对枚举外值响亮抛）。
 */
export const DISPATCH_CAUSES = ["leader_tool", "user_reassign", "rule", "comment"] as const;
export type DispatchCause = (typeof DISPATCH_CAUSES)[number];

/**
 * 用户侧子集（**不含 `rule`，也不含 `comment`**）：`workitem.dispatch_requested` 事件载荷与常驻 hub
 * 的**改派**请求只可能是这两者 —— 规则触发是 host 自己的接法、评论触发走 receipt/comment 变体，
 * 两者都不经过服务面这条改派事件链（那条链上没有第二个写入者）。
 * 收窄成子集而不是复用全集：让「事件载荷里冒出 `rule` / `comment`」在**类型层**就不可表达
 * （宽松的联合放行后，写错的那条路径不会有任何编译错）。
 */
export type UserDispatchCause = Exclude<DispatchCause, "rule" | "comment">;

/** 一条派发请求：**要开一个 run** 这条事实（不是工作项状态变迁）。 */
export type SquadDispatchRequest = {
  /** 被指派的工作项（run 挂在它下面）。 */
  workItemId: string;
  /** 目标 workspace：runtime 的**绑定值**（不是调用方传进来的，避免「读错的 workspace 上开 run」）。 */
  workspacePath: string;
  workspaceIdentity: string;
} & (
  | {
      /**
       * 请求种类（判别位）。**缺省 = `assignment`**（既有形态）：队长工具 / UI 改派。
       *
       * 为什么做成可选而不是必填：本域既有生产者（`applyWorkItemAssignee` 的 emit）与既有消费者
       * （host 的 `dispatchSquadAssignment`）形状不变（加法纪律）；新生产者（评论出口）显式给
       * `kind: "comment"`，消费者按它分流到评论派发入口。
       */
      kind?: "assignment";
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
    }
  | {
      kind: "comment";
      /**
       * 评论派发的成因**恒为** `comment`（不是「由调用者随便填」）：请求形状本身就是这条事实
       * （§5.2 明文评论成因另行扩展），写成字面量让「评论请求带着别的成因」在类型层不可表达。
       */
      cause: "comment";
      /**
       * 评论请求的**身份**（§8.1 独立构造，`computeCommentDispatchKey`）：receipt 主键、
       * host 台账 runId（eventKey）、以及「同一评论重投 ⇒ 同一条 run」的幂等键。**不得**在 host
       * 或本 hub 另造一个。
       */
      dispatchKey: string;
      /**
       * 本次要派给的**目标 agent**（§4.5 五源解析出的点名者）——**可以不是 assignee**：
       * `@agent` 是一次运行请求而非改派（§5.2），故评论请求**必带目标**，由 `planDispatch` 的
       * `targetOverride` 覆盖 assignee 推导（B-1 裁定）。
       */
      targetAgentId: string;
    }
);

export type SquadDispatchRequestHub = {
  /** 发布一条派发请求（runtime 的 `emitWorkItemEvent` 里对 `dispatch_requested` 调它）。 */
  publish(request: SquadDispatchRequest): void;
  /** 订阅入口（组合根**订一次**）。返回解绑函数。 */
  subscribe(handler: (request: SquadDispatchRequest) => void): () => void;
};

/* 两个判别别名（加法）：订阅侧（组合根）与执行侧（host 两个派发入口）按 kind 分流后各自拿到
   收窄的形状 —— 不窄化的话 `request.assignee` / `request.dispatchKey` 在另一支上不存在，
   而在两处各写一遍 `Extract<...>` 迟早漂移（漂移表现为「改派入口读到评论字段」且不报错）。 */
export type SquadAssignmentDispatchRequest = Extract<SquadDispatchRequest, { kind?: "assignment" }>;
export type SquadCommentDispatchRequest = Extract<SquadDispatchRequest, { kind: "comment" }>;

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
