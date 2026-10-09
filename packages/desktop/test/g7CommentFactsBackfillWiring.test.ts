import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/* G7（spec §8.4-3）接线守卫：**半途事务扫描挂进启动维护路径，且 host 侧零 repo / 零键拼装**。

   为什么这一格只能是源码守卫：启动维护整段要 Electron parentPort + git + 真库才跑得起来
   （与 X2.2 补投接线同款）。行为面（补什么、幂等、不重跑队列状态窗）在 services 侧有真库用例
   （`commentFactsBackfill.test.ts`）；这里钉的是**只有 host 源码能回答**的三件事：
   ① 挂点在启动路径上、且在第四步（queue reconciliation）**之后**；
   ② 走协作门面的公开入口，host 不自己拼 repo / 不自己拼键（那会是第二条写路径）；
   ③ 每 workspace 一次、失败响亮（逐条带 workspace 路径 warn），不阻断启动。 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const readHost = (): string =>
  readFileSync(join(repoRoot, "packages/desktop/src/host/index.ts"), "utf8");

test("G7 接线｜第五步挂在启动维护路径上，且排在第四步（queue reconciliation）之后", () => {
  const host = readHost();
  const queueIdx = host.indexOf('"queue reconciliation"');
  const backfillIdx = host.indexOf('"comment facts backfill"');
  assert.ok(queueIdx >= 0, "找不到启动第四步（queue reconciliation）");
  assert.ok(
    backfillIdx > queueIdx,
    "半途事务扫描必须排在第四步之后（补投先收口 receipt，再按已持久事实投影）",
  );
  assert.match(
    host.slice(backfillIdx, backfillIdx + 600),
    /backfillCommentFactsBestEffort\(activeServices, target\)/,
    "第五步必须经那个 best-effort 助手（逐候选 try/catch 与留痕都在它里面）",
  );
  // 挂点仍在同一个启动 IIFE（预热名单 + database ready 回调）里：不能飘到别处成为第二个启动路径。
  const iifeIdx = host.indexOf("void (async () => {", queueIdx - 4000);
  const watchdogIdx = host.indexOf("squadWatchdogTick = startSquadWatchdogTick(", backfillIdx);
  assert.ok(
    iifeIdx >= 0 && iifeIdx < backfillIdx && watchdogIdx > backfillIdx,
    "第五步必须在启动 IIFE 内、且在在线看门狗 tick 之前（次序即契约）",
  );
});

test("G7 接线｜补写走协作门面公开入口，host 侧零 repo / 零连接 / 零键拼装", () => {
  const host = readHost();
  const start = host.indexOf("async function backfillCommentFactsBestEffort(");
  const end = host.indexOf("\nasync function", start + 10);
  assert.ok(start >= 0 && end > start, "找不到 backfillCommentFactsBestEffort 的边界");
  const helper = host.slice(start, end);
  assert.match(
    helper,
    /services\?\.getOptional\(IWorkItemCollaborationService\)/,
    "必须经协作门面取公开入口（未注册 ⇒ 响亮 warn，不静默跳过）",
  );
  assert.match(
    helper,
    /await collaboration\.backfillWorkItemCommentFacts\(target\)/,
    "调的是门面方法（workspaceKey 由门面从 runtime 绑定值派生）",
  );
  for (const forbidden of [
    "createWorkItemCommentRepo",
    "createWorkItemActivityRepo",
    "openSharedDatabase",
    "dedupKey",
    "comment:${",
  ]) {
    assert.ok(
      !helper.includes(forbidden),
      `host 侧不得出现 ${forbidden}：补写必须落在写侧那张表与那份键表上（另拼一份 = 第二条写路径）`,
    );
  }
  // 失败面：响亮（带 workspace 路径的 warn），但不阻断启动。
  assert.match(
    helper,
    /logger\.warn\(`\[squad\] startup comment facts backfill failed workspace=\$\{target\.path\}`/,
    "失败必须逐条带 workspace 原文留痕（静默会让「没补上」与「本来就没有残行」长得一样）",
  );
});
