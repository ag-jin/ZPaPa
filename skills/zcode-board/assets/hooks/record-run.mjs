#!/usr/bin/env node
/**
 * zcode-board / record-run（T13 交付物）——runs.json 唯一写入者的机械转抄脚本
 *
 * 触发两级、实现一份（设计 §5.3；A5 实测勘误）：
 *   - 前台（同步）派发：PostToolUse(Agent|Task) hook 自动触发（stdin = 完整 PostToolUse payload，
 *     报告全文在 `tool_response.content[].text`，A5 §2.2/§6）；
 *   - 后台（async）派发（当前主形态）：完成走会话消息通知、不触发 PostToolUse → 编排者收到报告后
 *     以报告原文为 stdin 代触发同一脚本（`--cwd/--session-id` 补齐机械字段）。
 * 两形态以 `tool_response` 字段是否存在**显式分支**（A5 §7.2），解析逻辑零分叉。
 *
 * 行为（run-event.md 冻结的落账映射与容错语义）：
 *   1. 抽取报告内每一处 run_event 块（对象或对象数组；一个块 = 一条记录，逐块落账、互不合并）；
 *   2. appendRun（lib/runs.mjs，runs.json 唯一写路径）原子追加：机械字段 runId/sessionId/at 由
 *      appendRun 补齐（报告自报一律忽略）；块内缺省按契约不造字段值；
 *   3. 报告同源代存归档（#123/V13）：落账后把本次解析出的报告原文（parsed.text——与 run_event
 *      抽取同一次解析的输出，同一实现、同一解析）逐字归档到
 *      .zcode/board/evidence/<runId>/report.md——"报告正本"走归档文件，runs.json 记录 schema
 *      零变化（不加字段）。一份报告一份正本：evidence/ 一层下已有同内容副本（代存归档或手写
 *      第二份）→ 不重复写入 + 点名既有路径（疑似重复落账）；同 runId 首写为准（不覆盖首份）；
 *      去重只作用归档面，runs.json 照常追加（落账行为零变化）；归档失败只 stderr 不阻塞；
 *   4. 落账后触发一次重编译（CLI 方式调 compile-board.mjs；编译器本脚本不做任何解析）；
 *   5. 无块 / 块解析失败 / 表外值 / 落账失败 → stderr diagnostics，进程退出码恒 0——
 *      hook 失败永不阻塞主流程（设计 §10.4；落账失败由 Stop 对账点名"未登记"兜底）。
 *
 * 输出纪律（A6 实测）：stdout 恒为空（PostToolUse 无注入输出）；一切日志走 stderr。
 *
 * 用法：
 *   node record-run.mjs                    # hook 形态：stdin = PostToolUse payload（含 tool_response）
 *   pbpaste | node record-run.mjs --cwd <项目根> --session-id <会话 id>   # 代触发形态：stdin = 裸报告
 * 选项：--cwd <路径> / --session-id <id> / --tool-name <名> / -h|--help
 * 退出码：恒 0（hook 不阻塞主流程；问题一律以 stderr diagnostics 表达）。
 *
 * 无第三方依赖（仅 node 内置）。本脚本只调用 lib/runs.mjs 的 appendRun、lib/board-io.mjs 的原子写
 * 与编译器 CLI；除报告代存归档（.zcode/board/evidence/<runId>/report.md）外不改写任何文件，
 * runs.json 的唯一写路径仍是 appendRun 一处。
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeHandle, writeFileAtomic } from "../lib/board-io.mjs";
import { appendRun } from "../lib/runs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** 编译器位置（同 assets 根下；只以 CLI 方式调用，不 import——编译逻辑归编译器，本脚本零解析）。 */
const COMPILER = resolve(HERE, "..", "compile-board.mjs");
/** 派发工具名（A5 §4 定案：Agent 主名 / Task 兼容别名）。 */
const DISPATCH_TOOLS = ["Agent", "Task"];
const COMPILE_TIMEOUT_MS = 20_000;
/** 报告同源代存归档位（#123）：<项目根>/.zcode/board/evidence/<runId>/report.md。 */
const EVIDENCE_REL = ".zcode/board/evidence";
const REPORT_FILE = "report.md";

const USAGE = `zcode-board record-run（run 事件机械落账；runs.json 唯一写路径）

用法：
  node record-run.mjs                         hook 形态：stdin = PostToolUse(Agent|Task) payload
  <报告文本 | pbpaste> | node record-run.mjs --cwd <项目根> --session-id <会话 id>
                                              代触发形态：stdin = 裸报告文本（后台派发主力路径）

选项：
  --cwd <路径>         项目根（默认：payload.cwd → ZCODE_PROJECT_DIR/CLAUDE_PROJECT_DIR → 当前目录）
  --session-id <id>    会话 id（payload.sessionId 缺省时使用）
  --tool-name <名>     代触发时声明角色工具名（诊断用；派发工具应为 Agent|Task）
  -h, --help           显示本帮助

契约：stdin 解析 run_event 块 → appendRun 原子追加 runs.json → 报告原文代存
      .zcode/board/evidence/<runId>/report.md（逐字同源；已有同内容副本 → 点名去重，
      不重复写入——双触发/手写第二份必咬）→ 触发重编译。
无块/解析失败/落账失败/代存失败 → stderr diagnostics，退出码恒 0（hook 永不阻塞主流程）。
`;

function log(msg) {
  process.stderr.write(`record-run: ${msg}\n`);
}

// ---------------------------------------------------------------- run_event 抽取（纯函数，导出供 reconcile-stop 复用）

/**
 * 字符串感知的 JSON 值扫描：从 start 处的 `{`/`[` 起取到配对闭合符（含）。
 * 返回闭合符下标；未配对返回 -1（调用方跳过该块 + diagnostics）。
 */
function scanJsonValue(text, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 抽取报告文本中的全部 run_event 块（run-event.md §1：对象或对象数组；每处 `"run_event"` 键都取）。
 * 返回 {blocks, diagnostics}；blocks 为按出现顺序排列的值数组（元素原样，合法性由 appendRun 判定）。
 */
export function extractRunEvents(text) {
  const src = String(text ?? "");
  const blocks = [];
  const diagnostics = [];
  const re = /"run_event"\s*:/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length;
    while (i < src.length && /\s/.test(src[i])) i += 1;
    const ch = src[i];
    if (ch !== "{" && ch !== "[") {
      diagnostics.push(`run_event 值不是 JSON 对象/数组（${JSON.stringify(src.slice(i, i + 24))}…）：跳过该处。`);
      continue;
    }
    const end = scanJsonValue(src, i);
    if (end < 0) {
      diagnostics.push("run_event 块 JSON 括号不配对：跳过该块（解析失败不阻塞）。");
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(src.slice(i, end + 1));
    } catch (e) {
      diagnostics.push(`run_event 块 JSON 解析失败（${e.message}）：跳过该块（不阻塞）。`);
      continue;
    }
    const values = Array.isArray(parsed) ? parsed : [parsed];
    if (values.length === 0) diagnostics.push("run_event 数组为空：无块落账。");
    for (const v of values) blocks.push(v);
  }
  return { blocks, diagnostics };
}

/** 块内卡号归一（与 lib/runs.mjs 同口径：正整数原样、字符串走句柄归一、其余丢弃）。 */
function blockCards(block) {
  const out = [];
  if (Array.isArray(block?.cards)) {
    for (const raw of block.cards) {
      if (Number.isInteger(raw) && raw >= 1) out.push(raw);
      else if (typeof raw === "string") {
        const no = normalizeHandle(raw);
        if (no !== null) out.push(no);
      }
    }
  }
  return out.sort((a, b) => a - b);
}

/** 报告块 ↔ runs 记录的同源匹配（供 reconcile-stop 判"未登记"；报告自有字段逐一比对）。 */
export function runMatchesBlock(run, block) {
  if (!run || typeof run !== "object" || !block || typeof block !== "object") return false;
  if (run.role !== block.role || run.result !== block.result) return false;
  const bc = blockCards(block);
  const rc = (Array.isArray(run.cards) ? run.cards : []).filter((n) => Number.isInteger(n)).sort((a, b) => a - b);
  if (bc.length !== rc.length || bc.some((v, i) => v !== rc[i])) return false;
  const bs = Number.isInteger(block.stoppedAt) ? block.stoppedAt : null;
  const rs = run.breakpoint && Number.isInteger(run.breakpoint.stoppedAt) ? run.breakpoint.stoppedAt : null;
  return bs === rs;
}

// ---------------------------------------------------------------- stdin 形态分支

function isRecord(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * 显式分支解析 stdin（A5 §7.2）：含 tool_response/toolResponse 键 → hook 形态；否则 → 裸报告文本。
 * 返回 {mode, text, sessionId, toolName, cwd, diagnostics}。
 * mode: "payload"（completed）/ "async"（async_launched 无报告）/ "bare" / "empty"。
 */
function parseRecordStdin(raw) {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "") {
    return { mode: "empty", text: "", sessionId: null, toolName: null, diagnostics: ["stdin 为空：无报告可解析（跳过落账）。"] };
  }
  let payload = null;
  if (trimmed.startsWith("{")) {
    try {
      const v = JSON.parse(trimmed);
      if (isRecord(v)) payload = v;
    } catch {
      payload = null; // 非 JSON → 按裸报告文本处理（代触发形态）
    }
  }
  const hasResponse = payload !== null && (Object.hasOwn(payload, "tool_response") || Object.hasOwn(payload, "toolResponse"));
  const cwd = payload !== null && typeof payload.cwd === "string" ? payload.cwd : null;
  if (!hasResponse) return { mode: "bare", text: trimmed, sessionId: null, toolName: null, cwd, diagnostics: [] };

  const sessionId = typeof payload.session_id === "string" ? payload.session_id : typeof payload.sessionId === "string" ? payload.sessionId : null;
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : typeof payload.toolName === "string" ? payload.toolName : null;
  const diagnostics = [];
  if (toolName !== null && !DISPATCH_TOOLS.includes(toolName)) {
    diagnostics.push(`tool_name=${toolName} 非派发工具（应为 ${DISPATCH_TOOLS.join("|")}）：payload 不解析（matcher 配置核查）。`);
    return { mode: "payload", text: "", sessionId, toolName, cwd, diagnostics };
  }
  const resp = payload.tool_response ?? payload.toolResponse;
  const status = isRecord(resp) ? resp.status : null;
  if (status === "async_launched") {
    diagnostics.push(
      "tool_response.status=async_launched（后台派发启动时点，无报告全文）：不落账——完成通知不触发 PostToolUse，由编排者以报告为 stdin 代触发本脚本（§5.3 两级）。",
    );
    return { mode: "async", text: "", sessionId, toolName, cwd, diagnostics };
  }
  if (status !== "completed") {
    diagnostics.push(`tool_response.status=${JSON.stringify(status ?? null)}（非 completed）：无可解析报告，不落账。`);
    return { mode: "payload", text: "", sessionId, toolName, cwd, diagnostics };
  }
  const content = Array.isArray(resp.content) ? resp.content : [];
  const text = content
    .filter((c) => isRecord(c) && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
  if (text.trim() === "") diagnostics.push("tool_response.content 无文本（未截断全文缺失）：不落账；勿以 toolResultPreview（4000 字符）或 transcript 兜底（A5 §2.3）。");
  return { mode: "payload", text, sessionId, toolName, cwd, diagnostics };
}

// ---------------------------------------------------------------- 报告同源代存归档（V13；#123）

/** 既有副本枚举（evidence/ 一层下任意 report.md：代存归档与手写副本同面），按路径排序保证诊断确定性。 */
function collectExistingReportCopies(root) {
  let entries;
  try {
    entries = readdirSync(join(root, EVIDENCE_REL), { withFileTypes: true });
  } catch {
    return []; // evidence/ 不存在或不可读：无既有副本（写侧失败由各自诊断承载，不阻塞）
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const rel = `${EVIDENCE_REL}/${ent.name}/${REPORT_FILE}`;
    try {
      out.push({ rel, text: readFileSync(join(root, rel), "utf8") });
    } catch {
      /* 该目录无 report.md / 不可读：不作为候选（不阻塞） */
    }
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

/**
 * 代存归档（#123，V13）：落账后把本次解析出的报告原文（parsed.text——与 run_event 抽取同一次
 * 解析的输出，同一实现、同一解析）归档到 evidence/<runId>/report.md。语义（定性成文）：
 *   - runs.json 记录 schema 零变化（不改记录结构、不加字段）——"报告正本"走归档文件；
 *   - 逐字同源：写入内容 = 解析输出原样，不重新提取、不改造（byte 级可核）；
 *   - 一份报告一份正本（去重 + 点名）：evidence/ 一层下已有逐字一致的 report.md（代存归档或
 *     手写副本）→ 不重复写入 + 点名既有路径——疑似重复落账（双触发/手写第二份必咬）；
 *     去重只作用归档面：runs.json 照常追加（落账行为零变化）；
 *   - 同 runId 首写为准：目标已存在时保持首份（内容一致 → 去重提示；不一致 → 拒写并点名冲突）；
 *   - 失败只 stderr 不阻塞（与 watch-sources 同先例）：归档失败不影响落账结果与退出码。
 */
function archiveRunReports(root, runIds, text) {
  const diagnostics = [];
  const duplicates = collectExistingReportCopies(root).filter((e) => e.text === text);
  if (duplicates.length > 0) {
    const shown = duplicates.slice(0, 3).map((e) => e.rel).join("；");
    const more = duplicates.length > 3 ? `等 ${duplicates.length} 处` : "";
    diagnostics.push(`报告代存去重：已存在同内容副本（${shown}${more}）——疑似重复落账（双触发/手写第二份）；不重复写入，保持既有正本（落账不受影响）。`);
    return diagnostics;
  }
  for (const runId of runIds) {
    const rel = `${EVIDENCE_REL}/${runId}/${REPORT_FILE}`;
    let current = null;
    try {
      current = readFileSync(join(root, rel), "utf8");
    } catch {
      current = null; // 不存在（或不可读）：继续写（写失败由下方诊断承载）
    }
    if (current !== null) {
      diagnostics.push(
        current === text
          ? `报告代存去重：同 runId 归档已存在且内容一致（${rel}）——保持首份，不重复写入。`
          : `报告代存拒写：同 runId 归档已存在且内容不同（${rel}）——保持首份（疑手写抢占/复用 runId），本次未代存该 runId 副本。`,
      );
      continue;
    }
    try {
      writeFileAtomic(join(root, rel), text);
      diagnostics.push(`报告代存：${rel}（与报告原文逐字同源）。`);
    } catch (e) {
      diagnostics.push(`报告代存归档失败（${rel}：${e.message}）——只 stderr 诊断，不阻塞落账。`);
    }
  }
  return diagnostics;
}

// ---------------------------------------------------------------- CLI / 主流程

function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const opts = { cwd: null, sessionId: null, toolName: null, help: false, errors: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--cwd") opts.cwd = argv[++i] ?? null;
    else if (a === "--session-id") opts.sessionId = argv[++i] ?? null;
    else if (a === "--tool-name") opts.toolName = argv[++i] ?? null;
    else opts.errors.push(`未知选项 ${a}`);
  }
  if (opts.cwd !== null && (typeof opts.cwd !== "string" || opts.cwd === "")) opts.errors.push("--cwd 需要一个路径");
  if (opts.sessionId !== null && (typeof opts.sessionId !== "string" || opts.sessionId === "")) opts.errors.push("--session-id 需要一个值");
  return opts;
}

/**
 * 同步读全文 stdin。hook 通道 payload 可能远超 8KB（探针的截断缺陷不得复现，A5 §1.2 原因 D）：
 * 逐块 readSync 到 EOF，任何失败都退化为空串（调用方按"无报告"处理，不阻塞）。
 */
function readStdin() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  try {
    let n;
    // fd 0 在管道输入下可同步读；EAGAIN 时回退整读。
    while ((n = readSync(0, buf, 0, buf.length, null)) > 0) chunks.push(Buffer.from(buf.subarray(0, n)));
    return Buffer.concat(chunks).toString("utf8");
  } catch (e) {
    if (e && e.code === "EAGAIN") {
      try {
        return readFileSync(0, "utf8");
      } catch {
        return "";
      }
    }
    return chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : "";
  }
}

function resolveRoot(payloadCwd, argCwd) {
  const candidates = [argCwd, payloadCwd, process.env.ZCODE_PROJECT_DIR, process.env.CLAUDE_PROJECT_DIR, process.cwd()];
  for (const cand of candidates) {
    if (typeof cand === "string" && cand !== "" && isDirectory(cand)) return resolve(cand);
  }
  return null;
}

function recompile(root) {
  const r = spawnSync(process.execPath, [COMPILER, root], { encoding: "utf8", timeout: COMPILE_TIMEOUT_MS });
  if (r.error) {
    log(`重编译未完成（${r.error.message}）：陈旧角标兜底，不阻塞。`);
    return false;
  }
  if (r.status !== 0) {
    log(`重编译失败（退出码 ${String(r.status)}）：${String(r.stderr ?? "").trim().slice(0, 300)}（陈旧角标兜底，不阻塞）`);
    return false;
  }
  return true;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (opts.errors.length > 0) {
    for (const e of opts.errors) log(e);
    log("用法：node record-run.mjs [--cwd <项目根>] [--session-id <id>] [--tool-name <名>]");
    return 0; // hook 不阻塞；用法问题走 stderr
  }

  const raw = readStdin();
  const parsed = parseRecordStdin(raw);
  for (const d of parsed.diagnostics) log(d);
  if (parsed.mode === "empty" || parsed.text.trim() === "") {
    log("无报告文本：跳过落账（板照常重编译）。");
    const root0 = resolveRoot(parsed.cwd, opts.cwd);
    if (root0 !== null) recompile(root0);
    return 0;
  }

  const sessionId = opts.sessionId ?? parsed.sessionId;
  const toolName = opts.toolName ?? parsed.toolName;
  if (toolName !== null && !DISPATCH_TOOLS.includes(toolName)) log(`--tool-name=${toolName} 非派发工具（诊断用，不阻塞）。`);

  const root = resolveRoot(parsed.cwd, opts.cwd);
  if (root === null) {
    log("无法确定项目根（--cwd / payload.cwd / 环境变量 / cwd 均不可用）：跳过落账（不阻塞）。");
    return 0;
  }

  const { blocks, diagnostics } = extractRunEvents(parsed.text);
  for (const d of diagnostics) log(d);
  if (blocks.length === 0) {
    log("报告无 run_event 块：跳过落账 + diagnostics（schema 提示：报告须带 run_event 块）。板照常重编译。");
    recompile(root);
    return 0;
  }

  let written = 0;
  const landedRunIds = [];
  blocks.forEach((block, idx) => {
    const res = appendRun(root, block, { sessionId: sessionId ?? null });
    for (const d of res.diagnostics) log(`块 #${idx + 1}：${d.message}`);
    if (res.ok) {
      written += 1;
      landedRunIds.push(res.record.runId);
      log(`块 #${idx + 1} 已落账：${res.record.runId}（role=${res.record.role} result=${res.record.result} cards=[${res.record.cards.join(",")}]）`);
    } else {
      log(`块 #${idx + 1} 未落账（跳过，不阻塞）。`);
    }
  });

  if (landedRunIds.length > 0) {
    for (const d of archiveRunReports(root, landedRunIds, parsed.text)) log(d);
  }

  log(`落账 ${written}/${blocks.length} 条；触发重编译。`);
  recompile(root);
  return 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath !== "" && invokedPath === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
