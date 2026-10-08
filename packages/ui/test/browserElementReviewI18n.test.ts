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
  assert.ok(
    zhKeys.length >= minimumCount,
    `${prefix} 只比到 ${zhKeys.length} 条，前缀可能写错了`,
  );
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
