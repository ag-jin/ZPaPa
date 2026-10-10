#!/usr/bin/env node
/**
 * zcode-board / verify-cleanup —— 收尾机械核对：合并后 worktree/branch 差集（#116 / B5-4）
 *   + HEAD merge 提交信息格式事后核对（#118 / B5-6；E4-17 审计面）
 *
 * 存在原因（E4-18 ②；E1 V33「收口断尾」；SKILL.md §3.4 / assets/worktree-discipline.md §5/§8）：
 *   合并后清理（remove → prune → branch -d）原先只有 integrator 自述，无机械核对面——
 *   task-32…task-36、task-54/55/58/59 等分支已合并仍留（工作树已删、分支未 -d）。
 *   本脚本把「清理齐备」变成可复跑的机械判定：对刚合并的卡号集合逐卡核对三方现场，
 *   残留即逐条点名并给出正规处置；清理齐备输出绿态（exit 0）。
 *
 * HEAD merge 格式事后核对（#118 / B5-6；E4-17）：
 *   冻结格式（SKILL §6 第 6 条）：merge commit 精确写 `Merge task-<no> [#<no>]`。
 *   gate-merge 只拦带 -m 的事前形态；交互/默认信息（无 -m）合并只能在事后核对——本脚本查 HEAD：
 *     - HEAD 非 merge commit → 不适用（stderr 说明，零噪声）；
 *     - HEAD 为 merge 且 subject 精确匹配冻结格式（两号一致）→ 合规（stdout 结论行）；
 *     - HEAD 为 merge 且 subject 呈卡合并迹象（含 task-<no> / [#<no>]，如 git 默认
 *       "Merge branch 'task-118'"）但非冻结格式 → 格式残留点名（应写实例 + amend 处置）→ exit 1；
 *     - HEAD 为 merge 且无卡合并迹象（上游同步/feature 合并等非卡合并）→ 冻结格式面不适用
 *       （stderr 说明，零噪声；只约束卡合并，不误报）。
 *   边界：只核对 HEAD 一个 merge commit（刚合并形态）；卡号集合外的旧 merge 不回扫（防误报）。
 *
 * 差集三方（判定源）：
 *   ① `git worktree list --porcelain`：在册现场（prunable 标记 = 登记残留）；
 *   ② 卡 worktree 声明（runs.json 的 run 事件 worktree 字段）：声明仍在而目录仍在、登记不在 → 目录残留；
 *   ③ 分支存在性（refs/heads/task-<no>）——已合并应已 -d。
 *   （登记/声明/分支三者互补：现场在册 vs 声明在 vs 分支在；任一残留即点名。）
 *
 * 输出（stdout，机读 + 人读同一形态）：
 *   残留：`清理核对：卡 #<号…> → 残留 N 项（分支 a / 现场 b / 登记 c / 目录 d[ / 格式 e]）` + 逐条
 *        `- <类>残留：<名>（<处置>）` + `结果=有残留`（格式类只在有格式残留时进计数，防零噪声）
 *   齐备：`清理核对：卡 #<号…> → 清理齐备（无残留现场/分支/目录）`
 *        [+ `HEAD merge 格式：卡 #<no> \`Merge task-<no> [#<no>]\`（合规；E4-17）`]
 *        + `结果=清理齐备`
 *   诊断（逐卡状态 + HEAD merge 格式核对结论）只走 stderr，前缀 `verify-cleanup: `。
 *
 * 用法：
 *   node assets/tools/verify-cleanup.mjs --cards <卡号[,卡号…]> [--root <项目根>]
 *
 * 退出码：0 = 清理齐备（含 HEAD merge 格式合规或不适用）；1 = 有残留（差集或格式点名清单）；
 *         2 = 用法/输入错误；3 = 前置环境拒绝（root 非 git 仓库）。
 *
 * 边界：只核对 --cards 声明的卡号集合（刚合并集）；集合外的在途卡现场不误报；
 * 声明面读 runs.json，缺失 ≡ 空声明（登记/分支照常核对，不静默当通过）。
 * 无第三方依赖（仅 node 内置）。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const PROG = "verify-cleanup";

const USAGE = `用法：
  node assets/tools/verify-cleanup.mjs --cards <卡号[,卡号…]> [--root <项目根>]

  --cards   刚合并的卡号集合（逗号分隔或重复给值；核对"已合并应清理"的现场/分支残留）
  --root    项目根（缺省 = 当前目录）；须位于 git 仓库内（取仓库顶层为核对根）
核对面：①合并后差集（分支/现场/登记/目录残留）；②HEAD merge 格式事后核对（E4-17——
  merge commit 精确写 \`Merge task-<no> [#<no>]\`；呈卡合并迹象而不符即格式残留点名）。
退出码：0 = 清理齐备（含 HEAD merge 格式合规或不适用）；1 = 有残留（差集或格式点名清单）；
        2 = 用法/输入错误；3 = 前置环境拒绝（root 非 git 仓库）。`;

function die(msg, code = 2) {
  process.stderr.write(`${PROG}: ${msg}\n`);
  process.exit(code);
}

function refuse(msg) {
  die(msg, 3);
}

function git(root, args) {
  return spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function parseArgs(argv) {
  const opt = { cards: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (a !== "--cards" && a !== "--root") die(`未知选项 ${a}\n${USAGE}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) die(`选项 ${a} 缺少取值\n${USAGE}`);
    if (a === "--cards") opt.cards.push(...String(v).split(",").map((s) => s.trim()).filter((s) => s !== ""));
    else opt.root = v;
    i += 1;
  }
  return opt;
}

/** 现场登记条目（worktree list --porcelain → [{path, branch, prunable}]）。 */
function worktreeEntries(root) {
  const res = git(root, ["worktree", "list", "--porcelain"]);
  if (res.status !== 0) refuse(`git worktree list 失败：${String(res.stderr ?? "").trim()}`);
  const entries = [];
  let cur = null;
  for (const line of String(res.stdout ?? "").split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice("worktree ".length), branch: null, prunable: null };
      entries.push(cur);
      continue;
    }
    if (cur === null) continue;
    if (line.startsWith("branch ")) cur.branch = line.slice("branch ".length);
    else if (line.startsWith("prunable")) cur.prunable = line.slice("prunable".length).trim() || "prunable";
  }
  return entries;
}

/** 卡 worktree 声明（runs.json 的 run 事件 worktree 字段）；缺失/损坏 → 空集 + stderr 说明。 */
function declaredWorktrees(top, cards) {
  const path = join(top, ".zcode", "board", "runs.json");
  if (!existsSync(path)) return new Map(); // 缺失 ≡ 空声明（登记/分支照常核对）
  let doc = null;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    process.stderr.write(`${PROG}: 提示：${path} 不可读（${e.message}）：声明差集跳过（登记/分支照常核对）。\n`);
    return new Map();
  }
  const out = new Map();
  const runs = Array.isArray(doc?.runs) ? doc.runs : [];
  for (const run of runs) {
    if (run === null || typeof run !== "object" || !Array.isArray(run.cards)) continue;
    const w = typeof run.worktree === "string" ? run.worktree.trim() : "";
    if (w === "") continue;
    for (const no of run.cards) {
      if (!cards.has(no)) continue;
      if (!out.has(no)) out.set(no, []);
      out.get(no).push(w);
    }
  }
  return out;
}

function relTo(top, abs) {
  const rel = relative(top, abs);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? rel : abs;
}

// ---------------------------------------------------------------- HEAD merge 格式事后核对（#118/B5-6；E4-17）

/** 冻结格式（SKILL §6 第 6 条）：merge commit 精确写 `Merge task-<no> [#<no>]`（两号一致）。 */
const HEAD_MERGE_RE = /^Merge task-([1-9][0-9]*) \[#([1-9][0-9]*)\]$/;
/** 卡合并迹象（非冻结格式的默认信息形态，如 "Merge branch 'task-118'" / "[#118]"）。 */
const CARD_HINT_RE = /\btask-([1-9][0-9]*)\b|\[#([1-9][0-9]*)\]/;

/**
 * HEAD 提交快照：{checked:false, reason}（git 不可用）| {checked:true, merge:false, subject}
 * | {checked:true, merge:true, ok, card, subject}。
 * ok=false 且 card===null = 非卡合并形态（上游同步/feature 合并）——冻结格式面不适用。
 */
function headMergeFormat(top) {
  const res = git(top, ["log", "-1", "--format=%s%x00%P"]);
  if (res.status !== 0) {
    return { checked: false, reason: String(res.stderr ?? "").trim() || `git log 退出码 ${String(res.status)}` };
  }
  const raw = String(res.stdout ?? "").replace(/\n+$/, "");
  const nul = raw.indexOf("\0");
  const subject = (nul >= 0 ? raw.slice(0, nul) : raw).trim();
  const parents = (nul >= 0 ? raw.slice(nul + 1) : "").trim().split(/\s+/).filter((s) => s !== "");
  if (parents.length < 2) return { checked: true, merge: false, subject };
  const m = HEAD_MERGE_RE.exec(subject);
  if (m !== null && m[1] === m[2]) return { checked: true, merge: true, ok: true, card: Number(m[1]), subject };
  const hint = CARD_HINT_RE.exec(subject);
  const card = hint !== null ? Number(hint[1] ?? hint[2]) : null;
  return { checked: true, merge: true, ok: false, card, subject };
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.cards.length === 0) die(`缺少必填选项 --cards（刚合并的卡号集合）\n${USAGE}`);
  const bad = opt.cards.filter((c) => !/^[1-9][0-9]*$/.test(c));
  if (bad.length > 0) die(`--cards 须为裸正整数稳定号（逗号分隔）：${bad.join("、")}\n${USAGE}`);
  const cards = [...new Set(opt.cards.map((c) => Number(c)))].sort((a, b) => a - b);

  const rootArg = opt.root ?? process.cwd();
  if (!existsSync(rootArg) || !statSync(rootArg).isDirectory()) die(`项目根不存在或不是目录：${rootArg}`);
  const root = realpathSync(rootArg);
  const topRes = git(root, ["rev-parse", "--show-toplevel"]);
  if (topRes.status !== 0) {
    refuse(`项目根不在 git 仓库内：${root}（${String(topRes.stderr ?? "").trim()}）——收尾核对需要现场登记（git worktree list）。`);
  }
  const topRaw = String(topRes.stdout ?? "").trim();
  const top = existsSync(topRaw) ? realpathSync(topRaw) : topRaw;

  const entries = worktreeEntries(top);
  const declared = declaredWorktrees(top, new Set(cards));

  // HEAD merge 格式事后核对（#118/B5-6；E4-17）——诊断先行；不符并入残留清单（见下）
  const head = headMergeFormat(top);
  if (!head.checked) {
    process.stderr.write(`${PROG}: 提示：HEAD merge 格式核对跳过（${head.reason}）。\n`);
  } else if (!head.merge) {
    process.stderr.write(`${PROG}: HEAD 非 merge commit（${head.subject}）：HEAD merge 格式核对不适用。\n`);
  } else if (head.ok) {
    process.stderr.write(`${PROG}: HEAD merge 格式：合规（卡 #${head.card}，${head.subject}）。\n`);
  } else if (head.card === null) {
    process.stderr.write(`${PROG}: HEAD merge 非卡合并形态（${head.subject}）：冻结格式核对不适用（上游同步/feature 合并不在面）。\n`);
  } else {
    process.stderr.write(
      `${PROG}: HEAD merge 格式：不符（卡 #${head.card}，${head.subject}）——应精确写 \`Merge task-${head.card} [#${head.card}]\`。\n`,
    );
  }

  const residues = [];
  for (const no of cards) {
    const branch = `task-${no}`;
    const siteSuffix = `/.zcode/worktrees/${branch}`;
    // ① 分支存在性（已合并应已 -d）
    if (git(top, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0) {
      residues.push({
        kind: "分支",
        card: no,
        name: branch,
        action: `处置：git branch -d ${branch}，-d 而非 -D；未合并会被拒绝 → 退回核对`,
      });
    }
    // ② 在册现场 / 登记残留
    const covered = new Set();
    for (const e of entries) {
      const byBranch = e.branch === `refs/heads/${branch}`;
      const byPath = typeof e.path === "string" && e.path.endsWith(siteSuffix);
      if (!byBranch && !byPath) continue;
      covered.add(resolve(e.path));
      const rel = relTo(top, e.path);
      if (e.prunable !== null) {
        residues.push({ kind: "登记", card: no, name: rel, action: "prunable；处置：git worktree prune" });
      } else {
        residues.push({ kind: "现场", card: no, name: rel, action: `处置：git worktree remove ${rel} && git worktree prune` });
      }
    }
    // ③ 声明差集：声明在、目录在、登记不在 → 目录残留（悬空/手工现场形态）
    for (const w of declared.get(no) ?? []) {
      const abs = resolve(top, w);
      if (!existsSync(abs)) continue;
      if (covered.has(abs)) continue;
      covered.add(abs);
      residues.push({
        kind: "目录",
        card: no,
        name: isAbsolute(w) ? relTo(top, w) : w.replace(/^\.\//, ""),
        action: "登记不在；处置：核对后按 worktree-discipline §6 正规清理",
      });
    }
    const own = residues.filter((r) => r.card === no).length;
    process.stderr.write(`${PROG}: 卡 #${no}：${own === 0 ? "无残留" : `残留 ${own} 项`}\n`);
  }

  // 格式残留（HEAD merge 呈卡合并迹象而不符冻结格式）——非卡号项，不进逐卡计数
  if (head.checked && head.merge && !head.ok && head.card !== null) {
    residues.push({
      kind: "格式",
      card: null,
      name: `HEAD merge commit \`${head.subject}\``,
      action:
        `应精确写 \`Merge task-${head.card} [#${head.card}]\`（E4-17 冻结格式）；处置：` +
        `git commit --amend -m "Merge task-${head.card} [#${head.card}]" 修正信息，或 reset 后按格式重做合并`,
    });
  }

  const kinds = ["分支", "现场", "登记", "目录", ...(residues.some((r) => r.kind === "格式") ? ["格式"] : [])];
  const countOf = (k) => residues.filter((r) => r.kind === k).length;
  const cardList = cards.map((n) => `#${n}`).join(" ");
  const lines = [];
  if (residues.length === 0) {
    lines.push(`清理核对：卡 ${cardList} → 清理齐备（无残留现场/分支/目录）`);
    if (head.checked && head.merge && head.ok) {
      lines.push(`HEAD merge 格式：卡 #${head.card} \`${head.subject}\`（合规；E4-17）`);
    }
    lines.push("结果=清理齐备");
  } else {
    lines.push(`清理核对：卡 ${cardList} → 残留 ${residues.length} 项（${kinds.map((k) => `${k} ${countOf(k)}`).join(" / ")}）`);
    for (const r of residues) lines.push(`- ${r.kind}残留：${r.name}（${r.action}）`);
    lines.push("结果=有残留");
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return residues.length === 0 ? 0 : 1;
}

process.exit(main());
