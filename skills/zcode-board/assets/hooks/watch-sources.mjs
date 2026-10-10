#!/usr/bin/env node
/**
 * zcode-board / watch-sources（T13 交付物；B3-1 扩展 Bash 检测面）——真相源变更 → 自动重编译 / 陈旧告警
 *
 * 职责（设计 §10.4 第 4 项；任务 T13 场景 29；B3-1/AD-10③/E4-06）：
 *   1. PostToolUse(Write|Edit)：判定变更路径是否属 board 源 → 触发编译器 CLI 重编译（原行为不变）。
 *   2. PostToolUse(Bash，#101/#102)：轻量启发解析命令文本，识别删除源（rm/rmdir/git rm）、
 *      非 Write|Edit 新增/写入源（cp/install/rsync、mv/git mv、touch/tee、重定向、sed -i/perl -i）——
 *      命中则输出"板陈旧告警"（点名路径与类别，明确指向重编译），**不自动重编译**；命令非零退出时不告警。
 *   3. 归档移动分流（B3-2/AD-10③）：删除源事件的移动目标（dest）命中勘误 10 归档映射候选
 *      （.zcode/plans/<x>→.zcode/archive/<x>、docs/plans|docs/design-notes/<x>→docs/archive/plans/<x>、
 *      specs/<f>/…→specs/archive/<f>/…，含 spec 目录整移与目录目标形态）→ 判"合法转移"（不判违规），
 *      输出"合法转移提示"指向 --assign 指向改写（与 --check 归档直查共用同一指引句）；
 *      dest 为空（移出根）/非归档目标/归档根下非映射子路径 → 维持板陈旧告警（误判必咬，见 run-t13 W14）。
 *   源归属判定（两路并用，宁多编译不漏编译）：
 *     1. 权威路：board.json 的 sources[]（存在时逐条匹配：精确路径 / spec 根+files）；
 *     2. 形态路：源位置的形态匹配——覆盖"新文件尚未进 sources[]"的窗口；#72 起按
 *        .zcode/board/scan.json 解析（默认 .zcode/plans/，docs 计划目录需 opt-in，excludeGlobs 命中不算）。
 *
 * 行为约束（设计 §10.4）：
 *   - async 语义（配置声明 async:true）：本脚本自行 spawnSync 编译后退出，stdout 恒空；
 *   - 失败不阻塞：编译器失败只写 stderr（mtime 陈旧角标兜底）；退出码恒 0；Bash 通道只告警不修复；
 *   - board.json/board.md/evidence/ 等派生或非源路径不触发（防自激）。
 *
 * 无第三方依赖（仅 node 内置）。
 */

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readJsonFile } from "../lib/board-io.mjs";
import { loadScanConfig, matchesAnyGlob } from "../lib/scan-config.mjs";
import { scanSourceChangeClaims } from "./source-change-detect.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPILER = resolve(HERE, "..", "compile-board.mjs");
const BOARD_REL = ".zcode/board/board.json";
const COMPILE_TIMEOUT_MS = 20_000;

/** 第一方源（路径精确匹配）。 */
const FIRST_PARTY = new Set([".zcode/board/interviews.json", ".zcode/board/registry.json", ".zcode/board/runs.json"]);
/** spec 文件（目录级归属：四类编译器输入）。 */
const SPEC_FILES = new Set(["tasks.md", "progress.json", "requirements.md", "design.md"]);

function log(msg) {
  process.stderr.write(`watch-sources: ${msg}\n`);
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

function toPosix(p) {
  return String(p).split("\\").join("/");
}

/** 变更路径 → 相对项目根的 posix 相对路径；不在根内返回 null。 */
function relativeInRoot(root, filePath, payloadCwd) {
  let abs = null;
  if (isAbsolute(filePath)) abs = resolve(filePath);
  else {
    const base = typeof payloadCwd === "string" && isDirectory(payloadCwd) ? payloadCwd : root;
    abs = resolve(base, filePath);
  }
  const rel = toPosix(relative(root, abs));
  if (rel === "" || rel.startsWith("../") || isAbsolute(rel)) return null;
  return rel;
}

/** sources[] 成员判定（spec 条目按 root+files）。 */
function inSources(board, rel) {
  for (const s of board?.sources ?? []) {
    if (!s || typeof s !== "object") continue;
    if (typeof s.path === "string" && toPosix(s.path) === rel) return true;
    if (typeof s.root === "string" && Array.isArray(s.files)) {
      const rootRel = toPosix(s.root).replace(/\/$/, "");
      if (rel.startsWith(`${rootRel}/`) && s.files.map(toPosix).includes(rel.slice(rootRel.length + 1))) return true;
    }
  }
  return false;
}

/** 源位置形态判定（新文件窗口覆盖）。#72：计划目录面随 .zcode/board/scan.json 解析——编译器扫什么，hook 就认什么
 *  （默认只 .zcode/plans/；docs 计划目录需 opt-in；excludeGlobs 命中不算真相源）。 */
function inSourceShape(root, rel) {
  if (FIRST_PARTY.has(rel)) return true;
  const surface = loadScanConfig(root);
  if (matchesAnyGlob(rel, surface.excludeGlobs)) return false;
  if (surface.planDirs.some((d) => rel.startsWith(`${d}/`))) return true;
  const m = /^specs\/([^/]+)\/([^/]+)$/.exec(rel);
  if (m && SPEC_FILES.has(m[2])) return true;
  return false;
}

function compile(root) {
  const r = spawnSync(process.execPath, [COMPILER, root], { encoding: "utf8", timeout: COMPILE_TIMEOUT_MS });
  if (r.error) {
    log(`重编译未完成（${r.error.message}）：陈旧角标兜底，不阻塞。`);
    return false;
  }
  if (r.status !== 0) {
    log(`重编译失败（退出码 ${String(r.status)}）：${String(r.stderr ?? "").trim().slice(0, 300)}（陈旧角标兜底，不阻塞）`);
    return false;
  }
  log(`重编译完成：${String(r.stdout ?? "").trim()}`);
  return true;
}

// ---------------------------------------------------------------- B3-1/B3-2：Bash 通道检测面与归档分流（#101/#102）

const MAX_ALERT_ITEMS = 8;
const KIND_LABEL = { delete: "删除", create: "新增", write: "写入", move: "移动" };

function posixJoin(dir, base) {
  const d = String(dir).replace(/\/+$/, "");
  return d === "" ? base : `${d}/${base}`;
}

function baseNameOf(p) {
  const parts = String(p).replace(/\/+$/, "").split("/");
  return parts[parts.length - 1];
}

/** 项目根解析：payload.cwd → ZCODE_PROJECT_DIR → CLAUDE_PROJECT_DIR → process.cwd()，取首个真实目录。 */
function resolveRoot(payload) {
  const payloadCwd = typeof payload?.cwd === "string" ? payload.cwd : null;
  for (const cand of [payloadCwd, process.env.ZCODE_PROJECT_DIR, process.env.CLAUDE_PROJECT_DIR, process.cwd()]) {
    if (typeof cand === "string" && cand !== "" && isDirectory(cand)) return resolve(cand);
  }
  return null;
}

/** 归档目录（编译器按名排除：specs/archive、.zcode/archive、docs/archive）不是源面。 */
function isArchivePath(rel) {
  return (
    rel === "specs/archive" ||
    rel.startsWith("specs/archive/") ||
    rel === ".zcode/archive" ||
    rel.startsWith(".zcode/archive/") ||
    rel === "docs/archive" ||
    rel.startsWith("docs/archive/")
  );
}

/** 与 compile-board.mjs --check 归档直查共用的指引句（同一文案，防二份漂移）。 */
const ASSIGN_GUIDE_SENTENCE = "运行 --assign 改写指向（号不变、assignedAt 保留，勘误 10）";

/**
 * 勘误 10 归档映射（与 compile-board.mjs `archiveCandidateOf` 同源；hook 不 import 编译器 CLI，改动须同步）：
 *   .zcode/plans/<x> → .zcode/archive/<x>
 *   docs/plans/<x>、docs/design-notes/<x> → docs/archive/plans/<x>
 *   specs/<f>/<x> → specs/archive/<f>/<x>；specs/<f>（目录整移）→ specs/archive/<f>
 * 归档目录自身不再映射（指向改写幂等）。
 * 分流判据=**精确映射**：dest 恰为候选才判"合法转移"——"归档根下的任意子路径"不可机械修复
 * （--assign 指向改写与 --check 直查都按映射候选推导），宽松判据会作废的承诺（误判必咬：W14 近邻场景）。
 */
function archiveCandidateOf(rel) {
  if (typeof rel !== "string" || rel === "") return null;
  if (rel.startsWith(".zcode/plans/")) return `.zcode/archive/${rel.slice(".zcode/plans/".length)}`;
  if (rel.startsWith("docs/plans/")) return `docs/archive/plans/${rel.slice("docs/plans/".length)}`;
  if (rel.startsWith("docs/design-notes/")) return `docs/archive/plans/${rel.slice("docs/design-notes/".length)}`;
  const dir = /^specs\/([^/]+)$/.exec(rel); // 编译器的 --check 直查以 spec 根为键；目录整移同映射
  if (dir && dir[1] !== "archive") return `specs/archive/${dir[1]}`;
  const m = /^specs\/([^/]+)\/(.*)$/.exec(rel);
  if (m && m[1] !== "archive") return `specs/archive/${m[1]}/${m[2]}`;
  return null;
}

/** 归档移动判定（B3-2）：合法则返回实际落点（勘误 10 映射候选），否则 null。
 *  文件目标 = dest；目录目标形态（git mv <src> <归档根>/）= dest/<basename>。 */
function archiveMoveLanding(srcRel, destRel) {
  if (destRel === null || destRel === "") return null;
  const cand = archiveCandidateOf(srcRel);
  if (cand === null) return null;
  const dest = destRel.replace(/\/+$/, "");
  if (dest === cand || `${dest}/${baseNameOf(srcRel)}` === cand) return cand;
  return null;
}

/** 源面谓词集（Bash 通道）：文件级（sources[] ∪ 形态）、已知源（sources[]）、目录级（整目录删除/移动）。 */
function makeSurface(root, board) {
  const surface = loadScanConfig(root);
  const excluded = (rel) =>
    matchesAnyGlob(rel, surface.excludeGlobs) ||
    matchesAnyGlob(`${rel}/`, surface.excludeGlobs) ||
    matchesAnyGlob(`${rel}/__probe__.md`, surface.excludeGlobs);
  const isSource = (rel) => inSources(board, rel) || inSourceShape(root, rel);
  const isKnownSource = (rel) => inSources(board, rel);
  const isSourceDir = (rel) => {
    if (rel === "" || isArchivePath(rel)) return false;
    if (rel === "specs" || /^specs\/[^/]+$/.test(rel)) return true;
    if (surface.planDirs.some((d) => rel === d || rel.startsWith(`${d}/`))) return !excluded(rel);
    return surface.planDirs.some((d) => d.startsWith(`${rel}/`)); // 计划目录的祖先（删容器面）
  };
  return { isSource, isKnownSource, isSourceDir };
}

/** 通配参数 → 目录前缀（首个含通配符的段之前；无通配/首段即通配返回 null）。 */
function globPrefixOf(rel) {
  const parts = String(rel).split("/");
  const idx = parts.findIndex((p) => /[*?[\]]/.test(p));
  if (idx <= 0) return null;
  return parts.slice(0, idx).join("/");
}

/** write claim → 实际写入目标 rel 列表：目标是真实目录时用 dirCandidate（<dest>/<basename>），否则用 path。 */
function writeTargets(root, pathArg, dirCandidate, payloadCwd) {
  const rel = relativeInRoot(root, pathArg, payloadCwd);
  if (rel === null) return [];
  if (typeof dirCandidate === "string" && dirCandidate !== "" && isDirectory(resolve(root, rel))) {
    const cand = relativeInRoot(root, dirCandidate, payloadCwd);
    return cand === null ? [] : [cand];
  }
  return [rel];
}

/** Bash 命令 → 源面事件（claim 做归属判定与 kind 归一；path/dest 为项目根相对 posix 路径）。 */
function collectBashEvents(root, board, command, payloadCwd) {
  const { isSource, isKnownSource, isSourceDir } = makeSurface(root, board);
  const events = [];
  const seen = new Set();
  const add = (ev) => {
    const key = `${ev.kind}|${ev.path}|${ev.dest ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    events.push(ev);
  };
  /** 目录级归属（含通配参数的前缀）：rm -rf <dir> / sed -i <dir>/*.md 一类整面操作。 */
  const dirMember = (rel) => {
    if (isSourceDir(rel)) return true;
    const prefix = globPrefixOf(rel);
    return prefix !== null && isSourceDir(prefix);
  };
  for (const cl of scanSourceChangeClaims(command)) {
    if (cl.op === "delete") {
      const rel = relativeInRoot(root, cl.path, payloadCwd);
      if (rel === null || (!isSource(rel) && !dirMember(rel))) continue;
      const destRel = cl.dest === null ? null : relativeInRoot(root, cl.dest, payloadCwd);
      const landing = archiveMoveLanding(rel, destRel);
      add({ kind: landing !== null ? "archive-move" : "delete", verb: cl.verb, path: rel, dest: destRel, landing });
      continue;
    }
    if (cl.op === "move") {
      const srcRel = relativeInRoot(root, cl.path, payloadCwd);
      if (srcRel === null) continue;
      const destRel = cl.dest === null || cl.dest === "" ? null : relativeInRoot(root, cl.dest, payloadCwd);
      if (isSource(srcRel) || dirMember(srcRel)) {
        // 源面内移出/挪位：dest 一并带上——归档移动分流（B3-2）靠它判"合法转移"。
        const destMember = destRel !== null && (isSource(destRel) || dirMember(destRel));
        const landing = destMember ? null : archiveMoveLanding(srcRel, destRel);
        const kind = destMember ? "move" : landing !== null ? "archive-move" : "delete";
        add({ kind, verb: cl.verb, path: srcRel, dest: destRel, landing });
        continue;
      }
      if (destRel === null) continue;
      // 移入源面（如 `mv /tmp/稿 .zcode/plans/`）：按目标文件判定（目录目标展开 basename）。
      for (const cand of writeTargets(root, cl.dest, posixJoin(cl.dest, baseNameOf(cl.path)), payloadCwd)) {
        if (!isSource(cand) && !dirMember(cand)) continue;
        add({ kind: isKnownSource(cand) ? "write" : "create", verb: cl.verb, path: cand, dest: null });
      }
      continue;
    }
    if (cl.op === "write") {
      for (const cand of writeTargets(root, cl.path, cl.dirCandidate ?? null, payloadCwd)) {
        if (!isSource(cand) && !dirMember(cand)) continue;
        // 通配/目录面写入（sed -i <dir>/*.md）按「写入」计；单文件尚未进 sources[] 才是「新增」。
        const kind = isKnownSource(cand) || globPrefixOf(cand) !== null ? "write" : "create";
        add({ kind, verb: cl.verb, path: cand, dest: null });
      }
    }
  }
  return events;
}

function renderEvent(ev) {
  if (ev.kind === "archive-move") {
    // 归档=只移动位置（不判违规）：文案指向 --assign 指向改写，与 --check 归档直查同一指引句。
    return `合法转移：${ev.path}（移至 ${ev.landing ?? ev.dest}）→ ${ASSIGN_GUIDE_SENTENCE}`;
  }
  const label = KIND_LABEL[ev.kind] ?? ev.kind;
  if (ev.kind === "move" && ev.dest) return `${label}：${ev.path} → ${ev.dest}`;
  if (ev.dest !== null && ev.dest !== undefined) return `${label}：${ev.path}（移至 ${ev.dest}）`;
  return `${label}：${ev.path}`;
}

/** 板陈旧告警 + 归档合法转移提示（B3-2 两文案分流；stderr；不改板、不重编译——修复由人工或 Stop 兜底负责）。 */
function emitStaleAlert(events, root) {
  const archiveMoves = events.filter((ev) => ev.kind === "archive-move");
  const stale = events.filter((ev) => ev.kind !== "archive-move");
  if (stale.length > 0) {
    log(`板陈旧告警：检测到 ${stale.length} 处 Bash 源变更（未经重编译）——看板可能已陈旧，请重编译：node ${COMPILER} ${root}`);
    for (const ev of stale.slice(0, MAX_ALERT_ITEMS)) log(`  - ${renderEvent(ev)}`);
    if (stale.length > MAX_ALERT_ITEMS) log(`  - …等 ${stale.length} 处（详见命令原文）`);
  }
  if (archiveMoves.length > 0) {
    log(`合法转移提示：检测到 ${archiveMoves.length} 处归档移动（合法转移、非违规——号与条目保留；registry 指向改写：node ${COMPILER} ${root} --assign，--assign 自动重编译）`);
    for (const ev of archiveMoves.slice(0, MAX_ALERT_ITEMS)) log(`  - ${renderEvent(ev)}`);
    if (archiveMoves.length > MAX_ALERT_ITEMS) log(`  - …等 ${archiveMoves.length} 处（详见命令原文）`);
  }
}

/** 命令退出码（现代 payload 在 tool_response.exitCode；未知形态返回 null = 不抑制）。 */
function toolExitCode(payload) {
  const tr = payload?.tool_response ?? payload?.toolResponse ?? null;
  if (tr !== null && typeof tr === "object" && typeof tr.exitCode === "number") return tr.exitCode;
  return null;
}

function snippet(text) {
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > 80 ? `${t.slice(0, 77)}…` : t;
}

function handleBash(payload, input) {
  const command = typeof input?.command === "string" ? input.command : null;
  if (command === null || command.trim() === "") {
    log("Bash payload 无 tool_input.command：跳过（不阻塞）。");
    return 0;
  }
  const root = resolveRoot(payload);
  if (root === null) {
    log("无法确定项目根：跳过（不阻塞）。");
    return 0;
  }
  const payloadCwd = typeof payload.cwd === "string" ? payload.cwd : null;
  const loaded = readJsonFile(join(root, BOARD_REL));
  const board = loaded.ok && loaded.value && typeof loaded.value === "object" ? loaded.value : null;
  const events = collectBashEvents(root, board, command, payloadCwd);
  if (events.length === 0) {
    log(`Bash 命令未命中真相源（${snippet(command)}）：不触发。`);
    return 0;
  }
  const exitCode = toolExitCode(payload);
  if (typeof exitCode === "number" && exitCode !== 0) {
    log(`Bash 源变更疑似（${events.length} 处）但命令非零退出（${exitCode}）：不告警（以现场为准，Stop 兜底）。`);
    return 0;
  }
  emitStaleAlert(events, root);
  return 0;
}

// ---------------------------------------------------------------- 主流程

function handleWriteEdit(payload, input) {
  const filePath = typeof input?.file_path === "string" ? input.file_path : typeof input?.filePath === "string" ? input.filePath : null;
  if (filePath === null || filePath === "") {
    log("payload 无 tool_input.file_path：跳过（不阻塞）。");
    return 0;
  }

  const payloadCwd = typeof payload.cwd === "string" ? payload.cwd : null;
  const root = resolveRoot(payload);
  if (root === null) {
    log("无法确定项目根：跳过（不阻塞）。");
    return 0;
  }

  const rel = relativeInRoot(root, filePath, payloadCwd);
  if (rel === null) {
    log(`变更路径在项目根之外（${filePath}）：不触发。`);
    return 0;
  }

  const loaded = readJsonFile(join(root, BOARD_REL));
  const board = loaded.ok && loaded.value && typeof loaded.value === "object" ? loaded.value : null;
  const member = inSources(board, rel) || inSourceShape(root, rel);
  if (!member) {
    log(`非真相源路径（${rel}）：不触发重编译。`);
    return 0;
  }

  log(`真相源变更（${rel}）：触发重编译。`);
  compile(root);
  return 0;
}

function main() {
  const payload = parsePayload(readStdin());
  if (payload === null) {
    log("stdin 不是 JSON payload：跳过（不阻塞）。");
    return 0;
  }
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : typeof payload.toolName === "string" ? payload.toolName : null;
  const input = payload.tool_input ?? payload.toolInput ?? {};
  if (toolName === "Bash") return handleBash(payload, input);
  if (toolName !== null && toolName !== "Write" && toolName !== "Edit") {
    log(`tool_name=${toolName} 非 Write|Edit|Bash：跳过。`);
    return 0;
  }
  return handleWriteEdit(payload, input);
}

try {
  process.exit(main());
} catch (e) {
  // hook 自身异常：不阻塞主流程（失败只进 stderr、exit 0 语义保持）。
  log(`hook 异常（${e?.message ?? e}）：跳过（不阻塞，请核查 hook）。`);
  process.exit(0);
}
