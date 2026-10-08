import assert from "node:assert/strict";
import test from "node:test";
import {
  WORK_ITEM_MAX_CHILDREN,
  WORK_ITEM_MAX_DEPTH,
  WORK_ITEM_STATUS_CATEGORY,
  isTerminalWorkItemStatus,
  workItemSchema,
} from "../src/work-item.js";

// category 是机器判定的唯一依据；键名只是标签。
test("六个状态键各自的 category", () => {
  assert.deepEqual(WORK_ITEM_STATUS_CATEGORY, {
    todo: "unstarted",
    in_progress: "started",
    in_review: "started",
    blocked: "started",
    done: "done",
    cancelled: "closed",
  });
});

// in_review 是 started 而不是终态：把它当终态会让「等子任务全完成」提前触发。
test("终态判定：done 与 cancelled 为真，in_review 为假", () => {
  assert.equal(isTerminalWorkItemStatus("done"), true);
  assert.equal(isTerminalWorkItemStatus("cancelled"), true);
  assert.equal(isTerminalWorkItemStatus("in_review"), false);
  assert.equal(isTerminalWorkItemStatus("blocked"), false);
});

test("schema 拒绝未知状态", () => {
  const parsed = workItemSchema.safeParse({
    id: "wi_1",
    workspaceIdentity: "ws",
    workspacePath: "/tmp/ws",
    title: "t",
    body: "",
    status: "archived", // 不存在
    assignee: { type: "user", id: "u1" },
  });
  assert.equal(parsed.success, false);
});

test("限额是 5 与 50", () => {
  assert.equal(WORK_ITEM_MAX_DEPTH, 5);
  assert.equal(WORK_ITEM_MAX_CHILDREN, 50);
});

/* Surface 对齐（0018）的 5 个新字段：priority / startDate / dueDate / creator / identifierSeq。
   存量行与「没给这一项」的新行都必须能解析，且**逐字段 undefined**（NULL 语义保真）——
   给缺省值（如 priority="medium"）等于替用户编一个没人做过的决定。 */
test("schema：Surface 新字段全部可选，缺省 = 未设置（逐字段 undefined，不编默认值）", () => {
  const parsed = workItemSchema.parse({
    id: "wi_1",
    workspaceIdentity: "ws",
    workspacePath: "/tmp/ws",
    title: "t",
    body: "",
    status: "todo",
    assignee: { type: "user", id: "u1" },
  });
  assert.equal(parsed.priority, undefined);
  assert.equal(parsed.startDate, undefined);
  assert.equal(parsed.dueDate, undefined);
  assert.equal(parsed.creator, undefined);
  assert.equal(parsed.identifierSeq, undefined);
});

test("schema：Surface 新字段齐全时原样读回（日期不做换算、创建人带显示名）", () => {
  const parsed = workItemSchema.parse({
    id: "wi_1",
    workspaceIdentity: "ws",
    workspacePath: "/tmp/ws",
    title: "t",
    body: "",
    status: "todo",
    assignee: { type: "user", id: "u1" },
    priority: "urgent",
    startDate: "2026-10-08",
    dueDate: "2026-12-31",
    creator: { kind: "human", id: "local-user" },
    identifierSeq: 7,
  });
  assert.equal(parsed.priority, "urgent");
  assert.equal(parsed.startDate, "2026-10-08");
  assert.equal(parsed.dueDate, "2026-12-31");
  assert.deepEqual(parsed.creator, { kind: "human", id: "local-user" });
  assert.equal(parsed.identifierSeq, 7);
});

test("schema：Surface 新字段的坏值一律拒绝（闭集外优先级 / 不存在的日期 / 空创建人 id / 非正序号）", () => {
  const base = {
    id: "wi_1",
    workspaceIdentity: "ws",
    workspacePath: "/tmp/ws",
    title: "t",
    body: "",
    status: "todo",
    assignee: { type: "user", id: "u1" },
  };
  assert.equal(workItemSchema.safeParse({ ...base, priority: "none" }).success, false);
  assert.equal(workItemSchema.safeParse({ ...base, startDate: "2026-02-29" }).success, false);
  assert.equal(workItemSchema.safeParse({ ...base, dueDate: "2026/10/08" }).success, false);
  assert.equal(
    workItemSchema.safeParse({ ...base, creator: { kind: "user", id: "u1" } }).success,
    false,
  );
  assert.equal(
    workItemSchema.safeParse({ ...base, creator: { kind: "human", id: "" } }).success,
    false,
  );
  assert.equal(workItemSchema.safeParse({ ...base, identifierSeq: 0 }).success, false);
  assert.equal(workItemSchema.safeParse({ ...base, identifierSeq: 1.5 }).success, false);
});
