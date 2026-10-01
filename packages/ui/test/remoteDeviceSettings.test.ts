import assert from "node:assert/strict";
import test from "node:test";
import {
  isProjectableSetting,
  pickProjectableSettings,
} from "../src/lib/remoteDeviceSettings.js";

/**
 * 远程设备设置投射走**排除法**（`EXCLUDED_KEY_PATTERNS` 黑名单），不是白名单：
 * 任何「布尔 + 键名不命中黑名单」的字段都会被投射，出现在远程设备设置页并可被远端改写。
 *
 * 实验开关必须显式排除：它是各端独立的能力开关，被对端远程打开会越过本机用户；
 * 而且实验开关会持续新增，靠逐个人工登记必然漏，所以用 `^experimental` 前缀兜住整类。
 */
test("实验开关不被投射到远程设备", () => {
  const key = "experimentalAgentSquadsEnabled";
  assert.equal(isProjectableSetting(key, true), false);
  const projectedKeys = pickProjectableSettings({ [key]: true }).map((entry) => entry.key);
  assert.ok(
    !projectedKeys.includes(key),
    `实验开关必须被排除，实际投射字段：${projectedKeys.join(",")}`,
  );
});

// 正向对照：排除法下普通布尔设置仍会被投射。没有这条，「永远返回空」的坏实现
// 也能让上面那条断言通过，测试就失去承重能力。
test("普通布尔设置仍可投射（对照，排除法未误伤整类）", () => {
  const projectedKeys = pickProjectableSettings({ taskAutoArchiveEnabled: true }).map(
    (entry) => entry.key,
  );
  assert.ok(
    projectedKeys.includes("taskAutoArchiveEnabled"),
    `普通布尔设置应可投射，实际投射字段：${projectedKeys.join(",")}`,
  );
});
