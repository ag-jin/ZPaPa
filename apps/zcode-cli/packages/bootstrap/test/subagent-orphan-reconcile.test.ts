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
  type MessageWithParts,
  type SessionEntryInfo,
  type SessionId,
  type SessionInfo,
  type SessionTaskType,
} from "@zcode/contracts";
import { SESSION_ENTRY_SUBAGENT_OUTCOME } from "../src/zcode-protocol/subagent-session-query.js";
import { readSessionSubagentInventory } from "../src/zcode-protocol/server-operations.js";
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

function reconcileContext(state: FakeOrphanStore, liveChildSessionIds: readonly string[] = []) {
  const sessions = new Map<string, unknown>();
  for (const sessionId of liveChildSessionIds) {
    sessions.set(sessionId, {
      // 与真实 record 同形的最小面：清单读取会问事件与投影。恢复出的空投影正是「接管时刻
      // 本进程零在飞」的形态（registry/事件都是进程内内存态）。
      stateRevision: 0,
      eventStore: { getEvents: async () => [] },
      app: { runtime: { getProjection: async () => undefined } },
    });
  }
  return {
    deps: { sessionStore: fakeSessionStore(state) },
    sessions,
  } as unknown as ReconcileInput["context"];
}

/** 标准孤儿场景：父 transcript 有后台 spawn，child 记录在场、无终态、活动时间可控。 */
function orphanScenario(options: {
  background?: boolean;
  childActivityAt: number;
  childUpdatedAt?: number;
  liveInProcess?: boolean;
  childTaskType?: SessionTaskType;
  childOutcomeStatus?: "failed" | "cancelled";
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
      options.liveInProcess ? [PARENT_SESSION_ID, CHILD_SESSION_ID] : [],
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
  const [user, assistant] = parentMessages;
  state.messages.set(PARENT_SESSION_ID, [
    user,
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
