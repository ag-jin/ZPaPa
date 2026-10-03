import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/* 收件箱三个 host 产生点的**接线守卫**（P2c）。

   本文件钉住的不是某个返回值，而是「某条线接上了」这件事实（与 squadWiring.test.ts 同一手法）：
   没有它们，漏接的表现是「功能整块空转且不报错」（recon.md C6 的原形态）——组件全绿、
   没有任何报错，只是没有任何地方去调用它们。

   还有一半是**best-effort**：登记失败（库未就绪 / 冲突 / 服务面缺件）不得阻断派发与收尾 ——
   所以每个落点都必须在 `try`/`catch` 或链 `.catch(` 里，且**逐个落点**分开钉：
   「有一处包了」不等于「三处都包了」。 */

const HOST_SOURCE = readFileSync(
  join(resolve(dirname(fileURLToPath(import.meta.url)), "../src"), "host/index.ts"),
  "utf8",
);

/** 取 [startMarker, endMarker) 之间的**结构区域**（不用固定字节窗口：窗口是脆的）。 */
function region(startMarker: string, endMarker: string): string {
  const start = HOST_SOURCE.indexOf(startMarker);
  assert.ok(start >= 0, `找不到区域起点：${startMarker}`);
  const end = HOST_SOURCE.indexOf(endMarker, start);
  assert.ok(end > start, `找不到区域终点：${endMarker}`);
  return HOST_SOURCE.slice(start, end);
}

/** 每个构建件在 host 里**只准出现一次**：第二处调用必然是漏包 best-effort 的新落点。 */
test("三个 Inbox 构建件在 host 里各只出现一次（第二处 = 未守卫的新落点）", () => {
  for (const builder of [
    "buildMemberFailedInboxItem(",
    "buildOrphanedRunInboxItem(",
    "buildDispatchSkippedInboxItem(",
  ]) {
    assert.equal(
      HOST_SOURCE.split(builder).length - 1,
      1,
      `${builder} 在 host/index.ts 里出现了多次：新落点必须先想清 best-effort 包裹方式`,
    );
  }
});

/** `.catch(` 链式（P2 队员失败 / P4 skip）：构建件之前必须有 `recordInboxItem(`，其后必须链 `.catch(`。 */
function assertRecordWrappedByCatch(source: string, builder: string): void {
  const builderAt = source.indexOf(builder);
  assert.ok(builderAt >= 0, `区域内没有构建件调用：${builder}`);
  const callAt = source.lastIndexOf("recordInboxItem(", builderAt);
  assert.ok(callAt >= 0, `构建件调用之前没有 recordInboxItem(：${builder}`);
  // 区域刻意取窄 ⇒ `recordInboxItem(` 之后的下一个 `.catch(` 只可能是它自己的链。
  assert.match(
    source.slice(callAt),
    /\.catch\(/,
    `${builder} 的 recordInboxItem 必须链 .catch(（best-effort：登记失败不得阻断派发/收尾）`,
  );
}

/** `try`/`catch` 包裹（P3 启动和解）：调用必须在**最近的** `try {` 之内（其间不得先出现 `} catch`）。 */
function assertRecordInsideTry(source: string, builder: string): void {
  const builderAt = source.indexOf(builder);
  assert.ok(builderAt >= 0, `区域内没有构建件调用：${builder}`);
  const callAt = source.lastIndexOf("recordInboxItem(", builderAt);
  assert.ok(callAt >= 0, `构建件调用之前没有 recordInboxItem(：${builder}`);
  const tryAt = source.lastIndexOf("try {", callAt);
  assert.ok(tryAt >= 0, `${builder} 的 recordInboxItem 不在任何 try 块里（best-effort 要求）`);
  assert.equal(
    source.slice(tryAt, callAt).includes("} catch"),
    false,
    `${builder} 的 recordInboxItem 与最近的 try { 之间出现了 } catch —— 它不在该 try 块内`,
  );
}

// P2（产生点 ②，spec §6.2）：队员/队长会话终态失败 ⇒ 除 failMemberRun 外还要登记 Inbox。
test("host 产生点 ②：终态失败分支里登记 member_failed 且链 .catch(", () => {
  const subscribeTerminal = region(
    "const subscribeTerminal = (listener",
    "squadRunSubscriptions.set(subscriptionKey, disposable);",
  );
  // 先证明区域取对了（失败出口与登记在同一支里）。
  assert.match(subscribeTerminal, /failMemberRun\(/);
  assertRecordWrappedByCatch(subscribeTerminal, "buildMemberFailedInboxItem(");
});

// P3（产生点 ③，spec §6.6）：启动和解的每条残留 run ⇒ 除 failMemberRun 外还要登记 Inbox。
test("host 产生点 ③：启动和解循环里登记 run_orphaned 且在 try/catch 内", () => {
  const reconcile = region(
    "const stale = selectStaleLeaderRuns(",
    "startup leader-run reconciliation done",
  );
  assert.match(reconcile, /failMemberRun\(/);
  assertRecordInsideTry(reconcile, "buildOrphanedRunInboxItem(");
});

// P4（产生点 ④，spec §3.9）：planDispatch 的四条 skip ⇒ 登记 dispatch_skipped（reason 用事件原文）。
test("host 产生点 ④：skip 分支里登记 dispatch_skipped 且链 .catch(", () => {
  const skipBranch = region(
    'const enqueued = events.find((event) => event.kind === "run.enqueued");',
    "const kind: SquadDispatchKind = enqueued.runClass;",
  );
  assert.match(skipBranch, /inbox\.notified/, "区域应先证明取到 skip 分支（reason 来自该事件）");
  assert.match(skipBranch, /reason: skip\.reason/, "reason 必须用事件原文（去重键含它）");
  assertRecordWrappedByCatch(skipBranch, "buildDispatchSkippedInboxItem(");
});

// 三个落点的共同纪律：`recordInboxItem` 经**服务面**（不是 host 自己开库 / 拼 SQL）——
// 这条把「有人图省事在 host 里直连 repo」的形状挡在门外（唯一写者不变）。
test("host 只经服务面 recordInboxItem 登记，不自己碰任何 SQL/repo", () => {
  assert.doesNotMatch(HOST_SOURCE, /inbox_items/, "host 不得出现裸表名（写者只准在 repo 里）");
  assert.doesNotMatch(
    HOST_SOURCE,
    /INSERT\s+(OR\s+IGNORE\s+)?INTO/i,
    "host 不得自己拼 INSERT（唯一写者是 inboxItemRepo）",
  );
});
