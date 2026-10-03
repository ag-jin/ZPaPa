import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { WakeRule } from "@zcode/shared";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  WAKE_RULE_STATUS_BADGE_CLASSES,
  WAKE_RULE_STATUS_MESSAGE_IDS,
  buildCreateWakeRuleInput,
  formatWakeRuleTime,
  resolveWorkItemTitle,
  wakeRuleRowState,
  wakeRuleScheduleParts,
  type CreateWakeRuleForm,
  type WakeRuleRowStatus,
} from "../src/squad/wakeRulesViewModel.js";

/* 「唤醒规则」分区（WorkItemsPage 的 WakeRulesSection / CreateWakeRuleDialog）的用例：
   **纯逻辑 + 结构守卫**（ui 包没有渲染测试设施，这是本项目既定做法，见 inboxPage.test.ts /
   squadReassign.test.ts）。分工：
   ① `wakeRuleRowState` 全矩阵（五态 × 动作可用性，逐格；优先级专门一格）；
   ② `wakeRuleScheduleParts` 三格 + 坏数据格（缺字段 / 非有限数 / 非正间隔 / 空表达式 ⇒ null）；
   ③ `buildCreateWakeRuleInput` 全格（三种 kind + mode 推导；每条 rejection 各一格；产物逐键断言
      **不含** timezone / expiresAt / condition / eventTypes / filters —— 第 39 轮硬约束）；
   ④ 结构守卫：分区服务接线、表单**不得**出现五个禁用词、页面渲染分区、动作映射（对调 ⇒ 红）；
   ⑤ i18n：squad.rules.* 显式键清单两语齐全 + 占位符 + 「cron 会被拒」的语义写明。每条守卫都
      写明变异方式，并在交付报告里逐条实测。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");

/** 造一条规则（只给纯函数关心的字段）。 */
function wakeRule(overrides: Partial<WakeRule> = {}): WakeRule {
  return {
    id: "rule-1",
    workItemId: "w1",
    kind: "every",
    mode: "continuous",
    intervalSeconds: 60,
    fireCount: 0,
    revision: 0,
    enabled: true,
    ...overrides,
  };
}

// ---------- ① wakeRuleRowState 穷尽矩阵 ----------

/* 逐格矩阵：pausedReason × enabled × at-fired × nextFireAt 空 × 其余。
   变异（M3）：把 `pausedReason` 那一支删掉 ⇒ 前三格（gate_paused）必红（它们会掉进
   unscheduled / user_paused）。 */
test("行状态矩阵：五态逐格（闸停 > 用户暂停 > 已完成 > 未排期 > 在跑）", () => {
  const matrix: Array<{
    label: string;
    rule: Parameters<typeof wakeRuleRowState>[0];
    status: WakeRuleRowStatus;
    canPause: boolean;
    canResume: boolean;
  }> = [
    {
      label: "闸停（pausedReason 有值；真实形态：enabled=true + 排期空）",
      rule: wakeRule({
        pausedReason: "max_fires",
        kind: "every",
        nextFireAt: undefined,
        fireCount: 3,
      }),
      status: "gate_paused",
      canPause: false,
      canResume: true,
    },
    {
      label: "闸停 —— pausedReason **优先于** !enabled（人为改库：闸停又关了开关）",
      rule: wakeRule({ pausedReason: "rate", enabled: false, nextFireAt: undefined }),
      status: "gate_paused",
      canPause: false,
      canResume: true,
    },
    {
      label: "闸停 —— pausedReason **优先于** once 已触发（防失控闸停了一次性规则）",
      rule: wakeRule({ pausedReason: "loop", kind: "at", fireCount: 1, nextFireAt: undefined }),
      status: "gate_paused",
      canPause: false,
      canResume: true,
    },
    {
      label: "用户暂停（enabled=false = 我停的；排期同时被清）",
      rule: wakeRule({ enabled: false, nextFireAt: undefined }),
      status: "user_paused",
      canPause: false,
      canResume: true,
    },
    {
      label: "用户暂停 —— 优先于 once 已触发（先触发、后被人停）",
      rule: wakeRule({ kind: "at", fireCount: 2, enabled: false, nextFireAt: undefined }),
      status: "user_paused",
      canPause: false,
      canResume: true,
    },
    {
      label: "已完成（一次性规则触发过；真实形态：enabled=true + 排期空 + fireCount>0）",
      rule: wakeRule({ kind: "at", fireCount: 1, enabled: true, nextFireAt: undefined }),
      status: "completed",
      canPause: false,
      canResume: false,
    },
    {
      label: "未排期（防御格：坏数据 / 人为改库；服务面保证建/恢复都会排上）",
      rule: wakeRule({ kind: "at", fireCount: 0, enabled: true, nextFireAt: undefined }),
      status: "unscheduled",
      canPause: false,
      canResume: false,
    },
    {
      label: "未排期 —— 连续规则开关开着却没有排期点（同上，防御格）",
      rule: wakeRule({ kind: "every", fireCount: 2, enabled: true, nextFireAt: undefined }),
      status: "unscheduled",
      canPause: false,
      canResume: false,
    },
    {
      label: "在跑 —— 连续规则有排期点",
      rule: wakeRule({ kind: "every", fireCount: 2, enabled: true, nextFireAt: 123 }),
      status: "active",
      canPause: true,
      canResume: false,
    },
    {
      label: "在跑 —— 一次性规则尚未触发（有未来排期点）",
      rule: wakeRule({
        kind: "at",
        mode: "once",
        at: 999,
        fireCount: 0,
        enabled: true,
        nextFireAt: 999,
      }),
      status: "active",
      canPause: true,
      canResume: false,
    },
    {
      label: "在跑 —— cron 已触发过数次、排期还在推进",
      rule: wakeRule({
        kind: "cron",
        mode: "continuous",
        cronExpression: "0 9 * * *",
        fireCount: 5,
        enabled: true,
        nextFireAt: 456,
      }),
      status: "active",
      canPause: true,
      canResume: false,
    },
    {
      label: "在跑 —— 事件型（UI 不给入口，库里可能有；矩阵对它是防御性覆盖）",
      rule: wakeRule({
        kind: "event",
        mode: "continuous",
        intervalSeconds: undefined,
        fireCount: 0,
        enabled: true,
        nextFireAt: 789,
      }),
      status: "active",
      canPause: true,
      canResume: false,
    },
  ];

  for (const entry of matrix) {
    assert.deepEqual(
      wakeRuleRowState(entry.rule),
      { status: entry.status, canPause: entry.canPause, canResume: entry.canResume },
      entry.label,
    );
  }
});

/* 动作口径（独立一格，防被矩阵的 deepEqual 掩盖）：动作**只由状态决定**，不看别的字段 ——
   canPause 只在 active；canResume 只在两种暂停。变异：canPause 放宽成 `enabled` ⇒ 本格红。 */
test("行动作：暂停只在「在跑」给；恢复只在两种暂停给；completed / unscheduled 不给任何动作", () => {
  const statuses: WakeRuleRowStatus[] = [
    "active",
    "user_paused",
    "gate_paused",
    "completed",
    "unscheduled",
  ];
  const byStatus = (status: WakeRuleRowStatus) =>
    ({
      active: wakeRule({ nextFireAt: 1 }),
      user_paused: wakeRule({ enabled: false, nextFireAt: undefined }),
      gate_paused: wakeRule({ pausedReason: "rate", nextFireAt: undefined }),
      completed: wakeRule({ kind: "at", fireCount: 1, nextFireAt: undefined }),
      unscheduled: wakeRule({ nextFireAt: undefined }),
    })[status];
  for (const status of statuses) {
    const state = wakeRuleRowState(byStatus(status));
    assert.equal(state.status, status, "造例自检：这一格的输入必须落在该状态上");
    assert.equal(state.canPause, status === "active", `${status} 的 canPause`);
    assert.equal(
      state.canResume,
      status === "user_paused" || status === "gate_paused",
      `${status} 的 canResume（completed/unscheduled 不给动作：重算没有未来排期点 ⇒ 服务面会响亮拒）`,
    );
  }
});

// ---------- ② wakeRuleScheduleParts（三格 + 坏数据格） ----------

/* 三格：kind 各带自己的字段 → 只搬事实。坏数据格：缺字段 / 非有限数（`Intl.DateTimeFormat`
   遇 NaN 会抛，直接把渲染炸掉）/ 非正间隔（「每 0 秒」是假话）/ 空表达式 / event ⇒ null
   （列表显示中性「配置缺失」，不把坏数据渲染成假话、也不让一条坏行炸掉整段列表）。 */
test("排期事实投影：三格只搬事实；坏数据（缺字段 / 非有限 / 非正 / 空串 / event）⇒ null", () => {
  assert.deepEqual(
    wakeRuleScheduleParts({ kind: "at", at: 123, intervalSeconds: 9, cronExpression: "x" }),
    {
      kind: "at",
      at: 123,
    },
  );
  assert.deepEqual(
    wakeRuleScheduleParts({ kind: "every", intervalSeconds: 30, at: 1, cronExpression: "x" }),
    { kind: "every", intervalSeconds: 30 },
  );
  assert.deepEqual(
    wakeRuleScheduleParts({ kind: "cron", cronExpression: "0 9 * * *", at: 1, intervalSeconds: 9 }),
    { kind: "cron", cronExpression: "0 9 * * *" },
  );

  const broken: Array<[string, Parameters<typeof wakeRuleScheduleParts>[0]]> = [
    ["at 缺字段", { kind: "at", at: undefined }],
    ["at 非有限数", { kind: "at", at: Number.NaN }],
    ["every 缺字段", { kind: "every", intervalSeconds: undefined }],
    ["every 非正", { kind: "every", intervalSeconds: 0 }],
    ["every 负数", { kind: "every", intervalSeconds: -5 }],
    ["every 非有限数", { kind: "every", intervalSeconds: Number.POSITIVE_INFINITY }],
    ["cron 缺字段", { kind: "cron", cronExpression: undefined }],
    ["cron 空串", { kind: "cron", cronExpression: "   " }],
    ["event（UI 不给入口；本层渲染不出排期描述）", { kind: "event" }],
  ];
  for (const [label, input] of broken) {
    assert.equal(wakeRuleScheduleParts(input), null, `${label} ⇒ null（列表显示「配置缺失」）`);
  }
});

test("行标题：查得到用标题、查不到回落 id（已归档 / 快照过期时不显示空）", () => {
  const items = [{ id: "w1", title: "标题一" }];
  assert.equal(resolveWorkItemTitle(items, "w1"), "标题一");
  assert.equal(resolveWorkItemTitle(items, "gone"), "gone");
});

test("时间格式：本地时区 + 两语都带年（不渲染 NaN、不抛）", () => {
  const timestamp = new Date(2026, 9, 4, 13, 30, 0).getTime();
  const zh = formatWakeRuleTime(timestamp, "zh-CN");
  const en = formatWakeRuleTime(timestamp, "en-US");
  assert.ok(zh.includes("2026"), `zh 应含年份：${zh}`);
  assert.ok(en.includes("2026"), `en 应含年份：${en}`);
  assert.ok(zh.length > 0 && en.length > 0);
});

// ---------- ③ buildCreateWakeRuleInput ----------

/** 表单造例（只给要测的字段；其余空白）。 */
function form(overrides: Partial<CreateWakeRuleForm> = {}): CreateWakeRuleForm {
  return {
    workItemId: "w1",
    kind: "at",
    atLocal: "",
    intervalSecondsText: "",
    cronExpression: "",
    maxFiresText: "",
    ...overrides,
  };
}

/** 固定 `now`（本地 2026-10-04 12:00:00）：到点解析按本地时区，用例对时区无依赖。 */
const NOW = new Date(2026, 9, 4, 12, 0, 0, 0).getTime();

/* 三种 kind 各一格（含 **mode 推导**断言：at⇒once、every/cron⇒continuous）。
   变异（M2）：把推导写反（every⇒once）⇒ 第二格的 mode 断言必红。 */
test("组装三种 kind：mode 由 kind 推导（at⇒once；every/cron⇒continuous），字段各归各位", () => {
  const at = buildCreateWakeRuleInput(form({ kind: "at", atLocal: "2026-10-04T13:00" }), NOW);
  assert.ok(at.ok, "合法 at 表单必须组装成功");
  assert.equal(at.input.kind, "at");
  assert.equal(at.input.mode, "once", "at 推导 once（validateWakeRule 互斥第 1 条）");
  assert.equal(at.input.at, new Date(2026, 9, 4, 13, 0, 0, 0).getTime());
  assert.equal(at.input.intervalSeconds, undefined);
  assert.equal(at.input.cronExpression, undefined);

  const every = buildCreateWakeRuleInput(form({ kind: "every", intervalSecondsText: " 60 " }), NOW);
  assert.ok(every.ok);
  assert.equal(every.input.kind, "every");
  assert.equal(every.input.mode, "continuous", "every 推导 continuous");
  assert.equal(every.input.intervalSeconds, 60, "文本框原样收、组装时 trim + 解析");
  assert.equal(every.input.at, undefined);
  assert.equal(every.input.cronExpression, undefined);

  const cron = buildCreateWakeRuleInput(form({ kind: "cron", cronExpression: " 0 9 * * * " }), NOW);
  assert.ok(cron.ok);
  assert.equal(cron.input.kind, "cron");
  assert.equal(cron.input.mode, "continuous", "cron 推导 continuous");
  assert.equal(cron.input.cronExpression, "0 9 * * *");
  assert.equal(cron.input.at, undefined);
  assert.equal(cron.input.intervalSeconds, undefined);
});

/* 产物**逐键断言**（第 39 轮硬约束）：只有 workItemId / kind / mode / 本 kind 的排期字段 /
   （可选）maxFires —— `timezone` / `expiresAt` / `condition` / `eventTypes` / `filters`
   一个都不许出现（运行期混键也拦住：组装是逐字段显式构造）。
   变异（M1 的同族）：在产物里加 `timezone: "Asia/Shanghai"` ⇒ 本用例必红。 */
test("产物逐键：不含 timezone / expiresAt / condition / eventTypes / filters（硬约束）", () => {
  const forbidden = ["timezone", "expiresAt", "condition", "eventTypes", "filters"];

  const bare = buildCreateWakeRuleInput(form({ kind: "at", atLocal: "2026-10-04T13:00" }), NOW);
  assert.ok(bare.ok);
  assert.deepEqual(
    Object.keys(bare.input).sort(),
    ["at", "kind", "mode", "workItemId"],
    "at 的产物键集必须恰是这四把（多一个就是混进了不该暴露的字段）",
  );

  const capped = buildCreateWakeRuleInput(
    form({ kind: "every", intervalSecondsText: "30", maxFiresText: "50" }),
    NOW,
  );
  assert.ok(capped.ok);
  assert.deepEqual(Object.keys(capped.input).sort(), [
    "intervalSeconds",
    "kind",
    "maxFires",
    "mode",
    "workItemId",
  ]);

  for (const result of [bare, capped]) {
    assert.ok(result.ok);
    for (const key of forbidden) {
      assert.ok(!(key in result.input), `产物不得含 ${key}（第 39 轮硬约束：界面不暴露）`);
    }
  }
});

/* 到点时刻：必须**严格晚于 now**（否则建成即过点 ⇒ 服务面响亮拒）——UI 先给可读 reasonId。
   四格：已过 / 恰好等于 / 空 / 日历上不存在的日期。变异：把 `at <= now` 放宽成 `<`（等于放行）
   ⇒ 第二格必红。 */
test("at 拒格：过去 / 恰好等于 now / 空 / 不存在的日期 ⇒ ok:false + invalid.at", () => {
  const rejected: Array<[string, string]> = [
    ["已过", "2026-10-04T11:59"],
    ["恰好等于 now（必须严格晚于）", "2026-10-04T12:00"],
    ["空", ""],
    ["日历上不存在的日期", "2026-02-30T10:00"],
    ["形状坏", "2026/10/05 10:00"],
  ];
  for (const [label, atLocal] of rejected) {
    const result = buildCreateWakeRuleInput(form({ kind: "at", atLocal }), NOW);
    assert.ok(!result.ok, `${label} ⇒ 必须被拒（不把必然失败递上去）`);
    assert.equal(result.reasonId, "squad.rules.invalid.at", `${label} 的 reasonId`);
  }
  // 边界通过格：晚一分钟是合法的（证明上一格的拒绝不是「永远拒」）。
  const ok = buildCreateWakeRuleInput(form({ kind: "at", atLocal: "2026-10-04T12:01" }), NOW);
  assert.ok(ok.ok);
});

/* 间隔：必须正整数 —— 空 / 0 / 负 / 小数 / 非数 / 科学计数法一律拒（与其猜意图，不如让他重输）。 */
test("间隔拒格：空 / 0 / 负 / 小数 / 非数 ⇒ ok:false + invalid.interval", () => {
  for (const intervalSecondsText of ["", "   ", "0", "-5", "1.5", "abc", "1e3", "1,000"]) {
    const result = buildCreateWakeRuleInput(form({ kind: "every", intervalSecondsText }), NOW);
    assert.ok(!result.ok, `「${intervalSecondsText}」必须被拒`);
    assert.equal(result.reasonId, "squad.rules.invalid.interval");
  }
  const ok = buildCreateWakeRuleInput(form({ kind: "every", intervalSecondsText: "86400" }), NOW);
  assert.ok(ok.ok, "正整数通过");
});

test("cron 拒格：空白表达式 ⇒ ok:false + invalid.cron；非空通过（有无未来命中归服务面判）", () => {
  const rejected = buildCreateWakeRuleInput(form({ kind: "cron", cronExpression: "   " }), NOW);
  assert.ok(!rejected.ok);
  assert.equal(rejected.reasonId, "squad.rules.invalid.cron");
  const ok = buildCreateWakeRuleInput(form({ kind: "cron", cronExpression: "*/5 * * * *" }), NOW);
  assert.ok(ok.ok);
});

/* 上限：空白 = 不传（产物里**没有这个键**）；越界（0 / 1001 / 非整数 / 非数）⇒ 拒；
   一次性 kind 带上限 ⇒ 拒（validateWakeRule 互斥第 4 条；不让必然失败出门）。
   变异：把范围检查 1..1000 删掉 ⇒ 第二格（1001）必红。 */
test("上限：空白不传；1..1000 之外拒；once（at）带上限拒", () => {
  const blank = buildCreateWakeRuleInput(form({ kind: "every", intervalSecondsText: "60" }), NOW);
  assert.ok(blank.ok);
  assert.ok(!("maxFires" in blank.input), "空白可选字段必须**不传**（不是传 undefined 键）");

  for (const maxFiresText of ["0", "1001", "2.5", "abc", "-3"]) {
    const result = buildCreateWakeRuleInput(
      form({ kind: "every", intervalSecondsText: "60", maxFiresText }),
      NOW,
    );
    assert.ok(!result.ok, `上限「${maxFiresText}」必须被拒`);
    assert.equal(result.reasonId, "squad.rules.invalid.maxFires");
  }
  for (const maxFiresText of ["1", "1000"]) {
    const result = buildCreateWakeRuleInput(
      form({ kind: "every", intervalSecondsText: "60", maxFiresText }),
      NOW,
    );
    assert.ok(result.ok, `上限「${maxFiresText}」是边界内合法值`);
    assert.equal(result.ok && result.input.maxFires, Number(maxFiresText));
  }

  const onceWithCap = buildCreateWakeRuleInput(
    form({ kind: "at", atLocal: "2026-10-04T13:00", maxFiresText: "5" }),
    NOW,
  );
  assert.ok(!onceWithCap.ok, "once 没有上限语义（maxFires 只在 continuous 有效）⇒ 拒");
  assert.equal(onceWithCap.reasonId, "squad.rules.invalid.maxFires");
});

test("宿主拒格：空 / 空白 workItemId ⇒ ok:false + invalid.workItem", () => {
  for (const workItemId of ["", "   "]) {
    const result = buildCreateWakeRuleInput(form({ workItemId, atLocal: "2026-10-04T13:00" }), NOW);
    assert.ok(!result.ok);
    assert.equal(result.reasonId, "squad.rules.invalid.workItem");
  }
});

// ---------- ④ 结构守卫（逐条可变异） ----------

/* 守卫 a：分区自含取数与写动作 —— 取数经响亮通路（`resolveSquadRuntimeService`），
  四个服务调用齐全。变异：删任一调用（或改直读 `services.squadRuntimeService`）⇒ 必红。 */
test("守卫｜WakeRulesSection 经响亮取数通路，四个服务调用齐全", () => {
  const section = readSource("squad/WakeRulesSection.tsx");
  assert.ok(
    section.includes("resolveSquadRuntimeService("),
    "取数必须经 resolveSquadRuntimeService",
  );
  assert.ok(
    !section.includes("services.squadRuntimeService"),
    "分区不得直接读 services.squadRuntimeService（那条路会把「服务没接上」静默成 undefined）",
  );
  for (const call of ["listWakeRules(", "createWakeRule(", "pauseWakeRule(", "resumeWakeRule("]) {
    assert.ok(section.includes(call), `分区必须接上 ${call}（缺一个就是缺一件功能）`);
  }
  // 失败不吞：既有翻译 + 原始 detail 经 notify 透出。
  assert.ok(section.includes("squadEntryErrorFeedback("), "失败经既有翻译（含门禁拒绝，不吞错）");
  assert.ok(section.includes("squadServiceUnavailableFeedback("), "服务没接上单列文案");
  assert.ok(section.includes('messageId: "squad.rules.created"'), "创建成功 toast");
  // 创建成功 ⇒ 重载列表（刷新失败不清空已有列表）。
  const createAt = section.indexOf("createWakeRule(");
  const reloadAfterCreate = section.indexOf("await reload()", createAt);
  assert.ok(reloadAfterCreate > createAt, "创建成功后必须重载列表");
});

/* 守卫 b：**表单源码**不得出现五个禁用词（第 39 轮硬约束：timezone / expiresAt 调度侧未消费、
condition / eventTypes / filters 需未枚举的事件词汇表）。
   变异（M1）：在 CreateWakeRuleDialog 里加一个 `timezone` 输入（或任何一处出现该词）⇒ 必红。
   说明：守卫只扫**表单文件**（合规注释会提到这些词 —— 如视图模型的头注解释为什么不做它们 ——
   注释不是输入口）；产物侧的硬约束由「产物逐键」用例覆盖。 */
test("守卫｜表单源码不出现 timezone / expiresAt / condition / eventTypes / filters", () => {
  const dialog = readSource("squad/CreateWakeRuleDialog.tsx");
  for (const word of ["timezone", "expiresAt", "condition", "eventTypes", "filters"]) {
    assert.ok(
      !dialog.includes(word),
      `表单源码不得出现「${word}」：界面不暴露（第 39 轮硬约束；变异：加一个 ${word} 输入即红）`,
    );
  }
  // 表单只收三种排班 kind（类型上就没有 event —— 事件型规则需要未枚举的词汇表）。
  assert.ok(
    dialog.includes('const WAKE_RULE_FORM_KINDS = ["at", "every", "cron"] as const'),
    "kind 只有三种排班",
  );
  assert.ok(!dialog.includes('"event"'), "kind 候选不得含 event");
});

/* 守卫 c：页面渲染分区（在 SquadRunsReview **之后**），并把工作项投影给它。
   变异：删 `<WakeRulesSection` ⇒ 第一断言必红；把它挪到 SquadRunsReview 之前 ⇒ 顺序断言必红。 */
test("守卫｜WorkItemsPage 在 SquadRunsReview 之后渲染 WakeRulesSection（工作项投影）", () => {
  const page = readSource("squad/WorkItemsPage.tsx");
  const sectionAt = page.indexOf("<WakeRulesSection");
  const reviewAt = page.indexOf("<SquadRunsReview");
  assert.ok(sectionAt >= 0, "页面必须渲染 WakeRulesSection（§11.1「项目窗口 ▸ 规则」的承诺）");
  assert.ok(reviewAt >= 0 && sectionAt > reviewAt, "次序：看板 → 待收尾运行 → 唤醒规则");
  assert.ok(
    page.includes("workItems={state.snapshot.workItems}"),
    "工作项（行标题 + 宿主候选）由页面投影",
  );
  assert.ok(page.includes("workspacePath={workspacePath}"), "目标 workspace 由页面透传（不另造）");
});

/* 守卫 d：动作映射 —— 暂停钮走 pauseWakeRule、启用钮走 resumeWakeRule。
   变异（M4）：把执行点里的三元映射对调（pause 支调 resumeWakeRule）⇒ 映射断言必红；
   把两个按钮的动作名对调 ⇒ 按钮断言必红。 */
test("守卫｜暂停钮走 pauseWakeRule、启用钮走 resumeWakeRule（对调 ⇒ 红）", () => {
  const section = readSource("squad/WakeRulesSection.tsx");

  // 按钮只在纯函数判据的条件下给（在跑才可暂停；两种暂停都可恢复）。
  const pauseGate = section.indexOf("{rowState.canPause ? (");
  const pauseButton = section.indexOf('data-testid="rule-pause"');
  const resumeGate = section.indexOf("{rowState.canResume ? (");
  const resumeButton = section.indexOf('data-testid="rule-resume"');
  assert.ok(
    pauseGate >= 0 && pauseButton > pauseGate,
    "暂停钮必须在 canPause 条件下（判据走纯函数）",
  );
  assert.ok(resumeGate >= 0 && resumeButton > resumeGate, "启用钮必须在 canResume 条件下");
  // 按钮把动作名交给唯一执行点；busy（写动作单飞）期间禁用。
  assert.ok(
    section.slice(pauseButton, pauseButton + 600).includes('runRuleAction(rule.id, "pause")'),
    '暂停钮必须交动作名 "pause"',
  );
  assert.ok(
    section.slice(resumeButton, resumeButton + 600).includes('runRuleAction(rule.id, "resume")'),
    '启用钮必须交动作名 "resume"',
  );
  assert.ok(
    section.slice(pauseButton, pauseButton + 600).includes("disabled={writing}"),
    "在飞期间暂停钮禁用",
  );

  // 唯一执行点里的三元映射：`action === "pause"` 在前、pauseWakeRule 在其后、resumeWakeRule 再后。
  const mapping = section.indexOf('action === "pause"');
  const pauseCall = section.indexOf("service.pauseWakeRule(");
  const resumeCall = section.indexOf("service.resumeWakeRule(");
  assert.ok(mapping >= 0, "执行点必须有 action 判据");
  assert.ok(pauseCall > mapping, 'pauseWakeRule 必须挂在 action === "pause" 支上（对调 ⇒ 红）');
  assert.ok(resumeCall > pauseCall, "resumeWakeRule 在另一支（两处对调 ⇒ 红）");
  assert.ok(section.includes("busyRuleId !== null"), "执行点必须有前置挡重（与按钮禁用同一判据）");
});

/* 守卫 e：分区四态 testid 齐全 + 行锚点 + 徽标/排期/上限都走纯函数（本层只照结论画）。 */
test("守卫｜分区四态锚点齐全、行锚点与 testid 不得改名", () => {
  const section = readSource("squad/WakeRulesSection.tsx");
  for (const testid of [
    'data-testid="squad-rules-section"',
    'data-testid="squad-rules-refresh"',
    'data-testid="squad-rules-create"',
    'data-testid="squad-rules-loading"',
    'data-testid="squad-rules-error"',
    'data-testid="squad-rules-empty"',
    'data-testid="squad-rules-list"',
  ]) {
    assert.ok(section.includes(testid), `${testid} 不得缺（四态齐全 + 锚点）`);
  }
  assert.ok(section.includes("data-rule-id"), "行上要有 data-rule-id");
  assert.ok(section.includes("wakeRuleRowState("), "状态/行动作必须走纯函数 wakeRuleRowState");
  assert.ok(
    section.includes("wakeRuleScheduleParts("),
    "排期描述必须走纯函数 wakeRuleScheduleParts",
  );
  assert.ok(section.includes("resolveWorkItemTitle("), "行标题查工作项（查不到回落 id）走纯函数");
  assert.ok(section.includes("WAKE_RULE_STATUS_BADGE_CLASSES"), "状态徽标用语义色 token 表");
  assert.ok(
    section.includes("rule.maxFires !== undefined"),
    "有显式上限才显示 fireCount / maxFires",
  );
});

/* 守卫 f：对话框只收集 + 校验 + 回意图 —— 不执行任何服务调用（照 ReassignWorkItemDialog）。
   变异：在对话框里直接调 createWakeRule ⇒ 第二断言必红。 */
test("守卫｜CreateWakeRuleDialog 经 buildCreateWakeRuleInput 校验、不执行服务调用", () => {
  const dialog = readSource("squad/CreateWakeRuleDialog.tsx");
  assert.ok(dialog.includes("buildCreateWakeRuleInput("), "提交前必须经视图模型校验");
  assert.ok(!dialog.includes("createWakeRule("), "对话框只回意图，不执行服务调用");
  assert.ok(!dialog.includes("resolveSquadRuntimeService("), "对话框不碰服务通路");
  assert.ok(dialog.includes("<CreateDialogShell"), "复用 squadDialogParts 的对话框壳");
  assert.ok(dialog.includes("<Field"), "复用 Field 原语");
  assert.ok(dialog.includes('titleId="squad.rules.createTitle"'), "标题文案键");
  // 校验不过 ⇒ **就地**显示 reasonId 文案（不调服务）。
  assert.ok(dialog.includes("setReasonId(result.reasonId)"), "校验不过就地显示 reasonId");
  // kind 切换清掉上一类字段（防混装；切进 at 连上限一起清 —— 否则留下不可见也改不掉的输入）。
  const changeKind = dialog.slice(dialog.indexOf("const changeKind"));
  for (const setter of ['setAtLocal("")', 'setIntervalSecondsText("")', 'setCronExpression("")']) {
    assert.ok(changeKind.includes(setter), `kind 切换必须清 ${setter}`);
  }
  assert.ok(
    changeKind.includes('if (next === "at") setMaxFiresText("")'),
    "切进 at 必须一并清上限（once 没有上限语义）",
  );
});

// ---------- ⑤ 文案表与 i18n ----------

test("状态文案与徽标：键集 = 五态、文案 id 前缀正确、配色只用语义色 token", () => {
  const statuses: WakeRuleRowStatus[] = [
    "active",
    "user_paused",
    "gate_paused",
    "completed",
    "unscheduled",
  ];
  assert.deepEqual(Object.keys(WAKE_RULE_STATUS_MESSAGE_IDS).sort(), [...statuses].sort());
  assert.deepEqual(Object.keys(WAKE_RULE_STATUS_BADGE_CLASSES).sort(), [...statuses].sort());
  // 状态名（下划线）→ 文案 id（camelCase 段）的对照显式写出：改名即红。
  const expectedIds: Record<WakeRuleRowStatus, string> = {
    active: "squad.rules.status.active",
    user_paused: "squad.rules.status.userPaused",
    gate_paused: "squad.rules.status.gatePaused",
    completed: "squad.rules.status.completed",
    unscheduled: "squad.rules.status.unscheduled",
  };
  for (const status of statuses) {
    assert.equal(WAKE_RULE_STATUS_MESSAGE_IDS[status], expectedIds[status]);
    const className = WAKE_RULE_STATUS_BADGE_CLASSES[status];
    assert.ok(
      !/-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d/.test(
        className,
      ),
      `${status} 用了九色板（状态不靠随手挑的颜色编码）：${className}`,
    );
    assert.ok(
      /(success|warning|muted|foreground|destructive)/.test(className),
      `${status} 必须用语义色 token：${className}`,
    );
  }
});

/* spec §11.4：所有新文案必须两语齐全，只写一种语言时另一种语言直接显示裸 key。
   显式键清单：`squad.` 前缀的命名空间级齐平由 squadsPage.test.ts 覆盖，这里钉住本轮的**键集本身**
   （清单遗漏 = 漏翻；多出清单外的 squad.rules.* = 没进过文案走查）。 */
const SQUAD_RULES_KEYS = [
  "squad.rules.title",
  "squad.rules.empty",
  "squad.rules.emptyHint",
  "squad.rules.create",
  "squad.rules.createTitle",
  "squad.rules.createHint",
  "squad.rules.workItem",
  "squad.rules.kind.at",
  "squad.rules.kind.every",
  "squad.rules.kind.cron",
  "squad.rules.kindHint.at",
  "squad.rules.kindHint.every",
  "squad.rules.kindHint.cron",
  "squad.rules.atTime",
  "squad.rules.intervalSeconds",
  "squad.rules.cronExpression",
  "squad.rules.maxFires",
  "squad.rules.fireProgress",
  "squad.rules.status.active",
  "squad.rules.status.userPaused",
  "squad.rules.status.gatePaused",
  "squad.rules.status.completed",
  "squad.rules.status.unscheduled",
  "squad.rules.pause",
  "squad.rules.resume",
  "squad.rules.paused",
  "squad.rules.resumed",
  "squad.rules.created",
  "squad.rules.loading",
  "squad.rules.loadFailed",
  "squad.rules.schedule.at",
  "squad.rules.schedule.every",
  "squad.rules.schedule.cron",
  "squad.rules.invalid.workItem",
  "squad.rules.invalid.at",
  "squad.rules.invalid.interval",
  "squad.rules.invalid.cron",
  "squad.rules.invalid.maxFires",
  "squad.rules.configMissing",
  "squad.rules.noWorkItemsHint",
];

test("i18n：squad.rules.* 显式键清单两语齐全，且命名空间里没有清单外的键", () => {
  for (const key of SQUAD_RULES_KEYS) {
    assert.ok((zhCN[key] ?? "").length > 0, `zh-CN 缺少 ${key}`);
    assert.ok((enUS[key] ?? "").length > 0, `en-US 缺少 ${key}`);
  }
  const localeKeys = (locale: Record<string, string>) =>
    Object.keys(locale).filter((key) => key.startsWith("squad.rules."));
  for (const [name, locale] of [["zh-CN", zhCN] as const, ["en-US", enUS] as const]) {
    assert.deepEqual(
      [...localeKeys(locale)].sort(),
      [...SQUAD_RULES_KEYS].sort(),
      `${name} 的 squad.rules.* 键集必须与显式清单一致`,
    );
  }
  // 复用的既有键必须在（刷新 / 取消 / 创建 / 无工作区 / 操作失败 / 服务未接上 / 实验已关闭）。
  for (const key of [
    "squad.common.refresh",
    "squad.common.cancel",
    "squad.common.submit",
    "squad.common.noWorkspace",
    "squad.common.operationFailed",
    "squad.common.serviceUnavailable",
    "squad.common.experimentOff",
  ]) {
    assert.ok(zhCN[key] && enUS[key], `复用键 ${key} 必须两语都在`);
  }
});

test("i18n：占位符齐备；kindHint.cron 必须写明「会被拒绝」（无未来命中是拒因，不是随便写）", () => {
  for (const [locale, name] of [[zhCN, "zh-CN"] as const, [enUS, "en-US"] as const]) {
    const message = (id: string) => locale[id] ?? "";
    assert.ok(
      message("squad.rules.fireProgress").includes("{count}"),
      `${name} fireProgress 缺 {count}`,
    );
    assert.ok(
      message("squad.rules.fireProgress").includes("{max}"),
      `${name} fireProgress 缺 {max}`,
    );
    assert.ok(
      message("squad.rules.schedule.at").includes("{time}"),
      `${name} schedule.at 缺 {time}`,
    );
    assert.ok(
      message("squad.rules.schedule.every").includes("{seconds}"),
      `${name} schedule.every 缺 {seconds}`,
    );
    assert.ok(
      message("squad.rules.schedule.cron").includes("{expression}"),
      `${name} schedule.cron 缺 {expression}`,
    );
  }
  assert.ok(
    (zhCN["squad.rules.kindHint.cron"] ?? "").includes("拒绝"),
    "zh kindHint.cron 必须写明表达式没有未来命中会被拒绝",
  );
  assert.ok(
    (enUS["squad.rules.kindHint.cron"] ?? "").toLowerCase().includes("rejected"),
    "en kindHint.cron must say it is rejected",
  );
});

/* 守卫（controller 审查发现项）：无工作项时「新建规则」置灰，**且给出可见原因** ——
   通用 hint 那句「点新建规则选一条工作项」在按钮点不动时是空话。
   变异：去掉 `workItems.length === 0` 的定向 hint（或去掉按钮的置灰条件）⇒ 本守卫必红。 */
test("守卫｜无工作项：按钮置灰 + 空态改用定向指引（置灰必须有可见原因）", () => {
  const section = readSource("squad/WakeRulesSection.tsx");
  // 必须是**条件句**：`workItems.length === 0 ? 定向指引 : 通用指引` ——
  // 只断言"两个字符串都在文件里"挡不住「无条件显示定向指引 / 顺序写反」这类变形
  // （我第一版就是这么写的，实测挡不住一个把 hint 改成无条件拼接的变异）。
  assert.match(
    section,
    /workItems\.length === 0[\s\S]{0,80}?t\("squad\.rules\.noWorkItemsHint"\)/,
    "无工作项时必须以条件句改用定向指引（不是无条件显示、也不是那句点不动的「点新建规则」）",
  );
  // 按钮的禁用条件里必须仍有「无工作项」这一项：置灰的原因与指引文案是同一件事的两半。
  assert.match(
    section,
    /disabled=\{[^}]*workItems\.length === 0[^}]*\}/,
    "「新建规则」钮必须仍含 `workItems.length === 0` 的禁用条件（无工作项 ⇒ 建不出规则）",
  );
  const zh = readSource("i18n/locales/zh-CN.ts");
  const en = readSource("i18n/locales/en-US.ts");
  assert.ok(zh.includes('"squad.rules.noWorkItemsHint"'), "zh-CN 缺定向指引文案");
  assert.ok(en.includes('"squad.rules.noWorkItemsHint"'), "en-US 缺定向指引文案");
});
