import assert from "node:assert/strict";
import test from "node:test";
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
