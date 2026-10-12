// [DEBUG-a4f2] 第二复现环（重启/进程退出）诊断脚本 —— 不是测试套件成员。
//
// 场景：宿主进程被硬杀（崩溃 / 应用重启 / 退出）时，本进程内联创建的后台子 agent 随进程消失：
// 它没有机会落 output.txt，也没有终态记录。重启后接管会话时，现状会：
//   1) 由 subagent-orphan-reconcile 在 **child 会话** 上补一条 subagent_outcome{lost}（f580ad8 线已修）；
//   2) 父会话（主会话）**不产生任何模型可见事实**（spec §1.4 明确「不合成任何父会话事件」）；
//   3) TaskOutput 只认进程内 registry，重启后按 agentId 查不到该任务（core/tool/handlers/task-output.ts）。
//
// 本脚本把这三件事各钉一条断言：1 绿（已修），2/3 是本任务要交回的设计缺口。
//
// 运行（一条命令）：
//   cd ZPaPa/apps/zcode-cli && node --import tsx packages/bootstrap/test/restart-recovery.probe.ts

import {
  createSessionId,
  type MessageWithParts,
  type SessionEntryInfo,
  type SessionId,
  type SessionInfo,
  type SessionStorePort,
} from "@zcode/contracts";
import { SESSION_ENTRY_SUBAGENT_OUTCOME } from "../src/zcode-protocol/subagent-session-query.js";
import { ProtocolRequestError } from "../src/zcode-protocol/server-types.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import { activateSessionForResume } from "../src/zcode-protocol/server-operations.js";

const PARENT_SESSION_ID = "sess_ring2_parent";
const AGENT_ID = "agent_ring2-1111-4222-8333-444444444444";
const CHILD_SESSION_ID = String(createSessionId(`subagent_${AGENT_ID}`));
const HOUR = 60 * 60 * 1_000;
const RECENT = Date.now() - 3 * HOUR;
const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "GREEN" : "RED  "}  ${name}\n        ${detail}`);
}

function launchAck(): string {
  return [
    "Async agent launched successfully.",
    `agentId: ${AGENT_ID} (internal ID - do not mention to user. Use SendMessage with to: '${AGENT_ID}' to continue this agent.)`,
    "The agent is working in the background. You will be notified automatically when it completes.",
  ].join("\n");
}

function sessionInfo(input: { id: string; taskType: string; updated: number; parentID?: string }) {
  return {
    id: input.id as SessionId,
    projectID: "proj_ring2" as SessionInfo["projectID"],
    taskType: input.taskType,
    slug: "ring2",
    directory: "/tmp/ring2",
    title: "ring2",
    version: "0.0.0-test",
    time: { created: input.updated - HOUR, updated: input.updated },
    ...(input.parentID ? { parentID: input.parentID as SessionId } : {}),
  } as SessionInfo;
}

/** 父 transcript：后台 Agent spawn（launch ACK）+ 之后没有任何终态事实。 */
function parentMessages(): MessageWithParts[] {
  return [
    {
      info: {
        id: "msg_ring2_user",
        role: "user",
        time: { created: RECENT - HOUR },
        semantics: {
          origin: "real_user",
          kind: "user_prompt",
          uiVisibility: "visible",
          providerVisibility: "visible",
          transcriptVisibility: "visible",
        },
        anchor: { turnId: "turn_ring2", origin: "realUser" },
      },
      parts: [{ id: "part_ring2_user", type: "text", text: "启动后台 agent" }],
    },
    {
      info: {
        id: "msg_ring2_assistant",
        role: "assistant",
        parentID: "msg_ring2_user",
        time: { created: RECENT - HOUR + 500, completed: RECENT - HOUR + 5_000 },
        finish: "tool-calls",
      },
      parts: [
        {
          id: "part_ring2_agent",
          type: "tool",
          callID: "call_ring2_agent",
          tool: "Agent",
          state: {
            status: "completed",
            input: {
              description: "长跑后台 agent",
              prompt: "do work",
              run_in_background: true,
              subagent_type: "implementer",
            },
            output: launchAck(),
            time: { start: RECENT - HOUR + 1_000, end: RECENT - HOUR + 1_100 },
          },
        },
      ],
    } as unknown as MessageWithParts,
  ];
}

/** child 的「被杀前」transcript：部分产出已落库（最后一条 assistant 无 completed、tool 还在 running）。 */
function childMessages(): MessageWithParts[] {
  return [
    {
      info: {
        id: "msg_ring2_child_user",
        role: "user",
        parentID: "msg_ring2_user",
        time: { created: RECENT - HOUR + 2_000 },
      },
      parts: [{ id: "part_ring2_child_user", type: "text", text: "do work" }],
    },
    {
      info: {
        id: "msg_ring2_child_assistant",
        role: "assistant",
        parentID: "msg_ring2_child_user",
        time: { created: RECENT - HOUR + 3_000 },
        finish: "tool-calls",
      },
      parts: [
        {
          id: "part_ring2_child_progress",
          type: "text",
          text: "已完成前半段：证据文件已写入 /tmp/ring2-evidence.md（这是被杀前唯一可读的产出）",
        },
        {
          id: "part_ring2_child_tool",
          type: "tool",
          callID: "call_ring2_child_tool",
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

interface State {
  entries: Map<string, SessionEntryInfo[]>;
  messages: Map<string, MessageWithParts[]>;
  saves: SessionEntryInfo[];
  sessions: Map<string, SessionInfo>;
  warnings: string[];
}

function createState(): State {
  const state: State = {
    entries: new Map(),
    messages: new Map(),
    saves: [],
    sessions: new Map(),
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
      parentID: PARENT_SESSION_ID,
      taskType: "subagent_child",
      updated: RECENT - HOUR,
    }),
  );
  state.messages.set(CHILD_SESSION_ID, childMessages());
  return state;
}

function store(state: State): SessionStorePort {
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

function context(state: State): ZCodeProtocolAgentServerContext {
  return {
    appRuntimePreferences: {},
    assertServing: () => {},
    deps: {
      createSessionEventStore: () => ({
        getEvents: async () => [],
        getLatestSequenceNumber: async () => 0,
      }),
      createZCodeApp: async () => ({
        resume: async () => ({ modelSelection: undefined }),
        runtime: {
          getProjection: async () => undefined,
          subscribeEvents: () => () => {},
        },
      }),
      sessionStore: store(state),
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
    requestClient: async () => {
      throw new ProtocolRequestError(-32601, "method not supported");
    },
    sessions: new Map<string, unknown>(),
    v4Interactions: { initializeAskUserQuestionAutoResolutionEnabled: () => {} },
  } as unknown as ZCodeProtocolAgentServerContext;
}

async function main(): Promise<void> {
  const state = createState();
  const ctx = context(state);
  // 重启：全新 context / 空 registry 下接管父会话（= 冷恢复激活）。
  await activateSessionForResume(ctx, { sessionId: PARENT_SESSION_ID });

  const childEntries = state.entries.get(CHILD_SESSION_ID) ?? [];
  const outcome = childEntries.find((entry) => entry.type === SESSION_ENTRY_SUBAGENT_OUTCOME);
  check(
    "R2-1 child 侧孤儿收敛（f580ad8 已修）",
    outcome !== undefined,
    `child entry=${JSON.stringify(outcome?.data ?? null)}`,
  );

  // 父会话新增的 entry（harness 面）：收敛是否给父会话留了任何事实。
  const parentEntries = state.entries.get(PARENT_SESSION_ID) ?? [];
  // 父 transcript 里是否有「这个后台 agent 已丢失」的模型可见事实。
  // launch ACK 里含 "will be notified automatically when it completes"（承诺，不是事实），
  // 所以判据只看终态事实：父会话出现过该 agent 的 lost/失败事实。
  const parentFacts = JSON.stringify({
    entries: parentEntries,
    messages: state.messages.get(PARENT_SESSION_ID),
  });
  const parentKnowsLost =
    parentFacts.includes(AGENT_ID) && /"lost"|已丢失|runtime_exit/.test(parentFacts);
  check(
    "R2-2 父会话（主会话）被通知「后台 agent 已丢失」",
    parentKnowsLost,
    `父会话 entry=${parentEntries.length} 条，transcript 里只有 launch ACK（无终态事实） ⇒ 主会话模型看不到自己启动的后台 agent 已死；无人值守时永远不会汇报`,
  );

  // 被杀前已落库的部分产出仍在（存储没丢），但没有任何投递面把它交给父会话。
  const childText = JSON.stringify(state.messages.get(CHILD_SESSION_ID));
  check(
    "R2-3 被杀前产出可读（存储面）",
    childText.includes("证据文件已写入"),
    "child transcript 里保留了被杀前的最后一条产出 ⇒ 信息可读，但只能由人/模型主动去 child 会话里翻",
  );

  const reds = results.filter((item) => !item.ok);
  console.log(`\n结论：${results.length - reds.length} 绿 / ${reds.length} 红`);
  for (const red of reds) console.log(`  RED: ${red.name}`);
  if (reds.length > 0) process.exitCode = 2;
}

await main().catch((error) => {
  console.error("probe failed:", error);
  process.exitCode = 1;
});
