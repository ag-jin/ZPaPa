import { GitCommandError } from "./gitRunner.js";
import type { WorktreeManager } from "./worktreeManager.js";

export type BranchPlan = { integration: string; member: string };

/* 小队的分支命名规则是固定的两条，写死在一处：
   集成分支 `squad/<workItemSlug>`、队员分支 `squad/<workItemSlug>/<agentSlug>`。
   队员分支挂在集成分支名**之下**（而不是并列的另一种前缀），是为了让「谁属于哪个工作项」
   单看分支名就能读出来 —— 合并、清理、排障都只靠这一个字符串。 */
const SQUAD_PREFIX = "squad/";

/**
 * slug 会同时进分支名与目录名，所以它是**进 git 与进文件系统的共同输入**：
 * 放行 `/` 能拼出层级、放行 `..` 能拼出向上逃逸、放行空格/大写/`_` 则可能造出非法 ref。
 * 因此只收 `[a-z0-9-]` 且首字符是字母数字（首字符不是 `-`，否则目录名会被下游当成选项）；
 * 长度不在这里管：那是文件系统的约束，不是「安全字符集」这道闸门的职责。
 */
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** 只此一处抛 slug 错误：文案统一，调用方按 /slug/ 就能分出「这是输入被拒」而非别的失败。 */
function rejectSlug(slug: string, reason: string): never {
  throw new Error(`Invalid slug (${reason}): ${JSON.stringify(slug)}`);
}

/**
 * 显式挡 `..`：上面那条正则其实已经不含 `.`，所以这是**冗余**的一道，但保留它 ——
 * 这里同时是「不能拼出向上逃逸路径」的最后一道闸，不该只依赖某个字符类。
 * 将来有人为兼容别的命名习惯把 `.` 加进白名单，`..` 会立刻重新变成可用的逃逸串，
 * 而这道显式检查会让它当场失败、有人察觉，而不是安静地放行。
 */
export function assertSafeSlug(slug: string): void {
  if (slug.includes("..")) {
    rejectSlug(slug, '不允许 ".."');
  }
  if (!SAFE_SLUG.test(slug)) {
    rejectSlug(slug, "只允许 [a-z0-9-] 且首字符为 a-z0-9");
  }
}

/** 纯拼接：命名规则只有这一处定义，校验放在真正去碰 git / 文件系统的调用点。 */
export function planBranches(input: { workItemSlug: string; agentSlug: string }): BranchPlan {
  const integration = `${SQUAD_PREFIX}${input.workItemSlug}`;
  return { integration, member: `${integration}/${input.agentSlug}` };
}

/**
 * 从队员分支名还原两个 slug。分支名是计划里唯一自洽的字段（目录名要由它派生），
 * 所以还原失败必须是响亮错误：人手写的、或未来改过形状的 plan，猜出个目录名来
 * 只会把问题推迟到「工作树建在了错的地方」。
 */
function slugsFromMemberBranch(member: string): { workItemSlug: string; agentSlug: string } {
  const parts = member.startsWith(SQUAD_PREFIX) ? member.slice(SQUAD_PREFIX.length).split("/") : [];
  if (parts.length !== 2) {
    rejectSlug(member, `无法从分支名还原 squad/<workItemSlug>/<agentSlug> 形状的 slug`);
  }
  return { workItemSlug: parts[0]!, agentSlug: parts[1]! };
}

/**
 * 只认「分支已被占」的两条 git 文案，**不认宽泛的 `already exists`**：
 * `fatal: '<path>' already exists` 说的是**目标目录非空**（路径问题，处置是先清目录），
 * 把它翻成「分支被占用」会让调用方去换分支名，方向正好是错的。
 *
 * `a branch named 'x' already exists` 覆盖面比「被工作树占用」更宽：ref 存在就够了，
 * 哪怕没有任何工作树持有它（实测：add 因目标目录非空失败时，git 已经先把分支建出来了，
 * 于是留下一条**无工作树的残枝**，下次再挂就是这条文案）。
 */
const BRANCH_TAKEN = /a branch named '.+' already exists|is already checked out at/;

function isBranchTakenError(error: unknown): error is GitCommandError {
  return error instanceof GitCommandError && BRANCH_TAKEN.test(`${error.stderr}\n${error.stdout}`);
}

export function createBranchAllocator(deps: { manager: WorktreeManager }): {
  allocate(plan: BranchPlan, base: string): Promise<{ memberPath: string }>;
} {
  const { manager } = deps;

  return {
    async allocate(plan, base) {
      // 只用 member 一个字段（目录名由它派生）；plan.integration 不在这里使用，也不在这里校验：
      // allocate 的职责是把队员分支挂出来，集成分支的创建与合并归消费 plan 的流程。
      const { workItemSlug, agentSlug } = slugsFromMemberBranch(plan.member);
      // 在给 git 之前挡：放过去的话，拒因会变成 git 的 `not a valid branch name`（或 Task 1 的
      // dirName 报错），与「slug 不安全」这个真实原因脱节；分层兜底只在更深的层报错，
      // 而这里能零副作用地拒掉 —— 不进 git、不落目录、不建分支。
      assertSafeSlug(workItemSlug);
      assertSafeSlug(agentSlug);

      // 目录名用扁平的 `<workItemSlug>-<agentSlug>`，不是 `wi1/attempt-a`：
      // Task 1 的 add 明确拒绝含 `/` 的 dirName（.worktree/ 只放一层，才能作为**一项**
      // 进集中排除清单），层级命名在这里编不出来，也不该编。
      const dirName = `${workItemSlug}-${agentSlug}`;

      try {
        const { path } = await manager.add({ branch: plan.member, base, dirName });
        return { memberPath: path };
      } catch (error) {
        if (!isBranchTakenError(error)) {
          // 其余失败（base 不存在、目录冲突…）原样抛出：stderr 已在 GitCommandError 上，
          // 归因交给调用方，这里不替它猜。
          throw error;
        }
        // 同分支双挂是「每个队员必须独占分支」这条不变量被打破的信号。
        // git 只会说 `a branch named 'x' already exists` —— 既没点明撞了什么，也没说该怎么办。
        // 所以翻译成一句可读原因，同时把 git 原文留在文案里、原异常挂在 cause 上：
        // 只给可读文案会丢掉分因所需的原文，只抛原文又等于没解释。
        // 后半句「或已存在却未挂在任何工作树上」是有实测依据的分支：这句话不能断言「一定有个
        // 工作树占着它」——残枝同样会走到这里，那时去让「另一个队员」腾位置就是白等。
        throw new Error(
          `无法挂载 ${plan.member}：该分支已被另一工作树占用，或已存在却未挂在任何工作树上（同一分支禁止双挂，每个队员必须独占分支）。git: ${
            error.stderr.trim() || error.message
          }`,
          { cause: error },
        );
      }
    },
  };
}
