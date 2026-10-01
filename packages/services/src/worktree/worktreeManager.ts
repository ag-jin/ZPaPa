import { access, realpath } from "node:fs/promises";
import { join } from "node:path";
import { ensureGitRunSucceeded, type GitRunner } from "./gitRunner.js";

export type WorktreeEntry = { path: string; branch: string | null };

export type WorktreeAddInput = { branch: string; base: string; dirName: string };

export interface WorktreeManager {
  add(input: WorktreeAddInput): Promise<{ path: string }>;
  remove(dirName: string): Promise<void>;
  list(): Promise<WorktreeEntry[]>;
  prune(): Promise<void>;
}

/**
 * 工作树目录名。**这是 `.worktree` 这个字面量在全仓的唯一来源**（终审 M8）：
 * 它在两处被需要 —— ①工作树的落点（下面的 `resolveWorktreeRoot`）；②spec §13 C10 的
 * 「工作区产物目录排除清单」（`workspaceProductDirs.ts` 的 `WORKSPACE_PRODUCT_DIRS`，
 * 它同时驱动 `.gitignore` 与扫描排除，故必须跟着改名走）。清单项必须是**裸名**
 * （相对路径、不含首尾 `/`，见那边的注释），所以两边共用的只能是这个目录名，而不是拼好的绝对路径。
 *
 * 为什么不在清单里重写一遍字面量：两处各自写 `".worktree"` 时没有任何编译期关联 ——
 * 这里改了名，清单与 `.gitignore` 会**静默**漏掉新目录（工作树于是被当成源码、被 git 看见）。
 * 由清单 import 本常量后，改名会引起 `.gitignore` 一致性测试立刻变红，改一处就够。
 */
export const WORKTREE_DIR_NAME = ".worktree";

/**
 * 队员工作树都落在 `<repoRoot>/.worktree/`。
 * 位置写死而不是由调用方指定：这个目录要作为**一项**进集中排除清单（否则主工作树会把
 * 队员的工作面看成未跟踪目录），只有一处定义才能保证清单与实现不会各说各话。
 */
export function resolveWorktreeRoot(repoRoot: string): string {
  return join(repoRoot, WORKTREE_DIR_NAME);
}

/**
 * dirName 只接受单层目录名。`..` 或带分隔符的写法能把工作树挪出 `.worktree/`，
 * 上面那条「位置写死」的前提、以及「排除清单只需一项」会同时失效 —— 所以在参数上就拒掉，
 * 而不是等 git 去兜。
 */
function resolveWorktreePath(repoRoot: string, dirName: string): string {
  if (
    dirName.length === 0 ||
    dirName === "." ||
    dirName === ".." ||
    dirName.includes("/") ||
    dirName.includes("\\")
  ) {
    throw new Error(`Invalid worktree dirName: ${JSON.stringify(dirName)}`);
  }
  return join(resolveWorktreeRoot(repoRoot), dirName);
}

const WORKTREE_LIST_ARGS = ["worktree", "list", "--porcelain"];
const BRANCH_REF_PREFIX = "refs/heads/";

/**
 * 解析 `git worktree list --porcelain`。块里除 path/branch 外还有 HEAD/bare/locked/prunable
 * 等行，这里只取需要的两项、其余忽略：格式将来加标记时，解析不该跟着崩。
 * `branch` 行缺省（detached）时保持 null，不能顺延上一块的分支名。
 */
function parseWorktreeListPorcelain(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  const flush = () => {
    if (current) {
      entries.push(current);
      current = null;
    }
  };

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: line.slice("worktree ".length), branch: null };
      continue;
    }
    if (!current || !line.startsWith("branch ")) {
      continue;
    }
    const ref = line.slice("branch ".length);
    current.branch = ref.startsWith(BRANCH_REF_PREFIX) ? ref.slice(BRANCH_REF_PREFIX.length) : ref;
  }
  flush();

  return entries;
}

/**
 * 目录被外部删掉的残骸在 git 里仍是登记的 worktree，但它已经没有工作面可言。
 * **只有 ENOENT 才算「不存在」**：EACCES / EPERM / ELOOP 说明路径本身可能活得好好的
 * （比如 `.worktree/` 某一层不可穿越）。把它们一并当成「不存在」，活着的工作树会被静默
 * 从 list() 里抹掉：队员数少 1、这个工作面也永远进不了 Task 3 的清理视野，且零信号。
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * 归一化路径形态：git 报出的工作树路径是 **realpath 后**的值，而本仓库拼出来的路径不一定是同一形态。
 *
 * 为什么必须有它（而不是「看着一样就当相等」）：macOS 上 `/var` 是 `/private/var` 的符号链接，
 * `mkdtempSync(tmpdir())` 给的是前者、git 报的是后者；不归一，`add()` 返回的 path 与 `list()` 报出的
 * path 就「看着一样却不相等」。孤儿回收那边更狠：它拿 `dirname(list 里的 path)` 与自家根比较，
 * 不归一就会把**自家的工作树**全判成外来树 —— 于是回收对自家工作树整体失灵，而它一声不响。
 *
 * **本函数是全模块唯一的一份**（终审 M4 抽公共）：`orphanReaper` 此前另抄了一份同体实现。
 * 放在这里而不是单开一个小模块：工作树根与工作树路径的规则本来就归 `WorktreeManager` 这层
 * （`resolveWorktreeRoot` / `resolveWorktreePath` 都在此），而两个消费者的 import 边早已存在
 * （`orphanReaper` 已经从这里取 `resolveWorktreeRoot`），不新增模块、也不新增依赖边。
 *
 * 错误处理与同族政策对齐（**只有 ENOENT 才算「不存在」**，见上面的 `pathExists`）：
 * 1. **ENOENT ⇒ 原样返回**。这是合法的「还不存在」情形（一次都没建过工作树时 `.worktree` 不在），
 *    调用方依赖它拿到原串继续比较。
 * 2. **其它错误 ⇒ 原样抛出**（响亮失败）。EACCES / EPERM / ELOOP 说明路径本身可能活得好好的，
 *    静默退回原串在归属判定上是危险的：`orphanReaper` 拿 `canonicalPath(repoRoot)` 当自家根，
 *    realpath 失败退回原串时，macOS 上的 `/var` ↔ `/private/var` 形态差异会把**我们自己的每一个
 *    工作树**全判成外来树 ⇒ reap **静默空转**（什么都不做、还报成功）。这正是本模块要消灭的失败类，
 *    只是换了一条触发路径（与 `pathExists` 同族），所以两条都按同一规矩办。
 *
 * 它只用于**比较**，不用于任何文件系统操作 —— 所以「抛出」不会在只读路径上造成破坏，只是把
 * 静默的误判变成一个可见的错误。
 */
export async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return path;
    }
    throw error;
  }
}

export function createWorktreeManager(deps: { git: GitRunner; repoRoot: string }): WorktreeManager {
  const { git, repoRoot } = deps;

  async function run(label: string, args: string[]): Promise<void> {
    ensureGitRunSucceeded(label, await git(args, { cwd: repoRoot }));
  }

  return {
    async add(input) {
      const path = resolveWorktreePath(repoRoot, input.dirName);
      // 缺失的父目录（含 .worktree/）由 git 自己补建，这里不先 mkdir：
      // 先建再让 git 失败会留下空目录，下一次 add 反而更容易踩到「目录已存在」。
      await run(`git worktree add ${input.branch}`, [
        "worktree",
        "add",
        "-b",
        input.branch,
        path,
        input.base,
      ]);
      return { path: await canonicalPath(path) };
    },

    async remove(dirName) {
      const path = resolveWorktreePath(repoRoot, dirName);
      // --force 是**抛弃语义**：队员可能留了未提交改动，而那些改动不参与合并（合并按分支走），
      // 不加 force 会让收尾卡死在 git 的交互式拒绝上。
      await run(`git worktree remove ${dirName}`, ["worktree", "remove", "--force", path]);
    },

    async list() {
      const result = ensureGitRunSucceeded(
        "git worktree list",
        await git(WORKTREE_LIST_ARGS, { cwd: repoRoot }),
      );
      // 主工作树永远排在第一块，它不是队员：算进去「队员数」会多 1。
      const linked = parseWorktreeListPorcelain(result.stdout).slice(1);
      const live: WorktreeEntry[] = [];
      for (const entry of linked) {
        // 目录已消失的残骸同样不是队员，计入统计就是虚增；prune() 才是它的清理入口。
        if (await pathExists(entry.path)) {
          live.push(entry);
        }
      }
      return live;
    },

    async prune() {
      await run("git worktree prune", ["worktree", "prune"]);
    },
  };
}
