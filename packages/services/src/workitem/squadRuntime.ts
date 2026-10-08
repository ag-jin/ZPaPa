import { resolveTeamAgentMaxConcurrentRuns, resolveWorkspaceKey } from "@zcode/shared";
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
import { createInboxChannelDelivery } from "./inboxChannelDelivery.js";
import { createInboxItemRepo } from "./inboxItemRepo.js";
import { createDefaultPullRequestProvider } from "./pullRequestProvider.js";
import { createPullRequestSync } from "./pullRequestSync.js";
import type { SquadRunLifecycle, SquadRuntime, SquadRuntimeDeps } from "./squadContracts.js";
import { createRunLifecycle } from "./squadRunLifecycle.js";
import { createSquadRunRepo } from "./squadRunRepo.js";
import { createSquadDeferredDispatchRepo } from "./squadDeferredDispatchRepo.js";
import { SquadDispatchDisabledError } from "./squadRuntimeService.js";
import { createWorkItemActivityRepo } from "./workItemActivityRepo.js";
import { createWorkItemActivityProjector } from "./workItemActivityProjector.js";
import { createWorkItemDeliverableRecorder } from "./workItemDeliverableRecorder.js";
import { createWorkItemDeliverableRepo } from "./workItemDeliverableRepo.js";
import { createWorkItemPullRequestRepo } from "./workItemPullRequestRepo.js";
import { createWorkItemRepo } from "./workItemRepo.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  createSubscriberFactRecorder,
  subscriberFactsForAssigneeChange,
} from "./subscriberFacts.js";
import { createWorkItemService, type WorkItemEvent } from "./workItemService.js";
import { createWorkItemSubscriberRepo } from "./workItemSubscriberRepo.js";
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

/* SUB.1：订阅事实落库失败的留痕口（订阅行是派生投影，失败只 warn、不回滚主事实）。 */
const subscriberLogger = createServiceLogger("work-item-subscribers");

/* SUB.3b：渠道推送失败的留痕口（推送是 Inbox 行的副本，失败只 warn、不回滚登记）。
   与 bots 域的 warn-once 各司其职：那一层记「跳过的原因」，这一层记「编排/解析这一步的异常」。 */
const inboxChannelLogger = createServiceLogger("inbox-channel-delivery");

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
 *
 * **lazy Git capability（2026-10-04 第 50 轮）**：base 分支**不在构造期**解析。工作项/花名册/
 * 台账/收件箱都是 SQLite 事实，读它们不需要 git；而组合根对服务面每一次调用都现构 runtime ⇒
 * 构造期急切解析会让非 git 目录上连 `getSnapshot`（工作项页首屏读）都崩在
 * `git symbolic-ref` 退出码 128。修法边界：只读/配置操作非 git 目录必须可用；派发 / 工作树 /
 * 审查合并 / 抛弃等 **git-dependent** 动作首次执行时才解析 base（并发调用共享同一个
 * 初始化 Promise —— 失败也共享，故两个并发的 git 动作拿到**同一个** Error 实例）；
 * 解析规则本身一条不动：显式 `deps.baseBranch` > HEAD 解析 > 小队命名空间分支崩溃残留时
 * 用唯一非小队分支（候选不唯一则抛），**绝不猜 "main"**。
 */
export async function createSquadRuntime(deps: SquadRuntimeDeps): Promise<SquadRuntime> {
  const { db, workspacePath, workspaceIdentity } = deps;

  // ① git：面向 worktree/merge 的薄壳 runner（失败也返回 code/stdout/stderr，含义由调用点定）。
  const git = createGitRunner();
  // ② 五个工作树工具（构造期全部纯函数，不起子进程）。base 分支在首个 git-dependent 动作时
  //    才解析一次，之后所有分支动作（建树 / 集成分支派生）都用它 —— 见下面 `gitCapability`。
  const worktreeManager = createWorktreeManager({ git, repoRoot: workspacePath });
  const branchAllocator = createBranchAllocator({ manager: worktreeManager });

  /* **lazy Git capability 的唯一接缝**：把「base 解析 + 拿 base 的那三个工具（merger / lifecycle /
     orchestrator 用的 allocator 参数）」收敛成**一个** Promise，首次 git-dependent 动作时兑现。
     - 去重：`resolveGitDeps` 被 N 个并发调用 ⇒ 全部 await **同一个** promise（失败也共享，
       非 git 目录上两个并发动作拿到同一 Error 实例，不重复起子进程）。
     - 成功后 memoize：本 runtime 生命周期内 base 只解析一次（与修前「构造期解析一次」同代价）。
     - 什么算 git-dependent：开树派生分支（`openMemberRun`）、集成分支派生（`ensureIntegration` /
       `mergeMember`）、审查合并（`reviewMemberRun` 的 approved 支）、摘树删分支（`discardMember` /
       `discardMemberRun`）、启动回收（`reapStartupOrphans`）。台账登记（`recordLeaderRun` /
       `bindMemberRunSession` / `failMemberRun` / `completeMemberRun`）与全部只读面**不走**这里。 */
  const gitDeps = async (): Promise<{
    baseBranch: string;
    integrationMerger: ReturnType<typeof createIntegrationMerger>;
    lifecycle: SquadRunLifecycle;
  }> => {
    if (resolved === null) {
      resolved = (async () => {
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
        const lifecycle = createRunLifecycle({
          squadRunRepo,
          workItemService,
          baseBranch,
          branchAllocator,
          integrationMerger,
          orphanReaper,
          boundWorkspace: { path: workspacePath, identity: workspaceIdentity },
          /* C3 并发闸的上限读取点（唯一实现）：名册缺席 ⇒ undefined ⇒ 不闸照旧派发（A5，
             不得凭空套缺省 6）。闭包前向引用下方 `teamAgentService`（:253 处 const）：
             本函数只在首个 lifecycle 调用时执行，那时构造已完成，无 TDZ 风险。 */
          resolveAgentMaxConcurrentRuns: (agentId) => {
            const agent = teamAgentService.list().find((candidate) => candidate.id === agentId);
            return agent === undefined ? undefined : resolveTeamAgentMaxConcurrentRuns(agent);
          },
          runSettlementHub: deps.runSettlementHub,
          /* C3b.2：run / worktree 七枚的投影面 —— 与工作项族共用**同一个**投影器（同一条 db）：
             lifecycle 在 opened 出口与 settleStatus 收口之后把「行 + 意图」交给它，键形状只在它那里。 */
          activityProjector,
          /* #7 D1b：run 级交付物捕获的唯一调用点（approved 臂，合并成功后、分支被删之前）。
             lifecycle 只交「拿到手的台账行 + base」，diff 怎么算/存哪/怎么回声全在登记面里。 */
          deliverableRecorder,
          squadDeferredDispatchRepo,
          /* C1：残行判据要的 git 事实（「这条 run 的分支上有没有活树」）——工作树的唯一所有者是
             `WorktreeManager`，故只从它取，不在台账上推断（见 `listWorktrees` 的接口注释）。 */
          listWorktrees: () => worktreeManager.list(),
          /* C1：分支 ref 是否已存在（「残枝」= 有分支没工作树）。`rev-parse -q --verify` 的退出码
             就是答案：0 = 存在；非 0 = 不存在（**不猜**：命令本身失败也按 false 之外的处理没有意义，
             这里只回答存在性，git 层异常在 code!=0 上无法与「不存在」区分，故用 --verify 的语义）。 */
          branchRefExists: async (branch) => {
            const result = await git(["rev-parse", "-q", "--verify", `refs/heads/${branch}`], {
              cwd: workspacePath,
            });
            return result.code === 0;
          },
        });
        return { baseBranch, integrationMerger, lifecycle };
      })();
    }
    return resolved;
  };
  /** memoized 初始化（null = 还没有任何 git-dependent 动作来过）。 */
  let resolved: Promise<{
    baseBranch: string;
    integrationMerger: ReturnType<typeof createIntegrationMerger>;
    lifecycle: SquadRunLifecycle;
  }> | null = null;

  // ③ 台账 / 工作项 / 唤醒规则三个 repo：**同一条** db（recon.md F3：另开连接会跳过迁移与回填）。
  const squadRunRepo = createSquadRunRepo(db);
  // R2：deferred 重放义务表（与 squad_runs 同一条 db；资格判据与排队不同故分表）。
  const squadDeferredDispatchRepo = createSquadDeferredDispatchRepo(db);
  const workItemRepo = createWorkItemRepo(db);
  const wakeRuleRepo = createWakeRuleRepo(db);
  /* SUB.3b：本 runtime 的 workspace 键**只算一次** —— 订阅读写（收件人解析）与推送目标必须是同一条
     式子（identity 去空白优先，否则 path）。两处各拼一次时，「推到另一个 workspace 的渠道」
     不会报错，只会安静地推错人。 */
  const boundWorkspaceKey = resolveWorkspaceKey({ workspacePath, workspaceIdentity });
  /* SUB.1：订阅关系（`work_item_subscribers`）的**唯一**存储面 + **绑定到本 workspace** 的事实出口。
     两个「负责人」写者（`applyWorkItemAssignee` / 归档转交）与门面的手动订阅都经它报事实；
     事实→reason 的映射与落库判据在 `subscriberFacts`（runtime 只负责把「哪张 workspace」钉死）。
     失败只留痕（订阅行是派生投影，不回滚主事实）——见 recorder 的失败面说明。 */
  const subscriberRepo = createWorkItemSubscriberRepo(db);
  const subscriberFacts = createSubscriberFactRecorder(
    subscriberRepo,
    { key: boundWorkspaceKey, path: workspacePath },
    (message, error) => subscriberLogger.warn(message, { error }),
  );
  /* SUB.3b：**渠道只读推送的编排器**（本 runtime 一份，绑定本 workspace）。
     它只回答「推不推、推什么」（判据全在 `inboxNotificationPolicy` —— 本层零自判），出站口由组合根
     注入（不注入 ⇒ 零出站）；收件人解析读的两口就在这一层：订阅行取本 runtime 的 workspace 键，
     父链取工作项树（`get` 过滤归档行 ⇒ 上溯在归档处自然停下）。 */
  const inboxChannelDelivery = createInboxChannelDelivery({
    target: {
      workspacePath,
      ...(workspaceIdentity.trim() ? { workspaceIdentity } : {}),
    },
    readSubscribers: (workItemId) => subscriberRepo.listByWorkItem(boundWorkspaceKey, workItemId),
    readParentId: (workItemId) => workItemRepo.get(workItemId)?.parentId ?? null,
    ...(deps.inboxChannelPush !== undefined ? { push: deps.inboxChannelPush } : {}),
    warn: (message, error) => inboxChannelLogger.warn(message, { error }),
  });
  // 收件箱台账（P2c）：同样落**同一条** db。编排器经 runtime.inboxItemRepo 直写（冲突发生在其内部），
  // 服务面经注入的懒取 repo 读写 —— 两处是**同一个** createInboxItemRepo，唯一写者不变。
  //
  // SUB.3b：**唯一挂接点**（`insertIfAbsent === true` 时通知编排器）装在这一个构造点上 ——
  // 全仓的条目写入（批次编排器 / 服务面 / SUB.2 通知口）都经过它，故不会漏推、也不会推两次。
  const inboxItemRepo = createInboxItemRepo(db, {
    onInserted: (item) => inboxChannelDelivery.notifyInserted(item),
  });
  /* Activity 投影器（C3b.1）：`work_item_activities` 的第三个写者（前两个：CommentService / DecisionService），
     与它们共用同一份 repo 契约（dedupKey 幂等 + 闭集双闸 + sequence 原子）—— repo 仍是唯一存储写者。
     **恒构造**（接线钉死测试钉住）：漏接的表现是「时间线永远只有评论」，而一路不报错。 */
  const activityProjector = createWorkItemActivityProjector({
    activities: createWorkItemActivityRepo(db),
  });
  /* #7 D1b：交付物**登记面**的唯一构造点（存储面 repo + git 侧捕获 + 第 20 枚回声三半在此装配）。
     与投影器同一处口径（恒构造、只此一处）：漏接的表现是「合并照常、交付物永远没有」，
     而全链不报错 —— 正是本域反复出现的静默缺口形态。 */
  const deliverableRepo = createWorkItemDeliverableRepo(db);
  const deliverableRecorder = createWorkItemDeliverableRecorder({
    git,
    repo: deliverableRepo,
    workspace: {
      /* workspace_key 口径与台账/快照**同一处**算法（C14：identity 去空白优先，否则 path），
         自己拼一遍会让「交付物按 workspace 过滤」与其它面悄悄对不上。 */
      key: resolveWorkspaceKey({
        workspacePath,
        workspaceIdentity,
      }),
      path: workspacePath,
    },
    projector: activityProjector,
  });

  /* #8 D2：PR 关联 + 快照的三件（存储面 / 读数面 / 同步深模块）在**这里**装配一次。
     · provider 的 token 读取口缺省 = 恒未配置 ⇒ null adapter（离线缺省形态，不必特判）；
     · 快照的 head-SHA 防陈旧写在 repo 的 CAS 里，同步模块只负责把它报出来（不静默）；
     · 本层**不做**任何工作项状态迁移（D2 边界）：D3 消费 pullRequestSync 报出的 mergedPullRequests。 */
  const pullRequestRepo = createWorkItemPullRequestRepo(db);
  const pullRequestProvider = createDefaultPullRequestProvider({
    readToken: deps.readGithubPullRequestToken ?? (() => undefined),
    ...(deps.githubFetch !== undefined ? { fetchImpl: deps.githubFetch } : {}),
  });
  const pullRequestSync = createPullRequestSync({
    provider: pullRequestProvider,
    repo: pullRequestRepo,
    workspace: {
      key: resolveWorkspaceKey({
        workspacePath,
        workspaceIdentity,
      }),
    },
  });

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
    // 状态变迁的投影跟随唯一写者（C3b.1）：三个生产调用点自动全覆盖，零新增判据。
    activityProjector,
    // SUB.1：创建事实（creator + 创建时的 assignee）经唯一 reconciler 落订阅行。
    subscribers: subscriberFacts,
  });

  // ⑥ 拼成 runtime。定义根都从目标 workspace 派生（实验命名空间 `<ws>/.zcode/squad/`）。
  const teamAgentService = createTeamAgentService({ root: resolveSquadAgentRoot(workspacePath) });
  const squadService = createSquadService({
    root: resolveSquadDefinitionRoot(workspacePath),
    teamAgentRoot: resolveSquadAgentRoot(workspacePath),
  });

  // git-dependent 动作的门面：`runtime.lifecycle` 的**所有**方法都先过 `gitDeps()`。
  // 用 Proxy 而不是手写十个转发：手写版每加一个 lifecycle 方法就要记得同步一份，
  // 漏掉的那一个会**静默绕过**门面（在非 git 目录上直接拿未初始化的零件跑）——
  // Proxy 按整对象包装，新方法默认就接上门面，漏接在结构上不可能。
  //   · 非 git 目录：首个 lifecycle 调用就抛「需要 git 仓库」—— 对 `computeActiveBranches` 这类
  //     只查台账的方法偏严格，但 getSnapshot 不经这里（服务面直接用 repo），实际只读面不受影响；
  //   · 刻意保守（不抄「哪个方法真的不碰 git」的判据进 runtime）：漏接一格的代价是
  //     **静默在错的 workspace 上动 git**，多拦一格的代价只是一条响亮报错。
  const lazyLifecycle: SquadRunLifecycle = new Proxy({} as SquadRunLifecycle, {
    get(_target, prop: string | symbol) {
      return async (...args: unknown[]) => {
        const { lifecycle } = await gitDeps();
        const method = (lifecycle as unknown as Record<string, unknown>)[prop as string];
        if (typeof method !== "function") {
          throw new Error(
            `SquadRunLifecycle 上不存在方法「${String(prop)}」：runtime 的 lifecycle 门面只代理方法。`,
          );
        }
        return method.apply(lifecycle, args);
      };
    },
  });
  // `integrationMerger` 同理（`reviewMemberRun` approved 支之外唯一的合入入口；runtime 契约上的
  // 直访面）。方法集是**冻结**的五个，逐个转发（不用 Proxy：merger 的返回类型不是清一色 Promise<void>，
  // 逐个转发保留精确签名，调用方（含测试对 conflict/branch_missing 的精确断言）不需要改读法）。
  const lazyIntegrationMerger: ReturnType<typeof createIntegrationMerger> = {
    ensureIntegration: async (branch: string) => {
      const { integrationMerger } = await gitDeps();
      return integrationMerger.ensureIntegration(branch);
    },
    mergeMember: async (input: { integration: string; member: string }) => {
      const { integrationMerger } = await gitDeps();
      return integrationMerger.mergeMember(input);
    },
    finalize: async (input: { integration: string; target: string }) => {
      const { integrationMerger } = await gitDeps();
      return integrationMerger.finalize(input);
    },
    discardMember: async (input: { branch: string; dirName: string }) => {
      const { integrationMerger } = await gitDeps();
      return integrationMerger.discardMember(input);
    },
    discardIntegration: async (input: { integration: string; target: string }) => {
      const { integrationMerger } = await gitDeps();
      return integrationMerger.discardIntegration(input);
    },
  };

  return {
    workItemRepo,
    wakeRuleRepo,
    squadRunRepo,
    squadDeferredDispatchRepo,
    inboxItemRepo,
    workItemService,
    activityProjector,
    deliverableRepo,
    deliverableRecorder,
    subscriberRepo,
    subscriberFacts,
    pullRequestRepo,
    pullRequestProvider,
    pullRequestSync,
    /* #8 D3：整批收尾模式的现判读取口（缺省 local = 行为与改前一致）；编排器在收尾那一刻取一次。 */
    readSquadMergeMode: () => deps.readSquadMergeMode?.() ?? "local",
    teamAgentService,
    squadService,
    git,
    worktreeManager,
    branchAllocator,
    integrationMerger: lazyIntegrationMerger,
    /** 见 `SquadRuntimeDeps`/契约：lazy base 解析的唯一谱面（git-dependent 动作内部已接同一份初始化）。 */
    resolveBaseBranch: async () => (await gitDeps()).baseBranch,
    /**
     * **测试专用**（`__test-` 前缀，不进契约）：门面解析后的底层 lifecycle。
     * 唯一用途是「按仓库串行」那条测试要往底层方法上打补丁（门面是 Proxy，不可写）。
     * 生产代码**不得**绕过门面直取底层对象 —— 那等于绕过「非 git 目录显式报错」这道闸。
     */
    __testUnderlyingLifecycle: async () => (await gitDeps()).lifecycle,
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
    lifecycle: lazyLifecycle,
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
         载荷是 `assignee`（类型 + id，小队也能是被派发对象）与 `cause`（成因：队长工具 / UI 改派）
         —— 见 `SquadDispatchRequest` 的详注；
         请求里不含 `user`：指派给人的事件根本不带派发请求（服务面只在 agent / squad 时发这条事件）。
         只对这一种事件 publish（状态变迁事件的消费方在实例内，没必要进常驻 hub）；
         `workspacePath/Identity` 取 runtime 的**绑定值**——不是调用方传进来的，避免在错的 workspace 上开 run。 */
      if (event.kind === "workitem.dispatch_requested" && deps.dispatchRequestHub) {
        deps.dispatchRequestHub.publish({
          workItemId: event.workItemId,
          assignee: event.assignee,
          // 成因**原样转发**（服务面在事件源头就分好：队长工具 / UI 改派）：本层不二次判定。
          cause: event.cause,
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
    /* 投影（C3b.1）：与 `applyWorkItemAssignee` **共用同一份判据**（两处写者、一份形状）。
       `from` 是转交前拿在手里的旧值；**不带 cause** —— 归档转交不是派发，不发明闭集外的成因。 */
    runtime.activityProjector.assigneeChanged({
      item,
      from: item.assignee,
      to: { type: "agent", id: squad.leaderAgentId },
    });
    /* 订阅事实（SUB.1）：转交也是一次负责人变化 —— 与 `applyWorkItemAssignee` 共用同一份
       事实→reason 映射（`cause="squad_archived_transfer"` ⇒ assignee；小队行撤销、队长行入册）。
       不在这里另判一格：两处各写一份的表现是「同一次转交在两张表里留下不同的关系」。 */
    for (const fact of subscriberFactsForAssigneeChange({
      from: item.assignee,
      to: { type: "agent", id: squad.leaderAgentId },
      cause: "squad_archived_transfer",
    })) {
      runtime.subscriberFacts({ workItemId: item.id, fact });
    }
  }

  runtime.squadService.archive(squadId);
}
