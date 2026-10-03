import { createSquadService } from "../teams/squadService.js";
import { resolveSquadDefinitionRoot } from "../teams/squadStorage.js";
import { createTeamAgentService } from "../teams/teamAgentService.js";
import { resolveSquadAgentRoot } from "../teams/teamAgentStorage.js";
import {
  createBranchAllocator,
  INTEGRATION_NAMESPACE,
  MEMBER_NAMESPACE,
} from "../worktree/branchNaming.js";
import { createGitRunner, ensureGitRunSucceeded, type GitRunner } from "../worktree/gitRunner.js";
import { createIntegrationMerger, deleteBranch } from "../worktree/integrationMerge.js";
import { createOrphanReaper } from "../worktree/orphanReaper.js";
import { createWorktreeManager } from "../worktree/worktreeManager.js";
import type { SquadBriefing } from "./leaderDispatch.js";
import { createInboxItemRepo } from "./inboxItemRepo.js";
import type { SquadRuntime, SquadRuntimeDeps } from "./squadContracts.js";
import { createRunLifecycle } from "./squadRunLifecycle.js";
import { createSquadRunRepo } from "./squadRunRepo.js";
import { SquadDispatchDisabledError } from "./squadRuntimeService.js";
import { createWorkItemRepo } from "./workItemRepo.js";
import { createWorkItemService, type WorkItemEvent } from "./workItemService.js";
import { createWakeRuleRepo } from "./wakeRuleRepo.js";

/* **组合根装配**：把 P0–P2a 交付的零件按目标 workspace 拼成一个 runtime。

   recon.md C6/F1 说这些零件出厂即「零生产调用方」——单元测试全绿，但应用里没有任何一处
   `new`/`create` 它们，于是功能整块空转**且不报错**。本文件是第一个装配点。

   两条贯穿全文件的约束：
   1. **目标 workspace 是必填的**（裁定 4 + 确认 3）：runtime 不为「当前工作区」而建，而是为
      **某一个** 目标而建，它的路径/身份写进 `boundWorkspace`，所有内部访问都只用它；
      外来的异己 workspaceKey 一律抛（见 `createRunLifecycle` 的 `assertOwnWorkspace`）。
   2. **不缓存**（由组合根决定使用方式）：本文件只提供「按目标现构」的工厂，每次调用都新建一套零件，
      所以不存在陈旧与失效逻辑；代价是一次 `git symbolic-ref` 子进程。 */

/** 小队命名空间的分支（集成分支 / 队员分支）—— **永远不是** base：它们是小队运行期的产物。 */
function isSquadNamespaceBranch(branch: string): boolean {
  return branch.startsWith(INTEGRATION_NAMESPACE) || branch.startsWith(MEMBER_NAMESPACE);
}

/** 本仓库的短分支名（`refs/heads/` 下全部，按名字排序）。失败**抛**（给空数组会让「找不到候选」看起来像「本来就没有」）。 */
async function listLocalBranchNames(git: GitRunner, workspacePath: string): Promise<string[]> {
  const result = await git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], {
    cwd: workspacePath,
  });
  if (result.code !== 0) {
    throw new Error(
      `无法枚举本仓库的分支（git for-each-ref 失败，exit ${result.code}` +
        `${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}）：` +
        "HEAD 停在小队命名空间分支时需要它来确定 base，枚举失败**不得**静默当作「没有候选」。",
    );
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** 解析 base 分支：显式给就用（空白视为没给），否则问 git；**绝不猜 "main"**。 */
async function resolveBaseBranch(
  git: GitRunner,
  workspacePath: string,
  explicit: string | undefined,
): Promise<string> {
  if (explicit !== undefined) {
    if (explicit.trim() === "") {
      throw new Error(
        `base 分支不能是空白（收到 ${JSON.stringify(explicit)}）：` +
          "要么给一个真分支名，要么整个省略让我们去问 git —— 不静默回退，否则整批成果会合到别处",
      );
    }
    return explicit;
  }

  const result = await git(["symbolic-ref", "--short", "HEAD"], { cwd: workspacePath });
  const branch = result.stdout.trim();
  if (result.code !== 0 || branch === "") {
    throw new Error(
      `小队需要一个 git 仓库作为 workspace：在 ${workspacePath} 上解析 base 分支失败` +
        `（git symbolic-ref --short HEAD 退出码 ${result.code}` +
        `${result.stderr.trim() ? `：${result.stderr.trim()}` : ""}）。` +
        "这通常意味着该目录不是 git 仓库、或正处于 detached HEAD。" +
        '**不猜 "main"**：猜错会把整批成果合到一个与用户预期无关的分支上，且不报错。' +
        "确实要用别的基础分支，请在 deps.baseBranch 里显式给出。",
    );
  }

  /* **崩溃残留的 HEAD**：批次收尾里 `mergeInto` 会 `git checkout <集成分支>` 再 merge（主工作树
     —— 所有 git 动作的 cwd 都是它），所以「末个子项 done 之后、finalize 落地之前」进程死掉时，
     重启后的 HEAD 正指着**集成分支**（或某条队员分支）。若把它当 base：
       · `finalize`（`checkout <base> && merge <integration>`）退化成「自己合自己」的空操作，
         返回 `ok`；
       · 随后 `discardIntegration` 因「集成分支正被检出」而**删不掉** ⇒ 整批**静默收不了尾**；
       · 而这一批的 `merged` 队员分支已不在活跃集，会被启动回收器当孤儿删掉（丢成果风险）。
     故小队命名空间的分支**一律不得当 base**：改用「本仓库**唯一**的非小队分支」（候选不唯一就抛，
     不猜名字 —— 与启动维护那侧的「不猜目标」同一口径）。HEAD 是普通分支时行为完全不变。 */
  if (isSquadNamespaceBranch(branch)) {
    const candidates = (await listLocalBranchNames(git, workspacePath)).filter(
      (name) => !isSquadNamespaceBranch(name),
    );
    if (candidates.length !== 1) {
      throw new Error(
        `HEAD 停在小队命名空间分支「${branch}」（崩溃残留：批次收尾会把主工作树检出到集成分支），` +
          `而本仓库有 ${candidates.length} 条非小队分支` +
          `${candidates.length > 0 ? `（${candidates.join(" / ")}）` : ""}：无法唯一确定 base 分支。` +
          "请在 deps.baseBranch 里显式给出。**不猜**：猜错会把整批成果合到一个无关的分支上，且不报错。",
      );
    }
    return candidates[0]!;
  }
  return branch;
}

/**
 * 把队长简报渲染成给队长的 prompt（三段，各带 `##` 标题）。
 *
 * 做成**导出的纯函数**而不是 runtime 的方法：host 的派发桥要拼这一段文本，
 * 若挂在 runtime 上，它为了一段字符串得先把整个 runtime（含 git、五个工作树工具）建出来。
 */
export function renderLeaderBriefingPrompt(briefing: SquadBriefing): string {
  const roster = briefing.roster
    .map((member) => `- ${member.agentId}${member.role ? `（${member.role}）` : ""}`)
    .join("\n");
  const instructions = Object.entries(briefing.instructions)
    .map(([slot, value]) => `- ${slot}: ${value}`)
    .join("\n");
  // 次序固定：先是谁、再是机制、最后是用户意图——读的人按这个次序建立模型。
  return [
    "## 花名册",
    roster,
    "",
    "## 操作协议",
    briefing.protocol,
    "",
    "## 队长指令",
    instructions,
  ].join("\n");
}

/**
 * 按目标 workspace **现构**一个 runtime（裁定 4 + 确认 3）。不缓存、不留 promise：
 * 组合根每个使用点建一个，方法返回后不再保留（陈旧与失效逻辑因此在构造上不存在）。
 *
 * **装配顺序**（`lifecycle` 的自引用问题）：① git + 仓库根；② 五个工作树工具；③ squad 台账 repo；
 * ④ 工作项服务（带内部事件出口）；⑤ `createRunLifecycle`；⑥ 拼成 runtime。
 * `lifecycle` **不得**在 ②⑤ 之前建（它要用两者的产物），而 `lifecycle` 又不能收 `SquadRuntime`
 * 本身（自引用），故它只收自己那几件零件。
 */
export async function createSquadRuntime(deps: SquadRuntimeDeps): Promise<SquadRuntime> {
  const { db, workspacePath, workspaceIdentity } = deps;

  // ① git：面向 worktree/merge 的薄壳 runner（失败也返回 code/stdout/stderr，含义由调用点定）。
  const git = createGitRunner();
  // ② 五个工作树工具。base 分支在这里解析一次，之后所有分支动作（建树 / 集成分支派生）都用它。
  const worktreeManager = createWorktreeManager({ git, repoRoot: workspacePath });
  const branchAllocator = createBranchAllocator({ manager: worktreeManager });
  const baseBranch = await resolveBaseBranch(git, workspacePath, deps.baseBranch);
  const integrationMerger = createIntegrationMerger({
    git,
    repoRoot: workspacePath,
    base: baseBranch,
  });
  const orphanReaper = createOrphanReaper({
    manager: worktreeManager,
    repoRoot: workspacePath,
    // 两个 dep 由调用方绑定成单参（P2a 契约）：两处共用同一份实现，免得 `git branch -D` 分叉。
    deleteBranch: (branch) => deleteBranch(git, workspacePath, branch),
    // 按**分支名前缀**问 git 枚举短名（如 `squad/member/`）；失败**抛**而不是给空数组 ——
    // 空数组会让回收器以为「没有残枝」，把该清的清不掉还说成功了。
    listBranches: async (prefix) => {
      const result = ensureGitRunSucceeded(
        `git for-each-ref refs/heads/${prefix}`,
        await git(["for-each-ref", "--format=%(refname:short)", `refs/heads/${prefix}`], {
          cwd: workspacePath,
        }),
      );
      return result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    },
  });

  // ③ 台账 / 工作项 / 唤醒规则三个 repo：**同一条** db（recon.md F3：另开连接会跳过迁移与回填）。
  const squadRunRepo = createSquadRunRepo(db);
  const workItemRepo = createWorkItemRepo(db);
  const wakeRuleRepo = createWakeRuleRepo(db);
  // 收件箱台账（P2c）：同样落**同一条** db。编排器经 runtime.inboxItemRepo 直写（冲突发生在其内部），
  // 服务面经注入的懒取 repo 读写 —— 两处是**同一个** createInboxItemRepo，唯一写者不变。
  const inboxItemRepo = createInboxItemRepo(db);

  // ④ 工作项服务的事件出口**唯一**：内部订阅表。emit 只在这里转发，调用方拿
  //    `subscribeWorkItemEvents` 挂订阅（不得去读 repo 轮询——轮询会漏掉「刚刚那一次」的时序信息）。
  const subscribers = new Set<(event: WorkItemEvent) => void>();
  /** 唯一的扇出实现：状态变迁（`workItemService` 的 emit）与派发请求（下面的 `emitWorkItemEvent`）
      走**同一处**，免得两条事件流各写一份遍历（选哪套、谁先到就无人能说清）。 */
  const fanout = (event: WorkItemEvent): void => {
    for (const handler of subscribers) handler(event);
  };
  const workItemService = createWorkItemService({
    repo: workItemRepo,
    emit: fanout,
  });

  // ⑤ lifecycle：只收零件（不收 runtime 本身，避免自引用）。
  const lifecycle = createRunLifecycle({
    squadRunRepo,
    workItemService,
    baseBranch,
    branchAllocator,
    integrationMerger,
    orphanReaper,
    boundWorkspace: { path: workspacePath, identity: workspaceIdentity },
  });

  // ⑥ 拼成 runtime。定义根都从目标 workspace 派生（实验命名空间 `<ws>/.zcode/squad/`）。
  const teamAgentService = createTeamAgentService({ root: resolveSquadAgentRoot(workspacePath) });
  const squadService = createSquadService({
    root: resolveSquadDefinitionRoot(workspacePath),
    teamAgentRoot: resolveSquadAgentRoot(workspacePath),
  });

  return {
    workItemRepo,
    wakeRuleRepo,
    squadRunRepo,
    inboxItemRepo,
    workItemService,
    teamAgentService,
    squadService,
    git,
    worktreeManager,
    baseBranch,
    branchAllocator,
    integrationMerger,
    orphanReaper,
    boundWorkspace: { path: workspacePath, identity: workspaceIdentity },
    /**
     * 门禁的**唯一实现**（spec §5.7.6 / 确认 2）：关闭 ⇒ 拒这次的**新**派发，抛稳定码错误。
     *
     * 「不中断在途 run」不是靠额外判断，而是靠本方法**什么都不做**：它只读一次注入的开关结论、
     * 只抛错——不取消会话、不动任何 `squad_runs` 行、不碰工作树。要中断在途 run，得先有别的代码
     * 去写台账；本方法连那条路径都没有。
     */
    async assertDispatchEnabled() {
      if (deps.readExperimentEnabled() !== true) {
        throw new SquadDispatchDisabledError();
      }
    },
    lifecycle,
    subscribeWorkItemEvents(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
    /** 发射侧：与 `subscribeWorkItemEvents` 共用同一张表（`fanout`）——见 `squadContracts.ts` 的说明。 */
    emitWorkItemEvent(event) {
      fanout(event);
      /* **派发请求**（改完负责人后发的 `workitem.dispatch_requested`：队长派单工具与 UI 改派都经它）
         另发一份到注入的 `dispatchRequestHub`：实例级订阅表在 runtime 内部、常驻侧订不到（runtime 按目标
         现构，2026-10-02 第 2 轮裁定），故这一格必须由 hub 承载才能真的开 run。
         载荷是 `assignee`（类型 + id，小队也能是被派发对象）—— 见 `SquadDispatchRequest` 的详注；
         请求里不含 `user`：指派给人的事件根本不带派发请求（服务面只在 agent / squad 时发这条事件）。
         只对这一种事件 publish（状态变迁事件的消费方在实例内，没必要进常驻 hub）；
         `workspacePath/Identity` 取 runtime 的**绑定值**——不是调用方传进来的，避免在错的 workspace 上开 run。 */
      if (event.kind === "workitem.dispatch_requested" && deps.dispatchRequestHub) {
        deps.dispatchRequestHub.publish({
          workItemId: event.workItemId,
          assignee: event.assignee,
          workspacePath,
          workspaceIdentity,
        });
      }
    },
    /**
     * 只清本域自持的东西（事件订阅表）。**不关 db**：连接是 `taskIndexRepo` 的，
     * 由 node.ts 的关闭链统一登记（recon.md F6）——在这里再 close 一次会在 dispose 时
     * 二次关闭同一条连接（而本 runtime 会被构造成很多份，每一份都关一次就是明显的 bug）。
     */
    dispose() {
      subscribers.clear();
    },
  };
}

/**
 * 归档小队 + 指派转交队长（spec §3.10 / §16 S10 / #9）。
 *
 * 为什么转交不放进 `SquadService.archive`：那会改动 `SquadService` 的冻结无依赖签名（F8），
 * 而它今天只有两个定义根目录、拿不到工作项。组合放在这里，`SquadService` 保持「只管花名册」。
 *
 * **次序：先转交、后归档。** 理由在崩溃恢复上：转交是幂等的（重复调用时
 * `listByAssignee` 返回空集），而 `archive` 对**已归档**行会早退——若把转交藏在 archive 里，
 * 「归档完成了、转交没落」的残局就永远修不回来（再调一次也是早退）。反过来先转交后归档，
 * 中途崩溃最坏是「指派已经给了队长、小队还没归档」，再调一次即可收敛。
 *
 * 排班（`WakeRule`）侧本阶段**不动**：规则的触发条件里没有 squad 字段，
 * 「派发给谁」这件事只由工作项的 `assignee` 表达，所以转交的对象就是 `assignee`。
 */
export async function archiveSquadAndTransfer(
  runtime: SquadRuntime,
  squadId: string,
): Promise<void> {
  const squad = runtime.squadService.get(squadId);
  if (!squad) {
    throw new Error(
      `小队不存在：${squadId}。静默当作「已归档」会让调用方以为转交完成了，而库里仍有指向它的指派。`,
    );
  }

  for (const item of runtime.workItemRepo.listByAssignee("squad", squadId)) {
    // 未命中（恰在期间被归档）就抛：调用方以为转交完成了，而库里仍指着旧对象。
    if (!runtime.workItemRepo.updateAssignee(item.id, { type: "agent", id: squad.leaderAgentId })) {
      throw new Error(
        `转交失败：工作项 ${item.id} 在转交过程中不再可写（已被归档或删除），` +
          "此时它对已归档小队的指派仍然存在",
      );
    }
  }

  runtime.squadService.archive(squadId);
}
