import type { IServiceAccessor, IWorkItemCollaborationServiceShape } from "@zcode/services";

/* B5.1 轮 1：工作项协作读门面在 UI 侧的**取数通路**（逐句对齐 `squadRuntimeAccess.ts`）。

   为什么这里要自己声明成员形状、而不是直接用 `@zcode/services` 的 `IServiceAccessor`：
   `IServiceAccessor` 没有 `get(descriptor)` 这类通用入口，renderer 的实现是逐字段建代理的
   **具体类**（`packages/client/src/remoteServiceAccess.ts`），所以「描述符已注册」不等于
   「UI 能取到」—— 必须先在 renderer 侧补上映射（B5.1 已补：`workItemCollaborationService`）。
   故形状在 UI 侧就地声明为**可选成员**：既让 UI 能安全地读，也不改动 services 的既有契约。

   取不到时**响亮失败**（下面的 error），不返回 undefined：静默兜底会把「服务没接上」
   伪装成「这条工作项没有任何评论/活动」—— 一句听起来很正常、但完全错误的话。 */

/** 稳定错误码（照 `SQUAD_RUNTIME_SERVICE_UNAVAILABLE_CODE` 的做法）：跨层识别「服务没接上」。 */
export const WORK_ITEM_COLLABORATION_SERVICE_UNAVAILABLE_CODE =
  "work_item_collaboration_service_unavailable";

export class WorkItemCollaborationServiceUnavailableError extends Error {
  readonly code = WORK_ITEM_COLLABORATION_SERVICE_UNAVAILABLE_CODE;
  constructor() {
    super(
      `[${WORK_ITEM_COLLABORATION_SERVICE_UNAVAILABLE_CODE}] 当前 accessor 上没有 workItemCollaborationService：` +
        `renderer 侧未映射 channel（packages/client/src/remoteServiceAccess.ts），` +
        `或 host 未注册 IWorkItemCollaborationService。`,
    );
    this.name = "WorkItemCollaborationServiceUnavailableError";
  }
}

/** UI 侧期望的 accessor 形状：`workItemCollaborationService` 是**可选**成员（非 desktop 通路可不提供）。 */
export type WorkItemCollaborationServiceAccessor = IServiceAccessor & {
  readonly workItemCollaborationService?: IWorkItemCollaborationServiceShape;
};

export function resolveWorkItemCollaborationService(
  services: IServiceAccessor,
): IWorkItemCollaborationServiceShape {
  // 只读这一个属性：不顺手去读别的服务（既有服务的取数行为不受本模块影响）。
  const service = (services as WorkItemCollaborationServiceAccessor).workItemCollaborationService;
  if (!service) {
    throw new WorkItemCollaborationServiceUnavailableError();
  }
  return service;
}
