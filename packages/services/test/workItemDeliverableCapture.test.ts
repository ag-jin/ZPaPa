import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  computeBatchDiffDeliverableDedupKey,
  computeRunDiffDeliverableDedupKey,
  createDeliverableCapture,
  deliverableIdForDedupKey,
} from "../src/workitem/workItemDeliverableCapture.js";
import type { GitRunResult, GitRunner } from "../src/worktree/gitRunner.js";
import { makeRepo, realGit } from "./helpers/gitFixture.js";

/* #7 交付物（D1a）**捕获函数**（纯逻辑侧，D1b 接线）：git 事实 → diff 文本或失败原因。

   两条纪律：
   · **git 经注入 runner**（`GitRunner`）⇒ 失败路径可测（真 git 只跑得通快乐路径）；
   · **失败不抛不阻断**（返回失败原因）——与 Activity 投影同款：留痕失败不得翻转已落地的事实
     （本函数的调用点在 `reviewMemberRun` 合并成功臂与 `finalize` 落地臂，两处都是「已经成功」之后）。

   run 级用**真 git 仓库**（夹具先例）：要断言的正是 git 自己吐出什么，打桩只会自证。 */

function gitAt(root: string): GitRunner {
  const git = realGit(root);
  return (args, opts) => git(args, { cwd: opts.cwd || root });
}

const MEMBER = "squad/member/wi-1/agent-a";

/** 主分支上一次提交 → 队员分支上两次提交（夹具里的 git 事实就是断言的真值来源）。 */
async function repoWithMemberCommits(): Promise<string> {
  const root = await makeRepo();
  const git = gitAt(root);
  const run = async (args: string[]): Promise<GitRunResult> => git(args, { cwd: root });
  await run(["checkout", "-q", "-b", MEMBER]);
  writeFileSync(join(root, "b.txt"), "b1\n");
  await run(["add", "-A"]);
  await run(["commit", "-qm", "feat: b1"]);
  writeFileSync(join(root, "b.txt"), "b2\n");
  await run(["add", "-A"]);
  await run(["commit", "-qm", "feat: b2"]);
  return root;
}

test("captureRunDiff：base...member 全 diff + stat + commit 数（真 git；分支删除前的唯一窗口）", async () => {
  const root = await repoWithMemberCommits();
  const capture = createDeliverableCapture({ git: realGit(root), repoRoot: root });
  const result = await capture.captureRunDiff({ base: "main", member: MEMBER });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  // diff 正文 = 队员分支相对 base 的全部改动（三点的合并基点语义：只算这个队员的活）。
  assert.match(result.diff, /diff --git a\/b\.txt b\/b\.txt/);
  assert.match(result.diff, /\+b2/);
  assert.doesNotMatch(result.diff, /a\.txt/, "base 上已有的 a.txt 不混进队员的 diff");
  // stat 摘要与 commit 数：commit 数是夹具造出来的事实（2 次提交），不是实现自算的。
  assert.match(result.stat, /b\.txt/);
  assert.match(result.stat, /insertion/);
  assert.equal(result.commitCount, 2);
});

test("captureBatchDiff：finalize 前后 target sha 差；集成分支已删也照捕（不依赖被删分支）", async () => {
  const root = await makeRepo();
  const git = gitAt(root);
  const run = async (args: string[]): Promise<GitRunResult> => git(args, { cwd: root });
  const capture = createDeliverableCapture({ git: realGit(root), repoRoot: root });

  // 集成分支上攒一个提交（本批的成果）。
  await run(["checkout", "-q", "-b", "squad/integration/wi-1"]);
  writeFileSync(join(root, "c.txt"), "c1\n");
  await run(["add", "-A"]);
  await run(["commit", "-qm", "feat: c1"]);
  // finalize **之前**读一次 target sha（纯读）——这是批级 diff 的起点，也是唯一需要事先取的值。
  const baseSha = (await run(["rev-parse", "main"])).stdout.trim();

  // finalize（集成分支 → target）→ 删集成分支（真实收尾次序：合回之后才删）。
  await run(["checkout", "-q", "main"]);
  await run(["merge", "--no-ff", "-q", "squad/integration/wi-1", "-m", "merge wi-1 batch"]);
  await run(["branch", "-D", "squad/integration/wi-1"]);
  assert.notEqual(
    (await run(["rev-parse", "-q", "--verify", "refs/heads/squad/integration/wi-1"])).code,
    0,
    "集成分支此刻确实已不在（这条用例守的正是「不依赖被删分支」）",
  );

  const result = await capture.captureBatchDiff({ target: "main", baseSha });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.match(result.diff, /\+c1/);
  assert.match(result.stat, /c\.txt/);
  assert.equal(
    result.commitCount,
    2,
    "baseSha → target 之间 = 合回的成果提交 + --no-ff 的合并提交本身（git rev-list 的字面口径）",
  );

  // 空批（target 一动不动）：合法结果——diff 是空串、commit 数 0，不是失败。
  const headSha = (await run(["rev-parse", "main"])).stdout.trim();
  const empty = await capture.captureBatchDiff({ target: "main", baseSha: headSha });
  assert.deepEqual(empty, { ok: true, diff: "", stat: "", commitCount: 0 });
});

test("捕获失败不抛不阻断：分支不存在 / runner 抛错 / 参数形态非法 ⇒ 一律 {ok:false, reason}", async () => {
  const root = await makeRepo();
  const capture = createDeliverableCapture({ git: realGit(root), repoRoot: root });

  // ① 真 git 失败：队员分支不存在（合并臂的 branch_missing 同款场景）。原因必须带得出原文。
  const missing = await capture.captureRunDiff({
    base: "main",
    member: "squad/member/wi-1/agent-none",
  });
  assert.equal(missing.ok, false, "分支不在 ⇒ 失败原因，不是抛");
  if (missing.ok) return;
  assert.match(missing.reason, /agent-none/, "原因里要看得出是哪条分支");

  // ② 注入的 runner 自己抛（进程起不来 / 被 kill）：捕获同样不抛——调用点在「已经成功」之后，
  //    留痕失败不得把已落地的事实翻转成失败。
  const throwing = createDeliverableCapture({
    git: async () => {
      throw new Error("git 起不来");
    },
    repoRoot: root,
  });
  const thrown = await throwing.captureRunDiff({ base: "main", member: MEMBER });
  assert.equal(thrown.ok, false);
  if (!thrown.ok) assert.match(thrown.reason, /git 起不来/);

  // ③ 参数形态闸：`--output=<file>` 会被 git 当成选项（把 diff 写到参数指定的文件），
  //    在进 git 之前就拒——否则返回值看着正常、盘上却多出一个文件。
  const escapeTarget = join(root, "pwned.diff");
  const injected = await capture.captureRunDiff({
    base: "main",
    member: `--output=${escapeTarget}`,
  });
  assert.equal(injected.ok, false);
  if (!injected.ok) assert.match(injected.reason, /形态/);
  assert.equal(existsSync(escapeTarget), false, "不得把 diff 写到参数指定的文件");

  // ④ 批级同款（baseSha 也是 revision 参数位）。
  const badBatch = await capture.captureBatchDiff({ target: "main", baseSha: "--output=x" });
  assert.equal(badBatch.ok, false);
});

test("键函数：run 级/批级 dedupKey 与 id 派生（形状冻结，字面量钉住）", () => {
  assert.equal(computeRunDiffDeliverableDedupKey("run-1"), "deliverable:run-1:diff");
  assert.equal(computeBatchDiffDeliverableDedupKey("wi-1"), "deliverable:wi-1:batch-diff");
  // id 与键**同源**（不解析键，只做机械替换——与 Activity 投影 `activity-<键>` 同一手法）：
  assert.equal(
    deliverableIdForDedupKey("deliverable:run-1:diff"),
    "deliverable-deliverable-run-1-diff",
  );
  assert.equal(
    computeRunDiffDeliverableDedupKey("run-1"),
    computeRunDiffDeliverableDedupKey("run-1"),
  );
});
