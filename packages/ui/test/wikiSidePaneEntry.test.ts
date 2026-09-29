import assert from "node:assert/strict";
import test from "node:test";
import { resolveOpenTabLauncherItemIds } from "../src/app-shell/animatedSidePanePanelModel.js";

/**
 * 侧栏「打开新面板」入口的顺序与存在性。
 *
 * wiki 必须紧跟在浏览器下方，且任何 workspace 都有入口 ——
 * 产物缺失时由面板内部引导生成，所以入口本身不做条件裁剪。
 *
 * 文件树同属这类「不受条件裁剪」的入口，且按要求排在辅助对话之前。
 */
test("文件树入口排在辅助对话之前，且始终存在", () => {
  const ids = resolveOpenTabLauncherItemIds({
    developerToolsEnabled: true,
    hasReviewTab: true,
    canOpenSelectionSideConversation: true,
    supportsEmbeddedBrowser: true,
  });
  const fileTreeIndex = ids.indexOf("file-tree");
  const sideChatIndex = ids.indexOf("selection-side-conversation");
  assert.ok(fileTreeIndex >= 0, `文件树入口应存在，实际顺序：${ids.join(",")}`);
  assert.equal(fileTreeIndex, 0, `文件树应排在最前，实际顺序：${ids.join(",")}`);
  assert.ok(
    sideChatIndex < 0 || fileTreeIndex < sideChatIndex,
    `文件树应在辅助对话之前，实际顺序：${ids.join(",")}`,
  );
});

test("没有辅助对话可开时文件树入口仍然存在（布局类入口不依赖对话）", () => {
  const ids = resolveOpenTabLauncherItemIds({
    developerToolsEnabled: false,
    hasReviewTab: true,
    canOpenSelectionSideConversation: false,
    supportsEmbeddedBrowser: false,
  });
  assert.ok(ids.includes("file-tree"), `实际顺序：${ids.join(",")}`);
  assert.ok(!ids.includes("selection-side-conversation"));
});

test("wiki 入口紧跟浏览器之后", () => {
  const ids = resolveOpenTabLauncherItemIds({
    developerToolsEnabled: false,
    hasReviewTab: false,
    supportsEmbeddedBrowser: true,
  });
  const browserIndex = ids.indexOf("browser");
  const wikiIndex = ids.indexOf("wiki");
  assert.ok(browserIndex >= 0, "浏览器入口应存在");
  assert.ok(wikiIndex >= 0, "wiki 入口应存在");
  assert.equal(wikiIndex, browserIndex + 1, `wiki 应紧跟浏览器，实际顺序：${ids.join(",")}`);
});

test("无内置浏览器时 wiki 仍然存在（它是独立入口，不依赖浏览器）", () => {
  const ids = resolveOpenTabLauncherItemIds({
    developerToolsEnabled: false,
    hasReviewTab: true,
    supportsEmbeddedBrowser: false,
  });
  assert.ok(ids.includes("wiki"), `实际顺序：${ids.join(",")}`);
  assert.ok(!ids.includes("browser"));
});

test("wiki 排在开发者工具之前", () => {
  const ids = resolveOpenTabLauncherItemIds({
    developerToolsEnabled: true,
    hasReviewTab: true,
    supportsEmbeddedBrowser: true,
  });
  assert.ok(
    ids.indexOf("wiki") < ids.indexOf("developer-tools"),
    `wiki 应在开发者工具之前，实际顺序：${ids.join(",")}`,
  );
});

test("已有 review tab 时不再提供 review 入口，但不影响 wiki", () => {
  const withReview = resolveOpenTabLauncherItemIds({
    developerToolsEnabled: false,
    hasReviewTab: false,
    supportsEmbeddedBrowser: true,
  });
  assert.ok(withReview.includes("review"));
  const withoutReview = resolveOpenTabLauncherItemIds({
    developerToolsEnabled: false,
    hasReviewTab: true,
    supportsEmbeddedBrowser: true,
  });
  assert.ok(!withoutReview.includes("review"));
  assert.ok(withoutReview.includes("wiki"));
});
