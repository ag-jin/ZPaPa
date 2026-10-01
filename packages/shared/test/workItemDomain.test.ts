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
