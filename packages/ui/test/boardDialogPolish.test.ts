import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPaneView, type BoardPaneViewProps } from "../src/board/BoardPaneView.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { readyGroupingBoard } from "./boardGroupingFixture.js";

/**
 * 弹窗改造与诊断折叠的守卫（卡 #46 / 规则书 v2：B5 弹窗 + B7 诊断区）。
 *
 * 期望值的独立真源：用户 2026-10-10 实测反馈：
 *   - B5 面板内定位（overlay = 面板容器内 absolute，非 fixed inset-0 全局）；
 *   - B5 区块重排：标题 → 阻碍（突出） → 执行摘要 → 来源 → 时间戳（底部小字）；
 *   - B5 信息精简：去草案徽章、状态色点去重（段位徽章已含状态）、路径截断（basename + title 全路径）、
 *     时间相对化（"3 小时前"）；
 *   - B7 诊断区：默认折叠一行「诊断 N 条」，展开才列明细。
 */

const NOW = Date.parse("2026-10-10T12:00:00+08:00");

function render(props: Partial<BoardPaneViewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(BoardPaneView, {
        state: readyGroupingBoard(),
        viewMode: "tree",
        now: NOW,
        ...props,
      }),
    }),
  );
}

function dialogSlice(markup: string): string {
  const anchor = markup.indexOf("data-board-dialog-root=");
  assert.ok(anchor >= 0, "弹窗应渲染");
  // 从外层 <div 起切（锚点在开标签内部，不能从锚点开始）
  const start = markup.lastIndexOf("<div", anchor);
  assert.ok(start >= 0 && start < anchor, "弹窗 overlay 应是 div");
  const end = markup.indexOf('data-board-diagnostics="', start);
  return markup.slice(start, end < 0 ? markup.length : end);
}

test("弹窗：面板内定位（面板根 relative；overlay absolute，非 fixed 全局遮罩）", () => {
  const markup = render({ openCardId: "task:46" });
  assert.match(
    markup.slice(0, markup.indexOf(">")),
    /data-board-pane=""/,
    "面板根仍是唯一入口锚点",
  );
  assert.ok(
    /<div data-board-pane=""[^>]*class="[^"]*relative/.test(markup),
    "面板根带 relative（弹窗的定位上下文）",
  );
  const dialog = dialogSlice(markup);
  assert.match(
    dialog,
    /<div data-board-dialog-root=""[^>]*class="[^"]*absolute inset-0/,
    "overlay 是面板内 absolute",
  );
  assert.ok(
    !/data-board-dialog-root=""[^>]*class="[^"]*fixed/.test(dialog),
    "overlay 不得再用 fixed 全局",
  );
});

test("弹窗：区块顺序 = 标题 → 阻碍 → 执行摘要 → 细节 → 来源 → 证据路径 → 时间戳（底部）；阻碍突出", () => {
  const markup = render({ openCardId: "task:47" });
  const dialog = dialogSlice(markup);
  const sections = [...dialog.matchAll(/data-board-dialog-section="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    sections,
    ["header", "status", "blockers", "execution", "origin", "evidence", "timestamps"],
    "区块顺序：标题 → 状态 → 阻碍 → 执行摘要 → 来源 → 证据 → 时间戳（末尾）",
  );
  const blockersStart = dialog.indexOf('data-board-dialog-section="blockers"');
  const blockersSlice = dialog.slice(
    blockersStart,
    dialog.indexOf('data-board-dialog-section="execution"'),
  );
  assert.match(blockersSlice, /border-warning/, "阻碍区块突出（warning 描边）");
});

test("弹窗：信息精简 —— 去草案徽章、状态色点去重、路径截断、时间相对化", () => {
  const markup = render({ openCardId: "task:46" });
  const dialog = dialogSlice(markup);
  assert.ok(!dialog.includes("data-board-draft"), "弹窗不显示草案徽章（B5 精简）");
  assert.ok(!dialog.includes('data-board-status="'), "弹窗不重复状态色点（段位徽章已含状态）");
  assert.ok(
    !/>\.zcode\/board\/evidence\/T36u\/00-baseline-ui-suite\.log</.test(dialog),
    "证据路径不显示全路径（可见文本是文件名）",
  );
  assert.match(dialog, />00-baseline-ui-suite\.log</, "路径截断为文件名");
  assert.match(
    dialog,
    /title="\.zcode\/board\/evidence\/T36u\/00-baseline-ui-suite\.log"/,
    "全路径保留在 title（可悬停查看）",
  );
  assert.match(dialog, /2 小时前/, "lastRun 时间相对化（12:00 - 09:30 → 2 小时前）");
  assert.match(dialog, />更新于 2 小时前</, "时间戳相对化（12:00 - 09:30 → 2 小时前，底部小字行）");
  assert.ok(!dialog.includes("10/10, 09:30 AM"), "弹窗不再显示绝对时间（相对化）");
});

test("弹窗：执行摘要 = 最近执行四要素 + 责任管线（当前执行者高亮）", () => {
  const markup = render({ openCardId: "task:46" });
  const dialog = dialogSlice(markup);
  const execution = dialog.slice(
    dialog.indexOf('data-board-dialog-section="execution"'),
    dialog.indexOf('data-board-dialog-section="origin"'),
  );
  assert.match(execution, /停在 #46/, "最近执行四要素（断点段）");
  assert.match(execution, /data-board-pipeline-current="true"/, "管线当前执行者标记");
  assert.match(execution, /data-board-pipeline-role="implementer"/, "管线角色");
});

test("诊断区：默认折叠为一行「诊断 N 条」，明细在折叠体内", () => {
  const base = readyGroupingBoard();
  assert.equal(base.kind, "ready");
  if (base.kind !== "ready") return;
  const markup = render({
    state: {
      kind: "ready",
      board: {
        ...base.board,
        diagnostics: [
          { path: ".zcode/plans/plan-x.md", message: "条目未领号：按未领号上板。" },
          { path: ".zcode/board/runs.json", message: "run 引用卡号 99 不在板上。" },
        ],
      },
    },
  });
  const slice = markup.slice(markup.indexOf('data-board-diagnostics="'));
  assert.ok(
    /<details[^>]*data-board-diagnostics=""[^>]*class="[^"]*shrink-0[^"]*"/.test(markup),
    "诊断区是 details 折叠体（非展开列表）",
  );
  assert.ok(!/<details[^>]*data-board-diagnostics=""[^>]*open/.test(markup), "默认折叠（无 open）");
  assert.match(markup, />诊断 2 条</, "摘要一行：诊断 N 条（逐字）");
  assert.match(slice, /条目未领号/, "明细保留在折叠体内（展开可见）");
  assert.match(slice, />plan-x\.md</, "诊断路径同样截断为文件名（可见文本）");
  assert.match(slice, /title="\.zcode\/plans\/plan-x\.md"/, "诊断路径全路径在 title");
});
