import { selectActiveConversationBranch } from "@zcode/contracts";
import type {
  MessageWithParts,
  SessionEntryInfo,
  SessionId,
  SessionInfo,
  SessionStorePort,
  ToolPart,
} from "@zcode/contracts";
import { backgroundResultOriginMetaOfMessage } from "../zcode-protocol-v4/transcript-hydration.js";
import type { HydratedReconciledBackgroundTask } from "../zcode-protocol-v4/transcript-hydration.js";

/**
 * 后台 Bash 工作的持久事实读面（background task session query）。
 *
 * 为什么需要它：`subagent_outcome`（子 agent 孤儿收敛）与 dwf 的 journal 收敛都有「持久终态
 * 事实 + 接管时收敛」两层，后台 Bash 两层都没有——面板的 `backgroundWorks` 只由进程内事件
 * （`BackgroundTaskStarted/Updated/Completed`）喂出，进程一死就只剩 transcript 里那条
 * **launch ACK**（「Command running in background with ID: …」），而它在任务刚启动那一刻就写成
 * completed：运行中还是早已结束，transcript 本身分不出来（真实库里 651 条后台 Bash part 全部是
 * 这种 ACK）。没有持久终态事实，就没有任何读面能让「只活在内存里的 running」自愈。
 *
 * 本模块把 bash work 的两个持久端点接起来（与 `subagent-session-query.ts` 对 child session
 * 的角色同构）：
 *   - **候选**：Bash tool part 的 launch ACK（`with ID: <taskId>` 或 JSON `backgroundTaskId`）
 *     ⇒ workId ≡ taskId ≡ 面板的 workId；ACK 的落库时间就是启动时刻与宽容期基准；
 *   - **终态证据**：①同一 workId 的后台结果唤醒轮（`originMeta.backgroundSource === "bash"`，
 *     模型收到通知 ⇒ 任务已终结，消息持久化在 transcript）②`background_task_outcome`
 *     session entry（孤儿收敛写下的补洞事实）。
 *
 * 与子 agent 同一条纪律：终态永远以持久记录为准，entry 只填洞；读不到（无 store）就退场，
 * 不猜、不制造第二份结论。
 */

/**
 * 孤儿收敛 entry 的 session_entry 类型：bash work 的「不在运行但无终态」补洞事实。
 * 唯一写方是 `background-task-orphan-reconcile.ts`（接管会话时），读面在本模块——
 * 与 `SESSION_ENTRY_SUBAGENT_OUTCOME` 同款（写 child 改为写**父会话自己**：bash work 没有
 * 自己的 child 会话，工作身份由父 transcript 的 launch ACK 承载）。
 */
export const SESSION_ENTRY_BACKGROUND_TASK_OUTCOME = "background_task_outcome" as const;

/** launch ACK 里的 workId（core 三个模板共用 `with ID: <id>.` 的写法，id 不含点/空白）。 */
const BACKGROUND_LAUNCH_ACK_ID_PATTERN = /with ID:\s*([^\s.]+)/;

/**
 * work 的终态事实（持久来源 + 落盘时刻）。`notification` 是真实终局（模型收到结果），
 * `outcome_entry` 是收敛补洞（「不在运行但无 outcome」）。
 */
export interface BackgroundTaskTerminalFact {
  source: "notification" | "outcome_entry";
  /** 终局落库时刻：通知轮的 message 时间 / entry 的 reconciledAt。读不到时省略。 */
  endedAtMs?: number;
}

/** 一个后台 Bash work 的持久事实（候选枚举的产物）。 */
export interface BackgroundTaskWorkFact {
  workId: string;
  toolCallId: string;
  title: string;
  command?: string;
  /** launch ACK 的落库时间（part 的 time.start；读不到回 part 的 end）。宽容期基准。 */
  launchedAtMs?: number;
  /** 同 workId 的持久终态证据；缺席即「无终态」。 */
  terminal?: BackgroundTaskTerminalFact;
  /** 本进程 runtime 投影里的状态（内存事实，仅用于「本进程认领」判据，不作终态权威）。 */
  liveStatus?: "running" | "terminal";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function finiteTimeMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Bash tool part 的输出 → workId。
 *
 * 两种持久形态都认：模型可见的 ACK 文本（`formatBackgroundInfoForModel` 的三个模板共用
 * 「with ID: <id>.」）与结构化 JSON（`backgroundTaskId`）。**只认带 id 的 part**：
 * 拿不到 workId 就没有可寻址的工作身份，后续判据（终态对账、幂等键）全部无处落点。
 */
export function backgroundWorkIdFromToolPart(part: ToolPart): string | undefined {
  if (part.tool !== "Bash") return undefined;
  const output = part.state.status === "completed" ? part.state.output : undefined;
  if (typeof output !== "string" || output.length === 0) return undefined;
  const structured = parseJsonObject(output);
  const structuredId = nonEmptyString(structured?.backgroundTaskId);
  if (structuredId) return structuredId;
  return nonEmptyString(BACKGROUND_LAUNCH_ACK_ID_PATTERN.exec(output)?.[1]);
}

function toolPartIntervalMs(part: ToolPart, which: "start" | "end"): number | undefined {
  if (!("time" in part.state)) return undefined;
  if (which === "start") return finiteTimeMs(part.state.time.start);
  return "end" in part.state.time ? finiteTimeMs(part.state.time.end) : undefined;
}

/**
 * 一条消息是否携带「后台 Bash work 结果」的持久元数据（model-only 唤醒轮的 originMeta）。
 *
 * 解释器复用 hydration 的 {@link backgroundResultOriginMetaOfMessage}（唯一解释者）；
 * 这里只需 bash 的 workId 对账，所以只取 identity 两项。
 */
function backgroundResultWorkIdOfMessage(message: MessageWithParts): string | undefined {
  const originMeta = backgroundResultOriginMetaOfMessage(message);
  if (originMeta?.backgroundSource !== "bash") return undefined;
  const workId = originMeta.workId.trim();
  return workId.length > 0 ? workId : undefined;
}

/**
 * work 的最后持久活动（毫秒）：ACK 的启动时间与消息时间的较大者。
 *
 * 对 bash 而言 transcript 在启动后不再增长（输出写文件、不进 transcript），所以这个时间是
 * **启动时刻**而不是「心跳」——宽容期因此只能回答「启动了多久」，不能证明进程还活着；
 * 活着的证据由「本进程 registry 认领」（{@link BackgroundTaskWorkFact.liveStatus}）承担。
 */
function workLastActivityAtMs(fact: {
  launchedAtMs?: number;
  messageCreatedAtMs?: number;
}): number | undefined {
  const candidates = [fact.launchedAtMs, fact.messageCreatedAtMs].filter(
    (value): value is number => value !== undefined,
  );
  return candidates.length === 0 ? undefined : Math.max(...candidates);
}

/**
 * 从父 transcript 枚举后台 Bash work 的持久事实（候选 + 终态 + 启动时间）。
 *
 * 只看当前分支（rewind 掉的分支上的 launch 不再被引用，与子 agent 候选枚举同款：
 * `selectActiveConversationBranch` + 按 workId 去重，后写覆盖）。同一 workId 出现多次
 * （重试/重复落库）时保留最后一条的 title/时间——workId 是幂等身份，展示字段取最新。
 */
export function collectBackgroundTaskWorkFacts(
  session: SessionInfo,
  messages: readonly MessageWithParts[],
): BackgroundTaskWorkFact[] {
  const active = selectActiveConversationBranch(messages, {
    branchCutAfterMessageId: session.revert?.branchCutAfterMessageID,
    rewindCreatedMessageId: session.revert?.createdMessageID,
    rewindKeptMessageIds: session.revert?.keptMessageIDs,
    rewindTargetMessageId: session.revert?.targetMessageID,
  });
  const facts = new Map<string, BackgroundTaskWorkFact>();
  const terminalByWorkId = new Map<string, BackgroundTaskTerminalFact>();
  for (const message of active) {
    const resultWorkId = backgroundResultWorkIdOfMessage(message);
    if (resultWorkId) {
      terminalByWorkId.set(resultWorkId, {
        source: "notification",
        endedAtMs: finiteTimeMs(message.info.time.created),
      });
    }
    for (const part of message.parts) {
      if (part.type !== "tool") continue;
      const workId = backgroundWorkIdFromToolPart(part);
      if (!workId) continue;
      const input = asRecord(part.state.input);
      const launchedAtMs =
        toolPartIntervalMs(part, "start") ??
        toolPartIntervalMs(part, "end") ??
        workLastActivityAtMs({ messageCreatedAtMs: finiteTimeMs(message.info.time.created) });
      const command = nonEmptyString(input.command);
      facts.set(workId, {
        workId,
        toolCallId: part.callID,
        title: nonEmptyString(input.description) ?? command ?? workId,
        ...(command ? { command } : {}),
        ...(launchedAtMs === undefined ? {} : { launchedAtMs }),
      });
    }
  }
  return [...facts.values()].map((fact) => {
    const terminal = terminalByWorkId.get(fact.workId);
    return terminal ? { ...fact, terminal } : fact;
  });
}

/**
 * 收敛 entry 的事实（`background_task_outcome`，唯一写方 `background-task-orphan-reconcile.ts`）。
 * 与子 agent 的 `subagentOutcomeEntryFact` 同款：只认 `status: "lost"`，未知形状一律当不可用
 * （不因未知 entry 让读面变形）；`reconciledAt` 是事实字段，解析不出就不给值。
 */
export function backgroundTaskOutcomeEntryFact(
  entries: readonly SessionEntryInfo[] | undefined,
): BackgroundTaskTerminalFact | undefined {
  for (const entry of entries ?? []) {
    const data = asRecord(entry.data);
    if (nonEmptyString(data.status) !== "lost") continue;
    const reconciledAt = nonEmptyString(data.reconciledAt);
    const reconciledAtMs = reconciledAt ? Date.parse(reconciledAt) : Number.NaN;
    return {
      source: "outcome_entry",
      ...(Number.isFinite(reconciledAtMs) ? { endedAtMs: reconciledAtMs } : {}),
    };
  }
  return undefined;
}

/**
 * 权威清单读取的依赖窄面（与子 agent 的 `SessionSubagentInventoryReadContext` 同形）。
 */
export interface BackgroundTaskInventoryReadContext {
  deps: { sessionStore?: SessionStorePort };
  sessions: ReadonlyMap<string, { app: { runtime: { getProjection(): Promise<unknown> } } }>;
  logger?: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

export interface SessionBackgroundTaskInventory {
  revision: number;
  works: BackgroundTaskWorkFact[];
}

function liveStatusByWorkId(projection: unknown): Map<string, "running" | "terminal"> {
  const record = asRecord(projection);
  const tasks = Array.isArray(record.backgroundTasks) ? record.backgroundTasks : [];
  const byWorkId = new Map<string, "running" | "terminal">();
  for (const task of tasks) {
    const entry = asRecord(task);
    const taskId = nonEmptyString(entry.taskId);
    if (!taskId) continue;
    byWorkId.set(taskId, entry.status === "running" ? "running" : "terminal");
  }
  return byWorkId;
}

/**
 * 后台 Bash work 的权威清单：transcript 的持久端点（launch ACK / 结果唤醒轮）+ 收敛 entry
 * + 本进程 runtime 投影的认领状态。与子 agent 清单同款，激活路径与 hydration 共用**同一次读**，
 * 避免各读一次造出第二份结论。
 */
export async function readSessionBackgroundTaskInventory(
  context: BackgroundTaskInventoryReadContext,
  sessionId: string,
  persistedMessages?: MessageWithParts[],
  operation = "session_background_tasks",
): Promise<SessionBackgroundTaskInventory> {
  const store = context.deps.sessionStore;
  if (!store) {
    return { revision: 0, works: [] };
  }
  const parentSession = await store.getSession(sessionId as SessionId);
  if (!parentSession) {
    // 诊断（对齐子 agent 清单的同一字段）：hydrate 预期跑在 record 已激活的会话上；
    // 读不到父记录时留现场，调用方（收敛/hydrate）各自决定降级——收敛退场、hydrate 照常。
    context.logger?.warn("ZCode Protocol session background tasks has no persisted parent", {
      event: "zcode_protocol.session.persisted_missing",
      module: "bootstrap.zcode_protocol",
      operation,
      sessionId,
    });
    return { revision: 0, works: [] };
  }
  const messages = persistedMessages ?? (await store.messages({ sessionID: parentSession.id }));
  const works = collectBackgroundTaskWorkFacts(parentSession, messages);
  if (works.length === 0) {
    return { revision: parentSession.time.updated, works };
  }
  const outcomeFacts = new Map<string, BackgroundTaskTerminalFact>();
  const entries = await store.sessionEntries?.({
    sessionID: parentSession.id,
    type: SESSION_ENTRY_BACKGROUND_TASK_OUTCOME,
  });
  for (const entry of entries ?? []) {
    const workId = nonEmptyString(asRecord(entry.data).workId) ?? entry.id.split(":").at(-1);
    if (!workId) continue;
    const fact = backgroundTaskOutcomeEntryFact([entry]);
    if (fact) outcomeFacts.set(workId, fact);
  }
  const liveParent = context.sessions.get(sessionId);
  let liveStatus = new Map<string, "running" | "terminal">();
  if (liveParent) {
    try {
      liveStatus = liveStatusByWorkId(await liveParent.app.runtime.getProjection());
    } catch {
      liveStatus = new Map();
    }
  }
  return {
    revision: parentSession.time.updated,
    works: works.map((work) => {
      // 终态优先级与子 agent 同款：真实通知（持久终局）> 收敛 entry（补洞）；
      // 内存投影只作认领/活状态信号，绝不覆盖持久终态。
      const terminal =
        work.terminal?.source === "notification" ? work.terminal : outcomeFacts.get(work.workId);
      const status = liveStatus.get(work.workId);
      return {
        ...work,
        ...(terminal ? { terminal } : {}),
        ...(status ? { liveStatus: status } : {}),
      };
    }),
  };
}

/**
 * 已收敛 work → hydration 收口事实（**唯一映射**：v4-bridge 与测试共用）。
 *
 * 只带 `outcome_entry` 来源的终态：通知终局是真实结果（模型已收到），内存事件里本来就有它的
 * 终态事件，再合成一条只会造出「补洞盖真实终局」的裂缝。`endedAtMs` 取 entry 的 reconciledAt
 * （0ecb862 定案的收敛行时间），`startedAtMs` 取 launch ACK 的持久时间（真实时间戳纪律）。
 */
export function reconciledBackgroundTaskHydrationFacts(
  inventory: SessionBackgroundTaskInventory,
): HydratedReconciledBackgroundTask[] {
  return inventory.works
    .filter((work) => work.terminal?.source === "outcome_entry")
    .map((work) => ({
      workId: work.workId,
      toolCallId: work.toolCallId,
      title: work.title,
      ...(work.command ? { command: work.command } : {}),
      ...(work.launchedAtMs === undefined ? {} : { startedAtMs: work.launchedAtMs }),
      ...(work.terminal?.endedAtMs === undefined ? {} : { endedAtMs: work.terminal.endedAtMs }),
    }));
}
