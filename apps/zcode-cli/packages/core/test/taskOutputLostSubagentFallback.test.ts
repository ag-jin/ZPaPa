// TaskOutput / TaskStop 的 registry miss 回退（spec 2026-10-08-subagent-orphan-reconcile §1.8，
// 2026-10-12 裁决 3 = 3D）。
//
// 为什么这组用例承重：`runtimeTaskRegistry` 是进程私有内存态、重启即空，所以「重启后按 agentId
// 查输出」直接 `No task found`——「output.txt 是事实源」这条运维兜底在重启场景失效。回退解析
// 必须与读面/收敛同一把尺：`agentId → sess_subagent_<agentId>` 确定性推导 → child 会话在场 ∧
// taskType=subagent_child → 终态锚 `subagent_outcome` entry（只认 lost）→ output 取恢复面
// （child transcript 尾部，spec §1.7）。真实完成/失败的死任务不在解析面内（维持 No task found）。
//
// 回退读不算 notified claim（registry 无该任务，认领无处落），也不得吞掉后续唤醒。

import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionId,
  type MessageWithParts,
  type SessionEntryInfo,
  type SessionId,
  type SessionInfo,
  type SessionStorePort,
  type TaskOutputResult,
} from "@zcode/contracts";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import { taskOutputToolEntry } from "../src/tool/handlers/task-output.js";
import { taskStopToolEntry } from "../src/tool/handlers/task-stop.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

const PARENT_SESSION_ID = "sess_task_output_fallback_parent";
const AGENT_ID = "agent_taskoutput-1111-4222-8333-444444444444";
const CHILD_SESSION_ID = String(createSessionId(`subagent_${AGENT_ID}`));
const HOUR = 60 * 60 * 1_000;
const RECENT = Date.now() - 3 * HOUR;

function sessionInfo(input: {
  id: string;
  taskType: string;
  updated: number;
  parentID?: string;
}): SessionInfo {
  return {
    id: input.id as SessionId,
    projectID: "proj_task_output" as SessionInfo["projectID"],
    taskType: input.taskType,
    slug: "task-output",
    directory: "/tmp/task-output",
    title: "后台 agent 的长跑任务",
    version: "0.0.0-test",
    time: { created: input.updated - HOUR, updated: input.updated },
    ...(input.parentID ? { parentID: input.parentID as SessionId } : {}),
  } as SessionInfo;
}

/** child 的「被杀前」transcript：最后一条 assistant 有文本 + 未完成的 tool。 */
function childMessages(): MessageWithParts[] {
  return [
    {
      info: {
        id: "msg_task_output_child_assistant",
        role: "assistant",
        parentID: "msg_task_output_child_user",
        time: { created: RECENT + 1_000 },
        finish: "tool-calls",
      },
      parts: [
        {
          id: "part_task_output_child_progress",
          type: "text",
          text: "已写入 /tmp/task-output-evidence.md：这是被杀前的最后一条产出",
        },
        {
          id: "part_task_output_child_tool",
          type: "tool",
          callID: "call_task_output_child_tool",
          tool: "Bash",
          state: {
            status: "running",
            input: { command: "sleep 600" },
            time: { start: RECENT + 1_100 },
          },
        },
      ],
    } as unknown as MessageWithParts,
  ];
}

function lostOutcomeEntry(reason = "runtime_exit"): SessionEntryInfo {
  return {
    id: `subagent-outcome:${CHILD_SESSION_ID}`,
    sessionID: CHILD_SESSION_ID as SessionId,
    type: "subagent_outcome",
    time: { created: RECENT, updated: RECENT },
    data: {
      status: "lost",
      reason,
      parentSessionId: PARENT_SESSION_ID,
      reconciledAt: new Date(RECENT).toISOString(),
      runtimeInstance: { pid: 4242 },
    },
  } as SessionEntryInfo;
}

interface FallbackState {
  sessions: Map<string, SessionInfo>;
  messages: Map<string, MessageWithParts[]>;
  entries: Map<string, SessionEntryInfo[]>;
  registry: InMemoryRuntimeTaskRegistry;
}

function createFallbackState(): FallbackState {
  const state: FallbackState = {
    sessions: new Map(),
    messages: new Map(),
    entries: new Map(),
    registry: new InMemoryRuntimeTaskRegistry(),
  };
  state.sessions.set(
    PARENT_SESSION_ID,
    sessionInfo({ id: PARENT_SESSION_ID, taskType: "interactive", updated: RECENT }),
  );
  state.sessions.set(
    CHILD_SESSION_ID,
    sessionInfo({
      id: CHILD_SESSION_ID,
      taskType: "subagent_child",
      parentID: PARENT_SESSION_ID,
      updated: RECENT - HOUR,
    }),
  );
  state.messages.set(CHILD_SESSION_ID, childMessages());
  return state;
}

function fakeStore(state: FallbackState): SessionStorePort {
  return {
    async getSession(sessionID: string) {
      return state.sessions.get(sessionID) ?? null;
    },
    async messages(input: { sessionID: string }) {
      return state.messages.get(input.sessionID) ?? [];
    },
    async sessionEntries(input: { sessionID: string; type?: string }) {
      return (state.entries.get(input.sessionID) ?? []).filter(
        (entry) => input.type === undefined || entry.type === input.type,
      );
    },
  } as unknown as SessionStorePort;
}

function createContext(state: FallbackState): ToolExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    runtimeTaskRegistry: state.registry,
    sessionId: PARENT_SESSION_ID as never,
    sessionStore: fakeStore(state),
    toolCallId: "call_task_output_tool",
    traceId: "trace_task_output_tool" as never,
    traceContext: { traceId: "trace_task_output_tool" },
    workingDirectory: "/tmp/task-output",
    workspaceRoot: "/tmp/task-output",
  } as unknown as ToolExecutionContext;
}

test("回退：registry miss + child 已收敛为 lost ⇒ 返回 failed 终态与恢复面尾部", async () => {
  const state = createFallbackState();
  state.entries.set(CHILD_SESSION_ID, [lostOutcomeEntry()]);
  const context = createContext(state);

  const result = (await taskOutputToolEntry.handler(
    { task_id: AGENT_ID, block: false, timeout: 30_000 },
    context,
  )) as TaskOutputResult;

  assert.equal(result.retrieval_status, "success", "重启后必须能解析到死任务（现状 No task found）");
  assert.equal(result.task?.task_type, "local_agent");
  assert.equal(result.task?.status, "failed", "lost → failed（row 层先例，spec §1.8）");
  assert.match(result.task?.error ?? "", /lost|runtime_exit/);
  assert.match(
    result.task?.output ?? "",
    /这是被杀前的最后一条产出/,
    "output 必须取恢复面（child transcript 尾部，spec §1.7）",
  );
  assert.equal(result.task?.outputFile, undefined, "死任务没有可读产物面，不许回填路径");
  // 回退读不算 notified claim：registry 里没有该任务，读一次不改任何认领状态。
  assert.equal(state.registry.get(AGENT_ID), undefined);
});

test("回退：registry miss + child 无 lost entry ⇒ 维持既有 No task found（诚实边界）", async () => {
  const state = createFallbackState();
  const context = createContext(state);

  const result = (await taskOutputToolEntry.handler(
    { task_id: AGENT_ID, block: false, timeout: 30_000 },
    context,
  )) as unknown as { result: false; errorCode: number; message: string };

  assert.equal(result.result, false);
  assert.match(result.message, /No task found with ID/);
});

test("回退：agentId 推不出 child 会话 / 会话不是 subagent_child ⇒ 不解析", async () => {
  const state = createFallbackState();
  state.entries.set(CHILD_SESSION_ID, [lostOutcomeEntry()]);
  state.sessions.set(
    CHILD_SESSION_ID,
    sessionInfo({
      id: CHILD_SESSION_ID,
      taskType: "interactive",
      parentID: PARENT_SESSION_ID,
      updated: RECENT,
    }),
  );
  const context = createContext(state);

  const result = (await taskOutputToolEntry.handler(
    { task_id: AGENT_ID, block: false, timeout: 30_000 },
    context,
  )) as unknown as { result: false; message: string };

  assert.equal(result.result, false, "归属校验不通过时必须维持既有失败（不猜测）");
  assert.match(result.message, /No task found with ID/);
});

test("回退：child 属于**别的**父会话 ⇒ 拒答（不能跨会话解析出他会话 agent 的恢复面）", async () => {
  // 越权读面：agentId 可被知晓（peer/协调场景），child 会话也在同一本地库里；只查 taskType 会让
  // 本会话解析出它会话 child 的 transcript 尾部。house pattern 是 parentID 双查
  // （bootstrap/src/app/subagent-observation.ts 的 readSubagentTranscript），回退必须同款。
  const state = createFallbackState();
  state.entries.set(CHILD_SESSION_ID, [lostOutcomeEntry()]);
  state.sessions.set(
    CHILD_SESSION_ID,
    sessionInfo({
      id: CHILD_SESSION_ID,
      taskType: "subagent_child",
      parentID: "sess_some_other_parent",
      updated: RECENT - HOUR,
    }),
  );
  const context = createContext(state);

  const result = (await taskOutputToolEntry.handler(
    { task_id: AGENT_ID, block: false, timeout: 30_000 },
    context,
  )) as unknown as { result: false; message: string };

  assert.equal(result.result, false, "parentID 不一致必须拒答");
  assert.match(result.message, /No task found with ID/);
});

test("回退：输入校验不早退（有 store 回退面时把判定交给 handler）", () => {
  const state = createFallbackState();
  state.entries.set(CHILD_SESSION_ID, [lostOutcomeEntry()]);
  const context = { runtimeTaskRegistry: state.registry, sessionStore: fakeStore(state) };

  const validation = taskOutputToolEntry.validateInput?.(
    { task_id: AGENT_ID, block: false, timeout: 30_000 },
    context as never,
  );

  assert.deepEqual(validation, { result: true }, "registry miss 不再在校验阶段直接判死");
});

test("TaskStop 同病：registry miss + child 已收敛为 lost ⇒ 报「不在运行（已丢失）」而不是 No task found", async () => {
  const state = createFallbackState();
  state.entries.set(CHILD_SESSION_ID, [lostOutcomeEntry()]);
  const context = {
    ...createContext(state),
    backgroundTaskControlPort: {
      stopBackgroundTask: async () => ({
        ok: false as const,
        reason: "background_task_not_found",
        taskId: AGENT_ID,
      }),
    },
  } as unknown as ToolExecutionContext;

  await assert.rejects(
    () => taskStopToolEntry.handler({ task_id: AGENT_ID }, context),
    (error: Error) => {
      assert.match(error.message, /not running|不在运行/i);
      assert.match(error.message, /lost|已丢失/);
      return true;
    },
  );
});
