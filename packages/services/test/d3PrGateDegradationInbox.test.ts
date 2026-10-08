import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createInboxItemRepo, INBOX_SEVERITY_BY_KIND } from "../src/workitem/inboxItemRepo.js";
import {
  buildPrGateDegradedInboxItem,
  computeInboxDedupKey,
} from "../src/workitem/inboxItemProducers.js";

/* #8 D3：pr-gate 收尾**降级**的留痕面（设计 §4.1 失败面「不静默」的同一纪律在家门口的一次应用）。

   降级的定义：模式选了 pr-gate，但前置条件不满足（没 token / 没 remote / remote 不是 GitHub）
   ⇒ 收尾**改走本地形态**（批次照常落地），但用户必须能看出「这次不是按我选的模式收的尾，为什么」。
   静默降级是最坏的一种：用户以为 PR 已经开了（那是他选 pr-gate 的全部意义），而实际什么都没推。 */

const WS = "pr-gate-ws";
const PARENT = "wi-plan";

function input(over: Partial<Parameters<typeof buildPrGateDegradedInboxItem>[0]> = {}) {
  return {
    workspaceKey: WS,
    workspacePath: "/tmp/pr-gate-ws",
    parentWorkItemId: PARENT,
    parentTitle: "计划 A",
    code: "no_token" as const,
    reason: "未配置 GitHub 访问令牌（PAT）：pr-gate 需要 PAT 才能开 PR。",
    integrationBranch: "squad/integration/wi-plan",
    targetBranch: "main",
    ...over,
  };
}

test("构建件｜三个码值各成一条（kind=pr_gate_degraded / attention / detail 带码与集成分支）", () => {
  for (const code of ["no_token", "no_remote", "remote_not_github"] as const) {
    const item = buildPrGateDegradedInboxItem(input({ code }));
    assert.equal(item.kind, "pr_gate_degraded");
    assert.equal(item.title, "计划 A", "标题取父项标题（拿不到时回落 id，见下一条）");
    assert.equal(item.workItemId, PARENT);
    assert.equal(item.runId, undefined, "降级是批次级事实，不挂某一条 run");
    assert.deepEqual(item.detail, {
      parentWorkItemId: PARENT,
      code,
      reason: input({ code }).reason,
      integrationBranch: "squad/integration/wi-plan",
      targetBranch: "main",
    });
    assert.equal(INBOX_SEVERITY_BY_KIND[item.kind], "attention", "本地收尾照常、但模式没按用户选的走");
  }
  assert.equal(buildPrGateDegradedInboxItem(input({ parentTitle: null })).title, PARENT);
});

test("去重键唯一形状｜同父项 + 同码 ⇒ 一条；同父项 + 换码 ⇒ 新的一条（原因变了就是新事实）", () => {
  assert.equal(
    computeInboxDedupKey({ kind: "pr_gate_degraded", parentWorkItemId: PARENT, code: "no_token" }),
    `pr_gate_degraded:${PARENT}:no_token`,
  );
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const repo = createInboxItemRepo(db);
  assert.equal(repo.insertIfAbsent(buildPrGateDegradedInboxItem(input())), true);
  assert.equal(
    repo.insertIfAbsent(buildPrGateDegradedInboxItem(input())),
    false,
    "同一事实（同批 + 同因）重投不产生第二条",
  );
  assert.equal(
    repo.insertIfAbsent(buildPrGateDegradedInboxItem(input({ code: "no_remote", reason: "没有 origin" }))),
    true,
    "换因（从没 token 变成没 remote）是新事实：新一条 —— 否则「先配 token 再发现没 remote」的第二次降级不可见",
  );
  assert.equal(repo.listByWorkspace(WS).length, 2);
});
