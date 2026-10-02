import type {
  IServiceAccessor,
  ISquadRuntimeServiceShape,
  SquadWorkspaceTarget,
} from "@zcode/services";

/* 小队运行时在 UI 侧的**取数通路**。

   为什么这里要自己声明成员形状、而不是直接用 `@zcode/services` 的 `IServiceAccessor`：
   `IServiceAccessor`（`packages/services/src/accessor.ts`）**没有** `get(descriptor)` 这类通用入口，
   renderer 的实现是逐字段建代理的**具体类**（`packages/client/src/remoteServiceAccess.ts`），
   所以「描述符已注册」并不等于「UI 能取到」—— 必须先在 renderer 侧补上映射（本次已补）。
   该接口的成员表属于 services 包，本轮扩权只到 `packages/client/**` 与 `packages/ui/**`，
   故形状在 UI 侧就地声明为**可选成员**的交叉类型：既让 UI 能安全地读，也不改动 services 的任何既有契约。

   取不到时**响亮失败**（下面的 error），不返回 undefined：静默兜底会让界面一片空白，
   用户分不清「这个 workspace 没有小队数据」与「服务根本没接上」。 */

/** 稳定错误码（照 `SQUAD_DISPATCH_DISABLED_CODE` 的做法）：跨层识别「服务没接上」这一类失败。 */
export const SQUAD_RUNTIME_SERVICE_UNAVAILABLE_CODE = "squad_runtime_service_unavailable";

export class SquadRuntimeServiceUnavailableError extends Error {
  readonly code = SQUAD_RUNTIME_SERVICE_UNAVAILABLE_CODE;
  constructor() {
    super(
      `[${SQUAD_RUNTIME_SERVICE_UNAVAILABLE_CODE}] 当前 accessor 上没有 squadRuntimeService：` +
        `renderer 侧未映射 channel（packages/client/src/remoteServiceAccess.ts），` +
        `或 host 未注册 ISquadRuntimeService。`,
    );
    this.name = "SquadRuntimeServiceUnavailableError";
  }
}

/** UI 侧期望的 accessor 形状：`squadRuntimeService` 是**可选**成员（非 desktop 通路可不提供）。 */
export type SquadRuntimeServiceAccessor = IServiceAccessor & {
  readonly squadRuntimeService?: ISquadRuntimeServiceShape;
};

export function resolveSquadRuntimeService(services: IServiceAccessor): ISquadRuntimeServiceShape {
  // 只读这一个属性：不顺手去读别的服务（既有服务的取数行为不受本模块影响）。
  const runtimeService = (services as SquadRuntimeServiceAccessor).squadRuntimeService;
  if (!runtimeService) {
    throw new SquadRuntimeServiceUnavailableError();
  }
  return runtimeService;
}

/**
 * 由 UI 已有的激活 workspace 求 `SquadWorkspaceTarget`（spec 确认 3：runtime 按目标现构、不缓存，
 * `ISquadRuntimeService` 的每个方法第一个参数都要显式带目标，**不存在隐式默认 workspace**）。
 *
 * 目标只取自调用方给的 active workspace：本函数**不挑**、不猜、不回落；
 * 没有激活 workspace（或 path 是空白）⇒ 返回 `null`，由调用方决定展示什么（本视图显示「无激活工作区」）。
 * 这正是「候选多于一个不得静默挑一个」的同一条纪律：解析不出唯一目标就不要造一个出来。
 *
 * `identity` 缺省为空串：服务内部按 `identity?.trim() || path` 求 workspaceKey（C14），
 * 故空串会自然回落到 path；这里不自己拼 key，避免出现第二份口径。
 */
export function squadWorkspaceTarget(
  activeWorkspacePath: string | null | undefined,
  activeWorkspaceIdentity: string | null | undefined,
): SquadWorkspaceTarget | null {
  const path = activeWorkspacePath?.trim();
  if (!path) return null;
  return { path, identity: activeWorkspaceIdentity?.trim() ?? "" };
}
