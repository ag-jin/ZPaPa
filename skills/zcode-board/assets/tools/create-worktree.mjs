#!/usr/bin/env node
/**
 * zcode-board / 编排者建树 + 树名下发（#122 / B6-4；E1 V31；SKILL.md §3.4 冻结步骤脚本化）
 *
 * 存在原因（裁决⑥「一期必须立起 E1 37 起事件的机械化防线」；dispatch-checklist「一卡一交付」）：
 * 工作树创建与树名下发由编排者单点执行——一张卡一个工作树，树名 `task-<no>` 即卡稳定号，
 * 无第二份登记表，机械可对、无手抄错位。与 #109/B4-5（板面 worktree 末段 = 卡号）互证：
 * 本脚本产出的现场形态即其断言域（`.zcode/worktrees/task-<no>`）。
 *
 * 动作 = SKILL.md §3.4 冻结步骤（只增不改）：
 *   1) 先查现场 `git worktree list`（复用优先：同名树零动作幂等返回）；
 *   2) `git worktree add .zcode/worktrees/task-<no> -b task-<no>`（只开一层；主检出执行）；
 *   3) `git check-ignore` 断言命中（现场不进版本库）；
 *   4) 后核 `git worktree list`（新条目在册）并下发树名/分支/现场/绝对路径。
 *
 * 树名下发（stdout，key=value 机读形态；供派发 prompt 原样引用，与 B6-3 需齐绿清单可拼
 * 「现场=.zcode/worktrees/task-<no>」行）：
 *   结果=新建|复用
 *   树名=task-<no>
 *   分支=task-<no>
 *   现场=.zcode/worktrees/task-<no>
 *   路径=<绝对路径>
 * 诊断（步骤/拒因）只走 stderr，前缀 `create-worktree: `。
 *
 * 用法：
 *   node assets/tools/create-worktree.mjs --no <卡号> [--root <项目根>] [--expect-name task-<卡号>]
 *   node assets/tools/create-worktree.mjs --source <计划稿> --card <标签|稳定号> [--root <项目根>]
 *
 * 拒建反例（退出码 3，零建树）：树名与卡号不符（--expect-name 错名 / 现场路径挂着别的分支 /
 * --no 与来源抽取号不一致）；未领号；忽略未命中；工作树内执行；root 非仓库顶层；空仓库；分支遗留。
 *
 * 退出码：0 = 完成（新建 或 复用）；2 = 用法/输入错误；3 = 前置/环境断言拒绝（不建树）。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const PROG = "create-worktree";

const USAGE = `用法：
  node assets/tools/create-worktree.mjs --no <卡号> [--root <项目根>]
  node assets/tools/create-worktree.mjs --source <计划稿> --card <标签|稳定号> [--root <项目根>]

  --no       卡稳定号（裸正整数，如 122；不接受层级标签形态）
  --source   计划稿路径（只读抽取；须与 --card 同用）
  --card     卡标签（如 B6-4）或稳定号（如 122）
  --root     项目根（缺省 = 当前目录）；须是 git 仓库顶层（主检出）
  --expect-name 交接材料中声明的树名（须逐字等于 task-<卡号>；不符拒建点名）
退出码：0 = 完成（新建/复用）；2 = 用法/输入错误；3 = 前置/环境断言拒绝（不建树）。`;

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
  const opt = {};
  const valueOpts = new Set(["--no", "--source", "--card", "--root", "--expect-name"]);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (!valueOpts.has(a)) die(`未知选项 ${a}\n${USAGE}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) die(`选项 ${a} 缺少取值\n${USAGE}`);
    opt[a.slice(2)] = v;
    i += 1;
  }
  return opt;
}

/**
 * 现场登记条目（worktree list --porcelain → [{path, branch}]）。 */
function worktreeEntries(root) {
  const res = git(root, ["worktree", "list", "--porcelain"]);
  if (res.status !== 0) refuse(`git worktree list 失败：${(res.stderr ?? "").trim()}`);
  const entries = [];
  let cur = null;
  for (const line of (res.stdout ?? "").split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice("worktree ".length), branch: null };
      entries.push(cur);
      continue;
    }
    if (cur && line.startsWith("branch ")) cur.branch = line.slice("branch ".length);
  }
  return entries;
}

/** 忽略断言（§3.4 第 3 步）：现场不进版本库；未命中即拒（前置防半成品现场）。 */
function assertIgnored(root, siteRel) {
  process.stderr.write(`${PROG}: check-ignore 断言 ${siteRel}（现场不进版本库）\n`);
  if (git(root, ["check-ignore", "-q", "--", siteRel]).status !== 0) {
    refuse(`忽略未命中：${siteRel} 不在忽略范围内——现场会进版本库（worktree-discipline §7）。`);
  }
}

/**
 * 卡条目抽取（**最小镜像** #119/B6-1 build-dispatch-prompt.mjs 的纯函数 extractCard：
 * `- [ ] <标签> … <!-- zcode-board: no=<号> -->`；标签或稳定号任一命中）。
 * 不复用 import 的原因：build-dispatch-prompt.mjs 为可执行脚本（导入即执行 main），
 * 本卡范围禁止改动他卡在途文件；两份实现的一致性由 t122 切片 3 与 B6-1 输出互证机械保证。
 * 返回 { found, no }：found=条目命中；no=稳定号（未领号则 null）。
 */
function extractCardNo(text, key) {
  const norm = String(key).trim().replace(/^#/, "").replace(/^ID-/i, "");
  for (const line of text.split(/\r?\n/)) {
    const m = /^-\s+\[[ xX]\]\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const noMatch = /<!--\s*zcode-board:\s*no=([1-9][0-9]*)\s*-->/.exec(line);
    const no = noMatch ? Number(noMatch[1]) : null;
    if (m[1] !== norm && !(no !== null && String(no) === norm)) continue;
    return { found: true, no };
  }
  return { found: false, no: null };
}

const STABLE_NO_RE = /^[1-9][0-9]*$/;

function main() {
  const opt = parseArgs(process.argv.slice(2));

  // —— 卡号解析（--no 直给 或 --source+--card 抽取；双给须一致——错号零容忍）——
  const hasSource = opt.source !== undefined;
  const hasCard = opt.card !== undefined;
  if (hasSource !== hasCard) {
    die(`--source 与 --card 须同用（抽取卡号路径）：${hasSource ? "缺 --card" : "缺 --source"}\n${USAGE}`);
  }
  let no = null;
  if (hasSource) {
    const src = resolve(opt.source);
    if (!existsSync(src) || !statSync(src).isFile()) {
      die(`计划稿不存在或不是文件：${src}`);
    }
    const card = extractCardNo(readFileSync(src, "utf8"), opt.card);
    if (!card.found) die(`未找到卡：${opt.card}（来源 ${src}）`);
    if (card.no === null) {
      refuse(
        `卡未领号（${opt.card}）：树名绑定需要稳定号——先由编排者 --assign 发号，再建树（E1 V31；标签不是号）。`,
      );
    }
    no = card.no;
    if (opt.no !== undefined) {
      if (!STABLE_NO_RE.test(opt.no)) {
        die(`--no 须为裸正整数稳定号（非层级标签形态）：${opt.no}\n${USAGE}`);
      }
      if (Number(opt.no) !== no) {
        refuse(
          `卡号不一致：--no ${opt.no} ≠ 来源抽取 #${no}（来源 ${src} / 卡 ${opt.card}）——` +
            `树名与卡号必须机械可对（E1 V31）；核对后重试（错号调用零建树）。`,
        );
      }
    }
  } else {
    if (opt.no === undefined) die(`缺少必填选项 --no（或 --source + --card）\n${USAGE}`);
    if (!STABLE_NO_RE.test(opt.no)) {
      die(`--no 须为裸正整数稳定号（非层级标签形态）：${opt.no}\n${USAGE}`);
    }
    no = Number(opt.no);
  }

  // —— 项目根：须为 git 仓库顶层（主检出），防错位现场 ——
  const rootArg = opt.root ?? process.cwd();
  if (!existsSync(rootArg) || !statSync(rootArg).isDirectory()) {
    die(`项目根不存在或不是目录：${rootArg}`);
  }
  const root = realpathSync(rootArg);
  const topRes = git(root, ["rev-parse", "--show-toplevel"]);
  if (topRes.status !== 0) refuse(`项目根不是 git 仓库：${root}（${(topRes.stderr ?? "").trim()}）`);
  const top = realpathSync((topRes.stdout ?? "").trim());
  if (top !== root) {
    refuse(`项目根须为仓库顶层（当前 ${root}，仓库顶层 ${top}）——错误 cwd 会写出错位现场，不入此门。`);
  }

  // —— 只开一层：工作树内禁止建树（递归收纳）——
  const gitDirRaw = (git(root, ["rev-parse", "--git-dir"]).stdout ?? "").trim();
  const commonDirRaw = (git(root, ["rev-parse", "--git-common-dir"]).stdout ?? "").trim();
  const gitDir = existsSync(resolve(root, gitDirRaw)) ? realpathSync(resolve(root, gitDirRaw)) : resolve(root, gitDirRaw);
  const commonDir = existsSync(resolve(root, commonDirRaw))
    ? realpathSync(resolve(root, commonDirRaw))
    : resolve(root, commonDirRaw);
  if (gitDir !== commonDir) {
    refuse(
      `工作树内禁止建树（只开一层）：当前 root ${root} 的 git-dir（${gitDir}）≠ common-dir（${commonDir}）——` +
        `建树只在主检出执行（worktree-discipline §3；嵌套工作树违规）。`,
    );
  }

  const treeName = `task-${no}`;
  const siteRel = `.zcode/worktrees/${treeName}`;
  const targetAbs = join(root, siteRel);

  // —— 树名绑定断言（E1 V31）：声明树名（派发清单/交接材料）必须逐字等于 task-<卡号> ——
  if (opt["expect-name"] !== undefined && opt["expect-name"] !== treeName) {
    refuse(
      `树名与卡号不符：--expect-name ${opt["expect-name"]} ≠ ${treeName}（卡 #${no}）——` +
        `树名=卡稳定号，机械可对、无手抄错位（E1 V31）；拒绝建树。`,
    );
  }

  // —— 1) 先查现场（复用优先：同名树零动作幂等返回）——
  process.stderr.write(`${PROG}: 先查现场 git worktree list（复用优先）\n`);
  const before = worktreeEntries(root);
  const existing = before.find((e) => e.path === targetAbs);
  if (existing) {
    if (existing.branch !== `refs/heads/${treeName}`) {
      refuse(
        `现场 ${targetAbs} 已登记但分支为 ${existing.branch ?? "<未知>"}，与树名 ${treeName} 不符——` +
          `树名与卡号必须机械可对（E1 V31）；核对后按 worktree-discipline §6 正规清理重试。`,
      );
    }
    assertIgnored(root, siteRel);
    process.stdout.write(
      ["结果=复用", `树名=${treeName}`, `分支=${treeName}`, `现场=${siteRel}`, `路径=${existing.path}`, ""].join("\n"),
    );
    process.stderr.write(`${PROG}: 完成（复用）；树名 ${treeName}；路径 ${existing.path}\n`);
    return;
  }

  // —— 分支占用/遗留检查（一卡一现场；不静默改写冻结步骤）——
  const branchRef = `refs/heads/${treeName}`;
  if (git(root, ["show-ref", "--verify", "--quiet", branchRef]).status === 0) {
    const holder = before.find((e) => e.branch === branchRef);
    if (holder) {
      refuse(
        `分支 ${treeName} 已被现场 ${holder.path} 占用——一卡一现场，同卡请在该现场按序进出，勿再建树。`,
      );
    }
    refuse(
      `分支 ${treeName} 已存在但无现场登记（手工删目录未 prune 的残留形态）：先 git worktree prune 清残留；` +
        `分支仍在则退回编排者裁定——不得 -D 丢弃未合并分支（worktree-discipline §6）。`,
    );
  }

  // —— 3) 忽略断言（前置）：现场不进版本库 ——
  assertIgnored(root, siteRel);

  // —— 2) 建树（§3.4 冻结步骤：add .zcode/worktrees/task-<no> -b task-<no>）——
  process.stderr.write(`${PROG}: git worktree add ${siteRel} -b ${treeName}\n`);
  const add = git(root, ["worktree", "add", siteRel, "-b", treeName]);
  if (add.status !== 0) {
    const errText = (add.stderr ?? "").trim() || `git 退出码 ${add.status}`;
    const hint = /not a valid object name: 'HEAD'|unborn|unknown revision|bad revision/i.test(errText)
      ? "；空仓库（unborn HEAD）：git worktree add 需要至少一次提交（worktree-discipline §2）"
      : "";
    refuse(`建树失败：${errText}${hint}`);
  }

  // —— 4) 后核：新条目在册（路径 + 分支）——
  const after = worktreeEntries(root);
  const site = after.find((e) => e.path === targetAbs && e.branch === `refs/heads/${treeName}`);
  if (!site) {
    refuse(`后核失败：worktree list 未见 ${targetAbs} [${treeName}]（实际 ${JSON.stringify(after)}）`);
  }

  const out = [
    "结果=新建",
    `树名=${treeName}`,
    `分支=${treeName}`,
    `现场=${siteRel}`,
    `路径=${site.path}`,
    "",
  ].join("\n");
  process.stdout.write(out);
  process.stderr.write(`${PROG}: 完成（新建）；树名 ${treeName}；路径 ${site.path}\n`);
}

main();
