#!/usr/bin/env node
/**
 * zcode-board / gate-merge（T13 交付物；B2-2/#100 加查第四绿；B5-4/#116 加拦 branch -D；B5-6/#118 加 merge 提交信息格式校验）——PreToolUse(Bash) 合并门禁（唯一有意阻断者）
 *
 * 职责（设计 §7.4 / §10.4 第 5 项；场景 27；B2-2/#100；B5-4/#116；B5-6/#118）：
 *   只拦目标为 base 分支的合并/push，且判据证据不在位的情形：
 *     第 1 绿 code-reviewer verdict = approved（run: role=code-reviewer, result=done, cards 含该卡）
 *     第 2 绿 test-verifier verdict = pass（run: role=test-verifier, result=done, cards 含该卡）
 *     第 3 绿（base 存在 + 该卡分支 rebase 无冲突）由 integrator 执行时机械验证，不在本 hook 判定面。
 *     第 4 绿（B2-2/#100）：卡分支 diff 触及 UI 面（路径前缀 `packages/ui/`，判据从简、理由见下）时，
 *       另查 ui-designer verdict = approved（run: role=ui-designer, result=done, cards 含该卡，且其
 *       evidence 至少一条文件在位）——无证据不得进待合并。依据：dispatch-checklist「UI 卡第四绿」
 *       （2026-10-10 用户批准）+ AD-10②（itw-20261010-5372）；与 B6-3「需齐绿清单」同口径
 *       （UI 卡 = 第四绿 + 浏览器断言；浏览器断言归 test-verifier 检查单，不在本 hook 判定面）。
 *   另拦 `git branch -D` 强制删除卡分支 `task-<no>`（B5-4/#116；E4-18）：
 *     `-D`（含 `--delete --force` / 组合短旗标）绕过「-d 未合并会被拒绝」的安全网，机械逼回 -d；
 *     非卡分支的 -D 不在卡分支纪律面（放行，去路文案走 stderr）。合并后 worktree/branch 差集核对
 *     归 `assets/tools/verify-cleanup.mjs`（V33；本 hook 只拦 -D，不做现场核对）。
 *   另拦 目标为 base 的卡片合并 `-m`/`--message` 不符冻结格式 `Merge task-<no> [#<no>]`（B5-6/#118；E4-17；
 *     SKILL §6 第 6 条）：merge commit 信息是卡号的机械回链锚点，必须与合并卡号一致且形态精确。
 *     校验顺序：命令形态（格式）→ 绿证据。无 -m/--message（交互、默认信息、-F 读文件）事前无法核对：
 *     放行 + stderr 指向 `verify-cleanup.mjs` 对 HEAD merge commit 的事后核对（E4-17 审计面）。
 *   "feature 分支间合并不拦"：在卡片工作树（.git 为 gitdir 指针）内执行的合并一律放行。
 *
 * 阻断形态：PreToolUse 退出码 2 被运行时译为 permissionDecision: deny（阻断原因取 stderr），
 * 拦截文案给出缺失绿与补齐路径；其余命令/无法判定时放行（exit 0，去路文案走 stderr）。
 * 三绿证据读取只读 `<root>/.git/HEAD` 与 `<root>/.zcode/board/runs.json`；第四绿的 UI 面判定需要
 * 一次有界 `git diff --name-only`（PR 路径另有 `git rev-parse --verify` 解析头分支）——这是本 hook
 * 仅有的子进程（超时 5s）；子进程失败 → 记录边界（stderr）并按"无法判定"放行（同一合并命令自身也会
 * 因同因失败）；证据缺失仍是 fail-closed。
 *
 * 无第三方依赖（仅 node 内置）。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { readJsonFile } from "../lib/board-io.mjs";

const RUNS_REL = ".zcode/board/runs.json";

function log(msg) {
  process.stderr.write(`gate-merge: ${msg}\n`);
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

// ---------------------------------------------------------------- git 现场（纯文件读）

function readHeadBranch(gitDir) {
  try {
    const text = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(text);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * 判定命令执行现场：主检出（.git 目录）还是卡片工作树（.git 文件 = gitdir 指针）。
 * base 分支 = 主检出 HEAD 所指分支（工作树经 commondir 回溯主检出 HEAD）。
 */
function gitContext(root) {
  const dotgit = join(root, ".git");
  let st;
  try {
    st = statSync(dotgit);
  } catch {
    return { repo: false, inWorktree: false, branch: null, base: null };
  }
  if (st.isFile()) {
    const text = readFileSync(dotgit, "utf8");
    const m = /gitdir:\s*(.+)/.exec(text);
    const gitdir = m ? resolve(root, m[1].trim()) : null;
    let base = null;
    if (gitdir !== null) {
      try {
        const common = readFileSync(join(gitdir, "commondir"), "utf8").trim();
        base = readHeadBranch(resolve(gitdir, common));
      } catch {
        base = null;
      }
    }
    return { repo: true, inWorktree: true, branch: gitdir !== null ? readHeadBranch(gitdir) : null, base };
  }
  if (st.isDirectory()) {
    const branch = readHeadBranch(dotgit);
    return { repo: true, inWorktree: false, branch, base: branch };
  }
  return { repo: false, inWorktree: false, branch: null, base: null };
}

// ---------------------------------------------------------------- 命令解析（保守词法）

/** 空白分词（尊重单/双引号；不做 shell 展开）。 */
function tokenize(cmd) {
  const out = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur !== "") out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur !== "") out.push(cur);
  return out;
}

const GIT_VALUE_OPTS = new Set(["-C", "--git-dir", "--work-tree", "-c", "--namespace", "--exec-path", "--config-env"]);
const MERGE_VALUE_OPTS = new Set(["-m", "--message", "-F", "--file", "-s", "--strategy", "-X", "--strategy-option", "-S", "--gpg-sign", "--into-name", "--author", "--cleanup"]);
const MERGE_CONTROL = new Set(["--abort", "--continue", "--quit"]);
const PUSH_VALUE_OPTS = new Set(["-o", "--push-option", "--receive-pack", "--exec", "--repo", "--recurse-submodules"]);

/** 归一 refspec → 目标分支名；无 refspec 返回 null。 */
function pushDestination(refspec) {
  if (typeof refspec !== "string" || refspec === "") return null;
  if (refspec.startsWith("+")) refspec = refspec.slice(1);
  const dst = refspec.includes(":") ? refspec.slice(refspec.indexOf(":") + 1) : refspec;
  if (dst === "") return { deleteBranch: true, branch: refspec.slice(0, refspec.indexOf(":")) };
  return { deleteBranch: false, branch: dst.replace(/^refs\/heads\//, "") };
}

function cardFromText(text) {
  if (typeof text !== "string") return null;
  let m = /\btask-([1-9][0-9]*)\b/.exec(text);
  if (m) return Number(m[1]);
  m = /\[#([1-9][0-9]*)\]/.exec(text);
  if (m) return Number(m[1]);
  return null;
}

/**
 * 命令分类：
 *   {kind:"merge", ref, cardNo} | {kind:"push", dst, toBase, allRefs} |
 *   {kind:"pr-merge", cardNo} | {kind:"branch-delete", delete, force, targets} | {kind:"none"}
 */
function classify(tokens) {
  const gh = tokens.findIndex((t) => t === "gh" || t.endsWith("/gh"));
  if (gh >= 0) {
    const rest = tokens.slice(gh + 1);
    if (rest[0] === "pr" && rest.includes("merge")) {
      let cardNo = null;
      let head = null;
      for (let i = 0; i < rest.length; i += 1) {
        if (rest[i] === "--head" && typeof rest[i + 1] === "string") head = rest[i + 1];
        const c = cardFromText(rest[i]);
        if (c !== null && cardNo === null) cardNo = c;
      }
      if (cardNo === null && head !== null) cardNo = cardFromText(head);
      return { kind: "pr-merge", cardNo };
    }
    return { kind: "none" };
  }

  const gitIdx = tokens.findIndex((t) => t === "git" || t.endsWith("/git"));
  if (gitIdx < 0) return { kind: "none" };
  let i = gitIdx + 1;
  while (i < tokens.length && tokens[i].startsWith("-")) {
    if (GIT_VALUE_OPTS.has(tokens[i])) i += 1;
    i += 1;
  }
  const sub = tokens[i] ?? "";
  const rest = tokens.slice(i + 1);

  if (sub === "merge") {
    let sawControl = false;
    let message = null;
    const positionals = [];
    for (let k = 0; k < rest.length; k += 1) {
      const t = rest[k];
      if (MERGE_CONTROL.has(t)) {
        sawControl = true;
        continue;
      }
      if (t.startsWith("-")) {
        if (MERGE_VALUE_OPTS.has(t)) {
          // B5-6/#118：-m 可多次（git 按空行拼接，subject 取第一条）——冻结格式校验对象为第一条 -m。
          if ((t === "-m" || t === "--message") && message === null) message = rest[k + 1] ?? null;
          k += 1;
        }
        continue;
      }
      positionals.push(t);
    }
    if (sawControl) return { kind: "merge-control" };
    const ref = positionals.length > 0 ? positionals[positionals.length - 1] : null;
    let cardNo = cardFromText(ref);
    if (cardNo === null) cardNo = cardFromText(message);
    return { kind: "merge", ref, cardNo, message };
  }

  if (sub === "push") {
    const positionals = [];
    let allRefs = false;
    for (let k = 0; k < rest.length; k += 1) {
      const t = rest[k];
      if (t === "--all" || t === "--mirror") {
        allRefs = true;
        continue;
      }
      if (t.startsWith("-")) {
        if (PUSH_VALUE_OPTS.has(t)) k += 1;
        continue;
      }
      positionals.push(t);
    }
    const refspec = positionals.length >= 2 ? positionals[1] : null;
    const dst = refspec !== null ? pushDestination(refspec) : null;
    return { kind: "push", dst, allRefs };
  }

  if (sub === "branch") return classifyBranch(rest);

  return { kind: "none" };
}

/** 卡分支形态（B5-4/#116）：`task-<正整数>`；接受 `refs/heads/` 全形态（git branch 两形态均收）。 */
const CARD_BRANCH_RE = /^(refs\/heads\/)?task-[1-9][0-9]*$/;

/**
 * branch 子命令分类（B5-4/#116；E4-18）：只提取"删除 + 强制"形态。
 *   - 删除旗标：短旗标串含 `d`/`D`，或 `--delete`；
 *   - 强制旗标：短旗标串含 `D`/`f`，或 `--force`；
 *   - targets = 位置参数（分支名）；`--` 后仍按位置参数收（与 git 词法一致）。
 * 判据从简：仅删除+强制（`-D`/`--delete --force`/`-df`/`-d -f`）触发拦截面；分支管理其余动作（-m/-c/-l 等）不在此面。
 */
function classifyBranch(rest) {
  let del = false;
  let force = false;
  const targets = [];
  for (const t of rest) {
    if (t === "--") continue;
    if (t === "--delete") {
      del = true;
      continue;
    }
    if (t === "--force") {
      force = true;
      continue;
    }
    if (t.startsWith("--")) continue;
    if (t.startsWith("-") && t.length > 1) {
      const chars = t.slice(1);
      if (chars.includes("d") || chars.includes("D")) del = true;
      if (chars.includes("D") || chars.includes("f")) force = true;
      continue;
    }
    targets.push(t);
  }
  return { kind: "branch-delete", delete: del, force: del && force, targets };
}

// ---------------------------------------------------------------- merge 提交信息格式（B5-6/#118；E4-17）

/**
 * 冻结格式（B5-6/#118；E4-17；SKILL §6 第 6 条）：merge commit 精确写 `Merge task-<no> [#<no>]`。
 * 判据：-m 信息的第一行（subject）trim 后须逐字等于 `Merge task-<cardNo> [#<cardNo>]`——
 * 卡号须与本次合并卡号一致（信息是卡号的机械回链锚点，错号会指错卡）。
 * 边界：仅核 `-m`/`--message` 第一条（git 多 -m 按空行拼接，subject 取第一条）；
 * 无 -m（交互/默认信息/-F 读文件）不做事前判定（放行 + 事后核对提示）。
 */
function mergeMessageSubject(message) {
  return String(message).split("\n")[0].trim();
}

function mergeFormatLines(cardNo, message) {
  const subject = mergeMessageSubject(message);
  const expected = `Merge task-${cardNo} [#${cardNo}]`;
  return [
    `[zcode-board 合并门禁] 已阻断：merge 提交信息不符冻结格式（卡 #${cardNo}）。`,
    `- 判别：命令 -m 信息为 ${JSON.stringify(subject)}；冻结格式精确写 \`Merge task-<no> [#<no>]\`（本卡应为 \`${expected}\`，SKILL §6 第 6 条；卡号须与合并卡号一致）。`,
    `- 去路：重写合并命令 \`git merge --no-ff task-${cardNo} -m "${expected}"\`（merge commit 信息是卡号的机械回链锚点，须与本次合并卡号一致且形态精确）。`,
    "- 依据：E4-17（merge commit 格式校验）；无 -m 的交互/默认信息形态由收尾核对 verify-cleanup 对 HEAD merge commit 事后核对。",
  ];
}

// ---------------------------------------------------------------- 第四绿（UI 面 diff，B2-2/#100）

/**
 * UI 面判据（判据从简，成文于此）：卡分支 diff 触及文件路径前缀 `packages/ui/` 即 UI 面。
 * 理由：`packages/ui` 是共享 React 组件、hooks 与 store 的用户可见界面代码（AGENTS.md 模块表）；
 * 前缀判据宁多勿漏——多判只多查一道第四绿（有证据即放行），漏判会让 UI 改动绕过 ui-designer 复核。
 * 非该前缀（apps/、packages/desktop 主进程壳、packages/services 等）不判 UI 面。
 * 与 B6-3「需齐绿清单」同口径：UI 卡 = 第四绿 + 浏览器断言；本 hook 只机检第四绿。
 */
const UI_FACE_PREFIX = "packages/ui/";
/** UI 面判据（B2 评审 SPEC-1 硬化）：段级锚定——嵌套根（如从工作区根对 ZPaPa/packages/ui/... 做 diff）同样命中；desktop renderer/web 扩面待用户裁定。 */
const UI_FACE_RE = /(^|\/)packages\/ui\//;

/** 一次有界 git 子进程：base...ref 的变更文件清单（--no-renames：改名按增/删两路径全列，宁多勿漏）。 */
function changedFiles(root, base, ref) {
  const r = spawnSync("git", ["diff", "--name-only", "--no-renames", `${base}...${ref}`, "--"], {
    cwd: root,
    encoding: "utf8",
    timeout: 2_000, // B2 评审 STD-1：单次 2s × 最坏 3 次 = 6s < 声明 timeoutMs 10000（防 harness 超时静默跳过门禁）
  });
  if (r.error !== undefined && r.error !== null) return { ok: false, error: r.error.message };
  if (r.status !== 0) {
    const first = String(r.stderr ?? "").trim().split("\n")[0] ?? "";
    return { ok: false, error: first !== "" ? first : `git diff 退出码 ${String(r.status)}` };
  }
  return { ok: true, files: String(r.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== "") };
}

/** PR 头分支解析：本地 task-<no> 优先，其次 origin/task-<no>（不可得返回 null → 边界，不阻断）。 */
function prHeadRef(root, cardNo) {
  for (const cand of [`task-${cardNo}`, `origin/task-${cardNo}`]) {
    const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${cand}^{commit}`], {
      cwd: root,
      encoding: "utf8",
      timeout: 2_000, // STD-1：预算收窄（最坏 3×2s=6s < timeoutMs 10000）
    });
    if ((r.error === undefined || r.error === null) && r.status === 0 && String(r.stdout ?? "").trim() !== "") return cand;
  }
  return null;
}

/** evidence 引用解析候选（与 guard-board 断言 B 同形子集：绝对 / 项目根相对 / 板根相对）。 */
function evidenceRefCandidates(root, ref) {
  if (isAbsolute(ref)) return [resolve(ref)];
  return [...new Set([resolve(root, ref), resolve(root, ".zcode/board", ref)])];
}

/** 第四绿状态：记录在位（role=ui-designer, result=done）且 evidence 至少一条文件在位。 */
function uiDesignerStatus(root, forCard) {
  const runs = forCard.filter((r) => r && r.role === "ui-designer" && r.result === "done");
  if (runs.length === 0) return { present: false, refs: [], missing: [] };
  const refs = [];
  for (const run of runs) {
    if (!Array.isArray(run.evidence)) continue;
    for (const s of run.evidence) if (typeof s === "string" && s.trim() !== "") refs.push(s);
  }
  const missing = refs.filter((ref) => !evidenceRefCandidates(root, ref).some((c) => existsSync(c)));
  return { present: true, refs, missing };
}

/**
 * UI 面门禁判定：
 *   {checked:false, reason}          —— diff 不可得（分支/基线不可解析或 git 失败），调用方记边界、不阻断；
 *   {checked:true, uiFace:false}     —— diff 未触及 UI 面，免第四绿；
 *   {checked:true, uiFace:true, ok}  —— UI 面 diff；ok = 第四绿记录与证据文件均在位。
 */
function uiFaceGate(root, base, ref, status) {
  if (typeof ref !== "string" || ref === "") return { checked: false, reason: "合并来源不可解析为分支名" };
  const diff = changedFiles(root, base !== null && base !== "" ? base : "HEAD", ref);
  if (!diff.ok) return { checked: false, reason: diff.error };
  const files = diff.files.filter((f) => UI_FACE_RE.test(f));
  if (files.length === 0) return { checked: true, uiFace: false, files: [] };
  return { checked: true, uiFace: true, files, ok: status.present && status.refs.length > 0 && status.missing.length < status.refs.length, status };
}

function uiGreenLines(cardNo, ui, { header = true } = {}) {
  const lines = header ? [`[zcode-board 合并门禁] 已阻断：UI 面合并缺第四绿（卡 #${cardNo}）。`] : [];
  const preview = ui.files.length > 3 ? `${ui.files.slice(0, 3).join("、")} 等 ${ui.files.length} 个文件` : ui.files.join("、");
  lines.push(`- 判别：卡分支 diff 触及 UI 面（前缀 ${UI_FACE_PREFIX}）：${preview}。`);
  if (!ui.status.present) {
    lines.push(`- 缺第 4 绿 ui-designer verdict = approved：runs.json 无 role=ui-designer result=done cards 含 #${cardNo} 的记录。`);
    lines.push(
      `  → 补齐路径：派发 ui-designer 复核卡 #${cardNo} 的最终 diff（视觉/信息层级）；报告带 run_event ` +
        `{"role":"ui-designer","result":"done","cards":[${cardNo}],"evidence":["evidence/T${cardNo}/ui-review.md"]}，` +
        "由 record-run.mjs 落账（#99 词表已支持），先落证再引用，随后重试同一合并命令。",
    );
  } else if (ui.status.refs.length === 0) {
    lines.push("- 缺证据文件：ui-designer 记录在位，但该记录 evidence 为空——无复核证据文件。");
    lines.push(`  → 补齐路径：先把 ui-designer 复核证据落盘（板根相对 evidence/T${cardNo}/… 或项目根相对 .zcode/board/evidence/T${cardNo}/…），在记录中引用后重试。`);
  } else {
    lines.push(`- 缺证据文件：ui-designer 记录在位，但引用的证据文件均不在位——未在位：${ui.status.missing.join("、")}。`);
    lines.push(`  → 补齐路径：先把 ui-designer 复核证据落盘（板根相对 evidence/T${cardNo}/… 或项目根相对 .zcode/board/evidence/T${cardNo}/…），或修正 runs.json 引用后重试。`);
  }
  lines.push(
    "- 依据：dispatch-checklist「UI 卡第四绿（code-reviewer 之后、用户实测之前强制 ui-designer 复核；无证据文件不得进待合并）」" +
      "（2026-10-10 用户批准）+ AD-10②（itw-20261010-5372）；与 B6-3「需齐绿清单」同口径（UI 卡 = 第四绿 + 浏览器断言）。",
  );
  return lines;
}

/** 通过放行时的第四绿注记（stderr 去路文案；diff 不可得的边界已在上一行 log 单列，不重复）。 */
function uiPassNote(ui) {
  if (!ui.checked) return "";
  return ui.uiFace ? `；UI 面 diff（${ui.files.length} 个文件）：第四绿 ui-designer 证据在位。` : "；diff 未触及 UI 面（packages/ui/）：免第四绿。";
}

// ---------------------------------------------------------------- 门禁证据

/** 前两绿判据（runs.json 的 verdict 事件；第 3 绿归 integrator 执行时机械验证）+ 第四绿状态。 */
function verdictEvidence(root, cardNo) {
  const loaded = readJsonFile(join(root, RUNS_REL));
  if (!loaded.ok) {
    return {
      readable: false,
      error: loaded.missing ? "runs.json 不存在" : `runs.json 无法读取（${loaded.error}）`,
      approved: false,
      pass: false,
      uiDesigner: { present: false, refs: [], missing: [] },
    };
  }
  const runs = Array.isArray(loaded.value?.runs) ? loaded.value.runs : [];
  const forCard = runs.filter((r) => r && Array.isArray(r.cards) && r.cards.includes(cardNo));
  return {
    readable: true,
    error: null,
    approved: forCard.some((r) => r.role === "code-reviewer" && r.result === "done"),
    pass: forCard.some((r) => r.role === "test-verifier" && r.result === "done"),
    uiDesigner: uiDesignerStatus(root, forCard),
  };
}

function gateLines(cardNo, ev, base) {
  const lines = [];
  lines.push(`[zcode-board 合并门禁] 已阻断：目标为 base 分支（${base ?? "主检出分支"}）的合并缺三绿证据（卡 #${cardNo}）。`);
  lines.push(
    ev.approved
      ? "- 第 1 绿 code-reviewer verdict = approved：已在位（runs.json）。"
      : `- 缺第 1 绿 code-reviewer verdict = approved：runs.json 无 role=code-reviewer result=done cards 含 #${cardNo} 的记录。`,
  );
  if (!ev.approved) {
    lines.push(
      `  → 补齐路径：派发 code-reviewer 评审卡 #${cardNo} 的最终 diff；其报告带 run_event {"role":"code-reviewer","result":"done","cards":[${cardNo}]}，` +
        "由 record-run.mjs 落账（前台 PostToolUse 自动 / 后台编排者以报告为 stdin 代触发），随后重试同一合并命令。",
    );
  }
  lines.push(
    ev.pass
      ? "- 第 2 绿 test-verifier verdict = pass：已在位（runs.json）。"
      : `- 缺第 2 绿 test-verifier verdict = pass：runs.json 无 role=test-verifier result=done cards 含 #${cardNo} 的记录。`,
  );
  if (!ev.pass) {
    lines.push(
      `  → 补齐路径：派发 test-verifier 验证卡 #${cardNo} 的最终状态；报告带 run_event {"role":"test-verifier","result":"done","cards":[${cardNo}]} 经 record-run.mjs 落账后重试。`,
    );
  }
  lines.push("- 第 3 绿（base 分支存在 + 该卡分支 rebase 无冲突）：integrator 执行时机械验证，不在本 hook 判定面（7.4）。");
  if (!ev.readable) lines.push(`- 证据不可核验（fail-closed）：${ev.error}——先恢复 runs.json 再合并。`);
  lines.push("放行条件：前两绿落账后重试同一命令；feature 分支间合并（卡片工作树内）不受本门禁拦截。");
  return lines;
}

// ---------------------------------------------------------------- 主流程

function main() {
  const payload = parsePayload(readStdin());
  if (payload === null) {
    log("stdin 不是 JSON payload：放行（不阻断）。");
    return 0;
  }
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : typeof payload.toolName === "string" ? payload.toolName : null;
  if (toolName !== null && toolName !== "Bash") {
    log(`tool_name=${toolName} 非 Bash：放行（matcher 应为 Bash）。`);
    return 0;
  }
  const input = payload.tool_input ?? payload.toolInput ?? {};
  const command = typeof input?.command === "string" ? input.command : null;
  if (command === null || command.trim() === "") {
    log("payload 无 tool_input.command：放行。");
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
    log("无法确定项目根：放行（不阻断）。");
    return 0;
  }

  const cls = classify(tokenize(command));
  const ctx = gitContext(root);

  if (cls.kind === "none") return 0;

  if (cls.kind === "merge-control") {
    log("merge 控制子命令（--abort/--continue/--quit）：放行。");
    return 0;
  }

  if (cls.kind === "merge") {
    if (!ctx.repo) {
      log("非 git 检出（无 .git）：不判定 base，放行。");
      return 0;
    }
    if (ctx.inWorktree) {
      log(`卡片工作树内合并（${ctx.branch ?? "?"}）：feature 分支间合并不拦，放行。`);
      return 0;
    }
    const ref = cls.ref ?? "";
    if (ctx.base !== null && new RegExp(`^(origin|remotes/origin)/${ctx.base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(ref)) {
      log(`上游同步合并（${ref} → ${ctx.base}）：非卡片合并，放行。`);
      return 0;
    }
    if (cls.cardNo === null) {
      return block([
        `[zcode-board 合并门禁] 已阻断：目标为 base 分支（${ctx.base ?? "主检出分支"}）的合并无法按卡号核验三绿。`,
        `- 命令的合并来源（${JSON.stringify(ref)}）不是 task-<no> 形态，也无 [#<no>] 合并信息。`,
        "- 去路：卡片分支命名 task-<no>（§6.1 命名即映射），合并命令写 `git merge --no-ff task-<no> -m \"Merge task-<no> [#<no>]\"`；",
        "  随后本门禁按 #<no> 核验前两绿证据（runs.json 的 code-reviewer/test-verifier verdict）。",
        "- feature 分支间合并请在卡片工作树内执行（不受本门禁拦截）。",
      ]);
    }
    // B5-6/#118：命令形态先于绿证据——-m 信息必须是冻结格式（Merge task-<no> [#<no>]）。
    if (typeof cls.message === "string") {
      const expected = `Merge task-${cls.cardNo} [#${cls.cardNo}]`;
      if (mergeMessageSubject(cls.message) !== expected) return block(mergeFormatLines(cls.cardNo, cls.message));
    } else {
      log(
        `merge 未提供 -m/--message 提交信息：冻结格式（Merge task-<no> [#<no>]，SKILL §6 第 6 条）无法事前核对——` +
          `事后核对：node <zcode-board 技能>/assets/tools/verify-cleanup.mjs --cards ${cls.cardNo} --root <项目根>（对 HEAD merge commit 格式核对，E4-17）。`,
      );
    }
    const ev = verdictEvidence(root, cls.cardNo);
    const ui = uiFaceGate(root, ctx.base, ref, ev.uiDesigner);
    if (!ui.checked) log(`第四绿：diff 不可得（${ui.reason}）：本次不判定 UI 面（边界：仅按本地可解析的 ${ctx.base ?? "HEAD"}...<来源> 计算）。`);
    if (ev.approved && ev.pass) {
      if (ui.checked && ui.uiFace && !ui.ok) return block(uiGreenLines(cls.cardNo, ui));
      log(`门禁通过：卡 #${cls.cardNo} 前两绿证据在位（code-reviewer approved / test-verifier pass）；第三绿归 integrator 机械验证${uiPassNote(ui)}`);
      return 0;
    }
    const lines = gateLines(cls.cardNo, ev, ctx.base);
    if (ui.checked && ui.uiFace && !ui.ok) lines.push("", ...uiGreenLines(cls.cardNo, ui, { header: false }));
    return block(lines);
  }

  if (cls.kind === "push") {
    if (!ctx.repo) {
      log("非 git 检出（无 .git）：放行。");
      return 0;
    }
    const base = ctx.base;
    const dstBranch = cls.dst !== null && cls.dst.deleteBranch !== true ? cls.dst.branch : cls.dst !== null ? null : ctx.branch;
    const toBase = (base !== null && dstBranch === base) || cls.allRefs === true;
    if (toBase) {
      return block([
        `[zcode-board 合并门禁] 已阻断：push 目标为 base 分支（${base ?? "当前检出分支"}${cls.allRefs ? "；--all/--mirror 全量推送含 base" : ""}）。`,
        "- 依据：§7.3 远程模式绝不直接 push base 分支——卡片经 integrator 走 PR 合并（gh pr merge），或本地模式走 git merge。",
        "- 去路：push 卡片分支 `git push origin task-<no>`；base 的更新经 integrator/PR 路径合入。",
      ]);
    }
    log(`push 目标非 base（${dstBranch ?? "未判决"}）：放行。`);
    return 0;
  }

  if (cls.kind === "branch-delete") {
    if (cls.force !== true) {
      log("git branch 非强制删除形态（-d 正规清理或分支管理）：放行。");
      return 0;
    }
    const cardTargets = cls.targets.filter((t) => CARD_BRANCH_RE.test(t));
    if (cardTargets.length === 0) {
      const shown = cls.targets.length > 0 ? cls.targets.join("、") : "无目标";
      log(`git branch -D 目标非卡分支（${shown}）：不在卡分支纪律面，放行（仍建议 -d，让 git 拒绝未合并删除）。`);
      return 0;
    }
    const branches = cardTargets.join("、");
    return block([
      `[zcode-board 合并门禁] 已阻断：git branch -D 强制删除卡分支（${branches}）。`,
      "- 判别：`-D`（含 `--delete --force` / `-df` / `-d -f` 组合）绕过「未合并会被拒绝」的安全网；SKILL §3.4 明确 `git branch -d`，-d 而非 -D（未合并会被拒绝，退回，不 -D）。",
      `- 去路：改用 \`git branch -d ${cardTargets[0]}\`；若被拒绝 = 该分支尚未合并——退回核对合并现场（integrator 合并 + 勾选），不得 -D 丢弃。`,
      `- 正规清理顺序：合并（Merge task-<no> [#<no>]）→ \`git worktree remove .zcode/worktrees/${cardTargets[0]}\` → \`git worktree prune\` → \`git branch -d ${cardTargets[0]}\`。`,
      "- 收尾机械核对：`node <zcode-board-skill>/assets/tools/verify-cleanup.mjs --cards <卡号> --root <项目根>`（残留点名清单；清理齐备 = 绿）。",
      "- 依据：E4-18（合并后清理半场：「-d 而非 -D」成文无机械面）+ E1 V33（收口断尾）。",
    ]);
  }

  if (cls.kind === "pr-merge") {
    let cardNo = cls.cardNo;
    if (cardNo === null) cardNo = cardFromText(ctx.branch ?? "");
    if (cardNo === null) {
      return block([
        "[zcode-board 合并门禁] 已阻断：gh pr merge 无法从命令确定卡号，三绿证据不可核验。",
        "- 去路：用 `gh pr merge task-<no>`（PR 以卡片分支为 head）标识卡号，或在卡片工作树内执行（当前分支即 task-<no>）。",
        "- 门禁按 #<no> 核验 runs.json 的 code-reviewer/test-verifier verdict；缺证据时先补齐再合并。",
      ]);
    }
    const ev = verdictEvidence(root, cardNo);
    const headRef = prHeadRef(root, cardNo);
    const ui = uiFaceGate(root, ctx.base, headRef, ev.uiDesigner);
    if (!ui.checked) log(`第四绿：PR 头分支 diff 不可得（${ui.reason}）：本次不判定 UI 面（边界：仅按本地 task-<no> / origin/task-<no> 计算）。`);
    if (ev.approved && ev.pass) {
      if (ui.checked && ui.uiFace && !ui.ok) return block(uiGreenLines(cardNo, ui));
      log(`门禁通过：卡 #${cardNo} 前两绿证据在位（PR 模式）${uiPassNote(ui)}`);
      return 0;
    }
    const lines = gateLines(cardNo, ev, ctx.base);
    if (ui.checked && ui.uiFace && !ui.ok) lines.push("", ...uiGreenLines(cardNo, ui, { header: false }));
    return block(lines);
  }

  return 0;
}

try {
  process.exit(main());
} catch (e) {
  // 门禁自身异常：不误拦（fail-open 仅限本 hook 自身故障；证据缺失仍是 fail-closed）。
  process.stderr.write(`gate-merge: 门禁异常（${e?.message ?? e}）：放行（请核查 hook）。\n`);
  process.exit(0);
}
