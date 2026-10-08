import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { SquadRunRecord } from "@zcode/services";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { runUsageLabel } from "../src/squad/squadRunHistoryViewModel.js";

/* CT.V（#6 成本记账线整线独立复验）—— **CT.3 呈现面** 独立矩阵（不复用实现者用例 / 期望值）。

   判据只有一个：`usage_recorded_at`（存在性开关）。三种形态各自可观察：
   · NULL ⇒ `null`（界面整块不渲染 —— 不显示 0、不显示占位符）；
   · 已记录 0 ⇒ 渲染 `0`（「跑过但没消耗」是事实）；
   · 已记录 > 0 ⇒ 紧凑格式（期望值取 CLDR 既定输出，硬编码，不按实现重算）。

   组件层（`SquadAgentDetailPage.tsx`）没有渲染测试设施（本域既定做法）⇒ 只用**结构断言**：
   门控纯函数、单点渲染、不做数字格式化、不新增取数通路。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

type UsageShape = Pick<
  SquadRunRecord,
  "usageRecordedAt" | "usageTotalTokens" | "usageReasoningTokens"
>;

/** 只给用量相关字段的形态（其余字段与呈现判档无关；类型上借用 SquadRunRecord 的键）。 */
const shape = (usage: UsageShape): UsageShape => usage;

test("未记录（开关 NULL）：无论数字是 null 还是 0，一律 null（不渲染，不折成 0）", () => {
  assert.equal(
    runUsageLabel(
      shape({ usageRecordedAt: null, usageTotalTokens: null, usageReasoningTokens: null }),
      "zh-CN",
    ),
    null,
  );
  assert.equal(
    runUsageLabel(
      shape({ usageRecordedAt: null, usageTotalTokens: 0, usageReasoningTokens: 0 }),
      "zh-CN",
    ),
    null,
    "关键格：数字是 0 但开关 NULL ⇒ 仍不渲染（否则把「没记账」伪装成「没消耗」）",
  );
  // 加列之前的遗留行字面量：字段整体缺席（undefined）同样按未记录处置。
  assert.equal(runUsageLabel(shape({} as UsageShape), "en-US"), null);
});

test('已记录：total=0 渲染 "0"（与未记录逐格可区分）；total>0 走紧凑格式（CLDR 既定输出）', () => {
  const at = 1_764_000_000_000;
  assert.deepEqual(
    runUsageLabel(
      shape({ usageRecordedAt: at, usageTotalTokens: 0, usageReasoningTokens: 0 }),
      "en-US",
    ),
    { total: "0", reasoning: null },
    "零消耗是事实：显示 0，且推理为 0 时不给分解",
  );
  assert.deepEqual(
    runUsageLabel(
      shape({ usageRecordedAt: at, usageTotalTokens: 12_345, usageReasoningTokens: 678 }),
      "en-US",
    ),
    { total: "12.3K", reasoning: "678" },
    "en-US：12345 → 12.3K",
  );
  assert.deepEqual(
    runUsageLabel(
      shape({ usageRecordedAt: at, usageTotalTokens: 12_345, usageReasoningTokens: 678 }),
      "zh-CN",
    ),
    { total: "1.2万", reasoning: "678" },
    "zh-CN：12345 → 1.2万（两语各自口径）",
  );
  // 边界：紧凑阈值两侧（en-US 1000 起单位；zh-CN 1000 仍是普通数字）。
  assert.deepEqual(
    runUsageLabel(
      shape({ usageRecordedAt: at, usageTotalTokens: 999, usageReasoningTokens: 0 }),
      "en-US",
    ),
    { total: "999", reasoning: null },
  );
  assert.deepEqual(
    runUsageLabel(
      shape({ usageRecordedAt: at, usageTotalTokens: 1000, usageReasoningTokens: 0 }),
      "en-US",
    ),
    { total: "1K", reasoning: null },
  );
});

test("边界：已记录但总数缺席（null / undefined / 非有限数）⇒ null，不猜 0", () => {
  const at = 1_764_000_000_000;
  assert.equal(
    runUsageLabel(
      shape({ usageRecordedAt: at, usageTotalTokens: null, usageReasoningTokens: 5 }),
      "zh-CN",
    ),
    null,
    "开关说已记录但总数不是数字（只可能出自绕过 recordUsage 的行字面量）⇒ 不渲染半个数字",
  );
  assert.equal(
    runUsageLabel(shape({ usageRecordedAt: at, usageTotalTokens: undefined }), "zh-CN"),
    null,
  );
  assert.equal(
    runUsageLabel(shape({ usageRecordedAt: at, usageTotalTokens: Number.NaN }), "zh-CN"),
    null,
  );
});

test("边界：推理为 0 / 缺席 / 非有限数都不给分解；推理 > 0 才分解", () => {
  const at = 1_764_000_000_000;
  for (const reasoning of [0, null, undefined, Number.NaN]) {
    assert.deepEqual(
      runUsageLabel(
        shape({ usageRecordedAt: at, usageTotalTokens: 42, usageReasoningTokens: reasoning }),
        "en-US",
      ),
      { total: "42", reasoning: null },
      `reasoning=${String(reasoning)} ⇒ 无分解（不出现「含推理 0」的噪音）`,
    );
  }
  assert.deepEqual(
    runUsageLabel(
      shape({ usageRecordedAt: at, usageTotalTokens: 42, usageReasoningTokens: 7 }),
      "en-US",
    ),
    { total: "42", reasoning: "7" },
  );
});

test("组件结构（无渲染设施域）：门控在纯函数、单点 testid、不做数字格式化、零新取数通路", () => {
  const page = readFileSync(resolve(SRC_DIR, "squad/SquadAgentDetailPage.tsx"), "utf8");
  const viewModel = readFileSync(resolve(SRC_DIR, "squad/squadRunHistoryViewModel.ts"), "utf8");

  assert.ok(page.includes("runUsageLabel(run, locale)"), "判档必须走纯函数（组件不自判）");
  assert.equal(
    page.split('data-testid="squad-agent-detail-run-usage"').length - 1,
    1,
    "用量格行渲染单点（恰一处 testid）",
  );
  assert.match(page, /usage === null \? null :/, "未记录 ⇒ 整块不渲染（不是占位符）");
  for (const forbidden of ["formatCompactTokenNumber", "toLocaleString"]) {
    assert.equal(page.includes(forbidden), false, `组件不得做数字格式化（${forbidden}）`);
  }
  assert.equal(
    page.includes("getTaskTokenUsage"),
    false,
    "界面不得直连用量查询面（数据来自既有读取面）",
  );
  for (const bad of [/\?\?\s*0\b/, /\|\|\s*0\b/]) {
    assert.equal(bad.test(viewModel), false, "纯函数内 NULL 不得折成 0");
  }
});

test("i18n 成对：两条用量文案键在 zh/en 都存在、占位符逐键一致", () => {
  for (const key of [
    "squad.agentDetail.runUsage.total",
    "squad.agentDetail.runUsage.totalWithReasoning",
  ]) {
    const zh = zhCN[key];
    const en = enUS[key];
    assert.ok(zh, `zh-CN 缺 ${key}`);
    assert.ok(en, `en-US 缺 ${key}`);
    const placeholders = (value: string) =>
      [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    assert.deepEqual(placeholders(zh), placeholders(en), `${key} 两语占位符必须一致`);
  }
  assert.deepEqual(
    [...(zhCN["squad.agentDetail.runUsage.totalWithReasoning"] ?? "").matchAll(/\{(\w+)\}/g)]
      .map((match) => match[1])
      .sort(),
    ["reasoning", "total"],
    "分解文案必须同时带 total 与 reasoning（少一个 ⇒ 用户看到原始花括号）",
  );
});
