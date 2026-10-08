import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createCommentDispatchReceiptRepo } from "../src/workitem/commentDispatchReceiptRepo.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import { createWorkItemCollaborationService } from "../src/workitem/workItemCollaborationService.js";
import { createWorkItemCommentReactionRepo } from "../src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemCommentRepo } from "../src/workitem/workItemCommentRepo.js";
import { createWorkItemDecisionRepo } from "../src/workitem/workItemDecisionRepo.js";
import { resolveDeliverableContentRoot } from "../src/workitem/workItemDeliverableRepo.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* #7 交付物 **D1b 服务面**（`IWorkItemCollaborationService` 的两个新面 + 读模型新字段）。
   缝合线 = 门面 + **真 runtime**（真 repo、真 git 仓库、真 .zcode 目录）：
   读回的正文三态、登记落盘、时间线回声都在真实存储上核对，期望值是手写字面量。 */

const WS = "d1b-facade-ws";
/** 组合根注入的本地人类身份（审计真源，测试里的独立字面量）。 */
const LOCAL_HUMAN = { kind: "human" as const, id: "local-user" };

async function setup() {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: WS,
    readExperimentEnabled: () => true,
  });
  const activities = createWorkItemActivityRepo(db);
  const service = createWorkItemCollaborationService({
    createRuntime: async () => runtime,
    getRepos: () => ({
      comments: createWorkItemCommentRepo(db),
      activities,
      decisions: createWorkItemDecisionRepo(db),
      reactions: createWorkItemCommentReactionRepo(db),
      receipts: createCommentDispatchReceiptRepo(db),
    }),
    localHumanActor: () => LOCAL_HUMAN,
  });
  const insertItem = (id: string): void => {
    runtime.workItemRepo.insert({
      id,
      workspaceIdentity: WS,
      workspacePath: repoRoot,
      title: `D1b ${id}`,
      body: "",
      status: "todo",
      assignee: { type: "user", id: "user" },
      labels: [],
      properties: {},
      position: 0,
    });
  };
  return {
    repoRoot,
    runtime,
    activities,
    service,
    insertItem,
    target: { path: repoRoot, identity: WS },
    timeline: (workItemId: string) => activities.listByWorkItem(WS, workItemId),
    runtimeStub: runtime as SquadRuntime,
  };
}

test("服务面-①｜手动登记 link：行 + 时间线回声（actor=操作者、payload 无 runId）；同 URL 两次各一条", async () => {
  const f = await setup();
  f.insertItem("wi-1");

  const first = await f.service.registerWorkItemDeliverableLink(f.target, {
    workItemId: "wi-1",
    title: "PR #12",
    url: "https://example.test/pr/12",
    note: "首轮审查",
  });
  const second = await f.service.registerWorkItemDeliverableLink(f.target, {
    workItemId: "wi-1",
    title: "PR #12（重贴）",
    url: "https://example.test/pr/12",
  });

  // 行：kind 恒 link、不挂 run、actor = 注入的操作者、content_ref = URL、sha/大小恒 NULL（不伪造）。
  assert.equal(first.kind, "link");
  assert.equal(first.runId, null);
  assert.deepEqual(first.actor, LOCAL_HUMAN);
  assert.equal(first.contentRef, "https://example.test/pr/12");
  assert.equal(first.contentSha, null);
  assert.equal(first.contentSize, null);
  assert.deepEqual(first.meta, { note: "首轮审查" });
  // 手动登记**不做幂等**（设计 §3.2）：同 URL 两次是两条独立事实。
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.dedupKey, second.dedupKey);
  assert.equal(f.runtime.deliverableRepo.listByWorkItem(WS, "wi-1").length, 2);
  assert.ok(first.id.startsWith("deliverable-link-"), `id 形态：${first.id}`);

  // 回声：键由交付物 id 派生；actor = 操作者（与自动捕获的 system 可分辨）；payload 无 runId。
  const echoes = f.timeline("wi-1").filter((entry) => entry.kind === "deliverable_registered");
  assert.equal(echoes.length, 2);
  assert.deepEqual(
    { dedupKey: echoes[0]!.dedupKey, payload: echoes[0]!.payload, actor: echoes[0]!.actor },
    {
      dedupKey: `deliverable:${first.id}:registered`,
      payload: { kind: "link", title: "PR #12", deliverableId: first.id },
      actor: LOCAL_HUMAN,
    },
  );
  assert.deepEqual(echoes[0]!.sourceRun, null, "手动登记不伪造 run 归属");
});

test("服务面-②｜link-only 闸：越界传入 diff 意图 ⇒ 仍只落 link 行、盘上不产生 diff 正文", async () => {
  const f = await setup();
  f.insertItem("wi-2");

  // JS 侧越界输入（类型擦除后可达）：kind/content 都是 diff 形态。
  const registered = await f.service.registerWorkItemDeliverableLink(f.target, {
    workItemId: "wi-2",
    title: "伪装的 diff",
    url: "https://example.test/actually-a-link",
    kind: "diff",
    content: "diff --git a/x b/x\n+1\n",
  } as unknown as Parameters<typeof f.service.registerWorkItemDeliverableLink>[1]);

  assert.equal(registered.kind, "link", "服务面只开 link：diff 型只由自动捕获产生");
  const root = resolveDeliverableContentRoot(f.repoRoot);
  assert.equal(
    existsSync(join(root, `${registered.id}.diff`)),
    false,
    "不得为手动登记落任何 diff 正文",
  );
});

test("服务面-③｜读模型：deliverables 随协作读返回（本工作项隔离、排序原样来自 repo）", async () => {
  const f = await setup();
  f.insertItem("wi-3");
  f.insertItem("wi-4");
  await f.service.registerWorkItemDeliverableLink(f.target, {
    workItemId: "wi-3",
    title: "文档",
    url: "https://example.test/doc",
  });
  await f.service.registerWorkItemDeliverableLink(f.target, {
    workItemId: "wi-4",
    title: "别的工作项",
    url: "https://example.test/other",
  });
  await f.service.registerWorkItemDeliverableLink(f.target, {
    workItemId: "wi-3",
    title: "预览",
    url: "https://example.test/preview",
  });

  const read = await f.service.getWorkItemCollaboration(f.target, "wi-3");
  assert.ok(read);
  /* 「门面零重排」的判据：返回数组与 repo 口径**逐字一致**（同一调用同一序）。
     不写死两行之间的先后：两条手动登记可能落在同一毫秒，repo 的同刻 tie-break 是 id ASC，
     而 id 带随机段 —— 写死它反而是在断言一个与「不重排」无关的偶然。 */
  assert.deepEqual(
    read.deliverables,
    f.runtime.deliverableRepo.listByWorkItem(WS, "wi-3"),
    "deliverables 原样来自 repo（门面不 sort / 不 filter）",
  );
  assert.deepEqual(
    read.deliverables.map((record) => record.title).sort(),
    ["文档", "预览"],
    "只带本工作项的交付物（另一条挂在 wi-4 上）",
  );
  assert.ok(read.deliverables.every((record) => record.workItemId === "wi-3"));
});

test("服务面-④｜单条正文三态：diff 可读 / 文件被删 ⇒ 缺失（不谎报）/ link ⇒ 外部；不存在 ⇒ null", async () => {
  const f = await setup();
  f.insertItem("wi-5");
  const root = resolveDeliverableContentRoot(f.repoRoot);
  // 自动捕获形态的 diff 行（正文经存储面落盘）——夹具直接种事实，读回走服务面。
  const diff = f.runtime.deliverableRepo.register({
    id: "deliverable-run-9-diff",
    workspaceKey: WS,
    workspacePath: f.repoRoot,
    workItemId: "wi-5",
    runId: "run-9",
    kind: "diff",
    title: "队员 run 产出 diff（squad/member/wi-5/a）",
    meta: { branch: "squad/member/wi-5/a", base: "main" },
    content: "diff --git a/x b/x\n+1\n",
    actor: { kind: "system", id: "squad-runtime" },
    dedupKey: "deliverable:run-9:diff",
    createdAt: 5,
  });
  const link = await f.service.registerWorkItemDeliverableLink(f.target, {
    workItemId: "wi-5",
    title: "PR",
    url: "https://example.test/pr/1",
  });

  const readable = await f.service.getWorkItemDeliverable(f.target, diff.id);
  assert.deepEqual(readable, {
    record: { ...readable!.record },
    content: { presence: "file", text: "diff --git a/x b/x\n+1\n" },
  });
  assert.equal(readable!.record.kind, "diff");

  // 用户把 .zcode 删了：元数据在库 ⇒ 呈现「正文缺失」，不重建、不抛。
  rmSync(join(root, "deliverable-run-9-diff.diff"));
  assert.deepEqual(await f.service.getWorkItemDeliverable(f.target, diff.id), {
    record: { ...readable!.record, contentSha: readable!.record.contentSha },
    content: { presence: "missing" },
  });

  assert.deepEqual((await f.service.getWorkItemDeliverable(f.target, link.id))!.content, {
    presence: "external",
    url: "https://example.test/pr/1",
  });

  assert.equal(await f.service.getWorkItemDeliverable(f.target, "deliverable-nope"), null);
});

test("服务面-⑤｜响亮拒绝：工作项不存在 / 标题空白 / 跨 workspace 的交付物 id", async () => {
  const f = await setup();
  f.insertItem("wi-6");
  await assert.rejects(
    f.service.registerWorkItemDeliverableLink(f.target, {
      workItemId: "wi-missing",
      title: "孤儿链接",
      url: "https://example.test/x",
    }),
    /工作项/,
    "工作项不存在 ⇒ 抛（静默建行会把链接挂到一个不存在的对象上）",
  );
  await assert.rejects(
    f.service.registerWorkItemDeliverableLink(f.target, {
      workItemId: "wi-6",
      title: "   ",
      url: "https://example.test/x",
    }),
    /标题/,
  );
  await assert.rejects(
    f.service.registerWorkItemDeliverableLink(f.target, {
      workItemId: "wi-6",
      title: "空链接",
      url: "   ",
    }),
    /url/i,
    "URL 空白 ⇒ 抛（存储面同一道闸）",
  );

  /* 跨 workspace：别人的行必须**响亮抛**，不得当「本 workspace 没有这条」的 null
     （同 getWorkItemCollaboration 的 §8.5 纪律）。 */
  const foreign = f.runtime.deliverableRepo.register({
    id: "deliverable-other-ws",
    workspaceKey: "other-ws",
    workspacePath: "/tmp/other",
    workItemId: "wi-other",
    kind: "link",
    title: "别人的",
    url: "https://example.test/other",
    actor: LOCAL_HUMAN,
    dedupKey: "deliverable:deliverable-other-ws:link",
    createdAt: 1,
  });
  assert.equal(foreign.workspaceKey, "other-ws");
  await assert.rejects(
    f.service.getWorkItemDeliverable(f.target, "deliverable-other-ws"),
    /workspace/,
  );
});
