import assert from "node:assert/strict";
import test from "node:test";
import { applyExternalTextInsertRequestToComposer } from "../src/v4/composer/composerTextInsert.js";
import type { ComposerTextInsertRequest } from "../src/store/zcodeSessionStoreTypes.js";

/**
 * 会话草稿文本注入通道：请求落地（卡 #186）。
 *
 * 期望值的独立真源：卡文「点击把卡引用注入当前会话输入框（草稿态，用户可编辑后发送）」+
 * 用户裁定「纯卡引用直发；用户想加什么话自己接着打、或直接发送」+ 既有三种合并方式的口径
 * （`replace` 整段替换 / `prepend-if-missing` 节点级前置保留用户内容）。
 *
 * 输入框替身只记录调用（不重算业务判据）：落进编辑器的内容由真编辑器在浏览器断言里核对。
 */

function createRecordingOutput(input: { text: string }) {
  const appended: string[] = [];
  const setTexts: string[] = [];
  const syncs: string[] = [];
  const events = { persisted: 0, focused: 0 };
  const state = { current: input.text };
  return {
    appended,
    setTexts,
    syncs,
    events,
    /** 编辑器 canonical 文本（真编辑器口径）：替身只在 append 后换成一个可辨认的值。 */
    state,
    prepareMention: () => true,
  };
}

function apply(input: {
  current: string;
  request: ComposerTextInsertRequest;
  appliedRequestId?: number | null;
}) {
  const record = createRecordingOutput({ text: input.current });
  const appliedRequestId = applyExternalTextInsertRequestToComposer({
    appliedRequestId: input.appliedRequestId ?? null,
    inputApi: {
      getMarkdown: () => record.state.current,
      appendText: (text: string) => {
        record.appended.push(text);
        record.state.current = `${record.state.current} [canonical]`;
      },
      setText: (text: string) => {
        record.setTexts.push(text);
        record.state.current = text;
      },
      setTextWithPluginMentions: (text: string) => {
        record.setTexts.push(text);
        record.state.current = text;
      },
      setMention: () => {},
      prependMentionIfMissing: record.prepareMention,
    },
    request: input.request,
    requestFocus: () => {
      record.events.focused += 1;
    },
    scheduleDraftPersist: () => {
      record.events.persisted += 1;
    },
    updateText: (text: string) => {
      record.syncs.push(text);
    },
  });
  return { appliedRequestId, record };
}

test("append-if-missing：空草稿 → 引用进输入框（可编辑可发送）+ 草稿落盘 + 聚焦", () => {
  const { appliedRequestId, record } = apply({
    current: "",
    request: { requestId: 7, text: "#186 T", mode: "append-if-missing", scope: "focused" },
  });

  assert.equal(appliedRequestId, 7, "请求消费确认（宿主据此清 store 请求）");
  assert.deepEqual(record.appended, ["#186 T"], "引用原样交给编辑器追加（不拼模板、不改写）");
  assert.deepEqual(record.syncs, [" [canonical]"], "草稿事实源同步编辑器 canonical 文本");
  assert.deepEqual(record.events, { persisted: 1, focused: 1 }, "追加后落盘并聚焦输入框");
});

test("append-if-missing：已有用户正文 → 追加不覆盖（保留已输入内容）", () => {
  const { appliedRequestId, record } = apply({
    current: "先看这张卡",
    request: { requestId: 8, text: "#186 T", mode: "append-if-missing", scope: "focused" },
  });

  assert.equal(appliedRequestId, 8);
  assert.deepEqual(record.appended, ["#186 T"]);
  assert.deepEqual(record.setTexts, [], "不得整段替换（用户已打的字不能被清掉）");
  assert.deepEqual(record.syncs, ["先看这张卡 [canonical]"]);
});

test("append-if-missing 反例：输入里已有同一引用 → 不重复追加，但请求照样消费", () => {
  const { appliedRequestId, record } = apply({
    current: "先看这张卡 #186 T",
    request: { requestId: 9, text: "#186 T", mode: "append-if-missing", scope: "focused" },
  });

  assert.equal(appliedRequestId, 9, "消费确认：不消费会让请求滞留在 store，换面后再弹一次");
  assert.deepEqual(record.appended, [], "同一张卡重复派发不得堆第二份引用");
  assert.deepEqual(record.syncs, [], "内容没变不重写草稿事实源");
  assert.deepEqual(record.events, { persisted: 0, focused: 1 });
});

test("既有合并方式回归：缺省 replace 整段替换、单次消费（本卡不改写旧语义）", () => {
  const { appliedRequestId, record } = apply({
    current: "旧草稿",
    request: { requestId: 10, text: "#9 别的卡" },
  });

  assert.equal(appliedRequestId, 10);
  assert.deepEqual(record.setTexts, ["#9 别的卡"]);
  assert.deepEqual(record.appended, []);
});

test("幂等边界：同一 requestId 已应用过 → 不再重复落一次（ref 语义）", () => {
  const { appliedRequestId, record } = apply({
    current: "",
    appliedRequestId: 11,
    request: { requestId: 11, text: "#186 T", mode: "append-if-missing", scope: "focused" },
  });

  assert.equal(appliedRequestId, 11);
  assert.deepEqual(record.appended, []);
  assert.deepEqual(record.events, { persisted: 0, focused: 0 });
});
