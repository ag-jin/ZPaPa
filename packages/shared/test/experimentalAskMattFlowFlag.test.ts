import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsSchema, appSettingsPatchSchema } from "../src/validationAppSettings.js";

// 卡 #202（A1）：设置·实验功能第二行「ask-matt 开发流程」的顶层 flag，**默认关**。
// 期望值的独立真源：卡文——纯开关先行，默认关；呈现侧判据严格 === true 才可见。
// 双 schema 登记是既有纪律（experimentalProjectBoardEnabled 先例）：对象面缺省落 false，
// patch 面缺一处键就会被 zod 静默剥掉（表现为「拨开关没反应」）。

test("ask-matt 流程开关缺省为 false（全新配置）", () => {
  const parsed = appSettingsSchema.parse({});
  assert.equal(parsed.experimentalAskMattFlowEnabled, false);
});

// 「存量用户升级」：旧设置文件里有别的键、没有本键 ⇒ 同一格必须落到 false。
test("存量设置缺本键时升级后为 false", () => {
  const parsed = appSettingsSchema.parse({
    locale: "zh-CN",
    memoryEnabled: true,
  });
  assert.equal(parsed.experimentalAskMattFlowEnabled, false);
});

test("ask-matt 流程开关可被显式打开", () => {
  const parsed = appSettingsSchema.parse({ experimentalAskMattFlowEnabled: true });
  assert.equal(parsed.experimentalAskMattFlowEnabled, true);
});

// 显式关闭是用户决定：任何缺省/迁移都不得把它翻回 true。
test("ask-matt 流程开关显式关闭保持 false", () => {
  const parsed = appSettingsSchema.parse({ experimentalAskMattFlowEnabled: false });
  assert.equal(parsed.experimentalAskMattFlowEnabled, false);
});

// patch 面少一处就会静默剥离该字段：断言键在解析后存活（开/关两向）。
test("patch 面接受 ask-matt 流程开关（键必须在解析后存活）", () => {
  const enabled = appSettingsPatchSchema.safeParse({ experimentalAskMattFlowEnabled: true });
  assert.equal(enabled.success, true);
  assert.equal(
    enabled.success ? enabled.data.experimentalAskMattFlowEnabled : undefined,
    true,
    "patch schema 必须保留 experimentalAskMattFlowEnabled（两处 schema 面同步是既有纪律）",
  );

  const disabled = appSettingsPatchSchema.safeParse({ experimentalAskMattFlowEnabled: false });
  assert.equal(disabled.success, true);
  assert.equal(disabled.success ? disabled.data.experimentalAskMattFlowEnabled : undefined, false);
});

// 持久化往返（写读一致）：写入的 patch 合并进完整快照、再经完整 schema（含 preprocess 迁移链）
// 解析回来必须仍是原值——任一方向的翻转都等于「开关自己变了」。
test("持久化往返：写入后的落盘快照重新解析保持原值（true / false 两向）", () => {
  const persist = (enabled: boolean) =>
    appSettingsSchema.parse({
      ...appSettingsSchema.parse({}),
      ...appSettingsPatchSchema.parse({ experimentalAskMattFlowEnabled: enabled }),
    });
  assert.equal(persist(true).experimentalAskMattFlowEnabled, true);
  assert.equal(persist(false).experimentalAskMattFlowEnabled, false);
});

// 两个实验开关相互独立：看板开关的值不得被本键的缺省或读写带着走（乘积态四格的前提）。
test("两个实验开关互不影响：看板开关不随 ask-matt 流程开关写入而变", () => {
  const parsed = appSettingsSchema.parse({ experimentalProjectBoardEnabled: true });
  assert.equal(parsed.experimentalProjectBoardEnabled, true);
  assert.equal(parsed.experimentalAskMattFlowEnabled, false);
});
