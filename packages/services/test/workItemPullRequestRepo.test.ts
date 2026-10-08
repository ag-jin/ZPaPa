import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import {
  createWorkItemPullRequestRepo,
  type LinkPullRequestInput,
  type PullRequestSnapshot,
} from "../src/workitem/workItemPullRequestRepo.js";

/* #8 D2 的**存储面**：`work_item_pull_requests`（迁移 0017）的唯一读写口。

   本文件只测存储面契约（夹具全部手写、期望值手写字面量）：
   ① 登记（multica 镜像列落库 + title 派生）、`(workspace, item, owner, name, number)` 的**幂等**；
   ② 快照写（`replaceSnapshot`）的 **head-SHA 防陈旧写**（M2 的 CAS 移植：库里 pin 变了 ⇒ 拒写）；
   ③ 读回闸（state 闭集）与 workspace 隔离；
   ④ unlink 是真删（PR 关联是**可变镜像**，不是 append-only 的事实账本 —— 与交付物表相反）。 */

const WS = "pr-ws";
const OTHER_WS = "pr-ws-other";
const ACTOR = { kind: "human", id: "u-1" } as const;

function setup() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return { db, repo: createWorkItemPullRequestRepo(db) };
}

function linkInput(over: Partial<LinkPullRequestInput> = {}): LinkPullRequestInput {
  return {
    id: "pr-1",
    workspaceKey: WS,
    workspacePath: "/tmp/pr-ws",
    workItemId: "wi-1",
    repoOwner: "acme",
    repoName: "widget",
    prNumber: 7,
    htmlUrl: "https://github.com/acme/widget/pull/7",
    linkedBy: ACTOR,
    createdAt: 100,
    ...over,
  };
}

function snapshot(over: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    state: "open",
    mergedAt: null,
    title: "Add widget",
    branch: "feat/widget",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    headSha: "head-aaa",
    fetchedAt: 200,
    ...over,
  };
}

test("0017 迁移：work_item_pull_requests 表与两索引建出来（只加新对象，不改既有表）", () => {
  const { db } = setup();
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_item_pull_requests'")
    .get() as { name: string } | undefined;
  assert.equal(table?.name, "work_item_pull_requests");
  const indexes = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_work_item_pull_requests%' ORDER BY name",
    )
    .all() as unknown as Array<{ name: string }>;
  assert.deepEqual(
    indexes.map((row) => row.name),
    ["idx_work_item_pull_requests_item", "idx_work_item_pull_requests_pr"],
  );
  // 未拉取过的行：快照列全 NULL、pin 为空串（「没有快照」与「快照说 sha 是空」是两件事）。
  const columns = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='work_item_pull_requests'")
    .get() as { sql: string };
  assert.match(columns.sql, /snapshot_head_sha\s+TEXT NOT NULL DEFAULT ''/);
});

test("登记｜镜像列落库 + title 派生；同 (workspace,item,owner,name,number) 重投幂等返既存行", () => {
  const { db, repo } = setup();
  const record = repo.link(linkInput());
  assert.equal(record.id, "pr-1");
  assert.equal(record.repoOwner, "acme");
  assert.equal(record.repoName, "widget");
  assert.equal(record.prNumber, 7);
  assert.equal(record.htmlUrl, "https://github.com/acme/widget/pull/7");
  // 未给标题 ⇒ 派生 `owner/name#number`（呈现可读；不猜远端标题——那是快照的活）。
  assert.equal(record.title, "acme/widget#7");
  assert.equal(record.state, null, "从未拉取：state 恒 NULL（不伪造 open）");
  assert.equal(record.mergedAt, null);
  assert.equal(record.snapshotHeadSha, "");
  assert.equal(record.snapshotFetchedAt, null);
  assert.equal(record.branch, null);
  assert.deepEqual(record.linkedBy, ACTOR);
  assert.equal(record.createdAt, 100);
  assert.equal(record.updatedAt, 100);

  // 显式标题照用（trim）。
  assert.equal(
    repo.link(linkInput({ id: "pr-2", prNumber: 8, title: "  PR 八  " })).title,
    "PR 八",
  );

  // 幂等：同一 PR 重投（哪怕不同 id/标题）⇒ 返回既存行，不产生第二行（唯一索引是兜底）。
  const retry = repo.link(linkInput({ id: "pr-retry", title: "重投的新标题", createdAt: 999 }));
  assert.equal(retry.id, "pr-1");
  assert.equal(retry.title, "acme/widget#7", "既存行的列不被改写");
  assert.equal(retry.createdAt, 100);
  const count = db.prepare("SELECT COUNT(*) AS n FROM work_item_pull_requests").get() as {
    n: number;
  };
  assert.equal(count.n, 2, "只有两条：pr-1 与 pr-2（重投不新增）");
});

test("登记｜形态闸：非正整数号 / 空 owner/name/url 一律响亮拒（不落坏行）", () => {
  const { db, repo } = setup();
  assert.throws(() => repo.link(linkInput({ prNumber: 0 })), /pr_number/);
  assert.throws(() => repo.link(linkInput({ prNumber: -3 })), /pr_number/);
  assert.throws(() => repo.link(linkInput({ prNumber: 1.5 })), /pr_number/);
  assert.throws(() => repo.link(linkInput({ repoOwner: "  " })), /repo_owner/);
  assert.throws(() => repo.link(linkInput({ repoName: "" })), /repo_name/);
  assert.throws(() => repo.link(linkInput({ htmlUrl: " " })), /html_url/);
  const count = db.prepare("SELECT COUNT(*) AS n FROM work_item_pull_requests").get() as {
    n: number;
  };
  assert.equal(count.n, 0, "拒绝发生在写库之前");
});

test("快照写｜head-SHA 防陈旧写（M2 的 CAS）：pin 未变则写、pin 已变则整条拒写并返回 false", () => {
  const { repo } = setup();
  const linked = repo.link(linkInput());

  // ① 首拉：expectHeadSha = ''（拉取前读到的 pin）。
  assert.equal(
    repo.replaceSnapshot({
      id: linked.id,
      expectHeadSha: "",
      snapshot: snapshot({ fetchedAt: 200 }),
    }),
    true,
  );
  const afterFirst = repo.get(linked.id)!;
  assert.equal(afterFirst.state, "open");
  assert.equal(afterFirst.snapshotHeadSha, "head-aaa");
  assert.equal(afterFirst.snapshotFetchedAt, 200);
  assert.equal(afterFirst.apiMergeable, "MERGEABLE");
  assert.equal(afterFirst.apiMergeStateStatus, "CLEAN");
  assert.equal(afterFirst.title, "Add widget", "镜像列随快照更新（API 是远端事实的唯一源）");
  assert.equal(afterFirst.branch, "feat/widget");
  assert.equal(afterFirst.updatedAt, 200);

  // ② 第二次拉取（head 前进）：拉取前读到 pin=head-aaa ⇒ 写入成功、pin 推进。
  assert.equal(
    repo.replaceSnapshot({
      id: linked.id,
      expectHeadSha: "head-aaa",
      snapshot: snapshot({
        headSha: "head-bbb",
        state: "merged",
        mergedAt: 1_700_000_000_000,
        fetchedAt: 300,
      }),
    }),
    true,
  );
  assert.equal(repo.get(linked.id)!.state, "merged");

  // ③ **陈旧响应**（慢响应后到）：它基于的 pin 已被推进 ⇒ 整条拒写（快照一列都不许动）。
  assert.equal(
    repo.replaceSnapshot({
      id: linked.id,
      expectHeadSha: "head-aaa",
      snapshot: snapshot({ headSha: "head-aaa", state: "open", fetchedAt: 250 }),
    }),
    false,
    "pin 已变 ⇒ 本次响应被丢弃（不得把已经 merged 的快照退回 open）",
  );
  const afterStale = repo.get(linked.id)!;
  assert.equal(afterStale.state, "merged");
  assert.equal(afterStale.snapshotHeadSha, "head-bbb");
  assert.equal(afterStale.snapshotFetchedAt, 300, "陈旧写连 fetched_at 都不许动");
  assert.equal(afterStale.mergedAt, 1_700_000_000_000);
});

test("快照写｜id 不存在 ⇒ 返回 false（不抛不改别的行）；state 非法值拒写", () => {
  const { repo } = setup();
  const a = repo.link(linkInput({ id: "pr-a", prNumber: 1 }));
  const b = repo.link(linkInput({ id: "pr-b", prNumber: 2 }));
  assert.equal(
    repo.replaceSnapshot({
      id: "pr-missing",
      expectHeadSha: "",
      snapshot: snapshot(),
    }),
    false,
  );
  assert.equal(repo.get(b.id)!.state, null, "别的行不受影响");

  // state 是闭集（代码闸，不在 DDL 里 CHECK）：非法值在写库前响亮拒，四个合法值照写。
  assert.throws(
    () =>
      repo.replaceSnapshot({
        id: a.id,
        expectHeadSha: "",
        // 绕过 TS 的闭集（数据驱动路径）：运行期必须挡住。
        snapshot: snapshot({ state: "weird" as never }),
      }),
    /state/,
  );
  assert.equal(repo.get(a.id)!.state, null, "拒写后仍是「从未拉取」");
  // 四值闭集全可写（draft 也是合法状态：multica M1 的镜像列口径）。
  assert.equal(
    repo.replaceSnapshot({ id: a.id, expectHeadSha: "", snapshot: snapshot({ state: "draft" }) }),
    true,
  );
  for (const state of ["open", "closed", "merged"] as const) {
    assert.equal(
      repo.replaceSnapshot({ id: a.id, expectHeadSha: "head-aaa", snapshot: snapshot({ state }) }),
      true,
      `${state} 是闭集内的合法值`,
    );
  }
});

test("读回闸｜库里被写坏的 state 读回响亮抛（不静默当 unknown）", () => {
  const { db, repo } = setup();
  const linked = repo.link(linkInput());
  db.prepare("UPDATE work_item_pull_requests SET state = 'weird' WHERE id = ?").run(linked.id);
  assert.throws(() => repo.get(linked.id), /state/);
  assert.throws(() => repo.listByWorkItem(WS, "wi-1"), /state/);
});

test("列表｜workspace 隔离 + created_at,id 主序；unlink 真删（返回是否删到）", () => {
  const { db, repo } = setup();
  repo.link(linkInput({ id: "pr-b", prNumber: 2, createdAt: 200 }));
  repo.link(linkInput({ id: "pr-a", prNumber: 1, createdAt: 100 }));
  // 同 workItemId、另一个 workspace：不得串台。
  repo.link(linkInput({ id: "pr-other", prNumber: 9, workspaceKey: OTHER_WS }));
  assert.deepEqual(
    repo.listByWorkItem(WS, "wi-1").map((row) => row.id),
    ["pr-a", "pr-b"],
  );
  assert.deepEqual(
    repo.listByWorkItem(OTHER_WS, "wi-1").map((row) => row.id),
    ["pr-other"],
  );
  assert.deepEqual(repo.listByWorkItem(WS, "wi-none"), []);

  assert.equal(repo.unlink("pr-a"), true);
  assert.equal(repo.unlink("pr-a"), false, "已经删掉的行再删 ⇒ false（不是错误）");
  assert.equal(repo.get("pr-a"), null);
  assert.deepEqual(
    repo.listByWorkItem(WS, "wi-1").map((row) => row.id),
    ["pr-b"],
  );
  const count = db.prepare("SELECT COUNT(*) AS n FROM work_item_pull_requests").get() as {
    n: number;
  };
  assert.equal(count.n, 2, "别的 workspace 那行不受影响");
});
