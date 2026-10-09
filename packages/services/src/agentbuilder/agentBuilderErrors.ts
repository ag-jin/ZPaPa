/* AgentBuilder 的类型化错误（**只依赖 Error**：本文件会被根入口导出给 renderer，
   所以既不能 import node:*，也不能拖进 logger 之类的服务实现依赖）。 */

/** 跨层识别用的稳定错误码（照 `SQUAD_RUNTIME_SERVICE_UNAVAILABLE_CODE` 的做法）。 */
export const AGENT_BUILDER_ERROR_CODES = {
  /** 没有可用的模型（用户没配 / Host 没发布 preferredSelection）⇒ UI 引导去手动创建。 */
  modelUnavailable: "agent_builder_model_unavailable",
  /** 模型请求本身失败 ⇒ UI 提供「重试本轮」。 */
  requestFailed: "agent_builder_request_failed",
} as const;

export type AgentBuilderErrorReason = "model-unavailable" | "request-failed";

export class AgentBuilderError extends Error {
  readonly code: string;
  constructor(
    message: string,
    readonly reason: AgentBuilderErrorReason,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "AgentBuilderError";
    this.code =
      reason === "model-unavailable"
        ? AGENT_BUILDER_ERROR_CODES.modelUnavailable
        : AGENT_BUILDER_ERROR_CODES.requestFailed;
  }
}
