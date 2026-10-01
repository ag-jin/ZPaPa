import { basename, dirname } from "node:path";
import { INTEGRATION_NAMESPACE, MEMBER_NAMESPACE } from "./branchNaming.js";
import { canonicalPath, resolveWorktreeRoot, type WorktreeManager } from "./worktreeManager.js";

export type ReapInput = {
  /**
   * **必须包含所有「未合并」的队员分支 —— 包括被打回待修复的那些。**
   *
   * 这是接线方对本模块的唯一输入口径，**契约在这里、不在调用点**：本模块不探测「这个队员是不是
   * 还在跑」，给什么就认什么。若接线方按「有没有在跑的 run」当口径，被打回待修（run 已结束、
   * 分支还没合）的队员工作树会在下次启动**被静默回收** —— spec §6.2「审查被拒绝时工作树必须
   * 存活到合并」的承诺当场落空，而本层测试原理上覆盖不到这条缝（缝在接线方的口径里）。
   *
   * 为什么必须是这样：这正是 §6.2 与 §6.4/§6.6 能同时成立的前提。§6.2 要求被拒的工作树活到
   * 合并；§6.4/§6.6 又要求**启动时**完成回收。只有把「未合并」也算进活跃集合，回收才只针对
   * **已合并 / 已放弃**的分支，两条要求才不会互相打架。反过来说：凡是不在活跃集合里、
   * 又没有存活工作树检出的队员分支，都会被当作孤儿收掉（连分支一起）—— 所以少报一条
   * 未合并的分支 = 丢掉一个队员的活。
   */
  activeBranches: readonly string[];
};

export type ReapOutcome = {
  /** 被回收的工作树 dirName（「有工作树」的那种孤儿形状）。 */
  reclaimed: string[];
  /**
   * 被保留的**工作树** dirName。**三类来源**，共同点是「本流程看见了、但决定一个字节不动」：
   * 1. 分支仍在 `activeBranches` 里（队员的活在跑 / 还没合完）；
   * 2. 命中了集成分支边界（`squad/integration/**`，承载整批未合并的成果，不归 reap 管）；
   * 3. **命名空间外来的分支**（2026-10-01 B‑0 新增）：树落在 `<repoRoot>/.worktree/` 下，
   *    但它的分支不属于 `squad/member/**`（用户自己 `git worktree add` 的、别的功能复用该目录的），
   *    或压根没有分支（detached）。没有命名空间就证明不了归属 ⇒ 不碰。
   *
   * 第 3 类不是「静默跳过」：它在这份返回结构里**可见**。这一点是刻意的 —— 覆盖「放在我们的
   * 目录里」与「属于我们」之间的缝时，最容易写出的错法是「不碰、也不说」，于是下次有人
   * 排查「启动回收什么都没干」时无从下手。不变式的完整表述见 `reap` 的 doc 注释。
   */
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
 * 归属比较只区分「win32」与「非 win32」两种语义。`NodeJS.Platform` 里没有 `"posix"` 这个取值，
 * 所以这里显式把它作为一个**语义名**加进来（`"posix"` ≡「非 win32」分支）：测试要在**任意**平台上
 * 钉住「POSIX 语义不变」，就不能只传 `NodeJS.Platform` 里的某个具体平台（在 Windows runner 上
 * 传 `"linux"` 也过得去，但那把断言的意图藏进了一个具体平台名里）。**纯类型放宽、零行为变化**：
 * `"posix"` 与 `"linux"` / `"darwin"` 走同一条 `return p` 分支。
 */
type ComparePlatform = NodeJS.Platform | "posix";

/**
 * 把路径统一成「可比较的形态」，**只**用于归属比较，绝不用于任何文件系统操作。
 *
 * 为什么必须有这一层（而不是直接 `===`）：归属比较的两侧来路不同 —— 一侧是 git 报出的路径，
 * 一侧是本地 `fs.realpath` / `path.join` 拼出来的路径。在 Windows 上二者的**写法可以不同**：
 * `fs.realpath` / `join` 产出 `C:\…\.worktree`，而 git-for-Windows 的 porcelain 惯用 `C:/…/.worktree`；
 * 文件系统又不区分大小写（`C:\A` 与 `c:\a` 是同一目录）。严格 `!==` 会把**我们自己的每一个工作树**
 * 都判成外来树 ⇒ reap 在 Windows 上**静默什么都不做**（还顺带把自家树报进 `foreign`，更具误导性）。
 * Windows 是发布目标之一，所以这不是洁癖：把正当情况变成永久失效，正是本模块要消灭的失败类。
 *
 * 两条规则与取舍：
 * 1. **分隔符**：`\` 与 `/` 在 Windows 上都合法、且会被 git 与 fs 交替产出，统一成 `/` 才能比较。
 * 2. **大小写**：只在 **win32** 上折叠。POSIX 区分大小写（`/A` 与 `/a` 是两个不同目录），
 *    折叠会把两棵**不同**的树误判成同一棵 —— 那是**误删**方向，比漏删更危险。所以按平台语义处理。
 *
 * POSIX 分支**原样返回**：这保证既有（macOS/Linux）行为一字节不变。
 */
function normalizeForCompare(p: string, platform: ComparePlatform = process.platform): string {
  if (platform !== "win32") {
    return p;
  }
  return p.replaceAll("\\", "/").toLowerCase();
}

/**
 * 「这两条路径指的是同一处吗」：**两侧都**过 `normalizeForCompare` 再比，绝不直接 `!==`。
 *
 * 导出是为了让测试能在 macOS 上传 `"win32"` / `"posix"` 喂不同平台形态的输入，
 * 从而在本机钉住两侧语义（见 orphanReaper.test.ts）。
 *
 * @param platform **只有 `"win32"` 会走大小写折叠分支**；其余取值（含测试用的 `"posix"`）一律按
 *   POSIX 语义原样比较。
 */
export function isSamePath(
  a: string,
  b: string,
  platform: ComparePlatform = process.platform,
): boolean {
  return normalizeForCompare(a, platform) === normalizeForCompare(b, platform);
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
 * 1. **不碰外来工作树**。归属先按**根**判（`dirname(path) === <repoRoot>/.worktree`），不按路径形状猜，
 *    也不按 basename 去 `.worktree/` 下硬拼 —— 撞名时那会摘错树、删错分支。外来项只进 `foreign`。
 *    为什么不改成「响亮拒绝」：只要用户自己在仓库里 `git worktree add` 过一个工作树（完全正当、
 *    与我们无关），启动回收就会**永久整体失败** ⇒ 孤儿永远清不掉 ⇒ 后续重派发反而撞「分支已存在」。
 *    把一个无关情况变成回收器的永久故障，代价远大于「静默」。
 *    **但「在本根下」只说明「放在我们的目录里」，不说明「属于我们」**：还需要分支命名空间那一闸，
 *    见 `reap` 的归属不变式（B‑0，2026-10-01）。
 * 2. **不碰 `squad/integration/**`**。集成分支承载整批未合并的成果，删它就是丢活；它由 Task 3 的
 *    `discardIntegration` 在**整批合回主分支之后**负责删除。这条边界**两遍都要守**，
 *    且两遍的判据都是**命名空间**：分支那一遍只枚举 `MEMBER_NAMESPACE`（该命名空间之外根本不进视野），
 *    工作树那一遍由命名空间闸整项跳过（`squad/integration/**` 不在 `MEMBER_NAMESPACE` 里，故被闸挡住）。
 *    `INTEGRATION_NAMESPACE` 那条显式判断**保留**：它如今被命名空间闸遮蔽（不可达），但它把
 *    「集成分支承载整批未合并的成果」这条理由单独钉在自己的测试上 —— 将来有人放宽/重排命名空间闸，
 *    这条仍会在 `kept` 语义上响（与 `BRANCH_TAKEN` 保留一条死臂同一取舍：显式写上一条本就该成立的
 *    事实，比只靠另一条闸的副作用更耐改）。两个命名空间都取自 `branchNaming.ts` 一处定义。
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
    /**
     * 回收一遍：把「**属于本流程**、又不在活跃集合里」的工作树连分支收掉，再收掉同样的残枝。
     *
     * ——回收器的归属不变式（2026-10-01 修正，P2a 遗留语义）——
     *
     * **归属判据 = 分支命名空间，不是路径。**
     * `dirname(path) === <repoRoot>/.worktree` 只说明「**放在我们的目录里**」，
     * **不说明**「**属于我们**」：用户在同一个目录里放过自己的工作树（`git worktree add`）、
     * 或将来别的功能复用该目录，都会落进这个判据里，而它们的判据「分支不在 `activeBranches`」
     * **恒为真**（`activeBranches` 是产品运行台账，外围分支永远不在里面）⇒ 会被当成孤儿收掉。
     * 故本模块**两遍都按 `MEMBER_NAMESPACE` 限域**，集成分支仍保护不删，**命名空间外的一律不碰**，
     * 且必须落进 `kept` / `foreign` 可报告通道（**不得静默**）。
     * 任何把「在不在我们的目录里」当成「属不属于我们」的改写都是回归。
     *
     * 为什么写在这里而不是只写在实现里：行为会被下一个作者照自己的理解改回去（P2a 就是这么只给
     * 第一遍补了 `INTEGRATION_NAMESPACE` 一个前缀）；不变式写在契约注释里，改动时才会先撞上它。
     */
    async reap({ activeBranches }) {
      const active = new Set(activeBranches);
      // 用 canonicalPath(repoRoot) 再拼，而不是 realpath 拼好的工作树根：后者要求 `.worktree`
      // 已经存在（一次都没建过工作树时它不在），那会把「根本没有工作树」错算成「根路径不同」。
      // canonicalPath 从 worktreeManager 取（两侧共用同一份实现，终审 M4）—— 不归一化会把自家树
      // 全判成外来树、回收静默空转，理由见它的 doc 注释。
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
        // 比较用 `isSamePath` 而不是 `!==`：两侧来路不同（git 报出的 vs realpath 拼的），
        // Windows 上分隔符/大小写写法可以不同，直接 `!==` 会把自家树全判成外来（见 normalizeForCompare）。
        if (!isSamePath(dirname(entry.path), ourRoot)) {
          foreign.push(entry.path);
          continue;
        }
        const dirName = basename(entry.path);
        /* **第二道闸：分支不属于小队命名空间的一律不动**，计入 `kept`（B‑0，2026-10-01）。
           为什么不能只看「在不在我们的目录里」：那是**路径代理**，而 `activeBranches` 是产品运行台账，
           任何非小队工作树的分支都不在里面 ⇒ 那条判据对它们恒为真、把它们全部当孤儿（连树带枝收掉，
           且不报错）。用户自己 `git worktree add`、将来别的功能复用 `.worktree/`，都会撞上这一格。
           `entry.branch === null`（detached）同样**不碰**：没有分支就没有命名空间，无法证明它属于我们
           （我们自己的树恒由 `add -b` 建出，必有分支 ⇒ 没分支的树只可能是别人的或残骸）。
           代价是这类树会一直留在 `.worktree/` 下并每轮出现在 `kept` 里（可见，不静默）；换来的是
           「绝不误删不属于我们的东西」——误删方向不可逆，留下方向只要看得见就能人工收。 */
        if (entry.branch === null || !entry.branch.startsWith(MEMBER_NAMESPACE)) {
          kept.push(dirName);
          continue;
        }
        // 集成分支边界（与分支那一遍同一条边界，brief 裁定 2）：集成分支承载整批未合并的成果，
        // 由 Task 3 的 discardIntegration 在整批合回主分支之后删。今天 `ensureIntegration` 只跑
        // `git branch`、从不建工作树，所以第一遍走不到这里；但将来若有调用方在 `.worktree/` 下给
        // 集成分支挂了工作树，第一遍会无条件把它当孤儿删掉 —— 那是丢整批未合并的活。
        // 命中即**整项跳过并计入 `kept`**：不摘它的树（树里可能有未提交的集成成果），更不删它的分支。
        // 计入 `kept` 而非新增一个桶：`kept` 的语义就是「本流程看见了、但决定原样不动」。
        if (entry.branch !== null && entry.branch.startsWith(INTEGRATION_NAMESPACE)) {
          kept.push(dirName);
          continue;
        }
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
