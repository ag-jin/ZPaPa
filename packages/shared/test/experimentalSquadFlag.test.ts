import assert from "node:assert/strict";
import test from "node:test";
import { IS_ZCODE_PRODUCT_FLAVOR_INJECTED } from "../src/env.js";
import {
  appSettingsSchema,
  appSettingsPatchSchema,
  resolveExperimentalAgentSquadsDefault,
} from "../src/validationAppSettings.js";

// 缺省在未注入 flavor define 的环境（node:test/web/CLI）必须保持 false：
// 只有真注入了身份的桌面构建才允许按渠道取默认（A1 方案的注入门控）。
test("实验开关缺省为 false（未注入环境的回退缺省）", () => {
  const parsed = appSettingsSchema.parse({});
  assert.equal(parsed.experimentalAgentSquadsEnabled, false);
});

test("实验开关可被显式打开", () => {
  const parsed = appSettingsSchema.parse({ experimentalAgentSquadsEnabled: true });
  assert.equal(parsed.experimentalAgentSquadsEnabled, true);
});

// I3 schema 级守卫：显式 false 必须原样穿过 parse，任何缺省/迁移都不得改写
//（这是「显式关不被翻回」的机器化防线，防未来 preprocess 迁移走 D 方案老路）。
test("实验开关显式关闭保持 false（I3：显式值永不被缺省改写）", () => {
  const parsed = appSettingsSchema.parse({ experimentalAgentSquadsEnabled: false });
  assert.equal(parsed.experimentalAgentSquadsEnabled, false);
});

// patch 少一处就会静默剥离该字段，表现为「拨开关没反应」——必须断言键在解析后存活，
// 否则裸 z.object 会剥离未知键，让 success 永远为 true。
test("patch 接受实验开关（键必须在解析后存活）", () => {
  const parsed = appSettingsPatchSchema.safeParse({ experimentalAgentSquadsEnabled: true });
  assert.equal(parsed.success, true);
  assert.equal(parsed.success ? parsed.data.experimentalAgentSquadsEnabled : undefined, true);
});

// A1 渠道缺省矩阵：接口即测试面，两个参数就是全部输入空间（4 格）。
test("resolveExperimentalAgentSquadsDefault 渠道矩阵", () => {
  assert.equal(resolveExperimentalAgentSquadsDefault("preview", true), true);
  assert.equal(resolveExperimentalAgentSquadsDefault("production", true), false);
  assert.equal(resolveExperimentalAgentSquadsDefault("preview", false), false);
  assert.equal(resolveExperimentalAgentSquadsDefault("production", false), false);
});

// 注入位守卫：test 进程未注入 define。若将来注入判定被改坏，上面的矩阵用例会静默漂移成
//「永远测不到注入分支」——此用例让漂移显式红。
test("测试进程未注入 flavor define（注入位回退事实）", () => {
  assert.equal(IS_ZCODE_PRODUCT_FLAVOR_INJECTED, false);
});
