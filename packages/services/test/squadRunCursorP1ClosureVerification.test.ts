import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { resolveWorkspaceKey } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { computeCommentDispatchKey } from "../src/workitem/commentDispatchKey.js";
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

/* P1 修复的**闭环重验**（test-verifier，2026-10-07，独立构造）。
   被验：`7c24463`（分页游标 v1 分隔符切片 ⇒ v2 长度前缀）。
   前一轮复验报告 §5-P1 判 failed：旧游标 `v1:<created_at>:<run_id>` 与生产 runId（= host 的
   eventKey：`assign:wi-…:agent:ta-…:<uuid>` / `comment-dispatch:v1:…`）的冒号冲突 ⇒ 自产游标被
   自拒，「加载更多」翻不过第一页。

   本文件是**复现重跑 + 独立构造**，与实现者夹具零复用（不同的 id、行数与序，期望值手写）：
   ① 复现重跑：两份生产形状 + limit=2，逐页并集完整（旧实现在第二页取数处抛，红侧由变异复跑证）；
   ② 独立构造：10 行混排（含**自身形如游标** / 纯数字 / 单字符 / `|` 与 `:` 混排的 runId），
      每一个给出游标的页边界都必须是含冒号 id（前提断言；不带前提的用例证明不了 P1 已修）；
   ③ 同刻 × agentId 过滤：6 行同刻、别人的行更新 ⇒ 过滤下推与 tie-break 同时承重；
   ④ 拒绝语义：旧 v1 一律拒绝（含旧实现自己会接受的无冒号样本）、v2 邻近畸形族全拒。

   游标保持**不透明**：本文件不把字面格式写成期望值；期望值取自需求（DESC 呈现口径、
   `(created_at, run_id)` tie-break、不透明游标原样带回、非法即抛）与手写行序。 */

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

/** 逐页走完：每页**必须**用上一页给的 nextCursor；游标不推进 ⇒ 响亮失败（不挂住）。 */
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

/** 每一页「给出游标」的边界行都必须是含冒号 runId；否则本文件的用例证明不了 P1 已修。 */
function assertCursorRowsHaveColon(
  pages: string[][],
  cursors: Array<string | null>,
  label: string,
): void {
  const cursorPages = pages.filter((_, index) => cursors[index] !== null);
  assert.ok(cursorPages.length > 0, `${label}：至少要有一页给出游标（否则游标没被翻过）`);
  for (const [index, page] of pages.entries()) {
    if (cursors[index] === null) continue;
    const boundary = page[page.length - 1]!;
    assert.ok(
      boundary.includes(":"),
      `${label}：第 ${index + 1} 页的边界行（游标所指）必须是含冒号 runId，实际「${boundary}」`,
    );
  }
}

/* ---------- ① 复现重跑：前报告 §5-P1 / §7-1 的夹具与页大小（limit=2）原样 ---------- */

test("P1 闭环｜复现重跑：两种生产形状 runId + limit=2 ⇒ 游标自读回、逐页并集 = 全集（旧实现必抛）", async () => {
  const service = await makeService();
  const runtime = await service.createRuntime(WS);
  const uuid = "9f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
  const assign = `assign:wi-1:agent:ta-1:${uuid}`;
  const comment = "comment-dispatch:v1:2:ws|4:wi-1|4:ta-1|3:c-1";
  /* 六行、两种生产形状各三行、created_at 各不相同 ⇒ 页边界必然落在形状行上。 */
  const ids = [
    assign,
    comment,
    `assign:wi-2:agent:ta-1:${randomUUID()}`,
    "comment-dispatch:v1:2:ws|4:wi-2|4:ta-1|3:c-2",
    `assign:wi-3:agent:ta-1:${randomUUID()}`,
    "comment-dispatch:v1:2:ws|4:wi-3|4:ta-1|3:c-3",
  ];
  ids.forEach((runId, index) => {
    runtime.squadRunRepo.insert(
      run({ runId, agentId: "ta-1", createdAt: 100 + index, updatedAt: 100 + index }),
    );
  });

  // 真 repo 直读：旧实现就死在第二行（把第一页给的游标喂回去 ⇒ decode 判非法）。
  const repoFirst = runtime.squadRunRepo.listHistoryPage(WS_KEY, { limit: 2 });
  assert.deepEqual(
    repoFirst.rows.map((record) => record.runId),
    [...ids].reverse().slice(0, 2),
    "前提：第一页是最近两条（DESC）",
  );
  assert.ok(repoFirst.nextCursor !== null, "第一页必须给游标（还有 4 行）");
  const repoSecond = runtime.squadRunRepo.listHistoryPage(WS_KEY, {
    limit: 2,
    cursor: repoFirst.nextCursor,
  });
  assert.deepEqual(
    repoSecond.rows.map((record) => record.runId),
    [...ids].reverse().slice(2, 4),
    "真 repo 的 nextCursor 被真 repo 自己吃下（旧实现此处抛）",
  );

  // 服务面（界面走的同一条）：逐页走完，并集 = 全集、无重、严格 DESC。
  const { ids: seen, pages, cursors } = await walk(service.squadRuntimeService, 2);
  assert.deepEqual(
    pages.map((page) => page.length),
    [2, 2, 2],
    "6 行 limit=2 ⇒ 3 页（旧实现：第一页过后 decode 抛，「加载更多」断在这里）",
  );
  assertCursorRowsHaveColon(pages, cursors, "复现重跑");
  assert.deepEqual(
    seen,
    [...ids].reverse(),
    "并集 = 全集且严格 DESC（手写期望：六行 created_at 递增，倒序即 DESC）",
  );
  assert.equal(new Set(seen).size, ids.length, "翻页并集无重复");
  assert.equal(cursors[2], null, "末页 nextCursor = null（到底）");
  // 游标可原样重放：同一游标读两次得到同一页（读操作不留状态）。
  const replay = await service.squadRuntimeService.listSquadRunHistory(WS, {
    limit: 2,
    cursor: cursors[0]!,
  });
  assert.deepEqual(
    replay.runs.map((record) => record.runId),
    pages[1],
    "第一页给出的游标原样重放 ⇒ 结论逐字相同",
  );
});

/* ---------- ② 独立构造：10 行混排（含对抗性 runId），边界行必含冒号 ---------- */

test("P1 闭环｜独立构造：10 行混排（对抗 runId）+ limit=2 ⇒ 5 页并集完整且严格 DESC", async () => {
  const service = await makeService();
  const runtime = await service.createRuntime(WS);
  const uuidA = randomUUID();
  const uuidB = randomUUID();
  const uuidC = randomUUID();
  /* 关键：`v2:3:105:59:decoy` 是**自身形如游标**的 runId（切分式解码会在这里翻车）；
     `12345` 纯数字、`z`/`1` 单字符（长度前缀只有一位）、`plain-run` 与 `|edge|:id|` 分别覆盖
     「无特殊字符」与「`|` 开头」两端。created_at 分组使 4 个给出游标的页边界都落在含冒号 id 上。 */
  const assignA = `assign:wi-42:agent:ta-7:${uuidA}`;
  const assignB = `assign:wi-42:agent:ta-7:${uuidB}`;
  const assignC = `assign:wi-42:agent:ta-7:${uuidC}`;
  const commentC7 = computeCommentDispatchKey({
    workspaceKey: "ws",
    workItemId: "wi-42",
    targetAgentId: "ta-7",
    commentId: "c-7",
  });
  const decoy = "v2:3:105:59:decoy";
  const rows: Array<[number, string]> = [
    [701, assignA],
    [700, assignB],
    [700, commentC7],
    [699, decoy],
    [698, "plain-run"],
    [697, assignC],
    [696, "12345"],
    [695, "|edge|:id|"],
    [695, "z"],
    [695, "1"],
  ];
  for (const [createdAt, runId] of rows) {
    runtime.squadRunRepo.insert(run({ runId, agentId: "ta-7", createdAt, updatedAt: createdAt }));
  }
  assert.equal(
    commentC7,
    "comment-dispatch:v1:2:ws|5:wi-42|4:ta-7|3:c-7",
    "生产评论派发键由真实生成器算出（含 `:` 与 `|`，不是手搓形状）",
  );
  assert.ok(decoy.includes("v2:") && decoy.includes(":"), "对抗样本自身就长得像游标");

  /* 手写期望：created_at DESC，同刻 run_id DESC（与 repo 的 ORDER BY created_at DESC,
     run_id DESC 同向；`|`(124) > `c`(99) > `a`(97) > `1`(49) 为 ASCII 序）。 */
  const expected = [
    assignA, // 701
    commentC7, // 700（comment-… > assign-…）
    assignB, // 700
    decoy, // 699
    "plain-run", // 698
    assignC, // 697
    "12345", // 696
    "|edge|:id|", // 695 组内 DESC
    "z",
    "1",
  ];

  const { ids, pages, cursors } = await walk(service.squadRuntimeService, 2);
  assert.deepEqual(
    pages.map((page) => page.length),
    [2, 2, 2, 2, 2],
    "10 行 limit=2 ⇒ 5 页（旧实现：第 1 页边界就是含冒号 id ⇒ 第二页抛）",
  );
  assertCursorRowsHaveColon(pages, cursors, "独立构造");
  assert.deepEqual(
    pages,
    [
      expected.slice(0, 2),
      expected.slice(2, 4),
      expected.slice(4, 6),
      expected.slice(6, 8),
      expected.slice(8, 10),
    ],
    "5 页逐页内容（含同刻 tie-break、手写 run_id DESC 序与对抗 runId）",
  );
  assert.deepEqual(ids, expected, "并集 = 全集且严格 DESC（手写期望，不重算实现口径）");
  assert.equal(new Set(ids).size, rows.length, "无重复、无漏行");
  assert.equal(cursors[4], null, "末页到底");
});

/* ---------- ③ 同刻 × agentId 过滤：过滤下推与 tie-break 同时承重 ---------- */

test("P1 闭环｜同刻 × 过滤：6 行同刻 + 别人的行更新 ⇒ 并集恰是自己的 6 行、按 run_id DESC", async () => {
  const service = await makeService();
  const runtime = await service.createRuntime(WS);
  for (let index = 0; index < 4; index += 1) {
    runtime.squadRunRepo.insert(
      run({
        runId: `assign:wi-other-${index}:agent:ta-8:${randomUUID()}`,
        agentId: "ta-8",
        createdAt: 800 + index,
        updatedAt: 800 + index,
      }),
    );
  }
  const commentKey1 = computeCommentDispatchKey({
    workspaceKey: "ws",
    workItemId: "wi-1",
    targetAgentId: "ta-7",
    commentId: "c-1",
  });
  const commentKey2 = computeCommentDispatchKey({
    workspaceKey: "ws",
    workItemId: "wi-1",
    targetAgentId: "ta-7",
    commentId: "c-2",
  });
  const assign1 = `assign:wi-1:agent:ta-7:${randomUUID()}`;
  const assign2 = `assign:wi-2:agent:ta-7:${randomUUID()}`;
  const mine = [commentKey1, commentKey2, assign1, assign2, "12345", "|mixed|:weird|"];
  for (const runId of mine) {
    runtime.squadRunRepo.insert(run({ runId, agentId: "ta-7", createdAt: 500, updatedAt: 500 }));
  }

  // 反证：不带过滤的第一页（limit=2）一条自己的行都没有 —— 过滤若发生在取数之后，这里就是假空。
  const unfiltered = await service.squadRuntimeService.listSquadRunHistory(WS, { limit: 2 });
  assert.equal(
    unfiltered.runs.filter((record) => record.agentId === "ta-7").length,
    0,
    "前提：自己的 6 行全部落在「最新 limit 条」之外（否则本用例证明不了过滤下推）",
  );

  const { ids, pages, cursors } = await walk(service.squadRuntimeService, 2, "ta-7");
  // 手写期望：同刻全部相等 ⇒ 只按 run_id DESC（ASCII 序）。
  const expected = ["|mixed|:weird|", commentKey2, commentKey1, assign2, assign1, "12345"];
  assert.deepEqual(pages, [expected.slice(0, 2), expected.slice(2, 4), expected.slice(4, 6)]);
  assert.deepEqual(
    ids,
    expected,
    "并集 = 该 agent 的全部 6 行（别人的更新行不占页、自己的一个不漏）",
  );
  assert.equal(new Set(ids).size, mine.length, "无重复");
  assertCursorRowsHaveColon(pages, cursors, "同刻×过滤");
  assert.equal(cursors[2], null, "末页到底");
});

/* ---------- ④ 拒绝语义：旧 v1 一律拒绝 + v2 邻近畸形全拒 ---------- */

test("P1 闭环｜拒绝语义：旧 v1（含旧实现会接受的无冒号样本）与 v2 邻近畸形一律响亮抛", async () => {
  const service = await makeService();
  const runtime = await service.createRuntime(WS);
  const cursorRow = `assign:wi-9:agent:ta-9:${randomUUID()}`;
  runtime.squadRunRepo.insert(run({ runId: cursorRow, agentId: "ta-9", createdAt: 105 }));
  runtime.squadRunRepo.insert(run({ runId: "plain-run", agentId: "ta-9", createdAt: 100 }));

  const first = await service.squadRuntimeService.listSquadRunHistory(WS, { limit: 1 });
  const real = first.nextCursor!;
  assert.equal(first.runs[0]!.runId, cursorRow, "前提：游标行是含冒号 runId");
  assert.ok(real.length > 0, "非末页必须给游标");

  // 正对照：未经改动的真实游标必须被接受（下面的畸形族才有意义）。
  const accepted = await service.squadRuntimeService.listSquadRunHistory(WS, {
    limit: 1,
    cursor: real,
  });
  assert.deepEqual(
    accepted.runs.map((record) => record.runId),
    ["plain-run"],
    "正对照：真游标照常翻到第二页",
  );

  /* 旧 v1 形状：升级后**一律**判非法（不猜着解释）。`v1:100:plain-run` 是无冒号样本 ——
     旧实现在它上面会正常接受；升级瞬间用户看到的是「加载更多」失败一次（重载即恢复），
     而不是被按旧语义解释成另一页。 */
  const legacyV1 = [
    "v1:100:plain-run",
    `v1:105:${cursorRow}`,
    "v1:1234567890123:r-0",
    "v1:1",
    "v1:",
    "v1",
  ];

  /* v2 邻近畸形：以**真游标**为基准做与格式含义无关的变换（位数 ±1 / 前导零 / 非数字 /
     截断 / 追加 / 空白 / 版本位），外加若干按文档形状手写的样本（缺段 / 空原文 /
     时间超安全整数 / 大小写版本位）。变换只看「版本位之后」的片段，不把格式钉成期望值。

     数字段的位次：`<版本>:<时间位数>:<时间原文>:<run_id 位数>:<run_id 原文>` —— 第 1 段是
     时间位数、第 2 段是时间原文、第 3 段是 run_id 位数（第 4 段起才是 run_id 内容）。
     这里**只**改第 1 / 3 段的位数与前导零：改第 2 段（时间**原文**）会得到一条自洽的、
     指向另一把 key 的游标 —— 那是复验报告已登记的 P3（手造自洽游标被接受，本次修复前后同款，
     不是「非法游标」这一类），故意不列进本族。 */
  const versionPrefix = `${real.slice(0, real.indexOf(":") + 1)}`;
  const body = real.slice(versionPrefix.length);
  const withBody = (next: string) => `${versionPrefix}${next}`;
  const replaceNthDigits = (index: number, rewrite: (digits: string) => string) => {
    let seen = 0;
    return withBody(
      body.replace(/(\d+):/g, (whole, digits: string) => {
        seen += 1;
        return seen === index ? `${rewrite(digits)}:` : whole;
      }),
    );
  };
  const bumpCreatedAtLength = (delta: number) =>
    replaceNthDigits(1, (digits) => String(Number(digits) + delta));
  const bumpRunIdLength = (delta: number) =>
    replaceNthDigits(3, (digits) => String(Number(digits) + delta));
  const zeroPadCreatedAtLength = () => replaceNthDigits(1, (digits) => `0${digits}`);
  const zeroPadRunIdLength = () => replaceNthDigits(3, (digits) => `0${digits}`);
  const nonNumericCreatedAtLength = () => replaceNthDigits(1, () => "x");

  const v2Malformed = [
    bumpCreatedAtLength(1), // 时间位数多一
    bumpCreatedAtLength(-1), // 时间位数少一
    bumpRunIdLength(1), // run_id 位数多一
    bumpRunIdLength(-1), // run_id 位数少一
    zeroPadCreatedAtLength(), // 时间位数前导零
    zeroPadRunIdLength(), // run_id 位数前导零
    nonNumericCreatedAtLength(), // 位数不是数字
    real.slice(0, -1), // 截断一格
    `${real}x`, // 尾部追加一个字符
    `${real}:v2:1:1`, // 尾部追加一整段
    ` ${real}`, // 前导空白
    `${real} `, // 尾部空白
    real.replace(/^v\d+/, "v0"), // 未知版本位
    "", // 空串
    "v2:3:105:59:", // 缺 run_id 原文段
    "v2:0::0:", // 空原文
    "v2:16:9007199254740993:1:a", // 时间超安全整数
    "V2:3:105:59:x", // 版本位大小写不同
    "v2:x:105:59:a", // 位数非数字（字面样本）
  ];

  for (const sample of [...legacyV1, ...v2Malformed]) {
    await assert.rejects(
      () => service.squadRuntimeService.listSquadRunHistory(WS, { limit: 1, cursor: sample }),
      /游标/,
      `非法游标「${JSON.stringify(sample)}」必须响亮抛（回落第一页会把分页 bug 伪装成「又刷了一遍」）`,
    );
  }
});
