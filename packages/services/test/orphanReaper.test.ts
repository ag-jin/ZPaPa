import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { memberDirName, planBranches } from "../src/worktree/branchNaming.js";
import {
  createOrphanReaper,
  isSamePath,
  type ReapInput,
  type ReapOutcome,
} from "../src/worktree/orphanReaper.js";
import { deleteBranch } from "../src/worktree/integrationMerge.js";
import { createWorktreeManager, type WorktreeManager } from "../src/worktree/worktreeManager.js";
import { makeRepo, realGit } from "./helpers/gitFixture.js";

type Git = ReturnType<typeof realGit>;

/* 夹具的分支名**派生自 planBranches**，不写字面量：一是与计划/合并层的命名保持同一处来源
   （命名再改，夹具自动跟着走，不会留下一个过时却仍然绿的夹具）；二是 reap 注入的 deleteBranch
   走的是 Task 3 同一道 slug 闸门（`assertSafeSlug`），字面量写错一个字符就会撞在闸门上，
   而「这个名字是命名规则产出的」由构造方式保证，不必让测试去猜。 */
const memberBranch = (agentSlug: string): string =>
  planBranches({ workItemSlug: "wi1", agentSlug }).member;

/** 目录名与分支**同源**（`memberDirName`），不再手拼 `<wi>-<agent>`：手拼就是在夹具里再造一处
    「配对」的拼法，而配对不成立正是终审 Important-1 的形状（判定按分支、动作按目录名）。 */
const memberDir = (agentSlug: string): string =>
  memberDirName(planBranches({ workItemSlug: "wi1", agentSlug }));

const DIR_A = memberDir("a");
const DIR_B = memberDir("b");
const DIR_REVIEW = memberDir("review");
const DIR_ORPHAN = memberDir("orphan");
const WORKTREE_ROOT = ".worktree";

type ReaperOverrides = {
  deleteBranch?: (branch: string) => Promise<void>;
  listBranches?: (prefix: string) => Promise<string[]>;
};

type Fixture = {
  root: string;
  git: Git;
  manager: WorktreeManager;
  /** 与生产同形的注入：把 Task 3 的三参 deleteBranch 绑定成单参；分支枚举器走真 git。 */
  reaper: (overrides?: ReaperOverrides) => {
    reap(input: ReapInput): Promise<ReapOutcome>;
  };
};

/**
 * 真 git 的分支枚举器（生产 deps 契约就是这个形状）：按**分支名前缀**列出短名。
 * 用 `for-each-ref refs/heads/<prefix>` 而不是 `branch --list <glob>`：前缀是 ref 名的真实前缀，
 * 没有通配符语义可以走偏（实测 `branch --list 'squad/*'` 的 `*` 会跨 `/`，把两个命名空间一起捞进来）。
 * 必须真的问 git 而不是按目录名猜：本模块要看见的恰恰是**没有工作树**的分支，
 * 只有 git 自己知道有哪些 ref。
 */
function realListBranches(git: Git, root: string): (prefix: string) => Promise<string[]> {
  return async (prefix) => {
    const result = await git(
      ["for-each-ref", "--format=%(refname:short)", `refs/heads/${prefix}`],
      {
        cwd: root,
      },
    );
    if (result.code !== 0) {
      throw new Error(`git for-each-ref 失败 (exit ${result.code}): ${result.stderr.trim()}`);
    }
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  };
}

async function fixture(): Promise<Fixture> {
  const root = await makeRepo();
  const git = realGit(root);
  const manager = createWorktreeManager({ git, repoRoot: root });
  const listBranches = realListBranches(git, root);
  return {
    root,
    git,
    manager,
    reaper: (overrides) =>
      createOrphanReaper({
        manager,
        repoRoot: root,
        deleteBranch: overrides?.deleteBranch ?? ((branch) => deleteBranch(git, root, branch)),
        listBranches: overrides?.listBranches ?? listBranches,
      }),
  };
}

async function addWorktree(f: Fixture, agentSlug: string, dirName: string): Promise<void> {
  await f.manager.add({ branch: memberBranch(agentSlug), base: "main", dirName });
}

function worktreePath(f: Fixture, dirName: string): string {
  return join(f.root, WORKTREE_ROOT, dirName);
}

function branchExists(f: Fixture, branch: string): Promise<boolean> {
  return f
    .git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: f.root })
    .then((r) => r.code === 0);
}

/** 断言「已回收」的实体状态：目录与分支都没了 —— 报告里的字符串不算数，落盘的东西才算。 */
async function assertFullyReclaimed(f: Fixture, dirName: string, branch: string): Promise<void> {
  assert.equal(existsSync(worktreePath(f, dirName)), false, `${dirName} 的目录应已删除`);
  assert.equal(await branchExists(f, branch), false, `${branch} 应已删除`);
}

// ── 裁定 1：归属比较必须跨平台（分隔符 / 大小写），且在 macOS 上可测 ──────────────

test("同一路径判定跨平台：Windows 的分隔符/大小写差异算同一条路径，POSIX 语义不变", () => {
  // 在 macOS 上用 `path.win32` 造 Windows 形态的输入：`fs.realpath`/`join` 产出 `C:\a\.worktree`，
  // 而 git-for-Windows 的 porcelain 惯用 `C:/a/.worktree`。严格 `!==` 会把自家工作树全判成外来树
  // ⇒ reap 在 Windows 上静默什么都不做。这里钉住「分隔符/大小写差异被判为同一路径」。
  const fromFs = win32.join("C:\\a", ".worktree"); // "C:\a\.worktree"
  assert.equal(isSamePath(fromFs, "C:/a/.worktree", "win32"), true, "分隔符差异：同一路径");
  assert.equal(
    isSamePath("C:/A/.worktree", "c:/a/.worktree", "win32"),
    true,
    "大小写差异：Windows 不区分大小写，同一路径",
  );
  // POSIX 断言：证明既有行为未变 —— 两侧都是 `/`，且**区分**大小写（折叠会把两棵不同的树误判成同一棵）。
  // 这三条**显式传 `"posix"`**：不传就会用默认的 `process.platform`，在 Windows runner 上默认是 win32
  // （届时大小写被折叠、`\` 被当分隔符），两条「不等」断言会因平台而非代码而红 —— 而 Windows 是
  // 我们的构建目标之一，不能留一条只在 macOS 上成立的断言。
  assert.equal(isSamePath("/repo/.worktree", "/repo/.worktree", "posix"), true, "POSIX：同一路径");
  assert.equal(
    isSamePath("/repo/.worktree", "/repo/.workTree", "posix"),
    false,
    "POSIX：区分大小写 ⇒ 不同路径",
  );
  // 分隔符的规范化只在 win32 上发生（否则会把 POSIX 里合法的含 `\` 文件名改写掉）。
  assert.equal(
    isSamePath("/repo\\.worktree", "/repo/.worktree", "posix"),
    false,
    "POSIX：反斜杠不是分隔符，原样比较",
  );
});

// ── brief Step 1 的四条（夹具名派生，断言体逐字保留）────────────────────────────

test("回收不在活跃集合里的工作树", async () => {
  const f = await fixture();
  await addWorktree(f, "a", DIR_A);
  await addWorktree(f, "b", DIR_B);
  const out = await f.reaper().reap({ activeBranches: [memberBranch("a")] });
  assert.deepEqual(out.reclaimed, [DIR_B]);
  assert.deepEqual(out.kept, [DIR_A]);
  // 字符串只是「说了什么」，实体状态才是「做了什么」：被回收的那个连目录带分支都得没了。
  await assertFullyReclaimed(f, DIR_B, memberBranch("b"));
  assert.equal(existsSync(worktreePath(f, DIR_A)), true);
  assert.equal(await branchExists(f, memberBranch("a")), true);
  // 分支那一遍（枚举命名空间）不该把已经收掉的分支再「收」一次：它不在了，就什么都不该报告。
  assert.deepEqual(out.reclaimedBranches, [memberBranch("b")]);
});

// 这条是「清理是正确性前置」的机器化证明：回收后同一分支必须能重新建。
test("回收后同一分支可重新建工作树", async () => {
  const f = await fixture();
  await addWorktree(f, "a", DIR_A);
  await f.reaper().reap({ activeBranches: [] });
  await assert.doesNotReject(
    f.manager.add({ branch: memberBranch("a"), base: "main", dirName: DIR_A }),
  );
  assert.equal((await f.manager.list()).length, 1);
});

// 只回收工作树而留下分支残枝，会让重派发撞上「分支已存在」——所以 reap 必须连分支一起收。
test("回收后孤儿分支确实不存在了", async () => {
  const f = await fixture();
  await addWorktree(f, "orphan", DIR_ORPHAN);
  await f.reaper().reap({ activeBranches: [] });
  const branches = await f.git(["branch", "--list", memberBranch("orphan")], { cwd: f.root });
  assert.equal(branches.stdout.trim(), "");
});

// 未合并（仍在活跃集合里）的工作树绝不能被回收：否则队员的活白干。
test("活跃分支对应的工作树被保留", async () => {
  const f = await fixture();
  await addWorktree(f, "review", DIR_REVIEW);
  const out = await f.reaper().reap({ activeBranches: [memberBranch("review")] });
  assert.deepEqual(out.kept, [DIR_REVIEW]);
});

// ── 「未合并的活真的还在」：保留不是「没删目录」，而是队员的成果原样在位 ──────────

test("保留的活跃工作树里，队员的未合并/未提交改动都原样还在", async () => {
  const f = await fixture();
  await addWorktree(f, "review", DIR_REVIEW);
  const dir = worktreePath(f, DIR_REVIEW);
  writeFileSync(join(dir, "unmerged.txt"), "队员还没提交的成果\n");
  writeFileSync(join(dir, "a.txt"), "1\n已改但未提交\n");

  const out = await f.reaper().reap({ activeBranches: [memberBranch("review")] });

  assert.deepEqual(out.reclaimed, []);
  // 只断「目录还在」太弱：reap 完全可能重挂/清空它。逐字比对内容才算「活没白干」。
  assert.equal(readFileSync(join(dir, "unmerged.txt"), "utf8"), "队员还没提交的成果\n");
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "1\n已改但未提交\n");
  assert.equal(await branchExists(f, memberBranch("review")), true);
});

// ── 穷举：activeBranches 的四种形态 ───────────────────────────────────────────

test("activeBranches 为空：全部回收，结果按 git 报出的顺序", async () => {
  const f = await fixture();
  await addWorktree(f, "a", DIR_A);
  await addWorktree(f, "b", DIR_B);
  // git 的 worktree list 按路径排序（.worktree 下即目录名字典序），所以顺序是可预期的字面值。
  const out = await f.reaper().reap({ activeBranches: [] });
  assert.deepEqual(out.reclaimed, [DIR_A, DIR_B]);
  assert.deepEqual(out.kept, []);
  await assertFullyReclaimed(f, DIR_A, memberBranch("a"));
  await assertFullyReclaimed(f, DIR_B, memberBranch("b"));
  assert.deepEqual(await f.manager.list(), []);
});

test("activeBranches 含全部：一个都不动（分支与工作树都在）", async () => {
  const f = await fixture();
  await addWorktree(f, "a", DIR_A);
  await addWorktree(f, "b", DIR_B);
  const out = await f.reaper().reap({
    // 重复项是常态（多个 run 引用同一分支）：判定用集合语义，重复不该让某项被处理两次。
    activeBranches: [memberBranch("a"), memberBranch("a"), memberBranch("b")],
  });
  assert.deepEqual(out.reclaimed, []);
  assert.deepEqual(out.kept, [DIR_A, DIR_B]);
  assert.equal(existsSync(worktreePath(f, DIR_A)), true);
  assert.equal(existsSync(worktreePath(f, DIR_B)), true);
  assert.equal(await branchExists(f, memberBranch("b")), true);
  assert.equal((await f.manager.list()).length, 2);
  // 第二遍（枚举命名空间）也不该碰活跃分支：它在活跃集合里，一个都不删。
  assert.deepEqual(out.reclaimedBranches, []);
});

test("activeBranches 里是不存在的/非法的分支名：不误伤，孤儿照回收", async () => {
  const f = await fixture();
  await addWorktree(f, "a", DIR_A);
  await addWorktree(f, "b", DIR_B);
  // 计划外/已消失/名字可疑的项混在活跃集合里：它们只参与 Set 比较、从不进 git，
  // 所以既不该「认领」任何一项（让它逃过回收），也不该在碰 git 之前就整体拒掉。
  const out = await f.reaper().reap({
    activeBranches: [
      "squad/member/nope/ghost",
      "/absolute/evil",
      "squad/member/../../evil",
      memberBranch("a"),
      memberBranch("ghost"),
    ],
  });
  assert.deepEqual(out.reclaimed, [DIR_B]);
  assert.deepEqual(out.kept, [DIR_A]);
  await assertFullyReclaimed(f, DIR_B, memberBranch("b"));
});

test("回收是幂等的：连跑两次，第二次没有可回收项", async () => {
  const f = await fixture();
  await addWorktree(f, "a", DIR_A);
  await addWorktree(f, "b", DIR_B);
  const first = await f.reaper().reap({ activeBranches: [] });
  assert.deepEqual(first.reclaimed, [DIR_A, DIR_B]);

  const second = await f.reaper().reap({ activeBranches: [] });
  // 幂等要求「第二次为空」而不是「第二次不报错」：残留的可回收项意味着第一次没收干净
  // （或 list() / 分支枚举里混进了刚要崩掉的东西）。
  assert.deepEqual(second, { reclaimed: [], kept: [], foreign: [], reclaimedBranches: [] });
});

// ── 不得回收主工作树（Task 1 的 list 已排除；这里核实这条前提真的成立）──────────

test("主工作树绝不被回收：根目录、主分支与主分支上的文件都不动", async () => {
  const f = await fixture();
  await addWorktree(f, "a", DIR_A);
  await f.reaper().reap({ activeBranches: [] });

  assert.equal(existsSync(join(f.root, "a.txt")), true);
  assert.equal(existsSync(join(f.root, ".git")), true);
  const head = await f.git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: f.root });
  assert.equal(head.stdout.trim(), "main");
  const branches = await f.git(["branch", "--list", "main"], { cwd: f.root });
  assert.match(branches.stdout, /main/);
});

// ── 顺序契约：先摘工作树、后删分支 ────────────────────────────────────────────

test("顺序契约：删分支时该分支已不再被工作树检出（反了 git 会拒绝删除）", async () => {
  const f = await fixture();
  await addWorktree(f, "a", DIR_A);
  let dirWasGoneWhenDeleting = false;
  await f
    .reaper({
      deleteBranch: async (branch) => {
        // 分支还被工作树检出时 `git branch -D` 会被 git 拒绝（Task 3 实测），所以「删分支能成功」
        // 本身就是顺序的证据；这里再钉一层：调用时目录必须已经摘掉了。
        dirWasGoneWhenDeleting = !existsSync(worktreePath(f, DIR_A));
        await deleteBranch(f.git, f.root, branch);
      },
    })
    .reap({ activeBranches: [] });

  assert.equal(dirWasGoneWhenDeleting, true);
  await assertFullyReclaimed(f, DIR_A, memberBranch("a"));
});

// ── 散落文件：非 worktree 的东西不能被误伤，工作树里的东西不能挡路 ──────────────

test("工作树内有未跟踪的散落文件时，回收照样成功并连它一起清掉", async () => {
  const f = await fixture();
  await addWorktree(f, "b", DIR_B);
  const dir = worktreePath(f, DIR_B);
  writeFileSync(join(dir, "stray.txt"), "崩溃前留下的半成品\n");
  writeFileSync(join(dir, "a.txt"), "1\n改了没提交\n");

  const out = await f.reaper().reap({ activeBranches: [] });

  // 抛弃语义：这些东西不参与合并（合并按分支走），留着它们会让收尾卡死在 git 的拒绝上。
  assert.deepEqual(out.reclaimed, [DIR_B]);
  await assertFullyReclaimed(f, DIR_B, memberBranch("b"));
});

test(".worktree/ 根下不属于任何工作树的散落文件与散落目录，回收都不碰", async () => {
  const f = await fixture();
  await addWorktree(f, "a", DIR_A);
  const strayPath = worktreePath(f, "stray-root.txt");
  const looseDir = worktreePath(f, "loose-dir");
  writeFileSync(strayPath, "不属于任何工作树\n");
  mkdirSync(looseDir, { recursive: true });

  const out = await f.reaper().reap({ activeBranches: [] });

  // reap 的视野是 git 报出的工作树（list()）与 git 报出的分支，不是「目录内容」——没有「顺手清目录」这回事。
  assert.deepEqual(out.reclaimed, [DIR_A]);
  assert.equal(existsSync(strayPath), true);
  assert.equal(existsSync(looseDir), true);
});

// ── 矩阵外：detached 工作树（Task 1 的 list 会给出 branch === null）────────────

test("detached 工作树（branch 为 null）：摘掉工作树，但不拿 null 去删分支", async () => {
  const f = await fixture();
  await f.git(["worktree", "add", "--detach", worktreePath(f, "det"), "main"], { cwd: f.root });
  const deleted: string[] = [];

  const out = await f
    .reaper({
      deleteBranch: async (branch) => {
        deleted.push(branch);
        await deleteBranch(f.git, f.root, branch);
      },
    })
    .reap({ activeBranches: [] });

  assert.deepEqual(out.reclaimed, ["det"]);
  // 没有分支可删：把 null 喂给 deleteBranch 会变成「删一个叫 null 的分支」这种假动作。
  assert.deepEqual(deleted, []);
  assert.equal(existsSync(worktreePath(f, "det")), false);
});

// ── 判定 1：外来工作树 —— 不抛、不碰、要可见 ───────────────────────────────────

test("外来工作树（不在 <repoRoot>/.worktree/ 下）：不抛、不碰，且进 foreign 可见", async () => {
  const f = await fixture();
  await addWorktree(f, "a", DIR_A);
  // 用户自己在仓库里建的工作树：完全正当，与本流程无关。
  const outside = join(f.root, "zzz-outside");
  await f.git(["worktree", "add", "-q", "-b", "user/own-branch", outside, "main"], {
    cwd: f.root,
  });
  const listed = await f.manager.list();
  assert.deepEqual(
    listed.map((entry) => entry.branch),
    [memberBranch("a"), "user/own-branch"],
    "夹具前提：本流程的工作树排在外部工作树之前",
  );

  // 归属按**根**判：不在 <repoRoot>/.worktree/ 下的都不是本流程的树。
  // 以前这里是「响亮拒绝」，代价是：用户只要自己建过一个工作树，启动回收就**永久整体失败**，
  // 孤儿永远清不掉，后续重派发反而撞「分支已存在」。现在改为**跳过 + 报出来**（不抛）。
  const out = await f.reaper().reap({ activeBranches: [] });

  // 跳过不等于隐形：外来的树要出现在 foreign 里（值是 git 报出的路径，与它在 list() 里的形态一致）。
  assert.deepEqual(
    out.foreign,
    [realpathSync(outside)],
    "外来的树必须出现在 foreign 里（跳过必须可见）",
  );
  // 它不混进任何一个「本流程」的桶：既没被回收，也不是我们保留的。
  assert.deepEqual(out.reclaimed, [DIR_A], "外来项不阻断本流程的回收");
  assert.deepEqual(out.kept, [], "外来项不是「我们保留的」，不能混进 kept");
  // 外部工作树与它的分支、它的内容原封不动。
  assert.equal(existsSync(outside), true);
  assert.equal(existsSync(join(outside, "a.txt")), true);
  assert.equal(await branchExists(f, "user/own-branch"), true);
  // 本流程的树照常回收干净。
  await assertFullyReclaimed(f, DIR_A, memberBranch("a"));

  rmSync(outside, { recursive: true, force: true });
});

// ── 判定 2 的边界：集成分支绝不能被「分支那一遍」误伤 ───────────────────────────

test("绝不碰集成分支：不在活跃集合里、也没有工作树的集成分支，reap 后必须还在", async () => {
  const f = await fixture();
  const integration = planBranches({ workItemSlug: "wi1", agentSlug: "a" }).integration;
  const member = memberBranch("a");
  // 同形状的对照：一条集成分支 + 一条队员残枝，都不在活跃集合里、都没有工作树。
  // 两者的唯一差别只在命名空间的第二段（integration / member），所以这条用例钉住的正是那条边界。
  await f.git(["branch", integration, "main"], { cwd: f.root });
  await f.git(["branch", member, "main"], { cwd: f.root });
  assert.equal(await branchExists(f, integration), true, "夹具前提：集成分支已建出");

  const out = await f.reaper().reap({ activeBranches: [] });

  // 集成分支承载整批未合并的成果，删它就是丢活；它由 Task 3 的 discardIntegration 在整批合回
  // 主分支之后删除，不在本模块的命名空间里。这条边界只由 MEMBER_NAMESPACE **一处**保证：
  // 把传给 listBranches 的前缀误写成会命中它的值（如 `squad/`），这条就会变红（变异验证 (b)）。
  assert.equal(await branchExists(f, integration), true, "集成分支绝不能被回收");
  assert.deepEqual(out.reclaimedBranches, [member], "只有队员残枝进了视野");
});

// 第一遍（工作树那一遍）也守同一条边界：上面的用例只覆盖第二遍的形状，抓不到这条。
test("第一遍也守集成分支边界：.worktree/ 下的集成分支工作树不被回收，且计入 kept", async () => {
  const f = await fixture();
  const integration = planBranches({ workItemSlug: "wi1", agentSlug: "a" }).integration;
  const dirName = "wi1-int";
  // 将来可能出现的形状：某调用方在 `.worktree/` 下给**集成分支**挂了工作树。今天 ensureIntegration
  // 只跑 git branch、不建工作树，所以**不可达**；但一旦如此，第一遍会无条件把「本根下任何工作树」
  // 当孤儿摘掉 —— 那会删掉整批未合并的集成分支（而现有边界测试只覆盖第二遍，抓不到）。
  await f.manager.add({ branch: integration, base: "main", dirName });

  const out = await f.reaper().reap({ activeBranches: [] });

  // 核心不可协商：集成分支**绝不能被删**（它承载整批未合并的成果，归 Task 3 的 discardIntegration 管）。
  assert.equal(await branchExists(f, integration), true, "集成分支绝不能被第一遍删掉");
  assert.deepEqual(out.reclaimedBranches, [], "第一遍不该删任何分支");
  assert.deepEqual(out.reclaimed, [], "第一遍不该回收任何工作树");
  // 语义选择：命中即**整项计入 `kept`**（连工作树一起原样不动，而不是「摘树留分支」）。
  // 理由：树里可能有未提交的集成成果，摘它就是丢活；而 `kept` 的既有语义正是「本流程看见了、
  // 但决定原样不动」，与「活跃分支对应的工作树」同类，故沿用而不另开一个桶。
  assert.deepEqual(out.kept, [dirName]);
  assert.equal(existsSync(worktreePath(f, dirName)), true, "集成分支的工作树也原样不动");
});

test("外来工作树检出的队员分支不被删，「未被存活工作树检出」这个判据承重", async () => {
  const f = await fixture();
  const member = memberBranch("b");
  const outside = join(f.root, "zzz-outside");
  await f.git(["branch", member, "main"], { cwd: f.root });
  await f.git(["worktree", "add", "-q", outside, member], { cwd: f.root });

  const out = await f.reaper().reap({ activeBranches: [] });

  // 这条分支「不在活跃集合里」，但它正被一棵**存活**的工作树检出（那棵是外来的树，按设计不动）。
  // 删它就是把别人手里的活抽走，git 也会拒绝（`Cannot delete branch '…' checked out at '…'`）——
  // 所以「未被任何存活工作树检出」这个判据必须真的承重，而不是一句注释。
  assert.deepEqual(out.foreign, [realpathSync(outside)]);
  assert.equal(await branchExists(f, member), true, "被存活工作树检出的分支必须保留");
  assert.deepEqual(out.reclaimedBranches, []);

  rmSync(outside, { recursive: true, force: true });
});

// ── 判定 2：分支残枝进视野（以前是「记录：…」，缺口已补 ⇒ 现在是真断言）──────────

test("分支残枝（有分支、无工作树）进视野：reap 后分支消失，同一分支可重新 add", async () => {
  const f = await fixture();
  // 残枝的真实成因（Task 1/3 都实测过）：`worktree add` **先建分支、后因目标路径已存在而失败**，
  // 于是留下一条没有工作树的分支 —— 它不在 `worktree list` 里，`prune()` 也不删分支，
  // 所以只做工作树那一遍就永远看不见它。
  mkdirSync(worktreePath(f, DIR_ORPHAN), { recursive: true });
  writeFileSync(join(worktreePath(f, DIR_ORPHAN), "占用.txt"), "x\n");
  await assert.rejects(
    f.manager.add({ branch: memberBranch("orphan"), base: "main", dirName: DIR_ORPHAN }),
    /already exists/i,
    "夹具前提：add 失败，但分支已经被建出来了",
  );
  assert.equal(await branchExists(f, memberBranch("orphan")), true, "夹具前提：残枝确实留下了分支");

  const out = await f.reaper().reap({ activeBranches: [] });

  // 这条用例以前叫「记录：分支残枝…也在视野之外」，注释写的是「变红 ⇔ 缺口已补」。
  // 缺口已补 ⇒ 现在是真的断言：残枝的分支确实被回收了。
  assert.equal(await branchExists(f, memberBranch("orphan")), false, "残枝的分支必须被回收");
  // 残枝没有工作树 ⇒ 不进 reclaimed；被删的是分支 ⇒ 进 reclaimedBranches。
  assert.deepEqual(out.reclaimed, []);
  assert.deepEqual(out.reclaimedBranches, [memberBranch("orphan")]);

  // 「清理是正确性前置」的机器化证明：回收后**同一分支**必须能重新 add。
  // 先清掉那个占位目录 —— 它**不是工作树**，reap 按设计不碰它（视野是 git 报出的工作树与分支，
  // 不是目录内容）；它是这次 add 失败的原因，不是 reap 的清理对象。
  rmSync(worktreePath(f, DIR_ORPHAN), { recursive: true, force: true });
  await assert.doesNotReject(
    f.manager.add({ branch: memberBranch("orphan"), base: "main", dirName: DIR_ORPHAN }),
  );
  assert.equal((await f.manager.list()).length, 1);
});

test("残骸（git 登记着、目录被外部删掉）的分支也进视野：prune 后由分支那一遍收掉", async () => {
  const f = await fixture();
  await addWorktree(f, "orphan", DIR_ORPHAN);
  // 残骸的真实成因：工作面被外部删掉（用户手删 / 临时目录清理），git 侧仍登记着它。
  rmSync(worktreePath(f, DIR_ORPHAN), { recursive: true, force: true });

  const out = await f.reaper().reap({ activeBranches: [] });

  // 这条用例以前也叫「记录：…」（「变红 ⇔ 缺口已补」）⇒ 缺口已补，翻转成真断言。
  assert.deepEqual(out.reclaimed, []); // 目录没了，没有工作树可摘
  assert.deepEqual(out.reclaimedBranches, [memberBranch("orphan")]);
  assert.equal(await branchExists(f, memberBranch("orphan")), false, "残骸的分支必须被回收");
  // prune 真的跑了、而且跑在分支那一遍**之前**：git 仍登记着残骸时，它认为残骸正检出着这条分支，
  // `git branch -D` 会被拒（实测 `Cannot delete branch '…' checked out at '…'`）。
  // 所以这条 porcelain 断言同时钉住「prune 有跑」与「prune 在两遍之间」。
  const porcelain = await f.git(["worktree", "list", "--porcelain"], { cwd: f.root });
  assert.equal(
    porcelain.stdout.split("\n").filter((line) => line.startsWith("worktree ")).length,
    1,
    "git 侧不再登记这条残骸",
  );
  // 同一分支可重新 add：残骸这条路上分支名同样不再被占。
  await assert.doesNotReject(
    f.manager.add({ branch: memberBranch("orphan"), base: "main", dirName: DIR_ORPHAN }),
  );
});

// ── 失败不静默 ──────────────────────────────────────────────────────────────

test("删分支失败时 reap 抛出，不把「只摘了工作树」当成回收成功", async () => {
  const f = await fixture();
  await addWorktree(f, "a", DIR_A);

  // 半拉子清理正是本任务要消灭的东西：摘了树却没删分支，如果被吞掉，调用方看到的是
  // 「回收成功」，而重派发会撞上「分支已存在」——报错必须留给调用方看见。
  await assert.rejects(
    f
      .reaper({
        deleteBranch: async () => {
          throw new Error("git branch -D 失败");
        },
      })
      .reap({ activeBranches: [] }),
    /git branch -D 失败/,
  );
});

test("分支枚举失败时 reap 抛出，不把「残枝那一半没做」当成回收成功", async () => {
  const f = await fixture();
  await addWorktree(f, "a", DIR_A);

  // 第二遍依赖注入的枚举器：它失败就意味着残枝这一半完全没做。吞掉它 = 调用方看到「回收成功」，
  // 而残枝还在占着分支名 —— 与「删分支失败要响」同一条道理（fail-fast，不改成「尽量多回收 + 汇总」）。
  await assert.rejects(
    f
      .reaper({
        listBranches: async () => {
          throw new Error("git for-each-ref 失败");
        },
      })
      .reap({ activeBranches: [] }),
    /for-each-ref 失败/,
  );
});
