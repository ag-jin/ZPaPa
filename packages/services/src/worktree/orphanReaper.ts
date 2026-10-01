import { realpath } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { MEMBER_NAMESPACE } from "./branchNaming.js";
import { resolveWorktreeRoot, type WorktreeManager } from "./worktreeManager.js";

export type ReapInput = { activeBranches: readonly string[] };

export type ReapOutcome = {
  /** 被回收的工作树 dirName（「有工作树」的那种孤儿形状）。 */
  reclaimed: string[];
  /** 被保留的工作树 dirName：分支仍在 `activeBranches` 里，一个字节都不动。 */
  kept: string[];
  /**
   * 工作树**存在、但不属于本流程**（不在 `<repoRoot>/.worktree/` 下）—— 按设计不动，只报出来。
   *
   * 语义是「跳过，但不是静默跳过」：既不是失败、也不是保留、更不是回收，而是
   * 「看见了、判断它不归我管、没碰」。值用 git 报出的**工作树路径**（不是 dirName）——
   * 这些项根本不在我们的目录布局里，dirName 无从谈起。
   *
   * 为什么必须有这个字段：外来工作树是**正常**情况（用户自己在仓库里 `git worktree add` 过），
   * 跳过它是正确行为，但「正确地跳过了什么」如果没人报出来，事后排查就只剩「启动回收什么也没说」
   * 这一种信息。
   */
  foreign: string[];
  /**
   * 被回收的**分支**名，与 `reclaimed` 正交：`reclaimed` 数工作树，这里数分支。
   *
   * 两种来路都进这里：随工作树一起删掉的孤儿分支，以及**有分支、无工作树**的残枝分支
   * （`worktree add` 先建分支、后失败留下的）。残枝不进 `reclaimed`（它压根没有工作树），
   * 但它确实被删了 —— 不报出来就是一次静默删除，而静默正是本模块要消灭的东西。
   */
  reclaimedBranches: string[];
};

/**
 * 「`.worktree` 在哪」只有 `resolveWorktreeRoot` 一处定义 —— 本模块不再自带第二处字面量。
 *
 * 两侧都要归一化。git 报出的工作树路径是 realpath 后的形态（macOS 上 `/var` 是 `/private/var`
 * 的符号链接，`mkdtemp(tmpdir())` 给的是前者、git 报的是后者），而 `repoRoot` 是调用方给的原样字符串。
 * 不归一化就会把**自家的**工作树误判成外来树：于是回收对自家工作树整体失灵，而它一声不响
 * （`foreign` 里多一项看起来完全正常）—— 比误删更安静的那种错。
 */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * 孤儿回收：把「不在活跃集合里」的工作树**连它的分支**一起收掉，再收掉「有分支、无工作树」的残枝。
 *
 * 为什么它值得单独一层：**清理是重派发的正确性前置**（spec §6.4；spec §6.6 把它列为启动时必须
 * 完成的恢复步骤）。孤儿不只占着一份工作树，它的**分支**同样占住分支名 —— 只删工作树的话，
 * 下一次同分支派发会撞上 `a branch named '…' already exists`，而清理过程本身**一声不响**。
 * 所以回收的定义是「工作树与分支都收掉，之后同一分支能重新 `add`」，不是「目录看起来没了」。
 *
 * 活跃与否**完全由入参 `activeBranches` 决定**，本模块不探测「这个队员是不是在跑」：
 * 判据只有一处来源，就不会出现「探测说在跑、清单说没在跑」两套真相。
 *
 * 三件事刻意**不做**（都是安全边界，不是省事）：
 * 1. **不碰外来工作树**。归属按**根**判（`dirname(path) === <repoRoot>/.worktree`），不按路径形状猜，
 *    也不按 basename 去 `.worktree/` 下硬拼 —— 撞名时那会摘错树、删错分支。外来项只进 `foreign`。
 *    为什么不改成「响亮拒绝」：只要用户自己在仓库里 `git worktree add` 过一个工作树（完全正当、
 *    与我们无关），启动回收就会**永久整体失败** ⇒ 孤儿永远清不掉 ⇒ 后续重派发反而撞「分支已存在」。
 *    把一个无关情况变成回收器的永久故障，代价远大于「静默」。
 * 2. **不碰 `squad/integration/**`**。集成分支承载整批未合并的成果，删它就是丢活；它由 Task 3 的
 *    `discardIntegration` 在**整批合回主分支之后**负责删除。命名空间取自 `MEMBER_NAMESPACE` 一处定义。
 * 3. **不做串行锁**（调用方约束）：reap 会动 git 的登记与分支，只能靠接线点序列化。
 *
 * 调用方约束：`deleteBranch` 的三参实现要由调用方**绑定**成单参
 * （`(branch) => deleteBranch(git, repoRoot, branch)`），与 `discardMember` 共用同一份
 * `git branch -D`；`listBranches(prefix)` 要真的问 git（如 `for-each-ref refs/heads/<prefix>`），
 * 按**分支名前缀**列出短名（`prefix` 传命名空间，如 `"squad/member/"` → `["squad/member/wi1/a", …]`）。
 * 本模块不自己拼这两条命令，避免同一语义有两处实现；也**不**对枚举结果再做一次前缀过滤 ——
 * 那样会把「命名空间」变成两处判据，`MEMBER_NAMESPACE` 这一处写错就再也不会被测试咬住。
 */
export function createOrphanReaper(deps: {
  manager: WorktreeManager;
  repoRoot: string;
  deleteBranch: (branch: string) => Promise<void>;
  listBranches: (prefix: string) => Promise<string[]>;
}): { reap(input: ReapInput): Promise<ReapOutcome> } {
  const { manager, repoRoot, deleteBranch, listBranches } = deps;

  return {
    async reap({ activeBranches }) {
      const active = new Set(activeBranches);
      // 用 canonicalPath(repoRoot) 再拼，而不是 realpath 拼好的工作树根：后者要求 `.worktree`
      // 已经存在（一次都没建过工作树时它不在），那会把「根本没有工作树」错算成「根路径不同」。
      const ourRoot = resolveWorktreeRoot(await canonicalPath(repoRoot));
      const live = await manager.list();

      // 先分类、后动手：分类阶段只读（`manager.list()` 是只读的），任何一项都不在动第一个工作树
      // 之前碰到 git 的登记或分支 —— 否则一次失败会留下「前面几个已经收了、后面没动」的半程状态。
      const kept: string[] = [];
      const foreign: string[] = [];
      const orphans: { dirName: string; branch: string | null }[] = [];
      for (const entry of live) {
        // 归属按**根**判：只有 `<repoRoot>/.worktree/<dirName>` 是本流程的树。
        // 不按路径形状猜（`basename(dirname(p)) === ".worktree"`）：形状相同的目录可能属于
        // 别的仓库；按根判才不会把别人的树认成自己的。
        if (dirname(entry.path) !== ourRoot) {
          foreign.push(entry.path);
          continue;
        }
        const dirName = basename(entry.path);
        // 分支在活跃集合里 ⇒ 保留。detached（branch 为 null）不可能是活跃分支，
        // 它也不算「队员」：下面按孤儿处理，但不会拿 null 去删分支。
        if (entry.branch !== null && active.has(entry.branch)) {
          kept.push(dirName);
          continue;
        }
        orphans.push({ dirName, branch: entry.branch });
      }

      const reclaimed: string[] = [];
      const reclaimedBranches: string[] = [];
      for (const orphan of orphans) {
        // 顺序不可颠倒：分支还被工作树检出时 git 会拒绝删除（Task 3 实测）。
        await manager.remove(orphan.dirName);
        if (orphan.branch !== null) {
          await deleteBranch(orphan.branch);
          reclaimedBranches.push(orphan.branch);
        }
        // 两个失败都在上面原样抛出：只摘了树没删分支如果被吞掉，调用方看到的就是
        // 「回收成功」——那正是本任务要消灭的半拉子清理。
        reclaimed.push(orphan.dirName);
      }

      // prune 夹在**两遍之间**，不是「末尾顺手一行」：目录被外部删掉的**残骸**在 git 侧仍登记着，
      // 而 git 认为它还检出着自己的分支 —— 不先 prune，下面那条 `git branch -D` 会被拒
      // （实测 `error: Cannot delete branch '…' checked out at '…'`），残骸的分支就永远收不掉，
      // 而那正是「清理是重派发前置」最需要的形状之一。
      await manager.prune();

      // 第二遍：分支。`worktree add` 会**先建分支、后因目标路径已存在而失败**（Task 1/3 都实测过），
      // 于是留下「有分支、无工作树」的残枝 —— 它不在 `worktree list` 里，`prune()` 也不删分支，
      // 所以只做工作树那一遍就永远看不见它，而它同样占住分支名。不走这一遍，
      // 「清理是重派发的正确性前置」对**最主要的那种孤儿形状**就不成立。
      //
      // 「未被任何存活工作树检出」这个判据**依赖上一遍已完成**：工作树那一遍已经摘掉了非活跃的树，
      // 所以这里重新 `list()` 得到的是**真的还活着**的工作树（含外来树）—— 被它们检出的分支
      // 一个都不能删（git 也会拒绝删）。据此，命名空间边界只剩一处：`MEMBER_NAMESPACE`。
      const survivorBranches = new Set(
        (await manager.list())
          .map((entry) => entry.branch)
          .filter((branch): branch is string => branch !== null),
      );
      for (const branch of await listBranches(MEMBER_NAMESPACE)) {
        if (active.has(branch) || survivorBranches.has(branch)) {
          continue;
        }
        await deleteBranch(branch);
        reclaimedBranches.push(branch);
      }

      return { reclaimed, kept, foreign, reclaimedBranches };
    },
  };
}
