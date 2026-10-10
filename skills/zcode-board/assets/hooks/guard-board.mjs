#!/usr/bin/env node
/**
 * zcode-board / guard-board（B5-1，#113）——PreToolUse 板文件禁写 + 报告 evidence 存在性校验
 *
 * 背景（裁决⑥「一期必须立起 E1 37 起事件的机械化防线」；E1 V19；AD-10 全收）：
 *   V19 两次事故 = 施工证据写进错根板（ZPaPa/.zcode/board/evidence/…）且 run 声明的 evidence 按板根
 *   解析不存在——文字防线（dispatch-checklist「绝对路径 + 显式 cd」）之后仍再发生，故立机械防线。
 *
 * 本 hook 两条断言（有意阻断；其余一律 exit 0 静默放行）：
 *
 * 断言 A｜板数据文件禁写（pre-agreed 边界：证据落盘是正当路径）：
 *   板数据文件 = 任意层级 `<...>/.zcode/board/` 目录下的
 *     board.json / board.md / runs.json / interviews.json / registry.json /
 *     exemptions.json / last-reconcile.md。
 *   这些文件只有唯一写路径（见下 text 表），经 Write / Edit / Bash（重定向、sed -i、tee、touch、
 *   cp/mv 目标、rm/删除、通配可命中）直写一律阻断（exit 2）。
 *   不在禁写面：`.zcode/board/evidence/**`（证据落盘）与板内非数据文件（scan.json / night-log.md /
 *   design.md 等——按文件名枚举，枚举之外不再扩大）；板目录本体仅拦截删除/移动（registry 号与
 *   条目不可销毁），对目录本体的写不判。
 *   组件名与文件名按大小写不敏感判定（macOS/Windows 文件系统下 `.ZCODE/BOARD` 即同一现场，防字母变体绕过）。
 *
 * 断言 B｜报告 evidence 引用逐条存在性（仅 Write|Edit 且目标为 .md；Write 校验全文、Edit 校验 new_string 片段）：
 *   解析三种声明形态：`evidence: ["…"]` line 流式数组、`evidence:` + `- …` YAML 块列表、
 *   ```json 围栏块内 `evidence` 数组（含 run_event 形态，递归收集）。
 *   逐条存在性判定（候选基准，去重后任一命中即算在位）：
 *     绝对路径原样 / 会话 cwd 相对 / `cwd/.zcode/board` 相对 / 报告所在板根相对。
 *   缺失 → 阻断并点名缺哪条（不猜测、不造路径）；无 cwd 且相对引用无法解析 → 该条跳过（fail-open，
 *   stderr 诊断），板文件面不受影响。
 *   不进入校验面（不可机械核验，非漏判）：占位（`...`、`<>`）、通配（`*`、`?`）、花括号扩展、`$` 展开、URL。
 *
 * 阻断形态：PreToolUse 退出码 2 被运行时译为 permissionDecision deny（阻断原因取 stderr）；
 * 放行零噪声（不输出）。本 hook 自身异常 = fail-open（放行 + stderr 诊断）；两类违规 = fail-closed。
 * 与 gate-merge（合并门禁）的分工：gate-merge 只拦缺三绿证据的 base 合并；本 hook 只拦板数据直写与
 * 证据悬空引用——两者共同构成「有意阻断者」清单（SKILL §3.6 步骤 4 成文随之更新）。
 *
 * 边界（诚实声明，宁少报不误报）：不解析 xargs/find -delete/bash -c 二级命令；不展开变量与命令替换；
 * 不解析 cd 变更目录后的相对路径；heredoc 正文不参与解析（与 B3-1 source-change-detect 同口径）；
 * `git checkout/stash` 一类可能覆盖板文件的命令不在本 hook 判定面（漏面由对账面兜底）。
 * 复用 B3-1 纯函数 scanSourceChangeClaims。
 *
 * 无第三方依赖（仅 node 内置 + 相对导入）。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { scanSourceChangeClaims } from "./source-change-detect.mjs";

/** 板数据文件 → 唯一写路径（去路文案；与 SKILL §3 各节同源）。 */
const BOARD_DATA_ROADS = new Map([
  ["board.json", "board.json 是编译派生件：跑 `node <skill>/assets/compile-board.mjs <项目根>` 重编译"],
  ["board.md", "board.md 是编译派生件：跑 `node <skill>/assets/compile-board.mjs <项目根>` 重编译"],
  ["runs.json", "runs.json 唯一写路径：record-run.mjs（前台 PostToolUse 自动 / 后台编排者以报告原文为 stdin 代触发）"],
  ["interviews.json", "interviews.json 唯一写路径：register-interview.mjs 的 append/resolve"],
  ["registry.json", "registry.json 由发号与指向改写维护（compile-board.mjs --assign），号永不回滚"],
  ["exemptions.json", "exemptions.json 属编排者单写者（豁免登记；不得假造 run 记录绕过）"],
  ["last-reconcile.md", "last-reconcile.md 产物归 reconcile-stop.mjs（Stop 对账 hook）"],
]);
const BOARD_DATA_FILES = new Set(BOARD_DATA_ROADS.keys());

/** 不可机械核验的引用形态：占位（.../<>）、通配（*?）、花括号、$ 展开、URL。 */
const PLACEHOLDER_RE = /[*?[\]{}<>$]|\.\.\.|:\/\//;

// ---------------------------------------------------------------- 基础工具

function log(msg) {
  process.stderr.write(`guard-board: ${msg}\n`);
}

function block(lines) {
  process.stderr.write(`${lines.join("\n")}\n`);
  return 2;
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

/** 会话工作基准目录（payload.cwd → 环境 → 进程 cwd；须真实存在）。 */
function resolveCwd(payload) {
  for (const cand of [payload.cwd, process.env.ZCODE_PROJECT_DIR, process.env.CLAUDE_PROJECT_DIR, process.cwd()]) {
    if (typeof cand === "string" && cand !== "" && isDirectory(cand)) return resolve(cand);
  }
  return null;
}

/** 相对路径按基准解析为绝对；绝对路径归一；无基准返回 null。 */
function resolveAgainst(base, p) {
  const s = String(p);
  if (isAbsolute(s)) return resolve(s);
  return base === null ? null : resolve(base, s);
}

/** 原样 + 按 cwd 归一 两种候选（组件判定对两者都跑；原始串保留便于点名）。 */
function pathCandidates(p, cwd) {
  const raw = String(p);
  const out = [raw];
  const abs = resolveAgainst(cwd, raw);
  if (abs !== null && abs !== raw) out.push(abs);
  return out;
}

// ---------------------------------------------------------------- 断言 A：板数据文件禁写

/** 路径 → 组件序列（反斜杠归一；`.` 与空段丢弃）。 */
function toSegments(p) {
  return String(p)
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .split("/")
    .filter((s) => s !== "" && s !== ".");
}

/**
 * 板路径分类：null（与板无关）| { kind, file? }
 *   evidence  —— `.zcode/board/evidence/**`（正当写面）
 *   board-dir —— 板目录本体
 *   glob      —— board/ 后首段含通配/花括号（可命中板数据文件）
 *   data      —— 板数据文件（禁写；file = 文件名）
 *   other     —— 板内非数据文件
 */
function boardPathKind(p) {
  const segs = toSegments(p);
  for (let i = 0; i + 1 < segs.length; i += 1) {
    // 组件名大小写不敏感：macOS/Windows 文件系统下 `.ZCODE/BOARD` 与 `.zcode/board` 是同一现场
    if (segs[i].toLowerCase() !== ".zcode" || segs[i + 1].toLowerCase() !== "board") continue;
    const rest = segs.slice(i + 2);
    if (rest.length === 0) return { kind: "board-dir", file: null };
    if (rest[0].toLowerCase() === "evidence") return { kind: "evidence", file: null };
    if (/[*?[\]{}]/.test(rest[0])) return { kind: "glob", file: null };
    const file = rest[rest.length - 1].toLowerCase();
    return BOARD_DATA_FILES.has(file) ? { kind: "data", file } : { kind: "other", file: null };
  }
  return null;
}

/**
 * 违规判定（op：write 写目标 / delete 删除源 / move 移出·改名源）。
 * board-dir 仅 delete/move 拦截（目录本体写不判）；data 与 glob 一律拦截。
 */
function boardViolation(p, op) {
  const info = boardPathKind(p);
  if (info === null || info.kind === "evidence" || info.kind === "other") return null;
  if (info.kind === "board-dir") return op === "write" ? null : { path: String(p), kind: info.kind, file: null };
  return { path: String(p), kind: info.kind, file: info.file };
}

/** Write|Edit 通道：file_path 命中板数据文件即违规。 */
function writeFaceViolation(filePath, cwd) {
  for (const cand of pathCandidates(filePath, cwd)) {
    const v = boardViolation(cand, "write");
    if (v !== null) return v;
  }
  return null;
}

/** Bash 通道：复用 B3-1 宣称解析，逐 claim 判板数据写/删/移（含 cp 目录目标候选与 mv 目标）。 */
function bashViolations(command, cwd) {
  const out = [];
  const seen = new Set();
  const add = (v, verb) => {
    const key = `${v.kind}\u0000${v.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...v, verb });
  };
  const check = (p, op, verb) => {
    for (const cand of pathCandidates(p, cwd)) {
      const v = boardViolation(cand, op);
      if (v !== null) {
        add(v, verb);
        return;
      }
    }
  };
  for (const claim of scanSourceChangeClaims(command)) {
    if (claim.op === "write") {
      check(claim.path, "write", claim.verb);
      if (claim.dirCandidate) {
        // 目录目标候选仅在目标真是目录（或显式以 / 结尾）时成立（与 B3-1 口径一致）
        const destAbs = resolveAgainst(cwd, claim.path);
        const destIsDir = String(claim.path).endsWith("/") || (destAbs !== null && isDirectory(destAbs));
        if (destIsDir) check(claim.dirCandidate, "write", claim.verb);
      }
    } else if (claim.op === "delete") {
      check(claim.path, "delete", claim.verb);
    } else if (claim.op === "move") {
      check(claim.path, "move", claim.verb);
      if (claim.dest) check(claim.dest, "write", claim.verb);
    }
  }
  return out;
}

function boardBlockLines(violations, toolName) {
  const lines = ["[zcode-board 板文件门禁] 已阻断：板数据文件禁写（写者单源；E1 V19 / 裁决⑥）。"];
  for (const v of violations) {
    const extra =
      v.kind === "board-dir"
        ? "——板目录本体的删除/移动（registry 号与条目不可销毁）"
        : v.kind === "glob"
          ? "——通配可命中板数据文件"
          : "";
    lines.push(`- 目标：${v.path}（工具 ${toolName}${v.verb ? ` / ${v.verb}` : ""}）${extra}`);
    const road = v.file !== null ? BOARD_DATA_ROADS.get(v.file) : null;
    lines.push(`  → 唯一写路径：${road ?? "编译/落账/登记脚本（compile-board.mjs / record-run.mjs / register-interview.mjs；registry 走 --assign）"}`);
  }
  lines.push("- 边界：`.zcode/board/evidence/**` 与板内非数据文件（scan.json / night-log.md 等）不在禁写面（证据落盘是正当路径）。");
  return lines;
}

// ---------------------------------------------------------------- 断言 B：evidence 引用存在性

function stripQuotes(s) {
  const t = String(s).trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

/** JSON 节点递归收集 evidence 数组（run_event 等嵌套形态）。 */
function collectEvidenceJson(node, push, depth = 0) {
  if (depth > 6 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) {
      if (typeof item === "string") push(item);
      else collectEvidenceJson(item, push, depth + 1);
    }
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === "evidence") {
      if (Array.isArray(v)) collectEvidenceJson(v, push, depth + 1);
      else if (typeof v === "string") push(v);
    } else if (v !== null && typeof v === "object") {
      collectEvidenceJson(v, push, depth + 1);
    }
  }
}

/** 报告正文 → evidence 引用清单（占位/通配/URL 形态不进入清单）。 */
function extractEvidenceRefs(content) {
  const refs = [];
  const push = (v) => {
    const t = typeof v === "string" ? v.trim() : "";
    if (t !== "" && !PLACEHOLDER_RE.test(t)) refs.push(t);
  };
  const lines = String(content ?? "").split(/\r?\n/);

  // 1) ```json 围栏块：整体解析后递归收集（run_event 形态）
  let inFence = false;
  let fenceLang = "";
  const buf = [];
  for (const line of lines) {
    const open = /^\s*```([A-Za-z0-9_-]*)\s*$/.exec(line);
    if (!inFence && open !== null) {
      inFence = true;
      fenceLang = open[1].toLowerCase();
      buf.length = 0;
      continue;
    }
    if (inFence && /^\s*```\s*$/.test(line)) {
      if (fenceLang === "json") {
        try {
          collectEvidenceJson(JSON.parse(buf.join("\n")), push);
        } catch {
          /* 非 JSON 块不解析（保守） */
        }
      }
      inFence = false;
      continue;
    }
    if (inFence) buf.push(line);
  }

  // 2) line 形态：evidence: [...] / evidence: + YAML 块列表
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s*evidence\s*:\s*(.*?)\s*$/.exec(lines[i]);
    if (m === null) continue;
    const val = m[1];
    if (val === "") {
      for (let j = i + 1; j < lines.length; j += 1) {
        const dm = /^\s*-\s*(.+?)\s*$/.exec(lines[j]);
        if (dm === null) break;
        push(stripQuotes(dm[1]));
      }
      continue;
    }
    const flow = /^\[(.*)\]$/.exec(val);
    if (flow === null) continue;
    for (const item of flow[1].split(",")) push(stripQuotes(item));
  }
  return refs;
}

/** 目标文件所在板根（`<...>/.zcode/board`），非板内文件返回 null。 */
function boardDirOf(targetAbs) {
  const segs = toSegments(targetAbs);
  for (let i = 0; i + 1 < segs.length; i += 1) {
    if (segs[i].toLowerCase() === ".zcode" && segs[i + 1].toLowerCase() === "board") {
      const prefix = segs.slice(0, i + 2).join("/");
      return targetAbs.startsWith("/") ? `/${prefix}` : prefix;
    }
  }
  return null;
}

/** 单条引用的解析候选（绝对原样 / cwd 相对 / cwd 板根相对 / 报告所在板根相对）。 */
function evidenceRefCandidates(ref, cwd, targetAbs) {
  const out = [];
  if (isAbsolute(ref)) {
    out.push(resolve(ref));
  } else {
    if (cwd !== null) {
      out.push(resolve(cwd, ref));
      out.push(resolve(cwd, ".zcode/board", ref));
    }
    const boardDir = targetAbs !== null ? boardDirOf(targetAbs) : null;
    if (boardDir !== null) out.push(resolve(boardDir, ref));
  }
  return [...new Set(out)];
}

/** 逐条 existsSync；返回 { missing: [{ref, cands}], unverifiable }。 */
function evidenceViolations(content, cwd, targetAbs) {
  const missing = [];
  let unverifiable = 0;
  for (const ref of extractEvidenceRefs(content)) {
    const cands = evidenceRefCandidates(ref, cwd, targetAbs);
    if (cands.length === 0) {
      unverifiable += 1;
      continue;
    }
    if (!cands.some((c) => existsSync(c))) missing.push({ ref, cands });
  }
  return { missing, unverifiable };
}

function evidenceBlockLines(target, missing) {
  const lines = [`[zcode-board 报告证据门禁] 已阻断：${target} 引用的 evidence 路径不存在（缺失 ${missing.length} 条）。`];
  for (const m of missing) {
    lines.push(`- 缺失：${m.ref}`);
    lines.push(`  → 已试：${m.cands.join("、")}`);
  }
  lines.push("- 去路：先把证据文件落盘、再写引用它的报告；或修正引用为实际路径（板根相对 `evidence/<T>/…` / 项目根相对 `.zcode/board/evidence/<T>/…` / 绝对路径）。");
  lines.push("- 面：仅 .md 目标进入本校验（Write 全文 / Edit 片段）；占位（…/<>）、通配、URL 引用不校验。");
  return lines;
}

// ---------------------------------------------------------------- 主流程

function main() {
  const payload = parsePayload(readStdin());
  if (payload === null) return 0;
  const toolName =
    typeof payload.tool_name === "string" ? payload.tool_name : typeof payload.toolName === "string" ? payload.toolName : null;
  const input = payload.tool_input ?? payload.toolInput ?? {};
  const cwd = resolveCwd(payload);
  const filePath = typeof input.file_path === "string" && input.file_path !== "" ? input.file_path : null;
  const command = typeof input.command === "string" ? input.command : null;

  if ((toolName === null || toolName === "Write" || toolName === "Edit") && filePath !== null) {
    const v = writeFaceViolation(filePath, cwd);
    if (v !== null) return block(boardBlockLines([v], toolName ?? "Write|Edit"));

    if (/\.(md|markdown)$/i.test(filePath)) {
      const content =
        toolName === "Edit"
          ? typeof input.new_string === "string"
            ? input.new_string
            : null
          : typeof input.content === "string"
            ? input.content
            : null;
      if (content !== null) {
        const targetAbs = resolveAgainst(cwd, filePath);
        const { missing, unverifiable } = evidenceViolations(content, cwd, targetAbs);
        if (unverifiable > 0) log(`evidence 引用 ${unverifiable} 条无解析基准（无 cwd）：跳过校验。`);
        if (missing.length > 0) return block(evidenceBlockLines(filePath, missing));
      }
    }
    return 0;
  }

  if ((toolName === null || toolName === "Bash") && command !== null && command.trim() !== "") {
    const violations = bashViolations(command, cwd);
    if (violations.length > 0) return block(boardBlockLines(violations, "Bash"));
    return 0;
  }

  return 0;
}

try {
  process.exit(main());
} catch (e) {
  // 守卫自身异常：fail-open（不误拦）；两类违规判定仍是 fail-closed。
  process.stderr.write(`guard-board: 守卫异常（${e?.message ?? e}）：放行（请核查 hook）。\n`);
  process.exit(0);
}
