import assert from "node:assert/strict";
import test from "node:test";
import {
  prependScrollAdjustment,
  resolvePrependViewportAdjustment,
  shouldAdjustVirtualizerForItemSizeChange,
  shouldTriggerLoadOlder,
  shouldTriggerLoadOlderFromScroll,
  refineTimelineScrollSource,
} from "../src/v4/timelineScrollAnchor.js";

/**
 * 会话按需加载的位置不变式（2026-10-01 实测缺陷）。
 *
 * 用户原话：「会话里面的按需加载的时候，拉到上面再后台加载，不要影响当前信息的位置」。
 * 唯一不变量：用户上滚离底之后，任何「更早历史」的加载与其位置恢复都不得改变 scrollTop。
 *
 * 三段判定是这条不变式的接缝：
 *   1. 预取来源门  —— 程序化回放/布局补偿不得触发 loadOlder（它们不是用户意图，
 *      否则会形成「恢复把位置钳在窗口顶部 → 预取补一窗 → 下次 commit 又钳回 → 再预取」
 *      的级联，把整段历史拉进窗口）；
 *   2. 回放取消判定 —— 落在 250ms layoutScrollGuard 保护窗内、没有登记意图的用户上滚
 *      必须仍被认出来，否则用户上滚会被当成布局补偿，回放在下一个 commit 上又落一次；
 *   3. 前插平移三段 —— 首帧、锚点行被虚拟化卸载、估计高度到实测高度的二次修正。
 */

// ── 1. 预取来源门 ────────────────────────────────────────────────────────────

test("预取来源门：真实用户滚动到顶才补页", () => {
  assert.equal(
    shouldTriggerLoadOlderFromScroll({
      source: "user",
      scrollTop: 0,
      canLoadOlder: true,
      loadingOlder: false,
    }),
    true,
  );
});

test("预取来源门：程序化回放与布局补偿一律不得触发 loadOlder", () => {
  for (const source of ["programmatic", "layout"] as const) {
    assert.equal(
      shouldTriggerLoadOlderFromScroll({
        source,
        scrollTop: 0,
        canLoadOlder: true,
        loadingOlder: false,
      }),
      false,
      `${source} scroll 不是用户意图，补页会形成级联`,
    );
  }
});

test("预取来源门：用户滚动但未到顶 / 在途时不补页", () => {
  assert.equal(
    shouldTriggerLoadOlderFromScroll({
      source: "user",
      scrollTop: 9000,
      canLoadOlder: true,
      loadingOlder: false,
      triggerPx: 2232,
    }),
    false,
  );
  assert.equal(
    shouldTriggerLoadOlderFromScroll({
      source: "user",
      scrollTop: 0,
      canLoadOlder: true,
      loadingOlder: true,
    }),
    false,
  );
  assert.equal(
    shouldTriggerLoadOlderFromScroll({
      source: "user",
      scrollTop: 0,
      canLoadOlder: false,
      loadingOlder: false,
    }),
    false,
  );
});

test("预取来源门：与几何判定的既有契约一致", () => {
  const geometry = { scrollTop: 10, canLoadOlder: true, loadingOlder: false };
  assert.equal(shouldTriggerLoadOlder(geometry), true);
  assert.equal(shouldTriggerLoadOlderFromScroll({ source: "user", ...geometry }), true);
});

// ── 2. 回放取消判定 ──────────────────────────────────────────────────────────

test("回放取消：保护窗内的用户上滚必须改判为 user", () => {
  assert.equal(
    refineTimelineScrollSource({
      source: "layout",
      scrollTop: 520,
      lastObservedScrollTop: 900,
      programmaticScroll: false,
      restorePending: true,
    }),
    "user",
  );
});

test("回放取消：亚像素抖动与自有程序化写入不被误判为用户上滚", () => {
  assert.equal(
    refineTimelineScrollSource({
      source: "layout",
      scrollTop: 899,
      lastObservedScrollTop: 900,
      programmaticScroll: false,
      restorePending: true,
    }),
    "layout",
  );
  assert.equal(
    refineTimelineScrollSource({
      source: "layout",
      // 回放自己把落点钳到更小的值：同帧程序化写入不算用户意图。
      scrollTop: 200,
      lastObservedScrollTop: 900,
      programmaticScroll: true,
      restorePending: true,
    }),
    "layout",
  );
});

test("回放取消：没有待落回放时不改判，其它来源原样透传", () => {
  assert.equal(
    refineTimelineScrollSource({
      source: "layout",
      scrollTop: 100,
      lastObservedScrollTop: 900,
      programmaticScroll: false,
      restorePending: false,
    }),
    "layout",
  );
  assert.equal(
    refineTimelineScrollSource({
      source: "user",
      scrollTop: 100,
      lastObservedScrollTop: 900,
      programmaticScroll: false,
      restorePending: true,
    }),
    "user",
  );
  assert.equal(
    refineTimelineScrollSource({
      source: "programmatic",
      scrollTop: 100,
      lastObservedScrollTop: 900,
      programmaticScroll: true,
      restorePending: true,
    }),
    "programmatic",
  );
});

// ── 3. 前插平移三段 ──────────────────────────────────────────────────────────

// 采集瞬间的锚点：起点 12_000、视口偏移 150（当时 scrollTop 11_850）、总高度 20_000。
const anchor = { key: "turn-300", offsetTop: 150, start: 12_000, totalSize: 20_000 };

test("前插平移·首帧：按锚点当帧实测起点算绝对目标", () => {
  const adjustment = resolvePrependViewportAdjustment({
    prevFirstRowId: null,
    nextFirstRowId: 11,
    prevTotalSize: 0,
    nextTotalSize: 6_000,
    // 首帧没有 rowId 可比，但锚点行已重新量到新起点 17_850。
    currentScrollTop: 11_850,
    anchor,
    anchorNextStart: 17_850,
    restoreOwnsAnchor: false,
  });
  assert.equal(adjustment, 17_850 - 150 - 11_850);
});

test("前插平移·首帧：没有锚点（普通首屏）时不猜平移量", () => {
  assert.equal(
    resolvePrependViewportAdjustment({
      prevFirstRowId: null,
      nextFirstRowId: 11,
      prevTotalSize: 0,
      nextTotalSize: 6_000,
      currentScrollTop: 11_850,
      anchor: null,
      anchorNextStart: null,
      restoreOwnsAnchor: false,
    }),
    null,
  );
});

test("前插平移·锚点行被卸载：用已存 measurement 起点加总高度增量还原绝对目标", () => {
  const adjustment = resolvePrependViewportAdjustment({
    prevFirstRowId: 500,
    nextFirstRowId: 100,
    prevTotalSize: 20_000,
    nextTotalSize: 26_000,
    // 采集到本帧之间恢复布局/虚拟化把 scrollTop 改写过（11_850 → 8_000）；
    // 只叠加增量会把这段中间位移重复计入，必须用绝对目标。
    currentScrollTop: 8_000,
    anchor,
    anchorNextStart: null,
    restoreOwnsAnchor: false,
  });
  assert.equal(adjustment, 12_000 + 6_000 - 150 - 8_000);
});

test("前插平移·锚点行被卸载：增量以采集瞬间为基准，不重复计入中间测高修正", () => {
  // 采集（总高度 20_000）之后、本帧之前，窗口里其它行完成了估计→实测修正，
  // 上一帧总高度已经是 20_600。若用上一帧做基准，增量会少 600px。
  assert.equal(
    resolvePrependViewportAdjustment({
      prevFirstRowId: 500,
      nextFirstRowId: 100,
      prevTotalSize: 20_600,
      nextTotalSize: 26_000,
      currentScrollTop: 8_000,
      anchor,
      anchorNextStart: null,
      restoreOwnsAnchor: false,
    }),
    12_000 + 6_000 - 150 - 8_000,
  );
});

test("前插平移·锚点行仍挂载：以当帧实测起点为准，与首次平移同帧提交", () => {
  assert.equal(
    resolvePrependViewportAdjustment({
      prevFirstRowId: 500,
      nextFirstRowId: 100,
      prevTotalSize: 20_000,
      nextTotalSize: 26_000,
      currentScrollTop: 8_000,
      anchor,
      anchorNextStart: 17_500,
      restoreOwnsAnchor: false,
    }),
    17_500 - 150 - 8_000,
  );
});

test("前插平移：等值/追加/清空不是前插，不动滚动位置", () => {
  const base = {
    prevTotalSize: 20_000,
    nextTotalSize: 26_000,
    currentScrollTop: 8_000,
    anchor: null,
    anchorNextStart: null,
    restoreOwnsAnchor: false,
  };
  assert.equal(
    resolvePrependViewportAdjustment({ ...base, prevFirstRowId: 500, nextFirstRowId: 620 }),
    null,
  );
  assert.equal(
    resolvePrependViewportAdjustment({ ...base, prevFirstRowId: 500, nextFirstRowId: 500 }),
    null,
  );
  assert.equal(
    resolvePrependViewportAdjustment({ ...base, prevFirstRowId: 500, nextFirstRowId: null }),
    null,
  );
});

test("前插平移：无锚点时退化为总高度增量（既有契约保留）", () => {
  assert.equal(
    resolvePrependViewportAdjustment({
      prevFirstRowId: 500,
      nextFirstRowId: 100,
      prevTotalSize: 20_000,
      nextTotalSize: 26_000,
      currentScrollTop: 8_000,
      anchor: null,
      anchorNextStart: null,
      restoreOwnsAnchor: false,
    }),
    6_000,
  );
  assert.equal(
    prependScrollAdjustment({
      prevFirstRowId: 500,
      nextFirstRowId: 100,
      prevTotalSize: 20_000,
      nextTotalSize: 26_000,
    }),
    6_000,
  );
});

test("前插平移：待落回放拥有坐标系时不得平移", () => {
  assert.equal(
    resolvePrependViewportAdjustment({
      prevFirstRowId: 500,
      nextFirstRowId: 100,
      prevTotalSize: 20_000,
      nextTotalSize: 26_000,
      currentScrollTop: 8_000,
      anchor,
      anchorNextStart: null,
      restoreOwnsAnchor: true,
    }),
    null,
  );
});

// ── 4. 估计高度 → 实测高度的二次修正 ────────────────────────────────────────

test("测高二次修正：用户已上滚接管时不得被恢复保护窗抑制", () => {
  assert.equal(
    shouldAdjustVirtualizerForItemSizeChange({
      following: false,
      suppressAdjustment: true,
      userOwnsScroll: true,
      contentWidthChanging: false,
      itemEnd: 4_000,
      scrollTop: 11_850,
    }),
    true,
    "前插行的估计高度改成实测高度后，视口上方的高度变化必须补进 scrollTop，否则锚点会漂",
  );
});

test("测高二次修正：恢复回放仍拥有滚动权时保持抑制", () => {
  assert.equal(
    shouldAdjustVirtualizerForItemSizeChange({
      following: false,
      suppressAdjustment: true,
      userOwnsScroll: false,
      contentWidthChanging: false,
      itemEnd: 4_000,
      scrollTop: 11_850,
    }),
    false,
  );
});

test("测高二次修正：贴底、宽度重排、视口下方变化都不补偿", () => {
  const base = {
    suppressAdjustment: false,
    userOwnsScroll: true,
    contentWidthChanging: false,
    itemEnd: 4_000,
    scrollTop: 11_850,
  };
  assert.equal(shouldAdjustVirtualizerForItemSizeChange({ ...base, following: true }), false);
  assert.equal(
    shouldAdjustVirtualizerForItemSizeChange({ ...base, following: false, contentWidthChanging: true }),
    false,
  );
  assert.equal(
    shouldAdjustVirtualizerForItemSizeChange({ ...base, following: false, itemEnd: 30_000 }),
    false,
  );
});
