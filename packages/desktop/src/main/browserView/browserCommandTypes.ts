/**
 * 受控视图的最小抽象：executor 只依赖这些方法，便于用 stub 单测（无需真 Electron webContents）。
 * 真实实现由 browserGuestManager 用 `<webview>` guest 的 webContents + webContents.debugger 提供。
 */
export interface ControlledViewWebContents {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  /**
   * 在页面上下文执行脚本并返回最后一个表达式的值（结构化克隆）。
   * 由 browserGuestManager wire 到 `guest.executeJavaScript(script, true)`（userGesture=true，与 element-picker 一致）。
   */
  executeJavaScript(script: string): Promise<unknown>;
  /**
   * 把一次按键事件**直接注入该 guest 的输入队列**（wire 到 `guest.sendInputEvent`）。
   *
   * 为什么键盘走这里而不是 CDP `Input.dispatchKeyEvent`：`<webview>` guest 的 CDP 键盘事件
   * 会被路由到**窗口当前聚焦的 widget**，而不是发命令的那个 guest。guest 未持有嵌入层焦点时
   * （切 tab、点过 app 壳、刚 reload 完都是常态），按键会静默落进 app 自己的渲染层 —— 命令还返回
   * ok=true（实测 Electron 41：同一状态下 CDP 键落到宿主页、`sendInputEvent` 落到 guest）。
   * 本通道以 webContents 为单位投递，与嵌入层焦点和 tab 可见性都无关，且不改动窗口焦点。
   *
   * `keyCode` 取 Electron accelerator 键名（字母/数字/单字符直接给字符；方向键是 Up/Down/Left/Right，
   * 见 browserCommandInput 的映射表），`modifiers` 取 `alt` / `control` / `meta` / `shift`。
   */
  sendInputEvent(event: ControlledViewInputEvent): void;
}

/** 键盘注入事件（Electron `webContents.sendInputEvent` 的子集：本域只用这三种与这些字段）。 */
export interface ControlledViewInputEvent {
  type: "keyDown" | "keyUp" | "char";
  /** Electron accelerator 键名（不是 CDP 的 key/code/windowsVirtualKeyCode 三元组）。 */
  keyCode: string;
  modifiers?: string[];
}

export interface ControlledViewCdp {
  /** webContents.debugger.sendCommand 的直通；sessionId 用于跨进程 iframe/OOPIF target。 */
  send(method: string, params?: unknown, sessionId?: string): Promise<unknown>;
}

export interface ControlledView {
  webContents: ControlledViewWebContents;
  cdp: ControlledViewCdp;
  /**
   * 已由宿主 compositor 合成的 viewport 截图。仅用于无 clip、非 fullPage 的普通截图；
   * Desktop 生产实现从 main 进程直接读取 guest surface，避开 Windows 下 CDP 对小 surface 的平铺。
   */
  captureViewportScreenshot?: () => Promise<string | undefined>;
  /**
   * 自由尺寸 guest 的 visible surface 保留宿主 backing scale；截图目标仍按 CSS px 计算。
   * executor 仅在该标记开启时读取 CDP layout metrics 并校验实际 raster。
   */
  normalizeScreenshotToCssPixels?: boolean;
  /**
   * 宿主图像引擎提供的高质量降采样能力。核心 executor 不直接依赖 Electron，
   * Desktop 生产装配使用 nativeImage，测试和其它宿主可注入等价实现。
   */
  resizeScreenshotToCssPixels?: (
    base64Png: string,
    target: { height: number; width: number },
  ) => Promise<string | undefined> | string | undefined;
}

export interface BrowserPoint {
  cx: number;
  cy: number;
}
