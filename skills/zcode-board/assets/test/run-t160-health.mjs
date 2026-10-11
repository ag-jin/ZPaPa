#!/usr/bin/env node
/**
 * zcode-board / #160（E1c-1）板体检一条命令（四绿输出）· 自包含套件
 *
 * 存在原因（卡 #160；裁决④三检查点；用户 2026-10-10「多检查点，刚才才开始测试就一堆错误」）：
 *   三检查点的第三关（hook 启用）原先只有分散命令与人读链路，无一键「四绿总览」——
 *   本套件为 `assets/tools/board-health.mjs`（体检入口）的行为回归面：以**公开面**
 *   （CLI 参数 / stdout 清单行 / 分级清单 / 结论行 / 退出码）断言，四绿各一组夹具 +
 *   任一组不绿的输出与退出码。
 *
 * 覆盖（逐用例见下）：
 *   T1  --only check 下钻：合规夹具 → [绿] ①--check 审计：通过（0 项失败）；exit 0（明细取编译器原输出）
 *   T2  四绿总览：合规夹具 + 桩套件 + 桩信任仓 + 真实 hook 探针 → 四行 [绿]；exit 0；真实板零触碰
 *   T3  ①红：板被篡改 → [红] ①--check 审计；exit 2；分级清单含重编译指引
 *   T4  ②红：桩套件失败 → [红] ②hooks 套件；exit 2
 *   T5  ③黄：信任仓无该工作区记录 → [黄] ③信任状态；exit 1；指引含信任评审
 *   T6  ③红：config.json 缺 hooks 包装层（A5 实测：被静默跳过）→ [红]；exit 2
 *   T7  ③④黄：config 无声明（hook 未启用）→ 两行黄；exit 1
 *   T8  ④红：声明指向坏 hook 脚本（探针非契约响应）→ [红] ④探针触发；exit 2
 *   T9  --only probe 明细含 B3 新检测面（Bash 源变更/归档移动/兜底重编译）
 *   T10 用法边界：未知选项/根不存在 → exit 2 + stderr 用法；stdout 零产出
 *   T11 E6-J6-3 场景复现：误删源 → ①红 + 指引可照做 + 下钻明细含修复原文（单点答案的机具面）
 *
 * 夹具：全部位于系统临时目录（真实板/真实 config 只读；探针副本域在工具内自建）。
 * 用法：node assets/test/run-t160-health.mjs [T1 T3 …]（缺省跑全部用例；给标签则只跑该组，供聚焦复跑/负对照）
 * 退出码：0 = 全部通过；1 = 有失败。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { COMPILER, newRoot, treeSnapshot, w } from "./fixtures/build-fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(HERE, "..");
const SKILL_ROOT = resolve(ASSETS, "..");
const HEALTH = join(ASSETS, "tools", "board-health.mjs");
const HOOKS_DIR = join(ASSETS, "hooks");

// ---------------------------------------------------------------- 断言与输出

const lines = [];
function say(s = "") {
  lines.push(s);
  console.log(s);
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
    this.ok(typeof text === "string" && !text.includes(needle), label, `不应命中：${JSON.stringify(needle)}`);
  }
}

// ---------------------------------------------------------------- 夹具构造

/** 最小合规项目：一份带号计划稿 + 真实 --assign（登记 registry + 重编译）→ --check 0 失败。 */
function mkProject(tag) {
  const root = newRoot(tag);
  w(
    root,
    ".zcode/plans/plan-probe.md",
    ["# 探针夹具稿 <!-- zcode-board: no=900 -->", "", "- [ ] 探针卡 A <!-- zcode-board: no=901 -->", ""].join("\n"),
  );
  const assign = spawnSync(process.execPath, [COMPILER, root, "--assign"], { encoding: "utf8" });
  if (assign.status !== 0) throw new Error(`夹具 --assign 失败（exit ${assign.status}）：${assign.stderr}`);
  const check = spawnSync(process.execPath, [COMPILER, root, "--check"], { encoding: "utf8" });
  if (check.status !== 0) throw new Error(`夹具自检 --check 非绿（exit ${check.status}）：${check.stdout}`);
  return root;
}

/** 桩 hooks 套件：按期望打印末行结论并退出（只验聚合面；真实套件跑法见证据留档）。 */
function mkStubSuite(dir, { exitCode = 0, pass = 12, failCount = 0 } = {}) {
  const p = join(dir, `stub-suite-${exitCode}-${pass}-${failCount}.mjs`);
  writeFileSync(
    p,
    [
      "#!/usr/bin/env node",
      'console.log("PASS  桩用例");',
      `console.log(${JSON.stringify(`结论：通过 ${pass}，失败 ${failCount}`)});`,
      `process.exit(${exitCode});`,
      "",
    ].join("\n"),
  );
  return p;
}

/** 声明在 events 结构中的位次（matcherIndex = 同事件内 matcher 块序；hookIndex = 块内 hook 序）。 */
function declIndexes(declarations) {
  const slotsByEvent = new Map(); // event → [{matcher, n}]
  return declarations.map((d) => {
    const slots = slotsByEvent.get(d.event) ?? [];
    if (!slotsByEvent.has(d.event)) slotsByEvent.set(d.event, slots);
    let mi = slots.findIndex((s) => s.matcher === (d.matcher ?? null));
    if (mi === -1) {
      slots.push({ matcher: d.matcher ?? null, n: 0 });
      mi = slots.length - 1;
    }
    const hi = slots[mi].n;
    slots[mi].n += 1;
    return { matcherIndex: mi, hookIndex: hi };
  });
}

/** 桩信任仓：按工作区身份登记 trusted 记录（身份字段形态与真实信任仓一致，含位次字段）。 */
function mkTrustStore(dir, { root, declarations = [], grantedAt = new Date().toISOString(), decision = "trusted" } = {}) {
  const p = join(dir, `trust-${declarations.length}-${decision}.json`);
  const idx = declIndexes(declarations);
  const records = declarations.map((d, i) => ({
    workspaceIdentity: root,
    hookDeclarationDigest: `fixture-digest-${i}`,
    digestAlgorithm: "sha256",
    decision,
    grantedAt,
    bundleDigestAtGrant: "fixture-bundle",
    eventAtGrant: d.event,
    displayCommandAtGrant: d.command,
    sourcePathAtGrant: ".zcode/config.json",
    sourceDiscoveryOrderAtGrant: 0,
    matcherAtGrant: d.matcher ?? null,
    matcherIndexAtGrant: idx[i].matcherIndex,
    hookIndexAtGrant: idx[i].hookIndex,
    appVersionAtGrant: "0.16.9",
  }));
  writeFileSync(p, `${JSON.stringify({ schemaVersion: 1, records }, null, 2)}\n`);
  return p;
}

/** 写 config.json（hooks 声明；args 指向真实技能根 hooks，供探针触发）；同 (event, matcher) 合并为一块。 */
function mkConfig(root, decls) {
  const events = {};
  for (const d of decls) {
    events[d.event] = events[d.event] ?? [];
    const matcher = d.matcher ?? null;
    let block = events[d.event].find((b) => (b.matcher ?? null) === matcher);
    if (block === undefined) {
      block = { ...(matcher === null ? {} : { matcher }), hooks: [] };
      events[d.event].push(block);
    }
    block.hooks.push(d.hook);
  }
  w(root, ".zcode/config.json", `${JSON.stringify({ hooks: { enabled: true, events } }, null, 2)}\n`);
}

function runHealth(args, opts = {}) {
  return spawnSync(process.execPath, [HEALTH, ...args], { encoding: "utf8", timeout: 300000, ...opts });
}

// ---------------------------------------------------------------- T1：--only check 下钻

function t1OnlyCheck(c) {
  const root = mkProject("t160-t1");
  // 哨兵套件：被调用即写标记文件（用于断言 --only check 不跑其他绿）
  const sentinel = join(root, "suite-ran.flag");
  const spySuite = w(
    root,
    "spy-suite.mjs",
    [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(sentinel)}, "ran\\n");`,
      'console.log("结论：通过 12，失败 0");',
      "",
    ].join("\n"),
  );
  const r = runHealth([root, "--only", "check", "--suite", spySuite]);
  c.eq(r.status, 0, "合规夹具：--only check 退出码 0", `stderr=${r.stderr}`);
  c.inc(r.stdout ?? "", "[绿] ①--check 审计：通过（0 项失败）", "①--check 行：绿 + 失败项计数");
  c.inc(r.stdout ?? "", `下钻：node ${join(SKILL_ROOT, "assets", "compile-board.mjs")} ${root} --check`, "行内给出下钻命令（每绿可下钻）");
  c.inc(r.stdout ?? "", "结论：绿", "--only 结论行：绿");
  c.inc(r.stdout ?? "", "结论：--check 通过（0 项失败）", "明细取编译器原输出（独立复现面）");
  c.ok(!existsSync(sentinel), "--only check 只跑该绿（哨兵套件未被调用）", `哨兵存在：${sentinel}`);
}

// ---------------------------------------------------------------- T2：四绿总览（全绿夹具）

/** 五项正式声明（args 指向真实技能根 hooks——探针触发真脚本，副本域只读真实板）。 */
function formalDecls() {
  const hook = (name, extra = {}) => ({
    type: "command",
    command: "node",
    args: [join(HOOKS_DIR, name)],
    ...extra,
  });
  return [
    { event: "SessionStart", hook: hook("board-context.mjs", { timeoutMs: 10000 }) },
    { event: "PreToolUse", matcher: "Bash", hook: hook("gate-merge.mjs", { timeoutMs: 10000 }) },
    { event: "PostToolUse", matcher: "Agent|Task", hook: hook("record-run.mjs", { timeoutMs: 30000 }) },
    { event: "PostToolUse", matcher: "Write|Edit", hook: hook("watch-sources.mjs", { async: true }) },
    { event: "Stop", hook: hook("reconcile-stop.mjs", { async: true }) },
  ];
}

function t2FourGreens(c) {
  const root = mkProject("t160-t2");
  const decls = formalDecls();
  mkConfig(root, decls);
  const trust = mkTrustStore(root, { root, declarations: decls });
  const suite = mkStubSuite(root, { pass: 12, failCount: 0 });
  const before = treeSnapshot(root);

  const r = runHealth([root, "--suite", suite, "--trust-store", trust]);
  c.eq(r.status, 0, "全绿夹具：四绿总览退出码 0", `stderr=${r.stderr}`);
  const out = r.stdout ?? "";
  c.inc(out, "[绿] ①--check 审计：通过（0 项失败）", "①--check 绿行");
  c.inc(out, "[绿] ②hooks 套件：通过 12/0", "②hooks 套件 绿行（通过/失败计数）");
  c.inc(out, "[绿] ③信任状态：5/5 项声明已评审", "③信任状态 绿行（声明↔信任仓对账）");
  c.ok(/\[绿\] ④探针触发：\d+\/\d+ 探针按契约响应/.test(out), "④探针触发 绿行（分母=实际探针数）", out.split("\n").find((l) => l.includes("④")) ?? "");
  c.inc(out, "分级清单：无", "四绿齐 → 分级清单为空");
  c.inc(out, "结论：绿", "结论行：绿");

  const after = treeSnapshot(root);
  c.eq(
    JSON.stringify([...after.entries()]),
    JSON.stringify([...before.entries()]),
    "真实项目根零触碰（探针走副本域；树快照逐文件一致）",
  );
}

// ---------------------------------------------------------------- T3：①红（板被篡改）

function t3CheckRed(c) {
  const root = mkProject("t160-t3");
  const decls = formalDecls();
  mkConfig(root, decls);
  const trust = mkTrustStore(root, { root, declarations: decls });
  const suite = mkStubSuite(root, { pass: 12, failCount: 0 });
  // 篡改板面（title 与源不一致 → --check 板比对失败）
  const boardPath = join(root, ".zcode/board", "board.json");
  const board = JSON.parse(readFileSync(boardPath, "utf8"));
  board.features[0].tasks[0].title = "被篡改标题";
  writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`);

  const r = runHealth([root, "--suite", suite, "--trust-store", trust]);
  c.eq(r.status, 2, "①红：总退出码 2（红——先整改并重跑检查点）", `stderr=${r.stderr}`);
  c.inc(r.stdout ?? "", "[红] ①--check 审计：失败", "①--check 红行（含失败项计数）");
  c.inc(r.stdout ?? "", "分级清单（", "分级清单进入渲染");
  c.ok(/^ {2}- 红：①--check 审计：失败/m.test(r.stdout ?? ""), "清单项：红 + ①标识 + 计数", (r.stdout ?? "").split("\n").find((l) => l.includes("①--check 审计：失败") && l.startsWith("  - ")) ?? "");
  c.inc(r.stdout ?? "", "重编译", "红项指引含重编译处置");
  c.inc(r.stdout ?? "", "结论：红", "结论行：红");
  c.inc(r.stdout ?? "", "[绿] ②hooks 套件：通过 12/0", "其余三绿照常评估（不因一红短路）");
}

// ---------------------------------------------------------------- T4：②红（桩套件失败）

function t4SuiteRed(c) {
  const root = mkProject("t160-t4");
  const decls = formalDecls();
  mkConfig(root, decls);
  const trust = mkTrustStore(root, { root, declarations: decls });
  const suite = mkStubSuite(root, { exitCode: 1, pass: 10, failCount: 2 });

  const r = runHealth([root, "--suite", suite, "--trust-store", trust]);
  c.eq(r.status, 2, "②红：总退出码 2", `stderr=${r.stderr}`);
  c.inc(r.stdout ?? "", "[红] ②hooks 套件：失败 2 项（通过 10", "②hooks 套件 红行（失败计数 + 通过数）");
  c.ok(/^ {2}- 红：②hooks 套件：失败 2 项/m.test(r.stdout ?? ""), "清单项：红 + ②标识", (r.stdout ?? "").split("\n").find((l) => l.startsWith("  - 红：②")) ?? "");
  c.inc(r.stdout ?? "", "修 hooks", "红项指引含修 hooks 后重跑");
  c.inc(r.stdout ?? "", "[绿] ①--check 审计：通过（0 项失败）", "①绿行并存（分级而非全盘否定）");

  // 下钻：--only hooks 只跑该绿（哨兵套件被调用；②明细可见）
  const sentinel = join(root, "hooks-suite-ran.flag");
  const spy = w(
    root,
    "spy-suite-hooks.mjs",
    [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(sentinel)}, "ran\\n");`,
      'console.log("桩用例");',
      'console.log("结论：通过 12，失败 0");',
      "",
    ].join("\n"),
  );
  const drill = runHealth([root, "--only", "hooks", "--suite", spy]);
  c.eq(drill.status, 0, "--only hooks：退出码 0（该绿绿）", `stderr=${drill.stderr}`);
  c.ok(existsSync(sentinel), "--only hooks 触发套件入口（哨兵在位）");
  c.inc(drill.stdout ?? "", "[绿] ②hooks 套件：通过 12/0", "--only hooks 行：绿 + 计数");
  c.inc(drill.stdout ?? "", "桩用例", "明细取套件原输出（独立复现面）");
}

// ---------------------------------------------------------------- T5：③黄（未评审）

function t5TrustYellow(c) {
  const root = mkProject("t160-t5");
  const decls = formalDecls();
  mkConfig(root, decls);
  // 信任仓存在但记录属其他工作区身份 → 本工作区 0 条已评审
  const trust = mkTrustStore(root, { root: "/some/other/workspace", declarations: decls });
  const suite = mkStubSuite(root, { pass: 12, failCount: 0 });

  const r = runHealth([root, "--suite", suite, "--trust-store", trust]);
  c.eq(r.status, 1, "③黄：总退出码 1（有黄无红）", `stderr=${r.stderr}`);
  c.inc(r.stdout ?? "", "[黄] ③信任状态：0/5 项声明已评审", "③信任状态 黄行（0/5 未评审）");
  c.ok(/^ {2}- 黄：③信任状态：0\/5/m.test(r.stdout ?? ""), "清单项：黄 + ③标识", (r.stdout ?? "").split("\n").find((l) => l.startsWith("  - 黄：③")) ?? "");
  c.inc(r.stdout ?? "", "一次性信任评审", "黄项指引含一次性信任评审");
  c.inc(r.stdout ?? "", "--only trust", "③行带下钻命令（--only trust——每绿可下钻）");
  c.inc(r.stdout ?? "", "--doctor", "③黄项指引保留声明面权威体检（--doctor）");
  c.inc(r.stdout ?? "", "结论：黄", "结论行：黄");
  c.inc(r.stdout ?? "", "[绿] ④探针触发：", "④仍触发（绿）——未评审不阻断探针本身");
}

// ---------------------------------------------------------------- T6：③红（缺 hooks 包装层）

function t6TrustRed(c) {
  const root = mkProject("t160-t6");
  const decls = formalDecls();
  // 缺 hooks 包装层（A5 实测形态：声明被静默跳过、不提示评审）
  const events = {};
  for (const d of decls) {
    events[d.event] = events[d.event] ?? [];
    events[d.event].push({ ...(d.matcher ? { matcher: d.matcher } : {}), hooks: [d.hook] });
  }
  w(root, ".zcode/config.json", `${JSON.stringify({ enabled: true, events }, null, 2)}\n`);
  const trust = mkTrustStore(root, { root, declarations: decls });
  const suite = mkStubSuite(root, { pass: 12, failCount: 0 });

  const r = runHealth([root, "--suite", suite, "--trust-store", trust]);
  c.eq(r.status, 2, "③红：总退出码 2", `stderr=${r.stderr}`);
  c.inc(r.stdout ?? "", "[红] ③信任状态：缺 hooks 包装层", "③信任状态 红行（缺包装层）");
  c.ok(/^ {2}- 红：③信任状态：/m.test(r.stdout ?? ""), "清单项：红 + ③标识");
  c.inc(r.stdout ?? "", "SKILL.md §3.6", "红项指引指向 §3.6 声明模板");
  c.inc(r.stdout ?? "", "[黄] ④探针触发：无声明可触发", "④同因黄（缺包装层 → 无可触发声明）");
}

// ---------------------------------------------------------------- T7：③④黄（无声明，hook 未启用）

function t7NoDeclarations(c) {
  const root = mkProject("t160-t7");
  w(root, ".zcode/config.json", `${JSON.stringify({ hooks: { enabled: true, events: {} } }, null, 2)}\n`);
  const trust = mkTrustStore(root, { root, declarations: [] });
  const suite = mkStubSuite(root, { pass: 12, failCount: 0 });

  const r = runHealth([root, "--suite", suite, "--trust-store", trust]);
  c.eq(r.status, 1, "无声明：总退出码 1（两黄）", `stderr=${r.stderr}`);
  c.inc(r.stdout ?? "", "[黄] ③信任状态：无声明条目", "③黄行（无声明条目）");
  c.inc(r.stdout ?? "", "[黄] ④探针触发：无声明可触发", "④黄行（无声明可触发）");
  c.ok(/分级清单（2 项）/.test(r.stdout ?? ""), "分级清单计数 = 2（两黄各一条）", (r.stdout ?? "").split("\n").find((l) => l.startsWith("分级清单")) ?? "");
}

// ---------------------------------------------------------------- T8：④红（坏 hook 声明）

function t8ProbeRed(c) {
  const root = mkProject("t160-t8");
  // 坏 hook：basename 与探针规格同名（board-context），行为不符契约（exit 3）
  const badHook = w(root, "bad-hooks/board-context.mjs", "process.exit(3);\n");
  const decls = [{ event: "SessionStart", hook: { type: "command", command: "node", args: [badHook], timeoutMs: 10000 } }];
  mkConfig(root, decls);
  const trust = mkTrustStore(root, { root, declarations: decls });
  const suite = mkStubSuite(root, { pass: 12, failCount: 0 });

  const r = runHealth([root, "--suite", suite, "--trust-store", trust]);
  c.eq(r.status, 2, "④红：总退出码 2", `stderr=${r.stderr}`);
  c.inc(r.stdout ?? "", "[红] ④探针触发：", "④探针触发 红行");
  c.inc(r.stdout ?? "", "不符 1 例", "红行给出不符例数");
  c.ok(/^ {2}- 红：④探针触发：/m.test(r.stdout ?? ""), "清单项：红 + ④标识");
  c.inc(r.stdout ?? "", "--doctor", "红项指引指向声明面体检（--doctor）");
  c.inc(r.stdout ?? "", "[绿] ③信任状态：1/1 项声明已评审", "③绿并存（声明已评审、脚本存在——红只在探针面）");

  // 下钻：--only probe 逐例点名（含实测退出码）
  const drill = runHealth([root, "--only", "probe", "--suite", suite, "--trust-store", trust]);
  c.eq(drill.status, 2, "--only probe：退出码 2（该绿红）", `stderr=${drill.stderr}`);
  c.inc(drill.stdout ?? "", "[红] board-context（SessionStart 单 JSON）：退出码 3", "明细逐例点名（探针实测退出码）");
  c.inc(drill.stdout ?? "", "结论：红", "--only 结论行：红");
}

// ---------------------------------------------------------------- T9：--only probe 明细（B3 新检测面覆盖）

function t9ProbeDrillB3(c) {
  const root = mkProject("t160-t9");
  const decls = formalDecls();
  mkConfig(root, decls);
  const trust = mkTrustStore(root, { root, declarations: decls });
  const suite = mkStubSuite(root, { pass: 12, failCount: 0 });

  const r = runHealth([root, "--only", "probe", "--suite", suite, "--trust-store", trust]);
  c.eq(r.status, 0, "--only probe：退出码 0（全绿）", `stderr=${r.stderr}`);
  c.ok(/\[绿\] ④探针触发：7\/7 探针按契约响应/.test(r.stdout ?? ""), "7 例探针全绿（五核心声明 × B3 面三例）", (r.stdout ?? "").split("\n").find((l) => l.includes("④")) ?? "");
  c.inc(r.stdout ?? "", "[绿] watch-sources（Bash 源变更告警；B3-1）", "B3-1：Bash 源变更告警触发");
  c.inc(r.stdout ?? "", "[绿] watch-sources（归档移动合法转移提示；B3-2）", "B3-2：归档移动合法转移提示触发");
  c.inc(r.stdout ?? "", "[绿] reconcile-stop（兜底重编译；B3-3）", "B3-3：Stop 兜底重编译触发");
  c.inc(r.stdout ?? "", "明细：", "--only 输出明细节");
}

// ---------------------------------------------------------------- T10：用法边界

function t10Usage(c) {
  const unknown = runHealth(["--nope"]);
  c.eq(unknown.status, 2, "未知选项 → exit 2", `stderr=${unknown.stderr}`);
  c.inc(unknown.stderr ?? "", "未知选项", "stderr 点名未知选项");
  c.eq(unknown.stdout ?? "", "", "未知选项 stdout 零产出");

  const badRoot = runHealth(["/nonexistent-root-160/xyz"]);
  c.eq(badRoot.status, 2, "根不存在 → exit 2", `stderr=${badRoot.stderr}`);
  c.inc(badRoot.stderr ?? "", "项目根不存在", "stderr 点名项目根不存在");

  const root = mkProject("t160-t10");
  const badOnly = runHealth([root, "--only", "nope"]);
  c.eq(badOnly.status, 2, "--only 非法取值 → exit 2", `stderr=${badOnly.stderr}`);
  c.inc(badOnly.stderr ?? "", "取值须为 check|hooks|trust|probe", "--only 取值域成文");

  const help = runHealth(["--help"]);
  c.eq(help.status, 0, "--help → exit 0");
  c.inc(help.stdout ?? "", "四绿", "--help 说明四绿口径");
}

// ---------------------------------------------------------------- T11：E6-J6-3 场景复现（用户误删源文件）

function t11JourneyJ63(c) {
  const root = mkProject("t160-t11");
  const decls = formalDecls();
  mkConfig(root, decls);
  const trust = mkTrustStore(root, { root, declarations: decls });
  const suite = mkStubSuite(root, { pass: 12, failCount: 0 });
  // E6-J6-3 缺口原文：「无板体检/一键修复语义……'我删了个文件怎么办'没有单点答案页」
  rmSync(join(root, ".zcode", "plans", "plan-probe.md"));

  const r = runHealth([root, "--suite", suite, "--trust-store", trust]);
  c.eq(r.status, 2, "E6-J6-3 复现：误删源 → 体检红（退出码 2）", `stderr=${r.stderr}`);
  c.inc(r.stdout ?? "", "[红] ①--check 审计：失败 1 项", "①行一条命令看到「板不对」（失败项计数）");
  c.ok(/^ {2}- 红：①--check 审计/m.test(r.stdout ?? ""), "分级清单逐条点名");
  c.inc(r.stdout ?? "", "重编译", "指引含恢复处置（重编译；指向改写/归档直查见下钻）");
  c.inc(r.stdout ?? "", `下钻：node ${COMPILER} ${root} --check`, "每绿可下钻（①下钻 = 编译器审计原命令）");
  c.eq(r.stderr ?? "", "", "体检本身零 stderr 噪声（判定与指引全走 stdout；底层诊断在下钻明细）");

  const drill = runHealth([root, "--only", "check"]);
  c.inc(drill.stdout ?? "", "board 不一致", "下钻明细含失败项原文（board 不一致）");
  c.inc(drill.stdout ?? "", "重编译即可修复", "下钻明细含可机械修复的处置原文（用户照做即可）");
  c.inc(drill.stdout ?? "", "归档", "下钻明细保留归档直查口径（误删/误移两态可见）");
}

// ---------------------------------------------------------------- 主流程

const CASES = [
  ["T1", "T1：--only check 下钻（绿侧）", t1OnlyCheck],
  ["T2", "T2：四绿总览（合规夹具 + 桩套件 + 桩信任仓 + 真实 hook 探针）", t2FourGreens],
  ["T3", "T3：①红（板被篡改 → 退出码 2 + 分级清单指引）", t3CheckRed],
  ["T4", "T4：②红（桩套件失败）", t4SuiteRed],
  ["T5", "T5：③黄（信任仓 0 条已评审）", t5TrustYellow],
  ["T6", "T6：③红（缺 hooks 包装层 → 声明被静默跳过）", t6TrustRed],
  ["T7", "T7：③④黄（无声明，hook 未启用）", t7NoDeclarations],
  ["T8", "T8：④红（声明指向坏 hook）", t8ProbeRed],
  ["T9", "T9：--only probe 明细（B3 新检测面覆盖核对）", t9ProbeDrillB3],
  ["T10", "T10：用法边界（未知选项/根不存在/--only 取值域/--help）", t10Usage],
  ["T11", "T11：E6-J6-3 场景复现（用户误删源文件 → 一条命令可见 + 指引可照做）", t11JourneyJ63],
];

const only = new Set(process.argv.slice(2).filter((a) => !a.startsWith("--")));
const selected = only.size === 0 ? CASES : CASES.filter(([tag]) => only.has(tag));
if (selected.length === 0) {
  console.error(`未知用例：${[...only].join("、")}（可用：${CASES.map(([t]) => t).join(",")}）`);
  process.exit(2);
}

say("zcode-board · #160（E1c-1）板体检四绿 · 行为断言");
say(`node   : ${process.version}`);
say(`工具   : ${HEALTH}`);
say("");
for (const [, title, fn] of selected) {
  say(`== ${title} ==`);
  {
    const c = new Checks(title.slice(0, title.indexOf("：")));
    fn(c);
  }
  say("");
}

if (failCount === 0) {
  say(`结论：通过 ${passCount}，失败 0`);
  say("全部用例通过（0 失败）");
  process.exit(0);
}
say(`结论：通过 ${passCount}，失败 ${failCount}`);
process.exit(1);
