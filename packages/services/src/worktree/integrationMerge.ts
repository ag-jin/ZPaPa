import { assertSafeSlug } from "./branchNaming.js";
import { ensureGitRunSucceeded, type GitRunner } from "./gitRunner.js";
import { createWorktreeManager } from "./worktreeManager.js";

export type MergeOutcome =
  | { ok: true; branch: string }
  | { ok: false; reason: "conflict" | "branch_missing"; detail: string };

/* 小队这条链路的合入段（spec §6.2/§6.3）：把队员分支**逐个**合到集成分支，整批过了再合回主分支。
   `mergeMember`（逐队员 → 集成分支）与 `finalize`（集成分支 → target）刻意分开：它们失败的代价不同 ——
   一个队员冲突只该挡住他自己，整批没过则一条都不该进主分支。

   两条**调用方**约束（本模块不做锁，也做不了锁）：
   1. **同一集成分支必须串行调用**。合并的实现是「检出目标分支 → git merge」，而主工作树的 HEAD 只有一份：
      两次并发 merge 会互相踩（检出被对方挪走、abort 把对方的合并一起回滚）。spec §6.3 说的「串行合并（一次一个）」
      落在调用方，这里不设锁。
   2. **合并会挪走主工作树的 HEAD**（brief 指定在仓库主工作树上检出集成分支/target），
      调用方不能假设自己原先的检出还在。

   `integration` / `member` 会直接进 git 子命令（checkout / merge / branch -D），所以一律先过
   `assertSafeSlug` 那道闸门 —— 与 Task 2 的 allocate 校验 member 用的是**同一个函数、同一套错误文案**
   （这正是审查指出的口径不一致：integration 同源于 workItemSlug，此前没人校验它）。 */
function assertSafeBranch(branch: string): void {
  // 逐段过闸门。**不**在这里断言形状（几段、什么前缀）：那是 planBranches 一处定义的命名规则，
  // 在合入层再写一遍就等于把命名规则定义成第二处。空段（空串、尾斜杠、双斜杠）由 assertSafeSlug 一并拒掉。
  for (const segment of branch.split("/")) {
    assertSafeSlug(segment);
  }
}

export function createIntegrationMerger(deps: { git: GitRunner; repoRoot: string; base: string }): {
  ensureIntegration(branch: string): Promise<void>;
  mergeMember(input: { integration: string; member: string }): Promise<MergeOutcome>;
  finalize(input: { integration: string; target: string }): Promise<MergeOutcome>;
  discardMember(input: { branch: string; dirName: string }): Promise<void>;
} {
  const { git, repoRoot, base } = deps;
  // 摘工作树复用 Task 1 的 WorktreeManager：dirName 的越界闸门与 `--force`（抛弃语义）都已在那边定好，
  // 在这里拿裸 git 拼路径等于把同一套规则写第二遍。
  const manager = createWorktreeManager({ git, repoRoot });

  async function run(label: string, args: string[]): Promise<void> {
    ensureGitRunSucceeded(label, await git(args, { cwd: repoRoot }));
  }

  async function branchExists(branch: string): Promise<boolean> {
    return (
      (await git(["rev-parse", "-q", "--verify", `refs/heads/${branch}`], { cwd: repoRoot }))
        .code === 0
    );
  }

  /** 区分「真处于合并中」与「合并压根没开始」——用来避免把后者误报成「回滚失败」。 */
  async function mergeInProgress(): Promise<boolean> {
    return (await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: repoRoot })).code === 0;
  }

  /**
   * 在**仓库主工作树**上检出 dst，再把 src 合入。
   * 成功返回 dst（承载结果的分支）；失败返回 conflict，并保证 dst 回到合并前状态。
   */
  async function mergeInto(dst: string, src: string): Promise<MergeOutcome> {
    // 检出失败（主工作树脏、dst 不存在…）**抛**：它既不是「冲突」也不是「分支不存在」，
    // 硬塞进那两个结局里，会让调用方把「环境没准备好」当成「这个队员白干了」。
    await run(`git checkout ${dst}`, ["checkout", dst]);

    const merge = await git(["merge", "--no-ff", src], { cwd: repoRoot });
    if (merge.code === 0) {
      return { ok: true, branch: dst };
    }

    // spec §6.3 要求不留半合并状态（否则后续队员会在一个半合并的 HEAD 上继续合，错误一路扩散），
    // 所以先判「是否真的起了合并」：merge 会在「工作区会被覆盖」这类前置检查上就退出
    // （实测 exit 2、stdout/stderr 有原文、**没有 MERGE_HEAD**），此时 `merge --abort` 反而以 exit 128
    // 失败（"There is no merge to abort"）。不判这一下，一次「没开始的合并」会被误报成「回滚失败」并抛给上层。
    if (await mergeInProgress()) {
      // abort 失败 ⇒「不留半合并」这条契约破了。这时**必须抛**：返回普通冲突等于把一个更糟的状态
      // 伪装成一次可重试的失败，而调用方会照常把下一个队员合上来。
      await run("git merge --abort", ["merge", "--abort"]);
    }

    // detail 兜住 stdout：git 有的失败只往 stdout 写原因（如 `merge: x - not something we can merge`），
    // 只留 stderr 会得到一句「失败了，但不知道为什么」。
    return { ok: false, reason: "conflict", detail: merge.stderr.trim() || merge.stdout.trim() };
  }

  async function ensureIntegration(branch: string): Promise<void> {
    assertSafeBranch(branch);
    // 已存在就**什么都不做**：这里绝不能写成 `branch -f <branch> <base>`（reset 语义）——
    // 集成分支上可能已经躺着前几个队员的合并成果，回退到 base 会把它们静默丢掉。
    if (await branchExists(branch)) {
      return;
    }
    // 派生点只有这一处（brief 的裁定）：集成分支从 deps.base 出，不靠「调用方在别处建好」。
    await run(`git branch ${branch}`, ["branch", branch, base]);
  }

  return {
    ensureIntegration,

    async mergeMember(input) {
      assertSafeBranch(input.member);
      // 先判队员分支在不在：不让一次**注定失败**的调用留下痕迹（不建集成分支、不挪检出）。
      if (!(await branchExists(input.member))) {
        return { ok: false, reason: "branch_missing", detail: `队员分支不存在: ${input.member}` };
      }
      // 集成分支的创建**隐式**发生在这里（brief 的二选一，选这个并写清）：首个队员合并时它还
      // 可能不存在，而它的来路只有 deps.base 一个答案。ensureIntegration 里也带 integration 的校验。
      await ensureIntegration(input.integration);
      return mergeInto(input.integration, input.member);
    },

    async finalize(input) {
      assertSafeBranch(input.integration);
      // 不调 ensureIntegration：整批都跑完了集成分支还不存在，说明这条流程根本没开始；
      // 替调用方凭空建一条再合回主分支，等于报告一次不存在的成功。
      if (!(await branchExists(input.integration))) {
        return {
          ok: false,
          reason: "branch_missing",
          detail: `集成分支不存在: ${input.integration}`,
        };
      }
      // target 是**仓库的主分支**，不是本层的命名空间产物：不用 slug 闸门去夹它
      // （那会把 `release/1.0` 这类合法分支名挡在外面），只确认它存在 ——
      // 先确认存在也顺带挡住了把 `--abort` 之类的前导短横线当分支名喂进 git 参数。
      if (!(await branchExists(input.target))) {
        return { ok: false, reason: "branch_missing", detail: `target 不存在: ${input.target}` };
      }
      return mergeInto(input.target, input.integration);
    },

    async discardMember(input) {
      assertSafeBranch(input.branch);
      // 顺序**不可颠倒**：工作树还挂着这条分支时 `git branch -D` 会被 git 拒
      // （实测 "error: Cannot delete branch 'x' checked out at '...'"）⇒ 先摘工作树、再删分支。
      //
      // 摘之前先确认「确有工作树」：`git worktree remove` 对不存在的路径是 exit 128
      // （"fatal: '<path>' is not a working tree"）。而**残枝**（worktree add 先建分支、后失败留下的
      // 无工作树分支）正是这里要消化的主场景 —— 少了这一步，remove 会先失败，`branch -D` 永远跑不到，
      // 队员便永久停在「分支已存在」上（正是「清理是正确性前置」的反面）。
      // 按**分支**判而不是按路径判：Task 1 报出的 path 是 realpath 后的形态，拿自己拼的路径去比会假阴性。
      const live = await manager.list();
      if (live.some((entry) => entry.branch === input.branch)) {
        await manager.remove(input.dirName);
      }
      // `-D` 而不是 `-d`：被抛弃的队员分支通常**未合并**，`-d` 会拒绝，留下一个「删不掉」的死角。
      // 分支若仍被某个工作树检出处（dirName 传错等），git 会在这里响亮拒绝 —— 不会静默成功。
      await run(`git branch -D ${input.branch}`, ["branch", "-D", input.branch]);
    },
  };
}
