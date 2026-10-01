import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { GitCommandError, createGitRunner } from "../src/worktree/gitRunner.js";
import {
  canonicalPath,
  createWorktreeManager,
  resolveWorktreeRoot,
} from "../src/worktree/worktreeManager.js";
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

// 上一条的反面：只有 ENOENT 才算残骸。别的 fs 错误（EACCES/EPERM/ELOOP）说明路径可能活得好好的，
// 若也当成「不存在」，活着的工作树会被静默抹掉 —— 队员数少 1 且零信号。
// 这里用自指符号链接确定性地造 ELOOP：不依赖 uid（以 root 跑测试时 chmod 000 根本不拦人，
// 那种用例会永远绿，等于没测）。
test("访问工作树路径报非 ENOENT 错误时，list 抛错而不是静默少一项", async () => {
  const root = await makeRepo();
  const m = createWorktreeManager({ git: realGit(root), repoRoot: root });
  const { path } = await m.add({ branch: "squad/wi1/a", base: "main", dirName: "wi1-a" });
  await rm(path, { recursive: true, force: true });
  symlinkSync("wi1-a", path);

  const error = await m.list().then(
    () => null,
    (e: unknown) => e as { code?: string },
  );
  assert.equal(error?.code, "ELOOP");
});

// canonicalPath 的错误处理必须与 pathExists 同族（只有 ENOENT 算「不存在」）：
// (a) 路径还不存在是合法情形 —— `orphanReaper` 一次都没建过工作树时要靠它拿到原串继续比较，
//     退回原路径、不能抛；否则「根本没有工作树」会被错算成故障。
test("canonicalPath 对不存在的路径退回原路径（ENOENT 合法）", async () => {
  const root = await makeRepo();
  const missing = join(root, "no-such-anywhere");
  assert.equal(await canonicalPath(missing), missing);
});

// (b) 非 ENOENT 的错误必须**响亮抛出**，不能静默退化。静默退回原串在归属判定上是危险的：
// orphanReaper 拿 canonicalPath(repoRoot) 当自家根，realpath 因 EACCES/ELOOP 失败而退回原串时，
// macOS 的 /var ↔ /private/var 形态差异会把自家每个工作树都判成外来树 ⇒ reap 静默空转（还报成功）。
// 这里照 pathExists 用例的手法用**自指符号链接**确定性地造 ELOOP（不依赖 uid）。
test("canonicalPath 对非 ENOENT 错误原样抛出（ELOOP）", async () => {
  const root = await makeRepo();
  const path = join(root, "self-loop");
  symlinkSync("self-loop", path);
  const error = await canonicalPath(path).then(
    () => null,
    (e: unknown) => e as { code?: string },
  );
  assert.equal(error?.code, "ELOOP");
});

// 夹具必须服从 opts.cwd：git 的行为随 cwd 变，夹具若写死自己造的那个仓库，
// createWorktreeManager 传进来的 repoRoot 就会被静默忽略 —— 命令跑在别的仓库上却不报错。
test("realGit 真的跑在 opts.cwd 指的仓库里", async () => {
  const repoA = await makeRepo();
  const repoB = await makeRepo();
  const result = await realGit(repoA)(["rev-parse", "--show-toplevel"], { cwd: repoB });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), realpathSync(repoB));
});

// git 没装或 PATH 不对时没有 stderr；不把 spawn 错误本身带上，上层只会看到
// 「失败、退出码 1、原因为空」——这种诊断等于没有。
test("git 起不来时不抛且带回可读原因", async () => {
  const git = createGitRunner({ binary: "zcode-no-such-git-binary" });
  const result = await git(["status"], { cwd: await makeRepo() });
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.length > 0);
});
