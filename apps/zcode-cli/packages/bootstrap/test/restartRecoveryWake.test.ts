// 重启缺口回归：硬杀/重启后接管会话，父会话（主会话）必须拿到「后台 agent 已丢失」的
// 模型可见事实，并且这个事实要真的把父模型唤醒（复用后台通知 admission/drain 管道）。
//
// 为什么这组用例承重：诊断报告（ZCode/.zcode/debug/subagent-silence-report.md §1 环 2）复现的
// R2-2 断言——`restart-recovery.probe.ts` 3/3 轮红——就是本文件的前身。收敛只补 child 持久事实
// （spec §1.4a），父会话 entry=0、transcript 只有 launch ACK（「承诺」不是事实），无人值守时
// 永远不会汇报。2026-10-12 裁决 1 = 父侧持久事实（幂等锚 childSessionId）+ 复用通知管道真唤醒；
// 本文件把探针场景转成正式回归，断言对象是**产品症状本身**：
//   ① 接管后 child 落 subagent_outcome{lost}（f580ad8 线，不许回归）；
//   ② 父会话出现账本投递标记（subagent-orphan-wake:<childSessionId>）+ 一条含该 agent 的
//      「已丢失」通知消息，且真实 runtime 起了一个带通知正文的模型轮（唤醒不是落灰）；
//   ③ 被杀前的产出仍可从 child transcript 尾部读出（恢复面，spec §1.7）。
//
// 防误报（红队 A1-1 硬防线）：唤醒必须拿到「旧 runtime 确实死了」的进程级硬证据——
// 本文件用真实的 agent 产物目录 metadata.json（宿主 pid = 一个真实退出过的进程 pid）驱动；
// 反向用例（宿主 pid 仍存活 / 证据缺失）在下方逐条给出，证明它不会把活着的 agent 报成丢失。
//
// 复用真实 `AgentRuntime`（与会话里跑的是同一个类）+ 真实 `activateSessionForResume`，
// 只替换 store（内存 fake，与 sqlite adapter 的语义同款）与模型（fake，记录请求）。

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSessionId,
  type MessagePart,
  type MessageWithParts,
  type Model,
  type ModelRequest,
  type SessionEntryInfo,
  type SessionId,
  type SessionInfo,
  type SessionInputRecord,
  type SessionStorePort,
} from "@zcode/contracts";
import { AgentRuntime } from "@zcode/core";
import { SESSION_ENTRY_SUBAGENT_OUTCOME } from "../src/zcode-protocol/subagent-session-query.js";
import { ProtocolRequestError } from "../src/zcode-protocol/server-types.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import { activateSessionForResume } from "../src/zcode-protocol/server-operations.js";

const PARENT_SESSION_ID = "sess_restart_wake_parent";
const AGENT_ID = "agent_restartwake-1111-4222-8333-444444444444";
const CHILD_SESSION_ID = String(createSessionId(`subagent_${AGENT_ID}`));
const TOOL_CALL_ID = "call_restart_wake_agent";
const HOUR = 60 * 60 * 1_000;
const RECENT = Date.now() - 3 * HOUR;
const WATCHDOG_MS = 3_000;

/** 真实退出过的进程 pid = 不会复用的「已死」硬证据（spawnSync 已回收，kill(pid,0) 必 ESRCH）。 */
function deadProcessPid(): number {
  const result = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.equal(result.status, 0, "无法制造「已退出进程」作为 pid 证据");
  assert.ok(result.pid && result.pid > 0);
  return result.pid;
}

function backgroundLaunchAck(agentId: string): string {
  return [
    "Async agent launched successfully.",
    `agentId: ${agentId} (internal ID - do not mention to user. Use SendMessage with to: '${agentId}' to continue this agent.)`,
    "The agent is working in the background. You will be notified automatically when it completes.",
  ].join("\n");
}

function sessionInfo(input: {
  id: string;
  taskType: string;
  updated: number;
  parentID?: string;
}): SessionInfo {
  return {
    id: input.id as SessionId,
    projectID: "proj_restart_wake" as SessionInfo["projectID"],
    taskType: input.taskType,
    slug: "restart-wake",
    directory: "/tmp/restart-wake",
    title: "restart wake",
    version: "0.0.0-test",
    time: { created: input.updated - HOUR, updated: input.updated },
    ...(input.parentID ? { parentID: input.parentID as SessionId } : {}),
  } as SessionInfo;
}

/** 父 transcript：后台 Agent spawn（launch ACK part）+ 之后没有任何终态事实。 */
function parentMessages(): MessageWithParts[] {
  return [
    {
      info: {
        id: "msg_restart_wake_user",
        role: "user",
        time: { created: RECENT - HOUR },
        semantics: {
          origin: "real_user",
          kind: "user_prompt",
          uiVisibility: "visible",
          providerVisibility: "visible",
          transcriptVisibility: "visible",
        },
        anchor: { turnId: "turn_restart_wake", origin: "realUser" },
      },
      parts: [{ id: "part_restart_wake_user", type: "text", text: "启动后台 agent" }],
    },
    {
      info: {
        id: "msg_restart_wake_assistant",
        role: "assistant",
        parentID: "msg_restart_wake_user",
        time: { created: RECENT - HOUR + 500, completed: RECENT - HOUR + 5_000 },
        finish: "tool-calls",
      },
      parts: [
        {
          id: "part_restart_wake_agent",
          type: "tool",
          callID: TOOL_CALL_ID,
          tool: "Agent",
          state: {
            status: "completed",
            input: {
              description: "长跑后台 agent",
              prompt: "do work",
              run_in_background: true,
              subagent_type: "implementer",
            },
            output: backgroundLaunchAck(AGENT_ID),
            time: { start: RECENT - HOUR + 1_000, end: RECENT - HOUR + 1_100 },
          },
        },
      ],
    } as unknown as MessageWithParts,
  ];
}

/** child 的「被杀前」transcript：部分产出已落库（最后一条 assistant 带 tool、tool 仍 running）。 */
function childMessages(): MessageWithParts[] {
  return [
    {
      info: {
        id: "msg_restart_wake_child_user",
        role: "user",
        parentID: "msg_restart_wake_user",
        time: { created: RECENT - HOUR + 2_000 },
      },
      parts: [{ id: "part_restart_wake_child_user", type: "text", text: "do work" }],
    },
    {
      info: {
        id: "msg_restart_wake_child_assistant",
        role: "assistant",
        parentID: "msg_restart_wake_child_user",
        time: { created: RECENT - HOUR + 3_000 },
        finish: "tool-calls",
      },
      parts: [
        {
          id: "part_restart_wake_child_progress",
          type: "text",
          text: "已完成前半段：证据文件已写入 /tmp/restart-wake-evidence.md（这是被杀前唯一可读的产出）",
        },
        {
          id: "part_restart_wake_child_tool",
          type: "tool",
          callID: "call_restart_wake_child_tool",
          tool: "Bash",
          state: {
            status: "running",
            input: { command: "sleep 600" },
            time: { start: RECENT - HOUR + 3_100 },
          },
        },
      ],
    } as unknown as MessageWithParts,
  ];
}

interface HarnessState {
  sessions: Map<string, SessionInfo>;
  messages: Map<string, MessageWithParts[]>;
  entries: Map<string, SessionEntryInfo[]>;
  inputs: Map<string, SessionInputRecord>;
  savedParts: MessagePart[];
  modelRequests: ModelRequest[];
  warnings: string[];
}

function createState(): HarnessState {
  return {
    sessions: new Map(),
    messages: new Map(),
    entries: new Map(),
    inputs: new Map(),
    savedParts: [],
    modelRequests: [],
    warnings: [],
  };
}

/** 场景装配：父会话 + 后台 spawn + child（无终态、过宽容期）+ 可选产物目录（pid 证据）。 */
function prepareScenario(state: HarnessState): void {
  state.sessions.set(
    PARENT_SESSION_ID,
    sessionInfo({ id: PARENT_SESSION_ID, taskType: "interactive", updated: RECENT }),
  );
  state.messages.set(PARENT_SESSION_ID, parentMessages());
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
}

/** 与 sqlite adapter 同语义的内存 store（session_input 的重开语义见 session-inputs 仓库）。 */
function createStore(state: HarnessState): SessionStorePort {
  const handlers: Record<string, (input: never) => unknown> = {
    // 与 port 同形：getSession 收字符串 id，其余读面收 `{ sessionID }`。
    getSession: async (sessionID: string) => state.sessions.get(sessionID) ?? null,
    messages: async (input: { sessionID: string }) => {
      const sessionID = input.sessionID;
      return (state.messages.get(sessionID) ?? []).map((message) => ({
        ...message,
        parts: [...message.parts],
      }));
    },
    sessionEntries: async (input: { sessionID: string; type?: string }) =>
      (state.entries.get(input.sessionID) ?? []).filter(
        (entry) => input.type === undefined || entry.type === input.type,
      ),
    saveSessionEntry: async (entry: SessionEntryInfo) => {
      const key = String(entry.sessionID);
      state.entries.set(key, [
        ...(state.entries.get(key) ?? []).filter((item) => item.id !== entry.id),
        entry,
      ]);
    },
    savePart: async (part: MessagePart) => {
      state.savedParts.push(part);
    },
    saveSessionInput: async (input: {
      id: string;
      sessionID: string;
      kind: string;
      delivery: "startNow" | "guide" | "queue";
      payload: { text: string; [key: string]: unknown };
    }) => {
      const existing = state.inputs.get(input.id);
      state.inputs.set(input.id, {
        id: input.id,
        sessionID: input.sessionID as SessionId,
        kind: input.kind,
        delivery: input.delivery,
        payload: input.payload,
        admittedSequence: existing?.admittedSequence ?? state.inputs.size,
        status: existing?.status === "discarded" ? "admitted" : (existing?.status ?? "admitted"),
        time: { created: existing?.time.created ?? Date.now(), updated: Date.now() },
      });
    },
    getSessionInputById: async (id: string) => state.inputs.get(id) ?? null,
    listSessionInputs: async (input: { sessionID: string; status?: string }) =>
      [...state.inputs.values()].filter(
        (record) =>
          record.sessionID === input.sessionID &&
          (input.status === undefined || record.status === input.status),
      ),
    markSessionInputPromoted: async (input: { id: string; promotedMessageID: string }) => {
      const record = state.inputs.get(input.id);
      if (!record) return;
      state.inputs.set(input.id, {
        ...record,
        status: "promoted",
        promotedMessageID: input.promotedMessageID as never,
      });
    },
    settleSessionInput: async (input: { id: string; status: SessionInputRecord["status"] }) => {
      const record = state.inputs.get(input.id);
      if (!record) return;
      state.inputs.set(input.id, { ...record, status: input.status });
    },
    readTodos: async () => [],
    updateTodos: async () => undefined,
  };
  return new Proxy({} as SessionStorePort, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      const handler = handlers[prop];
      if (handler) return handler;
      // 其余 port 面（本用例不关心的读面）落成 async no-op：多出来的依赖会让
      // 「挂点到底碰了什么」不可见（与既有 harness 同款取舍）。
      return async () => undefined;
    },
  });
}

function createFakeModel(state: HarnessState): Model {
  const model: Model = {
    providerId: "fake-provider" as never,
    modelId: "fake-model" as never,
    displayName: "fake",
    optionSpecs: { maxOutputTokens: { max: 4096, min: 1 } } as never,
    options: {},
    properties: {
      contextWindow: 200_000,
      inputFormat: {
        supportsAudio: false,
        supportsImage: false,
        supportsPdf: false,
        supportsText: true,
        supportsVideo: false,
      },
      outputFormat: { supportsText: true },
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsToolCall: true,
    } as never,
    bind: () => model,
    generateText: async (request) => {
      state.modelRequests.push(request);
      return {
        finishReason: "stop",
        text: "",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as never,
      };
    },
    streamText: (request) => {
      return (async function* () {
        state.modelRequests.push(request);
        yield { type: "start" } as never;
      })();
    },
  };
  return model;
}

/** 激活序列会问到的 fake app：resume() + 真实 AgentRuntime（投影/事件订阅面来自它）。 */
function createHarness(state: HarnessState, options: { subagentOutputRootDir?: string }) {
  const store = createStore(state);
  const runtime = new AgentRuntime(
    PARENT_SESSION_ID as never,
    {
      modelSelection: { providerId: "fake-provider", modelId: "fake-model" },
      modelStreaming: false,
      workingDirectory: process.cwd(),
    } as never,
    {
      eventStore: {
        append: async (event: unknown) => event,
        deleteSession: async () => {},
        getEvents: async () => [],
        getEventsAfter: async () => [],
        getLatestSequenceNumber: async () => 0,
      } as never,
      logger: {
        debug: () => {},
        error: () => {},
        info: () => {},
        warn: () => {},
        child: () => undefined,
      } as never,
      modelFactory: () => createFakeModel(state),
      sessionStore: store,
    } as never,
  );
  const context = {
    appRuntimePreferences: {},
    assertServing: () => {},
    deps: {
      createSessionEventStore: () => ({
        getEvents: async () => [],
        getLatestSequenceNumber: async () => 0,
      }),
      createZCodeApp: async () => ({
        resume: async () => ({ modelSelection: undefined }),
        runtime,
      }),
      sessionStore: store,
      version: "0.0.0-test",
      ...(options.subagentOutputRootDir
        ? { subagentOutputRootDir: options.subagentOutputRootDir }
        : {}),
    },
    logger: {
      debug: () => {},
      error: () => {},
      info: () => {},
      warn: (_message: string, fields?: { event?: string }) => {
        if (fields?.event) state.warnings.push(fields.event);
      },
    },
    requestClient: async () => {
      throw new ProtocolRequestError(-32601, "method not supported");
    },
    sessions: new Map<string, unknown>(),
    v4Interactions: { initializeAskUserQuestionAutoResolutionEnabled: () => {} },
  } as unknown as ZCodeProtocolAgentServerContext;
  return { context, runtime };
}

/** 轮询直到条件成立（drain 是异步的：入队后模型轮在自己的微任务/IO 之后起）。 */
async function waitFor(predicate: () => boolean, timeoutMs = WATCHDOG_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

/** 在 agents 产物目录写一个 metadata.json（宿主 pid 证据；与 core runner 的落盘同形）。 */
function writeAgentMetadata(input: {
  rootDir: string;
  parentSessionId: string;
  agentId: string;
  pid: number;
}): string {
  const dir = join(input.rootDir, input.parentSessionId, input.agentId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "metadata.json");
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        agentId: input.agentId,
        // 与 runner 同源的推导（`sess_subagent_<agentId>`）：夹具不许把第一个 agent 的 child id
        // 写死给所有 agent（多 agent 场景会造假字段，掩盖「各 agent 各自身份」）。
        childSessionId: String(createSessionId(`subagent_${input.agentId}`)),
        parentSessionId: input.parentSessionId,
        status: "running",
        runtimeInstance: { pid: input.pid },
      },
      null,
      2,
    )}\n`,
  );
  return file;
}

function withTempAgentRoot<T>(run: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = mkdtempSync(join(tmpdir(), "zcode-restart-wake-"));
  return run(rootDir).finally(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });
}

test("硬杀后接管：child 收敛 + 父会话收到「已丢失」唤醒（R2-1/R2-2/R2-3）", async () => {
  await withTempAgentRoot(async (rootDir) => {
    const state = createState();
    prepareScenario(state);
    writeAgentMetadata({
      rootDir,
      parentSessionId: PARENT_SESSION_ID,
      agentId: AGENT_ID,
      pid: deadProcessPid(),
    });
    const { context } = createHarness(state, { subagentOutputRootDir: rootDir });

    await activateSessionForResume(context, { sessionId: PARENT_SESSION_ID });

    // R2-1：child 侧孤儿收敛（f580ad8 线）不许回归。
    const childEntries = state.entries.get(CHILD_SESSION_ID) ?? [];
    const outcome = childEntries.find((entry) => entry.type === SESSION_ENTRY_SUBAGENT_OUTCOME);
    assert.ok(outcome, "R2-1：child 必须落 subagent_outcome{lost}");
    assert.equal((outcome.data as { status?: string }).status, "lost");

    // R2-2：父会话必须拿到模型可见的「已丢失」事实（账本投递标记 + 通知消息 + 真唤醒）。
    const wakeInputId = `subagent-orphan-wake:${CHILD_SESSION_ID}`;
    // 顺序约束（B 矩阵 1B）：唤醒 admission 必须在**激活返回之前**就落定——hydration 快照与唤醒轮
    // 谁先谁后不保证（drain 异步），但「激活返回后事实已在父侧账本」是可依赖的；测试不断言消息与
    // 快照的相对顺序，只断言两者都不丢。
    assert.ok(
      state.inputs.get(wakeInputId),
      "激活返回时唤醒 admission 必须已在父侧账本（顺序约束：事实先于快照，唤醒轮异步起）",
    );
    const admitted = await waitFor(
      () => state.inputs.get(wakeInputId)?.status === "promoted",
      WATCHDOG_MS,
    );
    assert.ok(
      admitted,
      `R2-2：父侧账本必须出现 ${wakeInputId} 且被消费（promoted）——现状只会收敛 child，父会话零事实`,
    );
    const notification = state.savedParts.find(
      (part) => part.type === "text" && part.text?.includes(AGENT_ID),
    );
    assert.ok(notification, "R2-2：父 transcript 必须落一条含该 agentId 的通知消息");
    assert.match(notification.text ?? "", /lost|runtime_exit/);
    assert.match(
      notification.text ?? "",
      /may be delivered more than once/i,
      "R2-2/W-2：at-least-once 的重复风险必须在文案里说清（模型不能把第二条当成第二个 agent 死亡）",
    );
    assert.ok(
      state.modelRequests.some((request) => JSON.stringify(request.messages).includes(AGENT_ID)),
      "R2-2：唤醒必须真的起一个带该 agent 事实的模型轮（无人值守时父模型才会汇报）",
    );

    // R2-3：被杀前产出仍可读（存储面），并且恢复面提取的摘要在通知里带上。
    const childText = JSON.stringify(state.messages.get(CHILD_SESSION_ID));
    assert.match(childText, /证据文件已写入/, "R2-3：child transcript 必须保留被杀前的产出");
    assert.match(
      notification.text ?? "",
      /证据文件已写入/,
      "R2-2：通知必须带恢复面摘要（spec §1.7），让父模型不翻子会话也知道被杀前做到哪",
    );
  });
});

test("防误报：宿主 pid 仍存活 ⇒ 不合成「已丢失」唤醒（只保留 display 层收敛）", async () => {
  await withTempAgentRoot(async (rootDir) => {
    const state = createState();
    prepareScenario(state);
    // 活着的 pid：双进程违例（桌面 + 终端 CLI 同库）里另一端仍在跑同一 child。
    writeAgentMetadata({
      rootDir,
      parentSessionId: PARENT_SESSION_ID,
      agentId: AGENT_ID,
      pid: process.pid,
    });
    const { context } = createHarness(state, { subagentOutputRootDir: rootDir });

    await activateSessionForResume(context, { sessionId: PARENT_SESSION_ID });

    // display 层照旧收敛（entry 在场）：宽容期语义不变。
    assert.ok(
      (state.entries.get(CHILD_SESSION_ID) ?? []).some(
        (entry) => entry.type === SESSION_ENTRY_SUBAGENT_OUTCOME,
      ),
      "display 层收敛不受唤醒证据门影响",
    );
    assert.equal(
      state.inputs.get(`subagent-orphan-wake:${CHILD_SESSION_ID}`),
      undefined,
      "pid 存活时不许写唤醒投递（否则真实完成通知会与「已丢失」消息互斥并存）",
    );
  });
});

test("防误报：pid 证据缺失（无 metadata / 无 pid 字段）⇒ 不合成「已丢失」唤醒", async () => {
  await withTempAgentRoot(async (rootDir) => {
    const state = createState();
    prepareScenario(state);
    // 不写 metadata.json：旧版本 spawn 的 agent / 文件被清理 ⇒ 无进程级死亡证据。
    const { context } = createHarness(state, { subagentOutputRootDir: rootDir });

    await activateSessionForResume(context, { sessionId: PARENT_SESSION_ID });

    assert.ok((state.entries.get(CHILD_SESSION_ID) ?? []).length >= 1, "display 层收敛照旧");
    assert.equal(
      state.inputs.get(`subagent-orphan-wake:${CHILD_SESSION_ID}`),
      undefined,
      "拿不到硬证据时宁可不投递（保守方向）",
    );
  });
});

test("幂等：已交付（账本 promoted）后的后续接管不重复唤醒", async () => {
  await withTempAgentRoot(async (rootDir) => {
    const state = createState();
    prepareScenario(state);
    writeAgentMetadata({
      rootDir,
      parentSessionId: PARENT_SESSION_ID,
      agentId: AGENT_ID,
      pid: deadProcessPid(),
    });
    const first = createHarness(state, { subagentOutputRootDir: rootDir });
    await activateSessionForResume(first.context, { sessionId: PARENT_SESSION_ID });
    await waitFor(() => state.inputs.get(`subagent-orphan-wake:${CHILD_SESSION_ID}`)?.status === "promoted");
    const messagesAfterFirst = state.savedParts.filter((part) => part.type === "text").length;

    // 第二次接管（新的 context / 新的 runtime，入口早退不适用：store 里已有 entry）：
    // 唤醒判据的持久层（账本 promoted）必须压住重投。
    const second = createHarness(state, { subagentOutputRootDir: rootDir });
    await activateSessionForResume(second.context, { sessionId: PARENT_SESSION_ID });
    await waitFor(() => false, 300);

    const textParts = state.savedParts.filter((part) => part.type === "text").length;
    assert.equal(textParts, messagesAfterFirst, "已交付的唤醒不许重投第二条消息");
    assert.equal(state.modelRequests.length, 1, "模型轮也不许重复起");
  });
});

test("崩在投递前（账本 discarded）⇒ 重开并重投递一次（at-least-once）", async () => {
  await withTempAgentRoot(async (rootDir) => {
    const state = createState();
    prepareScenario(state);
    writeAgentMetadata({
      rootDir,
      parentSessionId: PARENT_SESSION_ID,
      agentId: AGENT_ID,
      pid: deadProcessPid(),
    });
    // 复刻「上一次激活已 admission、进程在 drain 前又崩」：resume 清扫把残留 admitted 收口成
    // discarded(session_resumed)（core 的既有语义），账本行留在 store 里。
    const wakeInputId = `subagent-orphan-wake:${CHILD_SESSION_ID}`;
    state.inputs.set(wakeInputId, {
      id: wakeInputId,
      sessionID: PARENT_SESSION_ID as SessionId,
      kind: "backgroundNotification",
      delivery: "queue",
      payload: { text: "<task-notification></task-notification>" },
      admittedSequence: 0,
      status: "discarded",
      statusReason: "session_resumed",
      time: { created: RECENT, updated: Date.now() - 60_000 },
    });
    const { context } = createHarness(state, { subagentOutputRootDir: rootDir });

    await activateSessionForResume(context, { sessionId: PARENT_SESSION_ID });

    const promoted = await waitFor(() => state.inputs.get(wakeInputId)?.status === "promoted");
    assert.ok(
      promoted,
      "discarded 行必须被同 id 重投递重开为 admitted 并最终 promoted（否则事实静默丢失）",
    );
    assert.ok(
      state.savedParts.some((part) => part.type === "text" && part.text?.includes(AGENT_ID)),
      "重投递必须真的落一条通知消息",
    );
  });
});

test("批量：同一次收敛的多个 lost 合并成一条唤醒消息、一个模型轮", async () => {
  await withTempAgentRoot(async (rootDir) => {
    const state = createState();
    prepareScenario(state);
    const secondAgentId = "agent_restartwake-2222-4333-8444-555555555555";
    const secondChildSessionId = String(createSessionId(`subagent_${secondAgentId}`));
    const secondCallId = "call_restart_wake_agent_second";
    // 父 transcript 追加第二个后台 spawn（同一次收敛里两个 lost）。
    const parent = state.messages.get(PARENT_SESSION_ID) ?? [];
    const assistant = parent[1] as { parts: unknown[] };
    assistant.parts.push({
      id: `part_${secondCallId}`,
      type: "tool",
      callID: secondCallId,
      tool: "Agent",
      state: {
        status: "completed",
        input: {
          description: "第二个长跑后台 agent",
          prompt: "do work",
          run_in_background: true,
          subagent_type: "implementer",
        },
        output: backgroundLaunchAck(secondAgentId),
        time: { start: RECENT - HOUR + 1_000, end: RECENT - HOUR + 1_100 },
      },
    });
    state.sessions.set(
      secondChildSessionId,
      sessionInfo({
        id: secondChildSessionId,
        taskType: "subagent_child",
        parentID: PARENT_SESSION_ID,
        updated: RECENT - HOUR,
      }),
    );
    state.messages.set(secondChildSessionId, childMessages());
    writeAgentMetadata({ rootDir, parentSessionId: PARENT_SESSION_ID, agentId: AGENT_ID, pid: deadProcessPid() });
    writeAgentMetadata({
      rootDir,
      parentSessionId: PARENT_SESSION_ID,
      agentId: secondAgentId,
      pid: deadProcessPid(),
    });
    const { context } = createHarness(state, { subagentOutputRootDir: rootDir });

    await activateSessionForResume(context, { sessionId: PARENT_SESSION_ID });

    const both = await waitFor(
      () =>
        state.inputs.get(`subagent-orphan-wake:${CHILD_SESSION_ID}`)?.status === "promoted" &&
        state.inputs.get(`subagent-orphan-wake:${secondChildSessionId}`)?.status === "promoted",
    );
    assert.ok(both, "两个 child 的账本行都必须被投递并消费");
    const notifications = state.savedParts.filter(
      (part) => part.type === "text" && part.text?.includes("<task-notification>"),
    );
    assert.equal(notifications.length, 1, "同一次收敛的多个 lost 必须合并成一条唤醒消息");
    assert.match(notifications[0]?.text ?? "", /agent_restartwake-1111/);
    assert.match(notifications[0]?.text ?? "", /agent_restartwake-2222/);
    assert.equal(state.modelRequests.length, 1, "合并成一个模型轮（不是每个 lost 一輪）");
  });
});

test("W3 防御：账本行是终态（failed/cancelled）⇒ 不重投（不在白名单内即视为已终态）", async () => {
  await withTempAgentRoot(async (rootDir) => {
    const state = createState();
    prepareScenario(state);
    writeAgentMetadata({
      rootDir,
      parentSessionId: PARENT_SESSION_ID,
      agentId: AGENT_ID,
      pid: deadProcessPid(),
    });
    // 当前路径产不出 failed 的唤醒行（resume 只产 discarded），但判据必须是白名单制：
    // 「不在 {缺席, admitted, discarded} 内即已终态」，否则未来状态变更会静默变成每次激活重投。
    const wakeInputId = `subagent-orphan-wake:${CHILD_SESSION_ID}`;
    state.inputs.set(wakeInputId, {
      id: wakeInputId,
      sessionID: PARENT_SESSION_ID as SessionId,
      kind: "backgroundNotification",
      delivery: "queue",
      payload: { text: "<task-notification></task-notification>" },
      admittedSequence: 0,
      status: "failed",
      statusReason: "adapter_failure",
      time: { created: RECENT, updated: RECENT },
    });
    const { context } = createHarness(state, { subagentOutputRootDir: rootDir });

    await activateSessionForResume(context, { sessionId: PARENT_SESSION_ID });
    await waitFor(() => false, 300);

    assert.equal(state.inputs.get(wakeInputId)?.status, "failed", "终态行不许被重开");
    assert.equal(
      state.savedParts.filter((part) => part.type === "text").length,
      0,
      "终态行的 child 不许重投唤醒",
    );
    assert.equal(state.modelRequests.length, 0, "也不许起模型轮");
  });
});

test("一把尺：child 真实 outcome 到场 ⇒ 终态不由收敛 entry 决定，不唤醒", async () => {
  await withTempAgentRoot(async (rootDir) => {
    const state = createState();
    prepareScenario(state);
    writeAgentMetadata({
      rootDir,
      parentSessionId: PARENT_SESSION_ID,
      agentId: AGENT_ID,
      pid: deadProcessPid(),
    });
    // child 有一条真实终态（最后一条 assistant 无 tool round、带 completed ⇒ success）。
    state.messages.set(CHILD_SESSION_ID, [
      {
        info: {
          id: "msg_restart_wake_child_done",
          role: "assistant",
          parentID: "msg_restart_wake_child_user",
          time: { created: RECENT - HOUR + 4_000, completed: RECENT - HOUR + 5_000 },
          finish: "stop",
        },
        parts: [{ id: "part_restart_wake_child_done", type: "text", text: "完成" }],
      } as unknown as MessageWithParts,
    ]);
    const { context } = createHarness(state, { subagentOutputRootDir: rootDir });

    await activateSessionForResume(context, { sessionId: PARENT_SESSION_ID });
    await waitFor(() => false, 300);

    assert.equal(
      state.inputs.get(`subagent-orphan-wake:${CHILD_SESSION_ID}`),
      undefined,
      "真实结果已到场的 child 不是丢失，不许唤醒（真实 outcome > entry）",
    );
  });
});
