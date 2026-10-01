import { WORKTREE_DIR_NAME } from "./worktree/worktreeManager.js";

/* spec §13 C10 的「工作区产物目录排除清单」在**代码侧的唯一定义**。
 *
 * C10 要求这份清单「集中一处维护」，且同时驱动「gitignore」与「扫描排除」两半。
 * 纯文本的 `.gitignore` 无法被 TS import，`wikiScan` 也只拿到 `IFileService`（不读 ignore
 * 文件），所以两半的镜像在架构上不可避免——能收敛的是**代码侧**：这里是唯一来源，
 * `wikiScan` 与测试都从它派生，不再各写一份。
 *
 * 登记的标准动作（两处，第二处由测试强制同步）：
 *   ① 在本数组加一条（唯一来源）；
 *   ② 在仓库根 `.gitignore` 的「工作区产物目录排除清单」段加一条同名规则——
 *      漏改会被 `packages/services/test/workspaceProductDirExclusions.test.ts` 咬红。
 *
 * 用**相对 workspace 根、不含首尾 `/` 的 POSIX 路径**表示：与 `.gitignore` 规则一一对应，
 * 也便于测试逐条比对（`.gitignore` 侧写 `/.worktree/`，归一化后即此处的 `".worktree"`）。
 */
export const WORKSPACE_PRODUCT_DIRS = [
  /* 工作树产物：<repoRoot>/.worktree/<工作项>-<队员>/ 是整份仓库的副本（P2a 的隔离目录），
     可再生。不挡会把 N 份副本当源码吃进 wiki 清单、并让 manifestHash 每次都变。
     目录名**从工作树模块取**（`WORKTREE_DIR_NAME`），不在这里重写 `".worktree"` 字面量：
     否则那边改名时清单会静默漏掉新目录（终审 M8）。之所以只能共用**裸名**、不能共用拼好的
     绝对路径：清单项的定义是「相对 workspace 根、不含首尾 `/`」（见文末注释），
     绝对路径进不了本清单，也无法与 `.gitignore` 规则逐条比对。 */
  WORKTREE_DIR_NAME,
  /* 协作智能体（小队实验）产物：定义落在 <workspace>/.zcode/squad/（含 agents/ 子目录），
     与现有 subagent 的 <workspace>/.zcode/agents 分离、可整块删除。 */
  ".zcode/squad",
  /* 协作智能体的 project scope 记忆：<workspace>/.zcode/agent-memory/<稳定 id>/
     （apps/zcode-cli 的 persistent-memory.ts），与定义同属本地运行产物。 */
  ".zcode/agent-memory",
  /* 协作智能体的 local scope 记忆：<workspace>/.zcode/agent-memory-local/<稳定 id>/
     （同一处 persistent-memory.ts 在 scope=local 时写这里）。C10 字面只点名 agent-memory，
     但 §13 的设计意图是「定义与**记忆**的目录都必须进排除清单」，故一并登记。 */
  ".zcode/agent-memory-local",
] as const;

/**
 * 扫描器（`wikiScan.ts`）按「顶层目录名」剪枝用的集合，从清单派生。
 *
 * 清单项是相对路径（`.zcode/squad`），但遍历时必须在上层目录就剪掉整棵子树——
 * 不先跳过 `.zcode` 就永远走不到 `.zcode/squad`。故这里取每条清单项的**顶层段**并去重
 * （`.zcode/squad` / `.zcode/agent-memory` / `.zcode/agent-memory-local` → `.zcode`）。
 *
 * 由派生而非另写一份，正是 C10「集中一处维护」要的：往清单加一条，扫描器的剪枝集合自动跟上。
 */
export const WORKSPACE_PRODUCT_TOP_LEVEL_NAMES: ReadonlySet<string> = new Set(
  WORKSPACE_PRODUCT_DIRS.map((dir) => dir.split("/")[0] ?? dir),
);
