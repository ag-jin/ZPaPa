import {
  isTerminalWorkItemStatus,
  resolveWorkspaceKey,
  type Squad,
  type TeamAgent,
  type WorkItem,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { CreateSquadInput } from "../teams/squadService.js";
import type { CreateTeamAgentInput } from "../teams/teamAgentService.js";
import type { ReapOutcome } from "../worktree/orphanReaper.js";
import type { SquadRuntime } from "./squadContracts.js";
import type { MemberRunRequest, OpenMemberRunResult, ReviewOutcome } from "./squadRunLifecycle.js";
import type { SquadRunRecord } from "./squadRunRepo.js";

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
  createTeamAgent(target: SquadWorkspaceTarget, input: CreateTeamAgentInput): Promise<TeamAgent>;
  createSquad(target: SquadWorkspaceTarget, input: CreateSquadInput): Promise<Squad>;
  /** 指派即入队 ⇒ **入口过门禁**（入口② 走这条）。 */
  createWorkItem(target: SquadWorkspaceTarget, input: CreateWorkItemRequest): Promise<WorkItem>;
  /** 起新 run ⇒ **入口过门禁**（入口① 的队员段与入口③ 都汇到这里）。 */
  openMemberRun(
    target: SquadWorkspaceTarget,
    input: MemberRunRequest,
  ): Promise<OpenMemberRunResult>;
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
  /** 启动回收（host 启动路径调用，spec §6.4/§6.6）。**不过门禁**：清理是恢复步骤，不是新派发。 */
  reapStartupOrphans(target: SquadWorkspaceTarget): Promise<ReapOutcome>;
  /** 归档小队 + 指派转交队长（#9，spec §3.10/S10）。**先转交后归档**。 */
  archiveSquadAndTransfer(target: SquadWorkspaceTarget, id: string): Promise<void>;
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
 */
function settleChildWorkItem(runtime: SquadRuntime, runId: string): void {
  const record = runtime.squadRunRepo.get(runId);
  if (!record) {
    throw new Error(
      `审查通过后推进子项失败：squad_runs 没有 runId=「${runId}」的行。` +
        "静默跳过会让这次审查看起来成功了，而那条子工作项仍停在非终态 —— 整批就此永不收尾。",
    );
  }
  const item = runtime.workItemRepo.get(record.workItemId);
  if (!item) {
    throw new Error(
      `审查通过后推进子项失败：子工作项「${record.workItemId}」不存在或已归档（runId=${runId}）。` +
        "静默跳过会让这位队员的产出永远不参与 `children_done` 判定。",
    );
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
}): ISquadRuntimeService {
  /** 本 runtime 的 `workspace_key`（C14 口径）：台账与快照都按它过滤。 */
  const keyOf = (runtime: SquadRuntime): string =>
    resolveWorkspaceKey({
      workspacePath: runtime.boundWorkspace.path,
      workspaceIdentity: runtime.boundWorkspace.identity,
    });

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

    async createTeamAgent(target, input) {
      return (await deps.createRuntime(target)).teamAgentService.create(input);
    },

    async createSquad(target, input) {
      return (await deps.createRuntime(target)).squadService.create(input);
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

    async openMemberRun(target, input) {
      // 入口①（队员段）与入口③ 共用的这一道闸（与上面、与 assertDispatchEnabled 是同一个函数）。
      await assertEnabled();
      const runtime = await deps.createRuntime(target);
      return runtime.lifecycle.openMemberRun(input);
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
      if (outcome.ok && outcome.merged === true) settleChildWorkItem(runtime, input.runId);
      return outcome;
    },

    async reapStartupOrphans(target) {
      const runtime = await deps.createRuntime(target);
      return runtime.lifecycle.reapStartupOrphans({ workspaceKey: keyOf(runtime) });
    },

    async archiveSquadAndTransfer(target, id) {
      await deps.archiveSquadAndTransfer(target, id);
    },
  };
}
