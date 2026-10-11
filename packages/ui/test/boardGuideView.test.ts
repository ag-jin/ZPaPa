import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPaneView, type BoardPaneViewProps } from "../src/board/BoardPaneView.js";
import { groupBoardFeaturesByEpic } from "../src/board/boardEpicContainers.js";
import type { BoardPaneLoadState } from "../src/board/loadBoardDocument.js";
import { parseBoardJson } from "../src/board/boardViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import {
  boardGuideSlotActivation,
  boardGuideSlotDrilldownTarget,
  BOARD_GUIDE_SLOT_KEYS,
  buildBoardGuideSummary,
} from "../src/board/boardGuideViewModel.js";
import {
  buildGuideLegacyBoard,
  buildGuideNoPlansBoard,
  buildGuideZeroBoard,
  GUIDE_BOARD,
  GUIDE_NOW,
} from "./boardGuideFixture.js";

/**
 * 指引面骨架（卡 #136 / C3-1）的结构断言。
 *
 * 期望值的独立真源：卡文验收（「打开板看到正在执行的计划与功能完成进度（计数+微条）；
 * 点计划内卡片弹详情；全零 attention 空槽有形态」）+ `board.schema.json` x-decisions 四段条
 * （成员/顺序/计数直取派生投影，UI 禁自算）+ 消费契约 §13.6（L0/L1 同源消费四段）。
 * 夹具 `boardGuideFixture.ts` 刻意让「派生投影计数 ≠ 按卡字段自算计数」——反例用例即以此为咬点。
 */

function render(state: BoardPaneLoadState, props: Partial<BoardPaneViewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(BoardPaneView, {
        state,
        onRefresh: () => {},
        viewMode: "guide",
        now: GUIDE_NOW,
        ...props,
      }),
    }),
  );
}

function readyStateOf(raw: Record<string, unknown>): BoardPaneLoadState {
  const outcome = parseBoardJson(JSON.stringify(raw));
  if (outcome.kind !== "ready") throw new Error(`夹具必须是 v2 且 features 非空：${outcome.kind}`);
  return { kind: "ready", board: outcome.board };
}

const readyState = () => readyStateOf(GUIDE_BOARD);

function slotMarkup(markup: string, slot: string): string {
  const match = new RegExp(
    `data-board-guide-slot="${slot}"[\\s\\S]*?(?=data-board-guide-slot="|data-board-guide-plans)`,
  ).exec(markup);
  assert.ok(match, `槽 ${slot} 应存在`);
  return match[0];
}

function slotValue(markup: string, slot: string): string | null {
  const match = new RegExp(
    `data-board-guide-slot="${slot}"[^>]*data-board-guide-slot-value="([^"]*)"`,
  ).exec(markup);
  return match ? (match[1] ?? null) : null;
}

/** 槽卡的开标签（属性同款断言用：交互态/样式类都在同一标签上）。 */
function slotTag(markup: string, slot: string): string {
  const match = new RegExp(`<div[^>]*data-board-guide-slot="${slot}"[^>]*>`).exec(markup);
  assert.ok(match, `槽 ${slot} 开标签应存在`);
  return match[0];
}

function planMarkup(markup: string, planId: string): string {
  const start = markup.indexOf(`data-board-guide-plan="${planId}"`);
  assert.ok(start >= 0, `计划 ${planId} 应渲染`);
  const next = markup.indexOf("data-board-guide-plan=", start + 1);
  const end = markup.indexOf("data-board-guide-plans-empty", start + 1);
  const candidates = [next, end, markup.length].filter((value) => value >= 0);
  return markup.slice(start, Math.min(...candidates));
}

/** 计划摘要行可见文本（`data-board-guide-plan-summary`：段位·期次·前沿/在途计数同排）。 */
function planSummaryText(markup: string, planId: string): string {
  const match = /data-board-guide-plan-summary="[^"]*"[^>]*>([^<]*)</.exec(
    planMarkup(markup, planId),
  );
  assert.ok(match, `计划 ${planId} 应渲染摘要行`);
  return match[1] ?? "";
}

/* ---------------- 四段派生映射（消费面：parseBoardJson） ---------------- */

test("四段派生映射：frontier/active/blocked/recent 按板序原值透出（消费不重排、不改判据）", () => {
  const outcome = parseBoardJson(JSON.stringify(GUIDE_BOARD));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  const index = outcome.board.derivedIndex;
  assert.ok(index, "四段齐备的板必须映射出派生索引");
  assert.deepEqual(
    index.frontier.map((entry) => [entry.rank, entry.no]),
    [
      [1, 210],
      [2, 220],
      [3, 221],
    ],
    "frontier 顺序与 rank 直读板字段",
  );
  assert.deepEqual(
    index.active.map((entry) => [entry.no, entry.stage]),
    [
      [213, "执行中"],
      [215, "执行中"],
      [216, "审核中"],
    ],
    "active 顺序直读板字段（不按 status 重排）",
  );
  assert.equal(index.blocked.length, 3, "blocked 一行一项（一卡两项出两行）");
  assert.deepEqual(
    index.blocked.map((entry) => [entry.blockerKind, entry.targetId]),
    [
      ["external", null],
      ["dependency", 112],
      ["dependency", 113],
    ],
  );
  assert.deepEqual(
    index.recent.map((entry) => entry.no),
    [210, 211, 213, 215, 220],
  );
  assert.equal(index.recent[2]?.stoppedAt, 213, "recent 条目字段透出（stoppedAt/next 不丢）");
  assert.equal(index.recent[2]?.next, "续跑探针");
});

test("四段缺失（旧版编译器产物）→ 派生索引为 null（视图侧不得自算兜底）", () => {
  const outcome = parseBoardJson(JSON.stringify(buildGuideLegacyBoard()));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  assert.equal(outcome.board.derivedIndex, null, "四段缺省 = 索引缺失，不是空段");
});

/* ---------------- 置顶五槽条 ---------------- */

test("五槽条：计数直取派生投影与板字段（需处理=attentionSummary 合计、阻塞=blocked 行数、运行/待收口=active 段位、最近活动=recent 条数）", () => {
  const markup = render(readyState());
  assert.ok(markup.includes('data-board-view="guide"'), "guide 视图根锚点");
  assert.ok(markup.includes("data-board-guide-slots"), "五槽条容器");
  assert.equal(slotValue(markup, "attention"), "4", "需处理 = 2+0+1+1");
  assert.equal(slotValue(markup, "blocked"), "3", "阻塞 = blocked[] 行数（一卡两项出两行）");
  assert.equal(slotValue(markup, "running"), "2", "运行 = active 段位=执行中");
  assert.equal(slotValue(markup, "review"), "1", "待收口 = active 段位=审核中");
  assert.equal(slotValue(markup, "recent"), "5", "最近活动 = recent[] 条数");
  for (const label of ["需处理", "阻塞", "运行", "待收口", "最近活动"]) {
    assert.ok(slotMarkup(markup, slotName(label)).includes(label), `槽标签逐字：${label}`);
  }
});

const slotName = (label: string): string =>
  ({ 需处理: "attention", 阻塞: "blocked", 运行: "running", 待收口: "review", 最近活动: "recent" })[
    label
  ] ?? label;

test("反例（禁自算）：槽计数与自算口径不一致时，渲染必须跟派生投影走", () => {
  const markup = render(readyState());
  // 节点 attention 码合计 2、挂 blockers 的卡 2 张、status=active 的卡 1 张——
  // 任何按卡字段自算的实现会得到 2/2/1，这里逐一断言与派生投影一致。
  assert.equal(slotValue(markup, "attention"), "4");
  assert.equal(slotValue(markup, "blocked"), "3");
  assert.equal(slotValue(markup, "running"), "2");
});

test("零 attention：五槽仍显示，空槽有明确形态（0 + 空槽文案）", () => {
  const markup = render(readyStateOf(buildGuideZeroBoard()));
  assert.ok(markup.includes("data-board-guide-slots"), "零 signal 也不隐藏五槽条");
  for (const slot of ["attention", "blocked", "running", "review", "recent"]) {
    assert.equal(slotValue(markup, slot), "0", `${slot} 槽显式 0`);
    assert.ok(
      new RegExp(`data-board-guide-slot="${slot}"[^>]*data-board-guide-zero="true"`).test(markup),
      `${slot} 空槽形态标记`,
    );
  }
  assert.ok(markup.includes("无待处理"), "空槽给出可读文案，不留空壳");
  assert.ok(markup.includes("无最近活动"));
});

test("旧板（缺四段）：不自行推算——槽值未知 + 指名重编译提示", () => {
  const markup = render(readyStateOf(buildGuideLegacyBoard()));
  assert.ok(markup.includes("data-board-guide-index-state"), "索引状态锚点");
  assert.ok(markup.includes("data-board-guide-recompile"), "指名重编译提示");
  for (const slot of ["attention", "blocked", "running", "review", "recent"]) {
    assert.equal(slotValue(markup, slot), "—", `${slot} 槽不得显示自算计数`);
  }
});

/* ---------------- 主体「正在执行的计划」区块 ---------------- */

test("计划区块：活跃计划置顶、计划按板序；已取消计划与 spec 特性不入区块", () => {
  const markup = render(readyState());
  assert.ok(markup.includes("data-board-guide-plans"), "计划区块容器");
  assert.ok(markup.includes("正在执行的计划"), "区块标题");
  const planA = markup.indexOf('data-board-guide-plan="plan:plan-guide-a"');
  const planB = markup.indexOf('data-board-guide-plan="plan:plan-guide-b"');
  const planD = markup.indexOf('data-board-guide-plan="plan:plan-guide-d"');
  assert.ok(planA >= 0 && planB >= 0 && planD >= 0, "三张在册计划都渲染");
  assert.ok(planA < planB && planB < planD, "活跃计划置顶：A(active) → B → D 保板序");
  assert.ok(!markup.includes("plan:plan-guide-c"), "已取消计划不入区块");
  assert.ok(!markup.includes("spec:guide-spec"), "spec 特性不入计划区块");
});

test("活跃计划置顶：板序靠后的 active 计划提到 pending 计划之前（status 判据，非段位自算）", () => {
  const mutated = structuredClone(GUIDE_BOARD);
  const features = mutated.features as Array<Record<string, unknown>>;
  const planD = features.find((feature) => feature.id === "plan:plan-guide-d");
  assert.ok(planD, "夹具里应有计划 D");
  planD.status = "active";
  const markup = render(readyStateOf(mutated));
  const planA = markup.indexOf('data-board-guide-plan="plan:plan-guide-a"');
  const planDIndex = markup.indexOf('data-board-guide-plan="plan:plan-guide-d"');
  const planB = markup.indexOf('data-board-guide-plan="plan:plan-guide-b"');
  assert.ok(planA < planDIndex && planDIndex < planB, "A、D（active，板序）→ B（pending）");
});

test("活跃计划辨识：头行带共享状态点（板字段 status=active），非活跃计划不带", () => {
  const markup = render(readyState());
  const planA = planMarkup(markup, "plan:plan-guide-a");
  const dotIndex = planA.indexOf('data-board-status="active"');
  assert.ok(dotIndex >= 0, "active 计划头行带共享状态点（BoardStatusDot 锚点）");
  const barIndex = planA.indexOf("data-board-guide-plan-bar");
  assert.ok(barIndex > 0 && dotIndex < barIndex, "状态点落在头行（进度微条之前）");
  const planB = planMarkup(markup, "plan:plan-guide-b");
  assert.ok(!planB.includes("data-board-status"), "非活跃计划头行不带状态点（不新造装饰）");
});

test("计划进度：计数 = 该计划卡 completed/total（板字段），配进度微条", () => {
  const markup = render(readyState());
  const planA = planMarkup(markup, "plan:plan-guide-a");
  assert.ok(planA.includes('data-board-guide-plan-progress="2/4"'), `计划 A 计数 2/4：${planA}`);
  assert.ok(planA.includes("data-board-guide-plan-bar"), "计划 A 有进度微条");
  assert.ok(/data-board-guide-plan-bar-value="2\/4"/.test(planA), "微条数值钉住同一计数");
  const planB = planMarkup(markup, "plan:plan-guide-b");
  assert.ok(planB.includes('data-board-guide-plan-progress="0/3"'), "计划 B 0/3");
  const planD = planMarkup(markup, "plan:plan-guide-d");
  assert.ok(planD.includes("data-board-guide-plan-progress"), "零卡计划也带进度锚点");
  assert.ok(planD.includes("未拆解"), "零卡计划显示未拆解，不留空白");
});

test("计划摘要行：段位 + 期次合成名 + 前沿/在途计数（四段投影计数）", () => {
  const markup = render(readyState());
  const planA = planMarkup(markup, "plan:plan-guide-a");
  assert.ok(planA.includes("data-board-guide-plan-summary"), "摘要行锚点");
  assert.ok(planA.includes("执行中"), "摘要行带段位文本");
  assert.ok(planA.includes("KANB1"), "期次合成名走 A4 单点（KANB+1）");
  const planB = planMarkup(markup, "plan:plan-guide-b");
  assert.ok(planB.includes("KANB2"), "计划 B 期次 2 合成名");
});

test("可执行前沿队列（#138）：计划区块的队列行 = 该计划 frontier 成员（frontier 序直读），在途/受阻行不入队列", () => {
  const markup = render(readyState());
  const planA = planMarkup(markup, "plan:plan-guide-a");
  assert.ok(planA.includes("data-board-guide-plan-queue"), "队列容器锚点（完整前沿队列）");
  assert.ok(planA.includes('data-board-card="task:210"'), "计划 A 的可执行卡行（#210）");
  assert.ok(
    !planA.includes('data-board-card="task:213"'),
    "在途卡（#213）不占队列行（队列=可执行卡）",
  );
  assert.ok(planA.includes("置顶五槽条"), "行内带标题");
  const planB = planMarkup(markup, "plan:plan-guide-b");
  const rowIds = [...planB.matchAll(/data-board-card="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(
    rowIds,
    ["task:220", "task:221"],
    "计划 B 队列 = frontier 序 220→221（全量直读）",
  );
  assert.ok(
    !planB.includes('data-board-card="task:217"'),
    "受阻卡（#217 未解除阻塞）不入可执行队列",
  );
});

test("卡片点击落点：计划内卡行带开弹窗 props（role=button + tabindex；真点击路由断言在浏览器脚本）", () => {
  const opened: string[] = [];
  const markup = render(readyState(), { onOpenCard: (id) => opened.push(id) });
  const cardRow = /data-board-card="task:210"[^>]*/.exec(markup);
  assert.ok(cardRow, "卡行锚点存在");
  assert.ok(cardRow[0].includes('role="button"'), "落点声明 button 角色");
  assert.ok(cardRow[0].includes('tabindex="0"'), "落点可键盘聚焦");
});

/* ---------------- 视图切换入口与词条 ---------------- */

test("视图切换：新增「指引」入口（guide 为可选项，四结构视图保留）", () => {
  const markup = render(readyState());
  const switcher = /data-board-view-switcher[\s\S]*?<\/div>/.exec(markup);
  assert.ok(switcher, "视图切换控件存在");
  assert.ok(switcher[0].includes('data-board-view-option="guide"'), "指引入口在位");
  for (const mode of ["tree", "kanban", "list", "table"]) {
    assert.ok(switcher[0].includes(`data-board-view-option="${mode}"`), `${mode} 视图入口保留`);
  }
});

test("英文界面：五槽与计划区块文案全走 en-US 词条（不漏中文）", () => {
  const markup = renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "en-US" as const,
      children: createElement(BoardPaneView, {
        state: readyState(),
        onRefresh: () => {},
        viewMode: "guide",
        now: GUIDE_NOW,
      }),
    }),
  );
  for (const label of ["Needs attention", "Blocked", "Running", "To close", "Recent activity"]) {
    assert.ok(markup.includes(label), `英文槽标签：${label}`);
  }
  assert.ok(markup.includes("Plans in progress"), "英文区块标题");
  assert.ok(!markup.includes("正在执行的计划"), "英文界面不得漏中文标题");
  // 登记项②（#137 四绿转来，一行兜底）：en-US 槽标签与短解释在窄槽内会截断——原生 title 兜底完整文案。
  assert.ok(
    /data-board-guide-slot="attention"[\s\S]*?<span title="Needs attention"[^>]*>Needs attention<\/span>/.test(
      markup,
    ),
    "en-US 槽标签带原生 title 兜底（截断不丢完整文案）",
  );
  assert.ok(
    /data-board-guide-slot="attention"[\s\S]*?<span title="Items awaiting action"[^>]*>Items awaiting action<\/span>/.test(
      markup,
    ),
    "en-US 槽短解释 span 带原生 title 兜底（登记项②完整落地：标签/短解释两半同防线）",
  );
});

/* ---------------- 突变/空态咬点（计数跟随板字段，不跟标签） ---------------- */

test("突变：计划进度计数跟随板字段——卡 status 变 completed，计数与微条数值同步变", () => {
  const mutated = structuredClone(GUIDE_BOARD);
  const feature = (mutated.features as Array<Record<string, unknown>>)[0];
  const tasks = feature?.tasks as Array<Record<string, unknown>>;
  const target = tasks.find((task) => task.no === 210);
  assert.ok(target, "夹具里应有卡 #210");
  target.status = "completed";
  target.stage = "已完成";
  const markup = render(readyStateOf(mutated));
  const planA = planMarkup(markup, "plan:plan-guide-a");
  assert.ok(planA.includes('data-board-guide-plan-progress="3/4"'), `突变后计数 3/4：${planA}`);
  assert.ok(/data-board-guide-plan-bar-value="3\/4"/.test(planA), "微条数值同步突变");
});

test("突变：槽计数跟随派生投影——blocked 段少一行，阻塞槽随段变化（禁自算）", () => {
  const mutated = structuredClone(GUIDE_BOARD);
  (mutated.blocked as unknown[]).pop();
  const markup = render(readyStateOf(mutated));
  assert.equal(slotValue(markup, "blocked"), "2", "阻塞槽 = blocked[] 行数（突变后 2）");
});

test("空态：无计划特性 → 计划区块给明确空态（spec-only 项目不落空白）", () => {
  const markup = render(readyStateOf(buildGuideNoPlansBoard()));
  assert.ok(markup.includes("正在执行的计划"), "区块标题仍在");
  assert.ok(markup.includes("data-board-guide-plans-empty"), "空态锚点");
  assert.ok(markup.includes("暂无执行中的计划"), "空态文案");
  assert.ok(!markup.includes("data-board-guide-plan="), "空态时不得渲染计划块");
});

test("完整队列不再上限裁剪（#138）：计划内前沿行超过旧上限 3 时全量展示，无「还有 N 项」占位", () => {
  const mutated = structuredClone(GUIDE_BOARD);
  const feature = (mutated.features as Array<Record<string, unknown>>)[0];
  const tasks = feature?.tasks as Array<Record<string, unknown>>;
  // 追加第 5、6、7 张卡并让它们进前沿（旧上限 3 → 旧行为裁掉第 4 行 + 「还有 N 项」占位）。
  tasks.push(
    { no: 230, label: "1.5", title: "追加卡一", status: "pending", stage: "待办" },
    { no: 231, label: "1.6", title: "追加卡二", status: "pending", stage: "待办" },
    { no: 232, label: "1.7", title: "追加卡三", status: "pending", stage: "待办" },
  );
  (mutated.frontier as Array<Record<string, unknown>>).push(
    {
      rank: 4,
      no: 230,
      title: "追加卡一",
      stage: "待办",
      nextAssignee: "implementer",
      resolvedDeps: [],
    },
    {
      rank: 5,
      no: 231,
      title: "追加卡二",
      stage: "待办",
      nextAssignee: "implementer",
      resolvedDeps: [],
    },
    {
      rank: 6,
      no: 232,
      title: "追加卡三",
      stage: "待办",
      nextAssignee: "implementer",
      resolvedDeps: [],
    },
  );
  const markup = render(readyStateOf(mutated));
  const planA = planMarkup(markup, "plan:plan-guide-a");
  const rowIds = [...planA.matchAll(/data-board-card="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(
    rowIds,
    ["task:210", "task:230", "task:231", "task:232"],
    "4 行全量展示（frontier 序；旧实现只给前 3 行）",
  );
  assert.ok(
    !planA.includes("data-board-guide-plan-more"),
    "「还有 N 项」占位随完整队列退场（不再有被裁剪的行）",
  );
});

/* ---------------- C3-4（#139）：计划级进度胶囊 + 期次/功能级摘要行胶囊 ---------------- */

test("计划进度胶囊（#139）：已完成/总卡旁给百分比可读文本（与微条同口径；E7 §4.2 条旁必有数字）", () => {
  const markup = render(readyState());
  const planA = planMarkup(markup, "plan:plan-guide-a");
  assert.ok(/data-board-guide-plan-percent="50"/.test(planA), `计划 A 2/4 → 50%：${planA}`);
  assert.ok(planA.includes("50%"), "百分比是可见文本，不只靠条长表达");
  const planB = planMarkup(markup, "plan:plan-guide-b");
  assert.ok(/data-board-guide-plan-percent="0"/.test(planB), "计划 B 0/3 → 0%（显式，不留空壳）");
  assert.ok(planB.includes("0%"));
  const planD = planMarkup(markup, "plan:plan-guide-d");
  assert.ok(
    !/data-board-guide-plan-percent/.test(planD),
    "未拆解（0/0）不给百分比——不制造未知（E7 §4.2 未拆解形态）",
  );
  assert.ok(planD.includes("未拆解"), "未拆解文案仍在");
});

test("微条轨道（F1-139 微回炉）：轨道背景类覆写为四主题已定义 token（bg-border 在场，惰性 bg-muted 不回退）", () => {
  const markup = render(readyState());
  const planA = planMarkup(markup, "plan:plan-guide-a");
  const anchor = planA.indexOf("data-board-guide-plan-bar");
  assert.ok(anchor >= 0, "微条锚点存在");
  const tag = planA.slice(planA.lastIndexOf("<", anchor), planA.indexOf(">", anchor) + 1);
  const classAttr = /class="([^"]*)"/.exec(tag);
  const classText = classAttr?.[1] ?? "";
  assert.ok(classText, `微条带 class：${tag}`);
  // F1-139：`--color-muted` 全仓四主题块/默认主题/基座均无定义（progress 基件 bg-muted 为惰性类）——
  // 回退成 bg-muted 会让四主题轨道透明、比例通道丢失；bg-border 四主题已定义（10% 墨轨道）。
  // SSR 面上类名是轨道 token 的唯一可观测通道，故按「已定义 token 类在场 + 惰性类被覆写」钉住。
  assert.ok(
    classText.includes("bg-border"),
    `轨道背景类应为四主题已定义 token（bg-border）：${classText}`,
  );
  assert.ok(
    !/(^|\s)bg-muted(\s|$)/.test(classText),
    `惰性类 bg-muted 必须被 tailwind-merge 覆写移除：${classText}`,
  );
});

test("期次/功能级摘要行胶囊（#139）：计划卡数胶囊与 A4 组头 [N 张卡] 同源同值（countBoardFeatureTasks 单点）", () => {
  const guide = render(readyState());
  const planA = planMarkup(guide, "plan:plan-guide-a");
  assert.ok(
    /data-board-guide-plan-card-count="4"/.test(planA),
    `计划 A 规模胶囊 = 夹具全部成员卡 4 张：${planA}`,
  );
  assert.ok(planA.includes("4 张卡"), "规模文案走 A4 组头同一词条（{count} 张卡）");
  // 「与组头计数一致」对账：同一板同一单点，指引面胶囊与结构视图组头必须同值（4 张卡）。
  const kanban = render(readyState(), { viewMode: "kanban" });
  assert.ok(kanban.includes('data-board-feature-card-count="4"'), "看板组头 [N 张卡] 锚点");
  assert.ok(kanban.includes("4 张卡"), "组头计数同文案（两处同一词条）");
  // 反例（禁自算）：计划 A 的四段成员只有 2 张（frontier #210 + active #213）——
  // 规模胶囊必须是全部成员卡（4）；按四段成员数自算会得 2，必咬。
  const planB = planMarkup(guide, "plan:plan-guide-b");
  assert.ok(/data-board-guide-plan-card-count="3"/.test(planB), "计划 B 3 张卡（含在途/受阻卡）");
});

test("突变：卡数胶囊跟随板字段（含嵌套子卡）——与组头同步变，不跟标签/四段成员", () => {
  const mutated = structuredClone(GUIDE_BOARD);
  const feature = (mutated.features as Array<Record<string, unknown>>)[0];
  const tasks = feature?.tasks as Array<Record<string, unknown>>;
  const target = tasks.find((task) => task.no === 210);
  assert.ok(target, "夹具里应有卡 #210");
  target.tasks = [{ label: "1.1.1", title: "嵌套子卡", status: "pending", stage: "待办" }];
  const guide = render(readyStateOf(mutated));
  const planA = planMarkup(guide, "plan:plan-guide-a");
  assert.ok(
    /data-board-guide-plan-card-count="5"/.test(planA),
    `嵌套子卡计入总卡数（4+1）：${planA}`,
  );
  const kanban = render(readyStateOf(mutated), { viewMode: "kanban" });
  assert.ok(kanban.includes('data-board-feature-card-count="5"'), "组头计数同变（同一单点）");
});

test("rollup 缺口徽章（#139）：计数 = 计划成员卡 attention 码条数之和（A4 单点 boardLayerGapCount；零缺口不渲染）", () => {
  const base = render(readyState());
  const basePlanA = planMarkup(base, "plan:plan-guide-a");
  assert.ok(
    !basePlanA.includes("data-board-guide-plan-gap-count"),
    "全无缺口 → 不落徽章（日常零噪声，与 A4 层头同判据）",
  );
  const mutated = structuredClone(GUIDE_BOARD);
  const feature = (mutated.features as Array<Record<string, unknown>>)[0];
  assert.ok(feature, "夹具里应有计划 A");
  const tasks = feature.tasks as Array<Record<string, unknown>>;
  const card211 = tasks.find((task) => task.no === 211);
  const card210 = tasks.find((task) => task.no === 210);
  assert.ok(card211 && card210, "夹具里应有卡 #211/#210");
  card211.attention = ["interrupted-resume"];
  // 嵌套子卡也计入 rollup（成员 = 计划全部卡，含子卡）。
  card210.tasks = [
    {
      label: "1.1.1",
      title: "子卡",
      status: "pending",
      stage: "待办",
      attention: ["unmerged-worktree", "interrupted-resume"],
    },
  ];
  const markup = render(readyStateOf(mutated));
  const planA = planMarkup(markup, "plan:plan-guide-a");
  assert.ok(/data-board-guide-plan-gap-count="3"/.test(planA), `缺口 = 1+2 = 3：${planA}`);
  assert.ok(planA.includes("缺口 3"), "缺口文案走 A4 层头同一词条（缺口 {count}）");
  const planB = planMarkup(markup, "plan:plan-guide-b");
  assert.ok(!planB.includes("data-board-guide-plan-gap-count"), "计划 B 无缺口，不串台");
});

/* ---------------- C3-2（#137）：槽下钻路由 + 槽激活判据 ---------------- */

test("五槽可点（#137）：槽卡是看板既有交互形态（role=button + tabindex，hover/focus 复用既有 token），初始无空态指引", () => {
  const markup = render(readyState(), { onDrillToSlot: () => {} });
  for (const key of BOARD_GUIDE_SLOT_KEYS) {
    const tag = slotTag(markup, key);
    assert.ok(
      tag.includes('role="button"'),
      `${key} 槽声明 button 角色（:focus-visible 规则同款覆盖）`,
    );
    assert.ok(tag.includes('tabindex="0"'), `${key} 槽可键盘聚焦`);
    assert.ok(tag.includes("cursor-pointer"), `${key} 槽有可点光标`);
    assert.ok(
      tag.includes("hover:bg-surface-hover"),
      `${key} 槽 hover 复用看板既有交互 token（不新造配色/大面积色块）：${tag}`,
    );
  }
  assert.ok(
    !markup.includes("data-board-guide-slot-empty"),
    "初始不渲染空态指引（点零槽才出——不占版面）",
  );
});

test("槽不可点边界（#137）：缺下钻派发（只读渲染）时槽不落 button 角色；旧板（缺四段）槽不落死跳转", () => {
  const readOnly = render(readyState());
  for (const key of BOARD_GUIDE_SLOT_KEYS) {
    assert.ok(
      !slotTag(readOnly, key).includes('role="button"'),
      `${key} 槽缺宿主派发时应为只读（与卡行「缺 onOpenCard 不可点」同款）`,
    );
  }
  // 旧板：槽值未知（null，§13.6 缺四段）——重编译提示已点名，槽不上可点态（不拿未知当集合）。
  const legacy = render(readyStateOf(buildGuideLegacyBoard()), { onDrillToSlot: () => {} });
  for (const key of BOARD_GUIDE_SLOT_KEYS) {
    assert.ok(
      !slotTag(legacy, key).includes('role="button"'),
      `${key} 槽在缺四段板上不上可点态（不猜落点）`,
    );
  }
});

test("槽下钻路由（#137）：五槽落到既有视图/过滤——派发目标唯一、互不相同（禁第二路由）", () => {
  // 期望值 = 派发落点口径（需处理→看板列 / 阻塞→受阻清单形态 / 运行·待收口→对应列表态 /
  // 最近活动→最近视图），独立于实现逐槽抄写；controls 是既有 BoardListControls 的显式取值。
  const expected: Record<
    string,
    { viewMode: string; controls?: { stage: string | null; sort: string } }
  > = {
    attention: { viewMode: "kanban" },
    blocked: { viewMode: "table", controls: { stage: null, sort: "recent" } },
    running: { viewMode: "list", controls: { stage: "执行中", sort: "recent" } },
    review: { viewMode: "list", controls: { stage: "审核中", sort: "recent" } },
    recent: { viewMode: "list", controls: { stage: null, sort: "recent" } },
  };
  for (const key of BOARD_GUIDE_SLOT_KEYS) {
    const target = boardGuideSlotDrilldownTarget(key);
    const want = expected[key];
    assert.ok(want, `槽 ${key} 必须给落点（闭集穷尽）`);
    assert.equal(target.mode, want.viewMode, `槽 ${key} 的落点视图`);
    if (want.controls) {
      assert.ok(
        target.controls,
        `槽 ${key} 应给列表/表格目标的显式控制（确定性落点，不吃上一次筛子）`,
      );
      assert.equal(target.controls.stage, want.controls.stage, `槽 ${key} 的段位筛`);
      assert.equal(target.controls.sort, want.controls.sort, `槽 ${key} 的排序视角`);
      assert.equal(target.controls.status, null, "下钻不给状态筛（只看槽对应集合）");
      assert.equal(target.controls.attention, null, "下钻不给缺口码筛（只看槽对应集合）");
      assert.equal(target.controls.kind, null, "下钻不给类型筛（只看槽对应集合）");
    }
  }
  // 每槽落点互不相同：浏览器断言要能逐槽分辨「跳到了哪个对应视图/过滤」。
  const seen = new Set(
    BOARD_GUIDE_SLOT_KEYS.map((key) => JSON.stringify(boardGuideSlotDrilldownTarget(key))),
  );
  assert.equal(seen.size, BOARD_GUIDE_SLOT_KEYS.length, "五槽落点必须两两不同（否则点击不可分辨）");
  // 拷贝语义：落点表是共享常量，调用方改写返回值不得污染下一处消费（宿主会把 controls 交给 setState）。
  const first = boardGuideSlotDrilldownTarget("running");
  if (first.controls) first.controls.stage = "已完成";
  assert.equal(
    boardGuideSlotDrilldownTarget("running").controls?.stage,
    "执行中",
    "落点对象为拷贝（共享表不被调用方改写）",
  );
});

test("槽激活判据（#137）：计数 >0 才下钻；0 = 空态指引；缺四段（null）= 不跳（重编译提示已点名）", () => {
  // 期望值 = 卡文验收「零 attention 槽点击有明确空态指引（不落死跳转）」+ §13.6 缺四段不猜口径。
  assert.equal(boardGuideSlotActivation({ key: "attention", count: 4 }), "drill");
  assert.equal(boardGuideSlotActivation({ key: "blocked", count: 0 }), "empty");
  assert.equal(boardGuideSlotActivation({ key: "recent", count: 0 }), "empty");
  assert.equal(boardGuideSlotActivation({ key: "running", count: 1 }), "drill");
  assert.equal(boardGuideSlotActivation({ key: "review", count: null }), "none");
  assert.equal(boardGuideSlotActivation({ key: "attention", count: null }), "none");
});

test("反例（槽计数与板一致必咬）：派生段为零、节点自带 attention 码/blockers 时，激活仍按派生走", () => {
  // 夹具节点仍带 attention 码与 blockers，但 buildGuideZeroBoard 把四段与 attentionSummary 清零——
  // 任何「按节点字段自算」的实现会把需处理算成 2/阻塞算成 2 并下钻；判据必须跟板字段（派生）。
  const outcome = parseBoardJson(JSON.stringify(buildGuideZeroBoard()));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  const summary = buildBoardGuideSummary(outcome.board);
  for (const slot of summary.slots) {
    assert.equal(slot.count, 0, `${slot.key} 槽计数必须跟派生（0）`);
    assert.equal(
      boardGuideSlotActivation(slot),
      "empty",
      `${slot.key} 自算口径会得非零 → 必咬（应走空态指引，不下钻）`,
    );
  }
});

test("反例（缺口口径必咬）：不数计划自身 attention 码、也不漏嵌套子卡——只有成员卡全量求和得真值", () => {
  const mutated = structuredClone(GUIDE_BOARD);
  const feature = (mutated.features as Array<Record<string, unknown>>)[0];
  assert.ok(feature, "夹具里应有计划 A");
  // 计划自身缺口码（feature.attention）是「自身信号」不是 rollup——若被计数会得 1。
  feature.attention = ["interviewed-not-arranged"];
  const tasks = feature.tasks as Array<Record<string, unknown>>;
  const card213 = tasks.find((task) => task.no === 213);
  const card210 = tasks.find((task) => task.no === 210);
  assert.ok(card213 && card210, "夹具里应有卡 #213/#210");
  card213.attention = ["unmerged-worktree"];
  card210.tasks = [
    {
      label: "1.1.1",
      title: "子卡",
      status: "pending",
      stage: "待办",
      attention: ["interrupted-resume", "arranged-not-expanded"],
    },
  ];
  const markup = render(readyStateOf(mutated));
  const planA = planMarkup(markup, "plan:plan-guide-a");
  // 真值 = 成员卡全量求和：顶层 #213 的 1 条 + 嵌套子卡 2 条 = 3
  // （自算自身码会得 1；只数顶层会得 1；两者都被此断言咬住）。
  assert.ok(/data-board-guide-plan-gap-count="3"/.test(planA), `缺口真值 = 3：${planA}`);
});

/* ---------------- C3-3（#138）：可执行前沿队列（按计划分组） ---------------- */

/** 版上取计划投影（独立真源 = 夹具板字段；不经渲染面）。 */
function planProjection(board: Record<string, unknown>, planId: string) {
  const outcome = parseBoardJson(JSON.stringify(board));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") throw new Error("夹具必须 ready");
  const plan = buildBoardGuideSummary(outcome.board).plans.find(
    (entry) => entry.featureId === planId,
  );
  assert.ok(plan, `计划 ${planId} 应存在`);
  return plan;
}

test("完整前沿队列（#138）：计划区块的队列 = 该计划 frontier 成员全量——frontier 序直读、不含在途/受阻行、不再上限裁剪", () => {
  // 期望值的独立真源：夹具 frontier[]（rank 1..3 = 210/220/221）+ 各计划卡号集。
  const planA = planProjection(GUIDE_BOARD, "plan:plan-guide-a");
  assert.deepEqual(
    planA.queue.map((row) => [row.no, row.title, row.stage, row.nextAssignee, row.resolvedDeps]),
    [[210, "置顶五槽条", "待办", "implementer", []]],
    "计划 A 队列 = frontier 成员 #210（含处置指引接手位与已解除依赖）",
  );
  const planB = planProjection(GUIDE_BOARD, "plan:plan-guide-b");
  assert.deepEqual(
    planB.queue.map((row) => [row.no, row.resolvedDeps]),
    [
      [220, []],
      [221, [210]],
    ],
    "计划 B 队列 = frontier 序 220→221（221 的已解除依赖 210 直读）",
  );
  assert.ok(
    !planA.queue.some((row) => row.no === 213),
    "在途卡（active 段 #213）不占可执行队列行（队列 = 该计划可执行卡）",
  );
  assert.ok(
    !planB.queue.some((row) => row.no === 217),
    "受阻卡（#217 有未解除 external 阻塞）不入可执行队列",
  );
  const seen = new Set([...planA.queue, ...planB.queue].map((row) => row.no));
  assert.equal(seen.size, 3, "三条 frontier 各归其计划，不串台");
});

test("队列分组序（#138）：计划区块排序复用 A4 单点比较器（纯期次序）——期次升序、无期次殿后、不再保板序", () => {
  // 反例咬点：板序 A→B→D 与期次序相反（A 改性期 3、B 改性期 1，且 A 未活跃）——
  // 「只保板序」的旧实现会得 A→B→D；纯期次序必须得 B→A→D。
  const mutated = structuredClone(GUIDE_BOARD);
  const features = mutated.features as Array<Record<string, unknown>>;
  const planA = features.find((feature) => feature.id === "plan:plan-guide-a");
  const planB = features.find((feature) => feature.id === "plan:plan-guide-b");
  assert.ok(planA && planB, "夹具里应有计划 A/B");
  planA.status = "pending";
  planA.stage = "待办";
  planA.phase = 3;
  planB.phase = 1;
  const markup = render(readyStateOf(mutated));
  const indexOfPlan = (id: string) => markup.indexOf(`data-board-guide-plan="${id}"`);
  assert.ok(
    indexOfPlan("plan:plan-guide-b") < indexOfPlan("plan:plan-guide-a") &&
      indexOfPlan("plan:plan-guide-a") < indexOfPlan("plan:plan-guide-d"),
    "期次 1（B）→ 期次 3（A）→ 无期次（D）：纯期次序、无期次殿后（板序被改判）",
  );
  // 同源对账（禁二份实现）：指引面计划序 = A4 归组单点的期次序列（同一比较器判据）。
  const outcome = parseBoardJson(JSON.stringify(mutated));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  const a4PhasedPlanIds = groupBoardFeaturesByEpic(outcome.board).epics.flatMap((group) =>
    group.phases.flatMap((phase) => phase.features.map((feature) => feature.id)),
  );
  assert.deepEqual(
    a4PhasedPlanIds,
    ["plan:plan-guide-b", "plan:plan-guide-a"],
    "A4 单点期次序列（期 1 → 期 3）",
  );
  const guidePhasedPlanIds = buildBoardGuideSummary(outcome.board)
    .plans.filter((plan) => plan.phase !== null)
    .map((plan) => plan.featureId);
  assert.deepEqual(guidePhasedPlanIds, a4PhasedPlanIds, "指引面计划序 = A4 单点期次序列");
});

test("禁二份实现（#138 源码守卫）：指引面期次序比较只走 A4 单点导入，无内联期次算术", () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(
    join(testDir, "..", "src", "board", "boardGuideViewModel.ts"),
    "utf8",
  );
  assert.match(
    source,
    /import\s*\{[^}]*\bcompareBoardPhaseOrder\b[^}]*\}\s*from\s*"\.\/boardEpicContainers\.js"/,
    "期次序比较必须从 A4 归属模块导入单点比较器（而非注释里提一句）",
  );
  assert.ok(!/\.phase\s*[-+<>]/.test(source), "不得内联期次数值比较（第二份期次判据）");
});

/** 队列单行片段（`data-board-card` 锚点到下一个同行/结尾；行内断言用）。 */
function queueRowMarkup(planMarkupText: string, cardId: string): string {
  const start = planMarkupText.indexOf(`data-board-card="${cardId}"`);
  assert.ok(start >= 0, `队列行 ${cardId} 应渲染`);
  const tagStart = planMarkupText.lastIndexOf("<", start);
  const next = planMarkupText.indexOf("data-board-card=", start + 1);
  return planMarkupText.slice(tagStart, next >= 0 ? next : planMarkupText.length);
}

test("队列行处置指引（#138）：行含「下一步」接手位 + 已解除依赖计数（直读 frontier 条目字段）", () => {
  const markup = render(readyState());
  const planB = planMarkup(markup, "plan:plan-guide-b");
  const row220 = queueRowMarkup(planB, "task:220");
  assert.ok(row220.includes("data-board-guide-queue-row"), "队列行锚点");
  assert.ok(
    row220.includes('data-board-guide-queue-next="implementer"'),
    "处置指引锚点 = 接手位原值",
  );
  assert.ok(row220.includes("下一步：implementer"), "处置指引可读文案（接手位）");
  assert.ok(
    !row220.includes("data-board-guide-queue-deps"),
    "无已解除依赖 → 不落依赖计数片（零噪声）",
  );
  const row221 = queueRowMarkup(planB, "task:221");
  assert.ok(/data-board-guide-queue-deps="1"/.test(row221), "依赖计数片 = resolvedDeps 条数（1）");
  assert.ok(row221.includes("依赖已解除 1"), "依赖计数可读文案");
  assert.ok(row221.includes('title="#210"'), "计数片 title 带依赖号明细（信息不丢）");
  // 密度准入（itw-20261011-9003）：frontier 卡段位恒「待办」——段位徽章不再占行内信息组。
  assert.ok(!row220.includes("data-board-stage"), "队列行不落段位徽章（段位/处置 一档，处置优先）");
  // 行文字 ≥ text-sm（14px 档）：处置指引是行内主文字之一。
  const nextSpan = /data-board-guide-queue-next="implementer"[^>]*class="([^"]*)"/.exec(row221);
  assert.ok(nextSpan, "处置指引元素带 class");
  assert.ok(nextSpan[1]?.includes("text-ui-base"), `处置指引字号 ≥14px：${nextSpan[1]}`);
});

/** en-US 渲染（S1 计数词条单/复数回修：裸复数只在英文侧可观测）。 */
function renderEn(state: BoardPaneLoadState): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "en-US" as const,
      children: createElement(BoardPaneView, {
        state,
        onRefresh: () => {},
        viewMode: "guide",
        now: GUIDE_NOW,
      }),
    }),
  );
}

test("计数词条单/复数（#138 S1 微回炉 · 契约 §13.5）：en-US 队列依赖计数 count=1 走单数键，不再「1 deps resolved」", () => {
  // 期望值的独立真源：契约 §13.5「计数词条按单/复数两键（count===1 走单数）」——en 侧
  // 「1 deps resolved」正是 #90 成文要消灭的裸复数形态；可见文案应逐字为「1 dep resolved」。
  const row221 = queueRowMarkup(
    planMarkup(renderEn(readyState()), "plan:plan-guide-b"),
    "task:221",
  );
  assert.ok(/>1 dep resolved</.test(row221), `count=1 渲染单数键可见文案（不得裸复数）：${row221}`);
  assert.ok(!row221.includes("1 deps resolved"), "「1 deps resolved」= #90 要消灭的裸复数形态");
  // other 侧：count=2 走复数键（两键都喂单点 formatBoardCountText；只有 count===1 走 one）。
  const mutated = structuredClone(GUIDE_BOARD);
  const entries = mutated.frontier as Array<Record<string, unknown>>;
  const entry221 = entries.find((entry) => entry.no === 221);
  assert.ok(entry221, "夹具里应有 frontier #221");
  entry221.resolvedDeps = [210, 211];
  const pluralRow = queueRowMarkup(
    planMarkup(renderEn(readyStateOf(mutated)), "plan:plan-guide-b"),
    "task:221",
  );
  assert.ok(/>2 deps resolved</.test(pluralRow), `count≥2 走复数键（{count} 插值）：${pluralRow}`);
});

test("计数词条单/复数转正（#142 承 #136 · 契约 §13.5）：计划摘要「前沿/在途」en-US count=1 走单数键、0/≥2 走复数键；zh 两键同文不变", () => {
  // 期望值的独立真源：派发卡文「#136 面裸插值转正——『前沿 {count}』『在途 {count}』补 .one/.other
  // 两键形态（走 BOARD_COUNT_MESSAGE_IDS+formatBoardCountText 单点设施，与 #138 微回炉同款；
  // en one=单数形态/zh 两键同文）」+ 契约 §13.5「count===1 走单数键，其余（含 0）走复数键」。
  // 夹具真值（frontier/active 四段投影直读，不按卡字段自算）：计划 A 前沿 #210=1、在途 #213=1
  // （单数侧）；计划 B 前沿 #220/#221=2、在途 0（复数侧，含 0 也必须走复数键）。
  // zh 侧：两键同文（汉语无复数）——转正不得改变中文可见文案（独立期望值 = 既有词条文本）。
  const zhSummaryA = planSummaryText(render(readyState()), "plan:plan-guide-a");
  assert.ok(zhSummaryA.includes("前沿 1"), `zh 前沿文案（两键同文）不变：${zhSummaryA}`);
  assert.ok(zhSummaryA.includes("在途 1"), `zh 在途文案（两键同文）不变：${zhSummaryA}`);

  const enMarkup = renderEn(readyState());
  const enSummaryA = planSummaryText(enMarkup, "plan:plan-guide-a");
  assert.ok(
    enSummaryA.includes("1 card ready"),
    `count=1 走单数键（en 侧须有单数形态，不得裸插值「1 ready」）：${enSummaryA}`,
  );
  assert.ok(enSummaryA.includes("1 card in flight"), `count=1 在途同款走单数键：${enSummaryA}`);
  assert.ok(!enSummaryA.includes("1 ready"), "「1 ready」= #142 要消灭的裸插值形态");
  // other 侧：count=2 与 count=0 都走复数键（只有 count===1 走 one）——计划 B 即 2/0 组合。
  const enSummaryB = planSummaryText(enMarkup, "plan:plan-guide-b");
  assert.ok(enSummaryB.includes("2 cards ready"), `count≥2 走复数键：${enSummaryB}`);
  assert.ok(
    enSummaryB.includes("0 cards in flight"),
    `count=0 走复数键（不是单数）：${enSummaryB}`,
  );
});

test("窄面截断防线（#141 承 #138 P3-2 登记项）：超长角色名全文进原生 title，可见文本可收缩截断", () => {
  // 期望值的独立真源：派发卡文「超长角色名（nextAssignee）处置指引 span 在 <360px 溢出风险——
  // 本卡截断防线一并落（truncate+title）」；全文 = 词条插值后的同一字符串（不另拼第二份）。
  const longRole = "exhaustive-reverse-auditor";
  const mutated = structuredClone(GUIDE_BOARD);
  const entries = mutated.frontier as Array<Record<string, unknown>>;
  const entry221 = entries.find((entry) => entry.no === 221);
  assert.ok(entry221, "夹具里应有 frontier #221");
  entry221.nextAssignee = longRole;
  const row221 = queueRowMarkup(
    planMarkup(render(readyStateOf(mutated)), "plan:plan-guide-b"),
    "task:221",
  );
  assert.ok(
    row221.includes(`title="下一步：${longRole}"`),
    `超长角色名全文进原生 title（信息不丢）：${row221}`,
  );
  const nextSpan =
    /data-board-guide-queue-next="exhaustive-reverse-auditor"[^>]*class="([^"]*)"/.exec(row221);
  assert.ok(nextSpan, "处置指引元素带 class");
  assert.ok(nextSpan[1]?.includes("truncate"), `可见文本走省略号截断（truncate）：${nextSpan[1]}`);
  assert.ok(
    nextSpan[1]?.includes("min-w-0"),
    `可收缩到零基准（min-w-0：收不出空间时截断，而不是把行撑溢出）：${nextSpan[1]}`,
  );
  assert.ok(nextSpan[1]?.includes("text-ui-base"), `字号底线不破（≥14px 档）：${nextSpan[1]}`);
});

test("队列空态（#138）：计划无可执行卡时给明确文案（不留空壳）；有前沿的计划不落空态", () => {
  const markup = render(readyState());
  const planD = planMarkup(markup, "plan:plan-guide-d");
  assert.ok(planD.includes("data-board-guide-queue-empty"), "未拆解计划（零卡）有空态锚点");
  assert.ok(planD.includes("暂无可立即执行的卡"), "空态可读文案");
  const planA = planMarkup(markup, "plan:plan-guide-a");
  assert.ok(!planA.includes("data-board-guide-queue-empty"), "有可执行卡的计划不落空态");
  // 有卡但全部在途/受阻/完成 → 队列仍为空态（队列 = 可执行卡，可用性由 frontier 派生说话）。
  const mutated = structuredClone(GUIDE_BOARD);
  mutated.frontier = (mutated.frontier as Array<Record<string, unknown>>).filter(
    (entry) => entry.no === 210,
  );
  const mutatedMarkup = render(readyStateOf(mutated));
  const planB = planMarkup(mutatedMarkup, "plan:plan-guide-b");
  assert.ok(planB.includes("data-board-guide-queue-empty"), "计划 B 撤出前沿成员后落空态");
  assert.ok(
    planB.includes("data-board-guide-plan-card-count"),
    "计划 B 仍有卡数胶囊（有卡但无可执行）",
  );
});

test("反例（#138 派生改判必咬）：队列行成员/标题/接手位/依赖计数全跟 frontier 派生走，不按卡字段自算", () => {
  const mutated = structuredClone(GUIDE_BOARD);
  const entries = mutated.frontier as Array<Record<string, unknown>>;
  const entry220 = entries.find((entry) => entry.no === 220);
  assert.ok(entry220, "夹具里应有 frontier #220");
  // 派生改判：条目标题/接手位/依赖与卡节点字段解耦（卡节点仍是「胶囊形态」/implementer/无依赖）。
  entry220.title = "胶囊形态（前沿改判）";
  entry220.nextAssignee = "test-verifier";
  entry220.resolvedDeps = [211, 212];
  const markup = render(readyStateOf(mutated));
  const row220 = queueRowMarkup(planMarkup(markup, "plan:plan-guide-b"), "task:220");
  assert.ok(row220.includes("胶囊形态（前沿改判）"), "行标题 = frontier 条目标题（条目改判必随）");
  assert.ok(
    row220.includes('data-board-guide-queue-next="test-verifier"'),
    "接手位 = frontier 条目值",
  );
  assert.ok(/data-board-guide-queue-deps="2"/.test(row220), "依赖计数 = 条目 resolvedDeps 条数");
  assert.ok(row220.includes('title="#211, #212"'), "依赖明细 = 条目号原值");

  // 成员改判：撤掉 #221 条目（卡节点仍 待办）——队列不得把「卡字段看起来可执行」的卡自算回来。
  const without = structuredClone(GUIDE_BOARD);
  without.frontier = (without.frontier as Array<Record<string, unknown>>).filter(
    (entry) => entry.no !== 221,
  );
  const withoutMarkup = render(readyStateOf(without));
  const planB = planMarkup(withoutMarkup, "plan:plan-guide-b");
  assert.ok(
    !planB.includes('data-board-card="task:221"'),
    "派生撤出的成员不得由卡字段自算回队列（节点仍 待办 → 自算实现必咬）",
  );
  assert.ok(planB.includes('data-board-card="task:220"'), "其余成员不受影响");
});

test("反例（#138 顺序照读必咬）：队列行序 = frontier 数组序（派生顺序改判即随，不按板序/rank 重排）", () => {
  const mutated = structuredClone(GUIDE_BOARD);
  const entries = mutated.frontier as Array<Record<string, unknown>>;
  // 交换 220/221 两条目顺序（rank 字段不改）——队列必须照数组序（221 → 220）；
  // 按板序或按 rank 重排的实现会得 220 → 221（必咬）。
  const idx220 = entries.findIndex((entry) => entry.no === 220);
  const idx221 = entries.findIndex((entry) => entry.no === 221);
  assert.ok(idx220 >= 0 && idx221 >= 0, "夹具里应有 frontier #220/#221");
  [entries[idx220], entries[idx221]] = [
    entries[idx221] as Record<string, unknown>,
    entries[idx220] as Record<string, unknown>,
  ];
  const markup = render(readyStateOf(mutated));
  const planB = planMarkup(markup, "plan:plan-guide-b");
  const rowIds = [...planB.matchAll(/data-board-card="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(rowIds, ["task:221", "task:220"], "顺序照读（派生数组序改判即随）");
});
