import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { WakeRule } from "@zcode/shared";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  buildCreateWakeRuleInput,
  buildUpdateWakeRuleInput,
  wakeRuleDialogInitial,
  type CreateWakeRuleForm,
  type WakeRuleEditableForm,
} from "../src/squad/wakeRulesViewModel.js";

/* 「唤醒规则」的**编辑与删除**（第 41 轮）用例：纯逻辑 + 结构守卫（ui 包没有渲染测试设施，
   这是本项目既定做法，见 wakeRulesPage.test.ts / squadReassign.test.ts）。分工：
   ① `buildUpdateWakeRuleInput` 全格：三种 kind + mode 推导 + 每条 rejection（**与创建同一份
      校验核心**：行为等价在用例里直接对照产物）；产物逐键**不含 workItemId**、不含五个禁用词；
   ② `wakeRuleDialogInitial`：三种排班 kind 的初值映射 + at 的本地时区往返 + event 防御格 +
      at 上的陈旧 maxFires 不回填；
   ③ 结构守卫：行有编辑 / 删除钮（编辑**不被状态机门控**）；删除经 `requestConfirmation` +
      `confirmVariant: "destructive"` + **未确认提前返回** + 唯一调用点；编辑对话框工作项只读；
      `updateWakeRule(` 接线；对话框仍不执行服务调用；
   ④ i18n：新增键两语齐全、占位符齐备（{name} / {count}）。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");

/** 固定 `now`（本地 2026-10-04 12:00:00）：到点解析按本地时区，用例对时区无依赖。 */
const NOW = new Date(2026, 9, 4, 12, 0, 0, 0).getTime();

/** 编辑表单造例（只给要测的字段；其余空白）。 */
function form(overrides: Partial<WakeRuleEditableForm> = {}): WakeRuleEditableForm {
  return {
    kind: "at",
    atLocal: "",
    intervalSecondsText: "",
    cronExpression: "",
    maxFiresText: "",
    ...overrides,
  };
}

// ---------- ① buildUpdateWakeRuleInput：与创建同一口径 ----------

/* 三种 kind 各一格（含 **mode 推导**断言：at⇒once、every/cron⇒continuous）。
   变异（M4 的同族）：把推导写反（every⇒once）⇒ 第二格的 mode 断言必红。 */
test("编辑组装三种 kind：mode 由 kind 推导，字段各归各位（与创建同口径）", () => {
  const at = buildUpdateWakeRuleInput(form({ kind: "at", atLocal: "2026-10-04T13:00" }), NOW);
  assert.ok(at.ok, "合法 at 表单必须组装成功");
  assert.equal(at.patch.kind, "at");
  assert.equal(at.patch.mode, "once", "at 推导 once（validateWakeRule 互斥第 1 条）");
  assert.equal(at.patch.at, new Date(2026, 9, 4, 13, 0, 0, 0).getTime());
  assert.equal(at.patch.intervalSeconds, undefined);
  assert.equal(at.patch.cronExpression, undefined);

  const every = buildUpdateWakeRuleInput(form({ kind: "every", intervalSecondsText: " 60 " }), NOW);
  assert.ok(every.ok);
  assert.equal(every.patch.kind, "every");
  assert.equal(every.patch.mode, "continuous", "every 推导 continuous");
  assert.equal(every.patch.intervalSeconds, 60, "文本框原样收、组装时 trim + 解析");
  assert.equal(every.patch.at, undefined);
  assert.equal(every.patch.cronExpression, undefined);

  const cron = buildUpdateWakeRuleInput(form({ kind: "cron", cronExpression: " 0 9 * * * " }), NOW);
  assert.ok(cron.ok);
  assert.equal(cron.patch.kind, "cron");
  assert.equal(cron.patch.mode, "continuous", "cron 推导 continuous");
  assert.equal(cron.patch.cronExpression, "0 9 * * *");
  assert.equal(cron.patch.at, undefined);
  assert.equal(cron.patch.intervalSeconds, undefined);
});

/* 产物逐键（第 39 轮硬约束对编辑同样成立）：只有 kind / mode / 本 kind 的排期字段 /（可选）
   maxFires —— **不含 workItemId**（挂载对象不可改），也不含 timezone / expiresAt / condition /
   eventTypes / filters。
   变异（M2 的同族）：在 patch 里加 `workItemId`（或任一禁用字段）⇒ 本用例必红。 */
test("编辑产物逐键：不含 workItemId，也不含五个禁用字段（硬约束）", () => {
  const forbidden = ["workItemId", "timezone", "expiresAt", "condition", "eventTypes", "filters"];

  const bare = buildUpdateWakeRuleInput(form({ kind: "at", atLocal: "2026-10-04T13:00" }), NOW);
  assert.ok(bare.ok);
  assert.deepEqual(
    Object.keys(bare.patch).sort(),
    ["at", "kind", "mode"],
    "at 的 patch 键集必须恰是这三把（多一个就是混进了不该暴露的字段）",
  );

  const capped = buildUpdateWakeRuleInput(
    form({ kind: "every", intervalSecondsText: "30", maxFiresText: "50" }),
    NOW,
  );
  assert.ok(capped.ok);
  assert.deepEqual(Object.keys(capped.patch).sort(), [
    "intervalSeconds",
    "kind",
    "maxFires",
    "mode",
  ]);

  for (const result of [bare, capped]) {
    assert.ok(result.ok);
    for (const key of forbidden) {
      assert.ok(!(key in result.patch), `编辑产物不得含 ${key}`);
    }
  }
});

/* **校验核心单一来源**（规格硬要求）：同一条表单，创建的产物去掉 workItemId 必须与编辑的 patch
   **逐字段相等**（三种 kind 各验一遍）。若两处各写一份校验，字段默认值 / trim / 边界迟早分叉 ——
   而分叉不报错，只是「创建能过、编辑过不了」。变异：把编辑路径换成另一份实现 ⇒ 本用例必红。 */
test("校验单一来源：创建产物（去 workItemId）与编辑 patch 逐字段相等（三种 kind）", () => {
  const cases: CreateWakeRuleForm[] = [
    {
      workItemId: "w1",
      kind: "at",
      atLocal: "2026-10-04T13:00",
      intervalSecondsText: "",
      cronExpression: "",
      maxFiresText: "",
    },
    {
      workItemId: "w1",
      kind: "every",
      atLocal: "",
      intervalSecondsText: " 45 ",
      cronExpression: "",
      maxFiresText: " 20 ",
    },
    {
      workItemId: "w1",
      kind: "cron",
      atLocal: "",
      intervalSecondsText: "",
      cronExpression: " */5 * * * * ",
      maxFiresText: "",
    },
  ];
  for (const entry of cases) {
    const created = buildCreateWakeRuleInput(entry, NOW);
    const updated = buildUpdateWakeRuleInput(entry, NOW);
    assert.ok(created.ok && updated.ok, `${entry.kind}：两份都必须成功`);
    const { workItemId, ...fields } = created.input;
    assert.equal(workItemId, "w1", "创建产物带 workItemId");
    assert.deepEqual(fields, updated.patch, `${entry.kind}：同一份校验核心 ⇒ 产物一致`);
  }
});

/* 每条 rejection 与创建同一口径（同一份核心的**行为面**）：到点 / 间隔 / cron / 上限 / once 带上限。 */
test("编辑拒格：与创建同一批 reasonId（at / interval / cron / maxFires）", () => {
  for (const atLocal of ["", "2026-10-04T11:59", "2026-10-04T12:00", "2026-02-30T10:00"]) {
    const result = buildUpdateWakeRuleInput(form({ kind: "at", atLocal }), NOW);
    assert.ok(!result.ok, `at「${atLocal}」必须被拒`);
    assert.equal(result.reasonId, "squad.rules.invalid.at");
  }
  for (const intervalSecondsText of ["", "0", "-5", "1.5", "abc", "1e3"]) {
    const result = buildUpdateWakeRuleInput(form({ kind: "every", intervalSecondsText }), NOW);
    assert.ok(!result.ok);
    assert.equal(result.reasonId, "squad.rules.invalid.interval");
  }
  const cron = buildUpdateWakeRuleInput(form({ kind: "cron", cronExpression: "   " }), NOW);
  assert.ok(!cron.ok);
  assert.equal(cron.reasonId, "squad.rules.invalid.cron");
  for (const maxFiresText of ["0", "1001", "2.5"]) {
    const result = buildUpdateWakeRuleInput(
      form({ kind: "every", intervalSecondsText: "60", maxFiresText }),
      NOW,
    );
    assert.ok(!result.ok);
    assert.equal(result.reasonId, "squad.rules.invalid.maxFires");
  }
  const onceWithCap = buildUpdateWakeRuleInput(
    form({ kind: "at", atLocal: "2026-10-04T13:00", maxFiresText: "5" }),
    NOW,
  );
  assert.ok(!onceWithCap.ok, "once 没有上限语义 ⇒ 拒（validateWakeRule 互斥第 4 条）");
  assert.equal(onceWithCap.reasonId, "squad.rules.invalid.maxFires");
  // 边界通过格：证明上面的拒绝不是「永远拒」。
  assert.ok(buildUpdateWakeRuleInput(form({ kind: "every", intervalSecondsText: "1" }), NOW).ok);
});

// ---------- ② wakeRuleDialogInitial ----------

/** 造一条规则（只给初值映射关心的字段）。 */
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

/* 初值映射：三种排班 kind 的原值逐字段填回；`at` 按**本地时区**格式化（与解析侧对称）。
   变异：把 `at` 的格式化换成 UTC（toISOString）⇒ at 往返用例在非 UTC 环境下必红。 */
test("初值映射：三种 kind 的字段填回；at 本地时区往返", () => {
  const every = wakeRuleDialogInitial(wakeRule({ intervalSeconds: 60, maxFires: 50 }));
  assert.deepEqual(every, {
    workItemId: "w1",
    kind: "every",
    atLocal: "",
    intervalSecondsText: "60",
    cronExpression: "",
    maxFiresText: "50",
  });

  const cron = wakeRuleDialogInitial(
    wakeRule({ kind: "cron", intervalSeconds: undefined, cronExpression: "0 9 * * *" }),
  );
  assert.equal(cron.kind, "cron");
  assert.equal(cron.cronExpression, "0 9 * * *");
  assert.equal(cron.intervalSecondsText, "", "别的 kind 的字段留空（不与本 kind 的字段混装）");

  // at：本地时区的格式化必须能**往返**回同一个时刻（提交时再解析成 epoch ms）。
  const atTimestamp = new Date(2026, 9, 4, 13, 30, 0, 0).getTime();
  const at = wakeRuleDialogInitial(
    wakeRule({ kind: "at", mode: "once", at: atTimestamp, intervalSeconds: undefined }),
  );
  assert.equal(at.kind, "at");
  assert.equal(at.atLocal, "2026-10-04T13:30", "datetime-local 按本地时区格式化");
  assert.equal(at.maxFiresText, "", "at 没有上限语义，不回填 maxFires");
  const roundTrip = buildUpdateWakeRuleInput(at, NOW);
  assert.ok(roundTrip.ok, "初值原样提交必须合法（改一个字之前先能存回去）");
  assert.equal(roundTrip.patch.at, atTimestamp, "往返回同一个时刻（格式化与解析同一时区口径）");
});

/* 防御格（登记的行为）：库里出现 kind=event 的行（只能来自库外写入）⇒ 初值回落 at 且排期字段
   留空 —— 用户必须显式选一种触发方式并填好，绝不静默把它改写成某条排班规则。
   同时：at 行上若残留 maxFires（坏数据）也不回填（否则是看不见也改不掉的输入，下一次提交必败）。 */
test("初值映射（防御格）：event 行回落 at 空表单、不静默改写；at 行的陈旧 maxFires 不回填", () => {
  const event = wakeRuleDialogInitial(
    wakeRule({ kind: "event", intervalSeconds: undefined, maxFires: 20, nextFireAt: 1 }),
  );
  assert.equal(event.kind, "at");
  assert.deepEqual(
    [event.atLocal, event.intervalSecondsText, event.cronExpression],
    ["", "", ""],
    "排期字段留空：保存必须先是用户显式选定的触发方式",
  );
  const submittedAsIs = buildUpdateWakeRuleInput(event, NOW);
  assert.ok(!submittedAsIs.ok, "不填任何排期字段 ⇒ 表单拒绝（不会把 event 悄悄写成 at）");

  const atWithStaleCap = wakeRuleDialogInitial(
    wakeRule({
      kind: "at",
      mode: "once",
      at: NOW + 3_600_000,
      intervalSeconds: undefined,
      maxFires: 20,
    }),
  );
  assert.equal(
    atWithStaleCap.maxFiresText,
    "",
    "at 上残留的 maxFires 不回填（不可见也改不掉的输入必然失败）",
  );
});

// ---------- ③ 结构守卫（逐条可变异） ----------

/* 守卫 a：行**三件**动作齐全 —— 暂停 / 启用（状态机门控）+ **编辑 / 删除**（编辑不被门控：
   completed / unscheduled 正是要靠改配置救回来的那些）。次序：暂停 → 启用 → 编辑 → 删除。
   变异：删掉编辑或删除钮 ⇒ 必红；把编辑钮塞回 `rowState.` 条件里 ⇒ 第二断言必红。 */
test("守卫｜每行都有编辑 / 删除钮，且编辑**不被状态机门控**（所有行都给）", () => {
  const section = readSource("squad/WakeRulesSection.tsx");
  const pauseAt = section.indexOf('data-testid="rule-pause"');
  const resumeAt = section.indexOf('data-testid="rule-resume"');
  const editAt = section.indexOf('data-testid="rule-edit"');
  const deleteAt = section.indexOf('data-testid="rule-delete"');
  assert.ok(
    pauseAt >= 0 && resumeAt > pauseAt && editAt > resumeAt && deleteAt > editAt,
    "行内动作次序：暂停 → 启用 → 编辑 → 删除（编辑 / 删除在启停旁）",
  );
  // 编辑钮不得被任何状态机条件门控：resume 标签之后到编辑钮之间不得再出现 `{rowState.`。
  const between = section.slice(section.indexOf('t("squad.rules.resume")'), editAt);
  assert.ok(
    !between.includes("{rowState."),
    "编辑钮必须无条件渲染（completed / unscheduled 也要能改配置救回来）",
  );
  assert.ok(
    section.slice(editAt, editAt + 400).includes("setEditTarget(rule)"),
    "编辑钮打开本行的编辑对话框",
  );
  assert.ok(
    section.slice(deleteAt, deleteAt + 400).includes("requestDeleteRule(rule)"),
    "删除钮走二次确认入口（不直接调服务）",
  );
});

/* 守卫 b：删除**必须**二次确认，且**未确认 ⇒ 一个服务调用都不发**。
   次序：requestConfirmation → `if (!confirmed) return;` → 执行体（`deleteWakeRule(`）；
   且 `deleteWakeRule(` 全文件只有一个调用点（就在那条确认之后的路径上）。
   变异（M3）：把 `if (!confirmed) return;` 去掉（问了照做）⇒ 第二断言必红。 */
test("守卫｜删除经 requestConfirmation（destructive）+ 未确认提前返回 + 唯一调用点", () => {
  const section = readSource("squad/WakeRulesSection.tsx");
  assert.ok(section.includes("useConfirmDialogStore"), "走仓里既有的确认对话框单例");
  const confirmAt = section.indexOf("requestConfirmation({");
  /* 从确认处**向后**找提前返回：文档注释里也会引用这句（解释「执行体写在它之后」），
     从头 indexOf 会命中注释、把次序断言变成假红。 */
  const guardAt = section.indexOf("if (!confirmed) return;", confirmAt);
  const executeAt = section.indexOf(".deleteWakeRule(");
  assert.ok(confirmAt >= 0, "删除必须经二次确认");
  assert.ok(guardAt > confirmAt, "未确认 ⇒ 提前返回（在确认之后、执行之前）");
  assert.ok(executeAt > guardAt, "执行体在 `if (!confirmed) return;` 之后（未确认不碰服务）");
  assert.ok(
    section.includes('confirmVariant: "destructive"'),
    "删除确认是 destructive 变体（不可撤销的破坏性动作）",
  );
  assert.ok(
    section.includes('t("squad.rules.deleteConfirmDescription", { count: rule.fireCount })'),
    "确认文案必须带触发次数（说清「触发记录随规则一起删除」）",
  );
  assert.ok(
    section.includes('t("squad.rules.deleteConfirmTitle",'),
    "确认标题带宿主（规则没有名字，用挂载工作项的标题指认）",
  );
  assert.equal(
    (section.match(/\.deleteWakeRule\(/g) ?? []).length,
    1,
    "deleteWakeRule 只有一个调用点（未确认时「一个服务调用都不发」）",
  );
  // 删除成功 ⇒ toast + 重载（与别的写动作同款）。
  const callAt = section.indexOf(".deleteWakeRule(");
  assert.ok(section.slice(callAt).includes('messageId: "squad.rules.deleted"'), "删除成功 toast");
  assert.ok(section.slice(callAt).includes("await reload()"), "删除成功后重载列表");
});

/* 守卫 c：编辑接线 —— 分区调 `updateWakeRule`（唯一调用点），编辑对话框是**同一份表单**的
   edit 模式（工作项只读 + 初值 + 换标题 / 保存文案）。挂载点在 `WakeRuleDialogs`（400 行门槛的
   机械拆分，见该文件头注释）—— 「同一份表单」仍只指 `CreateWakeRuleDialog` 那一份。
   变异：把编辑对话框换成另写的一份表单（或漏了 mode/initial）⇒ 必红。 */
test("守卫｜编辑走 updateWakeRule，对话框是同一份表单的 edit 模式（工作项只读）", () => {
  const section = readSource("squad/WakeRulesSection.tsx");
  assert.equal(
    (section.match(/\.updateWakeRule\(/g) ?? []).length,
    1,
    "updateWakeRule 只有一个调用点（编辑对话框提交路径）",
  );
  assert.ok(section.includes('messageId: "squad.rules.updated"'), "编辑成功 toast");
  // 失败不关框（重试就在眼前）：错误分支里没有 setEditTarget(null)。
  const editFn = section.slice(section.indexOf("const submitEdit"));
  const catchBlock = editFn.slice(editFn.indexOf("catch (error)"), editFn.indexOf("} finally"));
  assert.ok(!catchBlock.includes("setEditTarget(null)"), "编辑失败不关对话框");

  const mounts = readSource("squad/WakeRuleDialogs.tsx");
  assert.ok(mounts.includes('mode="edit"'), "编辑对话框显式进 edit 模式");
  assert.ok(
    mounts.includes("initial={wakeRuleDialogInitial(editTarget)}"),
    "初值由纯函数从当时读到的实体映射（只有这一份映射）",
  );
  assert.ok(mounts.includes('titleId="squad.rules.editTitle"'), "编辑标题文案键");
  assert.ok(mounts.includes('submitLabelId="squad.common.save"'), "编辑提交 = 保存（复用既有键）");
  assert.equal(
    (mounts.match(/<CreateWakeRuleDialog/g) ?? []).length,
    2,
    "创建 / 编辑挂载的是**同一个**组件（两份表单在字段与校验上会陆续分叉）",
  );

  const dialog = readSource("squad/CreateWakeRuleDialog.tsx");
  assert.ok(dialog.includes("buildUpdateWakeRuleInput("), "编辑提交前经视图模型校验（同一份核心）");
  assert.ok(dialog.includes("squad.rules.hostLocked"), "编辑模式有工作项只读的说明行");
  assert.ok(
    /isEdit \? \([\s\S]{0,200}?disabled/.test(dialog),
    "编辑模式的工作项控件是 disabled（只读）",
  );
  assert.ok(!dialog.includes("updateWakeRule("), "对话框仍只回意图，不执行服务调用");
  assert.ok(
    !dialog.includes('"event"'),
    "kind 候选仍不得含 event（双引号字面量；注释用「event」措辞）",
  );
});

/* 守卫 d：i18n 新增键两语齐全 + 占位符齐备（{name} 在标题、{count} 在描述里 —— 缺了会渲染出裸
   占位符或丢信息）。 */
test("i18n：编辑 / 删除新键两语齐全，占位符 {name} / {count} 都在", () => {
  const keys = [
    "squad.rules.edit",
    "squad.rules.editTitle",
    "squad.rules.hostLocked",
    "squad.rules.updated",
    "squad.rules.delete",
    "squad.rules.deleteConfirmTitle",
    "squad.rules.deleteConfirmDescription",
    "squad.rules.deleted",
  ];
  for (const key of keys) {
    assert.ok((zhCN[key] ?? "").length > 0, `zh-CN 缺少 ${key}`);
    assert.ok((enUS[key] ?? "").length > 0, `en-US 缺少 ${key}`);
  }
  for (const [locale, name] of [[zhCN, "zh-CN"] as const, [enUS, "en-US"] as const]) {
    const message = (id: string) => locale[id] ?? "";
    assert.ok(
      message("squad.rules.deleteConfirmTitle").includes("{name}"),
      `${name} 删除标题缺 {name}（规则没有名字，用宿主标题指认）`,
    );
    assert.ok(
      message("squad.rules.deleteConfirmDescription").includes("{count}"),
      `${name} 删除描述缺 {count}（必须说清已触发 N 次会一起删）`,
    );
    const description = message("squad.rules.deleteConfirmDescription");
    assert.match(description, /不可撤销|cannot be undone/i, `${name} 必须写明不可撤销`);
    assert.ok(
      message("squad.rules.hostLocked").length > 0 &&
        /工作项|work item/i.test(message("squad.rules.hostLocked")),
      `${name} hostLocked 必须说明工作项不可改`,
    );
  }
});
