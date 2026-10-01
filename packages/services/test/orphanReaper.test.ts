import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planBranches } from "../src/worktree/branchNaming.js";
import { createOrphanReaper } from "../src/worktree/orphanReaper.js";
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

const DIR_A = "wi1-a";
const DIR_B = "wi1-b";
const DIR_REVIEW = "wi1-review";
const DIR_ORPHAN = "wi1-orphan";
const WORKTREE_ROOT = ".worktree";

type Fixture = {
  root: string;
  git: Git;
  manager: WorktreeManager;
  /** 与生产同形的注入：把 Task 3 的三参 deleteBranch 绑定成单参。 */
  reaper: (overrides?: { deleteBranch?: (branch: string) => Promise<void> }) => {
    reap(input: { activeBranches: readonly string[] }): Promise<{
      reclaimed: string[];
      kept: string[];
    }>;
  };
};

async function fixture(): Promise<Fixture> {
  const root = await makeRepo();
  const git = realGit(root);
  const manager = createWorktreeManager({ git, repoRoot: root });
  return {
    root,
    git,
    manager,
    reaper: (overrides) =>
      createOrphanReaper({
        manager,
        deleteBranch: overrides?.deleteBranch ?? ((branch) => deleteBranch(git, root, branch)),
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
  // （或 list() 里混进了刚要崩掉的东西）。
  assert.deepEqual(second, { reclaimed: [], kept: [] });
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

  // reap 的视野是 git 报出的工作树（list()），根下的散落文件/目录不在其中——没有「顺手清目录」这回事。
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

// ── 矩阵外：非本流程建的工作树（挂在本流程目录之外）────────────────────────────

test("挂在 .worktree/ 之外的工作树：响亮拒绝，且不动任何东西", async () => {
  const f = await fixture();
  await addWorktree(f, "a", DIR_A);
  // 故意取名排在 .worktree/ **之后**（git 按路径排序列出工作树）：于是「先动一个再发现不合法」
  // 这种实现会真的先摘掉 wi1-a，下面的零副作用断言才咬得住。
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

  // dirName 是从 git 报出的路径反推的，而 remove() 只会去 .worktree/<dirName> 找 ——
  // 别处的工作树反推出的名字会指向 .worktree/ 下的**另一个**目录，那就成了摘错树、删错分支。
  // 所以这里必须响亮拒绝，而不是「拼一把」：拒绝发生在任何 remove/deleteBranch 之前。
  await assert.rejects(f.reaper().reap({ activeBranches: [] }), /\.worktree/);

  assert.equal(existsSync(outside), true);
  assert.equal(await branchExists(f, "user/own-branch"), true);
  assert.equal(existsSync(worktreePath(f, DIR_A)), true);
  assert.equal(await branchExists(f, memberBranch("a")), true);

  rmSync(outside, { recursive: true, force: true });
});

// ── 矩阵外：只有分支、没有工作树的残枝（第二种「视野之外」的形状）──────────────

test("记录：分支残枝（无工作树）也在视野之外，重派发仍会撞「分支已存在」", async () => {
  const f = await fixture();
  // 残枝的真实成因（Task 1/3 都实测过）：`worktree add` 先建分支、后失败（目标目录非空），
  // 于是留下一条**没有工作树**的分支 —— 它不出现在 `worktree list` 里，reap 的视野是工作树。
  mkdirSync(worktreePath(f, DIR_ORPHAN), { recursive: true });
  writeFileSync(join(worktreePath(f, DIR_ORPHAN), "占用.txt"), "x\n");
  await assert.rejects(
    f.manager.add({ branch: memberBranch("orphan"), base: "main", dirName: DIR_ORPHAN }),
    /already exists/i,
    "夹具前提：add 失败但分支已被建出来",
  );
  assert.equal(await branchExists(f, memberBranch("orphan")), true);

  const out = await f.reaper().reap({ activeBranches: [] });

  // 视野之外 ⇒ 不回收。这条同样钉住缺口（变红 ⇔ 已补上）：reap 只按工作树枚举，
  // 而「只有分支」的孤儿恰恰没有工作树可枚举 —— 补法见 Task 4 报告（按命名空间枚举分支）。
  assert.deepEqual(out, { reclaimed: [], kept: [] });
  assert.equal(await branchExists(f, memberBranch("orphan")), true);
});

// ── 矩阵外：目录被外部删掉的残骸（已知缺口的可执行记录）────────────────────────
test("记录：目录已被外部删掉的残骸不在视野内，它的分支会留下（重派发仍会撞）", async () => {
  const f = await fixture();
  await addWorktree(f, "orphan", DIR_ORPHAN);
  // 残骸的真实成因：工作面被外部删掉（用户手删 / 临时目录清理），git 侧仍登记着它。
  rmSync(worktreePath(f, DIR_ORPHAN), { recursive: true, force: true });

  const out = await f.reaper().reap({ activeBranches: [] });

  // Task 1 的 list() 契约：目录不存在的残骸不算队员（不算进「队员数」），所以 reap 看不到它。
  assert.deepEqual(out, { reclaimed: [], kept: [] });
  // reap 末尾的 prune 真的跑了：git 侧不再登记这条残骸（否则每次启动都会反复列出同一个幽灵）。
  const porcelain = await f.git(["worktree", "list", "--porcelain"], { cwd: f.root });
  assert.equal(
    porcelain.stdout.split("\n").filter((line) => line.startsWith("worktree ")).length,
    1,
  );
  // 而 prune 只清 git 的登记项、**不删分支**：分支仍在 ⇒ 重派发会撞
  // 「a branch named '…' already exists」。这条用例把该缺口钉成可执行证据：
  // 它变红 ⇔ 缺口已被补上（例如 reap 改成先按命名空间枚举分支、再按 activeBranches 判定）。
  assert.equal(await branchExists(f, memberBranch("orphan")), true);
  await assert.rejects(
    f.manager.add({ branch: memberBranch("orphan"), base: "main", dirName: DIR_ORPHAN }),
    /already exists/,
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
