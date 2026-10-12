/**
 * 恢复面：被打断的 in-flight 子代理的「被杀前产出」（spec
 * `docs/superpowers/specs/2026-10-08-subagent-orphan-reconcile.md` §1.7，2026-10-12 裁决 2 = 2B）。
 *
 * 背景：子代理产物目录（`output.txt` / `task.output`）只在**终态收尾**写；硬杀 / 崩溃 / 进程退出
 * 时一条都到不了（`write*AgentArtifacts` 不可达），所以「output.txt 是事实源」对 in-flight 是假话。
 * 被杀前的产出唯一仍在的持久面 = **child session 的 transcript 尾部**——写侧完全不变（零新写者、
 * 不落 partial 文件），恢复面是**读侧定义**。
 *
 * 本模块是该定义的**唯一提取函数**；三处消费（丢失唤醒的通知摘要、TaskOutput 的 registry miss
 * 回退、人/模型主动读 child 会话）都必须走它，各写一份提取就会造出「尾部到底是哪条」的第二解读。
 */

import { STREAM_RECOVERY_DISCARDED_ERROR_NAME, type MessageWithParts } from "@zcode/contracts";

/** 恢复面摘要上界（字符）：通知与工具结果都进模型上下文，必须有界。 */
export const SUBAGENT_RECOVERY_TAIL_MAX_CHARS = 4_000;

export interface SubagentTranscriptTail {
  /** 尾部文本；child 没有可读 assistant 文本时缺席（空态，不伪造内容）。 */
  text?: string;
  /** 是否发生截断（只保留了更早产出的尾部，前部以省略标记开头）。 */
  truncated: boolean;
}

/**
 * 提取 child transcript 尾部（恢复面）：
 * - 取**最后一条** assistant 消息（流恢复作废的半截 assistant 不参与——它不是 child 的产出，
 *   只说明恢复被中断）；
 * - 只收集 `type === "text"` 且 `ignored !== true` 的块，按序拼接（与读面 `lastChildOutcome`
 *   的文本口径一致）；
 * - 超过 {@link SUBAGENT_RECOVERY_TAIL_MAX_CHARS} 时保留**尾部**（最新产出最相关），前部加省略标记。
 */
export function extractSubagentTranscriptTail(
  messages: readonly MessageWithParts[],
): SubagentTranscriptTail {
  const assistant = [...messages]
    .reverse()
    .find(
      (message) =>
        message.info.role === "assistant" &&
        message.info.error?.name !== STREAM_RECOVERY_DISCARDED_ERROR_NAME,
    );
  if (!assistant) return { truncated: false };
  const text = assistant.parts
    .flatMap((part) => (part.type === "text" && part.ignored !== true ? [part.text.trim()] : []))
    .filter(Boolean)
    .join("\n\n");
  if (!text) return { truncated: false };
  if (text.length <= SUBAGENT_RECOVERY_TAIL_MAX_CHARS) return { text, truncated: false };
  const omitted = text.length - SUBAGENT_RECOVERY_TAIL_MAX_CHARS;
  return {
    text: `[${omitted} chars of earlier subagent output omitted]\n${text.slice(-SUBAGENT_RECOVERY_TAIL_MAX_CHARS)}`,
    truncated: true,
  };
}
