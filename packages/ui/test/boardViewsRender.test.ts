import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPaneView, type BoardPaneViewProps } from "../src/board/BoardPaneView.js";
import type { BoardPaneLoadState } from "../src/board/loadBoardDocument.js";
import {
  EMPTY_BOARD_LIST_CONTROLS,
  type BoardListControls,
  type BoardViewMode,
} from "../src/board/boardViewsViewModel.js";
import { parseBoardJson } from "../src/board/boardViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { STAGE_MATRIX_BOARD } from "./boardStageMatrixFixture.js";

/**
 * 看板列视图与列表视图的真渲染守卫（卡 #33）。
 *
 * 期望值的独立真源：`.zcode/board/board-consumption-contract.md` §13.2（视图矩阵逐格要求：
 * 列头/列内元素/待合并与受阻角标/已取消列展示 statusRule）、§13.3（访谈汇总子区，默认折叠）、
 * §13.4（待合并角标）、§3.5（排序）与 §2（空态文案）。夹具实例期望见 boardStageMatrixFixture
 * 的 `STAGE_MATRIX_BOARD` 注释（哪张卡落哪列逐条写死）。
 */

function render(state: BoardPaneLoadState, props: Partial<BoardPaneViewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(BoardPaneView, { state, ...props }),
    }),
  );
}

function matrixBoard(): BoardPaneLoadState {
  const outcome = parseBoardJson(JSON.stringify(STAGE_MATRIX_BOARD));
  if (outcome.kind !== "ready") throw new Error("七段位夹具必须是 v2 且 features 非空");
  return { kind: "ready", board: outcome.board };
}

/** 一列的 markup 切片：从本列锚点到下一列锚点（渲染序 = 七段位序）。 */
function columnSlice(markup: string, stage: string, nextStage: string | null): string {
  const start = markup.indexOf(`data-board-column="${stage}"`);
  assert.ok(start >= 0, `列 ${stage} 应存在：\n${markup.slice(0, 400)}`);
  const end =
    nextStage === null ? markup.length : markup.indexOf(`data-board-column="${nextStage}"`);
  assert.ok(end > start, `列 ${nextStage} 应在 ${stage} 之后`);
  return markup.slice(start, end);
}

function attributeValue(markup: string, attribute: string): string {
  const match = new RegExp(`${attribute}="([^"]*)"`).exec(markup);
  assert.ok(match, `markup 里找不到 ${attribute}`);
  return match[1] ?? "";
}

/** 某锚点元素的直接文本子节点（逐字文案断言用）。 */
function textInside(markup: string, attr: string): string {
  const match = new RegExp(`<[^>]*${attr}[^>]*>([^<]*)<`).exec(markup);
  assert.ok(match, `markup 里找不到 ${attr} 的文本：\n${markup.slice(0, 400)}`);
  return (match[1] ?? "").trim();
}

/** 列头文本：按 `data-board-column-title` 锚点取（评审 #33-S2：不绑 CSS 类）。 */
function columnHeaderText(markup: string, stage: string): string {
  const start = markup.indexOf(`data-board-column="${stage}"`);
  assert.ok(start >= 0, `列 ${stage} 应存在`);
  const slice = markup.slice(start, start + 600);
  const match =
    /data-board-column-title=""[^>]*>([^<]*)</.exec(slice) ??
    /<summary[^>]*>\s*<[^>]*>([^<]*)</.exec(slice);
  assert.ok(match, `列 ${stage} 应有列头文本锚点`);
  return (match[1] ?? "").trim();
}

const kanban = (state: BoardPaneLoadState = matrixBoard()) => render(state, { viewMode: "kanban" });

test("看板：七列按流水序渲染，列头走段位词条", () => {
  const markup = kanban();
  assert.ok(markup.includes('data-board-view="kanban"'), "看板视图应有自己的根锚点");
  const order = [...markup.matchAll(/data-board-column="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(order, ["待设计", "待办", "执行中", "审核中", "阻塞", "已完成", "已取消"]);
  for (const stage of order) {
    assert.equal(columnHeaderText(markup, stage), stage, `列头应走段位词条：${stage}`);
  }
});

test("看板：卡片卡入对应列（特性与任务卡同一集合）", () => {
  const markup = kanban();
  assert.ok(
    columnSlice(markup, "执行中", "审核中").includes('data-board-card="task:8"'),
    "#8 段位=执行中，应在本列",
  );
  assert.ok(
    columnSlice(markup, "执行中", "审核中").includes('data-board-card="spec:preview-channel"'),
    "段位=执行中的特性节点也在本列（阻塞/已完成等段位仅特性级产出）",
  );
  assert.ok(
    columnSlice(markup, "阻塞", "已完成").includes('data-board-card="spec:payment-split"'),
    "阻塞列的节点是特性",
  );
  assert.ok(
    columnSlice(markup, "审核中", "阻塞").includes('data-board-card="task:13"'),
    "#13 段位=审核中",
  );
});

test("看板：空列保留并显示 0（骨架不随数据跳动），计数来自列内节点数", () => {
  const raw = structuredClone(STAGE_MATRIX_BOARD);
  raw.features = raw.features.filter(
    (feature) => (feature as { id?: string }).id !== "spec:payment-split",
  );
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  const markup = kanban({ kind: "ready", board: outcome.board });
  const blocked = columnSlice(markup, "阻塞", "已完成");
  assert.ok(blocked.includes('data-board-column="阻塞"'), "空列不隐藏");
  assert.equal(attributeValue(blocked, "data-board-column-count"), "0", "空列计数为 0");
  assert.ok(!blocked.includes("data-board-card="), "空列里没有卡片");
});

test("看板：列头计数（非空列）", () => {
  const markup = kanban();
  assert.equal(
    attributeValue(columnSlice(markup, "待办", "执行中"), "data-board-column-count"),
    "3",
  );
  assert.equal(
    attributeValue(columnSlice(markup, "执行中", "审核中"), "data-board-column-count"),
    "2",
  );
  assert.equal(
    attributeValue(columnSlice(markup, "已完成", "已取消"), "data-board-column-count"),
    "1",
  );
});

test("看板：卡片紧凑形态 = 号 + 标题 + 段位徽章 + 缺口徽章", () => {
  const markup = kanban();
  const running = columnSlice(markup, "执行中", "审核中");
  assert.ok(running.includes("ID-1.2"), "卡片应带编号");
  assert.ok(running.includes("让开关立刻生效（核心）"), "卡片应带标题");
  assert.ok(running.includes('data-board-stage="执行中"'), "卡片应带段位徽章");
  assert.ok(
    running.includes('data-board-attention="interrupted-resume"') &&
      running.includes('data-board-attention="unmerged-worktree"'),
    "卡片应带缺口徽章（两个码都在）",
  );
  // §13.2「审核中」格：unmerged-worktree → 待合并角标（逐字文案，§13.4）。
  assert.ok(running.includes("待合并（执行现场未回流）"), "待合并角标应逐字渲染");
});

test("看板：已取消列灰显并展示 statusRule 取消原因（§13.2）", () => {
  const markup = kanban();
  const cancelled = columnSlice(markup, "已取消", null);
  assert.ok(cancelled.includes('data-board-card="task:12"'), "#12 段位=已取消");
  assert.ok(
    cancelled.includes("cancelled: 上游方案作废（取消留痕、号不复用）"),
    "取消原因（statusRule）应逐字展示",
  );
  // 灰显守卫（评审 #33-S1）：测试名承诺的「灰显」必须有断言锚点，不能只有文案。
  assert.ok(
    /data-board-column="已取消"[^>]*data-board-column-muted="true"/.test(cancelled),
    "已取消列应带灰显锚点",
  );
  assert.ok(
    !columnSlice(markup, "待办", "执行中").includes("data-board-column-muted"),
    "其余列不得被误标灰显",
  );
});

test("看板：卡片角标簇与其余视图同装配（§13.2 各格要求的角标一处组装）", () => {
  const raw = structuredClone(STAGE_MATRIX_BOARD);
  const card8 = raw.features[0]?.tasks[1] as {
    draft?: boolean;
    blockers?: unknown[];
  };
  assert.ok(card8, "夹具应有 #8");
  card8.draft = true;
  card8.blockers = [{ kind: "external", summary: "待验证", evidence: [] }];
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  const state: BoardPaneLoadState = { kind: "ready", board: outcome.board };

  /**
   * 元素自身的 markup 切片：从锚点到下一个同类锚点；`null` = 固定窗口（弹窗的 class 串很长，
   * 角标区在窗口内可见即可）。
   */
  const clusterOf = (markup: string, anchor: string, nextAnchor: string | null): string => {
    const start = markup.indexOf(anchor);
    assert.ok(start >= 0, `${anchor} 应在 markup 里`);
    const next = nextAnchor === null ? -1 : markup.indexOf(nextAnchor, start + 1);
    return markup.slice(start, next > start ? next : start + 12000);
  };

  const order = [
    "data-board-draft",
    "data-board-attention",
    "data-board-blockers",
    "data-board-active-run",
    "data-board-status",
  ];

  // 三处「卡片角标」视图共用同一装配点（表格的段位/缺口/受阻是单元格文本，不走角标簇）；
  // 弹窗状态区同装配。
  const card = 'data-board-card="task:8"';
  const anyCard = 'data-board-card="';
  const surfaces: Array<{
    name: string;
    markup: string;
    anchor: string;
    next: string | null;
  }> = [
    { name: "tree", markup: render(state, { viewMode: "tree" }), anchor: card, next: anyCard },
    { name: "kanban", markup: render(state, { viewMode: "kanban" }), anchor: card, next: anyCard },
    { name: "list", markup: render(state, { viewMode: "list" }), anchor: card, next: anyCard },
    {
      name: "dialog",
      markup: render(state, { viewMode: "table", openCardId: "task:8" }),
      anchor: 'data-board-dialog="task:8"',
      next: null,
    },
  ];
  for (const surface of surfaces) {
    const cluster = clusterOf(surface.markup, surface.anchor, surface.next);
    assert.ok(cluster.includes("data-board-badges"), `${surface.name} 的卡片应走同一处角标装配`);
    for (const anchor of [
      'data-board-draft=""',
      'data-board-attention="interrupted-resume"',
      'data-board-attention="unmerged-worktree"',
      'data-board-blockers="1"',
      'data-board-active-run="implementer"',
      'data-board-status="active"',
    ]) {
      assert.ok(cluster.includes(anchor), `${surface.name} 的角标簇应含 ${anchor}：${cluster}`);
    }
    const positions = order.map((anchor) => cluster.indexOf(anchor));
    assert.deepEqual(
      [...positions].sort((left, right) => left - right),
      positions,
      `${surface.name} 的角标簇顺序应与装配点一致（草案 → 缺口 → 受阻 → 执行角色 → 状态点）`,
    );
  }
});

test("看板：待设计列的访谈汇总子区默认折叠，计数取 attentionSummary（§13.3）", () => {
  const markup = kanban();
  const design = columnSlice(markup, "待设计", "待办");
  const summaryMatch = /<details[^>]*data-board-interview-summary[^>]*>/.exec(design);
  assert.ok(summaryMatch, "待设计列应有访谈汇总子区");
  assert.ok(!summaryMatch[0].includes(" open"), "子区默认折叠（<details> 不带 open）");
  const summarySlice = design.slice(design.indexOf(summaryMatch[0]));
  assert.ok(summarySlice.includes("访谈汇总"), "子区标题逐字「访谈汇总」");
  assert.equal(attributeValue(summarySlice, "data-board-interview-count"), "2");
  // 两个 interview-only 节点在子区里，安排类 plan 节点留在主列（§13.3）。
  const main = design.slice(0, design.indexOf(summaryMatch[0]));
  assert.ok(!main.includes('data-board-card="interview:itw-a"'), "interview-only 节点不在主列");
  assert.ok(!main.includes('data-board-card="interview:itw-b"'), "interview-only 节点不在主列");
  assert.ok(
    main.includes('data-board-card="plan:sess_1f3c5d7e"'),
    "安排类 plan 节点留在待设计主列",
  );
  assert.ok(summarySlice.includes('data-board-card="interview:itw-a"'));
  assert.ok(summarySlice.includes('data-board-card="interview:itw-b"'));
});

test("看板：已完成列是可折叠分区（默认展开，归档前可见）", () => {
  const markup = kanban();
  const doneMatch = /<details[^>]*data-board-column-details="已完成"[^>]*>/.exec(markup);
  assert.ok(doneMatch, "已完成列应是可折叠分区");
  assert.ok(doneMatch[0].includes("open"), "默认展开（归档前要看得见）");
});

test("看板：段位缺失/不认识的节点数给提示，不静默丢失（列表视图仍全量）", () => {
  const raw = structuredClone(STAGE_MATRIX_BOARD);
  delete (raw.features[0] as { stage?: string }).stage;
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  const state: BoardPaneLoadState = { kind: "ready", board: outcome.board };
  const markup = kanban(state);
  const notice = /data-board-unplaced="([^"]*)"/.exec(markup);
  assert.ok(notice, "应有未定位节点提示");
  assert.equal(notice[1], "1", "提示计数 = 未定位节点数");
  assert.ok(markup.includes("段位"), "提示应说明原因（段位无法识别）");
  assert.ok(
    render(state, { viewMode: "list" }).includes("预览通道（Preview Channel）"),
    "列表视图仍能看到该节点（不静默丢失）",
  );
});

/* ---------------- 列表视图（§13.2 列表列 + §3.5 排序 + 过滤 UI 最小化） ---------------- */

const list = (controls?: Partial<BoardListControls>, state: BoardPaneLoadState = matrixBoard()) =>
  render(state, {
    viewMode: "list",
    ...(controls ? { listControls: { ...EMPTY_BOARD_LIST_CONTROLS, ...controls } } : {}),
  });

test("列表：过滤控件是闭集取值（段位 7 + 状态 5 + 缺口 4 + 类型 2 + 排序 2），各带「全部」项", () => {
  const markup = list();
  assert.ok(markup.includes('data-board-view="list"'), "列表视图应有自己的根锚点");
  const optionsOf = (filter: string): string[] => {
    const match = new RegExp(`data-board-filter="${filter}"[\\s\\S]*?</select>`).exec(markup);
    assert.ok(match, `找不到过滤控件 ${filter}`);
    return [...match[0].matchAll(/<option value="([^"]*)"/g)].map((entry) => entry[1] ?? "");
  };
  assert.deepEqual(optionsOf("stage"), [
    "",
    "待设计",
    "待办",
    "执行中",
    "审核中",
    "阻塞",
    "已完成",
    "已取消",
  ]);
  assert.deepEqual(optionsOf("status"), [
    "",
    "pending",
    "active",
    "blocked",
    "completed",
    "cancelled",
  ]);
  assert.deepEqual(optionsOf("attention"), [
    "",
    "interviewed-not-arranged",
    "arranged-not-expanded",
    "interrupted-resume",
    "unmerged-worktree",
  ]);
  assert.deepEqual(optionsOf("kind"), ["", "feature", "task"], "类型筛（§13.2 表格待设计格）");
  assert.deepEqual(optionsOf("sort"), ["recent", "oldest"]);
});

test("列表：类型筛（kind）按闭集取值收窄行集合（特性/卡片各自筛）", () => {
  const featuresOnly = list({ kind: "feature" });
  assert.ok(featuresOnly.includes('data-board-card="spec:preview-channel"'), "特性节点留下");
  assert.ok(!featuresOnly.includes('data-board-card="task:8"'), "卡片被筛掉");
  const tasksOnly = list({ kind: "task" });
  assert.ok(tasksOnly.includes('data-board-card="task:8"'), "卡片留下");
  assert.ok(!tasksOnly.includes('data-board-card="spec:preview-channel"'), "特性节点被筛掉");
});

test("列表：按段位过滤只留该段位行（其余行不出现）", () => {
  const markup = list({ stage: "审核中" });
  assert.ok(markup.includes('data-board-card="task:13"'));
  assert.ok(!markup.includes('data-board-card="task:8"'), "执行中的卡不得出现");
  assert.ok(!markup.includes('data-board-card="spec:preview-channel"'), "执行中的特性不得出现");
});

test("列表：按状态过滤（cancelled 终态）与按缺口码过滤", () => {
  const cancelled = list({ status: "cancelled" });
  assert.ok(cancelled.includes('data-board-card="task:12"'));
  assert.ok(!cancelled.includes('data-board-card="task:9"'), "已完成的卡不得出现");
  const unmerged = list({ attention: "unmerged-worktree" });
  assert.ok(unmerged.includes('data-board-card="task:8"'));
  assert.ok(unmerged.includes('data-board-card="task:14"'));
  assert.ok(!unmerged.includes('data-board-card="task:7"'), "没挂该码的卡不得出现");
});

test("列表：排序切「最老未动」（attention 仍置顶，其余最老在前）", () => {
  const recent = list();
  const oldest = list({ sort: "oldest" });
  assert.ok(
    recent.indexOf('data-board-card="task:7"') < recent.indexOf('data-board-card="task:10"'),
    "默认：#7（14:05）在 #10（09:00）之前",
  );
  assert.ok(
    oldest.indexOf('data-board-card="task:10"') < oldest.indexOf('data-board-card="task:7"'),
    "最老未动：#10 反超 #7",
  );
  assert.ok(
    oldest.indexOf('data-board-card="task:14"') < oldest.indexOf('data-board-card="task:10"'),
    "缺口置顶不受第二视角影响",
  );
});

test("列表：过滤后无行给空态文案（不静默空白）", () => {
  const markup = list({ stage: "阻塞", status: "cancelled" });
  assert.ok(!markup.includes("data-board-card="), "无行时不应渲染任何卡片");
  assert.equal(
    textInside(markup, "data-board-list-empty"),
    "没有符合当前过滤条件的节点。",
    "空结果文案逐字",
  );
});

test("列表：行保留 §13.2 要求的角标（待合并/受阻/执行角色）与 statusRule 行", () => {
  const markup = list();
  assert.ok(markup.includes("待合并（执行现场未回流）"), "待合并角标（§13.4）");
  assert.ok(markup.includes("受阻 1"), "受阻 N 角标");
  assert.ok(markup.includes("test-verifier 执行中"), "执行角色徽记");
  assert.ok(markup.includes("cancelled: 上游方案作废（取消留痕、号不复用）"), "取消原因（§13.2）");
});

/* ---------------- 视图切换（树形/看板/列表，会话内保持） ---------------- */

test("视图切换：四态控件常驻，当前视图 aria-pressed（不靠颜色表达选中）", () => {
  const switcherOf = (viewMode?: BoardViewMode) => {
    const markup = render(matrixBoard(), viewMode ? { viewMode } : {});
    const match = /data-board-view-switcher[\s\S]*?<\/div>/.exec(markup);
    assert.ok(match, "面板头部应有视图切换控件");
    return match[0];
  };
  for (const mode of ["tree", "kanban", "list", "table"] as const) {
    const switcher = switcherOf(mode);
    const options = [...switcher.matchAll(/<button[^>]*>/g)]
      .map((match) => match[0])
      .filter((tag) => tag.includes("data-board-view-option"));
    assert.deepEqual(
      options.map((tag) => attributeValue(tag, "data-board-view-option")),
      ["tree", "kanban", "list", "table"],
      "四个选项固定序（树形/看板/列表/表格，契约 §13.2 视图矩阵）",
    );
    assert.deepEqual(
      options
        .filter((tag) => attributeValue(tag, "aria-pressed") === "true")
        .map((tag) => attributeValue(tag, "data-board-view-option")),
      [mode],
      `当前视图 ${mode} 恰有一个按下态`,
    );
  }
});

test("视图切换：缺省树形（tracer 既有视图零变化），四态各渲染自己的根锚点", () => {
  const tree = render(matrixBoard());
  assert.ok(tree.includes('data-board-feature="spec:preview-channel"'), "缺省渲染树形");
  assert.ok(!tree.includes('data-board-view="kanban"'));
  assert.ok(render(matrixBoard(), { viewMode: "kanban" }).includes('data-board-view="kanban"'));
  assert.ok(render(matrixBoard(), { viewMode: "list" }).includes('data-board-view="list"'));
  assert.ok(render(matrixBoard(), { viewMode: "table" }).includes('data-board-view="table"'));
  assert.ok(
    render(matrixBoard(), { viewMode: "table" }).includes('data-board-column-header="no"'),
    "表格视图渲染自己的列头",
  );
});

test("视图切换：控件文案走词条（zh 逐字 树形/看板/列表/表格）", () => {
  const markup = render(matrixBoard(), { viewMode: "kanban" });
  const switcher = /data-board-view-switcher[\s\S]*?<\/div>/.exec(markup);
  assert.ok(switcher);
  for (const label of ["树形", "看板", "列表", "表格"]) {
    assert.ok(switcher[0].includes(`>${label}<`), `切换控件应含「${label}」`);
  }
});

test("英文界面：看板/列表的段位与控件文案走英文词条（评审 S5 的两个新面）", () => {
  const renderEnglish = (viewMode: BoardViewMode) =>
    renderToStaticMarkup(
      createElement(ZCodeIntlProvider, {
        initialLocale: "en-US" as const,
        children: createElement(BoardPaneView, { state: matrixBoard(), viewMode }),
      }),
    );
  const kanbanEn = renderEnglish("kanban");
  const expected: Record<string, string> = {
    待设计: "Design",
    待办: "To do",
    执行中: "In progress",
    审核中: "In review",
    阻塞: "Blocked",
    已完成: "Done",
    已取消: "Cancelled",
  };
  for (const [stage, label] of Object.entries(expected)) {
    assert.equal(columnHeaderText(kanbanEn, stage), label, `en-US 列头 ${stage} 应走英文词条`);
  }
  assert.ok(kanbanEn.includes("Interview summary"), "访谈汇总子区走英文词条");
  const listEn = renderEnglish("list");
  for (const label of ["Stage", "Status", "Gap", "Sort"]) {
    assert.ok(listEn.includes(`>${label}<`), `en-US 列表应含过滤标签「${label}」`);
  }
});

/* ---------------- 卡片弹窗宿主与跳转高亮（卡 #34，契约 §6） ---------------- */

test("面板：点行 → 弹窗（openCardId 命中一张卡时渲染恰好一个弹窗）", () => {
  const opened = render(matrixBoard(), { viewMode: "table", openCardId: "task:8" });
  const dialogs = [...opened.matchAll(/data-board-dialog="([^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(dialogs, ["task:8"], "同一时刻最多一个弹窗（同 id 也只渲染一处）");
  assert.ok(opened.includes("让开关立刻生效（核心）"), "弹窗渲染被点卡片自身的内容");
  assert.ok(opened.includes("停在 #8"), "弹窗带最近执行摘要（与卡片行同源）");
});

test("面板：没有打开态 / 打开态悬空（刷新后卡片消失）→ 一个弹窗都不渲染", () => {
  assert.ok(!render(matrixBoard(), { viewMode: "table" }).includes("data-board-dialog="));
  assert.ok(
    !render(matrixBoard(), { viewMode: "table", openCardId: "task:404" }).includes(
      "data-board-dialog=",
    ),
    "悬空 id 不留幽灵弹窗",
  );
});

test("面板：跳转落点高亮锚点跟着 highlightCardId 走（表格行与树形卡片行同一判据）", () => {
  const table = render(matrixBoard(), {
    viewMode: "table",
    highlightCardId: "task:8",
    onOpenCard: () => {},
  });
  assert.ok(
    /data-board-card="task:8"[^>]*data-board-card-highlight="true"/.test(table),
    "表格行带高亮锚点",
  );
  const tree = render(matrixBoard(), { highlightCardId: "task:7" });
  assert.ok(
    /data-board-task="task:7"[^>]*data-board-card-highlight="true"/.test(tree),
    "树形卡片行带高亮锚点（跳转目标可能是各视图里的卡）",
  );
  assert.ok(
    !/data-board-task="task:8"[^>]*data-board-card-highlight/.test(tree),
    "其余卡片不带高亮锚点",
  );
});

test("面板：四视图的卡片都接线打开弹窗（data 锚点仍是卡片 id）", () => {
  for (const viewMode of ["tree", "kanban", "list", "table"] as const) {
    const markup = render(matrixBoard(), { viewMode, onOpenCard: () => {} });
    assert.ok(markup.includes('data-board-card="task:8"'), `${viewMode} 渲染卡片锚点`);
  }
  const kanban = render(matrixBoard(), { viewMode: "kanban", onOpenCard: () => {} });
  assert.ok(/data-board-card="task:8"[^>]*role="button"/.test(kanban), "看板卡可点（role=button）");
  const list = render(matrixBoard(), { viewMode: "list", onOpenCard: () => {} });
  assert.ok(/data-board-card="spec:preview-channel"[^>]*role="button"/.test(list), "列表行可点");
});
