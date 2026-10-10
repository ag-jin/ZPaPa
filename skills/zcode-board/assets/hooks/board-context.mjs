#!/usr/bin/env node
/**
 * zcode-board / board-context（T13 交付物）——SessionStart 板摘要注入
 *
 * 职责（设计 §5.4/§10.4 第 1 项，A6 实测约束）：
 *   读 <项目根>/.zcode/board/board.json → 输出**单个 JSON 对象**到 stdout：
 *     {"additionalContext": "<缺口摘要 + 断点 top-N + 上次对账摘要>"}
 *   - 注入通道只认 JSON：纯文本/空输出整条静默丢弃（A6 §1.2）→ stdout 只写这一份 JSON；
 *   - 32KB 收集上限作用在 JSON 解析之前（超限=整条静默全丢），另有 24,000 字符注入闸（A6 §4）
 *     → 本脚本输出前自检字节数与字符数（目标 ≤20KB 字节），超限时按保留位降级截断 additionalContext、
 *     保 JSON 完整（#132 预算级截断：先丢细节行、再丢次要摘要行；对账/处置关键行逐字保留）；
 *   - 板缺失/损坏 → 输出空态提示（不阻塞）；一切日志走 stderr；显式退出码 0。
 *
 * 输出范围（预算内精简）：attention 计数（四缺口）+ 缺口短清单（#130：按优先级逐条 + 一行处置指引）
 * + 在做/该接 top-N（#131：谁在做/谁该接，按在做→待接手→未开工；旧板无 nextAssignee 字段时只读派生）
 * + 断点 top-N（停在 #N + 下一步）+ 陈旧告警行（#131：已登记源新于板 updatedAt 时点名并指向重编译）
 * + 上次对账摘要。
 * 保留位（#132 预算级截断）：板摘要头、陈旧告警行、缺口计数头与清单头、缺口清单各行
 * （含 → 处置）、在做/该接计数头、上次对账行、处置行——档 1/2 降级不丢；档 3 兜底（单行或累计超闸）
 * 按行整取，装不下的关键行整行跳过并留 stderr 诊断。可牺牲：细节行（长标题/条目）与次要摘要行。
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
/** 缺口清单上限（#130：缺口多时截断保处置行——列前 N 条，其余归计数行）。 */
const GAP_TOP_N = 8;
/**
 * 缺口短清单注入契约（#130）：[缺口码, 行内短标签, 一行处置指引]，**数组顺序即优先级**
 * （落卡 → 拆卡 → 续跑 → 合并；与缺口计数行同序）；同码内按板内顺序（编译器顺序，hook 不重排）。
 * 文案改动即注入契约改动：同步 SKILL.md 注入节与 run-t13 B7/B8。
 */
const GAP_ROWS = [
  ["interviewed-not-arranged", "已访谈未安排", "向用户确认是否落卡（register-interview / 计划稿补条目）"],
  ["arranged-not-expanded", "已安排未展开", "特性拆卡（task-planner）"],
  ["interrupted-resume", "执行中断可续", "按 nextStep 续跑该卡"],
  ["unmerged-worktree", "待合并", "核对工作树现场后走 integrator 合并"],
];
/** 在做/该接 top-N（#131：预算内精简；完整事实在 board.json / frontier 派生）。 */
const ASSIGNEE_TOP_N = 5;
/** 不做"在做/该接"候选的段位：终态（无需接手）与 roadmap 占位（动作在缺口清单：落卡/拆卡）。 */
const NON_CANDIDATE_STAGES = new Set(["已完成", "已取消", "待设计"]);
/** runs 第一方源缺省相对路径（board.sources 声明 kind=runs 时以声明为准）。 */
const RUNS_REL = ".zcode/board/runs.json";
/** 陈旧判定容差（#131，与 reconcile-stop checkStale 同口径：秒精度 +1s，防同秒写入误报）。 */
const STALE_TOLERANCE_MS = 1000;
/** 陈旧告警最多点名的源路径数（其余归计数）。 */
const STALE_LIST_MAX = 3;
/**
 * 预算级截断保留位（#132）：超 20KB/24k 闸时按档降级——自尾部起先省低优先行（细节行 → 次要摘要行）。
 *   0=关键行：对账/处置类——板摘要头、陈旧告警行、缺口计数头与清单头、缺口清单各行（含 → 处置）、
 *     在做/该接计数头、上次对账行、处置行——档 1/2 降级逐字保留；档 3 兜底整行取舍（见 finalize）；
 *   1=细节行：在做/该接与断点条目（长标题、nextStep 长文所在）——先牺牲；
 *   2=次要摘要行：断点段头、各"…其余 N …"计数行——细节行丢完仍超再牺牲。
 * 与 C1-1 的清单级 top-N 截断是两层：清单级先截（生成时），预算级兜底（输出前）。
 */
const ROW_KEEP = 0;
const ROW_DETAIL = 1;
const ROW_SECONDARY = 2;
/** 截断标记（正常降级：细节/次要行已按优先序省略，关键行在列）。 */
const truncationMarker = (droppedRows) =>
  `…（摘要超出注入预算已截断：已省略 ${droppedRows} 行（细节行优先、清单尾部起），对账/处置关键行逐字保留；完整事实见 .zcode/board/board.json 与 last-reconcile.md）`;
/** 截断标记（兜底：关键行单行或累计超闸——病态板，按字节收口；F1 勘误：不止单行路径）。 */
const HARD_TRUNCATION_MARKER = "…（摘要超出注入预算已截断：关键行单行或累计超闸，按字节收口、诊断见 stderr；完整事实见 .zcode/board/board.json 与 last-reconcile.md）";

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

/** 缺口行条目标识：特性=#N；任务=ID-<树位> #N（号是身份、标签是排版）；访谈条目=itw-id。 */
function gapRef(card) {
  if (card?.no == null) {
    const iid = card?.origin?.interviewId;
    if (typeof iid === "string" && iid !== "") return iid;
    return typeof card?.label === "string" && card.label !== "" ? `ID-${card.label}` : "未领号";
  }
  return typeof card?.label === "string" && card.label !== "" && card.label !== String(card.no)
    ? `ID-${card.label} #${card.no}`
    : `#${card.no}`;
}

/**
 * 缺口短清单（#130）：按 GAP_ROWS 固定优先序收集全板（含深度 3 嵌套卡）挂 attention 的条目；
 * 一卡挂两码计两条（各自可处置）；同码内保持板内顺序（编译器顺序，不重排）。
 */
function collectGaps(board) {
  const cards = allCards(board);
  const out = [];
  for (const [code, short, action] of GAP_ROWS) {
    for (const card of cards) {
      if (!Array.isArray(card?.attention) || !card.attention.includes(code)) continue;
      out.push({ code, short, action, card });
    }
  }
  return out;
}

/** 一条一行处置指引；待合并行附现场路径（照做需知道核对哪里）。 */
function formatGapEntry(gap) {
  const card = gap.card;
  const title = typeof card?.title === "string" && card.title !== "" ? ` ${card.title}` : "";
  const site = gap.code === "unmerged-worktree" && typeof card?.worktree === "string" && card.worktree !== ""
    ? `（现场 ${card.worktree}）`
    : "";
  return `- ${gap.short} ${gapRef(card)}${title}${site} → ${gap.action}`;
}

/**
 * 单卡 runs 证据索引（#131 旧板派生用）：card no → 记录数组。
 * 来源：board.sources 里 kind=runs 的声明路径（缺省 .zcode/board/runs.json）——只读第一方源。
 */
function loadRunsIndex(root, board) {
  const declared = Array.isArray(board?.sources)
    ? board.sources.find((s) => s && s.kind === "runs" && typeof s.path === "string")
    : null;
  const rel = declared?.path ?? RUNS_REL;
  const loaded = readJsonFile(join(root, rel));
  if (!loaded.ok || !Array.isArray(loaded.value?.runs)) {
    log(`旧板缺 nextAssignee 且 runs 源不可读（${rel}）：本轮不做只读派生（重编译可恢复）。`);
    return null;
  }
  const byNo = new Map();
  for (const rec of loaded.value.runs) {
    if (!rec || typeof rec !== "object") continue;
    for (const n of Array.isArray(rec.cards) ? rec.cards : []) {
      if (!Number.isInteger(n)) continue;
      if (!byNo.has(n)) byNo.set(n, []);
      byNo.get(n).push(rec);
    }
  }
  return byNo;
}

/** 旧板（卡无 nextAssignee 字段）只读派生：管线序首个无 done 证据角色（口径镜像 lib/derive.mjs deriveNextAssignee）。 */
function deriveNextFromRuns(card, runsIndex) {
  const pipeline = Array.isArray(card?.assignees) ? card.assignees : [];
  if (pipeline.length === 0 || runsIndex === null || !Number.isInteger(card?.no)) return null;
  const doneRoles = new Set();
  for (const rec of runsIndex.get(card.no) ?? []) {
    if (rec.result === "done" && typeof rec.role === "string" && rec.role !== "") doneRoles.add(rec.role);
  }
  for (const role of pipeline) if (!doneRoles.has(role)) return role;
  return null;
}

/**
 * 在做/该接候选（#131）：谁在做（activeRun）+ 谁该接（nextAssignee）。
 * 选：段位非终态/非占位且 activeRun 或 nextAssignee 非空的卡（含深度 3 嵌套卡，不重排板内顺序）；
 * 排：在做 → 已开工待接手（lastRun 有记录）→ 未开工；同层按最近活动（在做/待接手用 run at、
 * 未开工用板卡 updatedAt）新→旧，并列按板内顺序（编译器顺序）。
 * nextAssignee 直读板字段——字段存在（含显式 null）即板事实、不重算，注入不早于板；仅旧板
 * 缺该字段才用 assignees 序 + runs 证据只读派生（旧板派生值可能新于板：此时陈旧告警行同时提醒重编译，
 * 重编译后回到板字段口径）。
 * C2 衔接注记（#131，交 C2-3 收口）：本清单是 C1 期的临时只读投影；C2-1 落地 board.json
 * frontier[]/active[] 派生后，本段应改为直接消费该派生段（同源消费、禁自算、禁二份口径），由 C2-3
 * 守卫断言咬同值；届时本函数与 runs 派生只保留旧板兼容角色。
 */
function collectAssigneeRows(board, loadRunsIndexOnce) {
  const cards = allCards(board);
  const needsDerive = cards.some((c) => c && !("nextAssignee" in c) && Array.isArray(c.assignees) && c.assignees.length > 0);
  const runsIndex = needsDerive ? loadRunsIndexOnce() : null;
  const rows = [];
  let order = 0;
  for (const card of cards) {
    order += 1;
    if (!card || NON_CANDIDATE_STAGES.has(card.stage)) continue;
    const active = card.activeRun && typeof card.activeRun === "object" ? card.activeRun : null;
    let next = null;
    if ("nextAssignee" in card) {
      next = typeof card.nextAssignee === "string" && card.nextAssignee !== "" ? card.nextAssignee : null;
    } else {
      next = deriveNextFromRuns(card, runsIndex);
    }
    if (active === null && next === null) continue;
    rows.push({ card, active, next, order });
  }
  const tierOf = (r) => (r.active ? 0 : r.card.lastRun ? 1 : 2);
  const keyOf = (r) => {
    if (tierOf(r) === 2) return String(r.card.updatedAt ?? "");
    return String((r.active ? r.active.at : r.card.lastRun?.at) ?? "");
  };
  rows.sort((a, b) => {
    const ta = tierOf(a);
    const tb = tierOf(b);
    if (ta !== tb) return ta - tb;
    const cmp = keyOf(b).localeCompare(keyOf(a)); // 最近活动在前
    if (cmp !== 0) return cmp;
    return a.order - b.order;
  });
  return rows;
}

/** 一行"在做/该接"：在做=角色+自何时+段位；该接=角色+上一手 run 摘要（或未开工）。 */
function formatAssigneeRow(row) {
  const card = row.card;
  const title = typeof card?.title === "string" && card.title !== "" ? ` ${card.title}` : "";
  if (row.active) {
    const stage = typeof card.stage === "string" && card.stage !== "" ? `（${card.stage}）` : "";
    return `- 在做 ${gapRef(card)}${title}：${row.active.role ?? "?"} 自 ${row.active.at ?? "?"}${stage}`;
  }
  const last = card.lastRun;
  const handoff = last && typeof last === "object"
    ? `（上一手 ${last.role ?? "?"} ${last.result ?? "?"} @ ${last.at ?? "?"}）`
    : "（无 run 记录）";
  return `- 该接 ${gapRef(card)}${title}：${row.next}${handoff}`;
}

/**
 * 陈旧判定（#131）：板 updatedAt vs 已登记源 mtime——sources[] 逐文件，任一 mtime > updatedAt + 1s 即陈旧。
 * 口径与 reconcile-stop checkStale §3 同源（同容差、同 spec root+files 展开）；删除源（mtime 不可得）/
 * 新增源（尚未进 sources[]）/非 Write|Edit 写入属 B3 线检测面扩展（watch-sources 侧，B3-1 在途）——
 * 本判定只覆盖"已登记源被改写后未重编译"，不重复实现盲区检测，也不改 watch-sources.mjs。
 * 返回 null（不陈旧/无法判定）或 {count, samples:[{path, mtimeMs}]}（板 updatedAt 已见摘要头行）。
 */
function detectStale(root, board) {
  const updatedAtMs = typeof board?.updatedAt === "string" ? Date.parse(board.updatedAt) : NaN;
  if (!Number.isFinite(updatedAtMs)) return null;
  const paths = new Set();
  for (const s of board.sources ?? []) {
    if (!s || typeof s !== "object") continue;
    if (typeof s.path === "string") paths.add(s.path);
    if (typeof s.root === "string" && Array.isArray(s.files)) {
      for (const f of s.files) paths.add(`${String(s.root).replace(/\/$/, "")}/${String(f).replace(/^\.\//, "")}`);
    }
  }
  const samples = [];
  for (const rel of [...paths].sort()) {
    let mtimeMs = null;
    try {
      mtimeMs = statSync(join(root, rel)).mtimeMs;
    } catch {
      continue; // 源缺失=删除面：归 B3-1 检测，本行不误报
    }
    if (mtimeMs > updatedAtMs + STALE_TOLERANCE_MS) samples.push({ path: rel, mtimeMs });
  }
  if (samples.length === 0) return null;
  return { count: samples.length, samples };
}

/** 陈旧告警行：点名变动源（最多 STALE_LIST_MAX 个）并给重编译命令（本 hook 只告警不重编译）。 */
function formatStaleAlert(stale) {
  const list = stale.samples.slice(0, STALE_LIST_MAX).map((s) => `${s.path} @ ${isoLocal(new Date(s.mtimeMs))}`).join("、");
  const rest = stale.count > STALE_LIST_MAX ? `，共 ${stale.count} 个` : "";
  return `陈旧告警：板可能过期——${stale.count} 个已登记源在板更新后变动（${list}${rest}）→ 重编译：node <zcode-board-skill>/assets/compile-board.mjs <项目根>`;
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

/**
 * 摘要行（预算级截断由 finalize 按保留位统一处理）：每行带 tier——见 ROW_KEEP/ROW_DETAIL/ROW_SECONDARY。
 * 行文本与顺序即注入契约：文案改动同步 SKILL.md 注入节与 run-t13 B1/B5/B7-B13。
 */
function buildRows(root, board) {
  const rows = [];
  const now = isoLocal(new Date());
  const row = (tier, text) => rows.push({ tier, text });
  if (board === null) {
    return [
      { tier: ROW_KEEP, text: `[zcode-board] 本项目还没有看板：${BOARD_REL} 不存在（会话启动读板空态）。` },
      { tier: ROW_KEEP, text: `- 生成时机：第一次访谈登记或第一个 spec/plan 被编译器发现时自动生成（编译命令见 zcode-board 技能 SKILL.md）。` },
      { tier: ROW_KEEP, text: `- 处置（#72：生成板之前先核对扫描面，别直接重编译）：默认只扫 .zcode/plans/；docs/plans/、docs/design-notes/ 需项目级 .zcode/board/scan.json 显式 opt-in（includeDirs），单次 >10 个未领号计划文件会被拒绝（防批量改写）。` },
      { tier: ROW_KEEP, text: `- 核对方式：先跑 node <zcode-board-skill>/assets/compile-board.mjs <项目根> --check 只读核对（扫描面预览 --preflight 随 #73 落地后以它为准）；确认扫描面无误再运行编译器生成板。` },
    ];
  }
  if (!board.valid) {
    return [
      { tier: ROW_KEEP, text: `[zcode-board] 板无法读取（损坏/结构非法）：${BOARD_REL}` },
      { tier: ROW_KEEP, text: `- 原因：${board.error}` },
      { tier: ROW_KEEP, text: `- 处置：在会话中运行编译器重建（node <zcode-board-skill>/assets/compile-board.mjs <项目根>）；不要手工编辑板文件。` },
    ];
  }

  const b = board.value;
  const sum = b.attentionSummary ?? {};
  row(ROW_KEEP, `[zcode-board] 板摘要 @ ${now}（板更新于 ${b.updatedAt ?? "?"}，sources ${Array.isArray(b.sources) ? b.sources.length : "?"} 个，diagnostics ${Array.isArray(b.diagnostics) ? b.diagnostics.length : "?"} 条）`);

  const stale = detectStale(root, b);
  if (stale !== null) row(ROW_KEEP, formatStaleAlert(stale));

  row(
    ROW_KEEP,
    `缺口：已访谈未安排 ${sum.interviewedNotArranged ?? 0} · 已安排未展开 ${sum.arrangedNotExpanded ?? 0} · 执行中断可续 ${sum.interruptedResume ?? 0} · 待合并 ${sum.unmergedWorktree ?? 0}`,
  );

  const gaps = collectGaps(b);
  if (gaps.length === 0) {
    row(ROW_KEEP, "缺口清单：无（四缺口全零，无需处置）");
  } else {
    const shown = Math.min(gaps.length, GAP_TOP_N);
    row(ROW_KEEP, `缺口清单（${gaps.length} 个，按优先级；每条一行处置，列前 ${shown}）：`);
    for (const gap of gaps.slice(0, GAP_TOP_N)) row(ROW_KEEP, formatGapEntry(gap));
    if (gaps.length > GAP_TOP_N) row(ROW_SECONDARY, `- …其余 ${gaps.length - GAP_TOP_N} 个缺口见 board.json`);
  }

  const assignees = collectAssigneeRows(b, () => loadRunsIndex(root, b));
  if (assignees.length === 0) {
    row(ROW_KEEP, "在做/该接：无（无 activeRun 且无可接手卡）");
  } else {
    const actives = assignees.filter((r) => r.active !== null).length;
    const shownRows = Math.min(assignees.length, ASSIGNEE_TOP_N);
    row(ROW_KEEP, `在做/该接（在做 ${actives} · 该接 ${assignees.length - actives}；按在做→待接手→未开工，列前 ${shownRows}）：`);
    for (const r of assignees.slice(0, ASSIGNEE_TOP_N)) row(ROW_DETAIL, formatAssigneeRow(r));
    if (assignees.length > ASSIGNEE_TOP_N) row(ROW_SECONDARY, `- …其余 ${assignees.length - ASSIGNEE_TOP_N} 张见 board.json`);
  }

  const bps = collectBreakpoints(b);
  if (bps.length === 0) {
    row(ROW_SECONDARY, "断点：无（无 interrupted-resume 卡）");
  } else {
    row(ROW_SECONDARY, `断点（${bps.length} 个，列前 ${Math.min(bps.length, BREAKPOINT_TOP_N)}，接续入口=停在#N+下一步）：`);
    for (const bp of bps.slice(0, BREAKPOINT_TOP_N)) row(ROW_DETAIL, formatBreakpoint(bp));
    if (bps.length > BREAKPOINT_TOP_N) row(ROW_SECONDARY, `- …其余 ${bps.length - BREAKPOINT_TOP_N} 个见 board.json`);
  }

  const rec = lastReconcileSummary(root);
  if (rec !== null) row(ROW_KEEP, rec);

  const attentionTotal =
    (sum.interviewedNotArranged ?? 0) + (sum.arrangedNotExpanded ?? 0) + (sum.interruptedResume ?? 0) + (sum.unmergedWorktree ?? 0);
  if (attentionTotal > 0) row(ROW_KEEP, "处置：缺口非零——先与用户确认处理顺序，再派发（板记录事实，不自动派发）。");
  return rows;
}

/**
 * 输出自检与预算级截断（#132）：输出前断言 ≤ 闸值（20KB 字节 / 24k 字符，32KB 收集上限留余量）——
 * 超限时按保留位降级：档 1 省略细节行（ROW_DETAIL）、档 2 省略次要摘要行（ROW_SECONDARY），
 * 均自尾部起（清单尾部先省）；对账/处置关键行（ROW_KEEP）逐字保留不动。
 * 每降一档重验字节；降级后仍超（关键行单行或累计超闸——档 1/2 救不回）→ 兜底按字节收口（见下）。
 * 任何截断都写 stderr 诊断（不静默）；JSON 恒完整可解析（超限=整条静默全丢，宁可自截断也不超）。
 */
function finalize(rows) {
  const wrap = (s) => JSON.stringify({ additionalContext: s });
  const render = (live) => live.map((r) => r.text).join("\n");
  const within = (body) => Buffer.byteLength(wrap(body), "utf8") <= OUTPUT_BYTE_BUDGET && body.length <= OUTPUT_CHAR_BUDGET;

  const full = render(rows);
  if (within(full)) return wrap(full);

  const live = rows.slice();
  const dropped = { [ROW_DETAIL]: 0, [ROW_SECONDARY]: 0 };
  const droppedTotal = () => dropped[ROW_DETAIL] + dropped[ROW_SECONDARY];
  const body = () => `${render(live)}\n${truncationMarker(droppedTotal())}`;

  for (const tier of [ROW_DETAIL, ROW_SECONDARY]) {
    while (!within(body())) {
      let idx = -1;
      for (let i = live.length - 1; i >= 0; i -= 1) {
        if (live[i].tier === tier) {
          idx = i;
          break;
        }
      }
      if (idx < 0) break;
      live.splice(idx, 1);
      dropped[tier] += 1;
    }
  }

  if (within(body())) {
    log(
      `预算自检：输出超闸已截断（降级档 ${dropped[ROW_SECONDARY] > 0 ? 2 : 1}；省略细节行 ${dropped[ROW_DETAIL]} 行 / 次要摘要行 ${dropped[ROW_SECONDARY]} 行；保留关键行 ${live.filter((r) => r.tier === ROW_KEEP).length} 行）——输出 ${Buffer.byteLength(wrap(body()), "utf8")} 字节 / ${body().length} 字符（闸 ${OUTPUT_BYTE_BUDGET} 字节 / ${OUTPUT_CHAR_BUDGET} 字符）。`,
    );
    return wrap(body());
  }

  // 兜底（档 3；单行或累计超闸——降级档 1/2 救不回）：按行贪心保留能装下的关键行（逐字，
  // 整行保留或整体跳过——不取中段），超闸行进 stderr 诊断；输出前断言 ≤ 闸值，JSON 恒完整可解析。
  const kept = [];
  let skipped = 0;
  for (const r of live) {
    if (within(`${render([...kept, r])}\n${HARD_TRUNCATION_MARKER}`)) kept.push(r);
    else skipped += 1;
  }
  log(
    `预算自检：关键行超闸（单行或累计；单行阈值 ${OUTPUT_BYTE_BUDGET} 字节）——按字节收口，逐字保留能装下的关键行 ${kept.length}/${live.length} 行（整体跳过 ${skipped} 行，多为标题/正文过长），JSON 仍完整可解析；建议压缩过长标题或拆卡。`,
  );
  return wrap(kept.length > 0 ? `${render(kept)}\n${HARD_TRUNCATION_MARKER}` : HARD_TRUNCATION_MARKER);
}

function main() {
  const payload = parsePayload(readStdin());
  const root = resolveRoot(payload?.cwd ?? null);
  if (root === null) {
    log("无法确定项目根（payload.cwd/环境变量/cwd 均不可用）：输出空态提示。");
    process.stdout.write(`${finalize([{ tier: ROW_KEEP, text: "[zcode-board] 无法确定项目根：跳过板摘要（不阻塞；请核查 hook 配置 cwd）。" }])}\n`);
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

  const rows = buildRows(root, board);
  const text = rows.map((r) => r.text).join("\n");
  process.stdout.write(`${finalize(rows)}\n`);
  log(`已注入摘要（板：${loaded.missing ? "缺失" : board.valid ? "正常" : "损坏"}；字节 ${Buffer.byteLength(text, "utf8")}）。`);
  return 0;
}

process.exit(main());
