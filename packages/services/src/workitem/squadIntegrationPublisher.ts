import type { SquadPrGateDegradeCode } from "@zcode/shared";
import type { GitRunner } from "../worktree/gitRunner.js";
import { assertSafeSlug } from "../worktree/branchNaming.js";
import { SYSTEM_ACTIVITY_ACTOR } from "./workItemActivityProjector.js";
import type {
  CreatePullRequestInput,
  PullRequestProvider,
  RemotePullRequestFact,
} from "./pullRequestProvider.js";
import {
  pullRequestLinkId,
  type PullRequestRecord,
  type WorkItemPullRequestRepo,
} from "./workItemPullRequestRepo.js";

/* #8 D3 的**发布面**（设计 §4.4 的 `pr-gate` 行）：把一批已合入集成分支的成果发布成远端 PR。

   一个方法（`publishForReview`）：读 token → 读 remote → push 集成分支 → 开 PR（已存在则**认回**）
   → 登记关联行 + 首次快照。

   **为什么必须是深模块**：这五步在「收尾」「崩溃重驱」「将来的人工重试发布」三处都要做；删掉它，
   三处各自长出一份判据（先推哪条、无 remote 怎么办、422 算不算失败、认回按什么认），
   复杂度在 N 个调用点重现 —— 通过删除测试。

   三档结果，语义不同（调用方按 status 分派）：
   · `published`：远端 PR 已在，且本地关联行已登记（**此时才允许**把「本批已发布」当既成事实）；
   · `degraded`：**前置条件**不满足（没 token / 没 remote / remote 不是 GitHub）⇒ 调用方改走本地收尾，
     并在收件箱留痕说明为什么降级（**不静默**）。三档都在**任何远端写之前**判定；
   · `failed`：真失败（push 拒绝 / 开 PR 非 2xx）⇒ **响亮**：批次停手，不假装收尾成功
     （降级与失败必须分开：前者是「换一条路照常收尾」，后者是「这条路断了，需要人」）。

   次序硬约束（崩溃窗口，与本地模式的「先写落地事实、再做不可逆清理」同一条纪律）：
   **先把远端 PR 开出来、再把本地关联行写下** —— 本地行是「本批已发布」的唯一记录，
   重驱闸按它判「已收过尾」。两步之间崩溃的最坏结果是「远端有 PR、本地没行」：下一次重驱会再推一次
   （幂等，ref 更新为同一个值）并拿到 422，此时按 head 前缀**认回**那条已存在的 PR（见 `recoverExisting`）
   —— 收尾因此是收敛的，而不是每次重驱都响亮报错。 */

/** 降级的三档**码值**：闭集单源在 `@zcode/shared` 的 squad 域（Inbox 去重键与 UI 文案共用同一份）。 */
export type IntegrationPublishDegradeCode = SquadPrGateDegradeCode;

export type PublishIntegrationOutcome =
  | { status: "published"; pullRequest: PullRequestRecord }
  | { status: "degraded"; code: IntegrationPublishDegradeCode; reason: string }
  | { status: "failed"; reason: string };

export interface SquadIntegrationPublisher {
  /**
   * 把一批成果发布成远端 PR（**幂等**：远端已有同 head 的 PR ⇒ 认回它，不重复开）。
   * 不抛：三档结果都在返回值里（调用方按 `status` 分派；`failed` 由调用方响亮抛出）。
   */
  publishForReview(input: {
    workItemId: string;
    /** PR 标题的来源（父项标题；拿不到给 null ⇒ 回落 workItemId，同 Inbox 构建件的口径）。 */
    workItemTitle: string | null;
    /** head：本批的集成分支。 */
    integration: string;
    /** base：本批的 target 分支。 */
    target: string;
  }): Promise<PublishIntegrationOutcome>;
}

/**
 * 远程地址 → GitHub 的 `(owner, repo)`；不是 GitHub 形态 ⇒ `null`（调用方按降级处置，不猜）。
 *
 * 支持的书写（都是 git 里真实存在的形态）：`https://[www.]github.com/<owner>/<repo>[.git][/]`、
 * `git@github.com:<owner>/<repo>[.git]`（scp-like）、`ssh://git@github.com/<owner>/<repo>[.git]`。
 * 其余（本地路径、别的托管、形状不全）一律 null —— 猜 owner/repo 的代价是把 PR 开到别人的仓库里去。
 */
export function parseGitHubRemoteUrl(url: string): { repoOwner: string; repoName: string } | null {
  const raw = typeof url === "string" ? url.trim() : "";
  if (raw === "") return null;

  let owner: string | undefined;
  let repoRaw: string | undefined;
  const scpLike = /^[^@/\s]+@github\.com:(.+)$/.exec(raw);
  if (scpLike) {
    const segments = scpLike[1]!.split("/").filter((segment) => segment !== "");
    [owner, repoRaw] = segments;
    if (segments.length !== 2) return null;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    if (
      parsed.hostname.toLowerCase() !== "github.com" &&
      parsed.hostname.toLowerCase() !== "www.github.com"
    ) {
      return null;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:" && parsed.protocol !== "ssh:") {
      return null;
    }
    const segments = parsed.pathname.split("/").filter((segment) => segment !== "");
    if (segments.length !== 2) return null;
    [owner, repoRaw] = segments;
  }
  if (owner === undefined || repoRaw === undefined) return null;

  // `.git` 后缀是书写习惯，不是仓库名的一部分（剪掉它，别把 owner/widget.git 当仓库名）。
  const repoName = repoRaw.endsWith(".git") ? repoRaw.slice(0, -".git".length) : repoRaw;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner)) return null;
  // repo 位与 provider 的 URL 归一化同口径（字母数字、`-`、`_`、`.`）。
  if (!/^[A-Za-z0-9._-]+$/.test(repoName)) return null;
  return { repoOwner: owner, repoName };
}

/** 集成分支名进 git 参数前的闸门（与 `integrationMerge` 的 `assertSafeBranch` 同源：逐段过 `assertSafeSlug`）。 */
function assertSafeBranch(branch: string): void {
  for (const segment of branch.split("/")) {
    assertSafeSlug(segment);
  }
}

export function createSquadIntegrationPublisher(deps: {
  git: GitRunner;
  repoRoot: string;
  /** 本 runtime 绑定的 workspace（关联行按 workspace_key 隔离）。 */
  workspace: { key: string; path: string };
  provider: PullRequestProvider;
  repo: WorkItemPullRequestRepo;
  now?: () => number;
  logWarn?: (message: string, error?: unknown) => void;
}): SquadIntegrationPublisher {
  const now = deps.now ?? (() => Date.now());
  const logWarn = deps.logWarn ?? ((message: string) => console.warn(message));
  /** 推送目标：v1 钉 `origin`（约定俗成的默认远端；别的名字属于配置面，本轮不做）。 */
  const REMOTE_NAME = "origin";

  /**
   * 读**配置里**的 remote URL（`git config --get remote.<name>.url`）。
   *
   * 为什么不是 `git remote get-url <name>`：后者会施加 `url.<base>.insteadOf` 改写，返回的是
   * **改写后**的地址（镜像/代理配置下是本地路径），拿它去解析 GitHub owner/repo 会得到 null ⇒
   * 明明配着 GitHub 远端却被判成「不是 GitHub」。config 读的是用户写下的那份事实。
   */
  async function readRemoteUrl(): Promise<{ url: string } | { problem: string }> {
    const listed = await deps.git(["config", "--get", `remote.${REMOTE_NAME}.url`], {
      cwd: deps.repoRoot,
    });
    if (listed.code !== 0 || listed.stdout.trim() === "") {
      return {
        problem:
          `本仓库没有名为 ${REMOTE_NAME} 的远端（git config --get remote.${REMOTE_NAME}.url 退出码 ` +
          `${listed.code}）：pr-gate 需要把集成分支推到一个远端。` +
          (listed.stderr.trim() === "" ? "" : `git: ${listed.stderr.trim()}`),
      };
    }
    return { url: listed.stdout.trim() };
  }

  /**
   * 崩溃窗口的**认回**：创建 PR 返回 422（同 head 的 PR 已存在）时，按 head 前缀列出开着的 PR，
   * 取 **head 精确等于集成分支**的那条 —— 那正是本批上一次没收完尾时开出来的 PR。
   *
   * 为什么按精确分支名而不是「列表第一条」：前缀可能命中别的批（同工作项的其它分支/其它工作项），
   * 认错 PR 的后果是把别人的 PR 挂到本工作项上，且**不报错**。
   */
  async function recoverExisting(input: {
    repoOwner: string;
    repoName: string;
    integration: string;
  }): Promise<RemotePullRequestFact | null> {
    const listed = await deps.provider.listOpenByBranchPrefix({
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      prefix: input.integration,
    });
    if (!listed.ok) {
      logWarn(
        `[squad] pr-gate 认回失败：列举 Open PR 的调用没成功（${listed.reason}）—— 本次收尾报失败。`,
      );
      return null;
    }
    return listed.pullRequests.find((fact) => fact.snapshot.branch === input.integration) ?? null;
  }

  return {
    async publishForReview(input) {
      // ① 读数面可用性（前置，零出站）：没 token ⇒ 降级（本地收尾照常）。
      const status = deps.provider.describe();
      if (!status.available) {
        return {
          status: "degraded",
          code: "no_token",
          reason: `${status.reason}（pr-gate 需要 PAT 才能开 PR）`,
        };
      }

      // ② 远端（前置，纯读）：没 remote / 不是 GitHub ⇒ 降级。**都在推送之前**。
      const remote = await readRemoteUrl();
      if ("problem" in remote) {
        return { status: "degraded", code: "no_remote", reason: remote.problem };
      }
      const coordinates = parseGitHubRemoteUrl(remote.url);
      if (coordinates === null) {
        return {
          status: "degraded",
          code: "remote_not_github",
          reason:
            `${REMOTE_NAME} 的地址不是 GitHub 形态（${remote.url}）：pr-gate 只能向 GitHub 开 PR` +
            "（别的托管/本地路径没有本集成所使用的 PR API）。",
        };
      }

      // ③ push 集成分支（真网络动作；失败＝**失败**而不是降级：远端这条路已开始走，不能悄悄改道）。
      assertSafeBranch(input.integration);
      const refspec = `refs/heads/${input.integration}:refs/heads/${input.integration}`;
      const pushed = await deps.git(["push", REMOTE_NAME, refspec], { cwd: deps.repoRoot });
      if (pushed.code !== 0) {
        return {
          status: "failed",
          reason:
            `推送集成分支到 ${REMOTE_NAME} 失败（git push ${REMOTE_NAME} ${refspec}，退出码 ` +
            `${pushed.code}）：${pushed.stderr.trim() || pushed.stdout.trim() || "(no output)"}`,
        };
      }

      // ④ 开 PR（幂等：已存在则按 head 精确认回）。
      const createInput: CreatePullRequestInput = {
        repoOwner: coordinates.repoOwner,
        repoName: coordinates.repoName,
        title: input.workItemTitle?.trim() ? input.workItemTitle.trim() : input.workItemId,
        head: input.integration,
        base: input.target,
        body:
          `由 ZPaPa 小队整批收尾自动创建（pr-gate 模式）。\n\n` +
          `- 工作项：${input.workItemId}\n` +
          `- 集成分支：${input.integration}\n` +
          `- 目标分支：${input.target}\n\n` +
          "合并本 PR 即代表这一批通过验收：工作项随后自动转 done。",
      };
      const created = await deps.provider.createPullRequest(createInput);
      let fact: RemotePullRequestFact;
      if (created.ok) {
        fact = created.pullRequest;
      } else {
        if (created.code !== "http_error" || created.status !== 422) {
          return { status: "failed", reason: created.reason };
        }
        const existing = await recoverExisting({
          repoOwner: coordinates.repoOwner,
          repoName: coordinates.repoName,
          integration: input.integration,
        });
        if (existing === null) return { status: "failed", reason: created.reason };
        logWarn(
          `[squad] pr-gate 认回已存在的 PR：${coordinates.repoOwner}/${coordinates.repoName}` +
            `#${existing.number}（head=${input.integration}）—— 上一次收尾在「开 PR 之后、登记之前」中断，` +
            "本次不再重复开，直接登记这条。",
        );
        fact = existing;
      }

      // ⑤ 登记关联行 + 首次快照（**本地既成事实**：重驱闸按它判「本批已发布」）。
      const row = deps.repo.link({
        // id 与人工登记同一派生口径（业务键），认回后重投也回到同一行。
        id: pullRequestLinkId({
          workItemId: input.workItemId,
          repoOwner: coordinates.repoOwner,
          repoName: coordinates.repoName,
          prNumber: fact.number,
        }),
        workspaceKey: deps.workspace.key,
        workspacePath: deps.workspace.path,
        workItemId: input.workItemId,
        repoOwner: coordinates.repoOwner,
        repoName: coordinates.repoName,
        prNumber: fact.number,
        title: fact.snapshot.title,
        htmlUrl: fact.htmlUrl,
        // 登记时已知的 head（创建响应/认回列表里拿到的 ref）：本批那条 PR 的判据。
        branch: input.integration,
        linkedBy: SYSTEM_ACTIVITY_ACTOR,
        createdAt: now(),
      });
      const written = deps.repo.replaceSnapshot({
        id: row.id,
        expectHeadSha: row.snapshotHeadSha,
        snapshot: fact.snapshot,
      });
      if (!written) {
        /* 已有更新过的快照（人工先登记过同一条 PR 并刷过）⇒ 不覆盖，等下一次刷新；
         **不是失败**：关联行已在，收尾要的事实（「本批已发布」）成立，只是快照晚一格。 */
        logWarn(
          `[squad] pr-gate 登记后未写入首次快照（id=${row.id}）：库里已有更新的 pin，` +
            "按防陈旧写不动它（等下一次按需刷新）。",
        );
      }
      return { status: "published", pullRequest: deps.repo.get(row.id) ?? row };
    },
  };
}
