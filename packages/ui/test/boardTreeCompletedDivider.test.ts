import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPaneView, type BoardPaneViewProps } from "../src/board/BoardPaneView.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { readySortingBoard } from "./boardSortingFixture.js";

/**
 * 树形视图完成块的**弱分隔**（卡 #175 ①；来源证据 `.zcode/board/evidence/T6465d/design-review.md`
 * 第 2 条【归 #60】：长组里「已完成块与活卡边界仅靠位置 + 段位徽章表达」——评审建议弱分隔线 /
 * 组间节奏 / 弱化文本层级，明确要求**不大面积成功色填充**）。
 *
 * 期望值的独立真源：夹具 `SORTING_BOARD` 的章节与嵌套结构（夹具头注释逐卡标注）+ 卡 #65 的
 * 同级沉底规则（稳定分区：未完成保持文档序在前、已完成沉到同级末尾）——两者相交，本夹具的
 * 「活卡 → 完成」真实边界恰有三处：阶段一组（#72/#75 ⇒ #73/#74）、#75 的嵌套子卡组
 * （#77 ⇒ #76）、阶段二组（#78/#82 ⇒ #79）。阶段零（仅 #71）与 spec 块（仅 #81）整组只有
 * 已完成卡，没有跨越，不插线。
 *
 * 弱分隔的**视觉形态**（真 1px 弱描边、可辨识、不撑宽）由浏览器断言钉住
 * （`test/boardV21BrowserScenarios.ts` 树形场景）；这里钉结构、放置与反例（不得成功色填充）。
 */

function renderTree(props: Partial<BoardPaneViewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(BoardPaneView, {
        state: readySortingBoard(),
        viewMode: "tree",
        ...props,
      }),
    }),
  );
}

/** 渲染序 token 序列：任务卡锚点 `data-board-task` 取 id，弱分隔锚点取 `DIVIDER`（其余忽略）。 */
function treeTokenSequence(markup: string): string[] {
  return [
    ...markup.matchAll(/data-board-task="([^"]*)"|data-board-completed-divider="([^"]*)"/g),
  ].map((entry) => entry[1] ?? "DIVIDER");
}

test("树形完成块弱分隔（#175 ①）：每个同级组的「活卡 → 完成」边界各插一条弱分隔线", () => {
  const markup = renderTree();
  assert.deepEqual(
    treeTokenSequence(markup),
    [
      "task:71", // 阶段零：整组只有已完成卡 → 组内无边界
      "task:72", // 阶段一：活卡（文档序）
      "task:75", // 阶段一：活卡（带缺口；嵌套子卡渲染在父行之后）
      "task:77", //   └ #75 的嵌套待办卡（子卡组内的活卡）
      "DIVIDER", //      活卡 → 完成边界（嵌套子卡组）
      "task:76", //   └ #75 的嵌套已完成卡（同级沉底）
      "DIVIDER", //    活卡 → 完成边界（阶段一组）
      "task:73", // 阶段一：已完成（13:00 最新仍沉底）
      "task:74", // 阶段一：已完成
      "task:78", // 阶段二：活卡
      "task:82", // 阶段二：活卡
      "DIVIDER", //    活卡 → 完成边界（阶段二组）
      "task:79", // 阶段二：已完成
      "task:81", // spec 块：整组只有已完成卡 → 块内无边界
    ],
    "弱分隔线只落在「活卡在前、完成在后」的真实边界上；整组全完成的组不造假边界",
  );
});

test("树形完成块弱分隔（#175 ①）：弱描边形态——不引入成功色填充、不压实心底色", () => {
  // 反例（卡文验收）：改动引入「大面积成功色填充」时本测试与复核都可点名。
  const markup = renderTree();
  const dividerTags = [...markup.matchAll(/<div[^>]*data-board-completed-divider=""[^>]*>/g)].map(
    (entry) => entry[0],
  );
  assert.equal(dividerTags.length, 3, "夹具里三处真实边界各一条");
  for (const tag of dividerTags) {
    assert.ok(!/success/.test(tag), `弱分隔不得借成功色（评审点名反例）：${tag}`);
    assert.ok(!/bg-/.test(tag), `弱分隔不得带实心底色（大面积填充反例）：${tag}`);
    assert.match(tag, /aria-hidden="true"/, "弱分隔是纯视觉分组信号，不进可及性树");
  }
});
