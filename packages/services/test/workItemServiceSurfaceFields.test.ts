import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";
import { createWorkItemService } from "../src/workitem/workItemService.js";

/* 工作项**创建路径**（`workItemService.create`，唯一创建入口）在 0018 之后的新字段面。

   本层是**门禁层**：闭集（优先级）与日历日期（起始/截止）在这里过闸并**响亮抛**，抛发生在
   落盘之前（先写后校验会留下一条「值被悄悄改过」的行）。判据全部来自 shared 的纯函数
   （`resolveWorkItemPriority` / `resolveWorkItemDateOnly`），本层不复制一份规则。

   `identifier_seq` 由存储面语句内生成（`repo.insert` 的返回值）：调用方**结构上无法传号**
   —— `CreateWorkItemInput` 里没有这个字段；返回的实体带的是库里真实生成的号。 */

function setup() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const events: Array<{ kind: string }> = [];
  const repo = createWorkItemRepo(db);
  const service = createWorkItemService({ repo, emit: (event) => events.push(event) });
  const count = () => (db.prepare("SELECT COUNT(*) AS n FROM work_items").get() as { n: number }).n;
  const raw = (id: string) =>
    db
      .prepare(
        "SELECT priority, start_date, due_date, creator_kind, creator_id, creator_display_name, identifier_seq FROM work_items WHERE id = ?",
      )
      .get(id) as Record<string, unknown> | undefined;
  return { db, repo, service, events, count, raw };
}

const base = {
  workspaceIdentity: "ws",
  workspacePath: "/tmp/ws",
  body: "",
  assignee: { type: "user" as const, id: "u1" },
};

test("创建带新字段：优先级 / 起始 / 截止 / 创建人逐字落库并读回实体", () => {
  const { service, raw } = setup();
  const item = service.create({
    ...base,
    title: "带字段",
    priority: "high",
    startDate: "2026-10-08",
    dueDate: "2026-12-31",
    creator: { kind: "human", id: "local-user", displayName: "本机用户" },
  });
  assert.equal(item.priority, "high");
  assert.equal(item.startDate, "2026-10-08");
  assert.equal(item.dueDate, "2026-12-31");
  assert.deepEqual(item.creator, { kind: "human", id: "local-user", displayName: "本机用户" });
  assert.deepEqual(
    { ...raw(item.id) },
    {
      priority: "high",
      start_date: "2026-10-08",
      due_date: "2026-12-31",
      creator_kind: "human",
      creator_id: "local-user",
      creator_display_name: "本机用户",
      identifier_seq: 1,
    },
  );
});

test("创建不带新字段：全部未设置（NULL 保真，不编默认档位/不拿 assignee 冒充创建人）", () => {
  const { service, raw } = setup();
  const item = service.create({ ...base, title: "裸的" });
  assert.equal(item.priority, undefined);
  assert.equal(item.startDate, undefined);
  assert.equal(item.dueDate, undefined);
  assert.equal(item.creator, undefined);
  assert.deepEqual(
    { ...raw(item.id) },
    {
      priority: null,
      start_date: null,
      due_date: null,
      creator_kind: null,
      creator_id: null,
      creator_display_name: null,
      identifier_seq: 1,
    },
  );
});

test("创建闭集外优先级 ⇒ 响亮抛且不落盘（抛在写之前）", () => {
  const { service, count, raw } = setup();
  const before = count();
  assert.throws(
    () => service.create({ ...base, title: "坏优先级", priority: "none" as never }),
    /优先级/,
  );
  assert.equal(count(), before, "非 ok 的优先级不得留下半条行");
  assert.equal(raw("坏优先级"), undefined);
});

test("创建坏日期（起始 / 截止各自）⇒ 响亮抛且不落盘", () => {
  const { service, count } = setup();
  const before = count();
  assert.throws(
    () => service.create({ ...base, title: "坏起始", startDate: "2026-02-29" }),
    /日期/,
  );
  assert.throws(
    () => service.create({ ...base, title: "坏截止", dueDate: "2026-10-08T00:00:00Z" }),
    /日期/,
  );
  assert.throws(() => service.create({ ...base, title: "坏形状", dueDate: "2026/10/08" }), /日期/);
  assert.equal(count(), before, "坏日期不得留下半条行");
});

test("创建返回的 identifierSeq 是库里语句内生成的真实号（连续两条 1、2）", () => {
  const { service, raw } = setup();
  const first = service.create({ ...base, title: "一号" });
  const second = service.create({ ...base, title: "二号" });
  assert.equal(first.identifierSeq, 1);
  assert.equal(second.identifierSeq, 2);
  assert.equal(raw(first.id)?.identifier_seq, 1);
  assert.equal(raw(second.id)?.identifier_seq, 2);
});

// 显式 `null`（RPC 调用方把「清空」传成 null）与不给等价：未设置只有 NULL 一种形态，
// 落库与读取面逐字一致 —— 不存在第二个「空值」形状。
test("创建时显式 null 与不给等价：三列都落 NULL，读取面都是未设置", () => {
  const { service, raw } = setup();
  const item = service.create({
    ...base,
    title: "显式 null",
    priority: null,
    startDate: null,
    dueDate: null,
    creator: null,
  });
  assert.equal(item.priority, undefined);
  assert.equal(item.startDate, undefined);
  assert.equal(item.dueDate, undefined);
  assert.equal(item.creator, undefined);
  assert.deepEqual(
    { ...raw(item.id) },
    {
      priority: null,
      start_date: null,
      due_date: null,
      creator_kind: null,
      creator_id: null,
      creator_display_name: null,
      identifier_seq: 1,
    },
  );
});
