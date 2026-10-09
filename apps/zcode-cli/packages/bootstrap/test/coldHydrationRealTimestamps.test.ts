// 冷恢复行的 startedAt/endedAt 必须取**持久化 part 的真实时间**，不是合成时间（base+seq）。
//
// 为什么这组用例承重：hydration 的 `push()` 兜底时间戳是 `baseMs + seq`（会话首条消息时间 +
// 事件序号）。tool/subagent part 持久化里本来带着真实的 `time.start/end`，但合成事件过去不带
// source timestamp ⇒ 投影行的 createdAt/startedAt/endedAt 全部落到合成值：
//   - 面板 Agent 行的「已运行」按 `now - row.startedAt` 算 ⇒ 冷恢复后的 running 行量出
//     **整个会话的年龄**（用户实测截图：2199 分 47 秒 ≈ 36.7 小时 = 会话年龄，而非任务时长）；
//   - 侧栏/目录按 startedAt/endedAt 排序 ⇒ 同会话的历史行被挤在会话开头同一毫秒附近。
// 事件全序始终由 sequenceNumber 裁决，时间戳只服务展示事实——所以补真实时间不改任何顺序语义。
//
// 用例直接钉「来源」：断言行时间 === part 里写的那个数，而不是断言「不是合成值」——
// 后者在 baseMs 恰好等于 part 时间时会假绿。

import assert from "node:assert/strict";
import test from "node:test";
import { createSessionId, type MessageWithParts } from "@zcode/contracts";
import { mergeColdConversationEvents } from "../src/zcode-protocol-v4/cold-event-merge.js";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import type { HydratedSubagentChildFacts } from "../src/zcode-protocol-v4/transcript-hydration.js";

const SESSION_ID = "sess_cold_timestamps";
const AGENT_ID = "agent_timestamps-1111-4222-8333-444444444444";
const CHILD_SESSION_ID = String(createSessionId(`subagent_${AGENT_ID}`));
const TURN_ID = "turn_cold_timestamps";
const USER_MESSAGE_ID = "msg_cold_timestamps_user";
const ASSISTANT_MESSAGE_ID = "msg_cold_timestamps_assistant";
/** 会话开始时刻与任务执行时刻相差 36 小时：合成本底（base+seq）与真实时间的差异必须可辨。 */
const SESSION_BASE_MS = 1_700_000_000_000;
const TASK_START_MS = SESSION_BASE_MS + 36 * 3_600_000;
const TASK_END_MS = TASK_START_MS + 5_000;

function userMessage(): MessageWithParts {
  return {
    info: {
      id: USER_MESSAGE_ID,
      role: "user",
      time: { created: SESSION_BASE_MS },
      semantics: {
        origin: "real_user",
        kind: "user_prompt",
        uiVisibility: "visible",
        providerVisibility: "visible",
        transcriptVisibility: "visible",
      },
      anchor: { turnId: TURN_ID, origin: "realUser" },
    },
    parts: [{ id: "part_cold_timestamps_user_text", type: "text", text: "跑一个任务" }],
  } as unknown as MessageWithParts;
}

function backgroundLaunchAck(): string {
  return [
    "Async agent launched successfully.",
    `agentId: ${AGENT_ID} (internal ID - do not mention to user. Use SendMessage with to: '${AGENT_ID}' to continue this agent.)`,
    "The agent is working in the background. You will be notified automatically when it completes.",
  ].join("\n");
}

function assistantMessage(parts: readonly unknown[], completedAt: number): MessageWithParts {
  return {
    info: {
      id: ASSISTANT_MESSAGE_ID,
      role: "assistant",
      parentID: USER_MESSAGE_ID,
      time: { created: TASK_START_MS - 500, completed: completedAt },
      finish: "tool-calls",
      semantics: {
        origin: "agent_runtime",
        kind: "assistant_response",
        uiVisibility: "visible",
        providerVisibility: "visible",
        transcriptVisibility: "visible",
      },
      anchor: { turnId: TURN_ID, historyRoundCount: 1 },
    },
    parts,
  } as unknown as MessageWithParts;
}

function backgroundAgentPart() {
  return {
    id: "part_cold_timestamps_agent",
    type: "tool",
    callID: "call_cold_timestamps_agent",
    tool: "Agent",
    state: {
      status: "completed",
      input: {
        description: "长跑后台 agent",
        prompt: "do work",
        run_in_background: true,
        subagent_type: "implementer",
      },
      output: backgroundLaunchAck(),
      time: { start: TASK_START_MS, end: TASK_START_MS + 100 },
    },
  };
}

function bashPart() {
  return {
    id: "part_cold_timestamps_bash",
    type: "tool",
    callID: "call_cold_timestamps_bash",
    tool: "Bash",
    state: {
      status: "completed",
      input: { command: "echo hi", description: "跑个命令" },
      output: "hi\n",
      time: { start: TASK_START_MS, end: TASK_END_MS },
    },
  };
}

/** child 已知、无终态 ⇒ 后台 spawn 行停在 running（48f7f18 语义），正是面板时长读的行。 */
function runningChildFacts(): HydratedSubagentChildFacts {
  return { knownChildSessionIds: new Set([CHILD_SESSION_ID]), terminalStates: new Map() };
}

function hydrate(
  messages: readonly MessageWithParts[],
  subagentChildFacts?: HydratedSubagentChildFacts,
) {
  const merged = mergeColdConversationEvents({
    memoryEvents: [],
    messages: [...messages],
    sessionId: SESSION_ID,
    ...(subagentChildFacts ? { subagentChildFacts } : {}),
  });
  const projection = new ProductProjection(SESSION_ID, "epoch-cold-timestamps");
  projection.beginHydrationReplay();
  for (const event of merged.events) projection.applyHydrationEvent(event);
  projection.completeHydrationReplay();
  return { events: merged.events, snapshot: projection.getSnapshot() };
}

test("冷恢复：后台 Agent running 行的 startedAt 取 spawn part 的真实启动时间", () => {
  const { snapshot } = hydrate(
    [userMessage(), assistantMessage([backgroundAgentPart()], TASK_START_MS + 5_000)],
    runningChildFacts(),
  );

  assert.equal(snapshot.subagents.running.length, 1);
  assert.equal(
    snapshot.subagents.running[0]?.startedAt,
    TASK_START_MS,
    "面板「已运行」按 now - startedAt 算：合成时间会量出会话年龄（用户截图的 2199 分钟量级）",
  );
  const [row] = snapshot.rows.window.filter((row) => row.kind === "subagent");
  assert.equal(row?.startedAt, TASK_START_MS);
});

test("冷恢复：后台 Agent 终态行的 endedAt 取 spawn part 的真实结束时间", () => {
  const ended = hydrate(
    [userMessage(), assistantMessage([backgroundAgentPart()], TASK_START_MS + 5_000)],
    {
      knownChildSessionIds: new Set([CHILD_SESSION_ID]),
      terminalStates: new Map([[CHILD_SESSION_ID, { status: "success" }]]),
    },
  );
  const [row] = ended.snapshot.rows.window.filter((row) => row.kind === "subagent");
  assert.equal(
    row?.endedAt,
    TASK_START_MS + 100,
    "终态行的排序时间必须取 part 的 end（launch ACK 时刻仍是持久化事实，不是合成值）",
  );
});

test("冷恢复：Bash 工具行的 createdAt/startedAt/endedAt 全取 part 真实时间", () => {
  const { snapshot } = hydrate([
    userMessage(),
    assistantMessage([bashPart()], TASK_END_MS + 1_000),
  ]);
  const [row] = snapshot.rows.window.filter(
    (row) => row.kind === "toolCall" && row.toolName === "Bash",
  );

  assert.equal(row?.createdAt, TASK_START_MS, "ToolCallScheduled 事件必须带 part 的 start");
  assert.equal(row?.startedAt, TASK_START_MS, "ToolCallStarted 事件必须带 part 的 start");
  assert.equal(row?.endedAt, TASK_END_MS, "ToolCallResult 事件必须带 part 的 end");
});

test("冷恢复：同一轮多个工具行按真实时间分开，不再压到同一合成毫秒", () => {
  const second = {
    ...bashPart(),
    id: "part_cold_timestamps_bash_2",
    callID: "call_cold_timestamps_bash_2",
    state: {
      ...bashPart().state,
      time: { start: TASK_START_MS + 60_000, end: TASK_END_MS + 60_000 },
    },
  };
  const { snapshot } = hydrate([
    userMessage(),
    assistantMessage([bashPart(), second], TASK_END_MS + 61_000),
  ]);
  const rows = snapshot.rows.window.filter(
    (row) => row.kind === "toolCall" && row.toolName === "Bash",
  );

  assert.deepEqual(
    rows.map((row) => row.startedAt),
    [TASK_START_MS, TASK_START_MS + 60_000],
    "两条工具行的时间必须各自来自自己的 part（合成则相邻 seq 只差 1 毫秒）",
  );
});

test("幂等：同一份 transcript 重放两次 ⇒ 行时间逐字段一致", () => {
  const messages = [
    userMessage(),
    assistantMessage([backgroundAgentPart()], TASK_START_MS + 5_000),
  ];
  const first = hydrate(messages, runningChildFacts());
  const second = hydrate(messages, runningChildFacts());

  assert.deepEqual(second.snapshot.rows.window, first.snapshot.rows.window);
  assert.deepEqual(second.snapshot.subagents, first.snapshot.subagents);
});
