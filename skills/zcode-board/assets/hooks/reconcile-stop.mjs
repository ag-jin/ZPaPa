#!/usr/bin/env node
/**
 * zcode-board / reconcile-stop（T13 交付物）——Stop 收尾对账（点名四类 + 勾选=已合并点名，不阻断）
 *
 * 职责（设计 §5.4 / §10.4 第 2 项 / 勘误 10；R3 裁决）：
 *   会话结束时机械对账（四类点名 + 勾选=已合并点名 + 板滚未提交点名）：
 *     1. 未登记——Stop 载荷（responseText）中出现但 runs.json 无对应记录的 run_event 块
 *        （后台派发未代触发落账的机械可查半边；无块可核验时在正文注明"编排者自查"）；
 *     2. 未合并——板上 attention 含 unmerged-worktree 的卡（执行现场未回流）；
 *     3. 板陈旧——sources[] 任一文件 mtime 新于 board.updatedAt（秒精度 +1s 容差）；
 *     4. 待归档——特性 status=completed 且 updatedAt 超过 7 天冷却期仍留在扫描目录（只点名，移动归编排者）。
 *   5. 勾选=已合并点名（B1-2/#98）——completed 任务卡缺该卡 integrator done 的 run 证据（第五不变量 e，
 *      B1-1/#97）；判据复用 lib/fact-invariants.mjs（与 --check 同源，禁二份实现）；豁免登记
 *      .zcode/board/exemptions.json 经 lib/schema-check.mjs 校验后抑制点名（对账级，不阻断）。
 *   6. 兜底重编译（B3-3/#103；E1 V20 幻影板防线）——对账写盘后一律重编译（幂等：同输入同输出，
 *      根 updatedAt 除外）：Bash 通道漏检/人工编辑的漏网变更由此收口。顺序=检查先、重编译后
 *      （对账如实观察修复前状态：板陈旧等点名照常写入，C1 口径不变）；失败不阻塞、退出码恒 0。
 *   7. 板滚未提交（B5-5/#117；E1 V35；对账类别扩展）——板数据文件（board.json/board.md/registry/
 *      interviews/runs/exemptions）有变更而 `git status` 显示未提交 → 点名（提示级：提交建议=
 *      板滚并入收口 commit，E5 W3/G3 churn 治理方向）。非 git 项目/仓不可用跳过零噪声（结论行
 *      维持四类口径）；对账正文节号取 6——第 5 节已冻结归 B1-2「勾选=已合并点名」（两维并存：
 *      本类=板滚未提交，第 5 节=epic 勾选点名，互不混算）。
 *
 * 投递形态（A6 实测 / R3 裁决）：**不强推续跑**——Stop 的 additionalContext 仅在
 * continue/decision:block 时投递且每会话限 3 次，退出码 2 会被译为阻断并意外续跑；
 * 故本 hook stdout 恒为空、显式 exit 0，对账正文写入 `.zcode/board/last-reconcile.md`
 * （下次 SessionStart 注入 + 人可直读）。对账失败无副作用、永不阻塞主流程。
 *
 * 无第三方依赖（仅 node 内置）。
 */

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isFile, isoLocal, readJsonFile, writeFileAtomic } from "../lib/board-io.mjs";
import { checkCompletedMergedEvidence } from "../lib/fact-invariants.mjs";
import { checkExemptionsDoc, EXEMPTIONS_REL } from "../lib/schema-check.mjs";
import { extractRunEvents, runMatchesBlock } from "./record-run.mjs";

/**
 * 兜底重编译目标与超时（与 watch-sources 同口径）：技能包内编译器，绝对路径不由项目根派生。
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const COMPILER = resolve(HERE, "..", "compile-board.mjs");
const COMPILE_TIMEOUT_MS = 20_000;

const BOARD_REL = ".zcode/board/board.json";
const RUNS_REL = ".zcode/board/runs.json";
const LAST_RECONCILE_REL = ".zcode/board/last-reconcile.md";
/** 板目录（第五类「板滚未提交」检测面的相对路径基准）。 */
const BOARD_DIR_REL = ".zcode/board";
/**
 * 板数据文件（B5-5/#117；E1 V35；卡片枚举六件）：发号/落账/编译的板侧数据写入面。
 * evidence/ 子目录与 last-reconcile.md 不在本类（前者属证据域；后者归属未裁——E1 V34）。
 */
const CHURN_FILES = ["board.json", "board.md", "registry.json", "interviews.json", "runs.json", "exemptions.json"];
/** 一次有界 git 子进程（先例 gate-merge STD-1：单次 2s；本 hook 仅此一次 git 查询）。 */
const GIT_TIMEOUT_MS = 2_000;
/** schema 展开上限（board.schema.json x-decisions：feature → task → subtask，深度 3）。 */
const SCHEMA_CARD_DEPTH = 3;
/** 归档冷却期（天；勘误 10 建议值——常量可配，本期不引入旋钮）。 */
const ARCHIVE_COOLDOWN_DAYS = 7;
/** 秒精度时间戳的比对容差（board.updatedAt 为秒精度）。 */
const STALE_TOLERANCE_MS = 1000;
/**
 * 第五类（勾选=已合并点名）口径说明——写明豁免登记去向与字段（何处登记 / 字段 / 谁批）：
 * 登记文件 = `.zcode/board/exemptions.json`（编排者单写者；批准 = 用户拍板的速修/管理卡，
 * 由编排者登记，子智能体不得代写）；格式校验归 lib/schema-check.mjs（与 --check 同源）。
 */
const ROLLCALL_RULE_NOTE =
  "对账点名级（非失败、不阻断）：completed 任务卡（含嵌套）须有该卡 integrator done 的 run 证据（勾选=已合并 6.3）；" +
  "补录 integrator done 的 run 记录，或把速修/管理卡登记进 .zcode/board/exemptions.json" +
  "（编排者单写者；条目 {no, reason, at}——no 稳定号、reason 登记原因、at 带时区 ISO 8601）后不再点名。";
/**
 * 第五类（板滚未提交）口径说明——写明判据面、提交建议与噪声边界（B5-5/#117；E1 V35）：
 * 判据 = 六件板数据文件的 `git status --porcelain` 未提交态（含未跟踪/已暂存）；提示级不阻断；
 * 提交建议 = 板滚并入收口 commit（E5 W3/G3 churn 治理方向）——板真相源不跨会话裸奔。
 */
const CHURN_RULE_NOTE =
  "板滚未提交（提示级，非失败、不阻断）：板数据文件（board.json/board.md/registry/interviews/runs/exemptions）" +
  "有未提交变更即点名；提交建议＝板滚并入收口 commit（E5 W3/G3 churn 治理方向——板真相源随卡收口一并提交，" +
  "不重复开发、不单独增卡）。";

function log(msg) {
  process.stderr.write(`reconcile-stop: ${msg}\n`);
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function parsePayload(raw) {
  try {
    const v = JSON.parse(String(raw ?? "").trim());
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function mtimeMs(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 全板卡片（与编译器同前序：特性 → 任务 → 其子任务…），供未合并现场点名；
 * 递归至 schema 展开上限 3（feature → task → subtask，board.schema.json x-decisions）——
 * 深度 3 嵌套卡的未合并现场不遗漏（S4）。
 */
function allCards(board) {
  const out = [];
  const walkTasks = (tasks, depth) => {
    for (const t of tasks ?? []) {
      out.push(t);
      if (depth < SCHEMA_CARD_DEPTH) walkTasks(t.tasks, depth + 1);
    }
  };
  for (const f of board?.features ?? []) {
    out.push(f);
    walkTasks(f.tasks, 2);
  }
  return out;
}

function cardLabel(card) {
  return card?.label ? `ID-${card.label}` : card?.no ? `#${card.no}` : "未领号";
}

// ---------------------------------------------------------------- 检查（四类 + 第五类勾选=已合并点名）

/** 1. 未登记：responseText 中的 run_event 块 ↔ runs.json 记录。 */
function checkUnregistered({ responseText, runsDoc }) {
  const entries = [];
  if (typeof responseText !== "string" || responseText.trim() === "") {
    return { entries, note: "Stop 载荷无 responseText：无块可核验——编排者自查：本轮有无派发未代触发落账（5.4 仪式）。" };
  }
  const { blocks, diagnostics } = extractRunEvents(responseText);
  if (blocks.length === 0) {
    return { entries, note: "responseText 无 run_event 块可核验——编排者自查：本轮有无派发未代触发落账（5.4 仪式）。" };
  }
  const runs = Array.isArray(runsDoc?.runs) ? runsDoc.runs : [];
  blocks.forEach((block, idx) => {
    const role = typeof block?.role === "string" ? block.role : "?";
    const valid = runs.some((r) => runMatchesBlock(r, block));
    if (!valid) {
      const cards = Array.isArray(block?.cards) ? block.cards.filter((n) => Number.isInteger(n)) : [];
      const cardText = cards.length > 0 ? cards.map((n) => `#${n}`).join(",") : "[]";
      entries.push(`- 块 #${idx + 1}：role=${role} result=${JSON.stringify(block?.result ?? null)} cards=${cardText}——runs.json 无对应记录（缺代触发落账？）`);
    }
  });
  if (diagnostics.length > 0) entries.push(...diagnostics.map((d) => `- （核验提示）${d}`));
  return { entries, note: null };
}

/** 2. 未合并：attention 含 unmerged-worktree 的卡（含深度 3 嵌套卡）。 */
function checkUnmerged(board) {
  const entries = [];
  for (const card of allCards(board)) {
    if (!Array.isArray(card?.attention) || !card.attention.includes("unmerged-worktree")) continue;
    const wt = typeof card.worktree === "string" && card.worktree !== "" ? card.worktree : "（worktree 路径未记）";
    entries.push(`- ${cardLabel(card)}${card.no != null ? ` #${card.no}` : ""} ${card.title ?? ""}：${wt}（执行现场未回流——三绿后经 integrator 合并并正规清理）`);
  }
  return { entries, note: null };
}

/** 3. 板陈旧：sources[] 文件 mtime 新于 board.updatedAt（秒精度 +1s 容差）。 */
function checkStale(board, root) {
  const entries = [];
  const updatedAtMs = typeof board?.updatedAt === "string" ? Date.parse(board.updatedAt) : NaN;
  if (!Number.isFinite(updatedAtMs)) {
    return { entries, note: "board.updatedAt 不可解析：陈旧检测跳过（请重编译）。" };
  }
  const paths = new Set();
  for (const s of board.sources ?? []) {
    if (!s || typeof s !== "object") continue;
    if (typeof s.path === "string") paths.add(s.path);
    if (typeof s.root === "string" && Array.isArray(s.files)) {
      for (const f of s.files) paths.add(`${String(s.root).replace(/\/$/, "")}/${String(f).replace(/^\.\//, "")}`);
    }
  }
  for (const rel of [...paths].sort()) {
    const m = mtimeMs(join(root, rel));
    if (m !== null && m > updatedAtMs + STALE_TOLERANCE_MS) {
      entries.push(`- ${rel}（源 mtime ${isoLocal(new Date(m))} 新于板 updatedAt ${board.updatedAt}）`);
    }
  }
  return { entries, note: null };
}

/** 4. 待归档：completed 且超冷却期（按特性 updatedAt 机械可算；hook 只点名不移动）。 */
function checkArchive(board, now = Date.now()) {
  const entries = [];
  for (const f of board?.features ?? []) {
    if (f?.status !== "completed") continue;
    const updatedMs = typeof f.updatedAt === "string" ? Date.parse(f.updatedAt) : NaN;
    if (!Number.isFinite(updatedMs)) continue;
    const days = (now - updatedMs) / 86400_000;
    if (days <= ARCHIVE_COOLDOWN_DAYS) continue;
    const age = Math.floor(days);
    entries.push(
      `- ${cardLabel(f)}${f.no != null ? ` #${f.no}` : ""} ${f.title ?? ""}：completed @ ${f.updatedAt}（已 ${age} 天，超 ${ARCHIVE_COOLDOWN_DAYS} 天冷却）——归档 = 移动源文件（本工作区 .zcode/plans/ → .zcode/archive/；specs/<f>/ → specs/archive/<f>/；通用机制 docs/plans/ → docs/archive/plans/），hook 只点名不移动（勘误 10）`,
    );
  }
  return { entries, note: null };
}

/**
 * 最近仓根（纯 fs 上溯；先例 compile-board.mjs detectAssignSite——`.git` 文件亦算仓根，gitdir 指针形态）。
 * 非 git 项目（上溯至文件系统根无 .git）→ null：第五类整类跳过（零噪声、零子进程——夹具域不产 git 噪音）。
 */
function nearestRepoRoot(root) {
  let cur = resolve(root);
  for (;;) {
    try {
      statSync(join(cur, ".git"));
      return cur;
    } catch {
      // 本层无 .git：继续上溯
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * 6. 板滚未提交（B5-5/#117；E1 V35）：板数据文件有变更而 `git status` 显示未提交 → 点名。
 * 判据 = `git status --porcelain -uall -- <六件>`（未跟踪文件逐条列出；含已暂存未提交；2s 有界子进程）。
 * 非 git 项目 / 查询不可用 → 跳过并在节内写明（不误当通过、不静默）；对账级：只点名、不阻断、不写板。
 */
function checkBoardChurn(root) {
  if (nearestRepoRoot(root) === null) {
    return {
      entries: [],
      note: `${CHURN_RULE_NOTE}本工作区非 git 项目（上溯无 .git）：检测跳过（零噪声）。`,
      checked: false,
    };
  }
  const rels = CHURN_FILES.map((f) => `${BOARD_DIR_REL}/${f}`);
  const r = spawnSync("git", ["status", "--porcelain", "-uall", "--", ...rels], {
    cwd: root,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
  });
  if (r.error != null || r.status !== 0) {
    const first = String(r.stderr ?? "").trim().split("\n")[0] ?? "";
    const why = r.error != null ? r.error.message : first !== "" ? first : `git status 退出码 ${String(r.status)}`;
    return {
      entries: [],
      note: `${CHURN_RULE_NOTE}git status 不可用（${why}）：检测跳过（不误当通过；仓状态修复后重跑本对账即恢复）。`,
      checked: false,
    };
  }
  // porcelain 为定宽状态位（XY + 空格 + 路径）：不得整体 trim（会吃掉首位空格并错切路径）
  const entries = String(r.stdout ?? "")
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l !== "")
    .map((line) => {
      const code = line.slice(0, 2).trim() || "?";
      let p = line.slice(3);
      const arrow = p.indexOf(" -> ");
      if (arrow >= 0) p = p.slice(arrow + 4); // 改名行取新路径（旧路径命中 pathspec 时的形态）
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      return `- ${p}（未提交：${code}）——板滚并入收口 commit`;
    });
  return { entries, note: CHURN_RULE_NOTE, checked: true };
}

/**
 * 豁免登记读取（只读；B1-2/#98，口径与 --check 同源）：
 *   - 文件缺失 ≡ 零豁免（静默合法——豁免是例外登记，不是必填件）；
 *   - 解析失败 / 结构非法 / 条目非法 → 归 checkExemptionsDoc（lib/schema-check.mjs，禁二份实现），
 *     不生效的登记逐条提示（不静默放行）；合法条目照常生效。
 */
function loadExemptions(root) {
  const loaded = readJsonFile(join(root, EXEMPTIONS_REL));
  if (loaded.missing) return { exemptNos: [], notes: [] };
  if (!loaded.ok) {
    return {
      exemptNos: [],
      notes: [`${EXEMPTIONS_REL} 解析失败（${loaded.error}）：整份拒收（零豁免生效）——请修复后重跑 --check。`],
    };
  }
  const reg = checkExemptionsDoc(loaded.value);
  const notes = reg.errors.map((e) => `${EXEMPTIONS_REL}：${e}——该登记不生效（不静默放行）。`);
  if (reg.exemptNos.length > 0) notes.push(`已生效豁免 ${reg.exemptNos.length} 条（${EXEMPTIONS_REL}）——对应卡不再点名。`);
  return { exemptNos: reg.exemptNos, notes };
}

/**
 * 5. 勾选=已合并点名（B1-2/#98）：completed 任务卡缺该卡 integrator done 的 run 证据。
 * 判据复用 lib/fact-invariants.mjs checkCompletedMergedEvidence（与 --check 同源，禁二份实现）；
 * 可用性门与 --check 同口径：runs.json 缺失 ≡ 空证据（逐条点名）；解析失败/结构不合法 → 跳过并提示
 * （损坏源由其自身修复路径处理，此处不叠加点名噪音）。对账级：只点名、不阻断、不写板。
 */
function checkMergedEvidence({ board, runsLoaded, runsDoc, exemptNos, exemptionNotes }) {
  if (board === null) {
    return { entries: [], note: `板缺失或损坏：勾选=已合并取证无法检查（见上方板状态行）。`, notes: [...exemptionNotes], checked: false };
  }
  const runsUsable =
    runsLoaded.missing ||
    (runsLoaded.ok && runsDoc !== null && typeof runsDoc === "object" && !Array.isArray(runsDoc) && Array.isArray(runsDoc.runs));
  if (!runsUsable) {
    return {
      entries: [],
      note: `${RUNS_REL} 不可用（解析失败或结构不合法）：第五类跳过——先修复 runs.json（--check 会失败级点名）。`,
      notes: [...exemptionNotes],
      checked: false,
    };
  }
  const notes = [];
  if (runsLoaded.missing) notes.push(`${RUNS_REL} 缺失 ≡ 无 run 证据（逐条点名；落账后重跑本对账即消除）。`);
  notes.push(...exemptionNotes);
  return {
    entries: checkCompletedMergedEvidence({ board, runs: runsLoaded.missing ? [] : runsDoc.runs, exemptNos }),
    note: ROLLCALL_RULE_NOTE,
    notes,
    checked: true,
  };
}

// ---------------------------------------------------------------- 报告渲染

function renderResults({ stamp, sessionId, unregistered, unmerged, stale, archive, churn, rollcall, boardState }) {
  const counts = {
    unregistered: unregistered.entries.length,
    unmerged: unmerged.entries.length,
    stale: stale.entries.length,
    archive: archive.entries.length,
    churn: churn.entries.length,
    rollcall: rollcall.entries.length,
  };
  // 类计数：板滚未提交完成检查时计入（非 git 项目/仓不可用 → 跳过，维持四类口径不虚增）
  const total = counts.unregistered + counts.unmerged + counts.stale + counts.archive + counts.churn;
  const lines = [];
  lines.push("# 收尾对账（Stop hook 自动生成）");
  lines.push("");
  lines.push(`- 时间：${stamp}`);
  lines.push(`- 会话：${sessionId ?? "（未知）"}`);
  if (boardState === "missing") lines.push(`- 板状态：${BOARD_REL} 缺失——板侧四类（未合并/板陈旧/待归档/勾选=已合并取证）无法检查；先运行编译器生成板。`);
  else if (boardState !== "ok") lines.push(`- 板状态：${BOARD_REL} 损坏（无法读取）——板侧四类无法检查；请运行编译器重建。`);
  const verdict =
    total === 0
      ? churn.checked
        ? "- 结论：五类均无（对账通过）"
        : "- 结论：四类均无（对账通过）"
      : `- 结论：点名 ${total} 项（未登记 ${counts.unregistered} / 未合并 ${counts.unmerged} / 板陈旧 ${counts.stale} / 待归档 ${counts.archive}${churn.checked ? ` / 板滚未提交 ${counts.churn}` : ""}）`;
  lines.push(
    rollcall.checked && counts.rollcall > 0
      ? `${verdict}；勾选=已合并点名另计 ${counts.rollcall} 项（第 5 节——补录 integrator done 的 run 证据或登记豁免）`
      : verdict,
  );
  lines.push("");
  lines.push("对账非阻断（R3）：正文落本文件，下次 SessionStart 注入 + 人可直读；编排者答问后收尾（5.4）。");
  lines.push("");

  const section = (n, title, key, res) => {
    lines.push(`## ${n}. ${title}（${counts[key]}）`);
    lines.push("");
    if (res.entries.length === 0) lines.push("（无）");
    else lines.push(...res.entries);
    if (res.note) lines.push("", `说明：${res.note}`);
    for (const note of res.notes ?? []) lines.push(`提示：${note}`);
    lines.push("");
  };
  section(1, "未登记 run", "unregistered", unregistered);
  section(2, "未合并现场", "unmerged", unmerged);
  section(3, "板陈旧", "stale", stale);
  section(4, "待归档特性", "archive", archive);
  section(5, "勾选=已合并点名", "rollcall", rollcall);
  section(6, "板滚未提交", "churn", churn);
  return `${lines.join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------- 兜底重编译（B3-3/#103）

/**
 * 兜底重编译（B3-3/#103；E1 V20 幻影板防线）：Stop 收尾一律重编译——Bash 通道只告警不修复
 * （B3-1/B3-2），漏网变更由本兜底收口；重编译本身幂等（同输入同输出，根 updatedAt 除外），
 * 故连续两次 Stop 不产生额外板变更（run-t13 C10 双跑掩码断言）。
 * 失败不阻塞（投递语义与退出码不变）：编译器缺失跳过；启动失败/超时/非零退出只写 stderr 留痕。
 */
function recompile(root) {
  if (!isFile(COMPILER)) {
    log(`兜底重编译跳过：编译器不存在（${COMPILER}）。`);
    return;
  }
  const r = spawnSync(process.execPath, [COMPILER, root], { encoding: "utf8", timeout: COMPILE_TIMEOUT_MS });
  if (r.error) {
    log(`兜底重编译未完成（${r.error.message}）：不阻塞（下次 Stop/人工重编译兜底）。`);
    return;
  }
  if (r.status !== 0) {
    log(`兜底重编译失败（退出码 ${String(r.status)}）：${String(r.stderr ?? "").trim().slice(0, 300)}（不阻塞）`);
    return;
  }
  log(`兜底重编译完成：${String(r.stdout ?? "").trim()}（无源变更时仅编译时刻戳变化）`);
}

// ---------------------------------------------------------------- 主流程

function main() {
  const raw = readStdin();
  const payload = parsePayload(raw);
  const payloadCwd = typeof payload?.cwd === "string" ? payload.cwd : null;
  let root = null;
  for (const cand of [payloadCwd, process.env.ZCODE_PROJECT_DIR, process.env.CLAUDE_PROJECT_DIR, process.cwd()]) {
    if (typeof cand === "string" && cand !== "" && isDirectory(cand)) {
      root = resolve(cand);
      break;
    }
  }
  if (root === null) {
    log("无法确定项目根：跳过对账（不阻塞）。");
    return 0;
  }

  const loaded = readJsonFile(join(root, BOARD_REL));
  let boardState = "ok";
  let board = null;
  if (loaded.missing) {
    boardState = "missing";
  } else if (!loaded.ok) {
    boardState = "corrupt";
  } else if (loaded.value === null || typeof loaded.value !== "object" || Array.isArray(loaded.value) || !Array.isArray(loaded.value.features)) {
    boardState = "corrupt";
  } else {
    board = loaded.value;
  }

  const runsLoaded = readJsonFile(join(root, RUNS_REL));
  const runsDoc = runsLoaded.ok ? runsLoaded.value : null;

  const responseText =
    typeof payload?.responseText === "string"
      ? payload.responseText
      : typeof payload?.last_assistant_message === "string"
        ? payload.last_assistant_message
        : null;

  const unregistered = checkUnregistered({ responseText, runsDoc });
  const unmerged = board === null ? { entries: [], note: null } : checkUnmerged(board);
  const stale = board === null ? { entries: [], note: null } : checkStale(board, root);
  const archive = board === null ? { entries: [], note: null } : checkArchive(board);
  const churn = checkBoardChurn(root);
  const exemptions = loadExemptions(root);
  const rollcall = checkMergedEvidence({ board, runsLoaded, runsDoc, exemptNos: exemptions.exemptNos, exemptionNotes: exemptions.notes });

  const md = renderResults({
    stamp: isoLocal(new Date()),
    sessionId: typeof payload?.sessionId === "string" ? payload.sessionId : typeof payload?.session_id === "string" ? payload.session_id : null,
    unregistered,
    unmerged,
    stale,
    archive,
    churn,
    rollcall,
    boardState,
  });
  try {
    writeFileAtomic(join(root, LAST_RECONCILE_REL), md);
    log(`对账已写入 ${LAST_RECONCILE_REL}（点名 ${unregistered.entries.length + unmerged.entries.length + stale.entries.length + archive.entries.length + churn.entries.length} 项；勾选=已合并点名 ${rollcall.entries.length} 项）。`);
  } catch (e) {
    log(`对账写盘失败（${e.message}）：不阻塞（stderr 已留痕）。`);
  }
  // B3-3：收尾兜底重编译（检查先于重编译——点名为修复前状态观察，修复即落地；失败不阻塞）
  recompile(root);
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  log(`对账异常（${e?.message ?? e}）：不阻塞主流程。`);
  process.exit(0);
}
