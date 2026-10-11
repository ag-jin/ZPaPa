/**
 * 指引面**亮/暗色对比量取**（卡 #142 / C3-7 交付面③）——独立脚本，文件名不含 `.test.`
 * （`node --test` 常规套件不收它）。
 *
 * 为什么必须实测而不是只推 token：辅助文字 token 带 alpha（`foreground-subtle` = 60%），
 * 且元素坐在多层半透明底色（`bg-surface` = 5% 白）上——有效对比度依赖**真实层叠**；
 * 本脚本在真 Tailwind 产物 CSS + 真引擎里逐元素合成求值（公式与 E7 §8.2 同口径）。
 *
 * 判据来源（独立真源，不是量取值的转写）：
 *   - E7 §8.2：正文至少 4.5:1，组件/图标至少 3:1（暗色下同样成立）；
 *   - 交付面③：为 ui-designer 第四绿（亮/暗可读）留数据面。
 * 已知家族项（登记不修，全仓 token 面另立）：light 档 `foreground-subtle` ≈3.3:1 低于 AA——
 * 本脚本对「次要文字」在暗档按 3:1 底线断言并把实测值全量打出；4.5:1 目标面（主文字/
 * 摘要行的暗档实测）单独断言，数值不达标即红（不把测量值反过来写成期望值）。
 *
 * 命令（在 `packages/ui` 下）：
 *   node --import tsx test/boardGuideContrastBrowser.ts
 */
import assert from "node:assert/strict";
import { guideContrastDriverSource } from "./boardGuideContrastBrowserDrivers.js";
import { GUIDE_BOARD } from "./boardGuideFixture.js";
import {
  buildPageHtml,
  bundleBoardPaneClient,
  compileBoardPaneCss,
  resolveElectronBinary,
  runBoardPaneInElectron,
} from "./boardKanbanBrowserLayoutHarness.js";

/** 单元素对比量取（页面内计算；`ratio` = WCAG 对比度）。 */
interface ContrastMeasure {
  label: string;
  role: string;
  missing: boolean;
  text?: string;
  fontSize?: number;
  color?: string;
  colorRgb?: string;
  bgRgb?: string;
  ratio?: number;
}

interface ContrastTheme {
  themeClass: string;
  bgToken?: string;
  elements: ContrastMeasure[];
}

interface ContrastResult {
  ua: string;
  light: ContrastTheme;
  dark: ContrastTheme;
}

/**
 * 亮档**低于 AA（4.5:1）且本卡登记不修**的既有家族项（来源 = 交付面③「已知家族项维持登记不修」
 * 口径 + 本次实测）：
 *   - 计划 rollup 缺口徽章：`BOARD_WARNING_BADGE_CLASS`（warning 描边/浅底 + warning 文字，
 *     卡级缺口徽章与 A4 层头跨视图共用）——亮档实测 2.4:1；修它要动 warning 色族/共享徽章类，
 *     属全仓 token/组件面另立，不在本卡 diff。
 * 探测脚本对登记项只守「可见底线 ≥2:1」；主文字与摘要行不在此列（各自 ≥4.5 硬断言）。
 */
const LIGHT_BELOW_AA_FAMILY: Record<string, string> = {
  "plan-gap-badge": "warning 色族共享徽章类（亮档实测 2.4:1；全仓 token 面另立）",
};

/** 量取表里的元素族（按标签取；缺元素 = 夹具形态变化，直接红）。 */
function byLabel(theme: ContrastTheme, label: string): ContrastMeasure {
  const measure = theme.elements.find((entry) => entry.label === label);
  assert.ok(measure, `亮/暗量取表应有 ${label}`);
  assert.equal(measure.missing, false, `${label} 应渲染（缺元素 = 量取目标失效）`);
  assert.ok(typeof measure.ratio === "number", `${label} 应有对比度数值`);
  return measure;
}

/**
 * 对比量取场景板（#142）：在 `GUIDE_BOARD` 上只加一处 attention 码（卡 #211）——让计划 A 的
 * rollup 缺口徽章进渲染面（warning 色族要量），其余形态与原夹具逐字一致（量取面不另造形态）。
 */
function buildContrastBoardJson(): string {
  const raw = structuredClone(GUIDE_BOARD);
  const features = raw.features as Array<Record<string, unknown>>;
  const planA = features.find((feature) => feature.id === "plan:plan-guide-a");
  assert.ok(planA, "夹具里应有计划 A");
  const card211 = (planA.tasks as Array<Record<string, unknown>>).find((task) => task.no === 211);
  assert.ok(card211, "夹具里应有卡 #211");
  card211.attention = ["interrupted-resume"];
  return JSON.stringify(raw);
}

async function main(): Promise<void> {
  const bundle = await bundleBoardPaneClient();
  const boardJson = buildContrastBoardJson();
  const css = await compileBoardPaneCss({ boards: [boardJson], viewModes: ["guide"] });
  console.log(
    `bundle bytes=${bundle.length} css bytes=${css.length} electron=${resolveElectronBinary()}`,
  );
  const result = (await runBoardPaneInElectron({
    pageHtml: buildPageHtml({ css, boardJson, bundle }),
    driver: guideContrastDriverSource(),
    label: "guide-contrast",
  })) as ContrastResult | null;
  console.log(`GUIDE_CONTRAST_MEASUREMENTS=${JSON.stringify(result, null, 1)}`);
  assert.ok(result, "对比量取场景应回传结果");
  console.log(
    `主题类：亮=${result.light.themeClass || "(root)"} · 暗=${result.dark.themeClass}（暗档基底 ${result.dark.bgToken}）`,
  );
  for (const theme of [result.light, result.dark]) {
    console.log(
      theme === result.light ? "— 亮档 —" : "— 暗档 —",
      theme.elements
        .map((entry) => `${entry.label}=${entry.ratio}:1(${entry.fontSize}px)`)
        .join(" · "),
    );
  }

  /* 1. 暗档「正文」全量 ≥4.5:1（E7 §8.2：正文至少 4.5:1，暗色下同样成立）——指引面各元素
     实测都在 4.5 以上（见量取表）；下探即红。 */
  for (const measure of result.dark.elements) {
    assert.ok(
      (measure.ratio ?? 0) >= 4.5,
      `暗档 ${measure.label}（${measure.fontSize}px 正文/标签）≥4.5:1（实测 ${measure.ratio}:1）`,
    );
  }

  /* 2. 亮档：主文字族 ≥4.5:1（与暗档同口径）；辅助文字族（`foreground-subtle`，12–14px）
     实测 ≈3.1–3.2:1——**已知家族项**（交付面③口径：维持登记不修，全仓 token 面另立），
     此处守 3:1 组件级下限；4.5 目标值如实打进量取表。 */
  const lightMainLabels = [
    "plans-title",
    "slot-value",
    "plan-title",
    "progress-count",
    "queue-title",
  ];
  for (const label of lightMainLabels) {
    const measure = byLabel(result.light, label);
    assert.ok(
      (measure.ratio ?? 0) >= 4.5,
      `亮档 ${label}（主文字 ${measure.fontSize}px）≥4.5:1（实测 ${measure.ratio}:1）`,
    );
  }
  for (const measure of result.light.elements) {
    if (lightMainLabels.includes(measure.label)) continue;
    if (LIGHT_BELOW_AA_FAMILY[measure.label]) continue;
    assert.ok(
      (measure.ratio ?? 0) >= 3,
      `亮档 ${measure.label}（辅助 ${measure.fontSize}px）≥3:1 下限（实测 ${measure.ratio}:1）`,
    );
  }
  /* 亮档登记不修的 <AA 家族项：只守「可见底线 ≥2:1」（防坏成黑压黑/白压白），
     AA 目标值打入量取表供 ui-designer 判读（详见文件头与证据报告）。 */
  for (const [label, note] of Object.entries(LIGHT_BELOW_AA_FAMILY)) {
    const measure = byLabel(result.light, label);
    assert.ok(
      (measure.ratio ?? 0) >= 2,
      `亮档 ${label}（${note}）≥2:1 可见底线（实测 ${measure.ratio}:1）`,
    );
    console.log(`亮档登记项（<AA 不修）：${label}=${measure.ratio}:1 —— ${note}`);
  }

  /* 3. 字号底线在对比量取里顺带核（不改 #141 口径）：辅助 ≥12px、主文字 ≥14px。 */
  assert.ok((byLabel(result.dark, "slot-label").fontSize ?? 0) >= 12, "槽标签字号 ≥12px");
  assert.ok((byLabel(result.dark, "queue-title").fontSize ?? 0) >= 14, "队列卡名字号 ≥14px");

  console.log(
    "GUIDE_CONTRAST_BROWSER_ASSERTIONS_OK 亮/暗两档量取全量打出；暗档全量正文/标签 ≥4.5:1、" +
      "亮档主文字 ≥4.5:1（辅助族守 3:1 底线，foreground-subtle 家族项登记不修）、字号底线不破（12/14px）",
  );
}

await main();
