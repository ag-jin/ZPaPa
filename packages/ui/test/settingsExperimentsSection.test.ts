import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { isSettingsSectionEnabled, type SettingsSectionId } from "../src/lib/settingsNavigation.js";
import { SETTINGS_SECTIONS } from "../src/settings/settingsPageConfig.js";

// 实验分区必须是「运行期可见」的普通分区：若被放进 HIDDEN_SETTINGS_SECTIONS，
// 用户永远看不到入口，实验功能等于无法开启。
test("实验分区默认可见", () => {
  const id: SettingsSectionId = "experiments";
  assert.equal(isSettingsSectionEnabled(id), true);
});

test("实验分区在设置配置里注册", () => {
  assert.ok(SETTINGS_SECTIONS.some((section) => section.id === "experiments"));
});

// 开关写入失败要给用户可见反馈，其提示文案必须两语齐全：只写一种语言时，
// 另一种语言下会直接显示裸 key（settings.experiments.saveFailed）。
test("实验开关的文案两语齐全", () => {
  for (const key of [
    "settings.experiments.title",
    "settings.experiments.squadToggle.label",
    "settings.experiments.squadToggle.description",
    "settings.experiments.saveFailed",
  ]) {
    assert.ok(zhCN[key], `zh-CN 缺少 ${key}`);
    assert.ok(enUS[key], `en-US 缺少 ${key}`);
  }
});
