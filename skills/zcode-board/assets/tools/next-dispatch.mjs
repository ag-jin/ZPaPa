#!/usr/bin/env node
/**
 * zcode-board / next-dispatch —— 可派面扫描器：#180（B9-1）「事件后必跑」一条命令
 *
 * 存在原因（卡 #180；用户 2026-10-11 原话「先想好机制，不一定要靠定时任务去提醒。而且有时候定时提醒
 * 也不一定会安排出新的 agent」/「我看怎么不用定时任务，你现在只有 2 个智能体在推进」）：
 *   2026-10-11 上午两类实操事故——B4-4 域空 8 轮未派（漏派）与并发 2/12 时 4 路可派未察（过度串行）。
 *   根因：派发决策靠编排者脑内队列，没有单一命令回答「现在能派哪些卡、各自文件域、其余为什么不能派」。
 *   本工具把三个只读事实源合成一条命令的输出：板 frontier[]（可执行前沿）× blocked[]（阻塞归因）×
 *   在途清单（runs.json「implementer done 且卡未勾选」推导，或 --in-flight 显式传入）+ 卡→文件域映射
 *   （计划稿「文件域冲突点」声明 → 卡文文件提及 → 域未知标注置信）。
 *
 * 用法：
 *   node assets/tools/next-dispatch.mjs [<项目根>] [--json] [--in-flight <卡号,…>] [--slots <N>]
 *   node assets/tools/next-dispatch.mjs --help
 *
 *   <项目根>            项目根（缺省 = 当前目录）；读 <根>/.zcode/board/{board.json,runs.json} + 计划稿（只读）
 *   --json              机读输出（纯 JSON，stdout 单对象；字段与文本同源）
 *   --in-flight <卡号,…> 显式在途清单（覆盖 runs.json 推导；`108`/`#108` 等价；0 项 = 无在途）
 *   --slots <N>         并发上限（缺省 12）：报告剩余槽位并给并行组定尺；不代表可派面本身
 *
 * 输出三段（事件后看一屏即可决策）：
 *   ① 在途 N 张（每张给最近 run、下一棒、占用文件域）——域被占是「不可派」的第二类归因；
 *   ② 可派清单（未被在途域占 + 无前置在途）——逐张给文件域与「域未占 / 域未知——需人工确认」；
 *      并行组 = 按 rank 贪心取域互斥卡（域未知卡不入自动组，防双写）；
 *   ③ 不可派逐张证据——「域 X 被在途 #M 占」或「blocked-by 在途 #N / blocked-by #N（未在途）」。
 *
 * 退出码：0 = 有可派卡；1 = 无可派（前沿空或全阻塞——事件后必跑的信号面，非错误）；2 = 用法/坏输入。
 *
 * 边界（只读零写入）：不写任何文件（板/registry/runs/计划稿全只读）；不执行 git；不派发、不落账；
 * 域映射是**声明面**推断（非运行时事实）：计划稿声明 > 卡文提及 > 未知（标注置信，未知不阻断但需人工确认），
 * 同一文件名的 basename 归属与目录前缀按保守口径判定（宁可多报冲突，不可漏报双写）。
 * 无第三方依赖（仅 node 内置）。
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROG = "next-dispatch";
const DEFAULT_SLOTS = 12;

/** 卡生命周期里「已终态」的状态（不计在途、不列不可派）。 */
const DONE_STATUSES = new Set(["completed", "cancelled"]);
/** 在途推导的角色面（#180 卡文：implementer done 且卡未勾选 = 候选在途）。 */
const IN_FLIGHT_ROLE = "implementer";
const IN_FLIGHT_RESULTS = new Set(["done", "partial"]);

const USAGE = `用法：
  node assets/tools/next-dispatch.mjs [<项目根>] [--json] [--in-flight <卡号,…>] [--slots <N>]

  <项目根>              项目根（缺省 = 当前目录）
  --json                机读输出（纯 JSON 单对象）
  --in-flight <卡号,…>  显式在途清单（覆盖 runs.json 推导；108/#108 等价；可给空串表示零在途）
  --slots <N>           并发上限（缺省 ${DEFAULT_SLOTS}）
退出码：0 = 有可派卡；1 = 无可派（前沿空或全阻塞）；2 = 用法/坏输入。`;

function die(msg) {
  process.stderr.write(`${PROG}: ${msg}\n${USAGE}\n`);
  process.exit(2);
}

function isFile(p) {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 参数

function parseCardList(value) {
  const raw = String(value).trim();
  if (raw === "") return [];
  const out = [];
  for (const token of raw.split(/[,，\s]+/)) {
    if (token === "") continue;
    const m = token.match(/^(?:#|ID-)?(\d+)$/i);
    if (!m) die(`--in-flight 取值非法（须为卡号，如 108/#108）：${JSON.stringify(token)}`);
    out.push(Number(m[1]));
  }
  return out;
}

function parseArgs(argv) {
  const opt = { root: null, json: false, inFlight: null, slots: DEFAULT_SLOTS };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (a === "--json") {
      opt.json = true;
      continue;
    }
    if (a === "--in-flight" || a === "--slots") {
      const v = argv[i + 1];
      if (v === undefined || (v.startsWith("--") && a === "--slots")) die(`选项 ${a} 缺少取值`);
      if (a === "--in-flight") opt.inFlight = parseCardList(v);
      else {
        if (!/^\d+$/.test(String(v)) || Number(v) < 1) die(`--slots 取值非法（须为正整数）：${JSON.stringify(v)}`);
        opt.slots = Number(v);
      }
      i += 1;
      continue;
    }
    if (a.startsWith("--")) die(`未知选项 ${a}`);
    if (opt.root !== null) die(`多余的位置参数 ${a}`);
    opt.root = a;
  }
  return opt;
}

// ---------------------------------------------------------------- 只读读取

function readJsonOrDie(path, label) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    die(`${label} 读取失败：${path}（${err.code || err.message}）`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    die(`${label} 解析失败（JSON 非法）：${path}——${err.message}`);
  }
  return null;
}

function readTextIfExists(path) {
  if (!isFile(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 卡号/标签/域令牌

/** 卡标题里的稳定标签（如 "B4-4 runs 引…" → "B4-4"；无标签形态 → null）。 */
function cardLabel(title) {
  const first = String(title || "").trim().split(/\s+/)[0] || "";
  return /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/.test(first) ? first : null;
}

/** 批前缀（"B4-4" → "B4"；"60-1" → "60"；"E1c-1" → "E1c"）。 */
function batchPrefix(label) {
  if (!label) return null;
  const idx = label.lastIndexOf("-");
  return idx > 0 ? label.slice(0, idx) : null;
}

const FILE_TOKEN_RE = /(?:[\w.@$-]+\/)*[\w.@$-]+\.(?:mjs|js|cjs|ts|tsx|jsx|json|md|yml|yaml)\b/g;
const DIR_TOKEN_RE = /(?:[\w.@$-]+\/)+[\w.@$*-]+/g;

/** 归一单令牌：去行号后缀（`src/a.test.ts:12-18` → `src/a.test.ts`；引用位不是写面）。 */
function cleanToken(t) {
  return String(t).replace(/:(\d+)(?:-\d+)?$/, "");
}

/**
 * 文本 → 文件域令牌（去重、相对路径归一）。
 * 三类：① 反引号路径（含目录形态 `packages/ui`）；② 裸文件名词（带扩展名）；③ 目录通配（`assets/hooks/*`）。
 */
function extractFileTokens(text) {
  const out = new Set();
  const src = String(text || "");
  for (const m of src.matchAll(/`([^`\n]+)`/g)) {
    const inner = cleanToken(m[1].trim()).replace(/^\.\//, "");
    if (!inner || /\s/.test(inner)) continue;
    if (inner.includes("/") || FILE_TOKEN_RE.test(inner)) {
      out.add(inner);
      FILE_TOKEN_RE.lastIndex = 0;
    }
  }
  for (const m of src.matchAll(new RegExp(FILE_TOKEN_RE.source, "g"))) out.add(cleanToken(m[0]).replace(/^\.\//, ""));
  for (const m of src.matchAll(new RegExp(DIR_TOKEN_RE.source, "g"))) {
    if (/\/\*$/.test(m[0])) out.add(m[0].replace(/^\.\//, ""));
  }
  return [...out].sort();
}

/** 令牌归一（去前导 ./ 与尾部 /）。 */
function normToken(t) {
  return String(t).replace(/^\.\//, "").replace(/\/+$/, "");
}

function baseName(t) {
  const s = normToken(t).replace(/\/\*$/, "");
  return s.slice(s.lastIndexOf("/") + 1);
}

function isDirish(t) {
  const s = normToken(t);
  if (s.endsWith("/*")) return true;
  return !/\.[A-Za-z0-9]+$/.test(s);
}

/** 两域令牌是否指向同一写面（保守口径：多报冲突 > 漏报双写）。 */
function tokensConflict(a, b) {
  const A = normToken(a);
  const B = normToken(b);
  const Ad = A.replace(/\/\*$/, "");
  const Bd = B.replace(/\/\*$/, "");
  if (Ad === Bd) return true;
  if (isDirish(a) && (B === Ad || B.startsWith(`${Ad}/`))) return true;
  if (isDirish(b) && (A === Bd || A.startsWith(`${Bd}/`))) return true;
  if (A.endsWith(`/${B}`) || B.endsWith(`/${A}`)) return true;
  if (!isDirish(a) && !isDirish(b) && baseName(A) === baseName(B)) return true;
  return false;
}

// ---------------------------------------------------------------- 计划稿解析

/** 计划稿「与其它线的文件域冲突点」节的行（到下一个 ## 为止）。 */
function conflictSectionLines(planText) {
  const out = [];
  let inSection = false;
  for (const line of String(planText || "").split("\n")) {
    if (/^##\s/.test(line)) {
      inSection = /文件域冲突点/.test(line);
      continue;
    }
    if (inSection && /^-\s/.test(line)) out.push(line);
  }
  return out;
}

/** 卡文块：从 `<!-- zcode-board: no=N -->` 所在条目行到下一个条目/章节行。 */
function cardBlock(planText, no) {
  const lines = String(planText || "").split("\n");
  const marker = new RegExp(`<!--\\s*zcode-board:\\s*no=${no}\\s*-->`);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (marker.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const block = [];
  for (let i = start; i < lines.length; i += 1) {
    if (i > start && (/^- \[[ x~%]\]/.test(lines[i]) || /^##\s/.test(lines[i]))) break;
    block.push(lines[i]);
  }
  return block.join("\n");
}

/** 冲突区一行是否覆盖该卡（精确标签优先；批前缀按 token 边界，防 "B4" 误吞 "B4-7"）。 */
function conflictLineMatches(line, label) {
  if (!label) return false;
  if (line.includes(label)) return true;
  const prefix = batchPrefix(label);
  if (!prefix) return false;
  const re = new RegExp(`(?:^|[^\\w-])${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);
  return re.test(line);
}

// ---------------------------------------------------------------- 卡 → 文件域

/**
 * 域映射（声明面推断，标注来源与置信）：
 *   ① 计划稿「文件域冲突点」声明（高）；② 卡文文件提及（中）；③ 标题启发（低）；④ 全无 → 域未知。
 */
function domainForCard(root, task, planCache) {
  const files = new Set();
  const sources = [];
  let confidence = "未知";
  const label = cardLabel(task.title);
  const rel = task.source?.file || null;
  let plan = null;
  if (rel) {
    if (!planCache.has(rel)) planCache.set(rel, readTextIfExists(join(root, rel)) || "");
    plan = planCache.get(rel);
  }
  if (plan) {
    const matched = conflictSectionLines(plan).filter((line) => conflictLineMatches(line, label));
    const declared = new Set();
    for (const line of matched) {
      const colon = line.indexOf("：");
      const scope = colon > 0 ? line.slice(0, colon) : line;
      let tokens = extractFileTokens(scope);
      if (tokens.length === 0) tokens = extractFileTokens(line);
      for (const t of tokens) declared.add(t);
    }
    if (declared.size > 0) {
      for (const t of declared) files.add(t);
      sources.push("计划稿冲突区");
      confidence = "高";
    }
    const block = cardBlock(plan, task.no);
    if (block) {
      const mentioned = extractFileTokens(block);
      if (mentioned.length > 0) {
        const added = mentioned.filter((t) => ![...files].some((f) => tokensConflict(f, t)));
        for (const t of mentioned) files.add(t);
        if (added.length > 0 || sources.length === 0) sources.push("卡文");
        if (confidence !== "高") confidence = "中";
      }
    }
  }
  if (files.size === 0) {
    const fromTitle = extractFileTokens(task.title || "");
    if (fromTitle.length > 0) {
      for (const t of fromTitle) files.add(t);
      sources.push("标题启发");
      confidence = "低";
    }
  }
  return {
    files: [...files].sort(),
    source: sources.length > 0 ? sources.join("+") : "无声明",
    confidence,
    unknown: files.size === 0,
  };
}

// ---------------------------------------------------------------- 在途推导

function collectTasks(board) {
  const map = new Map();
  for (const f of board.features || []) {
    for (const t of f.tasks || []) {
      if (t && typeof t.no === "number" && !map.has(t.no)) map.set(t.no, { ...t, featureNo: f.no });
    }
  }
  return map;
}

/**
 * 在途推导：runs.json 里 role=implementer、result=done/partial 且该卡未终态（未勾选/未取消）= 候选在途
 * （implementer 完成到合并之间的整条管线都算在途，直到卡 completed/cancelled）。
 * 每卡取最近一次 run；返回按最近 run 时间倒序。
 */
function deriveInFlight(runs, tasks) {
  const lastByCard = new Map();
  for (const run of runs || []) {
    if (!run || run.role !== IN_FLIGHT_ROLE || !IN_FLIGHT_RESULTS.has(run.result)) continue;
    for (const no of run.cards || []) {
      const task = tasks.get(no);
      if (!task || DONE_STATUSES.has(task.status)) continue;
      const prev = lastByCard.get(no);
      if (!prev || String(run.at || "") > String(prev.run.at || "")) lastByCard.set(no, { no, run, task });
    }
  }
  return [...lastByCard.values()].sort((a, b) => String(b.run.at || "").localeCompare(String(a.run.at || "")));
}

// ---------------------------------------------------------------- 主流程

function main() {
  const opt = parseArgs(process.argv.slice(2));
  const root = resolve(opt.root ?? process.cwd());
  if (!isDir(root)) die(`项目根不存在或不是目录：${root}`);
  const boardPath = join(root, ".zcode", "board", "board.json");
  if (!isFile(boardPath)) die(`板文件不存在：${boardPath}（先运行编译器生成板，或核对 <项目根>）`);
  const board = readJsonOrDie(boardPath, "board.json");
  const runsPath = join(root, ".zcode", "board", "runs.json");
  const runsLoaded = isFile(runsPath) ? readJsonOrDie(runsPath, "runs.json") : null;
  const runs = runsLoaded?.runs || [];

  const tasks = collectTasks(board);
  const planCache = new Map();

  // 在途清单：CLI 覆盖 > runs.json 推导
  const inFlightSource = opt.inFlight !== null ? "cli" : "runs.json";
  const inFlight = [];
  if (opt.inFlight !== null) {
    for (const no of opt.inFlight) {
      const task = tasks.get(no);
      inFlight.push({ no, run: null, task: task || null });
    }
  } else {
    for (const entry of deriveInFlight(runs, tasks)) inFlight.push(entry);
  }
  const inFlightNos = new Set(inFlight.map((x) => x.no));
  const inFlightCards = inFlight.map((x) => {
    const domain = x.task ? domainForCard(root, x.task, planCache) : { files: [], source: "号不在板上", confidence: "未知", unknown: true };
    return {
      no: x.no,
      title: x.task?.title ?? "(号不在板上)",
      note: x.run ? `${x.run.role} ${x.run.result} ${x.run.at}` : "CLI 显式传入",
      nextAssignee: x.task?.nextAssignee ?? null,
      domain,
    };
  });

  // 前沿分类
  const frontier = [...(board.frontier || [])].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const dispatchable = [];
  const blocked = [];
  for (const entry of frontier) {
    const task = tasks.get(entry.no) || entry;
    if (inFlightNos.has(entry.no)) continue; // 在途卡在「在途」段，不算可派/不可派
    const domain = domainForCard(root, { ...task, no: entry.no, title: entry.title ?? task.title }, planCache);
    const hits = [];
    for (const own of domain.files) {
      for (const other of inFlightCards) {
        if (other.domain.unknown) continue;
        const hit = other.domain.files.find((f) => tokensConflict(own, f));
        if (hit) hits.push({ file: own, occupiedBy: other.no, occupyFile: hit });
      }
    }
    if (hits.length > 0) {
      blocked.push({
        no: entry.no,
        title: entry.title ?? task.title,
        kind: "domain",
        by: [...new Set(hits.map((h) => h.occupiedBy))].sort((a, b) => a - b),
        evidence: `域 ${hits[0].file} 被在途 #${hits[0].occupiedBy} 占`,
        detail: hits,
        rank: entry.rank ?? null,
      });
      continue;
    }
    dispatchable.push({
      no: entry.no,
      title: entry.title ?? task.title,
      rank: entry.rank ?? null,
      nextAssignee: entry.nextAssignee ?? task.nextAssignee ?? null,
      domain,
    });
  }

  // 板 blocked[] 归因逐张分流（在途卡不重复进「不可派」——板态矛盾只标注不静默丢）
  const inFlightByNo = new Map(inFlightCards.map((c) => [c.no, c]));
  for (const b of board.blocked || []) {
    const task = tasks.get(b.no);
    if (task && DONE_STATUSES.has(task.status)) continue;
    const target = b.targetId;
    const inFlightCard = inFlightByNo.get(b.no);
    if (inFlightCard) {
      const note = `板上仍有未解 blocker #${target ?? "?"}（与在途态矛盾——对账点名面）`;
      inFlightCard.boardBlockerNote = inFlightCard.boardBlockerNote ? `${inFlightCard.boardBlockerNote}；${note}` : note;
      continue;
    }
    const inFlightTarget = target !== undefined && inFlightNos.has(target);
    const label = b.blockerKind === "dependency" ? "blocked-by" : `blocked-by（${b.blockerKind || "未知"}）`;
    const evidence = inFlightTarget
      ? `${label} 在途 #${target}（板 blocked 归因 ${b.blockerKind || "未知"}）`
      : target === undefined || !tasks.has(target)
        ? `${label} #${target ?? "?"}（目标号不在板上——对账点名面）`
        : `${label} #${target}（前置未完成、未在途）`;
    blocked.push({
      no: b.no,
      title: b.title ?? tasks.get(b.no)?.title ?? "",
      kind: "dependency",
      by: target === undefined ? [] : [target],
      targetInFlight: Boolean(inFlightTarget),
      evidence,
      detail: [],
      rank: null,
    });
  }
  blocked.sort((a, b) => (a.kind === b.kind ? (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.no - b.no : a.kind === "domain" ? -1 : 1));

  // 并行组：按 rank 贪心取域互斥（域未知卡不入自动组）
  const slotsFree = Math.max(0, opt.slots - inFlightCards.length);
  const parallelGroup = [];
  for (const card of dispatchable) {
    if (parallelGroup.length >= slotsFree) break;
    if (card.domain.unknown) continue;
    const clash = parallelGroup.some((picked) =>
      picked.domain.files.some((f) => card.domain.files.some((g) => tokensConflict(f, g))),
    );
    if (!clash) parallelGroup.push(card);
  }

  const result = {
    tool: PROG,
    schema: "next-dispatch/1",
    root,
    boardUpdatedAt: board.updatedAt ?? null,
    runsLoaded: runsLoaded !== null,
    capacity: opt.slots,
    inFlight: {
      source: inFlightSource,
      count: inFlightCards.length,
      slotsFree,
      cards: inFlightCards,
    },
    dispatchable,
    parallelGroup: parallelGroup.map((c) => c.no),
    needsReview: dispatchable.filter((c) => c.domain.unknown).map((c) => c.no),
    blocked,
    summary: {
      frontier: frontier.length,
      dispatchable: dispatchable.length,
      dispatchableFree: dispatchable.filter((c) => !c.domain.unknown).length,
      needsReview: dispatchable.filter((c) => c.domain.unknown).length,
      blocked: blocked.length,
      inFlight: inFlightCards.length,
      slotsFree,
    },
  };

  if (opt.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(renderText(result));
  }
  process.exit(dispatchable.length > 0 ? 0 : 1);
}

// ---------------------------------------------------------------- 文本渲染

function domainText(domain) {
  if (domain.unknown) return `域未知（来源：${domain.source}）`;
  return `域：${domain.files.join("、")}（${domain.source}）`;
}

function renderText(r) {
  const out = [];
  out.push(`next-dispatch: ${r.root}（板更新 ${r.boardUpdatedAt ?? "未知"}）`);
  out.push("");
  if (r.inFlight.count === 0) {
    out.push(
      r.inFlight.source === "cli"
        ? "在途 0 张（--in-flight 显式传入为空）。"
        : "在途 0 张（runs.json 无「implementer done 且卡未勾选」候选；可用 --in-flight 显式指定）。",
    );
  } else {
    out.push(`在途 ${r.inFlight.count} 张（并发上限 ${r.capacity}，剩余槽位 ${r.inFlight.slotsFree}）：`);
    for (const c of r.inFlight.cards) {
      const note = c.boardBlockerNote ? `；${c.boardBlockerNote}` : "";
      out.push(`  #${c.no}  ${c.title}（最近 run：${c.note}；下一棒 ${c.nextAssignee ?? "无接手位"}${note}）`);
      out.push(`      ${domainText(c.domain)}${c.domain.unknown ? "——在途域未声明，无法判定与他卡冲突" : ""}`);
    }
  }
  out.push("");
  if (r.dispatchable.length === 0) {
    out.push(r.summary.frontier === 0 ? "可派 0 路（前沿为空——无可执行卡）。" : "可派 0 路（前沿卡全部被在途域占或前置未完成——见下逐张证据）。");
  } else {
    out.push(`可派 ${r.dispatchable.length} 路（未被在途域占；域未知者需人工确认）：`);
    for (const c of r.dispatchable) {
      const domain = c.domain.unknown
        ? "域未知——需人工确认"
        : `域：${c.domain.files.join("、")}（${c.domain.source}）；域未占`;
      out.push(`  #${c.no}  ${c.title}（${c.nextAssignee ?? "无接手位"}；${domain}）`);
    }
    if (r.parallelGroup.length > 0) out.push(`  并行组（≤${r.inFlight.slotsFree}）：${r.parallelGroup.map((n) => `#${n}`).join("、")}`);
  }
  out.push("");
  if (r.blocked.length === 0) {
    out.push("不可派 0 张。");
  } else {
    out.push(`不可派 ${r.blocked.length} 张（逐张证据）：`);
    for (const b of r.blocked) out.push(`  #${b.no}  ${b.title}：${b.evidence}`);
  }
  out.push("");
  out.push(
    `结论：可派 ${r.summary.dispatchable} 路（域未占 ${r.summary.dispatchableFree}、域未知 ${r.summary.needsReview}）；不可派 ${r.summary.blocked} 张；在途 ${r.summary.inFlight}/${r.capacity}。`,
  );
  return `${out.join("\n")}\n`;
}

main();
