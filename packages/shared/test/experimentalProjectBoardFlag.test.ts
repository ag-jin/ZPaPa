import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsSchema, appSettingsPatchSchema } from "../src/validationAppSettings.js";

// 卡 #58（用户 2026-10-10 拍板「合进主线，功能作为可选」）：项目看板进实验功能开关，**默认关**。
// 期望值的独立真源：卡文验收第 (4) 条「默认关：全新配置/存量用户升级后入口不可见」。
// 存量升级的机器形态 = 已落盘的 setting.json 里没有这个键 ⇒ parse 必须给出 false（不是 undefined），
// 否则呈现判据（严格 === true）与「缺省关」会在类型面上分叉。

test("看板实验开关缺省为 false（全新配置）", () => {
  const parsed = appSettingsSchema.parse({});
  assert.equal(parsed.experimentalProjectBoardEnabled, false);
});

// 「存量用户升级」：旧设置文件里有别的键、没有本键 ⇒ 同一格必须落到 false。
test("存量设置缺本键时升级后为 false（入口不可见）", () => {
  const parsed = appSettingsSchema.parse({
    locale: "zh-CN",
    experimentalAgentSquadsEnabled: true,
  });
  assert.equal(parsed.experimentalProjectBoardEnabled, false);
});

test("看板实验开关可被显式打开", () => {
  const parsed = appSettingsSchema.parse({ experimentalProjectBoardEnabled: true });
  assert.equal(parsed.experimentalProjectBoardEnabled, true);
});

// 显式关闭是用户决定：任何缺省/迁移都不得把它翻回 true。
test("看板实验开关显式关闭保持 false", () => {
  const parsed = appSettingsSchema.parse({ experimentalProjectBoardEnabled: false });
  assert.equal(parsed.experimentalProjectBoardEnabled, false);
});

// patch 面少一处就会静默剥离该字段（表现为「拨开关没反应」）：断言键在解析后存活。
test("patch 面接受看板实验开关（键必须在解析后存活）", () => {
  const parsed = appSettingsPatchSchema.safeParse({ experimentalProjectBoardEnabled: true });
  assert.equal(parsed.success, true);
  assert.equal(
    parsed.success ? parsed.data.experimentalProjectBoardEnabled : undefined,
    true,
    "patch schema 必须保留 experimentalProjectBoardEnabled（两处 schema 面同步是既有纪律）",
  );
});

test("patch 面可显式关闭看板实验开关", () => {
  const parsed = appSettingsPatchSchema.safeParse({ experimentalProjectBoardEnabled: false });
  assert.equal(parsed.success, true);
  assert.equal(parsed.success ? parsed.data.experimentalProjectBoardEnabled : undefined, false);
});

// 持久化往返（写读一致）：写入的 patch 合并进完整快照、再经完整 schema（含 preprocess 迁移链）
// 解析回来必须仍是原值——任一方向的翻转都等于「开关自己变了」。
test("持久化往返：写入后的落盘快照重新解析保持原值（true / false 两向）", () => {
  const persist = (enabled: boolean) =>
    appSettingsSchema.parse({
      ...appSettingsSchema.parse({}),
      ...appSettingsPatchSchema.parse({ experimentalProjectBoardEnabled: enabled }),
    });
  assert.equal(persist(true).experimentalProjectBoardEnabled, true);
  assert.equal(persist(false).experimentalProjectBoardEnabled, false);
});
