import {
  AUTOMATION_BOUND_SESSION_BUSY_ERROR_CODE,
  hasBlockingActiveSnapshotRuntime,
} from "@zcode/shared";
import { ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE, type IZCodeAgentService } from "@zcode/services";

/**
 * 绑定会话的空闲门控：定时任务派发前确认目标会话当前没有正在执行的 turn。
 *
 * 为什么必须单独探测而不是读 tasks-index 的 task_status：那张表是投影，
 * 崩溃/强杀会留下长期残留的 running 行（实测有记录停留数月），据此判断会永久卡住派发。
 * 这里改为读 Agent runtime 快照，判据复用 domain 既有的
 * hasBlockingActiveSnapshotRuntime（任务状态派生用的是同一个定义）。
 */

/** 探测失败时是否按“忙”处理。取 false（放行）：无 runtime 只说明会话未激活，不是忙。 */
export type BoundSessionExecutingProbe = (params: {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}) => Promise<boolean>;

/**
 * 目标会话正在执行一轮 turn。
 *
 * 与 off-peak 的 BoundSessionBusyError 一样，抛出必须发生在写会话配置之前，
 * 否则会把用户会话的 mode/模型悄悄改掉再被 session/send 以 -32010 拒绝。
 *
 * 消息里带稳定错误码：manual「立即运行」不进入等待队列，需要提示用户稍后重试，
 * 跨 RPC 传到 UI 后按码识别（同 AutomationCreateLimitError 的做法）。
 */
export class BoundSessionBusyError extends Error {
  readonly code = AUTOMATION_BOUND_SESSION_BUSY_ERROR_CODE;

  constructor(readonly sessionId: string) {
    super(
      `[${AUTOMATION_BOUND_SESSION_BUSY_ERROR_CODE}] automation bound session is executing, wait until it becomes idle: ${sessionId}`,
    );
    this.name = "BoundSessionBusyError";
  }
}

function isRuntimeUnavailableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE
  );
}

/**
 * 读取目标会话是否正在执行。
 *
 * existing-only：绝不为一次派发探测拉起新 Agent 进程；无 runtime 直接判为不忙，
 * 让派发走既有 resumeTask 路径（冷恢复发生在真正需要时）。
 * 探测异常同样放行——按“忙”处理会让一次快照读取故障永久推迟提醒。
 */
export function createBoundSessionExecutingProbe(params: {
  agentService: Pick<IZCodeAgentService, "readSession">;
  logWarn: (message: string, error: unknown) => void;
}): BoundSessionExecutingProbe {
  return async ({ sessionId, workspacePath, workspaceIdentity }) => {
    try {
      const snapshot = await params.agentService.readSession({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        sessionId,
        runtimePolicy: "existing-only",
      });
      return hasBlockingActiveSnapshotRuntime(snapshot);
    } catch (error) {
      if (isRuntimeUnavailableError(error)) return false;
      params.logWarn(
        `automation bound session busy probe failed session=${sessionId} (派发放行)`,
        error,
      );
      return false;
    }
  };
}
