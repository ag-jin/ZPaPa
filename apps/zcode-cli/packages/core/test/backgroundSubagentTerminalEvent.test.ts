// 后台 Agent 的**终态事件**必须由「终态快照的观察者」发布，而不是只靠 subagent runner。
//
// 为什么这组用例承重：v4 投影的 `backgroundWorks`（后台面板的数据面）只有 BackgroundTask* 事件
// 一个写者，它是 append-only、无过期、无对账的。面板据此渲染「运行中的后台任务」卡片与停止入口，
// 所以**只要终态事件缺席，卡片就永远停在 executing、而停止按钮的目标早已结束**（用户实测现象）。
//
// tracker 的 1s 轮询是唯一周期性重读 runtime task registry 的组件：它必须把「注册表已终态」
// 这个事实发布出去，而不是因为「runner 大概自己发过了」就静默收摊。本文件的断言就是这条发布义务。

import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent, type SubagentTaskSnapshot } from "@zcode/contracts";
import { BackgroundTaskTracker } from "../src/tool/executor/background-tasks.js";

const AGENT_ID = "agent_00000000-0000-4000-8000-000000000001";
const CHILD_SESSION_ID = `sess_subagent_${AGENT_ID}`;
const TOOL_CALL_ID = "call_subagent_terminal";
const TRACE = { traceId: "trace-background-terminal" } as never;

const toolCall = {
  id: TOOL_CALL_ID,
  name: "Agent",
  input: { description: "长跑后台 agent", prompt: "do work", run_in_background: true },
} as never;

/** runner 已经跑完时的 launch output（与 Agent 工具返回的 async_launched 形状一致）。 */
const launchOutput = {
  status: "async_launched",
  agentId: AGENT_ID,
  childSessionId: CHILD_SESSION_ID,
  backgroundTaskId: AGENT_ID,
  agentType: "implementer",
} as never;

/**
 * runtime task registry 里的终态条目：runner 收尾后 `notified: true`。
 * 这个形状正是 tracker 静默收摊所依据的条件（旧行为下它什么都不发）。
 *
 * `type: "local_agent"` 必须在场：`subagentPort.getTask` 的声明类型是 SubagentTaskSnapshot，
 * 但真实返回的是 registry 里的 RuntimeTaskSnapshot（见 runner.ts 的 getTask → registry.get），
 * 而判断「已通知的本地 agent」正是读这个字段。缺了它用例会走不到那条分支（假绿）。
 */
function completedTaskSnapshot(
  overrides: Partial<SubagentTaskSnapshot> = {},
): SubagentTaskSnapshot {
  return {
    type: "local_agent",
    taskId: AGENT_ID,
    agentId: AGENT_ID,
    agentType: "implementer",
    childSessionId: CHILD_SESSION_ID as never,
    completedAt: new Date(),
    description: "长跑后台 agent",
    notified: true,
    startedAt: new Date(),
    status: "completed",
    ...overrides,
  } as unknown as SubagentTaskSnapshot;
}

function createTracker(options: { snapshot: SubagentTaskSnapshot | undefined }): {
  tracker: BackgroundTaskTracker;
  events: SessionEvent[];
} {
  const events: SessionEvent[] = [];
  const tracker = new BackgroundTaskTracker({
    emitEvent: async (event: SessionEvent) => {
      events.push(event);
    },
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
    runtimeScope: "main",
    runtimeTaskRegistry: {
      update: () => undefined,
      remove: () => {},
      get: () => undefined,
    },
    sessionId: "sess_parent_background_terminal",
    subagentPort: {
      getTask: async () => options.snapshot,
    },
  } as never);
  return { tracker, events };
}

const terminalEvents = (events: readonly SessionEvent[]): SessionEvent[] =>
  events.filter((event) => event.type === SessionEventType.BackgroundTaskCompleted);

/** 面板的「运行中」闸门：投影把终态映射成什么，卡片就据此消失（见 product-projection）。 */
const payloadStatus = (event: SessionEvent): unknown =>
  (event.payload as Record<string, unknown>).status;

test("后台 Agent 完成：tracker 必须发布终态事件（否则面板卡片永远停在 executing）", async () => {
  const { tracker, events } = createTracker({ snapshot: completedTaskSnapshot() });

  await tracker.trackBackgroundTask(toolCall, launchOutput, TRACE, "turn-1" as never);

  assert.equal(
    terminalEvents(events).length,
    1,
    `终态快照被观察到却没有终态事件；事件序列=${JSON.stringify(events.map((event) => event.type))}`,
  );
});

test("后台 Agent 完成：终态事件必须带上面板收口 work 所需的字段", async () => {
  const { tracker, events } = createTracker({ snapshot: completedTaskSnapshot() });

  await tracker.trackBackgroundTask(toolCall, launchOutput, TRACE, "turn-1" as never);

  const [completed] = terminalEvents(events);
  assert.ok(completed, "缺少 background_task_completed");
  const payload = completed.payload as Record<string, unknown>;
  // workId ≡ taskId ≡ agentId：投影按它把 work 从 running 迁到 resultPending。
  assert.equal(payload.taskId, AGENT_ID);
  assert.equal(payload.status, "completed");
  assert.equal(payload.taskKind, "subagent");
  // 已终态就没有可取消的东西：留着 true 会渲染出一个点了没反应的 Stop。
  assert.equal(payload.cancellable, false);
  assert.equal(payload.childSessionId, CHILD_SESSION_ID);
});

test("后台 Agent 仍在运行：轮询期不发布终态事件（免得把活着的卡片收掉）", async () => {
  const { tracker, events } = createTracker({
    snapshot: completedTaskSnapshot({ status: "running", completedAt: undefined }),
  });

  await tracker.trackBackgroundTask(toolCall, launchOutput, TRACE, "turn-1" as never);

  assert.equal(terminalEvents(events).length, 0);
  assert.equal(payloadStatus(events.at(-1)!), "running");
});

test("后台 Agent 被停止：registry 的 killed 必须归一成事件词表的 cancelled", async () => {
  const { tracker, events } = createTracker({
    snapshot: completedTaskSnapshot({ status: "killed" }),
  });

  await tracker.trackBackgroundTask(toolCall, launchOutput, TRACE, "turn-1" as never);

  const [completed] = terminalEvents(events);
  assert.ok(completed, "缺少 background_task_completed");
  // registry 词表写 killed/stopped（runner 的 BACKGROUND_AGENT_STOPPED_STATE），
  // 而投影只把 "cancelled" 认成 cancelled；原样透传 killed 会让轮询比 runner 晚到一步的场景
  // 把已收口成 cancelled 的 work 改写成 failed。归一后的词与 runner 自己的停止终态事件同词。
  assert.equal(payloadStatus(completed), "cancelled");
});
