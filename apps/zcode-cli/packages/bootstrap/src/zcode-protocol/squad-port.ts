import {
  type SquadAssignWorkItemOutput,
  type SquadCreateChildWorkItemOutput,
  type SquadPort,
  type SquadRoster,
} from "@zcode/contracts";
import {
  zcodeProtocolMethods,
  zcodeSquadAssignWorkItemResultSchema,
  zcodeSquadCreateChildWorkItemResultSchema,
  zcodeSquadListRosterResultSchema,
} from "@zcode/shared";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * 队长派单端口的协议实现：把 core 的两个工具翻译成 **CLI → Host 的反向 JSON-RPC**，
 * 形状照抄 `automation-port.ts`（`context.requestClient(method, params, resultSchema)`）。
 *
 * 归属隔离（Step 0 / brief）：
 * - 本文件**只发请求**，不写任何工作项状态；`assignWorkItem` 最终落到 Host 侧的服务层
 *   （Wave 0 的 `ISquadRuntimeService` 路径），由唯一写者 `workItemService` 消费派发事件。
 * - 服务层在实验关闭时抛 `SquadDispatchDisabledError`（稳定码 `squad_dispatch_disabled`）：
 *   Host 把它作为 JSON-RPC error 回给这里 → `requestClient` 抛 `ProtocolRequestError` →
 *   本层**不 catch、不改写**，让它原样穿到工具 handler、再到模型。
 *   在这里再判一次实验开关就是第二份判据——正是本条要消灭的形态。
 * - 结果 schema 逐项解析（不是只加常量）：协议返回体必须过 zod 才能进 core，
 *   照 `automation-port.ts` 的 `zcodeAutomationCreateResultSchema` 同款。
 */
export function createProtocolSquadPort(context: ZCodeProtocolAgentServerContext): SquadPort {
  return {
    async createChildWorkItem(input): Promise<SquadCreateChildWorkItemOutput> {
      const result = await context.requestClient(
        zcodeProtocolMethods.squadCreateChildWorkItem,
        {
          parentId: input.parentId,
          title: input.title,
          ...(input.body ? { body: input.body } : {}),
          assigneeAgentId: input.assigneeAgentId,
        },
        zcodeSquadCreateChildWorkItemResultSchema,
      );
      return { workItemId: result.workItemId };
    },

    async assignWorkItem(input): Promise<SquadAssignWorkItemOutput> {
      const result = await context.requestClient(
        zcodeProtocolMethods.squadAssignWorkItem,
        { workItemId: input.workItemId, agentId: input.agentId },
        zcodeSquadAssignWorkItemResultSchema,
      );
      return { dispatched: result.dispatched };
    },

    async listRoster(): Promise<SquadRoster> {
      const result = await context.requestClient(
        zcodeProtocolMethods.squadListRoster,
        {},
        zcodeSquadListRosterResultSchema,
      );
      return {
        leaderAgentId: result.leaderAgentId,
        members: result.members.map((member) => ({ agentId: member.agentId })),
      };
    },
  };
}
