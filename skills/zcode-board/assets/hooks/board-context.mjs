#!/usr/bin/env node
/**
 * zcode-board / board-context（T13 交付物）——SessionStart 板摘要注入
 *
 * 职责（设计 §5.4/§10.4 第 1 项，A6 实测约束）：
 *   读 <项目根>/.zcode/board/board.json → 输出**单个 JSON 对象**到 stdout：
 *     {"additionalContext": "<缺口摘要 + 断点 top-N + 上次对账摘要>"}
 *   - 注入通道只认 JSON：纯文本/空输出整条静默丢弃（A6 §1.2）→ stdout 只写这一份 JSON；
 *   - 32KB 收集上限作用在 JSON 解析之前（超限=整条静默全丢），另有 24,000 字符注入闸（A6 §4）
 *     → 本脚本自检输出字节数（目标 ≤20KB 字节）与字符数，超限时截断 additionalContext、保 JSON 完整；
 *   - 板缺失/损坏 → 输出空态提示（不阻塞）；一切日志走 stderr；显式退出码 0。
 *
 * 输出范围（预算内精简）：attention 计数（四缺口）+ 断点 top-N（停在 #N + 下一步）+ 上次对账摘要。
 * 完整事实在 board.json / last-reconcile.md，本 hook 只做入口提示。
 *
 * 无第三方依赖（仅 node 内置）。
 */

import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { readJsonFile, isoLocal, readTextFile } from "../lib/board-io.mjs";

const BOARD_REL = ".zcode/board/board.json";
const LAST_RECONCILE_REL = ".zcode/board/last-reconcile.md";
/** 输出预算（A6 §4：32KB 硬上限留余量；24k 字符第二道闸）。 */
const OUTPUT_BYTE_BUDGET = 20 * 1024;
const OUTPUT_CHAR_BUDGET = 24_000;
/** 断点 top-N（预算内精简；完整清单在 board.json）。 */
const BREAKPOINT_TOP_N = 5;
/** schema 展开上限（board.schema.json x-decisions：feature → task → subtask，深度 3）。 */
const SCHEMA_CARD_DEPTH = 3;

function log(msg) {
  process.stderr.write(`board-context: ${msg}\n`);
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

function resolveRoot(payloadCwd) {
  for (const cand of [payloadCwd, process.env.ZCODE_PROJECT_DIR, process.env.CLAUDE_PROJECT_DIR, process.cwd()]) {
    if (typeof cand === "string" && cand !== "" && isDirectory(cand)) return resolve(cand);
  }
  return null;
}

/**
 * 全板卡片（与编译器同前序：特性 → 任务 → 其子任务…），供缺口断点清单；
 * 递归至 schema 展开上限 3（feature → task → subtask，board.schema.json x-decisions）——
 * 深度 3 嵌套卡的断点不遗漏（S4）。
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

/** 断点清单：attention 含 interrupted-resume 的卡（设计 §5.4 接续入口 = 停在#N + next 一句话）。 */
function collectBreakpoints(board) {
  const out = [];
  for (const card of allCards(board)) {
    if (!Array.isArray(card?.attention) || !card.attention.includes("interrupted-resume")) continue;
    out.push({
      no: card.no ?? null,
      label: cardLabel(card),
      title: typeof card.title === "string" ? card.title : "",
      lastRun: card.lastRun ?? null,
    });
  }
  out.sort((a, b) => String(b.lastRun?.at ?? "").localeCompare(String(a.lastRun?.at ?? "")));
  return out;
}

function formatBreakpoint(bp) {
  const run = bp.lastRun ?? {};
  const stopped = Number.isInteger(run.stoppedAt) ? `停在 #${run.stoppedAt}` : "停在（未记）";
  const next = typeof run.next === "string" && run.next !== "" ? run.next : "（未记下一步）";
  return `- ${bp.label}${bp.no != null ? ` #${bp.no}` : ""} ${bp.title}：${run.role ?? "?"} ${run.result ?? "?"} @ ${run.at ?? "?"}，${stopped}，下一步：${next}`;
}

/** 上次对账摘要：取 last-reconcile.md 的结论行（人可直读全文）。 */
function lastReconcileSummary(root) {
  const loaded = readTextFile(join(root, LAST_RECONCILE_REL));
  if (!loaded.ok) return null;
  const lines = loaded.text.split(/\r?\n/);
  const stamp = lines.find((l) => /-\s*时间/.test(l))?.replace(/^-\s*时间[：:]\s*/, "").trim() ?? null;
  const verdict = lines.find((l) => /-\s*结论/.test(l))?.replace(/^-\s*结论[：:]\s*/, "").trim() ?? null;
  if (stamp === null && verdict === null) return null;
  return `上次对账：${stamp ?? "（无时间）"} · ${verdict ?? "（无结论行）"}`;
}

/** 摘要正文（超限截断由 finalize 统一处理）。 */
function buildContext(root, board) {
  const lines = [];
  const now = isoLocal(new Date());
  if (board === null) {
    return [
      `[zcode-board] 本项目还没有看板：${BOARD_REL} 不存在（会话启动读板空态）。`,
      `- 生成时机：第一次访谈登记或第一个 spec/plan 被编译器发现时自动生成（编译命令见 zcode-board 技能 SKILL.md）。`,
      `- 处置（#72：生成板之前先核对扫描面，别直接重编译）：默认只扫 .zcode/plans/；docs/plans/、docs/design-notes/ 需项目级 .zcode/board/scan.json 显式 opt-in（includeDirs），单次 >10 个未领号计划文件会被拒绝（防批量改写）。`,
      `- 核对方式：先跑 node <zcode-board-skill>/assets/compile-board.mjs <项目根> --check 只读核对（扫描面预览 --preflight 随 #73 落地后以它为准）；确认扫描面无误再运行编译器生成板。`,
    ].join("\n");
  }
  if (!board.valid) {
    return [
      `[zcode-board] 板无法读取（损坏/结构非法）：${BOARD_REL}`,
      `- 原因：${board.error}`,
      `- 处置：在会话中运行编译器重建（node <zcode-board-skill>/assets/compile-board.mjs <项目根>）；不要手工编辑板文件。`,
    ].join("\n");
  }

  const b = board.value;
  const sum = b.attentionSummary ?? {};
  lines.push(`[zcode-board] 板摘要 @ ${now}（板更新于 ${b.updatedAt ?? "?"}，sources ${Array.isArray(b.sources) ? b.sources.length : "?"} 个，diagnostics ${Array.isArray(b.diagnostics) ? b.diagnostics.length : "?"} 条）`);
  lines.push(
    `缺口：已访谈未安排 ${sum.interviewedNotArranged ?? 0} · 已安排未展开 ${sum.arrangedNotExpanded ?? 0} · 执行中断可续 ${sum.interruptedResume ?? 0} · 待合并 ${sum.unmergedWorktree ?? 0}`,
  );

  const bps = collectBreakpoints(b);
  if (bps.length === 0) {
    lines.push("断点：无（无 interrupted-resume 卡）");
  } else {
    lines.push(`断点（${bps.length} 个，列前 ${Math.min(bps.length, BREAKPOINT_TOP_N)}，接续入口=停在#N+下一步）：`);
    for (const bp of bps.slice(0, BREAKPOINT_TOP_N)) lines.push(formatBreakpoint(bp));
    if (bps.length > BREAKPOINT_TOP_N) lines.push(`- …其余 ${bps.length - BREAKPOINT_TOP_N} 个见 board.json`);
  }

  const rec = lastReconcileSummary(root);
  if (rec !== null) lines.push(rec);

  const attentionTotal =
    (sum.interviewedNotArranged ?? 0) + (sum.arrangedNotExpanded ?? 0) + (sum.interruptedResume ?? 0) + (sum.unmergedWorktree ?? 0);
  if (attentionTotal > 0) lines.push("处置：缺口非零——先与用户确认处理顺序，再派发（板记录事实，不自动派发）。");
  return lines.join("\n");
}

/** 输出自检：超预算则按行截断 additionalContext，保 JSON 完整（超限=整条静默全丢）。 */
function finalize(text) {
  const wrap = (s) => JSON.stringify({ additionalContext: s });
  let body = text;
  if (Buffer.byteLength(wrap(body), "utf8") <= OUTPUT_BYTE_BUDGET && body.length <= OUTPUT_CHAR_BUDGET) return wrap(body);
  const marker = "\n…（摘要超出注入预算已截断；完整事实见 .zcode/board/board.json 与 last-reconcile.md）";
  const rows = body.split("\n");
  while (rows.length > 1) {
    rows.pop();
    body = `${rows.join("\n")}${marker}`;
    if (Buffer.byteLength(wrap(body), "utf8") <= OUTPUT_BYTE_BUDGET && body.length <= OUTPUT_CHAR_BUDGET) return wrap(body);
  }
  const hard = body.slice(0, 1000) + marker;
  return wrap(hard);
}

function main() {
  const payload = parsePayload(readStdin());
  const root = resolveRoot(payload?.cwd ?? null);
  if (root === null) {
    log("无法确定项目根（payload.cwd/环境变量/cwd 均不可用）：输出空态提示。");
    process.stdout.write(`${finalize("[zcode-board] 无法确定项目根：跳过板摘要（不阻塞；请核查 hook 配置 cwd）。")}\n`);
    return 0;
  }

  const loaded = readJsonFile(join(root, BOARD_REL));
  let board;
  if (loaded.missing) {
    board = null;
  } else if (!loaded.ok) {
    board = { valid: false, error: `JSON 解析失败：${loaded.error}` };
  } else if (loaded.value === null || typeof loaded.value !== "object" || Array.isArray(loaded.value) || !Array.isArray(loaded.value.features)) {
    board = { valid: false, error: "结构非法（features 必须为数组）" };
  } else {
    board = { valid: true, value: loaded.value };
  }

  const text = buildContext(root, board);
  process.stdout.write(`${finalize(text)}\n`);
  log(`已注入摘要（板：${loaded.missing ? "缺失" : board.valid ? "正常" : "损坏"}；字节 ${Buffer.byteLength(text, "utf8")}）。`);
  return 0;
}

process.exit(main());
