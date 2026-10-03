import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsSchema } from "@zcode/shared";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { squadEntryVisible } from "../src/squad/squadEntryVisibility.js";

// spec §12 / §16 S8（口径即 §5.7 第 6 项「关闭实验开关」）：关闭实验 ⇒ 入口**整体消失**
// （不是灰掉、不是报错页），且**不影响**现有 subagent / automation 的任何界面。
// 注意：这只是**显隐呈现**，不是门禁 —— 门禁是服务层单点 ISquadRuntimeService.assertDispatchEnabled。
test("开关关闭时入口不可见", () => {
  assert.equal(squadEntryVisible({ experimentalAgentSquadsEnabled: false }), false);
  assert.equal(squadEntryVisible({}), false);
  assert.equal(squadEntryVisible(null), false);
});

test("开关打开时入口可见", () => {
  assert.equal(squadEntryVisible({ experimentalAgentSquadsEnabled: true }), true);
});

// 穷举矩阵「settings 快照 = 完整」那一格：判据吃的就是**真设置对象**（不是测试假造的小对象）。
// 用校验器产出的默认 AppSettings 钉住「默认关闭 ⇒ 入口不可见」——spec §12 的「运行期开关」
// 要求默认不启用；若哪天默认值被改成 true，这条会红，而不是入口悄悄自己冒出来。
test("校验器产出的默认设置下入口不可见", () => {
  const defaults = appSettingsSchema.parse({});
  assert.equal(defaults.experimentalAgentSquadsEnabled, false);
  assert.equal(squadEntryVisible(defaults), false);
});

// spec §11.4：所有新文案必须两语齐全，只写一种语言时另一种语言直接显示裸 key。
// 2026-10-03：清单随「工作项」面落地换成该面的承重文案（旧的最小视图已退役）；
// 逐条清单只钉**承重项**，命名空间级的齐平由下面那条对照兜底。
test("工作项面文案两语齐全", () => {
  for (const key of [
    "workspace.openWorkItems",
    "squad.common.settingsMovedHint",
    "squad.workItems.create",
    "squad.workItems.created",
    "squad.workItems.updated",
    "squad.workItems.editTitle",
    "squad.workItems.loading",
    "squad.workItems.loadFailed",
    "squad.workItems.empty",
    "squad.workItems.emptyHint",
    "squad.runs.title",
    "squad.runs.empty",
    "squad.runs.approve",
    "squad.runs.reject",
    "squad.runs.openSession",
    "squad.discard.action",
  ]) {
    assert.ok(zhCN[key], `zh-CN 缺少 ${key}`);
    assert.ok(enUS[key], `en-US 缺少 ${key}`);
  }
});

// 上面那份清单是**起步**清单；视图落地后文案会继续长。逐条补清单必然漏，
// 所以再加一道**命名空间级**对照：`settings.experiments.` 下的键在两侧必须完全一致。
//
// 2026-10-03 重算（B6 的守卫要求）：`settings.experiments.squad.*` 整批改名到 `squad.*`
// （旧键删净），本命名空间**只剩确数 4 条**：总开关的 label / description、开关失败提示、
// 分区标题。下限断言必须跟着重算成**确数**（空断言不算数）：写死这 4 条键名，
// 多一条（例如旧键复活）或少一条都红。
test("实验分区文案在命名空间级别两语齐平（只剩确数 4 条）", () => {
  const prefix = "settings.experiments.";
  const keysWithPrefix = (locale: Record<string, string>) =>
    Object.keys(locale).filter((key) => key.startsWith(prefix));
  const zhKeys = new Set(keysWithPrefix(zhCN));
  const enKeys = new Set(keysWithPrefix(enUS));

  for (const key of zhKeys) assert.ok(enKeys.has(key), `en-US 缺少 ${key}`);
  for (const key of enKeys) assert.ok(zhKeys.has(key), `zh-CN 缺少 ${key}`);

  const expected = [
    "settings.experiments.saveFailed",
    "settings.experiments.squadToggle.description",
    "settings.experiments.squadToggle.label",
    "settings.experiments.title",
  ];
  assert.deepEqual([...zhKeys].sort(), expected, "zh-CN 的 settings.experiments.* 应恰为这 4 条");
  assert.deepEqual([...enKeys].sort(), expected, "en-US 的 settings.experiments.* 应恰为这 4 条");
});

// 旧命名空间**一条都不剩**（改名后不留孤儿）：`settings.experiments.squad.` 前缀在两侧
// 都必须是 0 条。变异（U5：旧键复活）：往任一 locale 加回一条旧键 ⇒ 本用例必红。
// 注意 `settings.experiments.squadToggle.*` 不在该前缀内（它在 `squadToggle.` 上），保留。
test("旧命名空间 settings.experiments.squad. 一条都不剩（两语）", () => {
  const oldPrefix = "settings.experiments.squad.";
  const zhOld = Object.keys(zhCN).filter((key) => key.startsWith(oldPrefix));
  const enOld = Object.keys(enUS).filter((key) => key.startsWith(oldPrefix));
  assert.deepEqual(zhOld, [], `zh-CN 仍残留旧键：${zhOld.join(", ")}`);
  assert.deepEqual(enOld, [], `en-US 仍残留旧键：${enOld.join(", ")}`);
  // 开关键（不在旧前缀内）必须还在：收尾不是把开关删了。
  assert.ok(enUS["settings.experiments.squadToggle.label"], "总开关文案不得随改名消失");
});

// 占位符也要成对：只译一侧或写错占位符名，用户会直接看到原始 `{count}`。
test("实验分区文案的占位符两语一致", () => {
  const placeholdersOf = (value: string) =>
    [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const key of Object.keys(zhCN).filter((k) => k.startsWith("settings.experiments."))) {
    const zhValue = zhCN[key];
    const enValue = enUS[key];
    assert.ok(zhValue, `zh-CN 缺少 ${key}`);
    assert.ok(enValue, `en-US 缺少 ${key}`);
    assert.deepEqual(placeholdersOf(enValue), placeholdersOf(zhValue), `${key} 的占位符不一致`);
  }
});
