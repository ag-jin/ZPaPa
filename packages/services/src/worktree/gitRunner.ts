import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type GitRunResult = { code: number; stdout: string; stderr: string };

export type GitRunner = (args: string[], opts: { cwd: string }) => Promise<GitRunResult>;

/* 小队这条链路上跑 git 的薄壳。刻意不复用 src/git 那套 GitCommandProvider：
   那层是面向 UI 的仓库服务（spawn + 超时 + 输出截断 + 二进制探测 + 结果归一化），
   而工作树管理只要「跑一条命令、把 code/stdout/stderr 原样拿回来」。
   失败的含义由调用点决定：同一条 stderr 在「建工作树」和「删分支」两处并不等价。 */

const execFileAsync = promisify(execFile);

/**
 * 把一次失败的 git 运行变成异常，并把 stderr 原样带出。
 * 上层要靠这段文案区分「分支已被别的 worktree 占用」这类可读原因，
 * 所以只丢出「失败」两个字是最坏的结果：调用方既不能分因，也不能重试。
 */
export class GitCommandError extends Error {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(label: string, result: GitRunResult) {
    super(
      `${label} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim() || "(no output)"}`,
    );
    this.name = "GitCommandError";
    this.code = result.code;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

export function ensureGitRunSucceeded(label: string, result: GitRunResult): GitRunResult {
  if (result.code !== 0) {
    throw new GitCommandError(label, result);
  }
  return result;
}

/**
 * 真实执行 git 的 runner：**不抛**，失败也统一返回 `{ code, stdout, stderr }`。
 * `binary` 只在测试里用来模拟「git 没装 / PATH 不对」。
 */
export function createGitRunner(options?: { binary?: string }): GitRunner {
  const binary = options?.binary ?? "git";
  return async (args, opts) => {
    try {
      const { stdout, stderr } = await execFileAsync(binary, args, {
        cwd: opts.cwd,
        windowsHide: true,
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
      const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
      return {
        code: typeof failure.code === "number" ? failure.code : 1,
        stdout: typeof failure.stdout === "string" ? failure.stdout : "",
        // git 根本没起来时（未安装、PATH 不对）没有 stderr，只有 spawn 自己的错误。
        // 不把它带出来，上层看到的就是「失败、退出码 1、原因为空」。
        stderr: stderr.length > 0 ? stderr : error instanceof Error ? error.message : "",
      };
    }
  };
}
