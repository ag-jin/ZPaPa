import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { resolveWorkspaceKey } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";
import { createWorkItemService } from "../src/workitem/workItemService.js";

/* 工作项 `workspace_key` 的**写读口径一致性**（G4 实测回归：dev:web 建项后看板不可见）。

   缺陷链（写读分叉）：
   · 写侧 `workItemService.create` 把 `input.workspaceIdentity` **原样**交给
     `workItemRepo.insert` ⇒ 落库 `workspace_key = 裸 identity`（web 环境该值为空串）；
   · 读侧 `squadRuntimeService` 的 `keyOf` 走 `resolveWorkspaceKey`（identity trim 后非空优先、
     否则回落 path）⇒ 空 identity 时读键是 path。
   两键不等 ⇒ 建出来的行**永远读不回**（`listByWorkspace` 命中 0 行），表现为看板不可见。

   本文件钉的是**接缝两侧**而不是某一侧的实现细节：
   ① 裸 SQL 读 `work_items.workspace_key`（经 repo 映射读会掩盖列写错，与 0018 用例同一条理由）；
   ② 用读侧**同一枚判据** `resolveWorkspaceKey` 求读键，再走 `repo.listByWorkspace` ——
      写侧归一若与读侧口径分叉（少 trim、多 trim、回落错一边），这里必红。

   三格：空串（web 缺省）/ 纯空白（trim 语义）/ 非空 identity（现行为不得回归）。 */

const WS_PATH = "/Users/dev/projects/g4";

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return db;
}

function fixture() {
  const db = openDb();
  const repo = createWorkItemRepo(db);
  const service = createWorkItemService({ repo, emit: () => {} });
  return { db, repo, service };
}

/** 裸读落库列：不走 repo 映射（映射掩盖列名/归一错误）。 */
function rawWorkspaceKey(db: DatabaseSync, id: string): string {
  const row = db.prepare("SELECT workspace_key FROM work_items WHERE id = ?").get(id) as
    | { workspace_key: string }
    | undefined;
  assert.ok(row, `工作项未落库：${id}`);
  return row.workspace_key;
}

function createWithIdentity(
  service: ReturnType<typeof createWorkItemService>,
  workspaceIdentity: string,
) {
  return service.create({
    workspaceIdentity,
    workspacePath: WS_PATH,
    title: "G4 自查第一条",
    assignee: { type: "agent", id: "a1" },
  });
}

test("写读口径一致｜identity 为空串（web 缺省）：落库键 = path，且按读侧判据可见", () => {
  const { db, repo, service } = fixture();
  const item = createWithIdentity(service, "");

  assert.equal(
    rawWorkspaceKey(db, item.id),
    WS_PATH,
    "空 identity 必须归一为 path（原样落空串 ⇒ 读侧按 path 查永远读不回）",
  );

  // 读侧判据（= squadRuntimeService.keyOf 的口径）：identity trim 后非空优先，否则 path。
  const readKey = resolveWorkspaceKey({ workspacePath: WS_PATH, workspaceIdentity: "" });
  assert.equal(readKey, WS_PATH);
  const visible = repo.listByWorkspace(readKey);
  assert.deepEqual(
    visible.map((row) => row.id),
    [item.id],
    "create 之后按读侧键必须读回刚建的那条（否则看板不可见）",
  );

  // create 的返回值必须与随后的读回逐字段同源：返回值若留着裸 identity，
  // 调用方手上的实体与库里的行就是两个 key（同一处分叉的第二张脸）。
  assert.equal(item.workspaceIdentity, rawWorkspaceKey(db, item.id));
  assert.equal(item.workspaceIdentity, readKey);
  assert.equal(item.workspacePath, WS_PATH, "path 仍按原值落列（文件操作/命令 cwd 靠它）");
  assert.deepEqual(
    repo.listByWorkspace(WS_PATH).map((row) => row.id),
    [item.id],
  );
  db.close();
});

test("写读口径一致｜identity 纯空白：按 trim 归一为 path（与读侧同一枚判据）", () => {
  const { db, repo, service } = fixture();
  const item = createWithIdentity(service, "   ");

  assert.equal(rawWorkspaceKey(db, item.id), WS_PATH);
  assert.equal(resolveWorkspaceKey({ workspacePath: WS_PATH, workspaceIdentity: "   " }), WS_PATH);
  assert.deepEqual(
    repo.listByWorkspace(WS_PATH).map((row) => row.id),
    [item.id],
  );
  db.close();
});

test("写读口径一致｜identity 非空（远程身份）：落 identity 且现行为不回归", () => {
  const { db, repo, service } = fixture();
  const identity = "remote:ssh:imac:/Users/dev/projects/g4";
  const item = createWithIdentity(service, identity);

  assert.equal(rawWorkspaceKey(db, item.id), identity);
  assert.equal(
    resolveWorkspaceKey({ workspacePath: WS_PATH, workspaceIdentity: identity }),
    identity,
  );
  assert.deepEqual(
    repo.listByWorkspace(identity).map((row) => row.id),
    [item.id],
  );
  // 身份隔离：非空 identity 的项**不得**出现在 path 键下（否则远程与本地项目串台）。
  assert.deepEqual(repo.listByWorkspace(WS_PATH), []);
  db.close();
});

test("写读口径一致｜identity 带首尾空白：落 trim 后的键（读侧 trim，写侧不得留原文）", () => {
  const { db, repo, service } = fixture();
  const item = createWithIdentity(service, "  remote:ssh:imac:/ws  ");

  assert.equal(rawWorkspaceKey(db, item.id), "remote:ssh:imac:/ws");
  assert.deepEqual(
    repo.listByWorkspace("remote:ssh:imac:/ws").map((row) => row.id),
    [item.id],
  );
  db.close();
});
