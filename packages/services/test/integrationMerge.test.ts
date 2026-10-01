import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memberDirName, planBranches } from "../src/worktree/branchNaming.js";
import { createIntegrationMerger, deleteBranch } from "../src/worktree/integrationMerge.js";
import { GitCommandError } from "../src/worktree/gitRunner.js";
import { createWorktreeManager, resolveWorktreeRoot } from "../src/worktree/worktreeManager.js";
import { makeRepo, realGit } from "./helpers/gitFixture.js";

type Git = ReturnType<typeof realGit>;

/* 夹具用的分支名**派生自 planBranches**，不写字面量：这份夹具曾有整整一轮「名字对不上计划」
   —— 旧命名对（集成分支 `squad/<工作项>` + 队员分支 `squad/<工作项>/<队员>`）在 git 里
   结构性不可共存（`refs/heads/squad/wi1` 是**文件**，`squad/wi1/a` 要它是**目录**，D/F 冲突，
   `cannot lock ref`），spec §6.3 遂改为**从第二段起分叉**的新命名对：
     集成分支 `squad/integration/<工作项>`、队员分支 `squad/member/<工作项>/<队员>`
   （见 branchNaming.ts 的注释：两个命名空间第一段就分开，冲突在构造上不存在）。
   派生 + 最后一条用例的字面断言一起做「对账」：命名再改，夹具与哨兵会自动跟着走，
   不会像上次那样留下一个已经过时的夹具而测试还是绿的。 */
const WORK_ITEM = "wi1";
const INTEGRATION = planBranches({ workItemSlug: WORK_ITEM, agentSlug: "a" }).integration;
const MEMBER_OK = planBranches({ workItemSlug: WORK_ITEM, agentSlug: "a" }).member;
const MEMBER_B = planBranches({ workItemSlug: WORK_ITEM, agentSlug: "b" }).member;
const MEMBER_CONFLICT = planBranches({ workItemSlug: WORK_ITEM, agentSlug: "conflict" }).member;
/** 目录名与分支**同源**（`memberDirName`）：`discardMember` 的入参是 `{ branch, dirName }`
    一对，夹具若在这里手拼 `<工作项>-<队员>`，就等于替「两者的配对」再写一处拼法 ——
    而配对不成立正是终审 Important-1 的形状（判定按分支、动作按目录名，先毁他人工件）。 */
const DIR_NAME = memberDirName(planBranches({ workItemSlug: WORK_ITEM, agentSlug: "a" }));
const DIR_B = memberDirName(planBranches({ workItemSlug: WORK_ITEM, agentSlug: "b" }));

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
  const { path } = await manager.add({ branch: MEMBER_OK, base: "main", dirName: DIR_NAME });
  // 让这条分支**带上未合并的提交**（被抛弃的队员就是这个形状）：分支若还停在 base 上，
  // `branch -d` 也能删掉，就分不出 `-D` 与 `-d` —— 被抛弃的活白干时删不掉才是真实风险。
  writeFileSync(join(path, "b.txt"), "unmerged work\n");
  await must(git, path, ["add", "-A"]);
  await must(git, path, ["commit", "-qm", "unmerged work"]);

  await merger.discardMember({ branch: MEMBER_OK, dirName: DIR_NAME });

  assert.deepEqual(await manager.list(), []);
  assert.equal(await branchExists(git, root, MEMBER_OK), false);
  assert.equal(existsSync(path), false);

  // 「清理是正确性前置」的机器化证明：不删分支的话，重新派发会撞上「分支已存在」（Task 2 实测）。
  await assert.doesNotReject(manager.add({ branch: MEMBER_OK, base: "main", dirName: DIR_NAME }));
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
  const busy = join(resolveWorktreeRoot(root), DIR_NAME);
  mkdirSync(busy, { recursive: true });
  writeFileSync(join(busy, "occupied.txt"), "x\n");
  await assert.rejects(manager.add({ branch: MEMBER_OK, base: "main", dirName: DIR_NAME }));
  assert.equal(await branchExists(git, root, MEMBER_OK), true);
  assert.deepEqual(await manager.list(), []);
  // 残枝上也放一次未合并的提交：与上一条同理，分支停在 base 时分不出 `-D` 与 `-d`。
  // （残枝没有工作树可用，所以借主工作树提交 —— 只 add 那一个文件，别把 .worktree/ 一起提进去。）
  await must(git, root, ["checkout", "-q", MEMBER_OK]);
  writeFileSync(join(root, "b.txt"), "unmerged work\n");
  await must(git, root, ["add", "b.txt"]);
  await must(git, root, ["commit", "-qm", "unmerged work"]);
  await must(git, root, ["checkout", "-q", "main"]);

  await merger.discardMember({ branch: MEMBER_OK, dirName: DIR_NAME });

  assert.equal(await branchExists(git, root, MEMBER_OK), false);
  // 同分支换个干净目录即可重挂（那堆散落文件不是本层的清理对象，Task 4 的 prune 管工作树）。
  await assert.doesNotReject(manager.add({ branch: MEMBER_OK, base: "main", dirName: "wi1-a2" }));
  assert.equal((await manager.list()).length, 1);
});

/* 终审 Important-1：`discardMember` 的**判定用 `branch`，动作却用调用方给的 `dirName`**，
   二者此前从不互相校验。不成对时（把 B 的目录名配 A 的分支喂进来）：`live.some(e => e.branch === A)`
   为真 ⇒ `worktree remove --force` **先静默强删了 B 的工作树**（B 未提交的成果一起没），
   随后 `branch -D A` 才因 A 仍被检出而响亮抛错 —— 净效果是「先毁掉无辜的树、再报一个与真实原因
   无关的错」。旧注释断言「dirName 传错时 git 会在 branch -D 那里响亮拒绝」**不成立**：破坏在它之前。
   现在必须在 remove **之前**断言「持有该分支的那一项的目录名 === 入参 dirName」，不一致即抛。 */
test("discardMember：dirName 与 branch 不成对 → 抛，且两棵树、两个分支都原样还在", async () => {
  const root = await makeRepo();
  const git = realGit(root);
  const manager = createWorktreeManager({ git, repoRoot: root });
  const merger = createIntegrationMerger({ git, repoRoot: root, base: "main" });
  const a = await manager.add({ branch: MEMBER_OK, base: "main", dirName: DIR_NAME });
  const b = await manager.add({ branch: MEMBER_B, base: "main", dirName: DIR_B });
  // B 的未提交成果：旧实现会连树带它一起强删（--force），这正是「静默毁掉他人工件」。
  writeFileSync(join(b.path, "b-wip.txt"), "b 还没提交的活\n");

  // 不成对：分支是 A 的，目录名是 B 的。
  await assert.rejects(merger.discardMember({ branch: MEMBER_OK, dirName: DIR_B }), /dirName/);

  // 只断「抛了」远远不够 —— 破坏发生在抛之前，所以这里断的是**实体状态**。
  assert.equal(existsSync(a.path), true, "A 的工作树必须还在");
  assert.equal(existsSync(b.path), true, "B 的工作树绝不能被这次错配的调用删掉");
  assert.equal(readFileSync(join(b.path, "b-wip.txt"), "utf8"), "b 还没提交的活\n");
  assert.equal(await branchExists(git, root, MEMBER_OK), true, "A 的分支必须还在");
  assert.equal(await branchExists(git, root, MEMBER_B), true, "B 的分支必须还在");
  assert.equal((await manager.list()).length, 2);
});

// integration 同源于 workItemSlug，Task 2 只校验了 member（审查指出的口径不一致）；
// 而这个值要拿去建/合/删分支，不能静默放行。
test("不安全的 integration / 分支名在碰 git 之前就被拒（与 member 同一道闸门）", async () => {
  const root = await makeRepo();
  const git = realGit(root);
  const manager = createWorktreeManager({ git, repoRoot: root });
  const merger = createIntegrationMerger({ git, repoRoot: root, base: "main" });
  await manager.add({ branch: MEMBER_OK, base: "main", dirName: DIR_NAME });
  const head = await currentBranch(git, root);

  for (const bad of ["../evil", "squad/../evil", "squad/integration/../x", "-e", ""]) {
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
    // discardIntegration 同源于 integration：删分支这一步同样要在碰 git 之前就拒掉非法名字。
    await assert.rejects(
      merger.discardIntegration({ integration: bad, target: "main" }),
      /Invalid slug/,
    );
  }
  await assert.rejects(
    merger.discardMember({ branch: "../evil", dirName: DIR_NAME }),
    /Invalid slug/,
  );

  // 「违规即抛，不静默降级」的精确一格：integration 非法 **且** 队员分支不存在时，
  // 若把 integration 的校验放在「队员分支存在吗」之后，早退的 branch_missing 会把非法名字吞掉。
  await assert.rejects(
    merger.mergeMember({ integration: "../evil", member: "squad/member/wi1/nobody" }),
    /Invalid slug/,
  );

  // 零副作用：没建出任何 ref、没挪检出、工作树还在（校验必须发生在任何 git 动作之前）。
  assert.equal((await manager.list()).length, 1);
  assert.equal(await currentBranch(git, root), head);
  const refs = await must(git, root, ["for-each-ref", "--format=%(refname)", "refs/heads"]);
  assert.equal(refs.includes(".."), false);
  assert.equal(refs.includes("-e"), false);
});

// `deleteBranch` 是独立导出的删分支出口，供 Task 4 的看门人注入复用（T4 brief 明写「不得要求
// Task 4 自己重写一份 git branch -D」），而不是藏在 discardMember 内部。
test("deleteBranch：已存在的分支删得掉", async () => {
  const root = await makeRepo();
  const git = realGit(root);
  await commitOnBranch(git, root, MEMBER_OK, { "b.txt": "work\n" });

  await deleteBranch(git, root, MEMBER_OK);

  assert.equal(await branchExists(git, root, MEMBER_OK), false);
});

// 删一个**不存在**的分支：抛（`GitCommandError`，git 原文 `branch 'x' not found`），不是幂等成功。
// 理由：本模块的立身之本是「清理是正确性前置」，而「删一个不存在的分支」只可能来自重复清理
// （上一个清理点漏了状态）或删错了对象 —— 两者都要有人看见。幂等成功会把「它本来就不在」
// 伪装成「我成功清掉了它」，与 Task 1 `remove()` 对不存在项响亮失败同一取舍。
test("deleteBranch：分支不存在时响亮失败（不是幂等成功）", async () => {
  const root = await makeRepo();
  const git = realGit(root);

  const error = await deleteBranch(git, root, MEMBER_OK).then(
    () => null,
    (e: unknown) => e as GitCommandError,
  );

  assert.ok(error instanceof GitCommandError);
  assert.match(`${error.stderr}${error.stdout}`, /not found/);
});

// 与主模块同一道闸门：Task 4 注入这份实现，等于注入一个会进 git 子命令的出口，
// 非法名字必须在碰 git 之前就被拒，不能成为一条不设防的旁路。
test("deleteBranch：非法分支名在碰 git 之前就被拒", async () => {
  const root = await makeRepo();
  const git = realGit(root);

  await assert.rejects(deleteBranch(git, root, "../evil"), /Invalid slug/);
  await assert.rejects(deleteBranch(git, root, ""), /Invalid slug/);
});

// 顺序契约的另一半：分支还挂在某个工作树上时 `git branch -D` 会被 git 拒绝 —— 这正是
// `discardMember` 「先 worktree remove、后 branch -D」不可颠倒的原因，也是本函数不替调用方
// 摘工作树、而把顺序留在调用点的证据（它只拿到分支名，不知道 dirName）。
test("deleteBranch：分支仍被工作树检出时被 git 拒绝（「先摘树」的理由）", async () => {
  const root = await makeRepo();
  const git = realGit(root);
  const manager = createWorktreeManager({ git, repoRoot: root });
  await manager.add({ branch: MEMBER_OK, base: "main", dirName: DIR_NAME });

  await assert.rejects(deleteBranch(git, root, MEMBER_OK));

  assert.equal(await branchExists(git, root, MEMBER_OK), true);
});

// 集成分支的删除**只在整批合回主分支之后**（spec §6.3「合并后分支删（队员分支与集成分支都删）」）。
// 未合回就删 = 整批队员的成果静默蒸发，所以「没合回」必须抛，而不是删了再说。
test("discardIntegration：未合回 target 就删 → 抛，且集成分支仍在", async () => {
  const root = await makeRepo();
  const git = realGit(root);
  const merger = createIntegrationMerger({ git, repoRoot: root, base: "main" });
  // 集成分支上放一个**不在 main 上**的提交：模拟「整批还躺在集成分支上、没合回主分支」。
  await commitOnBranch(git, root, INTEGRATION, { "b.txt": "batch\n" });

  await assert.rejects(
    merger.discardIntegration({ integration: INTEGRATION, target: "main" }),
    /尚未合回/,
  );
  // 「拒绝」必须是真的没删：一次失败的清理若把成果带走了，比不清理更糟。
  assert.equal(await branchExists(git, root, INTEGRATION), true);
});

test("discardIntegration：合回 target 后可删", async () => {
  const root = await makeRepo();
  const git = realGit(root);
  await commitOnBranch(git, root, MEMBER_OK, { "b.txt": "member\n" });
  const merger = createIntegrationMerger({ git, repoRoot: root, base: "main" });
  await merger.mergeMember({ integration: INTEGRATION, member: MEMBER_OK });
  // 走真实主线：finalize 把整批合回 main（这一步是本用例的前置，不是被检验对象）。
  assert.equal((await merger.finalize({ integration: INTEGRATION, target: "main" })).ok, true);

  await merger.discardIntegration({ integration: INTEGRATION, target: "main" });

  assert.equal(await branchExists(git, root, INTEGRATION), false);
  // 删掉的是**分支**，不是活：成果已经在主分支上。
  assert.equal(await must(git, root, ["show", "main:b.txt"]), "member\n");
});

// 「不存在就没得删」与「target 不存在」都要响亮：前者是状态错误（没人建过集成分支），
// 后者是参数错误。两者都不该静默成功 —— 静默成功会让调用方以为「集成分支已清理」。
test("discardIntegration：集成分支 / target 不存在都抛，且不留副作用", async () => {
  const root = await makeRepo();
  const git = realGit(root);
  const merger = createIntegrationMerger({ git, repoRoot: root, base: "main" });

  await assert.rejects(
    merger.discardIntegration({ integration: INTEGRATION, target: "main" }),
    /集成分支不存在/,
  );

  await merger.ensureIntegration(INTEGRATION);
  await assert.rejects(
    merger.discardIntegration({ integration: INTEGRATION, target: "no-such-target" }),
    /target 不存在/,
  );
  assert.equal(await branchExists(git, root, INTEGRATION), true);
});

/* 这条是**唯一直接验证 D/F 排除**的用例，必须有它：`planBranches` 给出的集成分支与队员分支
   要在同一个仓库里真的同时存在（各自还能挂上工作树）。spec §6.3 的旧命名对
   （集成分支 `squad/<工作项>` + 队员分支 `squad/<工作项>/<队员>`）在 ref 层互为「文件 vs 目录」，
   git 结构性拒绝（`cannot lock ref`）；新命名从 `squad/` 之后第一段就分叉，冲突在构造上不存在。
   将来任何人把命名改回父子形状、或让两个命名空间在第一段相交，这条会**立刻变红** ——
   而不是等到接线时撞上 git 的 `cannot lock ref` 才发现。 */
test("集成分支与队员分支在 git 里可共存（旧命名对不可，故改用此对）", async () => {
  // 对账：夹具名虽派生自 planBranches，这里仍把命名对钉成**字面量** ——
  // 命名若再改，这条会先红，提醒把本文件的夹具注释与名字一起更新（上一轮就是这样漏的）。
  const plan = planBranches({ workItemSlug: WORK_ITEM, agentSlug: "a" });
  assert.equal(plan.integration, "squad/integration/wi1");
  assert.equal(plan.member, "squad/member/wi1/a");

  const root = await makeRepo();
  const git = realGit(root);
  const manager = createWorktreeManager({ git, repoRoot: root });
  // 两条分支各自挂上工作树 —— 这正是 P2a 主线要到达的状态（集成 + 队员同时在世）。
  await assert.doesNotReject(
    manager.add({ branch: plan.integration, base: "main", dirName: "wi1-integration" }),
  );
  await assert.doesNotReject(manager.add({ branch: plan.member, base: "main", dirName: DIR_NAME }));

  assert.equal(await branchExists(git, root, plan.integration), true);
  assert.equal(await branchExists(git, root, plan.member), true);
  assert.equal((await manager.list()).length, 2);
});
