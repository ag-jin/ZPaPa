import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { GitCommandError, createGitRunner } from "../src/worktree/gitRunner.js";
import { createWorktreeManager, resolveWorktreeRoot } from "../src/worktree/worktreeManager.js";
import { makeRepo, realGit } from "./helpers/gitFixture.js";

// 工作树必须落在 <repoRoot>/.worktree 下：它是集中排除清单里的一项，位置写死才便于一处维护。
test("resolveWorktreeRoot 落在仓库根的 .worktree", () => {
  assert.ok(resolveWorktreeRoot("/tmp/x").endsWith(join(".worktree")));
});

test("add 建出工作树并可被 list 看见", async () => {
  const root = await makeRepo();
  const m = createWorktreeManager({ git: realGit(root), repoRoot: root });
  await m.add({ branch: "squad/wi1/a", base: "main", dirName: "wi1-a" });
  const list = await m.list();
  assert.equal(list.length, 1);
  assert.ok(list[0]!.path.includes(join(".worktree", "wi1-a")));
  assert.equal(list[0]!.branch, "squad/wi1/a");
});

test("remove 后 list 为空", async () => {
  const root = await makeRepo();
  const m = createWorktreeManager({ git: realGit(root), repoRoot: root });
  await m.add({ branch: "squad/wi1/a", base: "main", dirName: "wi1-a" });
  await m.remove("wi1-a");
  assert.equal((await m.list()).length, 0);
});

// git 失败必须把 stderr 带出来：上层要据此区分「同分支双挂」这类可读原因。
test("git 失败时返回码与 stderr 都被保留", async () => {
  const root = await makeRepo();
  const git = async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" });
  const m = createWorktreeManager({ git, repoRoot: root });
  await assert.rejects(m.add({ branch: "b", base: "main", dirName: "d" }), /not a git repository/);
});

// 主工作树永远排在 `git worktree list` 的第一位，它不是队员；被算进 list，「队员数」会凭空多 1。
test("list 不把主工作树算作队员", async () => {
  const root = await makeRepo();
  const m = createWorktreeManager({ git: realGit(root), repoRoot: root });
  assert.deepEqual(await m.list(), []);
});

// 上一条走的是桩，证明不了真 git 的退出码/stderr 真被搬到异常上。
// 这里用真实失败（base 不存在）确认字段是真的带出来的，而不是格式化时被吞掉。
test("真实 git 失败时退出码与 stderr 一起带出", async () => {
  const root = await makeRepo();
  const m = createWorktreeManager({ git: realGit(root), repoRoot: root });
  const error = await m.add({ branch: "squad/wi1/a", base: "no-such-base", dirName: "wi1-a" }).then(
    () => null,
    (e: unknown) => e as GitCommandError,
  );
  assert.ok(error instanceof GitCommandError);
  assert.notEqual(error.code, 0);
  assert.match(error.stderr, /not a valid object name/);
  assert.match(error.message, /not a valid object name/);
});

// add 的返回值和 list 的 path 会被上层拿来互相比对（谁是谁的工作面）。
// git 报出的是 realpath 后的路径，而 repoRoot 可能是符号链接（macOS 的 /var → /private/var），
// 不归一到同一形态，两边就会「看着一样却不相等」。
test("add 返回的路径与 list 报出的路径可直接比对", async () => {
  const root = await makeRepo();
  const m = createWorktreeManager({ git: realGit(root), repoRoot: root });
  const { path } = await m.add({ branch: "squad/wi1/a", base: "main", dirName: "wi1-a" });
  assert.equal(path, (await m.list())[0]?.path);
});

// --force 是抛弃语义：队员留下的未提交改动不该挡住收尾（那些改动不参与合并，合并按分支走）。
test("remove 连未提交改动一起丢掉", async () => {
  const root = await makeRepo();
  const m = createWorktreeManager({ git: realGit(root), repoRoot: root });
  const { path } = await m.add({ branch: "squad/wi1/a", base: "main", dirName: "wi1-a" });
  writeFileSync(join(path, "dirty.txt"), "leftover\n");
  await m.remove("wi1-a");
  assert.deepEqual(await m.list(), []);
  assert.equal(existsSync(path), false);
});

test("remove 不存在的 dirName 响亮失败", async () => {
  const root = await makeRepo();
  const m = createWorktreeManager({ git: realGit(root), repoRoot: root });
  await assert.rejects(m.remove("nope"), /is not a working tree/);
});

// dirName 带 `..` 或分隔符就能把工作树挪到 .worktree/ 之外：那样「工作树都在一个根下」
// 和「集中排除清单只需一项」这两个前提会同时失效，所以按参数拒绝，而不是等 git 去兜。
test("add / remove 拒绝越界 dirName", async () => {
  const root = await makeRepo();
  const m = createWorktreeManager({ git: realGit(root), repoRoot: root });
  for (const dirName of ["", ".", "..", "a/b", "..\\escape"]) {
    await assert.rejects(
      m.add({ branch: "squad/x", base: "main", dirName }),
      /Invalid worktree dirName/,
    );
    await assert.rejects(m.remove(dirName), /Invalid worktree dirName/);
  }
});

// 「分支已存在」和「目标目录非空」是 add 最常见的两种失败，git 给的文案不同，
// 上层要据此决定处置（换个分支名 vs 先清目录），所以这两种原因都必须原样带出。
test("add 失败时把原因原文带出：分支已存在 / 目标目录非空", async () => {
  const root = await makeRepo();
  const m = createWorktreeManager({ git: realGit(root), repoRoot: root });
  await m.add({ branch: "squad/wi1/a", base: "main", dirName: "wi1-a" });

  await assert.rejects(
    m.add({ branch: "squad/wi1/a", base: "main", dirName: "wi1-a2" }),
    /a branch named 'squad\/wi1\/a' already exists/,
  );

  const busy = join(resolveWorktreeRoot(root), "wi1-b");
  mkdirSync(busy, { recursive: true });
  writeFileSync(join(busy, "occupied.txt"), "x\n");
  await assert.rejects(
    m.add({ branch: "squad/wi1/b", base: "main", dirName: "wi1-b" }),
    /already exists/,
  );
});

// detached 的工作树没有分支名。若解析器把上一块的分支顺延下来，这里会读出别人的分支 ——
// 那意味着「哪个分支属于哪个工作面」的判断会串味。
test("detached 的工作树 branch 为 null 且不与相邻块串味", async () => {
  const root = await makeRepo();
  const git = realGit(root);
  const m = createWorktreeManager({ git, repoRoot: root });
  await m.add({ branch: "squad/wi1/a", base: "main", dirName: "wi1-a" });
  const detachedPath = join(resolveWorktreeRoot(root), "wi1-b");
  const added = await git(["worktree", "add", "--detach", detachedPath, "main"], { cwd: root });
  assert.equal(added.code, 0, added.stderr);

  const list = await m.list();
  assert.equal(list.length, 2);
  assert.equal(list.find((entry) => entry.path.endsWith("wi1-b"))?.branch, null);
  assert.equal(list.find((entry) => entry.path.includes("wi1-a"))?.branch, "squad/wi1/a");
});

// 目录被外部删掉（进程被杀、手工 rm）后 git 里仍留着一个注册项。它不占任何工作面，
// 算进 list 就是「队员数」虚增；prune() 是这类残骸的清理入口。
test("目录消失的残骸不算队员，prune 后 git 侧也收敛", async () => {
  const root = await makeRepo();
  const git = realGit(root);
  const m = createWorktreeManager({ git, repoRoot: root });
  const { path } = await m.add({ branch: "squad/wi1/a", base: "main", dirName: "wi1-a" });
  await rm(path, { recursive: true, force: true });

  assert.deepEqual(await m.list(), []);
  await m.prune();
  const raw = await git(["worktree", "list", "--porcelain"], { cwd: root });
  assert.equal(raw.stdout.includes("wi1-a"), false);
});

// git 没装或 PATH 不对时没有 stderr；不把 spawn 错误本身带上，上层只会看到
// 「失败、退出码 1、原因为空」——这种诊断等于没有。
test("git 起不来时不抛且带回可读原因", async () => {
  const git = createGitRunner({ binary: "zcode-no-such-git-binary" });
  const result = await git(["status"], { cwd: await makeRepo() });
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.length > 0);
});
