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
 *     缺口短清单（#130）：四码按固定优先序逐条列出、每条一行处置指引；缺口多于上限时截断为
 *     top 8 + 计数行且列出条目全部保留处置行（反例 B8）；
 *     在做/该接 top-N（#131）：按在做→待接手→未开工排序取前 5 + 截断计数行；终态/占位卡不列；
 *     旧板（无 nextAssignee 字段）按 assignees 序 + runs 证据只读派生、板字段（含显式 null）优先（B9/B11）；
 *     陈旧告警行（#131）：sources[] mtime 新于板 updatedAt（+1s 容差，与 reconcile-stop §3 同口径）
 *     → 点名变动源并指向重编译；板新鲜不告警（B10）；
 *     预算级截断（#132）：超量板（数百卡+长标题）下对账/处置关键行逐字保留、细节行按尾部省略、
 *     输出前字节自检 ≤ 闸值且 JSON 恒可解析（B13）；关键行单行或累计超闸走兜底收口 + stderr 诊断（B14）；
 *   - watch-sources.mjs（场景 29）：变更路径属 sources 才重编译（含尚未进 sources 的新文件归属判定）；
 *     无关路径不触发；
 *   - reconcile-stop.mjs：点名四类（未登记/未合并/板陈旧/待归档）+ 第五类「勾选=已合并点名」
 *     （B1-2/#98：completed 卡缺该卡 integrator done 证据；判据与 --check 同源 lib/fact-invariants.mjs；
 *     豁免登记 .zcode/board/exemptions.json 抑制点名、坏登记逐条提示不静默；runs 缺失≡空证据、
 *     损坏→跳过，均写明语义）；写 .zcode/board/last-reconcile.md；
 *     不强推续跑（stdout 无 continue/decision JSON）、显式 exit 0；未合并遍历递归到 schema 展开上限 3
 *     （深度 3 嵌套卡同样点名，S4）；
 *   - gate-merge.mjs（场景 27 夹具半场）：只拦"目标为 base 分支且无三绿证据"的合并；
 *     feature 间合并不拦；拦截文案给出缺失绿与补齐路径；其余 hook 永不阻断（exit 0）。
 *
 * 夹具全部位于系统临时目录；真实板文件零触碰（config.json 断言为只读）。
 * 用法：node assets/test/run-t13-hooks.mjs [--only S1,R1] [--clean]
 * 退出码：0 = 全部通过；1 = 有失败。
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
const REGISTER_INTERVIEW = join(ASSETS_DIR, "register-interview.mjs");
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
const BOARD_MD_REL = ".zcode/board/board.md";
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

/** 编译器指定模式（--assign / --check；--check 正文走 stdout）。 */
function runCompilerWith(root, ...args) {
  const r = spawnSync(process.execPath, [COMPILER, root, ...args], { encoding: "utf8" });
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
  // 零缺口态（本夹具无 run/无零卡稿）：清单显式报无，不留空标题
  c.ok(/缺口清单：无（四缺口全零，无需处置）/.test(ctx), "零缺口时清单显式报无（不输出空清单）", show(ctx.slice(0, 600)));
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

test("B7", "SessionStart 缺口短清单（#130）：四码按优先级逐条列出，每条一行处置指引", (c) => {
  const root = newRoot("t13-b7");
  // 已访谈未落卡：open/none 访谈登记（无任何产物）
  w(root, ".zcode/board/interviews.json", JSON.stringify({
    version: 1,
    interviews: [{
      id: "itw-20261010-9001",
      at: "2026-10-10T09:00:00+08:00",
      sessionId: "sess_T13_B7",
      topic: "缺口短清单访谈",
      summary: "只访谈未落卡，供缺口清单夹具。",
      decisions: [],
      artifacts: [],
      outcome: "none",
      status: "open",
    }],
  }, null, 2) + "\n");
  // 已安排未展开：零卡计划稿
  w(root, ".zcode/plans/plan-sess_t13-b7-empty.md", "# 未拆解计划 <!-- zcode-board: no=6 -->\n\n（本稿无可识别任务语法）\n");
  // 中断可续（#12）+ 待合并（#13，现场目录经 fs 互证真实存在）
  writePlanFixture(root, { featureNo: 5, cards: [{ no: 12 }, { no: 13 }] });
  writeRuns(root, [
    runRecord({ sessionId: "sess_fixture", cards: [12], breakpoint: { stoppedAt: 12, next: "补 updater 单测后重新验证" } }),
    runRecord({ runId: "run-20261009-b7b7", cards: [13], result: "done", worktree: ".zcode/worktrees/task-13", branch: "task-13" }),
  ]);
  mkdirSync(join(root, ".zcode", "worktrees", "task-13"), { recursive: true });
  const comp = runCompiler(root);
  c.exit(comp, 0, "前置编译退出码 0");
  const board = readBoard(root);
  c.eq(
    board?.attentionSummary,
    { interviewedNotArranged: 1, arrangedNotExpanded: 1, interruptedResume: 1, unmergedWorktree: 1 },
    "夹具确认：四缺口码各 1",
  );
  const r = runHook(BOARD_CONTEXT, sessionStartPayload(root));
  c.exit(r, 0, "退出码 0");
  const ctx = assertSingleJsonContext(c, r, "缺口短清单");
  c.ok(/缺口清单（4 个，按优先级；每条一行处置，列前 4）/.test(ctx), "清单头：缺口总数与处置列示口径", show(ctx.slice(0, 600)));
  const rows = ctx.split("\n");
  const gapRows = rows.filter((l) => /^- (已访谈未安排|已安排未展开|执行中断可续|待合并) /.test(l) && / → /.test(l));
  c.eq(gapRows.length, 4, "缺口清单恰 4 行（每条一行处置；不带 → 的行不算）", show(gapRows));
  c.ok(gapRows.every((l) => (l.match(/→/g) ?? []).length === 1), "每行恰一处处置指引（单行单动作）", show(gapRows));
  const rowOf = (frag) => gapRows.find((l) => l.includes(frag)) ?? "";
  const rowItw = rowOf("itw-20261010-9001");
  const rowArr = rowOf("未拆解计划");
  const rowInt = rowOf("#12");
  const rowUnm = rowOf("#13");
  c.ok(rowItw.includes("向用户确认是否落卡（register-interview / 计划稿补条目）"), "已访谈未安排行含处置指引：确认落卡（register-interview / 计划稿补条目）", show(rowItw));
  c.ok(rowArr.includes("特性拆卡（task-planner）"), "已安排未展开行含处置指引：特性拆卡（task-planner）", show(rowArr));
  c.ok(rowInt.includes("按 nextStep 续跑该卡"), "执行中断可续行含处置指引：按 nextStep 续跑该卡", show(rowInt));
  c.ok(rowUnm.includes("核对工作树现场后走 integrator 合并") && rowUnm.includes(".zcode/worktrees/task-13"), "待合并行含处置指引与现场路径：核对现场后走 integrator 合并", show(rowUnm));
  // 身份同行：卡标识 + 标题与处置指引在同一行（能照做，不必先读板）
  c.ok(
    rowItw.includes("缺口短清单访谈") && rowArr.includes("未拆解计划") && rowInt.includes("甲任务1") && rowUnm.includes("甲任务2"),
    "每行同时给卡标识与标题（缺口条目可定位）",
    show([rowItw, rowArr, rowInt, rowUnm]),
  );
  const pos = [
    ctx.indexOf("向用户确认是否落卡（register-interview / 计划稿补条目）"),
    ctx.indexOf("特性拆卡（task-planner）"),
    ctx.indexOf("按 nextStep 续跑该卡"),
    ctx.indexOf("核对工作树现场后走 integrator 合并"),
  ];
  c.ok(pos.every((p) => p >= 0) && pos[0] < pos[1] && pos[1] < pos[2] && pos[2] < pos[3], "四码按固定优先序（落卡 → 拆卡 → 续跑 → 合并）", show(pos));
});

test("B8", "SessionStart 缺口反例（#130）：缺口多于清单上限 → 截断保处置行（top 8 + 计数行）", (c) => {
  const root = newRoot("t13-b8");
  // 2 条未落卡（最高优先）+ 10 个零卡计划（次优先）= 12 个缺口
  w(root, ".zcode/board/interviews.json", JSON.stringify({
    version: 1,
    interviews: [
      { id: "itw-20261010-8001", at: "2026-10-10T09:00:00+08:00", sessionId: "sess_T13_B8", topic: "缺口甲", summary: "", decisions: [], artifacts: [], outcome: "none", status: "open" },
      { id: "itw-20261010-8002", at: "2026-10-10T09:10:00+08:00", sessionId: "sess_T13_B8", topic: "缺口乙", summary: "", decisions: [], artifacts: [], outcome: "none", status: "open" },
    ],
  }, null, 2) + "\n");
  for (let i = 0; i < 10; i += 1) {
    writePlanFixture(root, { featureNo: 200 + i, cards: [], rel: `.zcode/plans/plan-sess_t13-b8-${i}.md` });
  }
  const comp = runCompiler(root);
  c.exit(comp, 0, "前置编译退出码 0");
  const board = readBoard(root);
  c.eq(board?.attentionSummary?.interviewedNotArranged, 2, "夹具确认：2 条未落卡");
  c.eq(board?.attentionSummary?.arrangedNotExpanded, 10, "夹具确认：10 个零卡计划未展开");
  const r = runHook(BOARD_CONTEXT, sessionStartPayload(root));
  c.exit(r, 0, "退出码 0");
  const ctx = assertSingleJsonContext(c, r, "缺口截断");
  c.ok(/缺口清单（12 个，按优先级；每条一行处置，列前 8）/.test(ctx), "清单头：总数 12、列前 8", show(ctx.slice(0, 600)));
  const rows = ctx.split("\n");
  const gapRows = rows.filter((l) => /^- (已访谈未安排|已安排未展开|执行中断可续|待合并) /.test(l) && / → /.test(l));
  c.eq(gapRows.length, 8, "截断为 top 8（列出的每条仍带处置指引）", show(gapRows));
  c.eq(gapRows.filter((l) => l.includes("已访谈未安排")).length, 2, "高优先级码（未落卡 2 条）保留在列");
  c.eq(gapRows.filter((l) => l.includes("已安排未展开")).length, 6, "剩余名额给次优先级码（未展开 6 条）");
  c.ok(rows.includes("- …其余 4 个缺口见 board.json"), "计数行给出被截断数量（其余 4 个见 board.json）", show(rows.filter((l) => l.includes("其余"))));
  c.ok(Buffer.byteLength(String(r.stdout), "utf8") <= OUTPUT_BYTE_BUDGET, `输出 ≤ ${OUTPUT_BYTE_BUDGET} 字节（A6 预算）`);
});

test("B9", "SessionStart 在做/该接 top-N（#131）：在做→待接手→未开工排序取前 5，终态/占位卡不列，截断保计数", (c) => {
  const root = newRoot("t13-b9");
  // 待接手（tier1：#12/#13 implementer done，按 lastRun.at 新→旧）+ 在做（#14 partial→activeRun）
  writePlanFixture(root, { featureNo: 20, cards: [{ no: 12 }, { no: 13 }], rel: ".zcode/plans/plan-sess_t13-b9a.md" });
  writePlanFixture(root, { featureNo: 21, cards: [{ no: 14 }], rel: ".zcode/plans/plan-sess_t13-b9b.md" });
  // 未开工（tier2：updatedAt 2/1/4 天前，#16 新于 #15；#17/#18 超 top5 被截断）
  writePlanFixture(root, { featureNo: 22, cards: [{ no: 15 }], rel: ".zcode/plans/plan-sess_t13-b9c.md" });
  writePlanFixture(root, { featureNo: 23, cards: [{ no: 16 }], rel: ".zcode/plans/plan-sess_t13-b9d.md" });
  writePlanFixture(root, { featureNo: 24, cards: [{ no: 17 }, { no: 18 }], rel: ".zcode/plans/plan-sess_t13-b9e.md" });
  // 反例：终态（#19 已勾选=已完成）与 roadmap 占位（#27 段位恒待设计）都不算"该接"
  writePlanFixture(root, { featureNo: 25, cards: [{ no: 19, checked: true }], rel: ".zcode/plans/plan-sess_t13-b9f.md" });
  w(root, ".zcode/plans/plan-sess_t13-b9g.md", [
    "# 占位计划 <!-- zcode-board: no=26 -->",
    "<!-- zcode-board: roadmap -->",
    "",
    "- [ ] 1. 占位任务 <!-- zcode-board: no=27 -->",
    "  - 占位正文。",
    "",
  ].join("\n"));
  writeRuns(root, [
    runRecord({ runId: "run-20261010-b9a1", cards: [12], at: "2026-10-10T10:00:00+08:00", result: "done" }),
    runRecord({ runId: "run-20261010-b9a2", cards: [13], at: "2026-10-10T11:00:00+08:00", result: "done" }),
    runRecord({ runId: "run-20261010-b9a3", cards: [14], at: "2026-10-10T12:00:00+08:00", result: "partial", breakpoint: { stoppedAt: 14, next: "修完继续" } }),
  ]);
  setOldMtime(root, ".zcode/plans/plan-sess_t13-b9c.md", 2);
  setOldMtime(root, ".zcode/plans/plan-sess_t13-b9d.md", 1);
  setOldMtime(root, ".zcode/plans/plan-sess_t13-b9e.md", 4);
  c.exit(runCompiler(root), 0, "前置编译退出码 0");
  const board = readBoard(root);
  c.eq(cardByNo(board, 14)?.activeRun?.role, "implementer", "夹具确认：#14 activeRun.role=implementer");
  c.eq(cardByNo(board, 12)?.nextAssignee, "test-verifier", "夹具确认：#12 nextAssignee=test-verifier");
  c.eq(cardByNo(board, 19)?.stage, "已完成", "夹具确认：#19 已勾选=段位已完成（终态反例）");
  c.eq(cardByNo(board, 27)?.stage, "待设计", "夹具确认：#27 roadmap 卡段位待设计（占位反例）");
  const r = runHook(BOARD_CONTEXT, sessionStartPayload(root));
  c.exit(r, 0, "退出码 0");
  const ctx = assertSingleJsonContext(c, r, "在做/该接");
  c.ok(/在做\/该接（在做 1 · 该接 6；按在做→待接手→未开工，列前 5）：/.test(ctx), "段头：在做/该接计数与排序口径", show(ctx.slice(0, 900)));
  const rows = ctx.split("\n").filter((l) => /^- (在做|该接) /.test(l));
  c.eq(rows.length, 5, "列前 5 行（top-N=5）", show(rows));
  c.ok(/^- 在做 .*#14 .*：implementer 自 2026-10-10T12:00:00\+08:00（执行中）$/.test(rows[0] ?? ""), "第 1 行=在做 #14（activeRun.role + at + 段位）", show(rows[0]));
  c.ok(/^- 该接 .*#13 .*：test-verifier（上一手 implementer done @ 2026-10-10T11:00:00\+08:00）$/.test(rows[1] ?? ""), "第 2 行=待接手 #13（lastRun.at 新→旧）", show(rows[1]));
  c.ok(/^- 该接 .*#12 .*：test-verifier（上一手 implementer done @ 2026-10-10T10:00:00\+08:00）$/.test(rows[2] ?? ""), "第 3 行=待接手 #12", show(rows[2]));
  c.ok(/^- 该接 .*#16 .*：implementer（无 run 记录）$/.test(rows[3] ?? ""), "第 4 行=未开工 #16（updatedAt 1 天前，先于 2 天前的 #15）", show(rows[3]));
  c.ok(/^- 该接 .*#15 .*：implementer（无 run 记录）$/.test(rows[4] ?? ""), "第 5 行=未开工 #15", show(rows[4]));
  c.ok(!rows.some((l) => l.includes("#19")), "终态卡（#19 已完成）不列在做/该接", show(rows));
  c.ok(!rows.some((l) => l.includes("#27")), "roadmap 占位卡（#27 待设计）不列在做/该接（处置在缺口清单）", show(rows));
  c.eq(ctx.split("\n").filter((l) => l.startsWith("- …其余 ")).length, 1, "截断仅一行计数", show(ctx.split("\n").filter((l) => l.includes("其余"))));
  c.ok(ctx.includes("- …其余 2 张见 board.json"), "截断计数行：其余 2 张见 board.json（#17/#18）", show(ctx.split("\n").filter((l) => l.includes("其余"))));
  c.ok(Buffer.byteLength(String(r.stdout), "utf8") <= OUTPUT_BYTE_BUDGET, `输出 ≤ ${OUTPUT_BYTE_BUDGET} 字节（A6 预算）`);
});

test("B10", "SessionStart 陈旧告警（#131）：已登记源 mtime 新于板 updatedAt → 点名源并指向重编译；板新鲜不告警", (c) => {
  const root = newRoot("t13-b10");
  const planRel = writePlanFixture(root, { featureNo: 5, cards: [{ no: 12 }] });
  c.exit(runCompiler(root), 0, "前置编译退出码 0");
  const beforeBytes = readFileSync(join(root, BOARD_REL), "utf8");
  const fresh = runHook(BOARD_CONTEXT, sessionStartPayload(root));
  c.exit(fresh, 0, "新鲜板：退出码 0");
  const freshCtx = assertSingleJsonContext(c, fresh, "新鲜板");
  c.ok(!/陈旧告警/.test(freshCtx), "板新鲜（源 mtime ≤ updatedAt+1s 容差）时不输出陈旧告警行", show(freshCtx.slice(0, 600)));
  // 真相源 mtime 前进（纯 mtime、内容与板均不动）：板事实落后于源 → 陈旧必咬
  const ahead = new Date(Date.now() + 120_000);
  utimesSync(join(root, planRel), ahead, ahead);
  const stale = runHook(BOARD_CONTEXT, sessionStartPayload(root));
  c.exit(stale, 0, "陈旧板：退出码 0（注入型 hook 不阻塞）");
  const ctx = assertSingleJsonContext(c, stale, "陈旧告警");
  c.ok(/陈旧告警：板可能过期/.test(ctx), "输出陈旧告警行", show(ctx.slice(0, 700)));
  c.ok(/1 个已登记源/.test(ctx), "告警给出已登记源变动计数（1 个）", show(ctx.slice(0, 700)));
  c.ok(ctx.includes(planRel), `告警点名变动的源路径（${planRel}）`, show(ctx.slice(0, 700)));
  c.ok(/重编译：node <zcode-board-skill>\/assets\/compile-board\.mjs/.test(ctx), "告警指向重编译命令", show(ctx.slice(0, 700)));
  c.eq(readFileSync(join(root, BOARD_REL), "utf8"), beforeBytes, "hook 只读：board.json 字节不变（重编译归编译器等写者）");
  // 源形态覆盖：spec 条目（root+files 展开）同样参与陈旧判定（与 reconcile-stop §3 同展开口径）
  const root2 = newRoot("t13-b10b");
  writeSpecFixture(root2, { name: "alpha", checked: false });
  c.exit(runCompiler(root2), 0, "spec 夹具前置编译退出码 0");
  const ahead2 = new Date(Date.now() + 120_000);
  utimesSync(join(root2, "specs/alpha/tasks.md"), ahead2, ahead2);
  const r2 = runHook(BOARD_CONTEXT, sessionStartPayload(root2));
  c.exit(r2, 0, "spec 源陈旧：退出码 0");
  const ctx2 = assertSingleJsonContext(c, r2, "spec 源陈旧");
  c.ok(/陈旧告警：板可能过期/.test(ctx2) && /specs\/alpha\/tasks\.md/.test(ctx2), "spec 条目按 root+files 展开点名变动文件", show(ctx2.slice(0, 700)));
});

test("B11", "SessionStart 旧板无 nextAssignee 字段（#131）：按 assignees 序 + runs 证据只读派生；板字段（含显式 null）优先不重算", (c) => {
  const root = newRoot("t13-b11");
  writePlanFixture(root, { featureNo: 5, cards: [{ no: 12 }, { no: 13 }, { no: 15 }, { no: 16 }] });
  writeRuns(root, [
    runRecord({ runId: "run-20261010-b11a", cards: [12], at: "2026-10-10T10:00:00+08:00", result: "done" }),
    runRecord({ runId: "run-20261010-b11b", cards: [13], at: "2026-10-10T10:30:00+08:00", result: "done" }),
    runRecord({ runId: "run-20261010-b11c", role: "test-verifier", cards: [13], at: "2026-10-10T11:00:00+08:00", result: "done" }),
    runRecord({ runId: "run-20261010-b11d", cards: [16], at: "2026-10-10T09:00:00+08:00", result: "done" }),
  ]);
  c.exit(runCompiler(root), 0, "前置编译退出码 0");
  // 模拟旧板（nextAssignee 字段诞生前的 schema）：任务卡整体移除该字段；#16 保留显式 null（板事实优先的反例）
  const board = readBoard(root);
  const strip = (list) => {
    for (const t of list ?? []) {
      delete t.nextAssignee;
      strip(t.tasks);
    }
  };
  strip(board.features);
  cardByNo(board, 16).nextAssignee = null;
  w(root, BOARD_REL, JSON.stringify(board, null, 2) + "\n");
  const r = runHook(BOARD_CONTEXT, sessionStartPayload(root));
  c.exit(r, 0, "退出码 0");
  const ctx = assertSingleJsonContext(c, r, "旧板派生");
  const rows = ctx.split("\n").filter((l) => /^- (在做|该接) /.test(l));
  c.ok(/^- 该接 .*#13 .*：code-reviewer（上一手 test-verifier done @ 2026-10-10T11:00:00\+08:00）$/.test(rows[0] ?? ""), "派生顺延：#13 已两环 done → code-reviewer", show(rows));
  c.ok(/^- 该接 .*#12 .*：test-verifier（上一手 implementer done @ 2026-10-10T10:00:00\+08:00）$/.test(rows[1] ?? ""), "派生：#12 implementer done → test-verifier", show(rows));
  c.ok(/^- 该接 .*#15 .*：implementer（无 run 记录）$/.test(rows[2] ?? ""), "派生：无 run 卡 → 管线首角色 implementer", show(rows));
  c.ok(!rows.some((l) => l.includes("#16")), "显式 null 是板事实（不重算）：#16 虽有 done run 也不列该接", show(rows));
});

test("B12", "SessionStart 在做/该接零候选（#131）：无可办卡时显式报无（不留空标题）", (c) => {
  const root = newRoot("t13-b12");
  writePlanFixture(root, { featureNo: 5, cards: [] });
  writePlanFixture(root, { featureNo: 6, cards: [{ no: 12, checked: true }], rel: ".zcode/plans/plan-sess_t13-b12b.md" });
  c.exit(runCompiler(root), 0, "前置编译退出码 0");
  const r = runHook(BOARD_CONTEXT, sessionStartPayload(root));
  c.exit(r, 0, "退出码 0");
  const ctx = assertSingleJsonContext(c, r, "零候选");
  c.ok(/在做\/该接：无（无 activeRun 且无可接手卡）/.test(ctx), "零候选显式报无（已完成的 #12 是终态，不算该接）", show(ctx.slice(0, 600)));
});

test("B13", "SessionStart 预算级截断（#132）：超量板（数百卡+长标题）下对账/处置关键行逐字保留、细节行按尾部省略、JSON 仍可解析", (c) => {
  const root = newRoot("t13-b13");
  // 超量板：300 张卡、标题各 ~400 字——缺口 top8 / 在做该接 top5 / 断点 top5 的可见行被长标题撑爆 20KB 预算
  const LONG = "超量长标题".repeat(80);
  const plan = ["# 超量计划 <!-- zcode-board: no=500 -->", ""];
  for (let i = 0; i < 300; i += 1) {
    plan.push(`- [ ] ${i + 1}. 甲任务${i + 1}·${LONG} <!-- zcode-board: no=${1000 + i} -->`);
    plan.push(`  - 甲任务正文首行。`);
    plan.push("");
  }
  const planRel = ".zcode/plans/plan-sess_t13-b13.md";
  w(root, planRel, plan.join("\n"));
  // 12 张卡各一条 partial run：interrupted-resume 缺口 12 → 清单级 top8 + 其余计数行；在做 12（列前 5）
  const runs = [];
  for (let i = 0; i < 12; i += 1) {
    runs.push(runRecord({
      runId: `run-20261010-b13${String.fromCharCode(97 + i)}`,
      cards: [1000 + i],
      at: `2026-10-10T${String(10 + (i % 10)).padStart(2, "0")}:00:00+08:00`,
      result: "partial",
      breakpoint: { stoppedAt: 1000 + i, next: "继续长尾任务".repeat(12) },
    }));
  }
  writeRuns(root, runs);
  w(root, LAST_RECONCILE_REL, [
    "# 收尾对账（Stop hook）",
    "",
    "- 时间：2026-10-10T23:30:00+08:00",
    "- 结论：点名 2 项（未登记 0 / 未合并 1 / 板陈旧 1 / 待归档 0）",
    "",
  ].join("\n"));
  c.exit(runCompiler(root), 0, "前置编译退出码 0");
  const ahead = new Date(Date.now() + 120_000);
  utimesSync(join(root, planRel), ahead, ahead); // 陈旧告警行也在场（保留位之一）
  const r = runHook(BOARD_CONTEXT, sessionStartPayload(root));
  c.exit(r, 0, "退出码 0");
  const ctx = assertSingleJsonContext(c, r, "预算级截断");
  const bytes = Buffer.byteLength(String(r.stdout), "utf8");
  c.ok(bytes <= OUTPUT_BYTE_BUDGET, `stdout 字节 ≤ ${OUTPUT_BYTE_BUDGET}（32KB 收集上限内自截断）`, `实际 ${bytes}`);
  c.ok(ctx.length <= OUTPUT_CHAR_BUDGET, `additionalContext 字符 ≤ ${OUTPUT_CHAR_BUDGET}（24k 注入闸）`, `实际 ${ctx.length}`);
  c.ok(/截断/.test(ctx), "超限给出截断标记", show(ctx.slice(-200)));
  const rows = ctx.split("\n");
  // 保留位（对账/处置关键行）逐字保留
  c.ok(rows.some((l) => l.startsWith("陈旧告警：板可能过期") && l.includes(planRel)), "陈旧告警行逐字保留", show(rows.filter((l) => l.startsWith("陈旧告警"))));
  c.ok(rows.includes("处置：缺口非零——先与用户确认处理顺序，再派发（板记录事实，不自动派发）。"), "处置行逐字保留", show(rows.filter((l) => l.startsWith("处置"))));
  c.ok(rows.includes("上次对账：2026-10-10T23:30:00+08:00 · 点名 2 项（未登记 0 / 未合并 1 / 板陈旧 1 / 待归档 0）"), "上次对账行逐字保留", show(rows.filter((l) => l.startsWith("上次对账"))));
  c.ok(rows.some((l) => l === "在做/该接（在做 12 · 该接 288；按在做→待接手→未开工，列前 5）："), "在做/该接计数头逐字保留（细节条目可省，计数头不丢）", show(rows.filter((l) => l.startsWith("在做/该接"))));
  c.ok(rows.some((l) => l === "缺口清单（12 个，按优先级；每条一行处置，列前 8）："), "缺口清单头逐字保留", show(rows.filter((l) => l.startsWith("缺口清单"))));
  const gapRows = rows.filter((l) => /^- (已访谈未安排|已安排未展开|执行中断可续|待合并) /.test(l) && / → /.test(l));
  c.eq(gapRows.length, 8, "缺口清单各行保留（top 8，每条仍带 → 处置）", show(gapRows.length));
  c.ok(rows.includes("- …其余 4 个缺口见 board.json"), "缺口其余计数行（次要摘要）保留", show(rows.filter((l) => l.includes("其余"))));
  // 细节行按尾部优先省略（本夹具下断点条目被省；关键行不受影响）
  const bpRows = rows.filter((l) => /，停在 #/.test(l));
  c.ok(bpRows.length < 5, "细节行（断点条目）按尾部优先省略（< 5 行）", show(bpRows.length));
  // stderr 降级诊断（不静默）
  const err = String(r.stderr ?? "");
  c.ok(/预算自检/.test(err) && /省略/.test(err), "stderr 留预算自检与降级诊断（不静默）", show(err.slice(0, 400)));
});

test("B14", "SessionStart 病态超限兜底（#132）：关键行单独超闸 → 按字节收口、JSON 恒可解析且 ≤ 闸值，stderr 留诊断", (c) => {
  const root = newRoot("t13-b14");
  // 病态板：单卡标题 ~54KB（> 20KB 闸）——缺口行本身即超闸，降级档 1/2 也救不回
  const HUGE = "巨标题".repeat(6000);
  w(root, ".zcode/plans/plan-sess_t13-b14.md", [
    "# 病态计划 <!-- zcode-board: no=600 -->",
    "",
    `- [ ] 1. ${HUGE} <!-- zcode-board: no=2000 -->`,
    "  - 病态正文。",
    "",
  ].join("\n"));
  writeRuns(root, [
    runRecord({ runId: "run-20261010-b14a", cards: [2000], at: "2026-10-10T10:00:00+08:00", result: "partial", breakpoint: { stoppedAt: 2000, next: "继续" } }),
  ]);
  c.exit(runCompiler(root), 0, "前置编译退出码 0");
  const r = runHook(BOARD_CONTEXT, sessionStartPayload(root));
  c.exit(r, 0, "退出码 0（注入型 hook 不阻塞）");
  const ctx = assertSingleJsonContext(c, r, "病态超限");
  const bytes = Buffer.byteLength(String(r.stdout), "utf8");
  c.ok(bytes <= OUTPUT_BYTE_BUDGET, `stdout 字节 ≤ ${OUTPUT_BYTE_BUDGET}（自检兜底）`, `实际 ${bytes}`);
  c.ok(ctx.length <= OUTPUT_CHAR_BUDGET, `additionalContext 字符 ≤ ${OUTPUT_CHAR_BUDGET}`, `实际 ${ctx.length}`);
  c.ok(/截断/.test(ctx), "仍带截断标记", show(ctx.slice(-220)));
  c.ok(/\[zcode-board\]/.test(ctx) && ctx.includes("缺口清单（1 个，按优先级；每条一行处置，列前 1）："), "能装下的关键行（板摘要头/缺口清单头）逐字保留", show(ctx.slice(0, 500)));
  c.ok(!ctx.includes("巨标题巨标题"), "超闸单行整体跳过（不落盘、不静默取中段）");
  c.ok(/单行或累计|按字节收口/.test(String(r.stderr ?? "")), "stderr 留兜底收口诊断（绑定修正后口径，不静默）", show(String(r.stderr ?? "").slice(0, 400)));
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

// ---- C6 B1-2（#98）：第五类点名——「勾选=已合并点名」（completed 卡缺 integrator done 证据）

test("C6", "Stop 第五类（B1-2/#98）：completed 卡缺该卡 integrator done 证据 → last-reconcile.md「勾选=已合并点名」节点名卡号；有证据/未完成/未领号不点名", (c) => {
  const root = newRoot("t13-c6");
  writePlanFixture(root, {
    featureNo: 5,
    cards: [
      { no: 42, checked: true }, // 缺证据：仅 integrator partial（非 done 不算证据）
      { no: 43, checked: true }, // 有证据：integrator done
      { no: 44, checked: false }, // 未完成：不判
      { no: null, checked: true }, // 未领号：无引用位，不判（否则产生无法登记豁免的恒名词条）
    ],
  });
  writeRuns(root, [
    runRecord({ runId: "run-20261009-c6aa", role: "integrator", result: "done", cards: [43] }),
    runRecord({ runId: "run-20261009-c6bb", role: "integrator", result: "partial", cards: [42] }),
  ]);
  const comp = runCompiler(root);
  c.exit(comp, 0, "前置编译退出码 0");
  const board = readBoard(root);
  c.eq(
    (board?.features?.[0]?.tasks ?? []).map((t) => [t.no ?? null, t.status]),
    [[42, "completed"], [43, "completed"], [44, "pending"], [null, "completed"]],
    "夹具前置：勾选直映 completed（含未领号 completed 卡）",
  );

  const r = runHook(RECONCILE_STOP, stopPayload(root, "收尾，本轮无 run_event 块。"));
  c.exit(r, 0, "退出码 0（对账级非阻断）");
  c.eq(String(r.stdout ?? "").trim(), "", "stdout 为空（R3 语义不变：不强推续跑）");

  const md = String(readReconcile(root) ?? "");
  c.ok(/## 5\. 勾选=已合并点名（1）/.test(md), "第 5 节「勾选=已合并点名」独立成节且计数 1（partial 不算证据、未完成/未领号不判）", show(md.slice(0, 2400)));
  c.ok(
    /## 5\.[\s\S]*?features\[0\]\.tasks\[0\]（#42）[\s\S]*?integrator done/.test(md),
    "点名行指向卡号 #42（节点路径 + 稳定号 + 缺该卡 integrator done 证据）",
    show(md.slice(0, 2600)),
  );
  c.ok(!md.includes("#43"), "有 integrator done 证据的 #43 不点名", show(md.slice(2000)));
  c.ok(!md.includes("#44"), "未完成卡 #44 不点名（只对 completed 判）", show(md.slice(2000)));
  c.ok(/exemptions\.json/.test(md), "第 5 节写明豁免登记去向与口径（.zcode/board/exemptions.json）", show(md.slice(0, 2600)));
  c.ok(
    /- 结论：四类均无（对账通过）；勾选=已合并点名另计 1 项/.test(md),
    "结论行增第五类计数（另计 1 项——与四类口径并存不混算）",
    show(md.split("\n").slice(0, 6)),
  );
  noTempFiles(c, root, "原子写零残留（无 .*.tmp-*）");
});

// ---- C7 B1-2（#98）：第五类反例——豁免登记（登记后点名消失；坏登记不静默）

test("C7", "Stop 第五类反例（B1-2/#98）：登记豁免后点名消失（合法登记在效）；坏登记不静默（条目级不生效 / 结构非法整份拒收）", (c) => {
  const root = newRoot("t13-c7");
  const EXEMPTIONS_REL = ".zcode/board/exemptions.json"; // 登记位置（口径字面，与实现解耦断言）
  writePlanFixture(root, { featureNo: 6, cards: [{ no: 52, checked: true }, { no: 53, checked: true }] });
  writeRuns(root, [
    runRecord({ runId: "run-20261009-c7aa", role: "implementer", result: "done", cards: [52] }),
    runRecord({ runId: "run-20261009-c7bb", role: "implementer", result: "done", cards: [53] }),
  ]);
  const comp = runCompiler(root);
  c.exit(comp, 0, "前置编译退出码 0");

  const run = () => {
    const r = runHook(RECONCILE_STOP, stopPayload(root, "收尾。"));
    return { r, md: String(readReconcile(root) ?? "") };
  };

  // 反例前置：未登记 → 两条缺证据卡均点名
  const first = run();
  c.exit(first.r, 0, "前置：退出码 0");
  c.ok(
    /## 5\. 勾选=已合并点名（2）/.test(first.md) && first.md.includes("#52") && first.md.includes("#53"),
    "未登记豁免：两条缺证据卡均点名（前置）",
    show(first.md.slice(0, 2400)),
  );

  // 合法登记：点名消失 + 在效提示（登记件 .zcode/board/exemptions.json，{no, reason, at}）
  w(root, EXEMPTIONS_REL, JSON.stringify({
    version: 1,
    exemptions: [{ no: 52, reason: "速修直提交（用户拍板，无走卡合并）", at: "2026-10-10T09:00:00+08:00" }],
  }, null, 2) + "\n");
  const second = run();
  c.exit(second.r, 0, "登记后退出码 0");
  c.ok(/## 5\. 勾选=已合并点名（1）/.test(second.md), "登记豁免后：该卡不再点名（计数 2 → 1）", show(second.md.slice(0, 2400)));
  c.ok(!second.md.includes("#52"), "已登记豁免的 #52 点名消失", show(second.md.slice(2000)));
  c.ok(second.md.includes("#53"), "未登记的 #53 仍点名（登记只按稳定号抑制）", show(second.md.slice(2000)));
  c.ok(/已生效豁免 1 条/.test(second.md), "文件写明在效豁免条数（登记被消费，不静默）", show(second.md.slice(1200, 2600)));
  c.ok(/- 结论：四类均无（对账通过）；勾选=已合并点名另计 1 项/.test(second.md), "结论行计数随登记同步（另计 1 项）", show(second.md.split("\n").slice(0, 6)));
  c.eq(String(second.r.stdout ?? "").trim(), "", "stdout 恒空（登记不改投递语义：不强推续跑）");

  // 条目级非法（#53 缺 reason）：该条不生效 + 逐条提示；合法条目（#52）照常生效
  w(root, EXEMPTIONS_REL, JSON.stringify({
    version: 1,
    exemptions: [
      { no: 52, reason: "速修直提交（用户拍板，无走卡合并）", at: "2026-10-10T09:00:00+08:00" },
      { no: 53, at: "2026-10-10T09:05:00+08:00" },
    ],
  }, null, 2) + "\n");
  const third = run();
  c.exit(third.r, 0, "坏条目退出码 0（对账级不阻断）");
  c.ok(
    /提示：\.zcode\/board\/exemptions\.json：\$\.exemptions\[1\]\.reason/.test(third.md),
    "坏登记逐条提示（缺 reason 条目不生效，不静默放行）",
    show(third.md.slice(1200)),
  );
  c.ok(
    /## 5\. 勾选=已合并点名（1）/.test(third.md) && third.md.includes("#53") && !third.md.includes("#52"),
    "条目级非法不连带：合法 #52 仍豁免、非法 #53 恢复点名",
    show(third.md.slice(0, 2600)),
  );
  c.ok(/已生效豁免 1 条/.test(third.md), "条目级非法不影响合法条目：在效豁免仍 1 条", show(third.md.slice(1200)));

  // 结构非法（exemptions 非数组）：整份拒收（零豁免生效）——两条恢复点名
  w(root, EXEMPTIONS_REL, JSON.stringify({ version: 1, exemptions: "x" }, null, 2) + "\n");
  const fourth = run();
  c.exit(fourth.r, 0, "结构非法退出码 0（对账级；修复归 --check）");
  c.ok(
    /提示：\.zcode\/board\/exemptions\.json：\$\.exemptions/.test(fourth.md),
    "结构非法逐条提示（登记文件解析语义不静默）",
    show(fourth.md.slice(1200)),
  );
  c.ok(
    /## 5\. 勾选=已合并点名（2）/.test(fourth.md) && fourth.md.includes("#52") && fourth.md.includes("#53"),
    "整份拒收：零豁免生效，两条恢复点名（不静默放行）",
    show(fourth.md.slice(0, 2600)),
  );
  c.ok(!/已生效豁免/.test(fourth.md), "整份拒收时不报在效条数（零豁免）", show(fourth.md.slice(1200)));
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

// ---- C8 B1-2（#98）：第五类降级——证据源不可用时的口径（缺失 ≡ 空证据 / 损坏 → 跳过，均不静默）

test("C8", "Stop 第五类降级（B1-2/#98）：runs.json 缺失 ≡ 空证据（逐条点名）；损坏/板损坏 → 第五类跳过并提示（不误当通过）", (c) => {
  const root = newRoot("t13-c8");
  writePlanFixture(root, { featureNo: 7, cards: [{ no: 62, checked: true }] });
  const comp = runCompiler(root);
  c.exit(comp, 0, "前置编译退出码 0");

  // 缺失：与 --check 同口径（缺失 ≡ 无 run 证据）——逐条点名 + 写明语义
  const first = runHook(RECONCILE_STOP, stopPayload(root, "收尾。"));
  c.exit(first, 0, "runs.json 缺失：退出码 0");
  const md1 = String(readReconcile(root) ?? "");
  c.ok(
    /## 5\. 勾选=已合并点名（1）[\s\S]*?#62/.test(md1),
    "runs.json 缺失 ≡ 空证据：#62 逐条点名（不静默当有证据）",
    show(md1.slice(0, 2400)),
  );
  c.ok(/提示：\.zcode\/board\/runs\.json 缺失 ≡ 无 run 证据/.test(md1), "写明缺失语义（缺失≡空证据；落账后重跑即消除）", show(md1.slice(1400)));

  // 损坏：第五类跳过（不按空证据误点名、也不静默当通过）+ 提示恢复路径
  w(root, RUNS_REL, "{ 坏 JSON");
  const second = runHook(RECONCILE_STOP, stopPayload(root, "收尾。"));
  c.exit(second, 0, "runs.json 损坏：退出码 0（不阻塞）");
  const md2 = String(readReconcile(root) ?? "");
  c.ok(/## 5\. 勾选=已合并点名（0）/.test(md2), "损坏：第五类跳过（计数 0，不按空证据误点名）", show(md2.slice(0, 2400)));
  c.ok(!md2.includes("#62"), "损坏：不逐条点名（跳过而非空证据）", show(md2.slice(2000)));
  c.ok(/说明：\.zcode\/board\/runs\.json 不可用/.test(md2), "损坏：提示第五类跳过并指向 --check 修复路径", show(md2.slice(1600)));
  c.ok(!/已生效豁免/.test(md2), "无豁免登记：不凭空报在效条数");

  // 板损坏：第五类无法检查（跳过并提示；四类口径不变）
  const root2 = newRoot("t13-c8b");
  w(root2, BOARD_REL, "{ 坏 JSON");
  const third = runHook(RECONCILE_STOP, stopPayload(root2, "收尾。"));
  c.exit(third, 0, "板损坏：退出码 0");
  const md3 = String(readReconcile(root2) ?? "");
  c.ok(/## 5\. 勾选=已合并点名（0）/.test(md3), "板损坏：第五类计数 0（无法检查）", show(md3.slice(0, 1600)));
  c.ok(/说明：板缺失或损坏：勾选=已合并取证无法检查/.test(md3), "板损坏：第 5 节写明无法检查（指向板状态行处置）", show(md3.slice(0, 1600)));
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

// ---- B3-1（#101）：Bash 通道陈旧盲区检测面（删除源 / 非 Write|Edit 新增源 / Bash 写入）

/** 现代 runtime 形态的 PostToolUse(Bash) payload（tool_response.exitCode 反映命令结果）。 */
function bashHookPayload(root, command, { sessionId = "sess_T13_WB", exitCode = 0 } = {}) {
  return {
    cwd: root,
    hookEventName: "PostToolUse",
    hook_event_name: "PostToolUse",
    mode: "agent",
    sessionId,
    session_id: sessionId,
    timestamp: "2026-10-10T22:00:00.000Z",
    traceId: "trace_fixture_bash",
    turnId: "turn_fixture_bash",
    toolCallId: "toolu_fixture_bash",
    tool_name: "Bash",
    toolName: "Bash",
    tool_input: { command, description: "夹具 Bash" },
    tool_response: { stdout: "", stderr: "", exitCode, status: exitCode === 0 ? "completed" : "error" },
    toolResultPreview: "",
  };
}

test("W7", "B3-1：Bash 删除源（rm）→ 板陈旧告警点名删除路径并指向重编译；不自动重编译", (c) => {
  const root = newRoot("t13-w7");
  writeSpecFixture(root, { name: "alpha", checked: false });
  c.exit(runCompiler(root), 0, "前置编译退出码 0");
  const beforeMtime = boardMtimeMs(root);
  const beforeBytes = readFileSync(join(root, BOARD_REL), "utf8");
  const rel = "specs/alpha/tasks.md";
  rmSync(join(root, rel)); // 真删除（现场与命令一致）
  const r = runHook(WATCH_SOURCES, bashHookPayload(root, `rm ${rel}`));
  c.exit(r, 0, "hook 退出码 0（失败不阻塞语义保持）");
  c.eq(r.stdout, "", "stdout 恒空（async 契约不变）");
  c.ok(/板陈旧告警/.test(r.stderr), "stderr 出现板陈旧告警", show(r.stderr));
  c.ok(/删除：specs\/alpha\/tasks\.md/.test(r.stderr), "告警点名删除的源路径", show(r.stderr));
  c.ok(/请重编译：node .*compile-board\.mjs/.test(r.stderr), "告警明确指向重编译命令", show(r.stderr));
  c.eq(boardMtimeMs(root), beforeMtime, "不自动重编译（板 mtime 不变——检测与告警口径，修复归 Stop 兜底/人工）");
  c.eq(readFileSync(join(root, BOARD_REL), "utf8"), beforeBytes, "board.json 字节不变（不越权写入）");

  // 通配整面删除（rm specs/alpha/*.md）：按"首个通配段之前的前缀"做目录级归属 → 同样告警
  const rGlob = runHook(WATCH_SOURCES, bashHookPayload(root, "rm specs/alpha/*.md"));
  c.exit(rGlob, 0, "通配删除：hook 退出码 0");
  c.ok(/删除：specs\/alpha\/\*\.md/.test(rGlob.stderr), "通配删除按目录前缀归属并点名路径", show(rGlob.stderr));
  c.eq(boardMtimeMs(root), beforeMtime, "通配删除亦不自动重编译");
});

test("W8", "B3-1：非 Write|Edit 新增源（cp 落入新计划稿）→ 板陈旧告警点名「新增」路径", (c) => {
  const root = newRoot("t13-w8");
  writeSpecFixture(root, { name: "alpha" });
  c.exit(runCompiler(root), 0, "前置编译退出码 0");
  const beforeMtime = boardMtimeMs(root);
  const draftRel = ".zcode/tmp/plan-sess_t13-w8.md"; // 草稿在扫描面外；cp 目录目标形态落入 plans/
  const destRel = ".zcode/plans/plan-sess_t13-w8.md";
  w(root, draftRel, ["# 新计划稿", "", "- [ ] 1. 新任务", "  - 正文。", ""].join("\n"));
  mkdirSync(join(root, ".zcode", "plans"), { recursive: true }); // cp 目标目录（现场与命令一致）
  copyFileSync(join(root, draftRel), join(root, destRel)); // 真落入
  const r = runHook(WATCH_SOURCES, bashHookPayload(root, `cp ${draftRel} .zcode/plans/`)); // 目录目标形态
  c.exit(r, 0, "hook 退出码 0");
  c.ok(/板陈旧告警/.test(r.stderr), "stderr 出现板陈旧告警", show(r.stderr));
  c.ok(/新增：\.zcode\/plans\/plan-sess_t13-w8\.md/.test(r.stderr), "告警按「新增」点名新源路径（尚未进 sources[] 的窗口）", show(r.stderr));
  c.ok(!/plan-sess_t13-w8\.md\//.test(r.stderr), "目录目标展开不产生 <文件>/<basename> 伪路径（fs 判定目标真是目录）", show(r.stderr));
  c.ok(/请重编译：node .*compile-board\.mjs/.test(r.stderr), "告警明确指向重编译命令", show(r.stderr));
  c.eq(boardMtimeMs(root), beforeMtime, "不自动重编译（板 mtime 不变）");

  // heredoc 落新稿（cat > <新稿> <<'EOF'）：正文不参与解析，重定向目标判「新增」
  const heredocCmd = ["cat > .zcode/plans/plan-sess_t13-w8b.md <<'EOF'", "# 新计划稿乙", "", "rm specs/alpha/tasks.md", "", "- [ ] 1. 乙任务", "EOF", ""].join("\n");
  const rHd = runHook(WATCH_SOURCES, bashHookPayload(root, heredocCmd));
  c.exit(rHd, 0, "heredoc 落新稿：hook 退出码 0");
  c.ok(/新增：\.zcode\/plans\/plan-sess_t13-w8b\.md/.test(rHd.stderr), "heredoc 重定向目标按「新增」点名", show(rHd.stderr));
  c.ok(!/删除/.test(rHd.stderr), "heredoc 正文里的 rm 文本不误报删除（正文不参与解析）", show(rHd.stderr));
});

test("W9", "B3-1：Bash 写入（重定向 / sed -i / tee / touch）→ 板陈旧告警逐条点名「写入/新增」", (c) => {
  const root = newRoot("t13-w9");
  writeSpecFixture(root, { name: "alpha", checked: false });
  writeSpecFixture(root, { name: "beta", checked: false });
  c.exit(runCompiler(root), 0, "前置编译退出码 0");
  const beforeMtime = boardMtimeMs(root);
  // 现场与命令一致（真写入；sed/tee 用等价内容变更，不依赖 GNU/BSD sed 差异执行）
  w(root, "specs/alpha/tasks.md", readFileSync(join(root, "specs/alpha/tasks.md"), "utf8") + "\n<!-- B3-1 W9 追加 -->\n");
  w(root, "specs/alpha/progress.json", readFileSync(join(root, "specs/alpha/progress.json"), "utf8").replaceAll("alpha", "beta"));
  w(root, "specs/beta/tasks.md", readFileSync(join(root, "specs/beta/tasks.md"), "utf8"));
  w(root, ".zcode/plans/plan-sess_t13-w9.md", "# 新计划稿（touch 落空稿）\n");
  const cmd =
    "printf 'x' >> specs/alpha/tasks.md && sed -i '' 's/alpha/beta/' specs/alpha/progress.json && " +
    "tee specs/beta/tasks.md < /dev/null && touch .zcode/plans/plan-sess_t13-w9.md";
  const r = runHook(WATCH_SOURCES, bashHookPayload(root, cmd));
  c.exit(r, 0, "hook 退出码 0");
  c.ok(/板陈旧告警：检测到 4 处/.test(r.stderr), "告警头点名 4 处 Bash 源变更", show(r.stderr));
  c.ok(/写入：specs\/alpha\/tasks\.md/.test(r.stderr), "重定向 → 写入：alpha/tasks.md（sources[] 已知源）", show(r.stderr));
  c.ok(/写入：specs\/alpha\/progress\.json/.test(r.stderr), "sed -i → 写入：alpha/progress.json（sources[] 已知源）", show(r.stderr));
  c.ok(/写入：specs\/beta\/tasks\.md/.test(r.stderr), "tee → 写入：beta/tasks.md（sources[] 已知源）", show(r.stderr));
  c.ok(/新增：\.zcode\/plans\/plan-sess_t13-w9\.md/.test(r.stderr), "touch 新计划稿 → 新增（尚未进 sources[] 的窗口）", show(r.stderr));
  c.ok(/请重编译：node .*compile-board\.mjs/.test(r.stderr), "告警明确指向重编译命令", show(r.stderr));
  c.eq(boardMtimeMs(root), beforeMtime, "不自动重编译（板 mtime 不变）");
});

test("W10", "B3-1 反例：合法重编译与只读命令零告警；非源/派生路径写入不误报（防自激）", (c) => {
  const root = newRoot("t13-w10");
  writeSpecFixture(root, { name: "alpha", checked: false });
  c.exit(runCompiler(root), 0, "前置编译退出码 0");
  const beforeMtime = boardMtimeMs(root);

  // 反例 1：用户跑一次合法重编译（命令本身是 Bash 源变更的"合法路径"）
  const comp = runHook(WATCH_SOURCES, bashHookPayload(root, `node ${COMPILER} ${root}`));
  c.exit(comp, 0, "合法重编译命令：hook 退出码 0");
  c.ok(!/板陈旧告警/.test(comp.stderr), "合法重编译命令零陈旧告警（不误报）", show(comp.stderr));
  c.eq(boardMtimeMs(root), beforeMtime, "hook 只判定不代跑（命令由用户执行；hook 侧板 mtime 不变）");
  c.exit(runCompiler(root), 0, "合法重编译真执行退出码 0（路径本身有效）");

  // 反例 2：只读命令（cat / grep / 无 -i 的 sed）——不得告警
  for (const cmd of ["cat specs/alpha/tasks.md", "grep -n 甲 specs/alpha/tasks.md", "sed 's/甲/乙/' specs/alpha/tasks.md"]) {
    const r = runHook(WATCH_SOURCES, bashHookPayload(root, cmd));
    c.exit(r, 0, `只读命令退出码 0（${cmd.slice(0, 24)}…）`);
    c.ok(!/板陈旧告警/.test(r.stderr), `只读命令零陈旧告警：${cmd.slice(0, 44)}`, show(r.stderr));
  }

  // 反例 3：非源/派生路径写入（README、board.json、board.md、evidence/）——防自激
  for (const cmd of [
    "printf 'x' >> README.md",
    "printf 'x' >> .zcode/board/board.md",
    "printf 'x' >> .zcode/board/board.json",
    "mkdir -p .zcode/board/evidence/T101 && printf 'x' >> .zcode/board/evidence/T101/note.md",
  ]) {
    const r = runHook(WATCH_SOURCES, bashHookPayload(root, cmd));
    c.exit(r, 0, "非源/派生写入：hook 退出码 0");
    c.ok(!/板陈旧告警/.test(r.stderr), `非源/派生写入零陈旧告警：${cmd.slice(0, 48)}…`, show(r.stderr));
  }

  // 反例 4：heredoc 正文含 rm/sed 文本（写作内容而非执行）——正文不参与解析，不得误报
  const heredoc = runHook(WATCH_SOURCES, bashHookPayload(root, ["cat > README.md <<'EOF'", "rm specs/alpha/tasks.md", "sed -i '' 's/a/b/' specs/alpha/progress.json", "EOF", ""].join("\n")));
  c.exit(heredoc, 0, "heredoc 写非源：hook 退出码 0");
  c.ok(!/板陈旧告警/.test(heredoc.stderr), "heredoc 正文的 rm/sed 文本不误报（正文不参与解析）", show(heredoc.stderr));
});

test("W11", "B3-1 反例：命令非零退出不告警；Write|Edit 仍自动重编译且零陈旧告警", (c) => {
  const root = newRoot("t13-w11");
  writeSpecFixture(root, { name: "alpha", checked: false });
  c.exit(runCompiler(root), 0, "前置编译退出码 0");
  const beforeMtime = boardMtimeMs(root);

  // 非零退出：命令未生效（现场文件仍存在）——不得告警
  const failed = runHook(WATCH_SOURCES, bashHookPayload(root, "rm specs/alpha/tasks.md", { exitCode: 1 }));
  c.exit(failed, 0, "非零退出：hook 退出码 0");
  c.ok(/非零退出/.test(failed.stderr) && !/板陈旧告警/.test(failed.stderr), "非零退出：不告警且留下判定说明", show(failed.stderr));
  c.eq(boardMtimeMs(root), beforeMtime, "非零退出：板 mtime 不变");

  // Write|Edit 路径原行为不变：自动重编译，且不附陈旧告警（自动修复无需告警）
  w(root, "specs/alpha/tasks.md", ["# alpha 任务", "", "- [x] 1. 甲任务", "  - Scope: 甲任务正文。", ""].join("\n"));
  const r = runHook(WATCH_SOURCES, writeHookPayload(root, join(root, "specs/alpha/tasks.md")));
  c.exit(r, 0, "Write payload：hook 退出码 0");
  c.ok(boardMtimeMs(root) > beforeMtime, "Write 源变更仍自动重编译（原行为不变）");
  c.ok(!/板陈旧告警/.test(r.stderr), "Write|Edit 路径不输出陈旧告警（自动修复，告警只属 Bash 通道）", show(r.stderr));
});

test("W12", "B3-2 分流：归档移动（git mv 计划稿 → archive）→ 合法转移提示携带源与目标（不再判违规）", (c) => {
  const root = newRoot("t13-w12");
  const srcRel = writePlanFixture(root, { featureNo: 5, cards: [{ no: 12 }] });
  c.exit(runCompiler(root), 0, "前置编译退出码 0");
  const beforeMtime = boardMtimeMs(root);
  const destRel = ".zcode/archive/plan-sess_t13.md";
  mkdirSync(join(root, ".zcode", "archive"), { recursive: true });
  copyFileSync(join(root, srcRel), join(root, destRel));
  rmSync(join(root, srcRel)); // git mv 现场：移动（归档目录不在扫描面）
  const r = runHook(WATCH_SOURCES, bashHookPayload(root, `git mv ${srcRel} ${destRel}`));
  c.exit(r, 0, "hook 退出码 0");
  c.ok(/合法转移提示/.test(r.stderr), "stderr 出现合法转移提示（B3-2 分流；归档=只移动位置）", show(r.stderr));
  c.ok(!/板陈旧告警/.test(r.stderr), "不判违规：无板陈旧告警头", show(r.stderr));
  c.ok(/合法转移：\.zcode\/plans\/plan-sess_t13\.md/.test(r.stderr), "提示点名移动前路径（源面移除）", show(r.stderr));
  c.ok(/移至 \.zcode\/archive\/plan-sess_t13\.md/.test(r.stderr), "提示携带归档目标路径", show(r.stderr));
  c.eq(boardMtimeMs(root), beforeMtime, "不自动重编译（--assign 指向改写归人工/编排者；hook 只提示）");
});

// ---- B3-2（#102）：归档移动＝合法转移提示（指向 --assign 改写）

/** 归档分歧两文案共用指引句（与 compile-board.mjs --check 归档直查同一句，防二份文案漂移）。 */
const ASSIGN_GUIDE_SENTENCE = "运行 --assign 改写指向（号不变、assignedAt 保留，勘误 10）";

test("W13", "B3-2：归档移动（git mv 计划稿 → archive）→ 合法转移提示 + --assign 指引（不再判违规；与 --check 同一指引句）", (c) => {
  const root = newRoot("t13-w13");
  const srcRel = writePlanFixture(root, { featureNo: 5, cards: [{ no: 12 }] });
  const assign = runCompilerWith(root, "--assign");
  c.exit(assign, 0, "夹具前置：--assign 建立 registry 指向（号 5/12 → 计划稿；无 warning 语义）");
  const beforeMtime = boardMtimeMs(root);
  const destRel = ".zcode/archive/plan-sess_t13.md";
  mkdirSync(join(root, ".zcode", "archive"), { recursive: true });
  copyFileSync(join(root, srcRel), join(root, destRel));
  rmSync(join(root, srcRel)); // git mv 现场：移动（归档目录不在扫描面）
  const r = runHook(WATCH_SOURCES, bashHookPayload(root, `git mv ${srcRel} ${destRel}`));
  c.exit(r, 0, "hook 退出码 0（失败不阻塞语义不变）");
  c.eq(String(r.stdout ?? ""), "", "stdout 恒空（async 契约不变）");
  const err = String(r.stderr ?? "");
  c.ok(/合法转移提示/.test(err), "stderr 出现「合法转移提示」（归档移动不再是错误判定）", show(err));
  c.ok(!/板陈旧告警/.test(err), "不判违规：无板陈旧告警头（归档=只移动位置）", show(err));
  c.ok(/合法转移：\.zcode\/plans\/plan-sess_t13\.md/.test(err), "提示点名移动前路径（源面移除）", show(err));
  c.ok(/移至 \.zcode\/archive\/plan-sess_t13\.md/.test(err), "提示携带归档目标（勘误 10 映射命中）", show(err));
  c.ok(/registry 指向改写/.test(err) && /node .*compile-board\.mjs .*--assign/.test(err), "指向 --assign 改写命令（单动作处置）", show(err));
  c.ok(err.includes(ASSIGN_GUIDE_SENTENCE), "复用 --check 同一指引句（不二份文案）", show(err));
  c.eq(boardMtimeMs(root), beforeMtime, "不自动重编译（--assign 由人工/编排者执行；hook 只提示）");
  // 协同面硬对照：同一现场 --check 归档直查产出同一指引句（两处文案同源互锁）
  const chk = runCompilerWith(root, "--check");
  c.exit(chk, 1, "同一现场 --check 失败级（指向未随移动更新的可机械修复路径）");
  c.ok(String(chk.stdout ?? "").includes(ASSIGN_GUIDE_SENTENCE), "--check 归档直查产出同一指引句（协同面成立）", show(String(chk.stdout ?? "").slice(0, 900)));
});

test("W14", "B3-2 反例：真删除/非归档目标/移出根/归档路径但非勘误 10 候选 → 均维持板陈旧告警不误判（误判必咬）", (c) => {
  const root = newRoot("t13-w14");
  const aRel = writePlanFixture(root, { featureNo: 5, cards: [{ no: 12 }], rel: ".zcode/plans/plan-sess_t13-w14a.md" });
  const bRel = writePlanFixture(root, { featureNo: 6, cards: [{ no: 13 }], rel: ".zcode/plans/plan-sess_t13-w14b.md" });
  const cRel = writePlanFixture(root, { featureNo: 7, cards: [{ no: 14 }], rel: ".zcode/plans/plan-sess_t13-w14c.md" });
  const dRel = writePlanFixture(root, { featureNo: 8, cards: [{ no: 15 }], rel: ".zcode/plans/plan-sess_t13-w14d.md" });
  writeSpecFixture(root, { name: "alpha", checked: false });
  c.exit(runCompiler(root), 0, "前置编译退出码 0");

  // 1) 混合命令：一处归档移动（合法转移）+ 一处真删除（告警）→ 两文案分流、互不顶替
  const archRel = ".zcode/archive/plan-sess_t13-w14a.md";
  mkdirSync(join(root, ".zcode", "archive"), { recursive: true });
  copyFileSync(join(root, aRel), join(root, archRel));
  rmSync(join(root, aRel));
  rmSync(join(root, "specs/alpha/tasks.md")); // 真删除（现场与命令一致）
  const mixed = runHook(WATCH_SOURCES, bashHookPayload(root, `git mv ${aRel} ${archRel} && rm specs/alpha/tasks.md`));
  c.exit(mixed, 0, "混合命令：hook 退出码 0");
  const mixedErr = String(mixed.stderr ?? "");
  const moveLines = mixedErr.split("\n").filter((l) => l.includes("合法转移："));
  const delLines = mixedErr.split("\n").filter((l) => l.includes("删除："));
  c.eq(moveLines.length, 1, "合法转移行恰 1 条（仅归档移动）", show(mixedErr));
  c.eq(delLines.length, 1, "删除告警行恰 1 条（仅真删除）", show(mixedErr));
  c.ok(moveLines[0]?.includes(aRel) && moveLines[0]?.includes("移至 .zcode/archive/plan-sess_t13-w14a.md"), "合法转移行点名归档移动的源与目标", show(moveLines));
  c.ok(delLines[0]?.includes("specs/alpha/tasks.md") && !delLines[0]?.includes(".zcode/plans/"), "删除告警行点名真删除路径（不混入归档移动）", show(delLines));
  c.ok(/合法转移提示：检测到 1 处/.test(mixedErr) && /板陈旧告警：检测到 1 处/.test(mixedErr), "两文案各自计数 1（分流不合并计数）", show(mixedErr));

  // 2) 近邻误判必咬：dest 在归档根之下，但非勘误 10 映射候选（.zcode/archive/<x>）→ 不得判合法转移
  const nearRel = ".zcode/archive/sub/plan-sess_t13-w14b.md";
  mkdirSync(join(root, ".zcode", "archive", "sub"), { recursive: true });
  copyFileSync(join(root, bRel), join(root, nearRel));
  rmSync(join(root, bRel));
  const near = runHook(WATCH_SOURCES, bashHookPayload(root, `git mv ${bRel} ${nearRel}`));
  c.exit(near, 0, "归档子目录目标：hook 退出码 0");
  c.ok(/板陈旧告警/.test(near.stderr) && !/合法转移/.test(near.stderr), "归档根子路径但非映射候选 → 维持板陈旧告警（精确映射判据）", show(near.stderr));
  c.ok(new RegExp(`删除：${bRel.replace(/[.]/g, "\\.")}（移至 `).test(String(near.stderr)), "告警点名路径并携带实际目标（供人工核对归档位置）", show(near.stderr));

  // 3) 非归档目标：git mv 计划稿 → docs/scratch/（非源面、非归档映射）→ 维持告警
  const scratchRel = "docs/scratch/plan-sess_t13-w14c.md";
  mkdirSync(join(root, "docs", "scratch"), { recursive: true });
  copyFileSync(join(root, cRel), join(root, scratchRel));
  rmSync(join(root, cRel));
  const scratch = runHook(WATCH_SOURCES, bashHookPayload(root, `git mv ${cRel} ${scratchRel}`));
  c.exit(scratch, 0, "非归档目标：hook 退出码 0");
  c.ok(/板陈旧告警/.test(scratch.stderr) && !/合法转移/.test(scratch.stderr), "移入非归档、非源面目录 → 维持板陈旧告警（不误判合法转移）", show(scratch.stderr));

  // 4) 移出项目根：dest 归一失败（null）→ 维持删除告警
  const outRel = join(tmpdir(), "t102-w14-out.md");
  copyFileSync(join(root, dRel), outRel);
  rmSync(join(root, dRel));
  const out = runHook(WATCH_SOURCES, bashHookPayload(root, `git mv ${dRel} ${outRel}`));
  c.exit(out, 0, "移出根：hook 退出码 0");
  c.ok(/板陈旧告警/.test(out.stderr) && !/合法转移/.test(out.stderr), "移出项目根 → 维持板陈旧告警（dest 为空不按合法转移）", show(out.stderr));
  c.ok(new RegExp(`删除：${dRel.replace(/[.]/g, "\\.")}`).test(String(out.stderr)), "告警点名移出根的源路径", show(out.stderr));
});

test("W15", "B3-2：spec 目录整移（specs/<f> → specs/archive/<f>）与目录目标形态（→ .zcode/archive/）→ 合法转移提示", (c) => {
  const root = newRoot("t13-w15");
  writeSpecFixture(root, { name: "alpha", checked: false });
  const planRel = writePlanFixture(root, { featureNo: 5, cards: [{ no: 12 }], rel: ".zcode/plans/plan-sess_t13-w15.md" });
  c.exit(runCompiler(root), 0, "前置编译退出码 0");

  // 1) spec 目录整移（git mv specs/alpha specs/archive/alpha）：目录形态映射 specs/<f> → specs/archive/<f>
  mkdirSync(join(root, "specs", "archive"), { recursive: true });
  renameSync(join(root, "specs", "alpha"), join(root, "specs", "archive", "alpha"));
  const specMove = runHook(WATCH_SOURCES, bashHookPayload(root, "git mv specs/alpha specs/archive/alpha"));
  c.exit(specMove, 0, "spec 目录整移：hook 退出码 0");
  c.ok(/合法转移提示/.test(specMove.stderr) && !/板陈旧告警/.test(specMove.stderr), "spec 目录整移判合法转移（目录形态与编译器 --check 候选同构）", show(specMove.stderr));
  c.ok(/合法转移：specs\/alpha（移至 specs\/archive\/alpha）/.test(String(specMove.stderr)), "提示点名目录源与归档目标", show(specMove.stderr));

  // 2) 目录目标形态（git mv <计划稿> .zcode/archive/）：实际落点 = dest/<basename>，与映射候选一致
  mkdirSync(join(root, ".zcode", "archive"), { recursive: true });
  copyFileSync(join(root, planRel), join(root, ".zcode", "archive", "plan-sess_t13-w15.md"));
  rmSync(join(root, planRel));
  const dirDest = runHook(WATCH_SOURCES, bashHookPayload(root, `git mv ${planRel} .zcode/archive/`));
  c.exit(dirDest, 0, "目录目标形态：hook 退出码 0");
  c.ok(/合法转移提示/.test(dirDest.stderr) && !/板陈旧告警/.test(dirDest.stderr), "目录目标形态判合法转移（落点与映射候选一致）", show(dirDest.stderr));
  c.ok(/移至 \.zcode\/archive\/plan-sess_t13-w15\.md/.test(String(dirDest.stderr)), "提示携带实际落点（dest/<basename>）", show(dirDest.stderr));

  // 反例：目录目标跨形态（.zcode/plans 源 + specs/archive/ 目标）→ 维持告警（映射不跨形态拼接）
  const crossRel = writePlanFixture(root, { featureNo: 6, cards: [{ no: 13 }], rel: ".zcode/plans/plan-sess_t13-w15b.md" });
  mkdirSync(join(root, "specs", "archive"), { recursive: true });
  copyFileSync(join(root, crossRel), join(root, "specs", "archive", "plan-sess_t13-w15b.md"));
  rmSync(join(root, crossRel));
  const cross = runHook(WATCH_SOURCES, bashHookPayload(root, `git mv ${crossRel} specs/archive/`));
  c.exit(cross, 0, "跨形态目录目标：hook 退出码 0");
  c.ok(/板陈旧告警/.test(cross.stderr) && !/合法转移/.test(cross.stderr), "计划稿源 + specs/archive/ 目标不判合法转移（映射不跨形态拼接）", show(cross.stderr));
});

test("W16", "B3-2：§3.5 通用映射（opt-in 场景）——docs/plans、docs/design-notes → docs/archive/plans/ → 合法转移提示", (c) => {
  const root = newRoot("t13-w16");
  w(root, ".zcode/board/scan.json", JSON.stringify({ includeDirs: ["docs/plans", "docs/design-notes"] }, null, 2) + "\n");
  const docPlanRel = writePlanFixture(root, { featureNo: 5, cards: [{ no: 12 }], rel: "docs/plans/plan-doc.md" });
  const noteRel = "docs/design-notes/note-t13-w16.md";
  w(root, noteRel, ["# 设计档 <!-- zcode-board: no=6 -->", "", "- [ ] 1. 档任务 <!-- zcode-board: no=13 -->", "  - 正文。", ""].join("\n"));
  c.exit(runCompiler(root), 0, "前置编译退出码 0（docs 目录经 scan.json opt-in）");
  mkdirSync(join(root, "docs", "archive", "plans"), { recursive: true });

  const cases = [
    [docPlanRel, "docs/archive/plans/plan-doc.md", "docs/plans 映射"],
    [noteRel, "docs/archive/plans/note-t13-w16.md", "docs/design-notes 映射（同归 docs/archive/plans/）"],
  ];
  for (const [srcRel, destRel, label] of cases) {
    copyFileSync(join(root, srcRel), join(root, destRel));
    rmSync(join(root, srcRel));
    const r = runHook(WATCH_SOURCES, bashHookPayload(root, `git mv ${srcRel} ${destRel}`));
    c.exit(r, 0, `${label}：hook 退出码 0`);
    c.ok(/合法转移提示/.test(r.stderr) && !/板陈旧告警/.test(r.stderr), `${label}：判合法转移（opt-in 扫描面与归档映射协同）`, show(r.stderr));
    c.ok(new RegExp(`合法转移：${srcRel.replace(/[/.]/g, (m) => `\\${m}`)}（移至 ${destRel.replace(/[/.]/g, (m) => `\\${m}`)}）`).test(String(r.stderr)), `${label}：提示点名源与归档落点`, show(r.stderr));
  }
});

// ---- B3-3（#103）：Stop 兜底一律重编译（幂等）+ register-interview 注册后触发重编译

/** 板文件掩码（根 updatedAt = 编译时刻）后比对：双跑幂等证据——与 --check 同一先例（掩码根 updatedAt）。 */
function maskBoardUpdatedAt(text) {
  // 首次出现即根级（board.json 键序 version → project → updatedAt → generatedBy → sources → features）
  return String(text).replace(/"updatedAt": "[^"]*"/, '"updatedAt": "<编译时刻>"');
}

/** board.md 生成时间行掩码（编译时刻）后比对。 */
function maskBoardMdStamp(text) {
  return String(text).replace(/^- 生成时间：.*$/m, "- 生成时间：<编译时刻>");
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function runRegister(root, args) {
  return spawnSync(process.execPath, [REGISTER_INTERVIEW, root, ...args], { encoding: "utf8" });
}

/** 计划稿追加第 2 卡（#13）并把 mtime 推后 60s——板陈旧判定（秒精度 +1s 容差）确定性成立（C1 同法）。 */
function appendPlanCard(root, rel) {
  w(root, rel, readFileSync(join(root, rel), "utf8") + "\n- [ ] 2. 甲任务乙 <!-- zcode-board: no=13 -->\n  - 甲任务乙正文首行。\n");
  const future = new Date(Date.now() + 60_000);
  utimesSync(join(root, rel), future, future);
}

test("C9", "B3-3（#103）：Stop 兜底一律重编译——源变更后 Stop 自动刷新板（新卡上板）；对账如实点名修复前陈旧；stdout 恒空、exit 0", (c) => {
  const root = newRoot("t13-c9");
  const planRel = writePlanFixture(root, { featureNo: 5, cards: [{ no: 12 }], rel: ".zcode/plans/plan-sess_t13-c9.md" });
  c.exit(runCompiler(root), 0, "前置编译退出码 0");
  const before = readBoard(root);
  c.eq((before?.features?.[0]?.tasks ?? []).map((t) => t.no), [12], "前置：板上仅卡 #12（源变更前快照）");

  appendPlanCard(root, planRel); // 源变更后未重编译（Bash 通道漏检/人工编辑的漏网窗口）
  const r = runHook(RECONCILE_STOP, stopPayload(root, "收尾，本轮无 run_event 块。"));
  c.exit(r, 0, "退出码 0（兜底重编译不改投递语义）");
  c.eq(String(r.stdout ?? "").trim(), "", "stdout 恒空（R3 语义不变：不强推续跑）");

  const md = String(readReconcile(root) ?? "");
  c.ok(/## 3\. 板陈旧（1）[\s\S]*?plan-sess_t13-c9\.md/.test(md), "对账如实点名修复前陈旧（检查先于兜底重编译，C1 口径不变）", show(md.slice(0, 1600)));

  const after = readBoard(root);
  c.eq((after?.features?.[0]?.tasks ?? []).map((t) => t.no), [12, 13], "Stop 后板自动重编译：新卡 #13 已上板（免手动编译）");
  c.ok(/重编译/.test(String(r.stderr ?? "")), "stderr 留痕兜底重编译（可观测副作用）", show(r.stderr));
  c.ok(!/失败|异常|未完成/.test(String(r.stderr ?? "")), "stderr 零失败诊断（正常路径）", show(r.stderr));
  noTempFiles(c, root, "原子写零残留（无 .*.tmp-*）");
});

test("C10", "B3-3（#103）幂等：连续两次 Stop → 板文件掩码 updatedAt 后零 diff（双跑哈希一致）；第二次零失败诊断", (c) => {
  const root = newRoot("t13-c10");
  const planRel = writePlanFixture(root, { featureNo: 5, cards: [{ no: 12 }], rel: ".zcode/plans/plan-sess_t13-c10.md" });
  c.exit(runCompiler(root), 0, "前置编译退出码 0");
  appendPlanCard(root, planRel);

  const first = runHook(RECONCILE_STOP, stopPayload(root, "收尾（首跑）。", { sessionId: "sess_T13_C10a" }));
  c.exit(first, 0, "首跑退出码 0");
  c.eq(String(first.stdout ?? "").trim(), "", "首跑 stdout 恒空");
  const board1 = readBoard(root);
  c.eq((board1?.features?.[0]?.tasks ?? []).map((t) => t.no), [12, 13], "首跑已兜底重编译：新卡 #13 上板（幂等前置）");
  const json1 = readFileSync(join(root, BOARD_REL), "utf8");
  const md1 = readFileSync(join(root, BOARD_MD_REL), "utf8");

  const second = runHook(RECONCILE_STOP, stopPayload(root, "收尾（双跑）。", { sessionId: "sess_T13_C10b" }));
  c.exit(second, 0, "双跑第二次退出码 0");
  c.eq(String(second.stdout ?? "").trim(), "", "双跑第二次 stdout 恒空（输出契约不变）");
  c.ok(!/失败|异常|未完成/.test(String(second.stderr ?? "")), "第二次零失败诊断噪音", show(second.stderr));

  const json2 = readFileSync(join(root, BOARD_REL), "utf8");
  const md2 = readFileSync(join(root, BOARD_MD_REL), "utf8");
  c.eq(maskBoardUpdatedAt(json2), maskBoardUpdatedAt(json1), "双跑 board.json 掩码根 updatedAt 后零 diff（连续运行零额外变更）");
  c.eq(sha256(maskBoardUpdatedAt(json2)), sha256(maskBoardUpdatedAt(json1)), "双跑掩码板 sha256 一致（幂等证据）");
  c.eq(maskBoardMdStamp(md2), maskBoardMdStamp(md1), "双跑 board.md 掩码生成时间后零 diff");
  noTempFiles(c, root, "双跑后原子写零残留（无 .*.tmp-*）");
});

test("R9", "B3-3（#103）：register-interview 注册后触发重编译（新访谈即上板）；反例：未重编译板陈旧必咬；板未建立跳过；编译失败不阻塞", (c) => {
  // 1) 主路径：既有板 + append → 板即刻含新访谈条目（免手动编译）
  const root = newRoot("t13-r9");
  c.exit(runCompiler(root), 0, "前置编译退出码 0（空项目建板）");
  c.eq(readBoard(root)?.features?.length, 0, "前置：板 features=0（无访谈）");
  const r1 = runRegister(root, ["append", "--topic", "远控配对方案", "--summary", "确认配对与心跳。", "--outcome", "none"]);
  c.exit(r1, 0, "append 退出码 0");
  c.ok(/已登记：itw-/.test(String(r1.stdout ?? "")), "成功行照常输出（stdout 契约不变）", show(r1.stdout));
  const after = readBoard(root);
  const titles = (after?.features ?? []).map((f) => f.title);
  c.ok(titles.includes("远控配对方案"), "注册后板即刻含新访谈条目（触发重编译：新访谈即上板）", show(titles));
  c.eq(after?.features?.[0]?.kind, "interview-only", "新条目落为 interview-only 节点（新登记无产物）", show(after?.features?.[0]));

  // 2) 反例：直写 interviews.json（模拟未重编译的旧行为）→ 板陈旧 → --check 必咬
  w(root, ".zcode/board/interviews.json", JSON.stringify({
    version: 1,
    interviews: [
      { id: "itw-20261010-r901", at: "2026-10-10T09:00:00+08:00", sessionId: "", topic: "未重编译的登记", summary: "板应陈旧。", decisions: [], artifacts: [], outcome: "none", resolvedBy: "", status: "open" },
    ],
  }, null, 2) + "\n");
  const staleBoard = readBoard(root);
  c.ok(!(staleBoard?.features ?? []).some((f) => f.title === "未重编译的登记"), "反例前置：板未反映直写登记（板陈旧）");
  const chk = runCompilerWith(root, "--check");
  c.exit(chk, 1, "反例：未重编译 → --check 非零退出（板陈旧必咬）");
  c.ok(/\[board 不一致\]/.test(String(chk.stdout ?? "")) && /重编译即可修复/.test(String(chk.stdout ?? "")), "点名 board.json 与重编译期望不一致（修复路径 = 重编译）", show(String(chk.stdout).slice(0, 1400)));

  // 3) 板未建立：跳过重编译（零板文件写入），注册主流程照常成功
  const root2 = newRoot("t13-r9b");
  const r2 = runRegister(root2, ["append", "--topic", "首访无板", "--summary", "无板可刷新。", "--outcome", "none"]);
  c.exit(r2, 0, "无板根：append 退出码 0（跳过重编译不阻塞）");
  c.eq(isFile(join(root2, BOARD_REL)), false, "板未建立：跳过（不凭空生成 board.json）");
  c.eq(isFile(join(root2, BOARD_MD_REL)), false, "板未建立：不生成 board.md");
  const doc2 = readJsonFile(join(root2, ".zcode/board/interviews.json"));
  c.ok(doc2.ok && doc2.value?.interviews?.length === 1, "登记本身照常落盘（触发不越权改主流程）");

  // 4) 编译失败不阻塞（只读失败语义）：board.md 写盘目标被占为目录 → 编译器非零退出 → stderr 诊断、主流程退出码 0
  const root3 = newRoot("t13-r9c");
  c.exit(runCompiler(root3), 0, "前置编译退出码 0");
  rmSync(join(root3, BOARD_MD_REL));
  mkdirSync(join(root3, BOARD_MD_REL));
  const r3 = runRegister(root3, ["append", "--topic", "失败不阻塞", "--summary", "编译写盘失败。", "--outcome", "none"]);
  c.exit(r3, 0, "编译失败不阻塞：append 退出码 0");
  c.ok(/已登记：itw-/.test(String(r3.stdout ?? "")), "成功行照常输出（stdout 契约不变）", show(r3.stdout));
  c.ok(/重编译失败/.test(String(r3.stderr ?? "")), "编译失败写 stderr 诊断（不静默）", show(r3.stderr));
  const doc3 = readJsonFile(join(root3, ".zcode/board/interviews.json"));
  c.ok(doc3.ok && doc3.value?.interviews?.length === 1, "登记落盘不受编译失败影响（主流程照常成功）");
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
