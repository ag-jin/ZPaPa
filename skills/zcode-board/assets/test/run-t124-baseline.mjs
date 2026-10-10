#!/usr/bin/env node
/**
 * zcode-board / #124（B6-6）基线红清册 + 未验证面注入 · 场景断言脚本（红→绿，测试先行）
 *
 * 覆盖（卡文 `.zcode/plans/plan-boardv2-b2.md` B6-6 交付面 ①–③；E1 V26/V27；
 *       来源 itw-20261010-5372 裁决冻结）：
 *
 *   切片 1  清册骨架生成（--init）：读套件输出（--from 文件 / stdin）生成
 *           `.zcode/board/baseline-reds.json` 骨架（reds[] = id/label/firstSeen/attribution=null）；
 *           既有清册未 --force 拒绝覆盖（保护人工归因）；--force 重生成保留仍红条目归因、
 *           已消解条目移出点名、新增条目待归因
 *   切片 2  比对正向（--check）：清册内红 →「既有」（不误报新增，V26 核心）；清册红未复现 →
 *           「已消解」（信息级）；同一 id 跨输入去重；标签变化可见；--check 零写入
 *   切片 3  反例必咬（新红）：不在清册的红 → 非零退出（4）点名新增红；既有与新增并陈不混淆
 *   切片 4  坏输入 fail-closed：清册缺失/坏 JSON/形态非法、输入缺失/为空/非套件输出、
 *           选项互斥 → 退出码 2（不猜「无新增」）
 *   切片 5  未验证面注入（--unverified；E1 V27）：一行一项清单文件拼入派发 prompt 骨架
 *           （「未验证面」段逐条随文可见）；文件缺失拒发（2）；清单为空拒发（3，零产出）；
 *           缺省不注入（默认输出零变化）；注入双跑逐字节一致
 *   切片 6  卫生与互证：--init 恰写清册一个文件；--check 零写入；工具源码卫生
 *           （无绝对用户路径/无第三方依赖）；与 B6-1 夹具互证（真实夹具卡 + 拼装脚本）
 *
 * 夹具：mktemp 下的隔离根（build-fixture.newRoot），绝不触碰真实 ZPaPa/.zcode/board。
 *
 * 用法：
 *   node assets/test/run-t124-baseline.mjs
 * 退出码：0 = 全部通过；1 = 有失败。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { newRoot, removeRoot, w, treeSnapshot, diffSnapshot } from "./fixtures/build-fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(HERE, "..");
const SKILL_ROOT = resolve(ASSETS, "..");
const REDLIST_TOOL = join(ASSETS, "tools", "baseline-redlist.mjs");
const DISPATCH_TOOL = join(ASSETS, "tools", "build-dispatch-prompt.mjs");
const CARD_FIXTURE = join(HERE, "fixtures", "card", "two-cards.md");
const REDS_REL = ".zcode/board/baseline-reds.json";

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
    const deep =
      typeof actual === "object" &&
      actual !== null &&
      typeof expected === "object" &&
      expected !== null &&
      JSON.stringify(actual) === JSON.stringify(expected);
    this.ok(actual === expected || deep, label, `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}${detail ? `；${detail}` : ""}`);
  }
  inc(text, needle, label) {
    this.ok(typeof text === "string" && text.includes(needle), label, `未命中：${JSON.stringify(needle)}`);
  }
  notInc(text, needle, label) {
    this.ok(typeof text === "string" && !text.includes(needle), label, `不应命中：${JSON.stringify(needle)}`);
  }
}

function readText(path) {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

function sha256(path) {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readJson(path) {
  const text = readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 带时区 ISO 8601（如 2026-10-11T02:20:00+08:00），与技能仓时间戳口径一致。 */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

/** 运行清册工具（cwd = 技能根，形态与编排者实际调用一致）。 */
function runRedlist(args, { cwd = SKILL_ROOT, input } = {}) {
  return spawnSync(process.execPath, [REDLIST_TOOL, ...args], { encoding: "utf8", cwd, input });
}

/** 运行拼装脚本（cwd = 技能根）。 */
function runDispatch(args, { cwd = SKILL_ROOT, input } = {}) {
  return spawnSync(process.execPath, [DISPATCH_TOOL, ...args], { encoding: "utf8", cwd, input });
}

// ---------------------------------------------------------------- 套件输出夹具

/** 真实 67c 失败标签（取自 run-scenarios 实跑输出，独立于本工具实现）。 */
const LABEL_67C = "仓库内 manifest 与副本域重新生成逐字段一致（仅 generatedAt 掩码）";

/**
 * run-scenarios 形态的套件输出夹具：`== 场景 <id>：… ==` 段头 + PASS/FAIL 行 + 依据 +
 * 结论/失败场景汇总行（与真实输出形态一致，供机械解析）。
 */
function scenariosOutput(entries) {
  const lines = [];
  for (const e of entries) {
    lines.push(`== 场景 ${e.id}：${e.title ?? "<夹具场景标题>"} ==`);
    lines.push(`  夹具：/tmp/zcode-board-夹具-${e.id}`);
    lines.push(`  PASS  场景 ${e.id} 前置断言`);
    if (e.fail === true) {
      lines.push(`  FAIL  ${e.label}`);
      lines.push("          依据：期望 <夹具期望>；实际 <夹具实际>");
    } else {
      lines.push(`  PASS  场景 ${e.id} 断言`);
    }
    lines.push("");
  }
  const failed = entries.filter((e) => e.fail === true).map((e) => e.id).sort();
  lines.push(`结论：通过 ${entries.length}，失败 ${failed.length}`);
  lines.push(failed.length > 0 ? `失败场景：${failed.join(", ")}` : "全部场景通过（0 失败）");
  lines.push("");
  return lines.join("\n");
}

/** 手写清册（独立事实源：字面条目，不经被测工具生成）。 */
function writeBaseline(root, reds) {
  const abs = join(root, REDS_REL);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify({ version: "baseline-reds/1", reds }, null, 2)}\n`);
  return abs;
}

// ---------------------------------------------------------------- 切片 1：清册骨架生成（--init）

function checkInit(c, root) {
  // 夹具输出：两红（67c 真实标签 + 78）一绿（99）
  const run1 = w(
    root,
    "logs/run1.log",
    scenariosOutput([
      { id: "67c", fail: true, label: LABEL_67C },
      { id: "78", fail: true, label: "夹具场景 78 断言（反向：无卡不得挂 arranged-not-expanded）" },
      { id: "99", fail: false },
    ]),
  );
  const before = treeSnapshot(root);
  const res = runRedlist(["--root", root, "--init", "--from", run1]);
  c.eq(res.status, 0, "--init 生成骨架退出码 0", `stderr=${res.stderr}`);
  c.inc(res.stdout ?? "", "清册已生成", "stdout 回显「清册已生成」");
  c.inc(res.stdout ?? "", join(root, REDS_REL), "stdout 点名清册绝对路径");
  c.inc(res.stderr ?? "", "67c", "stderr 诊断列出纳入清册的红（67c）");

  const abs = join(root, REDS_REL);
  c.ok(existsSync(abs), "--init 写出 .zcode/board/baseline-reds.json");
  const doc = readJson(abs);
  c.ok(doc !== null, "清册 JSON 可解析", String(readText(abs)).slice(0, 200));
  if (doc === null) return; // 骨架未写出即无可核对象（后续断言由上方 FAIL 承担）
  c.eq(doc?.version, "baseline-reds/1", "清册版本 = baseline-reds/1");
  c.eq((doc?.reds ?? []).map((r) => r.id).sort(), ["67c", "78"], "清册红集 = 输出中 FAIL 场景集（绿场景 99 不入册）");
  const e67 = (doc?.reds ?? []).find((r) => r.id === "67c") ?? {};
  c.eq(e67.label, LABEL_67C, "67c 条目 label = FAIL 行标签（原文）");
  c.eq(e67.attribution, null, "骨架 attribution 为空（待编排者/验证者归因）");
  c.ok(ISO_RE.test(e67.firstSeen ?? ""), "firstSeen 为带时区 ISO 8601", String(e67.firstSeen));
  const e78 = (doc?.reds ?? []).find((r) => r.id === "78") ?? {};
  c.ok(ISO_RE.test(e78.firstSeen ?? ""), "78 条目 firstSeen 为带时区 ISO 8601", String(e78.firstSeen));

  // --init 恰写清册一个文件（不触碰其他任何文件）
  const diff = diffSnapshot(before, treeSnapshot(root));
  c.eq(diff.changed.length, 0, "--init 零改写（既有文件字节与 mtime 不变）", JSON.stringify(diff.changed.map((x) => x.rel)));
  c.eq(diff.removed.length, 0, "--init 零删除", JSON.stringify(diff.removed));
  c.eq(diff.added, [REDS_REL], "--init 恰新增清册一个文件", JSON.stringify(diff.added));

  // 不覆盖保护：既有清册（人工归因后）未 --force 必咬，文件零变化
  const docFill = JSON.parse(readText(abs));
  docFill.reds.find((r) => r.id === "67c").attribution = "夹具归因：manifest 陈旧（并行卡在途）；批收口 --manifest 重生成消解";
  writeFileSync(abs, `${JSON.stringify(docFill, null, 2)}\n`);
  const shaFilled = sha256(abs);
  const dup = runRedlist(["--root", root, "--init", "--from", run1]);
  c.eq(dup.status, 3, "既有清册未 --force 拒覆盖（退出码 3）", `stderr=${dup.stderr}`);
  c.inc(dup.stderr ?? "", "已存在", "拒覆盖点名清册已存在");
  c.inc(dup.stderr ?? "", "--force", "拒覆盖点名重生成路径（--force）");
  c.eq(sha256(abs), shaFilled, "拒覆盖零写入（清册 sha256 不变，人工归因未丢）");

  // --force 重生成：仍红条目保留 firstSeen/归因；新增条目待归因；已消解条目移出点名
  const run2 = w(
    root,
    "logs/run2.log",
    scenariosOutput([
      { id: "67c", fail: true, label: LABEL_67C },
      { id: "85", fail: true, label: "夹具场景 85 断言（epic 章三层渲染）" },
    ]),
  );
  const firstSeen67c = docFill.reds.find((r) => r.id === "67c").firstSeen;
  const forced = runRedlist(["--root", root, "--init", "--force", "--from", run2]);
  c.eq(forced.status, 0, "--init --force 重生成退出码 0", `stderr=${forced.stderr}`);
  const doc2 = readJson(abs);
  c.eq((doc2?.reds ?? []).map((r) => r.id).sort(), ["67c", "85"], "重生成后清册红集 = 当前输出红集（78 移出、85 纳入）");
  const f67 = (doc2?.reds ?? []).find((r) => r.id === "67c") ?? {};
  c.eq(f67.attribution, "夹具归因：manifest 陈旧（并行卡在途）；批收口 --manifest 重生成消解", "仍红条目保留人工归因（不被覆盖）");
  c.eq(f67.firstSeen, firstSeen67c, "仍红条目保留首次发现时刻（firstSeen）");
  const f85 = (doc2?.reds ?? []).find((r) => r.id === "85") ?? {};
  c.eq(f85.attribution, null, "新增条目 attribution 待归因");
  c.inc(forced.stdout ?? "", "已消解", "--force 输出点名已消解移出条目");
  c.inc(forced.stdout ?? "", "78", "--force 消解条目点名 78");
}

// ---------------------------------------------------------------- 切片 2：比对正向（--check 既有/已消解）

const ATTRIBUTION_67C = "夹具归因：manifest 陈旧（并行卡在途）；批收口 --manifest 重生成消解";

function checkPositive(c, root) {
  writeBaseline(root, [
    { id: "67c", label: LABEL_67C, firstSeen: "2026-10-11T01:30:00+08:00", attribution: ATTRIBUTION_67C },
    { id: "78", label: "夹具场景 78 标签（自愈项）", firstSeen: "2026-10-11T01:31:00+08:00", attribution: null },
  ]);
  const after = w(
    root,
    "logs/after.log",
    scenariosOutput([
      { id: "67c", fail: true, label: LABEL_67C },
      { id: "99", fail: false },
    ]),
  );
  const before = treeSnapshot(root);
  const res = runRedlist(["--root", root, "--check", "--from", after]);
  c.eq(res.status, 0, "--check 仅既有红 → 退出码 0（既有失败不误报为新增，V26）", `stderr=${res.stderr}`);
  const out = res.stdout ?? "";
  c.inc(out, "既有  67c", "既有红标注「既有」（67c）");
  c.inc(out, LABEL_67C, "既有行含当前标签（原文）");
  c.inc(out, ATTRIBUTION_67C, "既有行回显清册归因（编排者/验证者可见）");
  c.inc(out, "已消解", "清册红未复现标注「已消解」（信息级）");
  c.inc(out, "78", "已消解行点名 78");
  c.ok(!/^新增\s/m.test(out), "无新增红（无「新增」条目行）", out.split("\n").filter((l) => l.startsWith("新增")).join(" / "));
  c.inc(res.stderr ?? "", "清册", "stderr 诊断点名清册路径");
  const diff = diffSnapshot(before, treeSnapshot(root));
  c.eq(diff.changed.length, 0, "--check 零写入（既有文件字节与 mtime 不变）", JSON.stringify(diff.changed.map((x) => x.rel)));
  c.eq(diff.removed.length, 0, "--check 零删除", JSON.stringify(diff.removed));
  c.eq(diff.added.length, 0, "--check 零新增文件", JSON.stringify(diff.added));

  // stdin 管线形态（node <套件> 2>&1 | node <本工具> --check）
  const viaStdin = runRedlist(["--root", root, "--check"], {
    input: scenariosOutput([{ id: "67c", fail: true, label: LABEL_67C }]),
  });
  c.eq(viaStdin.status, 0, "stdin 管线比对退出码 0", `stderr=${viaStdin.stderr}`);
  c.inc(viaStdin.stdout ?? "", "既有  67c", "stdin 管线照常标注既有红");

  // 全绿输入：清册红全部未复现 → 0 退出，全部标注已消解，不误报
  const allGreen = runRedlist(["--root", root, "--check"], {
    input: scenariosOutput([
      { id: "67c", fail: false },
      { id: "78", fail: false },
    ]),
  });
  c.eq(allGreen.status, 0, "全绿输入退出码 0", `stderr=${allGreen.stderr}`);
  c.inc(allGreen.stdout ?? "", "已消解  67c", "全绿输入：67c 标注已消解");
  c.inc(allGreen.stdout ?? "", "已消解  78", "全绿输入：78 标注已消解");
  c.ok(!/^新增\s/m.test(allGreen.stdout ?? ""), "全绿输入无「新增」条目行", (allGreen.stdout ?? "").split("\n").filter((l) => l.startsWith("新增")).join(" / "));

  // 多输入去重：同一 id 出现在两个 --from 输出 → 既有行恰一条
  const dupInput = w(root, "logs/dup.log", scenariosOutput([{ id: "67c", fail: true, label: LABEL_67C }]));
  const dedup = runRedlist(["--root", root, "--check", "--from", after, "--from", dupInput]);
  c.eq(dedup.status, 0, "多输入比对退出码 0", `stderr=${dedup.stderr}`);
  c.eq(((dedup.stdout ?? "").match(/既有  67c/g) ?? []).length, 1, "同一 id 跨输入去重（既有行恰一条）");
  c.eq(((dedup.stdout ?? "").match(/已消解  78/g) ?? []).length, 1, "同一清册红恰一条已消解行（去重不重复点名）");

  // 标签变化：id 在清册、标签已变 → 仍判既有（id 级匹配），但漂移显式可见（不静默）
  writeBaseline(root, [
    { id: "67c", label: "清册登记时的旧标签", firstSeen: "2026-10-11T01:30:00+08:00", attribution: ATTRIBUTION_67C },
  ]);
  const drift = runRedlist(["--root", root, "--check", "--from", after]);
  c.eq(drift.status, 0, "标签漂移仍判既有（id 级匹配，不误报新增）", `stderr=${drift.stderr}`);
  c.inc(drift.stdout ?? "", "既有  67c", "标签漂移：标注既有");
  c.inc(drift.stdout ?? "", "标签变化", "标签漂移显式点名（不静默）");
  c.inc(drift.stdout ?? "", "清册登记时的旧标签", "标签漂移回显清册原标签（可核对）");
  c.inc(drift.stdout ?? "", LABEL_67C, "标签漂移回显当前标签（可核对）");
}

// ---------------------------------------------------------------- 切片 3：反例必咬（新红非零点名）

function checkNewRedBite(c, root) {
  writeBaseline(root, [
    { id: "67c", label: LABEL_67C, firstSeen: "2026-10-11T01:30:00+08:00", attribution: ATTRIBUTION_67C },
    { id: "78", label: "夹具场景 78 标签（自愈项）", firstSeen: "2026-10-11T01:31:00+08:00", attribution: null },
  ]);
  const after = w(
    root,
    "logs/bite.log",
    scenariosOutput([
      { id: "67c", fail: true, label: LABEL_67C },
      { id: "85", fail: true, label: "夹具场景 85 断言（epic 章三层渲染）" },
      { id: "86", fail: true, label: "夹具场景 86 断言（roadmap 占位）" },
    ]),
  );
  const res = runRedlist(["--root", root, "--check", "--from", after]);
  c.eq(res.status, 4, "新增红非零退出（退出码 4，点名新红）", `stderr=${res.stderr}`);
  const out = res.stdout ?? "";
  c.inc(out, "新增  85", "新增红 85 逐条点名");
  c.inc(out, "新增  86", "新增红 86 逐条点名");
  c.inc(out, "夹具场景 85 断言（epic 章三层渲染）", "新增行含当前标签（可核对）");
  c.inc(out, "既有  67c", "既有红与新红并陈不混淆（67c 仍标既有）");
  c.inc(out, "已消解  78", "未复现清册红仍标已消解（不因新红混乱）");
  c.ok(/检出新增红\s*2\s*条：85、86/.test(out), "结论行点名新增红全集与计数（85、86）", out.split("\n").filter((l) => l.includes("新增红")).join(" / "));

  // 控制组：新红与清册零交集（仅新增、无既有）→ 同样非零点名
  const onlyNew = runRedlist(["--root", root, "--check"], {
    input: scenariosOutput([{ id: "85", fail: true, label: "夹具场景 85 断言（epic 章三层渲染）" }]),
  });
  c.eq(onlyNew.status, 4, "仅新红（无既有复现）同样退出码 4", `stderr=${onlyNew.stderr}`);
  c.inc(onlyNew.stdout ?? "", "检出新增红 1 条：85", "仅新红结论行点名 85");

  // 只留汇总行的日志（无 FAIL 行）也能咬：失败场景汇总致 4
  const summaryOnly = [
    "  PASS  夹具前置断言",
    "结论：通过 3，失败 1",
    "失败场景：85",
    "",
  ].join("\n");
  const viaSummary = runRedlist(["--root", root, "--check"], { input: summaryOnly });
  c.eq(viaSummary.status, 4, "仅汇总行（失败场景：85）输入同样退出码 4", `stderr=${viaSummary.stderr}`);
  c.inc(viaSummary.stdout ?? "", "新增  85", "仅汇总行输入点名 85");
}

/** 手写清册原文（坏 JSON/形态非法等 fail-closed 夹具用）。 */
function writeRedsRaw(root, text) {
  const abs = join(root, REDS_REL);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}

// ---------------------------------------------------------------- 切片 4：坏输入 fail-closed

function checkGuards(c, root) {
  const good = w(root, "logs/good.log", scenariosOutput([{ id: "67c", fail: true, label: LABEL_67C }]));

  // 清册缺失 → 拒绝比对（不猜「无新增」）
  const missing = runRedlist(["--root", root, "--check", "--from", good]);
  c.eq(missing.status, 2, "清册缺失退出码 2（fail-closed，不猜无新增）", `stderr=${missing.stderr}`);
  c.inc(missing.stderr ?? "", "清册不存在", "清册缺失点名「清册不存在」");
  c.inc(missing.stderr ?? "", "--init", "清册缺失指向 --init 生成骨架");
  c.eq(missing.stdout ?? "", "", "清册缺失 stdout 为空（不产出误报结论）");

  // 坏 JSON → 2
  writeRedsRaw(root, "{ 不是 JSON ");
  const badJsonRun = runRedlist(["--root", root, "--check", "--from", good]);
  c.eq(badJsonRun.status, 2, "坏 JSON 清册退出码 2", `stderr=${badJsonRun.stderr}`);
  c.inc(badJsonRun.stderr ?? "", "解析失败", "坏 JSON 点名「解析失败」");

  // 形态非法：reds 非数组 / 条目缺 id / attribution 类型错 / 版本不符 → 2
  writeRedsRaw(root, `${JSON.stringify({ version: "baseline-reds/1", reds: "不是数组" })}\n`);
  const badShape = runRedlist(["--root", root, "--check", "--from", good]);
  c.eq(badShape.status, 2, "reds 非数组退出码 2", `stderr=${badShape.stderr}`);
  c.inc(badShape.stderr ?? "", "reds 必须为数组", "reds 非数组点名形态");
  writeRedsRaw(root, `${JSON.stringify({ version: "baseline-reds/1", reds: [{ label: "缺 id" }] })}\n`);
  const noId = runRedlist(["--root", root, "--check", "--from", good]);
  c.eq(noId.status, 2, "条目缺 id 退出码 2", `stderr=${noId.stderr}`);
  c.inc(noId.stderr ?? "", "缺 id", "条目缺 id 点名");
  writeRedsRaw(root, `${JSON.stringify({ version: "baseline-reds/1", reds: [{ id: "67c", attribution: 42 }] })}\n`);
  const badAttr = runRedlist(["--root", root, "--check", "--from", good]);
  c.eq(badAttr.status, 2, "attribution 类型错退出码 2", `stderr=${badAttr.stderr}`);
  c.inc(badAttr.stderr ?? "", "attribution", "attribution 类型错点名字段");
  writeRedsRaw(root, `${JSON.stringify({ version: "baseline-reds/9", reds: [] })}\n`);
  const badVer = runRedlist(["--root", root, "--check", "--from", good]);
  c.eq(badVer.status, 2, "清册版本不符退出码 2", `stderr=${badVer.stderr}`);
  c.inc(badVer.stderr ?? "", "版本不符", "清册版本不符点名");

  // 输入缺失 / 为空 / 非套件输出 → 2
  const noFrom = runRedlist(["--root", root, "--check", "--from", join(root, "logs/nope.log")]);
  c.eq(noFrom.status, 2, "--from 文件不存在退出码 2", `stderr=${noFrom.stderr}`);
  c.inc(noFrom.stderr ?? "", "不存在", "--from 文件不存在点名");
  const noInput = runRedlist(["--root", root, "--check"]);
  c.eq(noInput.status, 2, "无 --from 且 stdin 为空退出码 2（拒绝无依据比对）", `stderr=${noInput.stderr}`);
  c.inc(noInput.stderr ?? "", "未收到任何套件输出", "空输入点名「未收到任何套件输出」");
  const junk = runRedlist(["--root", root, "--check"], { input: "随手粘贴的文本，不是套件输出。\n" });
  c.eq(junk.status, 2, "非套件输出输入退出码 2（fail-closed）", `stderr=${junk.stderr}`);
  c.inc(junk.stderr ?? "", "套件输出标记", "非套件输出输入点名「套件输出标记」");

  // 用法门槛：模式互斥 / 缺模式 / --force 仅 --init / 未知选项 / 根不存在 → 2
  const both = runRedlist(["--root", root, "--init", "--check", "--from", good]);
  c.eq(both.status, 2, "--init 与 --check 互斥退出码 2", `stderr=${both.stderr}`);
  c.inc(both.stderr ?? "", "互斥", "模式互斥点名");
  const noMode = runRedlist(["--root", root, "--from", good]);
  c.eq(noMode.status, 2, "缺模式退出码 2", `stderr=${noMode.stderr}`);
  c.inc(noMode.stderr ?? "", "缺模式", "缺模式点名");
  const forceCheck = runRedlist(["--root", root, "--check", "--force", "--from", good]);
  c.eq(forceCheck.status, 2, "--force 配 --check 退出码 2（仅 --init 可用）", `stderr=${forceCheck.stderr}`);
  const unknown = runRedlist(["--root", root, "--check", "--wat", "--from", good]);
  c.eq(unknown.status, 2, "未知选项退出码 2", `stderr=${unknown.stderr}`);
  c.inc(unknown.stderr ?? "", "未知选项", "未知选项点名");
  const noRoot = runRedlist(["--root", join(root, "nope-dir"), "--check", "--from", good]);
  c.eq(noRoot.status, 2, "项目根不存在退出码 2", `stderr=${noRoot.stderr}`);
  c.inc(noRoot.stderr ?? "", "不存在", "项目根不存在点名");
}

// ---------------------------------------------------------------- 切片 5：未验证面注入（--unverified）

/** 未验证面清单夹具（一行一项；含注释行、空行、bullet 行——注入应剥离评论与列表记号）。 */
const UNVERIFIED_ITEMS = [
  "Windows/Linux 未实跑（夹具条目一）",
  "macOS 之外平台的多行渲染（夹具条目二）",
  "真实板无 activeRun 态未观察（夹具条目三）",
];

function checkUnverified(c, root) {
  const evidence = join(root, "evidence", "T124");
  const list = w(
    root,
    "fixtures/unverified.md",
    [
      "# 未验证面清单（夹具；一行一项；注释与空行不入注入）",
      "",
      UNVERIFIED_ITEMS[0],
      `- ${UNVERIFIED_ITEMS[1]}`,
      "",
      `  ${UNVERIFIED_ITEMS[2]}  `,
      "",
    ].join("\n"),
  );
  const base = ["--source", CARD_FIXTURE, "--card", "F9-1", "--evidence", evidence];

  // 正向：清单逐条注入派发 prompt 骨架（E1 V27）
  const res = runDispatch([...base, "--unverified", list]);
  c.eq(res.status, 0, "--unverified 注入拼装退出码 0", `stderr=${res.stderr}`);
  const out = res.stdout ?? "";
  c.inc(out, "## 6. 未验证面", "派发 prompt 含「未验证面」段（注入清单）");
  c.inc(out, "共 3 项", "段头载注入项数（共 3 项）");
  for (const item of UNVERIFIED_ITEMS) {
    c.inc(out, `- ${item}`, `清单行注入：${item}`);
  }
  c.notInc(out, "注释与空行不入注入", "注释行不入注入");
  c.inc(out, list, "段头回显清单来源路径（可追溯）");
  c.inc(res.stderr ?? "", "未验证面注入 3 项", "stderr 诊断注入项数");
  c.ok(out.indexOf("## 6. 未验证面") > out.indexOf("## 5. 只读边界"), "未验证面段紧跟只读边界（段序稳定）");
  c.inc(out, "## 1. 卡文原文", "既有段面不位移（卡文原文）");
  c.inc(out, "no=900", "既有段面不位移（发号标记）");
  c.inc(out, "constraint-block/1", "既有段面不位移（约束块）");
  c.inc(out, evidence, "既有段面不位移（绝对证据路径）");

  // 缺省不注入：默认输出零变化（无段面、无「未验证面」字样）
  const plain = runDispatch(base);
  c.eq(plain.status, 0, "缺省（无 --unverified）拼装退出码 0", `stderr=${plain.stderr}`);
  c.notInc(plain.stdout ?? "", "## 6. 未验证面", "缺省不注入未验证面段");
  c.notInc(plain.stdout ?? "", "未验证面", "缺省输出无「未验证面」字样");

  // 确定性：注入双跑逐字节一致
  const res2 = runDispatch([...base, "--unverified", list]);
  c.eq(res2.status, 0, "注入双跑前提：二次调用退出码 0", `stderr=${res2.stderr}`);
  c.eq(res2.stdout, res.stdout, "注入双跑 stdout 逐字节一致（确定性）");

  // --out 留痕：写出文件含注入段（派发 prompt 落盘可核对）
  const outFile = join(root, "out", "prompt-unverified.md");
  const outRun = runDispatch([...base, "--unverified", list, "--out", outFile]);
  c.eq(outRun.status, 0, "--out 写出退出码 0", `stderr=${outRun.stderr}`);
  const written = readText(outFile);
  c.ok(written !== null, "留痕前提：--out 文件存在");
  c.inc(written ?? "", "## 6. 未验证面", "留痕 prompt 含未验证面段");
  c.inc(written ?? "", UNVERIFIED_ITEMS[0], "留痕 prompt 含清单条目（原文）");

  // 反例必咬 1：清单文件缺失 → 退出码 2（点名，不产出任何 prompt）
  const missing = runDispatch([...base, "--unverified", join(root, "fixtures", "nope.md")]);
  c.eq(missing.status, 2, "--unverified 文件缺失退出码 2", `stderr=${missing.stderr}`);
  c.inc(missing.stderr ?? "", "不存在", "清单缺失点名「不存在」");
  c.eq(missing.stdout ?? "", "", "清单缺失 stdout 为空（零产出）");

  // 反例必咬 2：清单为空（仅注释/空行）→ 拒发退出码 3（不静默省略注入）
  const emptyList = w(root, "fixtures/unverified-empty.md", "# 只有注释\n\n   \n");
  const emptyOut = join(root, "out", "prompt-empty.md");
  const empty = runDispatch([...base, "--unverified", emptyList, "--out", emptyOut]);
  c.eq(empty.status, 3, "空清单拒发退出码 3（未验证面未注入必咬）", `stderr=${empty.stderr}`);
  c.inc(empty.stderr ?? "", "未验证面清单为空", "空清单点名「未验证面清单为空」");
  c.eq(empty.stdout ?? "", "", "空清单拒发 stdout 为空");
  c.ok(!existsSync(emptyOut), "空清单拒发不写出 --out（零半成品）");
}

// ---------------------------------------------------------------- 切片 6：卫生、边界解析与互证

function checkHygiene(c) {
  const src = readText(REDLIST_TOOL);
  c.ok(src !== null, "清册工具源码可读", `缺失：${REDLIST_TOOL}`);
  c.inc(src ?? "", "V26", "清册工具源码标注 E1 V26 依据（可追溯）");
  c.notInc(src ?? "", "/Users/", "清册工具源码无绝对用户路径（可移植）");
  c.notInc(src ?? "", "ZPaPa", "清册工具源码不含真实项目名（不触碰真实现场）");

  const dispatchSrc = readText(DISPATCH_TOOL);
  c.ok(dispatchSrc !== null, "拼装脚本源码可读", `缺失：${DISPATCH_TOOL}`);
  c.inc(dispatchSrc ?? "", "V27", "拼装脚本源码标注 E1 V27 依据（可追溯）");
  c.notInc(dispatchSrc ?? "", "/Users/", "拼装脚本源码无绝对用户路径");

  for (const [name, text] of [
    ["baseline-redlist", src ?? ""],
    ["build-dispatch-prompt", dispatchSrc ?? ""],
  ]) {
    const bad = [...text.matchAll(/from\s+"([^"]+)"/g)]
      .map((m) => m[1])
      .filter((s) => !s.startsWith("node:") && !s.startsWith("."));
    c.eq(bad, [], `${name} 无第三方 import（仅 node: 内置与相对路径）`, JSON.stringify(bad));
  }

  const help = runRedlist(["--help"]);
  c.eq(help.status, 0, "清册工具 --help 退出码 0");
  for (const flag of ["--init", "--check", "--force", "--from"]) {
    c.inc(help.stdout ?? "", flag, `用法含 ${flag}`);
  }
}

function checkEdgeParsing(c, root) {
  // 依据行内嵌「FAIL」字样不产生幽灵红（解析按行首锚定）
  const text = [
    "== 场景 67c：夹具 == ",
    "  FAIL  标签甲（依据内嵌 FAIL 字样不该再计）",
    "          依据：上一条 jq 输出含 FAIL 字样；期望 0；实际 1",
    "结论：通过 1，失败 1",
    "失败场景：67c",
    "",
  ].join("\n");
  writeBaseline(root, [{ id: "67c", label: null, firstSeen: "2026-10-11T01:30:00+08:00", attribution: null }]);
  const res = runRedlist(["--root", root, "--check"], { input: text });
  c.eq(res.status, 0, "依据行内嵌 FAIL 字样不产生幽灵红（退出码 0）", `stderr=${res.stderr}`);
  const existing = (res.stdout ?? "").split("\n").filter((l) => l.startsWith("既有"));
  c.eq(existing.length, 1, "恰一条既有行（每场景 id 去重，行首锚定解析）", JSON.stringify(existing));
  c.inc(res.stdout ?? "", "标签甲（依据内嵌 FAIL 字样不该再计）", "既有行含 FAIL 标签原文（未被依据行污染）");
}

// ---------------------------------------------------------------- 主流程

say("zcode-board · #124（B6-6）基线红清册 + 未验证面注入（红→绿）");
say(`node   : ${process.version}`);
say(`assets : ${ASSETS}`);
say("");
say(`工具   : ${REDLIST_TOOL}`);
say("");

say("== 切片 1：清册骨架生成（--init 骨架 / 不覆盖保护 / --force 保留归因） ==");
{
  const c = new Checks("init");
  const root = newRoot("t124-init");
  try {
    checkInit(c, root);
  } finally {
    removeRoot(root);
  }
}

say("");
say("== 切片 2：比对正向（--check 既有不误报 / 已消解 / 去重 / 标签变化 / 零写入） ==");
{
  const c = new Checks("check");
  const root = newRoot("t124-check");
  try {
    checkPositive(c, root);
  } finally {
    removeRoot(root);
  }
}

say("");
say("== 切片 3：反例必咬（新增红非零退出 4、点名全集、与既有并陈、仅汇总行输入同咬） ==");
{
  const c = new Checks("bite");
  const root = newRoot("t124-bite");
  try {
    checkNewRedBite(c, root);
  } finally {
    removeRoot(root);
  }
}

say("");
say("== 切片 4：坏输入 fail-closed（清册缺失/坏 JSON/形态非法/输入缺失或非套件输出/用法门槛） ==");
{
  const c = new Checks("guard");
  const root = newRoot("t124-guard");
  try {
    checkGuards(c, root);
  } finally {
    removeRoot(root);
  }
}

say("");
say("== 切片 5：未验证面注入（--unverified 逐条随文 / 缺省不注入 / 缺失与空清单拒发） ==");
{
  const c = new Checks("unverified");
  const root = newRoot("t124-unverified");
  try {
    checkUnverified(c, root);
  } finally {
    removeRoot(root);
  }
}

say("");
say("== 切片 6：卫生与边界解析（无第三方依赖/无绝对路径/--help；依据行内嵌 FAIL 不产生幽灵红） ==");
{
  const c = new Checks("hygiene");
  checkHygiene(c);
  const root = newRoot("t124-hygiene");
  try {
    checkEdgeParsing(c, root);
  } finally {
    removeRoot(root);
  }
}

say("");
say(failCount === 0 ? `结论：通过 ${passCount}，失败 0` : `结论：通过 ${passCount}，失败 ${failCount}`);
process.exit(failCount === 0 ? 0 : 1);
