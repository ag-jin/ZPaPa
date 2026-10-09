// 后台 Bash 任务的孤儿收敛：接管会话时把「进程已死、没有任何持久终态」的 work 收敛落盘。
//
// 为什么这组用例承重：后台 Bash 的持久化 part 只有 **launch ACK**（启动那一刻就写成
// completed），transcript 分不出「还在跑」和「早已结束」；面板的 backgroundWorks 又只由进程内
// 事件喂出（append-only、无对账、无过期）。于是宿主进程被硬杀/崩溃、终态事件没落盘时，这个
// work 在面板上永久停不下（用户实测：「原本在运行的终端已经停下了，还在显示在后台运行」）。
// 子 agent 与 dwf 各有「持久终态事实 + 接管时收敛」两层，bash 两层都要在本文件里钉住：
//   - 读面：launch ACK 是候选、结果唤醒轮与收敛 entry 是终态证据（workId ≡ taskId）；
//   - 收敛：J1-J5 全判、落 `background_task_outcome` entry（父会话、幂等键、touchSession=false）；
//   - 投影：收敛事实经 cold merge 合成终态事件，且**排在内存里的陈旧 running 之后** ⇒ 收口；
//   - 不误杀：本进程认领 / 宽容期内 / 有真实终态一律不写。

import assert from "node:assert/strict";
import test from "node:test";
import {
  type MessageWithParts,
  type SessionEntryInfo,
  type SessionId,
  type SessionInfo,
  type SessionStorePort,
} from "@zcode/contracts";
import { mergeColdConversationEvents } from "../src/zcode-protocol-v4/cold-event-merge.js";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import {
  SESSION_ENTRY_BACKGROUND_TASK_OUTCOME,
  backgroundWorkIdFromToolPart,
  readSessionBackgroundTaskInventory,
  reconciledBackgroundTaskHydrationFacts,
} from "../src/zcode-protocol/background-task-session-query.js";
import {
  BACKGROUND_TASK_ORPHAN_GRACE_MS,
  backgroundTaskOutcomeEntryId,
  reconcileBackgroundTaskOrphansOnActivation,
  selectBackgroundTaskOrphans,
} from "../src/zcode-protocol/background-task-orphan-reconcile.js";

const SESSION_ID = "sess_bg_orphan_parent";
const WORK_ID = "exec_11111111-2222-4333-8444-555555555555";
const TOOL_CALL_ID = "call_bg_orphan_bash";
const USER_MESSAGE_ID = "msg_bg_orphan_user";
const ASSISTANT_MESSAGE_ID = "msg_bg_orphan_assistant";
const BASE_MS = 1_700_000_000_000;
const HOUR = 3_600_000;

/** core 的 `formatBackgroundInfoForModel` 三个模板之一：显式后台启动的 ACK。 */
function backgroundLaunchAck(workId: string): string {
  return `Command running in background with ID: ${workId}. Output is being written to: /tmp/${workId}.log. You will be notified when it completes. To check interim output, use Read on that file path.`;
}

/**
 * 父 transcript：一条 user 消息 + 一条含后台 Bash launch ACK 的 assistant 消息。
 * `terminalNotice` 时追加一条结果唤醒轮（model-only user，metadata.originMeta 指回同一 workId）
 * ——它是「任务已终结」的持久证据（模型收到通知那一轮被持久化了）。
 */
function parentMessages(options: {
  workId?: string;
  partState?: Record<string, unknown>;
  terminalNotice?: boolean;
}): MessageWithParts[] {
  const workId = options.workId ?? WORK_ID;
  const messages: MessageWithParts[] = [
    {
      info: {
        id: USER_MESSAGE_ID,
        role: "user",
        time: { created: BASE_MS },
        semantics: {
          origin: "real_user",
          kind: "user_prompt",
          uiVisibility: "visible",
          providerVisibility: "visible",
          transcriptVisibility: "visible",
        },
        anchor: { turnId: "turn_bg_orphan", origin: "realUser" },
      },
      parts: [{ id: "part_bg_orphan_user_text", type: "text", text: "跑个长任务" }],
    } as unknown as MessageWithParts,
    {
      info: {
        id: ASSISTANT_MESSAGE_ID,
        role: "assistant",
        parentID: USER_MESSAGE_ID,
        time: { created: BASE_MS + 100, completed: BASE_MS + 200 },
        finish: "tool-calls",
      },
      parts: [
        {
          id: "part_bg_orphan_bash",
          type: "tool",
          callID: TOOL_CALL_ID,
          tool: "Bash",
          state: options.partState ?? {
            status: "completed",
            input: { command: "sleep 100000", description: "长跑终端", run_in_background: true },
            output: backgroundLaunchAck(workId),
            time: { start: BASE_MS + 150, end: BASE_MS + 200 },
          },
        },
      ],
    } as unknown as MessageWithParts,
  ];
  if (options.terminalNotice) {
    messages.push({
      info: {
        id: "msg_bg_orphan_notice",
        role: "user",
        time: { created: BASE_MS + 2 * HOUR },
        source: "background_task",
        metadata: {
          originMeta: { backgroundSource: "bash", title: "长跑终端", workId },
        },
        semantics: {
          origin: "real_user",
          kind: "user_prompt",
          uiVisibility: "visible",
          providerVisibility: "visible",
          transcriptVisibility: "visible",
        },
      },
      parts: [{ id: "part_bg_orphan_notice_text", type: "text", text: "后台命令已完成" }],
    } as unknown as MessageWithParts);
  }
  return messages;
}

interface HarnessState {
  sessions: Map<string, SessionInfo>;
  messages: Map<string, MessageWithParts[]>;
  entries: Map<string, SessionEntryInfo[]>;
  saves: SessionEntryInfo[];
  failEntryWrite?: boolean;
}

function sessionInfo(input: { id: string; updated: number }): SessionInfo {
  return {
    id: input.id as SessionId,
    projectID: "proj_bg_orphan" as SessionInfo["projectID"],
    taskType: "interactive",
    slug: "bg-orphan",
    directory: "/tmp/bg-orphan",
    title: "bg orphan",
    version: "0.0.0-test",
    time: { created: input.updated - HOUR, updated: input.updated },
  };
}

function createState(options: {
  workId?: string;
  terminalNotice?: boolean;
  updated?: number;
}): HarnessState {
  const state: HarnessState = {
    sessions: new Map(),
    messages: new Map(),
    entries: new Map(),
    saves: [],
  };
  const updated = options.updated ?? BASE_MS;
  state.sessions.set(SESSION_ID, sessionInfo({ id: SESSION_ID, updated }));
  state.messages.set(
    SESSION_ID,
    parentMessages({
      ...(options.workId ? { workId: options.workId } : {}),
      terminalNotice: options.terminalNotice,
    }),
  );
  return state;
}

function harnessStore(state: HarnessState): SessionStorePort {
  return {
    async getSession(sessionId: string) {
      return state.sessions.get(sessionId) ?? null;
    },
    async messages(input: { sessionID: string }) {
      return state.messages.get(input.sessionID) ?? [];
    },
    async sessionEntries(input: { sessionID: string; type?: string }) {
      return (state.entries.get(input.sessionID) ?? []).filter(
        (entry) => input.type === undefined || entry.type === input.type,
      );
    },
    async saveSessionEntry(entry: SessionEntryInfo) {
      if (state.failEntryWrite) throw new Error("store unavailable");
      state.saves.push(entry);
      const key = String(entry.sessionID);
      state.entries.set(key, [
        ...(state.entries.get(key) ?? []).filter((item) => item.id !== entry.id),
        entry,
      ]);
    },
  } as unknown as SessionStorePort;
}

/** 本进程 runtime 投影窄面：`claimedStatus` 时该 workId 报 running（本进程认领）。 */
function orphanContext(state: HarnessState, options: { claimedStatus?: string } = {}) {
  const backgroundTasks = options.claimedStatus
    ? [{ taskId: WORK_ID, status: options.claimedStatus }]
    : [];
  return {
    deps: { sessionStore: harnessStore(state) },
    logger: { info: () => {}, warn: () => {} },
    sessions: new Map([
      [SESSION_ID, { app: { runtime: { getProjection: async () => ({ backgroundTasks }) } } }],
    ]),
  } as unknown as Parameters<typeof readSessionBackgroundTaskInventory>[0];
}

/** 投影三段管线：cold merge（可带收敛事实）→ ProductProjection hydration 回放。 */
function hydrate(input: {
  messages: readonly MessageWithParts[];
  memoryEvents?: readonly import("@zcode/contracts").SessionEvent[];
  reconciledBackgroundTasks?: ReturnType<typeof reconciledBackgroundTaskHydrationFacts>;
}) {
  const merged = mergeColdConversationEvents({
    memoryEvents: [...(input.memoryEvents ?? [])],
    messages: [...input.messages],
    sessionId: SESSION_ID,
    ...(input.reconciledBackgroundTasks && input.reconciledBackgroundTasks.length > 0
      ? { reconciledBackgroundTasks: input.reconciledBackgroundTasks }
      : {}),
  });
  const projection = new ProductProjection(SESSION_ID, "epoch-bg-orphan");
  projection.beginHydrationReplay();
  for (const event of merged.events) projection.applyHydrationEvent(event);
  projection.completeHydrationReplay();
  return { events: merged.events, snapshot: projection.getSnapshot() };
}

// ── 读面：ACK 解析与候选枚举 ────────────────────────────────────────────────────────

test("读面：三种后台 ACK 模板与 JSON 形状都能解出 workId，无 id 的 part 不入候选", () => {
  const templates = [
    `Command running in background with ID: ${WORK_ID}. Output is being written to: /tmp/x.log.`,
    `Command exceeded the assistant-mode blocking budget (30s) and was moved to the background with ID: ${WORK_ID}. It is still running`,
    `Command was manually backgrounded by user with ID: ${WORK_ID}.`,
  ];
  for (const output of templates) {
    const part = {
      tool: "Bash",
      callID: TOOL_CALL_ID,
      state: { status: "completed", input: { command: "x" }, output, time: { start: 1, end: 2 } },
    } as unknown as Parameters<typeof backgroundWorkIdFromToolPart>[0];
    assert.equal(backgroundWorkIdFromToolPart(part), WORK_ID, `模板未解析：${output.slice(0, 40)}`);
  }
  const structured = {
    tool: "Bash",
    callID: TOOL_CALL_ID,
    state: {
      status: "completed",
      input: { command: "x" },
      output: JSON.stringify({ status: "backgrounded", backgroundTaskId: WORK_ID }),
      time: { start: 1, end: 2 },
    },
  } as unknown as Parameters<typeof backgroundWorkIdFromToolPart>[0];
  assert.equal(backgroundWorkIdFromToolPart(structured), WORK_ID);

  const noId = {
    tool: "Bash",
    callID: TOOL_CALL_ID,
    state: {
      status: "completed",
      input: { command: "x" },
      output: "hi\n",
      time: { start: 1, end: 2 },
    },
  } as unknown as Parameters<typeof backgroundWorkIdFromToolPart>[0];
  assert.equal(backgroundWorkIdFromToolPart(noId), undefined, "无 workId 就没有可寻址身份");
});

test("读面：前台输出里恰好含 ACK 短语不得当 workId（锚定模板前缀）", () => {
  const foregroundOutputs = [
    "connected to service with ID: abc123 (retrying)",
    "step 2: waiting for worker with ID: worker-7\ndone\n",
    '{"service":{"with ID: abc"}}',
  ];
  for (const output of foregroundOutputs) {
    const part = {
      tool: "Bash",
      callID: TOOL_CALL_ID,
      state: {
        status: "completed",
        input: { command: "grep x log" },
        output,
        time: { start: 1, end: 2 },
      },
    } as unknown as Parameters<typeof backgroundWorkIdFromToolPart>[0];
    assert.equal(
      backgroundWorkIdFromToolPart(part),
      undefined,
      `前台文本误报成后台 workId：${output.slice(0, 40)}`,
    );
  }

  // 正例对照：锚定只排除「短语恰好出现在别处」，模板原文仍在输出开头时照常解出。
  const stillParses = {
    tool: "Bash",
    callID: TOOL_CALL_ID,
    state: {
      status: "completed",
      input: { command: "x" },
      output: `${backgroundLaunchAck(WORK_ID)}\nconnected to service with ID: abc123`,
      time: { start: 1, end: 2 },
    },
  } as unknown as Parameters<typeof backgroundWorkIdFromToolPart>[0];
  assert.equal(backgroundWorkIdFromToolPart(stillParses), WORK_ID);
});

test("读面：结果唤醒轮是终态证据；无它则 work 停在「无终态」", async () => {
  const running = await readSessionBackgroundTaskInventory(
    orphanContext(createState({})),
    SESSION_ID,
  );
  assert.equal(running.works.length, 1);
  assert.equal(running.works[0]?.workId, WORK_ID);
  assert.equal(running.works[0]?.terminal, undefined, "没有结果轮 ⇒ 无持久终态");
  assert.equal(running.works[0]?.launchedAtMs, BASE_MS + 150, "宽容期基准取 ACK 的落库时间");

  const ended = await readSessionBackgroundTaskInventory(
    orphanContext(createState({ terminalNotice: true })),
    SESSION_ID,
  );
  assert.equal(ended.works[0]?.terminal?.source, "notification");
  assert.equal(ended.works[0]?.terminal?.endedAtMs, BASE_MS + 2 * HOUR);
});

// ── 读面：批量唤醒轮（同轮多条通知）的终态覆盖 ──────────────────────────────────────

const BATCH_WORK_ID_A = "exec_aaaaaaaa-1111-4222-8333-444444444444";
const BATCH_WORK_ID_B = "exec_bbbbbbbb-1111-4222-8333-444444444444";
const BATCH_WORK_ID_C = "exec_cccccccc-1111-4222-8333-444444444444";

/**
 * core `formatTaskNotification` 的 local_bash 分支（notification.ts）逐字对齐：通知文本的
 * 形态是解析依据，夹具按**生产者**的模板写，不按解析器的写法反推。
 */
function bashTaskNotificationText(taskId: string): string {
  return [
    "<task-notification>",
    `<task-id>${taskId}</task-id>`,
    `<tool-use-id>call_${taskId}</tool-use-id>`,
    `<output-file>/tmp/${taskId}.log</output-file>`,
    "<status>completed</status>",
    "<summary>完成</summary>",
    "</task-notification>",
  ].join("\n");
}

/**
 * 批量场景的父 transcript：每 work 一条 launch ACK 的 assistant 消息，随后一轮**批量**结果
 * 唤醒轮——core `persistBackgroundTaskNotificationBatch` 把各通知文本以 "\n\n" 连接成一条
 * model-only user 消息，而 originMeta 只保留代表任务（首个）的 workId。
 */
function batchState(workIds: readonly string[]): HarnessState {
  const state: HarnessState = {
    sessions: new Map(),
    messages: new Map(),
    entries: new Map(),
    saves: [],
  };
  state.sessions.set(SESSION_ID, sessionInfo({ id: SESSION_ID, updated: BASE_MS + 2 * HOUR }));
  const messages: MessageWithParts[] = [
    {
      info: {
        id: USER_MESSAGE_ID,
        role: "user",
        time: { created: BASE_MS },
        semantics: {
          origin: "real_user",
          kind: "user_prompt",
          uiVisibility: "visible",
          providerVisibility: "visible",
          transcriptVisibility: "visible",
        },
        anchor: { turnId: "turn_bg_batch", origin: "realUser" },
      },
      parts: [{ id: "part_bg_batch_user_text", type: "text", text: "并行跑三个任务" }],
    } as unknown as MessageWithParts,
    ...workIds.map(
      (workId, index) =>
        ({
          info: {
            id: `msg_bg_batch_launch_${index}`,
            role: "assistant",
            parentID: USER_MESSAGE_ID,
            time: { created: BASE_MS + 100 + index, completed: BASE_MS + 200 + index },
            finish: "tool-calls",
          },
          parts: [
            {
              id: `part_bg_batch_bash_${index}`,
              type: "tool",
              callID: `call_bg_batch_${index}`,
              tool: "Bash",
              state: {
                status: "completed",
                input: { command: `sleep ${index}`, description: workId, run_in_background: true },
                output: backgroundLaunchAck(workId),
                time: { start: BASE_MS + 150 + index, end: BASE_MS + 200 + index },
              },
            },
          ],
        }) as unknown as MessageWithParts,
    ),
    {
      info: {
        id: "msg_bg_batch_notice",
        role: "user",
        time: { created: BASE_MS + 2 * HOUR },
        source: "background_task",
        metadata: {
          originMeta: {
            backgroundSource: "bash",
            title: workIds.join(" · "),
            workId: workIds[0],
          },
        },
        semantics: {
          origin: "real_user",
          kind: "user_prompt",
          uiVisibility: "visible",
          providerVisibility: "visible",
          transcriptVisibility: "visible",
        },
      },
      parts: [
        {
          id: "part_bg_batch_notice_text",
          type: "text",
          text: workIds.map(bashTaskNotificationText).join("\n\n"),
        },
      ],
    } as unknown as MessageWithParts,
  ];
  state.messages.set(SESSION_ID, messages);
  return state;
}

test("读面：批量唤醒轮里同轮全部 task-id 都是终态证据（originMeta 只指代表任务）", async () => {
  const workIds = [BATCH_WORK_ID_A, BATCH_WORK_ID_B, BATCH_WORK_ID_C];
  const state = batchState(workIds);
  const context = orphanContext(state);
  const inventory = await readSessionBackgroundTaskInventory(context, SESSION_ID);

  assert.deepEqual(
    inventory.works.map((work) => [work.workId, work.terminal?.source]),
    [
      [BATCH_WORK_ID_A, "notification"],
      [BATCH_WORK_ID_B, "notification"],
      [BATCH_WORK_ID_C, "notification"],
    ],
    "同轮通知文本里的每个 task-id 都有终态证据，不止 originMeta 的代表任务",
  );
  for (const work of inventory.works) {
    assert.equal(work.terminal?.endedAtMs, BASE_MS + 2 * HOUR, "终局时刻取唤醒轮落库时间");
  }

  const persistedMessages = state.messages.get(SESSION_ID);
  const result = await reconcileBackgroundTaskOrphansOnActivation({
    context,
    sessionId: SESSION_ID,
    persistedMessages,
    now: BASE_MS + 3 * HOUR,
  });
  assert.equal(result.reconciled, 0, "同批真实完成的任务不得被收敛成 lost");
  assert.deepEqual(state.saves, []);
  assert.deepEqual(
    result.skipped.map((entry) => entry.reason),
    ["terminal_evidence", "terminal_evidence", "terminal_evidence"],
  );
});

// ── 判据纯函数 ────────────────────────────────────────────────────────────────────

test("判据：孤儿（无终态、无认领、过宽容期）入选；其余三类逐条给出 skip reason", () => {
  const now = BASE_MS + 3 * HOUR;
  const base = {
    workId: WORK_ID,
    toolCallId: TOOL_CALL_ID,
    title: "长跑终端",
    launchedAtMs: BASE_MS,
  };
  const selection = selectBackgroundTaskOrphans({
    candidates: [
      base,
      { ...base, terminal: { source: "notification" as const } },
      { ...base, liveStatus: "running" as const },
      { ...base, launchedAtMs: now - 60_000 },
      { workId: "w-unknown", toolCallId: "c", title: "t" },
    ],
    now,
  });

  assert.deepEqual(
    selection.orphans.map((work) => work.workId),
    [WORK_ID],
  );
  assert.deepEqual(
    selection.skipped.map((entry) => entry.reason),
    ["terminal_evidence", "claimed_in_process", "within_grace", "activity_unknown"],
  );
});

// ── 收敛动作 ──────────────────────────────────────────────────────────────────────

test("收敛：无终态 ∧ 过宽容期 ∧ 本进程不认领 ⇒ 落父会话的 background_task_outcome entry", async () => {
  const state = createState({});
  const now = BASE_MS + 3 * HOUR;
  const result = await reconcileBackgroundTaskOrphansOnActivation({
    context: orphanContext(state),
    sessionId: SESSION_ID,
    persistedMessages: parentMessages({}),
    now,
  });

  assert.equal(result.reconciled, 1);
  assert.equal(state.saves.length, 1);
  const entry = state.saves[0]!;
  assert.equal(entry.sessionID, SESSION_ID, "bash work 没有 child 会话：entry 落父会话");
  assert.equal(entry.type, SESSION_ENTRY_BACKGROUND_TASK_OUTCOME);
  assert.equal(entry.id, backgroundTaskOutcomeEntryId(WORK_ID), "幂等键由 workId 决定");
  assert.equal(entry.touchSession, false, "收敛不是任务活动，不改父会话活动时间");
  assert.deepEqual(
    { ...(entry.data as Record<string, unknown>) },
    {
      status: "lost",
      reason: "runtime_exit",
      workId: WORK_ID,
      parentSessionId: SESSION_ID,
      reconciledAt: new Date(now).toISOString(),
      runtimeInstance: { pid: process.pid },
    },
  );
});

test("不误杀：本进程认领（runtime 投影里该 work 仍 running）⇒ 不写 entry", async () => {
  const state = createState({});
  const result = await reconcileBackgroundTaskOrphansOnActivation({
    context: orphanContext(state, { claimedStatus: "running" }),
    sessionId: SESSION_ID,
    persistedMessages: parentMessages({}),
    now: BASE_MS + 3 * HOUR,
  });

  assert.equal(result.reconciled, 0);
  assert.deepEqual(state.saves, []);
  assert.deepEqual(result.skipped, [{ workId: WORK_ID, reason: "claimed_in_process" }]);
});

test("不误杀：有结果唤醒轮（真实终局）⇒ 不写 entry", async () => {
  const state = createState({ terminalNotice: true });
  const result = await reconcileBackgroundTaskOrphansOnActivation({
    context: orphanContext(state),
    sessionId: SESSION_ID,
    persistedMessages: parentMessages({ terminalNotice: true }),
    now: BASE_MS + 3 * HOUR,
  });

  assert.equal(result.reconciled, 0);
  assert.deepEqual(state.saves, []);
  assert.deepEqual(result.skipped, [{ workId: WORK_ID, reason: "terminal_evidence" }]);
});

test("不误杀：宽容期内（ACK 落库距今 < 10 分钟）⇒ 不写 entry", async () => {
  const state = createState({});
  const result = await reconcileBackgroundTaskOrphansOnActivation({
    context: orphanContext(state),
    sessionId: SESSION_ID,
    persistedMessages: parentMessages({}),
    now: BASE_MS + 150 + BACKGROUND_TASK_ORPHAN_GRACE_MS,
  });

  assert.equal(result.reconciled, 0);
  assert.deepEqual(result.skipped, [{ workId: WORK_ID, reason: "within_grace" }]);
});

test("幂等：entry 已落盘 ⇒ 不再进候选（不重复写、不覆盖）", async () => {
  const state = createState({});
  const context = orphanContext(state);
  const now = BASE_MS + 3 * HOUR;
  const first = await reconcileBackgroundTaskOrphansOnActivation({
    context,
    sessionId: SESSION_ID,
    persistedMessages: parentMessages({}),
    now,
  });
  assert.equal(first.reconciled, 1);
  assert.equal(state.saves.length, 1);

  const second = await reconcileBackgroundTaskOrphansOnActivation({
    context,
    sessionId: SESSION_ID,
    persistedMessages: parentMessages({}),
    now: now + HOUR,
  });
  assert.equal(second.reconciled, 0, "已收敛的 work 不再是孤儿");
  assert.deepEqual(second.skipped, [{ workId: WORK_ID, reason: "terminal_evidence" }]);
  assert.equal(state.saves.length, 1, "同 key 覆盖，不累积");
});

test("降级：写 entry 失败 ⇒ 只标 write_failed，不抛出（N9）", async () => {
  const state = createState({});
  state.failEntryWrite = true;
  const result = await reconcileBackgroundTaskOrphansOnActivation({
    context: orphanContext(state),
    sessionId: SESSION_ID,
    persistedMessages: parentMessages({}),
    now: BASE_MS + 3 * HOUR,
  });

  assert.equal(result.reconciled, 0);
  assert.deepEqual(result.skipped, [{ workId: WORK_ID, reason: "write_failed" }]);
});

// ── 投影同源：收敛事实让陈旧 running 在重建投影里收口 ──────────────────────────────

/** 内存里悬着的陈旧 running（进程死了、终态事件从未落盘）——面板卡片的来源。 */
function staleRunningMemoryEvents(workId: string) {
  return [
    {
      id: "mem-bg-start" as never,
      sessionId: SESSION_ID as never,
      type: "background_task_started" as never,
      timestamp: new Date(BASE_MS + 150),
      traceId: "trace-live" as never,
      sequenceNumber: 1,
      payload: {
        taskId: workId,
        toolCallId: TOOL_CALL_ID,
        toolName: "Bash",
        taskKind: "bash",
        description: "长跑终端",
        status: "running",
        cancellable: true,
        startedAt: new Date(BASE_MS + 150),
      },
    },
  ] as unknown as import("@zcode/contracts").SessionEvent[];
}

test("投影：内存里陈旧 running + 收敛事实 ⇒ 收口为终态，runningBashWorks 为空", async () => {
  const state = createState({});
  const context = orphanContext(state);
  const now = BASE_MS + 3 * HOUR;
  await reconcileBackgroundTaskOrphansOnActivation({
    context,
    sessionId: SESSION_ID,
    persistedMessages: parentMessages({}),
    now,
  });
  const inventory = await readSessionBackgroundTaskInventory(context, SESSION_ID);
  const facts = reconciledBackgroundTaskHydrationFacts(inventory);
  assert.equal(facts.length, 1, "映射只带 entry 来源的收敛事实");

  // 修前：内存事件里的 running 是唯一写者，投影永久停 running（面板卡片停不下）。
  const withoutFacts = hydrate({
    messages: parentMessages({}),
    memoryEvents: staleRunningMemoryEvents(WORK_ID),
  });
  assert.equal(withoutFacts.snapshot.backgroundWorks[0]?.status, "running");

  // 修后：收敛事实合成终态事件并排在内存事件之后 ⇒ 收口。
  const withFacts = hydrate({
    messages: parentMessages({}),
    memoryEvents: staleRunningMemoryEvents(WORK_ID),
    reconciledBackgroundTasks: facts,
  });
  const [work] = withFacts.snapshot.backgroundWorks;
  assert.equal(work?.workId, WORK_ID);
  assert.notEqual(work?.status, "running", "陈旧 running 必须收敛（面板卡片消失）");
  assert.equal(work?.startedAt, BASE_MS + 150, "收敛行的 startedAt 取 ACK 的真实落库时间");
  assert.equal(work?.endedAt, now, "收敛行的 endedAt 取 reconciledAt（0ecb862 定案）");
  assert.equal(work?.cancellable, false, "已收敛的 work 不许留 Stop 入口");
});

test("投影：收敛事实幂等（同一份 transcript + 事实重放两次逐字段一致）", () => {
  const facts = [
    {
      workId: WORK_ID,
      toolCallId: TOOL_CALL_ID,
      title: "长跑终端",
      startedAtMs: BASE_MS + 150,
      endedAtMs: BASE_MS + 3 * HOUR,
    },
  ];
  const first = hydrate({
    messages: parentMessages({}),
    memoryEvents: staleRunningMemoryEvents(WORK_ID),
    reconciledBackgroundTasks: facts,
  });
  const second = hydrate({
    messages: parentMessages({}),
    memoryEvents: staleRunningMemoryEvents(WORK_ID),
    reconciledBackgroundTasks: facts,
  });

  assert.deepEqual(second.snapshot.backgroundWorks, first.snapshot.backgroundWorks);
  assert.deepEqual(second.snapshot.rows.window, first.snapshot.rows.window);
});

test("投影：内存里已有真实终态 ⇒ 收敛事件缺席，真实终局不被盖（优先级）", () => {
  const memoryEvents = [
    ...staleRunningMemoryEvents(WORK_ID),
    {
      id: "mem-bg-completed" as never,
      sessionId: SESSION_ID as never,
      type: "background_task_completed" as never,
      timestamp: new Date(BASE_MS + 2 * HOUR),
      traceId: "trace-live" as never,
      sequenceNumber: 2,
      payload: {
        taskId: WORK_ID,
        toolName: "Bash",
        taskKind: "bash",
        status: "completed",
        completedAt: new Date(BASE_MS + 2 * HOUR),
      },
    },
  ] as unknown as import("@zcode/contracts").SessionEvent[];

  const { snapshot } = hydrate({
    messages: parentMessages({}),
    memoryEvents,
    reconciledBackgroundTasks: [
      {
        workId: WORK_ID,
        toolCallId: TOOL_CALL_ID,
        title: "长跑终端",
        endedAtMs: BASE_MS + 3 * HOUR,
      },
    ],
  });
  const [work] = snapshot.backgroundWorks;
  assert.equal(work?.status, "resultPending", "真实 completed 赢过收敛补洞（不得被改写）");
  assert.equal(work?.endedAt, BASE_MS + 2 * HOUR);
});

test("投影：后台 work 行的 startedAt/endedAt 取载荷真实时间，不用合成事件时刻", () => {
  const { snapshot } = hydrate({
    messages: parentMessages({}),
    reconciledBackgroundTasks: [
      {
        workId: WORK_ID,
        toolCallId: TOOL_CALL_ID,
        title: "长跑终端",
        startedAtMs: BASE_MS + 150,
        endedAtMs: BASE_MS + 3 * HOUR,
      },
    ],
  });
  const [work] = snapshot.backgroundWorks;
  assert.equal(work?.startedAt, BASE_MS + 150);
  assert.equal(work?.endedAt, BASE_MS + 3 * HOUR);
});
