#!/usr/bin/env node
/**
 * zcode-board / T13 hook 场景断言（测试先行：红 → 绿；T16 可直接复跑）
 *
 * 覆盖（任务 T13，场景 23/28/29 + 场景 27 的 gate-merge 夹具半场）：
 *   - record-run.mjs（场景 23/28）：前台 PostToolUse payload 与后台编排者代触发（裸报告 stdin）
 *     两形态零分叉；解析 run_event → appendRun（runs 唯一写路径）→ 重编译；无块跳过 + diagnostics；
 *     async_launched 分支不落账；损坏 runs.json 不阻塞；多块逐块落账、块内缺省不造字段；
 *   - board-context.mjs：SessionStart 单 JSON 注入（additionalContext 形态）、缺口摘要 + 断点 top-N +
 *     上次对账；无板/坏板空态；输出字节自检（≤20KB 且 ≤24k 字符）截 additionalContext 保 JSON 完整；
 *     断点遍历递归到 schema 展开上限 3——深度 3 嵌套卡（feature→task→subtask）同样注入（S4）；
 *   - watch-sources.mjs（场景 29）：变更路径属 sources 才重编译（含尚未进 sources 的新文件归属判定）；
 *     无关路径不触发；
 *   - reconcile-stop.mjs：点名四类（未登记/未合并/板陈旧/待归档）；写 .zcode/board/last-reconcile.md；
 *     不强推续跑（stdout 无 continue/decision JSON）、显式 exit 0；未合并遍历递归到 schema 展开上限 3
 *     （深度 3 嵌套卡同样点名，S4）；
 *   - gate-merge.mjs（场景 27 夹具半场）：只拦"目标为 base 分支且无三绿证据"的合并；
 *     feature 间合并不拦；拦截文案给出缺失绿与补齐路径；其余 hook 永不阻断（exit 0）。
 *
 * 夹具全部位于系统临时目录；真实板文件零触碰（config.json 断言为只读）。
 * 用法：node assets/test/run-t13-hooks.mjs [--only S1,R1] [--clean]
 * 退出码：0 = 全部通过；1 = 有失败。
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { readJsonFile } from "../lib/board-io.mjs";
import {
  ASSETS_DIR,
  COMPILER,
  w,
  isDir,
  isFile,
  newRoot as newRootRaw,
  toPosix,
} from "./fixtures/build-fixture.mjs";

const HOOKS_DIR = join(ASSETS_DIR, "hooks");
const RECORD_RUN = join(HOOKS_DIR, "record-run.mjs");
const BOARD_CONTEXT = join(HOOKS_DIR, "board-context.mjs");
const WATCH_SOURCES = join(HOOKS_DIR, "watch-sources.mjs");
const RECONCILE_STOP = join(HOOKS_DIR, "reconcile-stop.mjs");
const GATE_MERGE = join(HOOKS_DIR, "gate-merge.mjs");
const HOOK_FILES = [
  ["record-run.mjs", RECORD_RUN],
  ["board-context.mjs", BOARD_CONTEXT],
  ["watch-sources.mjs", WATCH_SOURCES],
  ["reconcile-stop.mjs", RECONCILE_STOP],
  ["gate-merge.mjs", GATE_MERGE],
];

/** 项目级 hook 声明样例（真实工作区文件；本脚本只读）。 */
const REAL_CONFIG = "/Users/linguojin/Workspace/ZCode/.zcode/config.json";

const RUNS_REL = ".zcode/board/runs.json";
const BOARD_REL = ".zcode/board/board.json";
const LAST_RECONCILE_REL = ".zcode/board/last-reconcile.md";
const TEMPLATES = join(ASSETS_DIR, "templates");

/** 独立于实现的形态断言（与契约同源，此处手写复述）。 */
const ISO_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([+-][0-9]{2}:[0-9]{2}|Z)$/;
const RUN_ID_RE = /^run-[0-9]{8}-[0-9a-z]{4}$/;
const RUN_KEYS = ["runId", "sessionId", "role", "at", "result", "cards", "worktree", "branch", "evidence", "breakpoint"];
/** A6 实测的输出预算：32KB 收集上限留余量 → 目标 ≤20KB 字节；另有 24,000 字符注入闸。 */
const OUTPUT_BYTE_BUDGET = 20 * 1024;
const OUTPUT_CHAR_BUDGET = 24_000;

// ---------------------------------------------------------------- 输出工具

const lines = [];
function say(s = "") {
  lines.push(s);
  console.log(s);
}

let passCount = 0;
let failCount = 0;
const failedTests = new Set();

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === "object") {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function show(v) {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch {
    return String(v);
  }
}

class Checks {
  constructor(id) {
    this.id = id;
  }

  ok(cond, label, detail = "") {
    if (cond) {
      passCount += 1;
      say(`  PASS  ${label}`);
    } else {
      failCount += 1;
      failedTests.add(this.id);
      say(`  FAIL  ${label}${detail ? `\n          依据：${detail}` : ""}`);
    }
    return !!cond;
  }

  eq(actual, expected, label) {
    return this.ok(deepEqual(actual, expected), label, `期望 ${show(expected)}；实际 ${show(actual)}`);
  }

  exit(result, expected, label) {
    const detail =
      `期望退出码 ${expected}；实际 ${String(result.status)}` +
      `（signal=${String(result.signal)} error=${result.error ? result.error.message : "无"}）` +
      `\n          stderr：${String(result.stderr ?? "").trim().split("\n").slice(0, 4).join(" / ")}` +
      `\n          stdout：${String(result.stdout ?? "").trim().split("\n").slice(0, 3).join(" / ")}`;
    return this.ok(result.status === expected, label, detail);
  }
}

// ---------------------------------------------------------------- 运行器

/** 以 stdin 夹具调用 hook：payload 为对象（JSON 化）或裸文本。 */
function runHook(hookPath, payload, { args = [], env = process.env } = {}) {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
  if (!isFile(hookPath)) {
    return { status: null, signal: null, stdout: "", stderr: "", error: new Error(`hook 不存在：${hookPath}`) };
  }
  return spawnSync(process.execPath, [hookPath, ...args], { input, encoding: "utf8", env });
}

function runCompiler(root) {
  const r = spawnSync(process.execPath, [COMPILER, root], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function readBoard(root) {
  const loaded = readJsonFile(join(root, BOARD_REL));
  return loaded.ok ? loaded.value : null;
}

function readRunsDoc(root) {
  const loaded = readJsonFile(join(root, RUNS_REL));
  return loaded.ok ? loaded.value : null;
}

function boardMtimeMs(root) {
  try {
    return statSync(join(root, BOARD_REL)).mtimeMs;
  } catch {
    return null;
  }
}

/** 屏蔽动态 runId/at 后与字面期望对象比对（期望值来自契约，不借实现重算）。 */
function maskRun(rec) {
  const out = { ...(rec ?? {}) };
  if (typeof out.runId === "string" && RUN_ID_RE.test(out.runId)) out.runId = "<runId>";
  if (typeof out.at === "string" && ISO_RE.test(out.at)) out.at = "<at>";
  return out;
}

/** 收集全板卡片（含特性自身），供 attention/断点断言。 */
function allCards(board) {
  const out = [];
  for (const f of board?.features ?? []) {
    out.push(f);
    for (const t of f.tasks ?? []) out.push(t);
  }
  return out;
}

function cardByNo(board, no) {
  return allCards(board).find((c) => c.no === no) ?? null;
}

// ---------------------------------------------------------------- 夹具工具

let activeChecks = null;
function newRoot(tag) {
  const root = newRootRaw(tag);
  if (activeChecks) {
    activeChecks.root = root;
    say(`  夹具：${toPosix(root)}`);
    const base = resolve(tmpdir());
    activeChecks.ok(resolve(root).startsWith(`${base}/`), "夹具根位于系统临时目录（真实文件零触碰）");
  }
  return root;
}

/**
 * 最小 plan 夹具：文件头号 + 条目行尾号（号是身份，标记随行走）。
 * cardNo 为 null 时该条目未领号。
 */
function writePlanFixture(root, { featureNo = 5, cards = [{ no: 12, checked: false }], rel = ".zcode/plans/plan-sess_t13.md" } = {}) {
  const rows = ["# 甲计划" + (featureNo == null ? "" : ` <!-- zcode-board: no=${featureNo} -->`), ""];
  cards.forEach((c, i) => {
    rows.push(`- [${c.checked ? "x" : " "}] ${i + 1}. 甲任务${i + 1}` + (c.no == null ? "" : ` <!-- zcode-board: no=${c.no} -->`));
    rows.push(`  - 甲任务${i + 1}正文首行。`);
    rows.push("");
  });
  w(root, rel, rows.join("\n"));
  return rel;
}

/** 嵌套 plan 夹具（S4）：feature → task → subtask 三层；卡 #13 为深度 3 子卡。 */
function writeNestedPlanFixture(root, { rel = ".zcode/plans/plan-sess_t13-nested.md" } = {}) {
  w(root, rel, [
    "# 嵌套计划 <!-- zcode-board: no=5 -->",
    "",
    "- [ ] 1. 甲任务 <!-- zcode-board: no=12 -->",
    "  - 甲任务正文首行。",
    "  - [ ] 2. 甲子任务 <!-- zcode-board: no=13 -->",
    "    - 甲子任务正文首行。",
    "",
  ].join("\n"));
  return rel;
}

/** 最小 spec 夹具：tasks.md 全勾选 + progress.json 阶段（供 completed/待归档夹具）。 */
function writeSpecFixture(root, { name = "alpha", checked = true, oldDays = 0 } = {}) {
  w(root, `specs/${name}/tasks.md`, [
    `# ${name} 任务`,
    "",
    `- [${checked ? "x" : " "}] 1. 甲任务`,
    "  - Scope: 甲任务正文。",
    "",
  ].join("\n"));
  w(root, `specs/${name}/progress.json`, JSON.stringify({
    version: 3,
    feature: name,
    stages: { execution: { status: checked ? "completed" : "active" }, "code-review": { status: checked ? "completed" : "pending" } },
    tasks: [],
    blockers: [],
    activity: [],
  }, null, 2) + "\n");
  if (oldDays > 0) {
    setOldMtime(root, `specs/${name}/tasks.md`, oldDays);
    setOldMtime(root, `specs/${name}/progress.json`, oldDays);
  }
  return `specs/${name}`;
}

function setOldMtime(root, rel, days) {
  const t = new Date(Date.now() - days * 86400 * 1000);
  utimesSync(join(root, rel), t, t);
}

function writeRuns(root, runs) {
  w(root, RUNS_REL, JSON.stringify({ version: 1, runs }, null, 2) + "\n");
}

/** 一条最小 run 记录字面（测试夹具用；字段形态与 runs.template 对齐）。 */
function runRecord({ runId = "run-20261009-aaaa", sessionId = "sess_fixture", role = "implementer", at = "2026-10-09T10:00:00+08:00", result = "partial", cards = [12], worktree = null, branch = null, evidence = [], breakpoint = null }) {
  return { runId, sessionId, role, at, result, cards, worktree, branch, evidence, breakpoint };
}

/** 派发报告正文：含 run_event 代码块（正例形态）。 */
function reportText(blockLines, { tail = "其余叙述不落账。" } = {}) {
  return [
    "## 实施报告",
    "",
    "结论：见下。",
    "",
    "```json",
    ...(Array.isArray(blockLines) ? blockLines : [blockLines]),
    "```",
    "",
    tail,
  ].join("\n");
}

/** 完整前台 PostToolUse(Agent) payload（形态对齐 A5 evidence §2.2）。 */
function postToolUsePayload(root, report, { sessionId = "sess_T13_R1", status = "completed", toolName = "Agent" } = {}) {
  const toolResponse = status === "completed"
    ? {
        status: "completed",
        agentId: "agent_fixture",
        agentType: "implementer",
        description: "夹具派发",
        prompt: "夹具 prompt",
        content: [{ type: "text", text: report }],
        totalToolUseCount: 3,
        totalDurationMs: 1200,
        totalTokens: 900,
      }
    : {
        status: "async_launched",
        agentId: "agent_fixture",
        description: "夹具派发",
        prompt: "夹具 prompt",
        outputFile: "/tmp/zcode-fixture-output.txt",
        canReadOutputFile: true,
      };
  return {
    cwd: root,
    hookEventName: "PostToolUse",
    hook_event_name: "PostToolUse",
    mode: "agent",
    sessionId,
    session_id: sessionId,
    timestamp: "2026-10-09T15:00:00.000Z",
    traceId: "trace_fixture",
    turnId: "turn_fixture",
    toolCallId: "toolu_fixture",
    tool_name: toolName,
    toolName,
    tool_input: { description: "夹具派发", prompt: "夹具 prompt", subagent_type: "implementer" },
    tool_input_snake: undefined,
    tool_response: toolResponse,
    toolResultPreview: report.slice(0, 4000),
  };
}

function noTempFiles(c, root, label) {
  const dir = join(root, ".zcode", "board");
  if (!isDir(dir)) return c.ok(true, label, "目录不存在（无残留）");
  return c.eq(readdirSync(dir).filter((n) => n.startsWith(".")), [], label);
}

// ---------------------------------------------------------------- 用例定义

const TESTS = [];
function test(id, title, fn) {
  TESTS.push({ id, title, fn });
}

// ---- S1 静态：record-run 交付物形态

test("S1", "静态：record-run.mjs 存在、仅 node 内置/相对导入、语法可解析", (c) => {
  c.ok(isFile(RECORD_RUN), `record-run.mjs 存在（${toPosix(RECORD_RUN)}）`);
  if (isFile(RECORD_RUN)) {
    const src = readFileSync(RECORD_RUN, "utf8");
    const imports = [...src.matchAll(/^\s*import\s+[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    c.eq(imports.filter((s) => !s.startsWith("node:") && !s.startsWith("./") && !s.startsWith("../")), [], "仅 node 内置与相对导入（无第三方依赖）");
    const chk = spawnSync(process.execPath, ["--check", RECORD_RUN], { encoding: "utf8" });
    c.exit(chk, 0, "node --check 语法校验通过");
    const help = runHook(RECORD_RUN, "", { args: ["--help"] });
    c.exit(help, 0, "--help 退出码 0");
    c.ok(String(help.stdout ?? "").includes("run_event"), "--help 说明 run_event 落账形态");
  }
});

// ---- R1 场景 23：前台 PostToolUse payload → runs 追加 + 重编译

test("R1", "场景 23 前台：PostToolUse(Agent) payload → 落账一条 + 重编译后卡片 lastRun 四要素", (c) => {
  const root = newRoot("t13-r1");
  writePlanFixture(root, { featureNo: 5, cards: [{ no: 12 }] });
  const comp = runCompiler(root);
  c.exit(comp, 0, "前置编译退出码 0");
  const beforeMtime = boardMtimeMs(root);
  const report = reportText(
    '"run_event": { "role": "implementer", "result": "partial", "cards": [12], "stoppedAt": 12, "nextStep": "补 updater 单测后重新验证", "evidence": ["specs/preview-channel/updater.ts"] }',
  );
  const r = runHook(RECORD_RUN, postToolUsePayload(root, report));
  c.exit(r, 0, "前台 payload 退出码 0（hook 不阻塞主流程）");
  c.eq(String(r.stdout ?? ""), "", "stdout 为空（PostToolUse 无注入输出）");

  const doc = readRunsDoc(root);
  c.ok(doc !== null, "runs.json 可解析", String(readJsonFile(join(root, RUNS_REL)).error ?? ""));
  c.eq(doc?.version, 1, "runs.json version=1");
  c.eq(doc?.runs?.length, 1, "追加 1 条记录（一个块 = 一条记录）");
  const rec = doc?.runs?.[0] ?? {};
  c.ok(RUN_ID_RE.test(String(rec.runId)), "runId 由脚本补齐（run-<日期>-<短后缀>）", show(rec.runId));
  c.ok(ISO_RE.test(String(rec.at)), "at 为带时区 ISO 8601（机械时钟，不采报告自报）", show(rec.at));
  c.eq(rec.sessionId, "sess_T13_R1", "sessionId 取 payload 机械字段");
  c.eq(maskRun(rec), {
    runId: "<runId>",
    sessionId: "sess_T13_R1",
    role: "implementer",
    at: "<at>",
    result: "partial",
    cards: [12],
    worktree: null,
    branch: null,
    evidence: ["specs/preview-channel/updater.ts"],
    breakpoint: { stoppedAt: 12, next: "补 updater 单测后重新验证" },
  }, "记录逐字段（run-event.md §3 落账映射 + v2.1 勘误 #42：worktree/branch 未显式声明 → 缺省一律 null，不按卡号推导）");
  c.eq(Object.keys(rec), RUN_KEYS, "记录键序与契约字段表一致");

  c.ok(boardMtimeMs(root) > beforeMtime, "重编译触发（board.json mtime 前进）");
  const board = readBoard(root);
  const card = cardByNo(board, 12);
  c.ok(card !== null, "重编译后板上出现卡 #12");
  c.eq(card?.lastRun, { at: rec.at, role: "implementer", result: "partial", stoppedAt: 12, next: "补 updater 单测后重新验证" }, "卡片 lastRun 四要素（时间/result/停在#N/下一步）");
  noTempFiles(c, root, "原子写零残留（无 .*.tmp-*）");
});

// ---- R2 场景 23：后台代触发（裸报告 stdin）与前台零分叉

test("R2", "场景 23 后台代触发：裸报告 stdin（--cwd/--session-id）与前台形态产出同一记录", (c) => {
  const root = newRoot("t13-r2");
  writePlanFixture(root, { featureNo: 5, cards: [{ no: 12 }] });
  const report = reportText(
    '"run_event": { "role": "implementer", "result": "partial", "cards": [12], "stoppedAt": 12, "nextStep": "补 updater 单测后重新验证", "evidence": ["specs/preview-channel/updater.ts"] }',
  );
  const r = runHook(RECORD_RUN, report, { args: ["--cwd", root, "--session-id", "sess_T13_R1", "--tool-name", "Agent"] });
  c.exit(r, 0, "代触发退出码 0");
  const doc = readRunsDoc(root);
  c.eq(doc?.runs?.length, 1, "裸报告文本同样落账 1 条");
  c.eq(maskRun(doc?.runs?.[0]), {
    runId: "<runId>",
    sessionId: "sess_T13_R1",
    role: "implementer",
    at: "<at>",
    result: "partial",
    cards: [12],
    worktree: null,
    branch: null,
    evidence: ["specs/preview-channel/updater.ts"],
    breakpoint: { stoppedAt: 12, next: "补 updater 单测后重新验证" },
  }, "两形态零分叉：同一解析、同一落账映射（仅触发方式不同；未声明工作树一律 null，v2.1 勘误 #42）");
  const board = readBoard(root);
  c.eq(cardByNo(board, 12)?.lastRun?.result, "partial", "代触发同样触发重编译（板已更新）");
});

// ---- R3 场景 28：无 run_event 块 → 跳过落账 + diagnostics，板照常重编译

test("R3", "场景 28：报告无 run_event 块 → 跳过落账 + diagnostics 提醒、进程不失败、板照常重编译", (c) => {
  const root = newRoot("t13-r3");
  writePlanFixture(root, { featureNo: 5, cards: [{ no: 12 }] });
  const comp = runCompiler(root);
  c.exit(comp, 0, "前置编译退出码 0");
  const beforeMtime = boardMtimeMs(root);
  const r = runHook(RECORD_RUN, postToolUsePayload(root, "## 报告\n\n本轮没有 run_event 块。\n", { sessionId: "sess_T13_R3" }));
  c.exit(r, 0, "无块退出码 0（进程不失败）");
  c.ok(!isFile(join(root, RUNS_REL)), "runs.json 未创建（零落账）");
  c.ok(/run_event/.test(String(r.stderr ?? "")), "stderr 给出 run_event 缺失 diagnostics 提醒", show(String(r.stderr ?? "").slice(0, 300)));
  c.ok(boardMtimeMs(root) > beforeMtime, "板照常重编译（容错语义表）");
});

// ---- R4 场景 28：块内字段缺省不造 + 多块逐块落账

test("R4", "场景 28 缺省容错：仅有 role/result 的块落无卡事件；run_event 数组逐块落账", (c) => {
  const root = newRoot("t13-r4");
  writePlanFixture(root, { featureNo: 5, cards: [{ no: 12 }, { no: 13 }] });
  const report = reportText([
    '"run_event": { "role": "test-verifier", "result": "done" },',
    '"run_event": [',
    '  { "role": "implementer", "result": "partial", "cards": [13], "stoppedAt": 13, "nextStep": "继续" },',
    '  { "role": "code-reviewer", "result": "done", "cards": [13] }',
    "]",
  ]);
  const r = runHook(RECORD_RUN, report, { args: ["--cwd", root, "--session-id", "sess_T13_R4"] });
  c.exit(r, 0, "退出码 0");
  const doc = readRunsDoc(root);
  c.eq(doc?.runs?.length, 3, "一个块 = 一条记录（对象 + 数组共 3 条，互不合并）");
  const [a, b, cRec] = doc?.runs ?? [];
  c.eq(maskRun(a), {
    runId: "<runId>",
    sessionId: "sess_T13_R4",
    role: "test-verifier",
    at: "<at>",
    result: "done",
    cards: [],
    worktree: null,
    branch: null,
    evidence: [],
    breakpoint: null,
  }, "缺省容错：cards []/worktree null/branch null/evidence []/breakpoint null（不造字段值）");
  c.eq([b?.cards, b?.worktree, b?.breakpoint], [[13], null, { stoppedAt: 13, next: "继续" }], "数组第 1 块未声明工作树 → 缺省 null（v2.1 勘误 #42：不按卡号推导）");
  c.eq(cRec?.cards, [13], "数组第 2 块同样落账");
  const board = readBoard(root);
  c.eq(cardByNo(board, 13)?.lastRun?.role, "code-reviewer", "重编译后卡 #13 的 lastRun 取最新记录");
});

// ---- R5 A5 硬输入：async_launched 无报告 → 不落账 + diagnostics

test("R5", "async_launched 分支：后台启动 payload 无报告 → 不落账 + diagnostics，退出码 0", (c) => {
  const root = newRoot("t13-r5");
  writePlanFixture(root, { featureNo: 5, cards: [{ no: 12 }] });
  const payload = postToolUsePayload(root, "", { sessionId: "sess_T13_R5", status: "async_launched" });
  const r = runHook(RECORD_RUN, payload);
  c.exit(r, 0, "退出码 0");
  c.ok(!isFile(join(root, RUNS_REL)), "不落账（async_launched 分支无报告文本）");
  c.ok(/async_launched/.test(String(r.stderr ?? "")), "stderr 点名 async_launched 分支", show(String(r.stderr ?? "").slice(0, 300)));
});

// ---- R6 表外值与层级标签：跳过该块 / 丢弃该值 + diagnostics

test("R6", "表外 role 跳过该块；cards 层级标签丢弃不静默改写；均不失败", (c) => {
  const root = newRoot("t13-r6");
  const report = reportText([
    '"run_event": { "role": "architect", "result": "done" },',
    '"run_event": { "role": "implementer", "result": "partial", "cards": ["ID-1.2", 14], "stoppedAt": "1.2", "nextStep": "继续" }',
  ]);
  const r = runHook(RECORD_RUN, report, { args: ["--cwd", root, "--session-id", "sess_T13_R6"] });
  c.exit(r, 0, "退出码 0（容错落账不阻塞）");
  const doc = readRunsDoc(root);
  c.eq(doc?.runs?.length, 1, "表外 role 块被跳过（仅 1 条落账）");
  c.eq(doc?.runs?.[0]?.cards, [14], "层级标签丢弃、正整数保留（不静默改写）");
  c.eq(doc?.runs?.[0]?.breakpoint, { stoppedAt: null, next: "继续" }, "stoppedAt 非法 → null（不猜卡号）；nextStep 照抄");
  c.ok((String(r.stderr ?? "").match(/diagnostics|表外|非法|丢弃|层级/g) ?? []).length >= 2, "stderr 给出两类 diagnostics", show(String(r.stderr ?? "").slice(0, 400)));
});

// ---- R7 落账失败不阻塞：损坏 runs.json 字节不变

test("R7", "损坏 runs.json：拒绝落账、字节不变、退出码 0（hook 失败永不阻塞主流程）", (c) => {
  const root = newRoot("t13-r7");
  const broken = '{\n  "version": 1,\n  "runs": [\n';
  w(root, RUNS_REL, broken);
  const report = reportText('"run_event": { "role": "implementer", "result": "done", "cards": [14] }');
  const r = runHook(RECORD_RUN, report, { args: ["--cwd", root, "--session-id", "sess_T13_R7"] });
  c.exit(r, 0, "退出码 0");
  c.eq(readFileSync(join(root, RUNS_REL), "utf8"), broken, "损坏文件字节不变（不丢数据、不覆盖）");
  c.ok(String(r.stderr ?? "").trim().length > 0, "stderr 非空（诊断不静默）");
});

// ---- R8 极端输入：空 stdin / 无地址参数

test("R8", "极端输入：空 stdin 与无可解析文本 → 退出码 0 + diagnostics（不崩溃）", (c) => {
  const root = newRoot("t13-r8");
  const empty = runHook(RECORD_RUN, "", { args: ["--cwd", root] });
  c.exit(empty, 0, "空 stdin 退出码 0");
  c.ok(String(empty.stderr ?? "").trim().length > 0, "空 stdin 有 diagnostics");
  const payload = postToolUsePayload(root, "", { sessionId: "sess_T13_R8" });
  payload.tool_response = { status: "completed" };
  const noText = runHook(RECORD_RUN, payload);
  c.exit(noText, 0, "completed 但无 content 文本：退出码 0");
  c.ok(!isFile(join(root, RUNS_REL)), "无可解析文本时零落账");
  noTempFiles(c, root, "零残留");
});

// ---- S2 静态：board-context 交付物形态

test("S2", "静态：board-context.mjs 存在、仅 node 内置/相对导入、语法可解析", (c) => {
  c.ok(isFile(BOARD_CONTEXT), `board-context.mjs 存在（${toPosix(BOARD_CONTEXT)}）`);
  if (isFile(BOARD_CONTEXT)) {
    const src = readFileSync(BOARD_CONTEXT, "utf8");
    const imports = [...src.matchAll(/^\s*import\s+[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    c.eq(imports.filter((s) => !s.startsWith("node:") && !s.startsWith("./") && !s.startsWith("../")), [], "仅 node 内置与相对导入（无第三方依赖）");
    c.exit(spawnSync(process.execPath, ["--check", BOARD_CONTEXT], { encoding: "utf8" }), 0, "node --check 语法校验通过");
  }
});

/** 断言 stdout 是"单个 JSON 对象 + additionalContext 字符串"（A6 注入契约）。 */
function assertSingleJsonContext(c, r, label) {
  const out = String(r.stdout ?? "").trim();
  c.ok(out.startsWith("{") && out.endsWith("}"), `${label}：stdout 为单个 JSON 对象（首尾 { }，无杂散输出）`, show(out.slice(0, 200)));
  let parsed = null;
  try {
    parsed = JSON.parse(out);
  } catch (e) {
    c.ok(false, `${label}：JSON 可解析（${e.message}）`);
    return "";
  }
  c.ok(parsed !== null && typeof parsed === "object" && typeof parsed.additionalContext === "string", `${label}：additionalContext 为字符串`, show(Object.keys(parsed ?? {})));
  return typeof parsed?.additionalContext === "string" ? parsed.additionalContext : "";
}

function sessionStartPayload(root, { sessionId = "sess_T13_B", source = "startup" } = {}) {
  return {
    cwd: root,
    hookEventName: "SessionStart",
    hook_event_name: "SessionStart",
    mode: "agent",
    sessionId,
    session_id: sessionId,
    source,
    timestamp: "2026-10-09T15:30:00.000Z",
    traceId: "trace_fixture",
    turnId: "turn_fixture",
  };
}

test("B1", "SessionStart：缺口摘要 + 断点 top-N（停在 #N + 下一步）经单 JSON additionalContext 注入", (c) => {
  const root = newRoot("t13-b1");
  writePlanFixture(root, { featureNo: 5, cards: [{ no: 12 }, { no: 13 }] });
  // 零卡计划稿（#53 契约 v2.3：有派生卡的计划稿不再挂 arranged-not-expanded，零卡稿仍挂）——
  // 保持"已安排未展开 1"的非零计数，持续验证摘要取自 attentionSummary（而非恒零模板）。
  w(root, ".zcode/plans/plan-sess_t13-empty.md", "# 未拆解计划 <!-- zcode-board: no=6 -->\n\n（本稿无可识别任务语法）\n");
  writeRuns(root, [
    runRecord({ sessionId: "sess_fixture", cards: [12], worktree: ".zcode/worktrees/task-12", branch: "task-12", breakpoint: { stoppedAt: 12, next: "补 updater 单测后重新验证" } }),
  ]);
  const comp = runCompiler(root);
  c.exit(comp, 0, "前置编译退出码 0");
  const r = runHook(BOARD_CONTEXT, sessionStartPayload(root));
  c.exit(r, 0, "退出码 0（注入型 hook 不阻塞）");
  const ctx = assertSingleJsonContext(c, r, "SessionStart");
  c.ok(/\[zcode-board\]/.test(ctx), "摘要带看板前缀标识", show(ctx.slice(0, 120)));
  c.ok(/缺口/.test(ctx) && /已访谈未安排/.test(ctx) && /执行中断可续/.test(ctx), "含四缺口计数摘要", show(ctx.slice(0, 400)));
  c.ok(/#12/.test(ctx) && /停在 #12/.test(ctx) && /补 updater 单测后重新验证/.test(ctx), "含断点（停在 #N + 下一步一句话）", show(ctx.slice(0, 600)));
  c.ok(/已安排未展开 1/.test(ctx), "缺口计数取自 attentionSummary（arrangedNotExpanded=1）", show(ctx.slice(0, 400)));
  c.ok(Buffer.byteLength(String(r.stdout), "utf8") <= OUTPUT_BYTE_BUDGET, `输出 ≤ ${OUTPUT_BYTE_BUDGET} 字节（A6 预算）`);
});

test("B2", "SessionStart 空态：board.json 不存在 → 单 JSON 空态提示，不阻塞", (c) => {
  const root = newRoot("t13-b2");
  const r = runHook(BOARD_CONTEXT, sessionStartPayload(root));
  c.exit(r, 0, "退出码 0");
  const ctx = assertSingleJsonContext(c, r, "无板空态");
  c.ok(/board\.json/.test(ctx) && /(不存在|未生成|没有看板)/.test(ctx), "空态文案点名无板（A 空态）", show(ctx));
  // #72：生成板之前先引导核对扫描面（人工核对 + --check 只读；--preflight 本体归 #73）
  c.ok(/扫描面/.test(ctx) && /scan\.json/.test(ctx), "空态文案先引导核对扫描面（默认 .zcode/plans；docs 计划目录需 scan.json opt-in）", show(ctx));
  c.ok(/--check/.test(ctx), "空态文案给只读核对命令（--check，不先写板）", show(ctx));
  c.ok(!/preflight/.test(ctx) || /#73/.test(ctx), "未落地的 --preflight 若被提及须注明归 #73（不冒充可用命令）", show(ctx));
});

test("B3", "SessionStart 损坏态：坏 JSON / 结构非法 → 单 JSON 提示重建，不阻塞", (c) => {
  const root = newRoot("t13-b3");
  w(root, BOARD_REL, '{\n  "version": 2,\n  "features": [\n');
  const r1 = runHook(BOARD_CONTEXT, sessionStartPayload(root));
  c.exit(r1, 0, "坏 JSON 退出码 0");
  const ctx1 = assertSingleJsonContext(c, r1, "损坏态");
  c.ok(/(损坏|无法读取|重建)/.test(ctx1), "损坏态文案提示重建（C 空态）", show(ctx1));

  w(root, BOARD_REL, JSON.stringify({ version: 2, features: "nope" }, null, 2) + "\n");
  const r2 = runHook(BOARD_CONTEXT, sessionStartPayload(root));
  c.exit(r2, 0, "结构非法退出码 0");
  const ctx2 = assertSingleJsonContext(c, r2, "结构非法态");
  c.ok(/(损坏|无法读取|重建)/.test(ctx2), "结构非法同样走损坏态文案", show(ctx2));
});

test("B4", "SessionStart 输出自检：超预算时截断 additionalContext 保 JSON 完整（≤20KB 且 ≤24k 字符）", (c) => {
  const root = newRoot("t13-b4");
  writePlanFixture(root, { featureNo: 5, cards: [{ no: 12 }] });
  writeRuns(root, [
    runRecord({ cards: [12], worktree: ".zcode/worktrees/task-12", branch: "task-12", breakpoint: { stoppedAt: 12, next: "甲".repeat(9000) } }),
  ]);
  const comp = runCompiler(root);
  c.exit(comp, 0, "前置编译退出码 0");
  const r = runHook(BOARD_CONTEXT, sessionStartPayload(root));
  c.exit(r, 0, "退出码 0");
  const ctx = assertSingleJsonContext(c, r, "超预算");
  const bytes = Buffer.byteLength(String(r.stdout), "utf8");
  c.ok(bytes <= OUTPUT_BYTE_BUDGET, `输出字节 ≤ ${OUTPUT_BYTE_BUDGET}（超限=静默全丢，脚本须自截断）`, `实际 ${bytes}`);
  c.ok(ctx.length <= OUTPUT_CHAR_BUDGET, `additionalContext 字符数 ≤ ${OUTPUT_CHAR_BUDGET}（24k 注入闸）`, `实际 ${ctx.length}`);
  c.ok(/截断/.test(ctx), "截断时给出截断标记", show(ctx.slice(-160)));
});

test("B5", "SessionStart：上次对账 last-reconcile.md 摘要进入注入", (c) => {
  const root = newRoot("t13-b5");
  writePlanFixture(root, { featureNo: 5, cards: [{ no: 12 }] });
  const comp = runCompiler(root);
  c.exit(comp, 0, "前置编译退出码 0");
  w(root, LAST_RECONCILE_REL, [
    "# 收尾对账（Stop hook）",
    "",
    "- 时间：2026-10-09T23:00:00+08:00",
    "- 结论：点名 2 项（未登记 0 / 未合并 1 / 板陈旧 1 / 待归档 0）",
    "",
  ].join("\n"));
  const r = runHook(BOARD_CONTEXT, sessionStartPayload(root));
  c.exit(r, 0, "退出码 0");
  const ctx = assertSingleJsonContext(c, r, "上次对账");
  c.ok(/上次对账/.test(ctx) && /点名 2 项/.test(ctx), "注入上次对账摘要（结论行）", show(ctx.slice(0, 800)));
});

test("B6", "SessionStart 递归遍历（S4）：深度 3 嵌套卡（feature→task→subtask）的断点同样注入", (c) => {
  const root = newRoot("t13-b6");
  writeNestedPlanFixture(root);
  writeRuns(root, [
    runRecord({ cards: [13], worktree: ".zcode/worktrees/task-13", branch: "task-13", breakpoint: { stoppedAt: 13, next: "继续子任务" } }),
  ]);
  const comp = runCompiler(root);
  c.exit(comp, 0, "前置编译退出码 0");
  const board = readBoard(root);
  const nested = board?.features?.[0]?.tasks?.[0]?.tasks?.[0];
  c.eq([nested?.no, nested?.title], [13, "甲子任务"], "夹具确认：卡 #13 位于深度 3（feature→task→subtask）");
  c.ok((nested?.attention ?? []).includes("interrupted-resume"), "夹具确认：深度 3 卡挂 interrupted-resume", show(nested?.attention));
  const r = runHook(BOARD_CONTEXT, sessionStartPayload(root));
  c.exit(r, 0, "退出码 0");
  const ctx = assertSingleJsonContext(c, r, "嵌套断点");
  c.ok(
    /#13/.test(ctx) && /停在 #13/.test(ctx) && /继续子任务/.test(ctx),
    "注入含深度 3 嵌套卡断点（停在 #N + 下一步）",
    show(ctx.slice(0, 800)),
  );
});

// ---- S3 静态：watch-sources 交付物形态

test("S3", "静态：watch-sources.mjs 存在、仅 node 内置/相对导入、语法可解析", (c) => {
  c.ok(isFile(WATCH_SOURCES), `watch-sources.mjs 存在（${toPosix(WATCH_SOURCES)}）`);
  if (isFile(WATCH_SOURCES)) {
    const src = readFileSync(WATCH_SOURCES, "utf8");
    const imports = [...src.matchAll(/^\s*import\s+[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    c.eq(imports.filter((s) => !s.startsWith("node:") && !s.startsWith("./") && !s.startsWith("../")), [], "仅 node 内置与相对导入（无第三方依赖）");
    c.exit(spawnSync(process.execPath, ["--check", WATCH_SOURCES], { encoding: "utf8" }), 0, "node --check 语法校验通过");
  }
});

function writeHookPayload(root, filePath, { toolName = "Write", sessionId = "sess_T13_W" } = {}) {
  return {
    cwd: root,
    hookEventName: "PostToolUse",
    hook_event_name: "PostToolUse",
    mode: "agent",
    sessionId,
    session_id: sessionId,
    tool_name: toolName,
    toolName,
    toolCallId: "toolu_fixture",
    tool_input: { file_path: filePath, content: "…" },
    tool_input_snake: undefined,
  };
}

test("W1", "场景 29：真相源（specs/<f>/tasks.md）变更 → 自动重编译（board.json mtime 前进）", (c) => {
  const root = newRoot("t13-w1");
  writeSpecFixture(root, { name: "alpha", checked: false });
  const comp = runCompiler(root);
  c.exit(comp, 0, "前置编译退出码 0");
  const beforeMtime = boardMtimeMs(root);
  w(root, "specs/alpha/tasks.md", ["# alpha 任务", "", "- [x] 1. 甲任务", "  - Scope: 甲任务正文。", ""].join("\n"));
  const r = runHook(WATCH_SOURCES, writeHookPayload(root, join(root, "specs/alpha/tasks.md")));
  c.exit(r, 0, "hook 退出码 0（async 重编译，不阻塞）");
  c.ok(boardMtimeMs(root) > beforeMtime, "board.json 被重写（mtime 前进）");
  const board = readBoard(root);
  c.eq((board?.features ?? []).map((f) => f.id), ["spec:alpha"], "重编译后板上出现 spec 特性节点");
});

test("W2", "场景 29 反向：无关路径（README.md）变更 → 不触发重编译", (c) => {
  const root = newRoot("t13-w2");
  writeSpecFixture(root, { name: "alpha" });
  const comp = runCompiler(root);
  c.exit(comp, 0, "前置编译退出码 0");
  const beforeMtime = boardMtimeMs(root);
  const beforeBytes = readFileSync(join(root, BOARD_REL), "utf8");
  w(root, "README.md", "# 与板无关\n");
  const r = runHook(WATCH_SOURCES, writeHookPayload(root, join(root, "README.md")));
  c.exit(r, 0, "退出码 0");
  c.eq(boardMtimeMs(root), beforeMtime, "board.json 未被重写（非真相源路径不触发）");
  c.eq(readFileSync(join(root, BOARD_REL), "utf8"), beforeBytes, "board.json 字节不变");
});

test("W3", "新增计划稿（尚未进 sources[]）→ 归属计划目录仍触发重编译（新文件不落空洞）", (c) => {
  const root = newRoot("t13-w3");
  writeSpecFixture(root, { name: "alpha" });
  const comp = runCompiler(root);
  c.exit(comp, 0, "前置编译退出码 0");
  const beforeMtime = boardMtimeMs(root);
  const planRel = ".zcode/plans/plan-sess_t13-new.md";
  w(root, planRel, ["# 新计划", "", "- [ ] 1. 新任务", "  - 正文。", ""].join("\n"));
  const r = runHook(WATCH_SOURCES, writeHookPayload(root, join(root, planRel), { toolName: "Edit" }));
  c.exit(r, 0, "Exit 工具同样触发（matcher Write|Edit）");
  c.ok(boardMtimeMs(root) > beforeMtime, "新计划稿触发重编译（按计划目录归属判定，不依赖旧 sources[]）");
  const board = readBoard(root);
  c.ok((board?.features ?? []).some((f) => f.origin?.type === "plan-session"), "重编译后新计划节点在板上");
});

test("W4", "runs.json（第一方源）变更 → 触发重编译；相对路径 file_path 亦可解析", (c) => {
  const root = newRoot("t13-w4");
  writePlanFixture(root, { featureNo: 5, cards: [{ no: 12 }] });
  const comp = runCompiler(root);
  c.exit(comp, 0, "前置编译退出码 0");
  const beforeMtime = boardMtimeMs(root);
  w(root, RUNS_REL, JSON.stringify({ version: 1, runs: [runRecord({ cards: [12], worktree: ".zcode/worktrees/task-12", branch: "task-12" })] }, null, 2) + "\n");
  mkdirSync(join(root, ".zcode", "worktrees", "task-12"), { recursive: true }); // #42：现场 = 字段命中 + 目录真实存在
  const r = runHook(WATCH_SOURCES, writeHookPayload(root, RUNS_REL)); // 相对路径形态
  c.exit(r, 0, "退出码 0");
  c.ok(boardMtimeMs(root) > beforeMtime, "runs.json 变更触发重编译（相对 file_path 归一）");
  c.eq(cardByNo(readBoard(root), 12)?.worktree, ".zcode/worktrees/task-12", "重编译后卡片 worktree 更新");
});

test("W5", "极端输入：空 stdin / 无 file_path → 退出码 0，不触碰板", (c) => {
  const root = newRoot("t13-w5");
  writeSpecFixture(root, { name: "alpha" });
  const comp = runCompiler(root);
  c.exit(comp, 0, "前置编译退出码 0");
  const beforeMtime = boardMtimeMs(root);
  const empty = runHook(WATCH_SOURCES, "");
  c.exit(empty, 0, "空 stdin 退出码 0");
  const noFile = runHook(WATCH_SOURCES, { cwd: root, tool_name: "Write", tool_input: {} });
  c.exit(noFile, 0, "无 file_path 退出码 0");
  c.eq(boardMtimeMs(root), beforeMtime, "未触发重编译（板 mtime 不变）");
});

test("W6", "#72：watch-sources 形态路随 scan.json 解析——未 opt-in 的 docs 计划目录变更不触发；opt-in 后触发；excludeGlobs 命中不触发", (c) => {
  const root = newRoot("t13-w6");
  writeSpecFixture(root, { name: "alpha" });
  c.exit(runCompiler(root), 0, "前置编译退出码 0");

  // 未 opt-in：docs/design-notes 变更 → 不触发（与编译器默认扫描面同源）
  const noteRel = "docs/design-notes/note-new.md";
  w(root, noteRel, ["# 历史档", "", "- [ ] 1. 事项", ""].join("\n"));
  const beforeA = boardMtimeMs(root);
  const rA = runHook(WATCH_SOURCES, writeHookPayload(root, join(root, noteRel)));
  c.exit(rA, 0, "未 opt-in：hook 退出码 0");
  c.eq(boardMtimeMs(root), beforeA, "未 opt-in：docs/design-notes 变更不触发重编译（非真相源）");

  // opt-in 后：同一目录变更 → 触发重编译并上板
  w(root, ".zcode/board/scan.json", JSON.stringify({ includeDirs: ["docs/design-notes"] }, null, 2) + "\n");
  const beforeB = boardMtimeMs(root);
  w(root, noteRel, ["# 历史档 改", "", "- [ ] 1. 事项改", ""].join("\n"));
  const rB = runHook(WATCH_SOURCES, writeHookPayload(root, join(root, noteRel)));
  c.exit(rB, 0, "opt-in 后：hook 退出码 0");
  c.ok(boardMtimeMs(root) > beforeB, "opt-in 后：docs/design-notes 变更触发重编译");
  c.ok(
    (readBoard(root)?.features ?? []).some((f) => f.title === "历史档 改"),
    "重编译后该目录计划稿上板（hook 与编译器扫描面同源）",
  );

  // excludeGlobs 命中：不触发（被排除文件不是真相源）
  w(root, ".zcode/board/scan.json", JSON.stringify({ includeDirs: ["docs/design-notes"], excludeGlobs: ["docs/design-notes/wip-*.md"] }, null, 2) + "\n");
  const wipRel = "docs/design-notes/wip-draft.md";
  w(root, wipRel, ["# 草稿档", "", "- [ ] 1. 事项", ""].join("\n"));
  const beforeC = boardMtimeMs(root);
  const rC = runHook(WATCH_SOURCES, writeHookPayload(root, join(root, wipRel)));
  c.exit(rC, 0, "excludeGlobs 命中：hook 退出码 0");
  c.eq(boardMtimeMs(root), beforeC, "excludeGlobs 命中的变更不触发重编译（与编译器排除面一致）");
});

// ---- S4 静态：reconcile-stop 交付物形态
test("S4", "静态：reconcile-stop.mjs 存在、仅 node 内置/相对导入、语法可解析", (c) => {
  c.ok(isFile(RECONCILE_STOP), `reconcile-stop.mjs 存在（${toPosix(RECONCILE_STOP)}）`);
  if (isFile(RECONCILE_STOP)) {
    const src = readFileSync(RECONCILE_STOP, "utf8");
    const imports = [...src.matchAll(/^\s*import\s+[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    c.eq(imports.filter((s) => !s.startsWith("node:") && !s.startsWith("./") && !s.startsWith("../")), [], "仅 node 内置与相对导入（无第三方依赖）");
    c.exit(spawnSync(process.execPath, ["--check", RECONCILE_STOP], { encoding: "utf8" }), 0, "node --check 语法校验通过");
  }
});

function stopPayload(root, responseText, { sessionId = "sess_T13_C" } = {}) {
  return {
    cwd: root,
    hookEventName: "Stop",
    hook_event_name: "Stop",
    mode: "agent",
    sessionId,
    session_id: sessionId,
    responseText,
    last_assistant_message: responseText,
    stopHookActive: false,
    toolCallCount: 12,
    timestamp: "2026-10-09T15:45:00.000Z",
    traceId: "trace_fixture",
    turnId: "turn_fixture",
  };
}

function readReconcile(root) {
  const p = join(root, LAST_RECONCILE_REL);
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** 四类齐备夹具：待归档 spec（old）+ 未合并卡 #12 + 板陈旧 runs.json + 未登记 run_event。 */
function fourClassFixture(root) {
  writeSpecFixture(root, { name: "beta", checked: true, oldDays: 10 });
  writePlanFixture(root, { featureNo: 5, cards: [{ no: 12 }, { no: 13 }] });
  writeRuns(root, [
    runRecord({ sessionId: "sess_fixture", cards: [12], worktree: ".zcode/worktrees/task-12", branch: "task-12", breakpoint: { stoppedAt: 12, next: "补单测" } }),
  ]);
  mkdirSync(join(root, ".zcode", "worktrees", "task-12"), { recursive: true }); // #42：未合并现场须经 fs 互证（目录真实存在）才计入缺口
  const comp = runCompiler(root);
  // 板陈旧：编译后把 runs.json mtime 推到未来（模拟编译之后源又变了）
  const future = new Date(Date.now() + 60_000);
  utimesSync(join(root, RUNS_REL), future, future);
  return comp;
}

test("C1", "Stop：点名四类（未登记/未合并/板陈旧/待归档）写 last-reconcile.md，不强推续跑", (c) => {
  const root = newRoot("t13-c1");
  const comp = fourClassFixture(root);
  c.exit(comp, 0, "前置编译退出码 0");
  const responseText = reportText([
    '"run_event": { "role": "debugger", "result": "done", "cards": [7], "evidence": [".zcode/board/evidence/T13/x.md"] }',
    '"run_event": { "role": "implementer", "result": "partial", "cards": [12], "stoppedAt": 12 }',
  ], { tail: "收尾叙述。" });
  const r = runHook(RECONCILE_STOP, stopPayload(root, responseText));
  c.exit(r, 0, "退出码 0（Stop 显式 0：exit 2 会意外触发续跑）");
  c.eq(String(r.stdout ?? "").trim(), "", "stdout 为空（不强推续跑：无 continue/decision JSON）");

  const md = readReconcile(root);
  c.ok(md !== null, `对账正文写入 ${LAST_RECONCILE_REL}`);
  c.ok(/- 结论：点名 4 项（未登记 1 \/ 未合并 1 \/ 板陈旧 1 \/ 待归档 1）/.test(String(md)), "结论行四类计数齐备", show(String(md).split("\n").slice(0, 6)));
  c.ok(/## 1\.\s*未登记[\s\S]*?debugger[\s\S]*?#7/.test(String(md)), "未登记：点名 responseText 中未落账的 run_event（debugger #7）", show(String(md).slice(0, 1600)));
  c.ok(/## 2\.\s*未合并[\s\S]*?#12/.test(String(md)), "未合并：点名 unmerged-worktree 卡 #12", show(String(md).slice(0, 1600)));
  c.ok(/## 3\.\s*板陈旧[\s\S]*?runs\.json/.test(String(md)), "板陈旧：点名 mtime 新于 board.updatedAt 的源（runs.json）", show(String(md).slice(0, 1600)));
  c.ok(/## 4\.\s*待归档[\s\S]*?beta/.test(String(md)), "待归档：点名 completed 且超 7 天冷却的特性（beta）", show(String(md).slice(0, 1600)));
  c.ok(/只点名不移动|hook 只点名/.test(String(md)), "待归档注明 hook 只点名、移动归编排者（勘误 10）");
  c.ok(String(md).includes("2026-"), "对账文件含时间戳");
});

test("C2", "Stop 负例对照：已落账的 run_event 不点名；四类均无时结论明确", (c) => {
  const root = newRoot("t13-c2");
  writePlanFixture(root, { featureNo: 5, cards: [{ no: 12 }] });
  writeRuns(root, [runRecord({ sessionId: "sess_fixture", cards: [12], breakpoint: { stoppedAt: 12, next: "补单测" } })]);
  const comp = runCompiler(root);
  c.exit(comp, 0, "前置编译退出码 0");
  // 板陈旧噪音控制：使 runs.json mtime 不新于 board.updatedAt（编译刚刚读过全部源）
  const responseText = reportText('"run_event": { "role": "implementer", "result": "partial", "cards": [12], "stoppedAt": 12 }');
  const r = runHook(RECONCILE_STOP, stopPayload(root, responseText));
  c.exit(r, 0, "退出码 0");
  const md = String(readReconcile(root) ?? "");
  c.ok(/## 1\.\s*未登记[\s\S]*?（无）/.test(md), "已落账的 run_event 不点名（负例对照）", show(md.slice(0, 1600)));
  c.ok(/- 结论：四类均无（对账通过）/.test(md), "四类均无时结论明确（对账通过）", show(md.split("\n").slice(0, 6)));
});

test("C3", "Stop 空态：board.json 缺失 → 对账文件写明无板、退出码 0", (c) => {
  const root = newRoot("t13-c3");
  const r = runHook(RECONCILE_STOP, stopPayload(root, "收尾。"));
  c.exit(r, 0, "退出码 0");
  const md = String(readReconcile(root) ?? "");
  c.ok(/board\.json/.test(md) && /(缺失|不存在)/.test(md), "文件写明板缺失（无法对账板侧三类）", show(md.slice(0, 800)));
});

test("C4", "Stop 损坏态：board.json 坏 JSON → 不崩溃、退出码 0、文件写明损坏", (c) => {
  const root = newRoot("t13-c4");
  w(root, BOARD_REL, "{ 坏 JSON");
  const r = runHook(RECONCILE_STOP, stopPayload(root, "收尾。"));
  c.exit(r, 0, "退出码 0");
  c.ok(String(r.stdout ?? "").trim() === "", "stdout 为空");
  const md = String(readReconcile(root) ?? "");
  c.ok(/(损坏|无法读取)/.test(md), "文件写明板损坏", show(md.slice(0, 800)));
});

test("C5", "Stop 递归遍历（S4）：深度 3 嵌套卡（feature→task→subtask）的未合并现场同样点名", (c) => {
  const root = newRoot("t13-c5");
  writeNestedPlanFixture(root);
  writeRuns(root, [
    runRecord({ cards: [13], worktree: ".zcode/worktrees/task-13", branch: "task-13", breakpoint: { stoppedAt: 13, next: "继续子任务" } }),
  ]);
  mkdirSync(join(root, ".zcode", "worktrees", "task-13"), { recursive: true }); // #42：现场 = 字段命中 + 目录真实存在
  const comp = runCompiler(root);
  c.exit(comp, 0, "前置编译退出码 0");
  const board = readBoard(root);
  const nested = board?.features?.[0]?.tasks?.[0]?.tasks?.[0];
  c.eq([nested?.no, nested?.title], [13, "甲子任务"], "夹具确认：卡 #13 位于深度 3（feature→task→subtask）");
  c.ok((nested?.attention ?? []).includes("unmerged-worktree"), "夹具确认：深度 3 卡挂 unmerged-worktree", show(nested?.attention));
  const r = runHook(RECONCILE_STOP, stopPayload(root, "收尾。"));
  c.exit(r, 0, "退出码 0");
  c.eq(String(r.stdout ?? "").trim(), "", "stdout 为空（R3：不强推续跑）");
  const md = String(readReconcile(root) ?? "");
  c.ok(/## 2\.\s*未合并[\s\S]*?#13/.test(md), "未合并：点名深度 3 嵌套卡 #13", show(md.slice(0, 1600)));
});

// ---- S5 静态：gate-merge 交付物形态

test("S5", "静态：gate-merge.mjs 存在、仅 node 内置/相对导入、语法可解析", (c) => {
  c.ok(isFile(GATE_MERGE), `gate-merge.mjs 存在（${toPosix(GATE_MERGE)}）`);
  if (isFile(GATE_MERGE)) {
    const src = readFileSync(GATE_MERGE, "utf8");
    const imports = [...src.matchAll(/^\s*import\s+[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    c.eq(imports.filter((s) => !s.startsWith("node:") && !s.startsWith("./") && !s.startsWith("../")), [], "仅 node 内置与相对导入（无第三方依赖）");
    c.exit(spawnSync(process.execPath, ["--check", GATE_MERGE], { encoding: "utf8" }), 0, "node --check 语法校验通过");
  }
});

function git(root, args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8" });
}

/** 夹具：真 git 仓库（main 检出 + 一个提交）。 */
function initGitRepo(root) {
  const r1 = git(root, ["init", "-q", "-b", "main"]);
  if (r1.status !== 0) git(root, ["init", "-q"]);
  w(root, "README.md", "# fixture\n");
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.email=t13@fixture", "-c", "user.name=t13", "commit", "-qm", "init"]);
  return root;
}

function preToolUsePayload(root, command, { sessionId = "sess_T13_G" } = {}) {
  return {
    cwd: root,
    hookEventName: "PreToolUse",
    hook_event_name: "PreToolUse",
    mode: "agent",
    sessionId,
    session_id: sessionId,
    toolCallId: "toolu_fixture",
    tool_name: "Bash",
    toolName: "Bash",
    tool_input: { command },
    tool_input_snake: undefined,
  };
}

test("G1", "场景 27 半场：目标为 base 且缺 code-reviewer approved → 拦截（exit 2）并提示缺失绿与补齐路径", (c) => {
  const root = newRoot("t13-g1");
  initGitRepo(root);
  writeRuns(root, [runRecord({ role: "test-verifier", result: "done", cards: [12] })]);
  const r = runHook(GATE_MERGE, preToolUsePayload(root, 'git merge --no-ff task-12 -m "Merge task-12 [#12]"'));
  c.exit(r, 2, "PreToolUse 阻断（退出码 2 → permissionDecision deny）");
  const err = String(r.stderr ?? "");
  c.ok(/code-reviewer/.test(err), "点名缺失绿（code-reviewer verdict = approved）", show(err.slice(0, 400)));
  c.ok(/(补齐|派发|record-run)/.test(err), "给出补齐路径（派发 code-reviewer → run_event → 落账）", show(err.slice(0, 700)));
  c.ok(/test-verifier/.test(err) && /(在位|已具备|通过)/.test(err), "列出已具备的绿（test-verifier pass）", show(err.slice(0, 700)));
  c.ok(/rebase|第三绿/.test(err), "说明第三绿由 integrator 执行时机械验证", show(err.slice(0, 700)));
  c.ok(String(r.stdout ?? "").trim() === "", "stdout 为空（阻断原因走 stderr）");
});

test("G2", "场景 27 半场反向：两绿证据在位 → 放行（exit 0，无阻断输出）", (c) => {
  const root = newRoot("t13-g2");
  initGitRepo(root);
  writeRuns(root, [
    runRecord({ role: "test-verifier", result: "done", cards: [12] }),
    runRecord({ role: "code-reviewer", result: "done", cards: [12] }),
  ]);
  const r = runHook(GATE_MERGE, preToolUsePayload(root, 'git merge --no-ff task-12 -m "Merge task-12 [#12]"'));
  c.exit(r, 0, "放行（exit 0）");
  c.ok(String(r.stdout ?? "").trim() === "", "stdout 为空（不注入）");
});

test("G3", "feature 间合并不拦：卡片工作树内 merge（无证据）→ 放行", (c) => {
  const root = newRoot("t13-g3");
  initGitRepo(root);
  const wt = join(root, ".zcode", "worktrees", "task-12");
  const add = git(root, ["worktree", "add", "-q", ".zcode/worktrees/task-12", "-b", "task-12"]);
  c.exit(add, 0, "前置：git worktree add 成功");
  c.ok(isFile(join(wt, ".git")), "工作树 .git 为文件（gitdir: 指针）");
  const r = runHook(GATE_MERGE, preToolUsePayload(wt, 'git merge feature-x -m "feature 间合并"'));
  c.exit(r, 0, "工作树内（feature 分支间）合并不拦");
});

test("G4", "目标为 base 但无法按 task-<no> 归卡 → 拦截并给出命名去路", (c) => {
  const root = newRoot("t13-g4");
  initGitRepo(root);
  const r = runHook(GATE_MERGE, preToolUsePayload(root, 'git merge topic-x -m "merge topic"'));
  c.exit(r, 2, "拦截（无法核验三绿）");
  c.ok(/task-<no>|task-12|命名/.test(String(r.stderr ?? "")), "给出 task-<no> 命名去路", show(String(r.stderr ?? "").slice(0, 600)));
});

test("G5", "push 目标判定：push base 拦截；push 卡片分支放行；merge --abort 放行", (c) => {
  const root = newRoot("t13-g5");
  initGitRepo(root);
  const pushBase = runHook(GATE_MERGE, preToolUsePayload(root, "git push origin main"));
  c.exit(pushBase, 2, "push 目标 base（main）→ 拦截");
  c.ok(/(PR|integrator|git merge)/.test(String(pushBase.stderr ?? "")), "阻断文案给出远程模式去路（经 PR 集成）", show(String(pushBase.stderr ?? "").slice(0, 500)));
  const pushBare = runHook(GATE_MERGE, preToolUsePayload(root, "git push"));
  c.exit(pushBare, 2, "main 检出上裸 push（当前分支=base）→ 拦截");
  const pushCard = runHook(GATE_MERGE, preToolUsePayload(root, "git push -u origin task-12"));
  c.exit(pushCard, 0, "push 卡片分支 → 放行");
  const abort = runHook(GATE_MERGE, preToolUsePayload(root, "git merge --abort"));
  c.exit(abort, 0, "merge --abort 非合并入口 → 放行");
});

test("G6", "无关 Bash 命令与空载荷：exit 0，零动作", (c) => {
  const root = newRoot("t13-g6");
  initGitRepo(root);
  c.exit(runHook(GATE_MERGE, preToolUsePayload(root, "git status --short")), 0, "git status 放行");
  c.exit(runHook(GATE_MERGE, preToolUsePayload(root, "node -e \"console.log(1)\"")), 0, "非 git 命令放行");
  c.exit(runHook(GATE_MERGE, ""), 0, "空 stdin 退出码 0");
});

test("G7", "gh pr merge：可按卡号归卡则核验证据；无法归卡则拦截并给出 --head/工作树去路", (c) => {
  const root = newRoot("t13-g7");
  initGitRepo(root);
  writeRuns(root, [runRecord({ role: "test-verifier", result: "done", cards: [12] })]);
  const blocked = runHook(GATE_MERGE, preToolUsePayload(root, "gh pr merge task-12 --squash"));
  c.exit(blocked, 2, "缺 code-reviewer → 拦截");
  const opaque = runHook(GATE_MERGE, preToolUsePayload(root, "gh pr merge 42 --squash"));
  c.exit(opaque, 2, "无法从命令确定卡号 → 拦截（无法核验三绿）");
  c.ok(/task-<no>|task-12/.test(String(opaque.stderr ?? "")), "阻断文案给出归卡去路", show(String(opaque.stderr ?? "").slice(0, 500)));
  writeRuns(root, [
    runRecord({ role: "test-verifier", result: "done", cards: [12] }),
    runRecord({ role: "code-reviewer", result: "done", cards: [12] }),
  ]);
  c.exit(runHook(GATE_MERGE, preToolUsePayload(root, "gh pr merge task-12 --squash")), 0, "两绿在位 → 放行");
});

// ---- S6 静态：.zcode/config.json 终态——五项正式声明 + 探针零残留 + 一次性信任评审状态（hooks 包装层形态）

function collectHookDecls(config) {
  const out = [];
  const events = config?.hooks?.events ?? {};
  for (const [event, decls] of Object.entries(events)) {
    for (const d of Array.isArray(decls) ? decls : []) {
      for (const h of Array.isArray(d?.hooks) ? d.hooks : []) out.push({ event, matcher: d.matcher ?? null, hook: h });
    }
  }
  return out;
}

function findDecl(decls, { event, matcher = null, scriptFragment }) {
  return decls.find(
    (d) =>
      d.event === event &&
      (matcher === null || d.matcher === matcher) &&
      Array.isArray(d.hook?.args) &&
      d.hook.args.some((a) => String(a).endsWith(scriptFragment)),
  );
}

test("S6", "config.json 终态：五项正式声明（matcher/timeoutMs/async/statusMessage）+ 探针条目零残留 + 一次性信任评审状态", (c) => {
  const loaded = readJsonFile(REAL_CONFIG);
  if (!c.ok(loaded.ok, `真实项目配置可解析（${REAL_CONFIG}）`, String(loaded.error ?? ""))) return;
  const config = loaded.value;
  c.ok(config?.hooks !== undefined && typeof config.hooks === "object", "hooks 包装层存在（A5 实测：缺包装层被静默跳过）");
  c.eq(config?.hooks?.enabled, true, "hooks.enabled=true（声明开启；信任评审另计）");
  const decls = collectHookDecls(config);
  c.eq(decls.length, 5, "声明条目恰为五项正式（三探针条目已按计划随 T16 通过后移除）");

  const cases = [
    ["SessionStart 注入", { event: "SessionStart", scriptFragment: "assets/hooks/board-context.mjs" }, (d) => c.eq(d.hook.timeoutMs, 10000, "board-context timeoutMs=10000"), (d) => c.ok(!d.hook.async, "board-context 同步（SessionStart 注入在首轮前）")],
    ["PostToolUse 落账", { event: "PostToolUse", matcher: "Agent|Task", scriptFragment: "assets/hooks/record-run.mjs" }, (d) => c.eq(d.hook.timeoutMs, 30000, "record-run timeoutMs=30000（落账同步）"), (d) => c.ok(!d.hook.async, "record-run 同步执行（其后读板可见）")],
    ["PostToolUse 重编译", { event: "PostToolUse", matcher: "Write|Edit", scriptFragment: "assets/hooks/watch-sources.mjs" }, (d) => c.eq(d.hook.async, true, "watch-sources async=true"), () => {}],
    ["Stop 对账", { event: "Stop", scriptFragment: "assets/hooks/reconcile-stop.mjs" }, (d) => c.eq(d.hook.async, true, "reconcile-stop async=true"), () => {}],
    ["PreToolUse 门禁", { event: "PreToolUse", matcher: "Bash", scriptFragment: "assets/hooks/gate-merge.mjs" }, (d) => c.eq(d.hook.timeoutMs, 10000, "gate-merge timeoutMs=10000"), (d) => c.ok(!d.hook.async, "gate-merge 同步（阻断需即时判定）")],
  ];
  for (const [label, want, ...checks] of cases) {
    const d = findDecl(decls, want);
    if (!c.ok(d !== undefined, `正式声明存在：${label}（${want.scriptFragment}）`, show(decls.map((x) => [x.event, x.matcher, x.hook.args?.slice(-1)[0]])))) continue;
    c.eq(d.hook.type, "command", `${label}：type=command`);
    c.eq(d.hook.command, "node", `${label}：command=node`);
    c.ok(typeof d.hook.statusMessage === "string" && d.hook.statusMessage.length > 0, `${label}：statusMessage 非空`, show(d.hook.statusMessage));
    for (const check of checks) check(d);
  }

  // 命令路径指向技能安装位置（B4 决策：~/.zcode/skills/zcode-board/）
  for (const d of decls) {
    const script = Array.isArray(d.hook.args) ? d.hook.args.find((a) => String(a).endsWith(".mjs")) : null;
    if (script) c.ok(isFile(script), `声明指向的脚本存在：${script}`);
  }

  // 探针零残留（T16 通过后按计划移除——终态断言，防止回退）
  for (const [event, frag] of [
    ["SessionStart", ".zcode/board/probes/probe-sessionstart.mjs"],
    ["PostToolUse", ".zcode/board/probes/probe-posttooluse.mjs"],
    ["Stop", ".zcode/board/probes/probe-stop.mjs"],
  ]) {
    c.ok(findDecl(decls, { event, scriptFragment: frag }) === undefined, `探针条目不存在：${frag}（T16 后已移除）`);
  }
  c.eq(decls.filter((d) => (Array.isArray(d.hook.args) ? d.hook.args : []).some((a) => /probes\//.test(String(a)))).length, 0, "config 零 probes/ 引用（任意事件/形态均无残留）");

  // 一次性信任评审状态（不声称已启用；终态文件——评审一次即稳定）
  const statusText = String(config?._status ?? "");
  c.ok(/一次性信任评审/.test(statusText) && /待/.test(statusText), "config _status 注明待用户一次性信任评审（不声称已启用）", show(config?._status));
});

// ---------------------------------------------------------------- 主流程

async function main(argv) {
  const onlyIdx = argv.indexOf("--only");
  const only = onlyIdx >= 0 ? new Set(String(argv[onlyIdx + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) : null;
  const clean = argv.includes("--clean");

  say("zcode-board · T13 hook 场景断言（测试先行：红 → 绿）");
  say(`node    : ${process.version}`);
  say(`assets  : ${toPosix(ASSETS_DIR)}`);
  say(`hooks   : ${toPosix(HOOKS_DIR)}（存在：${isDir(HOOKS_DIR)}）`);
  say(`用例    : ${only ? [...only].join(",") : "全部"}`);
  say("");

  const roots = [];
  for (const t of TESTS) {
    if (only && !only.has(t.id)) continue;
    say(`== ${t.id}：${t.title} ==`);
    const c = new Checks(t.id);
    roots.push(c);
    activeChecks = c;
    try {
      await t.fn(c, roots);
    } catch (e) {
      c.ok(false, "用例执行异常", e.stack ?? e.message);
    }
    say("");
  }

  for (const c of roots) {
    if (clean && c.root) rmSync(c.root, { recursive: true, force: true });
  }

  say(`结论：通过 ${passCount}，失败 ${failCount}`);
  if (failedTests.size > 0) {
    say(`失败用例：${[...failedTests].sort().join(", ")}`);
    return 1;
  }
  say("全部用例通过（0 失败）");
  return 0;
}

main(process.argv.slice(2)).then((code) => process.exit(code));
