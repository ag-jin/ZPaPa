// ============================================================
// Squad tools - leader dispatch tool set (create child work item / assign to member)
// ============================================================
//
// 与既有工具集的边界（spec §14 要求每个工具在工具文档中写明）：
// - `Agent` / `Task`：在当前对话内起一个**临时**子代理，产物回到本会话。协作小队的队员是
//   **独立会话 + 独立工作树**的长期队友，由 `SquadAssignWorkItem` 走派发事件唤醒。
// - `SendMessage`：向当前会话内的子代理 / 通信通道发消息，**不改**任何工作项事实。
// - `CronCreate` / `CronUpdate`：管「无工作项的定时任务」定义（spec §5.6）；挂在**工作项**上的
//   触发属于唤醒规则，不在这里。
// - 本文件只做两件事：**建子工作项** 与 **派给队员**——都只产出派发事件，**绝不**写工作项状态
//   （唯一写者是 `workItemService.transition`，spec §4.3）。
//
// 留白：spec §14 的另外两个工具（**汇报** / **请求审查**）留到 P2c，本文件不给它们开口子。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

const nonEmptyString = z.string().trim().min(1);

export const SquadCreateChildWorkItemInputSchema = z
  .object({
    parentId: nonEmptyString.describe(
      "Id of the existing parent work item this child hangs under. Required: a child without its parent would float outside the work-item tree.",
    ),
    title: nonEmptyString.describe(
      "Short imperative title for the child work item, describing the piece of work the member should do.",
    ),
    body: nonEmptyString
      .optional()
      .describe(
        "Optional longer description of the child's expected outcome, constraints and how to verify it.",
      ),
    assigneeAgentId: nonEmptyString.describe(
      "Id of the team agent that should own this child (must be in the squad roster; the leader itself is also a valid assignee).",
    ),
  })
  .strict();
export type SquadCreateChildWorkItemInput = z.infer<typeof SquadCreateChildWorkItemInputSchema>;
export const SquadCreateChildWorkItemInputJsonSchema = toToolJsonSchema(
  SquadCreateChildWorkItemInputSchema,
);

export const SquadCreateChildWorkItemOutputSchema = z
  .object({
    workItemId: nonEmptyString.describe("Id of the newly created child work item."),
  })
  .strict();
export type SquadCreateChildWorkItemOutput = z.infer<typeof SquadCreateChildWorkItemOutputSchema>;
export const SquadCreateChildWorkItemOutputJsonSchema = toToolJsonSchema(
  SquadCreateChildWorkItemOutputSchema,
);

export const SquadAssignWorkItemInputSchema = z
  .object({
    workItemId: nonEmptyString.describe(
      "Id of the work item (or child work item) to assign to a member.",
    ),
    agentId: nonEmptyString.describe(
      "Id of the team agent to assign to. Must be in the squad roster; anything else is rejected loudly so the item never hangs on a member that will never run.",
    ),
  })
  .strict();
export type SquadAssignWorkItemInput = z.infer<typeof SquadAssignWorkItemInputSchema>;
export const SquadAssignWorkItemInputJsonSchema = toToolJsonSchema(SquadAssignWorkItemInputSchema);

export const SquadAssignWorkItemOutputSchema = z
  .object({
    /** 派发事件已投递（不是「工作项已改状态」——状态由 workItemService 消费事件后自行流转）。 */
    dispatched: z.boolean().describe("Whether the dispatch event was accepted for this work item."),
  })
  .strict();
export type SquadAssignWorkItemOutput = z.infer<typeof SquadAssignWorkItemOutputSchema>;
export const SquadAssignWorkItemOutputJsonSchema = toToolJsonSchema(
  SquadAssignWorkItemOutputSchema,
);
