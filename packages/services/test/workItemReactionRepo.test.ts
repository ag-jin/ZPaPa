import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import {
  createWorkItemReactionRepo,
  type WorkItemReactionRepo,
} from "../src/workitem/workItemReactionRepo.js";

/* `work_item_reactions` 存储面（P3-R5s 切片 2）的直接用例。形态照 0010 评论 reactions 的现成模板
   （`workItemCommentReactionRepo.ts`）与 multica `issue_reaction.sql` 三条 SQL。

   本文件承重的四条纪律（逐条对应验收）：
   ① **写路径幂等由存储层兜底**：`INSERT OR IGNORE` + **`changes()` 判真插入** ——
      「命中冲突 = 无变化」是显式契约（multica `ON CONFLICT DO NOTHING` 同格：HTTP 仍 201，
      但辅助 revision 置 0，即调用方**知道**这次没有新事实）。先查后插不在此列：它在并发下
      两条都会「查不到」而撞唯一键，第二条会**响亮失败**（幂等塌掉）。
   ② **删除不存在 = 无变化、不报错**（multica `changed=false` 且 `204`）：重投/连点撤销不是错误。
   ③ **读 = 插入序（`created_at ASC`）**，不按热度也不按 id 重排（多端/多次刷新看到的次序不得抖动）。
   ④ **存储不白名单**：emoji 是非空字符串（自定义 token / 超长串原样存取），DDL 里唯一的约束是
      迁移 0021 的 `CHECK (length(emoji) > 0)`；正常路径的空串闸在服务面 `assertEmoji`（写之前拒、
      零落盘），而 `INSERT OR IGNORE` **连 CHECK 违规也一起吞** ⇒ 直插 repo 的空串由「回读为空」
      响亮抛兜底（钉在本文件最后一条用例里）。 */

const WS = "ws-a";
const human = (id: string) => ({ kind: "human" as const, id });

function makeRepo(): { db: DatabaseSync; repo: WorkItemReactionRepo } {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return { db, repo: createWorkItemReactionRepo(db) };
}

let seq = 0;
const add = (
  repo: WorkItemReactionRepo,
  over: Partial<Parameters<WorkItemReactionRepo["add"]>[0]> = {},
): ReturnType<WorkItemReactionRepo["add"]> =>
  repo.add({
    id: over.id ?? `r-${++seq}`,
    workspaceKey: WS,
    workItemId: "wi-1",
    author: human("u1"),
    emoji: "👍",
    createdAt: 100,
    ...over,
  });

const rawCount = (db: DatabaseSync): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM work_item_reactions").get() as { n: number }).n;

test("add｜首次 inserted=true 并读回逐字段；同五元组重投 inserted=false 且返回既存行（不重写时间戳、库里恰一行）", () => {
  const { db, repo } = makeRepo();
  const first = add(repo, { id: "r-first" });
  assert.equal(first.inserted, true, "首次是真插入");
  assert.deepEqual(first.record, {
    id: "r-first",
    workspaceKey: WS,
    workItemId: "wi-1",
    author: { kind: "human", id: "u1" },
    emoji: "👍",
    createdAt: 100,
  });

  // 重投：换 id、换时间戳、换 author.displayName —— 既存行一字不改（冲突 = 无变化）。
  const retry = add(repo, { id: "r-second", createdAt: 200, author: { ...human("u1") } });
  assert.equal(retry.inserted, false, "命中五元组冲突 ⇒ 无变化（changes()=0 是显式契约）");
  assert.equal(retry.record.id, "r-first", "返回既存行（不是入参回抛）");
  assert.equal(retry.record.createdAt, 100, "既存行的时间戳不得被重投改写");
  assert.equal(rawCount(db), 1, "库里恰一行");
  db.close();
});

test("add｜五元组各分量不同各自成行：一人多 emoji / 多人同 emoji / 跨工作项 / 跨 kind 互不影响", () => {
  const { db, repo } = makeRepo();
  add(repo, { id: "r-1", emoji: "👍" });
  add(repo, { id: "r-2", emoji: "🎉" }); // 一人多 emoji
  add(repo, { id: "r-3", author: human("u2") }); // 多人同 emoji
  add(repo, { id: "r-4", author: { kind: "agent", id: "u1" } }); // 同 id 异 kind 是另一个主体
  add(repo, { id: "r-5", workItemId: "wi-2" });
  add(repo, { id: "r-6", workspaceKey: "ws-b" });
  assert.equal(rawCount(db), 6, "六个不同五元组各自成行（幂等只在整元组相同时生效）");
  assert.equal(
    repo.listByWorkItem(WS, "wi-1").length,
    4,
    "本工作项四行：human u1 的两种 emoji + human u2 + agent u1（同 id 异 kind 是另一个主体）",
  );
  assert.equal(repo.listByWorkItem(WS, "wi-2").length, 1);
  assert.equal(repo.listByWorkItem("ws-b", "wi-1").length, 1, "跨 workspace 互不串行");
  db.close();
});

test("remove｜首次 removed=true，重复 removed=false 且不报错；只删目标元组那一行", () => {
  const { db, repo } = makeRepo();
  add(repo, { id: "r-1", emoji: "👍" });
  add(repo, { id: "r-2", emoji: "🎉" });
  add(repo, { id: "r-3", author: human("u2") });

  assert.equal(
    repo.remove({ workspaceKey: WS, workItemId: "wi-1", author: human("u1"), emoji: "👍" }),
    true,
    "命中一行才算删掉",
  );
  assert.equal(
    repo.remove({ workspaceKey: WS, workItemId: "wi-1", author: human("u1"), emoji: "👍" }),
    false,
    "取消不存在的反应 = 无变化、不报错（连点撤销不是错误）",
  );
  assert.equal(rawCount(db), 2, "只删了目标那一行");
  assert.deepEqual(
    repo.listByWorkItem(WS, "wi-1").map((row) => row.id),
    ["r-2", "r-3"],
  );
  // 跨工作项/跨工作的同形删除不得误删：本 workspace 没有这一行 ⇒ false，别的 workspace 的行照在。
  assert.equal(
    repo.remove({ workspaceKey: "ws-b", workItemId: "wi-1", author: human("u1"), emoji: "🎉" }),
    false,
    "异 workspace 的同形删除落空（不回删别人的行）",
  );
  assert.equal(rawCount(db), 2);
  db.close();
});

test("listByWorkItem｜按插入序（created_at ASC, id ASC）：id 逆序而时间正序的行不得按 id 重排", () => {
  const { db, repo } = makeRepo();
  // 时间戳先于 id 说话：插入序 = b(100) → a(200) → z(300) → c(300)，id 与插入序刻意逆序。
  add(repo, { id: "r-b", emoji: "👍", createdAt: 100 });
  add(repo, { id: "r-a", emoji: "🎉", createdAt: 200 });
  add(repo, { id: "r-z", emoji: "👀", createdAt: 300 });
  add(repo, { id: "r-c", emoji: "✅", createdAt: 300 });
  assert.deepEqual(
    repo.listByWorkItem(WS, "wi-1").map((row) => row.id),
    ["r-b", "r-a", "r-c", "r-z"],
    "created_at 升序为主键，同刻才用 id 做 tie-break（按 id 整表重排 = 界面次序随存储引擎抖动）",
  );
  db.close();
});

test("listByWorkItem｜存储不白名单：自定义 token / 超长串原样读回；非法 author_kind 读回响亮抛", () => {
  const { db, repo } = makeRepo();
  add(repo, { id: "r-custom", emoji: ":custom_party_parrot:" });
  add(repo, { id: "r-long", emoji: "x".repeat(100) });
  const emojis = repo.listByWorkItem(WS, "wi-1").map((row) => row.emoji);
  assert.deepEqual(
    emojis,
    [":custom_party_parrot:", "x".repeat(100)],
    "存储层不筛内容（白名单在 UI 层）",
  );

  // 手改库/跨版本残留的非法主体：读回**响亮抛**，不静默交出去（交出去界面会把 agent 的同 emoji
  // 误判成「我」或反之 —— 聚合的第一格判据就是 author_kind）。
  db.prepare(
    `INSERT INTO work_item_reactions (id, workspace_key, work_item_id, author_kind, author_id,
       emoji, created_at)
     VALUES ('r-bad', ?, 'wi-1', 'robot', 'u9', '👀', 400)`,
  ).run(WS);
  assert.throws(
    () => repo.listByWorkItem(WS, "wi-1"),
    /author_kind|robot/,
    "非法主体类型读回必须响亮抛（同 0010 评论 reactions 的读回口径）",
  );
  db.close();
});

/* 空 emoji 直插 repo 的**真实机制**（T-P3-V 复验收口）：`INSERT OR IGNORE` **连 CHECK 违规也
   一起吞**（`changes()=0` 静默跳过，不抛 `CHECK constraint failed`），响亮抛的是随后按五元组
   回读为空 —— 回读兜底，而不是「插入即抛」。
   正常写路径的空串闸在**服务面** `assertEmoji`（写之前拒、零落盘，见服务面用例 B1）；
   本用例钉的是 repo 被单独调用（绕过服务面）时的兜底行为。
   变异：把 `INSERT OR IGNORE` 换成 `INSERT`（或「先查后插」，想「空串被 CHECK 响亮拒绝」）
   ⇒ 这里必红 —— 抛的是 CHECK 错误，不再是读回兜底的「读回为空」。 */
test("add｜空 emoji 直插 repo：`INSERT OR IGNORE` 把 CHECK 违规一起吞（changes=0 静默），响亮抛的是随后的回读空", () => {
  const { db, repo } = makeRepo();
  assert.throws(
    () => add(repo, { id: "r-empty", emoji: "" }),
    /读回为空/,
    "空串不在这里被 CHECK 抛：IGNORE 连 CHECK 违规一起忽略（changes=0），抛的是回读兜底",
  );
  assert.equal(rawCount(db), 0, "CHECK 违规的行没有落库（IGNORE 吞掉的是这一行的写入）");
  db.close();
});
