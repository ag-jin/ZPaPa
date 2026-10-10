#!/usr/bin/env node
/**
 * zcode-board / T8 场景断言脚本（红→绿同一脚本，测试先行；T16 可直接复跑）
 *
 * 覆盖（任务 T8 + 检查点 2）：
 *   - register-interview.mjs  append：id 生成 itw-<日期>-<短后缀>、at 带时区、机械/未知字段留空不猜、
 *     追加式（既有条目零改写）、模板形态保留、用法错误退出码 2 且不写、损坏源不覆盖；
 *   - register-interview.mjs  resolve：按 id 回填 resolvedBy（+status=resolved）、其余字段不动、
 *     未命中 id 非零退出且不写；
 *   - 编译联动（结构性半场）：append → interview-only 节点出现；resolve → 登记条目与特性节点合并、
 *     interview-only 消失（attention 码值归 T7，本脚本只断言结构）；
 *   - lib/runs.mjs  appendRun：原子追加、机械字段补齐（runId/sessionId/at）、不覆盖报告自有字段、
 *     cards: [] 无卡事件、worktree/branch 仅显式声明时转抄（缺省一律 null + diagnostics，v2.1 勘误 #42）、
 *     层级标签丢弃 + diagnostics、
 *     表外 role/result 跳过、损坏源不覆盖、追加只增不改；
 *   - 检查点 2（文件级单写者）：interviews.json 仅 register-interview.mjs 写、runs.json 仅 lib/runs.mjs 写
 *     （静态扫描交付物源码中的写入调用）；夹具全部位于系统临时目录，真实板文件零触碰。
 *
 * 用法：
 *   node assets/test/run-t8-scenarios.mjs [--only A1,A2] [--clean]
 * 退出码：0 = 全部通过；1 = 有失败。
 */

import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { readJsonFile } from "../lib/board-io.mjs";
import {
  ASSETS_DIR,
  COMPILER,
  isFile,
  newRoot as newRootRaw,
  diffSnapshot,
  toPosix,
  treeSnapshot,
  w,
} from "./fixtures/build-fixture.mjs";

const REGISTER = join(ASSETS_DIR, "register-interview.mjs");
const RUNS_MODULE = join(ASSETS_DIR, "lib", "runs.mjs");

const INTERVIEWS_REL = ".zcode/board/interviews.json";
const RUNS_REL = ".zcode/board/runs.json";
const TEMPLATES = join(ASSETS_DIR, "templates");

/** 独立于实现的形态断言（与 board.schema.json 的 pattern 同源，故此处手写复述）。 */
const ISO_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([+-][0-9]{2}:[0-9]{2}|Z)$/;
const INTERVIEW_ID_RE = /^itw-[0-9]{8}-[0-9a-z]{4}$/;
const ENTRY_KEYS = [
  "id",
  "at",
  "sessionId",
  "topic",
  "summary",
  "decisions",
  "artifacts",
  "outcome",
  "resolvedBy",
  "status",
];

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

  /** 子进程退出码断言（附带 stderr 便于定位红）。 */
  exit(result, expected, label) {
    const detail =
      `期望退出码 ${expected}；实际 ${String(result.status)}` +
      `（signal=${String(result.signal)} error=${result.error ? result.error.message : "无"}）` +
      `\n          stderr：${String(result.stderr ?? "").trim().split("\n").slice(0, 3).join(" / ")}` +
      `\n          stdout：${String(result.stdout ?? "").trim().split("\n").slice(0, 3).join(" / ")}`;
    return this.ok(result.status === expected, label, detail);
  }
}

// ---------------------------------------------------------------- 运行器

function runRegister(root, args) {
  if (!isFile(REGISTER)) {
    return { status: null, signal: null, stdout: "", stderr: "", error: new Error(`CLI 不存在：${REGISTER}`) };
  }
  return spawnSync(process.execPath, [REGISTER, root, ...args], { encoding: "utf8" });
}

function runCompiler(root) {
  const r = spawnSync(process.execPath, [COMPILER, root], { encoding: "utf8" });
  const boardPath = join(root, ".zcode", "board", "board.json");
  const loaded = readJsonFile(boardPath);
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    board: loaded.ok ? loaded.value : null,
    boardText: loaded.text,
    boardPath,
  };
}

function readInterviewsDoc(root) {
  return readJsonFile(join(root, INTERVIEWS_REL));
}

function readRunsDoc(root) {
  return readJsonFile(join(root, RUNS_REL));
}

/** 临时文件零残留（原子写不得留下 .*.tmp-* 半成品）。 */
function noTempFiles(c, root, label) {
  const dir = join(root, ".zcode", "board");
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return c.ok(true, label, "目录不存在（无残留）");
  }
  return c.eq(names.filter((n) => n.startsWith(".")), [], label);
}

/** 夹具根必须位于系统临时目录：真实文件零触碰的机械护栏。 */
function assertTempRoot(c, root, label) {
  c.root = root;
  say(`  夹具：${toPosix(root)}`);
  const base = resolve(tmpdir());
  const abs = resolve(root);
  return c.ok(abs.startsWith(`${base}/`), label, `夹具根应在 ${base} 之下，实际 ${abs}`);
}

/** 当前用例（newRoot 包装器用它给每个夹具根自动加护栏并登记以便 --clean）。 */
let activeChecks = null;
function newRoot(tag) {
  const root = newRootRaw(tag);
  if (activeChecks) assertTempRoot(activeChecks, root, "夹具根位于系统临时目录（真实文件零触碰）");
  return root;
}

// ---------------------------------------------------------------- 用例定义

const TESTS = [];
function test(id, title, fn) {
  TESTS.push({ id, title, fn });
}

// ---- 静态：交付物形态与依赖边界

test("S1", "静态：CLI 存在、--help 含两种登记形态、无第三方依赖", (c) => {
  c.ok(isFile(REGISTER), `register-interview.mjs 存在（${toPosix(REGISTER)}）`);
  const help = runRegister("", ["--help"]);
  c.exit(help, 0, "--help 退出码 0");
  const text = String(help.stdout ?? "");
  c.ok(
    text.includes("append") && text.includes("--topic") && text.includes("--summary") && text.includes("--outcome"),
    "--help 含 append 形态（--topic/--summary/--outcome）",
  );
  c.ok(
    text.includes("resolve") && text.includes("--id") && text.includes("--resolved-by"),
    "--help 含 resolve 形态（--id/--resolved-by）",
  );
  if (isFile(REGISTER)) {
    const src = readFileSync(REGISTER, "utf8");
    const imports = [...src.matchAll(/^\s*import\s+[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    const bad = imports.filter((s) => !s.startsWith("node:") && !s.startsWith("./") && !s.startsWith("../"));
    c.eq(bad, [], "register-interview.mjs 仅 node 内置与相对导入（无第三方依赖）");
  }
});

// ---- append：新建登记

test("A1", "append：新根建档 — id/at/sessionId/topic/summary/decisions/artifacts/outcome/resolvedBy/status", (c) => {
  const root = newRoot("t8-a1");
  const before = treeSnapshot(root);
  const r = runRegister(root, [
    "append",
    "--topic",
    "预览发布通道方案",
    "--summary",
    "确认 tag 规则与四项实施任务。",
    "--outcome",
    "plan",
  ]);
  c.exit(r, 0, "append 退出码 0");

  const loaded = readInterviewsDoc(root);
  c.ok(loaded.ok, "interviews.json 可解析", String(loaded.error ?? ""));
  const doc = loaded.ok ? loaded.value : null;
  c.eq(doc?.version, 1, "新建文件 version=1");
  c.ok(Array.isArray(doc?.interviews), "interviews 为数组");
  c.eq(doc?.interviews?.length, 1, "含 1 条登记");
  const e = doc?.interviews?.[0] ?? {};
  c.ok(INTERVIEW_ID_RE.test(e.id), "id 形态 itw-<日期>-<短后缀>", `实际 ${show(e.id)}`);
  c.ok(ISO_RE.test(e.at), "at 为带时区 ISO 8601", `实际 ${show(e.at)}`);
  c.ok(Math.abs(Date.parse(e.at) - Date.now()) < 5000, "at 为登记时刻（±5s）", `实际 ${show(e.at)}`);
  c.eq(e.sessionId, "", "sessionId 未知留空（不猜）");
  c.eq(e.topic, "预览发布通道方案", "topic 照抄");
  c.eq(e.summary, "确认 tag 规则与四项实施任务。", "summary 照抄");
  c.eq(e.decisions, [], "decisions 缺省为空数组（不猜）");
  c.eq(e.artifacts, [], "artifacts 缺省为空数组（不猜）");
  c.eq(e.outcome, "plan", "outcome 照抄");
  c.eq(e.resolvedBy, "", "resolvedBy 缺省留空（不猜）");
  c.eq(e.status, "open", "append 后 status=open");
  c.eq(Object.keys(e).sort(), [...ENTRY_KEYS].sort(), "字段齐备且无多余键");
  const diff = diffSnapshot(before, treeSnapshot(root), [INTERVIEWS_REL]);
  c.eq(
    [diff.changed.length, diff.removed.length, diff.added.length],
    [0, 0, 0],
    "仅新增 interviews.json，夹具内其余零触碰",
  );
  noTempFiles(c, root, "原子写零残留（无 .*.tmp-*）");
  c.ok(readFileSync(join(root, INTERVIEWS_REL), "utf8").endsWith("\n"), "文件以换行结尾（writeJsonAtomic 形态）");
});

// ---- append：追加式 + 可选字段（decisions/artifacts/session-id）

test("A2", "append：二次追加只增不改 + --decisions/--artifacts/--session-id 可选字段", (c) => {
  const root = newRoot("t8-a2");
  const r1 = runRegister(root, ["append", "--topic", "甲主题", "--summary", "甲结论。", "--outcome", "none"]);
  c.exit(r1, 0, "首次 append 退出码 0");
  const first = readInterviewsDoc(root).value?.interviews?.[0] ?? null;

  const r2 = runRegister(root, [
    "append",
    "--topic",
    "乙主题",
    "--summary",
    "乙结论。",
    "--outcome",
    "spec",
    "--session-id",
    "sess_T8_A2",
    "--decisions",
    "先落接口",
    "--decisions",
    "再做校验",
    "--artifacts",
    ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000002.md",
  ]);
  c.exit(r2, 0, "二次 append 退出码 0");
  const doc = readInterviewsDoc(root).value ?? {};
  c.eq(doc.interviews?.length, 2, "两条登记");
  c.ok(deepEqual(doc.interviews?.[0], first), "既有条目逐字段不变（追加式：只增不改）", show(doc.interviews?.[0]));
  const e2 = doc.interviews?.[1] ?? {};
  c.eq(e2.sessionId, "sess_T8_A2", "--session-id 照抄");
  c.eq(e2.decisions, ["先落接口", "再做校验"], "--decisions 可重复，按序落数组");
  c.eq(e2.artifacts, [".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000002.md"], "--artifacts 落数组");
  c.eq(e2.outcome, "spec", "outcome 照抄");
  c.ok(e2.id !== first?.id, "id 唯一");
  noTempFiles(c, root, "原子写零残留（无 .*.tmp-*）");
});

// ---- append：模板形态保留

test("A3", "append：模板复制件 —— 保留 _note/version，仅向 interviews 追加", (c) => {
  const root = newRoot("t8-a3");
  const tplText = readFileSync(join(TEMPLATES, "interviews.template.json"), "utf8");
  const tpl = JSON.parse(tplText);
  w(root, INTERVIEWS_REL, tplText);
  const r = runRegister(root, ["append", "--topic", "模板根登记", "--summary", "结论。", "--outcome", "tasks"]);
  c.exit(r, 0, "append 退出码 0");
  const doc = readInterviewsDoc(root).value ?? {};
  c.eq(doc._note, tpl._note, "顶层 _note 原样保留");
  c.eq(doc.version, 1, "version 保留 1");
  c.eq(doc.interviews?.length, 1, "interviews 追加 1 条");
  c.eq(doc.interviews?.[0]?.outcome, "tasks", "outcome 照抄");
});

// ---- append：用法错误与损坏源

test("A4", "append：用法错误退出码 2 且零写入（表外 outcome / 缺必填 / 未知选项 / 根不存在）", (c) => {
  const root = newRoot("t8-a4");
  const cases = [
    ["表外 outcome", ["append", "--topic", "x", "--summary", "y", "--outcome", "bogus"]],
    ["缺 --topic", ["append", "--summary", "y", "--outcome", "none"]],
    ["缺 --summary", ["append", "--topic", "x", "--outcome", "none"]],
    ["缺 --outcome", ["append", "--topic", "x", "--summary", "y"]],
    ["--artifacts 为绝对路径", ["append", "--topic", "x", "--summary", "y", "--outcome", "none", "--artifacts", "/tmp/absolute.md"]],
    ["未知选项", ["append", "--topic", "x", "--summary", "y", "--outcome", "none", "--nope", "1"]],
    ["缺子命令", []],
    ["多余位置参数", ["append", "extra", "--topic", "x", "--summary", "y", "--outcome", "none"]],
  ];
  for (const [label, args] of cases) {
    const r = runRegister(root, args);
    c.ok(r.status === 2, `用法错误（${label}）退出码 2`, `实际 ${String(r.status)}；stderr=${String(r.stderr ?? "").trim()}`);
  }
  const rMissingRoot = spawnSync(process.execPath, [REGISTER, "/nonexistent-root-t8-xyz", "append", "--topic", "x", "--summary", "y", "--outcome", "none"], {
    encoding: "utf8",
  });
  c.ok(rMissingRoot.status === 2, "根目录不存在退出码 2", `实际 ${String(rMissingRoot.status)}`);
  c.ok(!isFile(join(root, INTERVIEWS_REL)), "用法错误路径零写入（文件未创建）");
  noTempFiles(c, root, "零残留");
});

test("A5", "append：损坏源不覆盖（解析失败/结构非法 → 非零退出、字节不变）", (c) => {
  const root = newRoot("t8-a5");
  const broken = '{\n  "version": 1,\n  "interviews": [\n';
  w(root, INTERVIEWS_REL, broken);
  const r1 = runRegister(root, ["append", "--topic", "x", "--summary", "y", "--outcome", "none"]);
  c.ok(r1.status !== 0 && r1.status !== null, "解析失败时非零退出（不静默重建）", `实际 ${String(r1.status)}`);
  c.eq(readFileSync(join(root, INTERVIEWS_REL), "utf8"), broken, "损坏文件字节不变（不丢数据）");

  const bad = JSON.stringify({ version: 1, interviews: "not-an-array" }, null, 2) + "\n";
  w(root, INTERVIEWS_REL, bad);
  const r2 = runRegister(root, ["append", "--topic", "x", "--summary", "y", "--outcome", "none"]);
  c.ok(r2.status !== 0 && r2.status !== null, "结构非法（interviews 非数组）非零退出", `实际 ${String(r2.status)}`);
  c.eq(readFileSync(join(root, INTERVIEWS_REL), "utf8"), bad, "结构非法文件字节不变");
  noTempFiles(c, root, "零残留");
});

// ---- 编译联动：interview-only 节点（结构性半场）

test("A6", "append → 编译出现 interview-only 节点；编译对 interviews.json 只读", (c) => {
  const root = newRoot("t8-a6");
  const r = runRegister(root, [
    "append",
    "--topic",
    "预览发布通道方案",
    "--summary",
    "确认 tag 规则与四项实施任务。",
    "--outcome",
    "plan",
  ]);
  c.exit(r, 0, "append 退出码 0");
  const entry = readInterviewsDoc(root).value?.interviews?.[0] ?? {};
  const beforeBytes = readFileSync(join(root, INTERVIEWS_REL), "utf8");

  const comp = runCompiler(root);
  c.exit(comp, 0, "编译退出码 0");
  const features = comp.board?.features ?? [];
  c.eq(features.length, 1, "编译后 1 个特性节点");
  const f = features[0] ?? {};
  c.eq(f.kind, "interview-only", "结构性半场：kind=interview-only（缺口码值归 T7）");
  c.eq(f.id, `interview:${entry.id}`, "节点 id 以登记 id 为句柄");
  c.eq(f.title, "预览发布通道方案", "title 取 topic");
  c.eq(f.details, "确认 tag 规则与四项实施任务。", "details 取 summary");
  c.eq(f.status, "pending", "status=pending");
  c.eq(f.origin, { type: "interview", interviewId: entry.id }, "origin 指向登记 id");
  c.eq(f.evidence, [`${INTERVIEWS_REL}#${entry.id}`], "evidence 指针为登记簿条目");
  c.ok(!Object.hasOwn(f, "no") && !Object.hasOwn(f, "label"), "访谈事件不占号（no/label 双缺省）");
  c.eq(readFileSync(join(root, INTERVIEWS_REL), "utf8"), beforeBytes, "编译后 interviews.json 字节不变（只读）");
});

// ---- resolve：回填 → 合并（结构性半场）

test("B1", "resolve：回填 resolvedBy/status → 编译合并特性节点、interview-only 消失", (c) => {
  const root = newRoot("t8-b1");
  const planRel = ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000008.md";
  const planId = "plan:sess_00000000-0000-4000-8000-000000000008";
  w(root, planRel, ["# 甲方案", "", "- [ ] 1. 甲任务", "  - 甲任务正文首行。", ""].join("\n"));

  const r1 = runRegister(root, [
    "append",
    "--topic",
    "甲方案讨论",
    "--summary",
    "确认甲方案与一项实施任务。",
    "--outcome",
    "plan",
  ]);
  c.exit(r1, 0, "append（含 --artifacts）退出码 0");
  const entry1 = readInterviewsDoc(root).value?.interviews?.[0] ?? {};

  const comp1 = runCompiler(root);
  c.exit(comp1, 0, "resolve 前编译退出码 0");
  c.eq(
    (comp1.board?.features ?? []).map((f) => f.kind).sort(),
    ["interview-only", "plan"],
    "resolve 前：计划节点 + interview-only 节点并存（未 resolve 不合并）",
  );
  c.eq(
    (comp1.board?.diagnostics ?? []).filter((d) => d.path === INTERVIEWS_REL),
    [],
    "登记簿无诊断（无 artifacts，resolvedBy 空 → 不报错）",
  );

  const r2 = runRegister(root, ["resolve", "--id", entry1.id, "--resolved-by", planId]);
  c.exit(r2, 0, "resolve 退出码 0");
  const entry2 = readInterviewsDoc(root).value?.interviews?.[0] ?? {};
  c.eq(entry2.resolvedBy, planId, "resolvedBy 回填为特性节点 id");
  c.eq(entry2.status, "resolved", "status 置 resolved");
  c.eq(
    { ...entry2, resolvedBy: entry1.resolvedBy, status: entry1.status },
    entry1,
    "其余字段零改写（登记条目唯一允许改写 = resolvedBy/status）",
  );
  c.eq(readInterviewsDoc(root).value?.interviews?.length, 1, "仍为 1 条登记（不新增）");

  const comp2 = runCompiler(root);
  c.exit(comp2, 0, "resolve 后编译退出码 0");
  const features = comp2.board?.features ?? [];
  c.eq(features.length, 1, "编译后仅 1 个特性节点");
  const f = features[0] ?? {};
  c.eq(f.kind, "plan", "节点 kind=plan");
  c.eq(f.id, planId, "特性节点 id 稳定");
  c.eq(f.origin?.interviewId, entry1.id, "origin.interviewId 由 resolvedBy 补全");
  c.eq(features.filter((x) => x.kind === "interview-only").length, 0, "interview-only 节点消失（合并）");
  c.eq(f.details, "确认甲方案与一项实施任务。", "details 取登记 summary（≤200 截断）");
  c.eq(f.tasks?.[0]?.title, "甲任务", "计划稿条目仍派生为卡片");
});

test("B2", "resolve：错误路径（id 未命中 / 形态非法 / 缺参 / 损坏源）非零退出且零写入", (c) => {
  const root = newRoot("t8-b2");
  const ok = runRegister(root, ["append", "--topic", "甲", "--summary", "乙", "--outcome", "none"]);
  c.exit(ok, 0, "预置登记退出码 0");
  const beforeBytes = readFileSync(join(root, INTERVIEWS_REL), "utf8");
  const entry = readInterviewsDoc(root).value?.interviews?.[0] ?? {};

  const notFound = runRegister(root, ["resolve", "--id", "itw-20261009-zzzz", "--resolved-by", "plan:x"]);
  c.exit(notFound, 1, "id 未命中 → 退出码 1");
  c.eq(readFileSync(join(root, INTERVIEWS_REL), "utf8"), beforeBytes, "id 未命中：文件字节不变");

  for (const [label, args] of [
    ["id 形态非法", ["resolve", "--id", "itw-2026-zz", "--resolved-by", "plan:x"]],
    ["缺 --id", ["resolve", "--resolved-by", "plan:x"]],
    ["缺 --resolved-by", ["resolve", "--id", entry.id ?? "itw-20261009-0000"]],
    ["未知选项", ["resolve", "--id", entry.id ?? "itw-20261009-0000", "--resolved-by", "plan:x", "--nope", "1"]],
    ["多余位置参数", ["resolve", "extra", "--id", entry.id ?? "itw-20261009-0000", "--resolved-by", "plan:x"]],
  ]) {
    const r = runRegister(root, args);
    c.ok(r.status === 2, `用法错误（${label}）退出码 2`, `实际 ${String(r.status)}；stderr=${String(r.stderr ?? "").trim()}`);
  }
  c.eq(readFileSync(join(root, INTERVIEWS_REL), "utf8"), beforeBytes, "用法错误：文件字节不变");

  const broken = '{\n  "version": 1,\n  "interviews": [\n';
  w(root, INTERVIEWS_REL, broken);
  const rBroken = runRegister(root, ["resolve", "--id", entry.id ?? "itw-20261009-0000", "--resolved-by", "plan:x"]);
  c.ok(rBroken.status === 1, "损坏源 → 退出码 1（拒绝覆盖）", `实际 ${String(rBroken.status)}`);
  c.eq(readFileSync(join(root, INTERVIEWS_REL), "utf8"), broken, "损坏源字节不变");
  noTempFiles(c, root, "零残留");
});

test("B3", "append --artifacts：产物与活源同路径 → 编译器经 artifacts 路径合并（§4.2 第二路）", (c) => {
  const root = newRoot("t8-b3");
  const planRel = ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000009.md";
  const planId = "plan:sess_00000000-0000-4000-8000-000000000009";
  w(root, planRel, ["# 乙方案", "", "- [ ] 1. 乙任务", ""].join("\n"));
  const r = runRegister(root, [
    "append",
    "--topic",
    "乙方案讨论",
    "--summary",
    "确认乙方案。",
    "--outcome",
    "plan",
    "--artifacts",
    planRel,
  ]);
  c.exit(r, 0, "append（--artifacts 命中活源）退出码 0");
  const entry = readInterviewsDoc(root).value?.interviews?.[0] ?? {};
  const comp = runCompiler(root);
  c.exit(comp, 0, "编译退出码 0");
  const features = comp.board?.features ?? [];
  c.eq(features.length, 1, "仅 1 个特性节点（artifacts 命中活源即合并）");
  c.eq(features[0]?.id, planId, "合并到计划特性节点");
  c.eq(features[0]?.origin?.interviewId, entry.id, "origin.interviewId 补全");
  c.eq(features[0]?.details, "确认乙方案。", "details 取登记 summary");
  c.eq(
    (comp.board?.diagnostics ?? []).filter((d) => d.path === INTERVIEWS_REL),
    [],
    "登记簿无诊断（artifacts 文件真实存在）",
  );
});

// ---------------------------------------------------------------- appendRun（lib/runs.mjs）

let runsImport = null;
async function getRuns() {
  if (runsImport === null) {
    try {
      runsImport = { ok: true, mod: await import(RUNS_MODULE) };
    } catch (e) {
      runsImport = { ok: false, error: e };
    }
  }
  return runsImport;
}

/** 屏蔽动态 runId/at 后与字面期望对象逐字段比对（期望值来自契约，不借实现重算）。 */
function maskRun(rec) {
  const out = { ...rec };
  if (typeof out.runId === "string" && /^run-[0-9]{8}-[0-9a-z]{4}$/.test(out.runId)) out.runId = "<runId>";
  if (typeof out.at === "string" && ISO_RE.test(out.at)) out.at = "<at>";
  return out;
}

const RUN_KEYS = [
  "runId",
  "sessionId",
  "role",
  "at",
  "result",
  "cards",
  "worktree",
  "branch",
  "evidence",
  "breakpoint",
];

test("S2", "静态：lib/runs.mjs 存在、导出 appendRun、无第三方依赖", async (c) => {
  c.ok(isFile(RUNS_MODULE), `lib/runs.mjs 存在（${toPosix(RUNS_MODULE)}）`);
  const got = await getRuns();
  c.ok(got.ok, "lib/runs.mjs 可导入", got.ok ? "" : String(got.error?.message ?? got.error));
  if (got.ok) {
    c.ok(typeof got.mod.appendRun === "function", "导出 appendRun 函数");
    c.eq(got.mod.RUNS_REL, RUNS_REL, "导出 RUNS_REL 与契约路径一致");
  }
  if (isFile(RUNS_MODULE)) {
    const src = readFileSync(RUNS_MODULE, "utf8");
    const imports = [...src.matchAll(/^\s*import\s+[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    const bad = imports.filter((s) => !s.startsWith("node:") && !s.startsWith("./") && !s.startsWith("../"));
    c.eq(bad, [], "lib/runs.mjs 仅 node 内置与相对导入（无第三方依赖）");
  }
});

test("C1", "appendRun：最小块 — 机械字段补齐、未声明 worktree/branch 不推导（缺省 null + diagnostics）、记录逐字段", async (c) => {
  const root = newRoot("t8-c1");
  const got = await getRuns();
  if (!got.ok) return c.ok(false, "lib/runs.mjs 可导入", String(got.error?.message ?? got.error));
  const now = new Date(2026, 9, 9, 14, 20, 0);
  const res = got.mod.appendRun(
    root,
    {
      role: "implementer",
      result: "partial",
      cards: [8],
      stoppedAt: 8,
      evidence: ["specs/preview-channel/updater.ts"],
      nextStep: "补 updater 单测后重新验证",
    },
    { sessionId: "sess_T8_C1", now },
  );
  c.eq(res.ok, true, "appendRun 成功");
  c.ok(
    (res.diagnostics ?? []).some((d) => d.message.includes("未声明工作树")),
    "未声明 worktree/branch → diagnostics 提示「未声明工作树」（不静默）",
    show(res.diagnostics),
  );
  c.ok(/^run-[0-9]{8}-[0-9a-z]{4}$/.test(String(res.record?.runId)), "runId 形态 run-<日期>-<短后缀>", show(res.record?.runId));
  c.ok(ISO_RE.test(String(res.record?.at)), "at 带时区 ISO 8601", show(res.record?.at));
  c.ok(Math.abs(Date.parse(res.record?.at) - now.getTime()) < 1000, "at = 注入的落账时刻（秒精度）", show(res.record?.at));
  c.eq(maskRun(res.record), {
    runId: "<runId>",
    sessionId: "sess_T8_C1",
    role: "implementer",
    at: "<at>",
    result: "partial",
    cards: [8],
    worktree: null,
    branch: null,
    evidence: ["specs/preview-channel/updater.ts"],
    breakpoint: { stoppedAt: 8, next: "补 updater 单测后重新验证" },
  }, "记录逐字段（契约 §3 落账映射 + v2.1 勘误：worktree/branch 不按卡号推导，缺省一律 null）");
  c.eq(Object.keys(res.record ?? {}), RUN_KEYS, "记录键序与契约字段表一致");
  const doc = readRunsDoc(root).value ?? {};
  c.eq(doc.version, 1, "runs.json 新建 version=1");
  c.eq(doc.runs?.length, 1, "含 1 条记录");
  c.eq(doc.runs?.[0], res.record, "文件内记录与返回值一致");
  noTempFiles(c, root, "原子写零残留（无 .*.tmp-*）");
});

test("C2", "appendRun：cards: [] 无卡事件 — 不推导 worktree/branch、断点缺省 null + diagnostics", async (c) => {
  const root = newRoot("t8-c2");
  const got = await getRuns();
  if (!got.ok) return c.ok(false, "lib/runs.mjs 可导入", String(got.error?.message ?? got.error));
  const res = got.mod.appendRun(root, { role: "code-reviewer", result: "done" }, { sessionId: "sess_T8_C2" });
  c.eq(res.ok, true, "appendRun 成功");
  c.eq(maskRun(res.record), {
    runId: "<runId>",
    sessionId: "sess_T8_C2",
    role: "code-reviewer",
    at: "<at>",
    result: "done",
    cards: [],
    worktree: null,
    branch: null,
    evidence: [],
    breakpoint: null,
  }, "无卡事件：cards []、worktree/branch/breakpoint 缺省为 null、evidence []");
  c.ok((res.diagnostics ?? []).length > 0, "worktree 不可推导 → diagnostics 提示（不静默）");
  const doc = readRunsDoc(root).value ?? {};
  c.eq(doc.runs?.[0]?.cards, [], "落账为无卡关联事件");
});

test("C3", "appendRun：不覆盖报告自有字段；自报机械字段一律忽略；未知键不转抄", async (c) => {
  const root = newRoot("t8-c3");
  const got = await getRuns();
  if (!got.ok) return c.ok(false, "lib/runs.mjs 可导入", String(got.error?.message ?? got.error));
  const now = new Date(2026, 9, 9, 16, 0, 0);
  const res = got.mod.appendRun(
    root,
    {
      role: "integrator",
      result: "done",
      cards: [9],
      worktree: ".zcode/worktrees/task-9",
      branch: "task-9",
      evidence: ["Merge task-9 [#9] (a1b2c3d)"],
      runId: "run-19700101-0000",
      at: "1970-01-01T00:00:00Z",
      sessionId: "sess_forged",
      notes: "叙事不进账",
    },
    { sessionId: "sess_T8_C3", now },
  );
  c.eq(res.ok, true, "appendRun 成功");
  c.eq(
    maskRun(res.record),
    {
      runId: "<runId>",
      sessionId: "sess_T8_C3",
      role: "integrator",
      at: "<at>",
      result: "done",
      cards: [9],
      worktree: ".zcode/worktrees/task-9",
      branch: "task-9",
      evidence: ["Merge task-9 [#9] (a1b2c3d)"],
      breakpoint: null,
    },
    "报告自有字段照抄；runId/at/sessionId 用机械值（防伪造时钟）",
  );
  c.ok(res.record?.runId !== "run-19700101-0000", "自报 runId 被忽略");
  c.ok(res.record?.at !== "1970-01-01T00:00:00Z", "自报 at 被忽略");
  c.ok(Math.abs(Date.parse(res.record?.at) - now.getTime()) < 1000, "at 取机械时钟");
  c.eq(Object.keys(res.record ?? {}).includes("notes"), false, "未知键不转抄");
});

test("C4", "appendRun：多卡不推导 task-<no>（显式给出则照抄）+ diagnostics", async (c) => {
  const root = newRoot("t8-c4");
  const got = await getRuns();
  if (!got.ok) return c.ok(false, "lib/runs.mjs 可导入", String(got.error?.message ?? got.error));
  const multi = got.mod.appendRun(root, { role: "implementer", result: "partial", cards: [7, 8] }, { sessionId: "s" });
  c.eq(multi.ok, true, "多卡块可落账");
  c.eq([multi.record?.worktree, multi.record?.branch], [null, null], "多卡未给出 → 不推导（缺省不造）");
  c.ok((multi.diagnostics ?? []).length > 0, "多卡不可推导 → diagnostics 提示");
  const explicit = got.mod.appendRun(
    root,
    { role: "implementer", result: "partial", cards: [7, 8], worktree: ".zcode/worktrees/task-7", branch: "task-7" },
    { sessionId: "s" },
  );
  c.eq([explicit.record?.worktree, explicit.record?.branch], [".zcode/worktrees/task-7", "task-7"], "显式执行现场照抄");
  const half = got.mod.appendRun(
    root,
    { role: "implementer", result: "partial", cards: [7], worktree: ".zcode/worktrees/task-7" },
    { sessionId: "s" },
  );
  c.eq([half.record?.worktree, half.record?.branch], [".zcode/worktrees/task-7", null], "半声明：给出的一侧照抄、缺省位 null（不推导、不丢弃）");
  c.ok((half.diagnostics ?? []).length > 0, "半声明 → diagnostics 提示「未声明工作树」（不静默）");
});

test("C5", "appendRun：引用位非法值丢弃 + diagnostics（层级标签拒收；非正整数拒收）", async (c) => {
  const root = newRoot("t8-c5");
  const got = await getRuns();
  if (!got.ok) return c.ok(false, "lib/runs.mjs 可导入", String(got.error?.message ?? got.error));
  const res = got.mod.appendRun(
    root,
    {
      role: "implementer",
      result: "partial",
      cards: ["ID-1.2", 3, 0, -1, 1.5, true],
      stoppedAt: "1.2",
      evidence: ["ok/path.ts", 7, null],
      nextStep: "下一步",
    },
    { sessionId: "s" },
  );
  c.eq(res.ok, true, "块本身有效 → 照常落账（仅非法值丢弃）");
  c.eq(res.record?.cards, [3], "层级标签/零/负/小数/布尔 全部丢弃，仅保留正整数");
  c.eq(res.record?.breakpoint, { stoppedAt: null, next: "下一步" }, "stoppedAt 非法 → null（不猜卡号）；nextStep 保留");
  c.eq(res.record?.evidence, ["ok/path.ts"], "evidence 非字符串项丢弃");
  c.ok((res.diagnostics ?? []).length >= 3, "每次丢弃都有 diagnostics（不静默）", show(res.diagnostics));
  c.eq(
    [res.record?.worktree, res.record?.branch],
    [null, null],
    "丢弃后恰剩 1 卡也不推导（v2.1 勘误 #42：执行现场只认显式声明，缺省一律 null）",
  );
});

test("C6", "appendRun：表外 role/result 跳过该块且零写入；interrupted 仅机械通道可记", async (c) => {
  const root = newRoot("t8-c6");
  const got = await getRuns();
  if (!got.ok) return c.ok(false, "lib/runs.mjs 可导入", String(got.error?.message ?? got.error));
  const badRole = got.mod.appendRun(root, { role: "architect", result: "done" }, { sessionId: "s" });
  c.eq(badRole.ok, false, "表外 role 跳过该块");
  c.ok((badRole.diagnostics ?? []).length > 0, "表外 role → diagnostics");
  const badResult = got.mod.appendRun(root, { role: "implementer", result: "maybe" }, { sessionId: "s" });
  c.eq(badResult.ok, false, "表外 result 跳过该块");
  const interruptedReport = got.mod.appendRun(root, { role: "implementer", result: "interrupted" }, { sessionId: "s" });
  c.eq(interruptedReport.ok, false, "报告通道不得自报 interrupted（run-event.md §2）");
  c.eq(isFile(join(root, RUNS_REL)), false, "全部跳过 → runs.json 未创建（零写入）");
  const mechanical = got.mod.appendRun(
    root,
    { role: "implementer", result: "interrupted", cards: [4] },
    { sessionId: "s", mechanical: true },
  );
  c.eq(mechanical.ok, true, "机械通道（Stop hook 补记）可写 interrupted");
  c.eq(mechanical.record?.result, "interrupted", "result=interrupted 照抄");
  c.eq(mechanical.record?.worktree, null, "机械通道同样只认显式声明（缺省 null，v2.1 勘误 #42）");
  c.eq((readRunsDoc(root).value?.runs ?? []).length, 1, "仅机械记录入库");
});

test("C7", "appendRun：追加式只增不改 + runId 唯一 + 模板形态保留", async (c) => {
  const root = newRoot("t8-c7");
  const tpl = readFileSync(join(TEMPLATES, "runs.template.json"), "utf8");
  w(root, RUNS_REL, tpl);
  const got = await getRuns();
  if (!got.ok) return c.ok(false, "lib/runs.mjs 可导入", String(got.error?.message ?? got.error));
  const r1 = got.mod.appendRun(root, { role: "implementer", result: "partial", cards: [8], stoppedAt: 8, nextStep: "继续" }, { sessionId: "s1" });
  const first = r1.record;
  const r2 = got.mod.appendRun(root, { role: "test-verifier", result: "done", cards: [8] }, { sessionId: "s2" });
  const doc = readRunsDoc(root).value ?? {};
  c.eq(doc._note, JSON.parse(tpl)._note, "顶层 _note 原样保留");
  c.eq(doc.version, 1, "version 保留 1");
  c.eq(doc.runs?.length, 2, "两条记录");
  c.eq(doc.runs?.[0], first, "既有记录逐字段不变（追加式）");
  c.ok(doc.runs?.[0]?.runId !== doc.runs?.[1]?.runId, "runId 唯一");
  c.eq(doc.runs?.[1]?.worktree, null, "第二条同样不推导（缺省 null，v2.1 勘误 #42）");
  noTempFiles(c, root, "零残留");
});

test("C8", "appendRun：损坏源不覆盖（解析失败 / runs 非数组 → 报错零写入）", async (c) => {
  const root = newRoot("t8-c8");
  const got = await getRuns();
  if (!got.ok) return c.ok(false, "lib/runs.mjs 可导入", String(got.error?.message ?? got.error));
  const broken = '{\n  "version": 1,\n  "runs": [\n';
  w(root, RUNS_REL, broken);
  const res = got.mod.appendRun(root, { role: "implementer", result: "done", cards: [1] }, { sessionId: "s" });
  c.eq(res.ok, false, "解析失败 → 拒绝落账");
  c.ok((res.diagnostics ?? []).length > 0, "解析失败 → diagnostics（不静默）");
  c.eq(readFileSync(join(root, RUNS_REL), "utf8"), broken, "损坏文件字节不变（不丢数据）");
  const badShape = JSON.stringify({ version: 1, runs: "nope" }, null, 2) + "\n";
  w(root, RUNS_REL, badShape);
  const res2 = got.mod.appendRun(root, { role: "implementer", result: "done", cards: [1] }, { sessionId: "s" });
  c.eq(res2.ok, false, "runs 非数组 → 拒绝落账");
  c.eq(readFileSync(join(root, RUNS_REL), "utf8"), badShape, "结构非法文件字节不变");
  noTempFiles(c, root, "零残留");
});

test("C9", "appendRun 后编译：runs.json 只读（lastRun 派生归 T7）、板正常产出", async (c) => {
  const root = newRoot("t8-c9");
  const got = await getRuns();
  if (!got.ok) return c.ok(false, "lib/runs.mjs 可导入", String(got.error?.message ?? got.error));
  const res = got.mod.appendRun(root, { role: "implementer", result: "partial", cards: [8], stoppedAt: 8, nextStep: "继续" }, { sessionId: "s" });
  c.eq(res.ok, true, "appendRun 成功");
  const beforeBytes = readFileSync(join(root, RUNS_REL), "utf8");
  const comp = runCompiler(root);
  c.exit(comp, 0, "编译退出码 0");
  c.eq(readFileSync(join(root, RUNS_REL), "utf8"), beforeBytes, "编译对 runs.json 只读（字节不变）");
  c.ok(comp.board !== null, "board.json 可解析");
  c.ok(
    comp.board?.sources?.some((s) => s.kind === "runs" && s.path === RUNS_REL),
    "sources[] 含 runs.json（场景 23 前置）",
  );
});

test("C10", "检查点 2：写入路径唯一（源码静态扫描：interviews.json 仅 register、runs.json 仅 lib/runs.mjs）", (c) => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      let st = null;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (name === "node_modules" || name === "fixtures") continue;
        walk(abs);
        continue;
      }
      if (!name.endsWith(".mjs")) continue;
      if (toPosix(abs).includes("/test/")) continue; // 测试脚本只写临时夹具，不是交付物写入路径
      files.push(abs);
    }
  };
  walk(ASSETS_DIR);
  const violations = [];
  const seen = new Set();
  for (const abs of files) {
    const src = readFileSync(abs, "utf8");
    const re = /(writeJsonAtomic|writeFileAtomic|writeFileSync|appendFileSync|createWriteStream|renameSync)\s*\(/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const window = src.slice(m.index, m.index + 300);
      const rel = toPosix(abs);
      if (/interviews\.json|INTERVIEWS_REL/.test(window) && rel !== toPosix(REGISTER)) {
        violations.push(`${rel}: ${m[1]} → interviews.json`);
      }
      if (/runs\.json|RUNS_REL/.test(window) && rel !== toPosix(RUNS_MODULE)) {
        violations.push(`${rel}: ${m[1]} → runs.json`);
      }
      seen.add(rel);
    }
  }
  c.eq(violations, [], `仅 register-interview.mjs 写 interviews.json、仅 lib/runs.mjs 写 runs.json（扫描 ${files.length} 个交付模块）`);
  c.ok(files.length >= 3, "扫描覆盖面（compile-board.mjs + lib/ + hooks/ 等交付模块）", show([...seen].sort()));
  const regSrc = isFile(REGISTER) ? readFileSync(REGISTER, "utf8") : "";
  c.ok(!/runs\.json|RUNS_REL/.test(regSrc), "register-interview.mjs 不触碰 runs.json");
  const runsSrc = isFile(RUNS_MODULE) ? readFileSync(RUNS_MODULE, "utf8") : "";
  c.ok(!/interviews\.json|INTERVIEWS_REL/.test(runsSrc), "lib/runs.mjs 不触碰 interviews.json");
});

// ---- pr 转抄白名单（契约 v2.1 §2/§3；卡 #36）

test("C11", "appendRun：契约 v2.1 — 合法 pr 转抄 {number 正整数, url http(s)}；白名单外键仍不转抄", async (c) => {
  const root = newRoot("t8-c11");
  const got = await getRuns();
  if (!got.ok) return c.ok(false, "lib/runs.mjs 可导入", String(got.error?.message ?? got.error));
  const res = got.mod.appendRun(
    root,
    {
      role: "integrator",
      result: "done",
      cards: [9],
      pr: { number: 41, url: "https://github.com/ag-jin/ZPaPa/pull/41", mergedAt: "2026-10-10T00:00:00+08:00" },
      evidence: [".zcode/board/runs.json"],
      notes: "叙事不进账",
    },
    { sessionId: "sess_T36_C11" },
  );
  c.eq(res.ok, true, "integrator 远程门禁块照常落账");
  c.eq(
    (res.diagnostics ?? []).filter((d) => String(d.message).includes("pr")),
    [],
    "合法 pr 零 pr 诊断（未声明工作树的 diagnostics 与 pr 无关，单列——v2.1 勘误 #42）",
  );
  c.eq(
    res.record?.pr,
    { number: 41, url: "https://github.com/ag-jin/ZPaPa/pull/41" },
    "pr 仅转抄 {number, url} 两键（对象内白名单外键不转抄）",
  );
  c.eq(Object.keys(res.record ?? {}), [...RUN_KEYS, "pr"], "记录键 = 冻结键序 + 末尾 pr（未知键 notes 照旧不转抄）");
  const doc = readRunsDoc(root).value ?? {};
  c.eq(doc.runs?.[0]?.pr, { number: 41, url: "https://github.com/ag-jin/ZPaPa/pull/41" }, "runs.json 文件内 pr 落账");
  noTempFiles(c, root, "原子写零残留（无 .*.tmp-*）");
});

test("C12", "appendRun：pr 形态非法 → 该值不落 + diagnostics（url 非 http(s)、number 非正整数、非对象）", async (c) => {
  const root = newRoot("t8-c12");
  const got = await getRuns();
  if (!got.ok) return c.ok(false, "lib/runs.mjs 可导入", String(got.error?.message ?? got.error));
  const cases = [
    ["url 非 http(s)", { number: 41, url: "ftp://example.com/41" }],
    ["url 缺省", { number: 41 }],
    ["number 为 0", { number: 0, url: "https://example.com/pull/41" }],
    ["number 为负", { number: -3, url: "https://example.com/pull/41" }],
    ["number 为字符串", { number: "41", url: "https://example.com/pull/41" }],
    ["number 为小数", { number: 1.5, url: "https://example.com/pull/41" }],
    ["空对象", {}],
    ["数组", [41]],
    ["字符串", "https://example.com/pull/41"],
  ];
  for (const [label, pr] of cases) {
    const res = got.mod.appendRun(root, { role: "integrator", result: "done", cards: [9], pr }, { sessionId: "s" });
    c.eq(res.ok, true, `形态非法不废整块（${label}）：照常落账`);
    c.eq(Object.hasOwn(res.record ?? {}, "pr"), false, `pr 不落字段（${label}）`);
    c.ok(
      (res.diagnostics ?? []).some((d) => String(d.message).includes("pr")),
      `pr 形态非法 → diagnostics（${label}）`,
      show(res.diagnostics),
    );
  }
  const doc = readRunsDoc(root).value ?? {};
  c.eq(doc.runs?.length, cases.length, "每条非法块均照常入库（仅 pr 值丢弃）");
  c.eq(doc.runs?.filter((r) => Object.hasOwn(r, "pr")).length, 0, "文件内零 pr 字段（不产出 schema 非法形态）");
});

test("C13", "appendRun：pr 缺省 / 显式 null → 不造该字段、零 pr 诊断（本地模式恒缺省）", async (c) => {
  const root = newRoot("t8-c13");
  const got = await getRuns();
  if (!got.ok) return c.ok(false, "lib/runs.mjs 可导入", String(got.error?.message ?? got.error));
  const absent = got.mod.appendRun(
    root,
    { role: "integrator", result: "done", cards: [43], evidence: ["Merge task-43 [#43] (d4e5f6a)"] },
    { sessionId: "s" },
  );
  c.eq(Object.keys(absent.record ?? {}), RUN_KEYS, "缺省：记录键与冻结键序一致（不造 pr）");
  c.eq(Object.hasOwn(absent.record ?? {}, "pr"), false, "缺省：字段不存在（非 null 占位）");
  c.eq(
    (absent.diagnostics ?? []).filter((d) => String(d.message).includes("pr")),
    [],
    "缺省：零 pr 诊断（缺省不是违规）",
  );
  const explicitNull = got.mod.appendRun(
    root,
    { role: "integrator", result: "done", cards: [43], pr: null },
    { sessionId: "s" },
  );
  c.eq(Object.hasOwn(explicitNull.record ?? {}, "pr"), false, "显式 null ≡ 缺省：不造该字段（与块内其余可选字段同口径）");
  c.eq(
    (explicitNull.diagnostics ?? []).filter((d) => String(d.message).includes("pr")),
    [],
    "显式 null 不产生 pr 诊断",
  );
  const doc = readRunsDoc(root).value ?? {};
  c.eq(doc.runs?.filter((r) => Object.hasOwn(r, "pr")).length, 0, "文件内零 pr 字段");
});

// ---------------------------------------------------------------- 主流程

async function main(argv) {
  const onlyIdx = argv.indexOf("--only");
  const only = onlyIdx >= 0 ? new Set(String(argv[onlyIdx + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) : null;
  const clean = argv.includes("--clean");

  say("zcode-board · T8 场景断言（测试先行：红 → 绿）");
  say(`node    : ${process.version}`);
  say(`assets  : ${toPosix(ASSETS_DIR)}`);
  say(`CLI     : ${toPosix(REGISTER)}（存在：${isFile(REGISTER)}）`);
  say(`runs    : ${toPosix(RUNS_MODULE)}（存在：${isFile(RUNS_MODULE)}）`);
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
