import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPaneView, type BoardPaneViewProps } from "../src/board/BoardPaneView.js";
import type { BoardPaneLoadState } from "../src/board/loadBoardDocument.js";
import {
  buildBoardKanban,
  buildBoardListGroups,
  EMPTY_BOARD_LIST_CONTROLS,
} from "../src/board/boardViewsViewModel.js";
import { parseBoardJson } from "../src/board/boardViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { GROUPING_BOARD } from "./boardGroupingFixture.js";

/**
 * 分组呈现的守卫（卡 #46 / 规则书 v2：B3 看板分组头 + B4 列表/表格分组折叠 + B6 责任管线高亮）。
 *
 * 期望值的独立真源：用户 2026-10-10 实测反馈：
 *   - B3：特性名做卡片分组头（**非独立卡**，不占一列位置）；
 *   - B4：列表/表格 = 分组行（特性头 + 缩进子行），可折叠；
 *   - B6：责任管线里当前执行者加粗变色，其余灰色小字（currentAssignee 来自 A3）。
 */

function readyState(): BoardPaneLoadState {
  const outcome = parseBoardJson(JSON.stringify(GROUPING_BOARD));
  if (outcome.kind !== "ready") throw new Error("夹具必须是 ready");
  return { kind: "ready", board: outcome.board };
}

function renderState(
  state: BoardPaneLoadState,
  props: Partial<BoardPaneViewProps> = {},
  locale: "zh-CN" | "en-US" = "zh-CN",
): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: locale,
      children: createElement(BoardPaneView, { state, ...props }),
    }),
  );
}

function render(
  props: Partial<BoardPaneViewProps> = {},
  locale: "zh-CN" | "en-US" = "zh-CN",
): string {
  return renderState(readyState(), props, locale);
}

/** 某张卡的渲染切片（到下一张卡为止）：管线断言按卡片范围取，不扫全页。 */
function cardSlice(markup: string, cardId: string): string {
  const start = markup.indexOf(`data-board-card="${cardId}"`);
  assert.ok(start >= 0, `markup 里应有卡片 ${cardId}`);
  const next = markup.indexOf('data-board-card="', start + 1);
  return markup.slice(start, next === -1 ? markup.length : next);
}

function anchors(markup: string, attribute: string): string[] {
  return [...markup.matchAll(new RegExp(`${attribute}="([^"]*)"`, "g"))].map(
    (match) => match[1] ?? "",
  );
}

/* ---------------- B3：看板分组头 ---------------- */

test("看板模型：列内按特性分组；特性节点自身段位所在列 = 分组头（featureInColumn）", () => {
  const outcome = parseBoardJson(JSON.stringify(GROUPING_BOARD));
  if (outcome.kind !== "ready") throw new Error("夹具必须是 ready");
  const { columns } = buildBoardKanban(outcome.board);
  const doing = columns.find((column) => column.stage === "执行中");
  assert.ok(doing);
  assert.deepEqual(
    doing.groups.map((group) => group.feature.id),
    ["plan:plan-zcode-ui"],
    "执行中列只有计划分组（特性自身段位 = 执行中）",
  );
  assert.equal(doing.groups[0]?.featureInColumn, true, "特性节点自身段位 = 本列");
  assert.deepEqual(
    doing.groups[0]?.nodes.map((node) => node.id),
    ["task:46"],
    "分组内是同列的任务卡",
  );

  const review = columns.find((column) => column.stage === "审核中");
  const todo = columns.find((column) => column.stage === "待办");
  assert.deepEqual(
    todo?.groups.map((group) => ({ id: group.feature.id, inColumn: group.featureInColumn })),
    [
      { id: "spec:alpha", inColumn: true },
      { id: "plan:plan-zcode-ui", inColumn: false },
    ],
    "待办列：spec 特性头在本列（inColumn），计划的待办卡以轻量分组标签随行",
  );
  assert.deepEqual(
    todo?.groups.find((group) => group.feature.id === "plan:plan-zcode-ui")?.nodes.map((n) => n.id),
    ["task:47"],
    "跨列分组只带本列的任务卡",
  );
  assert.equal(review?.groups.length, 0, "无节点列无分组");
});

test("看板渲染：分组头卡数 = 特性卡总数（#54-2），列内张数由列头计数表达", () => {
  // 真源：用户第四轮标注②——组头显示的是「本列有几张」会让人把特性规模读小（甚至读出「0 张卡」）；
  // 组头表达特性自身规模（全部子卡），列头计数表达本列排布数。
  const markup = render({ viewMode: "kanban" });
  const doing = markup.slice(
    markup.indexOf('data-board-column="执行中"'),
    markup.indexOf('data-board-column="审核中"'),
  );
  const group = doing.slice(doing.indexOf('data-board-kanban-group="plan:plan-zcode-ui"'));
  assert.match(
    group,
    /data-board-feature-card-count="2"/,
    "执行中列该特性只排 1 张卡，但组头显示特性卡总数 2",
  );
  assert.equal(
    (doing.match(/data-board-kanban-card="[^"]*"/g) ?? []).length,
    1,
    "列内实际只渲染本列的那 1 张卡（组头数字不改变卡列归属）",
  );

  const todo = markup.slice(
    markup.indexOf('data-board-column="待办"'),
    markup.indexOf('data-board-column="执行中"'),
  );
  const specGroup = todo.slice(todo.indexOf('data-board-kanban-group="spec:alpha"'));
  assert.match(specGroup, /data-board-feature-card-count="1"/, "单卡特性组头 = 1（总数即列内数）");
});

test("看板渲染：跨列分组头降级轻量标签（#54-9/P-2；不带段位徽章、角标弱化）", () => {
  // 真源：契约 §13.7 B3「特性自身段位在本列时分组头带自身徽章，跨列随行时只作轻量标签」。
  const markup = render({ viewMode: "kanban" });
  const todo = markup.slice(
    markup.indexOf('data-board-column="待办"'),
    markup.indexOf('data-board-column="执行中"'),
  );
  const headerOf = (column: string, featureId: string): string => {
    const start = column.indexOf(`data-board-kanban-group-header="${featureId}"`);
    assert.ok(start >= 0, `列里应有分组头 ${featureId}`);
    const end = column.indexOf("data-board-kanban-card=", start);
    return column.slice(start, end === -1 ? column.length : end);
  };

  const crossColumn = headerOf(todo, "plan:plan-zcode-ui");
  assert.match(crossColumn, /data-board-group-lightweight="true"/, "跨列分组头带轻量锚点");
  assert.ok(
    !/data-board-stage="/.test(crossColumn),
    "跨列标签不带段位徽章（特性段位属于它自己那一列）",
  );
  assert.match(
    crossColumn,
    /data-board-feature-card-count="2"/,
    "轻量标签仍显示特性卡总数（规模不因跨列而缩水）",
  );

  const inColumn = headerOf(todo, "spec:alpha");
  assert.ok(!inColumn.includes("data-board-group-lightweight"), "同列分组头维持全量形态");
  assert.match(inColumn, /data-board-stage="待办"/, "同列分组头带自身段位徽章");
  assert.match(inColumn, /data-board-feature-card-count="1"/, "同列分组头计数照旧");
});

test("看板渲染：特性分组头不是独立卡（卡片锚点只出现在任务卡上）", () => {
  const markup = render({ viewMode: "kanban" });
  const doing = markup.slice(
    markup.indexOf('data-board-column="执行中"'),
    markup.indexOf('data-board-column="审核中"'),
  );
  assert.match(doing, /data-board-kanban-group="plan:plan-zcode-ui"/, "执行中列带分组头锚点");
  assert.deepEqual(
    anchors(doing, "data-board-kanban-card"),
    ["task:46"],
    "列内卡片锚点只有任务卡（特性不再占卡位）",
  );
  assert.match(doing, /data-board-feature-code="UI01"/, "分组头显示计划码（完整形态）");
  const todo = markup.slice(
    markup.indexOf('data-board-column="待办"'),
    markup.indexOf('data-board-column="执行中"'),
  );
  // 待办列两组均无缺口、成员同刻（09:00）：分组序按「组内最高优先成员」比较，同刻回落到成员 id
  // （task:21 < task:47）——单一比较器（compareBoardViewNodes）同时管组序与行序，不另造规则。
  assert.deepEqual(
    anchors(todo, "data-board-kanban-group"),
    ["spec:alpha", "plan:plan-zcode-ui"],
    "待办列分组序 = 组内最高优先成员（同刻按 id 稳定收敛）",
  );
});

/* ---------------- B4：列表/表格分组折叠 ---------------- */

test("列表模型：分组 = 特性头 + 过滤排序后的子行（组间 attention 置顶序保持）", () => {
  const outcome = parseBoardJson(JSON.stringify(GROUPING_BOARD));
  if (outcome.kind !== "ready") throw new Error("夹具必须是 ready");
  const groups = buildBoardListGroups(outcome.board, {});
  assert.deepEqual(
    groups.map((group) => ({
      feature: group.feature.id,
      rows: group.nodes.map((node) => node.id),
    })),
    [
      { feature: "plan:plan-zcode-ui", rows: ["task:46", "task:47"] },
      { feature: "spec:alpha", rows: ["task:21"] },
    ],
    "分组序按成员最高优先（缺口置顶）；组内行按 updatedAt 倒序",
  );
});

test("列表/表格组头计数 = 特性卡总数（#59 S-1）：过滤只减行，不把组头读小", () => {
  // 真源：T5455r S-1——同一「[N 张卡]」四视图必须一种口径（总数在视图模型单点产出）；
  // 组头表达特性规模，行数表达当前过滤；列内/组内张数由行数自然表达。
  const outcome = parseBoardJson(JSON.stringify(GROUPING_BOARD));
  if (outcome.kind !== "ready") throw new Error("夹具必须是 ready");
  const filtered = buildBoardListGroups(outcome.board, { filter: { stage: "执行中" } });
  const plan = filtered.find((group) => group.feature.id === "plan:plan-zcode-ui");
  assert.ok(plan, "执行中过滤后 plan 分组仍在（#46 卡在列）");
  assert.equal(plan.nodes.length, 1, "组内只留执行中的 #46");
  assert.equal(plan.totalCards, 2, "组头计数 = 特性卡总数（#46 + #47），不是过滤后行数");

  const listMarkup = render({
    viewMode: "list",
    listControls: { ...EMPTY_BOARD_LIST_CONTROLS, stage: "执行中" },
  });
  const listGroup = listMarkup.slice(
    listMarkup.indexOf('data-board-list-group="plan:plan-zcode-ui"'),
  );
  assert.match(
    listGroup,
    /data-board-feature-card-count="2"/,
    "列表组头 = 总数 2（列内只排 1 行）",
  );

  const tableMarkup = render({
    viewMode: "table",
    listControls: { ...EMPTY_BOARD_LIST_CONTROLS, stage: "执行中" },
  });
  const tableGroup = tableMarkup.slice(
    tableMarkup.indexOf('data-board-table-group="plan:plan-zcode-ui"'),
  );
  assert.match(
    tableGroup,
    /data-board-feature-card-count="2"/,
    "表格组头 = 总数 2（组内只排 1 行）",
  );
});

test("列表组头点击分区（#54-4）：编号+名称区=开弹窗，段位/徽章/计数区=折叠", () => {
  // 真源：用户第四轮标注④——整行 preventDefault 吃掉折叠；开弹窗落点收窄到编号+名称，
  // 右区（段位/徽章/计数）与 summary 空白保留 summary 默认动作（折叠/展开）。
  const markup = render({ viewMode: "list" });
  const summaryStart = markup.indexOf('data-board-list-group-summary="plan:plan-zcode-ui"');
  assert.ok(summaryStart >= 0, "列表分组摘要应存在");
  const summary = markup.slice(summaryStart, markup.indexOf("</summary>", summaryStart));
  const openStart = summary.indexOf('data-board-card="plan:plan-zcode-ui"');
  assert.ok(openStart >= 0, "开弹窗落点锚点应仍在（跳转/高亮依赖它）");
  const titleAt = summary.indexOf("ZCode 看板 UI", openStart);
  assert.ok(titleAt > openStart, "落点里应有名称");
  const openRegion = summary.slice(openStart, summary.indexOf("</div>", titleAt));
  assert.ok(openRegion.includes("data-board-node-id"), "落点含编号");
  assert.ok(
    !openRegion.includes("data-board-stage="),
    "段位徽章在落点外（点它 = summary 默认动作，折叠）",
  );
  assert.ok(!openRegion.includes("data-board-badges"), "角标簇在落点外");
  assert.ok(!openRegion.includes("data-board-feature-card-count"), "计数在落点外");

  const outside = summary.slice(summary.indexOf("</div>", titleAt));
  assert.ok(outside.includes("data-board-stage="), "段位徽章留在 summary 内（默认动作可及）");
  assert.ok(outside.includes("data-board-feature-card-count"), "计数留在 summary 内");
  assert.ok(outside.includes("data-board-badges"), "角标簇留在 summary 内");
});

test("列表渲染：分组行（<details>，特性头 + 缩进子行；子行编号短形态）", () => {
  const markup = render({ viewMode: "list" });
  const group = markup.slice(
    markup.indexOf('data-board-list-group="plan:plan-zcode-ui"'),
    markup.indexOf('data-board-list-group="spec:alpha"'),
  );
  assert.match(group, /data-board-feature-card-count="2"/, "分组行显示卡片数摘要");
  assert.match(group, /data-board-node-id="5"/, "计划分组内子行编号省略计划码前缀");
  assert.match(group, /data-board-indent="1"/, "子行带结构缩进");
  assert.match(group, /data-board-list-group-summary="plan:plan-zcode-ui"/, "分组行是折叠摘要");
  const specGroup = markup.slice(markup.indexOf('data-board-list-group="spec:alpha"'));
  assert.match(specGroup, /data-board-node-id="ID-20.1"/, "spec 分组子行维持 ID- 形态");
});

test("表格渲染：分组行（列宽整行占位 + 特性头），子行在分组内", () => {
  const markup = render({ viewMode: "table" });
  const group = markup.slice(
    markup.indexOf('data-board-table-group="plan:plan-zcode-ui"'),
    markup.indexOf('data-board-table-group="spec:alpha"'),
  );
  assert.match(group, /<td[^>]*colspan="10"/i, "分组行整行占位（colSpan = 可见列数）");
  assert.match(group, /data-board-feature-code="UI01"/, "分组行显示计划码");
  assert.match(group, /data-board-node-id="5"/, "子行编号短形态");
  const rowIds = [...group.matchAll(/<tr[^>]*data-board-card="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(rowIds, ["task:46", "task:47"], "分组内行序 = 组内排序");
});

/* ---------------- S-3（#55）：折叠控件的可及名称与指示符 ---------------- */

function toggleTag(markup: string, featureId: string): string {
  const match = new RegExp(`<button[^>]*data-board-group-toggle="${featureId}"[^>]*>`).exec(markup);
  assert.ok(match, `表格里应有 ${featureId} 的折叠按钮`);
  return match[0];
}

function ariaLabelOf(markup: string, featureId: string): string {
  const match = /aria-label="([^"]*)"/.exec(toggleTag(markup, featureId));
  assert.ok(match, "折叠按钮应带 aria-label（可及名称不能只有 ▸/▾ 符号）");
  return match[1] ?? "";
}

test("可及名称（#55 S-3）：表格折叠按钮 = 展开/收起 + 特性名（两语、随状态切换）", () => {
  // 真源：评审 #46 S-3——按钮只有 ▸/▾ 符号，无可及名称。修复走词条（zh/en 两语）；
  // 状态仍由 aria-expanded 表达，名称只补「动作 + 对象」。
  assert.equal(
    ariaLabelOf(render({ viewMode: "table" }), "plan:plan-zcode-ui"),
    "收起 ZCode 看板 UI",
  );
  const collapsed = render({ viewMode: "table", collapsedFeatureIds: ["plan:plan-zcode-ui"] });
  assert.equal(ariaLabelOf(collapsed, "plan:plan-zcode-ui"), "展开 ZCode 看板 UI");
  assert.equal(
    /aria-expanded="false"/.test(toggleTag(collapsed, "plan:plan-zcode-ui")),
    true,
    "折叠态仍由 aria-expanded 表达",
  );
  const english = renderState(readyState(), { viewMode: "table" }, "en-US");
  assert.equal(ariaLabelOf(english, "plan:plan-zcode-ui"), "Collapse ZCode 看板 UI");
  const englishCollapsed = renderState(
    readyState(),
    { viewMode: "table", collapsedFeatureIds: ["plan:plan-zcode-ui"] },
    "en-US",
  );
  assert.equal(ariaLabelOf(englishCollapsed, "plan:plan-zcode-ui"), "Expand ZCode 看板 UI");
});

test("折叠指示符（#55 S-3）：树形/列表摘要带装饰性 chevron；展开态走原生 summary 语义", () => {
  // 判断成文（#55 S-3）：树形/列表的折叠摘要是原生 `<details>/<summary>`——展开态已由原生
  // disclosure 语义向辅助技术暴露，`aria-label` 反而会覆盖由内容（编号/名称/角标）构成的可及名称；
  // 缺的是**视觉**指示符。因此补装饰性 chevron（`aria-hidden`，`group-open:` 旋转），
  // 不写伪 `aria-expanded`。浏览器侧旋转行为断言见 test/boardV21BrowserScenarios.ts。
  const list = render({ viewMode: "list" });
  const listStart = list.indexOf('data-board-list-group-summary="plan:plan-zcode-ui"');
  assert.ok(listStart >= 0, "列表分组摘要应存在");
  const listSummary = list.slice(listStart, list.indexOf("</summary>", listStart));
  const listIndicator = /<span[^>]*data-board-fold-indicator=""[^>]*>/.exec(listSummary);
  assert.ok(listIndicator, "列表折叠摘要应有 chevron 指示符");
  assert.ok(/aria-hidden="true"/.test(listIndicator[0]), "指示符是装饰性的（不夺可及名称）");
  assert.ok(
    !listSummary.slice(0, listSummary.indexOf(">")).includes("aria-expanded"),
    "summary 不写伪 aria-expanded（原生语义已表达展开态）",
  );

  const tree = render({ viewMode: "tree" });
  for (const featureId of ["plan:plan-zcode-ui", "spec:alpha"]) {
    const start = tree.indexOf(`data-board-feature-block-summary="${featureId}"`);
    assert.ok(start >= 0, `树形摘要 ${featureId} 应存在`);
    const summary = tree.slice(start, tree.indexOf("</summary>", start));
    const indicator = /<span[^>]*data-board-fold-indicator=""[^>]*>/.exec(summary);
    assert.ok(indicator, `树形摘要 ${featureId} 应有 chevron 指示符（折叠不是消失）`);
    assert.ok(/aria-hidden="true"/.test(indicator[0]), "指示符是装饰性的");
  }
});

/* ---------------- B6：责任管线高亮 ---------------- */

test("责任管线三态（#54-1）：done 弱化勾形 + current 主色加粗 + next 次强调带「下一个」", () => {
  // 真源：消费契约 §13.7「责任管线（B6）」v2.3 段——nextAssignee（管线序首个无 done 证据角色）
  // 以轻量标识挂在管线上，与 currentAssignee（"谁在做"）并列；全 done → 不显示接手位。
  const raw = structuredClone(GROUPING_BOARD) as {
    features: Array<{ tasks: Array<Record<string, unknown>> }>;
  };
  const card = raw.features[0]?.tasks[0];
  assert.ok(card, "夹具应有 plan 的第一张卡（task:46）");
  // 手推管线状态：implementer 已 done、test-verifier 正在做、code-reviewer 是下一个。
  card.activeRun = { role: "test-verifier", at: "2026-10-10T10:00:00+08:00" };
  card.currentAssignee = "test-verifier";
  card.nextAssignee = "code-reviewer";
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  const state: BoardPaneLoadState = { kind: "ready", board: outcome.board };
  const markup = renderState(state, { viewMode: "table" });
  const pipeline = cardSlice(markup, "task:46");
  assert.match(
    pipeline,
    /data-board-pipeline-role="implementer"[^>]*data-board-pipeline-done="true"/,
    "已 done 的角色带弱化锚点",
  );
  assert.ok(pipeline.includes("✓"), "已 done 的角色带勾形（dim + 勾形）");
  assert.match(
    pipeline,
    /data-board-pipeline-role="test-verifier"[^>]*data-board-pipeline-current="true"/,
    "当前执行者仍是主色加粗（#46 B6 口径不变）",
  );
  assert.ok(
    !/data-board-pipeline-role="test-verifier"[^>]*data-board-pipeline-(done|next)/.test(pipeline),
    "当前执行者不得被误标为 done / next",
  );
  assert.match(
    pipeline,
    /data-board-pipeline-next="code-reviewer"/,
    "下一接手人锚点带角色名（data-board-pipeline-next=<role>）",
  );
  assert.ok(pipeline.includes("下一个"), "接手位带词条化的「下一个」标记");
  assert.ok(
    !/data-board-pipeline-role="integrator"[^>]*data-board-pipeline-(done|next)/.test(pipeline),
    "未开始的角色不误标（只有管线序早于 nextAssignee 的角色才算 done）",
  );

  const english = renderState(state, { viewMode: "table" }, "en-US");
  assert.ok(cardSlice(english, "task:46").includes("Next"), "接手位标记走英文词条（Next）");
});

test("责任管线：无 nextAssignee（字段缺省/全 done）时不编造接手位", () => {
  const markup = render({ viewMode: "table" });
  const pipeline = cardSlice(markup, "task:46");
  assert.ok(!pipeline.includes("data-board-pipeline-next"), "缺省 → 不显示接手位");
  assert.ok(!pipeline.includes("data-board-pipeline-done"), "缺省 → 不把任何角色画成已完成");
});

test("责任管线：当前执行者加粗变色，其余灰色小字（表格 assignees 列）", () => {
  const markup = render({ viewMode: "table" });
  const pipeline = markup.slice(markup.indexOf("data-board-pipeline="));
  assert.match(
    pipeline,
    /data-board-pipeline-role="implementer"[^>]*data-board-pipeline-current="true"/,
    "当前执行者标记",
  );
  assert.ok(
    /data-board-pipeline-current="true"[^>]*class="[^"]*font-medium[^"]*"/.test(pipeline) ||
      /class="[^"]*font-medium[^"]*"[^>]*data-board-pipeline-current="true"/.test(pipeline),
    "当前执行者加粗（font-medium）",
  );
  assert.ok(
    /data-board-pipeline-current="true"[^>]*class="[^"]*text-primary/.test(pipeline) ||
      /class="[^"]*text-primary[^"]*"[^>]*data-board-pipeline-current="true"/.test(pipeline),
    "当前执行者变色（text-primary）",
  );
  assert.ok(
    /data-board-pipeline-role="test-verifier"[^>]*class="[^"]*text-foreground-subtle/.test(
      pipeline,
    ) ||
      /class="[^"]*text-foreground-subtle[^"]*"[^>]*data-board-pipeline-role="test-verifier"/.test(
        pipeline,
      ),
    "其余角色灰色小字（text-foreground-subtle）",
  );
  assert.ok(
    !/data-board-pipeline-role="test-verifier"[^>]*data-board-pipeline-current/.test(pipeline),
    "非当前执行者不得误标",
  );
  // #59 N2：角色文本自带截断防线与全文 title（长 agent 名行高与扫读稳定）。
  assert.match(
    pipeline,
    /data-board-pipeline-role="implementer"[^>]*title="implementer"/,
    "角色文本带 title 全文（#59 N2）",
  );
});
