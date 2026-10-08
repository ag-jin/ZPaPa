// 后台子 agent 的孤儿收敛：判据 J1-J5 与 subagent_outcome 落盘。
//
// 为什么这组用例承重：48f7f18 之后「已知 child ∧ 无终态 ⇒ running」的规则保护了切走再切回仍在
// 跑的 agent，但宿主进程被硬杀/崩溃、child 没留下终态落盘时，该 agent 会长期显示 running——
// 面板出现一张无 Stop 入口的常驻卡片，且没有任何后续事实能让它自愈。本组用例锁定收敛的**边界**
// （J1-J5）与**落盘形状**（幂等键、终态词、原因码），并逐条覆盖 N1-N9 里不能误杀的场合。
//
// 判据来源与侧栏/hydration 同一条：child session 的持久记录。模块自己不再判活/判终态，只消费
// 权威清单（readSessionSubagentInventory）带出的 known/running/ended/后台候选/最后活动。

import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionId,
  SessionEventType,
  type MessageWithParts,
  type SessionEntryInfo,
  type SessionEvent,
  type SessionId,
  type SessionInfo,
  type SessionTaskType,
} from "@zcode/contracts";
import { SESSION_ENTRY_SUBAGENT_OUTCOME } from "../src/zcode-protocol/subagent-session-query.js";
import { listSessionSubagents, readSessionSubagentInventory } from "../src/zcode-protocol/server-operations.js";
import {
  SUBAGENT_ORPHAN_GRACE_MS,
  SUBAGENT_ORPHAN_RECONCILE_REASON,
  reconcileSubagentOrphansOnActivation,
  selectSubagentOrphans,
  subagentOutcomeEntryId,
  type SubagentOrphanCandidateFacts,
} from "../src/zcode-protocol/subagent-orphan-reconcile.js";

const PARENT_SESSION_ID = "sess_orphan_reconcile_parent";
const AGENT_ID = "agent_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CHILD_SESSION_ID = String(createSessionId(`subagent_${AGENT_ID}`));
const TURN_ID = "turn_orphan_reconcile";
const USER_MESSAGE_ID = "msg_orphan_reconcile_user";
const ASSISTANT_MESSAGE_ID = "msg_orphan_reconcile_assistant";
const TOOL_CALL_ID = "call_orphan_reconcile_agent";
const NOW = 1_700_000_000_000;
const MINUTE = 60 * 1_000;
const HOUR = 60 * MINUTE;

/** 后台 Agent 的持久化 launch ACK：与 core 的 `formatAgentOutputForModel` 同形。 */
function backgroundLaunchAck(agentId: string): string {
  return [
    "Async agent launched successfully.",
    `agentId: ${agentId} (internal ID - do not mention to user. Use SendMessage with to: '${agentId}' to continue this agent.)`,
    "The agent is working in the background. You will be notified automatically when it completes.",
  ].join("\n");
}

function foregroundResult(agentId: string): string {
  return [
    "子 agent 结果",
    `agentId: ${agentId} (use SendMessage with to: '${agentId}' to continue this agent)`,
  ].join("\n");
}

/** 一个 Agent 工具 part（默认后台 launch ACK 形态；`background: false` 走阻塞式结果输出）。 */
function agentToolPart(input: {
  agentId: string;
  callId: string;
  background: boolean;
  startedAt: number;
}): unknown {
  return {
    id: `part_${input.callId}`,
    type: "tool",
    callID: input.callId,
    tool: "Agent",
    state: {
      status: "completed",
      input: {
        description: "长跑后台 agent",
        prompt: "do work",
        ...(input.background ? { run_in_background: true } : {}),
        subagent_type: "implementer",
      },
      output: input.background
        ? backgroundLaunchAck(input.agentId)
        : foregroundResult(input.agentId),
      time: { start: input.startedAt, end: input.startedAt + (input.background ? 100 : 5_000) },
    },
  };
}

function sessionInfo(input: {
  id: string;
  taskType: SessionTaskType;
  updated: number;
  parentID?: string;
}): SessionInfo {
  return {
    id: input.id as SessionId,
    projectID: "proj_orphan_reconcile" as SessionInfo["projectID"],
    taskType: input.taskType,
    slug: "orphan-reconcile",
    directory: "/tmp/orphan-reconcile",
    title: "orphan reconcile",
    version: "0.0.0-test",
    time: { created: input.updated - HOUR, updated: input.updated },
    ...(input.parentID ? { parentID: input.parentID as SessionId } : {}),
  };
}

function userMessage(): MessageWithParts {
  return {
    info: {
      id: USER_MESSAGE_ID,
      role: "user",
      time: { created: NOW - 3 * HOUR },
      semantics: {
        origin: "real_user",
        kind: "user_prompt",
        uiVisibility: "visible",
        providerVisibility: "visible",
        transcriptVisibility: "visible",
      },
      anchor: { turnId: TURN_ID, origin: "realUser" },
    },
    parts: [{ id: "part_orphan_reconcile_user", type: "text", text: "启动后台 agent" }],
  } as unknown as MessageWithParts;
}

/** 含 Agent 工具 part 的 assistant message（默认一个后台 launch ACK part）。 */
function assistantMessage(options: {
  background: boolean;
  startedAt: number;
  parts?: unknown[];
}): MessageWithParts {
  const parts = options.parts ?? [
    agentToolPart({
      agentId: AGENT_ID,
      callId: TOOL_CALL_ID,
      background: options.background,
      startedAt: options.startedAt,
    }),
  ];
  return {
    info: {
      id: ASSISTANT_MESSAGE_ID,
      role: "assistant",
      parentID: USER_MESSAGE_ID,
      time: { created: options.startedAt - 500, completed: options.startedAt + 5_000 },
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

/**
 * child transcript 的最后一条消息（给 J5 的「最后消息时间」提供事实）。
 * 形状是「还在跑」：最后一条 assistant 带 tool part 且没有 completed/finish —— 与
 * `lastChildOutcome` 的判据一致（含 tool round 的 model step 结束不是 child 终态）。
 */
function childTranscript(activityAt: number): MessageWithParts[] {
  return [
    {
      info: {
        id: `msg_child_assistant_${activityAt}`,
        role: "assistant",
        parentID: "msg_orphan_reconcile_child_user",
        time: { created: activityAt },
        finish: "tool-calls",
      },
      parts: [
        {
          id: `part_child_tool_${activityAt}`,
          type: "tool",
          callID: `call_child_tool_${activityAt}`,
          tool: "Bash",
          state: { status: "running", input: { command: "sleep 600" }, time: { start: activityAt } },
        },
      ],
    } as unknown as MessageWithParts,
  ];
}

/**
 * 内存 fake store：只实现收敛路径真正读写的 port 面（getSession / messages /
 * sessionEntries / saveSessionEntry）。`saveSessionEntry` 记录全部写入，供幂等断言。
 */
interface FakeOrphanStore {
  sessions: Map<string, SessionInfo>;
  messages: Map<string, MessageWithParts[]>;
  entries: Map<string, SessionEntryInfo[]>;
  saves: SessionEntryInfo[];
  failSaveWith?: Error;
  failMessagesFor?: string;
}

function createFakeStore(): FakeOrphanStore {
  return { sessions: new Map(), messages: new Map(), entries: new Map(), saves: [] };
}

function fakeSessionStore(state: FakeOrphanStore) {
  return {
    async getSession(sessionID: string): Promise<SessionInfo | null> {
      return state.sessions.get(sessionID) ?? null;
    },
    async messages(input: { sessionID: string }): Promise<MessageWithParts[]> {
      // 读面失败必须降级成 warn + 跳过，不能把激活拖垮（N9）。
      if (state.failMessagesFor === input.sessionID) throw new Error("store unavailable");
      return state.messages.get(input.sessionID) ?? [];
    },
    async sessionEntries(input: { sessionID: string; type?: string }): Promise<SessionEntryInfo[]> {
      return (state.entries.get(input.sessionID) ?? []).filter(
        (entry) => input.type === undefined || entry.type === input.type,
      );
    },
    async saveSessionEntry(entry: SessionEntryInfo): Promise<void> {
      if (state.failSaveWith) throw state.failSaveWith;
      state.saves.push(entry);
      const key = String(entry.sessionID);
      const existing = state.entries.get(key) ?? [];
      // 与 store adapter 的 on conflict(id) upsert 同语义：同 key 覆盖，不追加。
      state.entries.set(key, [...existing.filter((item) => item.id !== entry.id), entry]);
    },
  };
}

type ReconcileInput = Parameters<typeof reconcileSubagentOrphansOnActivation>[0];

/**
 * 本进程 live record 的窄面。`liveSessionIds` 是「本进程有 record」的会话（读面只从 live 父记录
 * 取事件与投影，见 readSessionSubagentInventory）；`parentEvents` 是这些记录能读到的事件。
 */
function reconcileContext(
  state: FakeOrphanStore,
  liveSessionIds: readonly string[] = [],
  parentEvents: readonly SessionEvent[] = [],
) {
  const sessions = new Map<string, unknown>();
  for (const sessionId of liveSessionIds) {
    sessions.set(sessionId, {
      // 与真实 record 同形的最小面：清单读取会问事件与投影。恢复出的空投影正是「接管时刻
      // 本进程零在飞」的形态（registry/事件都是进程内内存态）。
      stateRevision: 0,
      eventStore: { getEvents: async () => [...parentEvents] },
      app: { runtime: { getProjection: async () => undefined } },
    });
  }
  return {
    deps: { sessionStore: fakeSessionStore(state) },
    sessions,
  } as unknown as ReconcileInput["context"];
}

/** 父会话的 SubagentStopped 事件（与 core runner 落盘同形，`status` 决定 stoppedStatus）。 */
function subagentStoppedEvent(input: {
  stoppedAt: number;
  status: "success" | "failed" | "cancelled";
}): SessionEvent {
  return {
    type: SessionEventType.SubagentStopped,
    sessionID: PARENT_SESSION_ID as SessionId,
    timestamp: new Date(input.stoppedAt),
    payload: {
      agentId: AGENT_ID,
      agentType: "implementer",
      background: true,
      childSessionId: CHILD_SESSION_ID,
      parentToolCallId: TOOL_CALL_ID,
      status: input.status,
    },
  } as unknown as SessionEvent;
}

/** 标准孤儿场景：父 transcript 有后台 spawn，child 记录在场、无终态、活动时间可控。 */
function orphanScenario(options: {
  background?: boolean;
  childActivityAt: number;
  childUpdatedAt?: number;
  liveInProcess?: boolean;
  childTaskType?: SessionTaskType;
  childOutcomeStatus?: "failed" | "cancelled";
  /** 父会话的 live 事件（给「更硬的终局事实后来到场」类用例注入 stop 事实）。 */
  parentEvents?: readonly SessionEvent[];
}): { state: FakeOrphanStore; context: ReconcileInput["context"] } {
  const state = createFakeStore();
  state.sessions.set(
    PARENT_SESSION_ID,
    sessionInfo({ id: PARENT_SESSION_ID, taskType: "interactive", updated: NOW - 3 * HOUR }),
  );
  state.messages.set(PARENT_SESSION_ID, [
    userMessage(),
    assistantMessage({
      background: options.background ?? true,
      startedAt: NOW - 3 * HOUR + MINUTE,
    }),
  ]);
  state.sessions.set(
    CHILD_SESSION_ID,
    sessionInfo({
      id: CHILD_SESSION_ID,
      taskType: options.childTaskType ?? "subagent_child",
      parentID: PARENT_SESSION_ID,
      updated: options.childUpdatedAt ?? options.childActivityAt,
    }),
  );
  state.messages.set(
    CHILD_SESSION_ID,
    options.childOutcomeStatus
      ? [
          {
            info: {
              id: "msg_orphan_reconcile_child_failed",
              role: "assistant",
              parentID: "msg_orphan_reconcile_child_user",
              time: { created: options.childActivityAt - MINUTE, completed: options.childActivityAt },
              finish: "stop",
              error: { name: options.childOutcomeStatus },
            },
            parts: [{ id: "part_orphan_reconcile_child", type: "text", text: "失败" }],
          } as unknown as MessageWithParts,
        ]
      : childTranscript(options.childActivityAt),
  );
  return {
    state,
    context: reconcileContext(
      state,
      options.liveInProcess || options.parentEvents
        ? [PARENT_SESSION_ID, ...(options.liveInProcess ? [CHILD_SESSION_ID] : [])]
        : [],
      options.parentEvents ?? [],
    ),
  };
}

// ── 判据纯函数（J1/J4/J5 的分支）───────────────────────────────────────────────

test("判据：后台 ∧ 无本地 live ∧ 过宽容期 ⇒ 唯一入选项是孤儿", () => {
  const candidates: SubagentOrphanCandidateFacts[] = [
    {
      childSessionId: CHILD_SESSION_ID,
      backgroundLaunch: true,
      liveInProcess: false,
      lastActivityAt: NOW - SUBAGENT_ORPHAN_GRACE_MS - 1,
    },
  ];
  const selection = selectSubagentOrphans({ candidates, now: NOW });

  assert.deepEqual(
    selection.orphans.map((item) => item.childSessionId),
    [CHILD_SESSION_ID],
  );
  assert.deepEqual(selection.skipped, []);
});

test("判据：宽容期内（child 还有近期活动）⇒ 不入选，skip 原因为 within_grace", () => {
  const selection = selectSubagentOrphans({
    candidates: [
      {
        childSessionId: CHILD_SESSION_ID,
        backgroundLaunch: true,
        liveInProcess: false,
        lastActivityAt: NOW - SUBAGENT_ORPHAN_GRACE_MS + 1,
      },
    ],
    now: NOW,
  });

  // 边界：恰好等于宽容期也算「还在窗口内」，宁可不收敛（N4 双进程违例防御）。
  assert.deepEqual(selection.orphans, []);
  assert.deepEqual(selection.skipped, [
    { childSessionId: CHILD_SESSION_ID, reason: "within_grace" },
  ]);
});

test("判据：前台（阻塞式）Agent ⇒ 不入选，skip 原因为 not_background（N7）", () => {
  const selection = selectSubagentOrphans({
    candidates: [
      {
        childSessionId: CHILD_SESSION_ID,
        backgroundLaunch: false,
        liveInProcess: false,
        lastActivityAt: NOW - HOUR,
      },
    ],
    now: NOW,
  });

  assert.deepEqual(selection.orphans, []);
  assert.deepEqual(selection.skipped, [
    { childSessionId: CHILD_SESSION_ID, reason: "not_background" },
  ]);
});

test("判据：本进程仍在认领该 child ⇒ 不入选，skip 原因为 live_child（N1/N2）", () => {
  const selection = selectSubagentOrphans({
    candidates: [
      {
        childSessionId: CHILD_SESSION_ID,
        backgroundLaunch: true,
        liveInProcess: true,
        lastActivityAt: NOW - HOUR,
      },
    ],
    now: NOW,
  });

  assert.deepEqual(selection.orphans, []);
  assert.deepEqual(selection.skipped, [{ childSessionId: CHILD_SESSION_ID, reason: "live_child" }]);
});

test("判据：读不到 child 最后活动 ⇒ 不入选（无法证明过宽容期，保守跳过）", () => {
  const selection = selectSubagentOrphans({
    candidates: [
      {
        childSessionId: CHILD_SESSION_ID,
        backgroundLaunch: true,
        liveInProcess: false,
      },
    ],
    now: NOW,
  });

  assert.deepEqual(selection.orphans, []);
  assert.deepEqual(selection.skipped, [
    { childSessionId: CHILD_SESSION_ID, reason: "activity_unknown" },
  ]);
});

test("判据：宽容期可注入（小值的单位是毫秒，不是固定 10 分钟）", () => {
  const candidate: SubagentOrphanCandidateFacts = {
    childSessionId: CHILD_SESSION_ID,
    backgroundLaunch: true,
    liveInProcess: false,
    lastActivityAt: NOW - 2 * MINUTE,
  };

  assert.deepEqual(selectSubagentOrphans({ candidates: [candidate], now: NOW }).skipped, [
    { childSessionId: CHILD_SESSION_ID, reason: "within_grace" },
  ]);
  assert.equal(
    selectSubagentOrphans({ candidates: [candidate], now: NOW, graceMs: MINUTE }).orphans.length,
    1,
  );
});

// ── 模块：写什么、不写什么 ───────────────────────────────────────────────────

test("孤儿：后台 ∧ 无终态 ∧ 过宽容期 ⇒ 落盘 subagent_outcome{lost, runtime_exit}", async () => {
  const { state, context } = orphanScenario({
    childActivityAt: NOW - SUBAGENT_ORPHAN_GRACE_MS - 1,
  });

  const result = await reconcileSubagentOrphansOnActivation({
    context,
    sessionId: PARENT_SESSION_ID,
    now: NOW,
  });

  assert.equal(result.reconciled, 1);
  assert.deepEqual(result.skipped, []);
  assert.equal(state.saves.length, 1, "只写一次，且只写孤儿一个");
  const [entry] = state.saves;
  assert.equal(entry.id, `subagent-outcome:${CHILD_SESSION_ID}`, "幂等键必须是确定性的");
  assert.equal(entry.id, subagentOutcomeEntryId(CHILD_SESSION_ID));
  assert.equal(entry.type, SESSION_ENTRY_SUBAGENT_OUTCOME);
  assert.equal(entry.sessionID, CHILD_SESSION_ID, "收敛事实落在 child 会话上（终态的唯一权威）");
  assert.equal(entry.time.created, NOW);
  assert.equal(entry.time.updated, NOW);
  assert.equal(entry.touchSession, false, "收敛不是任务活动，不能改写 child 的活动时间");
  assert.deepEqual(entry.data, {
    status: "lost",
    reason: SUBAGENT_ORPHAN_RECONCILE_REASON,
    parentSessionId: PARENT_SESSION_ID,
    reconciledAt: new Date(NOW).toISOString(),
    runtimeInstance: { pid: process.pid },
  });
});

test("不收敛：child 有真实终态（outcome）⇒ 不进 running 集合，一行都不写（N6）", async () => {
  const { state, context } = orphanScenario({
    childActivityAt: NOW - HOUR,
    childOutcomeStatus: "cancelled",
  });

  const result = await reconcileSubagentOrphansOnActivation({
    context,
    sessionId: PARENT_SESSION_ID,
    now: NOW,
  });

  assert.equal(result.reconciled, 0);
  assert.deepEqual(state.saves, [], "有真实终态的 child 不是孤儿，收敛者不许碰");
});

test("不收敛：前台 Agent（阻塞式）⇒ 无后台 spawn 候选，一行都不写（N7）", async () => {
  const { state, context } = orphanScenario({
    background: false,
    childActivityAt: NOW - HOUR,
  });

  const result = await reconcileSubagentOrphansOnActivation({
    context,
    sessionId: PARENT_SESSION_ID,
    now: NOW,
  });

  assert.equal(result.reconciled, 0);
  assert.deepEqual(state.saves, []);
});

test("不收敛：本进程有该 child 的 live runtime ⇒ 跳过并不写（N1/N2）", async () => {
  const { state, context } = orphanScenario({
    childActivityAt: NOW - HOUR,
    liveInProcess: true,
  });

  const result = await reconcileSubagentOrphansOnActivation({
    context,
    sessionId: PARENT_SESSION_ID,
    now: NOW,
  });

  assert.equal(result.reconciled, 0);
  assert.deepEqual(result.skipped, [
    { childSessionId: CHILD_SESSION_ID, reason: "live_child" },
  ]);
  assert.deepEqual(state.saves, []);
});

test("不收敛：child 记录不在场（被裁剪/从未落库/回放桶）⇒ 不参与收敛（N8）", async () => {
  const { state, context } = orphanScenario({ childActivityAt: NOW - HOUR });
  state.sessions.delete(CHILD_SESSION_ID);
  state.messages.delete(CHILD_SESSION_ID);

  const result = await reconcileSubagentOrphansOnActivation({
    context,
    sessionId: PARENT_SESSION_ID,
    now: NOW,
  });

  assert.equal(result.reconciled, 0);
  assert.deepEqual(state.saves, [], "读不到 child 记录时保持 part 推断的有界降级，不凭空收敛");
});

test("不收敛：child 会话 taskType 不是 subagent_child ⇒ 不参与（权威清单口径）", async () => {
  const { state, context } = orphanScenario({
    childActivityAt: NOW - HOUR,
    childTaskType: "interactive",
  });

  const result = await reconcileSubagentOrphansOnActivation({
    context,
    sessionId: PARENT_SESSION_ID,
    now: NOW,
  });

  assert.equal(result.reconciled, 0);
  assert.deepEqual(state.saves, []);
});

test("写失败：saveSessionEntry 抛错 ⇒ warn 降级、不抛出，结果标记 write_failed（N9）", async () => {
  const { state, context } = orphanScenario({
    childActivityAt: NOW - SUBAGENT_ORPHAN_GRACE_MS - 1,
  });
  state.failSaveWith = new Error("session_entry write failed");

  const result = await reconcileSubagentOrphansOnActivation({
    context,
    sessionId: PARENT_SESSION_ID,
    now: NOW,
  });

  assert.equal(result.reconciled, 0);
  assert.deepEqual(result.skipped, [
    { childSessionId: CHILD_SESSION_ID, reason: "write_failed" },
  ]);
  assert.deepEqual(state.saves, []);
});

test("读失败：child transcript 读不出来 ⇒ warn 降级、不抛出、不写（N9）", async () => {
  const { state, context } = orphanScenario({
    childActivityAt: NOW - SUBAGENT_ORPHAN_GRACE_MS - 1,
  });
  state.failMessagesFor = CHILD_SESSION_ID;

  const result = await reconcileSubagentOrphansOnActivation({
    context,
    sessionId: PARENT_SESSION_ID,
    now: NOW,
  });

  assert.equal(result.reconciled, 0);
  assert.deepEqual(state.saves, []);
});

test("宽容期取 session 活动与 transcript 最后消息的较大者（J5）：刚写过工具结果的 child 不算孤儿", async () => {
  // session 的活动时间停在两小时前（单看它会误判成孤儿），但 child transcript 一分钟前才写过：
  // 这正是「长工具执行后刚写了结果」的活 agent，必须判在宽容期内（N4）。
  const { state, context } = orphanScenario({
    childActivityAt: NOW - MINUTE,
    childUpdatedAt: NOW - 2 * HOUR,
  });

  const result = await reconcileSubagentOrphansOnActivation({
    context,
    sessionId: PARENT_SESSION_ID,
    now: NOW,
  });

  assert.equal(result.reconciled, 0);
  assert.deepEqual(result.skipped, [
    { childSessionId: CHILD_SESSION_ID, reason: "within_grace" },
  ]);
  assert.deepEqual(state.saves, []);
});

const ENDED_AGENT_ID = "agent_ended_1111-2222-4333-8444-555555555555";
const LIVE_AGENT_ID = "agent_live_6666-7777-4888-8999-000000000000";
const ENDED_CHILD_SESSION_ID = String(createSessionId(`subagent_${ENDED_AGENT_ID}`));
const LIVE_CHILD_SESSION_ID = String(createSessionId(`subagent_${LIVE_AGENT_ID}`));

test("混合：一个已结束、一个本进程在跑、一个孤儿 ⇒ 只收敛孤儿那一个（设计 §4.7-9）", async () => {
  const { state } = orphanScenario({
    childActivityAt: NOW - SUBAGENT_ORPHAN_GRACE_MS - 1,
  });
  const parentMessages = state.messages.get(PARENT_SESSION_ID) ?? [];
  state.messages.set(PARENT_SESSION_ID, [
    parentMessages[0] ?? userMessage(),
    assistantMessage({
      background: true,
      startedAt: NOW - 3 * HOUR + MINUTE,
      parts: [
        agentToolPart({
          agentId: AGENT_ID,
          callId: TOOL_CALL_ID,
          background: true,
          startedAt: NOW - 3 * HOUR + MINUTE,
        }),
        agentToolPart({
          agentId: ENDED_AGENT_ID,
          callId: "call_orphan_reconcile_ended",
          background: true,
          startedAt: NOW - 3 * HOUR + MINUTE,
        }),
        agentToolPart({
          agentId: LIVE_AGENT_ID,
          callId: "call_orphan_reconcile_live",
          background: true,
          startedAt: NOW - 3 * HOUR + MINUTE,
        }),
      ],
    }),
  ]);
  // 已结束的 child：有真实终态（cancelled），不进 running 集合。
  state.sessions.set(
    ENDED_CHILD_SESSION_ID,
    sessionInfo({
      id: ENDED_CHILD_SESSION_ID,
      taskType: "subagent_child",
      parentID: PARENT_SESSION_ID,
      updated: NOW - HOUR,
    }),
  );
  state.messages.set(ENDED_CHILD_SESSION_ID, [
    {
      info: {
        id: "msg_orphan_reconcile_ended_child",
        role: "assistant",
        parentID: "msg_orphan_reconcile_child_user",
        time: { created: NOW - HOUR, completed: NOW - HOUR },
        finish: "stop",
        error: { name: "cancelled" },
      },
      parts: [{ id: "part_orphan_reconcile_ended_child", type: "text", text: "已取消" }],
    } as unknown as MessageWithParts,
  ]);
  // 本进程在跑的 child：无终态、过宽容期，但有 live runtime（N1/N2）。
  state.sessions.set(
    LIVE_CHILD_SESSION_ID,
    sessionInfo({
      id: LIVE_CHILD_SESSION_ID,
      taskType: "subagent_child",
      parentID: PARENT_SESSION_ID,
      updated: NOW - SUBAGENT_ORPHAN_GRACE_MS - 1,
    }),
  );
  state.messages.set(
    LIVE_CHILD_SESSION_ID,
    childTranscript(NOW - SUBAGENT_ORPHAN_GRACE_MS - 1),
  );
  const context = reconcileContext(state, [PARENT_SESSION_ID, LIVE_CHILD_SESSION_ID]);

  const result = await reconcileSubagentOrphansOnActivation({
    context,
    sessionId: PARENT_SESSION_ID,
    now: NOW,
  });

  assert.equal(result.reconciled, 1, "三个 child 里只有一个真孤儿");
  assert.deepEqual(
    state.saves.map((entry) => entry.sessionID),
    [CHILD_SESSION_ID],
    "落盘的只有孤儿那一个 child",
  );
  assert.deepEqual(result.skipped, [
    { childSessionId: LIVE_CHILD_SESSION_ID, reason: "live_child" },
  ]);
});

// ── 读面：收敛 entry 的消费（同一次读 / 终态优先级 / 幂等）────────────────────

test("读面：同一次读带出收敛判据所需的全部事实（running/ended + 后台候选 + 最后活动）", async () => {
  const { context } = orphanScenario({ childActivityAt: NOW - HOUR });

  const inventory = await readSessionSubagentInventory(context, PARENT_SESSION_ID);
  const [running] = inventory.running;

  assert.deepEqual(inventory.childSessionIds, [CHILD_SESSION_ID]);
  assert.deepEqual(inventory.backgroundChildSessionIds, [CHILD_SESSION_ID], "J1 事实随同一次读带出");
  assert.equal(
    inventory.childLastActivityAtMs.get(CHILD_SESSION_ID),
    NOW - HOUR,
    "J5 事实随同一次读带出",
  );
  assert.equal(running?.childSessionId, CHILD_SESSION_ID);
  assert.deepEqual(inventory.ended, []);
});

test("读面：subagent_outcome entry 让 child 离开 running 并进入 ended{lost}", async () => {
  const { state, context } = orphanScenario({ childActivityAt: NOW - SUBAGENT_ORPHAN_GRACE_MS - 1 });
  // 手工放一条收敛 entry（模拟上一个 runtime 收敛后落盘的事实）：entry 本身就是终态证据，
  // 读面不许再凭空宣称 running——否则侧栏说「运行中」、行说 failed，正是 48f7f18 消灭的裂缝。
  state.entries.set(CHILD_SESSION_ID, [
    {
      id: subagentOutcomeEntryId(CHILD_SESSION_ID),
      sessionID: CHILD_SESSION_ID as SessionId,
      type: SESSION_ENTRY_SUBAGENT_OUTCOME,
      time: { created: NOW - HOUR, updated: NOW - HOUR },
      data: { status: "lost", reason: SUBAGENT_ORPHAN_RECONCILE_REASON },
    },
  ]);

  const inventory = await readSessionSubagentInventory(context, PARENT_SESSION_ID);

  assert.deepEqual(inventory.running, []);
  assert.deepEqual(
    inventory.ended.map((item) => ({ childSessionId: item.childSessionId, status: item.status })),
    [{ childSessionId: CHILD_SESSION_ID, status: "lost" }],
  );
});

/** 收敛 entry 的落盘形状（与 `buildSubagentOutcomeEntry` 同形：data.reconciledAt 是 ISO 串）。 */
function outcomeEntry(input: { childSessionId: string; reconciledAt: number }): SessionEntryInfo {
  return {
    id: subagentOutcomeEntryId(input.childSessionId),
    sessionID: input.childSessionId as SessionId,
    type: SESSION_ENTRY_SUBAGENT_OUTCOME,
    time: { created: input.reconciledAt, updated: input.reconciledAt },
    data: {
      status: "lost",
      reason: SUBAGENT_ORPHAN_RECONCILE_REASON,
      reconciledAt: new Date(input.reconciledAt).toISOString(),
    },
  } as SessionEntryInfo;
}

test("读面：收敛行的 endedAt 取 entry.data.reconciledAt，不用 spawn part 的时刻", async () => {
  // 收敛行的时间若取 spawn part 的 end（launch ACK 时刻），一个跑了很久才被收敛的孤儿会带着
  // 很早的时间进 ended 排序 —— 长期存在的老会话里它会沉到分页底部，用户翻不到（本用例锁时间来源）。
  const { state, context } = orphanScenario({ childActivityAt: NOW - 2 * HOUR });
  const reconciledAt = NOW - 5 * MINUTE;
  state.entries.set(CHILD_SESSION_ID, [
    outcomeEntry({ childSessionId: CHILD_SESSION_ID, reconciledAt }),
  ]);

  const inventory = await readSessionSubagentInventory(context, PARENT_SESSION_ID);
  const [ended] = inventory.ended;

  assert.equal(ended?.status, "lost");
  assert.equal(
    ended?.endedAt,
    reconciledAt,
    "收敛行的时间必须是 entry 记下的收敛时刻（spawn part 的 end 早得多）",
  );
  // 反面对照：spawn part 的 end = NOW - 3h + 1min + 100ms（orphanScenario 的固定值）。
  assert.notEqual(ended?.endedAt, NOW - 3 * HOUR + MINUTE + 100);
});

test("读面：因收敛落 lost 的行带 reconciled 标记（UI 副文案的唯一判据）", async () => {
  // 「已丢失」只说了状态，没说为什么。UI 只有在能分辨「这条终态是收敛来的」时才该写
  // 「运行时已退出，结果未知」；真实终态到场后标记必须消失，否则副文案会给真结果配错解释。
  const { state, context } = orphanScenario({ childActivityAt: NOW - 2 * HOUR });
  state.entries.set(CHILD_SESSION_ID, [
    outcomeEntry({ childSessionId: CHILD_SESSION_ID, reconciledAt: NOW }),
  ]);

  const inventory = await readSessionSubagentInventory(context, PARENT_SESSION_ID);
  assert.equal(inventory.ended[0]?.status, "lost");
  assert.equal(inventory.ended[0]?.reconciled, true, "收敛来的终态行必须可被 UI 识别");

  // 真实 outcome 后来到场（例如另一进程真把它跑完了）：标记必须让位。
  state.messages.set(CHILD_SESSION_ID, [
    {
      info: {
        id: "msg_child_late_success",
        role: "assistant",
        parentID: "msg_orphan_reconcile_child_user",
        time: { created: NOW - 2 * MINUTE, completed: NOW - MINUTE },
        finish: "stop",
      },
      parts: [{ id: "part_child_late_success", type: "text", text: "完成" }],
    } as unknown as MessageWithParts,
  ]);
  const afterOutcome = await readSessionSubagentInventory(context, PARENT_SESSION_ID);
  assert.equal(afterOutcome.ended[0]?.status, "success");
  assert.equal(afterOutcome.ended[0]?.reconciled, undefined, "真实终态不是收敛来的，不许带标记");
});

test("读面：更晚的 stop 事实赢过收敛 entry ⇒ 终态、时间、标记都跟着真实终局", async () => {
  // 反面对照（上一条只证明了「entry 决定终态时带标记」）：entry 落盘后又来了更硬的终局事实
  // （父会话的 SubagentStopped）——这条行的终态由后者决定，标记与时间就必须跟着后者走。
  // 若判据写成「有 entry ∧ child 无 outcome」而不看**终态到底取自谁**：取消行会被配上
  // 「运行时已退出，结果未知」的成因文案，并按收敛时刻排进分页（比真实取消时刻早得多）。
  const stoppedAt = NOW - MINUTE;
  const { state, context } = orphanScenario({
    childActivityAt: NOW - 2 * HOUR,
    parentEvents: [subagentStoppedEvent({ stoppedAt, status: "cancelled" })],
  });
  state.entries.set(CHILD_SESSION_ID, [
    outcomeEntry({ childSessionId: CHILD_SESSION_ID, reconciledAt: NOW - 5 * MINUTE }),
  ]);

  const inventory = await readSessionSubagentInventory(context, PARENT_SESSION_ID);
  const [ended] = inventory.ended;

  assert.equal(ended?.status, "cancelled", "更晚的 stop 事实赢过收敛 entry");
  assert.equal(ended?.reconciled, undefined, "终态不是收敛来的，不许带成因标记");
  assert.equal(ended?.endedAt, stoppedAt, "时间也必须取真实终局时刻，不取收敛时刻");
});

test("读面：长期孤儿按收敛时刻排序 ⇒ 收敛行留在首页（不掉出 limit 分页）", async () => {
  const secondAgentId = "agent_bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  const secondChildSessionId = String(createSessionId(`subagent_${secondAgentId}`));
  const secondCallId = "call_orphan_reconcile_agent_second";
  const state = createFakeStore();
  state.sessions.set(
    PARENT_SESSION_ID,
    sessionInfo({ id: PARENT_SESSION_ID, taskType: "interactive", updated: NOW - 3 * HOUR }),
  );
  // 父 transcript 两个后台 spawn：第一个早得多（老孤儿），第二个是刚结束的一条。
  state.messages.set(PARENT_SESSION_ID, [
    userMessage(),
    assistantMessage({
      background: true,
      startedAt: NOW - 3 * HOUR + MINUTE,
      parts: [
        agentToolPart({
          agentId: AGENT_ID,
          callId: TOOL_CALL_ID,
          background: true,
          startedAt: NOW - 4 * HOUR,
        }),
        agentToolPart({
          agentId: secondAgentId,
          callId: secondCallId,
          background: true,
          startedAt: NOW - 30 * MINUTE,
        }),
      ],
    }),
  ]);
  // child 1：老孤儿，早先被收敛（entry 在场，reconciledAt = NOW）。
  state.sessions.set(
    CHILD_SESSION_ID,
    sessionInfo({
      id: CHILD_SESSION_ID,
      taskType: "subagent_child",
      parentID: PARENT_SESSION_ID,
      updated: NOW - 4 * HOUR,
    }),
  );
  state.messages.set(CHILD_SESSION_ID, childTranscript(NOW - 4 * HOUR));
  state.entries.set(CHILD_SESSION_ID, [
    outcomeEntry({ childSessionId: CHILD_SESSION_ID, reconciledAt: NOW }),
  ]);
  // child 2：真实结束（近期终态），时间明显晚于老孤儿的 spawn 时刻。
  state.sessions.set(
    secondChildSessionId,
    sessionInfo({
      id: secondChildSessionId,
      taskType: "subagent_child",
      parentID: PARENT_SESSION_ID,
      updated: NOW - 25 * MINUTE,
    }),
  );
  state.messages.set(secondChildSessionId, [
    {
      info: {
        id: "msg_child_second_final",
        role: "assistant",
        parentID: "msg_orphan_reconcile_child_user",
        time: { created: NOW - 26 * MINUTE, completed: NOW - 25 * MINUTE },
        finish: "stop",
      },
      parts: [{ id: "part_child_second_final", type: "text", text: "完成" }],
    } as unknown as MessageWithParts,
  ]);

  const result = await listSessionSubagents(
    reconcileContext(state) as unknown as Parameters<typeof listSessionSubagents>[0],
    { endedLimit: 1, sessionId: PARENT_SESSION_ID },
  );

  assert.equal(result.ended.total, 2);
  assert.deepEqual(
    result.ended.items.map((item) => item.childSessionId),
    [CHILD_SESSION_ID],
    "收敛后的老孤儿必须排在首页（按 spawn 时刻排会沉到第二页，用户永远翻不到）",
  );
});

test("幂等：收敛后的后续接管不再重复写（entry 已让 child 离开 running 集合）", async () => {
  const { state, context } = orphanScenario({ childActivityAt: NOW - SUBAGENT_ORPHAN_GRACE_MS - 1 });

  const first = await reconcileSubagentOrphansOnActivation({
    context,
    sessionId: PARENT_SESSION_ID,
    now: NOW,
  });
  const second = await reconcileSubagentOrphansOnActivation({
    context,
    sessionId: PARENT_SESSION_ID,
    now: NOW + HOUR,
  });

  assert.equal(first.reconciled, 1);
  assert.equal(second.reconciled, 0, "已收敛的 child 不再是候选");
  assert.deepEqual(second.skipped, []);
  assert.equal(state.saves.length, 1, "同 key upsert，不累积第二条 entry");
  assert.equal(state.entries.get(CHILD_SESSION_ID)?.length, 1);
  const inventory = await readSessionSubagentInventory(context, PARENT_SESSION_ID);
  assert.deepEqual(inventory.running, []);
  assert.deepEqual(inventory.ended.map((item) => item.status), ["lost"]);
});

test("优先级：真实 outcome 后来到场 ⇒ 赢过收敛 entry（终态永远以真实记录为准）", async () => {
  const { state, context } = orphanScenario({ childActivityAt: NOW - SUBAGENT_ORPHAN_GRACE_MS - 1 });
  await reconcileSubagentOrphansOnActivation({ context, sessionId: PARENT_SESSION_ID, now: NOW });

  // child 后来真的结束/失败了（例如另一进程 resume 过它）：真实终态必须赢过补洞 entry。
  state.messages.set(CHILD_SESSION_ID, [
    {
      info: {
        id: "msg_child_late_outcome",
        role: "assistant",
        parentID: "msg_orphan_reconcile_child_user",
        time: { created: NOW - MINUTE, completed: NOW - MINUTE },
        finish: "stop",
        error: { name: "SubagentCrashed" },
      },
      parts: [{ id: "part_child_late_outcome", type: "text", text: "子 agent 失败" }],
    } as unknown as MessageWithParts,
  ]);

  const inventory = await readSessionSubagentInventory(context, PARENT_SESSION_ID);

  assert.deepEqual(inventory.running, []);
  assert.deepEqual(
    inventory.ended.map((item) => ({ childSessionId: item.childSessionId, status: item.status })),
    [{ childSessionId: CHILD_SESSION_ID, status: "failed" }],
  );
});

test("不收敛：spawn 在 rewind 掉的分支上 ⇒ 候选枚举只看当前分支，一行都不写（N5）", async () => {
  // rewind 之后旧的 spawn 还在 append-only store 里，但它不在当前分支上：候选枚举复用
  // activeBranchMessages/collectCandidates，分支外的 spawn 自然不进集合（收敛写的是 child
  // 持久事实、与分支无关，所以即便收敛了也无害；这里锁定「不该收敛就不收敛」）。
  const { state, context } = orphanScenario({
    childActivityAt: NOW - SUBAGENT_ORPHAN_GRACE_MS - 1,
  });
  const parentSession = state.sessions.get(PARENT_SESSION_ID);
  assert.ok(parentSession);
  parentSession.revert = { targetMessageID: USER_MESSAGE_ID } as SessionInfo["revert"];

  const result = await reconcileSubagentOrphansOnActivation({
    context,
    sessionId: PARENT_SESSION_ID,
    now: NOW,
  });

  assert.equal(result.reconciled, 0);
  assert.deepEqual(state.saves, []);
});
