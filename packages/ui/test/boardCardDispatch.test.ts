import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildBoardCardReferenceText,
  dispatchBoardCardReference,
  type BoardCardDispatchCall,
} from "../src/board/boardCardDispatch.js";
import type { RequestComposerTextInsert } from "../src/store/zcodeSessionStoreTypes.js";

/**
 * 卡片引用派发：注入载荷 + 写路径（卡 #186）。
 *
 * 期望值的独立真源：卡文「卡片弹窗/队列行增加「派发此卡」操作——点击把卡引用（稳定号+标题）与
 * 派发意图注入当前会话输入框（草稿态，用户可编辑后发送——不自动执行不绕过编排者裁决）」+
 * 用户中途裁定（简化：纯卡引用直发，去掉建议指令模板）+ 板引用纪律（引用一律稳定号；
 * 层级标签只是排版、拒入引用位）+ 板只读契约（应用侧不写板）。
 */

/** 派发调用记录（注入的写通道替身）：只记参数，不落任何状态。 */
function recordingInsert() {
  const calls: Parameters<RequestComposerTextInsert>[] = [];
  const insert: RequestComposerTextInsert = (...args) => {
    calls.push(args);
    return calls.length;
  };
  return { calls, insert };
}

test("卡引用文本：稳定号 + 标题（`#<稳定号> <标题>`，卡文「卡引用（稳定号+标题）」）", () => {
  assert.equal(
    buildBoardCardReferenceText({ no: 186, title: "UI 卡片引用派发：点卡注入会话安排" }),
    "#186 UI 卡片引用派发：点卡注入会话安排",
  );
  // 反例咬点：禁止退回层级标签/计划码形态（引用位只认稳定号，标签只是排版）。
  assert.equal(
    buildBoardCardReferenceText({ no: 7, title: "IMPL-1.2 形态的标题不得变成 ID 前缀" }),
    "#7 IMPL-1.2 形态的标题不得变成 ID 前缀",
  );
});

test("卡引用文本：标题首尾空白归一（载荷不留悬空空格）", () => {
  assert.equal(buildBoardCardReferenceText({ no: 12, title: "  前后有空格  " }), "#12 前后有空格");
  // 标题缺失：只留稳定号，不落尾随空格（仍可引用、可发送）。
  assert.equal(buildBoardCardReferenceText({ no: 12, title: "   " }), "#12");
});

test("卡引用文本反例：未领稳定号 → null（不猜号、不拿层级标签冒充引用）", () => {
  assert.equal(buildBoardCardReferenceText({ no: null, title: "未领号的卡" }), null);
  // 板面 label 不进引用位：即便对象带上 label，也不得拼出 `ID-<label>` 形态的载荷。
  const unnumberedWithLabel = { no: null, title: "带标签但未领号", label: "C3-1" };
  assert.equal(buildBoardCardReferenceText(unnumberedWithLabel), null);
});

test("派发写路径：只经既有会话草稿通道（append-if-missing + focused），参数逐字", () => {
  const { calls, insert } = recordingInsert();
  const outcome = dispatchBoardCardReference({
    workspacePath: "/ws/board-dispatch",
    workspaceIdentity: "identity-1",
    card: { no: 186, title: "UI 卡片引用派发：点卡注入会话安排" },
    insert,
  });

  assert.equal(outcome, "dispatched");
  assert.deepEqual(calls, [
    [
      "/ws/board-dispatch",
      "#186 UI 卡片引用派发：点卡注入会话安排",
      "identity-1",
      undefined,
      "append-if-missing",
      "focused",
    ],
  ]);
});

test("派发写路径：无 identity 时按既有签名省略（不写 undefined 占位）", () => {
  const { calls, insert } = recordingInsert();
  const outcome = dispatchBoardCardReference({
    workspacePath: "/ws/plain",
    card: { no: 9, title: "T" },
    insert,
  });

  assert.equal(outcome, "dispatched");
  assert.deepEqual(calls, [
    ["/ws/plain", "#9 T", undefined, undefined, "append-if-missing", "focused"],
  ]);
});

test("派发写路径反例：未领稳定号 → 通道零调用（不定向注入、不自动执行）", () => {
  const { calls, insert } = recordingInsert();
  const outcome = dispatchBoardCardReference({
    workspacePath: "/ws/board-dispatch",
    card: { no: null, title: "未领号" },
    insert,
  });

  assert.equal(outcome, "no-stable-number");
  assert.deepEqual(calls, [], "没有稳定号就不该产生任何注入请求");
});

test("派发模块守卫：只读契约与单通道（不落盘、不派发第二输入通道事件）", () => {
  const source = readFileSync(
    new URL("../src/board/boardCardDispatch.ts", import.meta.url),
    "utf8",
  );
  for (const forbidden of ["node:fs", "fileService", "writeTextFile", "writeFile", "appendFile"]) {
    assert.ok(!source.includes(forbidden), `派发模块不得引入落盘通道：${forbidden}`);
  }
  for (const forbidden of ["dispatchEvent", "CustomEvent"]) {
    assert.ok(!source.includes(forbidden), `派发不得自造第二输入通道事件：${forbidden}`);
  }
});

/** 类型面守卫：派发入参卡片身份只要求稳定号 + 标题（不是整个视图节点）。 */
const dispatchCardShape: BoardCardDispatchCall["card"] = { no: 1, title: "T" };
test("派发卡片身份：只需稳定号 + 标题（引用位拒收层级标签/计划码）", () => {
  assert.deepEqual(Object.keys(dispatchCardShape).sort(), ["no", "title"]);
});
