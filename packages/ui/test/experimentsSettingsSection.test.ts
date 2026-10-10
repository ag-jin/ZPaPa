import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IPlatformService } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { isSettingsSectionEnabled, resolveSettingsSection } from "../src/lib/settingsNavigation.js";
import { ExperimentsSection } from "../src/settings/ExperimentsSection.js";
import { createSettingsPageConfig } from "../src/settings/settingsPageConfig.js";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import { ServiceProvider } from "../src/hooks/useServices.js";

/**
 * 卡 #62：main 侧「实验功能」设置宿主（#61 抽取暴露的缺口）。
 *
 * 需求真源：卡文 (1)(2)(4)——
 *  · 照既有分区模式（config 声明 + 导航 + 渲染三面）新增**通用命名**的「实验功能」分区；
 *  · 首行开关 label-only（zh「项目看板」/ en「Project board」，无副文案），
 *    读写走既有 settings 通路（`useSettings().update` ⇒ appSettings.experimentalProjectBoardEnabled），
 *    不另建状态；
 *  · i18n 命名空间 `settings.experiments.*` 双语齐全。
 *
 * 分层（沿用仓库既有形态，见 boardExperimentGate.test.ts 的分层注释）：
 * 本文件覆盖 SSR 结构断言 + 源码守卫 + 词条；「真点击开关 ⇒ 真写设置 ⇒ 入口/面板显隐」
 * 是异步 settings store + 真事件，只有真引擎量得出来 —— 走 test/boardExperimentGateBrowser.ts。
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const SECTION_SOURCE = readFileSync(resolve(SRC, "settings/ExperimentsSection.tsx"), "utf8");
const PAGE_SOURCE = readFileSync(resolve(SRC, "SettingsPage.tsx"), "utf8");

/** SettingsRow 的固定外壳 class（行边界判据；不用文案猜行界）。 */
const SETTINGS_ROW_MARKER = 'class="border-t border-border px-4 py-3 first:border-t-0"';
const TOGGLE_LABEL_KEY = "settings.experiments.projectBoardToggle.label";

function renderSection(locale: "zh-CN" | "en-US"): string {
  // settingService 的最小投影：SSR 不跑 effect，设置快照停在「未加载（null）」——
  // 这正是要钉的一格：未加载完不得把实验开关当成已开启。
  const settingService = {
    get: async () => ({ experimentalProjectBoardEnabled: false }),
    update: async () => {},
  };
  return renderToStaticMarkup(
    createElement(PlatformProvider, {
      platform: {} as unknown as IPlatformService,
      children: createElement(ServiceProvider, {
        services: { settingService } as unknown as IServiceAccessor,
        children: createElement(ZCodeIntlProvider, {
          initialLocale: locale,
          children: createElement(ExperimentsSection, null),
        }),
      }),
    }),
  );
}

/** 切出含指定文案的那一个 SettingsRow（行边界 = SettingsRow 的固定外壳 class）。 */
function rowSliceContaining(markup: string, text: string): string {
  const segments = markup.split(SETTINGS_ROW_MARKER);
  const hit = segments.find((segment) => segment.includes(text));
  assert.ok(hit, `渲染结果里应有一行包含「${text}」：\n${markup}`);
  return hit;
}

test("分区存在｜设置导航新增「实验功能」分区，通用命名不绑死看板", () => {
  const { settingsSections, settingsSectionGroups } = createSettingsPageConfig();
  const section = settingsSections.find((candidate) => candidate.id === "experiments");
  assert.ok(section, "设置配置里应有 experiments 分区（nav 由 config 单点驱动）");
  assert.equal(
    section?.titleId,
    "settings.experiments.title",
    "分区名走 settings.experiments 命名空间",
  );
  const group = settingsSectionGroups.find((candidate) => candidate.id === section?.groupId);
  assert.ok(
    group?.sections.some((candidate) => candidate.id === "experiments"),
    "分区必须真的进导航分组（不是只声明不渲染）",
  );
  assert.equal(isSettingsSectionEnabled("experiments"), true, "分区默认可见（不是隐藏分区）");
  assert.equal(
    resolveSettingsSection("experiments"),
    "experiments",
    "分区 id 可解析，打开设置不回落",
  );
});

test("渲染面｜SettingsPage 把 experiments 分区接到 ExperimentsSection（不是只有导航条目）", () => {
  assert.ok(
    /activeSection === "experiments"/.test(PAGE_SOURCE),
    "SettingsPage 必须有 experiments 的渲染分支",
  );
  assert.ok(PAGE_SOURCE.includes("<ExperimentsSection"), "分支必须真渲染 ExperimentsSection");
});

test("i18n：分区名与开关名双语齐全，开关行无副文案词条", () => {
  assert.equal(zhCN["settings.experiments.title"], "实验功能");
  assert.equal(enUS["settings.experiments.title"], "Experiments");
  assert.equal(zhCN[TOGGLE_LABEL_KEY], "项目看板");
  assert.equal(enUS[TOGGLE_LABEL_KEY], "Project board");
  // 用户明确不要副文案：不定义 description 词条（沿用后台派发开关先例）。
  assert.equal(zhCN["settings.experiments.projectBoardToggle.description"], undefined);
  assert.equal(enUS["settings.experiments.projectBoardToggle.description"], undefined);
});

test("真渲染｜分区只有一行「项目看板」开关，且该行没有解释副文案", () => {
  const markup = renderSection("zh-CN");
  assert.ok(markup.includes("项目看板"), "看板开关行的标签必须渲染");
  const row = rowSliceContaining(markup, "项目看板");
  // 副文案的呈现槽位是 SettingsRow 的 description（text-foreground-subtle 行）；出现即代表有副文案。
  assert.equal(
    row.includes("text-foreground-subtle"),
    false,
    `看板开关行不得有解释副文案：\n${row}`,
  );
  assert.ok(row.includes('role="switch"'), "该行必须带开关控件（不是只放一行字）");
  assert.equal(
    markup.split(SETTINGS_ROW_MARKER).length - 1,
    1,
    "本卡分区只放这一行开关（将来可挂更多，但现在不得多出第二行）",
  );
  assert.equal(
    markup.includes("settings.experiments"),
    false,
    "渲染结果不得漏出裸词条 key（i18n 必须命中）",
  );
});

test("真渲染｜英文界面同一行显示英文词条", () => {
  const markup = renderSection("en-US");
  assert.ok(markup.includes("Project board"), "英文界面必须显示英文词条（不是裸 key/中文）");
  assert.equal(markup.includes("settings.experiments"), false);
});

test("守卫｜开关读写走既有 settings 通路，不另建状态", () => {
  assert.ok(
    SECTION_SOURCE.includes("settings?.experimentalProjectBoardEnabled === true"),
    "checked 必须取自共享 settings 快照的严格 === true（默认关、未加载关）",
  );
  assert.ok(
    /update\(\{\s*experimentalProjectBoardEnabled: enabled\s*\}\)/.test(SECTION_SOURCE),
    "写入必须走 useSettings().update 的同一通路（两个方向同一个调用点）",
  );
  assert.equal(SECTION_SOURCE.includes("createContext"), false, "不得为实验开关新建 Context 状态");
  assert.equal(
    /from "@\/store\//.test(SECTION_SOURCE),
    false,
    "不得另建 store：实验开关事实源只有 appSettings 一份",
  );
});
