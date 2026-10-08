// 后台 Agent 的冷恢复终态只能由 **child session 的持久记录** 裁决。
//
// 为什么这组用例承重：后台 Agent 的持久化工具 part 是 launch ACK（「Async agent launched
// successfully.」），它在**启动成功的那一刻**就写成 completed——它是「启动过」的证据，
// 不是「结束」的证据。旧 hydration 把该 part 的 state.status 直接当子 agent 终态，
// 于是「切走会话再切回」（冷恢复）时仍在跑的后台 agent 被收口成 success：
//   hydrate 合成 SubagentStopped → row.status=success → snapshot.subagents.running 由
//   「row.status === running」反推 → running=[]（面板/头像簇里活着的 agent 整体消失），
//   且 endedTotal 把它记成已结束。
//
// 反向误判同样有界：把 spawn 行永远留在 running 会复活 9c1e81c 修掉的「永久执行中幽灵」。
// 因此三件事必须同时成立：
//   ① child 无终态记录 ⇒ running（进程重启后内存 registry 缺失不是「已结束」的证据）；
//   ② child 有终态记录 ⇒ 按该终态收口（success/failed/cancelled 三词各有对应）；
//   ③ 后台 spawn 行必须带 backgrounded，否则冷恢复后历史轮会被这一行重新翻成 running。
//
// 判据来源与侧栏 `listSessionSubagents`/`projectSessionSubagents` 同一条：child session
// 的 transcript 才是终态事实。hydrate 不自己猜，只消费调用方注入的终态表；
// 调用方拿不到 child 记录时（浏览器回放桶等）保持修前的 part 推断，见下「降级」用例。

import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionEventType,
  createSessionId,
  type MessageWithParts,
  type SessionEntryInfo,
  type SessionEvent,
  type SessionId,
  type SessionInfo,
  type SessionTaskType,
} from "@zcode/contracts";
import { mergeColdConversationEvents } from "../src/zcode-protocol-v4/cold-event-merge.js";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import { readSessionSubagentInventory } from "../src/zcode-protocol/server-operations.js";
import { reconcileSubagentOrphansOnActivation } from "../src/zcode-protocol/subagent-orphan-reconcile.js";
import type {
  HydratedSubagentChildFacts,
  HydratedSubagentTerminalState,
} from "../src/zcode-protocol-v4/transcript-hydration.js";

const SESSION_ID = "sess_cold_hydration_subagent";
const AGENT_ID = "agent_11111111-2222-4333-8444-555555555555";
const CHILD_SESSION_ID = String(createSessionId(`subagent_${AGENT_ID}`));
const TURN_ID = "turn_cold_hydration_subagent";
const USER_MESSAGE_ID = "msg_cold_hydration_user";
const ASSISTANT_MESSAGE_ID = "msg_cold_hydration_assistant";
const TOOL_CALL_ID = "call_cold_hydration_agent";
const BASE_MS = 1_700_000_000_000;

/** 后台 Agent 的持久化 launch ACK：与 core 的 `formatAgentOutputForModel` 同形。 */
const BACKGROUND_LAUNCH_ACK = [
  "Async agent launched successfully.",
  `agentId: ${AGENT_ID} (internal ID - do not mention to user. Use SendMessage with to: '${AGENT_ID}' to continue this agent.)`,
  "The agent is working in the background. You will be notified automatically when it completes.",
].join("\n");

function userMessage(): MessageWithParts {
  return {
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
      anchor: { turnId: TURN_ID, origin: "realUser" },
    },
    parts: [{ id: "part_cold_hydration_user_text", type: "text", text: "启动后台 agent" }],
  } as unknown as MessageWithParts;
}

/**
 * 含一个 Agent 工具 part 的 assistant message。
 * 默认是**后台** agent 的 launch ACK part（run_in_background + completed），
 * `foreground` 时改用阻塞式结果输出，验证前台语义不被误改。
 */
function assistantMessage(options: { background: boolean }): MessageWithParts {
  const part = options.background
    ? {
        id: "part_cold_hydration_agent",
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
          output: BACKGROUND_LAUNCH_ACK,
          time: { start: BASE_MS + 1_000, end: BASE_MS + 1_100 },
        },
      }
    : {
        id: "part_cold_hydration_agent",
        type: "tool",
        callID: TOOL_CALL_ID,
        tool: "Agent",
        state: {
          status: "completed",
          input: { description: "前台 agent", prompt: "do work", subagent_type: "implementer" },
          output: `子 agent 结果\nagentId: ${AGENT_ID} (use SendMessage with to: '${AGENT_ID}' to continue this agent)`,
          time: { start: BASE_MS + 1_000, end: BASE_MS + 6_000 },
        },
      };
  return {
    info: {
      id: ASSISTANT_MESSAGE_ID,
      role: "assistant",
      parentID: USER_MESSAGE_ID,
      time: { created: BASE_MS + 500, completed: BASE_MS + 6_500 },
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
    parts: [part],
  } as unknown as MessageWithParts;
}

/**
 * child session 的持久事实（与 v4 bridge 从 `readSessionSubagentInventory` 注入的形状一致）：
 * 已落库的 child session 集合 + 已有终态记录的 child。
 */
function childFacts(input: {
  known: readonly string[];
  terminal?: ReadonlyMap<string, HydratedSubagentTerminalState>;
}): HydratedSubagentChildFacts {
  return {
    knownChildSessionIds: new Set(input.known),
    terminalStates: input.terminal ?? new Map(),
  };
}

/** 仍在跑：child 记录在场、没有终态记录。 */
function runningChildFacts(): HydratedSubagentChildFacts {
  return childFacts({ known: [CHILD_SESSION_ID] });
}

function endedChildFacts(
  status: HydratedSubagentTerminalState["status"],
): HydratedSubagentChildFacts {
  // 词表是侧栏查询的（success/failed/cancelled/lost），不是事件词表（completed/failed/cancelled）。
  return childFacts({
    known: [CHILD_SESSION_ID],
    terminal: new Map([[CHILD_SESSION_ID, { status }]]),
  });
}

interface HydratedSnapshot {
  events: SessionEvent[];
  snapshot: ReturnType<ProductProjection["getSnapshot"]>;
}

/** 走 app 冷恢复的同一三段管线：merge（transcript 合成）→ ProductProjection hydration 回放。 */
function hydrate(input: {
  background: boolean;
  subagentChildFacts?: HydratedSubagentChildFacts;
}): HydratedSnapshot {
  const merged = mergeColdConversationEvents({
    memoryEvents: [],
    messages: [userMessage(), assistantMessage({ background: input.background })],
    sessionId: SESSION_ID,
    ...(input.subagentChildFacts ? { subagentChildFacts: input.subagentChildFacts } : {}),
  });
  const projection = new ProductProjection(SESSION_ID, "epoch-cold-hydration-subagent");
  projection.beginHydrationReplay();
  for (const event of merged.events) projection.applyHydrationEvent(event);
  projection.completeHydrationReplay();
  return { events: merged.events, snapshot: projection.getSnapshot() };
}

function subagentRows(snapshot: HydratedSnapshot["snapshot"]) {
  return snapshot.rows.window.filter(
    (row): row is Extract<typeof row, { kind: "subagent" }> => row.kind === "subagent",
  );
}

function subagentLifecycleTypes(events: readonly SessionEvent[]): string[] {
  return events
    .filter(
      (event) =>
        event.type === SessionEventType.SubagentSpawned ||
        event.type === SessionEventType.SubagentStopped,
    )
    .map((event) => event.type);
}

test("投影幂等：同一份 transcript + 同一份 child 事实重放两次 ⇒ subagents 与行完全一致", () => {
  // 冷恢复可能连续发生（切走再切回、订阅重放）。两次 hydrate 必须落到同一个状态，
  // 否则第二次恢复会把第一次恢复出来的 running 行又收掉（或反过来重复补行）。
  for (const facts of [runningChildFacts(), endedChildFacts("success")]) {
    const first = hydrate({ background: true, subagentChildFacts: facts });
    const second = hydrate({ background: true, subagentChildFacts: facts });

    assert.deepEqual(
      second.snapshot.subagents,
      first.snapshot.subagents,
      "重复 hydrate 后 subagents 必须逐字段一致",
    );
    assert.deepEqual(subagentRows(second.snapshot), subagentRows(first.snapshot));
  }
});

test("后台 Agent 冷恢复：child 无终态记录（仍在跑）⇒ 必须恢复为 running", () => {
  const { events, snapshot } = hydrate({
    background: true,
    subagentChildFacts: runningChildFacts(),
  });
  const [row] = subagentRows(snapshot);

  assert.equal(
    row?.status,
    "running",
    `launch ACK 不是终态证据；事件=${JSON.stringify(subagentLifecycleTypes(events))}`,
  );
  assert.equal(
    subagentLifecycleTypes(events).includes(SessionEventType.SubagentStopped),
    false,
    "child 没有终态记录时不许合成 SubagentStopped",
  );
});

test("后台 Agent 冷恢复：running 行必须回到 snapshot.subagents（面板与头像簇的数据面）", () => {
  const { snapshot } = hydrate({ background: true, subagentChildFacts: runningChildFacts() });

  assert.equal(snapshot.subagents.running.length, 1, "在跑的后台 agent 从运行集里消失");
  assert.equal(snapshot.subagents.running[0]?.childSessionId, CHILD_SESSION_ID);
  assert.equal(snapshot.subagents.endedTotal, 0, "仍在跑的 agent 不能被记进 endedTotal");
});

test("后台 Agent 冷恢复：running 行必须带 backgrounded，否则历史轮被重新翻成 running", () => {
  const { snapshot } = hydrate({ background: true, subagentChildFacts: runningChildFacts() });
  const [row] = subagentRows(snapshot);

  // 渲染层用 backgrounded 把后台 subagent 行排除出「本轮仍在跑」判定
  // （conversationTurnRenderUnits.isCompletionBlockingWorkRowRunning）。
  assert.equal(
    row?.backgrounded,
    true,
    "后台 spawn 行缺 backgrounded 会把早已结束的轮翻成 running",
  );
});

test("后台 Agent 冷恢复：child 已 completed ⇒ 按 child 终态收口成 success", () => {
  const { events, snapshot } = hydrate({
    background: true,
    subagentChildFacts: endedChildFacts("success"),
  });
  const [row] = subagentRows(snapshot);

  assert.equal(row?.status, "success");
  assert.equal(snapshot.subagents.running.length, 0);
  assert.equal(snapshot.subagents.endedTotal, 1);
  assert.equal(subagentLifecycleTypes(events).at(-1), SessionEventType.SubagentStopped);
});

test("后台 Agent 冷恢复：child 已 failed ⇒ 收口成 failed（不能一律当 success）", () => {
  const { snapshot } = hydrate({
    background: true,
    subagentChildFacts: endedChildFacts("failed"),
  });
  const [row] = subagentRows(snapshot);

  assert.equal(row?.status, "failed", "child 的失败终态必须传下去");
  assert.equal(snapshot.subagents.running.length, 0);
});

test("后台 Agent 冷恢复：child 已 cancelled/stopped ⇒ 收口成 cancelled", () => {
  const { snapshot } = hydrate({
    background: true,
    subagentChildFacts: endedChildFacts("cancelled"),
  });
  const [row] = subagentRows(snapshot);

  assert.equal(row?.status, "cancelled");
  assert.equal(snapshot.subagents.running.length, 0);
});

test("降级：child 记录缺席（被裁剪/从未落库）⇒ 退回 part 推断，不制造永久 running", () => {
  // 判活与判终态的共同前提是「有持久 child 记录」；两个集合都没有它时，既没有存活证据
  // 也没有终态证据。此时不许凭空宣称存活（每条历史后台 Agent 都会永久停在 running），
  // 退回 transcript 自身证据——与修前同形，有界。
  const { snapshot } = hydrate({ background: true, subagentChildFacts: childFacts({ known: [] }) });
  const [row] = subagentRows(snapshot);

  assert.equal(row?.status, "success");
  assert.equal(snapshot.subagents.running.length, 0);
});

test("降级：调用方完全没有 child 数据源 ⇒ 保持修前的 part 推断", () => {
  // 浏览器回放桶（无 session store）走这一支：它读不到 child 记录，
  // 只能按 transcript 自身证据收口；要它按 child 裁决就必须注入 subagentChildFacts。
  const { snapshot } = hydrate({ background: true });
  const [row] = subagentRows(snapshot);

  assert.equal(row?.status, "success");
  assert.equal(snapshot.subagents.running.length, 0);
});

test("child 终态为 lost（不在运行但无 outcome）⇒ 有界收口，不留 running 幽灵", () => {
  const { snapshot } = hydrate({
    background: true,
    subagentChildFacts: endedChildFacts("lost"),
  });
  const [row] = subagentRows(snapshot);

  assert.equal(row?.status, "failed", "lost 在 row 词表无对应项，按 failed 收口");
  assert.equal(snapshot.subagents.running.length, 0);
});

test("前台 Agent（阻塞式）不受影响：part 终态即 child 终态，照旧收口", () => {
  const { events, snapshot } = hydrate({ background: false });
  const [row] = subagentRows(snapshot);

  assert.equal(row?.status, "success", "阻塞式 Agent 的 part 终态仍是 child 终态的证据");
  assert.equal(subagentLifecycleTypes(events).at(-1), SessionEventType.SubagentStopped);
});

// ── 孤儿收敛的集成形态：entry 经 inventory 注入 ⇒ 与既有 8 档同一收口路径 ─────────────
//
// 上面的用例手工构造 child 事实；这里改走真实读面（readSessionSubagentInventory）：
// 接管时收敛落盘 subagent_outcome{lost} → 同一次读把 child 放进 ended ⇒ facts 注入
// hydration ⇒ 与「child 有 lost 终态」完全同一档（row failed、running 空、endedTotal=1）。
// 这条链路是 48f7f18「同源单一结论」的延续：收敛不合成父事件，只补 child 的持久事实。

interface OrphanStoreState {
  sessions: Map<string, SessionInfo>;
  messages: Map<string, MessageWithParts[]>;
  entries: Map<string, SessionEntryInfo[]>;
  saves: SessionEntryInfo[];
}

/** child 的「还在跑」transcript：最后一条 assistant 带 tool part、没有 completed/finish。 */
function runningChildTranscript(activityAt: number): MessageWithParts[] {
  return [
    {
      info: {
        id: "msg_cold_hydration_child_assistant",
        role: "assistant",
        parentID: "msg_cold_hydration_child_user",
        time: { created: activityAt },
        finish: "tool-calls",
      },
      parts: [
        {
          id: "part_cold_hydration_child_tool",
          type: "tool",
          callID: "call_cold_hydration_child_tool",
          tool: "Bash",
          state: { status: "running", input: { command: "sleep 600" }, time: { start: activityAt } },
        },
      ],
    } as unknown as MessageWithParts,
  ];
}

function orphanSessionInfo(input: {
  id: string;
  taskType: SessionTaskType;
  parentID?: string;
  updated: number;
}): SessionInfo {
  return {
    id: input.id as SessionId,
    projectID: "proj_cold_hydration" as SessionInfo["projectID"],
    taskType: input.taskType,
    slug: "cold-hydration",
    directory: "/tmp/cold-hydration",
    title: "cold hydration",
    version: "0.0.0-test",
    time: { created: input.updated - 3_600_000, updated: input.updated },
    ...(input.parentID ? { parentID: input.parentID as SessionId } : {}),
  };
}

/** 接管时刻的会话状态：父 transcript 有后台 spawn，child 记录在场、无终态。 */
function createOrphanStoreState(childActivityAt: number): OrphanStoreState {
  const state: OrphanStoreState = {
    sessions: new Map(),
    messages: new Map(),
    entries: new Map(),
    saves: [],
  };
  state.sessions.set(
    SESSION_ID,
    orphanSessionInfo({ id: SESSION_ID, taskType: "interactive", updated: BASE_MS }),
  );
  state.messages.set(SESSION_ID, [userMessage(), assistantMessage({ background: true })]);
  state.sessions.set(
    CHILD_SESSION_ID,
    orphanSessionInfo({
      id: CHILD_SESSION_ID,
      taskType: "subagent_child",
      parentID: SESSION_ID,
      updated: childActivityAt,
    }),
  );
  state.messages.set(CHILD_SESSION_ID, runningChildTranscript(childActivityAt));
  return state;
}

/** 激活后的窄面 context（parent live record 只提供清单读取会问的事件/投影面）。 */
function orphanContext(state: OrphanStoreState) {
  return {
    deps: {
      sessionStore: {
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
          state.saves.push(entry);
          const key = String(entry.sessionID);
          state.entries.set(key, [
            ...(state.entries.get(key) ?? []).filter((item) => item.id !== entry.id),
            entry,
          ]);
        },
      },
    },
    sessions: new Map([
      [
        SESSION_ID,
        {
          stateRevision: 0,
          eventStore: { getEvents: async () => [] },
          app: { runtime: { getProjection: async () => undefined } },
        },
      ],
    ]),
  } as unknown as Parameters<typeof readSessionSubagentInventory>[0];
}

/** 与 v4 bridge 同形的 facts 构造：known 取自 childSessionIds，终态取自 ended。 */
function factsFromInventory(
  inventory: Awaited<ReturnType<typeof readSessionSubagentInventory>>,
): HydratedSubagentChildFacts {
  return {
    knownChildSessionIds: new Set(inventory.childSessionIds),
    terminalStates: new Map(
      inventory.ended.map((item) => [item.childSessionId, { status: item.status }]),
    ),
  };
}

test("集成：孤儿经接管收敛落盘 ⇒ row failed、running=[]、endedTotal=1，且重放幂等", async () => {
  const state = createOrphanStoreState(BASE_MS + 60_000);
  const context = orphanContext(state);
  const now = BASE_MS + 3 * 3_600_000;

  const reconciled = await reconcileSubagentOrphansOnActivation({
    context,
    sessionId: SESSION_ID,
    now,
  });
  assert.equal(reconciled.reconciled, 1, "孤儿必须被收敛（判据 J1-J5 全部成立）");
  assert.equal(state.saves.length, 1);
  assert.equal(state.saves[0]?.sessionID, CHILD_SESSION_ID);

  const inventory = await readSessionSubagentInventory(context, SESSION_ID);
  assert.deepEqual(inventory.running, [], "收敛后 running 行必须为空（常驻卡片消失）");
  assert.deepEqual(
    inventory.ended.map((item) => ({ childSessionId: item.childSessionId, status: item.status })),
    [{ childSessionId: CHILD_SESSION_ID, status: "lost" }],
  );

  const facts = factsFromInventory(inventory);
  const first = hydrate({ background: true, subagentChildFacts: facts });
  const [row] = subagentRows(first.snapshot);
  assert.equal(row?.status, "failed", "lost 在 row 词表无对应项，按 failed 收口");
  assert.equal(first.snapshot.subagents.running.length, 0);
  assert.equal(first.snapshot.subagents.endedTotal, 1);

  // 幂等：同一份 transcript + 同一份 entry 重放两次，subagents 与行逐字段一致；
  // 再跑一次收敛也不会产生第二条 entry（同 key upsert）。
  const second = hydrate({ background: true, subagentChildFacts: factsFromInventory(inventory) });
  assert.deepEqual(second.snapshot.subagents, first.snapshot.subagents);
  assert.deepEqual(subagentRows(second.snapshot), subagentRows(first.snapshot));
  const reconciledAgain = await reconcileSubagentOrphansOnActivation({
    context,
    sessionId: SESSION_ID,
    now: now + 3_600_000,
  });
  assert.equal(reconciledAgain.reconciled, 0, "已收敛的孤儿不再是候选");
  assert.equal(state.saves.length, 1, "entry 只增不改：同 key 覆盖，不累积");
});

test("回放桶护栏：store 里有收敛 entry，但调用方读不到 child 事实 ⇒ 保持 part 推断", async () => {
  // 浏览器回放桶没有 session store，读不到 child 记录也就没有 facts 注入。收敛机制只在
  // 「读面注入的终态事实」这一条路上生效，不许从旁路改写这条有界降级（现有 297 行语义）。
  const state = createOrphanStoreState(BASE_MS + 60_000);
  await reconcileSubagentOrphansOnActivation({
    context: orphanContext(state),
    sessionId: SESSION_ID,
    now: BASE_MS + 3 * 3_600_000,
  });
  assert.equal(state.saves.length, 1, "先确认 entry 真的落盘了");

  const { snapshot } = hydrate({ background: true });
  const [row] = subagentRows(snapshot);

  assert.equal(row?.status, "success", "没有 child 终态事实时退回 part 推断（与修前同形）");
  assert.equal(snapshot.subagents.running.length, 0);
});
