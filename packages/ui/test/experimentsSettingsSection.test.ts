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
 * 卡 #202（A1）：实验功能**第二行**「ask-matt 开发流程」开关 + 乘积态说明行。
 * 卡 #235（F10）：D11 裁决在该开关行补一句「开启时同名自定义命令让位」（description 槽位启用；
 * 看板行不受影响）。
 *
 * 需求真源：卡文 (1)(2)(4)——照既有分区模式（config 声明 + 导航 + 渲染三面）；
 *  · #62 首行「项目看板」开关 label-only（zh「项目看板」/ en「Project board」，无副文案），
 *    读写走既有 settings 通路（`useSettings().update` ⇒ appSettings.experimentalProjectBoardEnabled），
 *    不另建状态；
 *  · #202 第二行「ask-matt 开发流程」写 `experimentalAskMattFlowEnabled`；
 *    板关+流开时开关页显示状态说明一行（非副文案，判据走纯函数 askMattFlowBoardClosedNoticeVisible）；
 *    #235/F10 D11 起该行带一句让位说明（label-only 只对看板行仍有约束）；
 *  · i18n 命名空间 `settings.experiments.*` 双语齐全。
 *
 * 分层（沿用仓库既有形态，见 boardExperimentGate.test.ts 的分层注释）：
 * 本文件覆盖 SSR 结构断言 + 源码守卫 + 词条；「真点击开关 ⇒ 真写设置 ⇒ 入口/面板显隐」
 * 是异步 settings store + 真事件，只有真引擎量得出来 —— 走 test/boardExperimentGateBrowser.ts /
 * test/boardExperimentsSettingsBrowser.ts。
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const SECTION_SOURCE = readFileSync(resolve(SRC, "settings/ExperimentsSection.tsx"), "utf8");
const PAGE_SOURCE = readFileSync(resolve(SRC, "SettingsPage.tsx"), "utf8");

/** SettingsRow 的固定外壳 class（行边界判据；不用文案猜行界）。 */
const SETTINGS_ROW_MARKER = 'class="border-t border-border px-4 py-3 first:border-t-0"';
const TOGGLE_LABEL_KEY = "settings.experiments.projectBoardToggle.label";
const ASK_MATT_LABEL_KEY = "settings.experiments.askMattFlowToggle.label";
const ASK_MATT_NOTICE_KEY = "settings.experiments.askMattFlowBoardClosedNotice";

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

test("i18n：分区名与两行开关名双语齐全；ask-matt 行带 D11 让位说明，看板行无副文案词条", () => {
  assert.equal(zhCN["settings.experiments.title"], "实验功能");
  assert.equal(enUS["settings.experiments.title"], "Experiments");
  assert.equal(zhCN[TOGGLE_LABEL_KEY], "项目看板");
  assert.equal(enUS[TOGGLE_LABEL_KEY], "Project board");
  assert.equal(zhCN[ASK_MATT_LABEL_KEY], "ask-matt 开发流程");
  assert.ok(
    (enUS[ASK_MATT_LABEL_KEY] ?? "").trim().length > 0 &&
      enUS[ASK_MATT_LABEL_KEY] !== ASK_MATT_LABEL_KEY,
    "第二行英文词条必须存在且不是裸 key",
  );
  // 看板行沿用「不要副文案」偏好：不定义 description 词条。
  assert.equal(zhCN["settings.experiments.projectBoardToggle.description"], undefined);
  assert.equal(enUS["settings.experiments.projectBoardToggle.description"], undefined);
  // #235/F10 D11 裁决：ask-matt 行补一句「开启时同名自定义命令让位」（设计稿 §6）——
  // label-only 只对看板行保留；本行 description 槽位自本卡起启用。
  assert.equal(
    zhCN["settings.experiments.askMattFlowToggle.description"],
    "开启时同名自定义命令让位",
  );
  assert.ok(
    (enUS["settings.experiments.askMattFlowToggle.description"] ?? "").trim().length > 0 &&
      enUS["settings.experiments.askMattFlowToggle.description"] !==
        "settings.experiments.askMattFlowToggle.description",
    "ask-matt 行英文让位说明必须存在且不是裸 key",
  );
  // 乘积态说明行是**独立一行**（不是 description），两语都要有词条。
  assert.ok((zhCN[ASK_MATT_NOTICE_KEY] ?? "").trim().length > 0, "说明行中文词条必须存在");
  assert.ok(
    (enUS[ASK_MATT_NOTICE_KEY] ?? "").trim().length > 0 &&
      enUS[ASK_MATT_NOTICE_KEY] !== ASK_MATT_NOTICE_KEY,
    "说明行英文词条必须存在且不是裸 key",
  );
});

test("真渲染｜两行开关：第一行项目看板 label-only；第二行 ask-matt 开发流程带 D11 让位说明", () => {
  const markup = renderSection("zh-CN");
  // 可见标签判据用「文本节点」形态（>文案<），不用裸 includes：
  // aria-label 也是同一文案，只做裸 includes 会把「可见标签被换掉、aria-label 还在」的坏法判绿。
  assert.ok(markup.includes(">项目看板</div>"), "看板开关行的可见标签必须渲染");
  assert.ok(
    markup.includes(">ask-matt 开发流程</div>"),
    "第二行 ask-matt 流程开关的可见标签必须渲染",
  );
  const boardRow = rowSliceContaining(markup, "项目看板");
  // 副文案的呈现槽位是 SettingsRow 的 description（text-foreground-subtle 行）；出现即代表有副文案。
  assert.equal(
    boardRow.includes("text-foreground-subtle"),
    false,
    `看板开关行不得有解释副文案：\n${boardRow}`,
  );
  assert.ok(boardRow.includes('role="switch"'), "看板行必须带开关控件（不是只放一行字）");
  const askMattRow = rowSliceContaining(markup, "ask-matt 开发流程");
  assert.ok(
    askMattRow.includes(">ask-matt 开发流程</div>"),
    `第二行的可见标签必须是 ask-matt 开发流程（不得只挂在 aria-label 上）：\n${askMattRow}`,
  );
  // #235/F10 D11：ask-matt 行必须带让位说明（description 槽位），可见文本节点 = 词条原文。
  const askMattDescription = zhCN["settings.experiments.askMattFlowToggle.description"] ?? "";
  assert.ok(askMattDescription.length > 0, "D11 让位说明 zh 词条必须存在（守卫失败则本断言先红）");
  assert.ok(
    askMattRow.includes("text-foreground-subtle"),
    `ask-matt 流程开关行必须带 D11 让位说明（description 槽位）：\n${askMattRow}`,
  );
  assert.ok(
    askMattRow.includes(`>${askMattDescription}</div>`),
    `让位说明必须是词条原文的可见文本节点（不得只挂在属性/裸 key）：\n${askMattRow}`,
  );
  assert.ok(askMattRow.includes('role="switch"'), "ask-matt 流程行必须带开关控件");
  assert.equal(
    markup.split(SETTINGS_ROW_MARKER).length - 1,
    2,
    "分区放两行开关（#62 看板 + #202 ask-matt 流程）；说明行不得冒充 SettingsRow",
  );
  assert.equal(
    markup.includes("settings.experiments"),
    false,
    "渲染结果不得漏出裸词条 key（i18n 必须命中）",
  );
});

test("真渲染｜设置未加载（SSR）时不渲染乘积态说明行（说明行要等真实开关快照）", () => {
  // SSR 不跑 effect，settings 停在 null；说明行由快照驱动，此时必须缺席。
  const markup = renderSection("zh-CN");
  assert.equal(
    markup.includes(zhCN[ASK_MATT_NOTICE_KEY] ?? "\u0000"),
    false,
    `设置未加载时不得显示板关+流开的说明行：\n${markup}`,
  );
});

test("真渲染｜英文界面同一行显示英文词条", () => {
  const markup = renderSection("en-US");
  assert.ok(markup.includes(">Project board</div>"), "英文界面必须显示英文词条（不是裸 key/中文）");
  assert.ok(
    markup.includes(`>${enUS[ASK_MATT_LABEL_KEY]}</div>`),
    "英文界面第二行的可见标签必须显示英文词条",
  );
  // #235/F10 D11：英文界面同行的让位说明也必须是英文词条原文（可见文本节点）。
  const enDescription = enUS["settings.experiments.askMattFlowToggle.description"] ?? "";
  assert.ok(enDescription.length > 0, "D11 让位说明 en 词条必须存在（守卫失败则本断言先红）");
  assert.ok(markup.includes(`>${enDescription}</div>`), "英文界面 ask-matt 行必须显示英文让位说明");
  assert.equal(markup.includes("settings.experiments"), false);
});

test("守卫｜两行开关读写走既有 settings 通路，不另建状态", () => {
  assert.ok(
    SECTION_SOURCE.includes("settings?.experimentalProjectBoardEnabled === true"),
    "看板 checked 必须取自共享 settings 快照的严格 === true（默认关、未加载关）",
  );
  assert.ok(
    /update\(\{\s*experimentalProjectBoardEnabled: enabled\s*\}\)/.test(SECTION_SOURCE),
    "看板写入必须走 useSettings().update 的同一通路（两个方向同一个调用点）",
  );
  assert.ok(
    SECTION_SOURCE.includes("settings?.experimentalAskMattFlowEnabled === true"),
    "ask-matt 流程 checked 必须取自共享 settings 快照的严格 === true（默认关、未加载关）",
  );
  assert.ok(
    /update\(\{\s*experimentalAskMattFlowEnabled: enabled\s*\}\)/.test(SECTION_SOURCE),
    "ask-matt 流程写入必须走 useSettings().update 的同一通路（两个方向同一个调用点）",
  );
  assert.equal(SECTION_SOURCE.includes("createContext"), false, "不得为实验开关新建 Context 状态");
  assert.equal(
    /from "@\/store\//.test(SECTION_SOURCE),
    false,
    "不得另建 store：实验开关事实源只有 appSettings 一份",
  );
});

test("守卫｜乘积态说明行判据走纯函数单点 + 说明行不占 description 槽位", () => {
  assert.ok(
    SECTION_SOURCE.includes("askMattFlowBoardClosedNoticeVisible"),
    "说明行显隐必须问纯函数判据（板关+流开），不得在视图里手写两开关比较",
  );
  assert.ok(SECTION_SOURCE.includes(ASK_MATT_NOTICE_KEY), "说明行文案必须走词条（不得硬编码中文）");
  // 说明行是独立一行：它渲染在 SettingsRow 之外，因此不得出现在任何行的 description 槽位。
  const askMattRow = rowSliceContaining(renderSection("zh-CN"), "ask-matt 开发流程");
  assert.equal(askMattRow.includes(ASK_MATT_NOTICE_KEY), false);
});
