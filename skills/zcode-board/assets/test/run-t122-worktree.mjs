#!/usr/bin/env node
/**
 * zcode-board / #122（B6-4）编排者建树 + 树名下发 · 场景断言脚本（红→绿，测试先行）
 *
 * 覆盖（卡文 `.zcode/plans/plan-boardv2-b2.md` B6-4 交付面 ①–③；用户原话引用 =
 * 裁决⑥「一期必须立起 E1 37 起事件的机械化防线」+ dispatch-checklist「一卡一交付」
 * （2026-10-10 用户批准）；E1 V31；来源 itw-20261010-5372 裁决冻结）：
 *
 *   切片 1  建树成功面：`create-worktree.mjs --no <卡号> --root <项目根>` 按 SKILL §3.4 冻结步骤
 *           建树（先查现场 → git worktree add .zcode/worktrees/task-<no> -b task-<no> →
 *           check-ignore 断言命中 → 后核登记），stdout 下发树名/分支/现场/绝对路径
 *   切片 2  幂等复用：已有同名树（路径+分支皆符）→ 零动作返回（结果=复用），不重复 add
 *   切片 3  卡号来源：--source 计划稿 + --card（标签|稳定号）抽取号；与 B6-1 抽取实现互证
 *           （同一夹具两侧得同一号）；--no 与来源号不一致必咬
 *   切片 4  反例必咬：树名与卡号不符（--expect-name 错名 / 手动错支现场 task-NN 建 #MM 卡）拒建点名；
 *           非正整数卡号（标签形态）拒收
 *   切片 5  环境前置：忽略未命中拒建（零建树）/ 工作树内禁止建树（只开一层）/ root 非仓库顶层拒绝 /
 *           空仓库（unborn HEAD）失败带 §2 指向 / 分支遗留（无现场登记）拒建点名
 *   切片 6  互证面与确定性：现场形态 = §3.4/§6.1 冻结判据（`.zcode/worktrees/task-<no>` 末段 =
 *           卡稳定号，B4-5 断言落地后自动对上）+ 双跑逐字节一致 + 工具源码无绝对路径（不碰真实工作区）
 *
 * 夹具：mktemp 下的**裸 git 仓库**（build-fixture.newRoot），绝不触碰真实 ZPaPa/.zcode/worktrees。
 *
 * 用法：
 *   node assets/test/run-t122-worktree.mjs
 * 退出码：0 = 全部通过；1 = 有失败。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { newRoot, removeRoot, w } from "./fixtures/build-fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(HERE, "..");
const SKILL_ROOT = resolve(ASSETS, "..");
const TOOL = join(ASSETS, "tools", "create-worktree.mjs");
const DISPATCH_TOOL = join(ASSETS, "tools", "build-dispatch-prompt.mjs");
const TWO_CARDS_FIXTURE = join(HERE, "fixtures", "card", "two-cards.md");

// ---------------------------------------------------------------- 输出工具

const lines = [];
function say(s = "") {
  lines.push(s);
  console.log(s);
}

let passCount = 0;
let failCount = 0;

function pass(msg) {
  passCount += 1;
  say(`PASS  ${msg}`);
}

function fail(msg, detail = "") {
  failCount += 1;
  say(`FAIL  ${msg}${detail ? ` ｜ ${detail}` : ""}`);
}

class Checks {
  constructor(tag) {
    this.tag = tag;
  }
  ok(cond, label, detail = "") {
    if (cond) pass(`[${this.tag}] ${label}`);
    else fail(`[${this.tag}] ${label}`, detail);
  }
  eq(actual, expected, label, detail = "") {
    this.ok(actual === expected, label, `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}${detail ? `；${detail}` : ""}`);
  }
  inc(text, needle, label) {
    this.ok(typeof text === "string" && text.includes(needle), label, `未命中：${JSON.stringify(needle)}`);
  }
  notInc(text, needle, label) {
    this.ok(typeof text === "string" && !text.includes(needle), label, `不应命中：${JSON.stringify(needle)}`);
  }
  re(text, regexp, label, detail = "") {
    this.ok(typeof text === "string" && regexp.test(text), label, detail || `未匹配：${regexp}`);
  }
}

function readText(path) {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

// ---------------------------------------------------------------- git 夹具工具

/** 在夹具根跑 git（不继承调用者的 cwd；-C 精确指向夹具）。 */
function git(root, args) {
  return spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

/** 裸 git 仓库夹具：init + 身份 + 忽略规则（可关）+ 基线提交（可关=空仓库形态）。 */
function initRepo(root, { ignore = true, commit = true } = {}) {
  git(root, ["init", "-q", "."]);
  git(root, ["config", "user.email", "t122@test.local"]);
  git(root, ["config", "user.name", "t122"]);
  if (ignore) w(root, ".gitignore", "# 夹具忽略：现场不进版本库\n.zcode/worktrees/\n");
  if (commit) {
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "夹具基线"]);
  }
}

/** 运行建树工具（cwd = 技能根，形态与编排者实际调用一致）。 */
function runTool(args, cwd = SKILL_ROOT) {
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8", cwd });
}

/** 输出行抽取（key=value 形态；树名下发面）。 */
function outLine(text, key) {
  const m = new RegExp(`^${key}=.*$`, "m").exec(text ?? "");
  return m ? m[0] : null;
}

/** 现场登记条目（worktree list --porcelain：path + branch 对）。 */
function worktreeEntries(root) {
  const res = git(root, ["worktree", "list", "--porcelain"]);
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

// ---------------------------------------------------------------- 切片 1：建树成功 + 树名下发

function checkCreate(c, root) {
  initRepo(root);
  const res = runTool(["--no", "100", "--root", root]);
  c.eq(res.status, 0, "建树退出码 0（#100 → task-100）", `stderr=${res.stderr}`);
  const out = res.stdout ?? "";
  const siteRel = ".zcode/worktrees/task-100";

  // 树名下发（stdout；供派发 prompt 引用——与 B6-3 清单可拼「现场=…」行）
  c.eq(outLine(out, "结果"), "结果=新建", "stdout 下发 结果=新建");
  c.eq(outLine(out, "树名"), "树名=task-100", "stdout 下发 树名=task-100（树名=卡号绑定）");
  c.eq(outLine(out, "分支"), "分支=task-100", "stdout 下发 分支=task-100");
  c.eq(outLine(out, "现场"), `现场=${siteRel}`, "stdout 下发 现场=.zcode/worktrees/task-100（板根相对冻结形态）");
  // 绝对路径以 git 自证现场（worktree list 条目）为独立事实源，而非重算拼接
  const entries = worktreeEntries(root);
  const site = entries.find((e) => e.branch === "refs/heads/task-100");
  c.ok(site !== undefined, "独立事实源：git 现场条目存在（task-100）", JSON.stringify(entries));
  c.eq(outLine(out, "路径"), `路径=${site ? site.path : "<缺>"}`, "stdout 下发 绝对路径 = git 登记现场路径（独立事实源）");
  c.re(outLine(out, "路径"), /\/\.zcode\/worktrees\/task-100$/, "下发路径末段 = `.zcode/worktrees/task-100`");
  // 步骤可见（stderr 诊断；stdout 只承载下发线）
  c.inc(res.stderr ?? "", "先查现场", "stderr 步骤可见：先查现场（复用优先）");
  c.inc(res.stderr ?? "", "check-ignore", "stderr 步骤可见：check-ignore 断言");
  c.eq(out.split("\n").filter((l) => l.includes("=") && !l.startsWith("路径=")).length, 4, "stdout 恰 4 条相对下发线（无多余噪声）", `stdout=${JSON.stringify(out)}`);

  // 现场事实：目录存在且是工作树（.git 文件指向 gitdir）
  const target = join(root, siteRel);
  c.ok(existsSync(join(target, ".git")), "工作树目录建立（含 .git 指针）", `缺失：${target}`);
  c.ok(
    site !== undefined && site.path.endsWith(`/.zcode/worktrees/task-100`),
    "git worktree list 后核：路径且分支 task-100 登记在册",
    JSON.stringify(entries),
  );
  c.eq(git(root, ["rev-parse", "--verify", "--quiet", "refs/heads/task-100"]).status, 0, "分支 task-100 存在（refs/heads/task-100）");
  c.eq(git(root, ["check-ignore", "-q", siteRel]).status, 0, "check-ignore 断言：现场命中忽略规则（不进版本库）");
  c.eq(git(root, ["status", "--porcelain"]).stdout.trim(), "", "主检出工作区干净（建树不在主检出留痕）");
}

// ---------------------------------------------------------------- 切片 2：幂等复用

function checkReuse(c, root) {
  initRepo(root);
  const first = runTool(["--no", "100", "--root", root]);
  c.eq(first.status, 0, "复用前提：首次建树成功", `stderr=${first.stderr}`);
  const siteRel = ".zcode/worktrees/task-100";
  const headBefore = git(join(root, siteRel), ["rev-parse", "HEAD"]).stdout.trim();
  c.ok(headBefore !== "", "复用前提：现场 HEAD 可读", headBefore);

  // 第二次同卡调用：已有同名树 → 零动作幂等返回（不重复 add——重复 add 必失败，status 0 即证）
  const second = runTool(["--no", "100", "--root", root]);
  c.eq(second.status, 0, "复用：二次调用退出码 0（零动作，不重复 add）", `stderr=${second.stderr}`);
  const out = second.stdout ?? "";
  c.eq(outLine(out, "结果"), "结果=复用", "复用：stdout 下发 结果=复用（区别于新建）");
  c.eq(outLine(out, "树名"), "树名=task-100", "复用：树名不变");
  c.eq(outLine(out, "现场"), `现场=${siteRel}`, "复用：现场不变");
  const entries = worktreeEntries(root).filter((e) => e.branch === "refs/heads/task-100");
  c.eq(entries.length, 1, "复用：登记仍恰一条（未重复登记）", JSON.stringify(entries));
  c.eq(git(join(root, siteRel), ["rev-parse", "HEAD"]).stdout.trim(), headBefore, "复用：现场 HEAD 未变（零动作证据）");
  c.inc(second.stderr ?? "", "完成（复用）", "stderr 点名复用路径（完成（复用））");

  // 复用输出与新建输出仅「结果」行不同（其余下发线逐字节一致）
  const firstLines = (first.stdout ?? "").split("\n").filter((l) => !l.startsWith("结果="));
  const secondLines = (second.stdout ?? "").split("\n").filter((l) => !l.startsWith("结果="));
  c.eq(JSON.stringify(secondLines), JSON.stringify(firstLines), "复用与新建的下发线一致（仅结果行不同）");
}

// ---------------------------------------------------------------- 切片 3：卡号来源（--source/--card 抽取）+ 与 B6-1 互证

/** B6-1 抽取实现的独立读数（stderr「命中卡 <标签>（#<号>）」），供互证不二份。 */
function dispatchExtractedNo(source, card, cwd) {
  const res = spawnSync(process.execPath, [DISPATCH_TOOL, "--source", source, "--card", card, "--evidence", cwd], {
    encoding: "utf8",
    cwd,
  });
  const m = /命中卡\s+\S+（#([1-9][0-9]*)）/.exec(res.stderr ?? "");
  return m ? Number(m[1]) : null;
}

function checkCardSource(c, root) {
  initRepo(root);
  const evidence = join(root, "evidence");

  // ① 抽取路径：夹具卡 F9-1 自带 no=900（字面事实）；树名必须机械跟随之
  const byLabel = runTool(["--source", TWO_CARDS_FIXTURE, "--card", "F9-1", "--root", root]);
  c.eq(byLabel.status, 0, "抽取路径建树退出码 0（F9-1 → no=900 → task-900）", `stderr=${byLabel.stderr}`);
  c.eq(outLine(byLabel.stdout ?? "", "树名"), "树名=task-900", "树名 = 抽取稳定号（字面事实 no=900）");

  // ② 与 B6-1 抽取实现互证（同一夹具两侧得同一号；镜像实现漂移必咬）
  const b61No = dispatchExtractedNo(TWO_CARDS_FIXTURE, "F9-1", root);
  c.eq(b61No, 900, "B6-1 抽取独立读数 = 900（独立实现，非重算）");
  c.eq(outLine(byLabel.stdout ?? "", "树名"), `树名=task-${b61No}`, "本工具树名 = B6-1 抽取读数（互证不二份）");

  // ③ 标签与稳定号等价命中：--card 900 指向同一现场 → 复用
  const byNo = runTool(["--source", TWO_CARDS_FIXTURE, "--card", "900", "--root", root]);
  c.eq(byNo.status, 0, "按稳定号命中退出码 0（标签/号等价）", `stderr=${byNo.stderr}`);
  c.eq(outLine(byNo.stdout ?? "", "结果"), "结果=复用", "同号二次调用零动作复用（等价命中同一现场）");

  // ④ --no 与来源号一致（双保险放行）
  const both = runTool(["--no", "900", "--source", TWO_CARDS_FIXTURE, "--card", "F9-1", "--root", root]);
  c.eq(both.status, 0, "--no 与来源号一致放行退出码 0", `stderr=${both.stderr}`);

  // ⑤ 反例必咬：--no 与来源号不一致（手动错号，如 task-99 建 #900 卡的树）→ 拒绝点名、零建树
  const before = JSON.stringify(worktreeEntries(root));
  const mismatch = runTool(["--no", "99", "--source", TWO_CARDS_FIXTURE, "--card", "F9-1", "--root", root]);
  c.eq(mismatch.status, 3, "错号调用拒建（--no 99 ≠ 来源 900）退出码 3", `stderr=${mismatch.stderr}`);
  c.inc(mismatch.stderr ?? "", "不一致", "错号调用点名「不一致」");
  c.eq(mismatch.stdout ?? "", "", "错号调用 stdout 为空（不下发任何树名）");
  c.eq(JSON.stringify(worktreeEntries(root)), before, "错号调用零建树（现场登记不变）");
  c.eq(git(root, ["rev-parse", "--verify", "--quiet", "refs/heads/task-99"]).status, 1, "错号调用未建 task-99 分支");

  // ⑥ 未领号卡：抽取到卡但无 no 标记 → 拒建点名（树名绑定需稳定号）
  const unassigned = w(
    root,
    "plans/unassigned.md",
    ["- [ ] N1-1 夹具未领号卡", "  责任: implementer", "  目标: 夹具。", "  验收: 未领号。", ""].join("\n"),
  );
  const noNo = runTool(["--source", unassigned, "--card", "N1-1", "--root", root]);
  c.eq(noNo.status, 3, "未领号卡拒建退出码 3", `stderr=${noNo.stderr}`);
  c.inc(noNo.stderr ?? "", "未领号", "未领号卡点名（先 --assign）");

  // ⑦ 卡未找到 / 来源不存在 / 选项不成对 → 用法错误（退出码 2）
  const nf = runTool(["--source", TWO_CARDS_FIXTURE, "--card", "ZZZ-9", "--root", root]);
  c.eq(nf.status, 2, "卡未找到退出码 2", `stderr=${nf.stderr}`);
  c.inc(nf.stderr ?? "", "未找到", "卡未找到点名");
  const ns = runTool(["--source", join(root, "nope.md"), "--card", "F9-1", "--root", root]);
  c.eq(ns.status, 2, "来源不存在退出码 2", `stderr=${ns.stderr}`);
  const pair = runTool(["--source", TWO_CARDS_FIXTURE, "--root", root]);
  c.eq(pair.status, 2, "--source 缺 --card 退出码 2", `stderr=${pair.stderr}`);
  c.inc(pair.stderr ?? "", "--card", "选项不成对点名 --card");
  const pair2 = runTool(["--card", "F9-1", "--root", root]);
  c.eq(pair2.status, 2, "--card 缺 --source 退出码 2", `stderr=${pair2.stderr}`);
}

// ---------------------------------------------------------------- 切片 4：树名与卡号不符必咬

function checkNameBinding(c, root) {
  initRepo(root);

  // 反例 1：声明树名与卡号不符（--expect-name task-99 对 #100 卡）→ 拒建点名、零建树
  const before = JSON.stringify(worktreeEntries(root));
  const wrongName = runTool(["--no", "100", "--expect-name", "task-99", "--root", root]);
  c.eq(wrongName.status, 3, "错名声明（task-99 对 #100）拒建退出码 3", `stderr=${wrongName.stderr}`);
  c.inc(wrongName.stderr ?? "", "树名与卡号不符", "错名声明点名「树名与卡号不符」");
  c.eq(wrongName.stdout ?? "", "", "错名声明 stdout 为空（不下发任何树名）");
  c.eq(JSON.stringify(worktreeEntries(root)), before, "错名声明零建树（现场登记不变）");
  c.eq(git(root, ["rev-parse", "--verify", "--quiet", "refs/heads/task-100"]).status, 1, "错名声明未建任何分支");

  // 正向：声明树名与卡号一致 → 放行（模式与派发清单交接一致）
  const okName = runTool(["--no", "100", "--expect-name", "task-100", "--root", root]);
  c.eq(okName.status, 0, "正确声明（task-100 对 #100）放行退出码 0", `stderr=${okName.stderr}`);
  c.eq(outLine(okName.stdout ?? "", "树名"), "树名=task-100", "正确声明建树成功");

  // 反例 2：手动错支现场（路径 task-100 挂分支 task-999——手抄错位的现场形态）→ 拒建点名、不误报复用
  const root2 = newRoot("t122-botched");
  try {
    initRepo(root2);
    git(root2, ["worktree", "add", ".zcode/worktrees/task-100", "-b", "task-999"]);
    const botchedBefore = JSON.stringify(worktreeEntries(root2));
    const botched = runTool(["--no", "100", "--root", root2]);
    c.eq(botched.status, 3, "错支现场拒建退出码 3（不误报）", `stderr=${botched.stderr}`);
    c.inc(botched.stderr ?? "", "与树名 task-100 不符", "错支现场点名分支与树名不符");
    c.eq(botched.stdout ?? "", "", "错支现场 stdout 为空（不放行复用）");
    c.eq(JSON.stringify(worktreeEntries(root2)), botchedBefore, "错支现场未被改动（零动作）");
  } finally {
    removeRoot(root2);
  }
}

function checkNoArgumentForms(c, root) {
  initRepo(root);
  const before = worktreeEntries(root).length;
  for (const [arg, label] of [
    ["0", "零"],
    ["B6-4", "标签形态"],
    ["#100", "# 前缀"],
    ["100.5", "小数"],
  ]) {
    const res = runTool(["--no", arg, "--root", root]);
    c.eq(res.status, 2, `--no ${label}（${arg}）拒收退出码 2（须裸正整数）`, `stderr=${res.stderr}`);
    c.inc(res.stderr ?? "", "裸正整数", `--no ${label} 点名「裸正整数」`);
  }
  c.eq(worktreeEntries(root).length, before, "非法 --no 零建树（现场登记数不变）");
}

// ---------------------------------------------------------------- 切片 5：环境前置（拒建=零建树）

function checkIgnoreGuard(c, root) {
  initRepo(root, { ignore: false });
  const res = runTool(["--no", "100", "--root", root]);
  c.eq(res.status, 3, "忽略未命中拒建退出码 3（现场不进版本库是硬断言）", `stderr=${res.stderr}`);
  c.inc(res.stderr ?? "", "忽略", "忽略未命中点名");
  c.eq(res.stdout ?? "", "", "忽略未命中 stdout 为空（零下发）");
  c.eq(worktreeEntries(root).length, 1, "忽略未命中零建树（未建任何现场）");
  c.eq(git(root, ["rev-parse", "--verify", "--quiet", "refs/heads/task-100"]).status, 1, "忽略未命中未建分支");
}

function checkNestedGuard(c, root) {
  initRepo(root);
  c.eq(runTool(["--no", "100", "--root", root]).status, 0, "嵌套前提：主检出建 task-100");
  const inner = join(root, ".zcode/worktrees/task-100");
  const res = runTool(["--no", "200", "--root", inner]);
  c.eq(res.status, 3, "工作树内建树拒建退出码 3（只开一层）", `stderr=${res.stderr}`);
  c.inc(res.stderr ?? "", "工作树内", "工作树内建树点名");
  c.eq(res.stdout ?? "", "", "工作树内建树 stdout 为空");
  c.eq(worktreeEntries(root).length, 2, "工作树内建树零新增（仍 主检出 + task-100）");
  c.eq(git(root, ["rev-parse", "--verify", "--quiet", "refs/heads/task-200"]).status, 1, "工作树内建树未建 task-200 分支");
}

function checkRootGuards(c, root) {
  initRepo(root);
  w(root, "sub/dir/.keep", "");
  const notTop = runTool(["--no", "100", "--root", join(root, "sub")]);
  c.eq(notTop.status, 3, "root 非仓库顶层（子目录）拒建退出码 3（防错位现场）", `stderr=${notTop.stderr}`);
  c.inc(notTop.stderr ?? "", "仓库顶层", "root 非顶层点名「仓库顶层」");
  const missing = runTool(["--no", "100", "--root", join(root, "nope")]);
  c.eq(missing.status, 2, "root 不存在退出码 2（用法/输入错误）", `stderr=${missing.stderr}`);
  c.inc(missing.stderr ?? "", "不存在", "root 不存在点名");

  const nonRepo = newRoot("t122-nonrepo");
  try {
    const res = runTool(["--no", "100", "--root", nonRepo]);
    c.eq(res.status, 3, "root 非 git 仓库拒建退出码 3", `stderr=${res.stderr}`);
    c.inc(res.stderr ?? "", "不是 git 仓库", "root 非仓库点名「不是 git 仓库」");
  } finally {
    removeRoot(nonRepo);
  }
  c.eq(worktreeEntries(root).length, 1, "root 守卫零建树");

  // 默认 root = 当前目录（cwd 形态，与编排者 `cd <项目根>` 一致）
  const byCwd = runTool(["--no", "100"], root);
  c.eq(byCwd.status, 0, "缺省 root = 当前目录建树退出码 0", `stderr=${byCwd.stderr}`);
  c.eq(outLine(byCwd.stdout ?? "", "树名"), "树名=task-100", "缺省 root 建出 task-100");
}

function checkEmptyRepo(c, root) {
  initRepo(root, { commit: false });
  const res = runTool(["--no", "100", "--root", root]);
  c.eq(res.status, 3, "空仓库（unborn HEAD）建树失败退出码 3", `stderr=${res.stderr}`);
  c.inc(res.stderr ?? "", "至少一次提交", "空仓库点名「至少一次提交」（worktree-discipline §2）");
  c.eq(worktreeEntries(root).length, 1, "空仓库零建树");
}

function checkStaleBranch(c, root) {
  initRepo(root);
  c.eq(runTool(["--no", "100", "--root", root]).status, 0, "分支遗留前提：建 task-100");
  git(root, ["worktree", "remove", ".zcode/worktrees/task-100"]);
  git(root, ["worktree", "prune"]);
  c.eq(git(root, ["rev-parse", "--verify", "--quiet", "refs/heads/task-100"]).status, 0, "分支遗留前提：task-100 分支仍在（remove 不删分支）");
  const res = runTool(["--no", "100", "--root", root]);
  c.eq(res.status, 3, "分支遗留（无现场登记）拒建退出码 3", `stderr=${res.stderr}`);
  c.inc(res.stderr ?? "", "prune", "分支遗留点名先 prune 清残留（正规修复路径）");
  c.inc(res.stderr ?? "", "不得 -D", "分支遗留点名不得 -D 丢弃未合并分支");
  c.eq(worktreeEntries(root).length, 1, "分支遗留零建树");
}

// ---------------------------------------------------------------- 切片 6：互证面（B4-5 判据形态）+ 确定性 + 源码卫生

function checkInterop(c, root) {
  initRepo(root);
  const res = runTool(["--no", "100", "--root", root]);
  c.eq(res.status, 0, "互证前提：建树退出码 0", `stderr=${res.stderr}`);
  const out = res.stdout ?? "";
  const site = (outLine(out, "现场") ?? "").replace(/^现场=/, "");

  // 冻结判据（SKILL §3.4 / 设计 §6.1 / 消费契约 (f) 判定域）：末段 task-<no>，<no> = 卡稳定号
  const m = /^\.zcode\/worktrees\/task-([1-9][0-9]*)$/.exec(site);
  c.ok(m !== null, "现场形态命中冻结短形态 `.zcode/worktrees/task-<no>`（#71 接受两形态之一）", site);
  c.eq(m ? Number(m[1]) : null, 100, "现场末段号 = 卡稳定号（B4-5 断言域；该卡落地后自动对上）");

  const treeName = (outLine(out, "树名") ?? "").replace(/^树名=/, "");
  const branch = (outLine(out, "分支") ?? "").replace(/^分支=/, "");
  const pathSeg = (outLine(out, "路径") ?? "").replace(/^路径=/, "").split("/").pop();
  c.eq(pathSeg, treeName, "路径末段 = 树名（机械可对，无手抄错位）");
  c.eq(branch, treeName, "分支名 = 树名（卡号单一映射）");
  c.eq(treeName, `task-${m ? Number(m[1]) : "?"}`, "树名 = task-<稳定号>");

  // 确定性：连续复用双跑 stdout 逐字节一致（无随机/时间戳）
  const r2 = runTool(["--no", "100", "--root", root]);
  const r3 = runTool(["--no", "100", "--root", root]);
  c.eq(r2.status, 0, "确定性前提：复用跑一退出码 0", `stderr=${r2.stderr}`);
  c.eq(r3.status, 0, "确定性前提：复用跑二退出码 0", `stderr=${r3.stderr}`);
  c.eq(r3.stdout, r2.stdout, "复用双跑 stdout 逐字节一致（确定性）");
}

function checkSourceHygiene(c) {
  const src = readText(TOOL);
  c.ok(src !== null, "工具源码可读", `缺失：${TOOL}`);
  c.notInc(src ?? "", "/Users/", "工具源码无绝对用户路径（可移植；不绑任何真实工作区）");
  c.notInc(src ?? "", "ZPaPa", "工具源码不含真实项目名（不触碰真实 ZPaPa 现场）");
  for (const fn of ["writeFileSync", "appendFileSync", "rmSync", "unlinkSync", "mkdirSync"]) {
    c.notInc(src ?? "", fn, `工具源码无直接 ${fn}（现场只走 git worktree 正规路径）`);
  }
  // 夹具隔离正证：本套件夹具根落在系统临时目录（mktemp 形态，绝不碰真实工作区）
  const probe = newRoot("t122-isolation-probe");
  try {
    const tmp = realpathSync(tmpdir());
    const real = realpathSync(probe);
    c.ok(real === tmp || real.startsWith(`${tmp}/`), "套件夹具根落在系统临时目录（隔离正证）", real);
  } finally {
    removeRoot(probe);
  }
}

// ---------------------------------------------------------------- 主流程

say("zcode-board · #122（B6-4）编排者建树 + 树名下发（红→绿）");
say(`node   : ${process.version}`);
say(`assets : ${ASSETS}`);
say("");
say(`工具   : ${TOOL}`);
say("");

say("== 切片 1：建树成功 + 树名下发（#100 → .zcode/worktrees/task-100） ==");
{
  const c = new Checks("create");
  const root = newRoot("t122-create");
  try {
    checkCreate(c, root);
  } finally {
    removeRoot(root);
  }
}

say("");
say("== 切片 2：幂等复用（已有同名树 → 零动作，结果=复用） ==");
{
  const c = new Checks("reuse");
  const root = newRoot("t122-reuse");
  try {
    checkReuse(c, root);
  } finally {
    removeRoot(root);
  }
}

say("");
say("== 切片 3：卡号来源（--source/--card 抽取；与 B6-1 互证；错号必咬） ==");
{
  const c = new Checks("source");
  const root = newRoot("t122-source");
  try {
    checkCardSource(c, root);
  } finally {
    removeRoot(root);
  }
}

say("");
say("== 切片 4：树名与卡号不符必咬（错名声明 / 错支现场 / 非法卡号形态） ==");
{
  const c = new Checks("naming");
  const root = newRoot("t122-naming");
  try {
    checkNameBinding(c, root);
    checkNoArgumentForms(c, root);
  } finally {
    removeRoot(root);
  }
}

say("");
say("== 切片 5：环境前置（未忽略 / 工作树内 / root 守卫 / 空仓库 / 分支遗留 → 拒建=零建树） ==");
{
  const c = new Checks("env");
  const root = newRoot("t122-env");
  try {
    checkIgnoreGuard(c, root);
  } finally {
    removeRoot(root);
  }
  const root2 = newRoot("t122-env2");
  try {
    checkNestedGuard(c, root2);
  } finally {
    removeRoot(root2);
  }
  const root3 = newRoot("t122-env3");
  try {
    checkRootGuards(c, root3);
  } finally {
    removeRoot(root3);
  }
  const root4 = newRoot("t122-env4");
  try {
    checkEmptyRepo(c, root4);
  } finally {
    removeRoot(root4);
  }
  const root5 = newRoot("t122-env5");
  try {
    checkStaleBranch(c, root5);
  } finally {
    removeRoot(root5);
  }
}

say("");
say("== 切片 6：互证面（现场形态=§3.4/§6.1 冻结判据，与 B4-5 断言域同面）+ 确定性 + 源码卫生 ==");
{
  const c = new Checks("interop");
  const root = newRoot("t122-interop");
  try {
    checkInterop(c, root);
  } finally {
    removeRoot(root);
  }
  checkSourceHygiene(c);
}

say("");
say(failCount === 0 ? `结论：通过 ${passCount}，失败 0` : `结论：通过 ${passCount}，失败 ${failCount}`);
process.exit(failCount === 0 ? 0 : 1);
