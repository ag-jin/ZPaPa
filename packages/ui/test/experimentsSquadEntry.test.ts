import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsSchema } from "@zcode/shared";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { squadEntryVisible } from "../src/settings/squadEntry/squadEntryVisibility.js";

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
