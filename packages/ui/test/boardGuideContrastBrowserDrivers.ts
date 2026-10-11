/**
 * 指引面亮/暗色对比量取的**页面内驱动**（卡 #142 / C3-7 交付面③；判据（阈值断言）留在
 * `boardGuideContrastBrowser.ts`）。
 *
 * 量法（真排版 + 真计算色）：
 * - 亮档先量一轮，再把页面切到暗色（`html.dark`，与产品主题同一 class 变体）复量同一批元素；
 * - 底色按**真实层叠**求：沿祖先链收集非透明 `background-color`，自底向上用 alpha 合成
 *   （`foreground-subtle` 等 token 带 60% alpha，不能拿 token 原值直接比）；
 * - 页面基底显式设为 `var(--color-background)`（产品里板面板坐在主题背景上；harness 页面本身
 *   无底色，不设会把暗档量到 Chromium 默认白底上，量出假数值）；
 * - 对比度用 WCAG 相对亮度公式（与 E7 §8.2「正文 ≥4.5:1、组件/图标 ≥3:1」同口径）。
 *
 * 只量取、不判据：返回逐元素 {label, text, fontSize, color, bg, ratio}，阈值断言在脚本侧。
 */

export function guideContrastDriverSource(): string {
  return `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (read, label, timeoutMs) => {
    const limit = Date.now() + (timeoutMs || 15000);
    for (;;) {
      const value = read();
      if (value) return value;
      if (Date.now() > limit) throw new Error("等待超时：" + label);
      await sleep(25);
    }
  };
  const switchToView = async (mode) => {
    await waitFor(() => document.querySelector("[data-board-pane]"), "面板渲染");
    const option = await waitFor(
      () => document.querySelector('[data-board-view-option="' + mode + '"]'),
      "视图切换控件 " + mode,
    );
    option.click();
    await waitFor(() => document.querySelector('[data-board-view="' + mode + '"]'), "视图渲染 " + mode);
  };
  /* 计算色解析：Chromium 计算值保留色彩空间（oklch/oklab/color(srgb …)），canvas fillStyle
     回读也保留原空间——统一走 1×1 画布绘制 + getImageData 像素回读（canvas 后备存储是
     sRGB，像素即最终 sRGB 通道 + alpha）。取值只来自 getComputedStyle（必为合法 CSS 色）。 */
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  const parseRgb = (value) => {
    if (!value) return null;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const pixels = ctx.getImageData(0, 0, 1, 1).data;
    const [r, g, b, a] = [pixels[0], pixels[1], pixels[2], pixels[3]];
    // 透明色（含解析失败的回落透明）签名 = 全 0 像素；调用方对 alpha 分档处理。
    return { r, g, b, a: a / 255 };
  };
  /* 自上而下 alpha 合成（top 覆盖 bottom）。 */
  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  });
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const luminance = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const contrastRatio = (fg, bg) => {
    const a = luminance(fg);
    const b = luminance(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  /* 有效底色：沿祖先链收非透明底色，自底向上合成（页面基底 = #host 的主题背景——
     styles.css 对 html/body/#root 有 background: transparent !important（Electron vibrancy
     规则），底色落在宿主容器上；解析不出来就返回 null，由量取表显式暴露，不静默拿白底凑数）。 */
  const effectiveBg = (node) => {
    const layers = [];
    let cur = node;
    while (cur) {
      const color = parseRgb(getComputedStyle(cur).backgroundColor);
      if (color && color.a > 0) {
        layers.push(color);
        if (color.a >= 1) break;
      }
      cur = cur.parentElement;
    }
    const base = parseRgb(getComputedStyle(host).backgroundColor);
    if (!base || base.a < 1) return null;
    let out = base;
    for (const layer of layers.reverse()) out = over(layer, out);
    return out;
  };
  const rgbText = (c) =>
    "rgb(" + Math.round(c.r) + ", " + Math.round(c.g) + ", " + Math.round(c.b) + ")";
  /* 量取清单（指引面各元素；一次定义，两档复用）。 */
  const targets = [
    { label: "plans-title", selector: "[data-board-guide-plans] h2", role: "title" },
    { label: "slot-label", selector: "[data-board-guide-slot] > span:nth-of-type(1)", role: "secondary" },
    { label: "slot-value", selector: "[data-board-guide-slot] > span:nth-of-type(2)", role: "main" },
    { label: "slot-hint", selector: "[data-board-guide-slot] > span:nth-of-type(3)", role: "secondary" },
    { label: "plan-title", selector: "[data-board-guide-plan] span[title]", role: "main" },
    { label: "plan-summary", selector: "[data-board-guide-plan-summary]", role: "secondary" },
    { label: "plan-count-chip", selector: "[data-board-guide-plan-card-count]", role: "chip" },
    { label: "plan-gap-badge", selector: "[data-board-guide-plan-gap-count]", role: "badge" },
    { label: "progress-count", selector: "[data-board-guide-plan-progress] span > span:nth-of-type(1)", role: "main" },
    { label: "progress-percent", selector: "[data-board-guide-plan-percent]", role: "secondary" },
    { label: "queue-title", selector: "[data-board-guide-plan-queue] [data-board-card] span[title]", role: "main" },
    { label: "queue-deps-chip", selector: "[data-board-guide-queue-deps]", role: "chip" },
    { label: "queue-next", selector: "[data-board-guide-queue-next]", role: "secondary" },
  ];
  const measure = (target) => {
    const node = document.querySelector(target.selector);
    if (!node) return { label: target.label, role: target.role, missing: true };
    const style = getComputedStyle(node);
    const fg = parseRgb(style.color);
    const bg = effectiveBg(node);
    if (!fg || !bg) {
      return {
        label: target.label,
        role: target.role,
        missing: false,
        error: "色彩解析失败",
        color: style.color,
      };
    }
    const flattened = over(fg, bg);
    return {
      label: target.label,
      role: target.role,
      missing: false,
      text: (node.textContent || "").trim().slice(0, 40),
      fontSize: parseFloat(style.fontSize),
      color: style.color,
      colorRgb: rgbText(flattened),
      bgRgb: rgbText(bg),
      ratio: Math.round(contrastRatio(flattened, bg) * 100) / 100,
    };
  };
  const measureAll = () => targets.map(measure);

  await switchToView("guide");
  await waitFor(() => document.querySelector('[data-board-view="guide"]'), "指引面渲染");
  /* 页面基底 = 主题背景（产品里板面板坐在主题背景上；harness 页面无底色，不设会把暗档量到
     Chromium 默认白底上，量出假数值）。styles.css 对 html/body/#root 有
     background: transparent !important（Electron vibrancy），底色落宿主容器 #host。 */
  const host = document.getElementById("host");
  const pane = document.querySelector("[data-board-pane]");
  const baseColor =
    (pane && getComputedStyle(pane).getPropertyValue("--color-background").trim()) ||
    getComputedStyle(document.documentElement).getPropertyValue("--color-background").trim() ||
    "white";
  host.style.backgroundColor = baseColor;
  await sleep(200);
  const light = {
    themeClass: document.documentElement.className,
    baseColor,
    bgToken: getComputedStyle(host).backgroundColor,
    elements: measureAll(),
  };

  document.documentElement.classList.add("dark");
  const darkBaseColor =
    getComputedStyle(document.documentElement).getPropertyValue("--color-background").trim() ||
    "black";
  host.style.backgroundColor = darkBaseColor;
  await sleep(220);
  const dark = {
    themeClass: document.documentElement.className,
    baseColor: darkBaseColor,
    bgToken: getComputedStyle(host).backgroundColor,
    elements: measureAll(),
  };

  return { ua: navigator.userAgent, light, dark };
})();
`;
}
