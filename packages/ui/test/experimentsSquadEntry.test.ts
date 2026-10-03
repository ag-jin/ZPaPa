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
test("最小视图文案两语齐全", () => {
  for (const key of [
    "settings.experiments.squad.viewTitle",
    "settings.experiments.squad.teamAgents",
    "settings.experiments.squad.squads",
    "settings.experiments.squad.workItems",
    "settings.experiments.squad.createTeamAgent",
    "settings.experiments.squad.createSquad",
    "settings.experiments.squad.createWorkItem",
    "settings.experiments.squad.review.approve",
    "settings.experiments.squad.review.reject",
    "settings.experiments.squad.loopHint",
  ]) {
    assert.ok(zhCN[key], `zh-CN 缺少 ${key}`);
    assert.ok(enUS[key], `en-US 缺少 ${key}`);
  }
});

// 上面那份清单是**起步时**的十个键；视图落地后文案会继续长。逐条补清单必然漏，
// 所以再加一道**命名空间级**对照：`settings.experiments.` 下的键在两侧必须完全一致。
test("实验分区文案在命名空间级别两语齐平", () => {
  const prefix = "settings.experiments.";
  const keysWithPrefix = (locale: Record<string, string>) =>
    Object.keys(locale).filter((key) => key.startsWith(prefix));
  const zhKeys = new Set(keysWithPrefix(zhCN));
  const enKeys = new Set(keysWithPrefix(enUS));

  for (const key of zhKeys) assert.ok(enKeys.has(key), `en-US 缺少 ${key}`);
  for (const key of enKeys) assert.ok(zhKeys.has(key), `zh-CN 缺少 ${key}`);

  // 前缀写错时上面两条会退化成空断言（0 == 0 也算通过）。钉一个下限，让「一条都没比到」变红。
  assert.ok(zhKeys.size > 20, `settings.experiments.* 只比到 ${zhKeys.size} 条，前缀可能写错了`);
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
