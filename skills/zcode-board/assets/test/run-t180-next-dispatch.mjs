#!/usr/bin/env node
/**
 * zcode-board / #180（B9-1）next-dispatch 可派面扫描器 · 自包含套件
 *
 * 存在原因（卡 #180；用户 2026-10-11 原话「先想好机制，不一定要靠定时任务去提醒。而且有时候定时提醒
 * 也不一定会安排出新的 agent」/「我看怎么不用定时任务，你现在只有 2 个智能体在推进」）：
 *   2026-10-11 上午两类实操事故——B4-4 域空 8 轮未派（漏派）与并发 2/12 时 4 路可派未察（过度串行）——
 *   根因是派发决策靠编排者脑内队列。本套件为 `assets/tools/next-dispatch.mjs`（事件后必跑一条命令）
 *   的行为回归面：以**公开面**（CLI 参数 / stdout 清单行 / --json 字段 / 退出码）断言。
 *
 * 覆盖（逐用例见下）：
 *   T1  有可派夹具（三态之一）：在途推导（runs.json implementer done 且卡未勾选）+ 卡→文件域映射
 *      （计划稿冲突区 / 卡文 / 域未知）+ 可派清单 + 不可派域占证据 + 并行组 + 退出码 0
 *   T2  在途推导面与覆盖：--in-flight 显式覆盖（卡号与 #号等价）、--slots 并发上限与剩余槽位口径
 *   T3  不可派逐张证据：板 blocked[] 归因分流（blocked-by 在途 #N / blocked-by #N 未在途）
 *   T4  --json 机读输出：纯 JSON、字段与文本同源、域来源/置信随行
 *   T5  全阻塞夹具（三态之二）：可派 0、逐张证据齐、退出码 1（事件后必跑的信号面）
 *   T6  空 frontier 夹具（三态之三）：前沿为空、可派 0、退出码 1、零崩溃
 *   T7  只读零写入（快照前后 sha256+mtimeM 断言）+ 工具源码卫生（仅 node 内置 / 无绝对用户路径）
 *   T8  用法与坏输入 fail-closed：未知选项、板缺失、--in-flight 非法 → 退出码 2 + 用法；stdout 零产出
 *
 * 夹具：全部位于系统临时目录（build-fixture.newRoot；真实板/真实计划稿只读）。
 * 用法：node assets/test/run-t180-next-dispatch.mjs [T1 T3 …]（缺省跑全部用例；给标签只跑该组）
 * 退出码：0 = 全部通过；1 = 有失败。
 */

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { newRoot, removeRoot, treeSnapshot, diffSnapshot, w } from "./fixtures/build-fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(HERE, "..");
const TOOL = join(ASSETS, "tools", "next-dispatch.mjs");

// ---------------------------------------------------------------- 断言与输出

const lines = [];
let quiet = false;
function say(s = "") {
  lines.push(s);
  if (!quiet) console.log(s);
}

let passCount = 0;
let failCount = 0;

function pass(msg) {
  passCount += 1;
  say(`PASS  ${msg}`);
}

function fail(msg, detail = "") {
  failCount += 1;
  say(`FAIL  ${msg}${detail ? ` ｜ ${detail}` : ""}`);
}

class Checks {
  constructor(tag) {
    this.tag = tag;
  }
  ok(cond, label, detail = "") {
    if (cond) pass(`[${this.tag}] ${label}`);
    else fail(`[${this.tag}] ${label}`, detail);
  }
  eq(actual, expected, label, detail = "") {
    this.ok(
      actual === expected,
      label,
      `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}${detail ? `；${detail}` : ""}`,
    );
  }
  inc(text, needle, label) {
    this.ok(typeof text === "string" && text.includes(needle), label, `未命中：${JSON.stringify(needle)}`);
  }
  notInc(text, needle, label) {
    this.ok(typeof text === "string" && !text.includes(needle), label, `意外命中：${JSON.stringify(needle)}`);
  }
}

// ---------------------------------------------------------------- 夹具

/** 跑 next-dispatch 工具（可经 activeTool 切到突变副本；夹具根只读）。 */
let activeTool = TOOL;
function runTool(root, args = []) {
  const res = spawnSync(process.execPath, [activeTool, root, ...args], { encoding: "utf8" });
  return { code: res.status, out: res.stdout || "", err: res.stderr || "", signal: res.signal };
}

/** 静默跑一段断言并只回计数（突变负对照用；不污染总账、不打印）。 */
function countQuiet(fn) {
  const p0 = passCount;
  const f0 = failCount;
  quiet = true;
  try {
    fn();
  } finally {
    quiet = false;
  }
  const res = { passes: passCount - p0, fails: failCount - f0 };
  passCount = p0;
  failCount = f0;
  return res;
}

function task(no, title, extra = {}) {
  return {
    no,
    label: String(extra.label || no),
    title,
    status: extra.status || "pending",
    stage: extra.stage || "待办",
    nextAssignee: extra.nextAssignee || "implementer",
    currentAssignee: extra.currentAssignee || null,
    blockers: extra.blockers || [],
    source: extra.source || null,
    worktree: null,
  };
}

function frontierEntry(rank, no, title, extra = {}) {
  return {
    rank,
    no,
    title,
    stage: extra.stage || "待办",
    nextAssignee: extra.nextAssignee || "implementer",
    resolvedDeps: extra.resolvedDeps || [],
  };
}

function feature(no, title, tasks) {
  return {
    id: `plan:plan-x`,
    no,
    label: String(no),
    title,
    status: "active",
    stage: "执行中",
    tasks,
  };
}

/** 写夹具板（board.json / runs.json / 计划稿）。 */
function makeFixture(root, spec) {
  const board = {
    version: 2,
    project: { root: ".", name: "fixture" },
    updatedAt: spec.updatedAt || "2026-10-11T09:00:00+08:00",
    generatedBy: "zcode-board/0.5.0",
    sources: [],
    epics: [],
    features: spec.features || [],
    frontier: spec.frontier || [],
    active: [],
    blocked: spec.blocked || [],
    recent: [],
    attentionSummary: {},
    diagnostics: [],
  };
  w(root, ".zcode/board/board.json", JSON.stringify(board, null, 2));
  if (spec.runs) {
    w(root, ".zcode/board/runs.json", JSON.stringify({ version: 1, runs: spec.runs }, null, 2));
  }
  for (const [rel, text] of Object.entries(spec.plans || {})) w(root, rel, text);
  return board;
}

function implRun(runId, at, cards, extra = {}) {
  return {
    runId,
    sessionId: "sess_fixture",
    role: extra.role || "implementer",
    at,
    result: extra.result || "done",
    cards,
    worktree: extra.worktree ?? null,
    branch: extra.branch ?? null,
    evidence: [],
    breakpoint: { stoppedAt: null, next: "" },
  };
}

/** 三态夹具共用的计划稿：X1 批 4 卡 + 冲突区声明（shared.mjs 由 X1 各卡与 Z1 共享）。 */
const PLAN_X = `# fixture 计划稿（plan-x）

## 与其它线的文件域冲突点（共享写者，禁并行派发）

- \`assets/shared.mjs\`：X1-1 与 X1-4 共享（逐卡串行）。
- UI（\`packages/ui\` 看板模块）：X1-5 与 Z9 共享。

## X1 批

- [ ] X1-1 改共享域 <!-- zcode-board: no=101 -->
  责任: implementer
  目标: 改 assets/shared.mjs 的判定逻辑。
- [ ] X1-2 独立域卡 <!-- zcode-board: no=102 -->
  责任: implementer
  目标: 新增 assets/independent.mjs 工具（只增不改共享文件）。
- [ ] X1-3 无声明卡 <!-- zcode-board: no=103 -->
  责任: implementer
  目标: 收口对账文本，交付面按批注执行。
- [ ] X1-4 在途卡 <!-- zcode-board: no=104 -->
  责任: implementer
  目标: 改 assets/shared.mjs 的共享判定。
`;

/** 「有可派」夹具：在途 1（#104 占 shared.mjs）；可派 2（#102 域未占 / #103 域未知）；#101 域被占。 */
function fixtureGreen(root) {
  makeFixture(root, {
    plans: { ".zcode/plans/plan-x.md": PLAN_X },
    features: [
      feature(100, "X 线", [
        task(101, "X1-1 改共享域", { source: { file: ".zcode/plans/plan-x.md", selector: "item-1" } }),
        task(102, "X1-2 独立域卡", { source: { file: ".zcode/plans/plan-x.md", selector: "item-2" } }),
        task(103, "X1-3 无声明卡", { source: { file: ".zcode/plans/plan-x.md", selector: "item-3" } }),
        task(104, "X1-4 在途卡", { nextAssignee: "test-verifier", source: { file: ".zcode/plans/plan-x.md", selector: "item-4" } }),
      ]),
    ],
    frontier: [
      frontierEntry(1, 101, "X1-1 改共享域"),
      frontierEntry(2, 102, "X1-2 独立域卡"),
      frontierEntry(3, 103, "X1-3 无声明卡"),
    ],
    runs: [implRun("run-fixture-0001", "2026-10-11T08:00:00+08:00", [104])],
  });
}

// ---------------------------------------------------------------- T1 有可派

function checkGreen(c) {
  const root = newRoot("t180-green");
  try {
    fixtureGreen(root);
    const r = runTool(root);
    c.eq(r.code, 0, "有可派 → 退出码 0", r.err);
    c.inc(r.out, "next-dispatch:", "输出头含工具名");
    // 在途推导：runs.json implementer done 且卡未勾选 = 在途
    c.inc(r.out, "在途 1 张（并发上限 12，剩余槽位 11）：", "在途计数与并发上限口径");
    c.inc(r.out, "#104", "在途卡 #104 在列");
    c.inc(r.out, "域：assets/shared.mjs", "在途卡域随行（卡文声明）");
    // 可派清单：域未占 + 域未知两态
    c.inc(r.out, "可派 2 路", "可派计数 = 域未占 + 域未知");
    c.inc(r.out, "#102", "域未占卡 #102 在可派列");
    c.inc(r.out, "域未占", "可派卡标注域未占");
    c.inc(r.out, "#103", "域未知卡 #103 在可派列");
    c.inc(r.out, "域未知——需人工确认", "域未知卡显式标注需人工确认");
    // 不可派：域被占证据（前置在途号 + 域被占者）
    c.inc(r.out, "不可派 1 张", "不可派计数");
    c.inc(r.out, "域 assets/shared.mjs 被在途 #104 占", "域占证据逐张点名");
    // 并行组：域未知卡不入自动并行组（整行断言——突变「放行未知域入组」必咬）
    const groupLine = r.out.split("\n").find((l) => l.includes("并行组（≤"));
    c.eq((groupLine || "").trim(), "并行组（≤11）：#102", "并行组按 rank 取域互斥卡；域未知卡不入组");
    c.inc(r.out, "结论：可派 2 路", "结论行汇总");
  } finally {
    removeRoot(root);
  }
}

// ---------------------------------------------------------------- T2 在途推导与并发参数

function checkInFlightOverrides(c) {
  const root = newRoot("t180-inflight");
  try {
    fixtureGreen(root);
    // --in-flight 覆盖推导：卡号与 #号等价；#104 不再占域 → #101 转为可派
    const r1 = runTool(root, ["--in-flight", "#102"]);
    c.eq(r1.code, 0, "--in-flight 覆盖后仍可派 → 退出码 0", r1.err);
    c.inc(r1.out, "在途 1 张（并发上限 12，剩余槽位 11）：", "覆盖后在途计数以 CLI 为准");
    c.inc(r1.out, "CLI 显式传入", "在途行标注来源 = CLI");
    c.inc(r1.out, "域：assets/independent.mjs", "覆盖卡域随行");
    c.inc(r1.out, "可派 2 路", "覆盖后 #101 域释放转可派（可派 = #101+#103）");
    c.notInc(r1.out, "被在途 #104 占", "覆盖后 #104 不再计入在途域占");
    // 多卡 + --slots：上限即剩余槽位口径
    const r2 = runTool(root, ["--in-flight", "102,104", "--slots", "2"]);
    c.eq(r2.code, 0, "多卡覆盖 + 并发上限 → 退出码 0", r2.err);
    c.inc(r2.out, "在途 2 张（并发上限 2，剩余槽位 0）：", "上限 2 / 在途 2 → 剩余 0");
    c.notInc(r2.out, "并行组", "剩余槽位 0 时不给并行组（并发上限是资源约束）");
    // 空串 = 显式零在途
    const r3 = runTool(root, ["--in-flight", ""]);
    c.eq(r3.code, 0, "零在途 → 退出码 0", r3.err);
    c.inc(r3.out, "在途 0 张（--in-flight 显式传入为空）。", "空串显式零在途（来源与推导零在途文案分流）");
    c.inc(r3.out, "可派 3 路", "零在途时前沿全可派（#101+#102+#103）");
    // 无 runs.json：推导面空态（提示可用 --in-flight）
    const noRuns = newRoot("t180-inflight-noruns");
    try {
      fixtureGreen(noRuns);
      rmSync(join(noRuns, ".zcode", "board", "runs.json"));
      const r4 = runTool(noRuns);
      c.inc(r4.out, "在途 0 张（runs.json 无「implementer done 且卡未勾选」候选；可用 --in-flight 显式指定）。", "runs 缺失/无候选时的推导空态文案");
    } finally {
      removeRoot(noRuns);
    }
  } finally {
    removeRoot(root);
  }
}

// ---------------------------------------------------------------- T3 板 blocked[] 归因分流

/** blocked 夹具：批前缀域声明（X3 各卡）+ 板 blocked[] 三态（在途/未在途/死号）+ 已终态卡跳过。 */
const PLAN_Y = `# fixture 计划稿（plan-y）

## 与其它线的文件域冲突点（共享写者，禁并行派发）

- \`assets/shared.mjs\`：X1-1 与 X1-4 共享（逐卡串行）。
- \`assets/batchwide.mjs\`：X3 各卡与 Z1 共享（批内按列序串行）。

## X1 批

- [ ] X1-1 改共享域 <!-- zcode-board: no=101 -->
  责任: implementer
  目标: 改 assets/shared.mjs 的判定逻辑。
- [ ] X1-2 独立域卡 <!-- zcode-board: no=102 -->
  责任: implementer
  目标: 新增 assets/independent.mjs 工具。
- [ ] X1-3 无声明卡 <!-- zcode-board: no=103 -->
  责任: implementer
  目标: 收口对账文本。
- [ ] X1-4 在途卡 <!-- zcode-board: no=104 -->
  责任: implementer
  目标: 改 assets/shared.mjs 的共享判定。
- [ ] X3-1 批级共享卡 <!-- zcode-board: no=105 -->
  责任: implementer
  目标: 补批级共享面的断言。
`;

function checkBlockedAttribution(c) {
  const root = newRoot("t180-blocked");
  try {
    makeFixture(root, {
      plans: { ".zcode/plans/plan-y.md": PLAN_Y },
      features: [
        feature(100, "X 线", [
          task(101, "X1-1 改共享域", { source: { file: ".zcode/plans/plan-y.md", selector: "item-1" } }),
          task(102, "X1-2 独立域卡", { source: { file: ".zcode/plans/plan-y.md", selector: "item-2" } }),
          task(103, "X1-3 无声明卡", { source: { file: ".zcode/plans/plan-y.md", selector: "item-3" } }),
          task(104, "X1-4 在途卡", { nextAssignee: "test-verifier", source: { file: ".zcode/plans/plan-y.md", selector: "item-4" } }),
          task(105, "X3-1 批级共享卡", { source: { file: ".zcode/plans/plan-y.md", selector: "item-5" } }),
          task(106, "X9-1 依赖在途卡"),
          task(107, "X9-2 依赖未在途卡"),
          task(110, "X9-4 依赖死号"),
          task(111, "X9-5 已终态卡（陈旧 blocked 条目应跳过）", { status: "completed", stage: "已完成" }),
        ]),
      ],
      frontier: [
        frontierEntry(1, 101, "X1-1 改共享域"),
        frontierEntry(2, 102, "X1-2 独立域卡"),
        frontierEntry(3, 103, "X1-3 无声明卡"),
        frontierEntry(4, 105, "X3-1 批级共享卡"),
      ],
      blocked: [
        { no: 106, title: "X9-1 依赖在途卡", stage: "待办", blockerKind: "dependency", targetId: 104, summary: "" },
        { no: 107, title: "X9-2 依赖未在途卡", stage: "待办", blockerKind: "dependency", targetId: 102, summary: "" },
        { no: 110, title: "X9-4 依赖死号", stage: "待办", blockerKind: "dependency", targetId: 999, summary: "" },
        { no: 111, title: "X9-5 已终态卡", stage: "待办", blockerKind: "dependency", targetId: 102, summary: "" },
      ],
      runs: [implRun("run-fixture-0002", "2026-10-11T08:00:00+08:00", [104])],
    });
    const r = runTool(root);
    c.eq(r.code, 0, "有可派 → 退出码 0", r.err);
    // 批前缀声明面：X3 各卡命中共行 → 域取声明文件
    c.inc(r.out, "域：assets/batchwide.mjs（计划稿冲突区）；域未占", "批前缀声明命中（X3 各卡）并标注来源");
    // blocked[] 三态逐张证据
    c.inc(r.out, "blocked-by 在途 #104（板 blocked 归因 dependency）", "板 blocked 归因：目标在途");
    c.inc(r.out, "blocked-by #102（前置未完成、未在途）", "板 blocked 归因：目标未在途");
    c.inc(r.out, "blocked-by #999（目标号不在板上——对账点名面）", "板 blocked 归因：目标号不在板上");
    c.notInc(r.out, "#111", "已终态卡的历史 blocked 条目跳过（零噪声）");
    c.inc(r.out, "不可派 4 张", "不可派 = 域占 1 + 板 blocked 3");
  } finally {
    removeRoot(root);
  }
}

// ---------------------------------------------------------------- T4 --json 机读输出

function checkJson(c) {
  const root = newRoot("t180-json");
  try {
    fixtureGreen(root);
    const r = runTool(root, ["--json"]);
    c.eq(r.code, 0, "--json 有可派 → 退出码 0", r.err);
    let j = null;
    try {
      j = JSON.parse(r.out);
    } catch (err) {
      fail(`[T4] stdout 为纯 JSON（可解析）`, err.message);
    }
    if (!j) return;
    c.eq(j.schema, "next-dispatch/1", "JSON schema 标识");
    c.eq(j.root, root, "JSON root 回显项目根");
    c.eq(j.boardUpdatedAt, "2026-10-11T09:00:00+08:00", "JSON 回显板 updatedAt");
    c.eq(j.inFlight.source, "runs.json", "在途来源 = runs.json");
    c.eq(j.inFlight.count, 1, "在途计数");
    c.eq(j.inFlight.cards[0].no, 104, "在途卡号");
    c.eq(j.inFlight.cards[0].nextAssignee, "test-verifier", "在途卡下一棒");
    c.ok(j.inFlight.cards[0].domain.files.includes("assets/shared.mjs"), "在途卡域文件", JSON.stringify(j.inFlight.cards[0].domain));
    c.eq(j.inFlight.slotsFree, 11, "剩余槽位");
    c.eq(JSON.stringify(j.dispatchable.map((x) => x.no)), JSON.stringify([102, 103]), "可派卡号与 rank 序");
    c.eq(j.dispatchable[0].domain.source, "卡文", "域来源随行（卡文）");
    c.eq(JSON.stringify(j.needsReview), JSON.stringify([103]), "域未知清单（需人工确认）");
    c.eq(JSON.stringify(j.parallelGroup), JSON.stringify([102]), "并行组号清单");
    c.eq(j.blocked.length, 1, "不可派条数");
    c.eq(j.blocked[0].kind, "domain", "不可派归因 = 域占");
    c.eq(JSON.stringify(j.blocked[0].by), JSON.stringify([104]), "域占者号");
    c.inc(j.blocked[0].evidence, "域 assets/shared.mjs 被在途 #104 占", "逐张证据文本");
    c.eq(j.summary.dispatchableFree, 1, "汇总：域未占计数");
    c.eq(j.summary.needsReview, 1, "汇总：域未知计数");
  } finally {
    removeRoot(root);
  }
}

// ---------------------------------------------------------------- T5/T6 三态之二、之三

function checkAllBlocked(c) {
  const root = newRoot("t180-allblocked");
  try {
    makeFixture(root, {
      plans: { ".zcode/plans/plan-x.md": PLAN_X },
      features: [
        feature(100, "X 线", [
          task(101, "X1-1 改共享域", { source: { file: ".zcode/plans/plan-x.md", selector: "item-1" } }),
          task(104, "X1-4 在途卡", { nextAssignee: "test-verifier", source: { file: ".zcode/plans/plan-x.md", selector: "item-4" } }),
        ]),
      ],
      frontier: [frontierEntry(1, 101, "X1-1 改共享域")],
      runs: [implRun("run-fixture-0003", "2026-10-11T08:00:00+08:00", [104])],
    });
    const r = runTool(root);
    c.eq(r.code, 1, "全阻塞 → 退出码 1（事件后必跑的信号面）", r.err);
    c.inc(r.out, "可派 0 路（前沿卡全部被在途域占或前置未完成——见下逐张证据）。", "全阻塞文案");
    c.inc(r.out, "不可派 1 张（逐张证据）：", "逐张证据齐");
    c.inc(r.out, "域 assets/shared.mjs 被在途 #104 占", "证据点名域与占者");
    c.inc(r.out, "结论：可派 0 路", "结论行 0 路");
    const j = JSON.parse(runTool(root, ["--json"]).out);
    c.eq(j.dispatchable.length, 0, "JSON 可派为空");
    c.eq(j.parallelGroup.length, 0, "JSON 并行组为空");
  } finally {
    removeRoot(root);
  }
}

function checkEmptyFrontier(c) {
  const root = newRoot("t180-empty");
  try {
    makeFixture(root, {
      plans: { ".zcode/plans/plan-x.md": PLAN_X },
      features: [
        feature(100, "X 线", [
          task(104, "X1-4 在途卡", { nextAssignee: "test-verifier", source: { file: ".zcode/plans/plan-x.md", selector: "item-4" } }),
          task(107, "X9-2 依赖未在途卡"),
        ]),
      ],
      frontier: [],
      blocked: [{ no: 107, title: "X9-2 依赖未在途卡", stage: "待办", blockerKind: "dependency", targetId: 104, summary: "" }],
      runs: [implRun("run-fixture-0004", "2026-10-11T08:00:00+08:00", [104])],
    });
    const r = runTool(root);
    c.eq(r.code, 1, "空 frontier → 退出码 1（无可派）", r.err);
    c.inc(r.out, "可派 0 路（前沿为空——无可执行卡）。", "空前沿文案");
    c.inc(r.out, "blocked-by 在途 #104", "前沿空时仍给板 blocked 逐张证据");
    c.inc(r.out, "结论：可派 0 路", "结论行 0 路");
  } finally {
    removeRoot(root);
  }
}

// ---------------------------------------------------------------- T7 只读零写入 + 源码卫生

function checkReadOnlyAndHygiene(c) {
  const root = newRoot("t180-readonly");
  try {
    fixtureGreen(root);
    const before = treeSnapshot(root);
    const r1 = runTool(root);
    const r2 = runTool(root, ["--json"]);
    const r3 = runTool(root, ["--in-flight", "102", "--slots", "3"]);
    c.eq(r1.code + r2.code + r3.code, 0, "三次运行均正常（text/json/参数面）");
    const after = treeSnapshot(root);
    const diff = diffSnapshot(before, after);
    c.eq(diff.changed.length, 0, "只读零写入：无文件字节/mtime 变化", JSON.stringify(diff.changed.map((x) => x.rel)));
    c.eq(diff.removed.length, 0, "只读零写入：无文件移除", JSON.stringify(diff.removed));
    c.eq(diff.added.length, 0, "只读零写入：无文件新增", JSON.stringify(diff.added));

    // 源码卫生（卫生面与 run-t124-baseline 同口径）：仅 node 内置、无绝对用户路径、无写入 API、无网络
    const src = readFileSync(TOOL, "utf8");
    const specifiers = [...src.matchAll(/^\s*import\s[^\n]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    c.ok(specifiers.length > 0, "工具确有 import 声明（卫生断言非空转）");
    c.ok(specifiers.every((s) => s.startsWith("node:")), "仅 node 内置依赖（无第三方）", JSON.stringify(specifiers));
    c.ok(!src.includes("/Users/"), "无绝对用户路径");
    c.ok(!/writeFileSync\(|appendFileSync\(|mkdirSync\(|createWriteStream\(|rmSync\(/.test(src), "无写入 API（只读证据面）");
    c.ok(!/fetch\(|https?:\/\//.test(src), "无网络调用");
  } finally {
    removeRoot(root);
  }
}

// ---------------------------------------------------------------- T8 用法与坏输入 fail-closed

function checkUsageGuards(c) {
  const root = newRoot("t180-guards");
  try {
    fixtureGreen(root);
    const cases = [
      { args: ["--nope"], label: "未知选项", needle: "未知选项" },
      { args: ["--slots", "0"], label: "--slots 0 非法", needle: "--slots 取值非法" },
      { args: ["--slots", "abc"], label: "--slots 非数非法", needle: "--slots 取值非法" },
      { args: ["--in-flight", "abc"], label: "--in-flight 非卡号非法", needle: "--in-flight 取值非法" },
      { args: [], root: join(root, "nope-dir"), label: "项目根不存在", needle: "项目根不存在" },
    ];
    for (const cs of cases) {
      const res = runTool(cs.root || root, cs.args);
      c.eq(res.code, 2, `${cs.label} → 退出码 2`, res.err);
      c.inc(res.err, cs.needle, `${cs.label} → stderr 点名原因`);
      c.inc(res.err, "用法：", `${cs.label} → stderr 带用法`);
      c.eq(res.out, "", `${cs.label} → stdout 零产出`);
    }
    // 板缺失（空目录 = 合法目录但无板）
    const empty = newRoot("t180-guards-empty");
    try {
      const res = runTool(empty);
      c.eq(res.code, 2, "板缺失 → 退出码 2", res.err);
      c.inc(res.err, "板文件不存在", "板缺失 → stderr 点名板路径");
      c.eq(res.out, "", "板缺失 → stdout 零产出");
    } finally {
      removeRoot(empty);
    }
    // 板 JSON 损坏
    const broken = newRoot("t180-guards-broken");
    try {
      w(broken, ".zcode/board/board.json", "{ not json");
      const res = runTool(broken);
      c.eq(res.code, 2, "板 JSON 损坏 → 退出码 2", res.err);
      c.inc(res.err, "解析失败", "板 JSON 损坏 → stderr 点名解析失败");
      c.eq(res.out, "", "板 JSON 损坏 → stdout 零产出");
    } finally {
      removeRoot(broken);
    }
    // --help：用法零副作用
    const help = runTool(root, ["--help"]);
    c.eq(help.code, 0, "--help → 退出码 0");
    c.inc(help.out, "next-dispatch.mjs", "--help 输出用法");
  } finally {
    removeRoot(root);
  }
}

// ---------------------------------------------------------------- T9 反例必咬（突变负对照）

/**
 * 突变负对照（与 run-mutations 同纪律）：把工具源码复制进副本域施加一处语义突变，
 * 用同一批夹具断言复跑——未被任何断言捕获（全绿）说明夹具/断言对该行为不敏感 → 本组判失败。
 * 真实工具只读（突变只写副本域）。
 */
function checkMutationControls(c) {
  const root = newRoot("t180-mutation-green");
  const base = readFileSync(TOOL, "utf8");
  const mutations = [
    {
      name: "域占判定关闭（hits 恒空 → 域被占卡漏报为可派）",
      from: "if (hits.length > 0) {",
      to: "if (false) {",
    },
    {
      name: "域未知卡放行入并行组（未知域双写风险）",
      from: "if (card.domain.unknown) continue;",
      to: "if (false) continue;",
    },
    {
      name: "在途推导结果面收窄（done 不再算在途）",
      from: 'const IN_FLIGHT_RESULTS = new Set(["done", "partial"]);',
      to: 'const IN_FLIGHT_RESULTS = new Set(["partial"]);',
    },
  ];
  try {
    fixtureGreen(root);
    for (const m of mutations) {
      if (!base.includes(m.from)) {
        fail(`[T9] 突变锚点命中：${m.name}`, "锚点失配——重构后突变会静默失效");
        continue;
      }
      const dir = newRoot("t180-mutant");
      try {
        activeTool = w(dir, "next-dispatch.mjs", base.replace(m.from, m.to));
        const caught = countQuiet(() => checkGreen(new Checks("MUT")));
        c.ok(
          caught.fails > 0,
          `[反例必咬] ${m.name} 被断言捕获`,
          `突变后全绿（passes=${caught.passes}）——夹具/断言对该行为不敏感`,
        );
      } finally {
        activeTool = TOOL;
        removeRoot(dir);
      }
    }
  } finally {
    removeRoot(root);
  }
}

// ---------------------------------------------------------------- T10 域令牌归一

/** 归一夹具：行号后缀（`src/foo.test.ts:12-18`）与裸文件名必须归一到同一写面。 */
const PLAN_Z = `# fixture 计划稿（plan-z）

## Y1 批

- [ ] Y1-1 行号引用卡 <!-- zcode-board: no=201 -->
  责任: implementer
  目标: 改 \`src/foo.test.ts:12-18\` 的断言。
- [ ] Y1-2 行号单点卡 <!-- zcode-board: no=202 -->
  责任: implementer
  目标: 补 \`src/foo.test.ts:40\` 用例。
- [ ] Y1-3 在途写者 <!-- zcode-board: no=203 -->
  责任: implementer
  目标: 改 src/foo.test.ts 全量。
- [ ] Y1-4 行号单点自由卡 <!-- zcode-board: no=204 -->
  责任: implementer
  目标: 补 \`src/bar.test.ts:7\` 用例（与 at 归一后域为 src/bar.test.ts）。
`;

function checkTokenNormalization(c) {
  const root = newRoot("t180-tokens");
  try {
    makeFixture(root, {
      plans: { ".zcode/plans/plan-z.md": PLAN_Z },
      features: [
        feature(200, "Y 线", [
          task(201, "Y1-1 行号引用卡", { source: { file: ".zcode/plans/plan-z.md", selector: "item-1" } }),
          task(202, "Y1-2 行号单点卡", { source: { file: ".zcode/plans/plan-z.md", selector: "item-2" } }),
          task(203, "Y1-3 在途写者", { source: { file: ".zcode/plans/plan-z.md", selector: "item-3" } }),
          task(204, "Y1-4 行号单点自由卡", { source: { file: ".zcode/plans/plan-z.md", selector: "item-4" } }),
        ]),
      ],
      frontier: [
        frontierEntry(1, 201, "Y1-1 行号引用卡"),
        frontierEntry(2, 202, "Y1-2 行号单点卡"),
        frontierEntry(3, 204, "Y1-4 行号单点自由卡"),
      ],
      runs: [implRun("run-fixture-0005", "2026-10-11T08:00:00+08:00", [203])],
    });
    const r = runTool(root);
    c.notInc(r.out, ":12-18", "域令牌剥离行号后缀（不落 :12-18 形态）");
    c.notInc(r.out, ":7", "域令牌剥离单点行号后缀（不落 :N 形态）");
    c.inc(r.out, "不可派 2 张", "行号变体与全量声明归一到同一写面（双双被在途占）");
    c.inc(r.out, "域 src/foo.test.ts 被在途 #203 占", "证据用归一后令牌点名域");
    c.inc(r.out, "域：src/bar.test.ts（卡文）；域未占", "可派行只用归一令牌（无行号噪声）");
  } finally {
    removeRoot(root);
  }
}

// ---------------------------------------------------------------- T11 在途与 blocked 矛盾态

/** 在途卡同时挂着板上未解 blocker（板态矛盾，对账点名面）：只在「在途」段出现一次并标注矛盾。 */
function checkInFlightBlockedContradiction(c) {
  const root = newRoot("t180-contradiction");
  try {
    makeFixture(root, {
      plans: { ".zcode/plans/plan-x.md": PLAN_X },
      features: [
        feature(100, "X 线", [
          task(101, "X1-1 改共享域", { source: { file: ".zcode/plans/plan-x.md", selector: "item-1" } }),
          task(104, "X1-4 在途卡", { nextAssignee: "test-verifier", source: { file: ".zcode/plans/plan-x.md", selector: "item-4" } }),
        ]),
      ],
      frontier: [frontierEntry(1, 101, "X1-1 改共享域")],
      blocked: [{ no: 104, title: "X1-4 在途卡", stage: "待办", blockerKind: "dependency", targetId: 101, summary: "" }],
      runs: [implRun("run-fixture-0006", "2026-10-11T08:00:00+08:00", [104])],
    });
    const r = runTool(root);
    c.inc(r.out, "在途 1 张", "在途卡只计一次");
    c.inc(r.out, "板上仍有未解 blocker #101（与在途态矛盾——对账点名面）", "在途段标注板态矛盾（不静默丢证据）");
    c.notInc(r.out, "blocked-by 在途 #101", "在途卡不再重复进「不可派」段");
    c.inc(r.out, "不可派 1 张", "不可派 = 域被占的 #101（在途卡被排除）");
    const j = JSON.parse(runTool(root, ["--json"]).out);
    c.eq(j.inFlight.cards[0].boardBlockerNote, "板上仍有未解 blocker #101（与在途态矛盾——对账点名面）", "JSON 同源矛盾标注");
    c.eq(j.blocked.length, 1, "JSON 不可派不含在途卡");
  } finally {
    removeRoot(root);
  }
}

// ---------------------------------------------------------------- 主流程

const GROUPS = {
  T1: ["T1 有可派夹具（可派清单+域映射+域占证据+并行组）", checkGreen],
  T2: ["T2 在途推导与并发参数（--in-flight 覆盖 / --slots 剩余槽位 / 零在途）", checkInFlightOverrides],
  T3: ["T3 板 blocked[] 归因分流（在途/未在途/死号/终态跳过）+ 批前缀域声明", checkBlockedAttribution],
  T4: ["T4 --json 机读输出（纯 JSON、字段与文本同源、域来源/置信随行）", checkJson],
  T5: ["T5 全阻塞夹具（可派 0、逐张证据齐、退出码 1）", checkAllBlocked],
  T6: ["T6 空 frontier 夹具（前沿为空、可派 0、退出码 1、零崩溃）", checkEmptyFrontier],
  T7: ["T7 只读零写入（快照断言）+ 工具源码卫生（仅 node 内置/无绝对路径/无写 API）", checkReadOnlyAndHygiene],
  T8: ["T8 用法与坏输入 fail-closed（未知选项/坏板/非法取值 → 退出码 2 + 用法；stdout 零产出）", checkUsageGuards],
  T9: ["T9 反例必咬（副本域突变负对照：域占判定/并行组/在途推导三处）", checkMutationControls],
  T10: ["T10 域令牌归一（行号后缀/裸文件名归一到同一写面）", checkTokenNormalization],
  T11: ["T11 在途与 blocked 矛盾态（在途段只出现一次 + 矛盾标注）", checkInFlightBlockedContradiction],
};

const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const selected = requested.length > 0 ? requested : Object.keys(GROUPS);

say(`== run-t180-next-dispatch：${selected.length} 组用例 ==`);
for (const tag of selected) {
  const entry = GROUPS[tag];
  if (!entry) {
    fail(`未知用例组 ${tag}`);
    continue;
  }
  say("");
  say(`== ${entry[0]} ==`);
  const c = new Checks(tag);
  entry[1](c);
}

say("");
say(failCount === 0 ? `结论：通过 ${passCount}，失败 0` : `结论：通过 ${passCount}，失败 ${failCount}`);
process.exit(failCount === 0 ? 0 : 1);
