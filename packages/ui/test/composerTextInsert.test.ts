import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  hasComposerTextReference,
  selectComposerTextInsertRequest,
} from "../src/v4/composer/composerTextInsert.js";
import type { ComposerTextInsertRequest } from "../src/store/zcodeSessionStoreTypes.js";

/**
 * 会话草稿文本注入通道：消费面（多会话目标判定）与引用去重（卡 #186）。
 *
 * 期望值的独立真源：卡文「注入当前会话输入框（草稿态，用户可编辑后发送）」+「多会话场景：
 * 注入到活跃会话（当前焦点会话，无则置顶 workspace 会话）」+ 既有调用面行为（新任务预填/
 * 示例提示/插件选择只吃草稿输入框——不得被本卡改动）+ 用户裁定（纯卡引用直发、无模板）。
 */

function request(scope?: "focused"): ComposerTextInsertRequest {
  return { requestId: 1, text: "#186 T", ...(scope ? { scope } : {}) } as ComposerTextInsertRequest;
}

test("消费面：聚焦 + 草稿输入框 + 缺省 scope → 消费（既有新任务预填口径不变）", () => {
  const req = request();
  assert.equal(
    selectComposerTextInsertRequest({ request: req, focused: true, sessionId: null })?.requestId,
    1,
  );
});

test("消费面反例：非聚焦输入框一律不消费（后台 composer 不得吞请求）", () => {
  assert.equal(
    selectComposerTextInsertRequest({ request: request(), focused: false, sessionId: null }),
    null,
  );
  assert.equal(
    selectComposerTextInsertRequest({
      request: request("focused"),
      focused: false,
      sessionId: "s1",
    }),
    null,
  );
});

test("消费面：聚焦 + 会话 + 缺省 scope → 不消费（既有调用面仍是草稿专用）", () => {
  assert.equal(
    selectComposerTextInsertRequest({ request: request(), focused: true, sessionId: "s1" }),
    null,
  );
});

test("多会话目标判定：scope=focused + 聚焦会话 → 落当前焦点会话", () => {
  const req = request("focused");
  assert.equal(
    selectComposerTextInsertRequest({ request: req, focused: true, sessionId: "s1" })?.requestId,
    req.requestId,
  );
});

test("多会话目标判定：scope=focused + 无焦点会话（草稿面）→ 落草稿输入框", () => {
  const req = request("focused");
  assert.equal(
    selectComposerTextInsertRequest({ request: req, focused: true, sessionId: null })?.requestId,
    req.requestId,
  );
});

test("消费面：空请求 → null（无请求不消费）", () => {
  assert.equal(
    selectComposerTextInsertRequest({ request: null, focused: true, sessionId: "s1" }),
    null,
  );
});

test("引用去重判定：输入里已有同一引用 → 不重复追加（重复派发同一张卡幂等）", () => {
  const reference = "#186 UI 卡片引用派发：点卡注入会话安排";
  assert.equal(hasComposerTextReference("", reference), false);
  assert.equal(hasComposerTextReference("   ", reference), false);
  assert.equal(hasComposerTextReference(reference, reference), true);
  assert.equal(hasComposerTextReference(`先看这张卡：\n${reference}`, reference), true);
  // 反例咬点：别的卡/别的标题不得被当成「已有」而静默吞掉本次派发。
  assert.equal(hasComposerTextReference("#185 别的卡", reference), false);
  assert.equal(hasComposerTextReference("#186", reference), false);
  assert.equal(hasComposerTextReference("#186 UI 卡片引用派发", reference), false);
  // 引用后面接着打了别的字（引用原样在）→ 视为已有，不重复堆一份。
  assert.equal(hasComposerTextReference(`${reference} 先安排这张`, reference), true);
});

test("消费面单点（源码守卫）：SessionPane 走 selector，不写第二份内联门禁", () => {
  const source = readFileSync(new URL("../src/v4/SessionPane.tsx", import.meta.url), "utf8");
  assert.match(source, /selectComposerTextInsertRequest\(\{/, "消费判定必须走单点 selector");
  assert.doesNotMatch(
    source,
    /externalTextInsertRequest=\{focused && sessionId === null/,
    "不得保留旧的草稿专用内联门禁（那会让当前焦点会话收不到派发）",
  );
});
