#!/usr/bin/env node
/**
 * zcode-board / board-io（T6 交付物，自本任务后冻结；如需扩展由主会话另立任务）
 *
 * 职责（设计 §3.4 / §12 的机械层，不含任何看板语义判断）：
 *   1. 源头内联号标记解析（语法族唯一实现，见 assets/contracts/markers.md §1–§2）；
 *   2. JSON / 文本读取（区分"缺失"与"损坏"，供 §12 降级路径分流）；
 *   3. 原子写（临时文件 + 改名，writeFileAtomic / writeJsonAtomic）；
 *   4. 带时区 ISO 8601 时间戳工具（board.schema.json 冻结形态）。
 *
 * 无第三方依赖：仅 node 内置模块。下游复用者：compile-board.mjs（T6）、
 * marker-write.mjs（T9）、register-interview.mjs / runs.mjs（T8）。
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

// ---------------------------------------------------------------- 标记解析

/**
 * 标记正则（markers.md §1 冻结；#53 契约 v2.3 扩展 roadmap 子旗标）：
 * `<!-- zcode-board: no=N -->` 或 `<!-- zcode-board: no=N, roadmap -->`，N 为 [1-9][0-9]*。
 * 书写形态以单空格规范形态为准；解析对注释内空白容错。前导零（no=07）不匹配 —— 非法。
 * roadmap 为可选子旗标（只在计划稿 H1 层合法；解析与位置审计见 compile-board.mjs 与 markers.md §2.5）。
 */
export const MARKER_SOURCE = "<!--\\s*zcode-board:\\s*no=([1-9][0-9]*)(?:\\s*,\\s*roadmap)?\\s*-->";

/**
 * roadmap 子旗标标记（#53 契约 v2.3）：独立注释 `<!-- zcode-board: roadmap -->` 或
 * 与号标记同注释 `<!-- zcode-board: no=N, roadmap -->`（两形态等价，见 markers.md §2.5）。
 */
export const ROADMAP_MARKER_RE = /<!--\s*zcode-board:\s*(?:no=[1-9][0-9]*\s*,\s*roadmap|roadmap)\s*-->/;

/** 解析全部标记：返回 [{no, index, text}]，index 为匹配起点（行内偏移按整文本累计）。 */
export function parseMarkers(text) {
  const out = [];
  const re = new RegExp(MARKER_SOURCE, "g");
  let m;
  while ((m = re.exec(String(text ?? ""))) !== null) {
    out.push({ no: Number(m[1]), index: m.index, text: m[0] });
  }
  return out;
}

/**
 * 文件级标记（markers.md §2.1 保守解析）：文件头首个"非条目行上的标记"有效。
 * 收紧理由：§2.2 规定条目行行尾标记只作行级号（只附着该条目）；若把首个匹配无条件当文件头标记，
 * 会把某条目的行级号误读成特性号。调用方传入 isEntryLine 判定条目行（两种语法模式各自实现）。
 * 返回 {no, lineIndex, count} 或 null；count 为全文件标记总数（供"多个头标记"提示级诊断）。
 */
export function findFileMarker(lines, isEntryLine) {
  const list = Array.isArray(lines) ? lines : String(lines ?? "").split(/\r?\n/);
  const isEntry = typeof isEntryLine === "function" ? isEntryLine : () => false;
  let count = 0;
  for (let i = 0; i < list.length; i += 1) {
    const markers = parseMarkers(list[i]);
    count += markers.length;
    if (markers.length === 0) continue;
    if (isEntry(list[i])) continue;
    return { no: markers[0].no, lineIndex: i, count };
  }
  return null;
}

/** 行尾标记：最后一个匹配且其后只剩空白才有效（标记不跨行、不依赖缩进）。 */
export function lineEndMarker(line) {
  const text = String(line ?? "");
  const all = parseMarkers(text);
  if (all.length === 0) return null;
  const last = all[all.length - 1];
  if (!/^\s*$/.test(text.slice(last.index + last.text.length))) return null;
  return { no: last.no, index: last.index, text: last.text };
}

/** 去掉行尾标记（保留其余字节）；无标记时原样返回。 */
export function stripLineEndMarker(line) {
  const text = String(line ?? "");
  const m = lineEndMarker(text);
  return m ? text.slice(0, m.index).trimEnd() : text;
}

/**
 * 作者句柄归一（markers.md §4 冻结算法）：`9` / `#9` / `ID-9` → 9；
 * 其余（含层级标签 `1.2`、`ID-1.2`、`#1.2`、`0`、`09`、`-3`、`task-9`、`no=9`）→ null（拒收）。
 */
export function normalizeHandle(raw) {
  let s = String(raw ?? "").trim();
  if (s.startsWith("#")) s = s.slice(1);
  else if (s.startsWith("ID-")) s = s.slice(3);
  s = s.trim();
  return /^[1-9][0-9]*$/.test(s) ? Number(s) : null;
}

// ---------------------------------------------------------------- 读取

/** 读 JSON：{ok:true,value,text} / {ok:false,missing:true} / {ok:false,missing:false,error,text}。 */
export function readJsonFile(absPath) {
  let text;
  try {
    text = readFileSync(absPath, "utf8");
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR" || e.code === "EISDIR")) {
      return { ok: false, missing: true, error: null, text: null };
    }
    return { ok: false, missing: false, error: e.message, text: null };
  }
  try {
    return { ok: true, value: JSON.parse(text), text };
  } catch (e) {
    return { ok: false, missing: false, error: e.message, text };
  }
}

/** 读文本：{ok:true,text} / {ok:false,missing:true} / {ok:false,missing:false,error}。 */
export function readTextFile(absPath) {
  try {
    return { ok: true, text: readFileSync(absPath, "utf8") };
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR" || e.code === "EISDIR")) {
      return { ok: false, missing: true, error: null };
    }
    return { ok: false, missing: false, error: e.message };
  }
}

export function isFile(absPath) {
  try {
    return statSync(absPath).isFile();
  } catch {
    return false;
  }
}

export function isDir(absPath) {
  try {
    return statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 写入（原子）

let tmpSeq = 0;

function tmpNameFor(absPath) {
  tmpSeq += 1;
  const stamp = Date.now().toString(36);
  return join(dirname(absPath), `.${basename(absPath)}.tmp-${process.pid}-${stamp}-${tmpSeq}`);
}

/** 临时文件 + fsync + 原子改名；改名失败清理临时文件后抛出（不留半成品）。 */
export function writeFileAtomic(absPath, content) {
  mkdirSync(dirname(absPath), { recursive: true });
  const tmp = tmpNameFor(absPath);
  const fd = openSync(tmp, "w", 0o666);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, absPath);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 清理失败不掩盖原错误 */
    }
    throw e;
  }
  return absPath;
}

/** 原子写 JSON：两空格缩进 + 末尾换行（逐字节确定性；键序由调用方决定）。 */
export function writeJsonAtomic(absPath, value, { indent = 2 } = {}) {
  return writeFileAtomic(absPath, `${JSON.stringify(value, null, indent)}\n`);
}

// ---------------------------------------------------------------- 时间戳

const pad2 = (n) => String(Math.abs(n)).padStart(2, "0");

/** 带时区 ISO 8601（秒精度，board.schema.json 冻结形态）：2026-10-09T15:00:00+08:00。 */
export function isoLocal(date = new Date()) {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const off = `${sign}${pad2(Math.floor(Math.abs(offsetMin) / 60))}:${pad2(Math.abs(offsetMin) % 60)}`;
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}${off}`
  );
}

export function nowIso() {
  return isoLocal(new Date());
}

/** 文件 mtime → ISO；不可读时返回 null（调用方留空不猜）。 */
export function mtimeIso(absPath) {
  try {
    return isoLocal(new Date(statSync(absPath).mtimeMs));
  } catch {
    return null;
  }
}

/** ISO 8601 形态校验（schema pattern 的同一正则，供降级与透传分流）。 */
export const ISO_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([+-][0-9]{2}:[0-9]{2}|Z)$/;
