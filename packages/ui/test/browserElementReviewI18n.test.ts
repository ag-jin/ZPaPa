import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

/* 内置浏览器「元素拾取」两个新功能的**文案成对**守卫（设计 §10.1）：
   浮条与 chip 评语编辑的键都按前缀分组，两侧键集必须完全一致（少一条就是某个语种裸奔），
   且新键的文案按设计逐条钉死 —— 只改一侧的误译在只比键集的守卫下是看不见的。 */

function keysWithPrefix(locale: Record<string, string>, prefix: string) {
  return Object.keys(locale).filter((key) => key.startsWith(prefix));
}

function assertPrefixParity(prefix: string, minimumCount: number) {
  const zhKeys = keysWithPrefix(zhCN, prefix);
  const enKeys = keysWithPrefix(enUS, prefix);
  for (const key of zhKeys) {
    assert.ok(key in enUS, `en-US 缺 ${key}`);
  }
  for (const key of enKeys) {
    assert.ok(key in zhCN, `zh-CN 缺 ${key}`);
  }
  assert.deepEqual(zhKeys.sort(), enKeys.sort(), `${prefix} 子树两语键集必须相等`);
  assert.ok(zhKeys.length >= minimumCount, `${prefix} 只比到 ${zhKeys.length} 条，前缀可能写错了`);
}

function placeholdersOf(value: string) {
  return [...value.matchAll(/\{(\w+)\}/gu)]
    .map((match) => match[1])
    .sort()
    .join(",");
}

test("i18n：chat.webElements.* 两语键集相等，评语编辑四条文案按设计落地", () => {
  assertPrefixParity("chat.webElements.", 7);

  const expected = {
    "chat.webElements.comment": ["评语", "Comment"],
    "chat.webElements.editComment": ["编辑评语", "Edit comment"],
    "chat.webElements.saveComment": ["保存", "Save"],
    "chat.webElements.cancelComment": ["取消", "Cancel"],
  } as const;

  for (const [key, [zh, en]] of Object.entries(expected)) {
    assert.equal(zhCN[key], zh, `zh-CN 的 ${key} 文案与设计不一致`);
    assert.equal(enUS[key], en, `en-US 的 ${key} 文案与设计不一致`);
    assert.ok(
      !/[{}]/u.test(zhCN[key] ?? "") && !/[{}]/u.test(enUS[key] ?? ""),
      `${key} 不是占位符文案，不应带花括号`,
    );
  }
});

test("i18n：browser.elementPicker.* 两语键集相等，浮条动作与评语区文案按设计落地", () => {
  // 键集逐条钉死：合并层级与评语一步提交后，「确认/跳过/完成」三个键必须消失
  // （少删一个就是浮条上还留着说不出话的死按钮），只允许新增「取消」与「层级指示」。
  const expectedKeys = [
    "browser.elementPicker.bar.adjustHint",
    "browser.elementPicker.bar.cancel",
    "browser.elementPicker.bar.chainTruncated",
    "browser.elementPicker.bar.hint",
    "browser.elementPicker.bar.levelIndicator",
    "browser.elementPicker.bar.repick",
    "browser.elementPicker.bar.selectedCount",
    "browser.elementPicker.bar.sliderLabel",
    "browser.elementPicker.cancel",
    "browser.elementPicker.comment.add",
    "browser.elementPicker.comment.placeholder",
    "browser.elementPicker.popover.background",
    "browser.elementPicker.popover.color",
    "browser.elementPicker.popover.font",
    "browser.elementPicker.start",
  ].sort();
  assertPrefixParity("browser.elementPicker.", expectedKeys.length);
  assert.deepEqual(
    keysWithPrefix(zhCN, "browser.elementPicker.").sort(),
    expectedKeys,
    "browser.elementPicker.* 键集必须与设计 §10.1 一致",
  );

  const expected = {
    "browser.elementPicker.bar.hint": ["点击页面中的元素", "Click an element in the page"],
    "browser.elementPicker.bar.adjustHint": ["拖动滑轨调整层级", "Drag the slider to adjust level"],
    "browser.elementPicker.bar.sliderLabel": ["祖先层级", "Ancestor level"],
    "browser.elementPicker.bar.repick": ["重选", "Repick"],
    "browser.elementPicker.bar.cancel": ["取消", "Cancel"],
    "browser.elementPicker.bar.levelIndicator": ["第 {n} / {total} 层", "Level {n} of {total}"],
    "browser.elementPicker.bar.chainTruncated": ["祖先链已截断", "Ancestor chain truncated"],
    "browser.elementPicker.comment.placeholder": [
      "输入对该元素的评语或问题（可选）",
      "Add a comment or question for this element (optional)",
    ],
    "browser.elementPicker.comment.add": ["加入对话", "Add to chat"],
  } as const;

  for (const [key, [zh, en]] of Object.entries(expected)) {
    assert.equal(zhCN[key], zh, `zh-CN 的 ${key} 文案与设计不一致`);
    assert.equal(enUS[key], en, `en-US 的 ${key} 文案与设计不一致`);
  }

  // 带占位符的键：只译一侧会让用户看到原始花括号。
  const selectedCountKey = "browser.elementPicker.bar.selectedCount";
  assert.equal(zhCN[selectedCountKey], "已选 {count} 个元素");
  assert.equal(enUS[selectedCountKey], "{count} elements selected");
  assert.equal(placeholdersOf(zhCN[selectedCountKey] ?? ""), "count");
  assert.equal(placeholdersOf(enUS[selectedCountKey] ?? ""), "count");

  const levelIndicatorKey = "browser.elementPicker.bar.levelIndicator";
  assert.equal(placeholdersOf(zhCN[levelIndicatorKey] ?? ""), "n,total");
  assert.equal(placeholdersOf(enUS[levelIndicatorKey] ?? ""), "n,total");
});
