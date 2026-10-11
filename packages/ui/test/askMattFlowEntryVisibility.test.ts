import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsSchema, type AppSettings } from "@zcode/shared";
import {
  askMattFlowBoardClosedNoticeVisible,
  askMattFlowEntryVisible,
} from "../src/settings/askMattFlowEntryVisibility.js";

/**
 * 「ask-matt 开发流程」入口的**呈现判据**（卡 #202；范式真源 = `../src/board/boardEntryVisibility.ts`）。
 *
 * 需求真源：卡文交付面 ③「门禁纯函数（visibility 范式）」——null / 未设置 / false 一律不可见；
 * 此时无消费面，函数就位供后续卡（命令面/技能注册/提示注入的 gate 都问它一处）。
 * 判据只吃一个可能为 null 的设置快照：设置异步加载（useSettings() 加载期给 null），
 * 未加载完就展示入口等于凭空许诺一个用户没开的流程。
 */

test("开关关闭 / 未设置 / 未加载时入口不可见", () => {
  assert.equal(askMattFlowEntryVisible({ experimentalAskMattFlowEnabled: false }), false);
  assert.equal(askMattFlowEntryVisible({}), false);
  assert.equal(askMattFlowEntryVisible(undefined), false);
  assert.equal(askMattFlowEntryVisible(null), false);
});

test("开关打开时入口可见（严格 === true）", () => {
  assert.equal(askMattFlowEntryVisible({ experimentalAskMattFlowEnabled: true }), true);
});

// 穷举矩阵「settings 快照 = 校验器产出的真默认值」那一格：默认关 ⇒ 入口不可见。
// 变异：把 schema 默认改成 true（或让判据对 undefined 放行）⇒ 本用例必红。
test("校验器产出的默认设置下入口不可见（默认关）", () => {
  const defaults = appSettingsSchema.parse({});
  assert.equal(defaults.experimentalAskMattFlowEnabled, false);
  assert.equal(askMattFlowEntryVisible(defaults), false);
});

/** 两开关的完整快照（判据只吃自己关心的键，但真实快照一定同时带两个开关）。 */
type ExperimentsSnapshot = Pick<
  AppSettings,
  "experimentalProjectBoardEnabled" | "experimentalAskMattFlowEnabled"
>;
const snapshot = (board: boolean, flow: boolean): ExperimentsSnapshot => ({
  experimentalProjectBoardEnabled: board,
  experimentalAskMattFlowEnabled: flow,
});

// 两开关独立判据：看板开关的值不得成为流程入口的可见性依据（乘积态四格的判据前提）。
test("判据只看流程开关：看板开关开/关都不影响流程入口", () => {
  assert.equal(askMattFlowEntryVisible(snapshot(true, false)), false);
  assert.equal(askMattFlowEntryVisible(snapshot(false, true)), true);
});

/**
 * 乘积态说明行（「来料厂」：板关+流开）——开关页那一行的显隐判据。
 * 期望值的独立真源：卡文交付面 ④「乘积态说明行（板关+流开）」——四格里只有这一格显示。
 */
test("乘积态说明行：仅板关+流开时可见（2×2 四格穷举）", () => {
  const notice = (board: boolean | undefined, flow: boolean | undefined) =>
    askMattFlowBoardClosedNoticeVisible({
      ...(board === undefined ? {} : { experimentalProjectBoardEnabled: board }),
      ...(flow === undefined ? {} : { experimentalAskMattFlowEnabled: flow }),
    });
  assert.equal(notice(true, true), false, "开开：看板可见，无需说明");
  assert.equal(notice(true, false), false, "开关：流程关，不显示流程说明");
  assert.equal(notice(false, false), false, "关关：流程未启用，不得解释一个不存在的组合");
  assert.equal(notice(false, true), true, "关开（来料厂）：板不可视但流程已启用，必须说明");
  assert.equal(notice(undefined, true), true, "板键缺省（默认关）+ 流开：同样落来料厂态");
  assert.equal(notice(undefined, undefined), false, "两者都未设置：默认全关，不显示");
});

test("乘积态说明行：设置未加载（null）时不显示", () => {
  assert.equal(askMattFlowBoardClosedNoticeVisible(null), false);
  assert.equal(askMattFlowBoardClosedNoticeVisible(undefined), false);
});
