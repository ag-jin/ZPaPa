#!/usr/bin/env node
/**
 * zcode-board / T9 场景断言脚本（红→绿同一脚本，测试先行；T16 可直接复跑）
 *
 * 覆盖（任务 T9 + 设计 §13 场景 3,11,12,13,14,19,20,22,31,33 后半；+ 场景 8 的
 * "--assign 二次运行幂等"在 test/run-scenarios.mjs 场景 8 内并入）：
 *   - 场景 3   plan T1–T4（真实样例结构）首轮 --assign → 4 张 draft 卡（title 剥离 T 前缀、
 *             details 取正文首行、任务号 2–5、label 1–4（#46 A2 计划内层级））；#53 契约 v2.3 起
 *             有卡计划稿不再挂 arranged-not-expanded（判据收窄为零卡），段位按原推导待办；
 *   - 场景 11  三特性（specs 字典序 → 计划目录冻结序）首次 --assign → 全局单序列按确定性扫描顺序
 *             领号（spec 特性号 registry 内绑定；计划号 = 文件头标记、任务号 = 条目行尾标记），
 *             源头标记 / registry / board 三方一致；auto-recompile 后 board 反映全部新号；
 *             再次 --assign 零写入（幂等）；
 *   - 场景 12  身份稳定-重排：条目乱序 → 全部 no 不变（标记随行走）、blocked-by 引用完好、
 *             仅 label 变化、registry 无任何变化；
 *   - 场景 13  删除不复用：删除条目 → 号成空洞；最高号删除后 seq 不回落；新条目领 seq+1；
 *   - 场景 14  旧文件迁移：两份真实样例（无号）首轮 --assign → e5545aac 头部 1 + T1–T4 行尾 2–5、
 *             f1a2d0bb 头部 6；除插入标记外字节不变；第二轮幂等；interview-only 节点始终无号；
 *   - 场景 19  号码冲突：两条目手写同号 → assign 不改号、不改文件、diagnostics 非空、
 *             后到者按未领号降级（--check 非零退出归 T10）；
 *   - 场景 20  标记/registry 不一致与重建：标记号未被登记 → 采纳补登记 + 高水位前进（跳号警示）；
 *             registry 整个丢失 → 按全部活标记重建（seq = max 活号），board 的 no 与引用不变；
 *   - 场景 22  计划→spec 延续：计划号 N 的事项建 spec 后 → spec 节点 no 仍为 N（registry 条目
 *             改指 spec 根、号不变），plan 文件降为 evidence（节点退役、文件字节不变）；
 *             原草案任务号成空洞；tasks.md 任务领新号；
 *   - 场景 31  多工作树 registry 合并：seq 取 max（seq / 条目 no / 活标记三源）、条目并集保留、
 *             新号不撞既有号；同号双实体 → 冲突路径（不改号、diagnostics）；--check 半场归 T10；
 *   - 场景 33（后半）  苗圃稿迁至 docs/plans/（头部标记不变）→ registry 指向更新、号不变、
 *             板无重复节点；
 *   - 场景 35a 归档指向改写（勘误 10 第三种指向改写）：file/specRoot 指向不存在、归档路径存在且含该号
 *             标记 → 改写指向、号/assignedAt/seq 不变（三映射全覆盖）；无标记候选不改写；二次 assign 幂等；
 *   - 写入面（§12 副作用边界）：--assign 的源头写入仅限号标记 + registry（+ board 产物）；
 *     默认编译仍对源零写入（每次编译前后快照对比）；
 *   - 静态断言：lib/marker-write.mjs 存在且逐文件原子写；无第三方依赖；CLI 帮助含 --assign。
 *
 * 用法：
 *   node assets/test/run-t9-scenarios.mjs                # 全部
 *   node assets/test/run-t9-scenarios.mjs --only 3,11    # 只跑指定场景
 *   node assets/test/run-t9-scenarios.mjs --clean        # 跑完删除临时夹具（默认保留供留证）
 * 退出码：0 = 全部通过；1 = 有失败。
 */

import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { readJsonFile } from "../lib/board-io.mjs";import {
  ASSETS_DIR,
  COMPILER,
  SAMPLE_PLAN_E5545AAC,
  SAMPLE_PLAN_F1A2D0BB,
  diffSnapshot,
  isDir,
  isFile,
  newRoot,
  removeRoot,
  sampleText,
  toPosix,
  treeSnapshot,
  w,
} from "./fixtures/build-fixture.mjs";

const REGISTRY_REL = ".zcode/board/registry.json";
const BOARD_REL = ".zcode/board/board.json";
/** 编译器产物（board）+ assign 合法写目标（registry）：快照断言白名单。 */
const SNAPSHOT_ALLOWED = [BOARD_REL, ".zcode/board/board.md", REGISTRY_REL];

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

  inc(haystack, needle, label) {
    const has = typeof haystack === "string" && haystack.includes(needle);
    return this.ok(has, label, `未在文本中找到 ${show(needle)}`);
  }

  regex(text, re, label) {
    const ok = typeof text === "string" && re.test(text);
    return this.ok(ok, label, `文本不匹配 ${re}`);
  }

  exit(result, expected, label) {
    const detail =
      `期望退出码 ${expected}；实际 ${String(result.code)}` +
      (result.error ? `（spawn error=${result.error.message}）` : "") +
      `\n          stderr：${truncate(result.stderr, 300)}` +
      `\n          stdout：${truncate(result.stdout, 200)}`;
    return this.ok(result.code === expected, label, detail);
  }
}

function truncate(s, n = 300) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// ---------------------------------------------------------------- 夹具与调用公用件

function runCompiler(root, args = []) {
  const res = spawnSync(process.execPath, [COMPILER, root, ...args], { encoding: "utf8" });
  let board = null;
  let boardText = null;
  let mdText = null;
  const boardPath = join(root, BOARD_REL);
  if (isFile(boardPath)) {
    boardText = readFileSync(boardPath, "utf8");
    try {
      board = JSON.parse(boardText);
    } catch {
      board = null;
    }
  }
  const mdPath = join(root, ".zcode/board/board.md");
  if (isFile(mdPath)) mdText = readFileSync(mdPath, "utf8");
  return {
    args,
    code: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error ?? null,
    board,
    boardText,
    md: mdText,
  };
}

function runAssign(root) {
  return runCompiler(root, ["--assign"]);
}

function readText(root, rel) {
  return readFileSync(join(root, rel), "utf8");
}

function readRegistry(root) {
  const loaded = readJsonFile(join(root, REGISTRY_REL));
  return loaded.ok ? loaded.value : null;
}

/** 独立于实现的期望文本：文件头标记 = 标题行后新起一行；行尾标记 = 行尾追加 " <!-- ... -->"。 */
function expectedAssign(beforeText, { headerNo = null, lineNos = [] } = {}) {
  const marker = (no) => `<!-- zcode-board: no=${no} -->`;
  const lines = beforeText.split("\n");
  for (const { lineIndex, no } of [...lineNos].sort((a, b) => a.lineIndex - b.lineIndex)) {
    if (lineIndex < 0 || lineIndex >= lines.length) throw new Error(`行号越界：${lineIndex}`);
    lines[lineIndex] = `${lines[lineIndex]} ${marker(no)}`;
  }
  if (headerNo != null) {
    const h = lines.findIndex((l) => /^#{1,6}\s/.test(l));
    lines.splice(h >= 0 ? h + 1 : 0, 0, marker(headerNo));
  }
  return lines.join("\n");
}

/** 按内容定位行号（0 起）；找不到即抛，防止夹具漂移导致断言静默失效。 */
function lineIndexOf(text, needle) {
  const idx = text.split("\n").findIndex((l) => l.includes(needle));
  if (idx < 0) throw new Error(`夹具定位失败：找不到包含 ${JSON.stringify(needle)} 的行`);
  return idx;
}

/** 源零写入断言（忽略编译器产物 board.* 与 registry）：纯编译 / 幂等 assign 必须零写入。 */
function assertZeroSourceWrites(c, before, after, label) {
  const diff = diffSnapshot(before, after, SNAPSHOT_ALLOWED);
  const changed = diff.changed.map((x) => x.rel).filter((rel) => !SNAPSHOT_ALLOWED.includes(rel));
  c.eq(changed, [], `${label}：源文件与 registry 零写入（字节 + mtime）`);
  c.eq(diff.added, [], `${label}：无新增源文件`);
  c.eq(diff.removed, [], `${label}：无文件被删除`);
}

/** 写入面断言：与基线相比，被改写文件恰为白名单（registry 与 board 产物按定义不计入；registry 内容另有专项断言）。 */
function assertWriteSurface(c, before, after, allowedChanged, label) {
  const diff = diffSnapshot(before, after, SNAPSHOT_ALLOWED);
  const changed = diff.changed
    .map((x) => x.rel)
    .filter((rel) => !SNAPSHOT_ALLOWED.includes(rel))
    .sort();
  c.eq(changed, [...allowedChanged].sort(), `${label}：被改写文件恰为白名单`);
  c.eq(diff.removed, [], `${label}：无文件被删除`);
  c.eq(diff.added, [], `${label}：无白名单外新增文件`);
}

function maskedIso(text) {
  return String(text ?? "").replace(
    /[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([+-][0-9]{2}:[0-9]{2}|Z)/g,
    "<TS>",
  );
}

/** 板上全部节点的 no（含嵌套任务）。 */
function boardNos(board) {
  const out = [];
  const walk = (list) => {
    for (const n of list ?? []) {
      if (Number.isInteger(n.no)) out.push(n.no);
      walk(n.tasks);
    }
  };
  walk(board?.features ?? []);
  return out.sort((a, b) => a - b);
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

function featureByTitle(board, title) {
  return (board?.features ?? []).find((f) => f.title === title) ?? null;
}

function taskByTitle(feature, title) {
  return (feature?.tasks ?? []).find((t) => t.title === title) ?? null;
}

function nodeByNo(board, no) {
  let hit = null;
  walkNodes(board?.features, (n) => {
    if (n.no === no) hit = n;
  });
  return hit;
}

function diagMessages(board, path) {
  return (board?.diagnostics ?? []).filter((d) => d.path === path).map((d) => d.message);
}

/** registry 精简视图（no/kind/指向/title），供确定性顺序断言。 */
function registryView(root) {
  const doc = readRegistry(root);
  if (!doc) return null;
  return (doc.entries ?? []).map((e) => ({
    no: e.no,
    kind: e.kind,
    ...(e.file != null ? { file: e.file } : {}),
    ...(e.specRoot != null ? { specRoot: e.specRoot } : {}),
    title: e.title,
  }));
}

// ---------------------------------------------------------------- 用例定义

const TESTS = [];
function test(id, title, fn) {
  TESTS.push({ id, title, fn });
}

// ---- 静态：交付物形态与依赖边界
test("static", "静态：marker-write.mjs 存在、CLI 帮助含 --assign、无第三方依赖、applyMarkerEdits 契约", async (c) => {
  c.ok(isFile(join(ASSETS_DIR, "lib", "marker-write.mjs")), "交付物存在：assets/lib/marker-write.mjs");

  const help = runCompiler(process.cwd(), ["--help"]);
  c.eq(help.code, 0, "--help 退出码 0");
  c.inc(help.stdout, "[--assign]", "帮助的用法行含 [--assign]（发号模式已可用）");
  c.inc(help.stdout, "--check", "帮助仍说明 --check 归属（T10）");

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
  c.ok(files.length >= 8, "assets 树含全部交付脚本（>=8 个 .mjs）", `实际 ${files.length}`);
  const offenders = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g)) {
      const spec = m[1];
      if (!spec.startsWith("node:") && !spec.startsWith(".") && !spec.startsWith("/")) {
        offenders.push(`${toPosix(f.slice(ASSETS_DIR.length + 1))} → ${spec}`);
      }
    }
  }
  c.eq(offenders, [], "全部 .mjs 仅使用 node: 内置或相对导入（无第三方依赖）");

  const { applyMarkerEdits } = await import("../lib/marker-write.mjs");
  const before = "# 标题\n\n- **T1 甲（草案）**：正文。\n";
  const afterHeader = applyMarkerEdits(before, { headerMarkerNo: 5 });
  c.eq(afterHeader, "# 标题\n<!-- zcode-board: no=5 -->\n\n- **T1 甲（草案）**：正文。\n", "applyMarkerEdits：文件头标记置于标题行后（独立期望值）");
  const withLine = applyMarkerEdits(before, { lineMarkerNos: [{ lineIndex: 2, no: 9 }] });
  c.eq(withLine, "# 标题\n\n- **T1 甲（草案）**：正文。 <!-- zcode-board: no=9 -->\n", "applyMarkerEdits：行尾标记只增不改");
  c.eq(applyMarkerEdits(before, {}), before, "applyMarkerEdits：无编辑时逐字节原样返回（幂等基础）");
  const crlf = "# 标题\r\n\r\n- 甲（草案）\r\n";
  c.eq(
    applyMarkerEdits(crlf, { headerMarkerNo: 3, lineMarkerNos: [{ lineIndex: 2, no: 4 }] }),
    "# 标题\r\n<!-- zcode-board: no=3 -->\r\n\r\n- 甲（草案） <!-- zcode-board: no=4 -->\r\n",
    "applyMarkerEdits：CRLF 行尾保持",
  );
  const twice = applyMarkerEdits(afterHeader, { headerMarkerNo: 6 });
  c.eq(twice, afterHeader, "applyMarkerEdits：已有头标记时不再插入（不重复盖号）");
});

// ---- 场景 3：plan T1–T4 首轮 assign
test("3", "场景 3：plan T1–T4 首轮 --assign → 草案卡 4 张 + 稳定号 + label（#53 v2.3：有卡不再挂 arranged-not-expanded）", (c, root) => {
  const planRel = ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000003.md";
  const planText = [
    "# 预览通道实现方案 · v3",
    "",
    "- **T1 预览发布通道（workflow）**：发布步在 tag 含 -preview 时加 --prerelease；stable 路径一字不动。",
    "",
    "- **T2 让开关立刻生效（核心）**：把「应用通道到 updater」抽成一个函数，初始化与拨开关两条路径都调它。",
    "",
    "- **T3 通道可见 + 版本序语义**：updateChannel 接到界面；版本序语义写进注释与文档。",
    "",
    "- **T4 文档 + 死代码**：README 发版小节补预览发布流程。",
    "",
  ].join("\n");
  w(root, planRel, planText);

  const before = treeSnapshot(root);
  const res = runAssign(root);
  const after = treeSnapshot(root);
  c.exit(res, 0, "--assign 退出码 0");
  c.ok(res.board !== null, "assign 自带重编译：board.json 可解析");

  const f = featureByTitle(res.board, "预览通道实现方案 · v3");
  c.ok(f !== null, "计划稿成特性节点");
  c.eq([f?.no, f?.label], [1, "1"], "文件头标记 → 特性号 1、label = 稳定号字符串");
  c.eq((f?.tasks ?? []).map((t) => t.title), ["预览发布通道（workflow）", "让开关立刻生效（核心）", "通道可见 + 版本序语义", "文档 + 死代码"], "title 剥离 T 前缀");
  c.eq((f?.tasks ?? []).map((t) => t.no), [2, 3, 4, 5], "任务号 2–5（同一全局单序列、文档序）");
  c.eq((f?.tasks ?? []).map((t) => t.label), ["1", "2", "3", "4"], "label 按计划内树位派生（#46 A2：顶层 1..n）");
  c.eq((f?.tasks ?? []).map((t) => t.draft), [true, true, true, true], "计划条目派生卡 draft: true");
  c.eq((f?.tasks ?? []).map((t) => t.details), [
    "发布步在 tag 含 -preview 时加 --prerelease；stable 路径一字不动。",
    "把「应用通道到 updater」抽成一个函数，初始化与拨开关两条路径都调它。",
    "updateChannel 接到界面；版本序语义写进注释与文档。",
    "README 发版小节补预览发布流程。",
  ], "details 取条目正文首行（同行正文）");
  c.eq(f?.attention, [], "#53 契约 v2.3：有卡计划稿不再误挂 arranged-not-expanded（判据收窄为零卡）");
  c.eq(f?.stage, "待办", "段位按原推导（status=pending 且无 activeRun）→ 待办");
  c.eq(diagMessages(res.board, planRel), [], "发号后该计划稿无未领号 diagnostics（不静默也无所缺）");

  c.eq(registryView(root), [
    { no: 1, kind: "plan", file: planRel, title: "预览通道实现方案 · v3" },
    { no: 2, kind: "task", file: planRel, title: "预览发布通道（workflow）" },
    { no: 3, kind: "task", file: planRel, title: "让开关立刻生效（核心）" },
    { no: 4, kind: "task", file: planRel, title: "通道可见 + 版本序语义" },
    { no: 5, kind: "task", file: planRel, title: "文档 + 死代码" },
  ], "registry：计划号与任务号同一条序列，条目指向计划稿路径");
  c.eq(readRegistry(root)?.seq, 5, "seq = 已发最大号（高水位）");

  const find = (needle) => lineIndexOf(planText, needle);
  c.eq(
    readText(root, planRel),
    expectedAssign(planText, {
      headerNo: 1,
      lineNos: [
        { lineIndex: find("**T1 预览发布通道（workflow）**"), no: 2 },
        { lineIndex: find("**T2 让开关立刻生效（核心）**"), no: 3 },
        { lineIndex: find("**T3 通道可见 + 版本序语义**"), no: 4 },
        { lineIndex: find("**T4 文档 + 死代码**"), no: 5 },
      ],
    }),
    "源头写入逐字节 = 独立期望（头标记一行 + 各行尾标记，其余字节不变）",
  );
  assertWriteSurface(c, before, after, [planRel], "写入面（§12：仅计划稿号标记 + registry 新增）");
});

// ---- 场景 11：三特性首轮发号（确定性顺序）+ 幂等
test("11", "场景 11：多源首轮 --assign → 确定性扫描顺序领号、三方一致、二次 assign 幂等", (c, root) => {
  w(root, "specs/alpha/requirements.md", "# Requirements: Alpha 特性\n");
  w(root, "specs/alpha/tasks.md", ["# Implementation Plan: Alpha", "", "- [ ] 1. 甲一", "  - Scope: 甲一细节。", ""].join("\n"));
  w(root, "specs/beta/requirements.md", "# Requirements: Beta 特性\n");
  w(root, "specs/beta/tasks.md", ["# Implementation Plan: Beta", "", "- [ ] 1. 乙一", "- [ ] 2. 乙二", ""].join("\n"));
  const aaa = ".zcode/plans/plan-aaa.md";
  const bbb = "docs/plans/plan-bbb.md";
  const aaaText = ["# 甲计划", "", "- **T1 甲任务（草案）**：甲任务正文。", "- **T2 甲任务二（草案）**：甲任务二正文。", ""].join("\n");
  const bbbText = ["# 乙计划", "", "- [ ] 1. 文档计划条目", "  - 条目正文。", ""].join("\n");
  w(root, aaa, aaaText);
  w(root, bbb, bbbText);
  // #72：docs/plans 为 opt-in 扫描面——本夹具显式开启（覆盖「docs/plans 参与发号」不弱化）
  w(root, ".zcode/board/scan.json", JSON.stringify({ includeDirs: ["docs/plans"] }, null, 2) + "\n");

  const before1 = treeSnapshot(root);
  const r1 = runAssign(root);
  const after1 = treeSnapshot(root);
  c.exit(r1, 0, "首次 --assign 退出码 0");
  c.ok(r1.board !== null, "auto-recompile 产出 board.json");

  const expectedOrder = [
    { no: 1, kind: "spec", specRoot: "specs/alpha/", title: "Alpha 特性" },
    { no: 2, kind: "task", file: "specs/alpha/tasks.md", title: "甲一" },
    { no: 3, kind: "spec", specRoot: "specs/beta/", title: "Beta 特性" },
    { no: 4, kind: "task", file: "specs/beta/tasks.md", title: "乙一" },
    { no: 5, kind: "task", file: "specs/beta/tasks.md", title: "乙二" },
    { no: 6, kind: "plan", file: aaa, title: "甲计划" },
    { no: 7, kind: "task", file: aaa, title: "甲任务（草案）" },
    { no: 8, kind: "task", file: aaa, title: "甲任务二（草案）" },
    { no: 9, kind: "plan", file: bbb, title: "乙计划" },
    { no: 10, kind: "task", file: bbb, title: "文档计划条目" },
  ];
  c.eq(registryView(root), expectedOrder, "registry 按确定性扫描顺序领号（specs 字典序 → PLAN_DIRS 冻结序，文件内文档序）");
  c.eq(readRegistry(root)?.seq, 10, "seq = 10（全局单序列，无撞号）");
  c.eq(boardNos(r1.board), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "board 活号 = 同一组 10 号（三方一致）");

  for (const e of expectedOrder) {
    const node = nodeByNo(r1.board, e.no);
    c.ok(node !== null, `号 ${e.no} 在板上（${e.title}）`);
  }
  c.eq(featureByTitle(r1.board, "Alpha 特性")?.label, "1", "spec 特性 label = 稳定号");
  c.eq(taskByTitle(featureByTitle(r1.board, "Alpha 特性"), "甲一")?.label, "1.1", "spec 任务 label 1.1");
  c.eq((featureByTitle(r1.board, "Beta 特性")?.tasks ?? []).map((t) => t.label), ["3.1", "3.2"], "Beta 任务 label 3.1/3.2");
  c.eq((featureByTitle(r1.board, "甲计划")?.tasks ?? []).map((t) => t.no), [7, 8], "计划任务号 7/8");
  c.eq((featureByTitle(r1.board, "乙计划")?.tasks ?? []).map((t) => t.label), ["1"], "文档计划任务 label 1（#46 A2 计划内序）");

  c.eq(
    readText(root, aaa),
    expectedAssign(aaaText, {
      headerNo: 6,
      lineNos: [
        { lineIndex: lineIndexOf(aaaText, "**T1 甲任务（草案）**"), no: 7 },
        { lineIndex: lineIndexOf(aaaText, "**T2 甲任务二（草案）**"), no: 8 },
      ],
    }),
    "计划稿标记逐字节 = 独立期望",
  );
  c.eq(
    readText(root, "specs/beta/tasks.md"),
    expectedAssign(["# Implementation Plan: Beta", "", "- [ ] 1. 乙一", "- [ ] 2. 乙二", ""].join("\n"), {
      lineNos: [
        { lineIndex: 2, no: 4 },
        { lineIndex: 3, no: 5 },
      ],
    }),
    "spec tasks.md 只加行尾标记（spec 特性号无内联标记，registry 内绑定）",
  );
  c.ok(!readText(root, "specs/alpha/tasks.md").split("\n").some((l) => /^\s*<!--\s*zcode-board/.test(l)), "tasks.md 无文件级标记");
  assertWriteSurface(c, before1, after1, ["specs/alpha/tasks.md", "specs/beta/tasks.md", aaa, bbb], "写入面（§12）");

  // 二次 assign：幂等（零写入；board 内容除时间戳外不变）
  const before2 = treeSnapshot(root);
  const r2 = runAssign(root);
  const after2 = treeSnapshot(root);
  c.exit(r2, 0, "二次 --assign 退出码 0");
  assertZeroSourceWrites(c, before2, after2, "二次 assign 幂等");
  c.eq(maskedIso(r2.boardText), maskedIso(r1.boardText), "二次 assign 后 board.json 逐字节一致（时间戳掩码）");
  c.eq(maskedIso(r2.md), maskedIso(r1.md), "二次 assign 后 board.md 一致（时间戳掩码）");
});

// ---- 场景 12：身份稳定-重排
test("12", "场景 12：条目乱序 → no 不变、引用完好、仅 label 变化、registry 无变化", (c, root) => {
  const planRel = ".zcode/plans/plan-reorder.md";
  const planText = [
    "# 重排夹具",
    "<!-- zcode-board: no=1 -->",
    "- **T1 甲卡（草案）**：甲正文。 <!-- zcode-board: no=2 -->",
    "  > blocked-by: 3 —— 等乙卡落地",
    "- **T2 乙卡（草案）**：乙正文。 <!-- zcode-board: no=3 -->",
    "- **T3 丙卡（草案）**：丙正文。 <!-- zcode-board: no=4 -->",
    "",
  ].join("\n");
  w(root, planRel, planText);
  w(root, "specs/gamma/requirements.md", "# Requirements: Gamma 特性\n");
  const tasksRel = "specs/gamma/tasks.md";
  const tasksText = [
    "# Implementation Plan: Gamma",
    "",
    "- [ ] 1. 甲任务 <!-- zcode-board: no=6 -->",
    "- [ ] 2. 乙任务 <!-- zcode-board: no=7 -->",
    "",
  ].join("\n");
  w(root, tasksRel, tasksText);
  w(root, REGISTRY_REL, JSON.stringify({ version: 1, seq: 7, entries: [
    { no: 1, kind: "plan", file: planRel, title: "重排夹具", assignedAt: "2026-10-01T00:00:00+08:00" },
    { no: 2, kind: "task", file: planRel, title: "甲卡（草案）", assignedAt: "2026-10-01T00:00:00+08:00" },
    { no: 3, kind: "task", file: planRel, title: "乙卡（草案）", assignedAt: "2026-10-01T00:00:00+08:00" },
    { no: 4, kind: "task", file: planRel, title: "丙卡（草案）", assignedAt: "2026-10-01T00:00:00+08:00" },
    { no: 5, kind: "spec", specRoot: "specs/gamma/", title: "Gamma 特性", assignedAt: "2026-10-01T00:00:00+08:00" },
    { no: 6, kind: "task", file: tasksRel, title: "甲任务", assignedAt: "2026-10-01T00:00:00+08:00" },
    { no: 7, kind: "task", file: tasksRel, title: "乙任务", assignedAt: "2026-10-01T00:00:00+08:00" },
  ] }, null, 2) + "\n");

  // 阶段 1：已一致 → assign 零写入
  const before1 = treeSnapshot(root);
  const r1 = runAssign(root);
  const after1 = treeSnapshot(root);
  c.exit(r1, 0, "重排前 --assign 退出码 0");
  assertZeroSourceWrites(c, before1, after1, "重排前 assign");
  const registryBefore = readText(root, REGISTRY_REL);
  const nosBefore = boardNos(r1.board);

  // 阶段 2：整体乱序（甲块含引用行整块移动；spec 两任务对调）
  const reordered = [
    "# 重排夹具",
    "<!-- zcode-board: no=1 -->",
    "- **T3 丙卡（草案）**：丙正文。 <!-- zcode-board: no=4 -->",
    "- **T1 甲卡（草案）**：甲正文。 <!-- zcode-board: no=2 -->",
    "  > blocked-by: 3 —— 等乙卡落地",
    "- **T2 乙卡（草案）**：乙正文。 <!-- zcode-board: no=3 -->",
    "",
  ].join("\n");
  w(root, planRel, reordered);
  const tasksReordered = [
    "# Implementation Plan: Gamma",
    "",
    "- [ ] 2. 乙任务 <!-- zcode-board: no=7 -->",
    "- [ ] 1. 甲任务 <!-- zcode-board: no=6 -->",
    "",
  ].join("\n");
  w(root, tasksRel, tasksReordered);

  // 阶段 3：再 assign（重编号不得发生；registry 不得变化）+ 断言板
  const r2 = runAssign(root);
  c.exit(r2, 0, "重排后 --assign 退出码 0");
  c.eq(readText(root, REGISTRY_REL), registryBefore, "registry 逐字节无变化（乱序不是发号事件）");
  c.eq(boardNos(r2.board), nosBefore, "全部 no 不变（标记随行走）");

  const plan = featureByTitle(r2.board, "重排夹具");
  c.eq((plan?.tasks ?? []).map((t) => [t.title, t.no, t.label]), [
    ["丙卡（草案）", 4, "1"],
    ["甲卡（草案）", 2, "2"],
    ["乙卡（草案）", 3, "3"],
  ], "只有 label 变化（计划内 1/2/3 随位次重排），no 跟随条目不动");
  const jia = taskByTitle(plan, "甲卡（草案）");
  c.eq(jia?.blockers, [{ kind: "dependency", blockedBy: 3, summary: "等乙卡落地", evidence: [planRel] }], "既有 blocked-by 引用完好可达（blockedBy=3 仍在板上）");
  const gamma = featureByTitle(r2.board, "Gamma 特性");
  c.eq((gamma?.tasks ?? []).map((t) => [t.title, t.no, t.label]), [
    ["乙任务", 7, "5.1"],
    ["甲任务", 6, "5.2"],
  ], "spec tasks.md 乱序：no 不变、label 随位次变化");
  c.ok(readText(root, planRel).includes("no=2") && readText(root, planRel).includes("no=4"), "文件字节未因 assign 被改写（标记原样）");
});

// ---- 场景 13：删除不复用
test("13", "场景 13：删除条目号成空洞、最高号删除后 seq 不回落、新条目领 seq+1", (c, root) => {
  const planRel = ".zcode/plans/plan-del.md";
  w(root, planRel, ["# 删除夹具", "", "- **T1 甲条目（草案）**：甲正文。", "- **T2 乙条目（草案）**：乙正文。", "- **T3 丙条目（草案）**：丙正文。", ""].join("\n"));

  const r1 = runAssign(root);
  c.exit(r1, 0, "首轮 --assign 退出码 0");
  c.eq(registryView(root).map((e) => e.no), [1, 2, 3, 4], "首轮：计划 1 + 任务 2/3/4");

  // 删除 乙（no=3）与 丙（no=4，最高号）
  const afterDelete = ["# 删除夹具", "<!-- zcode-board: no=1 -->", "- **T1 甲条目（草案）**：甲正文。 <!-- zcode-board: no=2 -->", ""].join("\n");
  w(root, planRel, afterDelete);
  const r2 = runAssign(root);
  c.exit(r2, 0, "删除后 --assign 退出码 0");
  c.eq(readRegistry(root)?.seq, 4, "seq 不回落（最高号 4 删除后仍是 4）");
  c.eq(registryView(root).map((e) => e.no), [1, 2, 3, 4], "registry 只增：3/4 条目保留（空洞）");
  c.eq(boardNos(r2.board), [1, 2], "板上只剩活条目号 1/2");

  // 新增未领号条目 → 领 seq+1（不复用 3/4）
  w(root, planRel, afterDelete.replace(/\n$/, "\n") + "- **T4 丁条目（草案）**：丁正文。\n");
  const r3 = runAssign(root);
  c.exit(r3, 0, "新增后 --assign 退出码 0");
  const f = featureByTitle(r3.board, "删除夹具");
  c.eq(taskByTitle(f, "丁条目（草案）")?.no, 5, "新条目领 seq+1 = 5（不复用空洞 3/4）");
  c.eq(taskByTitle(f, "丁条目（草案）")?.label, "2", "新条目 label 按当前树位 2（#46 A2 计划内序）");
  c.eq(readRegistry(root)?.seq, 5, "seq 前进到 5");
  c.eq(registryView(root).map((e) => e.no), [1, 2, 3, 4, 5], "registry 增 5、旧条目 3/4 仍在（号永不复用）");
  c.inc(readText(root, planRel), "<!-- zcode-board: no=5 -->", "新条目行尾盖号落在源头文件");
});

// ---- 场景 14：两份真实样例首轮迁移
test("14", "场景 14：两份真实样例首轮 --assign → 头部 1 + 行尾 2–5、头部 6；幂等；interview-only 无号", (c, root) => {
  const e5545 = `.zcode/plans/${SAMPLE_PLAN_E5545AAC}`;
  const f1a2 = `.zcode/plans/${SAMPLE_PLAN_F1A2D0BB}`;
  const eText = sampleText(SAMPLE_PLAN_E5545AAC);
  const fText = sampleText(SAMPLE_PLAN_F1A2D0BB);
  w(root, e5545, eText);
  w(root, f1a2, fText);
  w(root, ".zcode/board/interviews.json", JSON.stringify({ version: 1, interviews: [
    { id: "itw-20261009-0014", at: "2026-10-09T10:00:00+08:00", sessionId: "sess_14", topic: "尚未安排的事项", summary: "只登记未落产物。", decisions: [], artifacts: [], outcome: "none", status: "open" },
  ] }, null, 2) + "\n");

  const before = treeSnapshot(root);
  const r1 = runAssign(root);
  const after = treeSnapshot(root);
  c.exit(r1, 0, "首轮 --assign 退出码 0");

  c.eq(registryView(root), [
    { no: 1, kind: "plan", file: e5545, title: "预览通道（Preview Channel）实现方案 · v3" },
    { no: 2, kind: "task", file: e5545, title: "预览发布通道（workflow）" },
    { no: 3, kind: "task", file: e5545, title: "让开关立刻生效（核心）" },
    { no: 4, kind: "task", file: e5545, title: "通道可见 + 版本序语义" },
    { no: 5, kind: "task", file: e5545, title: "文档 + 死代码" },
    { no: 6, kind: "plan", file: f1a2, title: "会话按需加载：上拖后台加载时，当前可见内容不许位移" },
  ], "首轮迁移：e5545aac 头部 1 + T1–T4 行尾 2–5；f1a2d0bb 头部 6");
  c.eq(readRegistry(root)?.seq, 6, "seq = 6");

  const eAfter = readText(root, e5545);
  c.eq(
    eAfter,
    expectedAssign(eText, {
      headerNo: 1,
      lineNos: [
        { lineIndex: lineIndexOf(eText, "**T1 预览发布通道（workflow）**"), no: 2 },
        { lineIndex: lineIndexOf(eText, "**T2 让开关立刻生效（核心）**"), no: 3 },
        { lineIndex: lineIndexOf(eText, "**T3 通道可见 + 版本序语义**"), no: 4 },
        { lineIndex: lineIndexOf(eText, "**T4 文档 + 死代码**"), no: 5 },
      ],
    }),
    "e5545aac：除插入标记外逐字节不变（独立期望）",
  );
  const fAfter = readText(root, f1a2);
  c.eq(fAfter, expectedAssign(fText, { headerNo: 6 }), "f1a2d0bb：头部 6、0 个行级号（A/B/C 节不是任务语法）");
  c.eq((fAfter.match(/zcode-board: no=/g) ?? []).length, 1, "f1a2d0bb 全文件只有 1 个标记");

  const real = featureByTitle(r1.board, "预览通道（Preview Channel）实现方案 · v3");
  c.eq(real?.no, 1, "板：e5545aac 特性号 1");
  c.eq((real?.tasks ?? []).map((t) => t.no), [2, 3, 4, 5], "板：T1–T4 号 2–5");
  c.eq((real?.tasks ?? []).map((t) => t.title), ["预览发布通道（workflow）", "让开关立刻生效（核心）", "通道可见 + 版本序语义", "文档 + 死代码"], "title 照剥 T 前缀");
  c.eq(featureByTitle(r1.board, "会话按需加载：上拖后台加载时，当前可见内容不许位移")?.no, 6, "板：f1a2d0bb 特性号 6");
  const itw = (r1.board?.features ?? []).find((n) => n.kind === "interview-only");
  c.ok(itw !== null, "interview-only 节点在板上");
  c.ok(!Object.hasOwn(itw ?? {}, "no") && !Object.hasOwn(itw ?? {}, "label"), "interview-only 始终无号（访谈不占号）");

  // 第二轮：幂等
  const before2 = treeSnapshot(root);
  const registryText1 = readText(root, REGISTRY_REL);
  const r2 = runAssign(root);
  const after2 = treeSnapshot(root);
  c.exit(r2, 0, "第二轮 --assign 退出码 0");
  assertZeroSourceWrites(c, before2, after2, "第二轮 assign 幂等");
  c.eq(readText(root, REGISTRY_REL), registryText1, "registry 逐字节稳定（无重复写入）");
  c.inc(r2.boardText, '"no": 6', "第二轮 board 仍反映号 6");
  assertWriteSurface(c, before, after, [e5545, f1a2], "首轮写入面（§12：两份样例号标记 + registry 新增）");
});

// ---- 场景 19：号码冲突（assign 不改号）
test("19", "场景 19：两条目手写同号 → assign 不改号、不改文件、diagnostics、后到者未领号降级", (c, root) => {
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

  const before = treeSnapshot(root);
  const res = runAssign(root);
  const after = treeSnapshot(root);
  c.exit(res, 0, "--assign 退出码 0（非零退出归 --check，T10）");
  assertZeroSourceWrites(c, before, after, "冲突路径不静默改写任何文件");
  c.ok(
    /重复/.test(res.stderr) && res.stderr.includes("6"),
    "assign 输出 diagnostics 点名号 6 重复（不静默）",
    truncate(res.stderr, 300),
  );
  c.eq(readRegistry(root)?.seq, 6, "seq 不因冲突前进（不自动改号）");
  c.eq(registryView(root).map((e) => e.no), [5, 6], "registry 无新条目（冲突未消化前不发新号）");

  const f = featureByTitle(res.board, "冲突夹具");
  c.eq(taskByTitle(f, "先到（草案）")?.no, 6, "先扫者保留号 6");
  const second = taskByTitle(f, "后到（草案）");
  c.ok(!Object.hasOwn(second ?? {}, "no") && !Object.hasOwn(second ?? {}, "label"), "后到者按未领号降级（no/label 双缺省）", show(second));
  c.ok(diagMessages(res.board, planRel).some((m) => m.includes("6") && m.includes("重复")), "board diagnostics 记录冲突（重编译自带）");
  c.ok(!JSON.stringify(res.board).includes('"no": 7'), "未静默另发新号（板上无 7）");
});

// ---- 场景 20：标记/registry 不一致（采纳补登记）+ registry 丢失重建
test("20", "场景 20：标记未被 registry 登记 → 采纳补登记 + 高水位前进；registry 丢失 → 按活标记重建", (c, root) => {
  // -- 部分 A：手工写号（篡改路径）未被登记 →
  w(root, "specs/zeta/requirements.md", "# Requirements: Zeta 特性\n");
  w(root, "specs/zeta/tasks.md", ["# Implementation Plan: Zeta", "", "- [ ] 1. 泽塔任务", ""].join("\n"));
  const planRel = ".zcode/plans/plan-tamper.md";
  w(root, planRel, [
    "# 篡改夹具",
    "<!-- zcode-board: no=9 -->",
    "- **T1 篡后（草案）**：正文一。",
    "- **T2 篡后二（草案）**：正文二。",
    "",
  ].join("\n"));
  w(root, REGISTRY_REL, JSON.stringify({ version: 1, seq: 5, entries: [
    { no: 5, kind: "spec", specRoot: "specs/zeta/", title: "Zeta 特性", assignedAt: "2026-10-01T00:00:00+08:00" },
  ] }, null, 2) + "\n");

  const rA = runAssign(root);
  c.exit(rA, 0, "部分 A：--assign 退出码 0");
  c.ok(/采纳/.test(rA.stderr) && rA.stderr.includes("9"), "部分 A：diagnostics 点名标记 9 被采纳（不静默）", truncate(rA.stderr, 300));
  c.ok(rA.stderr.includes("跳号"), "部分 A：高水位前进路径警示跳号", truncate(rA.stderr, 300));
  c.eq(readRegistry(root)?.seq, 12, "部分 A：seq 前进到 12（9 采纳 + 新发 10/11/12）");
  c.eq(registryView(root), [
    { no: 5, kind: "spec", specRoot: "specs/zeta/", title: "Zeta 特性" },
    { no: 9, kind: "plan", file: planRel, title: "篡改夹具" },
    { no: 10, kind: "task", file: "specs/zeta/tasks.md", title: "泽塔任务" },
    { no: 11, kind: "task", file: planRel, title: "篡后（草案）" },
    { no: 12, kind: "task", file: planRel, title: "篡后二（草案）" },
  ], "部分 A：标记 9 补登记；未领号条目按序领 10/11/12（不复用 5–9）");
  c.eq(nodeByNo(rA.board, 9)?.no, 9, "部分 A：板如实反映被采纳的 9（无降级）");
  c.eq(boardNos(rA.board), [5, 9, 10, 11, 12], "部分 A：活号唯一");

  // -- 部分 B：registry 整个丢失 → 按活标记重建（seq = max），板与引用不变
  const rootB = `${root}-rebuild`;
  try {
    mkdirSync(rootB, { recursive: false });
  } catch {
    /* 已存在时复用 */
  }
  const planB = ".zcode/plans/plan-rebuild.md";
  const planBText = [
    "# 重建夹具",
    "<!-- zcode-board: no=1 -->",
    "- **T1 重建甲（草案）**：正文。 <!-- zcode-board: no=2 -->",
    "  > blocked-by: 3 —— 等重建乙",
    "- **T2 重建乙（草案）**：正文。 <!-- zcode-board: no=3 -->",
    "",
  ].join("\n");
  w(rootB, planB, planBText);
  const compileBefore = runCompiler(rootB);
  c.exit(compileBefore, 0, "部分 B：registry 缺失时默认编译仍正常（标记为身份真相）");
  c.eq(boardNos(compileBefore.board), [1, 2, 3], "部分 B：重建前板号 1/2/3");
  const refBlockers = JSON.stringify(taskByTitle(featureByTitle(compileBefore.board, "重建夹具"), "重建甲（草案）")?.blockers);

  const beforeB = treeSnapshot(rootB);
  const rB = runAssign(rootB);
  const afterB = treeSnapshot(rootB);
  c.exit(rB, 0, "部分 B：--assign 退出码 0");
  c.inc(rB.stderr, "重建", "部分 B：diagnostics 记录 registry 重建（不静默）");
  c.eq(readRegistry(rootB)?.seq, 3, "部分 B：重建后 seq = max(活标记) = 3");
  c.eq(registryView(rootB), [
    { no: 1, kind: "plan", file: planB, title: "重建夹具" },
    { no: 2, kind: "task", file: planB, title: "重建甲（草案）" },
    { no: 3, kind: "task", file: planB, title: "重建乙（草案）" },
  ], "部分 B：每条活标记重建一条 registry 条目（号随文件走）");
  c.eq(readText(rootB, planB), planBText, "部分 B：源头文件零改写（幂等：重建不改号不盖号）");
  c.eq(boardNos(rB.board), [1, 2, 3], "部分 B：board 的 no 不变");
  c.eq(JSON.stringify(taskByTitle(featureByTitle(rB.board, "重建夹具"), "重建甲（草案）")?.blockers), refBlockers, "部分 B：blockedBy 引用不变");
  assertZeroSourceWrites(c, beforeB, afterB, "部分 B：assign 只写 registry（+board）");
  rmSync(rootB, { recursive: true, force: true });
});

// ---- 场景 22：计划→spec 延续
test("22", "场景 22：计划→spec 延续 → spec 号不变、registry 改指 spec 根、plan 退役为 evidence、任务领新号", (c, root) => {
  const planRel = ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000022.md";
  const planText = [
    "# 预览通道（Preview Channel）实现方案 · v3",
    "<!-- zcode-board: no=1 -->",
    "- **T1 预览发布通道（workflow）**：草案条目一。 <!-- zcode-board: no=2 -->",
    "- **T2 让开关立刻生效（核心）**：草案条目二。 <!-- zcode-board: no=3 -->",
    "",
  ].join("\n");
  w(root, planRel, planText);
  w(root, "specs/preview-channel/requirements.md", "# Requirements: 预览通道（Preview Channel）\n");
  w(root, "specs/preview-channel/tasks.md", ["# Implementation Plan: 预览通道", "", "- [ ] 1. 预览发布通道（workflow）", "  - Scope: 切片一。", "- [ ] 2. 让开关立刻生效（核心）", "  - Scope: 切片二。", ""].join("\n"));
  w(root, "specs/preview-channel/progress.json", JSON.stringify({ version: 3, feature: "预览通道（Preview Channel）",
    current: { stage: "design", title: "" }, stages: { design: { status: "active", note: "", evidence: [] } },
    execution: { totalTasks: 2, completedTasks: 0 }, activity: [], blockers: [] }, null, 2) + "\n");
  w(root, REGISTRY_REL, JSON.stringify({ version: 1, seq: 3, entries: [
    { no: 1, kind: "plan", file: planRel, title: "预览通道（Preview Channel）实现方案 · v3", assignedAt: "2026-10-01T00:00:00+08:00" },
    { no: 2, kind: "task", file: planRel, title: "预览发布通道（workflow）", assignedAt: "2026-10-01T00:00:00+08:00" },
    { no: 3, kind: "task", file: planRel, title: "让开关立刻生效（核心）", assignedAt: "2026-10-01T00:00:00+08:00" },
  ] }, null, 2) + "\n");
  w(root, ".zcode/board/interviews.json", JSON.stringify({ version: 1, interviews: [
    { id: "itw-20261009-0022", at: "2026-10-01T09:00:00+08:00", sessionId: "sess_22", topic: "预览通道方案",
      summary: "确认 tag 规则与四项实施任务。", decisions: ["tag 采用 vX.Y.Z-preview.N"],
      artifacts: [planRel], outcome: "plan", resolvedBy: "spec:preview-channel", status: "open" },
  ] }, null, 2) + "\n");

  const before = treeSnapshot(root);
  const res = runAssign(root);
  const after = treeSnapshot(root);
  c.exit(res, 0, "--assign 退出码 0");

  const seq = readRegistry(root);
  const specEntry = (seq?.entries ?? []).find((e) => e.no === 1);
  c.eq(
    { no: specEntry?.no, kind: specEntry?.kind, specRoot: specEntry?.specRoot, file: specEntry?.file ?? null, title: specEntry?.title },
    { no: 1, kind: "spec", specRoot: "specs/preview-channel/", file: null, title: "预览通道（Preview Channel）实现方案 · v3" },
    "registry 条目 1 改指 spec 根（号不变、kind 改写、file 移除、title 快照保留）",
  );
  c.eq(registryView(root).filter((e) => e.no === 2 || e.no === 3).map((e) => e.kind), ["task", "task"], "原草案任务条目保留（号成空洞，不复用）");
  c.eq(seq?.seq, 5, "seq = 5（新增 tasks.md 任务 4/5）");
  c.eq(
    registryView(root).filter((e) => e.no >= 4),
    [
      { no: 4, kind: "task", file: "specs/preview-channel/tasks.md", title: "预览发布通道（workflow）" },
      { no: 5, kind: "task", file: "specs/preview-channel/tasks.md", title: "让开关立刻生效（核心）" },
    ],
    "tasks.md 任务领新号 4/5（不继承草案任务号 2/3）",
  );
  c.eq(readText(root, planRel), planText, "plan 文件逐字节不变（降为 evidence，标记不回收）");
  c.inc(res.stderr, "延续", "diagnostics 记录计划→spec 延续（不静默）");

  const spec = featureByTitle(res.board, "预览通道（Preview Channel）");
  c.ok(spec !== null, "板上 spec 节点存在");
  c.eq([spec?.no, spec?.label], [1, "1"], "spec 节点 no 仍为 1，label=1");
  c.eq(spec?.origin?.planRef, planRel, "plan 文件降为 evidence：origin.planRef 指向计划稿");
  c.eq(spec?.origin?.interviewId, "itw-20261009-0022", "登记条目合并到 spec 节点");
  c.eq((spec?.tasks ?? []).map((t) => [t.no, t.label]), [[4, "1.1"], [5, "1.2"]], "tasks.md 任务号 4/5、label 1.1/1.2");
  c.ok(featureByTitle(res.board, "预览通道（Preview Channel）实现方案 · v3") === null, "plan 节点退役（板上不再作为独立节点）");
  c.ok(!boardNos(res.board).includes(2) && !boardNos(res.board).includes(3), "草案任务号 2/3 不在板上（空洞）");
  c.eq(boardNos(res.board), [1, 4, 5], "活号 = 1/4/5（无重号）");
  c.ok(
    (res.board?.sources ?? []).some((s) => s.kind === "plan" && s.path === planRel),
    "sources[] 仍含计划稿路径（文件仍在扫描面，降为证据）",
  );
  assertWriteSurface(c, before, after, ["specs/preview-channel/tasks.md"], "写入面：plan 文件零触碰（registry 为允许写目标）");
});

// ---- 场景 31：多工作树 registry 合并
test("31", "场景 31：两副本 registry 合并语义 → seq 取 max、条目并集、不重号；同号双实体 → 冲突路径", (c, root) => {
  // -- 部分 A：合并后 seq 落后于条目（副本 B 的 9 已并集进来）
  w(root, "specs/a/requirements.md", "# Requirements: A 特性\n");
  w(root, "specs/a/tasks.md", ["# Implementation Plan: A", "", "- [ ] 1. 甲任务 <!-- zcode-board: no=8 -->", ""].join("\n"));
  w(root, "specs/b/requirements.md", "# Requirements: B 特性\n");
  w(root, "specs/b/tasks.md", ["# Implementation Plan: B", "", "- [ ] 1. 乙任务", ""].join("\n"));
  w(root, REGISTRY_REL, JSON.stringify({ version: 1, seq: 8, entries: [
    { no: 7, kind: "spec", specRoot: "specs/a/", title: "A 特性", assignedAt: "2026-10-01T00:00:00+08:00" },
    { no: 8, kind: "task", file: "specs/a/tasks.md", title: "甲任务", assignedAt: "2026-10-01T00:00:00+08:00" },
    { no: 9, kind: "spec", specRoot: "specs/b/", title: "B 特性", assignedAt: "2026-10-02T00:00:00+08:00" },
  ] }, null, 2) + "\n");

  const rA = runAssign(root);
  c.exit(rA, 0, "部分 A：--assign 退出码 0");
  c.eq(readRegistry(root)?.seq, 10, "部分 A：seq 取 max(seq=8, 条目 no=9, 活标记 8) 后新发 10");
  c.eq(registryView(root).map((e) => e.no), [7, 8, 9, 10], "部分 A：条目并集保留（7/8/9）+ 新号 10");
  c.eq(boardNos(rA.board), [7, 8, 9, 10], "部分 A：全部活标记一致、无重号");
  c.eq(taskByTitle(featureByTitle(rA.board, "B 特性"), "乙任务")?.no, 10, "部分 A：未领号条目领 10（不复用 7–9）");

  // -- 部分 B：同号双实体（违例发号）→ 冲突路径（不改号、不改文件、不发新号）
  const rootB = `${root}-dup`;
  try {
    mkdirSync(rootB, { recursive: false });
  } catch {
    /* 已存在时复用 */
  }
  w(rootB, "specs/x/requirements.md", "# Requirements: X 特性\n");
  const xTasks = ["# Implementation Plan: X", "", "- [ ] 1. 甲卡 <!-- zcode-board: no=9 -->", ""].join("\n");
  w(rootB, "specs/x/tasks.md", xTasks);
  const dupPlan = "docs/plans/plan-dup.md";
  const dupText = ["# 撞号计划", "<!-- zcode-board: no=9 -->", "- **T1 乙卡（草案）**：正文。 <!-- zcode-board: no=11 -->", ""].join("\n");
  w(rootB, dupPlan, dupText);
  w(rootB, ".zcode/board/scan.json", JSON.stringify({ includeDirs: ["docs/plans"] }, null, 2) + "\n"); // #72：opt-in 后 docs/plans 参与扫描
  const dupRegistry = JSON.stringify({ version: 1, seq: 11, entries: [
    { no: 9, kind: "spec", specRoot: "specs/x/", title: "X 特性", assignedAt: "2026-10-01T00:00:00+08:00" },
    { no: 11, kind: "task", file: dupPlan, title: "乙卡（草案）", assignedAt: "2026-10-02T00:00:00+08:00" },
  ] }, null, 2) + "\n";
  w(rootB, REGISTRY_REL, dupRegistry);

  const beforeB = treeSnapshot(rootB);
  const rB = runAssign(rootB);
  const afterB = treeSnapshot(rootB);
  c.exit(rB, 0, "部分 B：--assign 退出码 0");
  assertZeroSourceWrites(c, beforeB, afterB, "部分 B：同号双实体不改号、不改文件");
  c.eq(readText(rootB, REGISTRY_REL), dupRegistry, "部分 B：registry 逐字节不变（冲突未消化前不发新号、不改条目）");
  c.ok(rB.stderr.includes("9") && /重复/.test(rB.stderr), "部分 B：diagnostics 点名号 9 重复", truncate(rB.stderr, 300));
  c.eq(readText(rootB, dupPlan), dupText, "部分 B：后到文件标记未被改写（不静默纠正）");
  c.eq(readText(rootB, "specs/x/tasks.md"), xTasks, "部分 B：先扫者文件同样零改写");
  const boardB = rB.board;
  c.eq(nodeByNo(boardB, 9)?.kind, "spec", "部分 B：先扫者（spec x）保留号 9");
  c.eq(nodeByNo(boardB, 11)?.title, "乙卡（草案）", "部分 B：未冲突的既有号 11 照常上板");
  c.ok(!boardNos(boardB).includes(10), "部分 B：不为冲突实体另发新号");
  const dupFeature = featureByTitle(boardB, "撞号计划");
  c.ok(!Object.hasOwn(dupFeature ?? {}, "no") && !Object.hasOwn(dupFeature ?? {}, "label"), "部分 B：后到特性按未领号降级（no/label 双缺省）");
  c.ok(
    (boardB?.diagnostics ?? []).some((d) => d.message.includes("9") && d.message.includes("重复")),
    "部分 B：board diagnostics 记录冲突（--check 非零退出归 T10）",
    show(boardB?.diagnostics),
  );
  rmSync(rootB, { recursive: true, force: true });
});

// ---- 场景 33（后半）：苗圃 → docs/plans 迁移
test("33b", "场景 33 后半：苗圃稿迁至 docs/plans（opt-in 扫描面）→ registry 指向更新、号不变、板无重复节点", (c, root) => {
  const oldRel = ".zcode/plans/plan-mig.md";
  const newRel = "docs/plans/plan-mig.md";
  w(root, oldRel, ["# 迁移夹具", "", "- **T1 迁移条目（草案）**：正文。", ""].join("\n"));
  w(root, ".zcode/board/scan.json", JSON.stringify({ includeDirs: ["docs/plans"] }, null, 2) + "\n"); // #72：目标目录 opt-in（迁移映射与覆盖不弱化）

  const r1 = runAssign(root);
  c.exit(r1, 0, "首轮 --assign 退出码 0");
  c.eq(registryView(root).map((e) => e.no), [1, 2], "首轮领 1/2");
  c.eq(readRegistry(root)?.entries?.map((e) => e.file), [oldRel, oldRel], "首轮指向苗圃路径");

  // 迁移：文件移动（编排者动作；标记随文件走）
  const movedText = readText(root, oldRel);
  w(root, newRel, movedText);
  rmSync(join(root, oldRel), { force: true });

  const before = treeSnapshot(root);
  const r2 = runAssign(root);
  const after = treeSnapshot(root);
  c.exit(r2, 0, "迁移后 --assign 退出码 0");
  c.eq(registryView(root), [
    { no: 1, kind: "plan", file: newRel, title: "迁移夹具" },
    { no: 2, kind: "task", file: newRel, title: "迁移条目（草案）" },
  ], "registry 指向更新为新路径、号不变（1/2）");
  c.eq(readRegistry(root)?.seq, 2, "seq 不变（迁移不发新号）");
  c.eq(readText(root, newRel), movedText, "迁移后文件零改写（标记已随文件在）");
  assertWriteSurface(c, before, after, [], "迁移后 assign 只改 registry 指向（别无源改写）");

  const features = r2.board?.features ?? [];
  c.eq(features.length, 1, "板上无重复节点（迁移不新建特性）");
  c.eq([features[0]?.no, features[0]?.title], [1, "迁移夹具"], "节点号 1 不变");
  c.eq((features[0]?.tasks ?? []).map((t) => [t.no, t.label]), [[2, "1"]], "任务号 2、label 1（#46 A2 计划内序）");
  c.eq(
    (r2.board?.sources ?? []).filter((s) => s.kind === "plan").map((s) => s.path),
    [newRel],
    "sources[] 只含迁移后路径",
  );
});

// ---- 场景 35a：归档指向改写（勘误 10 第三种指向改写）
test("35a", "场景 35a：归档 → --assign 按三映射改写 registry 指向（号/assignedAt/seq 不变；无标记候选不改写）", (c, root) => {
  const ASSIGNED_AT = "2026-10-01T00:00:00+08:00";
  const zPlan = ".zcode/plans/plan-z.md";
  const dPlan = "docs/plans/plan-d.md";
  const nPlan = "docs/design-notes/plan-n.md";
  const badPlan = ".zcode/plans/plan-bad.md";
  const specTasks = "specs/feat/tasks.md";
  // 预发号夹具：全部标记/条目一致（不触发发号，只静候归档移动）
  w(root, zPlan, ["# 苗圃归档稿", "<!-- zcode-board: no=1 -->", "- **T1 甲（草案）**：正文。 <!-- zcode-board: no=2 -->", ""].join("\n"));
  w(root, dPlan, ["# docs 归档稿", "<!-- zcode-board: no=3 -->", "- **T1 乙（草案）**：正文。 <!-- zcode-board: no=4 -->", ""].join("\n"));
  w(root, nPlan, ["# design-notes 归档稿", "<!-- zcode-board: no=5 -->", "- **T1 丙（草案）**：正文。 <!-- zcode-board: no=6 -->", ""].join("\n"));
  w(root, "specs/feat/requirements.md", "# Requirements: 归档特性\n");
  w(root, specTasks, ["# Implementation Plan: 归档特性", "", "- [x] 1. 甲任务 <!-- zcode-board: no=8 -->", "- [x] 2. 乙任务 <!-- zcode-board: no=9 -->", ""].join("\n"));
  w(root, badPlan, ["# 无标记候选稿", "<!-- zcode-board: no=10 -->", ""].join("\n"));
  w(root, REGISTRY_REL, JSON.stringify({ version: 1, seq: 10, entries: [
    { no: 1, kind: "plan", file: zPlan, title: "苗圃归档稿", assignedAt: ASSIGNED_AT },
    { no: 2, kind: "task", file: zPlan, title: "甲（草案）", assignedAt: ASSIGNED_AT },
    { no: 3, kind: "plan", file: dPlan, title: "docs 归档稿", assignedAt: ASSIGNED_AT },
    { no: 4, kind: "task", file: dPlan, title: "乙（草案）", assignedAt: ASSIGNED_AT },
    { no: 5, kind: "plan", file: nPlan, title: "design-notes 归档稿", assignedAt: ASSIGNED_AT },
    { no: 6, kind: "task", file: nPlan, title: "丙（草案）", assignedAt: ASSIGNED_AT },
    { no: 7, kind: "spec", specRoot: "specs/feat/", title: "归档特性", assignedAt: ASSIGNED_AT },
    { no: 8, kind: "task", file: specTasks, title: "甲任务", assignedAt: ASSIGNED_AT },
    { no: 9, kind: "task", file: specTasks, title: "乙任务", assignedAt: ASSIGNED_AT },
    { no: 10, kind: "plan", file: badPlan, title: "无标记候选稿", assignedAt: ASSIGNED_AT },
  ] }, null, 2) + "\n");

  // 归档移动（编排者动作：只移动文件位置；标记随文件走）
  const move = (from, to) => {
    const text = readText(root, from);
    w(root, to, text);
    rmSync(join(root, from), { force: true });
  };
  move(zPlan, ".zcode/archive/plan-z.md");
  move(dPlan, "docs/archive/plans/plan-d.md");
  move(nPlan, "docs/archive/plans/plan-n.md");
  move(specTasks, "specs/archive/feat/tasks.md");
  move("specs/feat/requirements.md", "specs/archive/feat/requirements.md");
  rmSync(join(root, "specs/feat"), { recursive: true, force: true });
  // 诱饵：无标记候选（归档路径存在但缺号标记 → 不得改写）
  w(root, ".zcode/archive/plan-bad.md", ["# 无标记候选稿", "<!-- zcode-board: no=99 -->", ""].join("\n"));
  rmSync(join(root, badPlan), { force: true });

  const before = treeSnapshot(root);
  const res = runAssign(root);
  const after = treeSnapshot(root);
  c.exit(res, 0, "归档后 --assign 退出码 0");
  c.inc(res.stderr, "归档", "assign 诊断记录归档指向改写（不静默）");

  c.eq(readRegistry(root)?.seq, 10, "seq 不变（归档不改写号、不发新号）");
  c.eq(readRegistry(root)?.entries?.map((e) => e.no), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "全部条目号不变（归档不回收号）");
  c.eq(
    (readRegistry(root)?.entries ?? []).map((e) => ({ no: e.no, ref: e.specRoot ?? e.file })),
    [
      { no: 1, ref: ".zcode/archive/plan-z.md" },
      { no: 2, ref: ".zcode/archive/plan-z.md" },
      { no: 3, ref: "docs/archive/plans/plan-d.md" },
      { no: 4, ref: "docs/archive/plans/plan-d.md" },
      { no: 5, ref: "docs/archive/plans/plan-n.md" },
      { no: 6, ref: "docs/archive/plans/plan-n.md" },
      { no: 7, ref: "specs/archive/feat/" },
      { no: 8, ref: "specs/archive/feat/tasks.md" },
      { no: 9, ref: "specs/archive/feat/tasks.md" },
      { no: 10, ref: badPlan },
    ],
    "指向按勘误 10 三映射改写（.zcode/plans→.zcode/archive、docs/*→docs/archive/plans、specs/<f>→specs/archive/<f>）；无标记候选不改写",
  );
  c.eq(
    (readRegistry(root)?.entries ?? []).map((e) => e.assignedAt),
    Array(10).fill(ASSIGNED_AT),
    "assignedAt 逐条保留（改写只动指向）",
  );
  assertWriteSurface(c, before, after, [], "归档后 assign：被改写文件恰为白名单（源文件零改写）");

  const features = res.board?.features ?? [];
  c.eq(features, [], "归档特性从板上消失（无活节点）");
  c.eq(
    (res.board?.sources ?? []).filter((s) => s.kind === "spec").map((s) => s.root),
    [],
    "sources[] 不含 specs/archive/（归档不在扫描面）",
  );
  c.eq(
    (res.board?.sources ?? []).filter((s) => s.kind === "plan").map((s) => s.path),
    [],
    "sources[] 不含归档计划稿路径",
  );

  // 幂等：指向已在归档路径 → 二次 assign 零写入、registry 逐字节稳定
  const before2 = treeSnapshot(root);
  const registryText = readText(root, REGISTRY_REL);
  const res2 = runAssign(root);
  const after2 = treeSnapshot(root);
  c.exit(res2, 0, "二次 --assign 退出码 0");
  c.eq(readText(root, REGISTRY_REL), registryText, "二次 assign registry 逐字节不变（指向改写幂等）");
  assertZeroSourceWrites(c, before2, after2, "二次 assign 幂等");
});

// ---------------------------------------------------------------- 场景 36a（计划码）

/** 计划码形态（冻结）：4 位、首字符字母、其余大写字母数字。 */
const PLAN_CODE_RE = /^[A-Z][A-Z0-9]{3}$/;

function planCodeView(root) {
  const doc = readRegistry(root);
  if (!doc) return null;
  return (doc.entries ?? []).map((e) => ({
    no: e.no,
    kind: e.kind,
    title: e.title,
    ...(e.planCode != null ? { planCode: e.planCode } : {}),
  }));
}

function featurePlanCode(board, title) {
  return featureByTitle(board, title)?.planCode ?? null;
}

test("36a", "场景 36a：计划码（planCode）——派生分配 / 二次 assign 保留 / 手工指定 / 冲突顺延；全局序列号不含计划码", async (c, root) => {
  // 夹具：两份文件名可派生（末段 ui → UI01/UI02）+ 一份中文标题（哈希兜底 PLxx）
  const alpha = ".zcode/plans/plan-a-ui.md";
  const beta = ".zcode/plans/plan-b-ui.md";
  const gamma = ".zcode/plans/plan-后续期.md";
  w(root, alpha, ["# Alpha 计划", "", "- [ ] 甲一", "- [ ] 甲二", ""].join("\n"));
  w(root, beta, ["# Beta 计划", "", "- [ ] 乙一", ""].join("\n"));
  w(root, gamma, ["# 后续期路线（梦与远期）", "", "- [ ] 丙一", ""].join("\n"));

  // -- 部分 A：导出纯函数（派生规则直测；期望值为规则字面量，独立于实现）
  const compilerModule = await import("../compile-board.mjs");
  const derivePlanCode = compilerModule.derivePlanCode;
  c.ok(typeof derivePlanCode === "function", "部分 A：导出纯函数 derivePlanCode（计划码派生规则单点）");
  if (typeof derivePlanCode !== "function") return;
  c.eq(
    derivePlanCode({ file: ".zcode/plans/plan-zcode-ui.md", title: "ZCode 看板 UI", taken: new Set() }),
    "UI01",
    "部分 A：文件名末段 ui（<4 字符）→ UI + 序号 01",
  );
  c.eq(
    derivePlanCode({
      file: ".zcode/plans/plan-sess_e5545aac-beff-45c6-9654-46569478d90a.md",
      title: "预览通道（Preview Channel）实现方案 · v3",
      taken: new Set(),
    }),
    "PREV",
    "部分 A：文件名无词（会话 id）→ 标题首词 Preview 取前 4 字母",
  );
  const fallback = derivePlanCode({
    file: ".zcode/plans/plan-后续期.md",
    title: "后续期路线（梦与远期）",
    taken: new Set(),
  });
  c.regex(fallback, /^PL[0-9A-Z]{2}$/, "部分 A：无 ASCII 词 → PL + 两位哈希兜底");
  c.eq(
    derivePlanCode({ file: ".zcode/plans/plan-后续期.md", title: "后续期路线（梦与远期）", taken: new Set() }),
    fallback,
    "部分 A：派生确定性：同输入同输出（纯函数）",
  );
  c.eq(
    derivePlanCode({ file: ".zcode/plans/plan-a-ui.md", title: "Alpha 计划", taken: new Set(["UI01"]) }),
    "UI02",
    "部分 A：冲突顺延：短词码序号递增",
  );
  const takenPrev = derivePlanCode({
    file: ".zcode/plans/plan-sess_x.md",
    title: "Preview Channel",
    taken: new Set(["PREV"]),
  });
  c.regex(takenPrev, PLAN_CODE_RE, "部分 A：冲突顺延：4 字母码换用同形态新码");
  c.ok(takenPrev !== "PREV", "部分 A：冲突顺延：不得复用已占用的码", `实际 ${takenPrev}`);

  // -- 部分 B：首轮 assign 自动分配；计划码不占全局序列号
  const rA = runAssign(root);
  c.exit(rA, 0, "部分 B：--assign 退出码 0");
  c.eq(featurePlanCode(rA.board, "Alpha 计划"), "UI01", "部分 B：board 特性节点带派生计划码 UI01（确定性扫描序先到者）");
  c.eq(featurePlanCode(rA.board, "Beta 计划"), "UI02", "部分 B：同词冲突 → 顺延 UI02");
  c.regex(featurePlanCode(rA.board, "后续期路线（梦与远期）"), /^PL[0-9A-Z]{2}$/, "部分 B：中文标题计划码走哈希兜底");
  c.eq(readRegistry(root)?.seq, 7, "部分 B：全局序列号 = 3 计划 + 4 任务（计划码不消耗 seq）");
  c.eq(
    planCodeView(root)
      .filter((e) => e.kind === "plan")
      .map((e) => e.planCode)
      .filter(Boolean).length,
    3,
    "部分 B：registry 的 plan 条目各带 planCode",
  );
  c.eq(
    planCodeView(root)
      .filter((e) => e.kind === "task")
      .every((e) => !("planCode" in e)),
    true,
    "部分 B：task 条目不带 planCode（计划码是计划/特性层字段）",
  );
  const alphaFeature = featureByTitle(rA.board, "Alpha 计划");
  c.eq(
    (alphaFeature?.tasks ?? []).every((t) => !("planCode" in t)),
    true,
    "部分 B：任务卡不写 planCode 字段（UI 由所属特性取）",
  );
  c.inc(rA.md, "### UI01 · Alpha 计划", "部分 B：board.md 特性标题用计划码（显示层）");
  c.inc(rA.md, "UI01-1", "部分 B：board.md 任务编号 = 计划码-层级");

  // -- 部分 C：二次 assign 幂等（计划码不重分配、registry 逐字节稳定）
  const beforeC = treeSnapshot(root);
  const registryTextC = readText(root, REGISTRY_REL);
  const rC = runAssign(root);
  const afterC = treeSnapshot(root);
  c.exit(rC, 0, "部分 C：二次 --assign 退出码 0");
  c.eq(readText(root, REGISTRY_REL), registryTextC, "部分 C：registry 逐字节不变（计划码已存在 → 不重分配）");
  c.eq(featurePlanCode(rC.board, "Alpha 计划"), "UI01", "部分 C：board 计划码稳定");
  assertZeroSourceWrites(c, beforeC, afterC, "部分 C：二次 assign 零源写入");

  // -- 部分 D：手工指定（--plan-code）优先；坏码不采纳（diagnostics）
  const rootD = `${root}-manual`;
  mkdirSync(rootD, { recursive: false });
  w(rootD, alpha, ["# Alpha 计划", "", "- [ ] 甲一", ""].join("\n"));
  w(rootD, beta, ["# Beta 计划", "", "- [ ] 乙一", ""].join("\n"));
  const rD = runCompiler(rootD, ["--assign", "--plan-code", ".zcode/plans/plan-b-ui.md=BETA"]);
  c.exit(rD, 0, "部分 D：--plan-code 退出码 0");
  c.eq(featurePlanCode(rD.board, "Beta 计划"), "BETA", "部分 D：手工码生效（registry + board）");
  c.eq(featurePlanCode(rD.board, "Alpha 计划"), "UI01", "部分 D：未指定的计划照常自动分配");
  const rD2 = runCompiler(rootD, ["--assign", "--plan-code", ".zcode/plans/plan-b-ui.md=beta"]);
  c.exit(rD2, 0, "部分 D：坏码（小写）不阻断 assign");
  c.inc(rD2.stderr, "plan-code", "部分 D：坏码 diagnostics 点名（不静默）");
  c.eq(featurePlanCode(rD2.board, "Beta 计划"), "BETA", "部分 D：坏码被拒后保留既有码（不覆写、不重分配）");
  rmSync(rootD, { recursive: true, force: true });

  // -- 部分 E：手工码与自动分配冲突 → 手工码被拒 + diagnostics，自动路径照常
  const rootE = `${root}-conflict`;
  mkdirSync(rootE, { recursive: false });
  w(rootE, alpha, ["# Alpha 计划", "", "- [ ] 甲一", ""].join("\n"));
  w(rootE, beta, ["# Beta 计划", "", "- [ ] 乙一", ""].join("\n"));
  const rE = runCompiler(rootE, ["--assign", "--plan-code", ".zcode/plans/plan-b-ui.md=UI01"]);
  c.exit(rE, 0, "部分 E：冲突手工码退出码 0");
  c.inc(rE.stderr, "UI01", "部分 E：冲突 diagnostics 点名码 UI01（不静默）");
  c.eq(featurePlanCode(rE.board, "Alpha 计划"), "UI01", "部分 E：先到者（自动分配）保留 UI01");
  c.eq(featurePlanCode(rE.board, "Beta 计划"), "UI02", "部分 E：后被拒者走自动顺延 UI02");
  rmSync(rootE, { recursive: true, force: true });
});

// ---- #72：扫描面配置化下的 --assign 行为（默认不吸 docs 计划目录；>10 未领号拒绝）

test("72f", "#72：无 scan.json 时 --assign 不改写 docs/plans、docs/design-notes 计划文件（零盖号、零 registry 条目）", (c, root) => {
  const keepRel = ".zcode/plans/plan-keep.md";
  const keepText = ["# 苗圃稿", "", "- **T1 苗圃条目（草案）**：正文。", ""].join("\n");
  const oldText = ["# 旧票计划", "", "- **T1 旧计划条目（草案）**：正文。", ""].join("\n");
  const notes = [];
  w(root, keepRel, keepText);
  w(root, "docs/plans/plan-old.md", oldText);
  for (let i = 0; i < 4; i += 1) {
    const rel = `docs/design-notes/note-${i}.md`;
    const text = [`# 历史档 ${i}`, "", "- [ ] 1. 历史条目", "  - Scope: 历史细节。", ""].join("\n");
    w(root, rel, text);
    notes.push({ rel, text });
  }

  const before = treeSnapshot(root);
  const res = runAssign(root);
  const after = treeSnapshot(root);
  c.exit(res, 0, "默认扫描面下 --assign 退出码 0（无批量改写风险）");
  c.eq(readText(root, "docs/plans/plan-old.md"), oldText, "docs/plans 文件零改写（字节不变）");
  c.eq(
    notes.map((n) => readText(root, n.rel)),
    notes.map((n) => n.text),
    "docs/design-notes 文件逐字节不变（零盖号）",
  );
  c.eq(
    readText(root, keepRel),
    expectedAssign(keepText, { headerNo: 1, lineNos: [{ lineIndex: lineIndexOf(keepText, "**T1 苗圃条目（草案）**"), no: 2 }] }),
    "苗圃稿照常领号（收窄不误伤默认扫描面）",
  );
  assertWriteSurface(c, before, after, [keepRel], "写入面仅苗圃稿（docs 计划文件零触碰）");
  c.eq(
    registryView(root).map((e) => e.file),
    [keepRel, keepRel],
    "registry 仅苗圃条目（不为 docs 计划文件建条目）",
  );
  c.eq(
    (res.board?.sources ?? []).filter((s) => s.kind === "plan").map((s) => s.path),
    [keepRel],
    "板上计划源仅苗圃（docs 两目录零吸入）",
  );
});

test("72g", "#72：--assign 单次发现 >10 个未领号计划文件 → 拒绝执行（列清单+建议、零写入）；--force 放行并留诊断痕迹；恰 10 个放行", (c, root) => {
  w(root, ".zcode/board/scan.json", JSON.stringify({ includeDirs: ["docs/plans"] }, null, 2) + "\n");
  const keepRel = ".zcode/plans/plan-k0.md";
  w(root, keepRel, ["# 苗圃稿", "", "- **T1 苗圃条目（草案）**：正文。", ""].join("\n"));
  for (let i = 0; i < 10; i += 1) {
    w(root, `docs/plans/plan-b${i}.md`, [`# 批量稿 ${i}`, "", `- **T1 批量条目 ${i}（草案）**：正文。`, ""].join("\n"));
  }

  const before = treeSnapshot(root);
  const res = runAssign(root);
  const after = treeSnapshot(root);
  c.exit(res, 1, "11 个未领号计划文件（>10）→ 拒绝执行（退出码 1）");
  c.inc(res.stderr, "11", "诊断点名发现数量 11");
  c.inc(res.stderr, "未领号计划文件", "诊断点名「未领号计划文件」判据");
  c.inc(res.stderr, "核查扫描面", "建议含「核查扫描面」");
  c.inc(res.stderr, "拆分登记", "建议含「拆分登记」");
  c.inc(res.stderr, "plan-k0.md", "清单点名列全（苗圃稿）");
  c.inc(res.stderr, "plan-b0.md", "清单点名列全（批量稿首）");
  c.inc(res.stderr, "plan-b9.md", "清单点名列全（批量稿末）");
  c.inc(res.stderr, "--force", "诊断写明 --force 方可继续");
  assertZeroSourceWrites(c, before, after, "拒绝执行：零写入（源 + registry + 板）");
  c.eq(readRegistry(root), null, "registry 未写（不存在）");
  c.ok(!isFile(join(root, BOARD_REL)), "board 未生成（拒绝即无产物）");
  c.eq(readText(root, keepRel).includes("zcode-board: no="), false, "苗圃稿未被盖号（拒绝不部分执行）");

  // --force 放行：继续发号（11 文件 × 2 号 = 22 条活号），并留诊断痕迹
  const forced = runCompiler(root, ["--assign", "--force"]);
  c.exit(forced, 0, "--force 放行退出码 0");
  c.inc(forced.stderr, "--force", "--force 留诊断痕迹（点名 --force 放行）");
  c.inc(forced.stderr, "11", "--force 留痕含放行数量 11");
  c.inc(forced.stderr, "核查扫描面", "--force 留痕仍带核查建议（痕迹完整）");
  c.eq(readRegistry(root)?.seq, 22, "放行后 seq=22（11 文件 × 2 号）");
  c.eq(readRegistry(root)?.entries?.length, 22, "放行后 registry 22 条目");
  c.eq(boardNos(forced.board).length, 22, "板 22 个活号（苗圃 + 批量各号）");
  c.inc(readText(root, "docs/plans/plan-b9.md"), "zcode-board: no=", "批量稿已盖号（--force 后照常改写）");

  // 边界：恰 10 个未领号计划文件 → 无需 --force 放行（阈值判据 >10）
  const rootB = `${root}-ten`;
  mkdirSync(rootB, { recursive: false });
  w(rootB, ".zcode/board/scan.json", JSON.stringify({ includeDirs: ["docs/plans"] }, null, 2) + "\n");
  for (let i = 0; i < 10; i += 1) {
    w(rootB, `docs/plans/plan-t${i}.md`, [`# 十份稿 ${i}`, "", "- [ ] 1. 条目", ""].join("\n"));
  }
  const rB = runAssign(rootB);
  c.exit(rB, 0, "恰 10 个未领号计划文件 → 放行（阈值 >10）");
  c.eq(readRegistry(rootB)?.entries?.length, 20, "十份稿各领特性号 + 任务号（20 条目）");
  rmSync(rootB, { recursive: true, force: true });
});

test("72r", "#72：远端复现（副本域）——296 份 docs/design-notes 活历史档：默认编译 0 吸入、--assign 0 改写；opt-in 后 >10 闸拦截", (c, root) => {
  const REPRO_COUNT = 296;
  for (let i = 0; i < REPRO_COUNT; i += 1) {
    w(
      root,
      `docs/design-notes/design-${String(i).padStart(3, "0")}.md`,
      [`# 历史设计档 ${i}`, "", "- [ ] 1. 历史事项", "  - Scope: 活历史档正文。", ""].join("\n"),
    );
  }
  const keepRel = ".zcode/plans/plan-keep.md";
  w(root, keepRel, ["# 苗圃稿", "", "- **T1 苗圃条目（草案）**：正文。", ""].join("\n"));

  const r1 = runCompiler(root);
  c.exit(r1, 0, "默认编译退出码 0");
  c.eq((r1.board?.features ?? []).length, 1, "板上 1 个特性（仅苗圃稿）");
  c.eq(
    (r1.board?.features ?? []).filter((f) => String(f.title).includes("历史设计档")).length,
    0,
    "默认编译：0 特性来自 docs/design-notes（296 档零吸入）",
  );
  c.eq(
    (r1.board?.sources ?? []).filter((s) => s.kind === "plan").map((s) => s.path),
    [keepRel],
    "sources[] 计划源仅苗圃稿",
  );

  const snapAfterCompile = treeSnapshot(root);
  const r2 = runAssign(root);
  c.exit(r2, 0, "默认扫描面下 --assign 退出码 0");
  const diff2 = diffSnapshot(snapAfterCompile, treeSnapshot(root), [BOARD_REL, ".zcode/board/board.md", REGISTRY_REL]);
  c.eq(
    diff2.changed.map((x) => x.rel).filter((rel) => rel.startsWith("docs/design-notes/")),
    [],
    "--assign 对 296 档 0 改写（字节与 mtime 均不变）",
  );
  c.eq(registryView(root).map((e) => e.file), [keepRel, keepRel], "registry 仅苗圃条目（296 档零条目）");

  // opt-in 后：>10 闸拦截（296 档全部未领号 → 拒绝，零改写；--preflight/#73 落地前的机械防线）
  w(root, ".zcode/board/scan.json", JSON.stringify({ includeDirs: ["docs/design-notes"] }, null, 2) + "\n");
  const before3 = treeSnapshot(root);
  const r3 = runAssign(root);
  const after3 = treeSnapshot(root);
  c.exit(r3, 1, "opt-in 后 296 个未领号计划文件 → 闸拦截（退出码 1）");
  c.inc(r3.stderr, "296", "拦截诊断点名 296");
  c.inc(r3.stderr, "design-000.md", "清单含首档");
  c.inc(r3.stderr, "design-295.md", "清单含末档");
  assertZeroSourceWrites(c, before3, after3, "拦截后 296 档零改写（scan.json 亦零触碰）");
  c.eq(registryView(root).map((e) => e.file), [keepRel, keepRel], "registry 未被批量污染（仍仅苗圃条目）");
});

// ---------------------------------------------------------------- 主流程

async function main(argv) {
  const onlyIdx = argv.indexOf("--only");
  const only = onlyIdx >= 0 ? new Set(String(argv[onlyIdx + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) : null;
  const clean = argv.includes("--clean");

  say("zcode-board · T9 场景断言（--assign 发号；测试先行：红 → 绿）");
  say(`node      : ${process.version}`);
  say(`assets    : ${ASSETS_DIR}`);
  say(`编译器     : ${COMPILER}（存在：${isFile(COMPILER)}）`);
  say(`断言脚本   : ${toPosix(fileURLToPath(import.meta.url))}`);
  say(`场景      : ${only ? [...only].join(",") : "全部"}`);

  for (const t of TESTS) {
    if (only && !only.has(t.id)) continue;
    say("");
    say(`== T9 场景 ${t.id}：${t.title} ==`);
    const root = newRoot(`t9-${t.id}`);
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
  if (failedTests.size > 0) say(`失败场景：${[...failedTests].sort().join(", ")}`);
  else say("全部场景通过（0 失败）");
  return failCount === 0 ? 0 : 1;
}

process.exit(await main(process.argv.slice(2)));
