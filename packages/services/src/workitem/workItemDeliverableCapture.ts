import type { GitRunner } from "../worktree/gitRunner.js";

/* #7 交付物（D1a）的**捕获函数**：把两条 git 事实（一个队员分支的产出、一次整批合回）
   转成「可留痕的 diff」，或一个**失败原因**（设计 §3.1/§3.3）。

   为什么必须存在这一层（不是把三条 git 命令抄到调用点）：
   · 调用点（D1b：`reviewMemberRun` 的合并成功臂、`finalize` 落地臂）只交「拿在手里的分支信息」，
     `git diff` 的组合方式、stat/commit 数的取法只在这里定义一份；
   · **失败不抛不阻断**（设计 §8 / 投影同款纪律）：调用点都在「已经成功」之后（合并已落地、
     整批已合回），留痕失败不得把已落地的事实翻转成失败——所以这里把一切失败（git 退出码非 0、
     runner 抛错、参数形态非法）都收敛成 `{ ok: false, reason }`。

   两个窗口（设计 §3.3，次序是硬约束）：
   · **run 级**：`reviewMemberRun(approved)` 合并成功后、抛弃队员（删树删分支）之前 —— 这是
     member ref 还活着的**唯一窗口**；用 `git diff <base>...<member>`（三点：只算该分支相对
     合并基点的改动，别人的提交不混进来）；
   · **批级**：`finalize` 落地之后，用「**finalize 之前**读到的 target sha」与 target 当前状态
     做差 —— 该 diff **不依赖任何被删分支**（集成分支与队员分支此时都已删/待删）。

   刻意不在这里写文件、不登记表、不发 Activity 回声：那是存储面（`workItemDeliverableRepo`）
   与 D1b 接线的职责；本模块只回答「这次的 diff 是什么」。 */

export type DiffCaptureResult =
  | { ok: true; diff: string; stat: string; commitCount: number }
  | { ok: false; reason: string };

/* 自动捕获的**身份键形状**（设计 §3.2，单源定义）：
   · run 级 `deliverable:<runId>:diff`：一条 run 至多一条自动 diff（重投/重放由存储层的
     唯一索引咬住，不产生第二条）；
   · 批级 `deliverable:<parentWorkItemId>:batch-diff`：一个工作项的整批合回至多一条
     （finalize 重驱的幂等闸已保证同一事实不重放，捕获跟随同一事实键）。 */
export function computeRunDiffDeliverableDedupKey(runId: string): string {
  return `deliverable:${runId}:diff`;
}

export function computeBatchDiffDeliverableDedupKey(parentWorkItemId: string): string {
  return `deliverable:${parentWorkItemId}:batch-diff`;
}

/**
 * 交付物 id 与 dedupKey **同源**（设计 §3.2「自动捕获：id = deliverable-<dedupKey>」）：
 * 与 Activity 投影的 `activity-<键>` 同一手法——机械替换，**不解析键**（键一旦被解析，
 * 「自己拼的字符串自己读不回」的老路就会复发）。
 */
export function deliverableIdForDedupKey(dedupKey: string): string {
  return `deliverable-${dedupKey.replaceAll(":", "-")}`;
}

/**
 * 参数形态闸：这些字符串会直接进 git 参数位。git 的 diff 族接受 `--output=<file>` 这类
 * **选项**，一个以 `-` 开头的「分支名」会把命令变成「把 diff 写到别处」——
 * 那时返回值看起来正常、盘上却多了一个文件。含空白的形态同理（会被拆成多个参数）。
 * 这里不做 slug 白名单（分支命名规则只属于 `branchNaming`），只挡「选项形态 / 参数注入形态」。
 */
function assertRevisionShape(value: string, field: string): string {
  if (value.trim() === "" || value.startsWith("-") || /\s/.test(value)) {
    throw new Error(
      `捕获的 ${field} 不是合法的 revision 形态（收到 ${JSON.stringify(value)}）：` +
        "以 `-` 开头会被 git 当成选项、含空白会被拆成多个参数，命令的含义就变了。",
    );
  }
  return value;
}

export function createDeliverableCapture(deps: { git: GitRunner; repoRoot: string }): {
  /**
   * run 级 diff：`<base>...<member>`（三点）的正文 + `--stat` 摘要 + 范围内的 commit 数。
   * 必须在队员分支被删之前调用（合并成功后、抛弃前）。
   */
  captureRunDiff(input: { base: string; member: string }): Promise<DiffCaptureResult>;
  /**
   * 批级 diff：`<baseSha>..<target>`（finalize 之前读到的 target sha → target 当前状态）。
   * 不依赖集成分支 / 队员分支是否还在。
   */
  captureBatchDiff(input: { target: string; baseSha: string }): Promise<DiffCaptureResult>;
} {
  const { git, repoRoot } = deps;

  async function run(args: string[], label: string): Promise<string> {
    const result = await git(args, { cwd: repoRoot });
    if (result.code !== 0) {
      throw new Error(
        `${label} 失败（exit ${result.code}）：${result.stderr.trim() || result.stdout.trim() || "(no output)"}`,
      );
    }
    return result.stdout;
  }

  /** 失败收敛：**一切**失败（git 非 0 / runner 抛 / 参数形态非法）都变成失败原因，不上抛。 */
  async function attempt(
    label: string,
    work: () => Promise<DiffCaptureResult>,
  ): Promise<DiffCaptureResult> {
    try {
      return await work();
    } catch (error) {
      return {
        ok: false,
        reason: `${label}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** 三个量取自同一个范围：diff 正文、stat 摘要（呈现与对账用）、commit 数。 */
  async function captureRange(
    label: string,
    range: string,
    commitRange: string,
  ): Promise<DiffCaptureResult> {
    const diff = await run(["diff", "--no-color", range], label);
    const stat = await run(["diff", "--no-color", "--stat", range], label);
    const countText = await run(["rev-list", "--count", commitRange], label);
    const commitCount = Number.parseInt(countText.trim(), 10);
    if (!Number.isInteger(commitCount) || commitCount < 0) {
      throw new Error(`${label} 的 commit 数读不回：${JSON.stringify(countText)}`);
    }
    return { ok: true, diff, stat, commitCount };
  }

  return {
    captureRunDiff(input) {
      return attempt("run 级 diff 捕获", async () => {
        const base = assertRevisionShape(input.base, "base");
        const member = assertRevisionShape(input.member, "member");
        // 三点：`base...member` = 以 merge-base 为基点的改动（多个分支共用 base 时互不混入）。
        return captureRange("run 级 diff 捕获", `${base}...${member}`, `${base}..${member}`);
      });
    },

    captureBatchDiff(input) {
      return attempt("批级 diff 捕获", async () => {
        const target = assertRevisionShape(input.target, "target");
        const baseSha = assertRevisionShape(input.baseSha, "baseSha");
        // 两点：finalize 之前的 target sha → target 现在的状态 = 这次合回带进来的全部改动。
        // 不引用集成分支（它随后就被删），所以按「被删分支」为输入的实现不可替代这一点。
        return captureRange("批级 diff 捕获", `${baseSha}..${target}`, `${baseSha}..${target}`);
      });
    },
  };
}
