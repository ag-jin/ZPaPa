// 远程 workspace scope → Controller source 的解析胶水。
//
// 单独成模块的理由：这段胶水是「同一设备多项目」修复的判决点 —— 它必须用
// **被请求的** workspace 上下文去构造 source（registry 的 findSessionForWorkspace
// 返回的就是被请求上下文），而不是用 logical session 的"当前绑定"。一台被投射设备
// 可同时投射多个项目，当前绑定可能已经是另一个项目；用当前绑定构造 source 会让
// 非当前项目的会话既看不到也写不进。放在这里是为了让它能被层 1 直接测到。
import type { WindowHostAttachmentScope } from "@zcode/shared";
import { IZCodeAgentService, IZCodeTaskService, type ServiceCollection } from "@zcode/services";
import type { WindowHostControllerSourceScope } from "./windowHostControllerProjection.js";

export interface RemoteControllerSource {
  scope: WindowHostControllerSourceScope;
  taskService?: IZCodeTaskService;
  agentService?: IZCodeAgentService;
  sourceAvailability: "online" | "offline";
}

/** 远程连接 registry 需要的最小面（便于测试注入真实 registry 或替身）。 */
export interface RemoteControllerSourceRegistry {
  findSessionForWorkspace(params: { workspacePath: string; workspaceIdentity?: string }): {
    remoteSessionId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    sourceAvailability: "online" | "offline";
  } | null;
  resolveScopedServices(scope: WindowHostAttachmentScope): ServiceCollection;
}

export function resolveRemoteControllerSource(params: {
  scope: { workspacePath: string; workspaceIdentity?: string };
  registry: RemoteControllerSourceRegistry;
}): RemoteControllerSource | null {
  const remoteSession = params.registry.findSessionForWorkspace(params.scope);
  if (!remoteSession?.workspacePath || !remoteSession.workspaceIdentity) {
    return null;
  }
  const controllerScope = {
    kind: "remote" as const,
    remoteSessionId: remoteSession.remoteSessionId,
    workspacePath: remoteSession.workspacePath,
    workspaceIdentity: remoteSession.workspaceIdentity,
  };
  if (remoteSession.sourceAvailability !== "online") {
    return { scope: controllerScope, sourceAvailability: "offline" as const };
  }
  const services = params.registry.resolveScopedServices(controllerScope);
  return {
    scope: controllerScope,
    taskService: services.get(IZCodeTaskService),
    agentService: services.getOptional(IZCodeAgentService),
    sourceAvailability: "online" as const,
  };
}
