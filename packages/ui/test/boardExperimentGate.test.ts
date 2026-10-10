import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BookOpenIcon, SquareKanbanIcon } from "lucide-react";
import { resolveOpenTabLauncherItemIds } from "../src/app-shell/animatedSidePanePanelModel.js";
import {
  SidePaneOpenTabLauncher,
  type OpenTabLauncherItem,
} from "../src/app-shell/SidePaneOpenTabLauncher.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

/**
 * 卡 #58 门禁：实验开关关闭 ⇒ 侧边面板「打开标签页」入口**零渲染**（data 锚点不存在）。
 *
 * 需求真源（卡文 (3)(4)）：入口与 BoardPane 挂载只在开关开启时出现；关闭时无渲染残留、
 * 无空 tab、会话恢复不复活入口；默认关（存量升级后入口不可见）。
 *
 * 分层（与仓库既有形态一致）：入口渲染面抽成 SidePaneOpenTabLauncher（真组件，可 SSR）；
 * 条目裁剪的判据在 resolveOpenTabLauncherItemIds（纯函数，独立测）。
 * 为什么 SSR 要带**阳性对照**：只断言「没有 board 锚点」在下述坏法里会假绿——组件整体没渲染。
 * 所以同一份 markup 里必须同时看到其它入口（wiki）在场。
 * 真设置快照（开关=开）下的入口显隐与面板挂载走浏览器断言
 * （test/boardExperimentGateBrowser.ts），SSR 不跑 effect、拿不到已加载的设置。
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const PANEL_SOURCE = readFileSync(resolve(SRC, "app-shell/AnimatedSidePanePanel.tsx"), "utf8");

const ITEM_ICONS: Record<string, typeof BookOpenIcon> = {
  board: SquareKanbanIcon,
  wiki: BookOpenIcon,
};

function renderLauncher(itemIds: string[]): string {
  const items: OpenTabLauncherItem[] = itemIds.map((id) => ({
    id: id as OpenTabLauncherItem["id"],
    label: zhCN[id === "board" ? "board.title" : "wiki.title"] ?? id,
    icon: ITEM_ICONS[id] ?? BookOpenIcon,
    onOpen: () => {},
  }));
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(SidePaneOpenTabLauncher, { items }),
    }),
  );
}

function launcherItemIds(projectBoardEnabled: boolean): string[] {
  return resolveOpenTabLauncherItemIds({
    developerToolsEnabled: false,
    hasReviewTab: false,
    supportsEmbeddedBrowser: true,
    projectBoardEnabled,
  });
}

test("SSR｜默认关：launcher 列表里没有看板入口锚点，其它入口照常在场", () => {
  const markup = renderLauncher(launcherItemIds(false));
  // 阳性对照：列表本体与其它入口在（否则「没有 board 锚点」毫无信息量）。
  assert.ok(markup.includes('data-side-pane-open-tab-item="wiki"'), "阳性对照：wiki 入口应在");
  assert.equal(
    markup.includes('data-side-pane-open-tab-item="board"'),
    false,
    `关闭态不得出现看板入口：\n${markup}`,
  );
  assert.equal(markup.includes("项目看板"), false, "关闭态不得渲染看板文案");
});

test("SSR｜开关开启：看板入口出现且排在最后一行", () => {
  const markup = renderLauncher(launcherItemIds(true));
  assert.ok(markup.includes('data-side-pane-open-tab-item="board"'), "开启态看板入口必须渲染");
  const anchors = [...markup.matchAll(/data-side-pane-open-tab-item="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(anchors.at(-1), "board", `看板入口应排在最后：${anchors.join(",")}`);
});

/* 结构面（源码切片）——SSR 只能覆盖入口列表；面板挂载（BoardPane）的门在这里钉：
   ①挂载判据与入口同用一份纯函数；②关闭态的残留 board tab 不进 content 渲染面。 */
test("守卫｜面板挂载与入口同用一份判据 projectBoardEntryVisible(settings)", () => {
  assert.ok(
    PANEL_SOURCE.includes("projectBoardEntryVisible(settings)"),
    "面板必须经既有设置通路（useSettings + 纯判据）读取开关，不另建状态",
  );
  assert.ok(
    /resolveOpenTabLauncherItemIds\(\{[\s\S]*?projectBoardEnabled:\s*projectBoardVisible/.test(
      PANEL_SOURCE,
    ),
    "入口列表必须把 projectBoardVisible 交给 resolveOpenTabLauncherItemIds（唯一入口裁剪点）",
  );
  assert.ok(
    /tab\.type === "board" && !projectBoardVisible/.test(PANEL_SOURCE),
    "看板 tab 在开关关闭时不得进入 content 渲染面（含会话恢复的残留 tab）",
  );
  // 残留 tab 也不得留下空 tab 触发器：可见 tab 列表同样按开关裁剪。
  assert.ok(
    /\(tab\) => tab\.type !== "board" \|\| projectBoardVisible/.test(PANEL_SOURCE),
    "visibleTabs 必须按开关过滤看板 tab（无空 tab）",
  );
});
