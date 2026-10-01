import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { WORK_ITEM_MAX_CHILDREN } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";
import type { WorkItem } from "@zcode/shared";

function setup() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return { db, repo: createWorkItemRepo(db) };
}
function wi(over: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    workspaceIdentity: "ws",
    workspacePath: "/tmp/ws",
    title: over.id,
    body: "",
    status: "todo",
    assignee: { type: "user", id: "u1" },
    labels: [],
    properties: {},
    position: 0,
    ...over,
  } as WorkItem;
}

test("插入后可按 id 读回", () => {
  const { repo } = setup();
  repo.insert(wi({ id: "a" }));
  assert.equal(repo.get("a")?.id, "a");
});

// 聚合必须用 category：父项只有一个 cancelled 子项时也应算「全终态」。
test("子项聚合：done 与 cancelled 都算终态", () => {
  const { repo } = setup();
  repo.insert(wi({ id: "p" }));
  repo.insert(wi({ id: "c1", parentId: "p", status: "done" }));
  repo.insert(wi({ id: "c2", parentId: "p", status: "cancelled" }));
  assert.equal(repo.areAllChildrenTerminal("p"), true);
});

test("子项聚合：有 in_review 时不算全终态", () => {
  const { repo } = setup();
  repo.insert(wi({ id: "p" }));
  repo.insert(wi({ id: "c1", parentId: "p", status: "done" }));
  repo.insert(wi({ id: "c2", parentId: "p", status: "in_review" }));
  assert.equal(repo.areAllChildrenTerminal("p"), false);
});

test("无子项不算全终态（避免空父项被当成已完成）", () => {
  const { repo } = setup();
  repo.insert(wi({ id: "p" }));
  assert.equal(repo.areAllChildrenTerminal("p"), false);
});

// CAS：前置状态不匹配时不得写入，否则并发派发会互相覆盖。
test("updateStatus 的前置状态不匹配则拒绝", () => {
  const { repo } = setup();
  repo.insert(wi({ id: "a", status: "todo" }));
  assert.equal(repo.updateStatus("a", "in_progress", "blocked"), false);
  assert.equal(repo.get("a")?.status, "todo");
});

// 与「不匹配则拒绝」互为反向：命中前置状态时必须真的写入，否则 CAS 会变成只读。
test("updateStatus 的前置状态匹配则写入并返回 true", () => {
  const { repo } = setup();
  repo.insert(wi({ id: "a", status: "todo" }));
  assert.equal(repo.updateStatus("a", "in_progress", "todo"), true);
  assert.equal(repo.get("a")?.status, "in_progress");
});

// 不存在的行也必须返回 false：调用方据此区分「没命中」与「写成功」，而不是当成缺省失败。
test("updateStatus 对不存在的 id 返回 false", () => {
  const { repo } = setup();
  assert.equal(repo.updateStatus("ghost", "in_progress", "todo"), false);
});

// 回归顺序：子项列表按 position 排序。position 列存在的意义就是兄弟排序，
// 若退化成 rowid 顺序，上层树渲染会随插入顺序漂移。
test("listChildren 按 position 排序", () => {
  const { repo } = setup();
  repo.insert(wi({ id: "p" }));
  repo.insert(wi({ id: "late", parentId: "p", position: 20 }));
  repo.insert(wi({ id: "early", parentId: "p", position: 10 }));
  assert.deepEqual(
    repo.listChildren("p").map((item) => item.id),
    ["early", "late"],
  );
});

// 只在内存判定还不够：达到子项上限时也必须逐行按 category 判定，不能因为行数多就退化。
test("聚合在子项达到上限时仍按 category 判定", () => {
  const { repo } = setup();
  repo.insert(wi({ id: "p" }));
  for (let i = 0; i < WORK_ITEM_MAX_CHILDREN; i++) {
    repo.insert(wi({ id: `c${i}`, parentId: "p", status: i === 0 ? "cancelled" : "done" }));
  }
  assert.equal(repo.areAllChildrenTerminal("p"), true);
  repo.insert(wi({ id: "blocked", parentId: "p", status: "blocked" }));
  assert.equal(repo.areAllChildrenTerminal("p"), false);
});
