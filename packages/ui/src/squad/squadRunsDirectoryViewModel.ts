import type { AgentColor, AppSettings } from "@zcode/shared";
import type { SquadSnapshot } from "@zcode/services";
import { resolveSubagentColorFromName } from "@/lib/subagentColors.js";
import { resolveTeamAgentName, squadRunStatusMessageId } from "./squadEntryViewModel.js";
import { squadEntryVisible } from "./squadEntryVisibility.js";

/* 会话「智能体目录」侧栏里「小队运行（本项目）」分区的**纯逻辑**（不 import React、
   不 import UI 原语 —— 照 squadEntryViewModel / squadSurfaceViewModel 的既定做法）：
   行投影与整段显隐都是判断，而 ui 包没有渲染测试设施，留在组件里就等于不可测。

   行的**来源**：`snapshot.runs` = 服务层 `listActive` 的口径（未合并的活跃 run：
   open / produced / rejected），也是「工作项页 · 待收尾的运行」用的同一份数据。
   本分区只是把同一批 run 投影成目录行（身份 + 角色 + 状态 + 会话穿透），**不新开取数口径**。 */

/** 行角色徽标：队长 / 队员（spec §11.1 C11「用小队徽标区分是不是队员」的落点）。
    用**文案 id** 而不是布尔：视图照抄渲染即可，判据只在本文件一处出现（可被 node:test 钉住）。 */
export const SQUAD_RUN_ROLE_MESSAGE_IDS = {
  leader: "squad.runs.leader",
  member: "squad.runs.member",
} as const;

export type SquadRunDirectoryRow = {
  /** React key 与行锚点（`data-run-id`）。 */
  runId: string;
  /** 显示名：`resolveTeamAgentName`（查不到回落 agentId）。 */
  agentName: string;
  /** 身份色（九色板只表达身份，不编码状态 —— spec §11.3）；视图映射到 `SUBAGENT_COLOR_CLASS`。 */
  color: AgentColor;
  /** 角色徽标文案 id（队长 / 队员）。 */
  roleMessageId: (typeof SQUAD_RUN_ROLE_MESSAGE_IDS)[keyof typeof SQUAD_RUN_ROLE_MESSAGE_IDS];
  /** 运行状态文案 id（复用 `squad.runs.status.*`，`squadRunStatusMessageId`）。 */
  statusMessageId: string;
  /** 分支；没有分支（队长 run）回落 runId —— 与 SquadRunsReview 同一口径。 */
  branchLabel: string;
  /** **可否打开会话的唯一判据**：台账里真有 sessionId 才有可打开的东西（同 SquadRunsReview）。 */
  sessionId: string | null;
};

/**
 * 快照 → 目录行。顺序 = **快照给定顺序**（服务层 `listActive` 的
 * `ORDER BY created_at ASC, run_id ASC`，确定性排序），本函数**不重排**：
 * 重排会让行在每次刷新时跳位；两条同 agent 的运行是两次独立 run，**不合并**。
 */
export function squadRunDirectoryRows(snapshot: SquadSnapshot): SquadRunDirectoryRow[] {
  return snapshot.runs.map((run) => {
    const agent = snapshot.teamAgents.find((candidate) => candidate.id === run.agentId);
    // 查不到名册条目也照常成行：名字回落 id、色按名字稳定取 —— 目录是**运行历史的窗口**，
    // agent 定义被删/归档不该让历史上的运行从目录里消失。
    const agentName = resolveTeamAgentName(snapshot, run.agentId);
    return {
      runId: run.runId,
      agentName,
      // 定义里设了色就用它；没设（或定义不在名册）按名字稳定取一个（与 SquadAgentsList 同款式子）。
      color: agent?.color ?? resolveSubagentColorFromName(agentName),
      roleMessageId: run.isLeaderTask
        ? SQUAD_RUN_ROLE_MESSAGE_IDS.leader
        : SQUAD_RUN_ROLE_MESSAGE_IDS.member,
      statusMessageId: squadRunStatusMessageId(run.status),
      branchLabel: run.branch ?? run.runId,
      sessionId: run.sessionId,
    };
  });
}

/**
 * 整段「小队运行（本项目）」渲不渲染（呈现判据，**不是门禁**）：
 *
 * ① **远端会话（`remoteSessionId` 非空）⇒ false**。这是**投射边界**（spec §16 S9「投射端不出现
 *    小队界面」），不是「服务显示不可用」：投射端连本机的小队运行时服务都没有（renderer 的
 *    远端 accessor 有意不映射它，见 client/remoteServiceAccess.ts 的不可枚举定义），
 *    挂一个必然读不到任何东西的分区只会让投射端用户以为"这个功能坏了"。本机 workspace 是另一回事。
 * ② 实验开关关闭 ⇒ false：复用既有呈现判据 `squadEntryVisible`（settings 加载中给 null ⇒ 不可见，
 *    与侧栏一级入口同一份语义、同一份实现），不另造一份判据。
 */
export function squadDirectorySectionVisible(input: {
  remoteSessionId?: string;
  settings: Pick<AppSettings, "experimentalAgentSquadsEnabled"> | null | undefined;
}): boolean {
  if (input.remoteSessionId?.trim()) return false;
  return squadEntryVisible(input.settings);
}
