import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardCardDialog } from "../src/board/BoardCardDialog.js";
import { collectBoardViewNodes, type BoardViewNode } from "../src/board/boardViewsViewModel.js";
import { buildBoardCardDialog } from "../src/board/boardDialogViewModel.js";
import { parseBoardJson, type BoardViewModel } from "../src/board/boardViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { GOLDEN_SHAPED_BOARD } from "./boardTestFixture.js";

/**
 * 卡片正文（目标 / 交付面 / 验收）的板映射与弹窗消费（卡 #183；分支 b 数据就绪形态）。
 *
 * 期望值的独立真源：
 * - 卡 #183 前置核实（evidence/T183/01-precheck-board-card-fields.log）：board.json 卡对象
 *   不带卡文段落字段，编译器字段提案见 evidence/T183/schema-proposal.txt——UI 按提案字段名
 *   goal / deliverables / acceptance 做「有字段则渲染、无字段优雅空态」；
 * - 消费契约 §13.6：视图不解析真相源、不自算；字段缺失不是空态/损坏态；
 * - itw-20261011-9003 密度准入：区块常驻且默认折叠（展开态可见），不塞满。
 * 实例文本逐条写死在本文件，不由实现回算。
 */

function boardWithCardText(): BoardViewModel {
  const raw = structuredClone(GOLDEN_SHAPED_BOARD) as {
    features: Array<{ tasks: Array<Record<string, unknown>> }>;
  };
  const card8 = raw.features[0]?.tasks[1];
  assert.ok(card8, "夹具应有 #8");
  card8.goal = "让拨开关后的状态在界面立刻生效（核心路径收口）。";
  card8.deliverables = ["开关接线单点收口", "updater 侧重复用", "回归断言补齐"];
  card8.acceptance = "用户拨开关后 1 秒内状态刷新，且无重复初始化调用。";
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") throw new Error("夹具必须是 v2 且 features 非空");
  return outcome.board;
}

function nodeOf(board: BoardViewModel, id: string): BoardViewNode {
  const node = collectBoardViewNodes(board).find((entry) => entry.id === id);
  assert.ok(node, `夹具里应有节点 ${id}`);
  return node;
}

test("板映射：卡片正文三字段有值逐字段读取，缺省卡不携带（数据就绪形态）", () => {
  const board = boardWithCardText();
  const card8 = nodeOf(board, "task:8");
  assert.equal(card8.goal, "让拨开关后的状态在界面立刻生效（核心路径收口）。");
  assert.deepEqual(card8.deliverables, ["开关接线单点收口", "updater 侧重复用", "回归断言补齐"]);
  assert.equal(card8.acceptance, "用户拨开关后 1 秒内状态刷新，且无重复初始化调用。");

  // 反例：板上没有这三个字段（当前真实板形态）→ null / 空数组，不造值。
  const card7 = nodeOf(boardWithCardText(), "task:7");
  assert.equal(card7.goal, null);
  assert.deepEqual(card7.deliverables, []);
  assert.equal(card7.acceptance, null);

  // 反例：坏形态（非字符串 / 非数组）一律归零，不猜语义。
  const raw = structuredClone(GOLDEN_SHAPED_BOARD) as {
    features: Array<{ tasks: Array<Record<string, unknown>> }>;
  };
  const card9 = raw.features[0]?.tasks[2];
  assert.ok(card9, "夹具应有 #9");
  card9.goal = 42;
  card9.deliverables = "不是数组";
  card9.acceptance = { text: "对象形态" };
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  const node9 = nodeOf(outcome.board, "task:9");
  assert.equal(node9.goal, null, "非字符串 goal 不猜");
  assert.deepEqual(node9.deliverables, [], "非数组 deliverables 归零");
  assert.equal(node9.acceptance, null, "非字符串 acceptance 不猜");
});

test("弹窗模型：卡片正文三字段原值透传（被点卡片自身，不读其他文件）", () => {
  const board = boardWithCardText();
  const dialog = buildBoardCardDialog(board, nodeOf(board, "task:8"));
  assert.equal(dialog.goal, "让拨开关后的状态在界面立刻生效（核心路径收口）。");
  assert.deepEqual(dialog.deliverables, ["开关接线单点收口", "updater 侧重复用", "回归断言补齐"]);
  assert.equal(dialog.acceptance, "用户拨开关后 1 秒内状态刷新，且无重复初始化调用。");

  const empty = buildBoardCardDialog(board, nodeOf(board, "task:7"));
  assert.equal(empty.goal, null);
  assert.deepEqual(empty.deliverables, []);
  assert.equal(empty.acceptance, null);

  // 特性节点：卡级字段不借子树的值（模型透传 null/[]，渲染层据此给显式空态）。
  const feature = buildBoardCardDialog(board, nodeOf(board, "spec:preview-channel"));
  assert.equal(feature.goal, null);
  assert.deepEqual(feature.deliverables, []);
  assert.equal(feature.acceptance, null);
});

/** SSR 渲染（zh-CN）某张卡的弹窗（有数据板见 `boardWithCardText`）。 */
function renderCardTextDialog(cardId: string, board = boardWithCardText()): string {
  const node = nodeOf(board, cardId);
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(BoardCardDialog, { board, node }),
    }),
  );
}

/** 从静态标记里切出 `data-board-dialog-section="<name>"` 元素（`<details>` 与 `<section>` 通用）。 */
function elementOf(markup: string, section: string): string | null {
  const match = new RegExp(`data-board-dialog-section="${section}"`).exec(markup);
  if (!match) return null;
  const start = Math.max(
    markup.lastIndexOf("<section", match.index),
    markup.lastIndexOf("<details", match.index),
  );
  const next = markup.indexOf("data-board-dialog-section=", match.index + 1);
  return markup.slice(start >= 0 ? start : match.index, next === -1 ? markup.length : next);
}

test("弹窗渲染：卡片内容区块常驻且默认折叠——展开面含目标/交付面/验收全文", () => {
  const markup = renderCardTextDialog("task:8");
  const section = elementOf(markup, "cardText");
  assert.ok(section, "卡片内容区块常驻（有数据卡：在渲染面）");
  const opening = /<details[^>]*data-board-dialog-card-text[^>]*>/.exec(section);
  assert.ok(opening, "区块是原生 <details>（展开态由用户开合，长文不占满弹窗）");
  assert.ok(!opening[0].includes(" open"), "默认折叠态常驻（不自动展开抢版面）");
  assert.ok(section.includes("让拨开关后的状态在界面立刻生效（核心路径收口）。"), "目标全文");
  assert.ok(section.includes("用户拨开关后 1 秒内状态刷新，且无重复初始化调用。"), "验收全文");
  for (const [index, item] of ["开关接线单点收口", "updater 侧重复用", "回归断言补齐"].entries()) {
    assert.ok(
      section.includes(`data-board-dialog-card-text-item="${index}"`),
      `交付面第 ${index} 项在渲染面`,
    );
    assert.ok(section.includes(item), `交付面第 ${index} 项文本`);
  }
  assert.ok(
    !section.includes("data-board-dialog-card-text-absent"),
    "三字段齐全 → 不出现「未携带」占位",
  );
});

test("弹窗渲染：字段缺省 → 区块常驻 + 显式「未携带」，不硬造内容（反例必咬）", () => {
  // 反例真源：当前真实板形态（#183 前置核实）——卡对象不带目标/交付面/验收，弹窗不得消失该区、
  // 不得编造正文；`details` 空串照旧隐藏（契约 §6 不受影响）。
  const markup = renderCardTextDialog("task:7");
  const section = elementOf(markup, "cardText");
  assert.ok(section, "字段缺省时区块仍常驻（空值有明确形态，不是静默消失）");
  const opening = /<details[^>]*data-board-dialog-card-text[^>]*>/.exec(section);
  assert.ok(opening, "折叠态常驻");
  assert.ok(!opening[0].includes(" open"), "默认不展开");
  assert.ok(section.includes("板上未携带"), "空态文案在渲染面（逐字：板上未携带）");
  assert.ok(
    section.includes("data-board-dialog-card-text-all-absent"),
    "摘要行带「全空」提示（一眼可见为什么没有内容）",
  );
  for (const field of ["goal", "deliverables", "acceptance"]) {
    const row = new RegExp(
      `data-board-dialog-card-text="${field}"[\\s\\S]*?(?=data-board-dialog-card-text="|$)`,
    ).exec(section);
    assert.ok(row, `逐字段行 ${field} 在渲染面`);
    assert.ok(row[0].includes("data-board-dialog-card-text-absent"), `${field} 空值给显式占位`);
  }
  assert.ok(
    !section.includes("data-board-dialog-card-text-value"),
    "三字段全空 → 一个值节点都不许有（不硬造）",
  );
  assert.equal(elementOf(markup, "details"), null, "细节空串照旧隐藏（契约 §6 行为不受本卡影响）");

  // 部分缺省（goal 有、其余缺）：值节点只出现在有值字段；摘要不再标「全空」。
  const raw = structuredClone(GOLDEN_SHAPED_BOARD) as {
    features: Array<{ tasks: Array<Record<string, unknown>> }>;
  };
  const card7 = raw.features[0]?.tasks[0];
  assert.ok(card7);
  card7.goal = "只带目标的一张卡。";
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  const partial = elementOf(renderCardTextDialog("task:7", outcome.board), "cardText");
  assert.ok(partial, "部分缺省时区块在渲染面");
  assert.ok(partial.includes("只带目标的一张卡。"), "有值字段原样渲染");
  assert.ok(
    !partial.includes("data-board-dialog-card-text-all-absent"),
    "非全空 → 摘要不带「全空」提示",
  );
  assert.equal(
    (partial.match(/data-board-dialog-card-text-value/g) ?? []).length,
    1,
    "值节点只给有值字段（其余走显式占位）",
  );
  assert.equal(
    (partial.match(/data-board-dialog-card-text-absent/g) ?? []).length,
    2,
    "两个缺省字段各有显式占位",
  );
});
