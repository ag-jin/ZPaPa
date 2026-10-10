#!/usr/bin/env node
/**
 * zcode-board / T10 场景断言脚本（红→绿同一脚本，测试先行；T16 可直接复跑）
 *
 * 覆盖（任务 T10 + 设计 §3.2 附加校验 / §13 场景 9,10,19）：
 *   - 场景 10（全量）  手工篡改 board.json 与源不一致 → 报差异、非零退出；修复 = 重编译后
 *             --check 复绿；源侧改动（板陈旧）同样被检出；
 *   - 场景 9（退出码半场）  损坏源（progress.json / interviews.json 解析失败）→ --check 非零退出
 *            （diagnostics/降级半场归 T6，默认编译仍退 0）；
 *   - 场景 19（退出码半场）  同号双实体 → --check 非零退出（assign 不改号、退 0 归 T9）；
 *   - registry 一致性（独立夹具）  活标记无 registry 条目 / kind 不一致 / 指向不一致 → 非零退出；
 *            registry 空洞条目（指向文件仍在、号标记已移除）合法 → 通过；--assign 修复后复绿；
 *   - 场景 35b 归档直查（勘误 10）  归档条目按指向路径直查（存在且含标记 → 通过 + note"已归档"）；
 *            移动后未改写指向（归档候选已验证）→ 失败级独立诊断（运行 --assign 可机械修复）；
 *            指向真失效且无候选 → 提示级独立诊断（§3.2 空洞仍合法，但不以通用文案静默放行）；
 *   - schema 结构校验（独立夹具）  board.json 枚举/类型/引用位整数/attentionSummary 逐码相等
 *            （T7 公共不变量）+ 板解析失败 → 非零退出；
 *   - 活号唯一（独立夹具）  同号双实体 → 非零退出；
 *   - 契约 §2.4 过渡态例外（#43）  未领号特性下带号卡（卡保 no、label 缺省）合法 → --check 通过；
 *            已领号特性而卡缺 label（反向不成立）→ 结构断言仍非零退出；
 *   - 过渡态 board.md 渲染降级（#44）  带号卡 label 缺省 → 任务行与待处理指针渲染 #<no>，
 *            全文无 undefined；--assign 领号补齐后回归 ID-<label> 正常态；
 *   - 零副作用   --check 全程只读：全部文件 sha256 + mtime 前后一致；板不存在时不建板；
 *            连续两次 --check 逐字节无变化；
 *   - CLI      --check 与 --assign 互斥（退出码 2）；未知选项退出码 2；--help 含 --check；
 *   - 模块契约  lib/schema-check.mjs（子集校验器 + 板不变量），board.schema.json 与 golden 过检；
 *   - 静态断言  无第三方依赖。
 *
 * 用法：
 *   node assets/test/run-t10-scenarios.mjs                # 全部
 *   node assets/test/run-t10-scenarios.mjs --only 10,9c   # 只跑指定用例
 *   node assets/test/run-t10-scenarios.mjs --clean        # 跑完删除临时夹具（默认保留供留证）
 * 退出码：0 = 全部通过；1 = 有失败。
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { readJsonFile } from "../lib/board-io.mjs";
import {
  ASSETS_DIR,
  COMPILER,
  diffSnapshot,
  isDir,
  isFile,
  newRoot,
  removeRoot,
  toPosix,
  treeSnapshot,
  w,
} from "./fixtures/build-fixture.mjs";

const BOARD_REL = ".zcode/board/board.json";
const BOARD_MD_REL = ".zcode/board/board.md";
const REGISTRY_REL = ".zcode/board/registry.json";

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

function truncate(s, n = 300) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
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

  inc(haystack, needle, label) {
    const has = typeof haystack === "string" && haystack.includes(needle);
    return this.ok(has, label, `未在文本中找到 ${show(needle)}`);
  }

  exit(result, expected, label) {
    const detail =
      `期望退出码 ${expected}；实际 ${String(result.code)}` +
      (result.error ? `（spawn error=${result.error.message}）` : "") +
      `\n          stdout：${truncate(result.stdout, 400)}` +
      `\n          stderr：${truncate(result.stderr, 300)}`;
    return this.ok(result.code === expected, label, detail);
  }
}

// ---------------------------------------------------------------- 夹具与调用公用件

function runCompiler(root, args = []) {
  const res = spawnSync(process.execPath, [COMPILER, root, ...args], { encoding: "utf8" });
  return {
    args,
    code: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error ?? null,
  };
}

const runCheck = (root) => runCompiler(root, ["--check"]);
const runAssign = (root) => runCompiler(root, ["--assign"]);

function runCompile(root) {
  return runCompiler(root, []);
}

function readText(root, rel) {
  return readFileSync(join(root, rel), "utf8");
}

function readBoard(root) {
  const loaded = readJsonFile(join(root, BOARD_REL));
  return loaded.ok ? loaded.value : null;
}

function writeBoard(root, board) {
  writeFileSync(join(root, BOARD_REL), `${JSON.stringify(board, null, 2)}\n`);
}

function readRegistry(root) {
  const loaded = readJsonFile(join(root, REGISTRY_REL));
  return loaded.ok ? loaded.value : null;
}

/** --check 全程只读：全部文件（含产物）字节 + mtime 前后一致。 */
function assertNoWrites(c, before, after, label) {
  const diff = diffSnapshot(before, after);
  c.eq(diff.changed.map((x) => x.rel), [], `${label}：无任何文件被改写（sha256 + mtime）`);
  c.eq(diff.added, [], `${label}：无新增文件`);
  c.eq(diff.removed, [], `${label}：无文件被删除`);
}

function walkNodes(features, fn) {
  const walkTasks = (tasks, ptr) => {
    for (const [i, t] of (tasks ?? []).entries()) {
      fn(t, `${ptr}.tasks[${i}]`);
      walkTasks(t.tasks, `${ptr}.tasks[${i}]`);
    }
  };
  for (const [i, f] of (features ?? []).entries()) {
    fn(f, `features[${i}]`);
    walkTasks(f.tasks, `features[${i}]`);
  }
}

function goldenBoard() {
  return JSON.parse(readFileSync(join(ASSETS_DIR, "samples", "board.golden.json"), "utf8"));
}

// ---------------------------------------------------------------- 用例定义

const TESTS = [];
function test(id, title, fn) {
  TESTS.push({ id, title, fn });
}

// ---- 静态：交付物 / CLI / 依赖边界
test("static", "静态：schema-check.mjs 存在、--check 与 --assign 互斥、无第三方依赖、help 含 --check", (c) => {
  c.ok(isFile(join(ASSETS_DIR, "lib", "schema-check.mjs")), "交付物存在：assets/lib/schema-check.mjs");

  const help = runCompiler(process.cwd(), ["--help"]);
  c.exit(help, 0, "--help 退出码 0");
  c.inc(help.stdout, "--check", "帮助文档记录 --check（审计模式）");
  c.inc(help.stdout, "[--assign]", "帮助仍载 --assign 用法（T9 冻结面不回退）");
  c.inc(help.stdout, "只读", "帮助声明 --check 只读（零副作用）");

  const root = newRoot("t10-cli");
  w(root, ".zcode/plans/plan-cli.md", ["# CLI 夹具", "", "- **T1 甲（草案）**：正文。", ""].join("\n"));
  const before = treeSnapshot(root);

  const both = runCompiler(root, ["--check", "--assign"]);
  c.exit(both, 2, "--check 与 --assign 同时出现 → 用法错误退出码 2");
  c.inc(both.stderr, "互斥", "用法错误说明互斥原因");
  const unknown = runCompiler(root, ["--nope"]);
  c.exit(unknown, 2, "未知选项仍退出码 2（既有行为不回退）");
  assertNoWrites(c, before, treeSnapshot(root), "用法错误路径");

  const files = [];
  const collect = (dir) => {
    if (!isDir(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (isDir(p)) {
        if (name === "node_modules") continue;
        collect(p);
        continue;
      }
      if (/\.mjs$/.test(name)) files.push(p);
    }
  };
  collect(ASSETS_DIR);
  const offenders = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g)) {
      const spec = m[1];
      if (!spec.startsWith("node:") && !spec.startsWith(".") && !spec.startsWith("/")) {
        offenders.push(`${toPosix(f.slice(ASSETS_DIR.length + 1))} → ${spec}`);
      }
    }
    for (const m of text.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = m[1];
      if (!spec.startsWith("node:") && !spec.startsWith(".") && !spec.startsWith("/")) {
        offenders.push(`${toPosix(f.slice(ASSETS_DIR.length + 1))} → 动态 import ${spec}`);
      }
    }
  }
  c.eq(offenders, [], `全部 ${files.length} 个 .mjs 仅使用 node: 内置或相对导入（无第三方依赖）`);
  removeRoot(root);
});

// ---- 模块契约：lib/schema-check.mjs（子集校验器 + 板不变量）
test("module", "模块契约：子集关键字约束、schema 校验、板不变量（引用位/attentionSummary/号）", async (c) => {
  const mod = await import("../lib/schema-check.mjs");
  const { ALLOWED_SCHEMA_KEYWORDS, checkSchemaSubset, validateSchemaValue, checkBoardInvariants } = mod;
  const allowed = new Set(ALLOWED_SCHEMA_KEYWORDS);
  c.ok(
    ["type", "required", "properties", "items", "enum", "const", "oneOf", "pattern"].every((k) => allowed.has(k)) &&
      allowed.size === 8,
    "关键字子集 = T1 冻结清单（type/required/properties/items/enum/const/oneOf/pattern）",
    show([...(ALLOWED_SCHEMA_KEYWORDS ?? [])]),
  );

  const schemaLoaded = readJsonFile(join(ASSETS_DIR, "board.schema.json"));
  c.ok(schemaLoaded.ok, "board.schema.json 可解析");
  c.eq(checkSchemaSubset(schemaLoaded.value), [], "board.schema.json 自身只使用受约束关键字子集");
  const badSchema = { type: "object", additionalProperties: false };
  c.ok(checkSchemaSubset(badSchema).length > 0, "子集外的关键字（additionalProperties）被判违规", show(checkSchemaSubset(badSchema)));

  const golden = goldenBoard();
  const goldenErrors = validateSchemaValue(schemaLoaded.value, golden);
  c.eq(goldenErrors, [], "golden 通过子集校验器（T1 独立样例）");
  const versionDrift = validateSchemaValue(schemaLoaded.value, { ...golden, version: 3 });
  c.ok(versionDrift.length > 0, "version 主版本漂移被判违规（const 2）", show(versionDrift.slice(0, 2)));

  c.eq(checkBoardInvariants(golden), [], "golden 通过板不变量（T7 公共不变量 + 引用位整数）");

  const refBroken = JSON.parse(JSON.stringify(golden));
  let refPtr = null;
  walkNodes(refBroken.features, (n, ptr) => {
    if (refPtr === null && Number.isInteger(n.no)) {
      n.no = "9";
      refPtr = ptr;
    }
  });
  const refErrors = checkBoardInvariants(refBroken);
  c.ok(
    refErrors.length > 0 && refErrors.join("\n").includes("整数"),
    `${refPtr}.no 写成字符串 → 引用位整数断言拒绝（"号是身份"）`,
    show(refErrors.slice(0, 2)),
  );

  const summaryBroken = JSON.parse(JSON.stringify(golden));
  summaryBroken.attentionSummary.interruptedResume += 3;
  const summaryErrors = checkBoardInvariants(summaryBroken);
  c.ok(
    summaryErrors.some((e) => e.includes("attentionSummary")),
    "attentionSummary 与节点 attention 逐码相等为硬不变量（计数漂移被拒）",
    show(summaryErrors.slice(0, 2)),
  );

  const ruleBroken = JSON.parse(JSON.stringify(golden));
  ruleBroken.features[0].statusRule = "";
  c.ok(
    checkBoardInvariants(ruleBroken).some((e) => e.includes("statusRule")),
    "statusRule 非空为硬不变量（可溯源）",
  );
  const stageBroken = JSON.parse(JSON.stringify(golden));
  stageBroken.features[0].stage = "已完成中";
  c.ok(
    checkBoardInvariants(stageBroken).some((e) => e.includes("stage")),
    "stage ∈ 七段位词表为硬不变量",
  );

  // §2.4 过渡态例外（#43）：卡有 no 无 label 合法 ⟺ 所属特性未领号（特性 no/label 双缺）；
  // 特性节点自身仍严格执行"同时存在或同时缺省"（放宽不得泄漏到特性层）。
  const transitional = JSON.parse(JSON.stringify(golden));
  const owner = transitional.features.find((f) => Number.isInteger(f.no) && (f.tasks ?? []).some((t) => Number.isInteger(t.no)));
  delete owner.no;
  delete owner.label;
  for (const t of owner.tasks) delete t.label;
  c.ok(
    !checkBoardInvariants(transitional).some((e) => e.includes("no/label")),
    "§2.4 过渡态：未领号特性下带号卡（no 在、label 缺省）不判 no/label 违规",
    show(checkBoardInvariants(transitional).slice(0, 3)),
  );
  const featureLabelBroken = JSON.parse(JSON.stringify(golden));
  delete featureLabelBroken.features[0].label;
  c.ok(
    checkBoardInvariants(featureLabelBroken).some((e) => e.includes("no/label")),
    "§2.4 反向：特性有 no 而缺 label 仍判 no/label 违规（例外不外溢到特性层）",
    show(checkBoardInvariants(featureLabelBroken).slice(0, 3)),
  );
  const cardLabelBroken = JSON.parse(JSON.stringify(golden));
  const numberedOwner = cardLabelBroken.features.find((f) => Number.isInteger(f.no) && (f.tasks ?? []).some((t) => Number.isInteger(t.no)));
  delete numberedOwner.tasks[0].label;
  c.ok(
    checkBoardInvariants(cardLabelBroken).some((e) => e.includes("no/label")),
    "§2.4 反例：已领号特性下卡缺 label 仍判 no/label 违规（例外仅限未领号特性）",
    show(checkBoardInvariants(cardLabelBroken).slice(0, 3)),
  );
});

// ---- 场景 10（全量）：篡改检测 → 报差异 + 非零退出；修复 = 重编译
test("10", "场景 10：篡改 board.json / 板陈旧 → 差异报告 + 退出码 1；重编译修复后复绿", (c) => {
  const root = newRoot("t10-s10");
  const planRel = ".zcode/plans/plan-s10.md";
  w(root, planRel, ["# 审计夹具", "", "- **T1 甲任务（草案）**：甲正文。", ""].join("\n"));

  const assign = runAssign(root);
  c.exit(assign, 0, "前置 --assign 退出码 0（生成带号板）");
  c.ok(isFile(join(root, BOARD_REL)), "板已生成：.zcode/board/board.json");

  // 0. 正对照：未篡改 → 通过
  const clean = runCheck(root);
  c.exit(clean, 0, "未篡改：--check 退出码 0");
  c.inc(clean.stdout, "结论：--check 通过", "报告结论为通过");
  c.ok(!clean.stdout.includes("校验失败"), "未篡改：无失败项");

  // 1. 篡改 board.json（任务卡 status pending → completed）
  const board = readBoard(root);
  c.eq(board.features[0].tasks[0].status, "pending", "前置：任务卡 status=pending");
  board.features[0].tasks[0].status = "completed";
  writeBoard(root, board);

  const before = treeSnapshot(root);
  const tampered = runCheck(root);
  const after = treeSnapshot(root);
  c.exit(tampered, 1, "篡改 board.json → --check 非零退出（退出码 1）");
  c.inc(tampered.stdout, "[board 不一致]", "失败项归类到板/源不一致（篡改检测）");
  c.inc(tampered.stdout, "features[0].tasks[0].status", "差异报告点名被篡改的字段路径");
  c.inc(tampered.stdout, "completed", "差异报告给出实际值（篡改后的值）");
  c.inc(tampered.stdout, "结论：--check 失败", "报告结论为失败");
  assertNoWrites(c, before, after, "篡改检测路径");

  const twice = runCheck(root);
  c.exit(twice, 1, "重复 --check 仍非零退出（不因运行而自愈）");

  // 2. 修复 = 重编译（--check 不自动修复）
  const recompiled = runCompile(root);
  c.exit(recompiled, 0, "重编译退出码 0（修复动作）");
  const healed = runCheck(root);
  c.exit(healed, 0, "重编译后 --check 复绿");
  c.ok(!healed.stdout.includes("校验失败"), "复绿：无失败项");

  // 3. 板陈旧（源侧改动未重编译）同样被检出
  w(root, planRel, ["# 审计夹具", "", "- **T1 甲任务（草案）**：甲正文已改。", ""].join("\n"));
  const stale = runCheck(root);
  c.exit(stale, 1, "源改动后未重编译（板陈旧）→ --check 非零退出");
  c.inc(stale.stdout, "features[0].tasks[0].details", "差异报告点名源侧漂移的字段");
  const staleAgain = runCompile(root);
  c.exit(staleAgain, 0, "重编译退出码 0");
  c.exit(runCheck(root), 0, "重编译后 --check 复绿（板与源一致）");
  removeRoot(root);
});

// ---- 场景 9（退出码半场）：损坏源 → --check 非零退出
test("9c", "场景 9 退出码半场：损坏源 → --check 非零退出（默认编译仍退 0，降级半场归 T6）", (c) => {
  const root = newRoot("t10-s9");
  w(root, "specs/gamma/requirements.md", "# Requirements: Gamma 特性\n");
  w(root, "specs/gamma/tasks.md", ["# Implementation Plan: Gamma", "", "- [ ] 1. 甲任务", "  - Scope: 甲细节。", ""].join("\n"));
  w(root, "specs/gamma/progress.json", "{ 这不是合法 JSON —— 版本字段与结构都不存在\n");
  w(root, ".zcode/board/interviews.json", "{ 同样损坏的登记簿\n");

  const compile = runCompile(root);
  c.exit(compile, 0, "默认模式：损坏源不失败（退出码 0，降级半场归 T6 已断言）");

  const before = treeSnapshot(root);
  const res = runCheck(root);
  const after = treeSnapshot(root);
  c.exit(res, 1, "损坏源：--check 非零退出（退出码 1）");
  c.inc(res.stdout, "[损坏源]", "失败项归类到损坏源");
  c.inc(res.stdout, "specs/gamma/progress.json", "报告点名损坏的 progress.json");
  c.inc(res.stdout, ".zcode/board/interviews.json", "报告点名损坏的 interviews.json");
  c.inc(res.stdout, "结论：--check 失败", "报告结论为失败");
  assertNoWrites(c, before, after, "损坏源审计路径");
  removeRoot(root);
});

// ---- 场景 19（退出码半场）：号码冲突 → --check 非零退出
test("19c", "场景 19 退出码半场：同号双实体 → --check 非零退出（assign 不改号、退 0 归 T9）", (c) => {
  const root = newRoot("t10-s19");
  const planRel = ".zcode/plans/plan-conflict.md";
  w(root, planRel, [
    "# 冲突夹具",
    "<!-- zcode-board: no=5 -->",
    "- **T1 先到（草案）**：先到者。 <!-- zcode-board: no=6 -->",
    "- **T2 后到（草案）**：后到者。 <!-- zcode-board: no=6 -->",
    "",
  ].join("\n"));
  w(root, REGISTRY_REL, JSON.stringify({ version: 1, seq: 6, entries: [
    { no: 5, kind: "plan", file: planRel, title: "冲突夹具", assignedAt: "2026-10-01T00:00:00+08:00" },
    { no: 6, kind: "task", file: planRel, title: "先到（草案）", assignedAt: "2026-10-01T00:00:00+08:00" },
  ] }, null, 2) + "\n");

  const assign = runAssign(root);
  c.exit(assign, 0, "--assign 退出码 0（不改号，T9 半场）");
  c.inc(assign.stderr, "重复", "assign 诊断点名重复（不静默）");

  const planTextBefore = readText(root, planRel);
  const before = treeSnapshot(root);
  const res = runCheck(root);
  const after = treeSnapshot(root);
  c.exit(res, 1, "号码冲突：--check 非零退出（退出码 1）");
  c.inc(res.stdout, "[号码冲突]", "失败项归类到号码冲突");
  c.inc(res.stdout, "号 6", "报告点名冲突号 6");
  c.inc(res.stdout, "结论：--check 失败", "报告结论为失败");
  c.eq(readText(root, planRel), planTextBefore, "冲突夹具源文件逐字节不变（--check 不改号不修复）");
  assertNoWrites(c, before, after, "冲突审计路径");
  removeRoot(root);
});

// ---- registry 一致性（独立夹具，四子例）
test("registry", "registry 一致性：无条目/kind 不一致/指向不一致 → 非零退出；空洞条目合法；assign 修复后复绿", (c) => {
  // a. 活标记未被 registry 登记 → 非零退出；--assign 补登记后复绿
  {
    const root = newRoot("t10-reg-a");
    const planRel = ".zcode/plans/plan-a.md";
    w(root, planRel, ["# 未登记夹具", "<!-- zcode-board: no=9 -->", "- **T1 甲（草案）**：正文。 <!-- zcode-board: no=10 -->", ""].join("\n"));
    w(root, REGISTRY_REL, JSON.stringify({ version: 1, seq: 0, entries: [] }, null, 2) + "\n");
    c.exit(runCompile(root), 0, "a：默认编译退出码 0");
    const res = runCheck(root);
    c.exit(res, 1, "a：活标记无 registry 条目 → --check 非零退出");
    c.inc(res.stdout, "[registry 不一致]", "a：失败项归类到 registry 不一致");
    c.inc(res.stdout, "无 registry 条目", "a：报告说明缺条目（指向 --assign 修复）");
    c.inc(res.stdout, "号 9", "a：报告点名未登记的号 9");
    const fixed = runAssign(root);
    c.exit(fixed, 0, "a：--assign 补登记退出码 0");
    c.eq(readRegistry(root)?.seq, 10, "a：seq 前进到 max(活标记)=10");
    c.exit(runCheck(root), 0, "a：补登记后 --check 复绿");
    removeRoot(root);
  }

  // b. kind 不一致（活标记是 task，registry 条目写 plan）→ 非零退出
  {
    const root = newRoot("t10-reg-b");
    const planRel = ".zcode/plans/plan-b.md";
    w(root, planRel, ["# kind 夹具", "<!-- zcode-board: no=1 -->", "- **T1 甲（草案）**：正文。 <!-- zcode-board: no=2 -->", ""].join("\n"));
    w(root, REGISTRY_REL, JSON.stringify({ version: 1, seq: 2, entries: [
      { no: 1, kind: "plan", file: planRel, title: "kind 夹具", assignedAt: "2026-10-01T00:00:00+08:00" },
      { no: 2, kind: "plan", file: planRel, title: "甲（草案）", assignedAt: "2026-10-01T00:00:00+08:00" },
    ] }, null, 2) + "\n");
    c.exit(runCompile(root), 0, "b：默认编译退出码 0");
    const res = runCheck(root);
    c.exit(res, 1, "b：registry 条目 kind 与活标记不一致 → --check 非零退出");
    c.inc(res.stdout, "kind", "b：报告点名 kind 不一致");
    c.inc(res.stdout, "号 2", "b：报告点名号 2");
    removeRoot(root);
  }

  // c. 指向不一致（条目指向他处文件）→ 非零退出
  {
    const root = newRoot("t10-reg-c");
    const planRel = ".zcode/plans/plan-c.md";
    w(root, planRel, ["# 指向夹具", "<!-- zcode-board: no=1 -->", "- **T1 甲（草案）**：正文。 <!-- zcode-board: no=2 -->", ""].join("\n"));
    w(root, REGISTRY_REL, JSON.stringify({ version: 1, seq: 2, entries: [
      { no: 1, kind: "plan", file: planRel, title: "指向夹具", assignedAt: "2026-10-01T00:00:00+08:00" },
      { no: 2, kind: "task", file: "docs/plans/plan-elsewhere.md", title: "甲（草案）", assignedAt: "2026-10-01T00:00:00+08:00" },
    ] }, null, 2) + "\n");
    c.exit(runCompile(root), 0, "c：默认编译退出码 0");
    const res = runCheck(root);
    c.exit(res, 1, "c：registry 条目指向与活标记位置不一致 → --check 非零退出");
    c.inc(res.stdout, "指向", "c：报告点名指向不一致");
    c.inc(res.stdout, planRel, "c：报告给出活标记所在文件");
    removeRoot(root);
  }

  // d. 空洞条目（源已删除，号不复用）合法 → 通过
  {
    const root = newRoot("t10-reg-d");
    const planRel = ".zcode/plans/plan-d.md";
    w(root, planRel, ["# 空洞夹具", "<!-- zcode-board: no=1 -->", "- **T1 甲（草案）**：正文。 <!-- zcode-board: no=2 -->", ""].join("\n"));
    w(root, REGISTRY_REL, JSON.stringify({ version: 1, seq: 99, entries: [
      { no: 1, kind: "plan", file: planRel, title: "空洞夹具", assignedAt: "2026-10-01T00:00:00+08:00" },
      { no: 2, kind: "task", file: planRel, title: "甲（草案）", assignedAt: "2026-10-01T00:00:00+08:00" },
      { no: 99, kind: "task", file: planRel, title: "已删条目（号成空洞，不复用）", assignedAt: "2026-10-01T00:00:00+08:00" },
    ] }, null, 2) + "\n");
    c.exit(runCompile(root), 0, "d：默认编译退出码 0");
    const res = runCheck(root);
    c.exit(res, 0, "d：registry 空洞条目（源已删除）合法 → --check 通过");
    c.inc(res.stdout, "结论：--check 通过", "d：报告结论为通过");
    c.ok(!res.stdout.includes("[registry 不一致]"), "d：空洞条目不报不一致（防过度严格）");
    removeRoot(root);
  }

  // e. 计划→spec 延续未改写 registry（延续前）→ 非零退出；--assign 改写后复绿
  {
    const root = newRoot("t10-reg-e");
    const planRel = ".zcode/plans/plan-sess_00000000-0000-4000-8000-0000000000ee.md";
    w(root, planRel, [
      "# 延续未改写夹具", "<!-- zcode-board: no=1 -->",
      "- **T1 甲（草案）**：正文。 <!-- zcode-board: no=2 -->",
      "",
    ].join("\n"));
    w(root, "specs/cont2/requirements.md", "# Requirements: 延续二\n");
    w(root, "specs/cont2/tasks.md", ["# Implementation Plan: 延续二", "", "- [ ] 1. 甲", "  - Scope: 甲。", ""].join("\n"));
    w(root, REGISTRY_REL, JSON.stringify({ version: 1, seq: 2, entries: [
      { no: 1, kind: "plan", file: planRel, title: "延续未改写夹具", assignedAt: "2026-10-01T00:00:00+08:00" },
      { no: 2, kind: "task", file: planRel, title: "甲（草案）", assignedAt: "2026-10-01T00:00:00+08:00" },
    ] }, null, 2) + "\n");
    w(root, ".zcode/board/interviews.json", JSON.stringify({ version: 1, interviews: [
      { id: "itw-reg-e", at: "2026-10-08T09:00:00+08:00", sessionId: "sess_e", topic: "延续", summary: "建 spec。", decisions: [], artifacts: [planRel], outcome: "spec", resolvedBy: "spec:cont2", status: "open" },
    ] }, null, 2) + "\n");
    c.exit(runCompile(root), 0, "e：默认编译退出码 0（编译已按延续退役计划节点）");
    const res = runCheck(root);
    c.exit(res, 1, "e：延续未改写 registry（条目仍是 plan 形态）→ --check 非零退出");
    c.inc(res.stdout, "kind", "e：报告点名 kind 不一致（号 1）");
    c.ok(!res.stdout.includes("[号码冲突]"), "e：延续退役的计划标记不被计为双实体（不误报冲突）");
    const fixed = runAssign(root);
    c.exit(fixed, 0, "e：--assign 执行延续改写退出码 0");
    c.exit(runCheck(root), 0, "e：延续改写后 --check 复绿");
    removeRoot(root);
  }
});

// ---- schema 结构校验（独立夹具）
test("schema", "schema 结构校验：枚举/引用位整数/attentionSummary/板损坏 → 非零退出", (c) => {
  const bootstrap = (tag) => {
    const root = newRoot(tag);
    w(root, ".zcode/plans/plan-sch.md", ["# 结构夹具", "", "- **T1 甲（草案）**：甲正文。", ""].join("\n"));
    const assign = runAssign(root);
    return { root, assign };
  };

  // A. 枚举违规（status 不在四词）
  {
    const { root, assign } = bootstrap("t10-sch-a");
    c.exit(assign, 0, "A：前置 --assign 退出码 0");
    const board = readBoard(root);
    board.features[0].status = "bogus";
    writeBoard(root, board);
    const res = runCheck(root);
    c.exit(res, 1, "A：status 枚举违规 → --check 非零退出");
    c.inc(res.stdout, "[板结构校验]", "A：失败项归类到板结构校验");
    c.inc(res.stdout, "不在枚举", "A：报告给出枚举违规原因");
    c.inc(res.stdout, "features[0].status", "A：报告点名违规路径");
    removeRoot(root);
  }

  // B. 引用位非整数（no 写成字符串）
  {
    const { root, assign } = bootstrap("t10-sch-b");
    c.exit(assign, 0, "B：前置 --assign 退出码 0");
    const board = readBoard(root);
    board.features[0].tasks[0].no = "2";
    writeBoard(root, board);
    const res = runCheck(root);
    c.exit(res, 1, "B：引用位写成字符串 → --check 非零退出");
    c.inc(res.stdout, "整数", "B：报告命中引用位整数断言（号是身份）");
    removeRoot(root);
  }

  // C. attentionSummary 计数漂移（schema 合法、不变量违规）
  {
    const { root, assign } = bootstrap("t10-sch-c");
    c.exit(assign, 0, "C：前置 --assign 退出码 0");
    const board = readBoard(root);
    board.attentionSummary.interruptedResume = 7;
    writeBoard(root, board);
    const res = runCheck(root);
    c.exit(res, 1, "C：attentionSummary 与节点 attention 不一致 → --check 非零退出");
    c.inc(res.stdout, "attentionSummary", "C：报告点名 attentionSummary 不变量");
    removeRoot(root);
  }

  // D. 板本身损坏（非法 JSON）
  {
    const { root, assign } = bootstrap("t10-sch-d");
    c.exit(assign, 0, "D：前置 --assign 退出码 0");
    writeFileSync(join(root, BOARD_REL), "{ 板不是合法 JSON\n");
    const res = runCheck(root);
    c.exit(res, 1, "D：board.json 解析失败 → --check 非零退出");
    c.inc(res.stdout, "解析失败", "D：报告说明板解析失败（重编译即可修复）");
    removeRoot(root);
  }
});

// ---- 场景 43（契约 §2.4 过渡态例外）：未领号特性下带号卡合法 → --check 通过；已领号特性而卡缺 label 仍违规
test("43", "契约 §2.4 过渡态：未领号特性下带号卡过 --check；已领号特性而卡缺 label 仍非零退出", (c) => {
  // A. 未领号特性（spec 根未在 registry 绑定号、无内联头标记）+ 带号卡（行尾标记）→ 合法过渡态
  {
    const root = newRoot("t10-s43a");
    const tasksRel = "specs/gamma/tasks.md";
    w(root, "specs/gamma/requirements.md", "# Requirements: Gamma 特性\n");
    w(root, tasksRel, [
      "# Implementation Plan: Gamma",
      "",
      "- [ ] 1. 甲任务 <!-- zcode-board: no=21 -->",
      "  - Scope: 甲。",
      "- [ ] 2. 乙任务 <!-- zcode-board: no=22 -->",
      "  - Scope: 乙。",
      "",
    ].join("\n"));
    w(root, REGISTRY_REL, JSON.stringify({ version: 1, seq: 22, entries: [
      { no: 21, kind: "task", file: tasksRel, title: "甲任务", assignedAt: "2026-10-01T00:00:00+08:00" },
      { no: 22, kind: "task", file: tasksRel, title: "乙任务", assignedAt: "2026-10-01T00:00:00+08:00" },
    ] }, null, 2) + "\n");

    c.exit(runCompile(root), 0, "A：前置默认编译退出码 0（过渡态源可编译）");
    const board = readBoard(root);
    const f = board?.features?.[0] ?? {};
    c.ok(!Object.hasOwn(f, "no") && !Object.hasOwn(f, "label"), "A：特性未领号（no/label 双缺）");
    c.ok(
      (f.tasks ?? []).length === 2 && f.tasks.every((t) => Number.isInteger(t.no) && !Object.hasOwn(t, "label")),
      "A：卡保留 no、label 缺省（§2.4 过渡态形态）",
      show((f.tasks ?? []).map((t) => ({ no: t.no, label: t.label }))),
    );

    const res = runCheck(root);
    c.exit(res, 0, "A：未领号特性下带号卡 → --check 通过（§2.4 过渡态例外，不判违规）");
    c.inc(res.stdout, "结论：--check 通过", "A：报告结论为通过");
    c.ok(!res.stdout.includes("no/label 应同时存在"), "A：不再命中 no/label 共存在断言");
    c.ok(!res.stdout.includes("校验失败"), "A：无失败项（含板/源互检零差异）");
    removeRoot(root);
  }

  // B. 已领号特性（label=1）而卡缺 label → 仍违规（§2.4「反向不成立」；放宽不得变成整体免检）
  {
    const root = newRoot("t10-s43b");
    const planRel = ".zcode/plans/plan-s43.md";
    w(root, planRel, [
      "# 过渡态反例",
      "<!-- zcode-board: no=1 -->",
      "- **T1 甲卡（草案）**：正文。 <!-- zcode-board: no=2 -->",
      "",
    ].join("\n"));
    const assign = runAssign(root);
    c.exit(assign, 0, "B：前置 --assign 退出码 0（特性已领号）");
    const board = readBoard(root);
    c.eq(board?.features?.[0]?.label, "1", "B：前置：特性已领号（label=1）");
    c.eq(board?.features?.[0]?.tasks?.[0]?.label, "1", "B：前置：卡带 label=1（#46 A2 计划内序）");

    delete board.features[0].tasks[0].label;
    writeBoard(root, board);
    const res = runCheck(root);
    c.exit(res, 1, "B：已领号特性而卡缺 label → --check 非零退出（结构断言仍生效）");
    c.inc(res.stdout, "[板结构校验]", "B：失败项归类到板结构校验（未随过渡态放宽）");
    c.inc(res.stdout, "no/label", "B：报告仍点名 no/label 共存在断言");
    removeRoot(root);
  }
});

// ---- 场景 44（#44 board.md 过渡态渲染降级）：带号卡 label 缺省 → 渲染 #<no>（不留 ID-undefined）；领号补齐后回归 ID-<label>
test("44", "场景 44：过渡态 board.md 渲染降级 —— 带号卡 label 缺省渲染 #<no>，全文无 undefined；领号后回归 ID-<label>", (c) => {
  // A. 未领号特性 + 带号卡（label 缺省）+ 一条 partial run（待处理段同走渲染器）→ 任务行与指针均降级为 #<no>
  const root = newRoot("t10-s44");
  const tasksRel = "specs/gamma/tasks.md";
  w(root, "specs/gamma/requirements.md", "# Requirements: Gamma 特性\n");
  w(root, tasksRel, [
    "# Implementation Plan: Gamma",
    "",
    "- [ ] 1. 甲任务 <!-- zcode-board: no=21 -->",
    "  - Scope: 甲。",
    "- [ ] 2. 乙任务 <!-- zcode-board: no=22 -->",
    "  - Scope: 乙。",
    "",
  ].join("\n"));
  w(root, REGISTRY_REL, JSON.stringify({ version: 1, seq: 22, entries: [
    { no: 21, kind: "task", file: tasksRel, title: "甲任务", assignedAt: "2026-10-01T00:00:00+08:00" },
    { no: 22, kind: "task", file: tasksRel, title: "乙任务", assignedAt: "2026-10-01T00:00:00+08:00" },
  ] }, null, 2) + "\n");
  w(root, ".zcode/board/runs.json", JSON.stringify({ version: 1, runs: [
    { runId: "run-20261009-s44", sessionId: "sess_s44", role: "implementer", at: "2026-10-09T10:00:00+08:00", result: "partial", cards: [21], evidence: [], breakpoint: { stoppedAt: 21, next: "补甲卡测试" } },
  ] }, null, 2) + "\n");

  c.exit(runCompile(root), 0, "A：前置默认编译退出码 0（过渡态源可编译）");
  const mdPre = readText(root, BOARD_MD_REL);
  c.inc(mdPre, "- #21 · 甲任务", "A：任务行降级渲染 #<no>（甲卡）");
  c.inc(mdPre, "- #22 · 乙任务", "A：任务行降级渲染 #<no>（乙卡）");
  c.inc(mdPre, "未领号 > #21 甲任务", "A：待处理指针同样降级（不落 ID-undefined）");
  c.ok(!mdPre.includes("undefined"), "A：过渡态 board.md 全文无 undefined");

  // B. --assign 领号补齐（特性 23 → 卡按树位 23.1/23.2）→ 渲染回归 ID-<label>，降级只属过渡态
  c.exit(runAssign(root), 0, "B：前置 --assign 退出码 0（特性领号 23）");
  c.exit(runCompile(root), 0, "B：领号后默认编译退出码 0");
  const mdPost = readText(root, BOARD_MD_REL);
  c.inc(mdPost, "ID-23.1 · 甲任务", "B：label 补齐后回归 ID-<label> 正常态（降级只属过渡态）");
  c.ok(!mdPost.includes("undefined"), "B：领号后 board.md 全文无 undefined");
  removeRoot(root);
});

// ---- 零副作用：--check 全程只读（板不存在不建板；连续运行零改写）
test("zeroside", "零副作用：--check 全程只读（sha256+mtime 一致；不建板；连续两次零变化）", (c) => {
  const root = newRoot("t10-zero");
  w(root, ".zcode/plans/plan-zero.md", ["# 只读夹具", "", "- **T1 甲（草案）**：正文。", ""].join("\n"));

  // 板不存在：不报错、不建板（缺板为提示级）
  const before1 = treeSnapshot(root);
  const noBoard = runCheck(root);
  const after1 = treeSnapshot(root);
  c.exit(noBoard, 0, "板不存在：--check 退出码 0（缺板为提示级，不阻断）");
  c.inc(noBoard.stdout, "board.json 不存在", "报告说明跳过板/源互检");
  c.eq(isFile(join(root, BOARD_REL)), false, "--check 不创建 board.json");
  c.eq(isFile(join(root, BOARD_MD_REL)), false, "--check 不创建 board.md");
  c.eq(isDir(join(root, ".zcode", "board")), false, "--check 不创建 .zcode/board 目录（零写入含目录面）");
  assertNoWrites(c, before1, after1, "缺板审计路径");

  // 已编译：连续两次 --check 零改写
  c.exit(runCompile(root), 0, "前置默认编译退出码 0");
  const boardTextBefore = readText(root, BOARD_REL);
  const mdTextBefore = readText(root, BOARD_MD_REL);
  const before2 = treeSnapshot(root);
  const first = runCheck(root);
  const after2 = treeSnapshot(root);
  c.exit(first, 0, "首次 --check 退出码 0");
  assertNoWrites(c, before2, after2, "首次 --check");
  const second = runCheck(root);
  const after3 = treeSnapshot(root);
  c.exit(second, 0, "二次 --check 退出码 0");
  assertNoWrites(c, after2, after3, "二次 --check");
  c.eq(readText(root, BOARD_REL), boardTextBefore, "board.json 逐字节不变（未被 --check 重写）");
  c.eq(readText(root, BOARD_MD_REL), mdTextBefore, "board.md 逐字节不变");
  c.eq(first.stdout, second.stdout, "两次 --check 报告逐字节一致（不动即确定）");
  removeRoot(root);
});

// ---- 正对照：全源类型干净工程 + 计划→spec 延续 → 通过（防误报）
test("positive", "正对照：spec/plan/runs/登记全源干净 → 通过；计划→spec 延续后 → 通过（防误报）", (c) => {
  // a. 全源类型工程
  {
    const root = newRoot("t10-pos-a");
    w(root, "specs/alpha/requirements.md", "# Requirements: Alpha 特性\n");
    const tasksRel = "specs/alpha/tasks.md";
    w(root, tasksRel, ["# Implementation Plan: Alpha", "", "- [ ] 1. 甲一 <!-- zcode-board: no=21 -->", "- [ ] 2. 乙一 <!-- zcode-board: no=22 -->", ""].join("\n"));
    w(root, "specs/alpha/progress.json", JSON.stringify({
      version: 3, feature: "Alpha 特性",
      current: { stage: "execution", title: "其他事项" },
      stages: { execution: { status: "active", note: "", evidence: [] } },
      execution: { totalTasks: 2, completedTasks: 0 }, activity: [], blockers: [],
    }, null, 2) + "\n");
    const planRel = ".zcode/plans/plan-pos.md";
    w(root, planRel, [
      "# 正对照计划", "<!-- zcode-board: no=30 -->",
      "- **T1 甲卡（草案）**：正文。 <!-- zcode-board: no=31 -->",
      "  > blocked-by: 32 —— 等乙卡",
      "- **T2 乙卡（草案）**：正文。 <!-- zcode-board: no=32 -->",
      "",
    ].join("\n"));
    w(root, REGISTRY_REL, JSON.stringify({ version: 1, seq: 32, entries: [
      { no: 20, kind: "spec", specRoot: "specs/alpha/", title: "Alpha 特性", assignedAt: "2026-10-01T00:00:00+08:00" },
      { no: 21, kind: "task", file: tasksRel, title: "甲一", assignedAt: "2026-10-01T00:00:00+08:00" },
      { no: 22, kind: "task", file: tasksRel, title: "乙一", assignedAt: "2026-10-01T00:00:00+08:00" },
      { no: 30, kind: "plan", file: planRel, title: "正对照计划", assignedAt: "2026-10-01T00:00:00+08:00" },
      { no: 31, kind: "task", file: planRel, title: "甲卡（草案）", assignedAt: "2026-10-01T00:00:00+08:00" },
      { no: 32, kind: "task", file: planRel, title: "乙卡（草案）", assignedAt: "2026-10-01T00:00:00+08:00" },
    ] }, null, 2) + "\n");
    w(root, ".zcode/board/runs.json", JSON.stringify({ version: 1, runs: [
      { runId: "run-pos-1", sessionId: "sess_pos", role: "implementer", at: "2026-10-09T10:00:00+08:00", result: "partial", cards: [31], worktree: ".zcode/worktrees/task-31", branch: "task-31", evidence: [], breakpoint: { stoppedAt: 31, next: "补测" } },
    ] }, null, 2) + "\n");
    w(root, ".zcode/board/interviews.json", JSON.stringify({ version: 1, interviews: [
      { id: "itw-pos-1", at: "2026-10-08T09:00:00+08:00", sessionId: "sess_pos", topic: "正对照访谈", summary: "已安排。", decisions: [], artifacts: [planRel], outcome: "plan", resolvedBy: "plan:plan-pos", status: "open" },
    ] }, null, 2) + "\n");
    c.exit(runCompile(root), 0, "a：默认编译退出码 0");
    const board = readBoard(root);
    c.eq(board.sources.length, 5, "a：sources = 3 第一方源 + 1 spec + 1 plan");
    const res = runCheck(root);
    c.exit(res, 0, "a：全源类型干净工程 → --check 通过（防误报）");
    c.ok(!res.stdout.includes("校验失败"), "a：无失败项");
    removeRoot(root);
  }

  // b. 计划→spec 延续（T9 场景 22 语义）：assign 后 check 通过
  {
    const root = newRoot("t10-pos-b");
    const planRel = ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000010.md";
    w(root, planRel, [
      "# 延续夹具", "<!-- zcode-board: no=1 -->",
      "- **T1 甲（草案）**：正文。 <!-- zcode-board: no=2 -->",
      "",
    ].join("\n"));
    w(root, "specs/cont/requirements.md", "# Requirements: 延续特性\n");
    w(root, "specs/cont/tasks.md", ["# Implementation Plan: 延续特性", "", "- [ ] 1. 甲", "  - Scope: 甲。", ""].join("\n"));
    w(root, REGISTRY_REL, JSON.stringify({ version: 1, seq: 2, entries: [
      { no: 1, kind: "plan", file: planRel, title: "延续夹具", assignedAt: "2026-10-01T00:00:00+08:00" },
      { no: 2, kind: "task", file: planRel, title: "甲（草案）", assignedAt: "2026-10-01T00:00:00+08:00" },
    ] }, null, 2) + "\n");
    w(root, ".zcode/board/interviews.json", JSON.stringify({ version: 1, interviews: [
      { id: "itw-pos-b", at: "2026-10-08T09:00:00+08:00", sessionId: "sess_pos", topic: "延续", summary: "建 spec。", decisions: [], artifacts: [planRel], outcome: "spec", resolvedBy: "spec:cont", status: "open" },
    ] }, null, 2) + "\n");

    const res = runAssign(root);
    c.exit(res, 0, "b：前置 --assign 退出码 0");
    const registry = readRegistry(root);
    c.eq(
      registry.entries.find((e) => e.no === 1)?.kind,
      "spec",
      "b：前置：registry 条目 1 已改指 spec（延续改写）",
    );
    const check = runCheck(root);
    c.exit(check, 0, "b：计划→spec 延续（计划节点退役、标记降 evidence）→ --check 通过（防误报）");
    c.ok(!check.stdout.includes("[registry 不一致]"), "b：退役计划稿的头标记不触发指向不一致");
    c.ok(!check.stdout.includes("[号码冲突]"), "b：延续号（1）不被计为双实体");
    removeRoot(root);
  }
});

// ---- 场景 35b：--check 归档直查（勘误 10）
test("35b", "场景 35b：归档条目按指向直查（已归档→通过+note；移动后未改写→失败级诊断；无候选→提示级独立诊断）", (c) => {
  const ARCHIVED_AT = "2026-10-01T00:00:00+08:00";
  // 公共部分：活计划（板上非空）+ 归档件（spec 根与计划稿）
  const seedArchived = (root, { registryRefs }) => {
    w(root, "specs/archive/feat/requirements.md", "# Requirements: 已归档特性\n");
    w(root, "specs/archive/feat/tasks.md", ["# Implementation Plan: 已归档特性", "", "- [x] 1. 归档甲 <!-- zcode-board: no=22 -->", "- [x] 2. 归档乙 <!-- zcode-board: no=23 -->", ""].join("\n"));
    w(root, ".zcode/archive/plan-old.md", ["# 归档计划稿", "<!-- zcode-board: no=30 -->", "- **T1 归档卡（草案）**：正文。 <!-- zcode-board: no=31 -->", ""].join("\n"));
    w(root, ".zcode/plans/plan-live.md", ["# 活计划", "<!-- zcode-board: no=50 -->", "- **T1 活卡（草案）**：正文。 <!-- zcode-board: no=51 -->", ""].join("\n"));
    w(root, REGISTRY_REL, JSON.stringify({ version: 1, seq: 51, entries: [
      { no: 20, kind: "spec", specRoot: registryRefs.specRoot, title: "已归档特性", assignedAt: ARCHIVED_AT },
      { no: 22, kind: "task", file: registryRefs.specTasks, title: "归档甲", assignedAt: ARCHIVED_AT },
      { no: 23, kind: "task", file: registryRefs.specTasks, title: "归档乙", assignedAt: ARCHIVED_AT },
      { no: 30, kind: "plan", file: registryRefs.oldPlan, title: "归档计划稿", assignedAt: ARCHIVED_AT },
      { no: 31, kind: "task", file: registryRefs.oldPlan, title: "归档卡（草案）", assignedAt: ARCHIVED_AT },
      { no: 50, kind: "plan", file: ".zcode/plans/plan-live.md", title: "活计划", assignedAt: ARCHIVED_AT },
      { no: 51, kind: "task", file: ".zcode/plans/plan-live.md", title: "活卡（草案）", assignedAt: ARCHIVED_AT },
    ] }, null, 2) + "\n");
  };

  // A. 指向已更新为归档路径（--assign 已改写）→ 直查通过 + note"已归档"
  {
    const root = newRoot("t10-s35a");
    seedArchived(root, { registryRefs: {
      specRoot: "specs/archive/feat/",
      specTasks: "specs/archive/feat/tasks.md",
      oldPlan: ".zcode/archive/plan-old.md",
    } });
    c.exit(runCompile(root), 0, "A：默认编译退出码 0");
    const res = runCheck(root);
    c.exit(res, 0, "A：归档条目（指向归档路径且含号标记）→ --check 通过");
    c.inc(res.stdout, "已归档", "A：note 明写「已归档」（勘误 10）");
    c.inc(res.stdout, "条目 20", "A：逐条点名归档条目（spec 根条目 20）");
    c.inc(res.stdout, "条目 30", "A：逐条点名归档条目（计划稿条目 30）");
    c.inc(res.stdout, "specs/archive/feat/tasks.md", "A：note 按指向路径直查（点明归档任务文件）");
    c.ok(!res.stdout.includes("[registry 不一致]"), "A：归档条目不报不一致（防误报）");
    removeRoot(root);
  }

  // B. 指向失效但归档候选存在（移动后未运行 --assign）→ 独立失败诊断（可修复指向）
  {
    const root = newRoot("t10-s35b");
    seedArchived(root, { registryRefs: {
      specRoot: "specs/feat/",
      specTasks: "specs/feat/tasks.md",
      oldPlan: ".zcode/plans/plan-old.md",
    } });
    c.exit(runCompile(root), 0, "B：默认编译退出码 0");
    const res = runCheck(root);
    c.exit(res, 1, "B：指向失效（原路径不存在、归档候选在）→ --check 非零退出");
    c.inc(res.stdout, "[registry 不一致]", "B：失败项归类到 registry 不一致");
    c.inc(res.stdout, "运行 --assign", "B：诊断给出修复路径（运行 --assign 改写指向）");
    c.inc(res.stdout, "specs/archive/feat/", "B：诊断点名已验证的归档候选路径");
    c.inc(res.stdout, "已归档", "B：诊断说明该指向属归档移动（勘误 10）");
    removeRoot(root);
  }

  // C. 指向失效且归档候选不存在（真删/改名）→ 提示级独立诊断（§3.2 空洞仍合法；不得用通用空洞文案静默放行）
  {
    const root = newRoot("t10-s35c");
    w(root, ".zcode/plans/plan-live.md", ["# 活计划", "<!-- zcode-board: no=50 -->", "- **T1 活卡（草案）**：正文。 <!-- zcode-board: no=51 -->", ""].join("\n"));
    w(root, REGISTRY_REL, JSON.stringify({ version: 1, seq: 99, entries: [
      { no: 50, kind: "plan", file: ".zcode/plans/plan-live.md", title: "活计划", assignedAt: ARCHIVED_AT },
      { no: 51, kind: "task", file: ".zcode/plans/plan-live.md", title: "活卡（草案）", assignedAt: ARCHIVED_AT },
      { no: 99, kind: "task", file: "docs/plans/plan-gone.md", title: "指向失效条目", assignedAt: ARCHIVED_AT },
    ] }, null, 2) + "\n");
    c.exit(runCompile(root), 0, "C：默认编译退出码 0");
    const res = runCheck(root);
    c.exit(res, 0, "C：指向不存在且无归档候选 → --check 通过（§3.2 空洞合法，提示级独立诊断）");
    c.inc(res.stdout, "docs/plans/plan-gone.md", "C：诊断点名失效指向");
    c.inc(res.stdout, "亦不存在", "C：诊断说明归档路径亦不存在（区分于可修复的归档改写路径）");
    c.inc(res.stdout, "号永不回收", "C：诊断保留「号不复用」语义（不是号问题，是指向问题）");
    c.ok(!res.stdout.includes("在当前活条目中无对应"), "C：不再以通用「空洞（合法）」文案静默放行（独立文案点名指向悬空）");
    c.ok(!res.stdout.includes("[registry 不一致]"), "C：无已验证归档件 → 不判失败（不误报）");
    removeRoot(root);
  }
});

// ---- #72：扫描面配置错误 → --check 失败项（失败级；编译侧兜底不阻断）
test("72h", "#72：scan.json 坏 JSON / 池外引用 → --check 失败项「扫描面配置」非零退出；合法配置零噪音", (c) => {
  // a. 坏 JSON → 失败项（编译侧按默认 .zcode/plans 兜底；--check 不静默放行）
  {
    const root = newRoot("t10-72h-a");
    w(root, ".zcode/plans/plan-keep.md", ["# 苗圃稿", "", "- [ ] 1. 条目", ""].join("\n"));
    w(root, ".zcode/board/scan.json", "{ 坏 JSON —— 字段也缺\n");
    const before = treeSnapshot(root);
    const res = runCheck(root);
    const after = treeSnapshot(root);
    c.exit(res, 1, "a：坏 scan.json → --check 非零退出（失败级）");
    c.inc(res.stdout, "[扫描面配置]", "a：失败项归类到「扫描面配置」");
    c.inc(res.stdout, "scan.json", "a：失败项点名 scan.json");
    c.inc(res.stdout, "默认 .zcode/plans", "a：说明编译侧按默认扫描面兜底（不猜）");
    assertNoWrites(c, before, after, "a：--check 全程只读（坏配置亦零写入）");
    removeRoot(root);
  }

  // b. includeDirs 池外引用 → 失败项（防止任意目录当计划源被静默接受）
  {
    const root = newRoot("t10-72h-b");
    w(root, ".zcode/plans/plan-keep.md", ["# 苗圃稿", "", "- [ ] 1. 条目", ""].join("\n"));
    w(root, "docs/history/bait.md", ["# 池外诱饵", "", "- **T1 条目（草案）**：正文。", ""].join("\n"));
    w(root, ".zcode/board/scan.json", JSON.stringify({ includeDirs: ["docs/history"] }, null, 2) + "\n");
    const res = runCheck(root);
    c.exit(res, 1, "b：池外引用 → --check 非零退出");
    c.inc(res.stdout, "docs/history", "b：失败项点名被拒目录");
    c.inc(res.stdout, "opt-in 池", "b：说明池外拒绝判据");
    removeRoot(root);
  }

  // c. 合法 scan.json → --check 通过、零噪音（配置不进 notes/失败项）
  {
    const root = newRoot("t10-72h-c");
    w(root, ".zcode/plans/plan-keep.md", ["# 苗圃稿", "", "- [ ] 1. 条目", ""].join("\n"));
    w(root, "docs/plans/plan-old.md", ["# 旧票计划", "", "- [ ] 1. 条目", ""].join("\n"));
    w(root, ".zcode/board/scan.json", JSON.stringify({ includeDirs: ["docs/plans"], excludeGlobs: ["**/x-*.md"] }, null, 2) + "\n");
    c.exit(runCompile(root), 0, "c：默认编译退出码 0");
    const res = runCheck(root);
    c.exit(res, 0, "c：合法扫描面配置 → --check 通过（零噪音）");
    c.ok(!res.stdout.includes("[扫描面配置]"), "c：无扫描面配置失败项");
    c.ok(!/scan\.json/.test(res.stdout), "c：合法配置不进 notes/失败项（零噪音）");
    removeRoot(root);
  }
});

// ---------------------------------------------------------------- 主流程

async function main(argv) {
  const onlyIdx = argv.indexOf("--only");
  const only = onlyIdx >= 0 ? new Set(String(argv[onlyIdx + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) : null;
  const clean = argv.includes("--clean");

  say("zcode-board · T10 场景断言（--check 审计；测试先行：红 → 绿）");
  say(`node      : ${process.version}`);
  say(`assets    : ${ASSETS_DIR}`);
  say(`编译器     : ${COMPILER}（存在：${isFile(COMPILER)}）`);
  say(`断言脚本   : ${toPosix(fileURLToPath(import.meta.url))}`);
  say(`用例      : ${only ? [...only].join(",") : "全部"}`);

  for (const t of TESTS) {
    if (only && !only.has(t.id)) continue;
    say("");
    say(`== T10 用例 ${t.id}：${t.title} ==`);
    const root = newRoot(`t10-${t.id}`);
    say(`  夹具：${root}`);
    const c = new Checks(t.id);
    try {
      await t.fn(c, root);
    } catch (e) {
      c.ok(false, "测试执行异常", e.stack ?? e.message);
    }
    if (clean) removeRoot(root);
    else if (failedTests.has(t.id)) say(`  保留夹具供排查：${root}`);
  }

  say("");
  say(`结论：通过 ${passCount}，失败 ${failCount}`);
  if (failedTests.size > 0) say(`失败用例：${[...failedTests].sort().join(", ")}`);
  else say("全部用例通过（0 失败）");
  return failCount === 0 ? 0 : 1;
}

process.exit(await main(process.argv.slice(2)));
