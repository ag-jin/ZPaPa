#!/usr/bin/env node
/**
 * zcode-board / gate-merge（T13 交付物）——PreToolUse(Bash) 合并门禁（唯一有意阻断者）
 *
 * 职责（设计 §7.4 / §10.4 第 5 项；场景 27）：
 *   只拦一种情形——**合并/push 的目标为 base 分支，且前两绿判据证据不在 runs.json**：
 *     第 1 绿 code-reviewer verdict = approved（run: role=code-reviewer, result=done, cards 含该卡）
 *     第 2 绿 test-verifier verdict = pass（run: role=test-verifier, result=done, cards 含该卡）
 *     第 3 绿（base 存在 + 该卡分支 rebase 无冲突）由 integrator 执行时机械验证，不在本 hook 判定面。
 *   "feature 分支间合并不拦"：在卡片工作树（.git 为 gitdir 指针）内执行的合并一律放行。
 *
 * 阻断形态：PreToolUse 退出码 2 被运行时译为 permissionDecision: deny（阻断原因取 stderr），
 * 拦截文案给出缺失绿与补齐路径；其余命令/无法判定时放行（exit 0，去路文案走 stderr）。
 * 本 hook 不做任何 git 子进程调用，只读 `<root>/.git/HEAD` 与 `<root>/.zcode/board/runs.json`。
 *
 * 无第三方依赖（仅 node 内置）。
 */

import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

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
 *   {kind:"pr-merge", cardNo} | {kind:"none"}
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
          if (t === "-m" || t === "--message") message = rest[k + 1] ?? message;
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
    return { kind: "merge", ref, cardNo };
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

  return { kind: "none" };
}

// ---------------------------------------------------------------- 门禁证据

/** 前两绿判据（runs.json 的 verdict 事件；第 3 绿归 integrator 执行时机械验证）。 */
function verdictEvidence(root, cardNo) {
  const loaded = readJsonFile(join(root, RUNS_REL));
  if (!loaded.ok) {
    return { readable: false, error: loaded.missing ? "runs.json 不存在" : `runs.json 无法读取（${loaded.error}）`, approved: false, pass: false };
  }
  const runs = Array.isArray(loaded.value?.runs) ? loaded.value.runs : [];
  const forCard = runs.filter((r) => r && Array.isArray(r.cards) && r.cards.includes(cardNo));
  return {
    readable: true,
    error: null,
    approved: forCard.some((r) => r.role === "code-reviewer" && r.result === "done"),
    pass: forCard.some((r) => r.role === "test-verifier" && r.result === "done"),
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
    const ev = verdictEvidence(root, cls.cardNo);
    if (ev.approved && ev.pass) {
      log(`门禁通过：卡 #${cls.cardNo} 前两绿证据在位（code-reviewer approved / test-verifier pass）；第三绿归 integrator 机械验证。`);
      return 0;
    }
    return block(gateLines(cls.cardNo, ev, ctx.base));
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
    if (ev.approved && ev.pass) {
      log(`门禁通过：卡 #${cardNo} 前两绿证据在位（PR 模式）。`);
      return 0;
    }
    return block(gateLines(cardNo, ev, ctx.base));
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
