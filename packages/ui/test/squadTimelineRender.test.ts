import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { SquadRunRecord } from "@zcode/services";
import type { TeamAgent } from "@zcode/shared";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  SQUAD_TIMELINE_MIN_STATION_WIDTH,
  SQUAD_TIMELINE_STATION_INSET_Y,
  layoutSquadTimeline,
} from "../src/squad/squadTimelineLayout.js";
import { buildSquadTimelineModel } from "../src/squad/squadTimelineModel.js";

/* 「活动时间线」（规格 §11.2）**渲染两半**的用例：纯几何（squadTimelineLayout）
   + 结构守卫（SquadTimeline / SquadTimelineSection / WorkItemsBoard / WorkItemsPage 读源码）。
   ui 包没有渲染测试设施（本项目既定做法）⇒ 几何逐值钉在纯函数上、判断钉在源码形态上。

   分工：
   ① 几何逐格：空模型 / 零长度域（单站同刻）/ 普通三站 / 开口站两格（now 在域外 / 域内）/
      最小站宽（含「下界不是上界」）/ lane 的 y 递增与站对齐 / 弧三点逐值 / 弧只透传不推断；
   ② 结构守卫：SquadTimeline（弧虚线、九色板只做身份、状态语义 token、reduced-motion、可点判据）、
      SquadTimelineSection（历史读通路、失败重试、不拉快照、实测宽）、
      WorkItemsBoard（展开钮只在批根行）、WorkItemsPage（展开态单点）；
   ③ i18n：squad.timeline.* 显式键两语齐全（`squad.` 前缀的命名空间级齐平由 squadsPage.test.ts
      那条既有用例自动覆盖）+ 「推断」声明必须在文案里。

   每条守卫都写明变异方式（哪一行改坏会红）；变异 M1–M5 已在交付报告里逐条实测。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");

const run = (over: Partial<SquadRunRecord> = {}): SquadRunRecord => ({
  runId: "run-1",
  workspaceKey: "ws",
  workspacePath: "/tmp/ws",
  workItemId: "wi-child-1",
  parentWorkItemId: "wi-batch-1",
  agentId: "ta-member",
  isLeaderTask: false,
  branch: "squad/member/aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbb",
  dirName: null,
  status: "open",
  sessionId: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const agent = (over: Partial<TeamAgent> = {}): TeamAgent => ({
  id: "ta-leader",
  name: "队长",
  systemPrompt: "",
  skills: [],
  memoryScope: "project",
  enabled: true,
  ...over,
});

/** 布局入参的公共部分：画布 176 宽、左右内边距 40 + 8 ⇒ 可绘制区 128（取 2 的幂便于逐值手算）。 */
const canvas = { width: 176, laneHeight: 20, padding: { left: 40, right: 8 } };

/** 递归断言：这棵布局里**每一个数字都是有限数**（NaN / Infinity 不得静默产出合法外观）。 */
function assertNoNaN(value: unknown, path = "layout"): void {
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `${path} 必须是有限数，实际是 ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertNoNaN(entry, `${path}[${index}]`);
    });
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) assertNoNaN(entry, `${path}.${key}`);
  }
}

// ---------- ① 几何：空模型 ----------

test("空模型：lanes/站/弧为空、height = 0、任何数字都不是 NaN（域仍按同一式子给）", () => {
  const model = buildSquadTimelineModel({ runs: [], teamAgents: [] });
  const layout = layoutSquadTimeline({ model, ...canvas, now: 1000 });

  assert.deepEqual(layout.lanes, []);
  assert.deepEqual(layout.stations, []);
  assert.deepEqual(layout.arcs, []);
  assert.equal(layout.height, 0, "没有 lane 就没有行高 —— 空态在渲染层自然成为「没有可画的行」");
  assert.deepEqual(layout.domain, { startAt: 0, endAt: 1000 }, "域不特判：endAt = max(0, now)");
  assertNoNaN(layout);
});

// ---------- ② 几何：零长度域（不产生 NaN） ----------

/* 变异（M3）：去掉零长度域的固定映射（直接做 (t - startAt) / span * drawable）⇒ span = 0 时
   0/0 = NaN ⇒ 本用例的有限数断言与逐值断言全红。 */
test("零长度域（同刻的两站）：不做除法 —— x 全落 padding.left、宽取最小可见宽，且无 NaN", () => {
  const model = buildSquadTimelineModel({
    runs: [
      run({ runId: "run-a", agentId: "ta-x", status: "merged", createdAt: 10, updatedAt: 10 }),
      run({ runId: "run-b", agentId: "ta-x", status: "merged", createdAt: 10, updatedAt: 10 }),
    ],
    teamAgents: [],
  });
  // now 与站同刻 ⇒ 布局域 {10, 10}（span = 0）。
  const layout = layoutSquadTimeline({ model, ...canvas, now: 10 });

  assert.deepEqual(layout.domain, { startAt: 10, endAt: 10 });
  assert.equal(layout.stations.length, 2);
  for (const station of layout.stations) {
    assert.equal(station.x, canvas.padding.left, "零长度域：所有站落 padding.left（固定映射）");
    assert.equal(
      station.width,
      SQUAD_TIMELINE_MIN_STATION_WIDTH,
      "宽度差为 0 ⇒ 由最小可见宽兜底（0 宽的条在 SVG 里什么都不画）",
    );
  }
  assertNoNaN(layout);
});

// ---------- ③ 几何：普通三站（缩放 / y / 弧三点逐值） ----------

test("普通三站：缩放逐值、lane 的 y 递增且站与 lane 对齐、弧三点逐值、open=false", () => {
  const model = buildSquadTimelineModel({
    runs: [
      // 队长站 0→64；队员 m1 16→32；队员 m2 32→56。now = 64 ⇒ 域 {0, 64}（span 64、可绘制 128 ⇒ 系数 2）。
      run({
        runId: "run-leader",
        agentId: "ta-leader",
        isLeaderTask: true,
        branch: null,
        status: "merged",
        createdAt: 0,
        updatedAt: 64,
      }),
      run({ runId: "run-m1", agentId: "ta-m1", status: "merged", createdAt: 16, updatedAt: 32 }),
      run({ runId: "run-m2", agentId: "ta-m2", status: "merged", createdAt: 32, updatedAt: 56 }),
    ],
    teamAgents: [agent()],
  });
  const layout = layoutSquadTimeline({ model, ...canvas, now: 64 });

  assert.equal(layout.width, canvas.width);
  assert.deepEqual(layout.domain, { startAt: 0, endAt: 64 });
  assert.equal(layout.height, 3 * canvas.laneHeight);

  // lane 的 y 递增（队长 lane 置顶来自模型；布局只管行高）。
  assert.deepEqual(
    layout.lanes.map((lane) => [lane.laneId, lane.y]),
    [
      ["ta-leader", 0],
      ["ta-m1", 20],
      ["ta-m2", 40],
    ],
  );

  // 缩放 x(t) = 40 + t / 64 * 128 = 40 + 2t；站宽 = 两端映射之差。
  const stationByRunId = new Map(layout.stations.map((station) => [station.runId, station]));
  assert.deepEqual(
    [...stationByRunId].map(([runId, station]) => [runId, station.x, station.width, station.y]),
    [
      ["run-leader", 40, 128, 0 + SQUAD_TIMELINE_STATION_INSET_Y],
      ["run-m1", 72, 32, 20 + SQUAD_TIMELINE_STATION_INSET_Y],
      ["run-m2", 104, 48, 40 + SQUAD_TIMELINE_STATION_INSET_Y],
    ],
    "站与 lane 对齐：y = lane.y + 内边距；宽度是 [startAt, endAt] 映射后的差",
  );
  for (const station of layout.stations) {
    assert.equal(station.open, false, "终态站的 open=false（开口判据只在模型一处）");
  }

  // 弧三点逐值：from = 队长条**右缘**中点（168, 10）；to = 队员条**左缘**中点；
  // control = 两点中点（x 两站中点、y 两 lane 中线）。
  assert.deepEqual(
    layout.arcs.map((arc) => [arc.fromRunId, arc.toRunId, arc.from, arc.control, arc.to]),
    [
      ["run-leader", "run-m1", { x: 168, y: 10 }, { x: 120, y: 20 }, { x: 72, y: 30 }],
      ["run-leader", "run-m2", { x: 168, y: 10 }, { x: 136, y: 30 }, { x: 104, y: 50 }],
    ],
  );
  for (const arc of layout.arcs) {
    assert.equal(arc.kind, "leader_dispatch_inferred", "kind 原样带出（推断的字面量不在这里改写）");
  }
  assertNoNaN(layout);
});

// ---------- ④ 几何：开口站两格（now 在域外 / 域内） ----------

test("开口站：now 超出域右端 ⇒ 宽度伸到 now（= 轴右端）", () => {
  const model = buildSquadTimelineModel({
    runs: [
      run({
        runId: "run-leader",
        agentId: "ta-leader",
        isLeaderTask: true,
        branch: null,
        status: "merged",
        createdAt: 0,
        updatedAt: 64,
      }),
      // 活跃（open）站：模型 endAt = null、不取 updatedAt（见模型用例）。
      run({ runId: "run-m1", agentId: "ta-m1", status: "open", createdAt: 16, updatedAt: 16 }),
    ],
    teamAgents: [],
  });
  // now = 128 > 域右端 64 ⇒ 布局域 {0, 128}（span 128、可绘制 128 ⇒ 系数 1）。
  const layout = layoutSquadTimeline({ model, ...canvas, now: 128 });

  assert.deepEqual(layout.domain, { startAt: 0, endAt: 128 }, "endAt = max(域右端, now)");
  const station = layout.stations.find((candidate) => candidate.runId === "run-m1");
  assert.ok(station);
  assert.equal(station.open, true, "开口标记原样带出（渲染层据此吃开口端帽）");
  assert.equal(station.x, 56, "x(16) = 40 + 16");
  assert.equal(station.width, 112, "宽度算到 now = 域右端：x(128) - x(16) = 168 - 56");
  assert.equal(
    station.x + station.width,
    canvas.padding.left + canvas.width - canvas.padding.left - canvas.padding.right,
    "右缘正好落在轴右端",
  );
  assertNoNaN(layout);
});

test("开口站：now 仍在域内（更晚的闭合站把域右端撑出去）⇒ 宽度仍算到域右端", () => {
  const model = buildSquadTimelineModel({
    runs: [
      // 闭合站结束得比 now 晚（64）；now = 32 在域内。
      run({
        runId: "run-leader",
        agentId: "ta-leader",
        isLeaderTask: true,
        branch: null,
        status: "merged",
        createdAt: 0,
        updatedAt: 64,
      }),
      run({ runId: "run-m1", agentId: "ta-m1", status: "open", createdAt: 16, updatedAt: 16 }),
    ],
    teamAgents: [],
  });
  const layout = layoutSquadTimeline({ model, ...canvas, now: 32 });

  assert.deepEqual(layout.domain, { startAt: 0, endAt: 64 }, "max(64, 32) = 64：轴始终覆盖全部站");
  const station = layout.stations.find((candidate) => candidate.runId === "run-m1");
  assert.ok(station);
  assert.equal(station.x, 72, "x(16) = 40 + 2 * 16");
  assert.equal(
    station.width,
    96,
    "宽度算到 domain.endAt（= 域右端 64，不是 now 32）：0 宽的「到 now 截断」会是 32 —— 轴只有一条缩放规则",
  );
  assert.notEqual(station.width, 32, "「到 now 截断」是第二种缩放规则，未采用");
  // 闭合站按自己的 endAt 收尾（64 → 轴右端）。
  const leader = layout.stations.find((candidate) => candidate.runId === "run-leader");
  assert.equal(leader?.width, 128);
  assertNoNaN(layout);
});

// ---------- ⑤ 几何：最小站宽（下界不是上界） ----------

test("最小站宽：零时长站被下界兜住、零时长之外不受影响（下界不是上界）", () => {
  const model = buildSquadTimelineModel({
    runs: [
      run({ runId: "run-zero", agentId: "ta-z", status: "merged", createdAt: 0, updatedAt: 0 }),
      // 同刻起、时长 32.5 ⇒ 映射后宽 128（绝不能被最小宽截住）。
      run({ runId: "run-full", agentId: "ta-h", status: "merged", createdAt: 0, updatedAt: 32.5 }),
    ],
    teamAgents: [],
  });
  const layout = layoutSquadTimeline({ model, ...canvas, now: 0 });

  assert.deepEqual(layout.domain, { startAt: 0, endAt: 32.5 });
  const zero = layout.stations.find((candidate) => candidate.runId === "run-zero");
  const full = layout.stations.find((candidate) => candidate.runId === "run-full");
  assert.equal(zero?.x, 40);
  assert.equal(zero?.width, SQUAD_TIMELINE_MIN_STATION_WIDTH, "零宽站也被下界抬到可见");
  assert.equal(full?.width, 128, "正常站宽不受最小宽影响");
  assertNoNaN(layout);
});

// ---------- ⑥ 几何：弧只透传不推断 ----------

test("弧只透传：队员先于队长（模型 0 弧）⇒ 布局 0 弧；不在这里重新推断", () => {
  const model = buildSquadTimelineModel({
    runs: [
      run({ runId: "run-m1", agentId: "ta-m1", createdAt: 1 }),
      run({
        runId: "run-leader",
        agentId: "ta-leader",
        isLeaderTask: true,
        branch: null,
        status: "merged",
        createdAt: 5,
        updatedAt: 6,
      }),
    ],
    teamAgents: [],
  });
  assert.deepEqual(model.arcs, [], "前提：推断不出来（队员先于队长）");
  const layout = layoutSquadTimeline({ model, ...canvas, now: 100 });
  assert.deepEqual(layout.arcs, [], "布局不补弧：只翻 model.arcs 给的边");
});

// ---------- ⑦ 结构守卫（读源码，逐条可变异） ----------

/* 守卫 a：SquadTimeline.tsx 的三条视觉纪律。
   变异：M1 弧线去掉 strokeDasharray（画成实线）⇒ 第 1 条红；
        M5 ticker 无条件启动（去掉 matchMedia 判断）⇒ reduced-motion 两条红。 */
test("守卫｜SquadTimeline：弧必须虚线、九色板只做身份、reduced-motion 在 ticker 之前", () => {
  const src = readSource("squad/SquadTimeline.tsx");

  // (1) 弧的渲染段（layout.arcs.map( … </svg>，弧是 SVG 的最后一块）里必须有 strokeDasharray。
  // 切片而不是全文匹配：开口端帽也用虚线，全文匹配会在「弧改成实线」时被端帽放过去。
  const arcsBlock = src.slice(src.indexOf("layout.arcs.map("), src.indexOf("</svg>"));
  assert.ok(arcsBlock.includes("layout.arcs.map("), "弧渲染段必须存在（切片锚点）");
  assert.ok(arcsBlock.includes("strokeDasharray"), "弧线必须虚线：推断的派发关系不得画成实线");
  assert.ok(arcsBlock.includes("opacity"), "弧线必须带低不透明度");

  // (2) 九色板只允许出现在身份侧：全文件恰一处取色，且以 lane.color 为键。
  assert.equal(
    (src.match(/SUBAGENT_COLOR_CLASS\[/g) ?? []).length,
    1,
    "九色板取色点只应有一处（多一处就是可能被拿去编码状态）",
  );
  assert.ok(src.includes("SUBAGENT_COLOR_CLASS[lane.color]"), "九色板的键只能是 lane 身份色");

  // (3) 状态走语义 token：原生调色板（rose-300 这类）一个都不出现；状态表逐档是语义 token。
  assert.ok(
    !/-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d/.test(
      src,
    ),
    "身份之外不得出现原生调色板色值（状态只由语义 token 表达，§11.3）",
  );
  const statusBlock = src.slice(
    src.indexOf("STATION_STATUS_CLASSES"),
    src.indexOf("};", src.indexOf("STATION_STATUS_CLASSES")),
  );
  for (const line of statusBlock.split("\n").filter((entry) => entry.includes("text-"))) {
    assert.ok(
      /text-(foreground|destructive|warning|success)/.test(line),
      `状态类必须是语义 token：${line.trim()}`,
    );
  }
  assert.ok(
    src.includes("squadRunStatusMessageId("),
    "状态文案必须复用既有 squadRunStatusMessageId",
  );

  // (4) ticker 必须在 prefers-reduced-motion 判断之后（命中 ⇒ 不启动）。
  // 钉**带引号的媒体查询字符串**而不是裸词组：裸词组会被注释满足（把代码删了、注释还在 ⇒
  // 守卫放行），带引号的形态只可能出现在真的 matchMedia 调用里。
  const motionIndex = src.indexOf('"(prefers-reduced-motion: reduce)"');
  const tickerIndex = src.indexOf("setInterval(");
  assert.ok(motionIndex >= 0, "必须有 prefers-reduced-motion 判断（ticker 不得无条件启动）");
  assert.ok(tickerIndex >= 0, "开口站的 ticker 在（仅 open 站时启动）");
  assert.ok(motionIndex < tickerIndex, "reduced-motion 判断必须出现在 ticker 之前");
  assert.ok(
    src.includes('typeof window.matchMedia !== "function"'),
    "matchMedia 不可用按「不启动」处理",
  );

  // (5) 无障碍与锚点。
  assert.ok(
    src.includes('role="img"') && src.includes("aria-label="),
    "SVG 必须 role=img + aria-label",
  );
  assert.ok(src.includes('data-testid="squad-timeline"'), "SVG testid 不得改名");

  // (6) 可点判据：onOpenSession 非空 **且** 有会话 id；两者缺一都不给点击。
  assert.ok(
    src.includes("onOpenSession !== undefined && sessionId !== null"),
    "可点必须同时要求 onOpenSession 与会话 id（没有会话就没有可打开的东西）",
  );
});

/* 守卫 b：SquadTimelineSection.tsx 的取数纪律。
   变异：把 listSquadRuns 换成 getSnapshot ⇒ 第 1/4 条红（本分区只用历史读、不拉快照）。 */
test("守卫｜SquadTimelineSection：历史读经服务通路、失败带重试、不拉快照、宽度实测", () => {
  const src = readSource("squad/SquadTimelineSection.tsx");

  assert.ok(
    src.includes("resolveSquadRuntimeService("),
    "取数必须经 resolveSquadRuntimeService（响亮通路）",
  );
  assert.ok(src.includes("listSquadRuns("), "必须调 listSquadRuns 读本批历史");
  assert.ok(src.includes("parentWorkItemId: workItemId"), "必须按 parentWorkItemId 收敛到本批");
  assert.ok(
    !src.includes("getSnapshot("),
    "本分区只用历史读，不拉快照（快照口径是页面既有的 SquadRunsReview）",
  );
  assert.ok(src.includes("squadEntryErrorFeedback("), "失败翻译走既有入口");
  assert.ok(src.includes("squadServiceUnavailableFeedback("), "服务未接上单列文案");
  assert.ok(src.includes('data-testid="squad-timeline-retry"'), "失败态必须带重试");
  assert.ok(src.includes("void reload();"), "mount / 重试都要真的调 reload");

  for (const testid of ["squad-timeline-loading", "squad-timeline-error", "squad-timeline-empty"]) {
    assert.ok(src.includes(`data-testid="${testid}"`), `缺测试锚点 ${testid}`);
  }

  assert.ok(src.includes("ResizeObserver"), "宽度用容器实测（ResizeObserver）");
  assert.ok(src.includes("SQUAD_TIMELINE_FALLBACK_WIDTH"), "量不到宽要有兜底（非浏览器环境）");
  assert.ok(
    src.includes("[services, target, workItemId]"),
    "取数依赖里没有宽度 —— 宽度变化只重画、不重取数据",
  );
  assert.ok(src.includes("squad.timeline.legendInferred"), "图例必须注明「虚线 = 推断」");
});

/* 守卫 c：展开钮只在**批根行**（判据 = 服务面唯一实现 isSquadBatchRoot）。
   变异：M2 去掉 isSquadBatchRoot 条件（无条件渲染展开钮）⇒ 前三条红。 */
test("守卫｜WorkItemsBoard：展开钮在 isSquadBatchRoot 条件内、渲染在行下方、透传 onOpenSession", () => {
  const board = readSource("squad/WorkItemsBoard.tsx");

  const gate = board.indexOf("isSquadBatchRoot({");
  const button = board.indexOf('data-testid="work-item-timeline-toggle"');
  assert.ok(gate >= 0, "看板必须用服务面唯一判据 isSquadBatchRoot（不得另写一份「什么是批」）");
  assert.ok(button > gate, "展开钮必须在批根判据之后（不得无条件渲染）");
  assert.ok(
    !board.slice(gate, button).includes(") : null}"),
    "展开钮必须在条件块内（条件中途闭合 = 钮裸奔到所有行）",
  );
  assert.equal((board.match(/onToggleTimeline\(item\)/g) ?? []).length, 1, "开关回调恰一处调用");

  const sectionGate = board.indexOf("timelineExpanded ? (");
  const section = board.indexOf("<SquadTimelineSection");
  assert.ok(sectionGate >= 0 && section > sectionGate, "展开时把分区渲染在该行下方（条件渲染）");
  assert.ok(board.includes("onOpenSession={onOpenSession}"), "看板把 onOpenSession 透传给分区");
  assert.ok(board.includes('t("squad.timeline.toggle")'), "展开钮文案走 squad.timeline.toggle");

  const page = readSource("squad/WorkItemsPage.tsx");
  const pageBoardTag = page.slice(
    page.indexOf("<WorkItemsBoard"),
    page.indexOf("/>", page.indexOf("<WorkItemsBoard")),
  );
  for (const needle of [
    "timelineExpandedWorkItemId={expandedTimelineWorkItemId}",
    "onToggleTimeline={toggleTimeline}",
    "onOpenSession={onOpenSession}",
    "workspacePath={workspacePath}",
    "workspaceIdentity={workspaceIdentity}",
  ]) {
    assert.ok(pageBoardTag.includes(needle), `页面到看板的接线缺 ${needle}`);
  }
});

/* 守卫 d：展开态**单点**（页面）。
   「恰一处」的读法（本用例的形态）：① 状态只有一处声明；② 只有一处改写（同一个 setter 调用）；
   ③ 回调只接给看板一处。三者任一被复制/旁路（第二个 useState、第二处 setState、接两处）⇒ 红。
   变异：把 `previous === item.id ? null : item.id` 改成恒等于 item.id（去掉了「再点收起」）⇒ 红。 */
test("守卫｜WorkItemsPage：展开态单点声明 + 单点改写 + 单点接线（一次只展开一批）", () => {
  const page = readSource("squad/WorkItemsPage.tsx");

  assert.equal(
    (page.match(/const \[expandedTimelineWorkItemId/g) ?? []).length,
    1,
    "展开态只该有一处声明（再存一份 = 一份界面两种真相）",
  );
  assert.equal(
    (page.match(/setExpandedTimelineWorkItemId\(/g) ?? []).length,
    1,
    "展开态只在开关的单一回调里被改写（别处再改 = 收起/换批会分叉）",
  );
  assert.equal((page.match(/onToggleTimeline=\{/g) ?? []).length, 1, "开关回调只接给看板一处");
  assert.match(
    page,
    /previous === item\.id \? null : item\.id/,
    "同一条再点 = 收起（收起即卸载 = 数据丢弃）；点别的条 = 换过去（一次只展开一批）",
  );
});

// ---------- ⑧ i18n：squad.timeline.* 显式键清单 ----------

/* 显式清单（照 inboxPage.test.ts 的写法）：`squad.` 前缀的命名空间级两语齐平由
   squadsPage.test.ts 的既有用例自动覆盖；这里把**语义**逐条钉住（开关/加载/失败/空/
   图例/推断说明/无障碍标签/会话提示/时长），并钉住「推断」二字必须在文案里。 */
test("i18n：squad.timeline.* 两语齐全，且「推断」声明在图例与悬停说明里", () => {
  for (const key of [
    "squad.timeline.toggle",
    "squad.timeline.loading",
    "squad.timeline.loadFailed",
    "squad.timeline.empty",
    "squad.timeline.legendTitle",
    "squad.timeline.legendIdentity",
    "squad.timeline.legendInferred",
    "squad.timeline.ariaLabel",
    "squad.timeline.inferredTooltip",
    "squad.timeline.openSessionTooltip",
    "squad.timeline.durationSeconds",
  ]) {
    assert.ok((zhCN[key] ?? "").length > 0, `zh-CN 缺少 ${key}`);
    assert.ok((enUS[key] ?? "").length > 0, `en-US 缺少 ${key}`);
  }

  // 弧是**推断**的：图例与悬停说明都必须把话说出来（不得画成既成事实）。
  assert.ok((zhCN["squad.timeline.legendInferred"] ?? "").includes("推断"));
  assert.ok((zhCN["squad.timeline.inferredTooltip"] ?? "").includes("没有派发边"));
  assert.ok(/inferred/i.test(enUS["squad.timeline.legendInferred"] ?? ""));
  assert.ok(/no dispatch edge/i.test(enUS["squad.timeline.inferredTooltip"] ?? ""));

  // aria-label 的占位符两语一致（组件传 lanes / runs；缺一个占位符会渲染出裸花括号）。
  const placeholders = (text: string) =>
    [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  assert.deepEqual(placeholders(zhCN["squad.timeline.ariaLabel"] ?? ""), ["lanes", "runs"]);
  assert.deepEqual(placeholders(enUS["squad.timeline.ariaLabel"] ?? ""), ["lanes", "runs"]);
});
