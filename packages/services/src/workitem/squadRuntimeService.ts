/* oxlint-disable eslint(max-lines) -- 小队服务面：ISquadRuntimeService 是冻结接口的聚合入口
   （门禁/快照/台账/花名册/收件箱/队列读取都从这一处出），拆分会在描述符与协议两侧各留一份影子。 */
import {
  isTerminalWorkItemStatus,
  resolveWorkspaceKey,
  type Squad,
  type TeamAgent,
  type WakeRule,
  type WorkItem,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { CreateSquadInput, SquadRosterPatch } from "../teams/squadService.js";
import type { CreateTeamAgentInput, TeamAgentEditablePatch } from "../teams/teamAgentService.js";
import type { ReapOutcome } from "../worktree/orphanReaper.js";
import type { InboxItem, InboxItemInput, InboxItemRepo } from "./inboxItemRepo.js";
import type { SquadBatchOrchestrator, SquadRuntime } from "./squadContracts.js";
import type {
  LeaderRunRecordOutcome,
  LeaderRunRequest,
  MemberRunRequest,
  OpenMemberRunResult,
  ReviewOutcome,
} from "./squadRunLifecycle.js";
import type { SquadRunRecord } from "./squadRunRepo.js";
// 「改负责人 + 发派发事件」的**唯一实现**（唯一写者纪律 / 同值处置 / 事件出口全在其中）。
// 单拆成文件是为了浏览器安全（本文件被根入口值导出）+ 400 行 lint 门槛，详见该文件的头部注释。
import { applyWorkItemAssignee } from "./workItemAssignee.js";
// 唤醒规则六项（list / create / pause / resume / update / delete）的唯一实现（组装 / 校验 / 排期 /
// CAS 全在其中）。同款拆文件：本文件必须浏览器安全 + 贴着 400 行门槛；门禁口径与「用户暂停」的
// 落库口径见该文件头注释。
import {
  createWakeRuleOps,
  type CreateWakeRuleRequest,
  type UpdateWakeRuleInput,
} from "./squadWakeRules.js";

/* 小队运行时的**服务面**：UI / host / 工具三处都只经这个描述符取数或触发派发。

   **本文件必须保持浏览器安全**：`packages/services/src/index.ts` 用**值**导入导出它
   （描述符要在 renderer 侧可达），而根入口的运行时依赖一旦触达 `node:*`，整包会在 React 挂载前失败
   （现场是「页面停在启动壳、没有报错浮层」，见 browserSafeRootEntry.test.ts）。
   所以这里对 node 侧模块只用 `import type`，实现函数 `createSquadRuntimeService` 的依赖
   （建 runtime 的工厂、读设置、归档转交）全部由**调用方注入**（node.ts）。
   这与既有约定一致：描述符可从根入口取，实现从 `@zcode/services/node` 取。 */

export type SquadWorkspaceTarget = { path: string; identity: string };

export type SquadSnapshot = {
  /** **只读呈现用**（UI 据此隐藏 / 禁用入口）——**它不是门禁**；门禁是下面的 assertDispatchEnabled。 */
  enabled: boolean;
  teamAgents: TeamAgent[];
  squads: Squad[];
  workItems: WorkItem[];
  /** 只列**未合并**的 run（`SquadRunRepo.listActive` 的口径）：最小视图关心的是「还欠收尾的那些」。 */
  runs: SquadRunRecord[];
};

export type CreateWorkItemRequest = {
  title: string;
  body?: string;
  parentId?: string;
  assignee: WorkItem["assignee"];
};

/** 稳定错误码：跨 RPC 传到上层后按码分流（照 AUTOMATION_BOUND_SESSION_BUSY_ERROR_CODE 的做法）。 */
export const SQUAD_DISPATCH_DISABLED_CODE = "squad_dispatch_disabled";

/** 队长派单「指派」的入参（**加法**，2026-10-02 裁定 Important-1）。 */
export type AssignWorkItemRequest = { workItemId: string; agentId: string };

/** 启动重驱的结论（Important-2）：重驱了哪些父项、哪些失败（失败项要由调用方**响亮**记日志）。 */
export type BatchReplayOutcome = {
  replayed: string[];
  failures: Array<{ parentWorkItemId: string; error: unknown }>;
};

/**
 * 「响亮留痕」的注入形态（Minor-3）：本文件必须**浏览器安全**（`index.ts` 值导入导出它），
 * 不能 import node 侧的 logger，故日志能力由组合根注入（与 `readExperimentEnabled` 同一手法）。
 */
export type SquadRuntimeLogWarn = (message: string, error?: unknown) => void;

/**
 * 「本工作项是一支小队批次的**根**」的**唯一判据**（`packages/services/src/index.ts` 从**值**入口导出，
 * 故纯函数、浏览器安全）。
 *
 * 为什么它必须只有一处定义：这条判据有两个消费方 —— 启动重驱（`replayUnfinalizedBatches` 用它枚举
 * 「可能有未收尾批次的父项」，缺陷 1 的修法）与**最小视图的「放弃整批」入口**（UI 只在批次根上给出
 * 破坏性动作）。两处各写一份「什么是批次根」迟早漂移，而漂移**不报错** —— 表现会是「界面给的按钮
 * 服务层不接受」或反过来「某类批永远看不见入口」。
 *
 * 两条**并列**证据（命中任意一条即为批次根）：
 * (a) 台账里有以它为 `parentWorkItemId` 的 run 行 —— 有队员产出过的批；
 * (b) 本项被**指派给小队**（`assignee.type === "squad"`）—— 小队的批次根，且**空批没有任何 run 行**
 *     （例如唯一子项在派单前被取消）也覆盖得到。
 *
 * 为什么不能用「父项有子项」代替 (b)：这对一个**普通父项**同样为真 —— 那会把无关的父项也认成批次根
 * （重驱会跨过它自己的验收把它推到 `done`；UI 会给它一个会删分支的破坏性入口）。
 *
 * `runParentWorkItemIds` 由调用方从**自己的取数口**给出（服务侧是 `squadRunRepo.listByParent`，
 * UI 侧是快照的活跃 run 集合）：本函数不做 IO，也不去猜该查哪张表。
 */
export function isSquadBatchRoot(input: {
  workItem: Pick<WorkItem, "id" | "assignee">;
  runParentWorkItemIds: readonly string[];
}): boolean {
  return (
    input.workItem.assignee.type === "squad" ||
    input.runParentWorkItemIds.some((parentId) => parentId === input.workItem.id)
  );
}

export class SquadDispatchDisabledError extends Error {
  readonly code = SQUAD_DISPATCH_DISABLED_CODE;
  constructor() {
    super(`[${SQUAD_DISPATCH_DISABLED_CODE}] 实验功能已关闭：停止新派发（进行中的 run 不受影响）`);
    this.name = "SquadDispatchDisabledError";
  }
}

export interface ISquadRuntimeService {
  /**
   * **门禁的唯一判据**（spec §5.7.6 / §12 / §16 S8 S14）。
   *
   * 为什么判据必须落在**服务层单点**、而不是 host 的派发路径或 UI：门禁有**三个入口** ——
   * ① 规则 tick 自动派发、② 用户在最小界面手动触发、③ 队长的派单工具（Wave 1 D）。
   * 放 host 只盖住①；② 与 ③ 不走 host 的那条分支，各自再判就是**三份判据**，
   * 改一处漏一处 —— 那正是「关掉实验照旧派发」的形态（recon.md B4 的现状）。
   * 故判据只有这一处实现，三个入口都调它（① 由 host 在 dispatch 前调；②③ 因为要起新 run，
   * 在下面 createWorkItem / openMemberRun 的**入口**内部调**同一个** assertDispatchEnabled）。
   *
   * 语义（spec §5.7.6）：关闭 ⇒ **拒绝这一次新派发**（抛 SquadDispatchDisabledError）；
   * **不中断在途 run** —— 本方法只读设置、只抛错：不取消、不关会话、不改任何 `squad_runs` 行。
   */
  assertDispatchEnabled(target: SquadWorkspaceTarget): Promise<void>;
  /** UI 的唯一取数口（含只读的 `enabled` 供呈现用）。 */
  getSnapshot(target: SquadWorkspaceTarget): Promise<SquadSnapshot>;
  /**
   * **运行台账的历史读取面**（**加法**，规格 §11.2 活动时间线）：给了 `parentWorkItemId` ⇒
   * 该批的 run（`listByParent` 口径）；否则 ⇒ 本 workspace **全部** run（`listByWorkspace` 口径，
   * 含 merged / discarded 的终态行）。
   *
   * 为什么必须补它：`getSnapshot().runs` 是 `listActive` 的口径（只列未合并的活跃 run —— 快照
   * 关心「还欠收尾的那些」），而时间线要**历史**：已合并 / 已抛弃的 run 也是一次发生过的活动，
   * 只画活跃 run 会让每一次收尾都把图上的一段**静默抹掉**（用户看到的不是「历史」，是「还在跑的」）。
   * 两个口径的分工见 `SquadRunRepo.listByWorkspace` 的注释：**不得互相替代**。
   *
   * 三条纪律（与冻结面既有形态一致）：
   * 1. **只读**：只经 runtime 的 `squadRunRepo` 读，不写任何行、不碰 git。
   * 2. **不过门禁**（`assertDispatchEnabled`）：读历史不是新派发（§5.7.6 只停新派发），与
   *    `reviewMemberRun` / `listInboxItems` 同款理由 —— 关掉实验开关后，界面仍应能查看已经跑过什么
   *    （那正是收尾在途 run / 复盘所需的视野）。**本层不得写任何第二份开关判据**。
   * 3. **目标显式**：`target` 是**唯一权威**（没有隐式默认 workspace），workspaceKey 取自
   *    runtime 的**绑定值**（与 `getSnapshot` / `createWorkItem` 同一条式子 —— runtime 才是
   *    「为哪个 workspace 而构造」的权威）。过滤与排序都由 repo 单源给出，本层不重写 SQL、
   *    不读回后重排（第二份判据会与 repo 漂移，而漂移不报错）。
   */
  listSquadRuns(
    target: SquadWorkspaceTarget,
    input?: { parentWorkItemId?: string },
  ): Promise<SquadRunRecord[]>;
  createTeamAgent(target: SquadWorkspaceTarget, input: CreateTeamAgentInput): Promise<TeamAgent>;
  /**
   * 编辑协作智能体的**可编辑定义字段**（名字 / 系统提示词 / 记忆作用域），返回写盘后的实体
   * （**加法**，2026-10-03：名册的一级入口「智能体」要求编辑可用）。
   *
   * 三条纪律：
   * 1. **唯一写者**：只经注入的 `teamAgentService`（它内部 read-modify-write + 原子写盘）。
   *    调用方**不得**自己写 `<ws>/.zcode/squad/agents/<id>.json` —— 第二份写者迟早漂移，
   *    而漂移的表现是「界面看着改了、盘上没改」或反过来，两处都不报错。
   * 2. **目标显式**：`target` 是**唯一权威**（没有隐式默认 workspace），写进目标自己的
   *    `<ws>/.zcode/squad/agents`——与 `createTeamAgent` 同款（runtime 按目标现构、不缓存）。
   * 3. **不过门禁**：名册管理不产生新派发（§5.7.6 只停新派发），与 `failMemberRun` /
   *    `reviewMemberRun` 同款理由 —— 关掉实验开关后**不该连改名字都不让**（在途 run 的收尾、
   *    名册的整理都与派发无关）。**本层不得写任何第二份开关判据**；界面侧入口的显隐由
   *    `squadEntryVisible` 负责，那是呈现、不是门禁。
   */
  updateTeamAgent(
    target: SquadWorkspaceTarget,
    input: { id: string; patch: TeamAgentEditablePatch },
  ): Promise<TeamAgent>;
  /**
   * 启用 / 停用协作智能体（**加法**）。**不过门禁**：不产生新派发（与 `updateTeamAgent` 同理由）。
   * **唯一写者**：只经注入的 `teamAgentService.setEnabled`（它保留除 `enabled` 外的全部字段，
   * 含 `archivedAt` —— 停用不是归档，两者互不覆盖）。**目标显式**：同 `updateTeamAgent`。
   */
  setTeamAgentEnabled(
    target: SquadWorkspaceTarget,
    input: { id: string; enabled: boolean },
  ): Promise<void>;
  /**
   * 归档协作智能体（**加法**）：只写 `archivedAt`，定义与记忆都保留（不是硬删）。
   * **不过门禁**：不是「新派发」（与 `updateTeamAgent` 同理由；归档本身正是**减少**派发候选的动作）。
   * **唯一写者**：只经注入的 `teamAgentService.archive`。**目标显式**：同 `updateTeamAgent`。
   */
  archiveTeamAgent(target: SquadWorkspaceTarget, input: { id: string }): Promise<void>;
  createSquad(target: SquadWorkspaceTarget, input: CreateSquadInput): Promise<Squad>;
  /**
   * 编辑小队的**可改定义字段**（名字 / 队长 / 名册 / 指令槽位），返回写盘后的实体
   * （**加法**，2026-10-03：小队的一级入口「小队」要求编辑可用）。
   *
   * 三条纪律（与 `updateTeamAgent` 同款）：
   * 1. **唯一写者**：只经注入的 `squadService.updateRoster`（它内部 read-modify-write + 原子写盘，
   *    且逐字段显式构造 `next`——白名单是**运行期**的墙）。调用方**不得**自己写
   *    `<ws>/.zcode/squad/squads/<id>.json` —— 第二份写者迟早漂移，而漂移的表现是
   *    「界面看着改了、盘上没改」或反过来，两处都不报错。
   * 2. **目标显式**：`target` 是**唯一权威**（没有隐式默认 workspace），写进目标自己的
   *    `<ws>/.zcode/squad/squads`——与 `createSquad` 同款（runtime 按目标现构、不缓存）。
   * 3. **不过门禁**：名册管理不产生新派发（§5.7.6 只停新派发），与 `updateTeamAgent` 同款理由。
   *    **本层不得写任何第二份开关判据**；界面侧入口的显隐由 `squadEntryVisible` 负责（呈现，不是门禁）。
   *
   * 小队**归档**不在此处新增方法：归档要「先转交工作项、后归档」的组合语义，唯一实现在既有的
   * `archiveSquadAndTransfer`（UI 直接调它，见 `squadRuntime.ts` 的详注）。
   */
  updateSquad(
    target: SquadWorkspaceTarget,
    input: { id: string; patch: SquadRosterPatch },
  ): Promise<Squad>;
  /**
   * 启用 / 停用小队（**加法**）。**不过门禁**：不产生新派发（与 `updateSquad` 同理由）。
   * **唯一写者**：只经注入的 `squadService.update`（保留除 `enabled` 外的全部字段，含 `archivedAt`
   * —— 停用不是归档，两者互不覆盖；`update` 合并后会**重新校验**，非法定义被响亮拒绝——
   * 这是可接受的：本方法不做第二份校验，也不新开第三个写路径）。
   * **目标显式**：同 `updateSquad`。
   */
  setSquadEnabled(
    target: SquadWorkspaceTarget,
    input: { id: string; enabled: boolean },
  ): Promise<void>;
  /** 指派即入队 ⇒ **入口过门禁**（入口② 走这条）。 */
  createWorkItem(target: SquadWorkspaceTarget, input: CreateWorkItemRequest): Promise<WorkItem>;
  /**
   * 本 workspace 的唤醒规则（经工作项反查 —— `wake_rules` 表没有 workspace 列，见调度器注释）。
   *
   * **不过门禁**（只读不是新派发，§5.7.6 只停新派发）：关掉实验开关后仍应能查看有哪些规则
   * —— 那是收尾 / 复盘所需的视野（与 `listSquadRuns` / `listInboxItems` 同款理由）。
   * **本层不得写任何第二份开关判据。**
   *
   * 取数口径（实现见 `squadWakeRules.ts`，过滤判据只有那一处）：
   * 1. `wakeRuleRepo.listAll()` **全量**读出（repo 单源排序，本层不重排），
   * 2. 用本 workspace 的工作项 id 集合（`workItemRepo.listByWorkspace(key)`）过滤 ——
   *    `key` 取自 runtime 的**绑定值**（与 `getSnapshot` / `createWorkItem` 同一条式子：
   *    runtime 才是「为哪个 workspace 而构造」的权威）。
   * 3. **已归档工作项的规则列不出来**（有意登记）：`listByWorkspace` 的口径是「归档行视同不存在」
   *    （repo 既定口径，服务面没有列出归档工作项的取数口，`wake_rules` 也没有 workspace 列可反查）
   *    ⇒ 这类规则**无法归属到任何 workspace**。它们同时**不可派发**（host 对归档工作项一律
   *    解析不到 workspace ⇒ tick 响亮失败），属显式的坏配置而非静默消失；若界面确需展示，
   *    下一轮补一条「含归档的按 workspace 列工作项」的 repo 口再收录（本轮不加取数口、不加 SQL）。
   */
  listWakeRules(target: SquadWorkspaceTarget): Promise<WakeRule[]>;
  /**
   * 建一条唤醒规则（**加法**，P2b 第二半：「规则半边」此前**全仓没有任何创建路径** ——
   * `wakeRuleRepo.insert` 零生产调用方 ⇒ 没有 `next_fire_at` 的规则永远不会被调度器扫到）。
   *
   * **过门禁**（§5.7.6）：规则 = 未来派发的排班表，属「新派发」的准备 —— 与 `createWorkItem`
   * 同一处判据（`assertEnabled`），**次序也同款：门禁在构造 runtime 之前过**（门禁只回答
   * 「现在允不允许新派发」，与目标是不是可用的 git 仓库无关；先建 runtime 会在非 git 目标上
   * 把门禁结论换成「base 分支解析失败」，上层按稳定码分流就分不出来）。关掉开关后**响亮拒绝**。
   *
   * 实现要点（唯一实现在 `squadWakeRules.ts`，此处只把 runtime 工厂与门禁接进去）：
   * 1. 组装：`id` 新生成（`globalThis.crypto.randomUUID`）、`fireCount: 0`、`enabled: true`，
   *    排期字段按 kind 原样透传；`condition` / `eventTypes` / `filters` 类型上就没有入口（见
   *    `CreateWakeRuleRequest` 的形状决定）。
   * 2. `validateWakeRule` **优先**：不过 ⇒ 中文 problems **原样带出**（照 `assertValid` 的既有做法）。
   * 3. 宿主体检：工作项不存在 / 已归档 / 不属于目标 workspace ⇒ 响亮抛（挂不上的规则永不触发）。
   * 4. `nextFireAt = ` 与调度器**同一份**实现算出的首格（`every` 锚点 = 创建时刻 ⇒ 落在未来一个
   *    间隔内；`at` 必须严格晚于创建时刻；`cron` 取表达式在创建时刻之后的下一次命中）。
   *    **无未来命中 ⇒ 响亮抛**（「这条规则建成即永不触发」属死配置 —— 静默落盘正是本半要消灭的
   *    形态：listReady 只取 `next_fire_at <= now`，没有排期点的规则永远不触发且零报错）。
   * 5. `insert` 写盘后**读回**返回（照 `updateRoster` 的读回口径）。
   */
  createWakeRule(target: SquadWorkspaceTarget, input: CreateWakeRuleRequest): Promise<WakeRule>;
  /**
   * 暂停（不清除配置）：`nextFireAt` 置空（不再是到点扫描的候选）。**不过门禁**（停下不是新派发，
   * 与 `failMemberRun` 同款理由 —— 关掉开关后仍应能停掉一条规则）。
   *
   * **落库口径（有意偏离 brief 字面，逐条登记）**：`pausedReason` **不写下任何固定码** ——
   * 该列的读回是**封闭枚举**校验（`wakeRuleRepo.enumColumn`：枚举外值读回即抛，会让调度器
   * 整批扫描炸掉），集合只有 `max_fires | rate | loop` 三个**防失控闸**的码，没有「用户手动暂停」
   * 这一码（shared 本轮冻结）。写任何一个既有码都是**伪造闸原因**（界面会把用户暂停显示成
   * 「被 rate 闸停了」），故本实现只置空 `nextFireAt`（目标语义「不再到点 = 停下来了」完整成立），
   * `pausedReason` 原样保留（闸写下的原因不因用户再点一次 pause 而被抹掉）。
   * 下一轮若要区分「手动暂停」与「闸暂停」，需要给 shared 的 `WAKE_PAUSE_REASONS` 加一码。
   *
   * 前置读当时状态 + CAS（revision fencing，照既有纪律）：已不再到点的规则 ⇒ **幂等早退**
   * （不写盘、不 bump revision）；CAS 未命中（并发改动，如调度器刚推进一格）⇒ **响亮抛**。
   */
  pauseWakeRule(target: SquadWorkspaceTarget, input: { id: string }): Promise<void>;
  /**
   * 恢复：清 `pausedReason` 并**重算** `nextFireAt`（与 `createWakeRule` 同一份首格排期计算：
   * `every` 锚点 = 恢复时刻、`cron` 取之后下一次命中、`at` 取 `at` 本身并要求仍晚于恢复时刻）。
   * **过门禁**（恢复 = 让未来的派发重新可能，与 `createWakeRule` 同一处判据、同一次序）。
   *
   * 分格口径（写清）：已在排期的规则 ⇒ **幂等早退且不重算**（重算会静默挪动在跑规则的网格，
   * 比报错更坏）；重算后**无未来排期点**（如一次性的 `at` 已过点、或 cron 无未来命中）⇒
   * **响亮抛且不写盘**（死动作：恢复一条永不触发的规则会让用户以为它又开始跑了）。
   * CAS 未命中的处置同 `pauseWakeRule`（前置读当时状态、响亮抛）。
   */
  resumeWakeRule(target: SquadWorkspaceTarget, input: { id: string }): Promise<void>;
  /**
   * 编辑规则的**配置**（kind + 排期字段 + maxFires；挂载对象不可改）。**过门禁**（编辑让未来派发
   * 变样 —— 规则 = 未来派发的排班表；与 `createWakeRule` 同一处判据、同一次序：门禁在构造
   * runtime 之前过）。**revision +1**（§5.7 fencing：过期 revision 的进行中派发靠它自动作废）；
   * `enabled` / `pausedReason` / `fireCount` 原样保留（编辑不改开关与闸态）。
   *
   * 实现要点（唯一实现在 `squadWakeRules.ts`，复用**同一份**组装与首格排期）：
   * 1. 读现行（不存在 ⇒ 响亮抛）；2. 以 patch 调 `assembleWakeRule` 造新配置实体（旧 kind 的
   * 排期字段不带入 ⇒ 切换即清；**不含** `workItemId` / `timezone` / `expiresAt`，形状见
   * `UpdateWakeRuleRequest`）；3. 抄回 `fireCount` / `enabled` / `pausedReason`；
   * 4. `validateWakeRule` 不过 ⇒ 中文 problems 原样带出；5. 在跑的规则重算 `nextFireAt`
   * （无未来排期点 ⇒ 响亮抛且不写盘）；暂停中（用户暂停 / 闸暂停）编辑 ⇒ 排期保持空；
   * 6. `casUpdateConfig` 写盘，CAS 未命中 ⇒ 响亮抛；读回返回。
   */
  updateWakeRule(target: SquadWorkspaceTarget, input: UpdateWakeRuleInput): Promise<WakeRule>;
  /**
   * 删除规则。**不过门禁**（删掉 = 未来派发**减少**，与 `pauseWakeRule` 同款理由；关掉实验开关后
   * 也要能清配置）。
   *
   * 规则是**配置**（一张挂在工作项上的排班表），删除是它的正常生命周期终点；但**已触发的记录
   * （`fire_count`）随行一起消失、不可撤销** —— 这一点由 UI 的二次确认文案向用户交代
   * （`squad.rules.deleteConfirmDescription`），服务面只保证「恰命中一行才算成功」：
   * 不存在 / 未命中（并发被删）都**响亮抛**，绝不静默 no-op（那会让界面以为删掉了而列表里还在）。
   */
  deleteWakeRule(target: SquadWorkspaceTarget, input: { id: string }): Promise<void>;
  /**
   * 编辑工作项的**内容字段**（标题 / 正文），返回写盘后的实体（**加法**，2026-10-03：
   * 工作项看板要求编辑可用）。
   *
   * 三条纪律（与 `updateTeamAgent` / `updateSquad` 同款）：
   * 1. **唯一写者**：`status` 仍只经 `workItemService.transition`（本条不碰它）；内容经 repo 的
   *    专用写入口 `workItemRepo.updateContent`（同样是「恰命中一行才算成功」的条件更新）——
   *    调用方**不得**自己碰 repo，更不得写裸 SQL：第二份写者迟早漂移，而漂移的表现是
   *    「界面看着改了、库里没改」或反过来，两处都不报错。
   * 2. **目标显式**：`target` 是**唯一权威**（没有隐式默认 workspace），runtime 按目标现构、
   *    不缓存 —— 与 `createWorkItem` 同款。
   * 3. **不过门禁**：改标题 / 正文**不产生新派发**（§5.7.6 只停新派发），与 `updateTeamAgent`
   *    同款理由 —— 关掉实验开关后不该连改个字都不让。**本层不得写任何第二份开关判据**；
   *    界面侧入口的显隐由 `squadEntryVisible` 负责（呈现，不是门禁）。
   *
   * **未命中 / 空 patch ⇒ 响亮抛**（照 `assignWorkItem` 的既有口径）：未命中 = id 算错或该行
   * 已被归档，空 patch = 调用方没给任何要改的字段 —— 静默 no-op 会让界面以为改成功了，
   * 而库里仍是旧标题。写盘后读回返回；读回为空（理论不可达：刚刚命中过同一条件）也响亮抛，
   * 不返回 undefined 让调用方在下一层才炸。
   */
  updateWorkItem(
    target: SquadWorkspaceTarget,
    input: { id: string; patch: { title?: string; body?: string } },
  ): Promise<WorkItem>;
  /** C4b：排队行读取口（推进扫描/快照计数共用；ORDER_BY_CREATED）。 */
  listQueuedSquadRuns(target: SquadWorkspaceTarget): Promise<SquadRunRecord[]>;
  /** C4b：deferred 重放义务读取口（推进扫描用；资格判定在推进侧，这里只给事实）。 */
  listSquadDeferredObligations(
    target: SquadWorkspaceTarget,
  ): Promise<import("./squadDeferredDispatchRepo.js").SquadDeferredDispatchRecord[]>;
  /** 起新 run ⇒ **入口过门禁**（入口① 的队员段与入口③ 都汇到这里）。 */
  openMemberRun(
    target: SquadWorkspaceTarget,
    input: MemberRunRequest,
  ): Promise<OpenMemberRunResult>;
  /**
   * 登记一次**队长 run**（**加法**，P2b 余项）：**只登记，不执行** —— 不开工作树、不改工作项状态。
   *
   * 缺口与后果：此前 `ISquadRuntimeService` 上没有队长 run 的写入口，而 `openMemberRun` 传
   * `isLeaderTask: true` 会**照样开树**（那是给队员用的）⇒ 队长 run **完全不进台账**。后果是
   * spec §5.7(1)「队长 run **进行中**时的重复指派合并为同一次」**没有判据**（无记录 ⇒ 无从判
   * 「进行中」），且 `getSnapshot().runs` 永远看不见队长 run。
   *
   * 三条纪律（与冻结面既有形态一致）：
   * 1. **唯一写者不变**：实现只经 `runtime.lifecycle.recordLeaderRun`（其内部只调
   *    `squadRunRepo.insert`），调用方不得自己 INSERT（那会成为台账的第二个写者）。
   * 2. **不越权**：不建工作树（队长在目标工作区执行，spec §6.1/§6.2）、不写工作项 `status`
   *    （§5.7(2) 队长 run 不改父项状态）—— 见 `SquadRunLifecycle.recordLeaderRun`。
   * 3. **不过门禁**：本方法**只登记一次已经通过门禁、即将发出的 run**，自身不开始任何派发。
   *    门禁的唯一判据仍是 `assertDispatchEnabled`（这里不新增第二处判据）。此处**不**再判一次
   *    也是**有意的**：切换开关与登记之间若恰好翻转，再判一次会把一条**已经在跑**的 run 挡在
   *    台账外（「在跑但无记录」比「多一行记录」更坏 —— 后者至少能被看见）。
   *
   * **可区分**：队长行 `is_leader_task=1`、`branch=null`、`dir_name=null`。用 `is_leader_task`
   * 作身份标记（`branch` 是「有没有可操作的分支」的**操作性**判据，二者不可互替 —— 见
   * `squadOrchestrator.memberRuns` 的注释）。
   *
   * **「进行中」的读法**（给**重复指派合并**用，spec §5.7(1)）：唯一实现是
   * `hasInProgressLeaderRun(runs, workItemId)`（由 `squadRunLifecycle.ts` 导出）——`getSnapshot().runs`
   * 即活跃集合（已含队长行、已排除终态），命中即「该工作项有进行中的队长 run」⇒ 重复指派应合并
   * 而不是新起一次。调用方**不得**自己重写这条投影（第二份定义迟早漂移，而漂移不报错）。
   *
   * **要「真的」可判定还差一半的写者**：登记只写 `open`；队长 run 结束时若不写终态，这条行会长驻
   * 活跃集 ⇒ 读法**恒真**。补上它的正是下面的 `completeLeaderRun`（成功）与 `failMemberRun`（失败/中止）。
   */
  recordLeaderRun(
    target: SquadWorkspaceTarget,
    input: LeaderRunRequest,
  ): Promise<LeaderRunRecordOutcome>;
  /**
   * 队长 run 的**成功终态收口**（**加法**，P2b 余项）：把队长行从 `open` 移到终态（`merged`）。
   *
   * 为什么必须有它：`recordLeaderRun` 只登记，而队长 run **没有队员那一步 review/merge**
   * （无分支可合、无树可抛，spec §6.1/§6.2）⇒ 没有既有方法会把这条行移出活跃集 ⇒ **成功的队长行
   * 长驻 `open`** ⇒ `hasInProgressLeaderRun` **恒为真** ⇒ §5.7(1) 的「重复指派合并」会把该工作项的
   * 所有后续指派**永久吃掉**（且不报错）。这不是「少一个便利动作」，而是判据被架空。
   *
   * 与 `completeMemberRun` 的**刻意差异**（对称但不等同）：**不推工作项状态**（spec §5.7(2)
   * 「队长 run 不改父项状态」——套上 `completeMemberRun` 那句 `in_review` 会写坏父项）、
   * **直接到终态**（队员的产出要活到合并，故 `produced` 仍是活跃态；队长无分支/工作树，run 结束
   * 即收口）。队长行 `branch=null` ⇒ §6.2「终态**不得**影响工作树生命周期」成立。
   *
   * 三条纪律（与 `failMemberRun` 同款）：**唯一写者**（只经 `squadRunRepo.setStatus`）、
   * **前置读当时状态**、**未命中 / 跨终态响亮抛**（已是 `merged` 幂等返回；`discarded` 等跨终态**抛**）。
   * **只收队长行**（非队长行抛 —— 误用于队员行会把从未合并的分支置 `merged`，随后被连树带枝丢弃）。
   * **不过门禁**：收口在途 run 不是「新派发」（与 `completeMemberRun` 同理由）。
   */
  completeLeaderRun(target: SquadWorkspaceTarget, input: { runId: string }): Promise<void>;
  /** run 终态（host 派发桥调用）。**不过门禁**：收尾在途 run 不属「新派发」。 */
  completeMemberRun(target: SquadWorkspaceTarget, input: { runId: string }): Promise<void>;
  /**
   * 审查裁决（最小视图按钮调用）。**不过门禁**：审查既有产出的动作不产生新派发。
   *
   * 通过（approved）时本方法做**两件事**，且次序固定：① 把该队员分支合进**集成分支**（生命周期层）；
   * ② 把**该子工作项**推进到终态（裁定 1，经唯一写者 `workItemService.transition`）—— ② 是
   * 「子项全终态 ⇒ `children_done` ⇒ 批次 finalize」这条链的唯一写者，缺了它整批永不收尾。
   * 打回（rejected）**不写**工作项状态：工作树与分支存活到修复后重新审核（spec §6.2）。
   */
  reviewMemberRun(
    target: SquadWorkspaceTarget,
    input: { runId: string; verdict: "approved" | "rejected" },
  ): Promise<ReviewOutcome>;
  /**
   * 改派（**加法**，2026-10-03）：把**既有**工作项改给 user / agent / squad（UI 的唯一入口）。
   * 返回本次调用是否**真的发生了变更**（`assigned:false` = 对象与现值相同 ⇒ 有意不动作，见第 3 条）。
   *
   * 语义逐条：
   * 1. **入口过门禁**（指派 = 新派发）：与 `assignWorkItem` / `createWorkItem` 同一处判据
   *    （`assertEnabled`）。**次序**：门禁在**构造 runtime 之前**过 —— 与 `createWorkItem` 同款。
   *    门禁要回答的是「现在允不允许新派发」，它与目标 workspace 是不是一个可用的 git 仓库无关；
   *    先建 runtime 会先跑 base 分支解析（构造期解析、失败即抛），于是在**非 git 目标**上关闭开关时，
   *    调用方拿到的是「base 分支解析失败」而不是**门禁结论** —— 上层按稳定码分流
   *    （`SQUAD_DISPATCH_DISABLED_CODE`）就分不出来，界面上会显示成 workspace 坏了。
   *    关掉实验后改派被拒（`SquadDispatchDisabledError` 原样带出）。
   * 2. **工作项不存在 / 已归档 ⇒ 响亮抛**（照 `assignWorkItem` 的口径）：本方法只改**既有**工作项的
   *    负责人；静默建新项会把这次派发挂到一个与调用方所指无关的对象上。
   * 3. **assignee 与现值相同（type 与 id 都相同）⇒ 不写、不发事件、返回 `{assigned:false}`**：
   *    重复指派给同一对象**不该再起一次 run** —— 队员 run 会撞工作树/分支名而响亮失败，队长 run 则由
   *    §5.7(1) 合并；「同一事实重投不产生第二次动作」与 Inbox 的幂等（`insertIfAbsent`）是同一条纪律。
   *    （队长派单工具的 `assignWorkItem` 在这一格**有意不同**：照旧写 + 照旧发事件 —— 那是对同一队员的
   *    **重试**入口，见该方法的注释。）
   * 4. `assignee.type === "user"` ⇒ **只写负责人**（`updateAssignee`），**不发派发事件**：
   *    人不需要被派 run ——「指派给人 = 等人自己动手」（`planDispatch` 的 user 支路同样只通知、不排队）。
   * 5. `assignee.type === "agent" | "squad"` ⇒ 写负责人 + 发 `workitem.dispatch_requested`（经
   *    **唯一出口** `SquadRuntime.emitWorkItemEvent` ↔ `subscribeWorkItemEvents` 同一张表 / 同一个
   *    常驻 hub），**不在这里开 run**（开 run 是派发路径的事，§5.1 一处写入 / §5.6 `@` ≠ 指派）。
   *    载荷是 `assignee`（类型 + id）而非裸 `agentId`：小队也能被指派（负责人是 squad ⇒ 派发路径
   *    解析出队长 run）。
   * 6. **写者纪律**：负责人不是 `status`（唯一写者那条约束管的是 `status`），只经 repo 的专用写入口
   *    `workItemRepo.updateAssignee`（「恰命中一行才算成功」的条件更新）；未命中（写入时已不可写：
   *    被归档 / 删除）⇒ **响亮抛**，不静默 no-op。
   */
  reassignWorkItem(
    target: SquadWorkspaceTarget,
    input: { workItemId: string; assignee: WorkItem["assignee"] },
  ): Promise<{ assigned: boolean }>;
  /**
   * 把**既有**工作项指派给某位队员（裁定 Important-1，2026-10-02）：**改负责人 + 发出派发事件**。
   *
   * **薄包装**（2026-10-03 收口）：内部走 `reassignWorkItem` 的**同一实现**（传
   * `{type:"agent", id: agentId}`），使「改负责人 + 发事件」在服务面**只有一份实现**。对外契约
   * 保持不变：入参形状、返回 `{assigned:true}`、过门禁、只支持 agent。
   *
   * **有意保留的一格差异**：同一队员**重复指派**（对象与现值相同）照旧**写 + 发事件** —— 那是对
   * 该队员的**重试**入口（队员 run 失败后该队员可能仍是负责人，重派一次是正当操作；派发结论的响亮
   * 失败由派发路径给，见 host 的 eventKey 注释），把它静默改成 no-op 会让工具回执「已派发」而实际
   * 什么都没发生 —— 正是本项目一路在消灭的「点了没反应」。服务面实现因此在同值这一格接受两种策略，
   * 由调用面显式选择（见 `applyWorkItemAssignee` 的 `sameAssignee`）。
   *
   * 语义其余部分（门禁在前 / 只改既有项 / 只发事件不开 run / 唯一写者）与 `reassignWorkItem` 完全一致。
   */
  assignWorkItem(
    target: SquadWorkspaceTarget,
    input: AssignWorkItemRequest,
  ): Promise<{ assigned: true }>;
  /**
   * 失败 run 的出口（裁定 Important-3）：把执行失败的 run 移出活跃集，使其工作树/分支**可被回收**。
   * **不过门禁**：收口失败 run 不是「新派发」。与 `reviewMemberRun` 同款纪律（唯一写者 / 前置读当时
   * 状态 / 未命中响亮抛），见 `SquadRunLifecycle.failMemberRun`。
   */
  failMemberRun(
    target: SquadWorkspaceTarget,
    input: { runId: string; reason: string },
  ): Promise<void>;
  /**
   * 会话建立后把 `sessionId` 回写该 run 的台账（裁定 Important-4）：让忙检查的**强探测**与
   * `deferred` 分支真正可达（否则台账恒为 `null`，保护为零）。**不过门禁**：不是「新派发」。
   */
  bindMemberRunSession(
    target: SquadWorkspaceTarget,
    input: { runId: string; sessionId: string },
  ): Promise<void>;
  /**
   * 启动**重驱**未收尾的批次（裁定 Important-2）：对「子项全部终态、但该批尚未 finalize」的父项
   * 再跑一次 `advanceAfterChildrenDone`。**幂等**（沿用编排层的 CAS / 前置读当时状态 / 重放闸）；
   * **响亮**（失败逐条留在返回值里，由调用方记日志）。不实现「重发 `child_completed`」——
   * 事件在崩溃后不会再有人重放，所以恢复动作必须是**幂等的重驱**而不是重放事件。
   *
   * **发现判据不得只依赖 run 台账行**（缺陷 1 的修法）：空批（无任何队员 run）在台账里没有行，
   * 只按行找会**永远看不见它** —— 父项永久滞留 `todo`。故枚举用两条并列证据：run 台账行
   * （有产出过的批）**或**父项被指派给小队（批次根；覆盖空批）。见实现内的详注。
   */
  replayUnfinalizedBatches(target: SquadWorkspaceTarget): Promise<BatchReplayOutcome>;
  /** 启动回收（host 启动路径调用，spec §6.4/§6.6）。**不过门禁**：清理是恢复步骤，不是新派发。 */
  reapStartupOrphans(target: SquadWorkspaceTarget): Promise<ReapOutcome>;
  /** 归档小队 + 指派转交队长（#9，spec §3.10/S10）。**先转交后归档**。 */
  archiveSquadAndTransfer(target: SquadWorkspaceTarget, id: string): Promise<void>;
  /**
   * **整批放弃**（spec §6.3「整批可整体放弃」，**加法**）：用户显式取消一个**还没合回主分支**的批 ——
   * 逐个抛弃队员（删分支 + 清工作树，含 `produced` / `rejected`）→ 删集成分支 → 父项置 `cancelled`。
   *
   * 为什么必须补这个入口：机制（`SquadBatchOrchestrator.discardBatch`）早已实现，但此前
   * **没有任何生产调用方** ⇒ 服务面与 host 都够不到 ⇒ §6.3 承诺的「整批可整体放弃」**用户用不了**，
   * 只有「合并后自动抛弃」可达。
   *
   * 三条纪律（与冻结面既有形态一致）：
   * 1. **唯一写者不变**：父项状态只经 `workItemService.transition`（编排器内部已如此），本方法不碰 repo。
   * 2. **不过门禁**：放弃**不产生新派发**，与 `reviewMemberRun` / `failMemberRun` 同款 ——
   *    关掉实验开关只停新派发（§5.7.6），若把放弃也拦下，用户就**收不掉**一个已经在跑的批。
   * 3. **显式目标**：第一个参数就是 `SquadWorkspaceTarget`（裁定 4：没有隐式默认 workspace）。
   *
   * **前置条件由编排层响亮拒绝**（全部在任何 git 写动作**之前**）：父项不存在 / 已归档、父项已终态
   * （`done` = 成果已合回主分支；`cancelled` = 已放弃过）、或集成分支已合回 base —— 见
   * `squadOrchestrator.discardBatch` 的详注。**「已合回主分支的批」= 拒绝**（不得静默丢弃已落地成果）。
   *
   * **发现判据**：哪些工作项是批次根由 `isSquadBatchRoot` 给出（与 UI 入口共用同一份定义）。
   */
  discardBatch(target: SquadWorkspaceTarget, input: { parentWorkItemId: string }): Promise<void>;
  /**
   * 登记一条 InboxItem（**加法**，P2c）：host 在「需要人介入」的产生点调用（队员失败 / 启动和解 /
   * 派发 skip）；冲突那一条由**编排器**直写（它本来就用同一组 repo，见 `SquadRuntime.inboxItemRepo`）。
   *
   * 三条纪律（与 `updateTeamAgent` / `updateWorkItem` 同款）：
   * 1. **唯一写者**：只经 runtime 的 `inboxItemRepo.insertIfAbsent`（存储层幂等：唯一索引 +
   *    `INSERT OR IGNORE` —— 同一事实重投不产生第二条、已归档不复活）。调用方不得自己拼 SQL，
   *    也不得绕过本方法直连 repo；`kind → severity` 的映射在 repo 内单源（产生点只表态 kind）。
   * 2. **不过门禁**：登记通知**不是新派发**（§5.7.6 只停新派发），与 `failMemberRun` /
   *    `updateTeamAgent` 同款理由 —— 关掉实验开关后，在途 run 的失败与和解仍必须能落进收件箱
   *    （那正是要「看得见」的东西）。**本层不得写任何第二份开关判据**。
   * 3. **目标显式**：`target` 是**唯一权威**（没有隐式默认 workspace），runtime 按目标现构、不缓存
   *    —— 与 `createWorkItem` 同款。**幂等结论不回传**（`insertIfAbsent` 的 `false` 在本签名上折成
   *    void）：调用点是 best-effort 留痕，不据它分流 ——「重投」与「新登记」对调用方的后续动作没有差别。
   */
  recordInboxItem(target: SquadWorkspaceTarget, input: InboxItemInput): Promise<void>;
  /**
   * 收件箱的**跨项目**读取面（**加法**，P2c）：用户裁定收件箱是**跨 workspace 的通知面**
   * （跨项目一级入口，下一轮落地），故本方法**有意偏离**「目标显式」这条覆盖全文件的纪律 ——
   * **没有** target 参数，也**不得**有人悄悄加一个（加了就退回「一次只能看一个项目」，
   * 而「所有项目里等我处理的事」正是收件箱存在的理由）。
   *
   * 默认**排除已归档**（归档 = 用户说「处理完了」）；`includeArchived: true` 才连归档行一起取。
   * 读取不经任一 runtime（跨 workspace ⇒ 没有唯一目标），走组合根注入的懒取 repo：库未就绪时
   * 它在**调用时**响亮抛，不静默返回空表（空表会把「库没开」伪装成「收件箱是空的」）。
   */
  listInboxItems(options?: { includeArchived?: boolean }): Promise<InboxItem[]>;
  /** 标已读（**加法**）：只改 `read_at` 一列（重复调用保留首次时间戳）。未命中 ⇒ 响亮抛。 */
  markInboxItemRead(id: string): Promise<void>;
  /**
   * 归档（**加法**）：只改 `archived_at` 一列（不碰 `read_at` —— 已读与归档是两件正交的事）。
   * 归档后同一事实的重投**不复活**它（存储层不变式，见 `recordInboxItem` 第 1 条）。未命中 ⇒ 响亮抛。
   */
  archiveInboxItem(id: string): Promise<void>;
}

export const ISquadRuntimeService = createServiceDescriptor<ISquadRuntimeService>("squad-runtime");

/**
 * 审查通过 ⇒ 该子工作项推进到**终态**（`done`）——裁定 1：闭合「子项终态 ⇒ `children_done` ⇒ 批次收尾」的链条。
 *
 * 为什么必须补这个写者：`reviewMemberRun(approved)` 把队员分支合进**集成分支**之后就结束了 ——
 * 全仓里 `"done"` 只出现在编排器给**父项**的地方，谁都不写**子项**的终态。于是
 * `workItemService.transition` 内部的 `areAllChildrenTerminal` 永远为假 ⇒ `workitem.child_completed`
 * 永不发出 ⇒ `advanceAfterChildrenDone` 永不运行 ⇒ 整批永不 finalize ⇒ 用户既看不到 `done`，
 * 主分支也永远拿不到成果。这不是「少一个便利动作」，而是闭环断在这里。
 *
 * 三条纪律（逐条对应裁定原文）：
 * 1. **写者不变**：只经 `workItemService.transition`（唯一写者）。本函数不碰 repo 的 `updateStatus`、
 *    不写裸 SQL、不在协议 handler 里写状态。
 * 2. **条件驱动，不是渲染驱动**（spec §4.2 / §4.3）：推进由「审查通过」这个**条件**发生 —— 本函数不读
 *    界面正在显示什么，也不让状态反过来驱动执行。
 * 3. **前置读当时状态、不得写死**：CAS 的 `expect` 必须来自**此刻**读到的子项状态。写死一个前置
 *    （例如 `in_review`）会在子项实际停在别处时**静默未命中**，而 §5.7.5 的「未命中即丢弃」会把那次
 *    结算吞掉 —— 用户既看不到 `done`，也看不到任何报错。这不是假想：机械半 `completeMemberRun` 的
 *    `in_review ← in_progress` 前置就是写死的，而**全仓没有任何路径把子项推到 `in_progress`**
 *    （`workItemService.create` 给的是 `todo`）⇒ 由队长建出的子项事实上停在 `todo`，写死前置必不命中。
 *    故这里先读当时状态再拿它当前置；读到写之间被人改了（真 CAS 未命中）则**响亮抛**，绝不静默丢弃。
 *
 * **次序硬约束**：调用点只能在**合并成功之后**。反序（先标终态、后合并）会让子项终态抢先触发
 * `child_completed` ⇒ 批次在集成分支还缺这份成果时就 finalize —— 半批已经落到主分支上，且回不去。
 *
 * 「子项已是**另一个**终态」（例如用户把它 `cancelled` 了）⇒ **不跨终态改写**，也不抛：
 * · 不改成 `done`：跨终态改写会掩盖这条批是按什么次序结算的；
 * · 不抛：此刻合并**已经落地**，抛出去会把一次成功的合并变成一次响亮失败，而上层拿到失败后
 *   并不会去回滚集成分支 —— 那份产出就悬在那里。这与编排层对「子项被取消」的既有口径一致
 *   （`全 cancelled 子项：仍按 run 台账结算`）：取消子项不代表丢弃它已产出的活。
 * 这条支路有专门用例（断言「不抛、也不改写」），故它是**显式结论**而不是被吞掉的分支。
 *
 * **Minor-3（2026-10-02 裁定）：口径统一。** 「子项不存在/已归档」与上面那条支路处在**同一位置**
 * （都在合并**已落地之后**）⇒ 必须同口径：**不抛 + 响亮留痕**（`logWarn` 带原文）。旧实现这里抛错，
 * 与它自己的论证直接矛盾（README 形态：一次成功的合并被一个「找不到子项」的异常翻成响亮失败，
 * 且上层不会回滚）。留痕经注入的 `logWarn`（本文件必须保持浏览器安全，不能 import node 侧 logger）。
 * 与「runId 算错」严格区分：那是**调用方传参错误**（不是数据状态），继续响亮抛。
 */
function settleChildWorkItem(
  runtime: SquadRuntime,
  runId: string,
  logWarn: SquadRuntimeLogWarn,
): void {
  const record = runtime.squadRunRepo.get(runId);
  if (!record) {
    throw new Error(
      `审查通过后推进子项失败：squad_runs 没有 runId=「${runId}」的行。` +
        "静默跳过会让这次审查看起来成功了，而那条子工作项仍停在非终态 —— 整批就此永不收尾。",
    );
  }
  const item = runtime.workItemRepo.get(record.workItemId);
  if (!item) {
    /* 子项不存在 / 已归档：合并**已经落地**（与「已取消」支路同一位置），故**不抛** ——
       抛出去会把一次成功的合并变成响亮失败，而集成分支不会因此回滚。改为**响亮留痕**：
       这条工作项不再参与 `children_done` 判定，是必须让人看见的事实（否则整批永不收尾且无人知道）。 */
    logWarn(
      `审查通过后推进子项失败：子工作项「${record.workItemId}」不存在或已归档（runId=${runId}）。` +
        "本次合并已落地，但该子项不再参与 `children_done` 判定 —— 这一批需要人工收尾。",
    );
    return;
  }
  // 幂等：已是目标态就直接返回（不重复发事件 —— 事件是下游唯一判据，重复发会重复结算）。
  if (item.status === "done") return;
  if (isTerminalWorkItemStatus(item.status)) return;
  if (!runtime.workItemService.transition(item.id, "done", item.status)) {
    throw new Error(
      `子工作项「${item.id}」的终态 CAS 未命中：读到前置「${item.status}」、目标「done」，` +
        "但写入时该行已不是读到的那样（并发改动）。静默丢弃会让这次结算消失得无影无踪（§5.7.5），故响亮抛出。",
    );
  }
}

/**
 * 服务实现。依赖全部由组合根注入（本文件不得 import node 侧的值）。
 *
 * 关于「读开关」的纪律（确认 2）：服务侧**唯一**的判据是下面的私有 `assertEnabled()`；
 * `assertDispatchEnabled` / `createWorkItem` / `openMemberRun` 三个入口都调它，没有第二处判断。
 * 它读的就是组合根注入的 `readExperimentEnabled`（node.ts 里是门禁用的那份同步快照）。
 * 同一个 `readExperimentEnabled` 也被 `getSnapshot().enabled` 用于 UI 呈现 —— 那是**同一份值**的
 * 第二个用途，不是第二个判据：呈现读到相反的值既不会放行、也不会拦截任何派发。
 * `SquadRuntime.assertDispatchEnabled`（冻结签名）是 host 走「规则 tick」入口的形态，
 * 它读的是组合根注入给 runtime 的**同一个闭包**（两处同源 ⇒ 不可能漂移）。
 */
export function createSquadRuntimeService(deps: {
  /** 按目标现构 runtime（裁定 4 + 确认 3：不缓存、不取首个）。 */
  createRuntime: (target: SquadWorkspaceTarget) => Promise<SquadRuntime>;
  /**
   * 读实验开关：**门禁（服务侧唯一判据）与 UI 呈现共用这一份结论**。
   * 组合根注入的是门禁用的那份同步快照，故它与注入给 runtime 的是同一份值。
   */
  readExperimentEnabled: () => Promise<boolean>;
  /**
   * 归档 + 指派转交（组合逻辑在 `squadRuntime.ts`：它要用 workItemRepo，而描述符这一侧必须浏览器安全，
   * 不能值导入那个模块）。由组合根注入。
   */
  archiveSquadAndTransfer: (target: SquadWorkspaceTarget, id: string) => Promise<void>;
  /**
   * 批次编排工厂（`createSquadOrchestrator`）。**注入**：编排器模块 import 了 node 侧依赖
   * （`node:crypto` 等），本文件值导入它会破坏浏览器安全不变量（见文件头注释）。
   *
   * 可选以保持**既有调用方不受影响**（加法）：未注入时 `replayUnfinalizedBatches` **响亮抛**
   * ——缺工厂就说明这一份 runtime 的服务面根本没接上批次层，静默 no-op 会让崩溃窗口永久卡死。
   */
  createOrchestrator?: (deps: { runtime: SquadRuntime }) => SquadBatchOrchestrator;
  /**
   * 响亮留痕（Minor-3 的子项缺失支路要用）。同样**可选**：未注入时回落到 `console.warn`
   * （本文件必须浏览器安全，不能值导入 node 侧 logger；`console` 是两侧都有的最小交底）。
   */
  logWarn?: SquadRuntimeLogWarn;
  /**
   * 收件箱的**懒取** repo 口（跨 workspace 的读取面用：`listInboxItems` / `markInboxItemRead` /
   * `archiveInboxItem` —— 它们没有唯一目标，故不经 runtime）。
   *
   * 为什么是「一次调用一次的取法」而不是实例：组合根在 `ensureReady()` 之后才拿得到同一条 db
   * （`openSharedDatabase()` 未初始化即抛，见 `createSquadRuntimeFor` 的既有口径），而服务面在库
   * 就绪前就已构造。故注入闭包、调用时才取：未就绪在**调用时响亮抛**（不静默返回空表 —— 空表会把
   * 「库没开」伪装成「收件箱是空的」，与既有「响亮失败优于静默」同款）。
   *
   * **可选**（加法，既有调用方不受影响）：未注入时上面三个方法**响亮抛** —— 缺它说明这一份服务面
   * 根本没接上收件箱台账，静默 no-op 会让界面显示「空收件箱」而库里其实有东西。
   */
  getInboxItemRepo?: () => InboxItemRepo;
}): ISquadRuntimeService {
  /** 本 runtime 的 `workspace_key`（C14 口径）：台账与快照都按它过滤。 */
  const keyOf = (runtime: SquadRuntime): string =>
    resolveWorkspaceKey({
      workspacePath: runtime.boundWorkspace.path,
      workspaceIdentity: runtime.boundWorkspace.identity,
    });

  /** 响亮留痕的唯一去处（Minor-3）：注入优先，否则回落 console（见 deps.logWarn 的理由）。 */
  const logWarn: SquadRuntimeLogWarn = deps.logWarn ?? ((message) => console.warn(message));

  /**
   * 跨 workspace 读取面用的懒取 repo（见 `deps.getInboxItemRepo` 的理由）。
   * 未注入 ⇒ **响亮抛**：这不只是「没配」，而是「这一份服务面根本没接上收件箱」——
   * 静默返回空表会让用户看到一个空收件箱，而库里其实有东西。
   */
  const requireInboxItemRepo = (): InboxItemRepo => {
    if (!deps.getInboxItemRepo) {
      throw new Error(
        "收件箱台账未接通：组合根没有注入 getInboxItemRepo（懒取 repo 口）。" +
          "静默返回空结果会把「这份服务面没接收件箱」伪装成「收件箱是空的」，故一律抛。",
      );
    }
    return deps.getInboxItemRepo();
  };

  /**
   * 门禁的**唯一判据**（spec §5.7.6 / 确认 2）。三个入口（`assertDispatchEnabled` 自身、
   * `createWorkItem`、`openMemberRun`）都调**这一个**函数。
   *
   * 为什么在这里读注入的开关、而不是「先建 runtime 再问 runtime」：门禁要回答的问题是
   * 「现在允不允许新派发」，它与目标 workspace 是不是一个**可用的 git 仓库**无关。
   * 先建 runtime 会先跑 `git symbolic-ref` 解析 base 分支（构造期解析、失败即抛），
   * 于是在**非 git 目标**上关闭开关时，调用方拿到的是「base 分支解析失败」而不是**门禁结论** ——
   * 上层据错误码分流（`SQUAD_DISPATCH_DISABLED_CODE`）就分不出来，界面上会显示成 workspace 坏了。
   * 判据的值只有一处来源：组合根注入的 `readExperimentEnabled`（node.ts 里就是门禁用的那份
   * `squadsEnabled` 同步快照，与注入给 runtime 的是**同一个**闭包 ⇒ 两处不可能漂移）。
   * `SquadRuntime.assertDispatchEnabled`（冻结签名）仍是 host 走「规则 tick」那条入口的形态，
   * 它读的是同一个来源；本函数是服务侧三个入口的形态。
   */
  const assertEnabled = async (): Promise<void> => {
    if ((await deps.readExperimentEnabled()) !== true) {
      throw new SquadDispatchDisabledError();
    }
  };

  /* 唤醒规则六项（**加法**：P2b 第二半 + 收口）：实现全在 `squadWakeRules.ts`
     （组装 / 校验 / 排期 / CAS），这里只把两个依赖接进去 —— ① `deps.createRuntime`（按目标现构，
     不缓存）；② `assertEnabled`（服务侧唯一门禁：create / resume / update 在构造 runtime **之前**
     过它；pause / list / delete 不过）。**这里刻意不写任何第二份开关判据**（门禁的唯一判据就是
     上面的 `assertEnabled`）。 */
  const wakeRuleOps = createWakeRuleOps({
    createRuntime: deps.createRuntime,
    assertEnabled,
  });

  return {
    async assertDispatchEnabled(_target) {
      // 只答门禁问题：**不构造 runtime**（也就不依赖 git 解析），只读设置、只抛错。
      await assertEnabled();
    },

    async getSnapshot(target) {
      const runtime = await deps.createRuntime(target);
      return {
        enabled: (await deps.readExperimentEnabled()) === true,
        teamAgents: runtime.teamAgentService.list(),
        squads: runtime.squadService.list(),
        workItems: runtime.workItemRepo.listByWorkspace(keyOf(runtime)),
        runs: runtime.squadRunRepo.listActive(keyOf(runtime)),
      };
    },

    /* 历史读取面（**加法**，规格 §11.2 时间线的数据面）。**不过门禁**：读历史不是新派发
       （接口注释里有完整理由），与 `getSnapshot` 不同 —— 后者读 `enabled` 是为了**呈现**，
       本方法连开关值都不需要：图要画的是「发生过什么」，不是「现在允许做什么」。
       两个口径都由 repo 单源给出、原样交回：批次过滤 `listByParent`、全量历史 `listByWorkspace`；
       本层不在这里筛、不在这里重排（第二份判据会与 repo 的排序/过滤漂移，而漂移不报错）。
       `keyOf(runtime)` 取自 runtime 的**绑定值**：runtime 才是「为哪个 workspace 而构造」的权威
       （与 createWorkItem 取 workspace 列同一条纪律）。 */
    async listSquadRuns(target, input) {
      const runtime = await deps.createRuntime(target);
      return input?.parentWorkItemId
        ? runtime.squadRunRepo.listByParent(input.parentWorkItemId)
        : runtime.squadRunRepo.listByWorkspace(keyOf(runtime));
    },

    async createTeamAgent(target, input) {
      return (await deps.createRuntime(target)).teamAgentService.create(input);
    },

    /* 以下三个名册管理动作（**加法**）都不调 `assertEnabled`：名册管理不产生新派发
       （§5.7.6 只停新派发），与 `failMemberRun` / `reviewMemberRun` 同款理由 ——
       关掉实验开关时名册管理仍应可用（界面侧入口此时本就隐藏，见 `squadEntryVisible`）。
       **这里刻意不写任何第二份开关判据**：门禁的唯一判据是上面的 `assertEnabled`，
       名册这里连"判一下"的必要都没有（不是漏判，是不该判）。
       写者纪律：只经注入的 `teamAgentService`（read-modify-write + 原子写盘在其内部），
       服务面不碰任何文件，也不做第二份拼装。目标 `target` 原样交给 `createRuntime` ——
       它是**唯一权威**（runtime 按目标现构、不缓存，没有隐式默认 workspace）。 */
    async updateTeamAgent(target, input) {
      return (await deps.createRuntime(target)).teamAgentService.update(input.id, input.patch);
    },

    async setTeamAgentEnabled(target, input) {
      await (await deps.createRuntime(target)).teamAgentService.setEnabled(input.id, input.enabled);
    },

    async archiveTeamAgent(target, input) {
      await (await deps.createRuntime(target)).teamAgentService.archive(input.id);
    },

    async createSquad(target, input) {
      return (await deps.createRuntime(target)).squadService.create(input);
    },

    /* 以下两个小队名册管理动作（**加法**）与上面三个智能体的同款：都不调 `assertEnabled`
       —— 名册管理不产生新派发（§5.7.6 只停新派发），关掉实验开关后名册整理仍应可用。
       写者纪律：只经注入的 `squadService`（read-modify-write + 原子写盘在其内部），
       服务面不碰任何文件，也不做第二份拼装。目标 `target` 原样交给 `createRuntime` ——
       它是**唯一权威**（runtime 按目标现构、不缓存，没有隐式默认 workspace）。
       小队归档**刻意不在这里**：归档的「先转交后归档」组合只有一处实现
       （`archiveSquadAndTransfer`），UI 直接调它，本层不再加第三个写入口。 */
    async updateSquad(target, input) {
      return (await deps.createRuntime(target)).squadService.updateRoster(input.id, input.patch);
    },

    async setSquadEnabled(target, input) {
      // 经通用的 `update`（它保留其余字段含 `archivedAt`，并在合并后重新校验）——
      // 不为「改一个 enabled」新开第三个写路径。
      (await deps.createRuntime(target)).squadService.update(input.id, { enabled: input.enabled });
    },

    async createWorkItem(target, input) {
      // 入口② 的闸：**先**判门禁（用的是服务侧唯一判据，不需要先建 runtime），再建项。
      // 「拦在入口而不是半路」：半路拦会留下一条已入队的工作项，看上去像是派发成功了一半。
      await assertEnabled();
      const runtime = await deps.createRuntime(target);
      // workspace 列取自 runtime 的绑定值而不是入参 target：runtime 才是「为哪个 workspace 而构造」的权威。
      return runtime.workItemService.create({
        workspaceIdentity: runtime.boundWorkspace.identity,
        workspacePath: runtime.boundWorkspace.path,
        title: input.title,
        body: input.body,
        parentId: input.parentId,
        assignee: input.assignee,
      });
    },

    async listQueuedSquadRuns(target) {
      const runtime = await deps.createRuntime(target);
      // workspaceKey 与台账行同源口径（C14：identity 去空白优先，否则 path）。
      return runtime.squadRunRepo.listQueued(keyOf(runtime));
    },

    async listSquadDeferredObligations(target) {
      const runtime = await deps.createRuntime(target);
      return runtime.squadDeferredDispatchRepo.list(keyOf(runtime));
    },

    async openMemberRun(target, input) {
      // 入口①（队员段）与入口③ 共用的这一道闸（与上面、与 assertDispatchEnabled 是同一个函数）。
      await assertEnabled();
      const runtime = await deps.createRuntime(target);
      return runtime.lifecycle.openMemberRun(input);
    },

    /* 工作项**内容**编辑（**加法**）：不调 `assertEnabled` —— 改标题 / 正文不产生新派发
       （§5.7.6 只停新派发），与 `updateTeamAgent` / `updateSquad` 同款理由。
       写者纪律：只经 repo 的专用写入口 `workItemRepo.updateContent`（status 的唯一写者仍是
       `workItemService.transition`，本方法不碰它）；调用方不接触 repo。
       未命中（含空 patch：repo 直接 false）⇒ 响亮抛，照 `assignWorkItem` 的既有口径 ——
       静默 no-op 会让界面以为改成功了，而库里仍是旧标题。目标 `target` 原样交给
       `createRuntime`（唯一权威，没有隐式默认 workspace）。 */
    async updateWorkItem(target, input) {
      const runtime = await deps.createRuntime(target);
      if (!runtime.workItemRepo.updateContent(input.id, input.patch)) {
        throw new Error(
          `编辑工作项失败：工作项「${input.id}」不存在、已归档、或没有给任何要改的字段（空 patch）——` +
            "静默 no-op 会让界面以为改成功了，而库里仍是旧内容。",
        );
      }
      // 读回写盘后的实体返回；理论上刚刚命中过同一条件，读回为 null 不可达 —— 真不可达时也响亮抛，
      // 不返回 undefined 让调用方在下一层才炸。
      const item = runtime.workItemRepo.get(input.id);
      if (!item) {
        throw new Error(
          `编辑工作项失败：工作项「${input.id}」写入成功后读回为空（理论不可达）——` +
            "不返回 undefined，避免调用方在下一层才炸。",
        );
      }
      return item;
    },

    /**
     * 队长 run 的登记：**只登记不执行**（门禁理由见接口注释第 3 条 —— 本方法不过门禁）。
     * 委托给 `lifecycle.recordLeaderRun`：台账的写入口只有生命周期这一处，服务面不做第二份拼装。
     */
    async recordLeaderRun(target, input) {
      const runtime = await deps.createRuntime(target);
      // 结论**原样交回**（`recorded: false` = 本次并入进行中的那次，§5.7(1)/S13）：服务面不替调用方
      // 消化这个结论 —— 谁能起会话只有它自己知道，在服务面「当成功吞掉」会让上层以为 run 起了。
      return runtime.lifecycle.recordLeaderRun(input);
    },

    /**
     * 队长 run 的成功收口：**只把台账行移到终态**（门禁理由与 `completeMemberRun` 同 —— 不过门禁）。
     * 委托给 `lifecycle.completeLeaderRun`（唯一写者是生命周期层，服务面不做第二份动作；
     * 也**不在这一层**碰任何工作项状态 —— §5.7(2) 队长 run 不改父项状态）。
     */
    async completeLeaderRun(target, input) {
      const runtime = await deps.createRuntime(target);
      await runtime.lifecycle.completeLeaderRun({ runId: input.runId });
    },

    // 以下三个**不过门禁**：收尾 / 审查 / 回收都不是「新派发」。
    // 关掉开关时若把它们也拦下，正在跑的那批 run 会卡在中间状态（spec §5.7.6 只停新派发）。
    async completeMemberRun(target, input) {
      const runtime = await deps.createRuntime(target);
      await runtime.lifecycle.completeMemberRun({ runId: input.runId });
    },

    async reviewMemberRun(target, input) {
      const runtime = await deps.createRuntime(target);
      const outcome = await runtime.lifecycle.reviewMemberRun({
        runId: input.runId,
        verdict: input.verdict,
      });
      /* 裁定 1（闭环的第三环）：审查**通过** ⇒ 该子工作项推进到终态。
         顺序不可反：这里在**合并成功之后**才写（先写会让子项终态抢先触发 `child_completed`，
         批在集成分支还缺这份成果时就 finalize —— 半批落到主分支上，回不去）。
         `rejected` 走不到这一支（`merged === false`）：被打回待修的子项**保持 `in_review`**，
         工作树存活到修复后重新审核（spec §6.2 / §16 S5）。 */
      if (outcome.ok && outcome.merged === true) {
        settleChildWorkItem(runtime, input.runId, logWarn);
      }
      return outcome;
    },

    async reassignWorkItem(target, input) {
      /* UI 改派（入口③'）。与入口①②③ 共用**同一个**门禁判据（指派 = 新派发）。
         「拦在入口」：半路拦会留下一条已改负责人、却没有派发事件的工作项（看上去成功了一半）。
         **次序**：先门禁、后建 runtime（与 `createWorkItem` 同款）—— 门禁只读开关、只抛错，
         不依赖目标是不是 git 仓库；先建 runtime 会先跑 base 解析，非 git 目标上关开关时调用方
         拿到的是「base 解析失败」而不是门禁结论（稳定码分流就分不出来）。 */
      await assertEnabled();
      const runtime = await deps.createRuntime(target);
      // 同值 ⇒ skip：不写、不发事件、返回 `{assigned:false}`（语义 3：重复指派不该再起一次 run）。
      // 成因取 `user_reassign` —— 本次派发由用户在界面上发起（事实由调用面给出，实现只搬运）。
      // 选项做成单行常量而不是内联字面量：本文件贴着 oxlint 的行数门槛（skipComments 口径）。
      const reassignOptions = { sameAssignee: "skip", cause: "user_reassign" } as const;
      return applyWorkItemAssignee(runtime, input, reassignOptions);
    },

    async assignWorkItem(target, input) {
      /* 队长派单工具（入口③）—— **薄包装**：与 `reassignWorkItem` 同一份实现（`applyWorkItemAssignee`），
         差异只有显式两处：① 对象固定为 `{type:"agent", id}`（本方法对外契约只支持 agent，保持不变）；
         ② **同值 ⇒ reapply**（照旧写 + 照旧发事件）：这是对同一队员的**重试**入口，把它静默 no-op 会让
         工具回执「已派发」而实际什么都没发生（见接口注释的取舍说明）。
         门禁同样是构造 runtime **之前**过（与 reassignWorkItem / createWorkItem 同一处判据、同一次序）。 */
      await assertEnabled();
      const runtime = await deps.createRuntime(target);
      applyWorkItemAssignee(
        runtime,
        { workItemId: input.workItemId, assignee: { type: "agent", id: input.agentId } },
        // 成因取 `leader_tool`（本次派发由队长派单工具发起）；与改派那一支各传自己的值。
        { sameAssignee: "reapply", cause: "leader_tool" },
      );
      // 返回形状不变（reapply 恒写 + 恒发；未命中 / 不可写已在实现里响亮抛，走不到这里）。
      return { assigned: true };
    },

    async failMemberRun(target, input) {
      const runtime = await deps.createRuntime(target);
      await runtime.lifecycle.failMemberRun({ runId: input.runId, reason: input.reason });
    },

    async bindMemberRunSession(target, input) {
      const runtime = await deps.createRuntime(target);
      await runtime.lifecycle.bindMemberRunSession({
        runId: input.runId,
        sessionId: input.sessionId,
      });
    },

    async replayUnfinalizedBatches(target) {
      const runtime = await deps.createRuntime(target);
      const workspaceKey = keyOf(runtime);
      if (!deps.createOrchestrator) {
        // 缺工厂 = 这一份服务面没接上批次层：响亮抛（静默 no-op 会让崩溃窗口永久卡死一批）。
        throw new Error(
          "replayUnfinalizedBatches 无法执行：组合根没有注入 createOrchestrator（批次编排工厂）。" +
            "缺它就没有能重驱收尾的编排器 —— 静默返回空结果会把「这批没恢复」伪装成「本来就没待恢复的批」。",
        );
      }
      const orchestrator = deps.createOrchestrator({ runtime });
      const replayed: string[] = [];
      const failures: Array<{ parentWorkItemId: string; error: unknown }> = [];
      /* 枚举「可能有未收尾批次」的父项 —— 判据**不得只依赖 run 台账行**（缺陷 1 的修法）。
         两条并列的「这是一条小队批次的根」证据，命中**任意一条**即纳入重驱：
         (a) 台账里有本批的 run 行（`listByParent` 非空）：有队员产出过的批（**原有视野**，回归保持）；
         (b) 本项被**指派给小队**（`assignee.type === "squad"`）：小队批次的根 —— **空批没有任何 run 行**
             （例如唯一子项在派单前被取消）。只按 (a) 找会永远看不见它：进程死在「子项转终态」与
             「`child_completed` 转发器跑完收尾」之间时，重启后父项**永久**停在 `todo`，
             没有任何路径会再收它（不是报错，是**永远不动**）。
         为什么 (b) 用「被指派给小队」而不是「父项有子项」：全仓对「本项在一支小队批次里」的判据正是
         「父项负责人是小队」（`leaderDispatch.isSquadBatchChild`）。「子项全终态」对一个**普通父项**
         同样为真，但收尾它会把一个无关的父项跨过自己的验收直接推到 `done` —— 必须用小队指派把它排除。
         （普通父项只靠 `child_completed` 事件的**驱动**才会被收尾；它是事件驱动、要求「有子项**本进程内**
         转过终态」，而重驱是**状态扫描**，会捞到历史遗留的全终态普通父项 —— 二者的差别正在这里。）
         为什么不给空批补一条**假 run 行**：那是伪造事实，会污染 `listActive` / 活跃分支口径与回收判据
         （一条从不存在的 run 被当成真的在跑）。缺证据时补的是**发现判据**，不是**编造台账**。
         这两条证据已收敛成**一处实现**（`isSquadBatchRoot`）：最小视图的「放弃整批」入口也用同一份
         判据（UI 侧传快照的活跃 run 集合），因此不存在「界面认得出、服务层认不出」的第二份口径。 */
      for (const item of runtime.workItemRepo.listByWorkspace(workspaceKey)) {
        const parentRunItems = runtime.squadRunRepo.listByParent(item.id);
        if (
          !isSquadBatchRoot({
            workItem: item,
            runParentWorkItemIds: parentRunItems.map((record) => record.parentWorkItemId),
          })
        ) {
          continue;
        }
        // 已终态 = 已结算（`done`）或已被用户取消（`cancelled`）⇒ 幂等重放应直接跳过，不动 git。
        if (isTerminalWorkItemStatus(item.status)) continue;
        // 子项没全终态 ⇒ 半批，收尾会（正确地）拒绝：这里不重驱，等下一次 `child_completed`。
        if (!runtime.workItemRepo.areAllChildrenTerminal(item.id)) continue;
        try {
          /* 幂等：`advanceAfterChildrenDone` 内部有重放闸（无待合队员且集成分支已不在 ⇒ 空转）与
             「前置读当时状态」的 CAS，重复重驱不会重复合并 / 重复推进。回调里不得 await 的那条约束
             在此**不适用**：这里不是事件回调，是启动恢复路径（没有外层链在等本层）。 */
          await orchestrator.advanceAfterChildrenDone({
            workspaceKey,
            parentWorkItemId: item.id,
          });
          replayed.push(item.id);
        } catch (error) {
          // 逐条收集而不是首错即断：一条坏批不该让其它批的恢复也停下（响亮交给调用方逐条记）。
          failures.push({ parentWorkItemId: item.id, error });
        }
      }
      return { replayed, failures };
    },

    async reapStartupOrphans(target) {
      const runtime = await deps.createRuntime(target);
      return runtime.lifecycle.reapStartupOrphans({ workspaceKey: keyOf(runtime) });
    },

    async archiveSquadAndTransfer(target, id) {
      await deps.archiveSquadAndTransfer(target, id);
    },

    /**
     * 整批放弃（§6.3「整批可整体放弃」）：**只做一件事** —— 把显式目标与 `workspaceKey` 交给编排器。
     *
     * 门禁理由（不过门禁）：放弃是**收尾/取消**动作，不产生新派发，与 `reviewMemberRun` /
     * `failMemberRun` 同款（§5.7.6 只停新派发）。若在这里也判一次开关，用户就**收不掉**一个
     * 开关关闭前已经开跑的批 —— 而放弃恰恰是「把这个批停掉」的那条路。
     *
     * `workspaceKey` 取自 runtime 的**绑定值**（与 `createWorkItem` 取 workspace 列、重驱逐
     * 同一条纪律）：runtime 才是「为哪个 workspace 而构造」的权威；编排层还会再比一次
     * （`assertOwnWorkspace`），异己 key 一律响亮拒绝，不会静默动作在别处。
     *
     * 前置条件（父项存在 / 未终态 / 集成分支未合回 base）由编排层**在任何 git 写动作之前**响亮拒绝
     * —— 见 `squadOrchestrator.discardBatch`，本层不重写一遍（那就是第二份判据）。
     */
    async discardBatch(target, input) {
      const runtime = await deps.createRuntime(target);
      if (!deps.createOrchestrator) {
        // 缺工厂 = 这一份服务面没接上批次层：响亮抛（静默 no-op 会让用户以为「整批已放弃」，
        // 而分支与工作树一个都没被收 —— 那正是本次要消灭的「点了没反应」形态）。
        throw new Error(
          "discardBatch 无法执行：组合根没有注入 createOrchestrator（批次编排工厂）。" +
            "缺它就没有能执行「整批放弃」的编排器 —— 静默返回会把「一个字节都没动」伪装成「已放弃」。",
        );
      }
      const orchestrator = deps.createOrchestrator({ runtime });
      await orchestrator.discardBatch({
        workspaceKey: keyOf(runtime),
        parentWorkItemId: input.parentWorkItemId,
      });
    },

    /* 收件箱四项（**加法**，P2c）。前三个是目标方法、第四个是**有意的跨项目偏离**：

       `recordInboxItem` 走**目标显式**的既有形态（先按 target 现构 runtime，再由它的 repo 落库）——
       与 `createWorkItem` 同款：runtime 才是「为哪个 workspace 而构造」的权威。
       `listInboxItems` / `markInboxItemRead` / `archiveInboxItem` **没有唯一目标**（跨项目通知面 /
       全局唯一的条目 id），故走组合根注入的懒取 repo —— 这里**不得**给它们补一个 target 参数：
       用户裁定的正是「所有项目里等我处理的事，一次看全」。 */
    async recordInboxItem(target, input) {
      /* **不过门禁**（见接口注释第 2 条）：登记通知不是新派发。这里刻意不调 `assertEnabled`。
         写者纪律：只经 runtime 的 `inboxItemRepo.insertIfAbsent`，本层不碰 SQL、不拼 dedupKey
         （那是 `inboxItemProducers` 的唯一形状）。**不吞错**：登记失败照抛，由 best-effort 的调用方
         记日志（在 host 的失败/收尾路径上，一个抛错不得翻掉主流程 —— 但也不得在这里被静默）。 */
      const runtime = await deps.createRuntime(target);
      runtime.inboxItemRepo.insertIfAbsent(input);
    },

    async listInboxItems(options) {
      // 跨 workspace 的读取面（接口注释里有「有意偏离」的理由）：不经任一 runtime、不挑目标。
      return requireInboxItemRepo().listAll(options);
    },

    async markInboxItemRead(id) {
      // 条目 id 全局唯一 ⇒ 不需要目标。未命中由 repo **响亮抛**（界面不会以为标成功了）。
      requireInboxItemRepo().markRead(id);
    },

    async archiveInboxItem(id) {
      // 同 markInboxItemRead：只改 archived_at 一列；未命中响亮抛。
      requireInboxItemRepo().archive(id);
    },

    /* 唤醒规则六项（**加法**：P2b 第二半 + 收口）：实现与逐条口径全在 `squadWakeRules.ts`
       （见该文件头注释与接口 doc）；上面构造的 `wakeRuleOps` 即那六个方法，原样并进本返回值。 */
    ...wakeRuleOps,
  };
}
