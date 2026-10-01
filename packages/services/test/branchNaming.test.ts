import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitCommandError } from "../src/worktree/gitRunner.js";
import {
  assertSafeSlug,
  createBranchAllocator,
  planBranches,
} from "../src/worktree/branchNaming.js";
import { createWorktreeManager, resolveWorktreeRoot } from "../src/worktree/worktreeManager.js";
import { makeRepo, realGit } from "./helpers/gitFixture.js";

test("分支命名：集成分支 + 队员分支", () => {
  assert.deepEqual(planBranches({ workItemSlug: "wi-42", agentSlug: "ta-x" }), {
    integration: "squad/wi-42",
    member: "squad/wi-42/ta-x",
  });
});

// slug 直接进分支名与目录名，必须限制在安全字符集内，否则可构造出路径逃逸或非法 ref。
test("assertSafeSlug 拒空/斜杠/点点/大写/空格", () => {
  for (const bad of ["", "a/b", "..", "A", "a b", "a_b"]) {
    assert.throws(() => assertSafeSlug(bad), /slug/);
  }
});

test("assertSafeSlug 接受合法 slug", () => {
  for (const ok of ["a", "wi-42", "ta-x-1", "a1"]) assert.doesNotThrow(() => assertSafeSlug(ok));
});

// 白名单的第一个字符位是单独的闸门：`-a` 这种 slug 会原样进目录名，被下游按选项解释；
// 而 `squad/wi` 则说明有人把整条分支名当 slug 传了 —— 两者都得挡。
test("assertSafeSlug 边界：首字符不能是连字符，尾字符可以", () => {
  for (const bad of ["-a", "-", "--", "squad/wi"]) assert.throws(() => assertSafeSlug(bad), /slug/);
  for (const ok of ["a-", "0", "z9-9z"]) assert.doesNotThrow(() => assertSafeSlug(ok));
});

test("allocate 建出队员工作树：分支为队员分支、目录名扁平", async () => {
  const root = await makeRepo();
  const manager = createWorktreeManager({ git: realGit(root), repoRoot: root });
  const allocator = createBranchAllocator({ manager });

  const { memberPath } = await allocator.allocate(
    planBranches({ workItemSlug: "wi-42", agentSlug: "ta-x" }),
    "main",
  );

  const list = await manager.list();
  assert.equal(list.length, 1);
  assert.equal(memberPath, list[0]!.path);
  assert.equal(list[0]!.branch, "squad/wi-42/ta-x");
  // 扁平：目录名是 `<workItemSlug>-<agentSlug>`，不是 `wi-42/ta-x` 的层级。
  // 层级写法会被 add 直接拒（.worktree/ 只放一层，才能作为一项进集中排除清单）。
  assert.ok(memberPath.endsWith(join(".worktree", "wi-42-ta-x")));
  assert.equal(memberPath.includes(join(".worktree", "wi-42", "ta-x")), false);
});

// 同一 base 并行开两名队员是最常见的形状：分支不同就必须都成功，
// 否则「每队员独立工作面」在并发下会退化成互相踩。
test("同 base 并行：分支不同的两名队员都成功", async () => {
  const root = await makeRepo();
  const manager = createWorktreeManager({ git: realGit(root), repoRoot: root });
  const allocator = createBranchAllocator({ manager });

  const [x, y] = await Promise.all([
    allocator.allocate(planBranches({ workItemSlug: "wi-42", agentSlug: "ta-x" }), "main"),
    allocator.allocate(planBranches({ workItemSlug: "wi-42", agentSlug: "ta-y" }), "main"),
  ]);

  assert.notEqual(x.memberPath, y.memberPath);
  const branches = (await manager.list()).map((entry) => entry.branch).sort();
  assert.deepEqual(branches, ["squad/wi-42/ta-x", "squad/wi-42/ta-y"]);
});

// 同分支双挂由 git 拒绝，但 git 的原文（`a branch named 'x' already exists`）
// 既不说明「问题是什么」也不说明「该做什么」。上层要的是可读原因，
// 同时不能把 git 原文丢掉：分因、排障都靠它。两条都要验。
test("同分支双挂：第二次可读失败，恰好一份工作面存活", async () => {
  const root = await makeRepo();
  const manager = createWorktreeManager({ git: realGit(root), repoRoot: root });
  const allocator = createBranchAllocator({ manager });
  const plan = planBranches({ workItemSlug: "wi-42", agentSlug: "ta-x" });
  await allocator.allocate(plan, "main");

  const error = await allocator.allocate(plan, "main").then(
    () => null,
    (e: unknown) => e as Error & { cause?: unknown },
  );

  assert.ok(error instanceof Error);
  assert.match(error.message, /该分支已被另一工作树占用/);
  assert.match(error.message, /already exists/);
  assert.ok(error.cause instanceof GitCommandError);
  // 包装必须真的发生：只把 GitCommandError 原样重抛就不算「可读失败」。
  assert.notEqual(error.message, (error.cause as GitCommandError).message);

  // 失败的那次不能动到已挂上的工作面，也不能多留一个目录。
  const list = await manager.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.branch, "squad/wi-42/ta-x");
  assert.deepEqual(readdirSync(resolveWorktreeRoot(root)), ["wi-42-ta-x"]);
});

// base 不存在是「输入错了」，不是「分支被占」。归错因会把处置方向带偏
// （该换 base 却去清分支），所以这条路径必须原样抛、stderr 保留。
// 顺带锁死「失败不留半个工作面」：目录与分支都不该多出来。
test("base 不存在：原样失败且 stderr 保留，不留半个工作面", async () => {
  const root = await makeRepo();
  const git = realGit(root);
  const manager = createWorktreeManager({ git, repoRoot: root });
  const allocator = createBranchAllocator({ manager });
  const plan = planBranches({ workItemSlug: "wi-42", agentSlug: "ta-x" });

  const error = await allocator.allocate(plan, "no-such-base").then(
    () => null,
    (e: unknown) => e as Error,
  );

  assert.ok(error instanceof Error);
  assert.doesNotMatch(error.message, /该分支已被另一工作树占用/);
  assert.match(error.message, /not a valid object name/);

  assert.equal(existsSync(join(resolveWorktreeRoot(root), "wi-42-ta-x")), false);
  assert.deepEqual(await manager.list(), []);
  const branches = await git(["branch", "--list", plan.member], { cwd: root });
  assert.equal(branches.stdout.trim(), "");
});

// 宽泛匹配 `already exists` 会把「目标目录非空」（路径问题）误译成「分支被占用」（ref 问题）：
// 两者处置相反（先清目录 vs 换分支名）。这条用真实 git 的路径冲突锁住分类边界。
test("目标目录非空不被误译为「分支被占用」", async () => {
  const root = await makeRepo();
  const manager = createWorktreeManager({ git: realGit(root), repoRoot: root });
  const allocator = createBranchAllocator({ manager });

  const occupied = join(resolveWorktreeRoot(root), "wi-42-ta-y");
  mkdirSync(occupied, { recursive: true });
  writeFileSync(join(occupied, "occupied.txt"), "x\n");

  const error = await allocator
    .allocate(planBranches({ workItemSlug: "wi-42", agentSlug: "ta-y" }), "main")
    .then(
      () => null,
      (e: unknown) => e as GitCommandError,
    );

  assert.ok(error instanceof GitCommandError);
  assert.doesNotMatch(error.message, /该分支已被另一工作树占用/);
  assert.match(error.stderr, /already exists/);
});

// 扁平目录名的固有歧义：`wi-42` + `ta-x` 与 `wi-42-ta` + `x` 拼出同一个目录名。
// 分支不同（不是双挂），所以 git 报的是**路径**冲突。这条必须与「分支被占」分得开，
// 否则调用方会朝「换分支名」这个错方向修。
test("扁平目录名撞车（分支不同）：按路径冲突失败，不误标为分支被占", async () => {
  const root = await makeRepo();
  const manager = createWorktreeManager({ git: realGit(root), repoRoot: root });
  const allocator = createBranchAllocator({ manager });
  await allocator.allocate(planBranches({ workItemSlug: "wi-42", agentSlug: "ta-x" }), "main");

  const error = await allocator
    .allocate(planBranches({ workItemSlug: "wi-42-ta", agentSlug: "x" }), "main")
    .then(
      () => null,
      (e: unknown) => e as GitCommandError,
    );

  assert.ok(error instanceof GitCommandError);
  assert.doesNotMatch(error.message, /该分支已被另一工作树占用/);
  assert.match(error.stderr, /already exists/);
  // 撞车不能把先挂上的那个工作面弄坏。
  const list = await manager.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.branch, "squad/wi-42/ta-x");
});

// 有 ref、没有工作树的**残枝**（实测：add 因目录非空失败时 git 已先建出该分支）同样会让 add 失败。
// 这条路径上目标目录是空的 —— 正是「分支已存在」与「目录被占」最容易混为一谈的地方；
// 顺带锁死它不留任何目录。
test("分支残枝（无工作树）按「分支已存在」可读失败，目录零残留", async () => {
  const root = await makeRepo();
  const git = realGit(root);
  const manager = createWorktreeManager({ git, repoRoot: root });
  const allocator = createBranchAllocator({ manager });
  const plan = planBranches({ workItemSlug: "wi-42", agentSlug: "ta-x" });
  const made = await git(["branch", plan.member, "main"], { cwd: root });
  assert.equal(made.code, 0, made.stderr);

  const error = await allocator.allocate(plan, "main").then(
    () => null,
    (e: unknown) => e as Error & { cause?: unknown },
  );

  assert.ok(error instanceof Error);
  assert.match(error.message, /该分支已被另一工作树占用/);
  assert.match(error.message, /already exists/);
  assert.ok(error.cause instanceof GitCommandError);
  assert.deepEqual(await manager.list(), []);
  assert.equal(existsSync(join(resolveWorktreeRoot(root), "wi-42-ta-x")), false);
});

// 逃逸 slug 必须在进 git / 进文件系统之前就被挡：挡在分配器边界，
// 仓库上不该有任何副作用（无目录、无分支、无 git 登记），而不是等 git 事后报错。
test("allocate 在挂载前挡住逃逸 slug，仓库零改动", async () => {
  const root = await makeRepo();
  const manager = createWorktreeManager({ git: realGit(root), repoRoot: root });
  const allocator = createBranchAllocator({ manager });

  const escapes = [
    // 工作项 slug 为 `..`：member 会拼成 squad/../<agent>，放行就能把工作树挪出 .worktree/。
    planBranches({ workItemSlug: "..", agentSlug: "ta-x" }),
    planBranches({ workItemSlug: "wi-42", agentSlug: ".." }),
    // 三段式分支：不是 planBranches 造得出来的形状，得响亮失败而不是猜出个目录名来。
    planBranches({ workItemSlug: "wi-42", agentSlug: "../evil" }),
    planBranches({ workItemSlug: "wi-42", agentSlug: "ta-x/../.." }),
  ];
  for (const plan of escapes) {
    await assert.rejects(allocator.allocate(plan, "main"), /slug/);
  }

  assert.equal(existsSync(resolveWorktreeRoot(root)), false);
  assert.deepEqual(await manager.list(), []);
});

// 长度不设上限：它是文件系统的约束，不是「安全字符集」这道闸门的职责。
// 但「不设限」不等于「可以截断」—— 传给 git 的分支名/目录名必须原样。
test("超长 slug 原样使用：不截断、不额外设限", async () => {
  const root = await makeRepo();
  const manager = createWorktreeManager({ git: realGit(root), repoRoot: root });
  const allocator = createBranchAllocator({ manager });
  const workItemSlug = "w".repeat(100);
  const agentSlug = "a".repeat(100);

  const { memberPath } = await allocator.allocate(
    planBranches({ workItemSlug, agentSlug }),
    "main",
  );

  const list = await manager.list();
  assert.equal(list.length, 1);
  assert.equal(memberPath, list[0]!.path);
  assert.equal(list[0]!.branch, `squad/${workItemSlug}/${agentSlug}`);
  assert.equal(realpathSync(memberPath).endsWith(`${workItemSlug}-${agentSlug}`), true);
});
