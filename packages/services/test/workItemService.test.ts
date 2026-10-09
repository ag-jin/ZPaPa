import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";
import { createWorkItemService } from "../src/workitem/workItemService.js";

function setup() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const events: Array<{ kind: string }> = [];
  const service = createWorkItemService({
    repo: createWorkItemRepo(db),
    emit: (e) => events.push(e),
  });
  return { service, events };
}
const base = { workspaceIdentity: "ws", workspacePath: "/tmp/ws", body: "", assignee: { type: "user" as const, id: "u1" } };

test("成环被拒绝", () => {
  const { service } = setup();
  const a = service.create({ ...base, title: "a" });
  const b = service.create({ ...base, title: "b", parentId: a.id });
  assert.throws(() => service.create({ ...base, title: "x", parentId: b.id, id: a.id }), /环|cycle/i);
});

test("超过深度上限被拒绝", () => {
  const { service } = setup();
  let parentId: string | undefined;
  for (let i = 0; i < 5; i++) parentId = service.create({ ...base, title: `n${i}`, parentId }).id;
  assert.throws(() => service.create({ ...base, title: "too-deep", parentId }), /深度|depth/i);
});

test("超过子项上限被拒绝", () => {
  const { service } = setup();
  const p = service.create({ ...base, title: "p" });
  for (let i = 0; i < 50; i++) service.create({ ...base, title: `c${i}`, parentId: p.id });
  assert.throws(() => service.create({ ...base, title: "overflow", parentId: p.id }), /子项|children/i);
});

// 唯一写者：改状态必须经服务，且产生事件。
test("状态流转产生事件；CAS 失败不发事件", () => {
  const { service, events } = setup();
  const a = service.create({ ...base, title: "a" });
  assert.equal(service.transition(a.id, "in_progress", "todo"), true);
  assert.deepEqual(events.at(-1), { kind: "workitem.status_changed", id: a.id, from: "todo", to: "in_progress" });
  assert.equal(service.transition(a.id, "done", "todo"), false); // 前置已不是 todo
  assert.equal(events.filter((e) => e.kind === "workitem.status_changed").length, 1);
});

test("最后一个子项进入终态时发 child_completed", () => {
  const { service, events } = setup();
  const p = service.create({ ...base, title: "p" });
  const c = service.create({ ...base, title: "c", parentId: p.id });
  service.transition(c.id, "done", "todo");
  assert.ok(events.some((e) => e.kind === "workitem.child_completed"));
});

// 反向承重：还有一个 in_review 子项时绝不能发 child_completed，否则队长会被提前唤醒。
test("尚有非终态子项时不发 child_completed", () => {
  const { service, events } = setup();
  const p = service.create({ ...base, title: "p" });
  const c1 = service.create({ ...base, title: "c1", parentId: p.id });
  const c2 = service.create({ ...base, title: "c2", parentId: p.id });
  service.transition(c2.id, "in_review", "todo");
  service.transition(c1.id, "done", "todo");
  assert.equal(events.filter((e) => e.kind === "workitem.child_completed").length, 0);
});
