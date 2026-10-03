/* 派发请求的**常驻订阅出口**（Task 7 第 2 轮裁定，落点 ii）。

   为什么需要它：`SquadRuntime` 是**按目标现构、不缓存**的（确认 3），而工作项事件的订阅表在
   **实例内部** ⇒ 常驻侧（host 进程里的组合根）**订不到**某个实例的订阅表 —— 于是「队长派单只发一条
   `workitem.dispatch_requested`」在当前架构下**驱动不出 run**（事件发出去了，没有任何常驻订阅者收得到）。

   裁定给的解法：把**派发请求**这一格的出口做成**可注入的单例 hub**，由组合根建**一份**、注入给每个
   runtime（`createSquadRuntime` 的 `dispatchRequestHub`），runtime 在发出 `workitem.dispatch_requested`
   时一并 `publish`；组合根**订一次**（`createLocalServices` 里），转给 host 注入的派发执行体。
   **加法式**：既有的 `subscribeWorkItemEvents`（实例级订阅表）一字未改，既有调用方不受影响。

   本文件必须**浏览器安全**（它被 `squadRuntime.ts` 值导入，而该文件同时也被测试与 node 侧使用）：
   只 import type，不触达 `node:*`，因此不引入任何运行时依赖。 */

/** 一条派发请求：**要开一个 run** 这条事实（不是工作项状态变迁）。 */
export type SquadDispatchRequest = {
  /** 被指派的工作项（run 挂在它下面）。 */
  workItemId: string;
  /** 被指派到的队员（`assignWorkItem` 刚写进 `assignee` 的那个值）。 */
  agentId: string;
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
