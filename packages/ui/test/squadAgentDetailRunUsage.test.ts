import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { SquadRunRecord } from "@zcode/services";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { runUsageLabel } from "../src/squad/squadRunHistoryViewModel.js";

/* agent 详情页运行区「用量」一格（CT.3，#6 按 run 记账）的 UI 用例。

   **分档的唯一判据是 `usage_recorded_at`，不是数字本身**（CT.1 冻结语义）：
   NULL = 未记录（没有会话 / 补拉没成功）⇒ **不渲染该格**；0 = 跑过但零消耗 ⇒ 渲染 `0`。
   渲染 0 会把「没记账」伪装成「没花用量」——本文件第一条用例就是钉这件事。

   ui 包没有渲染测试设施（本域既定做法，见 `squadRunHistoryPaging.test.ts`）：可判逻辑全部
   收敛到 `runUsageLabel` 纯函数，组件层只留结构守卫（testid / 门控 / 不做格式化）。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");

type UsageFields = Pick<
  SquadRunRecord,
  "usageRecordedAt" | "usageTotalTokens" | "usageReasoningTokens"
>;

/** 造一条带用量列的 run 行（其余字段只给渲染路径关心的）。 */
const runWithUsage = (usage: UsageFields): SquadRunRecord => ({
  runId: "run-1",
  workspaceKey: "ws",
  workspacePath: "/tmp/ws",
  workItemId: "wi",
  parentWorkItemId: "wi",
  agentId: "ta-1",
  isLeaderTask: false,
  branch: "squad/run-1",
  dirName: "run-1",
  status: "merged",
  sessionId: "sess-1",
  dispatchCause: null,
  causedByRunId: null,
  ...usage,
  createdAt: 1,
  updatedAt: 1,
});

// ---------- ① 未记录（NULL）⇒ 不渲染 ----------

/* 变异（P1）：未记录显示 0 ⇒ 本用例必红。
   `usage_recorded_at` 是 CT.1 冻结的**存在性开关**：它才是「有没有记账」的判据。
   `usageTotalTokens: 0` 那一格故意给「像 0 的数字」，证明实现只认开关、不看数字。 */
test("未记录（usage_recorded_at 为 NULL）⇒ null（不渲染该格，不是显示 0）", () => {
  assert.equal(
    runUsageLabel(
      runWithUsage({ usageRecordedAt: null, usageTotalTokens: null, usageReasoningTokens: null }),
      "zh-CN",
    ),
    null,
    "未记录 ⇒ 无文案（界面整块不渲染）",
  );
  assert.equal(
    runUsageLabel(
      runWithUsage({ usageRecordedAt: null, usageTotalTokens: 0, usageReasoningTokens: 0 }),
      "zh-CN",
    ),
    null,
    "NULL ≠ 0：开关为 NULL 时即使数值列是 0 也不得渲染（否则把「没记账」伪装成「没消耗」）",
  );
});

// ---------- ② 已记录：0 是事实 ----------

/* 变异（P1 的另一半）：已记录但总数为 0 也整块不渲染（把「零消耗」当成「没记账」）⇒ 本用例必红。
   这一格是上一条的**反面**：同样读到 0 这个数字，开关不同 ⇒ 呈现不同。 */
test("已记录且总数为 0 ⇒ 渲染 0（与「未记录」逐格可区分）", () => {
  assert.deepEqual(
    runUsageLabel(
      runWithUsage({
        usageRecordedAt: 1_700_000_000_000,
        usageTotalTokens: 0,
        usageReasoningTokens: 0,
      }),
      "zh-CN",
    ),
    { total: "0", reasoning: null },
    "0 是「跑过但没消耗」的事实，必须渲染（且无分解：推理也是 0）",
  );
});

// ---------- ③ 分解：total + reasoning（Q6 直裁的 v1 冻结格） ----------

/* 变异（分解字段缺失）：只说 total、丢掉 reasoning ⇒ 本用例必红。
   分解走 `formatCompactTokenNumber` **同一个单源**（与 total 同一份格式化实现，不另写一份）。 */
test("已记录且有推理 ⇒ total 与 reasoning 各自紧凑格式化（中英各自口径）", () => {
  const run = runWithUsage({
    usageRecordedAt: 1_700_000_000_000,
    usageTotalTokens: 12_345,
    usageReasoningTokens: 678,
  });
  assert.deepEqual(
    runUsageLabel(run, "en-US"),
    { total: "12.3K", reasoning: "678" },
    "英文紧凑口径（CLDR：12345 → 12.3K）",
  );
  assert.deepEqual(
    runUsageLabel(run, "zh-CN"),
    { total: "1.2万", reasoning: "678" },
    "中文紧凑口径（CLDR：12345 → 1.2万）——两语各自格式化，不是把英文串抄一遍",
  );
});

// ---------- ④ 边界：分解只在真有时给出；「已记录但没有数字」不猜 0 ----------

/* 变异：
   · 去掉 `reasoning > 0` 闸 ⇒ 第一条断言红（界面会出现「含推理 0」这种噪音，且把「无分解」
     与「零推理」两件事混成一句）；
   · 把「已记录但没有总数」折成 0（`?? 0`）⇒ 第二、三条断言红（NULL ≠ 0 的同一条纪律：
     没有数字就是没有数字，不编一个 0 顶上）。 */
test("边界：推理为 0 不给分解；开关已记但数值缺席（含字段整体缺席）⇒ 仍不渲染", () => {
  assert.deepEqual(
    runUsageLabel(
      runWithUsage({
        usageRecordedAt: 1_700_000_000_000,
        usageTotalTokens: 12_345,
        usageReasoningTokens: 0,
      }),
      "en-US",
    ),
    { total: "12.3K", reasoning: null },
    "推理为 0 ⇒ 无分解（不渲染「含推理 0」）",
  );
  assert.equal(
    runUsageLabel(
      runWithUsage({
        usageRecordedAt: 1_700_000_000_000,
        usageTotalTokens: null,
        usageReasoningTokens: null,
      }),
      "en-US",
    ),
    null,
    "9 列同写同读 ⇒ 这一格只可能出自绕过 recordUsage 的行字面量：没有可诚实显示的总数就不渲染",
  );
  assert.equal(
    runUsageLabel({}, "en-US"),
    null,
    "加列之前的遗留行字面量（字段整体缺席）⇒ 未记录，不渲染",
  );
});

// ---------- ⑤ 组件：行里加一格，门控在纯函数上 ----------

/* 变异：
   · 组件里直接读 `run.usageTotalTokens ?? 0` 自己判档 ⇒ 第一条断言红（判据在纯函数里，组件只消费）；
   · 未记录时渲染占位（如「—」）而不是不渲染 ⇒ 第二条断言红；
   · 组件里自己格式化（`toLocaleString` / 手写 1000 进制）⇒ 第三、四条断言红；
   · 顺手直连用量查询面（`getTaskTokenUsage`）⇒ 第五条断言红：数据只能来自既有 `listSquadRunHistory`。 */
test("守卫｜运行行的用量格：门控在 runUsageLabel 上、单点渲染、组件不做数字格式化", () => {
  const page = readSource("squad/SquadAgentDetailPage.tsx");
  assert.ok(page.includes("runUsageLabel("), "用量呈现必须经纯函数（组件不自己判档/取数）");
  assert.match(
    page,
    /usage === null \? null :/,
    "未记录（null）⇒ 整块不渲染（不是渲染占位符：那会把「没记账」说成一句话）",
  );
  assert.ok(page.includes('data-testid="squad-agent-detail-run-usage"'), "用量格 testid");
  assert.equal(
    [...page.matchAll(/data-testid="squad-agent-detail-run-usage"/g)].length,
    1,
    "行渲染单点：用量格只在唯一的 run 行渲染处出现一次",
  );
  assert.ok(
    !page.includes("formatCompactTokenNumber") && !page.includes("toLocaleString"),
    "组件不做数字格式化（格式化只经纯函数，单源）",
  );
  assert.ok(!/\/\s*1000/.test(page), "组件不得手写 1000 进制换算");
  assert.ok(
    !page.includes("getTaskTokenUsage"),
    "界面不得直连用量查询面：数据来自既有 listSquadRunHistory（本卡零新取数通路）",
  );
});

test("守卫｜纯函数文件内 NULL 不得折成 0（无 `?? 0` / `|| 0`）", () => {
  const viewModel = readSource("squad/squadRunHistoryViewModel.ts");
  assert.ok(
    !/\?\?\s*0\b/.test(viewModel),
    "`?? 0` 会把「未记录」折成「零消耗」（NULL ≠ 0 单点纪律）",
  );
  assert.ok(!/\|\|\s*0\b/.test(viewModel), "`|| 0` 同款：0 与 NULL 是两件事");
});

// ---------- ⑥ i18n：两语成对（含占位符一致） ----------

/* 变异（P3）：只加中文键（漏英文）⇒ 第一条必红；某一侧占位符拼错（`{totals}`）⇒ 第二条必红
   （`formatMessage` 只替换对得上名字的占位符，剩下的花括号会原样显示给用户）。
   另注：`squad.` 前缀的**键集齐平**由 `squadAgentsPage.test.ts` / `squadsPage.test.ts` 的既有守卫
   兜底（本文件只补占位符一致这一条）。 */
test("i18n：用量文案两语成对，占位符逐键一致", () => {
  const placeholdersOf = (value: string) =>
    [...value.matchAll(/\{(\w+)\}/g)]
      .map((match) => match[1])
      .sort()
      .join(",");
  for (const key of [
    "squad.agentDetail.runUsage.total",
    "squad.agentDetail.runUsage.totalWithReasoning",
  ]) {
    assert.ok(zhCN[key], `zh-CN 缺 ${key}`);
    assert.ok(enUS[key], `en-US 缺 ${key}`);
    assert.equal(placeholdersOf(zhCN[key] ?? ""), placeholdersOf(enUS[key] ?? ""), `${key} 占位符`);
  }
  assert.equal(placeholdersOf(zhCN["squad.agentDetail.runUsage.total"] ?? ""), "total");
  assert.equal(
    placeholdersOf(zhCN["squad.agentDetail.runUsage.totalWithReasoning"] ?? ""),
    "reasoning,total",
    "带分解的文案必须同时带两个占位符（漏一个 ⇒ 用户看到原始花括号）",
  );
});
