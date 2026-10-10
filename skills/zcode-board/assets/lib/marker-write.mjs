#!/usr/bin/env node
/**
 * zcode-board / marker-write（T9 交付物：逐文件原子写号标记）
 *
 * 职责（设计 §3.4 / markers.md §6 写入面）：
 *   1. 文件级标记插入：`<!-- zcode-board: no=N -->` 置于首个标题行之后（无标题置顶）；
 *   2. 行级标记追加：条目行行尾追加同一注释（只增不改，行内原字节不动）；
 *   3. 逐文件原子写：调用 board-io.writeFileAtomic（临时文件 + 改名）；内容不变则不写
 *      （幂等：再次 --assign / 编译不再改动任何文件、mtime 不动）。
 *
 * 硬约束：除插入标记外不改动其余字节（CRLF 行尾保持）；无第三方依赖（仅 node 内置）。
 * 边界：本模块只做文本变换与原子写，不做任何看板语义判断（谁该领号归 compile-board.mjs）。
 */

import { writeFileAtomic, MARKER_SOURCE } from "./board-io.mjs";

const HEADING_RE = /^(\s*)(#{1,6})\s+(.*)$/;
/**
 * 独立成行的头标记（TQ-3 收口：与 board-io 的 MARKER_SOURCE 同口径）。
 * 合并形态 `<!-- zcode-board: no=N, roadmap -->` 也是合法现位头标记——不复认会把既有合并标记
 * 当"未盖号"，重复插入即产生"同号两处标记"（markers.md 反例表）。故从 MARKER_SOURCE 组合生成，
 * 两侧形态永远同步（词表漂移守卫由 run-scenarios 的 marker-write 公开契约断言钉住）。
 */
const STANDALONE_MARKER_RE = new RegExp(`^\\s*${MARKER_SOURCE}\\s*$`);

/** 规范标记文本（markers.md §1 单空格形态）。 */
export function markerText(no) {
  return `<!-- zcode-board: no=${no} -->`;
}

/** 按行切分并保留行尾符：返回 [{content, eol}]，末行 eol === "" 表示文件无尾换行。 */
export function splitKeepEol(text) {
  const parts = String(text ?? "").split(/(\r?\n)/);
  const out = [];
  for (let i = 0; i < parts.length; i += 2) {
    out.push({ content: parts[i], eol: parts[i + 1] ?? "" });
  }
  return out;
}

/** 还原 splitKeepEol 的文本（与切分互逆，逐字节）。 */
export function joinKeepEol(lines) {
  return lines.map((l) => l.content + l.eol).join("");
}

function hasStandaloneMarkerLine(lines) {
  return lines.some((l) => STANDALONE_MARKER_RE.test(l.content));
}

/**
 * 插入文件级标记：置于首个标题行之后（无标题则置顶）。已有独立成行的头标记时不再插入
 * （防止重复盖号）。除新增一行外不改动任何既有字节。
 */
export function insertHeaderMarker(text, no) {
  const lines = splitKeepEol(text);
  if (hasStandaloneMarkerLine(lines)) return text;
  const headingIndex = lines.findIndex((l) => HEADING_RE.test(l.content));
  const at = headingIndex >= 0 ? headingIndex + 1 : 0;
  const eol = lines[at - 1]?.eol || lines[at]?.eol || "\n";
  if (at > 0 && lines[at - 1].eol === "") lines[at - 1].eol = eol; // 原末行补换行以容纳新行
  lines.splice(at, 0, { content: markerText(no), eol });
  return joinKeepEol(lines);
}

/** 行尾追加标记（纯插入：不裁剪既有空白，行内其余字节不动）。 */
export function insertLineMarker(text, lineIndex, no) {
  const lines = splitKeepEol(text);
  const line = lines[lineIndex];
  if (!line) throw new Error(`行号 ${lineIndex} 越界（共 ${lines.length} 行）`);
  line.content = `${line.content} ${markerText(no)}`;
  return joinKeepEol(lines);
}

/**
 * 组合编辑（一次性应用；行号以传入文本的原始行为准）：
 *   { headerMarkerNo: N | null, lineMarkerNos: [{lineIndex, no}] } → 新文本。
 * 无编辑 → 逐字节原样返回（幂等基础）。
 */
export function applyMarkerEdits(text, { headerMarkerNo = null, lineMarkerNos = [] } = {}) {
  let out = String(text ?? "");
  for (const { lineIndex, no } of [...(lineMarkerNos ?? [])].sort((a, b) => a.lineIndex - b.lineIndex)) {
    out = insertLineMarker(out, lineIndex, no);
  }
  if (headerMarkerNo != null) out = insertHeaderMarker(out, headerMarkerNo);
  return out;
}

/** 逐文件原子写：内容不变则不写（mtime 不动）。返回是否写入。 */
export function writeMarkersIfChanged(absPath, newText, oldText) {
  if (newText === oldText) return false;
  writeFileAtomic(absPath, newText);
  return true;
}
