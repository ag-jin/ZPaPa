import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsSchema } from "@zcode/shared";
import { projectBoardEntryVisible } from "../src/board/boardEntryVisibility.js";

/**
 * 「项目看板」入口的**呈现判据**（卡 #58，范式真源 = squad/squadEntryVisibility.ts）。
 *
 * 需求真源：卡文 (3)(4)——关闭时入口零渲染；默认关（全新配置与存量升级后入口不可见）。
 * 判据是纯函数、只吃一个可能为 null 的设置快照：设置是异步加载的（useSettings() 加载期给 null），
 * 未加载完就展示入口等于凭空许诺一个用户没开的功能。
 */

test("开关关闭 / 未设置 / 未加载时入口不可见", () => {
  assert.equal(projectBoardEntryVisible({ experimentalProjectBoardEnabled: false }), false);
  assert.equal(projectBoardEntryVisible({}), false);
  assert.equal(projectBoardEntryVisible(undefined), false);
  assert.equal(projectBoardEntryVisible(null), false);
});

test("开关打开时入口可见（严格 === true）", () => {
  assert.equal(projectBoardEntryVisible({ experimentalProjectBoardEnabled: true }), true);
});

// 穷举矩阵「settings 快照 = 校验器产出的真默认值」那一格：默认关 ⇒ 入口不可见。
// 变异：把 schema 默认改成 true（或让判据对 undefined 放行）⇒ 本用例必红。
test("校验器产出的默认设置下入口不可见（默认关）", () => {
  const defaults = appSettingsSchema.parse({});
  assert.equal(defaults.experimentalProjectBoardEnabled, false);
  assert.equal(projectBoardEntryVisible(defaults), false);
});
