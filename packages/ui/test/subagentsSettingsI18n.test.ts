import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

/* 「后台派发」开关（设置页 · 子智能体表单）：字段全链路已存在，缺的只是表单这一格。
   语义以运行时为准 —— `runner.ts` 的 `rawRequest.runInBackground === true || profile.background === true`
   都会走 `start`，即 `background: true` 是**强制后台**（调用方不传也后台），文案写成
   「模型请求时允许」是错的，本组用例把正确措辞与表单接线一起钉死。
   表单没有渲染测试设施（本项目既定做法，见 wakeRulesEditPage.test.ts 的说明），
   因此用结构守卫：初始值 / state / 重置 / 保存四格必须齐全，**保存要始终写表单值**
   （显式关掉必须落 false，否则旧值残留）；最易踩的坑是重置机制 —— 编辑另一个 agent
   时表单必须按新快照回灌，改错会让上一个 agent 的开关状态粘在下一个 agent 上。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");

/** 压掉换行与缩进：结构断言只关心代码序列，不锁格式化结果。 */
const compact = (source: string) => source.replace(/\s+/gu, " ");

/** 取 `start` 到其后第一处 `end` 的片段；标记缺失直接失败（避免空洞断言）。 */
function slice(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `未找到片段起点：${start}`);
  const to = source.indexOf(end, from);
  assert.notEqual(to, -1, `未找到片段终点：${end}`);
  return source.slice(from, to + end.length);
}

const subagentsSource = readSource("settings/SubagentsSection.tsx");

test("i18n：后台开关的文案键两语成对且非空", () => {
  for (const key of [
    "settings.subagents.form.background.label",
    "settings.subagents.form.background.description",
  ]) {
    assert.ok(zhCN[key], `zh-CN 缺少 ${key}`);
    assert.ok(enUS[key], `en-US 缺少 ${key}`);
    assert.ok(zhCN[key]?.trim(), `zh-CN 的 ${key} 为空`);
    assert.ok(enUS[key]?.trim(), `en-US 的 ${key} 为空`);
  }
  // 两语都不得再出现「模型请求时允许」的旧口径（强制后台 ≠ 按请求后台）。
  for (const [locale, name] of [
    [zhCN, "zh-CN"],
    [enUS, "en-US"],
  ] as const) {
    const description = locale["settings.subagents.form.background.description"] ?? "";
    assert.ok(
      !description.includes("模型请求") && !description.toLowerCase().includes("when requested"),
      `${name} 的描述仍是「按模型请求」的旧口径：${description}`,
    );
  }
});

test("表单接线：后台开关的初始值 / state / 重置 / 保存四格齐全", () => {
  const initialState = compact(
    slice(
      compact(subagentsSource),
      "function createSubagentFormInitialState(",
      "function createSubagentFormInitialStateKey(",
    ),
  );
  assert.ok(
    initialState.includes("background: initial?.background ?? false,"),
    "初始值必须取 agent 快照的 background，缺省 false",
  );
  assert.ok(
    initialState.includes('"background"') || initialState.includes('| "background"'),
    "createSubagentFormInitialState 的入参 Pick 必须收 background（否则类型上就取不到快照值）",
  );

  const formState = compact(subagentsSource);
  assert.ok(
    formState.includes(
      "const [background, setBackground] = useState(initialFormState.background);",
    ),
    "表单必须持有 background 草稿 state（初值来自 initialFormState）",
  );

  // 重置：保存/切换 agent 后组件复用旧实例，必须按新快照回灌，否则旧开关状态粘住。
  assert.ok(
    slice(
      subagentsSource,
      "previousInitialFormStateKeyRef.current = initialFormStateKey;",
      "}, [initial, initialFormStateKey]);",
    ).includes("setBackground(nextInitialState.background);"),
    "重置分支必须回灌 setBackground(nextInitialState.background)",
  );
  // 重置判据是整份初始状态的 JSON；若 key 改成手写枚举而漏掉 background，
  // 「只有 background 不同的两个 agent」互相切换时表单不会重置。
  assert.ok(
    slice(subagentsSource, "function createSubagentFormInitialStateKey(", "}").includes(
      "...createSubagentFormInitialState(initial)",
    ),
    "重置 key 必须涵盖整份初始状态（含 background）",
  );

  // 保存：始终写表单值（true / false 都落盘），不得再透传 initial.background。
  const savePayload = compact(slice(subagentsSource, "await onSave({", "});"));
  assert.ok(savePayload.includes(" background, "), "保存必须始终携带 background 表单值");
  assert.ok(
    !savePayload.includes("initial?.background"),
    "保存不得再按 initial.background 透传（显式关掉会残留旧值）",
  );
});

test("开关行：紧随注入 AGENTS.md 行，同款带边框行 + 左标签 + 右 Switch 绑定 background 草稿", () => {
  const compactSource = compact(subagentsSource);
  const borderRowClass =
    '<div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-3 py-2.5">';
  // 注入 AGENTS.md 行在前，后台开关行紧随其后（同款形态）。
  const injectRowStart = compactSource.indexOf(borderRowClass);
  assert.notEqual(injectRowStart, -1, "注入 AGENTS.md 行必须还在（同款形态的样板）");
  const injectRowEnd = compactSource.indexOf(
    "settings.subagents.form.injectAgentsMd.label",
    injectRowStart,
  );
  assert.notEqual(injectRowEnd, -1, "注入 AGENTS.md 行必须仍渲染它的标签");

  const backgroundRowStart = compactSource.indexOf(borderRowClass, injectRowEnd);
  assert.notEqual(backgroundRowStart, -1, "注入 AGENTS.md 行之后必须有同款带边框的开关行");
  const switchIndex = compactSource.indexOf("checked={background}", backgroundRowStart);
  assert.notEqual(switchIndex, -1, "注入 AGENTS.md 行之后必须有绑定 background 的 Switch");
  // 行片段取到 Switch 之后的收尾 `</div>`：标签、描述与开关必须同处这一行内。
  const backgroundRow = compactSource.slice(
    backgroundRowStart,
    compactSource.indexOf("</div>", switchIndex),
  );
  for (const fragment of [
    "settings.subagents.form.background.label",
    "settings.subagents.form.background.description",
    "checked={background}",
    "onCheckedChange={setBackground}",
  ]) {
    assert.ok(backgroundRow.includes(fragment), `开关行缺少 ${fragment}：${backgroundRow}`);
  }
  // 描述文案必须真的渲染出来：键写好了却不显示，用户看不到「始终后台」这条关键语义。
  assert.match(
    backgroundRow,
    /intl\.formatMessage\(\{ id: "settings\.subagents\.form\.background\.description",? \}\)/u,
    `开关行必须渲染描述文案：${backgroundRow}`,
  );
  // Switch 的可访问名与左侧标签同源（只有一侧改名时 screen reader 会读旧文案）。
  assert.match(
    backgroundRow,
    /aria-label=\{intl\.formatMessage\(\{ id: "settings\.subagents\.form\.background\.label",? \}\)\}/u,
    `Switch 的 aria-label 必须用同一个 label 键：${backgroundRow}`,
  );
});
