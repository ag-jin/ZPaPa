/* eslint-disable max-lines -- Electron webview 注入脚本需要在单个函数内自包含运行：祖先链 helper 与挂载键由组装模板以位置实参注入，函数体只引用形参、不引用模块作用域，内层函数一律无名（压缩器会改写具名内层函数）。 */
import type {
  WebElementContextPayload,
  WebElementRect,
  WebElementStyleSummary,
} from "@/lib/webElementContext.js";

export type WebElementPickerPickResult =
  | { status: "clicked"; chain: WebElementAncestorStep[]; chainTruncated: boolean }
  | { status: "cancelled" };

export type WebElementPickerAdjustResult =
  | { status: "selected"; element: Omit<WebElementContextPayload, "workspacePath"> }
  | { status: "repick" }
  | { status: "cancelled" };

/** 句柄小脚本可驱动的方法（与页内 `window.__zcodeWebElementPicker` 的键一一对应）。 */
export type WebElementPickerCommand =
  | "pick"
  | "beginAdjust"
  | "showAncestor"
  | "confirm"
  | "requestRepick"
  | "cancel";

/** 祖先链档位：level 0 = 被点击元素，仅 renderer 消费（不进入 prompt）。 */
export interface WebElementAncestorStep {
  level: number;
  tagName: string;
  id?: string;
  classNames?: string[];
  label: string;
}

/** 上溯只读这几个字段，伪节点树（单测）与真实 Element 都能满足。 */
export interface WebElementAncestorNodeLike {
  tagName: string;
  id?: string;
  classList?: Iterable<string> | { length: number; item(index: number): string | null };
  parentElement?: WebElementAncestorNodeLike | null;
}

/**
 * 从被点元素沿 `parentElement` 上溯，排除 body/html（到 body 之前封顶），深度上限 24。
 *
 * 作为注入脚本的位置实参传入：只能依赖入参与语言内建，不得引用模块级值，`toString()` 后要能独立运行；
 * 内层 helper 同样不许有名字（理由见 webElementPickerScript 的自包含约束）。
 */
export function computeAncestorChain(
  node: WebElementAncestorNodeLike | null | undefined,
  maxDepth?: number,
): { chain: WebElementAncestorStep[]; truncated: boolean } {
  const limit = typeof maxDepth === "number" && maxDepth > 0 ? Math.floor(maxDepth) : 24;
  const helpers = {} as { readClassNames: (target: WebElementAncestorNodeLike) => string[] };
  helpers.readClassNames = (target: WebElementAncestorNodeLike): string[] => {
    const classList = target.classList;
    if (!classList) {
      return [];
    }
    const names: string[] = [];
    const iterable = classList as Partial<Iterable<string>>;
    if (typeof iterable[Symbol.iterator] === "function") {
      for (const name of classList as Iterable<string>) {
        if (name) {
          names.push(name);
        }
      }
    } else {
      const list = classList as { length?: number; item?: (index: number) => string | null };
      const length = typeof list.length === "number" ? list.length : 0;
      for (let index = 0; index < length; index += 1) {
        const name = typeof list.item === "function" ? list.item(index) : null;
        if (name) {
          names.push(name);
        }
      }
    }
    return names.slice(0, 2);
  };

  const chain: WebElementAncestorStep[] = [];
  let current: WebElementAncestorNodeLike | null | undefined = node;

  while (current && chain.length < limit) {
    const tagName = String(current.tagName ?? "").toLowerCase();
    if (!tagName) {
      break;
    }
    if (chain.length > 0 && (tagName === "body" || tagName === "html")) {
      break;
    }

    const id = typeof current.id === "string" && current.id ? current.id : undefined;
    const classNames = helpers.readClassNames(current);
    chain.push({
      level: chain.length,
      tagName,
      ...(id ? { id } : {}),
      ...(classNames.length > 0 ? { classNames } : {}),
      label: id ? `${tagName}#${id}` : classNames[0] ? `${tagName}.${classNames[0]}` : tagName,
    });
    current = current.parentElement ?? null;
  }

  const remainingTagName = current ? String(current.tagName ?? "").toLowerCase() : "";
  return {
    chain,
    truncated:
      chain.length >= limit &&
      remainingTagName !== "" &&
      remainingTagName !== "body" &&
      remainingTagName !== "html",
  };
}

/**
 * 页内层级标签：至多两段（父 子，形如 `tr th`），根档位与链长 1 时单段。
 *
 * 同 computeAncestorChain 的注入约束：零模块作用域依赖。
 */
export function buildAncestorLabel(
  chain: readonly WebElementAncestorStep[],
  level: number,
): string {
  const current = chain[level];
  if (!current) {
    return "";
  }
  const parent = chain[level + 1];
  return parent ? `${parent.label} ${current.label}` : current.label;
}

interface WebElementPickerScriptOptions {
  maxTextChars: number;
  maxHtmlChars: number;
  maxAttributeChars: number;
  labels: WebElementPickerScriptLabels;
}

export interface WebElementPickerScriptLabels {
  background: string;
  color: string;
  font: string;
}

type WebElementPickerScriptBuildOptions = Partial<Omit<WebElementPickerScriptOptions, "labels">> & {
  labels?: Partial<WebElementPickerScriptLabels>;
};

/**
 * 页内实例句柄的挂载键：主脚本与句柄小脚本共用同一常量，且作为位置实参注入主函数
 * （注入体不得引用模块作用域绑定，键漂移会让所有句柄命令静默 no-op）。
 */
const WEB_ELEMENT_PICKER_STATE_KEY = "__zcodeWebElementPicker";

const DEFAULT_OPTIONS: WebElementPickerScriptOptions = {
  maxTextChars: 4_000,
  maxHtmlChars: 6_000,
  maxAttributeChars: 500,
  labels: {
    background: "Background",
    color: "Color",
    font: "Font",
  },
};

/**
 * 注入主函数体内层 helper 的形态契约。类型只在编译期存在（打包器会擦除注解），因此不违反
 * `toString()` 产物的自包含约束：helper 一律以**成员赋值**挂到页内 runtime 对象上。
 */
interface WebElementPickerRuntime {
  truncate: (value: string | null | undefined, maxLength: number) => string;
  clampColorChannel: (value: number) => number;
  toHexColor: (red: number, green: number, blue: number) => string;
  parseAlpha: (value: string | undefined) => number;
  formatComputedColor: (value: string) => string;
  readStyleSummary: (element: Element) => WebElementStyleSummary;
  formatFont: (style: WebElementStyleSummary) => string;
  formatElementSize: (rect: DOMRect) => string;
  hasVisibleBackground: (style: WebElementStyleSummary) => boolean;
  cssEscape: (value: string) => string;
  readElementText: (element: Element) => string;
  getImplicitRole: (element: Element) => string;
  getAccessibleName: (element: Element) => string;
  getAttributes: (element: Element) => Record<string, string>;
  getSelector: (element: Element) => string;
  getXPath: (element: Element) => string;
  getNearbyText: (element: Element) => string;
  getHtmlExcerpt: (element: Element) => string;
  rectToPlainObject: (rect: DOMRect) => WebElementRect;
  settlePick: (result: WebElementPickerPickResult) => void;
  settleAdjust: (result: WebElementPickerAdjustResult) => void;
  watchHover: (enabled: boolean) => void;
  watchRelayout: (enabled: boolean) => void;
  cleanup: () => void;
  appendPopoverRow: (name: string, value: string | undefined) => void;
  renderPopover: (target: Element, rect: DOMRect, levelLabel?: string) => void;
  clampPosition: (value: number, min: number, max: number) => number;
  getPopoverPosition: (
    rect: DOMRect,
    labelWidth: number,
    labelHeight: number,
  ) => { left: number; top: number };
  updateOverlay: (target: Element | null, levelLabel?: string) => void;
  currentTarget: () => Element | null;
  showLevel: (nextLevel: number) => { level: number; label: string } | null;
  collectChainElements: (element: Element, count: number) => Element[];
  enterAdjusting: () => void;
  leaveAdjusting: () => void;
  handleMouseMove: (event: MouseEvent) => void;
  handleRelayout: () => void;
  collectElement: (element: Element) => Omit<WebElementContextPayload, "workspacePath">;
  handleClick: (event: MouseEvent) => void;
  handleKeyDown: (event: KeyboardEvent) => void;
  pick: () => Promise<WebElementPickerPickResult>;
  beginAdjust: () => Promise<WebElementPickerAdjustResult>;
  showAncestor: (nextLevel: number) => { level: number; label: string } | null;
  confirm: () => void;
  requestRepick: () => void;
}

/**
 * 页内主脚本。opts、两个 helper 与挂载键都是**位置形参**，由 buildWebElementPickerScript 在模板里以
 * 源码文本实参传入（形参名只在本函数内解析，构建器压缩改名后主函数体依然自洽）。
 *
 * 函数体不得引用任何模块作用域绑定：打包器重命名模块绑定后，toString() 出来的引用会指向压缩改名的
 * 标识符，而注入体里并不存在它们——发布产物会直接 ReferenceError。
 *
 * 第二条约束同理但更隐蔽：**内层函数一律不许有名字**——函数声明、`const f = …`、对象字面量属性都会让
 * 压缩器推导出名字，minify + keepNames 组合下它们会被改写成 `__name(fn, "f")`，而 `__name` 是注入在
 * 模块作用域的 helper（先例见 apps/zcode-cli/packages/dynamic-workflow-runtime/src/child-source.ts）。
 * 它一旦出现在 toString() 文本里，页内执行就 ReferenceError，且**只在压缩产物里坏**。所以 helper 统一
 * 走「成员赋值 + 末尾解构取回局部名」：成员赋值不被推导名字，解构也不创建函数。
 */
function webElementPickerScript(
  options: WebElementPickerScriptOptions,
  __zcodeWepComputeAncestorChain: typeof computeAncestorChain,
  __zcodeWepBuildAncestorLabel: typeof buildAncestorLabel,
  __zcodeWepStateKey: string,
) {
  const runtime = {} as WebElementPickerRuntime;
  const existing = (window as unknown as Record<string, { cancel?: () => void }>)[
    __zcodeWepStateKey
  ];
  existing?.cancel?.();

  runtime.truncate = (value: string | null | undefined, maxLength: number) => {
    const normalized = (value ?? "").replace(/\s+/g, " ").trim();
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
  };

  runtime.clampColorChannel = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

  runtime.toHexColor = (red: number, green: number, blue: number) =>
    `#${[red, green, blue]
      .map((channel) => clampColorChannel(channel).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()}`;

  runtime.parseAlpha = (value: string | undefined) => {
    if (!value) {
      return 1;
    }
    if (value.endsWith("%")) {
      return Number(value.slice(0, -1)) / 100;
    }
    return Number(value);
  };

  runtime.formatComputedColor = (value: string) => {
    const normalized = value.trim();
    const match =
      /^rgba?\(\s*([0-9.]+)(?:,|\s)+([0-9.]+)(?:,|\s)+([0-9.]+)(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/iu.exec(
        normalized,
      );
    if (!match) {
      return normalized;
    }

    const redValue = match[1];
    const greenValue = match[2];
    const blueValue = match[3];
    if (!redValue || !greenValue || !blueValue) {
      return normalized;
    }

    const red = Number(redValue);
    const green = Number(greenValue);
    const blue = Number(blueValue);
    const alpha = parseAlpha(match[4]);
    if ([red, green, blue, alpha].some((channel) => Number.isNaN(channel))) {
      return normalized;
    }
    if (alpha <= 0) {
      return "transparent";
    }

    return toHexColor(red, green, blue);
  };

  runtime.readStyleSummary = (element: Element): WebElementStyleSummary => {
    const style = window.getComputedStyle(element);
    const backgroundColor = formatComputedColor(style.backgroundColor);
    return {
      ...(backgroundColor !== "transparent" ? { backgroundColor } : {}),
      color: formatComputedColor(style.color),
      display: style.display,
      fontFamily: truncate(style.fontFamily, 160),
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
    };
  };

  runtime.formatFont = (style: WebElementStyleSummary) =>
    truncate([style.fontSize, style.fontFamily].filter(Boolean).join(" "), 96);

  runtime.formatElementSize = (rect: DOMRect) =>
    `${Math.round(rect.width)}x${Math.round(rect.height)}`;

  runtime.hasVisibleBackground = (style: WebElementStyleSummary) =>
    Boolean(
      style.backgroundColor &&
      style.backgroundColor !== "transparent" &&
      style.backgroundColor !== "rgba(0, 0, 0, 0)",
    );

  runtime.cssEscape = (value: string) => {
    const escape = (window.CSS as { escape?: (input: string) => string } | undefined)?.escape;
    if (escape) {
      return escape(value);
    }
    return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  };

  runtime.readElementText = (element: Element) => {
    if (element instanceof HTMLInputElement) {
      if (element.type.toLowerCase() === "password") {
        return "[masked password input]";
      }
      return truncate(
        element.getAttribute("aria-label") ||
          element.getAttribute("placeholder") ||
          element.name ||
          element.type,
        options.maxTextChars,
      );
    }

    if (element instanceof HTMLTextAreaElement) {
      return truncate(
        element.getAttribute("aria-label") ||
          element.getAttribute("placeholder") ||
          element.name ||
          "textarea",
        options.maxTextChars,
      );
    }

    return truncate(
      (element as HTMLElement).innerText || element.textContent,
      options.maxTextChars,
    );
  };

  runtime.getImplicitRole = (element: Element) => {
    const tagName = element.tagName.toLowerCase();
    if (tagName === "button") return "button";
    if (tagName === "a" && element.hasAttribute("href")) return "link";
    if (tagName === "img") return "img";
    if (tagName === "input") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "button" || type === "submit" || type === "reset") return "button";
      return "textbox";
    }
    if (tagName === "textarea") return "textbox";
    if (tagName === "select") return "combobox";
    if (tagName === "nav") return "navigation";
    if (tagName === "main") return "main";
    if (tagName === "form") return "form";
    if (/^h[1-6]$/u.test(tagName)) return "heading";
    return "";
  };

  runtime.getAccessibleName = (element: Element) => {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const label = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      const normalizedLabel = truncate(label, options.maxTextChars);
      if (normalizedLabel) return normalizedLabel;
    }

    return truncate(
      element.getAttribute("aria-label") ||
        element.getAttribute("alt") ||
        element.getAttribute("title") ||
        element.getAttribute("placeholder") ||
        readElementText(element),
      options.maxTextChars,
    );
  };

  runtime.getAttributes = (element: Element) => {
    const attributes: Record<string, string> = {};
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const allowed =
        name === "id" ||
        name === "class" ||
        name === "href" ||
        name === "src" ||
        name === "alt" ||
        name === "title" ||
        name === "name" ||
        name === "type" ||
        name === "placeholder" ||
        name.startsWith("aria-");
      if (!allowed || name === "value") {
        continue;
      }
      attributes[name] = truncate(attribute.value, options.maxAttributeChars);
    }
    return attributes;
  };

  runtime.getSelector = (element: Element) => {
    if (element.id) {
      return `#${cssEscape(element.id)}`;
    }

    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
      const tagName = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift(`${tagName}#${cssEscape(current.id)}`);
        break;
      }

      const currentTagName = current.tagName;
      const classNames = Array.from(current.classList)
        .filter(Boolean)
        .slice(0, 2)
        .map((className) => `.${cssEscape(className)}`)
        .join("");
      let part = `${tagName}${classNames}`;
      const parentElement: Element | null = current.parentElement;
      if (parentElement) {
        const sameTagSiblings = Array.from(parentElement.children).filter(
          (sibling): sibling is Element =>
            sibling instanceof Element && sibling.tagName === currentTagName,
        );
        if (sameTagSiblings.length > 1) {
          part += `:nth-of-type(${sameTagSiblings.indexOf(current) + 1})`;
        }
      }
      parts.unshift(part);
      current = parentElement;
    }

    return parts.join(" > ");
  };

  runtime.getXPath = (element: Element) => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 12) {
      const tagName = current.tagName.toLowerCase();
      const currentTagName = current.tagName;
      const parentElement: Element | null = current.parentElement;
      if (!parentElement) {
        parts.unshift(`/${tagName}`);
        break;
      }
      const sameTagSiblings = Array.from(parentElement.children).filter(
        (sibling): sibling is Element =>
          sibling instanceof Element && sibling.tagName === currentTagName,
      );
      const index = sameTagSiblings.indexOf(current) + 1;
      parts.unshift(`${tagName}[${index}]`);
      current = parentElement;
    }
    return `/${parts.join("/")}`.replace(/^\/\//u, "/");
  };

  runtime.getNearbyText = (element: Element) => {
    const container =
      element.closest("article, section, main, form, li, tr, dialog") ||
      element.parentElement ||
      element;
    return truncate(
      (container as HTMLElement).innerText || container.textContent,
      options.maxTextChars,
    );
  };

  runtime.getHtmlExcerpt = (element: Element) => {
    const clone = element.cloneNode(true);
    if (!(clone instanceof Element)) {
      return "";
    }
    clone.querySelectorAll("script, style, noscript, template").forEach((node) => {
      node.remove();
    });
    clone.querySelectorAll("input, textarea").forEach((node) => {
      if (node instanceof HTMLInputElement) {
        node.removeAttribute("value");
        if (node.type.toLowerCase() === "password") {
          node.setAttribute("type", "password");
        }
      }
      if (node instanceof HTMLTextAreaElement) {
        node.textContent = "";
      }
    });
    return truncate(clone.outerHTML, options.maxHtmlChars);
  };

  runtime.rectToPlainObject = (rect: DOMRect): WebElementRect => ({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  });

  const hoverOverlayStyle = {
    background: "rgba(37, 99, 235, 0.12)",
    border: "2px solid #2563eb",
  } satisfies Partial<CSSStyleDeclaration>;
  const lockedOverlayStyle = {
    background: "rgba(22, 163, 74, 0.14)",
    border: "2px solid #16a34a",
  } satisfies Partial<CSSStyleDeclaration>;

  const overlay = document.createElement("div");
  overlay.setAttribute("data-zcode-web-element-picker", "overlay");
  Object.assign(overlay.style, {
    ...hoverOverlayStyle,
    borderRadius: "4px",
    boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.10)",
    boxSizing: "border-box",
    display: "none",
    left: "0",
    pointerEvents: "none",
    position: "fixed",
    top: "0",
    zIndex: "2147483647",
  } satisfies Partial<CSSStyleDeclaration>);

  const label = document.createElement("div");
  Object.assign(label.style, {
    backdropFilter: "blur(10px)",
    background: "rgba(17, 24, 39, 0.92)",
    border: "1px solid rgba(255, 255, 255, 0.14)",
    borderRadius: "18px",
    boxShadow: "0 18px 38px rgba(15, 23, 42, 0.28)",
    boxSizing: "border-box",
    color: "#f9fafb",
    display: "none",
    font: "12px/1.4 -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
    left: "0",
    maxWidth: "calc(100vw - 16px)",
    minWidth: "214px",
    padding: "12px 18px 14px",
    pointerEvents: "none",
    position: "fixed",
    top: "0",
    width: "min(320px, calc(100vw - 16px))",
    zIndex: "2147483647",
  } satisfies Partial<CSSStyleDeclaration>);

  document.documentElement.append(overlay, label);

  type Phase = "idle" | "hovering" | "adjusting";

  let phase: Phase = "idle";
  let hoveredElement: Element | null = null;
  let chain: WebElementAncestorStep[] = [];
  let chainElements: Element[] = [];
  let chainTruncated = false;
  let level = 0;
  let pickResolve: ((result: WebElementPickerPickResult) => void) | null = null;
  let adjustResolve: ((result: WebElementPickerAdjustResult) => void) | null = null;

  runtime.settlePick = (result: WebElementPickerPickResult) => {
    const resolve = pickResolve;
    pickResolve = null;
    resolve?.(result);
  };

  runtime.settleAdjust = (result: WebElementPickerAdjustResult) => {
    const resolve = adjustResolve;
    adjustResolve = null;
    resolve?.(result);
  };

  runtime.watchHover = (enabled: boolean) => {
    if (enabled) {
      document.addEventListener("mousemove", handleMouseMove, true);
      document.addEventListener("click", handleClick, true);
      document.documentElement.style.cursor = "crosshair";
      return;
    }
    document.removeEventListener("mousemove", handleMouseMove, true);
    document.removeEventListener("click", handleClick, true);
    document.documentElement.style.cursor = "";
  };

  // adjust 阶段冻结 hover 监听后，只剩滚动/缩放需要重定位绿框与标签。
  runtime.watchRelayout = (enabled: boolean) => {
    if (enabled) {
      window.addEventListener("scroll", handleRelayout, { capture: true, passive: true });
      window.addEventListener("resize", handleRelayout);
      return;
    }
    window.removeEventListener("scroll", handleRelayout, { capture: true });
    window.removeEventListener("resize", handleRelayout);
  };

  runtime.cleanup = () => {
    phase = "idle";
    watchHover(false);
    watchRelayout(false);
    document.removeEventListener("keydown", handleKeyDown, true);
    overlay.remove();
    label.remove();
    delete (window as unknown as Record<string, unknown>)[__zcodeWepStateKey];
    chain = [];
    chainElements = [];
    chainTruncated = false;
    level = 0;
    hoveredElement = null;
    // 任意阶段：全部 pending promise 一律以 cancelled 落定（沿用既有契约）。
    settlePick({ status: "cancelled" });
    settleAdjust({ status: "cancelled" });
  };

  runtime.appendPopoverRow = (name: string, value: string | undefined) => {
    if (!value) {
      return;
    }

    const row = document.createElement("div");
    Object.assign(row.style, {
      alignItems: "baseline",
      columnGap: "16px",
      display: "grid",
      gridTemplateColumns: "auto minmax(0, 1fr)",
      minWidth: "0",
    } satisfies Partial<CSSStyleDeclaration>);

    const nameNode = document.createElement("span");
    nameNode.textContent = name;
    Object.assign(nameNode.style, {
      color: "rgba(255, 255, 255, 0.62)",
      fontSize: "15px",
      fontWeight: "600",
      minWidth: "0",
      whiteSpace: "nowrap",
    } satisfies Partial<CSSStyleDeclaration>);

    const valueNode = document.createElement("span");
    valueNode.textContent = value;
    Object.assign(valueNode.style, {
      color: "#ffffff",
      fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace",
      fontSize: "15px",
      fontWeight: "700",
      minWidth: "0",
      overflow: "hidden",
      textAlign: "right",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    } satisfies Partial<CSSStyleDeclaration>);

    row.append(nameNode, valueNode);
    label.append(row);
  };

  runtime.renderPopover = (target: Element, rect: DOMRect, levelLabel?: string) => {
    const style = readStyleSummary(target);
    label.replaceChildren();

    const header = document.createElement("div");
    Object.assign(header.style, {
      alignItems: "baseline",
      columnGap: "16px",
      display: "grid",
      gridTemplateColumns: "minmax(0, 1fr) auto",
      minWidth: "0",
    } satisfies Partial<CSSStyleDeclaration>);

    const tagNode = document.createElement("span");
    // adjust 阶段标题换成层级标签（`tr th` 形态），hover 阶段仍是原始 tag。
    tagNode.textContent = levelLabel ?? target.tagName.toLowerCase();
    Object.assign(tagNode.style, {
      color: "#ffffff",
      fontSize: "16px",
      fontWeight: "800",
      minWidth: "0",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    } satisfies Partial<CSSStyleDeclaration>);

    const sizeNode = document.createElement("span");
    sizeNode.textContent = formatElementSize(rect);
    Object.assign(sizeNode.style, {
      color: "#ffffff",
      fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace",
      fontSize: "15px",
      fontWeight: "800",
      whiteSpace: "nowrap",
    } satisfies Partial<CSSStyleDeclaration>);

    header.append(tagNode, sizeNode);
    label.append(header);
    appendPopoverRow(options.labels.color, style.color);
    if (hasVisibleBackground(style)) {
      appendPopoverRow(options.labels.background, style.backgroundColor);
    }
    appendPopoverRow(options.labels.font, formatFont(style));
  };

  runtime.clampPosition = (value: number, min: number, max: number) =>
    Math.max(min, Math.min(max, value));

  runtime.getPopoverPosition = (rect: DOMRect, labelWidth: number, labelHeight: number) => {
    const padding = 8;
    const gap = 12;
    const maxLeft = Math.max(padding, window.innerWidth - labelWidth - padding);
    const maxTop = Math.max(padding, window.innerHeight - labelHeight - padding);
    const centeredLeft = rect.left + rect.width / 2 - labelWidth / 2;
    const centeredTop = rect.top + rect.height / 2 - labelHeight / 2;
    const candidates = [
      {
        left: clampPosition(centeredLeft, padding, maxLeft),
        top: rect.bottom + gap,
      },
      {
        left: clampPosition(centeredLeft, padding, maxLeft),
        top: rect.top - labelHeight - gap,
      },
      {
        left: rect.right + gap,
        top: clampPosition(centeredTop, padding, maxTop),
      },
      {
        left: rect.left - labelWidth - gap,
        top: clampPosition(centeredTop, padding, maxTop),
      },
    ];
    const viewportSafeCandidate = candidates.find(
      (candidate) =>
        candidate.left >= padding &&
        candidate.top >= padding &&
        candidate.left + labelWidth <= window.innerWidth - padding &&
        candidate.top + labelHeight <= window.innerHeight - padding,
    );

    if (viewportSafeCandidate) {
      return viewportSafeCandidate;
    }

    const availableSpaces = [
      {
        left: clampPosition(centeredLeft, padding, maxLeft),
        size: window.innerHeight - rect.bottom - padding,
        top: clampPosition(rect.bottom + gap, padding, maxTop),
      },
      {
        left: clampPosition(centeredLeft, padding, maxLeft),
        size: rect.top - padding,
        top: clampPosition(rect.top - labelHeight - gap, padding, maxTop),
      },
      {
        left: clampPosition(rect.right + gap, padding, maxLeft),
        size: window.innerWidth - rect.right - padding,
        top: clampPosition(centeredTop, padding, maxTop),
      },
      {
        left: clampPosition(rect.left - labelWidth - gap, padding, maxLeft),
        size: rect.left - padding,
        top: clampPosition(centeredTop, padding, maxTop),
      },
    ].sort((a, b) => b.size - a.size);

    // 交互修正：目标元素靠近边缘或几乎铺满视口时，浮窗无法完全放到元素外侧。
    // 这时选择可用空间最大的方向，并继续夹在视口内，尽量减少对当前选区的遮挡。
    return availableSpaces[0] ?? { left: padding, top: padding };
  };

  runtime.updateOverlay = (target: Element | null, levelLabel?: string) => {
    if (!target || target === overlay || target === label || label.contains(target)) {
      overlay.style.display = "none";
      label.style.display = "none";
      return;
    }

    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      overlay.style.display = "none";
      label.style.display = "none";
      return;
    }

    overlay.style.display = "block";
    overlay.style.left = `${Math.max(0, rect.left)}px`;
    overlay.style.top = `${Math.max(0, rect.top)}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;

    label.style.display = "block";
    renderPopover(target, rect, levelLabel);

    const labelWidth = label.offsetWidth || 240;
    const labelHeight = label.offsetHeight || 90;
    const position = getPopoverPosition(rect, labelWidth, labelHeight);
    label.style.left = `${position.left}px`;
    label.style.top = `${position.top}px`;
  };

  runtime.currentTarget = () => chainElements[level] ?? null;

  /** 幂等：把绿框与层级标签移到档位 `nextLevel`（越界自动夹在链内）。 */
  runtime.showLevel = (nextLevel: number): { level: number; label: string } | null => {
    if (chain.length === 0) {
      updateOverlay(null);
      return null;
    }
    const requested = Number.isFinite(nextLevel) ? Math.floor(nextLevel) : 0;
    level = Math.max(0, Math.min(chain.length - 1, requested));
    const target = currentTarget();
    if (!target) {
      updateOverlay(null);
      return null;
    }
    const levelLabel = __zcodeWepBuildAncestorLabel(chain, level);
    updateOverlay(target, levelLabel);
    return { level, label: levelLabel };
  };

  runtime.collectChainElements = (element: Element, count: number) => {
    const elements: Element[] = [];
    let node: Element | null = element;
    while (node && elements.length < count) {
      elements.push(node);
      node = node.parentElement;
    }
    return elements;
  };

  runtime.enterAdjusting = () => {
    phase = "adjusting";
    watchHover(false);
    watchRelayout(true);
    Object.assign(overlay.style, lockedOverlayStyle);
    showLevel(0);
  };

  /** 退出层级调整：清空链与 pending，等 renderer 再次 pick() 或 cancel()。 */
  runtime.leaveAdjusting = () => {
    phase = "idle";
    watchRelayout(false);
    Object.assign(overlay.style, hoverOverlayStyle);
    updateOverlay(null);
    chain = [];
    chainElements = [];
    chainTruncated = false;
    level = 0;
  };

  runtime.handleMouseMove = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    hoveredElement = target;
    updateOverlay(target);
  };

  runtime.handleRelayout = () => {
    if (phase !== "adjusting") {
      return;
    }
    showLevel(level);
  };

  runtime.collectElement = (element: Element): Omit<WebElementContextPayload, "workspacePath"> => {
    const rect = element.getBoundingClientRect();
    return {
      pageUrl: location.href,
      pageTitle: document.title,
      tagName: element.tagName.toLowerCase(),
      role: element.getAttribute("role") || getImplicitRole(element) || undefined,
      accessibleName: getAccessibleName(element) || undefined,
      selector: getSelector(element),
      xpath: getXPath(element),
      text: readElementText(element) || undefined,
      nearbyText: getNearbyText(element) || undefined,
      htmlExcerpt: getHtmlExcerpt(element) || undefined,
      attributes: getAttributes(element),
      rect: rectToPlainObject(rect),
      style: readStyleSummary(element),
      capturedAt: Date.now(),
    };
  };

  runtime.handleClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (phase !== "hovering" || !hoveredElement) {
      settlePick({ status: "cancelled" });
      return;
    }

    const picked = __zcodeWepComputeAncestorChain(hoveredElement);
    if (picked.chain.length === 0) {
      settlePick({ status: "cancelled" });
      return;
    }

    chain = picked.chain;
    chainTruncated = picked.truncated;
    chainElements = collectChainElements(hoveredElement, picked.chain.length);
    enterAdjusting();
    settlePick({ status: "clicked", chain, chainTruncated });
  };

  runtime.handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" && event.key !== "Enter") {
      return;
    }
    if (phase === "hovering") {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      settlePick({ status: "cancelled" });
      return;
    }
    if (phase !== "adjusting") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      requestRepick();
      return;
    }
    confirm();
  };

  runtime.pick = () => {
    return new Promise<WebElementPickerPickResult>((resolve) => {
      if (pickResolve || adjustResolve) {
        // 每个时刻至多一条 pending：重复发起按取消收敛，不制造第二条悬挂 promise。
        resolve({ status: "cancelled" });
        return;
      }
      phase = "hovering";
      hoveredElement = null;
      chain = [];
      chainElements = [];
      chainTruncated = false;
      level = 0;
      updateOverlay(null);
      watchHover(true);
      pickResolve = resolve;
    });
  };

  runtime.beginAdjust = () => {
    return new Promise<WebElementPickerAdjustResult>((resolve) => {
      if (phase !== "adjusting" || chain.length === 0 || adjustResolve) {
        // 顺序不变量：beginAdjust 必须在 adjusting 阶段且尚未悬挂时发起（confirm/requestRepick
        // 靠这条 promise 落定）。阶段不符按「重选」收敛，renderer 会回到 hover 重新 pick。
        resolve({ status: "repick" });
        return;
      }
      adjustResolve = resolve;
    });
  };

  runtime.showAncestor = (nextLevel: number) => {
    if (phase !== "adjusting") {
      // 防御式：非 adjusting 阶段（或句柄已随页面销毁）一律返回 null，不 reject。
      return null;
    }
    return showLevel(Number(nextLevel));
  };

  runtime.confirm = () => {
    if (phase !== "adjusting" || !adjustResolve) {
      return;
    }
    const target = currentTarget();
    if (!target) {
      return;
    }
    // 确认时按当前层级重新采集（新鲜 capturedAt），不复用 click 时的快照。
    const element = collectElement(target);
    leaveAdjusting();
    settleAdjust({ status: "selected", element });
  };

  runtime.requestRepick = () => {
    if (phase !== "adjusting" || !adjustResolve) {
      return;
    }
    leaveAdjusting();
    settleAdjust({ status: "repick" });
  };

  // 成员赋值不被压缩器推导函数名；解构同样不创建函数，取回局部名后函数体照旧互相引用。
  const {
    truncate,
    clampColorChannel,
    toHexColor,
    parseAlpha,
    formatComputedColor,
    readStyleSummary,
    formatFont,
    formatElementSize,
    hasVisibleBackground,
    cssEscape,
    readElementText,
    getImplicitRole,
    getAccessibleName,
    getAttributes,
    getSelector,
    getXPath,
    getNearbyText,
    getHtmlExcerpt,
    rectToPlainObject,
    settlePick,
    settleAdjust,
    watchHover,
    watchRelayout,
    cleanup,
    appendPopoverRow,
    renderPopover,
    clampPosition,
    getPopoverPosition,
    updateOverlay,
    currentTarget,
    showLevel,
    collectChainElements,
    enterAdjusting,
    leaveAdjusting,
    handleMouseMove,
    handleRelayout,
    collectElement,
    handleClick,
    handleKeyDown,
    pick,
    beginAdjust,
    showAncestor,
    confirm,
    requestRepick,
  } = runtime;

  const handle = {
    pick,
    beginAdjust,
    showAncestor,
    confirm,
    requestRepick,
    cancel: cleanup,
  };

  (window as unknown as Record<string, typeof handle>)[__zcodeWepStateKey] = handle;
  document.addEventListener("keydown", handleKeyDown, true);
  return pick();
}

export function buildWebElementPickerScript(options: WebElementPickerScriptBuildOptions = {}) {
  const resolvedOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
    labels: {
      ...DEFAULT_OPTIONS.labels,
      ...options.labels,
    },
  };
  // 注入脚本自包含：opts、两个 helper 与挂载键全部走位置实参，主函数体内不存在跨作用域的自由标识符。
  return [
    "(function () {",
    `return (${webElementPickerScript.toString()})(${JSON.stringify(resolvedOptions)}, ${computeAncestorChain.toString()}, ${buildAncestorLabel.toString()}, ${JSON.stringify(WEB_ELEMENT_PICKER_STATE_KEY)});`,
    "})()",
  ].join("\n");
}

export function buildWebElementPickerCommandScript(
  method: WebElementPickerCommand,
  ...args: unknown[]
) {
  const serializedArgs = args
    .filter((arg) => arg !== undefined)
    .map((arg) => JSON.stringify(arg))
    .join(", ");
  // 防御式：句柄不存在（页面已导航/实例已销毁）或阶段不符时返回 null，不 reject。
  return [
    "(() => {",
    `const picker = window.${WEB_ELEMENT_PICKER_STATE_KEY};`,
    `if (!picker || typeof picker.${method} !== 'function') return null;`,
    `return picker.${method}(${serializedArgs});`,
    "})()",
  ].join("\n");
}

export function buildCancelWebElementPickerScript() {
  return buildWebElementPickerCommandScript("cancel");
}
