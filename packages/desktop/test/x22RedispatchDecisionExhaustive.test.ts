// eslint-disable-next-line typescript-eslint/triple-slash-reference -- 与 x21CommentDispatchWiring.test.ts 同一处声明（不为本文件另写一份）
/// <reference path="../../services/src/runtime-tools/node-forge.d.ts" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  commentReceiptObligationPairKey,
  commentReceiptSettlementFor,
  decideSquadDispatch,
  decideUnsettledReceiptRedispatch,
  WORK_ITEM_MISSING_REASON,
} from "../src/host/squadDispatch.js";

/* X2.2 独立复验（test-verifier）：D4 补投决策表的**穷举网格 + 每格可达性**，以及在途去重
   守卫的咬合面（结构面 —— `index.ts` 是 host 入口，不可 import，见文末说明）。

   为什么再写一份网格：实现者的用例是按「场景」给例子（每格一个代表），但决策表的两个
   不变量只能靠穷举钉住 ——
   ① **次序**：自己 run 非 open 优先于会话探测；探测不可得优先于「在执行」；
      有自己 run 行时**完全不看**义务表（义务归属只在「没有自己 run 行」时参与）；
   ② **非空跑**：7 格必须每格都被真实输入走到（某格永不被走到 = 判据形同虚设）。
   本文件的期望值按**判据表**独立重写（顺序敏感），并对全量笛卡尔积逐点比对。 */

const receipt = { dispatchKey: "cdk-1", workItemId: "wi-1", targetAgentId: "ta-1" };
const pairKey = commentReceiptObligationPairKey("wi-1", "ta-1");

/** D4 七格（+1 条同为「重投」的独立路径）：id 用于可达性计数，不参与取值。 */
type CellId =
  | "own_run_not_open"
  | "session_unprobeable"
  | "session_executing"
  | "own_obligation_pending"
  | "settle_coalesced"
  | "redispatch_own_open_no_session"
  | "redispatch_own_open_idle_session"
  | "redispatch_no_own_run_no_obligation";

type Facts = {
  ownStatus: "absent" | "open" | "queued" | "produced" | "rejected" | "merged" | "discarded";
  ownSessionId: string | null;
  probeAvailable: boolean;
  executing: ReadonlySet<string>;
  obligationRunId: string | null;
};

/** 判据表（自上而下，次序即契约）。与实现无关地按七格语义重写。 */
function expectedCell(f: Facts): CellId {
  if (f.ownStatus !== "absent" && f.ownStatus !== "open") return "own_run_not_open";
  if (f.ownStatus === "open" && f.ownSessionId !== null) {
    if (!f.probeAvailable) return "session_unprobeable";
    if (f.executing.has(f.ownSessionId)) return "session_executing";
    return "redispatch_own_open_idle_session";
  }
  if (f.ownStatus === "open") return "redispatch_own_open_no_session";
  if (f.obligationRunId !== null) {
    return f.obligationRunId === receipt.dispatchKey
      ? "own_obligation_pending"
      : "settle_coalesced";
  }
  return "redispatch_no_own_run_no_obligation";
}

const expectedDecision = (cell: CellId, f: Facts) => {
  switch (cell) {
    case "own_run_not_open":
      return { action: "skip", reason: "own_run_not_open" } as const;
    case "session_unprobeable":
      return { action: "skip", reason: "session_unprobeable" } as const;
    case "session_executing":
      return { action: "skip", reason: "session_executing" } as const;
    case "own_obligation_pending":
      return { action: "skip", reason: "own_obligation_pending" } as const;
    case "settle_coalesced":
      return { action: "settle_coalesced", coalescedInto: f.obligationRunId! } as const;
    case "redispatch_own_open_no_session":
    case "redispatch_own_open_idle_session":
    case "redispatch_no_own_run_no_obligation":
      return { action: "redispatch" } as const;
  }
};

const run = (f: Facts) =>
  decideUnsettledReceiptRedispatch({
    receipt,
    runHistory:
      f.ownStatus === "absent"
        ? []
        : [{ runId: receipt.dispatchKey, status: f.ownStatus, sessionId: f.ownSessionId }],
    executingSessionIds: f.executing,
    sessionProbeAvailable: f.probeAvailable,
    obligationsByPair:
      f.obligationRunId === null ? new Map() : new Map([[pairKey, f.obligationRunId]]),
  });

/* ---------- ① 七格逐格点名（每格至少一个直接断言；次序敏感的格另附反例） ---------- */

test("X2.2 决策表 7 格逐格点名（每格一个直接断言，含次序敏感格的反例）", () => {
  // 格 1「自己 run 非 open」& 次序：即使绑定了正在执行的会话，也必须先报「非 open」（先判台账行）。
  for (const status of ["queued", "produced", "rejected", "merged", "discarded"] as const) {
    assert.deepEqual(
      run({
        ownStatus: status,
        ownSessionId: "s-1",
        probeAvailable: true,
        executing: new Set(["s-1"]),
        obligationRunId: null,
      }),
      { action: "skip", reason: "own_run_not_open" },
      `格1：${status} 行 + 会话在执行 ⇒ 先判「非 open」（不得只看会话）`,
    );
  }
  // 格 2「探测不可得」& 次序：探测不可得优先于「在执行」（不可知时不得据自证清白的集合放行）。
  assert.deepEqual(
    run({
      ownStatus: "open",
      ownSessionId: "s-1",
      probeAvailable: false,
      executing: new Set(["s-1"]),
      obligationRunId: null,
    }),
    { action: "skip", reason: "session_unprobeable" },
    "格2：探测不可得 ⇒ 跳过（自证清白的集合在这条输入下不可信）",
  );
  // 格 3「会话在执行」。
  assert.deepEqual(
    run({
      ownStatus: "open",
      ownSessionId: "s-1",
      probeAvailable: true,
      executing: new Set(["s-1"]),
      obligationRunId: null,
    }),
    { action: "skip", reason: "session_executing" },
    "格3：确证在执行 ⇒ 跳过（重发会重复一次 prompt）",
  );
  // 格 4「自己的义务在案」（没有自己的 run 行时才看义务表）。
  assert.deepEqual(
    run({
      ownStatus: "absent",
      ownSessionId: null,
      probeAvailable: true,
      executing: new Set(),
      obligationRunId: receipt.dispatchKey,
    }),
    { action: "skip", reason: "own_obligation_pending" },
    "格4：自己的义务还挂着 ⇒ 重放通道拥有这次执行",
  );
  // 格 5「同键义务属别的请求」⇒ 终局并入。
  assert.deepEqual(
    run({
      ownStatus: "absent",
      ownSessionId: null,
      probeAvailable: true,
      executing: new Set(),
      obligationRunId: "cdk-existing",
    }),
    { action: "settle_coalesced", coalescedInto: "cdk-existing" },
    "格5：同键义务属别的请求 ⇒ coalesced（B-3 同键合并 = 一次执行）",
  );
  // 格 6「自己的 run open 且未绑会话」⇒ 重投（崩在「登记台账 → 建会话」之间的续做路径）。
  assert.deepEqual(
    run({
      ownStatus: "open",
      ownSessionId: null,
      probeAvailable: true,
      executing: new Set(),
      obligationRunId: null,
    }),
    { action: "redispatch" },
    "格6：open 未绑会话 ⇒ 重投",
  );
  // 格 7「什么都还没有」⇒ 重投（transient 失败 / 桥不可用留下的 pending）。
  assert.deepEqual(
    run({
      ownStatus: "absent",
      ownSessionId: null,
      probeAvailable: true,
      executing: new Set(),
      obligationRunId: null,
    }),
    { action: "redispatch" },
    "格7：无 run 行无义务 ⇒ 重投",
  );
  // 第 8 条路径（同为「重投」，与格 6 的输入类不同）：open + 绑定会话 + 探测可得 + 不在执行。
  assert.deepEqual(
    run({
      ownStatus: "open",
      ownSessionId: "s-1",
      probeAvailable: true,
      executing: new Set(),
      obligationRunId: null,
    }),
    { action: "redispatch" },
    "重启后会话不在执行 ⇒ 重投（resume 后续发）",
  );
  // 次序反例（有自己 run 行时，义务表**完全不参与**）：否则会把「自己已开跑」的请求并进别人的执行。
  assert.deepEqual(
    run({
      ownStatus: "open",
      ownSessionId: null,
      probeAvailable: true,
      executing: new Set(),
      obligationRunId: "cdk-other-request",
    }),
    { action: "redispatch" },
    "有自己 run 行 ⇒ 不看义务表（并入只能发生在「没有执行载体」时）",
  );
});

/* ---------- ② 穷举网格：笛卡尔积逐点比对 + 每格可达性计数 ---------- */

test("X2.2 决策表穷举网格：全量笛卡尔积逐点比对，且 7 格每格都被真实输入走到", () => {
  const statuses = [
    "absent",
    "open",
    "queued",
    "produced",
    "rejected",
    "merged",
    "discarded",
  ] as const;
  const sessions = [null, "s-1", "s-2"] as const;
  const probes = [true, false] as const;
  const executingSets = [
    new Set<string>(),
    new Set(["s-1"]),
    new Set(["s-2"]),
    new Set(["s-1", "s-2"]),
  ] as const;
  const obligations = [null, "cdk-1", "cdk-existing"] as const;
  const reached = new Map<CellId, number>();
  let combos = 0;
  for (const ownStatus of statuses) {
    for (const ownSessionId of sessions) {
      for (const probeAvailable of probes) {
        for (const executing of executingSets) {
          for (const obligationRunId of obligations) {
            const facts: Facts = {
              ownStatus,
              ownSessionId,
              probeAvailable,
              executing,
              obligationRunId,
            };
            const cell = expectedCell(facts);
            reached.set(cell, (reached.get(cell) ?? 0) + 1);
            combos += 1;
            assert.deepEqual(
              run(facts),
              expectedDecision(cell, facts),
              `组合 ${JSON.stringify({ ...facts, executing: [...executing] })} 应落 ${cell}`,
            );
          }
        }
      }
    }
  }
  assert.equal(combos, 7 * 3 * 2 * 4 * 3, "网格规模 = 全量笛卡尔积");
  const seven: CellId[] = [
    "own_run_not_open",
    "session_unprobeable",
    "session_executing",
    "own_obligation_pending",
    "settle_coalesced",
    "redispatch_own_open_no_session",
    "redispatch_no_own_run_no_obligation",
  ];
  for (const cell of seven) {
    assert.ok((reached.get(cell) ?? 0) > 0, `${cell} 格必须被真实输入走到（非空跑）`);
  }
  assert.ok(
    (reached.get("redispatch_own_open_idle_session") ?? 0) > 0,
    "第 8 条路径（open+空闲会话）同样可达",
  );
  // 键隔离：别的 (workItem, agent) 的义务不参与本请求的裁决（网格只喂本键，故这里单独钉一条反例）。
  assert.deepEqual(
    decideUnsettledReceiptRedispatch({
      receipt,
      runHistory: [],
      executingSessionIds: new Set(),
      sessionProbeAvailable: true,
      obligationsByPair: new Map([[commentReceiptObligationPairKey("wi-2", "ta-1"), "cdk-x"]]),
    }),
    { action: "redispatch" },
    "义务归属按 (workItem, agent) 键隔离：异键义务不得被认作本请求的并入目标",
  );
});

/* ---------- ③ 稳定原因码与落定映射（统一终局的取值面） ---------- */

test("X2.2 统一 blocked：原因码取值稳定、落定映射把它落成终局 blocked（不是 failed）", () => {
  assert.equal(WORK_ITEM_MISSING_REASON, "work_item_missing", "原因码是对外可依赖的稳定值");
  assert.deepEqual(
    commentReceiptSettlementFor({ kind: "blocked", reason: WORK_ITEM_MISSING_REASON }),
    {
      outcome: "blocked",
      detail: { reason: "work_item_missing" },
    },
  );
  // 与「并入别的请求」的落定对照：coalescedInto 随 detail 落回收据。
  assert.deepEqual(
    commentReceiptSettlementFor({ kind: "coalesced", coalescedInto: "cdk-existing" }),
    {
      outcome: "coalesced",
      detail: { coalescedInto: "cdk-existing" },
    },
  );
  // retry = 不落定（保持未收敛等重投），failed = 终局失败 —— 两者不得混同。
  assert.equal(commentReceiptSettlementFor({ kind: "retry" }), null);
  assert.deepEqual(commentReceiptSettlementFor({ kind: "failed", error: "boom" }), {
    outcome: "failed",
    detail: { reason: "boom" },
  });
});

/* ---------- ④ 缝合成因链：残枝重放失败后 host 会走到哪一格（每步均已执行，中间由 host 接线） ---------- */

test("X2.2 组合推定：重放失败留下「有行无树」的 open 行 ⇒ 派发桥按缺树判失败 ⇒ receipt 落 failed", () => {
  // 步 ①：openMemberRun 撞残枝后残行留 open（见 services/test/x22NoCollisionPipeline.test.ts，已执行）。
  // 步 ②：host 对 already_registered 的行沿用既有缺失工作树判据 —— 队员 run 无树 ⇒ fail（不派发）。
  assert.deepEqual(
    decideSquadDispatch({
      dispatchEnabled: true,
      databaseReady: true,
      busy: false,
      kind: "member",
      leaderRunInProgress: false,
      briefingPrompt: "P",
      memberPrompt: "P",
      standalonePrompt: "P",
      worktree: undefined,
    }),
    { action: "fail", reason: "member_run_requires_worktree" },
    "缺失工作树的队员 run 是确定性失败（重投不自愈）",
  );
  // 步 ③：失败落点 ⇒ receipt 终局 failed（终局 = 不再被未收敛扫描认领）。
  assert.deepEqual(
    commentReceiptSettlementFor({ kind: "failed", error: "member_run_requires_worktree" }),
    {
      outcome: "failed",
      detail: { reason: "member_run_requires_worktree" },
    },
  );
});

/* ---------- ⑤ 在途去重守卫的咬合（结构面：host 入口不可 import） ---------- */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const readHost = (): string =>
  readFileSync(join(repoRoot, "packages/desktop/src/host/index.ts"), "utf8");
const countOccurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

test("X2.2 接线：三条评论派发路径全部汇入在途去重壳（唯一执行体只有壳内一个调用点）", () => {
  const host = readHost();
  // 唯一执行体：performCommentDispatch 只有「定义 + 壳内一个调用点」两处出现。
  assert.equal(
    countOccurrences(host, "performCommentDispatch("),
    2,
    "执行体不得被壳以外的地方直呼（否则绕过在途去重 ⇒ 同一请求两次建会话/两次 prompt）",
  );
  const wrapperStart = host.indexOf("async function runCommentDispatch(");
  const wrapperEnd = host.indexOf("async function performCommentDispatch(", wrapperStart);
  assert.ok(wrapperStart >= 0 && wrapperEnd > wrapperStart, "找不到去重壳与执行体的边界");
  const wrapper = host.slice(wrapperStart, wrapperEnd);
  assert.equal(countOccurrences(wrapper, "performCommentDispatch("), 1, "壳内恰一个调用点");
  // 壳的调用点 = 3 条路径：在线入口 / 义务重放 / 补投扫描（各自一行 await）。
  const callSites = countOccurrences(host, "await runCommentDispatch(squadRuntime, target, ");
  assert.equal(callSites, 3, "在线入口 / 义务重放 / 补投扫描各一处（不多不少）");
  for (const marker of [
    "async function dispatchCommentDispatch(",
    "async function replayCommentObligation(",
    "async function redispatchUnsettledCommentReceipts(",
  ]) {
    const start = host.indexOf(marker);
    const end = host.indexOf("\n}\n", start);
    assert.ok(start >= 0 && end > start, `找不到 ${marker} 的边界`);
    assert.match(
      host.slice(start, end),
      /await runCommentDispatch\(squadRuntime, target, /,
      `${marker} 必须经去重壳（不得直呼执行体）`,
    );
  }
  // 占位/释放的咬合：占位在 await 之前，释放只在 finally（抛错也必须释放，否则该键永久卡死）。
  const at = (needle: string): number => {
    const index = wrapper.indexOf(needle);
    assert.ok(index >= 0, `壳里找不到「${needle}」`);
    return index;
  };
  const hasAt = at("commentDispatchInFlight.has(dispatchKey)");
  const addAt = at("commentDispatchInFlight.add(dispatchKey)");
  const awaitAt = at("await performCommentDispatch(");
  const finallyAt = at("finally {");
  const deleteAt = at("commentDispatchInFlight.delete(dispatchKey)");
  assert.ok(hasAt < addAt, "先查后占位");
  assert.ok(addAt < awaitAt, "占位必须先于执行（否则并发窗口仍在）");
  assert.ok(finallyAt < deleteAt, "释放必须在 finally 里（唯一释放点）");
  assert.ok(awaitAt < finallyAt, "执行被 finally 包住");
  assert.equal(countOccurrences(wrapper, "commentDispatchInFlight.delete("), 1, "释放点只有一处");
  assert.equal(
    countOccurrences(host, "const commentDispatchInFlight"),
    1,
    "去重集合是模块级单例（进程内）",
  );
});

test("X2.2 接线：统一 blocked 的在线入口半边（工作项查不到 ⇒ blocked + 稳定原因码）", () => {
  const host = readHost();
  // 三处 = 1 处 import + 2 处使用（在线入口 / A1 重验）。字面量不得绕过常量另写一份。
  assert.equal(countOccurrences(host, "WORK_ITEM_MISSING_REASON"), 3, "import + 两个使用点");
  assert.equal(
    countOccurrences(host, '"work_item_missing"'),
    0,
    "不得写死字面量（第二份文案会与常量漂移）",
  );
  assert.match(
    host,
    /return failPermanent\(`work item not found: \$\{msg\.workItemId\}`, \{\s*kind: "blocked",\s*reason: WORK_ITEM_MISSING_REASON,\s*\}\);/,
    "在线入口：工作项查不到 ⇒ 与义务重放/补投扫描同一终局（blocked）",
  );
  assert.match(
    host,
    /function commentReplayRejectionReason\(workItem: WorkItem \| undefined\): string \| null \{\s*if \(workItem === undefined\) return WORK_ITEM_MISSING_REASON;/,
    "A1 重验的同一实现：缺失原因码只有一处",
  );
});
