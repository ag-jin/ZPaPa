#!/usr/bin/env node
/**
 * zcode-board / 基线红清册（#124 / B6-6；E1 V26）
 *
 * 存在原因（E1 V26）：多轮报告以「基线既有失败」豁免结案——fmt/套件基线红无清册、无主人，
 * 成为永久豁免通道（工作树级 67c=manifest 陈旧即长期归因红）。本工具把「既有红」机械化为清册：
 *   - --init  读套件输出（--from 文件或 stdin）生成骨架 `.zcode/board/baseline-reds.json`：
 *             reds[] = { id, label, firstSeen, attribution:null }；归因/排期由编排者/验证者维护，
 *             本工具只生成骨架与比对。既有清册未 --force 拒绝覆盖（保护人工归因）；
 *             --force 重生成：仍红条目保留 firstSeen/attribution，已消解条目移出并点名，
 *             新增条目 attribution=null。
 *   - --check 读套件输出逐条判定：清册内红 →「既有」（既有失败不误报为新增，V26 核心）；
 *             不在清册的红 →「新增」→ 非零退出（4）点名；清册红未复现 →「已消解」（信息级，
 *             建议经 --init --force 重生成清册）。
 *
 * 判红依据（两类套件输出的真实形态；依据是输出文本，不是工具自算）：
 *   ① `FAIL  <标签>` 行；场景 id 取最近 `== <id>：… ==` 段头（run-scenarios 的
 *      `== 场景 67c：… ==`、t13 的 `== R10：… ==` 同口径），无段头时以 FAIL 标签本身为 id；
 *   ② `失败场景：a, b` / `失败用例：a, b` 汇总行（仅得 id，供只留汇总行的日志比对）。
 *
 * 用法：
 *   node assets/tools/baseline-redlist.mjs --init  [--root <项目根>] --from <套件输出> [--from …] [--force]
 *   node assets/tools/baseline-redlist.mjs --check [--root <项目根>] --from <套件输出> [--from …]
 *   （--from 缺省读 stdin；管线形态：
 *    node assets/test/run-scenarios.mjs 2>&1 | node assets/tools/baseline-redlist.mjs --check）
 *
 * 退出码：0 = 生成/比对通过（无新增红）；2 = 用法/输入错误（含清册缺失/坏 JSON/输入无套件标记，
 *         fail-closed——不猜「无新增」）；3 = --init 遇既有清册且未 --force（拒覆盖保护归因）；
 *         4 = --check 检出新增红（点名；修复或归因后经 --init --force 入清册）。
 * 无第三方依赖：仅 Node 内置模块。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** 清册相对路径（项目根下）与版本标记。 */
const REDS_REL = ".zcode/board/baseline-reds.json";
const REDLIST_VERSION = "baseline-reds/1";

/** 清册文件说明（生成骨架随文可见，指明维护者与比对语义）。 */
const REDS_NOTE =
  "基线红清册（E1 V26）：既有失败不误报为新增。reds[] = 已知红（id/label/firstSeen/attribution）；" +
  "归因与排期由编排者/验证者维护，工具只生成骨架（--init）与比对（--check）。" +
  "新增红经 --check 非零点名；既有红重现标注「既有」。";

const USAGE = `用法：
  node assets/tools/baseline-redlist.mjs --init  [--root <项目根>] --from <套件输出> [--from …] [--force]
  node assets/tools/baseline-redlist.mjs --check [--root <项目根>] --from <套件输出> [--from …]

  --init         生成清册骨架（<项目根>/.zcode/board/baseline-reds.json；attribution 待人工归因）
  --check        读套件输出比对清册：既有红不误报为新增；新增红非零退出点名；未复现红标注已消解
  --root         项目根（含 .zcode/board/）；缺省当前目录
  --from         套件输出文件（可重复）；缺省读 stdin
  --force        --init 重生成（仍红条目保留 firstSeen/attribution；已消解条目移出点名）
退出码：0 = 生成/比对通过；2 = 用法/输入错误（fail-closed）；3 = --init 遇既有清册拒覆盖；4 = 检出新增红。`;

function die(msg) {
  process.stderr.write(`baseline-redlist: ${msg}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opt = { from: [] };
  const valueOpts = new Set(["--root", "--from"]);
  const flagOpts = new Set(["--init", "--check", "--force"]);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (flagOpts.has(a)) {
      opt[a.slice(2)] = true;
      continue;
    }
    if (!valueOpts.has(a)) die(`未知选项 ${a}\n${USAGE}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) die(`选项 ${a} 缺少取值\n${USAGE}`);
    if (a === "--from") opt.from.push(v);
    else opt[a.slice(2)] = v;
    i += 1;
  }
  if (opt.init === true && opt.check === true) die(`--init 与 --check 互斥（一次一个模式）\n${USAGE}`);
  if (opt.init !== true && opt.check !== true) die(`缺模式：--init 或 --check 必选其一\n${USAGE}`);
  if (opt.force === true && opt.init !== true) die(`--force 仅用于 --init（重生成清册）\n${USAGE}`);
  return opt;
}

/** 本地时区带偏移的 ISO 8601（如 2026-10-11T02:20:00+08:00；技能仓时间戳同口径）。 */
function nowIsoLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** 套件输出标记（fail-closed：输入不像套件输出时拒绝比对，不猜「无新增」）。 */
const SUITE_MARKER_RE = /^\s*(?:PASS|FAIL|SKIP)\b|^结论：通过|^(?:失败场景|失败用例)[：:]|^== /m;

/** 段头 id（`== 场景 67c：… ==` / `== R10：… ==`；无冒号段头不取）。 */
const SECTION_RE = /^==\s+(?:(?:场景|用例)\s+)?(\S+?)\s*[：:]/;
/** FAIL 行（`  FAIL  <标签>`；依据行不匹配）。 */
const FAIL_RE = /^\s*FAIL\s+(.+?)\s*$/;
/** 汇总行（`失败场景：a, b` / `失败用例：a, b`；仅得 id）。 */
const SUMMARY_RE = /^(?:失败场景|失败用例)[：:]\s*(.+?)\s*$/;

/**
 * 解析套件输出为观察红集（[{ id, label }]；按出现序去重，label 补全优先非空）。
 * id 取最近段头（缺失时以 FAIL 标签本身为 id——标签即稳定身份）；汇总行并入仅得 id 的条目。
 */
function parseSuiteOutput(text) {
  const reds = [];
  const indexById = new Map();
  const add = (id, label) => {
    if (!id) return;
    if (!indexById.has(id)) {
      indexById.set(id, reds.length);
      reds.push({ id, label: label ?? null });
      return;
    }
    const cur = reds[indexById.get(id)];
    if (cur.label === null && label) cur.label = label;
  };
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const ms = SECTION_RE.exec(raw);
    if (ms) {
      section = ms[1];
      continue;
    }
    const mf = FAIL_RE.exec(raw);
    if (mf) {
      if (section !== null) add(section, mf[1]);
      else add(mf[1], null);
      continue;
    }
    const msum = SUMMARY_RE.exec(raw);
    if (msum) {
      for (const id of msum[1].split(/[,，、]/).map((s) => s.trim()).filter(Boolean)) add(id, null);
    }
  }
  return reds;
}

/** 读输入（--from 文件逐个读；缺省 stdin）。每个输入必须含套件输出标记（fail-closed）。 */
function readInputs(opt) {
  const inputs = [];
  if (opt.from.length > 0) {
    for (const f of opt.from) {
      const abs = resolve(f);
      if (!existsSync(abs) || !statSync(abs).isFile()) die(`套件输出文件不存在：${abs}`);
      const text = readFileSync(abs, "utf8");
      if (!SUITE_MARKER_RE.test(text)) {
        die(`输入不含套件输出标记（PASS/FAIL/结论/失败场景/段头），拒绝比对：${abs}`);
      }
      inputs.push({ path: abs, text });
    }
    return inputs;
  }
  let text = "";
  try {
    text = readFileSync(0, "utf8");
  } catch {
    text = "";
  }
  if (text.trim() === "") die(`未收到任何套件输出（--from 或缺省 stdin 均为空）`);
  if (!SUITE_MARKER_RE.test(text)) die(`stdin 输入不含套件输出标记（PASS/FAIL/结论/失败场景/段头），拒绝比对`);
  inputs.push({ path: "<stdin>", text });
  return inputs;
}

/** 归并多个输入的观察红集（同 id 去重；label 补全优先非空）。 */
function mergeReds(inputs) {
  const reds = [];
  const indexById = new Map();
  for (const input of inputs) {
    for (const r of parseSuiteOutput(input.text)) {
      if (!indexById.has(r.id)) {
        indexById.set(r.id, reds.length);
        reds.push({ id: r.id, label: r.label });
      } else if (reds[indexById.get(r.id)].label === null && r.label) {
        reds[indexById.get(r.id)].label = r.label;
      }
    }
  }
  return reds;
}

/** 读清册（missing → null；坏 JSON/形态非法 → die 2，fail-closed）。 */
function loadBaseline(path, { optional = false } = {}) {
  if (!existsSync(path)) {
    if (optional) return null;
    die(`清册不存在：${path}（先 --init 生成骨架，再由编排者/验证者归因）`);
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    die(`清册 JSON 解析失败：${path}：${e.message}`);
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) die(`清册形态非法（应为对象）：${path}`);
  if (doc.version !== undefined && doc.version !== REDLIST_VERSION) {
    die(`清册版本不符：${path} version=${JSON.stringify(doc.version)}（期望 ${REDLIST_VERSION}）`);
  }
  if (!Array.isArray(doc.reds)) die(`清册形态非法：reds 必须为数组：${path}`);
  for (const r of doc.reds) {
    if (r === null || typeof r !== "object" || typeof r.id !== "string" || r.id.trim() === "") {
      die(`清册条目缺 id（须非空字符串）：${path}：${JSON.stringify(r)}`);
    }
    if (r.label !== undefined && r.label !== null && typeof r.label !== "string") {
      die(`清册条目 label 须为字符串或 null：${path}：${JSON.stringify(r)}`);
    }
    if (r.attribution !== undefined && r.attribution !== null && typeof r.attribution !== "string") {
      die(`清册条目 attribution 须为字符串或 null：${path}：${JSON.stringify(r)}`);
    }
  }
  return doc;
}

function main() {
  const opt = parseArgs(process.argv.slice(2));

  const root = resolve(opt.root ?? ".");
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    die(`项目根不存在或不是目录：${root}`);
  }
  const redsPath = join(root, REDS_REL);

  const inputs = readInputs(opt);
  const observed = mergeReds(inputs);

  if (opt.init === true) {
    const existing = loadBaseline(redsPath, { optional: true });
    if (existing !== null && opt.force !== true) {
      process.stderr.write(
        `baseline-redlist: 清册已存在：${redsPath}；--init 不覆盖人工归因，如需重生成用 --force（仍红条目保留 firstSeen/attribution）\n`,
      );
      process.exit(3);
    }
    const oldById = new Map((existing?.reds ?? []).map((r) => [r.id, r]));
    const observedIds = new Set(observed.map((r) => r.id));
    const healed = (existing?.reds ?? []).filter((r) => !observedIds.has(r.id));
    const kept = [];
    const reds = observed.map((o) => {
      const old = oldById.get(o.id);
      if (old !== undefined) kept.push(o.id);
      return {
        id: o.id,
        label: o.label ?? old?.label ?? null,
        firstSeen: old?.firstSeen ?? nowIsoLocal(),
        attribution: old?.attribution ?? null,
      };
    });
    const doc = { _note: REDS_NOTE, version: REDLIST_VERSION, reds };
    mkdirSync(dirname(redsPath), { recursive: true });
    writeFileSync(redsPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    process.stdout.write(`baseline-redlist: 清册已生成 ${redsPath}（${reds.length} 条红；attribution=null 待编排者/验证者归因）\n`);
    if (existing !== null) {
      process.stdout.write(`baseline-redlist: 重生成（保留 ${kept.length} 条既有归因；新增 ${reds.length - kept.length} 条）\n`);
    }
    for (const h of healed) {
      process.stdout.write(`baseline-redlist: 已消解 ${h.id}（移出清册${h.label ? `：${h.label}` : ""}）\n`);
    }
    process.stderr.write(`baseline-redlist: 纳入清册 ${reds.length} 条：${reds.map((r) => r.id).join("、") || "<无>"}（来源 ${inputs.map((i) => i.path).join("、")}）\n`);
    return;
  }

  // --check：逐条判定（既有/新增/已消解）——既有失败不误报为新增（V26），新红必咬（退出码 4）
  const baseline = loadBaseline(redsPath);
  const known = new Map(baseline.reds.map((r) => [r.id, r]));
  const observedIds = new Set(observed.map((r) => r.id));
  const newReds = [];
  for (const o of observed) {
    const b = known.get(o.id);
    if (b === undefined) {
      newReds.push(o);
      process.stdout.write(`新增  ${o.id}${o.label ? ` ｜ ${o.label}` : ""}\n`);
      continue;
    }
    let line = `既有  ${o.id}`;
    if (o.label) line += ` ｜ ${o.label}`;
    if (o.label && b.label && o.label !== b.label) line += `（标签变化：清册「${b.label}」）`;
    if (b.attribution) line += `（归因：${b.attribution}）`;
    process.stdout.write(`${line}\n`);
  }
  const healed = baseline.reds.filter((r) => !observedIds.has(r.id));
  for (const h of healed) {
    process.stdout.write(`已消解  ${h.id}${h.label ? ` ｜ ${h.label}` : ""}（建议 --init --force 重生成清册移出）\n`);
  }
  const existingCount = observed.length - newReds.length;
  process.stderr.write(
    `baseline-redlist: 清册 ${redsPath}；观察红 ${observed.length} 条（既有 ${existingCount} / 新增 ${newReds.length} / 已消解 ${healed.length}；来源 ${inputs.map((i) => i.path).join("、")}）\n`,
  );
  if (newReds.length > 0) {
    process.stdout.write(
      `baseline-redlist: 检出新增红 ${newReds.length} 条：${newReds.map((r) => r.id).join("、")}——不得当作既有；修复或归因后经 --init --force 入清册（E1 V26）\n`,
    );
    process.exit(4);
  }
  process.stdout.write(`baseline-redlist: 无新增红（既有 ${existingCount} 条 / 已消解 ${healed.length} 条）\n`);
}

main();
