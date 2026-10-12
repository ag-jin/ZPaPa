/**
 * TaskOutput / TaskStop 的 registry miss 回退（spec 2026-10-08-subagent-orphan-reconcile §1.8，
 * 2026-10-12 裁决 3 = 3D）。
 *
 * 背景：`runtimeTaskRegistry` 是进程私有内存态、重启即空，所以「重启后按 agentId 查输出」直接
 * `No task found`——「output.txt 是事实源」这条运维兜底在重启场景失效。回退解析与读面/收敛
 * **同一把尺**：
 *   agentId → childSessionId 确定性推导（`sess_subagent_<agentId>`，与 runner 生成 child 会话
 *   同一函数）→ child 会话在场 ∧ `taskType === "subagent_child"`（归属校验）→ 终态锚
 *   `subagent_outcome` entry（唯一解释器，只认 `lost`）→ output 取恢复面（child transcript 尾部）。
 *
 * 诚实边界：真实完成 / 失败的死任务**不在**本解析面内（没有 entry ⇒ 维持既有 `No task found`）；
 * 它们的 output.txt 在产物目录里，由文件面读，本机制不猜。
 *
 * 只读：不写 registry（`notified` 认领在 registry miss 下无处落 ⇒ 回退读**不算** notified claim，
 * 既不抑制后续真实通知，也不影响丢失唤醒的账本判据）。
 */

import {
  SESSION_ENTRY_SUBAGENT_OUTCOME,
  createSessionId,
  subagentOutcomeEntryFact,
  type MessageWithParts,
  type SessionId,
  type TaskOutputTask,
} from "@zcode/contracts";
import type { ToolExecutionContext } from "../types.js";
import { extractSubagentTranscriptTail } from "../../subagent/recovery-surface.js";

/** lost → failed：沿用 row 层先例（spec §1.4a / §1.8），不新造终态词。 */
const LOST_TASK_STATUS = "failed" as const;

export interface LostSubagentTaskFact {
  task: TaskOutputTask;
  /** 收敛原因码（`subagent_outcome.data.reason`），供 TaskStop 报错文案使用。 */
  reason?: string;
}

/**
 * registry miss 时的只读回退解析：解析得出才返回（undefined = 维持既有 `No task found`）。
 * 任何一步读失败都按「解析不出」处理（不抛出：工具失败路径不该被 store 抖动放大）。
 */
export async function resolveLostSubagentTask(input: {
  agentId: string;
  context: ToolExecutionContext;
}): Promise<LostSubagentTaskFact | undefined> {
  const store = input.context.sessionStore;
  if (!store?.getSession || !store.messages) return undefined;
  const childSessionId = createSessionId(`subagent_${input.agentId}`) as SessionId;
  let child;
  try {
    child = await store.getSession(childSessionId);
  } catch {
    return undefined;
  }
  // 归属校验（house pattern：bootstrap/src/app/subagent-observation.ts 的 readSubagentTranscript 双查）：
  // 必须是「本会话派生的 subagent child」。只查 taskType 会让他会话的 agentId 也能在本会话里被
  // 解析出恢复面（同用户本地库内的越权读），所以 parentID 必须与当前会话一致。
  if (
    !child ||
    child.taskType !== "subagent_child" ||
    child.parentID !== input.context.sessionId
  ) {
    return undefined;
  }

  let entries;
  try {
    entries = await store.sessionEntries?.({
      sessionID: childSessionId,
      type: SESSION_ENTRY_SUBAGENT_OUTCOME,
    });
  } catch {
    return undefined;
  }
  const outcome = subagentOutcomeEntryFact(entries);
  if (!outcome) return undefined;

  let messages: readonly MessageWithParts[] = [];
  try {
    messages = await store.messages({ sessionID: childSessionId });
  } catch {
    messages = [];
  }
  const tail = extractSubagentTranscriptTail(messages);
  const reason = resolveOutcomeReason(entries);
  return {
    task: {
      task_id: input.agentId,
      task_type: "local_agent",
      status: LOST_TASK_STATUS,
      description: child.title || input.agentId,
      output: tail.text ?? "",
      ...(tail.text ? { result: tail.text } : {}),
      error: `Background agent lost: its host process exited before completion (reason: ${
        reason ?? "runtime_exit"
      }). No completion result or output file exists; the recovered partial output from the subagent transcript is shown${
        tail.text ? " above" : " empty (no assistant text before the exit)"
      }.`,
    },
    ...(reason ? { reason } : {}),
  };
}

function resolveOutcomeReason(entries: readonly { data?: unknown }[] | undefined): string | undefined {
  for (const entry of entries ?? []) {
    const data = entry.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const record = data as Record<string, unknown>;
    if (record.status !== "lost") continue;
    const reason = typeof record.reason === "string" ? record.reason.trim() : "";
    return reason || undefined;
  }
  return undefined;
}
