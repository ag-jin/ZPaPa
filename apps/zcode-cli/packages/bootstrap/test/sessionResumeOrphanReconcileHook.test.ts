// 孤儿收敛的唯一挂点：`activateSessionForResume` 尾部。
//
// 为什么这组用例承重：收敛判据与落盘形状已被 subagent-orphan-reconcile.test.ts 锁死，但**挂点本身**
// 曾零覆盖——把 `await reconcileSubagentOrphansOnActivation(...)` 从激活序列里删掉，全部用例照样绿，
// 于是「重启后接管会话时收敛」这条产品承诺没有任何测试守着。本文件在真实 `activateSessionForResume`
// 上驱动最小 fake context，钉住挂点的三条契约：
//
//   1) 未激活会话（冷恢复）走激活路径 ⇒ 接管尾部执行收敛（child 落盘 subagent_outcome{lost}）；
//   2) 已激活会话（`existing` 早退）⇒ 不触发收敛（幂等的来源：重复订阅不该重复收敛）;
//   3) 收敛失败（读 child 事实抛错）⇒ 只降级 warn，激活照常返回（N9：绝不拖垮激活）。
//
// fake 只覆盖激活序列真正会问的依赖面（事件存储 / app 工厂 / store / 反向请求 / 交互端口），
// 其余为 undefined——多出来的依赖会让「挂点到底碰了什么」变得不可见。收敛的 `now` 是真实时钟，
// 所以 child 活动时间取相对当前的三小时前（远大于 10 分钟宽容期）。

import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionId,
  type MessageWithParts,
  type SessionEntryInfo,
  type SessionId,
  type SessionInfo,
  type SessionStorePort,
} from "@zcode/contracts";
import { SESSION_ENTRY_SUBAGENT_OUTCOME } from "../src/zcode-protocol/subagent-session-query.js";
import {
  ProtocolRequestError,
  type ZCodeProtocolAgentServerContext,
} from "../src/zcode-protocol/server-types.js";
import { activateSessionForResume } from "../src/zcode-protocol/server-operations.js";

const PARENT_SESSION_ID = "sess_resume_hook_parent";
const AGENT_ID = "agent_resumehook-1111-4222-8333-444444444444";
const CHILD_SESSION_ID = String(createSessionId(`subagent_${AGENT_ID}`));
const TOOL_CALL_ID = "call_resume_hook_agent";
const HOUR = 60 * 60 * 1_000;
const RECENT = Date.now() - 3 * HOUR;

function backgroundLaunchAck(agentId: string): string {
  return [
    "Async agent launched successfully.",
    `agentId: ${agentId} (internal ID - do not mention to user. Use SendMessage with to: '${agentId}' to continue this agent.)`,
    "The agent is working in the background. You will be notified automatically when it completes.",
  ].join("\n");
}

function sessionInfo(input: { id: string; taskType: string; updated: number; parentID?: string }) {
  return {
    id: input.id as SessionId,
    projectID: "proj_resume_hook" as SessionInfo["projectID"],
    taskType: input.taskType,
    slug: "resume-hook",
    directory: "/tmp/resume-hook",
    title: "resume hook",
    version: "0.0.0-test",
    time: { created: input.updated - HOUR, updated: input.updated },
    ...(input.parentID ? { parentID: input.parentID as SessionId } : {}),
  } as SessionInfo;
}

/** 父 transcript：一条后台 Agent spawn（launch ACK part，与生产持久化同形）。 */
function parentMessages(): MessageWithParts[] {
  return [
    {
      info: {
        id: "msg_resume_hook_user",
        role: "user",
        time: { created: RECENT - HOUR },
        semantics: {
          origin: "real_user",
          kind: "user_prompt",
          uiVisibility: "visible",
          providerVisibility: "visible",
          transcriptVisibility: "visible",
        },
        anchor: { turnId: "turn_resume_hook", origin: "realUser" },
      },
      parts: [{ id: "part_resume_hook_user", type: "text", text: "启动后台 agent" }],
    },
    {
      info: {
        id: "msg_resume_hook_assistant",
        role: "assistant",
        parentID: "msg_resume_hook_user",
        time: { created: RECENT - HOUR + 500, completed: RECENT - HOUR + 5_000 },
        finish: "tool-calls",
      },
      parts: [
        {
          id: "part_resume_hook_agent",
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

/** child 的「还在跑」transcript（最后一条 assistant 带 tool part、无 completed/finish）。 */
function childMessages(): MessageWithParts[] {
  return [
    {
      info: {
        id: "msg_resume_hook_child_assistant",
        role: "assistant",
        parentID: "msg_resume_hook_child_user",
        time: { created: RECENT - HOUR },
        finish: "tool-calls",
      },
      parts: [
        {
          id: "part_resume_hook_child_tool",
          type: "tool",
          callID: "call_resume_hook_child_tool",
          tool: "Bash",
          state: {
            status: "running",
            input: { command: "sleep 600" },
            time: { start: RECENT - HOUR },
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
  saves: SessionEntryInfo[];
  failEntryReadFor?: string;
  warnings: string[];
}

function createState(): HarnessState {
  const state: HarnessState = {
    sessions: new Map(),
    messages: new Map(),
    entries: new Map(),
    saves: [],
    warnings: [],
  };
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
  return state;
}

function harnessStore(state: HarnessState): SessionStorePort {
  return {
    async getSession(sessionID: string) {
      return state.sessions.get(sessionID) ?? null;
    },
    async messages(input: { sessionID: string }) {
      return state.messages.get(input.sessionID) ?? [];
    },
    async sessionEntries(input: { sessionID: string; type?: string }) {
      if (state.failEntryReadFor === input.sessionID) throw new Error("store unavailable");
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
  } as unknown as SessionStorePort;
}

/** 激活序列会问到的 fake app 面：resume() 返回值 + runtime 的事件订阅/投影。 */
function fakeApp() {
  return {
    resume: async () => ({ modelSelection: undefined }),
    runtime: {
      getProjection: async () => undefined,
      subscribeEvents: () => () => {},
    },
  };
}

function createContext(
  state: HarnessState,
  options: { existingRecord?: unknown } = {},
): ZCodeProtocolAgentServerContext {
  const eventStore = {
    getEvents: async () => [],
    getLatestSequenceNumber: async () => 0,
  };
  const sessions = new Map<string, unknown>();
  if (options.existingRecord) sessions.set(PARENT_SESSION_ID, options.existingRecord);
  return {
    appRuntimePreferences: {},
    assertServing: () => {},
    deps: {
      createSessionEventStore: () => eventStore,
      createZCodeApp: async () => fakeApp(),
      sessionStore: harnessStore(state),
      version: "0.0.0-test",
    },
    logger: {
      debug: () => {},
      error: () => {},
      info: () => {},
      warn: (_message: string, fields?: { event?: string }) => {
        if (fields?.event) state.warnings.push(fields.event);
      },
    },
    // 冷恢复的启动偏好走反向请求；无 Host 的纯 CLI 路径按 -32601 回退默认值（生产同款）。
    requestClient: async () => {
      throw new ProtocolRequestError(-32601, "method not supported");
    },
    sessions,
    v4Interactions: { initializeAskUserQuestionAutoResolutionEnabled: () => {} },
  } as unknown as ZCodeProtocolAgentServerContext;
}

test("挂点：未激活会话走激活路径 ⇒ 接管尾部执行收敛（entry 落盘）", async () => {
  const state = createState();
  const context = createContext(state);

  const activated = await activateSessionForResume(context, { sessionId: PARENT_SESSION_ID });

  assert.equal(context.sessions.get(PARENT_SESSION_ID), activated.record, "激活后 record 必须入册");
  assert.equal(activated.knownSession?.id, PARENT_SESSION_ID);
  assert.equal(state.saves.length, 1, "接管尾部必须收敛孤儿：删掉那一行调用本用例必红");
  assert.equal(state.saves[0]?.sessionID, CHILD_SESSION_ID, "收敛事实落在 child 会话上");
  assert.equal(state.saves[0]?.type, SESSION_ENTRY_SUBAGENT_OUTCOME);
  const inventory = state.entries.get(CHILD_SESSION_ID);
  assert.equal(inventory?.length, 1, "entry 是可读的终态补洞事实（幂等键覆盖写）");
});

test("挂点：已激活会话（existing 早退）⇒ 不触发收敛（重复订阅不重复收敛）", async () => {
  // 负向对照：store 场景与上一条完全相同（同一份 transcript、同一个可收敛的孤儿），
  // 唯一差别是会话已在 context.sessions ⇒ 早退路径不许再碰收敛（否则每次订阅都会重写 entry）。
  const state = createState();
  const existingRecord = { marker: "already-active" };
  const context = createContext(state, { existingRecord });

  const activated = await activateSessionForResume(context, { sessionId: PARENT_SESSION_ID });

  assert.equal(activated.record, existingRecord, "早退必须原样返回既有 record");
  assert.deepEqual(state.saves, [], "已激活会话不得写收敛 entry");
});

test("挂点：收敛读面失败 ⇒ 只降级 warn，激活照常返回、不写 entry（N9）", async () => {
  const state = createState();
  state.failEntryReadFor = CHILD_SESSION_ID;
  const context = createContext(state);

  const activated = await activateSessionForResume(context, { sessionId: PARENT_SESSION_ID });

  assert.equal(context.sessions.get(PARENT_SESSION_ID), activated.record, "收敛失败不许拖垮激活");
  assert.deepEqual(state.saves, [], "读面失败 ⇒ 跳过该 child，不落 entry");
  assert.ok(
    state.warnings.includes("zcode_protocol.subagent.orphan_reconcile_failed"),
    "失败必须留下结构化 warn（静默吞掉就无从观测）",
  );
});
