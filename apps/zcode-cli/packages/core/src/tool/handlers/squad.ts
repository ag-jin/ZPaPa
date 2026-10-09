// ============================================================
// Squad Tool Handlers - 队长派单（建子工作项 / 派给队员）
// ============================================================
//
// 为什么存在：闭环里「队长被唤醒后**自己**派单」不能由操作员代劳——队长若不能建子项 / 派给队员，
// 后面「队员各开工作树 → 审查 → 合并 → 抛弃」根本不会发生（spec §16 S1）。
//
// **与既有工具的边界（spec §14 要求写在工具文档里）**：
// - `Agent` / `Task`：在当前对话内起一个**临时**子代理，产物回到本会话；
//   `SquadAssignWorkItem` 派的是**独立会话 + 独立工作树**的长期队友，走派发事件而非本会话子上下文。
// - `SendMessage`：向当前会话内的子代理发消息，**不改**任何工作项事实。
// - `CronCreate`：管「无工作项的定时任务」（spec §5.6）；挂在**工作项**上的触发属唤醒规则。
//
// **不变式（P0/P1 裁定）**：这两个工具**只**建子项 / 发派发事件，**绝不**直接写工作项 `status`。
// 唯一写者是服务侧的 `workItemService.transition`（spec §4.3 / §5.1）。本文件的 `SquadPort` 用法
// 里没有任何状态写入方法——见 `@zcode/contracts` 的 `squad.port.ts`。
//
// 门禁纪律（确认 2）：工具**不读** `experimentalAgentSquadsEnabled`。判据只有服务层一处；
// 关闭时服务层抛 `SquadDispatchDisabledError`（稳定码 `squad_dispatch_disabled`），本层把它
// **原样**带给模型——不吞、不改写、不自己再判一遍（自己判就有了第二份判据）。
//
// 留白：spec §14 的「汇报」「请求审查」两个工具留 P2c。

import {
  CoreErrorType,
  SquadAssignWorkItemInputJsonSchema,
  SquadAssignWorkItemInputSchema,
  SquadAssignWorkItemOutputJsonSchema,
  SquadAssignWorkItemOutputSchema,
  SquadCreateChildWorkItemInputJsonSchema,
  SquadCreateChildWorkItemInputSchema,
  SquadCreateChildWorkItemOutputJsonSchema,
  SquadCreateChildWorkItemOutputSchema,
  createCoreError,
  type SquadAssignWorkItemInput,
  type SquadAssignWorkItemOutput,
  type SquadCreateChildWorkItemInput,
  type SquadCreateChildWorkItemOutput,
  type SquadPort,
  type SquadRoster,
  type ToolPermissionSpec,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext } from "../types.js";

const SQUAD_TOOL_TIMEOUT_MS = 30_000;
const SQUAD_MODEL_BYTES = 32_000;

export const SQUAD_CREATE_CHILD_WORK_ITEM_TOOL_NAME = "SquadCreateChildWorkItem";
export const SQUAD_ASSIGN_WORK_ITEM_TOOL_NAME = "SquadAssignWorkItem";

/** 两个工具名的**唯一来源**：注册门、可见性门与「不与既有工具重名」的断言都读它。 */
export const squadToolNames = [
  SQUAD_CREATE_CHILD_WORK_ITEM_TOOL_NAME,
  SQUAD_ASSIGN_WORK_ITEM_TOOL_NAME,
] as const;

export type SquadToolName = (typeof squadToolNames)[number];

export interface SquadTools {
  createChildWorkItem: ToolEntry;
  assignWorkItem: ToolEntry;
}

/**
 * 取端口：执行器上下文优先，其次工厂闭包（测试与注册时用）。
 *
 * 缺 port **响亮抛**（照 cron.ts 的 `assertAutomationPort`）：静默 no-op 会让队长以为
 * 「派单成功了」，而队员永远不会被唤醒——这是本模块最不能接受的失败形态。
 * 文案里同时点名端口与错误类型，便于模型与日志一眼定位「工具面没装好」而非「派单被拒」。
 */
function resolveSquadPort(
  context: ToolExecutionContext,
  fallbackPort: SquadPort | undefined,
  toolName: SquadToolName,
  toolCallId: string | undefined,
): SquadPort {
  const port = context.squadPort ?? fallbackPort;
  if (port) return port;
  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `ConfigurationError: SquadPort is not configured for ${toolName}`,
    {
      context: { toolCallId, toolName },
      recoverable: false,
    },
  );
}

/**
 * 花名册校验：队长与队员都是合法受派人，花名册外的一律**响亮拒绝**。
 *
 * 为什么不静默放行：放行会让工作项挂在一个永远不会被唤醒的队员上——派发事件发出去了、
 * 状态看着也正常，但没有人会做这件事。这类「看起来没问题」的形态必须变成可见错误。
 */
function assertAssigneeInRoster(roster: SquadRoster, agentId: string): void {
  const allowed = new Set<string>([roster.leaderAgentId, ...roster.members.map((m) => m.agentId)]);
  if (allowed.has(agentId)) return;
  throw createCoreError(
    CoreErrorType.InvalidInput,
    `Agent ${agentId} is not in the squad roster (花名册); refusing to assign the work item to a member that will never be dispatched.`,
    {
      context: { agentId, roster: [...allowed] },
      recoverable: true,
      retryable: false,
    },
  );
}

function squadPermission(permission: string, reason: string): ToolPermissionSpec {
  return {
    permission,
    reason,
    riskLevel: "medium",
    sideEffectScope: "workspace",
    // **不设人工审批**：本任务的存在理由就是「队长自主派单」，每次拆解都弹一次确认会把闭环卡死。
    // 真正的边界是两层——① 实验开关在服务层单点（关闭即拒），② 唯一写者不在这条通路上。
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  };
}

const squadResultBudget = {
  maxInlineBytes: SQUAD_MODEL_BYTES,
  maxModelBytes: SQUAD_MODEL_BYTES,
  strategy: "truncate" as const,
  preview: {
    maxBytes: SQUAD_MODEL_BYTES,
    direction: "head" as const,
  },
};

const squadTimeout = {
  defaultMs: SQUAD_TOOL_TIMEOUT_MS,
  maxMs: SQUAD_TOOL_TIMEOUT_MS,
  allowCallOverride: false,
};

/**
 * 造出两个工具。`squadPort` 可选：注册路径把端口交给执行器（`context.squadPort`），
 * 测试与无执行器的调用方走闭包。
 */
export function createSquadTools(deps: { squadPort?: SquadPort }): SquadTools {
  const createChildWorkItemHandler: ToolEntry["handler"] = async (input, context) => {
    const parsed = SquadCreateChildWorkItemInputSchema.parse(input) as SquadCreateChildWorkItemInput;
    const port = resolveSquadPort(
      context,
      deps.squadPort,
      SQUAD_CREATE_CHILD_WORK_ITEM_TOOL_NAME,
      context.toolCallId,
    );
    // 协议错误（含服务层的 SquadDispatchDisabledError → squad_dispatch_disabled）原样上抛：
    // 工具的职责是转发队长的意图，把服务层的裁决抄一遍只会多出第二份判据。
    const result = await port.createChildWorkItem(parsed);
    return { workItemId: result.workItemId } satisfies SquadCreateChildWorkItemOutput;
  };

  const assignWorkItemHandler: ToolEntry["handler"] = async (input, context) => {
    const parsed = SquadAssignWorkItemInputSchema.parse(input) as SquadAssignWorkItemInput;
    const port = resolveSquadPort(
      context,
      deps.squadPort,
      SQUAD_ASSIGN_WORK_ITEM_TOOL_NAME,
      context.toolCallId,
    );
    // 先读花名册再派：读失败原样上抛（未知 ≠ 合法），花名册外的队员响亮拒绝。
    const roster = await port.listRoster();
    assertAssigneeInRoster(roster, parsed.agentId);
    const result = await port.assignWorkItem({
      workItemId: parsed.workItemId,
      agentId: parsed.agentId,
    });
    return { dispatched: result.dispatched } satisfies SquadAssignWorkItemOutput;
  };

  return {
    createChildWorkItem: {
      capability: "Create a child work item under an existing work item and assign it to a member",
      metadata: {
        name: SQUAD_CREATE_CHILD_WORK_ITEM_TOOL_NAME,
        description:
          "Create a child work item under an existing work item in the current workspace and assign it to one team agent of the squad. This emits a dispatch event only; work-item lifecycle status is owned by the work item service and is never written by this tool.",
        modelInstructions: [
          "Use this only while acting as the squad leader, to break an assigned work item into pieces.",
          "Always pass the parent work item id you were given; a child without its parent would float outside the work item tree.",
          "Give every child a title that states the outcome the member must produce, and put constraints and verification expectations in body.",
          "assigneeAgentId must be a member from the squad roster; the leader itself is also a valid assignee.",
          "This tool creates a child and emits a dispatch event. It does not change any work item status; the work item service advances status when the conditions are met.",
          "Do not use Agent/Task for this: those start a temporary helper inside the current conversation, not a teammate with its own session and worktree.",
          "If a call fails with squad_dispatch_disabled, the experimental feature is switched off: stop dispatching and tell the user instead of retrying.",
        ],
        readOnly: false,
        destructive: false,
        concurrentSafe: false,
        timeoutMs: SQUAD_TOOL_TIMEOUT_MS,
        maxOutputBytes: SQUAD_MODEL_BYTES,
        sideEffectScope: "workspace",
        riskLevel: "medium",
        needsApproval: false,
      },
      handler: createChildWorkItemHandler,
      inputSchema: SquadCreateChildWorkItemInputJsonSchema,
      outputSchema: SquadCreateChildWorkItemOutputJsonSchema,
      runtimeInputSchema: SquadCreateChildWorkItemInputSchema,
      runtimeOutputSchema: SquadCreateChildWorkItemOutputSchema,
      permission: squadPermission(
        "squad.createChildWorkItem",
        "SquadCreateChildWorkItem creates a child work item in this workspace and emits a dispatch event for one squad member",
      ),
      resultBudget: squadResultBudget,
      timeout: squadTimeout,
      cancellation: {
        supported: true,
        cleanup: "none",
        userVisibleMessage:
          "SquadCreateChildWorkItem was cancelled before the child work item was created",
      },
      trace: {
        required: true,
        propagateToAdapters: true,
        recordInput: "summary",
        recordOutput: "summary",
      },
    },
    assignWorkItem: {
      capability: "Assign a work item to one member of the squad by emitting a dispatch event",
      metadata: {
        name: SQUAD_ASSIGN_WORK_ITEM_TOOL_NAME,
        description:
          "Assign an existing work item (or child work item) to one team agent of the squad. This emits the same dispatch event shape the user's own assignment uses; it never writes work-item status.",
        modelInstructions: [
          "Use this only while acting as the squad leader, to hand a work item or child work item to a member.",
          "agentId must be a member from the squad roster; the leader itself is also a valid assignee. An id outside the roster fails loudly rather than hanging the item on a member that will never run.",
          "Pass the work item id returned when the child was created — do not invent ids.",
          "Assigning emits a dispatch event, exactly like a user assignment. It does not set work item status, and re-assigning the same item is merged by the work item service rather than queued twice.",
          "Do not use SendMessage for this: SendMessage talks to the current conversation and changes no work item fact.",
          "If a call fails with squad_dispatch_disabled, the experimental feature is switched off: stop dispatching and tell the user instead of retrying.",
        ],
        readOnly: false,
        destructive: false,
        concurrentSafe: false,
        timeoutMs: SQUAD_TOOL_TIMEOUT_MS,
        maxOutputBytes: SQUAD_MODEL_BYTES,
        sideEffectScope: "workspace",
        riskLevel: "medium",
        needsApproval: false,
      },
      handler: assignWorkItemHandler,
      inputSchema: SquadAssignWorkItemInputJsonSchema,
      outputSchema: SquadAssignWorkItemOutputJsonSchema,
      runtimeInputSchema: SquadAssignWorkItemInputSchema,
      runtimeOutputSchema: SquadAssignWorkItemOutputSchema,
      permission: squadPermission(
        "squad.assignWorkItem",
        "SquadAssignWorkItem assigns a work item to one squad member and emits a dispatch event",
      ),
      resultBudget: squadResultBudget,
      timeout: squadTimeout,
      cancellation: {
        supported: true,
        cleanup: "none",
        userVisibleMessage: "SquadAssignWorkItem was cancelled before the assignment was dispatched",
      },
      trace: {
        required: true,
        propagateToAdapters: true,
        recordInput: "summary",
        recordOutput: "summary",
      },
    },
  };
}

/** 注册用的静态条目：端口由执行器上下文提供（照 CronCreate / OffPeakCreate 的同款分工）。 */
const staticSquadTools = createSquadTools({});

export const squadCreateChildWorkItemToolEntry: ToolEntry =
  staticSquadTools.createChildWorkItem;
export const squadAssignWorkItemToolEntry: ToolEntry = staticSquadTools.assignWorkItem;
