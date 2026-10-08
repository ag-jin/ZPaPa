import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* #8 D3：整批收尾**模式**的运行时读取口（设计 §4.4 的模式开关 / §6 的「设置模式开关」）。

   本片把「模式」做成 runtime 的一个**读取函数**而不是构造期冻结的值：
   · runtime 按目标**现构、不缓存**，而模式是**运行期可改**的设置（同 `readGithubPullRequestToken`
     的既有手法）——读函数让「设置里刚切成 pr-gate」在下一次收尾即生效，不必重建 runtime；
   · 缺省（不注入）⇒ `local`：既有调用方与既有用例**零改动**，且缺省形态零出站
     （pr-gate 才碰网络）。这条是 D3 的行为中立锚点：开关关闭态 = 改前的本地链路。 */

async function setup(readSquadMergeMode?: () => "local" | "pr-gate") {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: "merge-mode-ws",
    readExperimentEnabled: () => true,
    ...(readSquadMergeMode !== undefined ? { readSquadMergeMode } : {}),
  });
  return { repoRoot, runtime, cleanup: () => rmSync(repoRoot, { recursive: true, force: true }) };
}

test("缺省（不注入读取口）⇒ local：既有装配零改动即得本地收尾形态", async () => {
  const f = await setup();
  try {
    assert.equal(f.runtime.readSquadMergeMode(), "local");
  } finally {
    f.cleanup();
  }
});

test("注入读取口 ⇒ 每次调用现判（设置切换后不必重建 runtime，不冻结结论）", async () => {
  let mode: "local" | "pr-gate" = "pr-gate";
  const f = await setup(() => mode);
  try {
    assert.equal(f.runtime.readSquadMergeMode(), "pr-gate");
    mode = "local";
    assert.equal(f.runtime.readSquadMergeMode(), "local", "同一 runtime 上现判，不吃旧结论");
    mode = "pr-gate";
    assert.equal(f.runtime.readSquadMergeMode(), "pr-gate");
  } finally {
    f.cleanup();
  }
});
