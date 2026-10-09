/* IAB 键盘注入通道守卫（「Enter 建项无响应」第三轮定位出的坏法的回归钉）。

   坏法（Electron 41 + `<webview>` guest 实测）：主 frame 的按键走 CDP `Input.dispatchKeyEvent`
   时，事件被路由到**窗口当前聚焦的 widget**，而不是发命令的那个 guest。guest 未持嵌入层焦点时
   （切 tab、点过 app 壳、刚 reload 完都是常态）按键会**静默落进 app 自己的渲染层**，命令仍返回
   ok=true —— 用户与 agent 看到的都是「输入框值在、Enter 没反应、点按钮却可以」。

   守卫（四条，都是结构性的；改坏哪条这里就红）：
   ① 主 frame 一律走 `webContents.sendInputEvent`：以 webContents 为单位投递，与嵌入层焦点无关；
      同一调用里**不得**再出现 CDP `Input.dispatchKeyEvent`（那条路径就是坏法本身）。
   ② frame 定点（`sessionId` 有值）保留 CDP，并保持 key/code/windowsVirtualKeyCode 三元组形状 ——
      只有 CDP 能定点到跨进程 iframe。
   ③ 键名映射：方向键必须折成 accelerator 名（实测 "ArrowUp" 在 Electron 里解析不出键：keyCode=0、
      key="" 的空事件且不报错）；**不认识的键名显式报错**，不静默发空事件。
   ④ 修饰键位掩码 → Electron modifiers 名（alt/control/meta/shift），组合键按「按下顺序 down、
      逆序 up」发。

   为什么在这里钉：这几条判据以前写在 `dispatchKey`/`dispatchKeyPress` 里没有任何测试
   （全仓 grep：没有一处 stub ControlledView 的键注入单测），而坏法是静默的 ——
   命令永远成功，只是键去了别的地方。 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  dispatchKey,
  dispatchKeyPress,
  electronKeyCodeFor,
  modifiersBitmask,
  modifierNamesFromBitmask,
} from "../src/main/browserView/browserCommandInput.js";
import type {
  ControlledView,
  ControlledViewInputEvent,
} from "../src/main/browserView/browserCommandTypes.js";

function stubView(): {
  view: ControlledView;
  inputEvents: ControlledViewInputEvent[];
  cdpCalls: Array<{ method: string; params?: unknown; sessionId?: string }>;
} {
  const inputEvents: ControlledViewInputEvent[] = [];
  const cdpCalls: Array<{ method: string; params?: unknown; sessionId?: string }> = [];
  const view = {
    webContents: {
      sendInputEvent: (event: ControlledViewInputEvent) => {
        inputEvents.push(event);
      },
    },
    cdp: {
      send: async (method: string, params?: unknown, sessionId?: string) => {
        cdpCalls.push({ method, params, sessionId });
        return {};
      },
    },
  } as unknown as ControlledView;
  return { view, inputEvents, cdpCalls };
}

test("主 frame 按键走 sendInputEvent，且同一调用里不再出现 CDP 键事件（坏法判据）", async () => {
  const { view, inputEvents, cdpCalls } = stubView();
  await dispatchKey(view, "Enter");
  assert.deepEqual(inputEvents, [
    { type: "keyDown", keyCode: "Enter" },
    { type: "keyUp", keyCode: "Enter" },
  ]);
  assert.equal(
    cdpCalls.length,
    0,
    "主 frame 不得再用 CDP Input.dispatchKeyEvent：该路径会被路由到窗口当前聚焦的 widget，guest 未聚焦时静默落到 app 渲染层",
  );
});

test("每个受支持键名都能解析成 accelerator 名并原样发出（含方向键折算）", async () => {
  const expected: Record<string, string> = {
    Enter: "Enter",
    Tab: "Tab",
    Escape: "Escape",
    Backspace: "Backspace",
    Delete: "Delete",
    Space: "Space",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    a: "a",
    "5": "5",
    "/": "/",
    F5: "F5",
  };
  for (const [name, accelerator] of Object.entries(expected)) {
    const { view, inputEvents } = stubView();
    await dispatchKey(view, name);
    assert.deepEqual(
      inputEvents.map((event) => event.keyCode),
      [accelerator, accelerator],
      `键名 ${name} 应折成 ${accelerator}`,
    );
  }
});

test("未知键名显式报错，且不产生任何按键事件（不静默发空事件）", async () => {
  const { view, inputEvents } = stubView();
  await assert.rejects(
    () => dispatchKey(view, "NumpadEnter"),
    /unsupported key name "NumpadEnter"/u,
  );
  assert.deepEqual(inputEvents, []);
  assert.throws(() => electronKeyCodeFor("FooBar"), /unsupported key name/u);
});

test("修饰键位掩码 → Electron modifiers 名（顺序固定 alt/control/meta/shift）", () => {
  assert.deepEqual(modifierNamesFromBitmask(0), []);
  assert.deepEqual(modifierNamesFromBitmask(modifiersBitmask(["Shift", "Meta"])), [
    "meta",
    "shift",
  ]);
  assert.deepEqual(
    modifierNamesFromBitmask(modifiersBitmask(["Alt", "Control", "Meta", "Shift"])),
    ["alt", "control", "meta", "shift"],
  );
  // ControlOrMeta 是复合修饰键：按平台折成主修饰键（darwin ⇒ meta）。
  assert.deepEqual(modifierNamesFromBitmask(modifiersBitmask(["ControlOrMeta"])), [
    process.platform === "darwin" ? "meta" : "control",
  ]);
});

test("组合键：按顺序 down、末键先 up，其余逆序 up，且修饰键随按住状态进 modifiers", async () => {
  const { view, inputEvents, cdpCalls } = stubView();
  await dispatchKeyPress(view, ["Shift", "a"]);
  assert.deepEqual(inputEvents, [
    { type: "keyDown", keyCode: "Shift", modifiers: ["shift"] },
    { type: "keyDown", keyCode: "a", modifiers: ["shift"] },
    { type: "keyUp", keyCode: "a", modifiers: ["shift"] },
    { type: "keyUp", keyCode: "Shift" },
  ]);
  assert.equal(cdpCalls.length, 0, "组合键没有 frame 定点需求，一律走 sendInputEvent");
});

test("ControlOrMeta 组合键在 accelerator 名下折成平台主修饰键，且小写别名可用", async () => {
  const { view, inputEvents } = stubView();
  await dispatchKeyPress(view, ["controlormeta+a"]);
  const modifierName = process.platform === "darwin" ? "Meta" : "Control";
  assert.deepEqual(inputEvents, [
    { type: "keyDown", keyCode: modifierName, modifiers: [modifierName.toLowerCase()] },
    { type: "keyDown", keyCode: "a", modifiers: [modifierName.toLowerCase()] },
    { type: "keyUp", keyCode: "a", modifiers: [modifierName.toLowerCase()] },
    { type: "keyUp", keyCode: modifierName },
  ]);
});

test("frame 定点（sessionId）保留 CDP：键名/键码三元组与原地投递都不变", async () => {
  const { view, inputEvents, cdpCalls } = stubView();
  await dispatchKey(view, "ArrowUp", modifiersBitmask(["Shift"]), "session-1");
  assert.deepEqual(cdpCalls, [
    {
      method: "Input.dispatchKeyEvent",
      params: {
        type: "keyDown",
        key: "ArrowUp",
        code: "ArrowUp",
        windowsVirtualKeyCode: 38,
        modifiers: 8,
      },
      sessionId: "session-1",
    },
    {
      method: "Input.dispatchKeyEvent",
      params: {
        type: "keyUp",
        key: "ArrowUp",
        code: "ArrowUp",
        windowsVirtualKeyCode: 38,
        modifiers: 8,
      },
      sessionId: "session-1",
    },
  ]);
  assert.deepEqual(inputEvents, [], "定点投递不得同时走 webContents 通道（否则键会到两个地方）");
});
