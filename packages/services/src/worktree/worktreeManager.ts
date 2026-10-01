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
 * 队员工作树都落在 `<repoRoot>/.worktree/`。
 * 位置写死而不是由调用方指定：这个目录要作为**一项**进集中排除清单（否则主工作树会把
 * 队员的工作面看成未跟踪目录），只有一处定义才能保证清单与实现不会各说各话。
 */
export function resolveWorktreeRoot(repoRoot: string): string {
  return join(repoRoot, ".worktree");
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

/** git 报出的工作树路径是 realpath 后的值，构造出来的路径不一定是同一形态。 */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
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
