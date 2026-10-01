import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planBranches } from "../src/worktree/branchNaming.js";
import { createIntegrationMerger } from "../src/worktree/integrationMerge.js";
import { GitCommandError } from "../src/worktree/gitRunner.js";
import { createWorktreeManager, resolveWorktreeRoot } from "../src/worktree/worktreeManager.js";
import { makeRepo, realGit } from "./helpers/gitFixture.js";

type Git = ReturnType<typeof realGit>;

/* 分支名常量集中在这一处。
   **队员分支名与 brief 的字面写法（`squad/wi1/a`）不同，这是被 git 逼的，不是笔误**：
   `refs/heads/squad/wi1` 是一个**文件**，而 `refs/heads/squad/wi1/a` 需要同名的**目录** ——
   git 的 ref 存储不允许这种「文件/目录」共存（D/F 冲突）。实测（git 2.39.2）：
     `git branch squad/wi1 main` 之后再 `git branch squad/wi1/a main`
       → fatal: cannot lock ref 'refs/heads/squad/wi1/a': 'refs/heads/squad/wi1' exists; cannot create ...
     反序（先子后父）同样失败；`git update-ref` 绕过不了；`git pack-refs --all` 后也绕不过。
   ⇒ spec §6.3 的集成分支 `squad/<工作项>` 与计划的队员分支 `squad/<工作项>/<队员>` **不能同时存在**，
   本文件最后一条用例把这个事实钉成可执行证据。集成分支沿用 spec 的字面名，队员分支在夹具里改用扁平名；
   命名怎么裁由上层定（见 task-3-report.md），裁定后只改这三行。 */
const INTEGRATION = "squad/wi1";
const MEMBER_OK = "squad/wi1-a";
const MEMBER_B = "squad/wi1-b";
const MEMBER_CONFLICT = "squad/wi1-conflict";

async function must(git: Git, root: string, args: string[]): Promise<string> {
  const result = await git(args, { cwd: root });
  assert.equal(result.code, 0, `git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

/** 在 branch 上落一次提交（分支从 base 派生），随后把主工作树放回 base：队员「已提交的成果」就是这个形状。 */
async function commitOnBranch(
  git: Git,
  root: string,
  branch: string,
  files: Record<string, string>,
  base = "main",
): Promise<void> {
  await must(git, root, ["checkout", "-q", "-b", branch, base]);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content);
  }
  await must(git, root, ["add", "-A"]);
  await must(git, root, ["commit", "-qm", `work on ${branch}`]);
  await must(git, root, ["checkout", "-q", base]);
}

async function branchExists(git: Git, root: string, branch: string): Promise<boolean> {
  return (
    (await git(["rev-parse", "-q", "--verify", `refs/heads/${branch}`], { cwd: root })).code === 0
  );
}

async function refSha(git: Git, root: string, ref: string): Promise<string> {
  return (await must(git, root, ["rev-parse", ref])).trim();
}

/** `git status --porcelain` 的裁剪输出：空串即「工作区干净」。 */
async function porcelain(git: Git, root: string): Promise<string> {
  return (await must(git, root, ["status", "--porcelain"])).trim();
}

async function mergeInProgress(git: Git, root: string): Promise<boolean> {
  return (await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: root })).code === 0;
}

async function currentBranch(git: Git, root: string): Promise<string> {
  return (await must(git, root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
}

/** 造一个真冲突：集成分支改了 a.txt，队员分支从 main 出、改了同一行。 */
async function conflictingFixture(): Promise<{
  root: string;
  git: Git;
  merger: ReturnType<typeof createIntegrationMerger>;
}> {
  const root = await makeRepo();
  const git = realGit(root);
  await commitOnBranch(git, root, INTEGRATION, { "a.txt": "integration\n" });
  await commitOnBranch(git, root, MEMBER_CONFLICT, { "a.txt": "member\n" });
  return { root, git, merger: createIntegrationMerger({ git, repoRoot: root, base: "main" }) };
}

test("无冲突时合入集成分支", async () => {
  const root = await makeRepo();
  const git = realGit(root);
  await commitOnBranch(git, root, MEMBER_OK, { "b.txt": "member\n" });
  const merger = createIntegrationMerger({ git, repoRoot: root, base: "main" });

  const out = await merger.mergeMember({ integration: INTEGRATION, member: MEMBER_OK });

  assert.equal(out.ok, true);
  // `branch` 报的是**承载结果**的分支：mergeMember ⇒ 集成分支。
  assert.equal(out.ok === true && out.branch, INTEGRATION);
  // 断言真的合进去了：只断 ok:true 的话，一个「什么都没做就返回成功」的实现也能蒙混过关。
  assert.equal(await must(git, root, ["show", `${INTEGRATION}:b.txt`]), "member\n");
  assert.equal(await currentBranch(git, root), INTEGRATION);
});

// 冲突必须返回结构化结果而不是抛：上层要据此把工作项置 blocked 并发通知（spec §6.3「失败：留分支 + 进 Inbox + 标 blocked」）。
test("冲突时返回 { ok:false, reason:'conflict' } 且不抛", async () => {
  const { git, root, merger } = await conflictingFixture();

  const out = await merger.mergeMember({ integration: INTEGRATION, member: MEMBER_CONFLICT });

  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.reason, "conflict");
  // detail 要能拿去做排障/通知：空串等于「失败了，但不知道为啥」。
  assert.ok(out.ok === false && out.detail.length > 0, "detail 必须带出 git 的原因");
  assert.equal(await porcelain(git, root), "");
});

// 冲突后集成分支必须回到合并前状态（不得留成半合并）：否则后续队员会被连坐（spec §6.3）。
test("冲突后集成分支不留半合并状态", async () => {
  const { git, root, merger } = await conflictingFixture();
  const before = await refSha(git, root, INTEGRATION);

  await merger.mergeMember({ integration: INTEGRATION, member: MEMBER_CONFLICT });

  assert.equal(await porcelain(git, root), "");
  // 「干净」有两个来源：真 abort 了，或者压根没开始合并。用 MERGE_HEAD 与 ref 是否后退把这两者分开：
  assert.equal(await mergeInProgress(git, root), false);
  assert.equal(await refSha(git, root, INTEGRATION), before);
});

test("队员分支不存在 → branch_missing，且这次注定失败的调用不留副作用", async () => {
  const root = await makeRepo();
  const git = realGit(root);
  const merger = createIntegrationMerger({ git, repoRoot: root, base: "main" });

  const out = await merger.mergeMember({ integration: INTEGRATION, member: MEMBER_OK });

  assert.equal(out.ok === false && out.reason, "branch_missing");
  assert.ok(out.ok === false && out.detail.includes(MEMBER_OK));
  // 队员分支缺失时不建集成分支、不挪检出：否则「一个不存在的队员」会留下它的痕迹。
  assert.equal(await branchExists(git, root, INTEGRATION), false);
  assert.equal(await currentBranch(git, root), "main");
});

test("ensureIntegration：缺失时从 base 派生，已存在时幂等（不回退已合入的成果）", async () => {
  const root = await makeRepo();
  const git = realGit(root);
  const merger = createIntegrationMerger({ git, repoRoot: root, base: "main" });

  await merger.ensureIntegration(INTEGRATION);
  assert.equal(await branchExists(git, root, INTEGRATION), true);
  // 派生点只有一个：deps.base（brief 的裁定：不靠「调用方在别处给」）。
  assert.equal(await refSha(git, root, INTEGRATION), await refSha(git, root, "main"));

  // 让集成分支往前走一步（模拟已合入一个队员），再 ensure 一次。
  // 幂等必须是「什么都不做」：实现若写成 `branch -f`，这里会把队员的成果静默回退到 base。
  await must(git, root, ["checkout", "-q", INTEGRATION]);
  writeFileSync(join(root, "merged.txt"), "kept\n");
  await must(git, root, ["add", "-A"]);
  await must(git, root, ["commit", "-qm", "merged member"]);
  await must(git, root, ["checkout", "-q", "main"]);
  const advanced = await refSha(git, root, INTEGRATION);

  await merger.ensureIntegration(INTEGRATION);

  assert.equal(await refSha(git, root, INTEGRATION), advanced);
});

test("base 不存在时 ensureIntegration 响亮失败，不留半成品", async () => {
  const root = await makeRepo();
  const git = realGit(root);
  const merger = createIntegrationMerger({ git, repoRoot: root, base: "no-such-base" });

  const error = await merger.ensureIntegration(INTEGRATION).then(
    () => null,
    (e: unknown) => e as GitCommandError,
  );

  assert.ok(error instanceof GitCommandError);
  assert.match(error.stderr, /not a valid object name/);
  assert.equal(await branchExists(git, root, INTEGRATION), false);
});

test("连续合两个队员：a 成功 → b 成功，a 的成果保留", async () => {
  const root = await makeRepo();
  const git = realGit(root);
  await commitOnBranch(git, root, MEMBER_OK, { "b.txt": "from-a\n" });
  await commitOnBranch(git, root, MEMBER_B, { "c.txt": "from-b\n" });
  const merger = createIntegrationMerger({ git, repoRoot: root, base: "main" });

  assert.equal(
    (await merger.mergeMember({ integration: INTEGRATION, member: MEMBER_OK })).ok,
    true,
  );
  assert.equal((await merger.mergeMember({ integration: INTEGRATION, member: MEMBER_B })).ok, true);

  assert.equal(await must(git, root, ["show", `${INTEGRATION}:b.txt`]), "from-a\n");
  assert.equal(await must(git, root, ["show", `${INTEGRATION}:c.txt`]), "from-b\n");
});

// 矩阵里最容易被漏掉的一格：b 冲突之后，**a 的成果还在不在**。
// abort 若写成 `reset --hard <base>` 之类的「回滚」，a 的合并会一起消失，而测试只看 b 的结局是发现不了的。
test("a 成功 → b 冲突：a 的成果保留，集成分支不被 b 拖进半合并", async () => {
  const root = await makeRepo();
  const git = realGit(root);
  await commitOnBranch(git, root, MEMBER_OK, { "a.txt": "from-a\n" });
  await commitOnBranch(git, root, MEMBER_CONFLICT, { "a.txt": "from-b\n" });
  const merger = createIntegrationMerger({ git, repoRoot: root, base: "main" });
  assert.equal(
    (await merger.mergeMember({ integration: INTEGRATION, member: MEMBER_OK })).ok,
    true,
  );
  const afterA = await refSha(git, root, INTEGRATION);

  const out = await merger.mergeMember({ integration: INTEGRATION, member: MEMBER_CONFLICT });

  assert.equal(out.ok === false && out.reason, "conflict");
  assert.equal(await must(git, root, ["show", `${INTEGRATION}:a.txt`]), "from-a\n");
  assert.equal(await porcelain(git, root), "");
  assert.equal(await refSha(git, root, INTEGRATION), afterA);
});

// merge 会在「工作区会被覆盖」这类**前置检查**上就退出：实测 exit 2、无 MERGE_HEAD，
// 此时 `git merge --abort` 反而以 exit 128 失败（"There is no merge to abort"）。
// 不判这一下，一次「没开始的合并」就会被误报成「回滚失败」并对上层抛错。
test("merge 未起就失败（未跟踪文件挡路）→ 返回 conflict，且不误报回滚失败", async () => {
  const root = await makeRepo();
  const git = realGit(root);
  await commitOnBranch(git, root, MEMBER_OK, { "b.txt": "member\n" });
  const merger = createIntegrationMerger({ git, repoRoot: root, base: "main" });
  await merger.ensureIntegration(INTEGRATION);
  await must(git, root, ["checkout", "-q", INTEGRATION]);
  writeFileSync(join(root, "b.txt"), "untracked local\n");
  const before = await refSha(git, root, INTEGRATION);

  const out = await merger.mergeMember({ integration: INTEGRATION, member: MEMBER_OK });

  assert.equal(out.ok === false && out.reason, "conflict");
  assert.match(out.ok === false ? out.detail : "", /untracked working tree files/i);
  assert.equal(await mergeInProgress(git, root), false);
  assert.equal(await refSha(git, root, INTEGRATION), before);
  assert.equal(await porcelain(git, root), "?? b.txt");
});

test("finalize：整批通过后集成分支合回 target", async () => {
  const root = await makeRepo();
  const git = realGit(root);
  await commitOnBranch(git, root, MEMBER_OK, { "b.txt": "member\n" });
  const merger = createIntegrationMerger({ git, repoRoot: root, base: "main" });
  await merger.mergeMember({ integration: INTEGRATION, member: MEMBER_OK });

  const out = await merger.finalize({ integration: INTEGRATION, target: "main" });

  assert.equal(out.ok, true);
  // 承载结果的是 target（集成分支 → 主分支）。
  assert.equal(out.ok === true && out.branch, "main");
  assert.equal(await must(git, root, ["show", "main:b.txt"]), "member\n");
  assert.equal(await currentBranch(git, root), "main");
});

test("finalize 冲突：返回 conflict，target 不留半合并", async () => {
  const root = await makeRepo();
  const git = realGit(root);
  await commitOnBranch(git, root, INTEGRATION, { "a.txt": "integration\n" });
  writeFileSync(join(root, "a.txt"), "main moved\n");
  await must(git, root, ["add", "-A"]);
  await must(git, root, ["commit", "-qm", "main moved"]);
  const merger = createIntegrationMerger({ git, repoRoot: root, base: "main" });
  const before = await refSha(git, root, "main");

  const out = await merger.finalize({ integration: INTEGRATION, target: "main" });

  assert.equal(out.ok === false && out.reason, "conflict");
  assert.equal(await porcelain(git, root), "");
  assert.equal(await mergeInProgress(git, root), false);
  assert.equal(await refSha(git, root, "main"), before);
});

test("finalize：集成分支 / target 不存在都是 branch_missing（且不替调用方建集成分支）", async () => {
  const root = await makeRepo();
  const git = realGit(root);
  const merger = createIntegrationMerger({ git, repoRoot: root, base: "main" });

  const noIntegration = await merger.finalize({ integration: INTEGRATION, target: "main" });

  assert.equal(noIntegration.ok === false && noIntegration.reason, "branch_missing");
  // 整批都跑完了集成分支还不存在 ⇒ 这条流程根本没开始；替它凭空建一条再合回主分支，
  // 等于报告一次不存在的成功。
  assert.equal(await branchExists(git, root, INTEGRATION), false);
  assert.equal(await currentBranch(git, root), "main");

  await merger.ensureIntegration(INTEGRATION);
  const noTarget = await merger.finalize({ integration: INTEGRATION, target: "no-such-target" });

  assert.equal(noTarget.ok === false && noTarget.reason, "branch_missing");
  assert.equal(await currentBranch(git, root), "main");
});

// 抛弃语义的落点（spec §6.3「合并后分支删（队员分支与集成分支都删）」）。
// 顺序**不可颠倒**：工作树还挂着这条分支时 `git branch -D` 会被 git 拒（实测
// "error: Cannot delete branch 'x' checked out at '...'"）—— 所以「能删掉」本身就证明了顺序对。
test("discardMember：先摘工作树再删分支，之后同一分支可重新挂上", async () => {
  const root = await makeRepo();
  const git = realGit(root);
  const manager = createWorktreeManager({ git, repoRoot: root });
  const merger = createIntegrationMerger({ git, repoRoot: root, base: "main" });
  const { path } = await manager.add({ branch: MEMBER_OK, base: "main", dirName: "wi1-a" });
  // 让这条分支**带上未合并的提交**（被抛弃的队员就是这个形状）：分支若还停在 base 上，
  // `branch -d` 也能删掉，就分不出 `-D` 与 `-d` —— 被抛弃的活白干时删不掉才是真实风险。
  writeFileSync(join(path, "b.txt"), "unmerged work\n");
  await must(git, path, ["add", "-A"]);
  await must(git, path, ["commit", "-qm", "unmerged work"]);

  await merger.discardMember({ branch: MEMBER_OK, dirName: "wi1-a" });

  assert.deepEqual(await manager.list(), []);
  assert.equal(await branchExists(git, root, MEMBER_OK), false);
  assert.equal(existsSync(path), false);

  // 「清理是正确性前置」的机器化证明：不删分支的话，重新派发会撞上「分支已存在」（Task 2 实测）。
  await assert.doesNotReject(manager.add({ branch: MEMBER_OK, base: "main", dirName: "wi1-a" }));
  assert.equal((await manager.list()).length, 1);
});

// Task 2 实测的真空：`worktree add` 失败时会**先建出分支、后失败**，留下无工作树的**残枝**；
// 而 Task 1 的 remove() 只删工作树。于是「先 remove 再 branch -D」的直白实现会卡在 remove 上
// （"fatal: '<path>' is not a working tree"，exit 128），branch -D 永远跑不到，队员永久停在「分支已存在」。
test("discardMember 消化「分支残枝」（无工作树）", async () => {
  const root = await makeRepo();
  const git = realGit(root);
  const manager = createWorktreeManager({ git, repoRoot: root });
  const merger = createIntegrationMerger({ git, repoRoot: root, base: "main" });
  // 用真实成因造残枝：目标目录非空 ⇒ add 先建分支、后失败。
  const busy = join(resolveWorktreeRoot(root), "wi1-a");
  mkdirSync(busy, { recursive: true });
  writeFileSync(join(busy, "occupied.txt"), "x\n");
  await assert.rejects(manager.add({ branch: MEMBER_OK, base: "main", dirName: "wi1-a" }));
  assert.equal(await branchExists(git, root, MEMBER_OK), true);
  assert.deepEqual(await manager.list(), []);
  // 残枝上也放一次未合并的提交：与上一条同理，分支停在 base 时分不出 `-D` 与 `-d`。
  // （残枝没有工作树可用，所以借主工作树提交 —— 只 add 那一个文件，别把 .worktree/ 一起提进去。）
  await must(git, root, ["checkout", "-q", MEMBER_OK]);
  writeFileSync(join(root, "b.txt"), "unmerged work\n");
  await must(git, root, ["add", "b.txt"]);
  await must(git, root, ["commit", "-qm", "unmerged work"]);
  await must(git, root, ["checkout", "-q", "main"]);

  await merger.discardMember({ branch: MEMBER_OK, dirName: "wi1-a" });

  assert.equal(await branchExists(git, root, MEMBER_OK), false);
  // 同分支换个干净目录即可重挂（那堆散落文件不是本层的清理对象，Task 4 的 prune 管工作树）。
  await assert.doesNotReject(manager.add({ branch: MEMBER_OK, base: "main", dirName: "wi1-a2" }));
  assert.equal((await manager.list()).length, 1);
});

// integration 同源于 workItemSlug，Task 2 只校验了 member（审查指出的口径不一致）；
// 而这个值要拿去建/合/删分支，不能静默放行。
test("不安全的 integration / 分支名在碰 git 之前就被拒（与 member 同一道闸门）", async () => {
  const root = await makeRepo();
  const git = realGit(root);
  const manager = createWorktreeManager({ git, repoRoot: root });
  const merger = createIntegrationMerger({ git, repoRoot: root, base: "main" });
  await manager.add({ branch: MEMBER_OK, base: "main", dirName: "wi1-a" });
  const head = await currentBranch(git, root);

  for (const bad of ["../evil", "squad/../evil", "squad/wi1/../x", "-e", ""]) {
    await assert.rejects(merger.ensureIntegration(bad), /Invalid slug/);
    await assert.rejects(
      merger.mergeMember({ integration: bad, member: MEMBER_OK }),
      /Invalid slug/,
    );
    await assert.rejects(
      merger.mergeMember({ integration: INTEGRATION, member: bad }),
      /Invalid slug/,
    );
    await assert.rejects(merger.finalize({ integration: bad, target: "main" }), /Invalid slug/);
  }
  await assert.rejects(
    merger.discardMember({ branch: "../evil", dirName: "wi1-a" }),
    /Invalid slug/,
  );

  // 零副作用：没建出任何 ref、没挪检出、工作树还在（校验必须发生在任何 git 动作之前）。
  assert.equal((await manager.list()).length, 1);
  assert.equal(await currentBranch(git, root), head);
  const refs = await must(git, root, ["for-each-ref", "--format=%(refname)", "refs/heads"]);
  assert.equal(refs.includes(".."), false);
  assert.equal(refs.includes("-e"), false);
});

/* 这条不测我们的模块，而是把**计划自身的命名缺陷**钉成可执行证据（见本文件顶部常量注释）：
   spec §6.3 的集成分支 `squad/<工作项>`，与计划的队员分支 `squad/<工作项>/<队员>`，
   互为 ref 路径的「文件/目录」—— git 不允许共存。
   若这条用例**变红**，说明命名已经改了（好事）：请把本文件的常量注释与夹具名一并更新，不要只把它删掉。 */
test("计划的分支命名对（集成分支 + 挂在其下的队员分支）在 git 里不可共存", async () => {
  const plan = planBranches({ workItemSlug: "wi1", agentSlug: "a" });

  const repoA = await makeRepo();
  const gitA = realGit(repoA);
  assert.equal((await gitA(["branch", plan.integration, "main"], { cwd: repoA })).code, 0);
  const child = await gitA(["branch", plan.member, "main"], { cwd: repoA });
  assert.notEqual(child.code, 0);
  assert.match(child.stderr, /cannot lock ref/);

  const repoB = await makeRepo();
  const gitB = realGit(repoB);
  assert.equal((await gitB(["branch", plan.member, "main"], { cwd: repoB })).code, 0);
  const parent = await gitB(["branch", plan.integration, "main"], { cwd: repoB });
  assert.notEqual(parent.code, 0);
  assert.match(parent.stderr, /cannot lock ref/);
});
