import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

/**
 * ask-matt 流程面的 i18n 收口守卫（卡 #213/A12，承 #202/A1 与 #204/A3）。
 *
 * 卡文验收「双语零硬编码（断言）」的可核对形态（先例：boardI18n.test.ts 指引面键清单、
 * browserElementReviewI18n.test.ts 键集逐条钉死、subagentsSettingsI18n.test.ts 死键成对删除）：
 *  · 键清单：设置开关行与状态说明（ask-matt 专属命名空间）+ 三命令所走 `/` 面板命令段的
 *    段标题与空态（命令面 chrome），两语逐键齐全、非空、非裸 key、占位符一致、en 侧无中文残留；
 *  · 零硬编码：流程面渲染源码（设置区 + `/` 面板）不得出现裸文案（中文串 / JSX 英文文本
 *    节点 / 字面量用户可见属性）——文案必须走词条；
 *  · 源码字面量对账：面源码里出现的 settings/chat 键字面量必须两语可解析（拼错 key 会静默
 *    渲染成裸 key，这类坏法只有源码级扫描拦得住）。
 *
 * 命令面词条边界（本卡评估结论，对齐记录见仓库根 DESIGN.md 的 Settings 段）：三命令的可见
 * 描述来自协议目录数据（CLI `ASK_MATT_FLOW_COMMANDS.description`，与全部内置命令
 * `BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES` 同一约定；CLI/TUI 无词条表），App 不把它
 * 复制成第二真源，因此不设命令描述键；App 侧流程面文案只有下列六键。新增任何流程面键
 * （含给开关加副文案）都必须显式进清单——设置面命名空间集合相等会拦住，见用例 2。
 *
 * 期望值的独立真源：两语词条表 + 流程面源码本身（不重算实现里的任何算式）。
 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

/** 设置面（开关行 + 板关流开状态说明行）的渲染单点。 */
const SETTINGS_FACE_FILE = "settings/ExperimentsSection.tsx";
/** 三命令所走 `/` 面板命令段的渲染单点（命令/技能/子智能体三段共用）。 */
const SLASH_PANEL_FACE_FILE = "slashCommandPanelSections.tsx";

const SETTINGS_FACE_SOURCE = readFileSync(resolve(SRC_DIR, SETTINGS_FACE_FILE), "utf8");
const SLASH_PANEL_FACE_SOURCE = readFileSync(resolve(SRC_DIR, SLASH_PANEL_FACE_FILE), "utf8");

/**
 * 流程面键清单 —— 卡文「开关/命令/状态说明词条 zh/en 完备」的键名真源。
 * 前两键为 ask-matt 专属（#202/A1 落地，label-only 无副文案；#235/F10 D11 裁决在开关行补一句
 * 「开启时同名自定义命令让位」，description 槽位自本卡起启用）；
 * 后三键为三命令呈现所依赖的 `/` 面板命令段 chrome（段标题 + 两种空态）。
 */
const ASK_MATT_FLOW_FACE_MESSAGE_IDS = [
  "settings.experiments.askMattFlowToggle.label",
  "settings.experiments.askMattFlowToggle.description",
  "settings.experiments.askMattFlowBoardClosedNotice",
  "chat.slash.commands.title",
  "chat.slash.emptyUnavailable",
  "chat.slash.emptyResults",
] as const;

/** ask-matt 专属命名空间：该前缀下的键集必须与清单前两键完全一致（不得有清单外的键）。 */
const ASK_MATT_SETTINGS_KEY_PREFIX = "settings.experiments.askMattFlow";

const keysWithPrefix = (locale: Record<string, string>, prefix: string): string[] =>
  Object.keys(locale)
    .filter((key) => key.startsWith(prefix))
    .sort();

/** 词条里的 {占位符} 集合（去重后排序）：只译一侧会露出原始花括号。 */
function placeholders(message: string | undefined): string[] {
  return [
    ...new Set([...(message ?? "").matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "")),
  ].sort();
}

const LOCALES = [
  [zhCN, "zh-CN"],
  [enUS, "en-US"],
] as const;

test("键清单：流程面六键两语逐键齐全、非空非裸 key、占位符一致、en 无中文残留", () => {
  for (const key of ASK_MATT_FLOW_FACE_MESSAGE_IDS) {
    for (const [locale, name] of LOCALES) {
      const message = locale[key];
      assert.ok((message ?? "").trim().length > 0, `${name} 缺 ${key}（或为空文案）`);
      assert.notEqual(message, key, `${name} 的 ${key} 是裸 key（未命中词条表）`);
    }
    assert.deepEqual(placeholders(enUS[key]), placeholders(zhCN[key]), `${key} 占位符两语不一致`);
    assert.equal(
      /[\u4e00-\u9fff]/u.test(enUS[key] ?? ""),
      false,
      `en-US 的 ${key} 残留中文（未真正翻译）`,
    );
  }
  // zh 开关名是用户原话（A2 裁定「ask-matt 开发流程」）：改名必须显式改本守卫。
  assert.equal(zhCN["settings.experiments.askMattFlowToggle.label"], "ask-matt 开发流程");
  // en 开关名必须保留产品名 ask-matt（大小写不限）。
  assert.match(enUS["settings.experiments.askMattFlowToggle.label"] ?? "", /ask-matt/i);
  // D11（#235）开关行让位说明是设计稿裁决原文：改文案必须显式改本守卫。
  assert.equal(
    zhCN["settings.experiments.askMattFlowToggle.description"],
    "开启时同名自定义命令让位",
  );
});

test("键清单与面源码对账：设置面命名空间集合相等（多键=死键/副文案回归，少键=清单漂移）", () => {
  const expectedSettingsKeys = [
    "settings.experiments.askMattFlowBoardClosedNotice",
    "settings.experiments.askMattFlowToggle.description",
    "settings.experiments.askMattFlowToggle.label",
  ];
  assert.deepEqual(
    keysWithPrefix(zhCN, ASK_MATT_SETTINGS_KEY_PREFIX),
    expectedSettingsKeys,
    "zh-CN 的 ask-matt 命名空间键集必须与清单一致（新增 description 等键=加副文案/死键）",
  );
  assert.deepEqual(
    keysWithPrefix(enUS, ASK_MATT_SETTINGS_KEY_PREFIX),
    expectedSettingsKeys,
    "en-US 的 ask-matt 命名空间键集必须与清单一致（单边键=某语裸 key）",
  );

  // 清单不许有死键：每个键都要真的被面源码以字面量渲染（键被改名/删除时本断言先红）。
  for (const key of ASK_MATT_FLOW_FACE_MESSAGE_IDS) {
    assert.ok(
      SETTINGS_FACE_SOURCE.includes(`"${key}"`) || SLASH_PANEL_FACE_SOURCE.includes(`"${key}"`),
      `清单键 ${key} 不在流程面源码里（死键或清单漂移）`,
    );
  }
  // 设置面源码的 ask-matt 字面量集合 == 清单前两键（组件里加键必须同步进清单）。
  const settingsLiterals = [
    ...new Set(
      [...SETTINGS_FACE_SOURCE.matchAll(/"settings\.experiments\.askMattFlow[A-Za-z0-9.]*"/g)].map(
        (match) => match[0].slice(1, -1),
      ),
    ),
  ].sort();
  assert.deepEqual(settingsLiterals, expectedSettingsKeys, "设置面源码的 ask-matt 字面量集合漂移");
});

/** 行级去注释：只保留代码（块注释正文行与行注释整行跳过；行尾注释裁掉）。 */
function codeLines(source: string): { line: string; number: number }[] {
  const lines: { line: string; number: number }[] = [];
  for (const [index, raw] of source.split("\n").entries()) {
    if (/^\s*\*/.test(raw) || /^\s*\/\//.test(raw) || /^\s*\/\*/.test(raw)) continue;
    lines.push({ line: raw.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, ""), number: index + 1 });
  }
  return lines;
}

const FACE_SOURCES = [
  [SETTINGS_FACE_FILE, SETTINGS_FACE_SOURCE],
  [SLASH_PANEL_FACE_FILE, SLASH_PANEL_FACE_SOURCE],
] as const;

test("零硬编码：面源码无裸中文文案、无 JSX 英文文本节点、无字面量用户可见属性", () => {
  const offenders: string[] = [];
  for (const [file, source] of FACE_SOURCES) {
    for (const { line, number } of codeLines(source)) {
      // 字符串字面量里的中文：日志消息（`[Scope] …` 作用域前缀）是诊断，不是用户可见文案，豁免。
      for (const match of line.matchAll(/"([^"]*)"/g)) {
        const text = match[1] ?? "";
        if (!/[\u4e00-\u9fff]/u.test(text)) continue;
        if (/^\[[A-Za-z][^\]]*\]/.test(text)) continue;
        if (/^(data-|aria-)/.test(text)) continue;
        offenders.push(`${file}:${number} 中文串 ${text.slice(0, 40)}`);
      }
      // JSX 文本节点：英文散文形态（字母起手、无代码符号）或含中文的裸文本。
      for (const match of line.matchAll(/>([^<>{}]+)</g)) {
        const text = (match[1] ?? "").trim();
        if (!text) continue;
        const englishProse = /^[A-Za-z][A-Za-z0-9 ,.!?'"–—-]*$/.test(text);
        if (englishProse || /[\u4e00-\u9fff]/u.test(text)) {
          offenders.push(`${file}:${number} JSX 文本 ${text.slice(0, 40)}`);
        }
      }
      // 用户可见属性的字面量值（label/描述/占位符等）：必须走词条表达式而非硬编码。
      for (const match of line.matchAll(
        /(?:aria-label|aria-description|label|title|placeholder|description)="([^"]+)"/g,
      )) {
        offenders.push(`${file}:${number} 字面量属性 ${match[0].slice(0, 40)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "流程面文案必须走词条（硬编码文案应改词条）");
});

test("源码字面量对账：面源码里的 settings/chat 键字面量两语可解析（拼错 key 会渲染裸 key）", () => {
  const missing: string[] = [];
  for (const [file, source] of FACE_SOURCES) {
    for (const { line, number } of codeLines(source)) {
      for (const match of line.matchAll(/"(settings\.[A-Za-z0-9.]+|chat\.[A-Za-z0-9.]+)"/g)) {
        const key = match[1] ?? "";
        if (!(key in zhCN) || !(key in enUS)) missing.push(`${file}:${number} ${key}`);
      }
    }
  }
  assert.deepEqual(missing, [], "以下面源码键字面量在词条表里找不到");
});

test("命令面边界：三命令描述是协议目录数据（CLI 单点），App 词条表不重复收录命令描述键", () => {
  // 三命令经协议目录进入 `/` 面板（CLI `ASK_MATT_FLOW_COMMANDS`，与全部内置命令同一约定）。
  // 若在 App 词条表新增命令描述键（如 settings.experiments.askMattFlowCommand*），等于把命令面
  // 文案复制成第二真源——CLI 面板/TUI 不读它，只会两处漂移；命令面文案只允许面板 chrome。
  const commandKeyShapes = /^settings\.experiments\.askMattFlow(Command|Grill|ToSpec|ToTickets)/i;
  const offenders = [...Object.keys(zhCN), ...Object.keys(enUS)].filter((key) =>
    commandKeyShapes.test(key),
  );
  assert.deepEqual(offenders, [], "命令描述不得进 App 词条表（协议目录为单点）");
});
