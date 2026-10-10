#!/usr/bin/env node
/**
 * zcode-board / #126（B6-8）突变工具 CLI 缺值边界 · 回归断言（B6 回炉轮 STD-1，2026-10-11）
 *
 * 存在原因（B6 批第三绿 STD-1）：run-mutations.mjs 对 `--source`/`--guard-board` 尾随缺值
 * 静默接受（--source 缺值回落默认源域照跑整轮；--guard-board 缺值静默关闭板面断言），
 * 与同批三工具（build-dispatch-prompt.mjs:106 / create-worktree.mjs:76 / baseline-redlist.mjs:78）
 * 的 `die("选项 X 缺少取值")` → exit 2 口径不一致；本套件为其 fail-closed 回归面。
 *
 * 插入点说明（回炉轮裁定「选最小侵入位，注明插入点」）：B6 批惯例为一卡一自包含套件
 * （run-t119-card-template / run-t122-worktree / run-t124-baseline）；#126 首绿（T126）以
 * evidence 探针覆盖、无自带套件——故本文件即其自包含套件（不落 t13 W1-W16 面：那是
 * watch-sources 域，与 argv 解析无关；也不改 t13 在途文件，避免与并行卡冲突）。
 *
 * 覆盖（断言均为退出码 / stderr 点名 / stdout 零产出等公开面）：
 *   S1  `--source` 尾随缺值 → exit 2 + stderr 点名「选项 --source 缺少取值」+ stdout 零产出
 *       （fail-closed 于副本域/突变执行之前：缺值不得回落默认源域开跑）
 *   S2  `--guard-board` 尾随缺值 → exit 2 + 同口径点名 + stdout 零产出（守卫不得静默关闭）
 *   S3  取值以 `--` 开头（`--source --keep` / `--guard-board --keep`）→ exit 2 同口径
 *       （不把旗标当取值吞掉）
 *   S4  误伤面：`--list` / `--help` / `--source <有效目录> --list` 仍正常（exit 0、
 *       清单行三字段形态），取值解析修正不误伤既有用法
 *
 * 夹具：无（只跑工具自身；缺值路径不建副本域、不触碰任何真实板/真实工作区）。
 * 用法：node assets/test/run-t126-mutations.mjs
 * 退出码：0 = 全部通过；1 = 有失败。
 */

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(HERE, "..");
const SKILL_ROOT = resolve(ASSETS, "..");
const TOOL = join(ASSETS, "test", "run-mutations.mjs");

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
    this.ok(
      actual === expected,
      label,
      `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}${detail ? `；${detail}` : ""}`,
    );
  }
  inc(text, needle, label) {
    this.ok(typeof text === "string" && text.includes(needle), label, `未命中：${JSON.stringify(needle)}`);
  }
  notInc(text, needle, label) {
    this.ok(typeof text === "string" && !text.includes(needle), label, `不应命中：${JSON.stringify(needle)}`);
  }
}

/** 运行突变工具（cwd = 技能根；超时留给缺值路径的 RED 态全轮跑）。 */
function runTool(args) {
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8", cwd: SKILL_ROOT, timeout: 180000 });
}

// ---------------------------------------------------------------- S1/S2/S3：缺值 fail-closed

function checkMissingValue(c) {
  // S1：--source 尾随缺值（曾静默回落默认源域照跑整轮）
  const s1 = runTool(["--source"]);
  c.eq(s1.status, 2, "--source 尾随缺值 → exit 2（fail-closed）", `stderr=${s1.stderr}`);
  c.inc(s1.stderr ?? "", "选项 --source 缺少取值", "stderr 点名「选项 --source 缺少取值」（同批三工具口径）");
  c.eq(s1.stdout ?? "", "", "--source 缺值 stdout 零产出（不落副本域、不开跑）");
  c.notInc(s1.stdout ?? "", "副本域", "--source 缺值不建副本域（缺值不得回落默认源域）");

  // S2：--guard-board 尾随缺值（曾静默关闭真实板守卫）
  const s2 = runTool(["--guard-board"]);
  c.eq(s2.status, 2, "--guard-board 尾随缺值 → exit 2（fail-closed）", `stderr=${s2.stderr}`);
  c.inc(s2.stderr ?? "", "选项 --guard-board 缺少取值", "stderr 点名「选项 --guard-board 缺少取值」");
  c.eq(s2.stdout ?? "", "", "--guard-board 缺值 stdout 零产出（守卫不得静默关闭）");
}

function checkDashLeadingValue(c) {
  // S3：取值以 `--` 开头 → 视为缺值（不把旗标当取值吞掉）
  const s3a = runTool(["--source", "--keep"]);
  c.eq(s3a.status, 2, "--source --keep → exit 2（旗标不当取值）", `stderr=${s3a.stderr}`);
  c.inc(s3a.stderr ?? "", "选项 --source 缺少取值", "--source --keep 点名「选项 --source 缺少取值」");
  c.eq(s3a.stdout ?? "", "", "--source --keep stdout 零产出");

  const s3b = runTool(["--guard-board", "--keep"]);
  c.eq(s3b.status, 2, "--guard-board --keep → exit 2（旗标不当取值）", `stderr=${s3b.stderr}`);
  c.inc(s3b.stderr ?? "", "选项 --guard-board 缺少取值", "--guard-board --keep 点名「选项 --guard-board 缺少取值」");
  c.eq(s3b.stdout ?? "", "", "--guard-board --keep stdout 零产出");
}

// ---------------------------------------------------------------- S4：误伤面（既有用法不回归）

function checkNoOverkill(c) {
  const list = runTool(["--list"]);
  c.eq(list.status, 0, "--list 仍正常（exit 0）", `stderr=${list.stderr}`);
  const rows = (list.stdout ?? "").trim().split("\n").filter((l) => l !== "");
  c.ok(rows.length > 0, "--list 列出突变清单（非空）");
  c.ok(
    rows.every((l) => /^m[0-9]+[a-z]?-/.test(l) && l.split("\t").length === 3),
    "清单行 = 名称 \\t 场景 \\t 期望（三字段形态不回归）",
    rows[0] ?? "",
  );

  const help = runTool(["--help"]);
  c.eq(help.status, 0, "--help 仍正常（exit 0）", `stderr=${help.stderr}`);
  c.inc(help.stdout ?? "", "--guard-board", "--help 用法含 --guard-board");

  // 合法取值（目录）不再报缺值：--list 早退路径下取值解析照常
  const withSource = runTool(["--source", ASSETS, "--list"]);
  c.eq(withSource.status, 0, "--source <有效目录> --list 正常（取值解析不误伤）", `stderr=${withSource.stderr}`);
  c.eq(withSource.stdout, list.stdout, "带合法 --source 的清单输出与裸 --list 逐字节一致");
}

// ---------------------------------------------------------------- 主流程

say("zcode-board · #126（B6-8）突变工具 CLI 缺值边界 · 回归断言（STD-1 回炉）");
say(`node   : ${process.version}`);
say(`assets : ${ASSETS}`);
say(`工具   : ${TOOL}`);
say("");

say("== S1/S2：缺值 fail-closed（--source / --guard-board 尾随缺值 → exit 2 + 点名 + 零产出） ==");
{
  const c = new Checks("S1-S2");
  checkMissingValue(c);
}

say("");
say("== S3：取值以 `--` 开头 → 同口径缺值（不把旗标当取值） ==");
{
  const c = new Checks("S3");
  checkDashLeadingValue(c);
}

say("");
say("== S4：误伤面（--list / --help / 合法取值不回归） ==");
{
  const c = new Checks("S4");
  checkNoOverkill(c);
}

say("");
say(failCount === 0 ? `结论：通过 ${passCount}，失败 0` : `结论：通过 ${passCount}，失败 ${failCount}`);
process.exit(failCount === 0 ? 0 : 1);
