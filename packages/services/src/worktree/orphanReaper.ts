import { basename, dirname } from "node:path";
import type { WorktreeManager } from "./worktreeManager.js";

export type ReapInput = { activeBranches: readonly string[] };

export type ReapOutcome = { reclaimed: string[]; kept: string[] };

/**
 * 本模块只认 <repoRoot>/.worktree/<dirName> 这个布局（`dirName` 是从 git 报出的路径反推的，
 * 这是同一份布局知识的另一面）。不为拿这个常量去 import `resolveWorktreeRoot`：它需要 `repoRoot`，
 * 而 deps 只有 manager —— 多一个参数只为拼一个已知目录名，代价比常量本身大。
 */
const WORKTREE_DIR_NAME = ".worktree";

/**
 * 反推 dirName，并在**反推不成立**时响亮拒绝。
 *
 * 为什么不能直接 `basename(path)`：`manager.remove()` 只会去 `.worktree/<dirName>` 动手，
 * 而 `list()` 报出的是**全部**链接工作树 —— 一个挂在别处的工作树（用户自己 `git worktree add`
 * 出来的，或本流程目录被挪走过）反推出的名字，会指向 `.worktree/` 下的**另一个**目录。
 * 那一步既不报错也不明显：摘掉的是别人的工作树，删掉的是别的分支。
 * 所以「不在这个布局里」不是可以猜一猜的情况，是必须当场拦下的信号。
 */
function worktreeDirName(path: string): string {
  if (basename(dirname(path)) !== WORKTREE_DIR_NAME) {
    throw new Error(`不是本流程建的工作树（不在 ${WORKTREE_DIR_NAME}/ 下），拒绝回收: ${path}`);
  }
  return basename(path);
}

/**
 * 孤儿回收：把「不在活跃集合里」的工作树与它的分支一起收掉。
 *
 * 为什么它值得单独一层：**清理是重派发的正确性前置**（spec §6.4）。孤儿不只占着一份工作树，
 * 它的**分支**同样占住分支名 —— 只删工作树的话，下一次同分支派发会撞上
 * `a branch named '…' already exists`，而清理过程本身**一声不响**。所以回收的定义是
 * 「工作树 + 分支都收掉，之后同一分支能重新 add」，不是「目录看起来没了」。
 *
 * 活跃与否**完全由入参 `activeBranches` 决定**，本模块不探测「这个队员是不是在跑」：
 * 判据只有一处来源，就不会出现「探测说在跑、清单说没在跑」两套真相。
 *
 * 调用方约束（本模块不做）：`deleteBranch` 的三参实现要由调用方**绑定**成单参
 * （`(branch) => deleteBranch(git, repoRoot, branch)`），与 `discardMember` 共用同一份
 * `git branch -D`；本模块不自己拼一条删除命令，避免同一语义有两处实现。
 */
export function createOrphanReaper(deps: {
  manager: WorktreeManager;
  deleteBranch: (branch: string) => Promise<void>;
}): { reap(input: ReapInput): Promise<ReapOutcome> } {
  const { manager, deleteBranch } = deps;

  return {
    async reap({ activeBranches }) {
      const active = new Set(activeBranches);
      const live = await manager.list();

      // 先分类、后动手：分类阶段只读（`worktreeDirName` 可能抛），任何一项不合法都在
      // 动第一个工作树之前结束 —— 否则一次拒绝会留下「前面几个已经收了、后面没动」的半程状态。
      const kept: string[] = [];
      const orphans: { dirName: string; branch: string | null }[] = [];
      for (const entry of live) {
        const dirName = worktreeDirName(entry.path);
        // 分支在活跃集合里 ⇒ 保留。detached（branch 为 null）不可能是活跃分支，
        // 它也不算「队员」：下面按孤儿处理，但不会拿 null 去删分支。
        if (entry.branch !== null && active.has(entry.branch)) {
          kept.push(dirName);
          continue;
        }
        orphans.push({ dirName, branch: entry.branch });
      }

      const reclaimed: string[] = [];
      for (const orphan of orphans) {
        // 顺序不可颠倒：分支还被工作树检出时 git 会拒绝删除（Task 3 实测）。
        await manager.remove(orphan.dirName);
        if (orphan.branch !== null) {
          await deleteBranch(orphan.branch);
        }
        // 两个失败都在上面原样抛出：只摘了树没删分支如果被吞掉，调用方看到的就是
        // 「回收成功」——那正是本任务要消灭的半拉子清理。
        reclaimed.push(orphan.dirName);
      }

      // git 侧仍登记着「目录已消失」的残骸（Task 1 的 list() 不把它算作队员），
      // prune 才是它的清理入口。注意 prune 只清登记项、**不删分支**（见测试里的缺口记录）。
      await manager.prune();

      return { reclaimed, kept };
    },
  };
}
