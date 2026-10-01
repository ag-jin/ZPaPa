import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createGitRunner, type GitRunner } from "../../src/worktree/gitRunner.js";

/* 工作树相关测试的共享夹具。
   放在 test/helpers/ 而不是各测试文件里各写一份：造仓库的样板一旦分叉，
   「add 能看见 / remove 看不见」这类断言就会在不同文件里跑在不同的仓库形态上，
   失败时先要花时间确认差异到底来自实现还是来自夹具。 */

const run = promisify(execFile);

/** 造一个一次性临时 git 仓库（已 init 到 main 且有一次提交），返回仓库根。 */
export async function makeRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "repo-"));
  await run("git", ["init", "-q", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.email", "t@t"], { cwd: root });
  await run("git", ["config", "user.name", "t"], { cwd: root });
  writeFileSync(join(root, "a.txt"), "1\n");
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["commit", "-qm", "init"], { cwd: root });
  return root;
}

/**
 * 返回真实执行 git 的 runner：**委托生产实现 `createGitRunner()`**，本夹具只补一个 cwd 缺省值。
 *
 * 为什么必须委托（终审 M5）：这里以前把「execFile 失败也归一成 `{code, stdout, stderr}`、不抛」
 * 自己抄了一遍 ⇒ 所有 worktree 测试验证的是**夹具版 runner**，与生产 runner 之间没有任何编译期
 * 关联，可以静默漂移（生产侧补了 `windowsHide`、或给 spawn 失败兜底 stderr 时，夹具永远学不到，
 * 于是「测试全绿」并不代表生产那条路径被覆盖）。委托之后，「夹具测出来的行为」就是生产的行为。
 *
 * 必须走真进程而不是打桩：要断言的正是「git 自己会把什么文案、什么退出码放出来」
 * （`not a valid object name`、`is not a working tree` 都是 git 的产物，打桩只会自证）。
 *
 * cwd 以 `opts.cwd` 为准，`root` 只是缺省：git 的行为随 cwd 变，夹具若写死自己造的那个
 * 仓库，调用方传进来的目录会被静默忽略 —— 命令跑在别的仓库上却一路不报错。
 */
export function realGit(root: string): GitRunner {
  const git = createGitRunner();
  return (args, opts) => git(args, { cwd: opts.cwd || root });
}
