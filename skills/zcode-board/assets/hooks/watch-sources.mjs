#!/usr/bin/env node
/**
 * zcode-board / watch-sources（T13 交付物）——PostToolUse(Write|Edit) 真相源变更 → 自动重编译
 *
 * 职责（设计 §10.4 第 4 项；任务 T13 场景 29）：
 *   收到文件变更事件 → 判定变更路径是否属 board 源（sources：interviews/registry/runs、
 *   specs/<f>/{tasks.md,progress.json,requirements.md,design.md}、计划目录——#72 起按
 *   .zcode/board/scan.json 解析：默认 .zcode/plans/，docs 计划目录需 opt-in，excludeGlobs 命中不算）；
 *   属源才调编译器 CLI 重编译，其余路径零动作。
 *
 * 归属判定（两路并用，宁多编译不漏编译）：
 *   1. 权威路：board.json 的 sources[]（存在时逐条匹配：精确路径 / spec 根+files）；
 *   2. 形态路：源位置的形态匹配——覆盖"新文件尚未进 sources[]"的窗口（新计划稿写入即应上板）。
 *
 * 行为约束（设计 §10.4）：
 *   - async 语义（配置声明 async:true）：本脚本自行 spawnSync 编译后退出，stdout 恒空；
 *   - 失败不阻塞：编译器失败只写 stderr（mtime 陈旧角标兜底）；退出码恒 0；
 *   - 仅真相源路径触发；board.json/board.md/evidence/ 等派生或非源路径不触发（防自激）。
 *
 * 无第三方依赖（仅 node 内置）。
 */

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readJsonFile } from "../lib/board-io.mjs";
import { loadScanConfig, matchesAnyGlob } from "../lib/scan-config.mjs";

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

function main() {
  const payload = parsePayload(readStdin());
  if (payload === null) {
    log("stdin 不是 JSON payload：跳过（不阻塞）。");
    return 0;
  }
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : typeof payload.toolName === "string" ? payload.toolName : null;
  if (toolName !== null && toolName !== "Write" && toolName !== "Edit") {
    log(`tool_name=${toolName} 非 Write|Edit：跳过。`);
    return 0;
  }
  const input = payload.tool_input ?? payload.toolInput ?? {};
  const filePath = typeof input?.file_path === "string" ? input.file_path : typeof input?.filePath === "string" ? input.filePath : null;
  if (filePath === null || filePath === "") {
    log("payload 无 tool_input.file_path：跳过（不阻塞）。");
    return 0;
  }

  const payloadCwd = typeof payload.cwd === "string" ? payload.cwd : null;
  let root = null;
  for (const cand of [payloadCwd, process.env.ZCODE_PROJECT_DIR, process.env.CLAUDE_PROJECT_DIR, process.cwd()]) {
    if (typeof cand === "string" && cand !== "" && isDirectory(cand)) {
      root = resolve(cand);
      break;
    }
  }
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

process.exit(main());
