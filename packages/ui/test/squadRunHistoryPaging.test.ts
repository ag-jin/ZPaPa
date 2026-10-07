import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SQUAD_RUN_SETTLE_REASON_USER_CANCEL,
  SQUAD_RUN_SETTLE_REASON_WATCHDOG_DEAD_SESSION,
  SQUAD_RUN_SETTLE_REASON_WATCHDOG_IDLE_GRACE,
  SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL,
  type SquadRunRecord,
} from "@zcode/services";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  RUN_SETTLE_REASON_MESSAGE_IDS,
  mergeRunHistoryPages,
  runSettleReasonMessageId,
} from "../src/squad/squadRunHistoryViewModel.js";

/* agent 详情页「运行历史」分页（欠账 #13，2026-10-07 裁定）的 UI 用例：
   追加页的合并纯函数 + 结算原因映射 + 详情页结构守卫 + 两语文案成对。

   取数面的分页判据（keyset / 游标 / agentId 下推）在 services 的 `squadRunHistoryPaging.test.ts`；
   本文件只钉界面这一层：**追加不是覆盖**（去重、保持倒序）、**结算原因不是闭集**（未知原文原样显示）。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");

/** 造一条 run 行（只给纯函数关心的字段）。 */
const run = (runId: string, createdAt: number, settleReason?: string | null): SquadRunRecord => ({
  runId,
  workspaceKey: "ws",
  workspacePath: "/tmp/ws",
  workItemId: "wi",
  parentWorkItemId: "wi",
  agentId: "ta-1",
  isLeaderTask: false,
  branch: null,
  dirName: null,
  status: "merged",
  sessionId: null,
  dispatchCause: null,
  causedByRunId: null,
  ...(settleReason === undefined ? {} : { settleReason }),
  createdAt,
  updatedAt: createdAt,
});

// ---------- ① 追加页合并 ----------

/* 变异（P1-7）：追加时不做去重 / 不排序（直接 `[...current, ...page]`）⇒ 第二、三条必红。
   为什么去重承重：翻页期间台账会**继续插入新行**（每次派发/重试都新增），边界行完全可能
   在两页里各出现一次 —— 不去重会在界面上出现两条一模一样的运行行（且 key 冲突）。 */
test("合并追加页：按 runId 去重、保持 (createdAt, runId) DESC 序", () => {
  const current = [run("c", 30), run("b", 20)];
  const page = [run("b", 20), run("a", 10)];
  assert.deepEqual(
    mergeRunHistoryPages(current, page).map((record) => record.runId),
    ["c", "b", "a"],
    "重复的 runId 只留一条（已在屏上的那条不被顶掉，界面不闪）",
  );
  assert.deepEqual(mergeRunHistoryPages([], page).map((record) => record.runId), ["b", "a"]);
  assert.deepEqual(mergeRunHistoryPages(current, []).map((record) => record.runId), ["c", "b"]);
  assert.deepEqual(mergeRunHistoryPages([], []), []);
});

test("合并追加页：同刻（createdAt 相同）按 runId DESC 定序（与服务面同一 tie-break）", () => {
  const merged = mergeRunHistoryPages([run("a", 5)], [run("c", 5), run("b", 5)]);
  assert.deepEqual(
    merged.map((record) => record.runId),
    ["c", "b", "a"],
    "同刻次序必须与服务面的 ORDER BY created_at DESC, run_id DESC 一致（否则追加后行序跳动）",
  );
});

test("合并追加页：不就地改写入参（两份列表原样保留）", () => {
  const current = [run("c", 30)];
  const page = [run("b", 20)];
  const currentSnapshot = [...current];
  const pageSnapshot = [...page];
  mergeRunHistoryPages(current, page);
  assert.deepEqual(current, currentSnapshot);
  assert.deepEqual(page, pageSnapshot);
});

// ---------- ② 结算原因呈现 ----------

/* 变异（P1-6）：把未知原文当成「无」隐藏 ⇒ 第三条必红。
   `settle_reason` **不是闭集**（失败原因原文也落这一列）：把它当枚举处理会让真实的失败原因
   在界面上消失 —— 而那正是用户最需要看到的一行。 */
test("结算原因：4 个码值各有文案键；未知原文与空值返回 null（前者原样显示、后者不显示）", () => {
  assert.deepEqual(Object.keys(RUN_SETTLE_REASON_MESSAGE_IDS).sort(), [
    SQUAD_RUN_SETTLE_REASON_USER_CANCEL,
    SQUAD_RUN_SETTLE_REASON_WATCHDOG_DEAD_SESSION,
    SQUAD_RUN_SETTLE_REASON_WATCHDOG_IDLE_GRACE,
    SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL,
  ].sort());
  for (const code of Object.keys(RUN_SETTLE_REASON_MESSAGE_IDS)) {
    assert.ok(runSettleReasonMessageId(code)?.startsWith("squad.agentDetail.settleReason."), code);
  }
  assert.equal(
    runSettleReasonMessageId("merge conflict: 分支上有人先改了同一段"),
    null,
    "非闭集原文 ⇒ null（界面原样显示，绝不隐藏）",
  );
  assert.equal(runSettleReasonMessageId(""), null, "空 = 没有原因（不显示）");
});

test("结算原因：码值必须引用 services 的常量（UI 不得内联字面量）", () => {
  const viewModel = readSource("squad/squadRunHistoryViewModel.ts");
  for (const literal of ["watchdog_ttl", "watchdog_dead_session", "user_cancel", "watchdog_idle_stop_grace_expired"]) {
    assert.ok(
      !viewModel.includes(`"${literal}"`),
      `UI 不得内联码值字面量「${literal}」—— 抄错一个字，一次看门狗结算会被显示成别的原因`,
    );
  }
  assert.ok(
    viewModel.includes("SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL"),
    "映射表必须引用服务面导出的常量",
  );
});

// ---------- ③ 详情页结构守卫 ----------

/* 变异（P1 的核心假空）：详情页改回 `listSquadRuns` + 前端 filter/slice ⇒ 前三条必红。 */
test("守卫｜详情页只调分页口径：无前端 agentId 过滤、无前端截断、用唯一页大小常量", () => {
  const page = readSource("squad/SquadAgentDetailPage.tsx");
  assert.ok(page.includes("listSquadRunHistory("), "取数必须走分页口径（第三个口径）");
  assert.ok(
    !page.includes("listSquadRuns("),
    "不得再调全量口径：全量 + 前端过滤就是「第一页可能一条都看不到」的假空形态",
  );
  assert.ok(
    !/\.filter\(\(run\) => run\.agentId === agentId\)/.test(page),
    "agentId 过滤已下推 SQL（前端不得再筛一遍）",
  );
  assert.ok(!/slice\(0,/.test(page), "前端截断已换成页大小（分页由服务面给游标）");
  assert.ok(
    /const RUN_HISTORY_PAGE_SIZE = 50;/.test(page) && page.includes("limit: RUN_HISTORY_PAGE_SIZE"),
    "页大小是唯一常量（值仍 50，但语义从「硬截断」变成「页大小」）",
  );
  assert.ok(
    !page.includes("RUN_HISTORY_LIMIT"),
    "旧名必须消失：留着它就是在说一句不再成立的话",
  );
});

test("守卫｜「加载更多」只在有游标时给，加载中禁用，失败可见", () => {
  const page = readSource("squad/SquadAgentDetailPage.tsx");
  const gate = page.indexOf("nextCursor === null");
  const button = page.indexOf('data-testid="squad-agent-detail-runs-more"');
  assert.ok(gate >= 0 && button > gate, "按钮必须在「还有下一页」的条件下");
  assert.ok(page.includes("loadingMore"), "加载中状态必须存在（重复点 = 重复请求）");
  assert.ok(
    page.includes('data-testid="squad-agent-detail-runs-more-failure"'),
    "加载失败要可见（不吞错）",
  );
  assert.ok(
    page.includes("squad.agentDetail.runsLoaded") || page.includes("squad.agentDetail.runsAllLoaded"),
    "计数/到底两态文案要接上",
  );
  assert.ok(
    !page.includes("runsOverflow"),
    "旧溢出文案（「共 N 条，显示前 50」）不再成立：分页后它是一句谎话",
  );
});

test("守卫｜结算原因呈现走映射表（码值本地化、原文原样、空不显示）", () => {
  const page = readSource("squad/SquadAgentDetailPage.tsx");
  assert.ok(page.includes("runSettleReasonMessageId("), "必须经映射表（不得内联字面量比较）");
  const block = page.slice(page.indexOf("runSettleReasonMessageId("), page.indexOf("</li>", page.indexOf("runSettleReasonMessageId(")));
  assert.ok(block.length > 0, "结算原因必须渲染在某一行里");
  assert.ok(
    block.includes("settleReason"),
    "渲染的文本取自 run.settleReason（未知原文原样显示）",
  );
});

// ---------- ④ i18n 成对 ----------

test("守卫｜运行历史分页与结算原因文案两语成对（含占位符一致）", () => {
  const placeholders = (value: string) =>
    [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(",");
  for (const key of [
    "squad.agentDetail.runsMore",
    "squad.agentDetail.runsMoreLoading",
    "squad.agentDetail.runsMoreFailed",
    "squad.agentDetail.runsLoaded",
    "squad.agentDetail.runsAllLoaded",
    "squad.agentDetail.settleReason.watchdogDeadSession",
    "squad.agentDetail.settleReason.watchdogTtl",
    "squad.agentDetail.settleReason.watchdogIdleGrace",
    "squad.agentDetail.settleReason.userCancel",
  ]) {
    const zh = zhCN[key];
    const en = enUS[key];
    assert.ok(zh, `中文缺 ${key}`);
    assert.ok(en, `英文缺 ${key}`);
    assert.equal(placeholders(zh), placeholders(en), `${key} 的占位符必须两语一致`);
  }
  assert.equal(zhCN["squad.agentDetail.runsOverflow"], undefined, "旧溢出文案必须删除（否则它在撒谎）");
  assert.equal(enUS["squad.agentDetail.runsOverflow"], undefined);
});
