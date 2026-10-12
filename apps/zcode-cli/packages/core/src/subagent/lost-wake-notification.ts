/**
 * 「后台 agent 已丢失」唤醒通知的文案（2026-10-12 裁决 1，spec §1.4b）。
 *
 * 与任务完成通知（`runtime-task/notification.ts`）刻意分开写：
 * - 状态词是 `lost`——它就是 child `subagent_outcome` entry 记下的终态（同一把尺），
 *   不是「结果到达」，也不是第二个终态裁决；
 * - 文案必须声明 **可能重复**：投递是 at-least-once（账本 promotion 与消息落盘不是同一事务，
 *   崩在中间会重投），模型不该把第二次通知当成第二个 agent 死亡；
 * - 文案必须给出恢复面摘要（spec §1.7）：被杀前的产出在 child 会话里，模型不必人肉翻会话；
 * - 文案同时写明「真实结果后来到场以真实结果为准」——读面优先级（真实 outcome > entry）的
 *   模型侧对应说法。
 */

import { escapeXml, truncateTaskNotification } from "../runtime-task/notification.js";

/** 唤醒通知的状态词（唯一取值：child entry 的 lost）。 */
export const SUBAGENT_LOST_WAKE_STATUS = "lost" as const;

export interface SubagentLostWakeNotificationInput {
  agentId: string;
  childSessionId: string;
  /** agent 的任务标题（父 transcript 的 spawn description）。 */
  description?: string;
  subagentType?: string;
  parentToolCallId?: string;
  /** 收敛原因码（spec §1.4a 的 `reason`）。 */
  reason: string;
  /** 恢复面摘要（child transcript 尾部）；缺席即不出现 `<result>` 节（截断标记随摘要同来）。 */
  recoveredOutput?: string;
}

export function formatSubagentLostWakeNotification(
  input: SubagentLostWakeNotificationInput,
): string {
  const lines = [
    "<task-notification>",
    `  <task-id>${escapeXml(input.agentId)}</task-id>`,
    ...(input.parentToolCallId
      ? [`  <tool-use-id>${escapeXml(input.parentToolCallId)}</tool-use-id>`]
      : []),
    `  <status>${SUBAGENT_LOST_WAKE_STATUS}</status>`,
    ...(input.subagentType ? [`  <subagent-type>${escapeXml(input.subagentType)}</subagent-type>`] : []),
    `  <child-session-id>${escapeXml(input.childSessionId)}</child-session-id>`,
    `  <summary>${escapeXml(
      `Background agent${input.description ? ` "${input.description}"` : ""} was lost: its host process exited before it could report a result.`,
    )}</summary>`,
    // 截断标记不在这里补：`extractSubagentTranscriptTail` 已在**头部**写准确的前缀
    // （`[N chars of earlier subagent output omitted]`），尾部再补一个会形成双标记且位置误导（S-7）。
    ...(input.recoveredOutput ? [`  <result>${escapeXml(input.recoveredOutput)}</result>`] : []),
    `  <error>${escapeXml(
      `Background agent lost (reason: ${input.reason}); no completion notification will follow.`,
    )}</error>`,
    `  <note>${escapeXml(
      "This notice may be delivered more than once after a restart. If a real result for this agent arrives later, the real result wins.",
    )}</note>`,
    "</task-notification>",
  ];
  return truncateTaskNotification(lines.join("\n"));
}
