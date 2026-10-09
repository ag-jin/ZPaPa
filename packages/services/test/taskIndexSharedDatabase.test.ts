import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

// 「同一条连接」不靠注释保证：TEMP 表是**连接级**的——换一条连接就一定看不到它。
// 若这里返回的是另开的一条连接（recon.md F3 的失败形态），下面第二条断言读不到 probe。
test("openSharedDatabase 交出的连接与 repo 自己用的是同一条", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tasks-index-"));
  const repo = new TaskIndexRepo(join(dir, "tasks-index.sqlite"));
  await repo.ensureReady();
  const db = repo.openSharedDatabase();
  db.exec("CREATE TEMP TABLE probe(x INTEGER)");
  db.exec("INSERT INTO probe VALUES (7)");
  assert.equal(repo.openSharedDatabase().prepare("SELECT x FROM probe").get()?.x, 7);
});

test("未初始化时 openSharedDatabase 响亮失败", () => {
  const dir = mkdtempSync(join(tmpdir(), "tasks-index-"));
  const repo = new TaskIndexRepo(join(dir, "tasks-index.sqlite"));
  assert.throws(() => repo.openSharedDatabase(), /尚未初始化/);
});
