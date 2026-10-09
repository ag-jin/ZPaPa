import { isTerminalWorkItemStatus, resolveWorkspaceKey } from "@zcode/shared";
import { normalizeGitHubPullRequestUrl } from "./pullRequestProvider.js";
import type { PullRequestSyncReport } from "./pullRequestSync.js";
import type { SquadRuntime } from "./squadContracts.js";
import type { AuthorRef } from "./workItemCommentRepo.js";
import { pullRequestLinkId, type PullRequestRecord } from "./workItemPullRequestRepo.js";

/* #8 D2：PR 关联三入口（link / unlink / refresh）的**实现面** —— 从协作门面里单独成文件。

   为什么不是门面里的一段方法（与 `createCommentService` / `createDecisionService` 的委托同一条理由）：
   门面必须保持**浏览器安全 + 薄**（它是描述符模块，renderer 经它取数），而这三口要碰
   runtime 的三件（repo / provider / sync）与 URL 归一化。放在这里，门面只剩三行转发，
   实现有唯一的测试缝合线（本模块可直接用真 repo + fake provider 驱动）。

   三条纪律（承设计 §4.2 的服务面口径）：
   · **URL 归一化是入库前的唯一判据**：非 GitHub PR 地址响亮抛，不静默降级成普通链接；
   · **工作项必须存在、且属于本次目标 workspace**（`requireOwnedWorkItem`）：静默建行会把一条关联
     挂到不存在的对象上，而界面上它看起来记下了；
   · **归因 = 组合根注入的本地人类**（actor 由门面传入，本模块不猜身份）。

   本文件保持浏览器安全（对 node 侧零值导入）：门面值导入它的三个导出不会把 node 侧带进 renderer 包。 */

/**
 * 「工作项必须存在、且属于本次目标 workspace」的**唯一判据**
 * （D1b 的交付物登记与 D2 的 PR 三口共用同一道）：
 * · 不存在/已归档 ⇒ 响亮抛；· 属于别的 workspace ⇒ 响亮抛（§8.5）。
 * `action` 只进报错文案（哪种操作被拒要一眼看出来）。
 */
export function requireOwnedWorkItem(
  runtime: SquadRuntime,
  workspaceKey: string,
  workItemId: string,
  action: string,
) {
  const item = runtime.workItemRepo.get(workItemId);
  if (!item) {
    throw new Error(
      `${action}失败：工作项「${workItemId}」不存在或已归档 —— ` +
        "链接必须挂在一条可寻址的工作项上，静默建行会让它看起来记下了却查不回。",
    );
  }
  /* workspace key 的算法与其它面**同一处**（C14：identity 去空白优先，否则 path）——
     这里不自己拼表达式（自拼一份迟早与 `resolveWorkspaceKey` 分叉，而分叉不报错）。 */
  const itemKey = resolveWorkspaceKey({
    workspacePath: item.workspacePath,
    workspaceIdentity: item.workspaceIdentity,
  });
  if (itemKey !== workspaceKey) {
    throw new Error(
      `工作项「${workItemId}」属于 workspace「${itemKey}」，与本次目标的「${workspaceKey}」不一致：` +
        "跨 workspace 引用一律响亮拒绝（§8.5）。",
    );
  }
  return item;
}

/** 读数面可用性（同步判据）：接口形状里 `available: false` 必带原因，故这里做一次归一。 */
export function pullRequestProviderAvailability(runtime: SquadRuntime): {
  available: boolean;
  reason: string | null;
} {
  const status = runtime.pullRequestProvider.describe();
  return status.available
    ? { available: true, reason: null }
    : { available: false, reason: status.reason };
}

export interface WorkItemPullRequestEntry {
  /** 登记一条关联（URL 归一化 + 幂等落行 + 归因）；**不发网络请求**（按需拉取）。 */
  link(input: { workItemId: string; url: string; title?: string }): PullRequestRecord;
  /** 解除一条关联（真删）。`false` = 本来就没有（不是错误）；跨 workspace ⇒ 响亮抛。 */
  unlink(input: { pullRequestId: string }): boolean;
  /**
   * 按需刷新该工作项下全部已链接 PR 的快照（唯一快照写入口），随后执行**终态驱动**（#8 D3）。
   * 报告形状不变（D2 的四档 + `mergedPullRequests` 读出）；状态迁移不经报告返回 ——
   * 读的人（UI）在动作之后重读工作项即可。
   */
  refresh(input: { workItemId: string }): Promise<PullRequestSyncReport>;
}

/**
 * **PR merge 驱动终态**（#8 D3，设计 §4.2 的次序硬约束）：快照刷新之后，若报出 merged 事实、
 * 且工作项正等验收（`in_review`）⇒ 经 `WorkItemService.transition` 转 `done`
 * （**唯一写者不变**：本模块不碰 repo 的 `updateStatus`，也不自己拼状态）。
 *
 * 四条边界（都在代码里看得见）：
 * ① **已终态**（done/cancelled）：跳过终态判定（快照照刷）—— 终态不因外部信号回退或改写；
 * ② **非终态但不是 in_review**（todo/in_progress/blocked）：**不动**。PR merged 只对「等验收」的工作项
 *    构成终态信号；把 `todo` 的工作项直接送 `done` 会跨过整条执行链（谁做的、做完了吗，无人回答）；
 * ③ **CAS 未命中**（读到 in_review、写入时已被别的写者改动 —— 多窗口 Host 共库的真实形态）：
 *    **不抛、不覆盖**，留一条 warn。同 `completeMemberRun` 的纪律（spec §5.7 第 5 项「不匹配则丢弃」）：
 *    库里已经有一份合理的结论，抢写会把别人的结算次序抹掉；
 * ④ **多条 merged PR 同时在报**：只由**第一条**驱动（`mergedPullRequests` 按 `created_at, id` 主序），
 *    其余不各留一枚回声 —— 回声是「谁驱动了终态」的证据，一次终态只有一个驱动者。
 *
 * 回声（`pr_merged`）**只在 CAS 命中时**写：它是「这枚 PR 的合并驱动了这一格终态」的证据，
 * 不是「这条 PR merged」的复述（复述由快照列如实承载）。
 */
function driveWorkItemFromMergedPullRequests(deps: {
  runtime: SquadRuntime;
  workItemId: string;
  report: PullRequestSyncReport;
  logWarn: (message: string, error?: unknown) => void;
}): void {
  const { runtime, workItemId, report } = deps;
  if (report.mergedPullRequests.length === 0) return;

  /* 读**当时**状态（与 `requireOwnedWorkItem` 是两次读：这里要的是「此刻」的值，而 CAS 前置
     必须来自当时事实）。刷新入口已经校验过「存在且同 workspace」，这里的 null 只可能是
     刷新往返期间被归档/删除 —— 静默返回：那是别人的动作，本函数不该抢一个结论。 */
  const item = runtime.workItemRepo.get(workItemId);
  if (!item) return;
  if (isTerminalWorkItemStatus(item.status)) return;
  if (item.status !== "in_review") return;

  const driving = report.mergedPullRequests[0]!;
  if (!runtime.workItemService.transition(workItemId, "done", "in_review")) {
    deps.logWarn(
      `[pull-request] PR #${driving.prNumber} 已合并，但工作项 ${workItemId} 的终态 CAS 未命中：` +
        "读到前置「in_review」，写入时该行已被别的写者改动（多窗口共库）。丢弃这次判定、不覆盖别人的结论。",
    );
    return;
  }
  runtime.activityProjector.pullRequestMerged({
    workspaceKey: item.workspaceIdentity,
    workspacePath: item.workspacePath,
    workItemId,
    pullRequestId: driving.pullRequestId,
    prNumber: driving.prNumber,
    url: driving.htmlUrl,
  });
}

export function createWorkItemPullRequestEntry(deps: {
  runtime: SquadRuntime;
  /** 本次 runtime 的绑定 workspaceKey（调用方传的 target 不参与 key 计算）。 */
  workspaceKey: string;
  /** 归因身份（门面注入的本地人类；本模块不猜）。 */
  actor: () => AuthorRef;
  /** 登记时刻（门面注入的时钟；缺省 Date.now 在门面侧定）。 */
  now: () => number;
  /** 失败留痕口（缺省回落 `console.warn`，与投影模块同款手法）：目前只有终态 CAS 竞态用它。 */
  logWarn?: (message: string, error?: unknown) => void;
}): WorkItemPullRequestEntry {
  const { runtime, workspaceKey } = deps;
  // 缺省落 console.warn（服务日志面不是本模块依赖）；第二参数透传原始错误（同款纪律）。
  const logWarn =
    deps.logWarn ?? ((message: string, error?: unknown) => console.warn(message, error));

  return {
    link({ workItemId, url, title }) {
      /* URL 归一化是**服务面**的活（唯一判据）：非 GitHub PR 地址 ⇒ 响亮抛。
         静默把它降级成「一条普通链接」会让「这条关联指向什么」从此无人能答。 */
      const address = normalizeGitHubPullRequestUrl(url);
      const item = requireOwnedWorkItem(runtime, workspaceKey, workItemId, "登记 PR 关联");
      return runtime.pullRequestRepo.link({
        // id 由业务键确定性派生（同一条关联恒同一 id）；真正的幂等判据是表的唯一索引。
        id: pullRequestLinkId({
          workItemId: item.id,
          repoOwner: address.repoOwner,
          repoName: address.repoName,
          prNumber: address.prNumber,
        }),
        workspaceKey,
        workspacePath: item.workspacePath,
        workItemId: item.id,
        repoOwner: address.repoOwner,
        repoName: address.repoName,
        prNumber: address.prNumber,
        // 存**规范地址**（同一 PR 的各种页面写法收敛到一条关联）。
        htmlUrl: address.canonicalUrl,
        ...(title !== undefined ? { title } : {}),
        linkedBy: deps.actor(),
        createdAt: deps.now(),
      });
    },

    unlink({ pullRequestId }) {
      const existing = runtime.pullRequestRepo.get(pullRequestId);
      /* 不存在 ⇒ false（不是错误：界面上的陈旧条目不该让用户看到一次报错）。
         但**跨 workspace 的 id ⇒ 响亮抛**：静默删除别人的行是比报错坏得多的结局。 */
      if (!existing) return false;
      if (existing.workspaceKey !== workspaceKey) {
        throw new Error(
          `PR 关联「${pullRequestId}」属于 workspace「${existing.workspaceKey}」，` +
            `与本次目标的「${workspaceKey}」不一致：跨 workspace 引用一律响亮拒绝（§8.5）。`,
        );
      }
      return runtime.pullRequestRepo.unlink(pullRequestId);
    },

    async refresh({ workItemId }) {
      // 刷新前先确认工作项可寻址且同 workspace（否则「刷了但什么都没有」会看起来像「没有 PR」）。
      requireOwnedWorkItem(runtime, workspaceKey, workItemId, "刷新 PR 快照");
      /* 快照的写与读全在同步模块里（head-SHA 防陈旧写、按需触发、不静默）；
         本层只定「刷哪个工作项」，并把报告原样交给调用方（UI 的失败域与 D3 的口都吃它）。 */
      const report = await runtime.pullRequestSync.refreshForWorkItem({ workItemId });
      /* #8 D3：快照刷完之后的**终态驱动**（次序硬约束：先刷事实、再由事实推动状态；
         判定与边界见上面的函数注释）。报告不变 —— 状态迁移的读法是「重读工作项」。 */
      driveWorkItemFromMergedPullRequests({ runtime, workItemId, report, logWarn });
      return report;
    },
  };
}
