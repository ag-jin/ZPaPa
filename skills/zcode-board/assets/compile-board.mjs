#!/usr/bin/env node
/**
 * zcode-board 编译器（T6 骨架 + T7 派生层 + T9 发号模式 + T10 审计模式）
 *
 * 用法：
 *   node compile-board.mjs [<project-root>]            默认只读编译（<project-root> 默认当前工作目录）
 *   node compile-board.mjs [<project-root>] --assign   发号：无号条目领全局稳定号，写源头标记 + registry + 自动重编译
 *   node compile-board.mjs [<project-root>] --check    审计（只读）：源/registry/board.json 三方一致 + 结构校验，不一致非零退出
 *   node compile-board.mjs --version                    版本：一行 包版本 / 契约版本 / schema 版本（#67；读 lib/version.mjs）
 *   node compile-board.mjs --manifest                   重新生成 assets/manifest.json（#67：三版本 + 关键文件 sha256）
 *   node compile-board.mjs --help
 *
 * 行为（设计 §3.3/§3.4/§4.2–§4.5/§8.3–§8.4/§12/§13 场景 9/10/19）：
 *   - 扫描 sources：.zcode/board/{interviews,registry,runs}.json + specs/<f>/{progress.json,tasks.md}
 *     + 三类计划目录 .zcode/plans/、docs/plans/、docs/design-notes/（docs/ 根目录其他文件不扫）；
 *   - 解析：文件头/行级号标记（v2.3 起含 roadmap 子旗标：独立注释或与 no= 同注释）、tasks.md 条目与
 *     progress.json v3、plan 保守任务语法（checkbox 与 T<数字>/任务<数字> 前缀）、`> blocked:`/`> blocked-by:`
 *     引用行、契约 v2.1（T21）的 `> cancelled:`（取消留痕，条目保留、号不复用；#66 起含特性级落点：
 *     计划稿 H1 标记行之后、首个非引用行之前 → 特性取消）与 `> agents:`
 *     （指派管线 → assignees[]）；引用族语法族仅落计划稿类文档——出现在 tasks.md 的行不解析 +
 *     diagnostics 逐行点名（markers.md §7）；roadmap 标记只在计划稿 H1 层合法（§2.5），非法位置不生效 +
 *     diagnostics，--check 非零退出；
 *   - 归一：title 净化、label 树位派生、blockers 句柄归一为整数、sources[] 完整、diagnostics 不静默；
 *     计划→spec 延续：被 spec 接续的计划稿节点退役（origin.planRef 降为 evidence，§3.2）；
 *   - 派生（T7，lib/derive.mjs）：特性/任务 status 推导（§4.3）+ statusRule、runs 归一
 *     （lastRun/activeRun/worktree/pr/updatedAt max 合并，§4.5）、四缺口码与 attentionSummary（§8.4）、
 *     段位 stage + stageRule（七段位，v2.1 起含已取消）、plan-overgrown / progress 勾选数不一致 /
 *     worktree 目录互证诊断；契约 v2.3（#53）：计划稿特性段位随子卡汇总（全完成→已完成）、
 *     arranged-not-expanded 判据收窄为零卡、roadmap 占位稿段位恒待设计、卡级 nextAssignee
 *     （管线序首个无 done run 证据角色）；#66 终态优先序：取消（卡级/特性级标记或全取消子卡汇总
 *     → 已取消）不让位于 roadmap 段位压制（特性自身取消 > rollup > roadmap 压制 > 其余推导）；
 *   - 发号（T9，--assign）：按确定性扫描顺序（specs 字典序 → PLAN_DIRS 冻结序 × 文件名字典序 →
 *     文件内文档序）给无号条目发全局单序列号；计划稿盖文件头标记、条目行尾盖号（lib/marker-write.mjs
 *     逐文件原子写，只增不改）；spec 特性号 registry 内绑定；seq 高水位只增；registry 指向更新
 *     （苗圃迁移 ②'、计划→spec 延续、归档映射（勘误 10：file/specRoot → 归档路径，号不变））；
 *     registry 丢失/损坏按活标记重建（seq=max 活号）；冲突/篡改不静默改写（diagnostics + 降级未领号）；
 *     发号后自动重编译；
 *   - 审计（T10，--check）：全程只读；内存重编译为期望基线 → 源完整性（损坏源 → 失败）、
 *     活条目清单 ↔ registry 互检（活号唯一、kind/指向一致、裁决序：标记 > registry；
 *     归档条目按指向路径直查——存在且含标记 → 通过 note"已归档"；指向不存在且归档候选已验证 → 失败级诊断，
 *     无候选 → 提示级独立诊断（勘误 10））、
 *     board.json（若存在）↔ 期望基线比对（篡改/板陈旧 → 差异报告 + 失败）+ 结构校验
 *     （lib/schema-check.mjs：T1 子集校验器 + T7 公共不变量/引用位整数断言）
 *     + 事实互证（#56，lib/fact-invariants.mjs：子卡全完成→已完成、有卡不得挂未拆解、
 *     board.md 编号形态 ↔ planCode/label 派生、段位计数复算；磁盘板与重编译基线各跑一遍，
 *     违例失败级点名路径 + 节点编号 + 两值对照）；修复 = 重编译；
 *   - 写出：<root>/.zcode/board/board.json + board.md（原子写：临时文件 + 改名）。
 *
 * 硬约束：默认模式对源文件**零写入**；--check 全程**只读**；--assign 对源头的写入仅限号标记 +
 * registry（§12 副作用边界，roadmap 子旗标由作者手写、--assign 不写入不改写）；不解析不触碰
 * .zcode/workflows/；不执行任何 git 命令；无第三方依赖。
 * 归属边界：契约 v2.3（#53）——roadmap 子旗标与 nextAssignee 已正式化（schema v2.3 与 markers.md v2.3 同源）；
 * v2.1（T21）的 cancelled/assignees/stage 与 v2.2（#46）的 planCode/currentAssignee/section 不变。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ISO_RE,
  ROADMAP_MARKER_RE,
  findFileMarker,
  isDir,
  isFile,
  lineEndMarker,
  mtimeIso,
  normalizeHandle,
  nowIso,
  parseMarkers,
  readJsonFile,
  readTextFile,
  stripLineEndMarker,
  writeFileAtomic,
  writeJsonAtomic,
} from "./lib/board-io.mjs";

import {
  ATTENTION,
  ATTENTION_CODES,
  ATTENTION_LABELS,
  DEGRADED_RULE,
  RUN_ROLES,
  STAGE,
  STAGE_VALUES,
  deriveArrangedNotExpanded,
  deriveCardRuns,
  deriveCurrentAssignee,
  deriveNextAssignee,
  derivePlanFeatureStatus,
  derivePlanTaskStatus,
  deriveSpecFeatureStatus,
  deriveStage,
  deriveTaskStatus,
  diagnosePlanOvergrown,
  diagnoseProgressMismatch,
  diagnoseWorktrees,
  maxIso,
  normalizeRuns,
  summarizeAttention,
  summarizeStages,
} from "./lib/derive.mjs";

import { applyMarkerEdits, writeMarkersIfChanged } from "./lib/marker-write.mjs";

import {
  checkBoardInvariants,
  checkSchemaSubset,
  validateSchemaValue,
} from "./lib/schema-check.mjs";

import { checkFactInvariants } from "./lib/fact-invariants.mjs";

import { SCAN_CONFIG_REL, loadScanConfig, matchesAnyGlob } from "./lib/scan-config.mjs";

import { GENERATED_BY, SKILL_ROOT_DIR, SKILL_VERSION, formatVersionLine, readVersionInfo } from "./lib/version.mjs";

// 版本单一事实源（#67）：包版本常量在 lib/version.mjs；此处重导出，board.json.generatedBy、
// SKILL.md 头部版本行与 assets/manifest.json 均由它派生/经断言守卫同值。
export { GENERATED_BY, SKILL_VERSION };

// ---------------------------------------------------------------- 常量

const BOARD_VERSION = 2;
const DETAILS_MAX = 200;
const ELLIPSIS = "…";
/** §4.2 plan-overgrown 阈值（T7 消费：diagnosePlanOvergrown 传入该常量）。 */
export const PLAN_OVERGROWN_THRESHOLD = 60;
/** 工作树收纳目录（§6.1 条件 1；编译器只做纯文件存在性检查，不执行 git）。 */
const WORKTREES_REL = ".zcode/worktrees";
/** 板产物相对路径（--check 的第三份互检对象；写出点见 main）。 */
const BOARD_JSON_REL = ".zcode/board/board.json";
/** 板渲染产物（--check 的编号形态互证对象；#56 不变量 c）。 */
const BOARD_MD_REL = ".zcode/board/board.md";
/** 契约包内的 board schema（T1 冻结；--check 结构校验依据，与 compile-board.mjs 同目录）。 */
const SCHEMA_PATH = fileURLToPath(new URL("./board.schema.json", import.meta.url));
/** 技能包 manifest（#67；P2 分发比对直接用；`--manifest` 写出点，技能根相对路径）。 */
const MANIFEST_REL = "assets/manifest.json";

/** 第一方源：缺失时按空源参与编译（§12），路径恒列于 sources[] 供陈旧检测与 hook 触发判定。 */
const FIRST_PARTY_SOURCES = [
  { kind: "interviews", path: ".zcode/board/interviews.json" },
  { kind: "registry", path: ".zcode/board/registry.json" },
  { kind: "runs", path: ".zcode/board/runs.json" },
];
const SPEC_SOURCE_FILES = ["progress.json", "tasks.md"];
const SPEC_TITLE_FILES = ["requirements.md", "design.md"];

const HEADING_RE = /^(\s*)(#{1,6})\s+(.*)$/;
/** H1 标题行（roadmap 标记的合法层；契约 v2.3 §2.5：`# 标题`，不匹配 `##` 及更深）。 */
const H1_RE = /^\s*#\s+(.*)$/;
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const REF_RE = /^\s*>\s*blocked(-by)?\s*:(.*)$/;
/** 契约 v2.1（T21）语法族：取消与指派；归属与引用行同一规则（上方最近条目、同缩进块）。 */
const CANCELLED_RE = /^\s*>\s*cancelled\s*:(.*)$/;
const AGENTS_RE = /^\s*>\s*agents\s*:(.*)$/;
/** 标准管线（markers.md v2.1：顺序即管线序；默认管线免写——缺省即此值）。 */
const DEFAULT_ASSIGNEES = Object.freeze(["implementer", "test-verifier", "code-reviewer", "integrator"]);
/** roadmap 占位稿段位规则（#53，契约 v2.3；语法见 markers.md v2.3 §2.5：本稿条目本身不执行）。 */
const ROADMAP_FEATURE_STAGE_RULE =
  "计划稿带 roadmap 标记（占位稿：本稿条目本身不执行）→ 段位恒为待设计（不受勾选/状态/执行记录影响）";
const ROADMAP_TASK_STAGE_RULE =
  "所在计划稿带 roadmap 标记（占位稿：本稿条目本身不执行）→ 段位恒为待设计（不受勾选/状态/执行记录影响）";
/**
 * 终态优先序（#66）：取消是终态（deriveStage 的 cancelled 分支先于其余分支），roadmap 段位压制对其让位——
 * roadmap 稿中已取消的卡/特性照常显示"已取消"，不因占位稿压制回落到"待设计"。
 */
const CANCELLED_OVER_ROADMAP_NOTE = "取消为终态，优先于 roadmap 段位压制（#66）";
const TASKS_ENTRY_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(\d+)\.\s*(.*)$/;
const PLAN_CHECKBOX_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;
const PLAN_BOLD_ENTRY_RE = /^(\s*)[-*+]\s+\*\*\s*(T(\d+)|任务(\d+))\s*([^*]*?)\s*\*\*\s*(.*)$/;
const PLAN_BOLD_BARE_RE = /^(\s*)\*\*\s*(T(\d+)|任务(\d+))\s*([^*]*?)\s*\*\*\s*(.*)$/;
const PLAN_HEADING_ENTRY_RE = /^(\s*)(#{1,6})\s*(T(\d+)|任务(\d+))\s*[:：、.．]?\s*(.*)$/;

/** 节点内部元数据（WeakMap + 访问器：绝不进入 JSON 产物）。 */
const META_STORE = new WeakMap();
function META(node) {
  let meta = META_STORE.get(node);
  if (!meta) {
    meta = {};
    META_STORE.set(node, meta);
  }
  return meta;
}

// ---------------------------------------------------------------- 小工具

function cleanInlineMarkup(s) {
  return String(s ?? "")
    .replace(/<!--[\s\S]*?-->/g, "") // 号标记等 HTML 注释不进入人类可读字段（位置无效的标记也不泄漏）
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 文档标题净化：剥已知文档前缀（Requirements:/Design:/Implementation Plan: 等）。 */
function sanitizeDocHeading(h) {
  return cleanInlineMarkup(h)
    .replace(/^(?:Requirements|Design|Implementation\s+Plan|Task\s+Plan|Plan)\s*[:：]\s*/i, "")
    .trim();
}

/** details 有界摘要：单行、≤200 字符（按码点）、超长截断加省略号。 */
export function truncateDetails(s) {
  const t = cleanInlineMarkup(s);
  const cps = [...t];
  if (cps.length <= DETAILS_MAX) return t;
  return cps.slice(0, DETAILS_MAX - 1).join("") + ELLIPSIS;
}

function firstHeading(text) {
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = HEADING_RE.exec(line);
    if (m) return m[3];
  }
  return null;
}

function indentOf(line) {
  const m = /^[ \t]*/.exec(String(line ?? ""));
  return m ? m[0].length : 0;
}

function stripRefSeparators(s) {
  return String(s ?? "")
    .trim()
    .replace(/^[\s\u2014\u2013\u2015:：,，、-]+/, "")
    .trim();
}

/**
 * 计划目录内的计划稿清单（非递归；仅 .md；忽略隐藏文件与子目录）。
 * 扫描序 = surface.planDirs（确定性：默认苗圃 `.zcode/plans/` → `scan.json.includeDirs` 池内冻结序；
 * #72/契约 v2.4，配置解析见 lib/scan-config.mjs）；`excludeGlobs` 按项目根相对路径排除。
 */
function listPlanFiles(root, surface) {
  const out = [];
  for (const dir of surface.planDirs) {
    const abs = join(root, dir);
    if (!isDir(abs)) continue;
    for (const name of readdirSync(abs).sort()) {
      if (name.startsWith(".")) continue;
      if (!name.toLowerCase().endsWith(".md")) continue;
      if (matchesAnyGlob(`${dir}/${name}`, surface.excludeGlobs)) continue; // excludeGlobs 按项目根相对路径排除（#72）
      const absFile = join(abs, name);
      if (!isFile(absFile)) continue;
      out.push({ dir, rel: `${dir}/${name}`, abs: absFile, stem: name.replace(/\.md$/i, "") });
    }
  }
  return out;
}

function listSpecDirs(root) {
  const specsRoot = join(root, "specs");
  if (!isDir(specsRoot)) return [];
  const out = [];
  for (const name of readdirSync(specsRoot).sort()) {
    if (name.startsWith(".")) continue;
    if (name === "archive") continue; // 归档目录不在扫描面（勘误 10：specs/archive/<f>/ 是移动目标，按名排除——不靠"无直接子文件"间接等效）
    const abs = join(specsRoot, name);
    if (!isDir(abs)) continue;
    const files = SPEC_SOURCE_FILES.filter((f) => isFile(join(abs, f)));
    if (files.length === 0) continue; // 无 tasks.md / progress.json 的目录不是真相源输入
    out.push({ dir: name, rel: `specs/${name}/`, abs, files });
  }
  return out;
}

function buildSources(scan) {
  const sources = FIRST_PARTY_SOURCES.map((s) => ({ ...s }));
  for (const spec of scan.specs) sources.push({ kind: "spec", root: spec.rel, files: [...spec.files] });
  for (const plan of scan.plans) sources.push({ kind: "plan", path: plan.rel });
  return sources;
}

/** 计划稿 identity：plan-sess_<uuid>.md → plan:sess_<uuid>（origin.sessionId 同名）；否则 plan:<主干>。 */
function planIdentity(plan) {
  const m = /^plan-(sess_[0-9A-Za-z-]+)$/.exec(plan.stem);
  if (m) return { id: `plan:${m[1]}`, sessionId: m[1] };
  return { id: `plan:${plan.stem}`, sessionId: null };
}

// ---------------------------------------------------------------- 归档映射（勘误 10：--assign 指向改写与 --check 直查共用）

/**
 * 勘误 10 归档映射：指向路径 → 归档候选路径（非扫描面三类源不产出候选，返回 null）。
 *   .zcode/plans/<x> → .zcode/archive/<x>
 *   docs/plans/<x>、docs/design-notes/<x> → docs/archive/plans/<x>
 *   specs/<f>/… → specs/archive/<f>/…
 * 归档目录自身（specs/archive/…、.zcode/archive/…、docs/archive/…）不再映射——指向改写幂等。
 */
function archiveCandidateOf(ref) {
  if (typeof ref !== "string" || ref === "") return null;
  if (ref.startsWith(".zcode/plans/")) return `.zcode/archive/${ref.slice(".zcode/plans/".length)}`;
  if (ref.startsWith("docs/plans/")) return `docs/archive/plans/${ref.slice("docs/plans/".length)}`;
  if (ref.startsWith("docs/design-notes/")) return `docs/archive/plans/${ref.slice("docs/design-notes/".length)}`;
  const m = /^specs\/([^/]+)\/(.*)$/.exec(ref);
  if (m && m[1] !== "archive") return `specs/archive/${m[1]}/${m[2]}`;
  return null;
}

/** 条目指向路径的现存性：spec 条目为根目录，其余为文件；指向缺省 → false。 */
function refPathExists(root, entry) {
  const ref = entry.kind === "spec" ? entry.specRoot : entry.file;
  if (typeof ref !== "string" || ref === "") return false;
  return entry.kind === "spec" ? isDir(join(root, ref)) : isFile(join(root, ref));
}

/** 条目指向路径（file 或 specRoot）；指向缺省 → null。 */
function entryRefOf(entry) {
  const ref = entry.kind === "spec" ? entry.specRoot : entry.file;
  return typeof ref === "string" && ref !== "" ? ref : null;
}

/** 条目指向路径直查三态（勘误 10）："archived"（存在且含该号标记）/ "exists"（存在但无该号标记）/ "missing"（不存在）。 */
function directRefQuery(root, entry) {
  const ref = entryRefOf(entry);
  if (ref === null || !refPathExists(root, entry)) return { ref, state: "missing" };
  return { ref, state: archiveRefVerified(root, entry, ref) ? "archived" : "exists" };
}

/**
 * 直查"归档路径存在且含该号标记"（勘误 10）：文件头标记或任一行尾标记等于该号即命中；
 * spec 根无内联特性号标记（号在 registry 内绑定）——以"目录存在且含 spec 源文件"为直查判据，
 * 其任务条目的行尾标记由各 task 条目自身逐条直查（不互相顶替）。
 */
function archiveRefVerified(root, entry, cand) {
  const abs = join(root, cand);
  if (entry.kind === "spec") {
    if (!isDir(abs)) return false;
    return SPEC_SOURCE_FILES.some((f) => isFile(join(abs, f)));
  }
  const read = readTextFile(abs);
  if (!read.ok) return false;
  const lines = read.text.split(/\r?\n/);
  const head = findFileMarker(lines, (line) => lineEndMarker(line) !== null);
  if (head && head.no === entry.no) return true;
  for (const line of lines) {
    const m = lineEndMarker(line);
    if (m && m.no === entry.no) return true;
  }
  return false;
}

// ---------------------------------------------------------------- 条目解析

/**
 * 计划稿条目保守语法（§4.2 / markers.md §2.2）：
 *   - checkbox（含嵌套）：`- [ ]` / `- [x]`，sourceNum 取可选 `N.` 前缀；
 *   - 加粗 T 前缀：`- **T1 标题**：正文`、`**T1 标题**`；
 *   - 标题 T 前缀：`### T2 标题`。
 * title 净化剥离作者标签；selector 保留作者形态（T1 / 任务1 / item-N）。
 */
function matchPlanEntry(line) {
  let m = PLAN_BOLD_ENTRY_RE.exec(line);
  if (m) {
    return {
      indent: m[1].length,
      checked: false,
      title: cleanInlineMarkup(m[5]),
      sameLineBody: m[6],
      selector: m[2],
      sourceNum: m[3] != null ? Number(m[3]) : Number(m[4]),
    };
  }
  m = PLAN_BOLD_BARE_RE.exec(line);
  if (m) {
    return {
      indent: m[1].length,
      checked: false,
      title: cleanInlineMarkup(m[5]),
      sameLineBody: m[6],
      selector: m[2],
      sourceNum: m[3] != null ? Number(m[3]) : Number(m[4]),
    };
  }
  m = PLAN_HEADING_ENTRY_RE.exec(line);
  if (m) {
    return {
      indent: m[1].length,
      checked: false,
      title: cleanInlineMarkup(m[6]),
      sameLineBody: "",
      selector: m[3],
      sourceNum: m[4] != null ? Number(m[4]) : Number(m[5]),
    };
  }
  m = PLAN_CHECKBOX_RE.exec(line);
  if (m) {
    const rest = m[3];
    const num = /^(\d+)\.\s*(.*)$/.exec(rest);
    return {
      indent: m[1].length,
      checked: m[2] !== " ",
      title: cleanInlineMarkup(num ? num[2] : rest),
      sameLineBody: "",
      selector: null,
      sourceNum: num ? Number(num[1]) : null,
    };
  }
  return null;
}

/** tasks.md 条目保守语法（markers.md §2.2）：`- [ ] N. 标题`（含嵌套），N 必填。 */
function matchTasksEntry(line) {
  const m = TASKS_ENTRY_RE.exec(line);
  if (!m) return null;
  return {
    indent: m[1].length,
    checked: m[2] !== " ",
    title: cleanInlineMarkup(m[4]),
    sameLineBody: "",
    selector: `task-${m[3]}`,
    sourceNum: Number(m[3]),
  };
}

/**
 * 代码上下文屏蔽（roadmap 标记专用，#53）：行内代码跨度（`…`）与围栏代码块（``` / ~~~）内的
 * 文本是文档示例，不构成标记——计划稿正文常在反引号里引用 v2.3 语法例（如卡片描述）。
 * 返回与入参等长的行数组（屏蔽行/片段置空，行号不变）。
 */
function stripCodeContext(lines) {
  const out = [];
  let fenced = false;
  for (const raw of lines) {
    const line = String(raw ?? "");
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      fenced = !fenced;
      out.push("");
      continue;
    }
    out.push(fenced ? "" : line.replace(/`[^`]*`/g, ""));
  }
  return out;
}

/**
 * roadmap 标记位置审计（#53，契约 v2.3；markers.md §2.5）：只在计划稿 H1 层合法——
 * 位于 H1 标题行之下、首个二级及以下标题或任务条目之前，且不在条目行上；多条合法标记首个生效、
 * 其余忽略（duplicates）。非法位置不生效（violations 供编译 diagnostics 与 --check 失败项，
 * 消息文本由调用方加路径/口径）。行内代码/围栏代码块中的示例不构成标记（stripCodeContext）。
 * 返回 { present, roadmap, duplicates, violations: [{lineIndex, message}] }。
 */
function auditRoadmap({ lines, h1Index = -1, entryLineIndexes = [] }) {
  const scanLines = stripCodeContext(lines);
  const occurrences = [];
  for (let i = 0; i < scanLines.length; i += 1) if (ROADMAP_MARKER_RE.test(scanLines[i])) occurrences.push(i);
  const violations = [];
  if (occurrences.length === 0) return { present: false, roadmap: false, duplicates: false, violations };
  const entries = entryLineIndexes instanceof Set ? entryLineIndexes : new Set(entryLineIndexes ?? []);
  let boundary = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    if (entries.has(i)) {
      boundary = i;
      break;
    }
    const m = HEADING_RE.exec(lines[i]);
    if (m && m[2].length >= 2 && h1Index >= 0 && i > h1Index) {
      boundary = i;
      break;
    }
  }
  const legal = [];
  for (const i of occurrences) {
    if (h1Index < 0) {
      violations.push({ lineIndex: i, message: "所在计划稿无 H1 标题行" });
      continue;
    }
    if (i <= h1Index) {
      violations.push({ lineIndex: i, message: "须位于 H1 标题行下方" });
      continue;
    }
    if (i >= boundary) {
      violations.push({ lineIndex: i, message: "位置无效（不在 H1 层：H1 之下、首个二级标题/任务条目之前）" });
      continue;
    }
    legal.push(i);
  }
  return { present: true, roadmap: legal.length > 0, duplicates: legal.length > 1, violations };
}

/**
 * 特性级引用行落点（#66，markers.md §3.1）：计划稿文件头号标记行（`<!-- zcode-board: no=N ... -->`）
 * 之后、首个非引用行之前——从标记行下一行起，连续的引用行（`> ...`）与 zcode-board 注释行
 * （号标记 / roadmap 独立注释）不打断落点；首个其它行（空行、正文、标题、任务条目）即落点结束。
 * 返回 lineIndex 行是否落在特性级落点内（调用方已确认该行是 `> cancelled:` 引用行）。
 */
function inFeatureQuoteRegion(lines, headLineIndex, lineIndex) {
  if (headLineIndex < 0 || lineIndex <= headLineIndex) return false;
  for (let j = headLineIndex + 1; j < lineIndex; j += 1) {
    const line = String(lines[j] ?? "");
    if (/^\s*>/.test(line)) continue;
    if (/<!--\s*zcode-board:/.test(line)) continue;
    return false;
  }
  return /^\s*>/.test(String(lines[lineIndex] ?? ""));
}

/**
 * 逐行解析任务条目（一个解析器，两种语法模式）：
 *   - plan：checkbox 与 T/任务 前缀条目；引用行归属上方最近条目（同缩进块内）；
 *   - tasks：仅编号 checkbox（`N.` 必填，避免把 Scope:/Changes: 子项误判为卡）；
 *     tasks.md 不引入引用族语法（真相源是 progress.json）：引用族行不解析 + diagnostics 逐行点名。
 * 返回 { entries, entryLineIndexes, headMarker, featureCancelled }——featureCancelled 为特性级
 * `> cancelled:`（#66：计划稿 H1 标记行之后的落点，见 inFeatureQuoteRegion；非计划稿恒 null）。
 */
function parseEntries({ lines, mode, fileRel, titleLineIndex, diag }) {
  const roots = [];
  const stack = [];
  const entryLineIndexes = new Set();
  let ordinal = 0;
  /** 特性级取消（#66）：首条有效者生效（与卡级同口径）。 */
  let featureCancelled = null;
  /** 计划稿章节（#46 B2 数据面）：最近一个二级及以下标题；spec 模式不产出 section。 */
  let currentSection = null;

  const add = (entry) => {
    while (stack.length > 0 && stack[stack.length - 1].indent >= entry.indent) stack.pop();
    const parent = stack[stack.length - 1] ?? null;
    if (parent) parent.children.push(entry);
    else roots.push(entry);
    stack.push(entry);
  };

  /** 引用族行（`> blocked:`/`> blocked-by:`/`> cancelled:`/`> agents:`）归属：上方最近条目（同缩进块内）。 */
  const ownerOf = (line) => {
    const indent = indentOf(line);
    while (stack.length > 0 && stack[stack.length - 1].indent > indent) stack.pop();
    return stack[stack.length - 1] ?? null;
  };

  // 文件级标记（仅计划稿有文件级标记；tasks.md 的号只在条目行行尾）。
  const headMarker =
    mode === "plan" ? findFileMarker(lines, (l) => Boolean(matchPlanEntry(stripLineEndMarker(l)))) : null;
  const headLineIndex = headMarker ? headMarker.lineIndex : -1;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (i === titleLineIndex) continue;
    const lineMarker = lineEndMarker(raw);
    const line = lineMarker ? stripLineEndMarker(raw) : raw;
    const match = mode === "plan" ? matchPlanEntry(line) : matchTasksEntry(line);

    if (match) {
      ordinal += 1;
      const entry = {
        indent: match.indent,
        lineIndex: i,
        checked: match.checked,
        title: match.title,
        sameLineBody: match.sameLineBody,
        selector: match.selector ?? `item-${ordinal}`,
        sourceNum: match.sourceNum ?? null,
        markerNo: lineMarker ? lineMarker.no : null,
        children: [],
        refs: [],
        cancelled: null,
        agents: null,
        section: currentSection,
      };
      entryLineIndexes.add(i);
      if (!lineMarker) {
        const stray = parseMarkers(raw);
        if (stray.length > 0) {
          diag(
            fileRel,
            `行内号标记未位于条目行行尾（第 ${i + 1} 行）：不附着任何卡（标记位置无效）。`,
          );
        }
      }
      add(entry);
      continue;
    }

    if (i !== headLineIndex && parseMarkers(raw).length > 0) {
      diag(fileRel, `行内号标记出现在非任务条目行（第 ${i + 1} 行）：不附着任何卡（标记位置无效）。`);
    }

    if (mode === "plan") {
      const ref = REF_RE.exec(raw);
      if (ref) {
        const owner = ownerOf(raw);
        if (!owner) {
          diag(fileRel, `引用行（第 ${i + 1} 行）上方无任务条目：语法位置无效，不挂卡。`);
        } else {
          owner.refs.push(parseReference(ref));
        }
        continue;
      }
      const cancel = CANCELLED_RE.exec(raw);
      if (cancel) {
        const owner = ownerOf(raw);
        if (owner) {
          if (owner.cancelled) {
            diag(fileRel, `条目「${owner.title}」出现多条 > cancelled: 行（第 ${i + 1} 行）：首条有效者生效，后者忽略（不静默改写）。`);
          } else {
            owner.cancelled = { reason: truncateDetails(stripRefSeparators(cancel[1])), lineIndex: i };
          }
        } else if (inFeatureQuoteRegion(lines, headLineIndex, i)) {
          // 特性级取消（#66）：H1 标记行后的落点内、上方无任务条目 → 取消的是计划稿特性本身。
          if (featureCancelled) {
            diag(fileRel, `计划稿出现多条特性级 > cancelled: 行（第 ${i + 1} 行）：首条有效者生效，后者忽略（不静默改写，markers.md §3.1）。`);
          } else {
            featureCancelled = { reason: truncateDetails(stripRefSeparators(cancel[1])), lineIndex: i };
          }
        } else {
          diag(fileRel, `取消行（第 ${i + 1} 行）上方无任务条目：语法位置无效，不挂卡（取消留痕不丢：请把 > cancelled: 置于目标条目下方同缩进块内，或置于特性级落点——计划稿 H1 标记行之后、首个非引用行之前，markers.md §3.1）。`);
        }
        continue;
      }
      const agents = AGENTS_RE.exec(raw);
      if (agents) {
        const content = agents[1].trim();
        const tokens = content === "" ? [] : content.split("|").map((s) => s.trim()).filter((s) => s !== "");
        const owner = ownerOf(raw);
        const invalid = tokens.filter((r) => !RUN_ROLES.includes(r));
        if (!owner) {
          diag(fileRel, `指派行（第 ${i + 1} 行）上方无任务条目：语法位置无效，不挂卡（> agents: 置于目标条目下方同缩进块内）。`);
        } else if (tokens.length === 0 || invalid.length > 0) {
          diag(
            fileRel,
            `> agents 行（第 ${i + 1} 行）${tokens.length === 0 ? "未给出角色" : `含表外角色 ${invalid.map((r) => JSON.stringify(r)).join("、")}`}（角色词表：${RUN_ROLES.join("|")}）：整行不解析，assignees 保持缺省标准管线 ${DEFAULT_ASSIGNEES.join("→")}（不猜、不静默）。`,
          );
        } else if (owner.agents) {
          diag(fileRel, `条目「${owner.title}」出现多条 > agents: 行（第 ${i + 1} 行）：首条有效者生效，后者忽略（不静默改写）。`);
        } else {
          owner.agents = tokens;
        }
        continue;
      }
      if (HEADING_RE.test(raw) || HR_RE.test(raw)) {
        stack.length = 0;
        if (mode === "plan" && HEADING_RE.test(raw)) {
          // 章节标题（一级及以上任意层，除文档标题行）：作为其后条目的 section（#46 B2）
          currentSection = HEADING_RE.exec(raw)[3].trim() || null;
        }
      }
    } else if (REF_RE.test(raw) || CANCELLED_RE.test(raw) || AGENTS_RE.test(raw)) {
      // markers.md §3/§7 反例表：tasks.md 不引入该语法族（spec 侧阻塞/取消真相源是 progress.json）——
      // 本行不解析、不挂任何卡，但必须 diagnostics 点名（宁误报不漏报，不静默）。
      diag(
        fileRel,
        `引用族行（第 ${i + 1} 行）：tasks.md 不引入该语法族：本行不解析（spec 侧阻塞真相源是 progress.json），不挂任何卡。`,
      );
    }
  }

  return { entries: roots, entryLineIndexes, headMarker, featureCancelled };
}

/** 引用行内容 → {kind, handle?, summary}；`> blocked:` 为 external，`> blocked-by:` 为 dependency。 */
function parseReference(match) {
  const isDependency = Boolean(match[1]);
  const content = match[2].trim();
  if (!isDependency) return { kind: "external", summary: content };
  const m = /^(\S+)\s*(.*)$/.exec(content);
  if (!m) return { kind: "dependency", handle: content, summary: "" };
  return { kind: "dependency", handle: m[1], summary: stripRefSeparators(m[2]) };
}

/** 条目块范围：下一个条目 / 标题 / 文末。 */
function nextBoundary(lines, startIndex, entryLineIndexes) {
  for (let j = startIndex + 1; j < lines.length; j += 1) {
    if (entryLineIndexes.has(j)) return j;
    if (HEADING_RE.test(lines[j])) return j;
  }
  return lines.length;
}

/** tasks.md 条目的 `Scope:`（→ details）与 `Requirements:`（→ requirements[]）。 */
function extractTasksFields(lines, entry, entryLineIndexes) {
  const end = nextBoundary(lines, entry.lineIndex, entryLineIndexes);
  let details = "";
  const requirements = [];
  for (let j = entry.lineIndex + 1; j < end; j += 1) {
    const text = lines[j].replace(/^\s*(?:[-*+]\s+)?/, "");
    const scope = /^Scope\s*[:：]\s*(.*)$/i.exec(text);
    if (scope && details === "") details = truncateDetails(scope[1]);
    const req = /^Requirements?\s*[:：]\s*(.*)$/i.exec(text);
    if (req) {
      for (const token of req[1].split(/[,\s、]+/)) {
        const t = token.trim();
        if (t !== "" && !requirements.includes(t)) requirements.push(t);
      }
    }
  }
  return { details, requirements };
}

/** plan 条目的 details：同行正文优先，其次条目块内正文首行（去 markdown 强调符）。 */
function extractPlanBody(lines, entry, entryLineIndexes) {
  const same = cleanInlineMarkup(entry.sameLineBody ?? "").replace(/^[:：]\s*/, "");
  if (same !== "") return truncateDetails(same);
  const end = nextBoundary(lines, entry.lineIndex, entryLineIndexes);
  for (let j = entry.lineIndex + 1; j < end; j += 1) {
    const raw = lines[j];
    if (raw.trim() === "") continue;
    if (entryLineIndexes.has(j)) return "";
    if (HEADING_RE.test(raw) || REF_RE.test(raw)) return "";
    return truncateDetails(raw);
  }
  return "";
}

// ---------------------------------------------------------------- 特性节点构造

function makeFeatureNode(fields) {
  const node = {
    id: fields.id,
    kind: fields.kind,
    title: fields.title,
    details: fields.details ?? "",
    status: fields.status,
    statusRule: fields.statusRule,
    origin: fields.origin,
    progress: fields.progress ?? null,
    evidence: fields.evidence ?? [],
    createdAt: fields.createdAt ?? nowIso(),
    updatedAt: fields.updatedAt ?? fields.createdAt ?? nowIso(),
    tasks: [],
    attention: [],
  };
  META_STORE.set(node, {
    kind: fields.kind,
    sourcePath: fields.sourcePath,
    diagPath: fields.diagPath ?? fields.sourcePath,
    markerNo: fields.markerNo ?? null,
    registryKey: fields.registryKey ?? null,
    /** roadmap 占位稿（#53，契约 v2.3）：仅计划稿可置 true（位置审计见 auditRoadmap）。 */
    roadmap: Boolean(fields.roadmap),
    tasks: node.tasks,
    interviewId: null,
    detailsFromInterview: null,
    progressData: fields.progressData ?? null,
    specFiles: fields.specFiles ?? null,
    activityAt: fields.activityAt ?? null,
  });
  return node;
}

function makeTaskNode(fields) {
  const node = {
    title: fields.title,
    details: fields.details ?? "",
    status: fields.status,
    statusRule: fields.statusRule,
    source: fields.source,
    origin: fields.origin,
    requirements: fields.requirements ?? [],
    evidence: [],
    /** 指派管线（契约 v2.1：顺序即管线序；缺省=标准管线 implementer→test-verifier→code-reviewer→integrator）。 */
    assignees: Array.isArray(fields.assignees) && fields.assignees.length > 0 ? [...fields.assignees] : [...DEFAULT_ASSIGNEES],
    draft: Boolean(fields.draft),
    blockers: [],
    attention: [],
    lastRun: null,
    activeRun: null,
    worktree: null,
    pr: null,
    createdAt: fields.createdAt ?? nowIso(),
    updatedAt: fields.updatedAt ?? fields.createdAt ?? nowIso(),
  };
  META_STORE.set(node, {
    sourcePath: fields.source.file,
    diagPath: fields.source.file,
    sourceNum: fields.sourceNum ?? null,
    markerNo: fields.markerNo ?? null,
    refs: fields.refs ?? [],
    blockers: node.blockers,
    tasks: [],
    interviewId: null,
    checked: Boolean(fields.checked),
    runState: null,
    /** 计划稿章节（#46 B2 数据面）：仅计划任务可能非空；spec 任务恒 null。 */
    section: fields.section ?? null,
  });
  return node;
}

function allTasks(feature) {
  const out = [];
  const walk = (list) => {
    for (const t of list) {
      out.push(t);
      walk(META(t).tasks);
    }
  };
  walk(META(feature).tasks);
  return out;
}

// ---------------------------------------------------------------- 计划稿 → 特性节点

function parsePlanFeature(plan, diag) {
  const identity = planIdentity(plan);
  const read = readTextFile(plan.abs);
  const mtime = mtimeIso(plan.abs);

  if (!read.ok) {
    diag(plan.rel, `计划稿读取失败（${read.error ?? "不存在"}）：子树降级保留标题与 mtime，状态未知。`);
    return makeFeatureNode({
      id: identity.id,
      kind: "plan",
      title: plan.stem,
      status: "pending",
      statusRule: DEGRADED_RULE,
      origin: { type: "plan-session", planRef: plan.rel },
      evidence: [plan.rel],
      createdAt: mtime,
      updatedAt: mtime,
      sourcePath: plan.rel,
    });
  }

  const text = read.text;
  const lines = text.split(/\r?\n/);
  const headingLine = lines.findIndex((l) => HEADING_RE.test(l));
  const title = sanitizeDocHeading(headingLine >= 0 ? HEADING_RE.exec(lines[headingLine])[3] : "") || plan.stem;

  const { entries, entryLineIndexes, headMarker, featureCancelled } = parseEntries({
    lines,
    mode: "plan",
    fileRel: plan.rel,
    titleLineIndex: headingLine,
    diag,
  });

  // roadmap 占位稿标记（#53，契约 v2.3）：只在 H1 层合法；非法位置不生效 + diagnostics（不静默）。
  const roadmapFacts = auditRoadmap({
    lines,
    h1Index: lines.findIndex((l) => H1_RE.test(l)),
    entryLineIndexes,
  });
  for (const v of roadmapFacts.violations) {
    diag(
      plan.rel,
      `roadmap 标记（第 ${v.lineIndex + 1} 行）：${v.message}——该标记不生效（只在计划稿 H1 层合法，markers.md v2.3 §2.5）。`,
    );
  }
  if (roadmapFacts.duplicates) {
    diag(plan.rel, "roadmap 标记出现多条（合法位置）：首个有效者生效，其余忽略（不静默，契约 v2.3）。");
  }

  const buildTask = (entry) => {
    const taskStatus = entry.cancelled
      ? {
          status: "cancelled",
          statusRule:
            entry.cancelled.reason !== ""
              ? `plan 条目已取消（> cancelled: ${entry.cancelled.reason}；取消留痕、号不复用）`
              : "plan 条目已取消（> cancelled 未记原因；取消留痕、号不复用）",
        }
      : derivePlanTaskStatus({ checked: entry.checked });
    const node = makeTaskNode({
      title: entry.title,
      details: extractPlanBody(lines, entry, entryLineIndexes),
      status: taskStatus.status,
      statusRule: taskStatus.statusRule,
      source: { file: plan.rel, selector: entry.selector },
      origin: { planRef: plan.rel },
      draft: true,
      checked: entry.checked,
      markerNo: entry.markerNo,
      sourceNum: entry.sourceNum,
      refs: entry.refs,
      assignees: entry.agents,
      section: entry.section,
      createdAt: mtime,
      updatedAt: mtime,
    });
    META(node).tasks = entry.children.map(buildTask);
    return node;
  };

  const tasks = entries.map(buildTask);
  const hasChecked = entries.some((e) => e.checked);
  // 特性级取消（#66，markers.md §3.1）：取消优先于勾选（与卡级同口径）——特性 status=cancelled。
  const featureStatus = featureCancelled
    ? {
        status: "cancelled",
        statusRule:
          featureCancelled.reason !== ""
            ? `计划稿已取消（> cancelled: ${featureCancelled.reason}；取消留痕、条目保留、号不复用）`
            : "计划稿已取消（> cancelled 未记原因；取消留痕、条目保留、号不复用）",
      }
    : derivePlanFeatureStatus({ hasChecked });
  const feature = makeFeatureNode({
    id: identity.id,
    kind: "plan",
    title,
    status: featureStatus.status,
    statusRule: featureStatus.statusRule,
    origin: identity.sessionId
      ? { type: "plan-session", sessionId: identity.sessionId }
      : { type: "plan-session", planRef: plan.rel },
    evidence: [plan.rel],
    createdAt: mtime,
    updatedAt: mtime,
    sourcePath: plan.rel,
    markerNo: headMarker ? headMarker.no : null,
    registryKey: { kind: "plan", file: plan.rel },
    roadmap: roadmapFacts.roadmap,
  });
  META(feature).tasks = tasks;
  feature.tasks = tasks;
  return feature;
}

// ---------------------------------------------------------------- spec → 特性节点

function parseSpecFeature(spec, diag) {
  const primaryPath = spec.files.includes("progress.json")
    ? `${spec.rel}progress.json`
    : `${spec.rel}tasks.md`;

  let progressData = null;
  let degraded = false;
  if (spec.files.includes("progress.json")) {
    const loaded = readJsonFile(join(spec.abs, "progress.json"));
    if (loaded.ok) {
      if (loaded.value && typeof loaded.value === "object" && loaded.value.version === 3) {
        progressData = loaded.value;
      } else {
        degraded = true;
        diag(
          primaryPath,
          `progress.json version=${JSON.stringify(loaded.value?.version ?? null)} 不受支持（v3 为准）：子树降级保留标题与 mtime，状态未知。`,
        );
      }
    } else {
      degraded = true;
      diag(
        primaryPath,
        `progress.json 解析失败（${loaded.error}）：子树降级保留标题与 mtime，状态未知。`,
      );
    }
  }

  let title = null;
  for (const name of SPEC_TITLE_FILES) {
    if (!isFile(join(spec.abs, name))) continue;
    const t = readTextFile(join(spec.abs, name));
    if (!t.ok) continue;
    const h = firstHeading(t.text);
    if (h) {
      title = sanitizeDocHeading(h);
      break;
    }
  }
  if (!title && progressData && typeof progressData.feature === "string" && progressData.feature.trim() !== "") {
    title = progressData.feature.trim();
  }
  if (!title) title = spec.dir;

  const mtimes = spec.files.map((f) => mtimeIso(join(spec.abs, f))).filter((t) => t != null);
  const newest = mtimes.length > 0 ? mtimes.sort().at(-1) : null;

  let tasks = [];
  if (spec.files.includes("tasks.md")) {
    const loaded = readTextFile(join(spec.abs, "tasks.md"));
    if (loaded.ok) {
      const lines = loaded.text.split(/\r?\n/);
      // roadmap 标记（#53，契约 v2.3）：tasks.md 不引入该标记（只在计划稿 H1 层合法）——逐行点名，不解析。
      // 行内代码/围栏代码块中的示例不构成标记（文档可安全引用语法）。
      const roadmapScan = stripCodeContext(lines);
      for (let i = 0; i < roadmapScan.length; i += 1) {
        if (ROADMAP_MARKER_RE.test(roadmapScan[i])) {
          diag(
            `${spec.rel}tasks.md`,
            `roadmap 标记（第 ${i + 1} 行）：tasks.md 不引入该标记（只在计划稿 H1 层合法，markers.md v2.3 §2.5）——本行不解析，不挂任何卡。`,
          );
        }
      }
      const headingLine = lines.findIndex((l) => HEADING_RE.test(l));
      const parsed = parseEntries({
        lines,
        mode: "tasks",
        fileRel: `${spec.rel}tasks.md`,
        titleLineIndex: headingLine,
        diag,
      });
      const buildTask = (entry) => {
        const fields = extractTasksFields(lines, entry, parsed.entryLineIndexes);
        const taskStatus = deriveTaskStatus({ checked: entry.checked });
        const node = makeTaskNode({
          title: entry.title,
          details: fields.details,
          status: taskStatus.status,
          statusRule: taskStatus.statusRule,
          source: { file: `${spec.rel}tasks.md`, selector: entry.selector },
          origin: { specRoot: spec.rel },
          requirements: fields.requirements,
          draft: false,
          checked: entry.checked,
          markerNo: entry.markerNo,
          sourceNum: entry.sourceNum,
          refs: [],
          createdAt: mtimeIso(join(spec.abs, "tasks.md")),
          updatedAt: mtimeIso(join(spec.abs, "tasks.md")),
        });
        META(node).tasks = entry.children.map(buildTask);
        return node;
      };
      tasks = parsed.entries.map(buildTask);
    } else {
      degraded = true;
      diag(`${spec.rel}tasks.md`, `tasks.md 读取失败（${loaded.error ?? "不存在"}）：子树降级保留标题与 mtime，状态未知。`);
    }
  }

  const flat = [];
  const collectFlat = (list) => {
    for (const t of list) {
      flat.push(t);
      collectFlat(META(t).tasks);
    }
  };
  collectFlat(tasks);

  // §4.2：current.stage == "execution" 且 current.title 与任务标题精确匹配或含 N. 前缀 → 该卡 active；
  // 匹配不上就不标（不为对齐四词汇而编造源里没有的状态）。
  const current = progressData?.current;
  if (current && current.stage === "execution" && typeof current.title === "string") {
    for (const t of flat) {
      if (!summaryMatchesTask(current.title, t)) continue;
      const matched = deriveTaskStatus({ checked: META(t).checked, currentMatch: true });
      t.status = matched.status;
      t.statusRule = matched.statusRule;
    }
  }

  const execution = progressData?.execution;
  const progress =
    execution && Number.isInteger(execution.totalTasks) && Number.isInteger(execution.completedTasks)
      ? { totalTasks: execution.totalTasks, completedTasks: execution.completedTasks }
      : null;

  if (progressData && (!progressData.stages || typeof progressData.stages !== "object" || Object.keys(progressData.stages).length === 0)) {
    diag(primaryPath, "progress.json 无 stages 对象：特性状态按 §4.3 规则 1 兜底 pending（不静默）。");
  }

  const activityAt = (Array.isArray(progressData?.activity) ? progressData.activity : [])
    .map((a) => (a && typeof a === "object" && typeof a.at === "string" ? a.at : null))
    .filter((at) => at != null && ISO_RE.test(at))
    .reduce((best, at) => maxIso(best, at), null);

  const featureStatus = degraded
    ? { status: "pending", statusRule: DEGRADED_RULE }
    : deriveSpecFeatureStatus({
        progress: progressData,
        hasTasksDoc: spec.files.includes("tasks.md"),
        tasks: flat.map((t) => ({ checked: META(t).checked })),
      });

  const feature = makeFeatureNode({
    id: `spec:${spec.dir}`,
    kind: "spec",
    title,
    status: featureStatus.status,
    statusRule: featureStatus.statusRule,
    origin: { type: "spec-driven-workflow", specRoot: spec.rel },
    progress,
    evidence: spec.files.map((f) => `${spec.rel}${f}`),
    createdAt: newest,
    updatedAt: newest,
    sourcePath: spec.rel,
    diagPath: primaryPath,
    registryKey: { kind: "spec", specRoot: spec.rel },
    progressData,
    specFiles: [...spec.files],
    activityAt,
  });
  META(feature).tasks = tasks;
  feature.tasks = tasks;
  return feature;
}

// ---------------------------------------------------------------- 登记簿归一

/** 读取登记簿（缺失 = 空登记簿，§12）：结构/解析失败 → diagnostics + 空登记簿（不静默）。 */
function loadInterviews(root, interviewsRel, diag) {
  let interviews = [];
  const loaded = readJsonFile(join(root, interviewsRel));
  if (loaded.ok) {
    if (Array.isArray(loaded.value?.interviews)) interviews = loaded.value.interviews;
    else diag(interviewsRel, "interviews.json 结构不合法（缺少 interviews 数组）：按空登记簿处置，状态未知。");
  } else if (!loaded.missing) {
    diag(interviewsRel, `interviews.json 解析失败（${loaded.error}）：按空登记簿处置，状态未知。`);
  }
  return interviews;
}

function makeInterviewOnlyNode(itw, interviewsRel, fallbackAt) {
  const id = String(itw.id).trim();
  const topic = typeof itw.topic === "string" && itw.topic.trim() !== "" ? itw.topic.trim() : null;
  const summary = typeof itw.summary === "string" ? itw.summary.trim() : "";
  const decision = Array.isArray(itw.decisions) && typeof itw.decisions[0] === "string" ? itw.decisions[0].trim() : "";
  const title = topic ?? (summary !== "" ? truncateDetails(summary) : id);
  const at = typeof itw.at === "string" && ISO_RE.test(itw.at) ? itw.at : fallbackAt;
  const openish = (itw.status ?? "open") === "open" && (itw.outcome ?? "none") === "none";
  return makeFeatureNode({
    id: `interview:${id}`,
    kind: "interview-only",
    title,
    details: truncateDetails(summary !== "" ? summary : decision),
    status: "pending",
    statusRule: openish
      ? "interview.status=open 且 outcome=none（无产物）"
      : "登记条目产物缺失/未落盘：退回 interview-only（§12）",
    origin: { type: "interview", interviewId: id },
    evidence: [`${interviewsRel}#${id}`],
    createdAt: at,
    updatedAt: at,
    sourcePath: interviewsRel,
    diagPath: interviewsRel,
  });
}

/**
 * 登记簿归一（§4.2）：resolvedBy 命中的条目与特性节点合并（回填 origin.interviewId + details）；
 * 未命中且无产物 → interview-only 节点；resolvedBy/artifacts 指向缺失 → 退回 interview-only + diagnostics。
 */
function mergeInterviews(features, root, interviewsRel, interviews, diag) {
  const byId = new Map(features.map((f) => [f.id, f]));
  const bySource = new Map(
    features.filter((f) => META(f).sourcePath !== interviewsRel).map((f) => [META(f).sourcePath, f]),
  );
  const fallbackAt = mtimeIso(join(root, interviewsRel));

  for (const itw of interviews) {
    if (!itw || typeof itw !== "object") {
      diag(interviewsRel, "登记条目不是对象：跳过该条目（不猜身份）。");
      continue;
    }
    const id = typeof itw.id === "string" ? itw.id.trim() : "";
    if (id === "") {
      diag(interviewsRel, "登记条目缺少 id：跳过该条目（不猜身份）。");
      continue;
    }
    const artifacts = Array.isArray(itw.artifacts) ? itw.artifacts.filter((a) => typeof a === "string") : [];
    const missing = artifacts.filter((a) => !isFile(join(root, a)));

    let target = typeof itw.resolvedBy === "string" ? byId.get(itw.resolvedBy) ?? null : null;
    if (!target) {
      for (const a of artifacts) {
        const hit = bySource.get(a);
        if (hit) {
          target = hit;
          break;
        }
      }
    }

    const summary = typeof itw.summary === "string" ? itw.summary.trim() : "";
    const decision = Array.isArray(itw.decisions) && typeof itw.decisions[0] === "string" ? itw.decisions[0].trim() : "";
    const details = summary !== "" ? summary : decision;

    if (target) {
      META(target).interviewId = id;
      META(target).detailsFromInterview = truncateDetails(details);
      for (const t of allTasks(target)) META(t).interviewId = id;
      continue;
    }

    features.push(makeInterviewOnlyNode(itw, interviewsRel, fallbackAt));
    if (typeof itw.resolvedBy === "string" && itw.resolvedBy !== "") {
      diag(
        interviewsRel,
        `登记条目 ${id} 的 resolvedBy=${JSON.stringify(itw.resolvedBy)} 指向的特性节点不存在：退回 interview-only（§12，产物丢失事实回归可见）。`,
      );
    } else if (missing.length > 0) {
      diag(
        interviewsRel,
        `登记条目 ${id} 的 artifacts 文件不存在（${missing.join("、")}）：退回 interview-only（§12）。`,
      );
    }
  }
}

// ---------------------------------------------------------------- 计划→spec 延续

/**
 * 计划→spec 延续（设计 §1.1 ④/§3.2）：登记条目 resolvedBy 指向某 spec 节点、且其 artifacts
 * 含已领号计划稿时，该计划稿节点退役（不再作为独立节点），计划稿路径降为该 spec 的
 * origin.planRef 证据（golden 形态）；号由 registry 条目改写延续（--assign 执行；编译只按
 * 既有证据退役节点，不猜、不写）。返回过滤后的特性列表；无延续时原样返回。
 */
function applyContinuations(features, interviews) {
  const planByPath = new Map();
  const specById = new Map();
  for (const f of features) {
    const meta = META(f);
    if (meta.kind === "plan") planByPath.set(meta.sourcePath, f);
    if (meta.kind === "spec") specById.set(f.id, f);
  }
  const superseded = new Set();
  for (const itw of interviews ?? []) {
    if (!itw || typeof itw !== "object") continue;
    const resolvedBy = typeof itw.resolvedBy === "string" ? itw.resolvedBy.trim() : "";
    if (resolvedBy === "") continue;
    const spec = specById.get(resolvedBy);
    if (!spec) continue;
    if (META(spec).planRef != null) continue;
    const artifacts = Array.isArray(itw.artifacts) ? itw.artifacts.filter((a) => typeof a === "string") : [];
    for (const a of artifacts) {
      const plan = planByPath.get(a);
      if (!plan) continue;
      META(spec).planRef = a;
      superseded.add(a);
      break;
    }
  }
  if (superseded.size === 0) return features;
  return features.filter((f) => !superseded.has(META(f).sourcePath));
}

// ---------------------------------------------------------------- 号与标签

function findRegistryEntry(registry, key) {
  if (!registry || !Array.isArray(registry.entries)) return null;
  for (const e of registry.entries) {
    if (!e || typeof e !== "object") continue;
    if (key.kind === "spec" && e.kind === "spec" && e.specRoot === key.specRoot) return e;
    if (key.kind === "plan" && e.kind === "plan" && e.file === key.file) return e;
  }
  return null;
}

/**
 * 号归一（§3.2/§3.4 裁决序：源头标记 > registry > 派生板）：
 *   文件头/行尾标记为身份真相；标记缺省时用 registry 条目兜底；
 *   重复号：先扫者保留、后到者按未领号降级 + diagnostics（不静默改写，--check 非零退出归 T10）。
 * 扫描顺序：specs 字典序 → 计划目录（PLAN_DIRS 序）文件名字典序 → 文件内文档序。
 */
function resolveNumbers(features, registry, diag) {
  const claimed = new Map();

  const claim = (node, no, holder) => {
    if (!Number.isInteger(no) || no < 1) return false;
    const meta = META(node);
    if (claimed.has(no)) {
      diag(
        meta.diagPath,
        `号 ${no} 重复（${holder} 与已持有的 ${claimed.get(no)} 冲突）：后到者按未领号降级，不静默改写，待人工修。`,
      );
      return false;
    }
    claimed.set(no, holder);
    meta.no = no;
    return true;
  };

  for (const f of features) {
    const meta = META(f);
    if (meta.kind === "interview-only") continue; // 访谈登记不占号（§3.2）
    let no = meta.markerNo;
    let holder = `${meta.sourcePath}（源头标记）`;
    if (!Number.isInteger(no) && meta.registryKey && registry) {
      const entry = findRegistryEntry(registry, meta.registryKey);
      if (entry && Number.isInteger(entry.no)) {
        no = entry.no;
        holder = `${meta.sourcePath}（registry 条目）`;
      }
    }
    claim(f, no, holder);
    for (const t of allTasks(f)) {
      const tm = META(t);
      claim(t, tm.markerNo, `${tm.sourcePath}（行尾标记）`);
    }
  }

  for (const f of features) {
    const meta = META(f);
    if (meta.kind === "interview-only") continue;
    if (meta.no == null) {
      diag(
        meta.diagPath,
        meta.kind === "spec"
          ? "spec 特性号未在 registry 绑定（spec 根为键，无内联标记）：按未领号上板，运行 --assign 补号。"
          : "计划稿未领号（文件头无 zcode-board: no=N 标记）：按未领号上板，运行 --assign 补号。",
      );
    }
    for (const t of allTasks(f)) {
      const tm = META(t);
      if (tm.no == null) {
        diag(tm.diagPath, "条目未领号（行尾无 zcode-board: no=N 标记）：按未领号上板，运行 --assign 补号。");
      }
    }
  }
}

// ---------------------------------------------------------------- 计划码（planCode，#46）

/**
 * 计划码冻结形态（契约 v2.2）：4 位、首字符字母、其余大写字母数字（如 IMPL/UI01/DREM/PREV）。
 * 计划码是**额外显示层**：全局序列号（no）不变，计划码不进入任何引用位。
 */
export const PLAN_CODE_RE = /^[A-Z][A-Z0-9]{3}$/;

/** 派生用停用词（无区分度的通用词不参与取词）。 */
const PLAN_CODE_STOPWORDS = new Set(["plan", "the", "and", "for", "with"]);
const PLAN_CODE_SESSION_TOKEN_RE = /^(sess|session)$/i;
/** 会话 id / uuid 片段（纯十六进制串，≥4 位）不是有意义的词。 */
const planCodeHexLike = (token) => /^[0-9a-f]{4,}$/i.test(token);
const planCodeLetters = (token) => String(token).replace(/[^A-Za-z0-9]/g, "").toUpperCase();

function planCodeTokensFromName(fileStem) {
  const stem = String(fileStem ?? "");
  // 会话稿文件名（plan-sess_<uuid>）本身无有意义的词：交给标题兜底。
  if (/^plan[-_]sess[-_]/i.test(stem)) return [];
  return stem
    .replace(/^plan[-_]/i, "")
    .split(/[-_.]+/)
    .filter((part) => {
      const letters = planCodeLetters(part);
      return (
        part.length >= 2 &&
        /[A-Za-z]/.test(part) &&
        letters.length >= 2 &&
        !PLAN_CODE_SESSION_TOKEN_RE.test(part) &&
        !planCodeHexLike(part)
      );
    });
}

function planCodeTokensFromTitle(title) {
  return (String(title ?? "").match(/[A-Za-z][A-Za-z0-9]*/g) ?? []).filter(
    (word) =>
      word.length >= 2 &&
      !PLAN_CODE_STOPWORDS.has(word.toLowerCase()) &&
      !planCodeHexLike(word),
  );
}

/** djb2 → base36 取末 2 位（大写）——哈希兜底的可读性形态：PL + 2 位。 */
function planCodeHash2(seed) {
  let h = 5381;
  for (const ch of String(seed)) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
  return h.toString(36).toUpperCase().padStart(2, "0").slice(-2);
}

/**
 * 计划码派生（纯函数，确定性；#46 A1）：
 *   1. 取词：文件名（去掉 plan- 前缀，末段更具体者优先）→ 标题首个 ASCII 词兜底；
 *   2. 成码：词 ≥4 字符 → 前 4 字母；3 字符 → 词+1 位序号；2 字符 → 词+2 位序号（01 起）；
 *   3. 无词 → `PL` + 两位哈希兜底；
 *   4. `taken` 命中 → 序号递增 / 末位替换 / 哈希顺延，仍冲突继续（确定性，不抛错）。
 * 期望值来源：契约 v2.2「计划码 = 4 位字母数字，从标题/文件名派生」+ 用户示例 IMPL/UI01/DREM/PREV。
 */
export function derivePlanCode({ file, title, taken = new Set() }) {
  const occupied = taken instanceof Set ? taken : new Set(taken ?? []);
  const stem = String(file ?? "")
    .split("/")
    .pop()
    .replace(/\.[^.]*$/, "");
  const nameTokens = planCodeTokensFromName(stem);
  const titleTokens = planCodeTokensFromTitle(title);
  const token = nameTokens.length > 0 ? nameTokens[nameTokens.length - 1] : (titleTokens[0] ?? null);
  const hashFallback = () => {
    for (let n = 0; n < 100; n += 1) {
      const cand = `PL${planCodeHash2(n === 0 ? stem : `${stem}#${n}`)}`;
      if (!occupied.has(cand)) return cand;
    }
    return `PL${planCodeHash2(stem)}`;
  };
  if (token == null) return hashFallback();
  const letters = planCodeLetters(token);
  if (letters.length < 2) return hashFallback();
  if (letters.length >= 4) {
    const base = letters.slice(0, 4);
    if (!occupied.has(base)) return base;
    for (const d of "234567890") {
      const cand = `${base.slice(0, 3)}${d}`;
      if (!occupied.has(cand)) return cand;
    }
    return hashFallback();
  }
  const width = 4 - letters.length;
  for (let n = 1; n < 10 ** width; n += 1) {
    const cand = `${letters}${String(n).padStart(width, "0")}`;
    if (!occupied.has(cand)) return cand;
  }
  return hashFallback();
}

/**
 * label 树位派生（§4.2；#46 A2 改造）：
 *   特性 label = 稳定号字符串（不变）；
 *   任务 label：**计划特性 → 计划内层级路径**（顶层 1..n、子 = `<父>.<序>`，如 1 / 1.2 / 1.2.1
 *   ——与 planCode 组合成完整显示形态 `IMPL-1.2`，保证项目内唯一）；spec 特性 → `<特性号>.<序>`
 *   （首段 = 特性稳定号，保持既有约定）。
 *   §2.4 过渡态：特性未领号时不派生任何任务 label（卡可保留 no）。
 * 全局稳定号 no、registry 与 blocked-by 引用一律不变（label 是显示层，绝不进入引用位）。
 */
function deriveLabels(features) {
  for (const f of features) {
    const meta = META(f);
    const featureLabel = meta.no == null ? null : String(meta.no);
    if (featureLabel != null) meta.label = featureLabel;
    const planInternal = meta.kind === "plan";
    const walk = (tasks, parentLabel) => {
      tasks.forEach((t, index) => {
        const tm = META(t);
        let label = null;
        if (featureLabel != null) {
          if (planInternal) {
            label = parentLabel == null ? String(index + 1) : `${parentLabel}.${index + 1}`;
          } else if (parentLabel != null) {
            label = `${parentLabel}.${index + 1}`;
          }
        }
        if (label != null) tm.label = label;
        walk(tm.tasks, label);
      });
    };
    walk(meta.tasks, planInternal ? null : featureLabel);
  }
}

/**
 * 引用位解析（markers.md §3–§4 + §12；引用有效性判据=板上活条目，勘误 9d）：
 *   - external → {kind, summary, evidence}；
 *   - dependency：句柄归一为整数；层级标签形态 → 拒收（blockedBy 缺省）+ diagnostics；
 *     目标号不在板上活条目 → 不造引用（blockedBy 缺省、summary 原文保留）+ diagnostics；
 *     两情形用独立文案（勘误 9d）：目标号 ∈ registry 条目号集合 → 文案 A（registry 有条目
 *     而板上无，提示检查目标是否已归档/未上板）；不属于 → 文案 B（完全未知号，提示核对句柄）。
 */
function resolveBlockers(features, registry, diag) {
  const live = new Set();
  const registryNos = new Set();
  for (const e of registry?.entries ?? []) {
    if (Number.isInteger(e?.no)) registryNos.add(e.no);
  }
  for (const f of features) {
    const fm = META(f);
    if (fm.no != null) live.add(fm.no);
    for (const t of allTasks(f)) {
      const tm = META(t);
      if (tm.no != null) live.add(tm.no);
    }
  }

  for (const f of features) {
    for (const t of allTasks(f)) {
      const meta = META(t);
      for (const ref of meta.refs) {
        if (ref.kind === "external") {
          meta.blockers.push({ kind: "external", summary: ref.summary, evidence: [meta.sourcePath] });
          continue;
        }
        const normalized = normalizeHandle(ref.handle);
        if (normalized == null) {
          meta.blockers.push({ kind: "dependency", summary: ref.summary, evidence: [meta.sourcePath] });
          diag(
            meta.sourcePath,
            `blocked-by 写法 ${JSON.stringify(ref.handle)} 是层级标签（标签不是句柄）：不解析为引用（blockedBy 缺省），请改用稳定号。`,
          );
          continue;
        }
        if (!live.has(normalized)) {
          meta.blockers.push({ kind: "dependency", summary: ref.summary, evidence: [meta.sourcePath] });
          diag(
            meta.sourcePath,
            registryNos.has(normalized)
              ? `blocked-by 目标号 ${normalized} 在 registry 有条目但不在本次编译的板上：按 §12 不造引用（blockedBy 缺省）——目标可能已归档或未上板（勘误 9d），请核对目标特性是否仍在扫描目录。`
              : `blocked-by 目标号 ${normalized} 是未知号（不在板上且 registry 无此号）：按 §12 不造引用（blockedBy 缺省）——请核对句柄写法（9/#9/ID-9 编译期归一为稳定号，勘误 9d）。`,
          );
          continue;
        }
        meta.blockers.push({
          kind: "dependency",
          blockedBy: normalized,
          summary: ref.summary,
          evidence: [meta.sourcePath],
        });
      }
    }
  }
}

/** progress.json blocker 与任务标题匹配（§4.2）：精确匹配或含 `N.` 前缀 → 挂该任务卡；否则只升特性级。 */
function summaryMatchesTask(summary, task) {
  const s = String(summary ?? "").trim();
  const meta = META(task);
  if (s === task.title) return true;
  const m = /^(\d+)\.\s*(.*)$/.exec(s);
  if (m && meta.sourceNum != null && String(meta.sourceNum) === m[1]) {
    const rest = m[2].trim();
    return rest === task.title || rest.startsWith(task.title);
  }
  return false;
}

function attachProgressBlockers(feature, progressData, progressRel) {
  const list = Array.isArray(progressData?.blockers) ? progressData.blockers : [];
  const tasks = allTasks(feature);
  for (const b of list) {
    if (!b || typeof b !== "object") continue;
    const summary = typeof b.summary === "string" ? b.summary.trim() : "";
    if (summary === "") continue;
    const target = tasks.find((t) => summaryMatchesTask(summary, t));
    if (!target) continue;
    META(target).blockers.push({ kind: "external", summary, evidence: [progressRel] });
  }
}

// ---------------------------------------------------------------- 产物组装

function finalizeTask(node, roadmap = false) {
  const meta = META(node);
  const runState = meta.runState;
  const out = {};
  if (meta.no != null) {
    out.no = meta.no;
    // §2.4 过渡态（未领号特性下的带号卡）：label 缺省时不得留 undefined 形参位——序列化会丢弃该键，
    // 留键会让 --check 板/源互检误报"板上缺少该字段"，并被结构断言误判为"带 label 的任务卡"（#43）。
    if (meta.label !== undefined) out.label = meta.label;
  }
  out.title = node.title;
  out.details = node.details;
  out.status = node.status;
  out.statusRule = node.statusRule;
  // 段位（#53 契约 v2.3；#66 终态优先序）：roadmap 占位稿的卡恒为待设计（本稿条目本身不执行）——
  // status/勾选/执行记录照常派生，只压制段位；但 status=cancelled 为终态，压制对其让位
  // （对齐 deriveStage 的 cancelled 分支次序：取消 > 其他）。
  let stage;
  if (roadmap && node.status !== "cancelled") {
    stage = { stage: STAGE.DESIGN, stageRule: ROADMAP_TASK_STAGE_RULE };
  } else {
    const derived = deriveStage(node.status, runState?.activeRun ?? null, node.attention);
    stage = roadmap
      ? { stage: derived.stage, stageRule: `${derived.stageRule} · ${CANCELLED_OVER_ROADMAP_NOTE}` }
      : derived;
  }
  out.stage = stage.stage;
  out.stageRule = stage.stageRule;
  out.source = node.source;
  // 计划稿章节（#46 B2）：有计划章节才写字段（spec 任务与章节前条目无该字段，UI 按 null 处理）。
  if (meta.section != null) out.section = meta.section;
  out.origin = meta.interviewId ? { ...node.origin, interviewId: meta.interviewId } : node.origin;
  out.requirements = node.requirements;
  out.evidence = node.evidence;
  out.assignees = node.assignees;
  out.draft = node.draft;
  out.blockers = meta.blockers;
  out.attention = node.attention;
  out.lastRun = runState?.lastRun ?? null;
  out.activeRun = runState?.activeRun ?? null;
  // 当前执行者（#46 A3）：管线 ∩ activeRun；无则 null（字段恒写出，UI 无第三种形态）
  out.currentAssignee = deriveCurrentAssignee({
    assignees: node.assignees,
    activeRun: runState?.activeRun ?? null,
  });
  // 下一接手人（#53，契约 v2.3）：assignees 序中首个无 done run 证据的角色（该卡归一后 runs 记录）；
  // 全部有 done 证据（含 integrator done=已合并）→ null；无号卡无 run 记录 → 管线首角色。
  out.nextAssignee = deriveNextAssignee({
    assignees: node.assignees,
    records: meta.runsRecords ?? [],
  });
  out.worktree = runState?.worktree ?? null;
  out.pr = runState?.pr ?? null;
  out.createdAt = node.createdAt;
  out.updatedAt = node.updatedAt;
  if (meta.tasks.length > 0) out.tasks = meta.tasks.map((t) => finalizeTask(t, roadmap));
  return out;
}

/**
 * 特性段位（#53 契约 v2.3；#66 终态优先序）：
 *   - 特性自身取消标记（#66：> cancelled: 特性级落点 → status=cancelled）：段位已取消——
 *     终态优先于 roadmap 压制与子卡汇总；
 *   - roadmap 占位稿：段位恒待设计（本稿条目本身不执行）；
 *   - plan：随子卡汇总——全部子卡 completed → 已完成（stageRule 记 N/M）；
 *     否则移除 arranged-not-expanded 后按 §4.3 原推导（active→执行中 / pending→待办）；
 *     零卡且缺口 → 待设计（有卡不再因"计划稿卡恒为 draft"被缺口压制）；
 *   - spec / interview-only：deriveStage 原推导不变。
 */
function finalizeFeatureStage(node) {
  const meta = META(node);
  if (node.status === "cancelled") {
    const derived = deriveStage(node.status, null, node.attention);
    return meta.roadmap
      ? { stage: derived.stage, stageRule: `${derived.stageRule} · ${CANCELLED_OVER_ROADMAP_NOTE}` }
      : derived;
  }
  // 全取消子卡汇总（#66，与"全完成→已完成"对称：子卡数>0 且全部 cancelled）：取消是终态，
  // 优先于 roadmap 压制（终态优先序：特性自身取消标记 > rollup > 现有推导）。
  if (meta.kind === "plan") {
    const tasks = allTasks(node);
    const total = tasks.length;
    const cancelled = tasks.filter((t) => t.status === "cancelled").length;
    if (total > 0 && cancelled === total) {
      return {
        stage: STAGE.CANCELLED,
        stageRule: `子卡汇总 ${cancelled}/${total} 全部 cancelled → 已取消（计划稿特性段位随子卡汇总，契约 v2.3）`,
      };
    }
  }
  if (meta.roadmap) return { stage: STAGE.DESIGN, stageRule: ROADMAP_FEATURE_STAGE_RULE };
  if (meta.kind !== "plan") return deriveStage(node.status, null, node.attention);
  const tasks = allTasks(node);
  const total = tasks.length;
  const completed = tasks.filter((t) => t.status === "completed").length;
  if (total > 0 && completed === total) {
    return {
      stage: STAGE.DONE,
      stageRule: `子卡汇总 ${completed}/${total} 全部 completed → 已完成（计划稿特性段位随子卡汇总，契约 v2.3）`,
    };
  }
  // 有卡的计划稿：缺口码里"未拆解"已由判据收窄为"零卡"，此处仍显式移除（防御 + 语义成文）。
  const attention =
    total > 0 ? (node.attention ?? []).filter((c) => c !== ATTENTION.ARRANGED_NOT_EXPANDED) : node.attention;
  const base = deriveStage(node.status, null, attention);
  // 零卡稿无"汇总"可言，不追加后缀（T5356r S-2：契约 §13.1 只在全完成时承诺 N/M 记法）。
  if (total === 0) return base;
  return { stage: base.stage, stageRule: `${base.stageRule} · 子卡汇总 ${completed}/${total}（契约 v2.3）` };
}

function finalizeFeature(node) {
  const meta = META(node);
  const out = { id: node.id };
  if (meta.no != null) {
    out.no = meta.no;
    out.label = meta.label;
  }
  // 计划码（#46 A1）：仅当 registry 已分配时写出（附加显示层，不参与引用与序列号）。
  if (meta.planCode != null) out.planCode = meta.planCode;
  // roadmap 占位稿（#53，契约 v2.3）：出现即 true（false 不写字段——与 section 同口径）。
  if (meta.roadmap) out.roadmap = true;
  out.kind = node.kind;
  out.title = node.title;
  out.details = meta.detailsFromInterview != null ? meta.detailsFromInterview : node.details;
  out.status = node.status;
  out.statusRule = node.statusRule;
  const stage = finalizeFeatureStage(node);
  out.stage = stage.stage;
  out.stageRule = stage.stageRule;
  const origin = { ...node.origin };
  if (meta.planRef != null) origin.planRef = meta.planRef;
  if (meta.interviewId) origin.interviewId = meta.interviewId;
  out.origin = origin;
  out.progress = node.progress;
  out.evidence = node.evidence;
  out.createdAt = node.createdAt;
  out.updatedAt = node.updatedAt;
  out.tasks = meta.tasks.map((t) => finalizeTask(t, Boolean(meta.roadmap)));
  // 当前执行者（#46 A3）：特性层 = 子树首个非空 currentAssignee（跟着正在跑的卡走）；
  // 子树全空 → null（字段恒写出）。
  let featureAssignee = null;
  const walkAssignee = (list) => {
    for (const t of list) {
      if (featureAssignee == null && t.currentAssignee != null) featureAssignee = t.currentAssignee;
      walkAssignee(t.tasks ?? []);
    }
  };
  walkAssignee(out.tasks);
  out.currentAssignee = featureAssignee;
  out.attention = node.attention;
  return out;
}

function renderBoardMd(board) {
  const lines = [];
  lines.push(`# 项目看板 · ${board.project.name}`);
  lines.push("");
  lines.push(`- 项目根：${board.project.root}`);
  lines.push(`- 生成时间：${board.updatedAt}`);
  lines.push(`- 生成器：${GENERATED_BY}（默认只读；status/段位/缺口/执行记录均为派生字段，可随时重编译重建）`);
  const specCount = board.sources.filter((s) => s.kind === "spec").length;
  const planCount = board.sources.filter((s) => s.kind === "plan").length;
  lines.push(`- 输入源：${board.sources.length} 个（第一方 3 + spec ${specCount} + plan ${planCount}）`);
  const taskCount = board.features.reduce((n, f) => n + countTasks(f.tasks ?? []), 0);
  lines.push(`- 计数：特性 ${board.features.length}，任务 ${taskCount}，诊断 ${board.diagnostics.length}`);
  const stages = summarizeStages(board.features);
  lines.push(`- 段位：${STAGE_VALUES.map((s) => `${s} ${stages[s] ?? 0}`).join(" · ")}（七段位：v2.1 起"已取消"为实产出）`);
  const sum = board.attentionSummary;
  lines.push(
    `- 缺口：已访谈未安排 ${sum.interviewedNotArranged} · 已安排未展开 ${sum.arrangedNotExpanded} · 执行中断可续 ${sum.interruptedResume} · 待合并 ${sum.unmergedWorktree}`,
  );
  lines.push("");

  if (ATTENTION_CODES.some((c) => attentionOfCode(board, c) > 0)) {
    lines.push("## 待处理");
    lines.push("");
    for (const code of ATTENTION_CODES) {
      const nodes = [];
      walkBoardNodes(board.features, (node, ptr) => {
        if ((node.attention ?? []).includes(code)) nodes.push(ptr);
      });
      if (nodes.length === 0) continue;
      lines.push(`- ${ATTENTION_LABELS[code]}（${code}）：${nodes.length}`);
      for (const n of nodes) lines.push(`  - ${n}`);
    }
    lines.push("");
  }

  const unmerged = [];
  walkBoardNodes(board.features, (node, ptr) => {
    if (typeof node.worktree === "string" && node.worktree !== "") unmerged.push(`${ptr} —— ${node.worktree}`);
  });
  if (unmerged.length > 0) {
    lines.push("## 待合并（unmerged-worktree 聚合）");
    lines.push("");
    for (const line of unmerged) lines.push(`- ${line}`);
    lines.push("");
  }

  lines.push("## 特性");
  lines.push("");
  if (board.features.length === 0) {
    lines.push("（空板：无 specs、无 plans、无登记）");
    lines.push("");
  }
  for (const f of board.features) {
    const id = renderNodeId(f);
    lines.push(`### ${id} · ${f.title}`);
    lines.push("");
    lines.push(`- kind：${f.kind}；status：${f.status}（${f.statusRule}）；段位：${f.stage}（${f.stageRule}）`);
    if ((f.attention ?? []).length > 0) {
      lines.push(`- 缺口：${f.attention.map((c) => `${ATTENTION_LABELS[c] ?? c}（${c}）`).join("、")}`);
    }
    if (f.details) lines.push(`- 细节：${f.details}`);
    if (f.origin?.interviewId) lines.push(`- 访谈：${f.origin.interviewId}`);
    if (f.origin?.specRoot) lines.push(`- spec：${f.origin.specRoot}`);
    if (f.origin?.planRef) lines.push(`- 计划：${f.origin.planRef}`);
    if (f.progress) lines.push(`- 进度：${f.progress.completedTasks}/${f.progress.totalTasks}`);
    lines.push(`- 时间戳：updatedAt ${f.updatedAt}${f.createdAt ? ` · createdAt ${f.createdAt}` : ""}`);
    if (f.evidence?.length) lines.push(`- 证据：${f.evidence.join("、")}`);
    if ((f.tasks ?? []).length === 0) lines.push("- 任务：无");
    else lines.push("- 任务：");
    for (const line of renderTaskLines(f.tasks, 1, f.planCode ?? null)) lines.push(line);
    lines.push("");
  }
  lines.push("## 诊断");
  lines.push("");
  if (board.diagnostics.length === 0) lines.push("- 无（诊断不静默：解析失败/未领号/引用异常一律在此点名）");
  for (const d of board.diagnostics) lines.push(`- ${d.path}：${d.message}`);
  lines.push("");
  return lines.join("\n");
}

function attentionOfCode(board, code) {
  let n = 0;
  walkBoardNodes(board.features, (node) => {
    if ((node.attention ?? []).includes(code)) n += 1;
  });
  return n;
}

/**
 * 渲染位 id 形态（board.md 单点派生）：带 label → `ID-<label>`；未领号 → `未领号`；
 * §2.4 过渡态（未领号特性下带号卡，label 缺省）→ 降级 `#<no>`（引用位可用，不留 "ID-undefined"）。
 * 计划码（#46 A1）在计划内替代全局号显示：特性 → `计划码`，任务 → `计划码-<层级>`（如 IMPL-1.2）。
 */
function renderNodeId(node) {
  if (node.no == null) return "未领号";
  if (node.planCode != null && node.label != null) return node.planCode;
  return node.label != null ? `ID-${node.label}` : `#${node.no}`;
}

/** 任务渲染位（#46 A1）：所属特性有计划码 → `计划码-<层级>`；否则维持 `ID-<label>`。 */
function renderTaskNodeId(node, planCode) {
  if (node.no == null) return "未领号";
  if (node.label == null) return `#${node.no}`;
  return planCode != null ? `${planCode}-${node.label}` : `ID-${node.label}`;
}

function walkBoardNodes(features, fn) {
  const walkTasks = (tasks, parentLabel, planCode) => {
    for (const t of tasks ?? []) {
      const self = `${parentLabel} > ${renderTaskNodeId(t, planCode)} ${t.title}`;
      fn(t, self);
      walkTasks(t.tasks, self, planCode);
    }
  };
  for (const f of features ?? []) {
    fn(f, `${renderNodeId(f)} ${f.title}`);
    walkTasks(f.tasks, renderNodeId(f), f.planCode ?? null);
  }
}

function countTasks(tasks) {
  return (tasks ?? []).reduce((n, t) => n + 1 + countTasks(t.tasks), 0);
}

function renderTaskLines(tasks, depth, planCode = null) {
  const out = [];
  const indent = "  ".repeat(depth);
  for (const t of tasks ?? []) {
    const id = renderTaskNodeId(t, planCode);
    out.push(`${indent}- ${id} · ${t.title} — ${t.status}（${t.statusRule}）· 段位：${t.stage}（${t.stageRule}）`);
    if (t.lastRun) {
      const stopped = t.lastRun.stoppedAt != null ? `停在 #${t.lastRun.stoppedAt}` : "无断点";
      const next = t.lastRun.next != null ? `· ${t.lastRun.next}` : "";
      out.push(`${indent}  - 最近执行：${t.lastRun.at} · ${t.lastRun.role} · ${t.lastRun.result} · ${stopped}${next}`);
    }
    const marks = [];
    if (t.activeRun) marks.push(`执行角色：${t.activeRun.role}（${t.stage}，自 ${t.activeRun.at}）`);
    if (t.worktree) marks.push(`执行现场：${t.worktree}（未合并）`);
    if (t.pr) marks.push(`PR：#${t.pr.number} ${t.pr.url}`);
    if (Array.isArray(t.assignees) && t.assignees.join("|") !== DEFAULT_ASSIGNEES.join("|")) {
      marks.push(`管线：${t.assignees.join(" → ")}`);
    }
    if (t.draft) marks.push("草案");
    if ((t.attention ?? []).length > 0) {
      marks.push(`缺口：${t.attention.map((c) => `${ATTENTION_LABELS[c] ?? c}（${c}）`).join("、")}`);
    }
    if (marks.length > 0) out.push(`${indent}  - ${marks.join(" · ")}`);
    for (const b of t.blockers ?? []) {
      const target = b.blockedBy != null ? `#${b.blockedBy}` : "（目标号缺省）";
      out.push(`${indent}  - 阻拦[${b.kind}] ${target} ${b.summary}`.trimEnd());
    }
    // D1（#53 第二绿发现）：递归必须透传计划码，否则嵌套行回落 ID-<层级>（如 ID-1.1）。
    out.push(...renderTaskLines(t.tasks, depth + 1, planCode));
  }
  return out;
}

// ---------------------------------------------------------------- 编译主流程

export function compileProject(rootInput) {
  const root = resolve(rootInput);
  const diagnostics = [];
  const diag = (path, message) => diagnostics.push({ path, message });

  // 扫描面（#72/契约 v2.4）：默认只扫 .zcode/plans；scan.json opt-in 后才含 docs/plans、docs/design-notes。
  // 配置错误 → 失败级 diagnostics + 按默认扫描面兜底（不猜；--check 另作失败项归口）。
  const scanSurface = loadScanConfig(root);
  for (const e of scanSurface.errors) diag(e.path, e.message);
  const scan = { specs: listSpecDirs(root), plans: listPlanFiles(root, scanSurface) };

  // 第一方源（缺失 = 空源，§12）
  const interviewsRel = FIRST_PARTY_SOURCES[0].path;
  const interviews = loadInterviews(root, interviewsRel, diag);

  let registry = null;
  const registryLoaded = readJsonFile(join(root, FIRST_PARTY_SOURCES[1].path));
  if (registryLoaded.ok) {
    if (Array.isArray(registryLoaded.value?.entries)) registry = registryLoaded.value;
    else diag(FIRST_PARTY_SOURCES[1].path, "registry.json 结构不合法（缺少 entries 数组）：按空 registry 处置。");
  } else if (!registryLoaded.missing) {
    diag(FIRST_PARTY_SOURCES[1].path, `registry.json 解析失败（${registryLoaded.error}）：按空 registry 处置。`);
  }

  const parsedFeatures = [];
  for (const spec of scan.specs) parsedFeatures.push(parseSpecFeature(spec, diag));
  for (const plan of scan.plans) parsedFeatures.push(parsePlanFeature(plan, diag));
  // 计划→spec 延续：被 spec 接续的计划稿节点退役（号延续由 registry 条目改写承载，--assign 执行）
  const features = applyContinuations(parsedFeatures, interviews);

  resolveNumbers(features, registry, diag);

  // 计划码（#46 A1）：registry 条目是唯一来源（分配发生在 --assign，编译器只读）；
  // 形态非法不采纳 + diagnostics（不静默），UI 侧回退显示稳定号。
  for (const f of features) {
    const meta = META(f);
    if (meta.kind === "interview-only" || !meta.registryKey || !registry) continue;
    const entry = findRegistryEntry(registry, meta.registryKey);
    const code = entry?.planCode;
    if (code == null) continue;
    if (typeof code === "string" && PLAN_CODE_RE.test(code)) meta.planCode = code;
    else {
      diag(
        meta.diagPath,
        `registry 条目（${meta.sourcePath}）的 planCode=${JSON.stringify(code)} 形态非法（应为 4 位：首字符字母 + 大写字母数字）：不采纳，按无计划码降级显示。`,
      );
    }
  }

  resolveBlockers(features, registry, diag);

  // progress blocker 挂卡（§4.2：summary 与任务标题精确匹配或含 N. 前缀 → 挂该任务卡；否则只升特性级）
  for (const f of features) {
    const meta = META(f);
    if (meta.kind !== "spec" || !meta.progressData) continue;
    attachProgressBlockers(f, meta.progressData, `${meta.sourcePath}progress.json`);
  }

  mergeInterviews(features, root, interviewsRel, interviews, diag);
  deriveLabels(features);

  // ---- 派生层（T7）：runs 归一 → attention → updatedAt max 合并 → 诊断 → attentionSummary
  const runsRel = FIRST_PARTY_SOURCES[2].path;
  let runsRaw = [];
  const runsLoaded = readJsonFile(join(root, runsRel));
  if (runsLoaded.ok) {
    if (Array.isArray(runsLoaded.value?.runs)) runsRaw = runsLoaded.value.runs;
    else diag(runsRel, "runs.json 结构不合法（缺少 runs 数组）：按空执行记录处置（§12）。");
  } else if (!runsLoaded.missing) {
    diag(runsRel, `runs.json 解析失败（${runsLoaded.error}）：按空执行记录处置（执行历史丢失不影响号码身份与 status 推导，§12）。`);
  }
  const runsState = normalizeRuns(runsRaw, { runsPath: runsRel });
  for (const d of runsState.diagnostics) diag(d.path, d.message);

  // 工作树 fs 事实（#42：unmerged-worktree 判据的互证基准；纯文件扫描，不执行 git）：
  //   ① 板根 `.zcode/worktrees/<name>`；② 一层嵌套项目根 `<child>/.zcode/worktrees/<name>`——
  //   卡的执行现场可能建在子项目根下（如 ZPaPa/.zcode/worktrees/task-32，声明侧常写作 `.zcode/worktrees/task-32`）。
  //   只探一层（与「工作树只开一层」同构，防递归）；隐藏目录与 .zcode 自身不是项目根，跳过。
  const worktreesAbs = join(root, WORKTREES_REL);
  const worktreeDirs = isDir(worktreesAbs)
    ? readdirSync(worktreesAbs).sort().filter((n) => isDir(join(worktreesAbs, n)))
    : [];
  const nestedDirs = worktreeDirs.filter((n) => isDir(join(worktreesAbs, n, ".zcode", "worktrees")));
  const existingWorktrees = worktreeDirs.map((n) => `${WORKTREES_REL}/${n}`);
  let rootEntries = [];
  try {
    rootEntries = readdirSync(root).sort();
  } catch {
    rootEntries = [];
  }
  for (const child of rootEntries) {
    if (child.startsWith(".") || child === "node_modules") continue; // 隐藏目录/依赖目录不是项目根
    const childWorktreesAbs = join(root, child, WORKTREES_REL);
    if (!isDir(childWorktreesAbs)) continue;
    for (const n of readdirSync(childWorktreesAbs).sort()) {
      if (isDir(join(childWorktreesAbs, n))) existingWorktrees.push(`${child}/${WORKTREES_REL}/${n}`);
    }
  }

  // 卡的 run 字段派生（§4.5）：只挂有稳定号的卡；无号卡无引用位可寻址。
  // #42：worktree 字段命中且目录经 fs 互证真实存在才触发 unmerged-worktree 缺口；命中而目录不在 →
  // 降为提示级 diagnostics（不猜状态：可能已正规清理或从未创建），不计入 attention。
  // #71：降级诊断先收集、后同因合并（见下方 mergedDemotions；替代逐卡直落诊断）。
  const demotions = [];
  for (const f of features) {
    for (const t of allTasks(f)) {
      const meta = META(t);
      if (meta.no == null) continue;
      const records = runsState.byNo.get(meta.no) ?? [];
      // 该卡归一后 runs 记录留档：nextAssignee（#53）按管线序判定"首个无 done 证据角色"。
      meta.runsRecords = records;
      const state = deriveCardRuns(records, { existingWorktrees });
      meta.runState = state;
      t.updatedAt = maxIso(t.updatedAt, state.latestAt) ?? t.updatedAt;
      if (state.demotedWorktree != null) {
        // 声明该路径的最新一条 run（与 deriveCardRuns 的选取同口径：最后一条 worktree 非空的记录）
        const declaring = [...records].reverse().find((r) => r.worktree === state.demotedWorktree) ?? null;
        demotions.push({ no: meta.no, path: state.demotedWorktree, runId: declaring?.runId ?? null });
      }
    }
  }
  // #71：降级诊断同因合并——按（声明 run × 声明路径）归并：同一 run 的同一声明落到多张卡时合并为一条，
  // 并点名 run 消歧；单卡声明维持 #42 原文案形态（板面纪律：runId 不进节点字段，单卡无消歧需要不点名）。
  const mergedDemotions = new Map();
  for (const d of demotions) {
    const key = `${d.runId ?? "（无 run 记录）"}|${d.path}`;
    const hit = mergedDemotions.get(key);
    if (hit) hit.nos.push(d.no);
    else mergedDemotions.set(key, { path: d.path, runId: d.runId, nos: [d.no] });
  }
  for (const d of mergedDemotions.values()) {
    const cardsLabel = d.nos.map((n) => `#${n}`).join("、");
    const runLabel = d.nos.length > 1 && d.runId != null ? `（run ${d.runId}）` : "";
    diag(
      runsRel,
      `卡 ${cardsLabel} 的 runs 声明工作树 ${d.path} 但目录不存在${runLabel}：不计入 unmerged-worktree 缺口（提示级——不猜状态，可能已正规清理或从未创建），请核查（§4.5/§12）。`,
    );
  }

  // 契约 v2.1（T21）：已取消卡若存在未合并工作树 → diagnostics 提醒走正规清理（取消不清理现场；缺口事实照常保留）
  for (const f of features) {
    for (const t of allTasks(f)) {
      const meta = META(t);
      if (t.status !== "cancelled" || meta.runState?.worktree == null) continue;
      diag(
        meta.diagPath ?? meta.sourcePath,
        `卡 #${meta.no} 已取消但存在未合并工作树 ${meta.runState.worktree}：取消不清理现场——请走 git worktree 正规清理后重编译（§6.1/§12）。`,
      );
    }
  }

  // run 事件引用的卡号不在板上 → 不挂任何卡 + diagnostics（不静默）
  const liveNo = new Set();
  for (const f of features) {
    const fm = META(f);
    if (fm.no != null) liveNo.add(fm.no);
    for (const t of allTasks(f)) {
      const tm = META(t);
      if (tm.no != null) liveNo.add(tm.no);
    }
  }
  for (const rec of runsState.order) {
    for (const no of rec.cards) {
      if (!liveNo.has(no)) {
        diag(runsRel, `run ${rec.runId} 引用卡号 ${no} 不在板上活条目中：不挂任何卡（§12），待人工确认。`);
      }
    }
  }

  // 特性 updatedAt：max(源推导, progress.activity 最新 at, 子树卡片 updatedAt)（§4.2/§4.5）
  for (const f of features) {
    const meta = META(f);
    let at = maxIso(f.updatedAt, meta.activityAt) ?? f.updatedAt;
    for (const t of allTasks(f)) at = maxIso(at, t.updatedAt) ?? at;
    f.updatedAt = at;
  }

  // 缺口码（§8.4）：特性级两码 + 卡级两码
  for (const f of features) {
    const meta = META(f);
    const tasks = allTasks(f);
    if (meta.kind === "interview-only") f.attention.push(ATTENTION.INTERVIEWED_NOT_ARRANGED);
    if (
      deriveArrangedNotExpanded({
        kind: meta.kind,
        hasTaskDoc: Boolean(meta.specFiles?.includes("tasks.md")),
        hasProgressDoc: Boolean(meta.specFiles?.includes("progress.json")),
        tasks,
      })
    ) {
      f.attention.push(ATTENTION.ARRANGED_NOT_EXPANDED);
    }
    for (const t of tasks) {
      for (const code of META(t).runState?.attention ?? []) t.attention.push(code);
    }
  }

  // 诊断：plan-overgrown（§4.2）与 progress.execution ↔ tasks.md 勾选数不一致（§4.2）
  for (const f of features) {
    const meta = META(f);
    if (meta.kind === "plan") {
      const d = diagnosePlanOvergrown({
        path: meta.sourcePath,
        cardCount: allTasks(f).length,
        threshold: PLAN_OVERGROWN_THRESHOLD,
      });
      if (d) diag(d.path, d.message);
    }
    if (meta.kind === "spec" && meta.progressData && meta.specFiles?.includes("tasks.md")) {
      const tasks = allTasks(f);
      for (const d of diagnoseProgressMismatch({
        progressPath: `${meta.sourcePath}progress.json`,
        execution: meta.progressData.execution,
        taskCount: tasks.length,
        checkedCount: tasks.filter((t) => META(t).checked).length,
      })) {
        diag(d.path, d.message);
      }
    }
  }

  // 诊断（提示级）：roadmap 占位稿出现激活迹象（T5356r P-2，契约 v2.3）——勾选记录或卡 done/partial
  // run 证据说明本稿已开始执行，但 roadmap 子旗标会把特性与全部卡段位恒压制为待设计；无其它机械提示，
  // 故此处点名"建议复核占位标记"（提示级不阻断；未激活稿零噪声）。
  for (const f of features) {
    const meta = META(f);
    if (!meta.roadmap) continue;
    const tasks = allTasks(f);
    const checkedCount = tasks.filter((t) => META(t).checked).length;
    const runCards = tasks.filter((t) => (META(t).runsRecords ?? []).some((r) => r.result === "done" || r.result === "partial"));
    if (checkedCount === 0 && runCards.length === 0) continue;
    const signals = [];
    if (checkedCount > 0) signals.push(`勾选记录 ${checkedCount} 条`);
    if (runCards.length > 0) signals.push(`done/partial run 证据 ${runCards.length} 卡`);
    diag(
      meta.sourcePath,
      `roadmap 占位稿出现激活迹象（${signals.join("、")}）：建议复核占位标记——roadmap 子旗标会将其段位永久压制为待设计；若本稿已开始执行，应移除该标记（契约 v2.3，提示级不阻断）。`,
    );
  }

  // 诊断：worktree 目录与 runs 互证（§4.5/§6.1；纯文件扫描，不执行 git；fs 事实见上方 #42 扫描块）。
  // 「runs 有据而目录不在」在本编译器流程中已由 #42 的派生层降级诊断承载（worktree 字段随之 null）；
  // 本调用保留为独立互证（目录在而板上无据/无该卡未合并证据、嵌套工作树两向点名）。
  const cardWorktrees = [];
  for (const f of features) {
    for (const t of allTasks(f)) {
      const meta = META(t);
      if (meta.no == null) continue;
      cardWorktrees.push({ no: meta.no, worktree: meta.runState?.worktree ?? null });
    }
  }
  for (const d of diagnoseWorktrees({
    worktreesRel: WORKTREES_REL,
    cards: cardWorktrees,
    existingDirs: worktreeDirs,
    nestedDirs,
  })) {
    diag(d.path, d.message);
  }

  const finalizedFeatures = features.map(finalizeFeature);
  const board = {
    version: BOARD_VERSION,
    project: { root, name: basename(root) },
    updatedAt: nowIso(),
    generatedBy: GENERATED_BY,
    sources: buildSources(scan),
    features: finalizedFeatures,
    attentionSummary: summarizeAttention(finalizedFeatures),
    diagnostics,
  };
  return board;
}

// ---------------------------------------------------------------- 发号（--assign，T9）

/** 计划稿发号事实（保留行级信息：行号 + 行尾标记，供盖号写回；语法族与编译同一解析器）。 */
function readPlanAssignFacts(plan) {
  const read = readTextFile(plan.abs);
  if (!read.ok) return { ok: false, error: read.error ?? "不存在" };
  const text = read.text;
  const lines = text.split(/\r?\n/);
  const headingLine = lines.findIndex((l) => HEADING_RE.test(l));
  const title = sanitizeDocHeading(headingLine >= 0 ? HEADING_RE.exec(lines[headingLine])[3] : "") || plan.stem;
  const { entries, headMarker } = parseEntries({
    lines,
    mode: "plan",
    fileRel: plan.rel,
    titleLineIndex: headingLine,
    diag: () => {},
  });
  const flat = [];
  const collect = (list) => {
    for (const e of list) {
      flat.push(e);
      collect(e.children);
    }
  };
  collect(entries);
  return {
    ok: true,
    text,
    title,
    headMarkerNo: headMarker ? headMarker.no : null,
    entries: flat.map((e) => ({ lineIndex: e.lineIndex, title: e.title, markerNo: e.markerNo })),
  };
}

/** spec 发号事实（标题优先级与 parseSpecFeature 同源；tasks.md 条目含行号与行尾标记）。 */
function readSpecAssignFacts(spec) {
  let title = null;
  for (const name of SPEC_TITLE_FILES) {
    if (!isFile(join(spec.abs, name))) continue;
    const t = readTextFile(join(spec.abs, name));
    if (!t.ok) continue;
    const h = firstHeading(t.text);
    if (h) {
      title = sanitizeDocHeading(h);
      break;
    }
  }
  let progressData = null;
  if (spec.files.includes("progress.json")) {
    const loaded = readJsonFile(join(spec.abs, "progress.json"));
    if (loaded.ok && loaded.value && typeof loaded.value === "object") progressData = loaded.value;
  }
  if (!title && progressData && typeof progressData.feature === "string" && progressData.feature.trim() !== "") {
    title = progressData.feature.trim();
  }
  if (!title) title = spec.dir;

  let tasks = [];
  let tasksText = null;
  if (spec.files.includes("tasks.md")) {
    const loaded = readTextFile(join(spec.abs, "tasks.md"));
    if (loaded.ok) {
      tasksText = loaded.text;
      const lines = loaded.text.split(/\r?\n/);
      const headingLine = lines.findIndex((l) => HEADING_RE.test(l));
      const parsed = parseEntries({
        lines,
        mode: "tasks",
        fileRel: `${spec.rel}tasks.md`,
        titleLineIndex: headingLine,
        diag: () => {},
      });
      const flat = [];
      const collect = (list) => {
        for (const e of list) {
          flat.push(e);
          collect(e.children);
        }
      };
      collect(parsed.entries);
      tasks = flat.map((e) => ({ lineIndex: e.lineIndex, title: e.title, markerNo: e.markerNo }));
    }
  }
  return { title, tasks, tasksText, id: `spec:${spec.dir}` };
}

/** registry 条目（冻结字段序：no, kind, file|specRoot, title, assignedAt；额外字段由调用方保留）。 */
function entryFor(target, no, assignedAt) {
  if (target.type === "feature" && target.kind === "spec") {
    return { no, kind: "spec", specRoot: target.specRoot, title: target.title, assignedAt };
  }
  return { no, kind: target.kind, file: target.file, title: target.title, assignedAt };
}

const ENTRY_KNOWN_KEYS = ["no", "kind", "file", "specRoot", "title", "assignedAt", "planCode"];
function entryExtras(e) {
  return Object.fromEntries(Object.entries(e).filter(([k]) => !ENTRY_KNOWN_KEYS.includes(k)));
}

function targetRef(t) {
  return t.type === "feature" && t.kind === "spec" ? t.specRoot : t.file;
}

/**
 * 防 mass 改写闸（#72）：单次 `--assign` 发现超过该数量的"未领号计划文件"（文件头无号标记）→
 * 拒绝执行（零写入、零发号），diagnostics 列全清单 + 建议；`--force` 才放行（亦留诊断痕迹）。
 * 由来：远端新赛马项目 docs/design-notes/ 296 份活历史档曾被默认扫描面吸入、逐份盖号改写。
 */
const MASS_PLAN_FILE_THRESHOLD = 10;

/**
 * 发号（设计 §3.2/§3.4/§6.4/§12；任务 T9）：
 *   1. 同编译的确定性扫描顺序（specs 字典序 → 扫描面目录冻结序 × 文件名字典序 → 文件内文档序）；
 *   2. 无号条目依次领全局单序列号；计划稿盖文件头标记、条目行尾盖号（逐文件原子写，只增不改）；
 *      spec 特性号在 registry 内绑定；
 *   3. registry：seq 高水位只增（seq/条目/活标记三者取 max）；缺失/损坏 → 按活标记重建；
 *      指向更新（迁移 file / 计划→spec 延续 specRoot / 归档映射 file|specRoot——勘误 10，号不变）；
 *      条目只增不复用；
 *   4. 冲突/篡改不静默改写：先扫者保留、后到者降级未领号 + diagnostics；
 *   5. 写回后自动重编译 board.json/board.md。
 * 写入面（§12）：号标记 + registry + board 产物；interviews/runs/其它源零触碰。
 * `planCodeRequests`（#46 A1，可选）：`[{file, code}]`——手工指定计划码（--plan-code <file>=<CODE>），
 *   优先于自动派生；形态非法或与已占用码冲突 → diagnostics + 该计划回退自动派生（不静默覆盖）。
 * `force`（#72）：未领号计划文件 > MASS_PLAN_FILE_THRESHOLD 时是否放行（默认拒绝——防批量改写；
 *   放行亦留诊断痕迹）。
 * 返回 `refused: true`（防 mass 改写闸拦截）时：零写入、零发号，`board`/`registry` 均为 null。
 */
export function assignProject(rootInput, { planCodeRequests = [], force = false } = {}) {
  const root = resolve(rootInput);
  const diagnostics = [];
  const diag = (path, message) => diagnostics.push({ path, message });

  // ---- 1. 扫描与发号目标（复用编译同一扫描顺序与同一语法族；扫描面由 scan.json 解析，#72）
  const scanSurface = loadScanConfig(root);
  for (const e of scanSurface.errors) diag(e.path, e.message);
  const scan = { specs: listSpecDirs(root), plans: listPlanFiles(root, scanSurface) };
  const targets = [];
  const fileTexts = new Map(); // rel → 原文（盖号写回的字节基线）
  for (const spec of scan.specs) {
    const facts = readSpecAssignFacts(spec);
    targets.push({ type: "feature", kind: "spec", id: facts.id, specRoot: spec.rel, title: facts.title, markerNo: null });
    if (facts.tasksText != null) fileTexts.set(`${spec.rel}tasks.md`, facts.tasksText);
    for (const t of facts.tasks) {
      targets.push({
        type: "task",
        kind: "task",
        file: `${spec.rel}tasks.md`,
        lineIndex: t.lineIndex,
        title: t.title,
        markerNo: t.markerNo,
      });
    }
  }
  // 未领号计划文件（文件头无号标记）：防 mass 改写闸的计数对象（#72）
  const unnumberedPlanFiles = [];
  for (const plan of scan.plans) {
    const facts = readPlanAssignFacts(plan);
    if (!facts.ok) {
      diag(plan.rel, `计划稿读取失败（${facts.error}）：本文件不发号（不撕碎其它源）。`);
      continue;
    }
    if (!Number.isInteger(facts.headMarkerNo)) unnumberedPlanFiles.push(plan.rel);
    fileTexts.set(plan.rel, facts.text);
    targets.push({ type: "feature", kind: "plan", file: plan.rel, title: facts.title, markerNo: facts.headMarkerNo });
    for (const e of facts.entries) {
      targets.push({
        type: "task",
        kind: "task",
        file: plan.rel,
        lineIndex: e.lineIndex,
        title: e.title,
        markerNo: e.markerNo,
      });
    }
  }

  // ---- 1b. 防 mass 改写闸（#72）：>10 个未领号计划文件 → 拒绝执行（零写入）；--force 放行并留痕
  if (unnumberedPlanFiles.length > MASS_PLAN_FILE_THRESHOLD) {
    const count = unnumberedPlanFiles.length;
    if (!force) {
      diag(
        SCAN_CONFIG_REL,
        `--assign 发现 ${count} 个未领号计划文件（阈值：单次 >${MASS_PLAN_FILE_THRESHOLD}）：拒绝执行——未写任何文件、未发任何号。清单：${unnumberedPlanFiles.join("、")}`,
      );
      diag(
        SCAN_CONFIG_REL,
        "处置建议：核查扫描面（.zcode/board/scan.json 的 includeDirs 是否误纳入整批历史档/无关目录，或应按 excludeGlobs 排除）或拆分登记；确认无误后加 --force 继续（--force 会在此留痕）。",
      );
      return {
        refused: true,
        refusedReason: "mass-plan-files",
        unnumberedPlanFiles,
        diagnostics,
        board: null,
        registry: null,
        assignedCount: 0,
        changedMarkerFiles: [],
        registryWritten: false,
      };
    }
    diag(
      SCAN_CONFIG_REL,
      `--force 放行：单次批量发号 ${count} 个未领号计划文件（>${MASS_PLAN_FILE_THRESHOLD} 阈值；已按上方建议核查扫描面/拆分登记）——本 run 将逐份改写号标记，此诊断即放行痕迹。`,
    );
  }

  // ---- 2. registry 读取（缺失/损坏 → 按全部活标记重建）
  const registryRel = FIRST_PARTY_SOURCES[1].path;
  const loaded = readJsonFile(join(root, registryRel));
  let raw = null;
  let rebuilt = false;
  if (loaded.ok && loaded.value && typeof loaded.value === "object" && Array.isArray(loaded.value.entries)) {
    raw = loaded.value;
  } else {
    rebuilt = true;
    diag(
      registryRel,
      loaded.ok
        ? "registry.json 结构不合法（缺少 entries 数组）：按全部源头活标记重建（号随文件走，seq=max(活号)）。"
        : loaded.missing
          ? "registry.json 缺失：按全部源头活标记重建（号随文件走，seq=max(活号)）；已删高水位记忆丢失属已知残余风险（§12/§14）。"
          : `registry.json 解析失败（${loaded.error}）：按全部源头活标记重建（号随文件走，seq=max(活号)）。`,
    );
  }

  const extras = raw
    ? Object.fromEntries(Object.entries(raw).filter(([k]) => !["version", "seq", "entries"].includes(k)))
    : {};
  let entries = [];
  if (raw) {
    const seenNo = new Set();
    raw.entries.forEach((e, i) => {
      if (!e || typeof e !== "object" || !Number.isInteger(e.no) || e.no < 1) {
        diag(registryRel, `registry.entries[${i}] 形态非法（no 须为正整数）：跳过该条，不猜号。`);
        return;
      }
      if (seenNo.has(e.no)) diag(registryRel, `registry.entries 存在同号 ${e.no} 重复：保留原样（不静默改写），待人工修。`);
      seenNo.add(e.no);
      entries.push({ ...e });
    });
    entries.sort((a, b) => a.no - b.no);
  } else {
    const seen = new Set();
    for (const t of targets) {
      if (!Number.isInteger(t.markerNo) || t.markerNo < 1 || seen.has(t.markerNo)) continue;
      seen.add(t.markerNo);
      entries.push(entryFor(t, t.markerNo, nowIso()));
    }
    entries.sort((a, b) => a.no - b.no);
  }

  // ---- 3. 高水位只增：seq / 条目 / 活标记三者取 max；活标记高于声明高水位 → 跳号警示
  const declaredSeq = raw && Number.isInteger(raw.seq) && raw.seq >= 0 ? raw.seq : 0;
  let seq = declaredSeq;
  for (const e of entries) seq = Math.max(seq, e.no);
  for (const t of targets) {
    if (Number.isInteger(t.markerNo) && t.markerNo > 0) seq = Math.max(seq, t.markerNo);
  }
  if (!rebuilt) {
    for (const t of targets) {
      if (Number.isInteger(t.markerNo) && t.markerNo > declaredSeq) {
        diag(
          targetRef(t),
          `源头标记号 ${t.markerNo} 高于 registry 高水位 seq=${declaredSeq}（手工篡改或副本分叉）：采纳并前进 seq，不静默改写（跳号）。`,
        );
      }
    }
  }

  // ---- 4. spec 绑定与计划→spec 延续（同一事项的号延续：registry 条目改写承载）
  const entryBySpecRoot = new Map();
  for (const e of entries) {
    if (e.kind === "spec" && typeof e.specRoot === "string" && !entryBySpecRoot.has(e.specRoot)) {
      entryBySpecRoot.set(e.specRoot, e);
    }
  }
  const specTargets = targets.filter((t) => t.type === "feature" && t.kind === "spec");
  for (const t of specTargets) {
    const e = entryBySpecRoot.get(t.specRoot);
    if (e) t.registryNo = e.no;
  }
  const planTargetByFile = new Map(
    targets.filter((t) => t.type === "feature" && t.kind === "plan").map((t) => [t.file, t]),
  );
  const interviews = loadInterviews(root, FIRST_PARTY_SOURCES[0].path, diag);
  const continuationOf = new Map(); // specTarget → {plan, no}
  for (const itw of interviews) {
    if (!itw || typeof itw !== "object") continue;
    const resolvedBy = typeof itw.resolvedBy === "string" ? itw.resolvedBy.trim() : "";
    if (resolvedBy === "") continue;
    const spec = specTargets.find((t) => t.id === resolvedBy);
    if (!spec || spec.registryNo != null || continuationOf.has(spec)) continue;
    const artifacts = Array.isArray(itw.artifacts) ? itw.artifacts.filter((a) => typeof a === "string") : [];
    for (const a of artifacts) {
      const plan = planTargetByFile.get(a);
      if (!plan || !Number.isInteger(plan.markerNo)) continue;
      continuationOf.set(spec, { plan, no: plan.markerNo });
      plan.superseded = true;
      for (const t of targets) if (t.type === "task" && t.file === a) t.superseded = true;
      break;
    }
  }

  // ---- 5. 认领（标记 > registry；冲突：先扫者保留、后到者按未领号降级，assign 不自动改号）
  const claimed = new Map();
  const claim = (t, no, holder) => {
    if (!Number.isInteger(no) || no < 1) return false;
    const who = holder ?? `${targetRef(t)}（源头标记）`;
    if (claimed.has(no)) {
      diag(
        targetRef(t),
        `号 ${no} 重复（${who} 与已持有的 ${claimed.get(no)} 冲突）：本目标按未领号降级，不静默改写，待人工修（--check 将非零退出）。`,
      );
      t.conflicted = true;
      return false;
    }
    claimed.set(no, who);
    t.no = no;
    return true;
  };
  for (const t of targets) {
    if (t.superseded) continue;
    if (t.type === "feature" && t.kind === "spec") {
      const cont = continuationOf.get(t);
      if (cont) {
        if (claim(t, cont.no, `${cont.plan.file}（计划号延续）`)) {
          diag(
            registryRel,
            `计划→spec 延续：号 ${cont.no} 由 ${cont.plan.file} 转指 ${t.specRoot}（号不变，plan 文件降为 evidence）。`,
          );
        }
        continue;
      }
      if (t.registryNo != null) {
        claim(t, t.registryNo, `${registryRel}（spec 绑定）`);
        continue;
      }
      continue; // 未领号 spec → 发号阶段
    }
    claim(t, t.markerNo, null);
  }

  // ---- 6. 发新号（确定性扫描顺序；冲突受害者本 run 不发号——不静默改号）
  let assignedCount = 0;
  for (const t of targets) {
    if (t.superseded || t.conflicted || t.no != null) continue;
    seq += 1;
    t.no = seq;
    t.assigned = true;
    assignedCount += 1;
  }

  // ---- 7. registry 维护（只增；允许的指向改写：迁移 file、计划→spec specRoot、归档 file/specRoot（7b）；额外字段保留）
  const out = entries.map((e) => ({ ...e }));
  const outByNo = new Map();
  for (const e of out) if (!outByNo.has(e.no)) outByNo.set(e.no, e);
  for (const t of targets) {
    if (t.superseded || t.no == null) continue;
    const existing = outByNo.get(t.no);
    if (!existing) {
      const created = entryFor(t, t.no, nowIso());
      out.push(created);
      outByNo.set(t.no, created);
      if (!rebuilt) {
        diag(registryRel, `源头标记号 ${t.no} 未在 registry 登记：采纳并补登记（标记为身份真相，不静默）。`);
      }
      continue;
    }
    const cont = t.type === "feature" && t.kind === "spec" ? continuationOf.get(t) : null;
    if (cont && existing.kind === "plan" && existing.file === cont.plan.file) {
      const idx = out.indexOf(existing);
      const rewritten = {
        no: existing.no,
        kind: "spec",
        specRoot: t.specRoot,
        title: existing.title,
        ...(typeof existing.planCode === "string" ? { planCode: existing.planCode } : {}),
        assignedAt: existing.assignedAt,
        ...entryExtras(existing),
      };
      out[idx] = rewritten;
      outByNo.set(t.no, rewritten);
      continue;
    }
    if (existing.kind !== t.kind) {
      diag(
        registryRel,
        `registry 条目 ${t.no} 的 kind=${JSON.stringify(existing.kind)} 与源头形态 ${JSON.stringify(t.kind)} 不一致：保留条目（不静默改写），待人工核对。`,
      );
      continue;
    }
    // 迁移/归档指针更新（号不变）：file 随文件走；spec 的 specRoot 同理
    if (t.type === "task" || t.kind === "plan") {
      if (existing.file !== t.file) existing.file = t.file;
    }
    if (t.type === "feature" && t.kind === "spec" && existing.specRoot !== t.specRoot) existing.specRoot = t.specRoot;
  }
  // ---- 7b. 归档指向改写（勘误 10 第三种指向改写，与迁移/延续同构）：条目指向不在原位（文件已移入归档
  //         目录）、归档候选存在且含该号标记 → 改写 file/specRoot 为归档路径；号不变、assignedAt 保留。
  //         候选不存在或缺号标记 → 不改写（不静默纠正；--check 按指向直查后独立诊断）。
  const claimedNos = new Set();
  for (const t of targets) if (t.no != null) claimedNos.add(t.no);
  for (const e of out) {
    if (claimedNos.has(e.no)) continue; // 活条目（含迁移/延续改写）已按目标处理
    const ref = entryRefOf(e);
    if (refPathExists(root, e)) continue; // 原路径仍在（普通空洞或指向仍有效）：不改写
    const cand = archiveCandidateOf(ref);
    if (cand === null || !archiveRefVerified(root, e, cand)) continue;
    diag(
      registryRel,
      `归档指向改写：registry 条目 ${e.no} 指向 ${JSON.stringify(ref)} → ${JSON.stringify(cand)}（号不变、assignedAt 保留——勘误 10 第三种指向改写）。`,
    );
    if (e.kind === "spec") e.specRoot = cand;
    else e.file = cand;
  }
  out.sort((a, b) => a.no - b.no);

  // ---- 7c. 计划码（#46 A1）：计划稿首轮发号时分配（existing planCode 保留 → 幂等）；
  //     手工指定（--plan-code）优先；派生确定性（文件名/标题）+ 冲突顺延；计划码不消耗 seq。
  const planCodeTargets = targets.filter(
    (t) =>
      t.type === "feature" &&
      t.no != null &&
      !t.superseded &&
      (t.kind === "plan" || (t.kind === "spec" && continuationOf.has(t))),
  );
  const takenCodes = new Set();
  for (const e of out) {
    if (typeof e.planCode === "string" && PLAN_CODE_RE.test(e.planCode)) takenCodes.add(e.planCode);
  }
  const wantedByKey = new Map();
  for (const req of planCodeRequests) {
    const rel = String(req?.file ?? "").replace(/^\.\//, "");
    const code = String(req?.code ?? "");
    if (!PLAN_CODE_RE.test(code)) {
      diag(
        registryRel,
        `--plan-code ${rel}=${JSON.stringify(code)} 形态非法（计划码冻结为 4 位：首字符字母 + 大写字母数字）：不采纳，该计划走自动派生。`,
      );
      continue;
    }
    wantedByKey.set(rel, code);
  }
  for (const t of planCodeTargets) {
    const cont = t.kind === "spec" ? continuationOf.get(t) : null;
    // 延续场景：手工指定与派生都以**原计划文件**为键（spec 根没有计划稿文件名）。
    const manualKey = cont ? cont.plan.file : (t.file ?? null);
    const deriveFrom = { file: manualKey, title: cont ? cont.plan.title : t.title };
    const entry = outByNo.get(t.no);
    if (!entry) continue;
    if (typeof entry.planCode === "string" && PLAN_CODE_RE.test(entry.planCode)) continue; // 已分配：不重分配
    if (entry.planCode != null) {
      diag(
        registryRel,
        `registry 条目 ${t.no} 的 planCode=${JSON.stringify(entry.planCode)} 形态非法：按未分配处置，重新派生（不静默留坏值）。`,
      );
    }
    const wanted = wantedByKey.get(manualKey) ?? null;
    let code = null;
    if (wanted != null) {
      if (takenCodes.has(wanted)) {
        diag(
          registryRel,
          `--plan-code ${manualKey}=${wanted} 与已占用计划码冲突（先到者保留）：不采纳，该计划走自动派生。`,
        );
      } else {
        code = wanted;
      }
    }
    if (code == null) code = derivePlanCode({ ...deriveFrom, taken: takenCodes });
    takenCodes.add(code);
    entry.planCode = code;
  }

  const registryDoc = { version: Number.isInteger(raw?.version) ? raw.version : 1, seq, entries: out, ...extras };

  // ---- 8. 号标记写回（逐文件原子写；只增不改；内容不变不写）
  const changedMarkerFiles = [];
  const markerEdits = new Map();
  for (const t of targets) {
    if (!t.assigned) continue;
    if (t.type === "feature" && t.kind === "spec") continue; // spec 特性号 registry 内绑定（无内联标记）
    const bucket = markerEdits.get(t.file) ?? { headerNo: null, lineMarkerNos: [] };
    if (t.type === "feature") bucket.headerNo = t.no;
    else bucket.lineMarkerNos.push({ lineIndex: t.lineIndex, no: t.no });
    markerEdits.set(t.file, bucket);
  }
  for (const [rel, bucket] of markerEdits) {
    const text = fileTexts.get(rel);
    if (text == null) continue;
    const next = applyMarkerEdits(text, { headerMarkerNo: bucket.headerNo, lineMarkerNos: bucket.lineMarkerNos });
    if (writeMarkersIfChanged(join(root, rel), next, text)) changedMarkerFiles.push(rel);
  }

  // ---- 9. registry 原子写（逐字节比对：无变化不写——幂等）
  const serialized = `${JSON.stringify(registryDoc, null, 2)}\n`;
  const current = readTextFile(join(root, registryRel));
  let registryWritten = false;
  if (!current.ok || current.text !== serialized) {
    writeJsonAtomic(join(root, registryRel), registryDoc);
    registryWritten = true;
  }

  // ---- 10. 自动重编译（board.json + board.md，原子写）
  const board = compileProject(root);
  const boardDir = join(root, ".zcode", "board");
  writeFileAtomic(join(boardDir, "board.md"), renderBoardMd(board));
  writeJsonAtomic(join(boardDir, "board.json"), board);

  return { board, registry: registryDoc, diagnostics, assignedCount, changedMarkerFiles, registryWritten };
}

// ---------------------------------------------------------------- 审计（--check，T10）

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * 深差异（board 互检报告）：逐层比对期望（重编译产物）与实际（磁盘板），
 * 返回 { count, lines }（lines 有上限，count 为全量差异数）；路径用 $ 起点的 JSON 指针。
 */
function diffJsonValues(expected, actual, { limit = 20 } = {}) {
  const lines = [];
  let count = 0;
  const push = (msg) => {
    count += 1;
    if (lines.length < limit) lines.push(msg);
  };
  const typeName = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  const rec = (e, a, ptr) => {
    if (Array.isArray(e) || Array.isArray(a)) {
      if (!Array.isArray(e) || !Array.isArray(a)) {
        push(`${ptr}: 期望 ${typeName(e)}，实际 ${typeName(a)}`);
        return;
      }
      if (e.length !== a.length) push(`${ptr}.length: 期望 ${e.length} 项，实际 ${a.length} 项`);
      const n = Math.max(e.length, a.length);
      for (let i = 0; i < n; i += 1) rec(e[i], a[i], `${ptr}[${i}]`);
      return;
    }
    if (isPlainObject(e) || isPlainObject(a)) {
      if (!isPlainObject(e) || !isPlainObject(a)) {
        push(`${ptr}: 期望 ${typeName(e)}，实际 ${typeName(a)}`);
        return;
      }
      const keys = [...new Set([...Object.keys(e), ...Object.keys(a)])].sort();
      for (const k of keys) {
        if (!(k in e)) push(`${ptr}.${k}: 板上多出该字段（实际 ${JSON.stringify(a[k])}）`);
        else if (!(k in a)) push(`${ptr}.${k}: 板上缺少该字段（期望 ${JSON.stringify(e[k])}）`);
        else rec(e[k], a[k], `${ptr}.${k}`);
      }
      return;
    }
    if (e !== a) push(`${ptr}: 期望 ${JSON.stringify(e)}，实际 ${JSON.stringify(a)}`);
  };
  rec(expected, actual, "$");
  return { count, lines };
}

/**
 * 源完整性扫描（失败类"损坏源"）：解析失败 / 顶层结构不合法 / 不受支持的版本 → 失败项。
 * 与编译的降级路径（§12：子树保留标题与 mtime + diagnostics + 继续编译）互补——
 * 默认模式照常产出降级板，--check 作为审计入口对损坏源非零退出。
 * 返回清单事实（供 registry 互检复用；缺失的第一方源 = 空源，合法）。
 */
function collectCheckFacts(root, fail) {
  const readFirstParty = (rel, key) => {
    const loaded = readJsonFile(join(root, rel));
    if (loaded.missing) return []; // 缺失 = 空源（§12）
    if (!loaded.ok) {
      fail("损坏源", `${rel} 解析失败（${loaded.error}）：无法审计（修复源或从 git 恢复）。`);
      return [];
    }
    const list = loaded.value && typeof loaded.value === "object" ? loaded.value[key] : null;
    if (!Array.isArray(list)) {
      fail("损坏源", `${rel} 结构不合法（缺少 ${key} 数组）：无法审计。`);
      return [];
    }
    return list;
  };
  const registryEntries = readFirstParty(FIRST_PARTY_SOURCES[1].path, "entries");
  const interviews = readFirstParty(FIRST_PARTY_SOURCES[0].path, "interviews");
  readFirstParty(FIRST_PARTY_SOURCES[2].path, "runs"); // 只判完整性（runs 形态细节归编译 diagnostics）

  // 扫描面配置（#72/契约 v2.4）：配置错误是失败级——静默忽略会让 opt-in 目录整批消失而无人察觉
  // （编译器侧已按默认扫描面兜底并落 diagnostics；此处归入 --check 失败项，退出码非零）。
  const scanSurface = loadScanConfig(root);
  for (const e of scanSurface.errors) {
    fail("扫描面配置", `${e.path}：${e.message}（配置错误：修复或删除 scan.json 后重编译；编译侧已按默认 .zcode/plans 兜底）。`);
  }

  const specs = listSpecDirs(root);
  const specFacts = new Map();
  for (const spec of specs) {
    if (spec.files.includes("progress.json")) {
      const rel = `${spec.rel}progress.json`;
      const loaded = readJsonFile(join(spec.abs, "progress.json"));
      if (!loaded.ok) {
        fail("损坏源", loaded.missing ? `${rel} 列出即应存在，但读取失败（缺失）：无法审计。` : `${rel} 解析失败（${loaded.error}）：无法审计。`);
      } else if (!loaded.value || typeof loaded.value !== "object" || loaded.value.version !== 3) {
        fail("损坏源", `${rel} version=${JSON.stringify(loaded.value?.version ?? null)} 不受支持（v3 为准）：无法审计。`);
      }
    }
    if (spec.files.includes("tasks.md")) {
      const loaded = readTextFile(join(spec.abs, "tasks.md"));
      if (!loaded.ok) fail("损坏源", `${spec.rel}tasks.md 读取失败（${loaded.error ?? "缺失"}）：无法审计。`);
      else {
        // roadmap 标记（#53，契约 v2.3）：tasks.md 不引入——出现即失败级（只在计划稿 H1 层合法）。
        // 行内代码/围栏代码块的示例不构成标记（同编译口径）。
        const lines = loaded.text.split(/\r?\n/);
        const roadmapScan = stripCodeContext(lines);
        for (let i = 0; i < roadmapScan.length; i += 1) {
          if (ROADMAP_MARKER_RE.test(roadmapScan[i])) {
            fail(
              "roadmap 标记",
              `${spec.rel}tasks.md（第 ${i + 1} 行）：tasks.md 不引入 roadmap 标记（只在计划稿 H1 层合法，markers.md v2.3 §2.5）——需人工移动或删除。`,
            );
          }
        }
      }
    }
    specFacts.set(spec.rel, readSpecAssignFacts(spec));
  }

  const plans = listPlanFiles(root, scanSurface);
  const planFacts = new Map();
  for (const plan of plans) {
    const facts = readPlanAssignFacts(plan);
    if (!facts.ok) {
      fail("损坏源", `${plan.rel} 读取失败（${facts.error}）：无法审计。`);
    } else {
      // roadmap 标记位置审计（#53，契约 v2.3）：只在 H1 层合法——非法位置失败级（不静默放行）。
      const lines = facts.text.split(/\r?\n/);
      const audit = auditRoadmap({
        lines,
        h1Index: lines.findIndex((l) => H1_RE.test(l)),
        entryLineIndexes: new Set(facts.entries.map((e) => e.lineIndex)),
      });
      for (const v of audit.violations) {
        fail(
          "roadmap 标记",
          `${plan.rel}（第 ${v.lineIndex + 1} 行）：roadmap 标记${v.message}——该标记只在计划稿 H1 层合法（markers.md v2.3 §2.5），需人工移动或删除。`,
        );
      }
    }
    planFacts.set(plan.rel, facts);
  }
  return { root, registryEntries, interviews, specs, plans, specFacts, planFacts };
}

/**
 * 活条目清单 ↔ registry 互检（设计 §3.2 附加校验）：
 *   裁决序复用 T9 冻结语义（标记 > registry）：spec 特性号 = registry 绑定；未绑定时按登记条目
 *   resolvedBy 指向与 artifacts 命中计划稿文件头标记 → 计划号延续（该计划稿节点退役、标记降为
 *   evidence，与编译 applyContinuations 同语义——退役不因 registry 是否已改写而改变；
 *   延续改写前的 registry 条目仍是 plan 形态 → kind 不一致失败，提示运行 --assign）；
 *   计划/任务号 = 源头标记（文件头 / 行尾）。
 *   失败类：活号冲突（同号多实体）、活标记无 registry 条目、条目 kind/指向与活标记不一致、
 *   registry 同号重复/形态非法。合法：registry 空洞条目（指向文件仍在且无该号标记、号不复用，§3.2）；
 *   归档条目按指向路径直查（存在且含该号标记 → 通过并 note；指向不存在：归档候选已验证 → 失败级诊断，无候选 → 提示级独立诊断，勘误 10）。
 */
function checkRegistryConsistency(facts, fail, note) {
  const { root, registryEntries, interviews, specs, plans, specFacts, planFacts } = facts;
  const continuationNo = new Map(); // spec.rel -> { no, from }（计划号延续）
  const retiredPlans = new Set(); // 计划稿 → 节点退役（标记降 evidence）
  for (const spec of specs) {
    for (const itw of interviews) {
      if (!itw || typeof itw !== "object") continue;
      if (String(itw.resolvedBy ?? "").trim() !== `spec:${spec.dir}`) continue;
      for (const artifact of Array.isArray(itw.artifacts) ? itw.artifacts : []) {
        const pf = planFacts.get(artifact);
        if (pf?.ok && Number.isInteger(pf.headMarkerNo)) {
          retiredPlans.add(artifact);
          continuationNo.set(spec.rel, { no: pf.headMarkerNo, from: artifact });
          break;
        }
      }
      if (continuationNo.has(spec.rel)) break;
    }
  }
  const claims = [];

  for (const spec of specs) {
    const entry = registryEntries.find((e) => e && e.kind === "spec" && e.specRoot === spec.rel);
    let no = entry && Number.isInteger(entry.no) ? entry.no : null;
    let origin = "registry 绑定";
    if (no == null && continuationNo.has(spec.rel)) {
      const cont = continuationNo.get(spec.rel);
      no = cont.no;
      origin = `计划号延续（${cont.from}）`;
    }
    if (no != null) claims.push({ no, kind: "spec", specRoot: spec.rel, holder: `${spec.rel}（${origin}）` });
    for (const t of specFacts.get(spec.rel)?.tasks ?? []) {
      if (Number.isInteger(t.markerNo)) {
        claims.push({ no: t.markerNo, kind: "task", file: `${spec.rel}tasks.md`, holder: `${spec.rel}tasks.md（行尾标记）` });
      }
    }
  }
  for (const plan of plans) {
    if (retiredPlans.has(plan.rel)) continue; // 计划→spec 延续：节点退役，标记降为 evidence（T9 冻结语义）
    const pf = planFacts.get(plan.rel);
    if (!pf?.ok) continue; // 读取失败已按损坏源点名
    if (Number.isInteger(pf.headMarkerNo)) claims.push({ no: pf.headMarkerNo, kind: "plan", file: plan.rel, holder: `${plan.rel}（文件头标记）` });
    for (const e of pf.entries) {
      if (Number.isInteger(e.markerNo)) claims.push({ no: e.markerNo, kind: "task", file: plan.rel, holder: `${plan.rel}（行尾标记）` });
    }
  }

  const byNo = new Map();
  for (const claim of claims) {
    if (!byNo.has(claim.no)) byNo.set(claim.no, []);
    byNo.get(claim.no).push(claim);
  }
  for (const [no, list] of [...byNo.entries()].sort((a, b) => a[0] - b[0])) {
    if (list.length > 1) {
      fail(
        "号码冲突",
        `号 ${no} 被 ${list.length} 个活实体持有：${list.map((c) => c.holder).join("、")}（不静默改号；--assign 不自动修，需人工定夺，§3.2）。`,
      );
    }
  }

  const entryByNo = new Map();
  registryEntries.forEach((e, i) => {
    if (!e || typeof e !== "object" || !Number.isInteger(e.no) || e.no < 1) {
      fail("registry 不一致", `registry.entries[${i}] 形态非法（no 须为正整数）：不猜号。`);
      return;
    }
    if (entryByNo.has(e.no)) {
      fail("registry 不一致", `registry.entries 存在同号 ${e.no} 重复（条目 ${entryByNo.get(e.no).index} 与 ${i}）：不静默改写，待人工修。`);
      return;
    }
    entryByNo.set(e.no, { entry: e, index: i });
  });

  for (const [no, list] of [...byNo.entries()].sort((a, b) => a[0] - b[0])) {
    if (list.length !== 1) continue; // 冲突已点名，不再叠加
    const claim = list[0];
    const hit = entryByNo.get(no);
    if (!hit) {
      fail("registry 不一致", `活标记号 ${no}（${claim.holder}）无 registry 条目：标记为身份真相，运行 --assign 补登记。`);
      continue;
    }
    const entry = hit.entry;
    if (entry.kind !== claim.kind) {
      fail(
        "registry 不一致",
        `registry 条目（号 ${no}）的 kind=${JSON.stringify(entry.kind)} 与活标记 kind=${claim.kind}（${claim.holder}）不一致：运行 --assign 修指向（合法改写仅限迁移/延续/归档）。`,
      );
      continue;
    }
    if (claim.kind === "spec") {
      if (entry.specRoot !== claim.specRoot) {
        fail("registry 不一致", `registry 条目（号 ${no}）指向 ${JSON.stringify(entry.specRoot)}，活标记在 ${claim.specRoot}：运行 --assign 更新指向（延续/归档后）。`);
      }
    } else if (entry.file !== claim.file) {
      fail("registry 不一致", `registry 条目（号 ${no}）指向 ${JSON.stringify(entry.file)}，活标记在 ${claim.file}（${claim.holder}）：运行 --assign 更新指向（迁移/归档后）。`);
    }
  }

  for (const { entry } of entryByNo.values()) {
    if (byNo.has(entry.no)) continue;
    const { ref, state } = directRefQuery(root, entry);
    if (state === "archived") {
      // 归档直查（勘误 10）：指向路径存在且含该号标记 → 通过并 note（号与条目保留、seq 不回落）。
      note(
        FIRST_PARTY_SOURCES[1].path,
        `registry 条目 ${entry.no}（${JSON.stringify(ref)}）：按指向路径直查——存在且含号标记，按已归档件通过（号与条目保留、seq 不回落，勘误 10）。`,
      );
      continue;
    }
    if (state === "exists") {
      note(FIRST_PARTY_SOURCES[1].path, `registry 条目 ${entry.no}（${JSON.stringify(ref)}）在当前活条目中无对应：号成空洞（合法，号不复用，§3.2）。`);
      continue;
    }
    // 指向不存在（勘误 10）：归档候选已验证（移动后未 run --assign）→ 失败级独立诊断（可机械修复）；
    // 无已验证候选（源真删/改名）→ 提示级独立诊断（空洞但指向悬空，§3.2 号不复用仍合法，不再用通用空洞文案放行）。
    const cand = archiveCandidateOf(ref);
    const candOk = cand !== null && archiveRefVerified(root, entry, cand);
    if (candOk) {
      fail(
        "registry 不一致",
        `registry 条目（号 ${entry.no}）指向 ${JSON.stringify(ref)} 不存在：归档路径 ${JSON.stringify(cand)} 存在且含该号标记（已归档移动）——指向未随移动更新，运行 --assign 改写指向（号不变、assignedAt 保留，勘误 10）。`,
      );
      continue;
    }
    note(
      FIRST_PARTY_SOURCES[1].path,
      `registry 条目 ${entry.no}（${JSON.stringify(ref)}）指向不存在且无可验证归档件（候选 ${JSON.stringify(cand ?? "（无可推导候选）")} 亦不存在）：号永不回收、条目保留（§3.2）——请核对归档位置或人工核对指向（勘误 10）。`,
    );
  }
}

/** 板互检：磁盘 board.json（若存在）↔ 重编译期望（掩码根 updatedAt）+ 结构校验。 */
function checkBoardArtifact(root, freshBoard, fail, note) {
  const rel = BOARD_JSON_REL;

  // 事实互证（#56）：重编译基线自洽性——编译器派生回归的机械防线（板不存在也执行：
  // 源→派生的四条不变量在内存产物上独立复算，违例即点名，不静默）。
  for (const m of checkFactInvariants({ board: freshBoard, boardMd: renderBoardMd(freshBoard) })) {
    fail("事实互证", `重编译产物：${m}`);
  }

  const loaded = readJsonFile(join(root, rel));
  if (loaded.missing) {
    note(rel, "board.json 不存在：跳过板/源互检（先运行默认编译生成板；--check 只读，不写板）。");
    return { compared: false, diffCount: 0 };
  }
  if (!loaded.ok) {
    fail("板结构校验", `${rel} 解析失败（${loaded.error}）：无法审计（重编译即可修复）。`);
    return { compared: false, diffCount: 0 };
  }

  // 事实互证（#56）：磁盘板四条不变量（编号形态需 board.md 配对文本；缺失 → 跳过 (c) 并提示）
  const mdLoaded = readTextFile(join(root, BOARD_MD_REL));
  for (const m of checkFactInvariants({ board: loaded.value, boardMd: mdLoaded.ok ? mdLoaded.text : null })) {
    fail("事实互证", `${rel}：${m}`);
  }
  if (!mdLoaded.ok) {
    note(
      BOARD_MD_REL,
      `board.md ${mdLoaded.missing ? "不存在" : `读取失败（${mdLoaded.error}）`}：跳过编号形态互证（先运行默认编译生成板；--check 只读，不写板）。`,
    );
  }

  // 结构校验：磁盘板与重编译期望都过检（schema 子集 + T7 公共不变量；期望基线自洽性同样审计）
  const structural = [];
  const schemaLoaded = readJsonFile(SCHEMA_PATH);
  if (!schemaLoaded.ok) {
    structural.push(`board.schema.json 不可用（${schemaLoaded.missing ? "不存在" : schemaLoaded.error}）：无法做结构校验`);
  } else {
    for (const e of checkSchemaSubset(schemaLoaded.value)) structural.push(`board.schema.json 自身违反关键字子集约束：${e}`);
    for (const e of validateSchemaValue(schemaLoaded.value, loaded.value)) structural.push(`${rel}：${e}`);
  }
  for (const e of checkBoardInvariants(loaded.value)) structural.push(`${rel}：${e}`);
  for (const e of checkBoardInvariants(freshBoard)) structural.push(`重编译产物自洽性：${e}`);
  for (const message of structural) fail("板结构校验", message);

  // 板/源互检（篡改或陈旧检测）：根 updatedAt 为编译时刻，掩码后逐字段比对
  const masked = (b) => ({ ...b, updatedAt: "<编译时刻>" });
  const diff = diffJsonValues(masked(freshBoard), masked(loaded.value), { limit: 20 });
  if (diff.count > 0) {
    fail(
      "board 不一致",
      `board.json 与重编译期望不一致（${diff.count} 处差异，显示前 ${diff.lines.length} 处；根 updatedAt 为编译时刻已掩码；篡改或板陈旧，重编译即可修复）：`,
      diff.lines,
    );
  }
  return { compared: true, diffCount: diff.count };
}

/**
 * 审计（--check；设计 §3.2 附加校验 / §13 场景 9/10/19；任务 T10）：
 *   全程只读——不写板、不写 registry、不改任何源文件。
 *   1. 内存重编译（与默认模式同一编译管线）作为期望基线；其诊断作为提示级 notes（不阻断）；
 *   2. 源完整性扫描：损坏源 → 失败（非零退出）；
 *   3. 活条目清单 ↔ registry 互检：活号唯一 + 条目 kind/指向一致（裁决序：标记 > registry）；
 *   4. board.json（若存在）↔ 期望基线比对（篡改/陈旧）+ 结构校验（T1 子集 + T7 公共不变量）；
 *   5. 事实互证（#56）：四条不变量（子卡全完成→已完成 / 有卡不得挂未拆解 / board.md 编号形态 ↔
 *      planCode·label 派生 / 段位计数复算）在磁盘板与重编译基线上各判定一遍，违例失败级点名。
 * 返回 { root, board, failures, notes, ok, compared }；退出码归 CLI（0 通过 / 非零有失败项）。
 */
export function checkProject(rootInput) {
  const root = resolve(rootInput);
  const failures = [];
  const notes = [];
  const fail = (category, message, detail) =>
    failures.push({ category, message, ...(Array.isArray(detail) && detail.length > 0 ? { detail } : {}) });
  const note = (path, message) => notes.push({ path, message });

  const board = compileProject(root);
  // 扫描面配置错误（#72）：编译侧作为 diagnostics 落板，审计侧另归「扫描面配置」失败项（见 collectCheckFacts），
  // 此处不重复进提示级 notes。
  for (const d of board.diagnostics) {
    if (d.path === SCAN_CONFIG_REL) continue;
    note(d.path, d.message);
  }

  const facts = collectCheckFacts(root, fail);
  checkRegistryConsistency(facts, fail, note);
  const artifact = checkBoardArtifact(root, board, fail, note);

  return { root, board, failures, notes, ok: failures.length === 0, compared: artifact.compared };
}

// ---------------------------------------------------------------- 技能包 manifest（#67，P2 分发前置件）

/**
 * manifest 覆盖的关键文件（技能根相对路径，posix 形态）：SKILL.md + 编译器 + lib 全部 + 契约 + schema。
 * 键序固定（固定项在前、lib 字典序），保证重新生成逐字节可比。
 */
export function manifestFileList() {
  const files = ["SKILL.md", "assets/board.schema.json", "assets/compile-board.mjs", "assets/contracts/markers.md"];
  for (const name of readdirSync(join(SKILL_ROOT_DIR, "assets", "lib")).sort()) {
    if (name.endsWith(".mjs")) files.push(`assets/lib/${name}`);
  }
  return files;
}

/** 生成 manifest 对象：三版本读 lib/version.mjs（唯一事实源）+ 关键文件 sha256（内容寻址）。 */
export function buildManifest() {
  const info = readVersionInfo();
  const files = {};
  for (const rel of manifestFileList()) {
    files[rel] = createHash("sha256")
      .update(readFileSync(join(SKILL_ROOT_DIR, rel)))
      .digest("hex");
  }
  return {
    _note:
      "zcode-board 技能包清单（#67）：包版本唯一事实源 = assets/lib/version.mjs 的 SKILL_VERSION；" +
      "files 为技能根相对路径的 sha256（内容寻址，P2 分发比对直接用）。重新生成：node assets/compile-board.mjs --manifest。",
    packageVersion: info.packageVersion,
    contractVersion: info.contractVersion,
    schemaVersion: info.schemaVersion,
    generatedAt: nowIso(),
    files,
  };
}

// ---------------------------------------------------------------- CLI

const USAGE = `zcode-board 编译器（默认只读；--assign 发号；--check 审计；--version / --manifest 辅助）

用法：
  node compile-board.mjs [<project-root>] [--assign] [--force] [--check]
  node compile-board.mjs --version
  node compile-board.mjs --manifest

参数：
  <project-root>   项目根目录（默认：当前工作目录）
  --assign         发号：无号条目领全局稳定号，写源头号标记 + 原子写 registry.json + 自动重编译
  --force          仅配合 --assign：单次发现 >10 个未领号计划文件时强制放行（默认拒绝——防 mass 改写；
                   放行留诊断痕迹；先核查扫描面 .zcode/board/scan.json 或拆分登记）
  --plan-code <文件>=<码>   仅配合 --assign：手工指定计划码（4 位：首字符字母 + 大写字母数字，如 UI01）；
                   可重复；缺省按文件名/标题自动派生（已有码不重分配）
  --check          审计（只读）：源/registry/board.json 三方一致、活号唯一、结构校验；不一致非零退出
  --version        显示版本（单行：包版本 / 契约版本 / schema 版本）；只读，不需要 <project-root>
  --manifest       重新生成 assets/manifest.json（技能包清单：三版本 + 关键文件 sha256，内容寻址）；
                   不读取 <项目根>、不写板
  -h, --help       显示本帮助

行为：
  扫描 .zcode/board/{interviews,registry,runs}.json、specs/<f>/{progress.json,tasks.md} 与
  .zcode/plans/、docs/plans/、docs/design-notes/ 三类计划目录，取号标记（含 v2.3 roadmap 子旗标：
  计划稿 H1 层 <!-- zcode-board: roadmap --> 或与 no= 同注释）与任务语法归一后，
  派生 status/statusRule、段位 stage/stageRule（计划稿特性随子卡汇总；roadmap 占位稿恒待设计，
  但取消终态让位——卡级/特性级 cancelled 与全取消汇总照常"已取消"，#66）、
  lastRun/activeRun/worktree/pr、nextAssignee（管线序首个无 done run 证据角色）、四缺口码与诊断，
  原子写出 <project-root>/.zcode/board/board.json 与 board.md。

  --assign 模式：按确定性扫描顺序（specs 字典序 → 计划目录冻结序 → 文件内文档序）发号——
  计划稿盖文件头标记、条目行尾盖号（只增不改，逐文件原子写），spec 特性号 registry 内绑定；
  seq 高水位只增；registry 丢失按活标记重建；冲突/篡改不静默改写（diagnostics + 未领号降级）；
  归档条目按勘误 10 映射改写指向（file/specRoot → 归档路径，号不变、assignedAt 保留）；
  发号后自动重编译。写入面仅限号标记与 registry（设计 §12）。

  --check 模式（全程只读，不写板/registry/源）：内存重编译为期望基线，随后——
  (1) 源完整性：解析失败/结构不合法/不受支持版本 → 失败（退出码 1）；
  (2) 活条目清单 ↔ registry：活号唯一（同号多实体 → 失败）、活标记必有 registry 条目、
      条目 kind/指向一致（合法改写仅限迁移/延续/归档）；空洞条目（指向文件仍在且无该号标记）合法；
      归档条目按指向路径直查——存在且含该号标记 → 通过并 note"已归档"；指向不存在：归档候选已验证 →
      失败级（运行 --assign 可修），无候选 → 提示级独立诊断（勘误 10）；
  (3) board.json（若存在）↔ 期望基线比对（篡改/板陈旧 → 差异报告 + 失败）+ 结构校验
      （board.schema.json 子集 + T7 公共不变量：引用位整数、attentionSummary 逐码相等等）；
  (4) 事实互证（#56，lib/fact-invariants.mjs 纯函数；磁盘板与重编译基线各跑一遍）：
      (a) 特性子卡全部 completed → 特性 stage=已完成（计划稿特性段位随子卡汇总，契约 v2.3）；
      (b) 已有任务卡的特性不得挂 arranged-not-expanded（判据为零卡；roadmap 稿同理）；
      (c) board.md 渲染编号形态 ↔ board.json 的 planCode/label 派生一致（嵌套任务行含深度 ≥2）；
      (d) 段位计数（board.json 如携带 stageSummary）与全板节点 stage 逐项复算相等。
      违例失败级：点名路径 + 节点编号 + 两值对照；板正常时零噪声。
  通过退出码 0；有失败项退出码 1；用法错误退出码 2。修复 = 重编译（或 --assign），--check 不自动修。

  --manifest 模式（#67）：重新生成 assets/manifest.json（技能包清单）——packageVersion / contractVersion /
  schemaVersion 分别读 lib/version.mjs 常量、markers.md 变更段头、board.schema.json 的 x-schemaVersion；
  files 为关键文件（SKILL.md、编译器、lib 全部、contracts/markers.md、board.schema.json）的 sha256
  （内容寻址，P2 分发比对直接用）。不读取 <项目根>、不写板。

硬约束：
  默认模式对源文件零写入；--check 全程只读；不解析 .zcode/workflows/；不执行 git 命令；
  无第三方依赖（仅 node 内置）。
`;

function main(argv) {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv.includes("--version")) {
    process.stdout.write(`${formatVersionLine()}\n`);
    return 0;
  }
  const args = [...argv];
  const planCodeRequests = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "--plan-code") continue;
    const value = args[i + 1] ?? "";
    const eq = value.indexOf("=");
    if (eq <= 0) {
      process.stderr.write(
        `compile-board: --plan-code 需要 <计划稿相对路径>=<4位码> 形态，实际 ${JSON.stringify(value)}\n`,
      );
      return 2;
    }
    planCodeRequests.push({ file: value.slice(0, eq), code: value.slice(eq + 1) });
    args.splice(i, 2);
    i -= 1;
  }
  const flags = args.filter((a) => a.startsWith("-"));
  const unknown = flags.filter((f) => f !== "--assign" && f !== "--check" && f !== "--manifest" && f !== "--force");
  if (unknown.length > 0) {
    process.stderr.write(`compile-board: 未知选项 ${unknown.join(" ")}（可用：--assign / --check / --manifest / --force / --version / --plan-code）\n`);
    return 2;
  }
  const assign = flags.includes("--assign");
  const check = flags.includes("--check");
  const manifest = flags.includes("--manifest");
  const force = flags.includes("--force");
  if ([assign, check, manifest].filter(Boolean).length > 1) {
    process.stderr.write("compile-board: --assign / --check / --manifest 互斥\n");
    return 2;
  }
  if (force && !assign) {
    process.stderr.write("compile-board: --force 仅在 --assign 模式下有效（防 mass 改写闸的强制放行）\n");
    return 2;
  }
  if (planCodeRequests.length > 0 && !assign) {
    process.stderr.write("compile-board: --plan-code 仅在 --assign 模式下有效（计划码在发号时分配）\n");
    return 2;
  }
  const positional = args.filter((a) => !a.startsWith("-"));
  if (positional.length > 1) {
    process.stderr.write("compile-board: 只接受一个 <project-root> 参数\n");
    return 2;
  }
  if (manifest) {
    if (positional.length > 0) {
      process.stderr.write("compile-board: --manifest 不接受 <project-root>（技能资产清单与项目无关）\n");
      return 2;
    }
    const manifestPath = join(SKILL_ROOT_DIR, MANIFEST_REL);
    writeJsonAtomic(manifestPath, buildManifest());
    process.stdout.write(
      `manifest 已写出：${manifestPath}（${formatVersionLine()} · files=${manifestFileList().length}）\n`,
    );
    return 0;
  }
  const root = resolve(positional[0] ?? process.cwd());
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    process.stderr.write(`compile-board: 项目根不存在或不是目录：${root}\n`);
    return 2;
  }

  if (check) {
    const res = checkProject(root);
    const taskCount = res.board.features.reduce((n, f) => n + countTasks(f.tasks ?? []), 0);
    const out = [];
    out.push(`--check：${res.root}`);
    out.push(
      `节点：features=${res.board.features.length} tasks=${taskCount}；诊断 ${res.notes.length} 条（提示级，不阻断）；` +
        `板比对：${res.compared ? "board.json 与重编译期望逐字段比对（根 updatedAt 为编译时刻，已掩码）" : "跳过（板不存在或不可解析）"}`,
    );
    if (res.notes.length > 0) {
      out.push(`诊断 ${res.notes.length} 条（提示级，不阻断）：`);
      for (const d of res.notes) out.push(`  - ${d.path}：${d.message}`);
    }
    if (res.failures.length > 0) {
      out.push(`校验失败 ${res.failures.length} 项：`);
      for (const f of res.failures) {
        out.push(`  - [${f.category}] ${f.message}`);
        for (const line of f.detail ?? []) out.push(`      · ${line}`);
      }
      out.push(`结论：--check 失败（${res.failures.length} 项失败）`);
    } else {
      out.push("结论：--check 通过（0 项失败）");
    }
    process.stdout.write(`${out.join("\n")}\n`);
    return res.ok ? 0 : 1;
  }

  if (assign) {
    const res = assignProject(root, { planCodeRequests, force });
    for (const d of res.diagnostics) {
      process.stderr.write(`assign 诊断：${d.path}：${d.message}\n`);
    }
    if (res.refused) {
      process.stdout.write(
        `--assign 拒绝执行（防 mass 改写闸，${res.refusedReason}）：发现 ${res.unnumberedPlanFiles.length} 个未领号计划文件（阈值：单次 >${MASS_PLAN_FILE_THRESHOLD}）——零写入、零发号；确认扫描面无误后加 --force 继续。\n`,
      );
      return 1;
    }
    const taskCount = res.board.features.reduce((n, f) => n + countTasks(f.tasks ?? []), 0);
    process.stdout.write(
      `--assign 完成：新发号 ${res.assignedCount} 个（seq=${res.registry.seq}）；` +
        `号标记写回 ${res.changedMarkerFiles.length} 个文件；registry ${res.registryWritten ? "已原子写" : "无变化（未写）"}；` +
        `诊断 ${res.diagnostics.length} 条\n`,
    );
    process.stdout.write(
      `board.json 已写出：.zcode/board/board.json（features=${res.board.features.length} tasks=${taskCount} diagnostics=${res.board.diagnostics.length}）\n`,
    );
    return 0;
  }

  const board = compileProject(root);
  const boardDir = join(root, ".zcode", "board");
  // board.json 是 UI 唯一读取点：最后写（两文件各自原子，§12 不落半成品）
  writeFileAtomic(join(boardDir, "board.md"), renderBoardMd(board));
  writeJsonAtomic(join(boardDir, "board.json"), board);

  const taskCount = board.features.reduce((n, f) => n + countTasks(f.tasks ?? []), 0);
  process.stdout.write(
    `board.json 已写出：.zcode/board/board.json（features=${board.features.length} tasks=${taskCount} diagnostics=${board.diagnostics.length}）\n`,
  );
  return 0;
}

/**
 * 入口守卫同一文件判定（#69）：两侧都按 realpathSync 归一后比较。
 * 原因（T6667v/10 实证）：Node 对模块路径取 realpath 写 import.meta.url，而 process.argv[1] 原样保留调用时
 * 的符号链接成分（macOS /tmp→/private/tmp、/var→/private/var，或显式软链目录）——原 resolve() 直接比较
 * 在含符号链接成分的路径下不相等，入口静默 exit 0、主逻辑不执行（无输出、无报错）。
 * realpath 失败（理论不可达：argv[1] 即本文件）退回原比较，不引入新静默分支。
 */
function sameRealFile(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath !== "" && sameRealFile(invokedPath, fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
