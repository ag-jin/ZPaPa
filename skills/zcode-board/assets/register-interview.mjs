#!/usr/bin/env node
/**
 * zcode-board / register-interview（T8 交付物，文件级单写者：interviews.json 唯一写路径）
 *
 * CLI 形态与技能手册 SKILL.md §3.2「访谈登记」命令表逐字一致（~/.zcode/skills/zcode-board/SKILL.md）：
 *   node register-interview.mjs <项目根> append --topic "<主题>" --summary "<结论一句话>" --outcome <none/plan/spec/tasks>
 *   node register-interview.mjs <项目根> resolve --id itw-<日期>-<短后缀> --resolved-by <特性节点 id>
 *
 * 行为（设计 §3.1/§5.2、interviews.template.json 冻结字段契约）：
 *   - append：生成不可变 id（itw-<日期>-<短后缀>）与 at（带时区 ISO 8601），原子追加一条登记；
 *     未知信息留空、不猜（sessionId 缺省空串、decisions/artifacts 缺省空数组、resolvedBy 空串、status=open）；
 *     interviews.json 缺失时按空登记簿新建（version=1）；已存在时只追加，既有条目与顶层键零改写。
 *   - resolve：按 --id 回填 resolvedBy（登记事件的唯一允许改写）并置 status=resolved；id 未命中报错且不写。
 *   - 损坏源（JSON 解析失败 / interviews 非数组）一律拒绝覆盖并报错（不静默重建、不丢数据）。
 *   - 注册后触发重编译（B3-3/#103；E1 V20 幻影板防线）：append/resolve 成功后自动重编译，
 *     新登记即上板（免手动编译）；板未建立/编译器缺失时跳过；编译失败只写 stderr 诊断，
 *     不阻塞主流程（退出码与 stdout 契约不变）——只读失败语义。
 *
 * 无第三方依赖（仅 node 内置）；原子写复用冻结的 lib/board-io.mjs（临时文件 + 改名）。
 * 退出码：0 = 成功；1 = 运行错误（id 未命中 / 源损坏 / IO）；2 = 用法错误。
 */

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isFile, isoLocal, readJsonFile, writeJsonAtomic } from "./lib/board-io.mjs";

/** interviews.json 相对项目根路径（设计 §3.1；与编译器 sources[] 同一路径）。 */
export const INTERVIEWS_REL = ".zcode/board/interviews.json";
export const OUTCOMES = ["none", "plan", "spec", "tasks"];
/** 登记 id 冻结形态：itw-<日期 YYYYMMDD>-<短后缀 4 位小写十六进制>（设计 §3.1）。 */
export const INTERVIEW_ID_RE = /^itw-[0-9]{8}-[0-9a-z]{4}$/;
const FILE_VERSION = 1;
const ID_ATTEMPTS = 8;

/** 注册后触发重编译（B3-3/#103）：技能包内编译器 + 板产物相对路径 + 超时（与 watch-sources 同口径）。 */
const HERE = dirname(fileURLToPath(import.meta.url));
const COMPILER = resolve(HERE, "compile-board.mjs");
const BOARD_REL = ".zcode/board/board.json";
const COMPILE_TIMEOUT_MS = 20_000;

const USAGE = `zcode-board 访谈登记（register-interview）

用法（SKILL.md §3.2「访谈登记」命令表为准：~/.zcode/skills/zcode-board/SKILL.md）：
  node register-interview.mjs <项目根> append --topic "<主题>" --summary "<结论一句话>" --outcome <none/plan/spec/tasks>
  node register-interview.mjs <项目根> resolve --id itw-<日期>-<短后缀> --resolved-by <特性节点 id>

append 可选参数（缺省留空不猜）：
  --session-id <会话 id>   登记时的会话（缺省空串）
  --decisions "<一句话>"    可重复；结论要点（缺省空数组）
  --artifacts <相对路径>    可重复；产物指针（缺省空数组）

行为：
  append   生成 id（itw-<日期>-<短后缀>，不可变）与 at（带时区 ISO 8601），原子追加一条登记；
           未知信息留空；interviews.json 缺失按空登记簿新建（version=1），已存在只追加。
  resolve  按 --id 回填 resolvedBy 并置 status=resolved；id 未命中报错且不写。

退出码：0 成功；1 运行错误（id 未命中 / 源损坏 / IO）；2 用法错误。
文件级单写者：本脚本是 interviews.json 的唯一写路径（检查点 2）；无第三方依赖。
`;

// ---------------------------------------------------------------- 读取（缺失 = 空登记簿）

function loadDoc(root) {
  const loaded = readJsonFile(join(root, INTERVIEWS_REL));
  if (loaded.missing) return { ok: true, doc: { version: FILE_VERSION, interviews: [] } };
  if (!loaded.ok) {
    return { ok: false, error: `interviews.json 解析失败（${loaded.error}）：拒绝覆盖，请人工修复后重试。` };
  }
  const doc = loaded.value;
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || !Array.isArray(doc.interviews)) {
    return { ok: false, error: "interviews.json 结构不合法（interviews 必须为数组）：拒绝覆盖，请人工修复后重试。" };
  }
  return { ok: true, doc };
}

// ---------------------------------------------------------------- 写入

/** 本地日期段 YYYYMMDD（复用冻结的带时区时间戳工具，保证与 at 同一时区口径）。 */
function localDatePart(date) {
  return isoLocal(date).slice(0, 10).replace(/-/g, "");
}

function makeEntry({ id, at, sessionId, topic, summary, decisions, artifacts, outcome }) {
  return { id, at, sessionId, topic, summary, decisions, artifacts, outcome, resolvedBy: "", status: "open" };
}

function appendEntry(root, fields) {
  const loaded = loadDoc(root);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const doc = loaded.doc;
  const at = new Date();
  let entry = null;
  for (let i = 0; i < ID_ATTEMPTS && entry === null; i += 1) {
    const id = `itw-${localDatePart(at)}-${randomBytes(2).toString("hex")}`;
    if (!doc.interviews.some((e) => e && typeof e === "object" && e.id === id)) {
      entry = makeEntry({ id, at: isoLocal(at), ...fields });
    }
  }
  if (entry === null) return { ok: false, error: `id 生成冲突（重试 ${ID_ATTEMPTS} 次）：未写入。` };
  doc.interviews.push(entry);
  writeJsonAtomic(join(root, INTERVIEWS_REL), doc);
  return { ok: true, entry };
}

/** resolve：回填 resolvedBy（唯一允许改写）并置 status=resolved；未命中不新建、不猜测。 */
function resolveEntry(root, id, resolvedBy) {
  const loaded = loadDoc(root);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const doc = loaded.doc;
  const index = doc.interviews.findIndex((e) => e && typeof e === "object" && e.id === id);
  if (index < 0) return { ok: false, error: `登记 id 未命中：${id}（不新建、不猜测；append 先行）` };
  const after = { ...doc.interviews[index], resolvedBy, status: "resolved" };
  doc.interviews[index] = after;
  writeJsonAtomic(join(root, INTERVIEWS_REL), doc);
  return { ok: true, entry: after };
}

// ---------------------------------------------------------------- 注册后触发重编译（B3-3/#103）

/**
 * 注册后触发重编译（B3-3/#103；E1 V20 幻影板防线）：新登记即上板，免手动编译。
 * 跳过（零板写入、stderr 留痕）：板根缺失——board.json 不存在（无板可刷新；登记先于首次编译的
 * 窗口由首次编译连带上板）；编译器缺失（技能包不完整）。注：本脚本刚写入 interviews.json
 * （sources[] 第一方源），成功后"无源"不可达。
 * 失败不阻塞（只读失败语义）：启动失败/超时/非零退出只写 stderr 诊断；登记主流程照常成功
 * （本函数不改退出码，也不向 stdout 增加内容）。
 */
function recompileAfterWrite(root) {
  if (!isFile(COMPILER)) {
    process.stderr.write("register-interview: 重编译跳过（编译器缺失）：登记已成功，板可稍后手动重编译。\n");
    return;
  }
  if (!isFile(join(root, BOARD_REL))) {
    process.stderr.write(`register-interview: 重编译跳过（板未建立：${BOARD_REL} 不存在，无板可刷新）：登记已成功，首次编译将连带上板。\n`);
    return;
  }
  const r = spawnSync(process.execPath, [COMPILER, root], { encoding: "utf8", timeout: COMPILE_TIMEOUT_MS });
  if (r.error) {
    process.stderr.write(`register-interview: 重编译未完成（${r.error.message}）：登记已成功（不阻塞，板可手动重编译）。\n`);
    return;
  }
  if (r.status !== 0) {
    const detail = String(r.stderr ?? "").trim().split("\n").slice(0, 3).join(" / ");
    process.stderr.write(`register-interview: 重编译失败（退出码 ${String(r.status)}）：${detail}（登记已成功，不阻塞；板可手动重编译）。\n`);
    return;
  }
  process.stderr.write(`register-interview: 已重编译（新登记上板）：${String(r.stdout ?? "").trim()}\n`);
}

// ---------------------------------------------------------------- CLI 解析

/** 解析 `--flag value` 与 `--flag=value`；返回值按出现次序累积。 */
function parseFlags(tokens) {
  const flags = new Map();
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (!tok.startsWith("--")) return { ok: false, error: `位置参数多余或非法：${tok}` };
    const eq = tok.indexOf("=");
    if (eq > 0) {
      flags.set(tok.slice(0, eq), [...(flags.get(tok.slice(0, eq)) ?? []), tok.slice(eq + 1)]);
      continue;
    }
    const next = tokens[i + 1];
    if (next === undefined) return { ok: false, error: `选项 ${tok} 缺少取值` };
    flags.set(tok, [...(flags.get(tok) ?? []), next]);
    i += 1;
  }
  return { ok: true, flags };
}

function first(flags, name) {
  const v = flags.get(name);
  return v === undefined ? undefined : v[v.length - 1];
}

function all(flags, name) {
  return flags.get(name) ?? [];
}

/** 校验取值集合：未知选项、重复单值选项取最后（值来自命令行，非猜测）。 */
function checkUnknown(flags, allowed) {
  for (const name of flags.keys()) {
    if (!allowed.includes(name)) return `未知选项 ${name}（允许：${allowed.join("、")}）`;
  }
  return null;
}

function parseCli(argv) {
  if (argv.includes("-h") || argv.includes("--help")) return { ok: true, help: true };
  const positionals = [];
  const rest = [];
  let seenSub = false;
  for (const tok of argv) {
    if (!seenSub && !tok.startsWith("-")) {
      positionals.push(tok);
      if (positionals.length === 2) seenSub = true;
      continue;
    }
    rest.push(tok);
  }
  if (positionals.length < 2) {
    return { ok: false, error: "用法：register-interview.mjs <项目根> <append|resolve> [选项…]（-h 查看帮助）" };
  }
  const [rootInput, sub] = positionals;
  if (!["append", "resolve"].includes(sub)) return { ok: false, error: `未知子命令 ${sub}（允许：append、resolve）` };
  const parsed = parseFlags(rest);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, rootInput, sub, flags: parsed.flags };
}

function main(argv) {
  const cli = parseCli(argv);
  if (!cli.ok) {
    process.stderr.write(`register-interview: ${cli.error}\n`);
    return 2;
  }
  if (cli.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const root = resolve(cli.rootInput);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    process.stderr.write(`register-interview: 项目根不存在或不是目录：${root}\n`);
    return 2;
  }

  if (cli.sub === "append") {
    const unknown = checkUnknown(cli.flags, ["--topic", "--summary", "--outcome", "--session-id", "--decisions", "--artifacts"]);
    if (unknown) {
      process.stderr.write(`register-interview: ${unknown}\n`);
      return 2;
    }
    const topic = first(cli.flags, "--topic");
    const summary = first(cli.flags, "--summary");
    const outcome = first(cli.flags, "--outcome");
    if (topic === undefined || topic.trim() === "") {
      process.stderr.write("register-interview: 缺少 --topic（登记主题，不可为空）\n");
      return 2;
    }
    if (summary === undefined || summary.trim() === "") {
      process.stderr.write("register-interview: 缺少 --summary（结论一句话，不可为空）\n");
      return 2;
    }
    if (outcome === undefined || !OUTCOMES.includes(outcome)) {
      process.stderr.write(`register-interview: --outcome 取值须为 ${OUTCOMES.join("|")}（实际 ${String(outcome)}）\n`);
      return 2;
    }
    const decisions = all(cli.flags, "--decisions");
    const artifacts = all(cli.flags, "--artifacts");
    const badArtifact = artifacts.find((a) => a === "" || isAbsolute(a));
    if (badArtifact !== undefined) {
      process.stderr.write(
        `register-interview: --artifacts 须为相对项目根路径（实际 ${JSON.stringify(badArtifact)}；编译器按 <项目根>/<值> 解析）\n`,
      );
      return 2;
    }
    const res = appendEntry(root, {
      sessionId: first(cli.flags, "--session-id") ?? "",
      topic,
      summary,
      decisions,
      artifacts,
      outcome,
    });
    if (!res.ok) {
      process.stderr.write(`register-interview: ${res.error}\n`);
      return 1;
    }
    process.stdout.write(`已登记：${res.entry.id}（${INTERVIEWS_REL}；outcome=${res.entry.outcome}）\n`);
    recompileAfterWrite(root); // B3-3：新访谈即上板（失败不阻塞，主流程照常成功）
    return 0;
  }

  const unknown = checkUnknown(cli.flags, ["--id", "--resolved-by"]);
  if (unknown) {
    process.stderr.write(`register-interview: ${unknown}\n`);
    return 2;
  }
  const id = first(cli.flags, "--id");
  const resolvedBy = first(cli.flags, "--resolved-by");
  if (id === undefined || !INTERVIEW_ID_RE.test(id)) {
    process.stderr.write(`register-interview: --id 形态须为 itw-<日期>-<短后缀>（实际 ${String(id)}）\n`);
    return 2;
  }
  if (resolvedBy === undefined || resolvedBy.trim() === "") {
    process.stderr.write("register-interview: 缺少 --resolved-by（产物对应的特性节点 id，不可为空）\n");
    return 2;
  }
  const res = resolveEntry(root, id, resolvedBy);
  if (!res.ok) {
    process.stderr.write(`register-interview: ${res.error}\n`);
    return 1;
  }
  process.stdout.write(`已回填：${res.entry.id} → resolvedBy=${res.entry.resolvedBy}（status=${res.entry.status}）\n`);
  recompileAfterWrite(root); // B3-3：resolve 同样改写 interviews.json（源）→ 触发重编译
  return 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath !== "" && invokedPath === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
