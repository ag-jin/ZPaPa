import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { resolveWorkspaceKey } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import { createSquadOrchestrator } from "../src/workitem/squadOrchestrator.js";
import { archiveSquadAndTransfer, createSquadRuntime } from "../src/workitem/squadRuntime.js";
import type { SquadRunRecord } from "../src/workitem/squadRunRepo.js";
import {
  createSquadRuntimeService,
  type ISquadRuntimeService,
  type SquadWorkspaceTarget,
} from "../src/workitem/squadRuntimeService.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* P1 修复轮的回归：**游标必须能被自己读回**——生产 runId（= host 的 eventKey）**含冒号**是常态。

   复验报告 `.superpowers/sdd/2026-10-01-multi-agent-squad-p2b/reports/2026-10-07-pack-round-verification.md`
   §5-P1（已实际复现）：旧游标格式 `v1:<created_at>:<run_id>` 用 `:` 分隔，而 runId 形状
   `assign:wi-1:agent:ta-1:<uuid>` / `comment-dispatch:v1:…` 里全是冒号 ⇒ 页边界行是这类 id 时，
   编出的 nextCursor 被同一实现的 decode 判非法（响亮抛）⇒「加载更多」翻不过第一页。
   任一 agent 超过一页（50 条）的运行必命中。

   本文件钉两件事（期望值取自复验报告给出的**生产形状**与手写的 (createdAt, runId) DESC 序）：
   ① 含冒号 runId 的**往返**：nextCursor 原样带回 ⇒ 下一页照常给出（旧实现此处必红）；
   ② 翻页**并集完整**：逐页走完 = 全集、无重、严格 DESC（含同刻 tie-break 与 agentId 过滤）。

   游标保持**不透明**：本文件不解析它的内容，只断言「给回来的东西能被自己吃下」——格式升级
   （v2 长度前缀）是实现细节，用例不得钉字面格式。 */

const target = (identity: string): SquadWorkspaceTarget => ({ path: `/tmp/${identity}`, identity });

const WS = target("ws");
const WS_KEY = resolveWorkspaceKey({ workspacePath: "/tmp/ws", workspaceIdentity: "ws" });

const run = (over: Partial<SquadRunRecord> = {}): SquadRunRecord => ({
  runId: "run-1",
  workspaceKey: WS_KEY,
  workspacePath: "/tmp/ws",
  workItemId: "wi-1",
  parentWorkItemId: "wi-1",
  agentId: "ta-1",
  isLeaderTask: false,
  branch: null,
  dirName: null,
  status: "merged",
  sessionId: null,
  dispatchCause: null,
  causedByRunId: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

/* 生产 runId 的两种形状（host 的 eventKey，逐字取自复验报告 §5-P1 的复现夹具）。 */
const UUID_A = "9f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
const ASSIGN_A = `assign:wi-1:agent:ta-1:${UUID_A}`;
const ASSIGN_B = "assign:wi-2:agent:ta-1:0b1c2d3e-4f5a-6b7c-8d9e-0f1a2b3c4d5e";
const COMMENT_A = "comment-dispatch:v1:2:ws|4:wi-1|4:ta-1|3:c-1";
const COMMENT_B = "comment-dispatch:v1:2:ws|4:wi-2|4:ta-1|3:c-2";
const COMMENT_C = "comment-dispatch:v1:2:ws|4:wi-3|4:ta-2|3:c-3";
const ASSIGN_C = "assign:wi-3:agent:ta-2:1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d";

async function makeService() {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const state = { enabled: true };
  const createRuntime = async (t: SquadWorkspaceTarget): Promise<SquadRuntime> =>
    createSquadRuntime({
      db,
      workspacePath: repoRoot,
      workspaceIdentity: t.identity,
      readExperimentEnabled: () => state.enabled,
    });
  const squadRuntimeService: ISquadRuntimeService = createSquadRuntimeService({
    createRuntime,
    readExperimentEnabled: async () => state.enabled,
    archiveSquadAndTransfer: async (t, id) => archiveSquadAndTransfer(await createRuntime(t), id),
    createOrchestrator: createSquadOrchestrator,
  });
  return { db, squadRuntimeService, createRuntime };
}

/** 逐页走完（每页**必须**用上一页给的 nextCursor；游标不推进 ⇒ 响亮失败，而不是挂住）。 */
async function walk(
  service: ISquadRuntimeService,
  limit: number,
  agentId?: string,
): Promise<{ ids: string[]; pages: string[][]; cursors: Array<string | null> }> {
  const pages: string[][] = [];
  const cursors: Array<string | null> = [];
  let cursor: string | undefined;
  for (let step = 0; step < 100; step += 1) {
    const page = await service.listSquadRunHistory(WS, {
      limit,
      ...(agentId === undefined ? {} : { agentId }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    assert.ok(page.runs.length <= limit, "每页不得超过 limit");
    pages.push(page.runs.map((record) => record.runId));
    cursors.push(page.nextCursor);
    if (page.nextCursor === null) return { ids: pages.flat(), pages, cursors };
    cursor = page.nextCursor;
  }
  throw new Error("游标翻页超过 100 页仍未结束：nextCursor 没有推进");
}

// ---------- ① 含冒号 runId 的游标往返（P1 的复现形状） ----------

test("P1 回归｜含冒号 runId 的页边界：nextCursor 自读回 + 逐页并集 = 全集（DESC）", async () => {
  const service = await makeService();
  const runtime = await service.createRuntime(WS);
  const ids = [ASSIGN_A, ASSIGN_B, COMMENT_A, COMMENT_B, COMMENT_C, ASSIGN_C];
  ids.forEach((runId, index) => {
    runtime.squadRunRepo.insert(
      run({ runId, agentId: "ta-1", createdAt: 100 + index, updatedAt: 100 + index }),
    );
  });

  const { ids: seen, pages, cursors } = await walk(service.squadRuntimeService, 2);

  // 前提：页边界行确实是含冒号的 runId（否则本用例证明不了 P1 —— 旧实现下这里必红）。
  assert.ok(pages[0]![1]!.includes(":"), "前提：第一页的最后一条（= 游标行）是含冒号的 runId");
  assert.deepEqual(
    pages.map((page) => page.length),
    [2, 2, 2],
    "6 行 limit=2 ⇒ 3 页（旧实现：第一页过后 decode 抛，「加载更多」在此断掉）",
  );
  assert.deepEqual(
    seen,
    [ASSIGN_C, COMMENT_C, COMMENT_B, COMMENT_A, ASSIGN_B, ASSIGN_A],
    "并集 = 全集，且严格按 (createdAt, runId) DESC（手写期望，不重算实现的口径）",
  );
  assert.equal(new Set(seen).size, ids.length, "翻页并集无重复");
  assert.equal(cursors[2], null, "末页 nextCursor = null（到底）");

  // 游标可原样重放：同一游标读两次得到同一页（读操作不留状态，也不依赖「谁在读」）。
  const replay = await service.squadRuntimeService.listSquadRunHistory(WS, {
    limit: 2,
    cursor: cursors[0]!,
  });
  assert.deepEqual(
    replay.runs.map((record) => record.runId),
    pages[1],
    "含冒号 runId 的游标原样重放结论逐字相同",
  );
});

test("P1 回归｜同刻（createdAt 全同）+ agentId 过滤下的含冒号 runId：tie-break 翻页不漏不重", async () => {
  const service = await makeService();
  const runtime = await service.createRuntime(WS);
  // 别人的行**更新**：若 agentId 过滤不下推 SQL，第一页会一条自己的行都没有（假空）。
  for (let index = 0; index < 3; index += 1) {
    runtime.squadRunRepo.insert(
      run({
        runId: `assign:wi-other-${index}:agent:ta-other:${UUID_A}`,
        agentId: "ta-other",
        createdAt: 600 + index,
        updatedAt: 600 + index,
      }),
    );
  }
  const mine = [
    ASSIGN_A,
    ASSIGN_B,
    COMMENT_A,
    COMMENT_B,
    "comment-dispatch:v1:2:ws|4:wi-0|4:ta-1|3:c-0",
  ];
  for (const runId of mine) {
    runtime.squadRunRepo.insert(run({ runId, agentId: "ta-1", createdAt: 500, updatedAt: 500 }));
  }

  const { ids, pages } = await walk(service.squadRuntimeService, 2, "ta-1");

  assert.deepEqual(
    pages,
    [
      [COMMENT_B, COMMENT_A],
      ["comment-dispatch:v1:2:ws|4:wi-0|4:ta-1|3:c-0", ASSIGN_B],
      [ASSIGN_A],
    ],
    "同刻按 run_id DESC（与 repo 的 tie-break 同向）、只推进自己的行；每页边界都是含冒号 id",
  );
  assert.deepEqual(
    ids,
    [COMMENT_B, COMMENT_A, "comment-dispatch:v1:2:ws|4:wi-0|4:ta-1|3:c-0", ASSIGN_B, ASSIGN_A],
    "并集 = 该 agent 的全部 5 行（别人的更新行不占页、自己的行一个不漏）",
  );
  assert.equal(new Set(ids).size, mine.length, "无重复");
});

// ---------- ② 非法游标语义按新格式重铸：旧 v1 形状必须判非法，不得静默接受 ----------

test("P1 回归｜非法游标一律响亮抛：旧 v1 形状不再被接受，新格式的邻近畸形也全部抛", async () => {
  const service = await makeService();
  const runtime = await service.createRuntime(WS);
  runtime.squadRunRepo.insert(
    run({ runId: ASSIGN_A, agentId: "ta-1", createdAt: 105, updatedAt: 105 }),
  );
  runtime.squadRunRepo.insert(
    run({ runId: "plain-run", agentId: "ta-1", createdAt: 100, updatedAt: 100 }),
  );

  const first = await service.squadRuntimeService.listSquadRunHistory(WS, { limit: 1 });
  const cursor = first.nextCursor!;
  assert.equal(first.runs[0]!.runId, ASSIGN_A, "前提：游标行是含冒号的 runId");
  assert.ok(cursor.length > 0, "非末页必须给游标");

  /* 说明：verifier 的 17 种非法游标样本（形状 / 版本 / 时间 / 多余段 / 前后空白）留在
     `squadRunHistoryPagingExhaustive.test.ts` **不动**，改格式后逐条仍抛（该文件本轮全绿）。
     这里补的是「旧 v1 形状**不再**被静默接受」与「新格式邻近畸形」两类。 */
  const invalid = [
    // ① 旧 v1 形状：格式升级后一律判非法 —— 含「旧实现自己会接受」的无冒号样本（不猜着解释）
    `v1:105:${ASSIGN_A}`,
    "v1:100:plain-run",
    // ② 真实游标的畸形变体（与格式无关的变换：截断 / 多余字符 / 前导空白 / 未知版本位）
    cursor.slice(0, -1),
    `${cursor}x`,
    ` ${cursor}`,
    cursor.replace(/^v\d+/, "v0"),
    // ③ 新格式（长度前缀）的邻近畸形：位数与实际不符 / 前导零 / 缺段 / 位数不是数字
    `v2:3:105:58:${ASSIGN_A}`, // 位数比实际少一（尾部字符落单）
    `v2:3:105:60:${ASSIGN_A}`, // 位数比实际多一（内容不足）
    `v2:03:105:59:${ASSIGN_A}`, // 长度位前导零
    `v2:3:0105:59:${ASSIGN_A}`, // 时间前导零（旧格式 `v1:01:` 的同类）
    `v2:3:105:059:${ASSIGN_A}`, // run_id 位数前导零
    `v2:3:105:59`, // 缺 run_id 段
    `v2:3:105::59:${ASSIGN_A}`, // 空位数段
    "v2:abc:105:59:x", // 位数不是数字
    `v2:3:105:59:${ASSIGN_A}:extra`, // 尾部多余段（原样读回不变式兜住）
  ];
  for (const sample of invalid) {
    await assert.rejects(
      () => service.squadRuntimeService.listSquadRunHistory(WS, { limit: 1, cursor: sample }),
      /游标/,
      `非法游标「${JSON.stringify(sample)}」必须响亮抛（回落第一页会把分页 bug 伪装成「又刷了一遍」）`,
    );
  }
});
