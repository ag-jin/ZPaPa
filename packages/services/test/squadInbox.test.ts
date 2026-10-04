import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import {
  createInboxItemRepo,
  INBOX_ITEM_KINDS,
  INBOX_ITEM_SEVERITIES,
  INBOX_SEVERITY_BY_KIND,
  type InboxItemRepo,
  type InboxItemInput,
} from "../src/workitem/inboxItemRepo.js";
import {
  buildDispatchSkippedInboxItem,
  buildMemberFailedInboxItem,
  buildMergeConflictInboxItem,
  buildOrphanedRunInboxItem,
  computeInboxDedupKey,
} from "../src/workitem/inboxItemProducers.js";
import { createSquadOrchestrator } from "../src/workitem/squadOrchestrator.js";
import { archiveSquadAndTransfer, createSquadRuntime } from "../src/workitem/squadRuntime.js";
import {
  createSquadRuntimeService,
  type ISquadRuntimeService,
  type SquadWorkspaceTarget,
} from "../src/workitem/squadRuntimeService.js";
import { slugForId } from "../src/workitem/slug.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* 收件箱（P2c）的用例。三层各自独立：
   1. **repo 层**（真 `:memory:` sqlite + 迁移）：幂等两格（同事实重投不产生第二条 / 已归档不复活）
      是**存储层不变式**，必须在行数上读库断言；`markRead`/`archive` 的「只改一列 + 首次时间戳」
      同样读裸行（不看返回值回声）。
   2. **构建件**（纯函数）：dedupKey 的四个形状逐条钉、severity 映射穷尽、title 回落。
   3. **端到端**（真 git 仓库 + 真 runtime/编排器/服务面）：冲突 ⇒ 恰一条 merge_conflict；
      服务面目标显式 / 不过门禁 / 跨 workspace 读取。

   为什么服务面装配用**真 runtime**（照 squadRosterManagement.test.ts）：给服务面塞桩只会验证桩的行为；
   目标透传用 `seenTargets` 观测（与那名册用例同一手法）。 */

const WS = "ws";

// ── 1. repo 层 ───────────────────────────────────────────────────────────────

function setupRepo(): { db: DatabaseSync; repo: InboxItemRepo } {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return { db, repo: createInboxItemRepo(db) };
}

const inboxInput = (over: Partial<InboxItemInput> = {}): InboxItemInput => ({
  workspaceKey: WS,
  workspacePath: "/tmp/ws",
  kind: "merge_conflict",
  dedupKey: "merge_conflict:wi-p",
  title: "计划",
  detail: { parentWorkItemId: "wi-p" },
  workItemId: "wi-p",
  ...over,
});

function rowCount(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM inbox_items").get() as { n: number }).n;
}

function rawRow(db: DatabaseSync, id: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM inbox_items WHERE id = ?").get(id) as Record<string, unknown>;
}

/** 去掉某一列后的整行（用于「另两列逐字不动」的逐字比较）。 */
function withoutKey(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _ignored, ...rest } = row;
  return rest;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// 幂等格 (a)：同一事实重投**不产生第二条**。去重是存储层不变式（唯一索引 + INSERT OR IGNORE），
// 故断言必须读**行数**（返回值 false 只是这件事实的结论，行数才是「没有第二条」）。
test("insertIfAbsent：首次 true；同键第二次 false 且行数仍 1（severity 由 repo 从 kind 补）", () => {
  const { db, repo } = setupRepo();
  assert.equal(repo.insertIfAbsent(inboxInput()), true, "首次登记应真的插入");
  assert.equal(
    repo.insertIfAbsent(inboxInput()),
    false,
    "同 (workspace_key, dedup_key) 重投应被忽略",
  );
  assert.equal(rowCount(db), 1, "重投不得产生第二条");
  const [item] = repo.listAll();
  assert.ok(item);
  assert.equal(item.severity, "action_required", "severity 由 INBOX_SEVERITY_BY_KIND 单源补上");
  assert.equal(typeof item.createdAt, "number");
  assert.ok(item.id.length > 0, "id 由 repo 生成");
});

// 幂等格 (b)：已归档**不复活**。归档行仍占着那个 (workspace_key, dedup_key) ⇒ 重投被忽略；
// 且冲突时**不改任何列** ⇒ archived_at 原样、标题也不会被重投改掉（用户说过「处理完了」）。
test("已归档后同键重投：仍 false、archived_at 原样、行数仍 1、任何列都没被改", () => {
  const { db, repo } = setupRepo();
  repo.insertIfAbsent(inboxInput());
  const id = repo.listAll()[0]!.id;
  repo.archive(id);
  const archived = rawRow(db, id);
  assert.equal(typeof archived.archived_at, "number");

  const again = repo.insertIfAbsent(
    inboxInput({ title: "重投改标题", detail: { parentWorkItemId: "wi-p", phase: "x" } }),
  );
  assert.equal(again, false, "已归档 ⇒ 同一事实的重投不产生新行");
  assert.equal(rowCount(db), 1);
  assert.deepEqual(rawRow(db, id), archived, "重投不得改动归档行的任何列（不复活、不改写）");
});

// markRead 只改 read_at 一列：直接读裸行，另两列（archived_at 与其余列）逐字不动。
test("markRead：只改 read_at 一列；重复调用保留首次时间戳；未命中响亮抛", async () => {
  const { db, repo } = setupRepo();
  repo.insertIfAbsent(inboxInput());
  const id = repo.listAll()[0]!.id;
  const before = rawRow(db, id);

  repo.markRead(id);
  const after = rawRow(db, id);
  assert.deepEqual(withoutKey(after, "read_at"), withoutKey(before, "read_at"), "只准动 read_at");
  assert.equal(typeof after.read_at, "number");
  assert.equal(after.archived_at, null, "标已读不是归档（两件正交的事）");

  const firstAt = after.read_at;
  await delay(5);
  repo.markRead(id);
  assert.equal(rawRow(db, id).read_at, firstAt, "重复调用不得后移「第一次看到」的时间");
  assert.deepEqual(withoutKey(rawRow(db, id), "read_at"), withoutKey(before, "read_at"));
});

test("archive：只改 archived_at 一列；重复调用保留首次时间戳；未命中响亮抛", async () => {
  const { db, repo } = setupRepo();
  repo.insertIfAbsent(inboxInput());
  const id = repo.listAll()[0]!.id;
  const before = rawRow(db, id);

  repo.archive(id);
  const after = rawRow(db, id);
  assert.deepEqual(withoutKey(after, "archived_at"), withoutKey(before, "archived_at"));
  assert.equal(typeof after.archived_at, "number");
  assert.equal(after.read_at, null, "归档不是已读（不碰 read_at）");

  const firstAt = after.archived_at;
  await delay(5);
  repo.archive(id);
  assert.equal(rawRow(db, id).archived_at, firstAt, "重复调用不得后移首次归档时间");

  assert.throws(() => repo.markRead("不存在"), /没有 id=「不存在」的行/, "未命中不得静默 no-op");
  assert.throws(() => repo.archive("不存在"), /没有 id=「不存在」的行/);
});

// listAll：默认排除已归档；排序 created_at DESC、同刻按 id ASC（呈现次序不随存储顺序漂移）。
test("listAll：默认排除已归档；排序 created_at DESC, id ASC；includeArchived 才带上归档行", () => {
  const { db, repo } = setupRepo();
  repo.insertIfAbsent(inboxInput({ dedupKey: "k-a", title: "A" }));
  repo.insertIfAbsent(inboxInput({ dedupKey: "k-b", title: "B" }));
  repo.insertIfAbsent(inboxInput({ dedupKey: "k-c", title: "C" }));
  const [a, b, c] = repo.listAll().sort((x, y) => x.title.localeCompare(y.title));
  assert.ok(a && b && c);
  // 手改 created_at 摆出确定的次序（insertIfAbsent 取的是 Date.now()，同刻不可控）：
  // A=100、B=300、C=100 ⇒ 期望 B（300）在前，随后 A/C 同刻按 id 升序。
  db.prepare("UPDATE inbox_items SET created_at = 100 WHERE id = ?").run(a.id);
  db.prepare("UPDATE inbox_items SET created_at = 300 WHERE id = ?").run(b.id);
  db.prepare("UPDATE inbox_items SET created_at = 100 WHERE id = ?").run(c.id);
  const expectedTie = [a.id, c.id].sort();

  assert.deepEqual(
    repo.listAll().map((item) => item.id),
    [b.id, ...expectedTie],
  );

  repo.archive(a.id);
  assert.deepEqual(
    repo.listAll().map((item) => item.id),
    [b.id, ...expectedTie.filter((id) => id !== a.id)],
    "默认列表排除已归档",
  );
  assert.equal(repo.listAll({ includeArchived: true }).length, 3, "显式要求才带上归档行");
});

test("listByWorkspace：只取本 workspace（归档口径与 listAll 一致）", () => {
  const { repo } = setupRepo();
  repo.insertIfAbsent(inboxInput({ dedupKey: "k-1", title: "本 ws" }));
  repo.insertIfAbsent(inboxInput({ dedupKey: "k-2", title: "别的 ws", workspaceKey: "ws-2" }));
  assert.deepEqual(
    repo.listByWorkspace(WS).map((item) => item.title),
    ["本 ws"],
  );
  assert.deepEqual(
    repo.listByWorkspace("ws-2").map((item) => item.title),
    ["别的 ws"],
  );
});

// 枚举回读校验（照 readStatus 的既定做法）：手改库造出的枚举外值 ⇒ 抛，不静默按默认处理。
test("枚举非法值（手改库）读回抛；detail 坏 JSON 也抛（不静默 {}）", () => {
  const { db, repo } = setupRepo();
  repo.insertIfAbsent(inboxInput());
  const id = repo.listAll()[0]!.id;

  db.prepare("UPDATE inbox_items SET kind = 'bogus' WHERE id = ?").run(id);
  assert.throws(() => repo.get(id), /inbox_items\.kind 读回非法值「bogus」/);
  db.prepare("UPDATE inbox_items SET kind = 'merge_conflict', severity = 'bogus' WHERE id = ?").run(
    id,
  );
  assert.throws(() => repo.get(id), /inbox_items\.severity 读回非法值「bogus」/);

  db.prepare("UPDATE inbox_items SET severity = 'info', detail_json = '{oops' WHERE id = ?").run(
    id,
  );
  assert.throws(() => repo.get(id), /detail_json 不是合法 JSON/);
});

// ── 2. 构建件 ────────────────────────────────────────────────────────────────

test("computeInboxDedupKey：四个 kind 的形状逐条钉（同事实两次同键、不同 reason 不同键）", () => {
  assert.equal(
    computeInboxDedupKey({ kind: "merge_conflict", parentWorkItemId: "wi-p" }),
    "merge_conflict:wi-p",
  );
  assert.equal(computeInboxDedupKey({ kind: "member_failed", runId: "r-1" }), "member_failed:r-1");
  assert.equal(computeInboxDedupKey({ kind: "run_orphaned", runId: "r-1" }), "run_orphaned:r-1");
  const skipped = { kind: "dispatch_skipped", workItemId: "wi-1", reason: "指派给人" } as const;
  assert.equal(computeInboxDedupKey(skipped), "dispatch_skipped:wi-1:指派给人");

  // 同事实两次 ⇒ 同键（幂等的立足点）。
  assert.equal(
    computeInboxDedupKey({ kind: "dispatch_skipped", workItemId: "wi-1", reason: "指派给人" }),
    computeInboxDedupKey(skipped),
  );
  // 原因变了就是**新事实** ⇒ 键必须不同（否则「已归档」与「已停用」会被当成同一件事）。
  assert.notEqual(
    computeInboxDedupKey({ ...skipped, reason: "已归档" }),
    computeInboxDedupKey(skipped),
  );
});

test("INBOX_SEVERITY_BY_KIND：键集 = 四 kind、值 ∈ 三 severity（穷尽）", () => {
  assert.deepEqual(Object.keys(INBOX_SEVERITY_BY_KIND).sort(), [...INBOX_ITEM_KINDS].sort());
  for (const kind of INBOX_ITEM_KINDS) {
    assert.ok(
      (INBOX_ITEM_SEVERITIES as readonly string[]).includes(INBOX_SEVERITY_BY_KIND[kind]),
      `${kind} 的 severity 必须在枚举内`,
    );
  }
  // 用户裁定：冲突要人拍板（最急）、失败与孤儿要人看一眼、skip 只是通知 —— 三格各不相同才是真的分了急缓。
  assert.equal(INBOX_SEVERITY_BY_KIND.merge_conflict, "action_required");
  assert.equal(INBOX_SEVERITY_BY_KIND.member_failed, "attention");
  assert.equal(INBOX_SEVERITY_BY_KIND.run_orphaned, "attention");
  assert.equal(INBOX_SEVERITY_BY_KIND.dispatch_skipped, "info");
});

test("四个构建件：kind / dedupKey / title 回落 / detail 原始值", () => {
  const base = { workspaceKey: WS, workspacePath: "/tmp/ws" };

  const conflict = buildMergeConflictInboxItem({
    ...base,
    parentWorkItemId: "wi-p",
    parentTitle: "计划",
    conflict: {
      phase: "member_merge",
      runId: "r-b",
      agentId: "ta-b",
      memberBranch: "squad/member/x/y",
      integrationBranch: "squad/integration/x",
      detail: "CONFLICT (content)",
    },
  });
  assert.equal(conflict.kind, "merge_conflict");
  assert.equal(conflict.dedupKey, "merge_conflict:wi-p");
  assert.equal(conflict.title, "计划");
  assert.equal(conflict.workItemId, "wi-p");
  assert.equal(conflict.runId, "r-b");
  assert.deepEqual(conflict.detail, {
    parentWorkItemId: "wi-p",
    phase: "member_merge",
    runId: "r-b",
    agentId: "ta-b",
    memberBranch: "squad/member/x/y",
    integrationBranch: "squad/integration/x",
    targetBranch: null,
    conflictDetail: "CONFLICT (content)",
  });

  const finalizeConflict = buildMergeConflictInboxItem({
    ...base,
    parentWorkItemId: "wi-p",
    parentTitle: null,
    conflict: {
      phase: "batch_finalize",
      integrationBranch: "squad/integration/x",
      targetBranch: "main",
      detail: "CONFLICT (content)",
    },
  });
  assert.equal(
    finalizeConflict.title,
    "wi-p",
    "拿不到父项标题 ⇒ 回落 id（一条「父项 xx 冲突」远好过什么都没记）",
  );
  assert.equal(finalizeConflict.runId, undefined, "整批合回冲突没有单个 runId");
  assert.equal(finalizeConflict.detail.targetBranch, "main");
  assert.equal(finalizeConflict.detail.memberBranch, null, "不适用的一律 null（detail 形状固定）");

  const failed = buildMemberFailedInboxItem({
    ...base,
    workItemId: "wi-c",
    workItemTitle: null,
    runId: "r-1",
    agentId: "ta-1",
    branch: null,
    sessionId: "sess-1",
    reason: "队员会话终态=failed：boom",
  });
  assert.equal(failed.kind, "member_failed");
  assert.equal(failed.dedupKey, "member_failed:r-1");
  assert.equal(failed.title, "wi-c");
  assert.deepEqual(failed.detail, {
    workItemId: "wi-c",
    runId: "r-1",
    agentId: "ta-1",
    branch: null,
    sessionId: "sess-1",
    reason: "队员会话终态=failed：boom",
  });

  const orphaned = buildOrphanedRunInboxItem({
    ...base,
    workItemId: "wi-p",
    workItemTitle: "计划",
    runId: "r-lead",
    agentId: "ta-lead",
    sessionId: null,
    reason: "startup 和解：会话已不在执行",
  });
  assert.equal(orphaned.kind, "run_orphaned");
  assert.equal(orphaned.dedupKey, "run_orphaned:r-lead");
  assert.equal(orphaned.detail.sessionId, null);

  const skipped = buildDispatchSkippedInboxItem({
    ...base,
    workItemId: "wi-c",
    workItemTitle: "子任务",
    reason: "工作项指派给人：不排队起 run，进 Inbox 等人处理",
  });
  assert.equal(skipped.kind, "dispatch_skipped");
  assert.equal(
    skipped.dedupKey,
    "dispatch_skipped:wi-c:工作项指派给人：不排队起 run，进 Inbox 等人处理",
    "reason 用原文（去重键含它）",
  );
  assert.equal(skipped.detail.reason, "工作项指派给人：不排队起 run，进 Inbox 等人处理");
});

/* member_failed 的 `detail.sessionId`（本轮补：UI 的「打开会话」穿透靠它）两格：
   带（host 派发时 `task.taskId`）⇒ 原样写进 detail；不带（null）⇒ **也写 null**（形状固定 ——
   UI 按缺失降级不给钮，而不是看不见键）。键名与 `run_orphaned` 的既有 `sessionId` 一致。
   变异 M1：构建件不写 sessionId（去掉 `sessionId: input.sessionId`）⇒ 本用例两格都红。 */
test("member_failed 的 detail.sessionId：带/不带两格都写（形状固定，UI 按缺失降级）", () => {
  const base = { workspaceKey: WS, workspacePath: "/tmp/ws" };
  const withSession = buildMemberFailedInboxItem({
    ...base,
    workItemId: "wi-c",
    workItemTitle: "子任务",
    runId: "r-a",
    agentId: "ta-a",
    branch: "squad/member/x/y",
    sessionId: "sess-a",
    reason: "队员会话终态=failed：boom",
  });
  assert.equal(withSession.detail.sessionId, "sess-a", "会话 id 必须原样写进 detail");
  assert.deepEqual(
    Object.keys(withSession.detail).sort(),
    ["agentId", "branch", "reason", "runId", "sessionId", "workItemId"],
    "detail 形状固定（键集不随有没有会话漂移）",
  );

  const withoutSession = buildMemberFailedInboxItem({
    ...base,
    workItemId: "wi-c",
    workItemTitle: "子任务",
    runId: "r-b",
    agentId: "ta-b",
    branch: null,
    sessionId: null,
    reason: "队长会话终态=stopped",
  });
  assert.ok("sessionId" in withoutSession.detail, "拿不到会话也要有键（缺失 ≠ 键消失）");
  assert.equal(
    withoutSession.detail.sessionId,
    null,
    "拿不到会话 ⇒ null（UI 据此不给「打开会话」）",
  );
});

// ── 3. P1 端到端：真 git 冲突 ────────────────────────────────────────────────

async function setupRuntime(): Promise<{
  repoRoot: string;
  db: DatabaseSync;
  runtime: Awaited<ReturnType<typeof createSquadRuntime>>;
  orchestrator: ReturnType<typeof createSquadOrchestrator>;
}> {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: WS,
    readExperimentEnabled: () => true,
  });
  return { repoRoot, db, runtime, orchestrator: createSquadOrchestrator({ runtime }) };
}

type RuntimeFixture = Awaited<ReturnType<typeof setupRuntime>>;

/** 队员开树 + 在树里提交一个文件 + 上报完成（→ run produced、子项 in_review）。 */
async function produce(
  f: RuntimeFixture,
  input: { runId: string; childId: string; parentId: string; agentId: string; content: string },
): Promise<{ branch: string; worktreePath: string }> {
  const opened = await f.runtime.lifecycle.openMemberRun({
    runId: input.runId,
    workItemId: input.childId,
    parentWorkItemId: input.parentId,
    agentId: input.agentId,
    isLeaderTask: false,
  });
  writeFileSync(join(opened.worktreePath, "a.txt"), input.content);
  for (const args of [
    ["add", "-A"],
    ["commit", "-qm", `${input.agentId} work`],
  ]) {
    const result = await f.runtime.git(args, { cwd: opened.worktreePath });
    assert.equal(result.code, 0, `${args.join(" ")} 失败: ${result.stderr}`);
  }
  await f.runtime.lifecycle.completeMemberRun({ runId: input.runId });
  return opened;
}

// 冲突 ⇒ 恰一条 `merge_conflict` / `action_required`，带 workItemId 与分支信息（spec §5.7.4 / §16 S17）。
// 真 git 构造（两名队员改**同一文件的同一行**、串行合进同一集成分支）——冲突的判据是 git 自己给的。
test("P1 端到端：真冲突 ⇒ 恰一条 merge_conflict / action_required，带 workItemId 与分支信息", async () => {
  const f = await setupRuntime();
  const parent = f.runtime.workItemService.create({
    id: "wi-p",
    workspaceIdentity: WS,
    workspacePath: f.repoRoot,
    title: "计划",
    assignee: { type: "squad", id: "sq1" },
  });
  const childId = "wi-c";
  f.runtime.workItemService.create({
    id: childId,
    workspaceIdentity: WS,
    workspacePath: f.repoRoot,
    title: "子任务",
    parentId: parent.id,
    assignee: { type: "agent", id: "ta-a" },
  });
  f.runtime.workItemService.transition(childId, "in_progress", "todo");
  f.runtime.workItemService.transition(parent.id, "in_review", "todo");

  await produce(f, { runId: "r-a", childId, parentId: parent.id, agentId: "ta-a", content: "A\n" });
  await delay(2); // 让 createdAt 严格递增：串行次序可预期（先 a 后 b ⇒ b 冲突）
  await produce(f, { runId: "r-b", childId, parentId: parent.id, agentId: "ta-b", content: "B\n" });
  f.runtime.workItemService.transition(childId, "done", "in_review");

  await f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id });

  // 前置事实没变：父项确实被置 blocked（Inbox 是**附加**的可见归宿，不替代 blocked）。
  assert.equal(f.runtime.workItemRepo.get(parent.id)?.status, "blocked");

  const items = f.runtime.inboxItemRepo.listAll();
  assert.equal(items.length, 1, "一次冲突恰一条（逐队员与整批合回两条路径按父项收敛）");
  const [item] = items;
  assert.ok(item);
  assert.equal(item.kind, "merge_conflict");
  assert.equal(item.severity, "action_required");
  assert.equal(item.workItemId, parent.id);
  assert.equal(item.runId, "r-b");
  assert.equal(item.title, "计划", "title 是父项标题（面向人的主体）");
  assert.equal(item.workspaceKey, WS);
  assert.equal(item.workspacePath, f.repoRoot);
  assert.equal(item.readAt, null);
  assert.equal(item.archivedAt, null);
  assert.equal(item.detail.parentWorkItemId, parent.id);
  assert.equal(item.detail.phase, "member_merge");
  assert.equal(item.detail.runId, "r-b");
  assert.equal(item.detail.agentId, "ta-b");
  assert.equal(item.detail.memberBranch, f.runtime.squadRunRepo.get("r-b")?.branch);
  assert.equal(item.detail.integrationBranch, `squad/integration/${slugForId(childId)}`);
  assert.ok(
    typeof item.detail.conflictDetail === "string" && item.detail.conflictDetail.length > 0,
    "detail 要带 git 原文（供人归因）",
  );

  // 再投一次同事实（走 repo 直投模拟重投：重驱 / 重连都可能再报一次同一批的冲突）⇒ 仍一条。
  const replayed = f.runtime.inboxItemRepo.insertIfAbsent(
    buildMergeConflictInboxItem({
      workspaceKey: WS,
      workspacePath: f.repoRoot,
      parentWorkItemId: parent.id,
      parentTitle: "计划",
      conflict: {
        phase: "member_merge",
        runId: "r-b",
        agentId: "ta-b",
        memberBranch: f.runtime.squadRunRepo.get("r-b")!.branch!,
        integrationBranch: `squad/integration/${slugForId(childId)}`,
        detail: item.detail.conflictDetail as string,
      },
    }),
  );
  assert.equal(replayed, false);
  assert.equal(f.runtime.inboxItemRepo.listAll().length, 1, "同一批的冲突重投不得产生第二条");
});

// ── 4. 服务面 ────────────────────────────────────────────────────────────────

async function makeService(): Promise<{
  repoRoot: string;
  db: DatabaseSync;
  service: ISquadRuntimeService;
  seenTargets: string[];
  setExperimentEnabled: (value: boolean) => void;
}> {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const state = { enabled: true };
  /** 记录服务面收到的目标 —— 证明服务面把**调用方给的**目标原样交给 runtime（与名册用例同一手法）。 */
  const seenTargets: string[] = [];
  const createRuntime = async (t: SquadWorkspaceTarget) => {
    seenTargets.push(`${t.path}|${t.identity}`);
    return createSquadRuntime({
      db,
      workspacePath: repoRoot,
      workspaceIdentity: t.identity,
      readExperimentEnabled: () => state.enabled,
    });
  };
  const service = createSquadRuntimeService({
    createRuntime,
    readExperimentEnabled: async () => state.enabled,
    archiveSquadAndTransfer: async (t, id) => archiveSquadAndTransfer(await createRuntime(t), id),
    createOrchestrator: createSquadOrchestrator,
    // 跨 workspace 读取面的懒取 repo：与组合根同款（同一条 db）。
    getInboxItemRepo: () => createInboxItemRepo(db),
  });
  return {
    repoRoot,
    db,
    service,
    seenTargets,
    setExperimentEnabled: (value: boolean) => {
      state.enabled = value;
    },
  };
}

const skippedFact = (over: Partial<InboxItemInput> = {}): InboxItemInput => ({
  workspaceKey: "given",
  workspacePath: "/tmp/given-ws",
  kind: "dispatch_skipped",
  dedupKey: "dispatch_skipped:wi-1:指派给人",
  title: "网关改造",
  detail: { workItemId: "wi-1", reason: "指派给人" },
  workItemId: "wi-1",
  ...over,
});

test("recordInboxItem：目标显式（原样透传）、落库读回、不过门禁（开关关掉仍可登记）", async () => {
  const { db, service, seenTargets, setExperimentEnabled } = await makeService();
  const given: SquadWorkspaceTarget = { path: "/tmp/given-ws", identity: "given" };

  setExperimentEnabled(false); // 门禁关闭：登记通知不是新派发 ⇒ 仍必须可用（§5.7.6 只停新派发）。
  await service.recordInboxItem(given, skippedFact());

  assert.deepEqual(seenTargets, ["/tmp/given-ws|given"], "目标必须原样交给 runtime（无隐式默认）");
  const [_item] = createInboxItemRepo(db).listAll();
  assert.ok(_item);
  assert.equal(_item.workspaceKey, "given");
  assert.equal(_item.kind, "dispatch_skipped");
  assert.equal(_item.severity, "info");
});

test("listInboxItems：跨 workspace 一次读全（两个目标各投一条）", async () => {
  const { service } = await makeService();
  await service.recordInboxItem(
    { path: "/tmp/ws-a", identity: "ws-a" },
    skippedFact({ workspaceKey: "ws-a", workspacePath: "/tmp/ws-a" }),
  );
  await service.recordInboxItem(
    { path: "/tmp/ws-b", identity: "ws-b" },
    skippedFact({
      workspaceKey: "ws-b",
      workspacePath: "/tmp/ws-b",
      dedupKey: "dispatch_skipped:wi-2:已归档",
      workItemId: "wi-2",
    }),
  );

  const items = await service.listInboxItems();
  assert.equal(items.length, 2, "收件箱是跨项目面：一次调用读到全部 workspace 的条目");
  assert.deepEqual(items.map((item) => item.workspaceKey).sort(), ["ws-a", "ws-b"]);
});

test("markInboxItemRead / archiveInboxItem：只改对应列；归档后默认列表不再返回；未命中抛", async () => {
  const { service } = await makeService();
  const target: SquadWorkspaceTarget = { path: "/tmp/given-ws", identity: "given" };
  await service.recordInboxItem(target, skippedFact());

  const [item] = await service.listInboxItems();
  assert.ok(item);
  await service.markInboxItemRead(item.id);
  const [read] = await service.listInboxItems();
  assert.ok(read?.readAt !== null && read?.readAt !== undefined, "已读被写回");
  assert.equal(read.archivedAt, null, "标已读不是归档");

  await service.archiveInboxItem(item.id);
  assert.deepEqual(await service.listInboxItems(), [], "归档后默认不再出现");
  const withArchived = await service.listInboxItems({ includeArchived: true });
  assert.equal(withArchived.length, 1);
  assert.equal(withArchived[0]?.archivedAt !== null, true);

  await assert.rejects(() => service.markInboxItemRead("不存在"), /没有 id=「不存在」的行/);
  await assert.rejects(() => service.archiveInboxItem("不存在"), /没有 id=「不存在」的行/);
});
