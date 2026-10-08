import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SQUAD_MERGE_MODES,
  SQUAD_PR_GATE_DEGRADE_CODES,
  appSettingsPatchSchema,
  appSettingsSchema,
  resolveSquadMergeMode,
} from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import {
  createGitHubPullRequestProvider,
  truncateRemoteField,
} from "../src/workitem/pullRequestProvider.js";
import { INBOX_ITEM_KINDS, INBOX_SEVERITY_BY_KIND } from "../src/workitem/inboxItemRepo.js";
import { WORK_ITEM_ACTIVITY_KINDS } from "../src/workitem/workItemActivityRepo.js";
import { computePullRequestMergedDedupKey } from "../src/workitem/workItemActivityProjector.js";

/* #8 D3 **闭集台账**的独立核对（任务 6）：第 21 枚、降级码值、模式闭集、脏值收敛与单点快照。

   期望值全部**手写**（不用被测的常量反算期望）；结构面（单点快照）以**读源码**为证据。 */

const SERVICES_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

test("独立复验｜WORK_ITEM_ACTIVITY_KINDS 恰 21 枚且唯一，第 21 枚 = pr_merged（手写全表 deepEqual）", () => {
  const handWritten = [
    "comment_created",
    "comment_mention_parsed",
    "comment_dispatch_requested",
    "comment_dispatch_suppressed",
    "comment_deleted",
    "comment_resolved",
    "comment_reaction_added",
    "decision_created",
    "status_changed",
    "assignee_changed",
    "run_started",
    "run_completed",
    "run_failed",
    "run_cancelled",
    "run_rejected",
    "worktree_created",
    "worktree_merged",
    "worktree_discarded",
    "wake_rule_fired",
    "deliverable_registered",
    "pr_merged",
  ];
  assert.equal(WORK_ITEM_ACTIVITY_KINDS.length, 21, "闭集恰 21 枚");
  assert.equal(new Set(WORK_ITEM_ACTIVITY_KINDS).size, 21, "21 枚互不重复");
  assert.deepEqual([...WORK_ITEM_ACTIVITY_KINDS].sort(), [...handWritten].sort());
  assert.equal(WORK_ITEM_ACTIVITY_KINDS[20], "pr_merged", "第 21 枚是 pr_merged（追加纪律）");
  assert.equal(computePullRequestMergedDedupKey("pr-x"), "pr:pr-x:merged");
});

test("独立复验｜Inbox 闭集（手写表）：9 枚唯一、严重级映射穷尽、pr_gate_degraded = attention", () => {
  const handWritten = [
    "merge_conflict",
    "member_failed",
    "run_orphaned",
    "dispatch_skipped",
    "run_stalled",
    "pr_gate_degraded",
    // SUB.2 追加三格（评论/决定族；闭集只增不改：既有六格一字不动）。
    "mention_action_required",
    "decision_required",
    "comment_attention",
  ];
  assert.deepEqual([...INBOX_ITEM_KINDS].sort(), [...handWritten].sort());
  assert.equal(new Set(INBOX_ITEM_KINDS).size, handWritten.length);
  assert.deepEqual(
    Object.keys(INBOX_SEVERITY_BY_KIND).sort(),
    [...handWritten].sort(),
    "每个 kind 都必须有严重级（映射穷尽，无缺格）",
  );
  assert.equal(INBOX_SEVERITY_BY_KIND["pr_gate_degraded"], "attention");
  assert.deepEqual(
    [...SQUAD_PR_GATE_DEGRADE_CODES],
    ["no_token", "no_remote", "remote_not_github"],
  );
  assert.deepEqual([...SQUAD_MERGE_MODES], ["local", "pr-gate"]);
});

test("独立复验｜模式脏值收敛到 local（闭集外一切形态），pr-gate 原样保留", () => {
  assert.equal(resolveSquadMergeMode("pr-gate"), "pr-gate");
  assert.equal(resolveSquadMergeMode("local"), "local");
  for (const dirty of [
    undefined,
    null,
    "",
    "  ",
    "PR-GATE",
    "prgate",
    "pr_gate",
    0,
    1,
    true,
    false,
    {},
    [],
  ]) {
    assert.equal(
      resolveSquadMergeMode(dirty),
      "local",
      `闭集外值必须收敛 local（不动远端的那一侧）：${JSON.stringify(dirty)}`,
    );
  }
  // 设置面两道闸：schema 关「能不能存」（闭集外拒绝），读出口关「读出来怎么用」（上面）。
  assert.equal(
    appSettingsSchema.parse({}).squadMergeMode,
    "local",
    "缺省 local（有确定值，不悬空）",
  );
  assert.equal(appSettingsSchema.parse({ squadMergeMode: "pr-gate" }).squadMergeMode, "pr-gate");
  assert.equal(appSettingsPatchSchema.safeParse({ squadMergeMode: "pr-gate" }).success, true);
  assert.equal(appSettingsPatchSchema.safeParse({ squadMergeMode: "local" }).success, true);
  assert.equal(
    appSettingsPatchSchema.safeParse({ squadMergeMode: "garbage" }).success,
    false,
    "patch 闭集外值必须被拒（脏值不进库）",
  );
});

test("独立复验｜单点快照（结构证据）：settings.squadMergeMode 的属性读仅 node.ts 一处，且经 resolveSquadMergeMode 归一", () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) {
        const source = readFileSync(path, "utf8");
        for (const line of source.split("\n")) {
          if (/settings\.squadMergeMode/.test(line)) offenders.push(`${path}:${line.trim()}`);
        }
      }
    }
  };
  walk(SERVICES_SRC);
  assert.equal(offenders.length, 1, `属性读必须单点：${JSON.stringify(offenders)}`);
  assert.match(offenders[0]!, /node\.ts/);
  assert.match(offenders[0]!, /resolveSquadMergeMode/, "单点处必须用同一个归一函数");

  // 编排器的现判点恰一次（收尾那一刻取一次），读取口本身是 runtime 契约的一部分。
  const orchestrator = readFileSync(resolve(SERVICES_SRC, "workitem/squadOrchestrator.ts"), "utf8");
  const callSites = orchestrator.match(/readSquadMergeMode\(\)/g) ?? [];
  assert.equal(callSites.length, 1, "编排器在收尾那一刻取一次，不在构造期冻结");
});

test("独立复验｜runtime 缺省读取口 ⇒ local（不注入即零出站形态）", async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "d3-iv-mode-"));
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  try {
    const runtime = await createSquadRuntime({
      db,
      workspacePath,
      workspaceIdentity: "d3-iv-mode-ws",
      readExperimentEnabled: () => true,
    });
    assert.equal(runtime.readSquadMergeMode(), "local");
  } finally {
    db.close();
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("独立复验｜P3 顺手修：地址形态问题报 invalid_url（零出站）；远端可控文本进原因前定长截断", async () => {
  // ① invalid_url 是**请求侧**形态问题：与网络失败分开报（处置不同），且零出站（形态不对不发请求）。
  const calls: string[] = [];
  const provider = createGitHubPullRequestProvider({
    readToken: () => "ghp_iv_p3",
    fetchImpl: (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  for (const url of [
    "https://gitlab.com/iv-org/iv-repo/pull/1",
    "https://github.com/iv-org/iv-repo",
    "not-a-url",
  ]) {
    const result = await provider.fetchPullRequest(url);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "invalid_url", `地址形态问题必须报 invalid_url：${url}`);
  }
  assert.equal(calls.length, 0, "形态不对 ⇒ 零出站");

  // ② 定长截断：远端可控的长文本（失败响应 message）进原因前被截断并写明。
  const hugeMessage = "A".repeat(100_000);
  const bounded = truncateRemoteField(hugeMessage);
  assert.ok(bounded.startsWith("A".repeat(120)), "保留开头若干字符（可行动性）");
  assert.ok(bounded.includes("截断"), "必须写明被截断（不假装原文就这么短）");
  assert.ok(bounded.length < 200, `截断后必须是有界长度：${bounded.length}`);

  const failing = createGitHubPullRequestProvider({
    readToken: () => "ghp_iv_p3",
    fetchImpl: (async () =>
      new Response(JSON.stringify({ message: hugeMessage }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  });
  const result = await failing.fetchPullRequest("https://github.com/iv-org/iv-repo/pull/1");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.reason.length < 1_000, `失败原因必须有界（远端可控）：${result.reason.length}`);
  assert.ok(result.reason.includes("截断"), "原因面同样要写明截断");
});
