import assert from "node:assert/strict";
import test from "node:test";
import { resolveOpenTabLauncherItemIds } from "../src/app-shell/animatedSidePanePanelModel.js";
import { getSidePaneTabTitle } from "../src/app-shell/SidePaneTabTrigger.js";
import {
  activateBoardSidePane,
  getVisibleSidePaneTabs,
  type WorkspaceSidePaneTab,
} from "../src/lib/workspaceSidePane.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

/**
 * 「项目看板」入口注册守卫（卡 #32）。
 *
 * 需求真源：任务卡 #32「侧边面板新增『项目看板』入口，位于『打开标签页』区块之下」
 * 与 `.zcode/board/board-consumption-contract.md` §12 入口落位。入口跟随既有 wiki/file-tree
 * 的标签注册模式：launcher 条目 + workspace 级标签 + 词条标题。
 */

const t = (descriptor: { id: string }, values?: Record<string, string>) => {
  let message = zhCN[descriptor.id] ?? descriptor.id;
  for (const [key, value] of Object.entries(values ?? {})) {
    message = message.replaceAll(`{${key}}`, String(value));
  }
  return message;
};

test("看板入口存在，且排在「打开标签页」列表最后（位于既有入口之下）", () => {
  const ids = resolveOpenTabLauncherItemIds({
    developerToolsEnabled: true,
    hasReviewTab: false,
    canOpenSelectionSideConversation: true,
    supportsEmbeddedBrowser: true,
  });
  const boardIndex = ids.indexOf("board");
  assert.ok(boardIndex >= 0, `看板入口应存在，实际顺序：${ids.join(",")}`);
  assert.equal(boardIndex, ids.length - 1, `看板入口应排在最后，实际顺序：${ids.join(",")}`);
  assert.ok(
    boardIndex > ids.indexOf("wiki"),
    `看板入口应在 wiki 入口之下，实际顺序：${ids.join(",")}`,
  );
});

test("看板入口不受条件裁剪（任何 workspace 都能打开）", () => {
  const ids = resolveOpenTabLauncherItemIds({
    developerToolsEnabled: false,
    hasReviewTab: true,
    canOpenSelectionSideConversation: false,
    supportsEmbeddedBrowser: false,
  });
  assert.ok(ids.includes("board"), `实际顺序：${ids.join(",")}`);
});

test("activateBoardSidePane 打开单例看板标签，重复打开只聚焦不堆叠", () => {
  const first = activateBoardSidePane(null);
  assert.equal(first.tabs.length, 1);
  assert.equal(first.tabs[0]?.type, "board");
  assert.equal(first.tabs[0]?.id, "board");
  assert.equal(first.activeTabId, "board");

  const reopened = activateBoardSidePane(first);
  assert.equal(reopened.tabs.length, 1, "看板是单例标签，重复打开不堆叠");
  assert.equal(reopened.activeTabId, "board");
});

test("看板标签是 workspace 级：其他对话不隐藏（切换对话不卸载只读面板）", () => {
  const tabs: WorkspaceSidePaneTab[] = [
    { id: "board", type: "board", ownerTaskId: "task-1", workspaceKey: "ws" },
  ];
  const visible = getVisibleSidePaneTabs(tabs, { workspaceKey: "ws", ownerTaskId: "task-2" });
  assert.equal(visible.length, 1);
  assert.equal(visible[0]?.type, "board");
});

test("看板标签标题走词条 board.title（zh-CN = 项目看板，不硬编码文案）", () => {
  const askedIds: string[] = [];
  const title = getSidePaneTabTitle({ id: "board", type: "board" }, (descriptor) => {
    askedIds.push(descriptor.id);
    return t(descriptor);
  });
  assert.deepEqual(askedIds, ["board.title"]);
  assert.equal(title, "项目看板");
});
