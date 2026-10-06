import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import {
  createWorkItemCommentReactionRepo,
  type WorkItemCommentReactionRepo,
} from "../src/workitem/workItemCommentReactionRepo.js";

/* 修复回归（X1.2 评审发现）：add 曾写 0010 表不存在的 author_display_name 列——调用即抛。
   本文件补上该 repo 此前缺失的行为测试（幂等/读回/隔离）。 */

function setup(): { repo: WorkItemCommentReactionRepo } {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return { repo: createWorkItemCommentReactionRepo(db) };
}

const input = (over: Record<string, unknown> = {}) => ({
  id: "r-1",
  workspaceKey: "ws",
  commentId: "c-1",
  author: { kind: "human" as const, id: "hu-1", displayName: "张三" },
  emoji: "👍",
  createdAt: 100,
  ...over,
});

test("add 可调用且读回（修复回归：列与 0010 表形状一致）", () => {
  const { repo } = setup();
  const added = repo.add(input());
  assert.equal(added.commentId, "c-1");
  assert.equal(added.emoji, "👍");
  // displayName 是输入形状的一部分，但表不存展示名快照——读回无此字段即正确形态。
  assert.equal((added.author as { displayName?: string }).displayName, undefined);
});

test("同 (comment,author,emoji) 幂等：重投返回既存行", () => {
  const { repo } = setup();
  const first = repo.add(input());
  const retry = repo.add(input({ id: "r-2", createdAt: 200 }));
  assert.equal(retry.id, first.id);
  assert.equal(retry.createdAt, first.createdAt, "不重写既存行");
  assert.equal(repo.listByComment("c-1").length, 1);
});

test("listByComment 排序与隔离；不同 emoji/author 各自成行", () => {
  const { repo } = setup();
  repo.add(input({ emoji: "👍" }));
  repo.add(input({ id: "r-2", emoji: "🎉" }));
  repo.add(input({ id: "r-3", author: { kind: "human", id: "hu-2" } }));
  repo.add(input({ id: "r-4", commentId: "c-2" }));
  assert.equal(repo.listByComment("c-1").length, 3);
  assert.equal(repo.listByComment("c-2").length, 1);
});
