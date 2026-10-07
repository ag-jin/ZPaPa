// eslint-disable-next-line typescript-eslint/triple-slash-reference -- 与 schedulerWakeTick.test.ts 同一处声明（不为本文件另写一份）
/// <reference path="../../services/src/runtime-tools/node-forge.d.ts" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveCommentLeaderOverride } from "../src/host/squadDispatch.js";

/* D6 插队轮（§6 / §11-C2）：**评论通道的目标是不是队长**这一格的判据。

   为什么这一格单独抽成纯函数、而不是写在 host 的 async 分支里：它决定「带不带三段简报、
   记不记队长台账行、参不参与 §5.7(1) 合并」——判错的表现是「队长被当成普通智能体起跑」
   （无简报、不合并）或反过来「普通智能体拿到一份花名册简报，以为自己该去派单」，两者都不报错。
   host 执行体在测试环境不可 import（worker 入口），故判据必须在可 import 的纯函数层被穷举。

   判据的三条事实（全部来自 receipt，持久事实）：
   · `squadId`：这条请求的目标是**哪支小队**解析出来的（D6 起落进 receipt.detail；缺席 = 不是队长目标）；
   · 名册里该小队的 `leaderAgentId`：**现在**谁是队长；
   · `targetAgentId`：这条请求点名要跑的智能体。
   身份核对（`leaderAgentId === targetAgentId`）是**必须**的：receipt 落库后队长可能被换人/
   小队被删，重放时目标已经不是队长了 —— 那时仍按队长派发会把简报发给一个不是队长的人。 */

const squads = [
  { id: "sq-a", leaderAgentId: "ta-lead" },
  { id: "sq-b", leaderAgentId: "ta-other" },
];

test("D6 身份核对：目标 = 小队队长 ⇒ 走队长支（返回那支小队）", () => {
  const squad = resolveCommentLeaderOverride({
    targetAgentId: "ta-lead",
    squadId: "sq-a",
    squads,
  });
  assert.deepEqual(squad, { id: "sq-a", leaderAgentId: "ta-lead" });
});

test("D6 身份核对：receipt 之后队长换人 ⇒ 不得按队长派发（退回普通 agent 覆盖）", () => {
  // receipt 记的是 sq-a（当时的队长是 ta-lead），但目标在名册里已不是该队队长。
  assert.equal(
    resolveCommentLeaderOverride({ targetAgentId: "ta-x", squadId: "sq-a", squads }),
    null,
    "「是不是队长」要按**当前**名册核对：不一致时绝不夹带简报（简报发给非队长 = 让它去派单）",
  );
  assert.equal(
    resolveCommentLeaderOverride({ targetAgentId: "ta-other", squadId: "sq-a", squads }),
    null,
    "目标恰是别队队长也不算：身份核对只认 receipt 记的那支小队的队长",
  );
});

test("D6 身份核对：无 squadId（@agent / 回复锚点）或小队已不存在 ⇒ 都不是队长目标", () => {
  assert.equal(
    resolveCommentLeaderOverride({ targetAgentId: "ta-lead", squadId: undefined, squads }),
    null,
    "没有 squadId = 这条请求解析出的目标是个普通智能体（不得靠名字/其它字段去猜）",
  );
  assert.equal(
    resolveCommentLeaderOverride({ targetAgentId: "ta-lead", squadId: "sq-gone", squads }),
    null,
    "小队已删（名册里查不到）⇒ 解析不出简报来源，退回普通 agent 覆盖（不猜、不静默丢弃这条请求）",
  );
});

/* ---------- 接线（host 执行体不可 import，按源码结构钉住「谁调谁」） ---------- */

const hostSource = (): string =>
  readFileSync(
    join(
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
      "packages/desktop/src/host/index.ts",
    ),
    "utf8",
  );

test("D6 接线：评论目标取 receipt 事实 → 身份核对 → 队长支带 leaderOverride，否则退回 targetOverride", () => {
  const host = hostSource();
  const start = host.indexOf("async function runSquadDispatch(");
  assert.ok(start >= 0, "host 里没有 runSquadDispatch");
  const end = host.indexOf('parentPort.on("message",', start);
  const body = host.slice(start, end);

  assert.match(
    body,
    /commentReceiptSquadId\(/,
    "小队来源必须从 receipt 事实读（D6 的 squadId 落库口），不得从调用方载荷或 source 反推",
  );
  assert.match(
    body,
    /resolveCommentLeaderOverride\(/,
    "身份核对必须走唯一实现（摘掉它 ⇒ 非队长也会拿到简报）",
  );
  assert.match(
    body,
    /\.\.\.\(leaderSquad !== null\s*\?\s*\{ leaderOverride: \{ squad: leaderSquad \} \}\s*:\s*targetOverride !== undefined/,
    "队长支必须把 squad 交给 planDispatch 的 leaderOverride（只出现标识符不算：必须是这一处入参展开）",
  );
  assert.match(body, /targetOverride/, "非队长支必须保留既有 agent 覆盖（旧契约不动）");
  // 两支互斥：两个覆盖值不得同时进 planDispatch 的入参对象。
  const planCall = body.slice(body.indexOf("events = planDispatch({"));
  const planArgs = planCall.slice(0, planCall.indexOf("});"));
  assert.doesNotMatch(
    planArgs,
    /targetOverride !== undefined[\s\S]{0,200}leaderOverride !== undefined/,
    "同一处同时传两个覆盖 = 目标身份没答出来（planDispatch 会响亮抛）",
  );
});

test("D6 接线：receipt 回写不得抹掉请求事实（squadId 随 detail 落回，否则重放降级）", () => {
  const host = hostSource();
  const start = host.indexOf("async function settleCommentReceipt(");
  assert.ok(start >= 0, "host 里没有 receipt 回写口");
  const end = host.indexOf("async function replayCommentObligation(", start);
  assert.ok(end > start, "找不到回写口的结束边界");
  const body = host.slice(start, end);
  assert.match(
    body,
    /commentReceiptSquadId\(receipt\)/,
    "小队来源必须从 receipt 读一次（回写是整份 detail 覆盖）",
  );
  assert.match(
    body,
    /triggerSource: receipt\.source,[\s\S]{0,200}\.\.\.\(squadId !== undefined \? \{ squadId \} : \{\}\)/,
    "回写必须把 squadId 一起落回：抹掉它 ⇒ deferred 重放那一次会降级成普通 agent run",
  );
});
