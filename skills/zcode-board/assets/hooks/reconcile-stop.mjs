#!/usr/bin/env node
/**
 * zcode-board / reconcile-stop（T13 交付物）——Stop 收尾对账（点名四类，不阻断）
 *
 * 职责（设计 §5.4 / §10.4 第 2 项 / 勘误 10；R3 裁决）：
 *   会话结束时机械点名四类"该进板而没进的"：
 *     1. 未登记——Stop 载荷（responseText）中出现但 runs.json 无对应记录的 run_event 块
 *        （后台派发未代触发落账的机械可查半边；无块可核验时在正文注明"编排者自查"）；
 *     2. 未合并——板上 attention 含 unmerged-worktree 的卡（执行现场未回流）；
 *     3. 板陈旧——sources[] 任一文件 mtime 新于 board.updatedAt（秒精度 +1s 容差）；
 *     4. 待归档——特性 status=completed 且 updatedAt 超过 7 天冷却期仍留在扫描目录（只点名，移动归编排者）。
 *
 * 投递形态（A6 实测 / R3 裁决）：**不强推续跑**——Stop 的 additionalContext 仅在
 * continue/decision:block 时投递且每会话限 3 次，退出码 2 会被译为阻断并意外续跑；
 * 故本 hook stdout 恒为空、显式 exit 0，对账正文写入 `.zcode/board/last-reconcile.md`
 * （下次 SessionStart 注入 + 人可直读）。对账失败无副作用、永不阻塞主流程。
 *
 * 无第三方依赖（仅 node 内置）。
 */

import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { isoLocal, readJsonFile, writeFileAtomic } from "../lib/board-io.mjs";
import { extractRunEvents, runMatchesBlock } from "./record-run.mjs";

const BOARD_REL = ".zcode/board/board.json";
const RUNS_REL = ".zcode/board/runs.json";
const LAST_RECONCILE_REL = ".zcode/board/last-reconcile.md";
/** schema 展开上限（board.schema.json x-decisions：feature → task → subtask，深度 3）。 */
const SCHEMA_CARD_DEPTH = 3;
/** 归档冷却期（天；勘误 10 建议值——常量可配，本期不引入旋钮）。 */
const ARCHIVE_COOLDOWN_DAYS = 7;
/** 秒精度时间戳的比对容差（board.updatedAt 为秒精度）。 */
const STALE_TOLERANCE_MS = 1000;

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

// ---------------------------------------------------------------- 四类检查

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

// ---------------------------------------------------------------- 报告渲染

function renderResults({ stamp, sessionId, unregistered, unmerged, stale, archive, boardState }) {
  const counts = {
    unregistered: unregistered.entries.length,
    unmerged: unmerged.entries.length,
    stale: stale.entries.length,
    archive: archive.entries.length,
  };
  const total = counts.unregistered + counts.unmerged + counts.stale + counts.archive;
  const lines = [];
  lines.push("# 收尾对账（Stop hook 自动生成）");
  lines.push("");
  lines.push(`- 时间：${stamp}`);
  lines.push(`- 会话：${sessionId ?? "（未知）"}`);
  if (boardState === "missing") lines.push(`- 板状态：${BOARD_REL} 缺失——板侧三类（未合并/板陈旧/待归档）无法检查；先运行编译器生成板。`);
  else if (boardState !== "ok") lines.push(`- 板状态：${BOARD_REL} 损坏（无法读取）——板侧三类无法检查；请运行编译器重建。`);
  lines.push(
    total === 0
      ? "- 结论：四类均无（对账通过）"
      : `- 结论：点名 ${total} 项（未登记 ${counts.unregistered} / 未合并 ${counts.unmerged} / 板陈旧 ${counts.stale} / 待归档 ${counts.archive}）`,
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
    lines.push("");
  };
  section(1, "未登记 run", "unregistered", unregistered);
  section(2, "未合并现场", "unmerged", unmerged);
  section(3, "板陈旧", "stale", stale);
  section(4, "待归档特性", "archive", archive);
  return `${lines.join("\n").trimEnd()}\n`;
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

  const md = renderResults({
    stamp: isoLocal(new Date()),
    sessionId: typeof payload?.sessionId === "string" ? payload.sessionId : typeof payload?.session_id === "string" ? payload.session_id : null,
    unregistered,
    unmerged,
    stale,
    archive,
    boardState,
  });
  try {
    writeFileAtomic(join(root, LAST_RECONCILE_REL), md);
    log(`对账已写入 ${LAST_RECONCILE_REL}（点名 ${unregistered.entries.length + unmerged.entries.length + stale.entries.length + archive.entries.length} 项）。`);
  } catch (e) {
    log(`对账写盘失败（${e.message}）：不阻塞（stderr 已留痕）。`);
  }
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  log(`对账异常（${e?.message ?? e}）：不阻塞主流程。`);
  process.exit(0);
}
