import type { BrowserKeyModifier, BrowserMouseButton } from "@zcode/shared";
import { RESOLVE_SCRIPT } from "./browserCommandScripts.js";
import type { BrowserPoint, ControlledView } from "./browserCommandTypes.js";

/**
 * 键盘修饰键 → 位掩码（Alt=1, Control=2, Meta=4, Shift=8）。
 * 鼠标/拖拽复用此掩码透传给 dispatchMouseEvent；键盘经 `modifierNamesFromBitmask` 折成
 * `sendInputEvent` 的 modifiers 名（frame 定点路径仍透传给 CDP dispatchKeyEvent）。
 */
const MODIFIER_BITS: Record<BrowserKeyModifier, number> = {
  Alt: 1,
  Control: 2,
  ControlOrMeta: process.platform === "darwin" ? 4 : 2,
  Meta: 4,
  Shift: 8,
};

/**
 * 常用键名 → CDP Input.dispatchKeyEvent 参数映射。
 * **只服务跨进程 frame 的定点投递**（dispatchKey 的 sessionId 分支，见那里的通道说明）；
 * 主 frame 不再走 CDP。未命中的 key 走裸传（仅带 key 字段），交给内核尽力解释。
 */
const KEY_MAP: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
};

function normalizeCuaKey(raw: string): string {
  const key = raw.trim();
  const alias: Record<string, string> = {
    alt: "Alt",
    option: "Alt",
    control: "Control",
    ctrl: "Control",
    controlormeta: process.platform === "darwin" ? "Meta" : "Control",
    cmd: "Meta",
    meta: "Meta",
    super: "Meta",
    win: "Meta",
    shift: "Shift",
    esc: "Escape",
    return: "Enter",
    space: "Space",
    left: "ArrowLeft",
    right: "ArrowRight",
    up: "ArrowUp",
    down: "ArrowDown",
  };
  return alias[key.toLowerCase()] ?? key;
}

function asModifier(key: string): BrowserKeyModifier | undefined {
  return ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"].includes(key)
    ? (key as BrowserKeyModifier)
    : undefined;
}

export function modifiersBitmask(mods?: readonly BrowserKeyModifier[]): number {
  if (!mods || mods.length === 0) return 0;
  let bits = 0;
  for (const m of mods) bits |= MODIFIER_BITS[m];
  return bits;
}

/** 修饰键位掩码（与 MODIFIER_BITS 同口径）→ Electron `sendInputEvent` 的 modifiers 名。 */
export function modifierNamesFromBitmask(bits: number): string[] {
  const names: string[] = [];
  if ((bits & MODIFIER_BITS.Alt) !== 0) names.push("alt");
  if ((bits & MODIFIER_BITS.Control) !== 0) names.push("control");
  if ((bits & MODIFIER_BITS.Meta) !== 0) names.push("meta");
  if ((bits & MODIFIER_BITS.Shift) !== 0) names.push("shift");
  return names;
}

/**
 * CDP 键名 → Electron accelerator 键名：**只有方向键不一致**，其余同名直通。
 *
 * 为什么单列一张表：`sendInputEvent` 的 `keyCode` 按 accelerator 键名解析，实测 Electron 41
 * 收到 "ArrowUp" 这类 CDP 名时解析不出任何键 —— 产出 keyCode=0、key="" 的空事件且**不报错**；
 * 折成 "Up" 才是真方向键。字母/数字/单字符/Home/End/PageUp/PageDown/Insert/F1–F24 同名直通。
 */
const ELECTRON_KEY_NAME_MAP: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  // 组合键里的复合修饰键在 accelerator 里没有对应名，按平台折成主修饰键（与 MODIFIER_BITS 同口径）。
  ControlOrMeta: process.platform === "darwin" ? "Meta" : "Control",
};

/** 已实测可用的非单字符键名（其余键名显式报错：宁可命令失败，也不产出空键事件）。 */
const ELECTRON_NAMED_KEYS = new Set([
  "Enter",
  "Return",
  "Tab",
  "Escape",
  "Esc",
  "Backspace",
  "Delete",
  "Insert",
  "Space",
  // 方向键的 accelerator 名（ELECTRON_KEY_NAME_MAP 的落点，必须同时在这张白名单里）。
  "Up",
  "Down",
  "Left",
  "Right",
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "Plus",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/** 键名 → Electron accelerator 键名（白名单；不认识的键名抛错，见 ELECTRON_NAMED_KEYS）。 */
export function electronKeyCodeFor(keyName: string): string {
  const mapped = ELECTRON_KEY_NAME_MAP[keyName] ?? keyName;
  const singleCharacter = [...mapped].length === 1;
  if (
    singleCharacter ||
    ELECTRON_NAMED_KEYS.has(mapped) ||
    /^F([1-9]|1[0-9]|2[0-4])$/u.test(mapped)
  ) {
    return mapped;
  }
  throw new Error(`press: unsupported key name "${keyName}"`);
}

/** 解析 ref 元素中心坐标；未找到（含返回非法结构）→ null。 */
export async function resolveRefCenter(
  view: ControlledView,
  ref: string,
): Promise<BrowserPoint | null> {
  const raw = (await view.webContents.executeJavaScript(RESOLVE_SCRIPT(ref))) as {
    cx?: unknown;
    cy?: unknown;
  } | null;
  if (!raw || typeof raw.cx !== "number" || typeof raw.cy !== "number") return null;
  return { cx: raw.cx, cy: raw.cy };
}

/** 在给定坐标发一次 CDP 真实鼠标点击（mouseMoved→mousePressed→mouseReleased）。 */
export async function dispatchClickAt(
  view: ControlledView,
  center: BrowserPoint,
  button: BrowserMouseButton,
  doubleClick: boolean,
  modifiers = 0,
): Promise<void> {
  const clickCount = doubleClick ? 2 : 1;
  // modifiers=0 时不带该字段，保持与既有单测（不含 modifiers 的断言）一致。
  const mod = modifiers > 0 ? { modifiers } : {};
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: center.cx,
    y: center.cy,
    ...mod,
  });
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: center.cx,
    y: center.cy,
    button,
    clickCount,
    ...mod,
  });
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: center.cx,
    y: center.cy,
    button,
    clickCount,
    ...mod,
  });
}

/**
 * 从起点拖到终点：mousePressed@from → 多个插值 mouseMoved → mouseReleased@to（带 modifiers）。
 * 拖拽期间的 mouseMoved 带 buttons:1（左键按住位）以让内核识别为拖拽而非普通移动。
 */
export async function dispatchDrag(
  view: ControlledView,
  from: BrowserPoint,
  to: BrowserPoint,
  modifiers = 0,
): Promise<void> {
  const mod = modifiers > 0 ? { modifiers } : {};
  const STEPS = 10;
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: from.cx,
    y: from.cy,
    ...mod,
  });
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: from.cx,
    y: from.cy,
    button: "left",
    clickCount: 1,
    ...mod,
  });
  for (let i = 1; i <= STEPS; i++) {
    const x = Math.round(from.cx + ((to.cx - from.cx) * i) / STEPS);
    const y = Math.round(from.cy + ((to.cy - from.cy) * i) / STEPS);
    await view.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "left",
      buttons: 1,
      ...mod,
    });
  }
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: to.cx,
    y: to.cy,
    button: "left",
    clickCount: 1,
    ...mod,
  });
}

/** Drag 输入：逐点保留调用方 path，不把手绘/曲线路径重建为首尾直线。 */
export async function dispatchDragPath(
  view: ControlledView,
  path: readonly { x: number; y: number }[],
  modifiers = 0,
): Promise<void> {
  const [first, ...rest] = path;
  if (!first) throw new Error("cua_drag requires a non-empty path");
  const mod = modifiers > 0 ? { modifiers } : {};
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: first.x,
    y: first.y,
    ...mod,
  });
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: first.x,
    y: first.y,
    button: "left",
    clickCount: 1,
    ...mod,
  });
  let last = first;
  try {
    for (const point of rest) {
      last = point;
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 1,
        ...mod,
      });
    }
  } finally {
    await view.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: last.x,
      y: last.y,
      button: "left",
      clickCount: 1,
      ...mod,
    });
  }
}

/** CUA scroll：先移动到锚点，再从该位置发送真实滚轮输入。 */
export async function dispatchScrollGesture(
  view: ControlledView,
  point: BrowserPoint,
  scrollX: number,
  scrollY: number,
  modifiers = 0,
): Promise<void> {
  const mod = modifiers > 0 ? { modifiers } : {};
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.cx,
    y: point.cy,
    ...mod,
  });
  // Electron 41 / Chromium 146 的 <webview> guest 会让
  // Input.synthesizeScrollGesture 静默成功但不产生 wheel 事件，页面因此完全不滚动。
  // mouseWheel 仍是命中锚点的 trusted input，可保留嵌套滚动区和 wheel handler 语义。
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: point.cx,
    y: point.cy,
    deltaX: scrollX,
    deltaY: scrollY,
    ...mod,
  });
}

/**
 * 组合键输入：逐键按下组合键，末键 down/up 后逆序释放其余按键。
 * 通道一律 `sendInputEvent`（组合键没有 frame 定点需求，理由见 dispatchKey）。
 */
export async function dispatchKeyPress(
  view: ControlledView,
  keys: readonly string[],
): Promise<void> {
  const normalized = keys
    .flatMap((key) => key.split("+"))
    .filter(Boolean)
    .map(normalizeCuaKey);
  const last = normalized.at(-1);
  if (!last) throw new Error("keypress requires at least one key");
  const held = normalized.slice(0, -1);
  const pressedModifiers = new Set<BrowserKeyModifier>();

  const dispatch = (type: "keyDown" | "keyUp", keyName: string): void => {
    const modifier = asModifier(keyName);
    if (type === "keyDown" && modifier) pressedModifiers.add(modifier);
    if (type === "keyUp" && modifier) pressedModifiers.delete(modifier);
    const modifierNames = modifierNamesFromBitmask(modifiersBitmask([...pressedModifiers]));
    view.webContents.sendInputEvent({
      type,
      keyCode: electronKeyCodeFor(keyName),
      ...(modifierNames.length > 0 ? { modifiers: modifierNames } : {}),
    });
  };

  for (const key of held) dispatch("keyDown", key);
  dispatch("keyDown", last);
  dispatch("keyUp", last);
  for (const key of held.toReversed()) dispatch("keyUp", key);
}

/**
 * 发一次按键（keyDown + keyUp）。
 *
 * **通道判据**（IAB 键盘注入只有这一处，别再各写一份）：
 * · 主 frame（`sessionId` 缺省）⇒ `webContents.sendInputEvent`：以 webContents 为单位投递，
 *   与「窗口当前聚焦的 widget」无关。
 *   为什么不能用 CDP `Input.dispatchKeyEvent`：`<webview>` guest 的 CDP 键事件会被路由到
 *   窗口**当前聚焦**的 widget；guest 未持嵌入层焦点时（切 tab、点过 app 壳、刚 reload 完
 *   都是常态）按键会**静默落进 app 自己的渲染层**，命令仍返回 ok=true。
 * · 跨进程 iframe/OOPIF（`sessionId` 有值）⇒ 保留 CDP：只有它能定点到那个 frame。
 *   该路径仍受嵌入层焦点限制（未修，属 frame 级焦点策略的 finding）。
 */
export async function dispatchKey(
  view: ControlledView,
  keyName: string,
  modifiers = 0,
  sessionId?: string,
): Promise<void> {
  const modifierNames = modifierNamesFromBitmask(modifiers);
  const electronModifiers = modifierNames.length > 0 ? { modifiers: modifierNames } : {};
  if (sessionId == null) {
    const keyCode = electronKeyCodeFor(keyName);
    view.webContents.sendInputEvent({ type: "keyDown", keyCode, ...electronModifiers });
    view.webContents.sendInputEvent({ type: "keyUp", keyCode, ...electronModifiers });
    return;
  }
  const def = KEY_MAP[keyName];
  const base = def
    ? { key: def.key, code: def.code, windowsVirtualKeyCode: def.windowsVirtualKeyCode }
    : { key: keyName };
  // modifiers=0 时不带该字段，保持这条定点投递路径的线上形状不变。
  const cdpModifiers = modifiers > 0 ? { modifiers } : {};
  await view.cdp.send(
    "Input.dispatchKeyEvent",
    { type: "keyDown", ...base, ...cdpModifiers },
    sessionId,
  );
  await view.cdp.send(
    "Input.dispatchKeyEvent",
    { type: "keyUp", ...base, ...cdpModifiers },
    sessionId,
  );
}
