#!/usr/bin/env node
/**
 * zcode-board / 反向断言（夹具有效性自证：T6 骨架 + T7 派生层 + T9 发号）
 *
 * 做法：把待突变域（`--source`，缺省 assets/）**整树快照进 mktemp 副本域**，每个突变在副本域里
 * 复制一份快照再施加一处**语义突变**，跑指定场景；若突变未被任何断言捕获（全绿），说明夹具/断言
 * 对该行为不敏感 → 判为失败。真实交付物与真实板一律只读。
 *
 * 副本域口径（V24：T57v §11「变异窗口撞并发重编译」事故后成文，本工具机械化）：
 *   - 默认即副本域：整轮共用**一个冻结快照**（快照前后指纹互证 ≥3 次）——源域在复制窗口内被并发
 *     改写（半写态）时拒跑（exit 2），不把撕裂态当验证对象；并行卡的半写态也不再污染本轮结果；
 *   - 误用活板域被拦（fail-closed，exit 2）：`--source` 指向活板域/持板域者、副本域落点在源域
 *     或活板域内 → 拒跑，零写入；
 *   - `--guard-board <板根|板目录>`：真实板面文件窗口前后 sha256 断言，变化即失败（exit 3）。
 *
 * 每个突变自带"锚点必须命中"检查，防止重构后突变静默失效。
 *
 * 用法：node assets/test/run-mutations.mjs [--list] [--source <dir>] [--guard-board <dir>] [--keep]
 * 退出码：0 = 全部突变都被捕获；1 = 有突变未被捕获 / 锚点失配；2 = 域守卫拒跑或输入非法；
 *         3 = 受护真实板在窗口内发生变化。
 */

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

import { ASSETS_DIR } from "./fixtures/build-fixture.mjs";

const COMPILER = "compile-board.mjs";
const LIB = "lib/board-io.mjs";
const DERIVE = "lib/derive.mjs";
/** #56 事实互证不变量 + #97 第五不变量（--check 的机械防线）。 */
const FIXTURE_INVARIANTS = "lib/fact-invariants.mjs";
/** #72 扫描面配置解析（默认收窄 / opt-in 池 / excludeGlobs / 兜底）。 */
const SCAN_CONFIG = "lib/scan-config.mjs";

const USAGE =
  "用法：node assets/test/run-mutations.mjs [--list] [--source <dir>] [--guard-board <dir>] [--keep]";

/** 快照取一致的最多尝试次数（源域被并发半写时退让重试，超限拒跑）。 */
const SNAPSHOT_ATTEMPTS = 3;

// ---------------------------------------------------------------- 副本域（V24）

/** 目录是否为板目录本体（board.json + board.md 同在）。 */
function isBoardDir(dir) {
  return existsSync(join(dir, "board.json")) && existsSync(join(dir, "board.md"));
}

/** 目录自身是否持有板域（板目录本体，或含 `.zcode/board/`）——源域误用判据。 */
function holdsBoardDomain(dir) {
  return isBoardDir(dir) || existsSync(join(dir, ".zcode", "board"));
}

/** 自身上溯：返回首个持板域的祖先（找不到 → null）——副本域落点判据。 */
function boardDomainAncestor(dir) {
  let cur = resolve(dir);
  for (;;) {
    if (holdsBoardDomain(cur)) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** child 是否位于 parent 之内（含相等）；只比较 resolve 后路径，不做符号链接归一。 */
function isInside(parent, child) {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 域内全部条目（相对路径 + 内容摘要；符号链接记目标文本）。 */
function collectFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const e of entries) {
      const abs = join(dir, e.name);
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isSymbolicLink()) out.push({ rel: r, kind: "link", digest: readlinkSync(abs) });
      else if (e.isFile()) out.push({ rel: r, kind: "file", digest: sha256File(abs) });
    }
  };
  walk(root, "");
  return out;
}

/** 域指纹：文件清单（路径 + 内容摘要）整体哈希。 */
function fingerprintDomain(root) {
  const files = collectFiles(root);
  const h = createHash("sha256");
  for (const f of files) h.update(`${f.rel}\0${f.kind}\0${f.digest}\n`);
  return { hash: h.digest("hex"), count: files.length, files };
}

/** 两份文件清单的路径级差异。 */
function diffFileLists(before, after) {
  const b = new Map(before.map((f) => [f.rel, f.digest]));
  const a = new Map(after.map((f) => [f.rel, f.digest]));
  const changed = [];
  const added = [];
  const removed = [];
  for (const [rel, v] of a) {
    if (!b.has(rel)) added.push(rel);
    else if (b.get(rel) !== v) changed.push(rel);
  }
  for (const rel of b.keys()) if (!a.has(rel)) removed.push(rel);
  return { changed, added, removed, total: changed.length + added.length + removed.length };
}

/** 板面文件（板目录一层，非递归；evidence/ 等高频面不入断言）指纹。 */
function fingerprintBoardSurface(boardDir) {
  const files = [];
  const entries = readdirSync(boardDir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const e of entries) {
    if (!e.isFile()) continue;
    files.push({ rel: e.name, digest: sha256File(join(boardDir, e.name)) });
  }
  const h = createHash("sha256");
  for (const f of files) h.update(`${f.rel}\0${f.digest}\n`);
  return { hash: h.digest("hex"), count: files.length, files };
}

/** 板根（含 `.zcode/board/`）/ 板目录两形态 → 板面文件所在目录。 */
function resolveBoardDir(p) {
  const abs = resolve(p);
  return existsSync(join(abs, ".zcode", "board")) ? join(abs, ".zcode", "board") : abs;
}

/**
 * 源域与落点守卫（fail-closed；V24：突变/篡改验证一律副本域）。
 * 返回 null = 放行；否则返回拒跑文案（逐条）。
 */
function domainGuardFailures(source, tempBase) {
  const problems = [];
  if (holdsBoardDomain(source)) {
    problems.push(
      `--source 指向活板域或其父域（检出板域：${source}）——突变验证一律副本域（V24），请对副本执行`,
    );
  }
  if (isInside(source, tempBase)) {
    problems.push(
      `系统临时目录落在源域内（tmpdir=${resolve(tempBase)}，源域=${resolve(source)}）——副本域必须与源域分离，否则突变落进待突变树`,
    );
  }
  const ancestor = boardDomainAncestor(tempBase);
  if (ancestor != null) {
    problems.push(`系统临时目录落在活板域内（${ancestor}）——副本域不得落进活板域（真实板零污染）`);
  }
  return problems.length > 0 ? problems : null;
}

/** 快照：复制源域 → 副本域，前后指纹互证（撕裂即重试；超限 → null，调用侧拒跑）。 */
function snapshotDomain(source, dest, attempts = SNAPSHOT_ATTEMPTS) {
  for (let i = 1; i <= attempts; i += 1) {
    rmSync(dest, { recursive: true, force: true });
    cpSync(source, dest, { recursive: true });
    const from = fingerprintDomain(source);
    const copy = fingerprintDomain(dest);
    if (from.hash === copy.hash) return { ...copy, sourceHash: from.hash, attempts: i };
  }
  return null;
}

/**
 * 缺值标志 fail-closed（B6 回炉轮 STD-1，2026-10-11）：尾随缺值（undefined）或以 `--` 开头 →
 * 记 error（exit 2）。修复原因：原 `argv[i + 1] ?? null` 使 `--source` 尾随缺值静默回落默认
 * 源域照跑整轮、`--guard-board` 尾随缺值静默关闭板面断言——与同批三工具口径不一致
 * （build-dispatch-prompt.mjs:106 / create-worktree.mjs:76 / baseline-redlist.mjs:78 的
 * `die("选项 X 缺少取值")`），且违反本工具 fail-closed 自我定位（#126/V24）。
 */
function takeValue(argv, i, name, errors) {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) {
    errors.push(`选项 ${name} 缺少取值（${USAGE}）`);
    return null;
  }
  return v;
}

function parseArgs(argv) {
  const opts = { list: false, help: false, keep: false, source: null, guardBoard: null, errors: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--list") opts.list = true;
    else if (a === "--keep") opts.keep = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--source") {
      opts.source = takeValue(argv, i, a, opts.errors);
      i += 1;
    } else if (a === "--guard-board") {
      opts.guardBoard = takeValue(argv, i, a, opts.errors);
      i += 1;
    } else opts.errors.push(`未知参数：${a}（${USAGE}）`);
  }
  return opts;
}

function mutate(src, from, to, label) {
  if (!src.includes(from)) {
    throw new Error(`突变锚点未命中（${label}）：${from.slice(0, 60)}…`);
  }
  return src.replace(from, to);
}

/** 每个突变：改什么、期望被哪个场景的哪条断言咬住。 */
const MUTATIONS = [
  {
    name: "m1-lenient-handle",
    file: LIB,
    scenario: "21",
    expect: "blocked-by 句柄过度宽松（任意数字形态都当句柄）必须被拒收断言咬住",
    apply: (src) =>
      mutate(src, "return /^[1-9][0-9]*$/.test(s) ? Number(s) : null;", "return /^[0-9]/.test(s) ? Number(s) : null;", "m1"),
  },
  {
    name: "m1b-handle-coerced",
    file: LIB,
    scenario: "21",
    expect: "把层级标签 1.2 强转成整数 1（静默改写）必须被咬住",
    apply: (src) =>
      mutate(
        src,
        "return /^[1-9][0-9]*$/.test(s) ? Number(s) : null;",
        "return /^[1-9]/.test(s) ? Math.trunc(Number(s)) : null;",
        "m1b",
      ),
  },
  {
    name: "m2-title-unsanitized",
    scenario: "33,15",
    expect: "title 未剥离作者前缀必须被 title 断言咬住",
    apply: (src) => mutate(src, "  out.title = node.title;", '  out.title = "T0 " + node.title;', "m2"),
  },
  {
    name: "m3-scan-docs-root",
    file: SCAN_CONFIG,
    scenario: "33",
    expect: "默认扫描面被放宽到 docs/ 根目录（阴沟扫）必须被 sources 顺序与诱饵断言咬住",
    apply: (src) =>
      mutate(
        src,
        'export const DEFAULT_PLAN_DIRS = Object.freeze([".zcode/plans"]);',
        'export const DEFAULT_PLAN_DIRS = Object.freeze([".zcode/plans", "docs"]);',
        "m3",
      ),
  },
  {
    name: "m4-no-unnumbered-diag",
    scenario: "4,16",
    expect: "未领号提示静默必须被 diagnostics 断言咬住",
    apply: (src) =>
      mutate(
        mutate(src, "    if (meta.no == null) {", "    if (false) {", "m4a"),
        "      if (tm.no == null) {",
        "      if (false) {",
        "m4b",
      ),
  },
  {
    name: "m5-source-rewrite",
    scenario: "33",
    expect: "编译期改写源文件（字节相同但 mtime 变化）必须被检查点 3 咬住",
    apply: (src) =>
      mutate(
        src,
        "  const read = readTextFile(plan.abs);",
        "  const read = readTextFile(plan.abs);\n  if (read.ok) writeFileAtomic(plan.abs, read.text);",
        "m5",
      ),
  },
  {
    name: "m6-no-dedupe",
    scenario: "19h",
    expect: "重复号不去重（活号不唯一）必须被 19h 断言咬住",
    apply: (src) => mutate(src, "    if (claimed.has(no)) {", "    if (false) {", "m6"),
  },
  {
    name: "m7-wallclock-node-ts",
    scenario: "8",
    expect: "节点时间戳改取墙钟（非源 mtime）必须被幂等/真值断言咬住",
    apply: (src) => mutate(src, "  const mtime = mtimeIso(plan.abs);", "  const mtime = nowIso();", "m7"),
  },
  {
    name: "m8-no-progress-summary",
    scenario: "17",
    expect: "progress 汇总丢失必须被 progress 断言咬住",
    apply: (src) => mutate(src, "  const execution = progressData?.execution;", "  const execution = null;", "m8"),
  },
  {
    name: "m9-attention-summary-zero",
    scenario: "2,stage",
    expect: "attentionSummary 恒为零（缺口计数丢失）必须被逐码计数断言咬住",
    apply: (src) =>
      mutate(
        src,
        "    attentionSummary: summarizeAttention(finalizedFeatures),",
        '    attentionSummary: { interviewedNotArranged: 0, arrangedNotExpanded: 0, interruptedResume: 0, unmergedWorktree: 0 },',
        "m9",
      ),
  },
  {
    name: "m10-stage-ignores-active-run",
    file: DERIVE,
    scenario: "stage",
    expect: "段位忽略 activeRun（执行中/审核中不可达）必须被段位表断言咬住",
    apply: (src) => mutate(src, "  if (JUDGING_ROLES.includes(role)) {", "  if (false) {", "m10"),
  },
  {
    name: "m11-stage-role-mismatch",
    file: DERIVE,
    scenario: "stage",
    expect: "角色错配（integrator 当判断角色 → 错配进审核中）必须被反向断言咬住",
    apply: (src) =>
      mutate(
        src,
        'export const JUDGING_ROLES = Object.freeze(["test-verifier", "code-reviewer"]);',
        'export const JUDGING_ROLES = Object.freeze(["test-verifier", "code-reviewer", "integrator"]);',
        "m11",
      ),
  },
  {
    name: "m12-overgrown-threshold-inclusive",
    file: DERIVE,
    scenario: "32",
    expect: "阈值改为含等号（恰 60 卡也提示）必须被边界断言咬住",
    apply: (src) => mutate(src, "cardCount <= threshold", "cardCount < threshold", "m12"),
  },
  {
    name: "m13-worktree-crosscheck-off",
    file: DERIVE,
    scenario: "25",
    expect: "worktree 目录互证诊断关闭（目录在而板上无据不点名）必须被点名断言咬住",
    apply: (src) => mutate(src, "  const dirNames = new Set(existingDirs ?? []);", "  const dirNames = new Set();", "m13"),
  },
  {
    name: "m14-worktree-shape-passthrough",
    file: DERIVE,
    scenario: "derive-lib",
    expect: "worktree 形态违规照抄（产出 schema 非法路径）必须被归一层断言咬住",
    apply: (src) =>
      mutate(
        src,
        "      worktree: worktreeParsed != null ? rawWorktree : null,",
        "      worktree: rawWorktree,",
        "m14",
      ),
  },
  {
    name: "m15-pr-url-unchecked",
    file: DERIVE,
    scenario: "derive-lib",
    expect: "pr url 形态不校验（产出 schema 非法 url）必须被归一层断言咬住",
    apply: (src) =>
      mutate(
        src,
        '  if (typeof raw.url !== "string" || !/^https?:\\/\\/.+/.test(raw.url)) return null;',
        '  if (typeof raw.url !== "string") return null;',
        "m15",
      ),
  },
  {
    name: "m16-assign-no-line-marker",
    script: "run-t9-scenarios.mjs",
    scenario: "3",
    expect: "发号不写条目行尾标记（只写文件头）必须被逐字节期望断言咬住",
    apply: (src) =>
      mutate(src, "    else bucket.lineMarkerNos.push({ lineIndex: t.lineIndex, no: t.no });", "    else { /* 突变：不写行尾标记 */ }", "m16"),
  },
  {
    name: "m17-assign-conflict-silent",
    script: "run-t9-scenarios.mjs",
    scenario: "19",
    expect: "号码冲突不点名不降级（静默采纳撞号）必须被冲突断言咬住",
    apply: (src) =>
      mutate(
        src,
        [
          "    const who = holder ?? `${targetRef(t)}（源头标记）`;",
          "    if (claimed.has(no)) {",
        ].join("\n"),
        ["    const who = holder ?? `${targetRef(t)}（源头标记）`;", "    if (false) {"].join("\n"),
        "m17",
      ),
  },
  {
    name: "m18-assign-pointer-frozen",
    script: "run-t9-scenarios.mjs",
    scenario: "33b",
    expect: "迁移后 registry 指向不更新（号与路径脱钩）必须被指向更新断言咬住",
    apply: (src) =>
      mutate(src, "      if (existing.file !== t.file) existing.file = t.file;", "      /* 突变：指向不更新 */;", "m18"),
  },
  {
    name: "m19-continuation-not-suppressed",
    script: "run-t9-scenarios.mjs",
    scenario: "22",
    expect: "计划→spec 延续后计划节点不退役（板上双节点/重号）必须被场景 22 断言咬住",
    apply: (src) =>
      mutate(
        src,
        "  if (superseded.size === 0) return features;\n  return features.filter((f) => !superseded.has(META(f).sourcePath));",
        "  if (superseded.size === 0) return features;\n  return features;",
        "m19",
      ),
  },
  {
    name: "m20-assign-highwater-ignores-markers",
    script: "run-t9-scenarios.mjs",
    scenario: "20",
    expect: "高水位忽略活标记（seq 落后 → 复用已发号）必须被采纳/前进断言咬住",
    apply: (src) =>
      mutate(
        src,
        "    if (Number.isInteger(t.markerNo) && t.markerNo > 0) seq = Math.max(seq, t.markerNo);",
        "    if (false) seq = Math.max(seq, 0);",
        "m20",
      ),
  },
  {
    name: "m21-unmerged-without-fs-corroboration",
    file: DERIVE,
    scenario: "42",
    expect: "unmerged-worktree 去掉 fs 互证（字段命中即触发 → 幽灵工作树误报）必须被场景 42 断言咬住",
    apply: (src) =>
      mutate(
        src,
        "  const resolvedWorktree = declared != null ? resolveWorktree(declared, existingWorktrees) : null;\n  const unmerged = resolvedWorktree != null;",
        "  const resolvedWorktree = declared;\n  const unmerged = declared != null;",
        "m21",
      ),
  },
  {
    name: "m22-runs-auto-derive-worktree",
    file: "lib/runs.mjs",
    script: "run-t8-scenarios.mjs",
    scenario: "C1",
    expect: "恢复「恰一卡自动推导 task-<no>」（幽灵工作树回归）必须被 C1 逐字段与 diagnostics 断言咬住",
    apply: (src) =>
      mutate(
        src,
        '    diag(diagnostics, "run_event 未声明工作树/分支（缺省位一律 null，不按卡号推导执行现场）。");',
        "    if (cards.length === 1) { worktree = `.zcode/worktrees/task-${cards[0]}`; branch = `task-${cards[0]}`; }",
        "m22",
      ),
  },
  {
    name: "m23-nolabel-assertion-off",
    file: "lib/schema-check.mjs",
    script: "run-t10-scenarios.mjs",
    scenario: "43",
    expect: "no/label 共存在断言整体关掉（放宽成免检而非「仅未领号特性下豁免」）必须被 43 反向夹具咬住",
    apply: (src) => mutate(src, "    if (hasNo !== hasLabel && !(ownerUnnumbered && hasNo && !hasLabel)) {", "    if (false) {", "m23"),
  },
  {
    name: "m24-transitional-phantom-label",
    script: "run-t10-scenarios.mjs",
    scenario: "43",
    expect: "未领号特性下带号卡留 undefined label 形参位（序列化丢键 → 板/源互检误报 + 结构误判）必须被 43 过渡态夹具咬住",
    apply: (src) => mutate(src, "    if (meta.label !== undefined) out.label = meta.label;", "    out.label = meta.label;", "m24"),
  },
  {
    name: "m25-transitional-id-undefined",
    script: "run-t10-scenarios.mjs",
    scenario: "44",
    expect: "过渡态带号卡渲染回退 ID-<label>（label 缺省即 ID-undefined）必须被 44 的降级渲染断言咬住",
    apply: (src) => mutate(src, "  if (node.label == null) return `#${node.no}`;", "  if (false) return `#${node.no}`;", "m25"),
  },
  {
    name: "m26-invariant-a-off",
    file: FIXTURE_INVARIANTS,
    scenario: "56a",
    expect: "子卡全完成→已完成 判据关掉（全完成仍显示执行中）必须被 56a 的假板断言咬住",
    apply: (src) => mutate(src, "    if (f.stage !== DONE_STAGE) {", "    if (false) {", "m26"),
  },
  {
    name: "m27-invariant-b-off",
    file: FIXTURE_INVARIANTS,
    scenario: "56b",
    expect: "有卡不得挂未拆解 判据关掉（有卡挂 arranged-not-expanded 静默）必须被 56b 的假板断言咬住",
    apply: (src) => mutate(src, "    if ((f.attention ?? []).includes(ARRANGED_NOT_EXPANDED)) {", "    if (false) {", "m27"),
  },
  {
    name: "m28-invariant-c-off",
    file: FIXTURE_INVARIANTS,
    scenario: "56c",
    expect: "board.md 编号形态互证关掉（嵌套行回落 ID-<层级> 不报、板仍退 0）必须被 56c 的假板断言咬住",
    apply: (src) => mutate(src, '  if (typeof boardMd === "string" && boardMd !== "") {', "  if (false) {", "m28"),
  },
  {
    name: "m29-invariant-d-off",
    file: FIXTURE_INVARIANTS,
    scenario: "56d",
    expect: "段位计数复算关掉（stageSummary 携带错值不报）必须被 56d 的假板断言咬住",
    apply: (src) => mutate(src, "        if (carried[s] !== recomputed[s]) {", "        if (false) {", "m29"),
  },
  {
    name: "m30-invariant-a-roadmap-false-positive",
    file: FIXTURE_INVARIANTS,
    scenario: "56b",
    expect: "roadmap 压制段位豁免被去掉（占位稿全完成被误判「应已完成」）必须被 56b 的零噪声断言咬住",
    apply: (src) => mutate(src, "    if (f.roadmap === true) return; // roadmap 占位稿段位被压制（本稿条目本身不执行；#66 起 cancelled 终态例外——照常\"已取消\"，本判据只查完成汇总故跳过）", "    if (false) return;", "m30"),
  },
  {
    name: "m31-entry-guard-symlink-blind",
    scenario: "69",
    expect: "入口守卫退回 resolve() 直比（含符号链接成分的调用路径下 import.meta.url 取 realpath → 不等 → 静默 no-op）必须被 69 的符号链接调用断言咬住",
    apply: (src) =>
      mutate(
        src,
        'if (invokedPath !== "" && sameRealFile(invokedPath, fileURLToPath(import.meta.url))) {',
        'if (invokedPath !== "" && invokedPath === fileURLToPath(import.meta.url)) {',
        "m31",
      ),
  },
  {
    name: "m32-worktree-subdir-loose",
    file: DERIVE,
    scenario: "derive-lib",
    expect: "嵌套形态子目录段放宽（隐藏目录/穿越 .. 也进接受集）必须被归一层拒收断言咬住",
    apply: (src) =>
      mutate(src, "export const WORKTREE_PATH_RE = /^(?:([^/.][^/]*)\\/)?\\.zcode\\/worktrees\\/task-([1-9][0-9]*)$/;", "export const WORKTREE_PATH_RE = /^(?:([^/]+)\\/)?\\.zcode\\/worktrees\\/task-([1-9][0-9]*)$/;", "m32"),
  },
  {
    name: "m33-demotion-merge-off",
    file: COMPILER,
    scenario: "71",
    expect: "降级诊断同因合并被去掉（同一 run 同一声明逐卡重复噪音）必须被 71 的合并计数断言咬住",
    apply: (src) =>
      mutate(
        src,
        '    const key = `${d.runId ?? "（无 run 记录）"}|${d.path}`;',
        '    const key = `${d.runId ?? "（无 run 记录）"}|${d.path}|${d.no}`;',
        "m33",
      ),
  },
  {
    name: "m34-default-scan-surface-widened",
    file: SCAN_CONFIG,
    scenario: "72a",
    expect: "默认扫描面未收窄（docs/plans、docs/design-notes 默认仍被吸入）必须被 72a 的零吸入断言咬住",
    apply: (src) =>
      mutate(
        src,
        'export const DEFAULT_PLAN_DIRS = Object.freeze([".zcode/plans"]);',
        'export const DEFAULT_PLAN_DIRS = Object.freeze([".zcode/plans", "docs/plans", "docs/design-notes"]);',
        "m34",
      ),
  },
  {
    name: "m35-pool-check-off",
    file: SCAN_CONFIG,
    scenario: "72e",
    expect: "includeDirs 池外引用放行（任意目录当计划源）必须被 72e 的拒绝诊断与零吸入断言咬住",
    apply: (src) => mutate(src, "        if (!OPT_IN_PLAN_DIRS.includes(dir)) {", "        if (false) {", "m35"),
  },
  {
    name: "m36-scan-config-error-swallowed",
    file: SCAN_CONFIG,
    scenario: "72d",
    expect: "坏 scan.json 的失败级诊断被吞（不点名解析失败/不写兜底去向）必须被 72d 的诊断断言咬住",
    apply: (src) =>
      mutate(
        src,
        "        message: `scan.json 解析失败（${loaded.error}）：整份配置拒收，扫描面按默认 .zcode/plans/ 兜底（不猜）——请修复后重编译。`,",
        "        message: `scan.json 未加载。`,",
        "m36",
      ),
  },
  {
    name: "m37-mass-gate-off",
    scenario: "72g",
    script: "run-t9-scenarios.mjs",
    expect: "防 mass 改写闸关闭（>10 未领号计划文件照常批量盖号）必须被 72g 的拒绝执行断言咬住",
    apply: (src) => mutate(src, "  if (unnumberedPlanFiles.length > MASS_PLAN_FILE_THRESHOLD) {", "  if (false) {", "m37"),
  },
  {
    name: "m38-exclude-globs-off",
    file: SCAN_CONFIG,
    scenario: "72c",
    expect: "excludeGlobs 失效（命中文件照常扫入）必须被 72c 的排除断言咬住",
    apply: (src) => mutate(src, "  return (globs ?? []).some((g) => globToRegExp(g).test(rel));", "  return false;", "m38"),
  },
  {
    name: "m39-check-scan-config-failure-off",
    scenario: "72h",
    script: "run-t10-scenarios.mjs",
    expect: "--check 对扫描面配置错误不判失败项（失败级降级为静默）必须被 72h 的非零退出断言咬住",
    apply: (src) => mutate(src, "  for (const e of scanSurface.errors) {", "  for (const e of []) {", "m39"),
  },
  {
    name: "m40-invariant-e-evidence-off",
    file: FIXTURE_INVARIANTS,
    scenario: "97a",
    expect: "第五不变量 (e) 的证据集合不再参与判定（有证据卡也被点名）必须被 97a 的「恰 2 项」计数断言咬住",
    apply: (src) => mutate(src, "        !evidence.has(t.no) &&", "        true ||", "m40"),
  },
  {
    name: "m41-invariant-e-exemption-off",
    file: FIXTURE_INVARIANTS,
    scenario: "97b",
    expect: "豁免登记被忽略（登记后照常点名）必须被 97b 的「点名消失」断言咬住",
    apply: (src) => mutate(src, "        !exempted.has(t.no)", "        true", "m41"),
  },
  {
    name: "m42-worktree-normalization-off",
    file: DERIVE,
    scenario: "151",
    expect: "工作树归一化关闭（字段退回声明原形态——短声明不再归一为现场路径）必须被 151 的两态归一断言咬住",
    apply: (src) =>
      mutate(
        src,
        "    worktree: unmerged ? resolvedWorktree : null,",
        "    worktree: unmerged ? declared : null,",
        "m42",
      ),
  },
  {
    name: "m43-worktree-card-binding-off",
    scenario: "152",
    expect: "卡号绑定判定关掉（板面 worktree 末段号不再与卡号对照）必须被 152 的「恰点名 2 项」与两卡点名断言咬住",
    apply: (src) =>
      mutate(
        src,
        "        if (parsed != null && parsed.no !== t.no) {",
        "        if (parsed != null && false) {",
        "m43",
      ),
  },
  {
    name: "m44-exemptions-version-gate-off",
    file: "lib/schema-check.mjs",
    scenario: "97b",
    expect: "豁免登记结构闸关掉（version≠1 但合法条目仍生效——报错与效果自相矛盾，FINDING-1 回炉）必须被 97b 的「零豁免生效/恢复点名」断言咬住",
    apply: (src) =>
      mutate(
        src,
        "  if (structural.length > 0) return { exemptNos: [], errors: structural };",
        "  if (false) return { exemptNos: [], errors: structural };",
        "m44",
      ),
  },
  {
    name: "m45-reuse-checks-off",
    scenario: "83",
    expect:
      "期号/epic 码复用判定关停（同码多行不咬、同期次跨批不点名）必须被 83 的码复用/复用候选断言咬住",
    apply: (src) =>
      mutate(
        mutate(src, "if (idx.length < 2) continue;", "if (true) continue;", "m45a（epic 码复用）"),
        "if (byStamp.size < 2) continue;",
        "if (true) continue;",
        "m45b（期号跨批）",
      ),
  },
  {
    name: "m46-seq-highwater-off",
    scenario: "83",
    expect: "seq 高水位判定关停（seq 回落与缺失/非法两态都不咬）必须被 83 的 seq 高水位断言咬住",
    apply: (src) =>
      mutate(
        mutate(src, "if (!Number.isInteger(seq) || seq < 0) {", "if (false) {", "m46a（缺失/非法）"),
        "if (seq < top.no) {",
        "if (false) {",
        "m46b（回落）",
      ),
  },
  {
    name: "m47-double-ownership-off",
    scenario: "82",
    expect:
      "同稿双归属判定关停（一稿一 epic 不再咬）必须被 82 的「恰 6 项」与双归属点名断言咬住（A2-2 §7 转交）",
    apply: (src) => mutate(src, "if (list.length < 2 || distinct.size < 2) continue;", "if (true) continue;", "m47"),
  },
  {
    name: "m48-phantom-guard-off",
    scenario: "114",
    expect:
      "幻影根判定关停（板项目子目录照写副板/错位证据无拦——祖先板根逐级上溯失效）必须被 114 的拦截面/零副板断言咬住",
    apply: (src) => mutate(src, "    if (isFile(join(cur, BOARD_JSON_REL))) {", "    if (false) {", "m48"),
  },
  {
    name: "m49-ownership-pair-shape-off",
    file: COMPILER,
    scenario: "82",
    expect:
      "归属对形态判定关停（裸码/半对/非正整数 phase 不再咬——A2-2 §7 转交的 pair 形态 push）必须被 82 的「恰 6 项」与形态点名断言咬住",
    apply: (src) =>
      mutate(
        src,
        "    const pair = normalizeEpicPair(e.epic, e.phase);\n    if (!pair.ok) {",
        "    const pair = normalizeEpicPair(e.epic, e.phase);\n    if (false) {",
        "m49（checkEpicOwnership 归属对形态）",
      ),
  },
  {
    name: "m50-epic-refs-reachability-off",
    file: FIXTURE_INVARIANTS,
    scenario: "82",
    expect:
      "板面登记 id 可达反查关停（悬空引用 epic:GONE 不再咬——A2-2 §7 转交的 checkEpicRefs 可达反查）必须被 82 的悬空两面与「恰 6 项」断言咬住",
    apply: (src) => mutate(src, "    if (codes.has(code)) return;", "    if (true) return;", "m50（checkEpicRefs 可达反查）"),
  },
  {
    name: "m51a-frontier-includes-blocked",
    file: DERIVE,
    scenario: "134",
    expect:
      "frontier 选取放宽（受阻卡混入可执行前沿）必须被 134 的 i1 多出行/i4 两面断言咬住",
    apply: (src) => mutate(src, "    if (card.stage === STAGE.TODO && unresolved.length === 0) {", "    if (card.stage === STAGE.TODO) {", "m51a"),
  },
  {
    name: "m51b-frontier-emptied",
    file: DERIVE,
    scenario: "134",
    expect:
      "frontier 恒空（可执行前沿漏行）必须被 134 的 i1 缺行/i4 空洞断言咬住",
    apply: (src) => mutate(src, "    if (card.stage === STAGE.TODO && unresolved.length === 0) {", "    if (card.stage === STAGE.TODO && false) {", "m51b"),
  },
  {
    name: "m51c-blocked-first-only",
    file: DERIVE,
    scenario: "134",
    expect:
      "blocked 归因截断（一卡多项只记首项）必须被 134 的 i3「一卡多项出多行」断言咬住",
    apply: (src) => mutate(src, "      for (const u of unresolved) blocked.push({ no: card.no, title: card.title, stage: card.stage, ...u });", "      for (const u of unresolved.slice(0, 1)) blocked.push({ no: card.no, title: card.title, stage: card.stage, ...u });", "m51c"),
  },
  {
    name: "m51d-recent-order-reversed",
    file: DERIVE,
    scenario: "134",
    expect:
      "recent 排序反向（旧→新）必须被 134 的 i2 非升序断言咬住",
    apply: (src) => mutate(src, "    .sort((a, b) => (atOf(a) === atOf(b) ? idxOf(a) - idxOf(b) : atOf(b) - atOf(a)));", "    .sort((a, b) => (atOf(a) === atOf(b) ? idxOf(a) - idxOf(b) : atOf(a) - atOf(b)));", "m51d"),
  },
  {
    name: "m51e-recent-truncation-off",
    file: DERIVE,
    scenario: "134",
    expect:
      "recent 截断关闭（超出 N=10 不截断）必须被 134 截断探针与 i2 上限断言咬住",
    apply: (src) => mutate(src, "      if (recent.length >= limit) return { frontier, active, blocked, recent };", "      if (false) return { frontier, active, blocked, recent };", "m51e"),
  },
  {
    name: "m51f-recent-cap-lowered",
    file: DERIVE,
    scenario: "134",
    expect:
      "RECENT_LIMIT 收紧（N 调小、recent 被提前截断）——i2 上界只判 ≤N 不判下界（合法少填），承载面 = S-1 词表守卫：fact-invariants 独立复写常量 RECENT_LIMIT 与 derive 对照，常量改动必被守卫咬住（C2 评审 std-2 承接：若场景侧无咬合断言，本条期望以 S-1 必红为准）",
    apply: (src) => mutate(src, "const RECENT_LIMIT = 10;", "const RECENT_LIMIT = 3;", "m51f"),
  },
  {
    name: "m52a-registry-ghost-merge-off",
    scenario: "105a",
    expect:
      "registry 幽灵/悬空条目并入板 diagnostics 的调用关停（幽灵号不再落点名——E4-05 两视图分叉回归）必须被 105a 的条目面点名计数断言咬住",
    apply: (src) => mutate(src, "  reconcileRegistryEntries(features, registry, root, diag);", "  /* 突变：幽灵/悬空并入关停 */", "m52a"),
  },
  {
    name: "m52b-runs-ref-split-off",
    scenario: "105b",
    expect:
      "runs 引用死号两文案分流关停（registry 有条目而板上无 也落「完全未知号」文案——两文案混用回归）必须被 105b 的文案 A 独立断言咬住",
    apply: (src) =>
      mutate(
        src,
        'if (classifyDeadNumber(no, { liveNos: liveNo, registryNos: runsRegistryNos }) === "registry-not-on-board") {',
        "if (false) {",
        "m52b",
      ),
  },
  {
    name: "m52c-registry-ghost-visibility-off",
    file: FIXTURE_INVARIANTS,
    scenario: "105d",
    expect:
      "registry 幽灵/悬空可见性断言关停（板面删点名不再咬——两视图一致性防线失效）必须被 105d 的「registry 对账 恰 1 项失败」断言咬住",
    apply: (src) => mutate(src, "    if (named) continue;", "    if (true) continue;", "m52c"),
  },
  {
    name: "m52d-omitted-ref-visibility-off",
    file: "lib/schema-check.mjs",
    scenario: "105d",
    expect:
      "「不造引用不静默」配对断言关停（引用缺省且无点名不再咬）必须被 105d 的板结构配对断言咬住",
    apply: (src) => mutate(src, "                if (!named) {", "                if (false) {", "m52d"),
  },
  {
    name: "m53a-assign-identity-off",
    scenario: "106a",
    expect:
      "发号前身份校验关停（名不符稿不再触发拒发——V29 #41 手误防线失效）必须被 106a 的拒发/点名/零写入断言咬住",
    apply: (src) =>
      mutate(
        src,
        "    for (const reason of planDocIdentityViolations(facts)) identityViolations.push({ file: t.file, reason });",
        "    for (const reason of planDocIdentityViolations(facts)) void reason; /* 突变：身份校验关停 */",
        "m53a",
      ),
  },
  {
    name: "m53b-session-uuid-rule-relaxed",
    scenario: "106a",
    expect:
      "会话稿 uuid 完整性判据放宽（缺段会话名照常通过——#41 手误形态回归）必须被 106a 的「完整 uuid/实际会话段」点名断言咬住",
    apply: (src) =>
      mutate(
        src,
        "const COMPLETE_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;",
        "const COMPLETE_UUID_RE = /^.+$/; /* 突变：uuid 完整性放宽 */",
        "m53b",
      ),
  },
  {
    name: "m53c-content-feature-rule-off",
    scenario: "106a",
    expect:
      "内容计划特征判据关停（无标题无条目的叙事稿照常通过）必须被 106a 的「内容无计划稿特征」点名断言咬住",
    apply: (src) => mutate(src, "  if (!hasHeading && entryCount === 0) {", "  if (false) { /* 突变：内容特征判据关停 */", "m53c"),
  },
  {
    name: "m53d-assign-plan-code-dup-off",
    scenario: "106b",
    expect:
      "重码判定关停（--assign 不再对重复 planCode 拒发）必须被 106b 的拒发/逐码点名/零写入断言咬住",
    apply: (src) => mutate(src, "  const planCodeDuplicates = planCodeConflicts(entries);", "  const planCodeDuplicates = []; /* 突变：重码判定关停 */", "m53d"),
  },
  {
    name: "m53e-check-plan-code-assertion-off",
    scenario: "106b",
    expect:
      "--check 面 planCode 唯一断言关停（重复注册表项不再失败级点名）必须被 106b 的「planCode 唯一 恰 1 项失败」断言咬住",
    apply: (src) =>
      mutate(
        src,
        "  return planCodeConflicts(registry.entries).map((c) => planCodeConflictMessage(c));",
        "  return []; /* 突变：唯一断言关停 */",
        "m53e",
      ),
  },
  {
    name: "m54a-agents-residue-scan-off",
    scenario: "107",
    expect:
      "根 AGENTS.md 看板残留扫描关停（塞入看板内容不再失败级点名）必须被场景 107 的红侧退出码/锚点行号/自清断言咬住",
    apply: (src) =>
      mutate(
        src,
        'export function checkRootAgentsResidue(root) {\n  const loaded = readTextFile(join(root, "AGENTS.md"));',
        'export function checkRootAgentsResidue(root) {\n  return []; /* 突变：AGENTS.md 锚扫描关停 */\n  const loaded = readTextFile(join(root, "AGENTS.md"));',
        "m54a",
      ),
  },
  {
    name: "m54b-docs-position-scan-off",
    scenario: "107",
    expect:
      "doc/docs 看板资产位置判定关停（docs/ 内板数据文件名族/内容锚不再失败级点名）必须被场景 107 的 docs 红侧断言咬住",
    apply: (src) =>
      mutate(
        src,
        "export function checkDocsBoardAssets(root) {\n  const out = [];",
        "export function checkDocsBoardAssets(root) {\n  const out = [];\n  return out; /* 突变：docs 位置判定关停 */",
        "m54b",
      ),
  },
];

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    console.log("  --list               只列出突变清单（不建副本域）");
    console.log("  --source <dir>       待突变域（缺省 = 本技能 assets/；一律先在副本域快照）");
    console.log("  --guard-board <dir>  真实板守卫：板根或板目录，窗口前后逐文件 sha256 断言（变化 → exit 3）");
    console.log("  --keep               保留副本域（排障用；缺省跑完即清）");
    return 0;
  }
  if (opts.errors.length > 0) {
    for (const e of opts.errors) console.error(e);
    return 2;
  }
  if (opts.list) {
    for (const m of MUTATIONS) console.log(`${m.name}\t场景 ${m.scenario}\t${m.expect}`);
    return 0;
  }

  const source = resolve(opts.source ?? ASSETS_DIR);
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    console.error(`源域不存在或不是目录：${source}`);
    return 2;
  }

  const tempBase = tmpdir();
  const guardFailures = domainGuardFailures(source, tempBase);
  if (guardFailures != null) {
    console.error("突变域守卫拒跑（V24：突变/篡改验证一律副本域，真实板零污染）：");
    for (const p of guardFailures) console.error(`  - ${p}`);
    return 2;
  }

  const guardBoardDir = opts.guardBoard != null ? resolveBoardDir(opts.guardBoard) : null;
  if (guardBoardDir != null && (!existsSync(guardBoardDir) || !statSync(guardBoardDir).isDirectory())) {
    console.error(`--guard-board 不是目录：${opts.guardBoard}`);
    return 2;
  }
  const boardBefore = guardBoardDir != null ? fingerprintBoardSurface(guardBoardDir) : null;

  const domainRoot = mkdtempSync(join(tempBase, "zcode-board-mut-domain-"));
  const baseAssets = join(domainRoot, "base", "assets");
  mkdirSync(dirname(baseAssets), { recursive: true });
  const snapshot = snapshotDomain(source, baseAssets);
  if (snapshot == null) {
    console.error(
      `源域在复制窗口内被并发改写（半写态）：${SNAPSHOT_ATTEMPTS} 次复制均未取到一致快照（源域 ${source}）——` +
        "待并发写入停稳后重跑；V24：不把撕裂态当验证对象（不猜、不静默）。",
    );
    rmSync(domainRoot, { recursive: true, force: true });
    return 2;
  }

  console.log("zcode-board · T6 反向断言（突变必须被夹具捕获）");
  console.log(`源域（只读）：${source}`);
  console.log(`副本域：${domainRoot}`);
  console.log(
    `快照：${snapshot.count} 文件 · sha256 ${snapshot.hash}${
      snapshot.attempts > 1 ? `（第 ${snapshot.attempts} 次取到一致）` : ""
    }`,
  );
  console.log(
    boardBefore != null
      ? `真实板守卫：${guardBoardDir}（${boardBefore.count} 文件 · sha256 ${boardBefore.hash}）`
      : "真实板守卫：未启用（--guard-board <板根|板目录> 可开启真实板窗口前后哈希断言）",
  );
  console.log("");

  let uncaught = 0;
  let errors = 0;
  let caught = 0;
  for (const m of MUTATIONS) {
    const dir = join(domainRoot, m.name);
    const target = join(dir, "assets");
    cpSync(baseAssets, target, { recursive: true });
    const path = join(target, m.file ?? COMPILER);
    try {
      writeFileSync(path, m.apply(readFileSync(path, "utf8")));
    } catch (e) {
      errors += 1;
  console.log(`ANCHOR-MISS  ${m.name}：${e.message}`);
      continue;
    }
    const script = m.script ?? "run-scenarios.mjs";
    const flag = m.script ? "--only" : "--scenario";
    const res = spawnSync(process.execPath, [join(target, "test", script), flag, m.scenario], {
      encoding: "utf8",
      cwd: dir,
    });
    const fails = (res.stdout ?? "").split("\n").filter((l) => l.startsWith("  FAIL")).length;
    if (res.status !== 0 && fails > 0) {
      caught += 1;
      console.log(`CAUGHT  ${m.name}（场景 ${m.scenario}，${fails} 条失败）`);
      console.log(`        断言依据：${m.expect}`);
      const first = (res.stdout ?? "").split("\n").find((l) => l.startsWith("  FAIL"));
      if (first) console.log(`        首条被咬：${first.trim()}`);
    } else {
      uncaught += 1;
      console.log(`UNCAUGHT  ${m.name}（场景 ${m.scenario}）依然全绿 → 断言对该行为不敏感`);
      console.log(`        期望：${m.expect}`);
      console.log(`        exit=${res.status}`);
    }
    console.log("");
  }

  // 源域漂移：整轮结果对应冻结快照；窗口内并发写入只报不咬（半写态不再污染本轮，V24）。
  const drift = diffFileLists(snapshot.files, collectFiles(source));
  if (drift.total === 0) {
    console.log(`源域窗口内零写入（本工具写入面 = 副本域；快照 sha256 ${snapshot.hash}）`);
  } else {
    const sample = [
      ...drift.changed,
      ...drift.added.map((r) => `+${r}`),
      ...drift.removed.map((r) => `-${r}`),
    ].slice(0, 10);
    console.log(
      `⚠ 源域窗口内被并发改写（${drift.total} 处）：${sample.join("、")}${
        drift.total > sample.length ? " …" : ""
      }`,
    );
    console.log(
      `  本轮结果对应冻结快照（sha256 ${snapshot.hash}），与窗口内改写无关（V24：半写态不再误咬）。`,
    );
  }

  // 真实板守卫：窗口前后逐文件哈希断言（变化即失败；未启用则跳过）。
  let boardChanged = false;
  if (guardBoardDir != null) {
    const after = fingerprintBoardSurface(guardBoardDir);
    if (after.hash === boardBefore.hash) {
      console.log(
        `真实板守卫：${guardBoardDir} 窗口前后逐文件一致（${after.count} 文件 · sha256 ${after.hash}）——真实板零污染`,
      );
    } else {
      boardChanged = true;
      const d = diffFileLists(boardBefore.files, after.files);
      for (const rel of [...d.changed, ...d.added, ...d.removed]) {
        const b = boardBefore.files.find((f) => f.rel === rel);
        const a = after.files.find((f) => f.rel === rel);
        console.log(
          `FAIL  真实板在突变窗口内变化：${rel}（${(b?.digest ?? "缺").slice(0, 12)} → ${(a?.digest ?? "缺").slice(0, 12)}）`,
        );
      }
      console.log(
        `真实板守卫：比对失败——窗口内变化 ${d.total} 处。本工具写入面仅副本域 ${domainRoot}；` +
          "请排查并发 record-run/重编译后重跑（真实板零污染口径见 V24）。",
      );
    }
  }

  console.log(
    `结论：捕获 ${caught} / 未捕获 ${uncaught} / 锚点失配 ${errors}（共 ${MUTATIONS.length} 个突变）`,
  );
  const ok = uncaught === 0 && errors === 0 && !boardChanged;
  console.log(
    boardChanged
      ? "存在窗口内变化的真实板文件（见上）"
      : ok
        ? "全部突变被夹具捕获（断言敏感）"
        : "存在未被捕获的突变或锚点失配",
  );

  if (opts.keep) console.log(`副本域保留（--keep）：${domainRoot}`);
  else rmSync(domainRoot, { recursive: true, force: true });
  return boardChanged ? 3 : ok ? 0 : 1;
}

process.exit(main(process.argv.slice(2)));
