#!/usr/bin/env node
/**
 * zcode-board / 反向断言（夹具有效性自证：T6 骨架 + T7 派生层 + T9 发号）
 *
 * 做法：把 assets/ 整树复制到系统临时目录，对副本施加一处**语义突变**，再跑指定场景；
 * 若突变未被任何断言捕获（全绿），说明夹具/断言对该行为不敏感 → 判为失败。
 * 真实交付物不被修改；每个突变自带"锚点必须命中"检查，防止重构后突变静默失效。
 *
 * 用法：node assets/test/run-mutations.mjs [--list]
 * 退出码：0 = 全部突变都被捕获；1 = 有突变未被捕获（断言不敏感）。
 */

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { ASSETS_DIR } from "./fixtures/build-fixture.mjs";

const COMPILER = "compile-board.mjs";
const LIB = "lib/board-io.mjs";
const DERIVE = "lib/derive.mjs";
/** #56 事实互证不变量 + #97 第五不变量（--check 的机械防线）。 */
const FIXTURE_INVARIANTS = "lib/fact-invariants.mjs";
/** #72 扫描面配置解析（默认收窄 / opt-in 池 / excludeGlobs / 兜底）。 */
const SCAN_CONFIG = "lib/scan-config.mjs";

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
];

function main(argv) {
  if (argv.includes("--list")) {
    for (const m of MUTATIONS) console.log(`${m.name}\t场景 ${m.scenario}\t${m.expect}`);
    return 0;
  }

  console.log("zcode-board · T6 反向断言（突变必须被夹具捕获）");
  console.log(`assets: ${ASSETS_DIR}`);
  console.log("");

  let uncaught = 0;
  let errors = 0;
  let caught = 0;
  for (const m of MUTATIONS) {
    const dir = mkdtempSync(join(tmpdir(), `zcode-board-t6-mut-${m.name}-`));
    const target = join(dir, "assets");
    cpSync(ASSETS_DIR, target, { recursive: true });
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

  console.log(
    `结论：捕获 ${caught} / 未捕获 ${uncaught} / 锚点失配 ${errors}（共 ${MUTATIONS.length} 个突变）`,
  );
  const ok = uncaught === 0 && errors === 0;
  console.log(ok ? "全部突变被夹具捕获（断言敏感）" : "存在未被捕获的突变或锚点失配");
  return ok ? 0 : 1;
}

process.exit(main(process.argv.slice(2)));
