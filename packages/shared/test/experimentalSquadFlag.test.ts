import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsSchema, appSettingsPatchSchema } from "../src/validationAppSettings.js";

// 缺省必须是 false：不显式打开就不应启用实验功能。
test("实验开关缺省为 false", () => {
  const parsed = appSettingsSchema.parse({});
  assert.equal(parsed.experimentalAgentSquadsEnabled, false);
});

test("实验开关可被显式打开", () => {
  const parsed = appSettingsSchema.parse({ experimentalAgentSquadsEnabled: true });
  assert.equal(parsed.experimentalAgentSquadsEnabled, true);
});

// patch 少一处就会静默剥离该字段，表现为「拨开关没反应」——必须断言键在解析后存活，
// 否则裸 z.object 会剥离未知键，让 success 永远为 true。
test("patch 接受实验开关（键必须在解析后存活）", () => {
  const parsed = appSettingsPatchSchema.safeParse({ experimentalAgentSquadsEnabled: true });
  assert.equal(parsed.success, true);
  assert.equal(parsed.success ? parsed.data.experimentalAgentSquadsEnabled : undefined, true);
});
