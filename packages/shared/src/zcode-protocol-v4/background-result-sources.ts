// 后台结果来源闭集（**唯一副本**）：schema / producer / 冷恢复解析器共用。
//
// 为什么单独一个模块：这套取值原先在 3+ 处各写一份（`workflow-row-meta` schema、`rows` 行 schema、
// `telemetry` fact schema、`conversation-telemetry-facts` 的 producer 白名单、`transcript-hydration`
// 的解析器），2026-10-12 加 `"subagent_lost"`（重启收敛的丢失唤醒）时只改了 schema、漏了 producer，
// 新值到不了任何 fact（代码评审 S-2）。抽成一份后，加值只改这里。
//
// 消费侧**不是**全部平权（刻意如此）：
// - UI 轮标题白名单（`packages/ui/src/v4/ConversationTurnGroup.tsx` 的 `BACKGROUND_RESULT_TITLE_SOURCES`）
//   是它的**子集**，不含 `"subagent_lost"` —— 丢失轮不允许被渲染成「后台结果」；
// - 遥测/聚合判据按 `=== "subagent"` / `=== "workflow"` 分叉，新值天然落在「不计入结果消费」侧。
export const BACKGROUND_RESULT_SOURCES = ["bash", "subagent", "workflow", "subagent_lost"] as const;

export type BackgroundResultSource = (typeof BACKGROUND_RESULT_SOURCES)[number];
