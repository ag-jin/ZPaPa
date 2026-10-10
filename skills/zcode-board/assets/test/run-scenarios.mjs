#!/usr/bin/env node
/**
 * zcode-board / 场景断言脚本（红→绿同一脚本，测试先行）
 *
 * T6 覆盖（设计 §13 场景 + T6 验收）：
 *   场景 1  空项目 → features: []、diagnostics: []
 *   场景 4  plan 无可识别任务语法 → 0 卡（arranged-not-expanded 归 T7，不在此断言）
 *   场景 7  登记条目 resolvedBy 回填 → interview-only 节点消失、特性节点 origin.interviewId 补全
 *   场景 8  幂等：连续两次编译逐字节一致（时间戳除外）＋（T9 并入）--assign 二次运行幂等、
 *          补登记与高水位前进不静默、首次 assign 写入面 = registry（源零改写）
 *   场景 15 details 提取：tasks.md Scope / plan 正文首行超 200 截断 / 无访谈来源为空串
 *   场景 16 blockers-external：> blocked: 挂上方最近条目；条目之前出现 → 不挂卡 + diagnostics
 *   场景 17 blockers-dependency：blockedBy 稳定号整数；目标不在板上 → 缺省 + diagnostics；
 *          progress blocker summary 匹配任务标题 → 挂该卡，不匹配 → []
 *   场景 21 blocked-by 句柄归一：9 / #9 / ID-9 → 整数；层级标签拒收 + diagnostics
 *   场景 37a/37b（勘误 9d）blocked-by 不可引用双诊断：registry 有条目而板上无 → 文案 A（归档/未上板
 *          提示）；完全未知号 → 文案 B（核对句柄）——两夹具各断言独立文案
 *   场景 33（前半）三目录多源：.zcode/plans、docs/plans、docs/design-notes 全扫、各自成节点；
 *          docs/ 根下其他文件不扫
 *   检查点 3  默认模式对源文件零写入（字节 + mtime 快照对比，含 .zcode/workflows/ 哨兵与 docs 诱饵）
 *   场景 9（diagnostics/降级半场）  损坏源 → diagnostics 非空、子树降级保留标题与 mtime、默认模式不失败
 *   场景 19（号码冲突半场）  同号重复 → 先扫者保留、后到者未领号降级 + diagnostics（不改号）
 *   静态断言  仅 node 内置依赖（无第三方导入）
 *
 * T7 覆盖（派生层：设计 §4.3 状态推导 / §4.5 run 归一 / §8.3–§8.4 段位与缺口）：
 *   场景 2  open/none 访谈登记 → interview-only + interviewed-not-arranged + attentionSummary + 段位待设计
 *   场景 5  spec 全链（progress v3 + tasks.md 半勾）→ 特性 active/段位执行中、任务 pending/completed 混合、
 *          progress 汇总、activity.at → 特性 updatedAt
 *   场景 6  progress 未解除阻塞 → 特性 blocked（statusRule 点名 stage）+ 段位阻塞
 *   场景 18 引用语法断言（schema 级）：golden 通过 board.schema.json 子集校验；引用位全为整数稳定号
 *   场景 24 interrupted-resume + activeRun + 弹窗只携 lastRun 摘要（不合并全史）；done 后缺口清除
 *   场景 25 unmerged-worktree + worktree 字段 + 待合并段位；integrator done + 勾选 → 缺口清除、已完成
 *   场景 30 卡龄：updatedAt = max(源推导, 最新 run.at)；无 run 的陈旧卡保留源 mtime
 *   场景 32 plan-overgrown：61 卡提示、恰 60 卡不提示（阈值取编译器导出常量）
 *   场景 34 pr 字段透传：远程模式非空并回显；本地模式恒为 null
 *   场景 35 归档全链（勘误 10）：Stop 点名"待归档" → 移动源文件 → 板上消失且 sources 不含归档路径、
 *          specs/archive 不当 spec 根（按名排除，F2）→ --assign 改写 registry 指向为归档路径（号/assignedAt
 *          不变）→ 已归档号被 blocked-by 引用走勘误 9d 文案 A → 新条目领 seq+1 → --check 直查通过（note"已归档"）
 *   段位表 七段位逐段断言（v2.1 起"已取消"实产出见场景 36）+ 2 条反向（角色错配不得进"审核中"）
 *   补充   progress.execution 与 tasks.md 勾选数不一致 → diagnostics
 *   场景 39（S2）tasks.md 引用族行（> blocked:/blocked-by:/cancelled:/agents:）不解析 + diagnostics
 *          逐行点名、不挂卡（markers.md §3/§7 反例表：spec 侧阻塞真相源是 progress.json）
 *   派生库  lib/derive.mjs 纯函数契约（deriveStage 七段位 + 纯度 + 角色表）
 *
 * #53 覆盖（契约 v2.3：编译器定点）：
 *   场景 53a 计划稿特性段位随子卡汇总（全完成→已完成 / 半勾→执行中 / 未勾→待办 / 零卡→待设计）；
 *          arranged-not-expanded 判据收窄为零卡；board.md 嵌套任务行透传计划码（第二绿发现 D1）
 *   场景 53b roadmap 占位稿标记：独立/合并注释两形态、plan.roadmap 字段、特性与全部卡段位恒待设计、
 *          非法位置不生效 + diagnostics、--check 非零退出
 *   场景 53c nextAssignee 卡级派生：assignees 序首个无 done run 证据的角色；三绿卡→integrator；全 done→null
 *   派生库  deriveArrangedNotExpanded 判据 / deriveNextAssignee 纯函数契约（红→绿同脚本）
 *
 * #56 覆盖（事实互证检查器：--check 不变量扩展）：
 *   场景 56a 子卡全完成 → 特性 stage=已完成（假板 stage=待办 必咬；正常板零噪声）
 *   场景 56b 有卡不得挂 arranged-not-expanded（roadmap 稿同理；roadmap 压制段位不误报 (a)）
 *   场景 56c board.md 编号形态 ↔ board.json 的 planCode/label 派生（嵌套行深度 ≥2；D1 类回归必咬）
 *   场景 56d stageSummary（如携带）与全板节点 stage 逐项复算相等（错一项必咬；正确零噪声）
 *   事实互证库 lib/fact-invariants.mjs 纯函数契约（四条不变量 + 零噪声 + 纯函数稳定性）
 *
 * #57 覆盖（T5356r 第三绿发现批次；P-1/P-3/S-2 为编排者速修）：
 *   S-1    词表漂移守卫：vocabularySnapshot ↔ derive.STAGE/ATTENTION 与 compile-board.PLAN_CODE_RE 逐项对照
 *   场景 57a TQ-3 --assign 幂等：合并形态 roadmap 头标记零改写；多条合法 roadmap 标记首个生效 + 提示级 diagnostics
 *   场景 57b P-2  roadmap 稿激活迹象（勾选记录 / done-partial run 证据）→ 提示级「建议复核占位标记」；未激活零噪声
 *   场景 57c TQ-1 不变量 (c) 扩面：## 待处理 / ## 待合并 节编号链（walkBoardNodes 渲染位）对照；篡改必咬
 *   场景 53a 追加 S-2 回退守卫：零卡稿 stageRule 无「子卡汇总 0/0」后缀
 *   标记写回库 lib/marker-write.mjs 公开契约（合并形态头标记去重同口径）
 *
 * #66 覆盖（取消终态语义补全；契约 v2.3 补篇，markers.md §3.1/§2.5）：
 *   场景 66a 卡级让位：roadmap 稿中 status=cancelled 的卡段位=已取消（含嵌套；未取消卡仍待设计）
 *   场景 66b 特性级落点：H1 标记行之后、首个非引用行之前的 > cancelled:（与 roadmap 独立注释并存、
 *           合并形态头标记、空原因、多条首条生效）；区域外（空行隔断）仍不解析 + diagnostics
 *   场景 66c 全取消汇总：全部子卡（含嵌套）cancelled → 特性段位=已取消（优先于 roadmap 压制）；
 *           混合态不 rollup、零卡不 rollup
 *
 * #67 覆盖（技能包版本化；P2 分发前置件。版本策略见 SKILL.md §3.7）：
 *   场景 67a --version：单行输出包版本/契约版本/schema 版本（契约从 markers.md 变更段头读、schema 从
 *           board.schema.json x-schemaVersion 读；无项目根、只读、退出码 0）
 *   场景 67b 三处同源（lib/version.mjs SKILL_VERSION 常量）：board.json generatedBy 形态 zcode-board/<包版本>、
 *           SKILL.md 头部版本行同值、schema-check 与子集校验接受三段式（旧两段式拒收）；board.generatedBy
 *           经 --check/结构校验回读一致。A1-5（#80）扩展：包/契约/schema **三版本**在常量、markers 段头、
 *           schema 版本位（x-contractVersion/x-schemaVersion）、读取器（readVersionInfo/formatVersionLine）
 *           与 SKILL.md 映射行各处取值同源互锁（任一处漂移必咬；SKILL.md 为手写位、批收口单飞写入）
 *   场景 67c --manifest：assets/manifest.json 内容寻址（包/契约/schema 版本 + 关键文件 sha256），
 *           --manifest 重新生成（临时副本域）与仓库内 manifest 一致性
 *
 * #69 覆盖（入口守卫符号链接静默失效修复）：
 *   场景 69 入口守卫 realpathSync 归一：经符号链接路径（含链接成分的 argv[1]）调用编译器时主逻辑
 *           照常执行（--version 正常输出）；realpath 直调对照输出逐字节一致
 *   突变 m31  守卫退回 resolve() 直比 → 场景 69 必咬
 *
 * #71 覆盖（嵌套项目工作树路径的 runs 归一与互证对齐；E2-02/E1-V31）：
 *   场景 71 runs 归一接受「<子目录>/.zcode/worktrees/task-<no>」（末段号解析）：嵌套声明 + fs 互证
 *           （子项目根下目录真实存在）→ worktree 字段与 unmerged-worktree 缺口成立、board.md 待合并聚合；
 *           目录缺失 → 降级提示；未知形态（两级嵌套）仍拒收 + diagnostics；同一 run 同一声明落多卡
 *           → 同因合并为一条并点名 run；schema 子集校验接受嵌套形态
 *   派生库  normalizeRuns 两形态接受集 / 拒收集逐条断言（derive-lib）
 *   突变 m32  嵌套子目录段放宽（隐藏目录/穿越进接受集）→ 归一层拒收断言必咬
 *   突变 m33  降级诊断同因合并去掉（逐卡重复噪音）→ 场景 71 合并计数断言必咬
 *
 * #97 覆盖（B1-1 第五不变量：completed 须有该卡 integrator done 证据；对账点名级）：
 *   场景 97a completed 任务卡缺该卡 integrator done 的 run 证据 → 逐条对账点名（非失败级、退出码 0、
 *           不阻塞）；有证据/未完成不点名；删掉 integrator run（红侧突变夹具）→ 该卡必被点名
 *   场景 97b 豁免登记（.zcode/board/exemptions.json，{no, reason, at}，编排者单写者）：合法登记后
 *           点名消失；坏登记（缺 reason / no 非整数 / JSON 解析失败）失败级点名且该条不生效
 *   事实互证库 checkCompletedMergedEvidence 纯函数契约（partial/非 integrator/interrupted 不算证据；
 *           未领号卡不判；豁免按稳定号抑制；纯函数稳定性）
 *   突变 m40  证据集合不再参与判定（有证据卡也被点名）→ 场景 97a 计数断言必咬
 *   突变 m41  豁免集合被忽略（登记后照常点名）→ 场景 97b 点名消失断言必咬
 *
 * #151 覆盖（D2-1：子项目根 worktree 归一化——derive 规范化层；E2-02）：
 *   场景 151 归一化两态夹具（短/长声明 → 板面 worktree=现场实际路径；缺失降级保留声明原文；
 *           同 run 双卡合并点名；零形态拒收噪音）；derive-lib 契约块 resolveWorktree
 *           （exact 优先/后缀归一/多命中确定性/布尔一致性）；场景 42 断言升格为归一后现场路径。
 *
 * #152 覆盖（D2-2：run-event.md 报告口径成文 + --check 卡号绑定断言；E4-09/E1-V31）：
 *   场景 152 卡号绑定（worktree 名 ↔ 卡号一致性）：板面 worktree（#151 归一后的现场实际路径）末段
 *           task-<no> ≠ 该卡稳定号 → 对账点名（非失败级、退出码 0、不阻断）；两形态（短/嵌套归一）
 *           都咬；合规卡（名=号）/目录缺失声明/形态非法声明/未声明 → 不进判定域（零噪声）；
 *           错配声明移除（现场收口）→ 点名自清
 *   突变 m43  卡号绑定判定关掉（末段号不再与卡号对照）→ 场景 152 计数断言必咬
 *
 * E1b-1（#159）覆盖（苗圃位置规则：裁决稿/设计稿/纲领稿禁入 plans/；契约 §11）：
 *   场景 159 苗圃（.zcode/plans/）内裁决稿/设计稿/纲领稿（文件名首段族词或 H1 自称命中）→ --check
 *           对账点名（非失败级、退出码 0、不阻断；点名文案给新位置 .zcode/design/ 与 A5-4 接口）；
 *           正常计划稿（plan-* 命名约定，含标题含族词者）与无法判族名零误报；移位（不改名）至
 *           .zcode/design/ 后点名自清（绿）；design/ 不进扫描面（scan.json 池外引用拒绝、零吸入、
 *           文件零触碰）
 *
 * 用法：
 *   node assets/test/run-scenarios.mjs                 # 全部场景
 *   node assets/test/run-scenarios.mjs --scenario 1,4  # 只跑指定场景
 *   node assets/test/run-scenarios.mjs --clean         # 跑完删除临时夹具目录（默认保留以便留证）
 * 退出码：0 = 全部通过；1 = 有失败。
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  findFileMarker,
  isoLocal,
  lineEndMarker,
  normalizeHandle,
  parseMarkers,
  readJsonFile,
  stripLineEndMarker,
  writeFileAtomic,
  writeJsonAtomic,
} from "../lib/board-io.mjs";

import {
  ALLOWED_OUTPUTS,
  ASSETS_DIR,
  COMPILER,
  SAMPLE_PLAN_E5545AAC,
  SAMPLE_PLAN_F1A2D0BB,
  diffSnapshot,
  isDir,
  isFile,
  newRoot,
  removeRoot,
  sampleText,
  setMtime,
  toPosix,
  treeSnapshot,
  w,
} from "./fixtures/build-fixture.mjs";

import { PLAN_OVERGROWN_THRESHOLD, checkProject } from "../compile-board.mjs";

import { SKILL_MD_PATH, SKILL_VERSION, formatVersionLine, readContractVersion, readSchemaVersion, readVersionInfo } from "../lib/version.mjs";

import { EXEMPTIONS_REL, checkBoardInvariants, checkExemptionsDoc, validateSchemaValue } from "../lib/schema-check.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));

const ISO_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([+-][0-9]{2}:[0-9]{2}|Z)$/;
/** 状态词表（契约 v2.1 起含 cancelled 终态——T21：取消留痕、条目保留、号不复用）。 */
const STATUSES = ["pending", "active", "blocked", "completed", "cancelled"];
/** 七段位词表（T7 §4.3 勘误后用户需求；v2.1 起"已取消"为实产出——T21）。 */
const SEVEN_STAGES = ["待设计", "待办", "执行中", "审核中", "阻塞", "已完成", "已取消"];
const ATTENTION_CODES = [
  "interviewed-not-arranged",
  "arranged-not-expanded",
  "interrupted-resume",
  "unmerged-worktree",
];

// ---------------------------------------------------------------- 输出工具

const lines = [];
function say(s = "") {
  lines.push(s);
  console.log(s);
}

let passCount = 0;
let failCount = 0;
const failedScenarios = new Set();

// ---------------------------------------------------------------- 断言器

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === "object") {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function show(v) {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch {
    return String(v);
  }
}

class Checks {
  constructor(scenario) {
    this.scenario = scenario;
  }

  ok(cond, label, detail = "") {
    if (cond) {
      passCount += 1;
      say(`  PASS  ${label}`);
    } else {
      failCount += 1;
      failedScenarios.add(this.scenario);
      say(`  FAIL  ${label}${detail ? `\n          依据：${detail}` : ""}`);
    }
    return !!cond;
  }

  eq(actual, expected, label) {
    return this.ok(deepEqual(actual, expected), label, `期望 ${show(expected)}；实际 ${show(actual)}`);
  }

  ne(actual, unexpected, label) {
    return this.ok(!deepEqual(actual, unexpected), label, `不应等于 ${show(unexpected)}`);
  }

  inc(haystack, needle, label) {
    const has = typeof haystack === "string" ? haystack.includes(needle) : false;
    return this.ok(has, label, `未在文本中找到 ${show(needle)}`);
  }

  skip(label, reason) {
    say(`  SKIP  ${label}（${reason}）`);
  }
}

// ---------------------------------------------------------------- 夹具断言公用件

function walkNodes(features, fn) {
  const walkTasks = (tasks, ptr) => {
    for (const [i, t] of (tasks ?? []).entries()) {
      fn(t, `${ptr}.tasks[${i}]`);
      walkTasks(t.tasks, `${ptr}.tasks[${i}]`);
    }
  };
  for (const [i, f] of (features ?? []).entries()) {
    fn(f, `features[${i}]`);
    walkTasks(f.tasks, `features[${i}]`);
  }
}

function featureByTitle(board, title) {
  return (board.features ?? []).find((f) => f.title === title) ?? null;
}

function featureByKind(board, kind) {
  return (board.features ?? []).filter((f) => f.kind === kind);
}

function taskByTitle(feature, title) {
  return (feature?.tasks ?? []).find((t) => t.title === title) ?? null;
}

function diagFor(board, path) {
  return (board.diagnostics ?? []).filter((d) => d.path === path);
}

/** 板上活号集合（引用位不变量：blockedBy 必须落在其中）。 */
function liveNumbers(board) {
  const set = new Set();
  walkNodes(board.features, (n) => {
    if (Number.isInteger(n.no)) set.add(n.no);
  });
  return set;
}

/** 夹具写 runs.json（第一方真相；T7 只读，测试作为夹具作者写入）。 */
function seedRuns(root, runs) {
  w(root, ".zcode/board/runs.json", JSON.stringify({ version: 1, runs }, null, 2) + "\n");
}

function readRuns(root) {
  const loaded = readJsonFile(join(root, ".zcode/board/runs.json"));
  return loaded.ok && Array.isArray(loaded.value?.runs) ? loaded.value.runs : [];
}

/** 全板 attention 逐码计数（与 attentionSummary 对照用，独立于实现遍历）。 */
function attentionCounts(board) {
  const counts = Object.fromEntries(ATTENTION_CODES.map((c) => [c, 0]));
  walkNodes(board.features, (n) => {
    for (const code of n.attention ?? []) if (code in counts) counts[code] += 1;
  });
  return counts;
}

/** 全板段位计数（段位表断言用）。 */
function stageCounts(board) {
  const counts = {};
  walkNodes(board.features, (n) => {
    counts[n.stage] = (counts[n.stage] ?? 0) + 1;
  });
  return counts;
}

function maskedRootUpdatedAt(text) {
  return text.replace(/^(\s*)"updatedAt": "[^"]*"/m, '$1"updatedAt": "<编译时刻>"');
}

/** 独立实现的 mtime → 带时区 ISO 8601（断言的独立真值来源，不借实现函数）。 */
function isoFromMtime(absPath) {
  const d = new Date(statSync(absPath).mtimeMs);
  const p = (n) => String(Math.abs(n)).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`
  );
}

function maskedIso(text) {
  return text.replace(
    /[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([+-][0-9]{2}:[0-9]{2}|Z)/g,
    "<TS>",
  );
}

function truncate(s, n = 400) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// ---------------------------------------------------------------- 编译器调用

function runCompiler(root, args = []) {
  const res = spawnSync(process.execPath, [COMPILER, root, ...args], { encoding: "utf8" });
  const boardPath = join(root, ".zcode/board/board.json");
  const mdPath = join(root, ".zcode/board/board.md");
  let board = null;
  let boardText = null;
  let boardError = null;
  if (isFile(boardPath)) {
    boardText = readFileSync(boardPath, "utf8");
    try {
      board = JSON.parse(boardText);
    } catch (e) {
      boardError = e.message;
    }
  } else {
    boardError = "board.json 不存在";
  }
  const mdText = isFile(mdPath) ? readFileSync(mdPath, "utf8") : null;
  return {
    code: res.status,
    signal: res.signal,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    spawnError: res.error ? res.error.message : null,
    board,
    boardText,
    boardError,
    md: mdText,
    boardRel: ".zcode/board/board.json",
    mdRel: ".zcode/board/board.md",
  };
}

// ---------------------------------------------------------------- 公用断言

function commonChecks(c, ctx) {
  const { root, run, board, before, after } = ctx;
  const lastStep = ctx.lastStep ?? { before, after };

  c.ok(
    run.code === 0,
    "编译器退出码为 0（默认只读模式）",
    `退出码 ${run.code}${run.stderr ? `；stderr=${truncate(run.stderr)}` : ""}${run.spawnError ? `；spawn=${run.spawnError}` : ""}`,
  );

  if (!board) {
    c.ok(false, "board.json 存在且可 JSON 解析", run.boardError ?? "未知");
    return false;
  }
  c.ok(true, "board.json 存在且可 JSON 解析");

  c.eq(board.version, 2, "board.version === 2（主版本冻结）");
  c.eq(board.generatedBy, `zcode-board/${SKILL_VERSION}`, "board.generatedBy 由 lib/version.mjs SKILL_VERSION 常量派生（#67 唯一事实源）");
  c.eq(board.project?.root, root, "board.project.root === 传入项目根（绝对路径）");
  c.eq(board.project?.name, basename(root), "board.project.name === 目录名");
  c.ok(ISO_RE.test(board.updatedAt ?? ""), "board.updatedAt 为带时区 ISO 8601", show(board.updatedAt));
  c.ok(Array.isArray(board.features), "board.features 为数组");
  c.ok(Array.isArray(board.diagnostics), "board.diagnostics 为数组");
  c.ok(Array.isArray(board.sources), "board.sources 为数组");
  c.ok(
    board.attentionSummary &&
      ["interviewedNotArranged", "arrangedNotExpanded", "interruptedResume", "unmergedWorktree"].every(
        (k) => Number.isInteger(board.attentionSummary[k]),
      ),
    "attentionSummary 四键均为整数",
    show(board.attentionSummary),
  );

  let shapeOk = true;
  walkNodes(board.features, (node, ptr) => {
    if (!STATUSES.includes(node.status)) {
      shapeOk = false;
      say(`          节点 ${ptr} status 非法：${show(node.status)}`);
    }
    if (typeof node.statusRule !== "string" || node.statusRule.trim() === "") {
      shapeOk = false;
      say(`          节点 ${ptr} statusRule 为空`);
    }
    if (!Array.isArray(node.attention)) {
      shapeOk = false;
      say(`          节点 ${ptr} attention 非数组`);
    }
    if (typeof node.title !== "string" || node.title === "") {
      shapeOk = false;
      say(`          节点 ${ptr} title 为空`);
    }
    if (typeof node.details !== "string") {
      shapeOk = false;
      say(`          节点 ${ptr} details 非字符串`);
    }
  });
  c.ok(shapeOk, "每个节点：status ∈ 词表、statusRule 非空、attention 数组、title 非空、details 字符串");

  let unnumberedOk = true;
  walkNodes(board.features, (node, ptr) => {
    const hasNo = Object.hasOwn(node, "no");
    const hasLabel = Object.hasOwn(node, "label");
    if (hasNo !== hasLabel) {
      unnumberedOk = false;
      say(`          节点 ${ptr} no/label 未同时存在或同时缺省`);
    }
    if (hasNo && (!Number.isInteger(node.no) || node.no < 1)) {
      unnumberedOk = false;
      say(`          节点 ${ptr} no 非正整数：${show(node.no)}`);
    }
  });
  c.ok(unnumberedOk, "未领号缺省形态：no/label 同时存在或同时缺省，no 为正整数");

  let stageOk = true;
  walkNodes(board.features, (node, ptr) => {
    if (!SEVEN_STAGES.includes(node.stage)) {
      stageOk = false;
      say(`          节点 ${ptr} stage 非法：${show(node.stage)}`);
    }
    if (typeof node.stageRule !== "string" || node.stageRule.trim() === "") {
      stageOk = false;
      say(`          节点 ${ptr} stageRule 为空`);
    }
    for (const code of node.attention ?? []) {
      if (!ATTENTION_CODES.includes(code)) {
        stageOk = false;
        say(`          节点 ${ptr} attention 码非法：${show(code)}`);
      }
    }
  });
  c.ok(stageOk, "每个节点：stage ∈ 七段位词表、stageRule 非空、attention 码 ∈ 四码（T7 派生层）");

  const summaryCounts = attentionCounts(board);
  c.eq(
    {
      interviewedNotArranged: summaryCounts["interviewed-not-arranged"],
      arrangedNotExpanded: summaryCounts["arranged-not-expanded"],
      interruptedResume: summaryCounts["interrupted-resume"],
      unmergedWorktree: summaryCounts["unmerged-worktree"],
    },
    board.attentionSummary,
    "attentionSummary 与全板节点 attention 逐码相等（§3.3 不变量）",
  );

  const dupNo = (() => {
    const seen = new Map();
    const dups = [];
    walkNodes(board.features, (node) => {
      if (Number.isInteger(node.no)) {
        if (seen.has(node.no)) dups.push(node.no);
        else seen.set(node.no, true);
      }
    });
    return dups;
  })();
  c.eq(dupNo, [], "活号唯一（板上无重复 no）");

  c.ok(ctx.run.md !== null && ctx.run.md.length > 0, "board.md 已生成（人类可读渲染）");

  // 检查点 3：源零写入（多步骤场景取最后一步的差量：assign 的写面由场景自行断言）
  const diff = diffSnapshot(lastStep.before, lastStep.after, ALLOWED_OUTPUTS);
  const changedUnexpected = diff.changed.filter((x) => !ALLOWED_OUTPUTS.includes(x.rel));
  c.ok(
    changedUnexpected.length === 0,
    "检查点 3：所有既有文件字节与 mtime 不变（源零写入）",
    show(changedUnexpected.map((x) => x.rel)),
  );
  c.ok(diff.removed.length === 0, "检查点 3：无文件被删除", show(diff.removed));
  c.ok(
    diff.added.length === 0,
    "检查点 3：新增文件仅限 .zcode/board/{board.json,board.md}",
    show(diff.added),
  );

  return true;
}

// ---------------------------------------------------------------- 场景定义

const SCENARIOS = [];

function scenario(id, title, spec) {
  SCENARIOS.push({ id, title, ...spec });
}

// ---- 场景 1：空项目
scenario("1", "空项目（无 specs、无 plans、无登记、无 runs）", {
  build(root) {
    w(root, ".zcode/workflows/keep.md", "# 不解析目录哨兵\n\n- **T1 不该被识别的条目**：若被扫描即证明越界。\n");
  },
  assert(c, ctx) {
    const { board, root, run } = ctx;
    c.eq(board.features, [], "空项目 features 为 []");
    c.eq(board.diagnostics, [], "空项目 diagnostics 为 []");
    c.eq(
      board.sources.map((s) => ({ kind: s.kind, path: s.path })),
      [
        { kind: "interviews", path: ".zcode/board/interviews.json" },
        { kind: "registry", path: ".zcode/board/registry.json" },
        { kind: "runs", path: ".zcode/board/runs.json" },
      ],
      "sources[] 完整列出三个第一方源（缺失文件按空源参与编译，§12）",
    );
    c.ok(!JSON.stringify(board).includes("workflows"), "不解析 .zcode/workflows/（board 无其痕迹）");
    c.ok(isFile(join(root, ".zcode/workflows/keep.md")), "哨兵文件仍在（未被触碰/删除）");
    c.inc(run.md, basename(root), "board.md 含项目名");
  },
});

// ---- 场景 4：plan 无可识别任务语法
scenario("4", "plan 无可识别任务语法 → 0 张卡（真实样例 f1a2d0bb 结构副本）", {
  build(root) {
    w(root, `.zcode/plans/${SAMPLE_PLAN_F1A2D0BB}`, sampleText(SAMPLE_PLAN_F1A2D0BB));
  },
  assert(c, ctx) {
    const { board } = ctx;
    const planRel = `.zcode/plans/${SAMPLE_PLAN_F1A2D0BB}`;
    c.eq(board.features.length, 1, "只有一个特性节点");
    const f = board.features[0] ?? {};
    c.eq(f.kind, "plan", "节点 kind === plan");
    c.eq(f.id, "plan:sess_f1a2d0bb-5238-4077-84d2-dae1f5a8f841", "id 由文件名会话 ID 派生");
    c.eq(f.title, "会话按需加载：上拖后台加载时，当前可见内容不许位移", "title = 文件首个标题");
    c.eq(f.tasks, [], "A/B/C 改动节不是任务语法 → 0 张卡");
    c.eq(f.details, "", "无 origin.interviewId 的 plan 特性卡 details 为空串");
    c.ok(!Object.hasOwn(f, "no") && !Object.hasOwn(f, "label"), "未领号：no/label 双缺省");
    c.eq(f.origin?.type, "plan-session", "origin.type === plan-session");
    c.eq(f.origin?.sessionId, "sess_f1a2d0bb-5238-4077-84d2-dae1f5a8f841", "origin.sessionId 取自文件名");
    c.ok(
      board.sources.some((s) => s.kind === "plan" && s.path === planRel),
      "sources[] 含该计划稿（kind=plan）",
    );
    c.ok(diagFor(board, planRel).length > 0, "未领号提示不静默（diagnostics 指向该计划稿）");
    c.ok(Array.isArray(f.attention), "attention 为数组（arranged-not-expanded 码归 T7 派生）");
  },
});

// ---- 场景 7：resolvedBy 回填 → 合并，interview-only 消失
scenario("7", "登记条目 resolvedBy 回填 → interview-only 消失 + 特性节点 origin.interviewId 补全", {
  build(root) {
    const planRel = ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000007.md";
    w(root, planRel, ["# 甲方案", "", "- [ ] 1. 甲任务", "  - 甲任务正文首行。", ""].join("\n"));
    w(
      root,
      ".zcode/board/interviews.json",
      JSON.stringify(
        {
          version: 1,
          interviews: [
            {
              id: "itw-20261009-0007",
              at: "2026-10-09T10:00:00+08:00",
              sessionId: "sess_00000000-0000-4000-8000-000000000007",
              topic: "甲方案讨论",
              summary: "确认甲方案与一项实施任务。",
              decisions: ["先落接口"],
              artifacts: [planRel],
              outcome: "plan",
              resolvedBy: "plan:sess_00000000-0000-4000-8000-000000000007",
              status: "open",
            },
          ],
        },
        null,
        2,
      ) + "\n",
    );
  },
  assert(c, ctx) {
    const { board } = ctx;
    c.eq(board.features.length, 1, "features 仅一个（登记条目已合并，未另成节点）");
    const f = board.features[0] ?? {};
    c.eq(f.id, "plan:sess_00000000-0000-4000-8000-000000000007", "特性节点 id 稳定");
    c.eq(f.origin?.interviewId, "itw-20261009-0007", "origin.interviewId 由 resolvedBy 补全");
    c.eq(
      featureByKind(board, "interview-only").length,
      0,
      "interview-only 节点消失（resolvedBy 命中特性节点）",
    );
    c.eq(f.details, "确认甲方案与一项实施任务。", "details 取登记条目 summary（≤200 截断）");
    c.eq(f.tasks?.length, 1, "计划稿条目仍派生为 1 张 draft 卡");
    c.eq(f.tasks?.[0]?.title, "甲任务", "title 剥离序号前缀");
    c.inc(JSON.stringify(board), "itw-20261009-0007", "登记 id 在板上可见");
  },
});

// ---- 场景 8：幂等（两次编译逐字节一致，时间戳除外）+ T9 并入：--assign 二次运行幂等
scenario("8", "幂等：连续两次编译 board.json 逐字节一致（编译时刻时间戳除外）＋ --assign 二次运行幂等（T9 并入）", {
  runs: 2,
  // T9：两次编译之前先跑两次 --assign（夹具已全带号：首次仅 registry 补登记，二次零写入）
  steps: [{ args: ["--assign"] }, { args: ["--assign"] }, { args: [] }, { args: [] }],
  build(root) {
    w(root, ".zcode/board/registry.json", JSON.stringify({ version: 1, seq: 20, entries: [
      { no: 20, kind: "spec", specRoot: "specs/alpha/", title: "甲特性", assignedAt: "2026-10-08T10:00:00+08:00" },
    ] }, null, 2) + "\n");
    w(root, "specs/alpha/requirements.md", "# Requirements: 甲特性\n");
    w(root, "specs/alpha/tasks.md", ["# Implementation Plan: 甲特性", "", "## Tasks", "",
      "- [ ] 1. 甲任务 <!-- zcode-board: no=21 -->", "  - Scope: 甲任务细节。", "  - Requirements: R1", "",
      "- [x] 2. 乙任务 <!-- zcode-board: no=22 -->", "  - Scope: 乙任务细节。", ""].join("\n"));
    w(root, "specs/alpha/progress.json", JSON.stringify({ version: 3, feature: "甲特性",
      current: { stage: "execution", title: "其他事项" },
      stages: { execution: { status: "active", note: "", evidence: [] }, "code-review": { status: "pending", note: "", evidence: [] } },
      execution: { totalTasks: 2, completedTasks: 1 }, activity: [], blockers: [] }, null, 2) + "\n");
    w(root, ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000008.md",
      ["# 乙方案", "<!-- zcode-board: no=30 -->", "",
       "- **T1 乙甲（草案）**：先落接口。 <!-- zcode-board: no=31 -->",
       "  > blocked-by: 32 —— 等乙乙落地",
       "- **T2 乙乙（草案）**：字段待定。 <!-- zcode-board: no=32 -->", ""].join("\n"));
    w(root, ".zcode/workflows/keep.md", "# 哨兵\n");
    setMtime(root, ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000008.md", "2026-01-02T03:04:05");
  },
  assert(c, ctx) {
    const [r1, r2] = ctx.runs;
    // T9 并入：--assign 二次运行幂等
    {
      const [a1, a2] = ctx.assigns;
      c.eq([a1?.code, a2?.code], [0, 0], "--assign 两次均退出码 0");
      const diffA = diffSnapshot(a1.after, a2.after);
      c.eq(
        diffA.changed.map((x) => x.rel).filter((rel) => !ALLOWED_OUTPUTS.includes(rel)),
        [],
        "第二次 --assign 零写入（源文件与 registry 无字节变化；board 产物按定义重写）",
      );
      c.eq(diffA.added, [], "第二次 --assign 无新增文件");
      c.eq(diffA.removed, [], "第二次 --assign 无删除文件");
      const diffFirst = diffSnapshot(ctx.before, a1.after, ALLOWED_OUTPUTS);
      c.eq(
        diffFirst.changed.map((x) => x.rel).filter((rel) => !ALLOWED_OUTPUTS.includes(rel)),
        [".zcode/board/registry.json"],
        "首次 --assign 的写入面 = registry 补登记（源头标记已全在，零改写）",
      );
      const reg = readJsonFile(join(ctx.root, ".zcode/board/registry.json"));
      c.eq(reg.value?.seq, 32, "首次 assign：seq 前进到已发最大号 32（高水位只增）");
      c.ok(
        [21, 22, 30, 31, 32].every((no) => (reg.value?.entries ?? []).some((e) => e.no === no)),
        "首次 assign：源头标记号未登记者全部补登记（采纳标记为身份真相）",
        show((reg.value?.entries ?? []).map((e) => e.no)),
      );
      c.ok(
        ["21", "30", "32"].every((n) => a1.stderr.includes(n)) && /跳号/.test(a1.stderr),
        "补登记与高水位前进不静默（diagnostics 逐号点名 + 跳号警示）",
        a1.stderr.trim().slice(0, 300),
      );
    }
    c.eq([r1.code, r2.code], [0, 0], "两次编译均退出码 0");
    c.ok(r1.boardText && r2.boardText, "两次编译均产出 board.json");
    c.eq(
      maskedRootUpdatedAt(r2.boardText ?? ""),
      maskedRootUpdatedAt(r1.boardText ?? ""),
      "board.json 两次编译逐字节一致（仅编译时刻 updatedAt 掩码）",
    );
    c.eq(maskedIso(r2.md ?? ""), maskedIso(r1.md ?? ""), "board.md 两次编译一致（时间戳掩码）");
    const b = r2.board ?? {};
    c.ok(ISO_RE.test(b.updatedAt ?? ""), "root updatedAt 为编译时刻 ISO");
    c.eq(b.features?.length, 2, "两个特性节点（spec + plan）");
    const alpha = featureByTitle(b, "甲特性");
    c.eq(alpha?.no, 20, "spec 特性号来自 registry 绑定");
    c.eq(alpha?.label, "20", "特性 label = 稳定号字符串");
    c.eq(taskByTitle(alpha, "甲任务")?.no, 21, "任务号来自行尾标记");
    c.eq(taskByTitle(alpha, "甲任务")?.label, "20.1", "任务 label 按树位派生");
    c.eq(taskByTitle(alpha, "乙任务")?.label, "20.2", "任务 label 按树位派生（第 2 位）");
    const beta = featureByTitle(b, "乙方案");
    c.eq(beta?.no, 30, "plan 特性号来自文件头标记");
    c.eq(taskByTitle(beta, "乙甲（草案）")?.no, 31, "plan 条目号来自行尾标记");
    c.eq(taskByTitle(beta, "乙乙（草案）")?.label, "2", "plan 条目 label 按计划内树位派生（#46 A2：顶层 1..n）");
    // 独立真值：节点时间戳必须取自源文件 mtime（非墙钟）——测试自带 ISO 格式化，不借实现
    const planAbs = join(ctx.root, ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000008.md");
    c.eq(beta?.updatedAt, isoFromMtime(planAbs), "节点 updatedAt 派生自源文件 mtime（非编译墙钟）");
  },
});

// ---- 场景 15：details 提取
let LONG_FIXTURE = "";

scenario("15", "details 提取：tasks.md Scope / plan 正文首行超 200 截断 / 无访谈来源为空串", {
  build(root) {
    w(root, "specs/alpha/requirements.md", "# Requirements: Alpha 特性\n");
    w(root, "specs/alpha/tasks.md", ["# Implementation Plan: Alpha",
      "", "## Tasks", "",
      "- [ ] 1. 第一项", "  - Scope: 第一项的细节摘要。", "  - Changes: 无", "  - Requirements: R1, R2", "  - Validation: 跑测试", "",
      "- [x] 2. 第二项", "  - Scope: 第二项细节。", ""].join("\n"));
    const LONG = `${"预览发布通道的正文首行说明：".repeat(1)}${"细节".repeat(120)}。`;
    LONG_FIXTURE = LONG;
    w(root, ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000015.md",
      ["# 详情提取夹具", "", `- **T1 长正文条目（草案）**：${LONG}`, "- **T2 无正文条目（草案）**", ""].join("\n"));
  },
  assert(c, ctx) {
    const { board } = ctx;
    const alpha = featureByTitle(board, "Alpha 特性");
    c.ok(alpha !== null, "spec 特性 title 取自 requirements.md 首个标题（剥 Requirements: 前缀）");
    c.eq(alpha?.kind, "spec", "节点 kind === spec");
    const t1 = taskByTitle(alpha, "第一项");
    const t2 = taskByTitle(alpha, "第二项");
    c.eq(t1?.details, "第一项的细节摘要。", "tasks.md 任务卡 details 取 Scope: 行");
    c.eq(t1?.requirements, ["R1", "R2"], "Requirements: 行 → requirements[]");
    c.eq(t1?.status, "pending", "未勾选 → pending");
    c.eq(t1?.statusRule, "tasks.md checkbox unchecked（仅反映已合并部分，6.3）", "statusRule 与 golden 词汇一致");
    c.eq(t2?.status, "completed", "已勾选 → completed");
    c.eq(t2?.statusRule, "tasks.md checkbox checked（勾选=已合并，6.3）", "statusRule 与 golden 词汇一致");
    c.eq(t1?.source, { file: "specs/alpha/tasks.md", selector: "task-1" }, "source = 文件 + task-N 选择子");

    const plan = featureByTitle(board, "详情提取夹具");
    c.eq(plan?.details, "", "无访谈来源的 plan 特性卡 details 为空串");
    const p1 = taskByTitle(plan, "长正文条目（草案）");
    c.ok(typeof p1?.details === "string" && p1.details.length <= 200, "长正文 details ≤ 200 字符", `长度 ${p1?.details?.length}`);
    c.ok(p1?.details?.endsWith("…") === true, "超长截断以省略号结尾");
    c.eq(p1?.details, `${LONG_FIXTURE.slice(0, 199)}…`, "截断 = 前 199 字符 + 省略号（独立于实现计算）");
    c.eq(taskByTitle(plan, "无正文条目（草案）")?.details, "", "无正文 → details 空串");
    c.eq(
      board.sources.find((s) => s.kind === "spec")?.files,
      ["tasks.md"],
      "spec sources.files 只列存在的源文件（无 progress.json）",
    );
  },
});

// ---------------------------------------------------------------- 场景 16：blockers-external 与归属
scenario("16", "blockers-external：> blocked: 挂上方最近条目；条目之前出现 → 不挂卡 + diagnostics", {
  build(root) {
    w(root, ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000016.md",
      ["# 外部阻塞夹具", "",
       "> blocked: 出现在任何任务条目之前的原因行", "",
       "- **T1 甲条目（草案）**：甲正文。", "- **T2 乙条目（草案）**：乙正文。",
       "  > blocked: 上游标签规则未定，字段待确认", ""].join("\n"));
  },
  assert(c, ctx) {
    const { board } = ctx;
    const planRel = ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000016.md";
    const f = featureByTitle(board, "外部阻塞夹具");
    c.ok(f !== null, "计划稿成特性节点");
    const t1 = taskByTitle(f, "甲条目（草案）");
    const t2 = taskByTitle(f, "乙条目（草案）");
    c.eq(t1?.blockers, [], "上方无引用行的条目 blockers 为空");
    c.eq(
      t2?.blockers,
      [{ kind: "external", summary: "上游标签规则未定，字段待确认", evidence: [planRel] }],
      "> blocked: 归为 external 并挂到上方最近条目，evidence 指向计划路径",
    );
    const ds = diagFor(board, planRel);
    c.ok(
      ds.some((d) => d.message.includes("位置无效")),
      "条目之前的引用行 → diagnostics 提示语法位置无效（不静默）",
      show(ds.map((d) => d.message)),
    );
    c.ok(
      ds.some((d) => d.message.includes("未领号")),
      "未领号条目仍有提示级 diagnostics",
      show(ds.map((d) => d.message)),
    );
  },
});

// ---- 场景 17：blockers-dependency 与归属 + progress blocker 匹配
scenario("17", "blockers-dependency：稳定号引用有效；目标不在板上 → 缺省 + diagnostics；progress blocker 按标题匹配挂卡", {
  build(root) {
    w(root, ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000017.md",
      ["# 依赖归一笔录", "<!-- zcode-board: no=10 -->", "",
       "- **T1 甲（草案）**：甲正文。 <!-- zcode-board: no=11 -->",
       "  > blocked-by: 12 —— 等乙落地后再合并",
       "- **T2 乙（草案）**：乙正文。 <!-- zcode-board: no=12 -->",
       "- **T3 丙（草案）**：丙正文。 <!-- zcode-board: no=13 -->",
       "  > blocked-by: 777 —— 等已完成事项", ""].join("\n"));
    w(root, "specs/beta/requirements.md", "# Requirements: Beta 特性\n");
    w(root, "specs/beta/tasks.md", ["# Implementation Plan: Beta", "", "## Tasks", "",
      "- [ ] 1. 预览发布通道（workflow）", "  - Scope: 甲。", "",
      "- [ ] 2. 让开关立刻生效（核心）", "  - Scope: 乙。", "",
      "- [ ] 3. 无关任务", "  - Scope: 丙。", ""].join("\n"));
    w(root, "specs/beta/progress.json", JSON.stringify({
      version: 3,
      feature: "Beta 特性",
      current: { stage: "execution", title: "其他事项" },
      stages: { execution: { status: "active", note: "", evidence: [] }, "code-review": { status: "pending", note: "", evidence: [] } },
      execution: { totalTasks: 3, completedTasks: 0 },
      activity: [],
      blockers: [
        { id: "B1", stage: "execution", summary: "1. 预览发布通道（workflow）—— 待验证 dev", owner: "用户", evidence: ["specs/beta/notes.md"] },
        { id: "B2", stage: "execution", summary: "完全不匹配的阻塞原因", owner: "用户", evidence: [] },
        { id: "B3", stage: "execution", summary: "让开关立刻生效（核心）", owner: "用户", evidence: [] },
      ],
    }, null, 2) + "\n");
  },
  assert(c, ctx) {
    const { board } = ctx;
    const planRel = ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000017.md";
    const f = featureByTitle(board, "依赖归一笔录");
    c.eq(f?.no, 10, "文件头标记 → 特性号 10");
    const jia = taskByTitle(f, "甲（草案）");
    c.eq(
      jia?.blockers,
      [{ kind: "dependency", blockedBy: 12, summary: "等乙落地后再合并", evidence: [planRel] }],
      "> blocked-by: 12 → blockedBy 为稳定号整数（在板上）",
    );
    const bing = taskByTitle(f, "丙（草案）");
    c.eq(bing?.blockers?.length, 1, "目标不在板上的引用仍保留一条 blocker");
    c.ok(
      bing?.blockers?.[0]?.kind === "dependency" && !Object.hasOwn(bing.blockers[0], "blockedBy"),
      "目标号不在板上 → blockedBy 缺省（不造引用）",
      show(bing?.blockers?.[0]),
    );
    c.eq(bing?.blockers?.[0]?.summary, "等已完成事项", "缺省 blockedBy 时 summary 原文保留");
    c.ok(
      diagFor(board, planRel).some((d) => d.message.includes("777")),
      "诊断点名缺失目标号 777（不静默）",
      show(diagFor(board, planRel).map((d) => d.message)),
    );

    const beta = featureByTitle(board, "Beta 特性");
    c.eq(beta?.progress, { totalTasks: 3, completedTasks: 0 }, "progress 汇总取自 progress.json execution");
    const p1 = taskByTitle(beta, "预览发布通道（workflow）");
    c.eq(p1?.blockers?.length, 1, "progress blocker（含 N. 前缀）挂到匹配任务卡");
    c.eq(p1?.blockers?.[0]?.kind, "external", "progress blocker 归为 external");
    c.eq(
      p1?.blockers?.[0]?.summary,
      "1. 预览发布通道（workflow）—— 待验证 dev",
      "progress blocker summary 原文照抄",
    );
    c.ok(
      p1?.blockers?.[0]?.evidence?.includes("specs/beta/progress.json"),
      "progress blocker evidence 指向 progress.json",
      show(p1?.blockers?.[0]?.evidence),
    );
    const p2 = taskByTitle(beta, "让开关立刻生效（核心）");
    c.eq(p2?.blockers?.length, 1, "progress blocker summary 与任务标题精确匹配 → 挂该卡");
    const p3 = taskByTitle(beta, "无关任务");
    c.eq(p3?.blockers, [], "progress blocker 不匹配任何任务标题 → 任务卡 blockers: []");
    const allSummaries = JSON.stringify(board);
    c.ok(!allSummaries.includes("完全不匹配的阻塞原因"), "不匹配的 blocker 不挂任何任务卡");
  },
});

// ---- 场景 21：blocked-by 句柄归一
scenario("21", "blocked-by 句柄归一：9 / #9 / ID-9 → 整数；层级标签拒收 + diagnostics", {
  build(root) {
    w(root, ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000021a.md",
      ["# 句柄归一", "<!-- zcode-board: no=1 -->", "",
       "- **T1 甲**：甲。 <!-- zcode-board: no=2 -->", "  > blocked-by: 9",
       "- **T2 乙**：乙。 <!-- zcode-board: no=3 -->", "  > blocked-by: #9",
       "- **T3 丙**：丙。 <!-- zcode-board: no=4 -->", "  > blocked-by: ID-9",
       "- **T4 丁**：丁。 <!-- zcode-board: no=5 -->", "  > blocked-by: 1.2 —— 顺序依赖（标签写法）", ""].join("\n"));
    w(root, ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000021b.md",
      ["# 目标九", "<!-- zcode-board: no=9 -->", "",
       "- **T1 戊**：戊。 <!-- zcode-board: no=10 -->", ""].join("\n"));
  },
  assert(c, ctx) {
    const { board } = ctx;
    const planRel = ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000021a.md";
    const nine = featureByTitle(board, "目标九");
    c.eq(nine?.no, 9, "被引用目标在板上（no=9）");
    const f = featureByTitle(board, "句柄归一");
    for (const [title, handle] of [["甲", "9"], ["乙", "#9"], ["丙", "ID-9"]]) {
      const t = taskByTitle(f, title);
      c.eq(t?.blockers?.[0]?.blockedBy, 9, `> blocked-by: ${handle} 归一为整数 9`);
      c.eq(t?.blockers?.[0]?.kind, "dependency", `> blocked-by: ${handle} 归为 dependency`);
    }
    const ding = taskByTitle(f, "丁");
    c.ok(
      ding?.blockers?.[0]?.kind === "dependency" && !Object.hasOwn(ding.blockers[0], "blockedBy"),
      "层级标签 1.2 不解析为引用（blockedBy 缺省）",
      show(ding?.blockers),
    );
    c.eq(ding?.blockers?.[0]?.summary, "顺序依赖（标签写法）", "拒收时 summary 原文保留");
    const ds = diagFor(board, planRel);
    c.ok(
      ds.some((d) => d.message.includes("1.2") && d.message.includes("层级标签")),
      "诊断点名层级标签写法（不静默改写）",
      show(ds.map((d) => d.message)),
    );
    c.eq(
      ds.filter((d) => d.message.includes("层级标签")).length,
      1,
      "三种合法写法（9/#9/ID-9）不产生层级标签诊断",
    );
  },
});

// ---- 场景 37a：blocked-by 不可引用双诊断（勘误 9d 文案 A：registry 有条目而板上无）
scenario("37a", "blocked-by 双诊断文案 A：目标号在 registry 有条目但不在板上 → 不造引用 + 归档/未上板提示", {
  build(root) {
    w(root, ".zcode/board/registry.json", JSON.stringify({
      version: 1,
      seq: 41,
      entries: [
        { no: 41, kind: "task", file: ".zcode/archive/plan-old.md", title: "已归档的旧卡", assignedAt: "2026-09-30T10:00:00+08:00" },
      ],
    }, null, 2) + "\n");
    w(root, ".zcode/plans/plan-sess_00000000-0000-4000-8000-00000000037a.md",
      ["# 归档引用夹具", "<!-- zcode-board: no=10 -->", "",
       "- **T1 引用方（草案）**：引用已归档的号。 <!-- zcode-board: no=11 -->",
       "  > blocked-by: 41 —— 等归档卡回收", ""].join("\n"));
  },
  assert(c, ctx) {
    const { board } = ctx;
    const planRel = ".zcode/plans/plan-sess_00000000-0000-4000-8000-00000000037a.md";
    c.ok(!liveNumbers(board).has(41), "目标号 41 不在板上活条目（registry 条目为归档空洞，编译合法）");
    const f = featureByTitle(board, "归档引用夹具");
    const t = taskByTitle(f, "引用方（草案）");
    c.ok(
      t?.blockers?.[0]?.kind === "dependency" && !Object.hasOwn(t.blockers[0], "blockedBy"),
      "不造引用：dependency 保留且 blockedBy 缺省",
      show(t?.blockers),
    );
    c.eq(t?.blockers?.[0]?.summary, "等归档卡回收", "summary 原文保留");
    const msgs = diagFor(board, planRel).map((d) => d.message);
    const msg = msgs.find((m) => m.includes("41")) ?? "";
    c.ok(
      msg.includes("registry") && (msg.includes("归档") || msg.includes("未上板")),
      "文案 A：点名 registry 有条目但未上板，提示检查目标是否已归档/未上板",
      show(msgs),
    );
    c.ok(!msg.includes("未知号"), "文案 A 与未知号文案独立（不混用）", show(msg));
  },
});

// ---- 场景 37b：blocked-by 不可引用双诊断（勘误 9d 文案 B：完全未知号）
scenario("37b", "blocked-by 双诊断文案 B：目标号不在 registry（完全未知号）→ 不造引用 + 核对句柄提示", {
  build(root) {
    w(root, ".zcode/board/registry.json", JSON.stringify({
      version: 1,
      seq: 41,
      entries: [
        { no: 41, kind: "task", file: ".zcode/archive/plan-old.md", title: "已归档的旧卡", assignedAt: "2026-09-30T10:00:00+08:00" },
      ],
    }, null, 2) + "\n");
    w(root, ".zcode/plans/plan-sess_00000000-0000-4000-8000-00000000037b.md",
      ["# 未知号夹具", "<!-- zcode-board: no=10 -->", "",
       "- **T1 引用方（草案）**：引用一个从未存在的号。 <!-- zcode-board: no=11 -->",
       "  > blocked-by: 8888 —— 等不存在的卡", ""].join("\n"));
  },
  assert(c, ctx) {
    const { board } = ctx;
    const planRel = ".zcode/plans/plan-sess_00000000-0000-4000-8000-00000000037b.md";
    c.ok(!liveNumbers(board).has(8888), "目标号 8888 不在板上活条目");
    const f = featureByTitle(board, "未知号夹具");
    const t = taskByTitle(f, "引用方（草案）");
    c.ok(
      t?.blockers?.[0]?.kind === "dependency" && !Object.hasOwn(t.blockers[0], "blockedBy"),
      "不造引用：dependency 保留且 blockedBy 缺省",
      show(t?.blockers),
    );
    c.eq(t?.blockers?.[0]?.summary, "等不存在的卡", "summary 原文保留");
    const msgs = diagFor(board, planRel).map((d) => d.message);
    const msg = msgs.find((m) => m.includes("8888")) ?? "";
    c.ok(
      msg.includes("未知号") && msg.includes("句柄"),
      "文案 B：点名完全未知号，提示核对句柄写法",
      show(msgs),
    );
    c.ok(!msg.includes("归档"), "文案 B 与 registry 有条目文案独立（不混用）", show(msg));
  },
});

// ---- 场景 19（号码冲突半场）：同号重复 → 先扫者保留、后到者未领号降级 + diagnostics
scenario("19h", "号码冲突半场：两个条目同号 → 先到者保留、后到者按未领号降级 + diagnostics（不改号）", {
  build(root) {
    w(root, ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000019.md",
      ["# 冲突夹具", "<!-- zcode-board: no=5 -->", "",
       "- **T1 先到（草案）**：先到者。 <!-- zcode-board: no=6 -->",
       "- **T2 后到（草案）**：后到者。 <!-- zcode-board: no=6 -->", ""].join("\n"));
  },
  assert(c, ctx) {
    const { board } = ctx;
    const planRel = ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000019.md";
    const f = featureByTitle(board, "冲突夹具");
    c.eq(f?.no, 5, "特性号不受影响");
    const first = taskByTitle(f, "先到（草案）");
    const second = taskByTitle(f, "后到（草案）");
    c.eq(first?.no, 6, "先扫者保留号 6");
    c.ok(
      !Object.hasOwn(second ?? {}, "no") && !Object.hasOwn(second ?? {}, "label"),
      "后到者按未领号降级（no/label 双缺省，不静默改写）",
      show(second),
    );
    c.ok(
      diagFor(board, planRel).some((d) => d.message.includes("6") && d.message.includes("重复")),
      "号码冲突 diagnostics 点名（不静默）",
      show(diagFor(board, planRel).map((d) => d.message)),
    );
  },
});

// ---- 场景 33（前半）：三目录多源（#72 起 docs 两目录为 opt-in 扫描面——本夹具显式开启，覆盖不弱化）
scenario("33", "三目录多源：.zcode/plans 默认扫 + docs/plans、docs/design-notes opt-in（scan.json）后全扫；docs/ 根其他文件不扫", {
  build(root) {
    w(root, `.zcode/plans/${SAMPLE_PLAN_E5545AAC}`, sampleText(SAMPLE_PLAN_E5545AAC));
    w(root, "docs/plans/plan-payment-split.md", ["# 支付拆分（旧稿）", "",
      "- **T1 拆出支付回调服务（草案）**：先落接口。", "- **T2 回调幂等键（草案）**：字段待定。", ""].join("\n"));
    w(root, "docs/design-notes/plan-legacy.md", ["# 旧项目票计划", "",
      "- [ ] 1. 遗留事项", "  - Scope: 旧稿细节。", ""].join("\n"));
    w(root, "docs/notes.md", "# 不该被扫描的 docs 根文件\n\n- **T1 诱饵条目**：不应出现在板上。\n");
    w(root, ".zcode/workflows/keep.md", "# 哨兵\n");
    w(root, ".zcode/board/scan.json", JSON.stringify({ includeDirs: ["docs/plans", "docs/design-notes"] }, null, 2) + "\n");
  },
  assert(c, ctx) {
    const { board, root } = ctx;
    const planSources = board.sources.filter((s) => s.kind === "plan").map((s) => s.path);
    c.eq(
      planSources,
      [
        `.zcode/plans/${SAMPLE_PLAN_E5545AAC}`,
        "docs/plans/plan-payment-split.md",
        "docs/design-notes/plan-legacy.md",
      ],
      "opt-in 后三类计划目录各成 sources[] 条目（确定性顺序：苗圃 → docs/plans → docs/design-notes）",
    );
    c.eq(board.sources.filter((s) => s.kind === "spec").length, 0, "无 specs 目录 → 无 spec 源");
    c.eq(board.features.length, 3, "三份计划稿 → 三个特性节点");
    c.ok(featureByTitle(board, "预览通道（Preview Channel）实现方案 · v3") !== null, "苗圃稿（真实样例副本）成节点");
    c.ok(featureByTitle(board, "支付拆分（旧稿）") !== null, "docs/plans 稿成节点");
    c.ok(featureByTitle(board, "旧项目票计划") !== null, "docs/design-notes 稿成节点");
    c.eq(featureByTitle(board, "支付拆分（旧稿）")?.id, "plan:plan-payment-split", "非 plan-sess_ 命名 → id = plan:<文件名主干>");
    c.eq(featureByTitle(board, "旧项目票计划")?.id, "plan:plan-legacy", "identity 由文件身份派生（不靠目录）");
    c.ok(!JSON.stringify(board).includes("诱饵"), "docs/ 根目录其他文件不扫（诱饵条目不在板上）");
    c.ok(!JSON.stringify(board).includes("workflows"), "不解析 .zcode/workflows/");
    c.ok(isFile(join(root, "docs/notes.md")), "诱饵文件仍在（未被触碰）");

    const real = featureByTitle(board, "预览通道（Preview Channel）实现方案 · v3");
    const titles = (real?.tasks ?? []).map((t) => t.title);
    c.eq(
      titles,
      ["预览发布通道（workflow）", "让开关立刻生效（核心）", "通道可见 + 版本序语义", "文档 + 死代码"],
      "真实样例 T1–T4 识别为 4 张草案卡，title 剥离 T 前缀",
    );
    c.ok((real?.tasks ?? []).every((t) => t.draft === true), "plan 条目派生卡 draft: true");
  },
});

// ---- 场景 9（diagnostics/降级半场）
scenario("9h", "降级半场：损坏源 → diagnostics 非空、子树降级保留标题与 mtime、默认模式不失败", {
  build(root) {
    w(root, "specs/gamma/requirements.md", "# Requirements: Gamma 特性\n");
    w(root, "specs/gamma/tasks.md", ["# Implementation Plan: Gamma", "", "## Tasks", "",
      "- [ ] 1. 甲任务", "  - Scope: 甲细节。", "",
      "- [x] 2. 乙任务", "  - Scope: 乙细节。", ""].join("\n"));
    w(root, "specs/gamma/progress.json", "{ 这不是合法 JSON —— 版本字段与结构都不存在\n");
    w(root, ".zcode/board/interviews.json", "{ 同样损坏的登记簿\n");
  },
  assert(c, ctx) {
    const { board } = ctx;
    const progressRel = "specs/gamma/progress.json";
    c.ok(diagFor(board, progressRel).length > 0, "progress.json 解析失败 → diagnostics 非空（不静默）");
    c.ok(diagFor(board, ".zcode/board/interviews.json").length > 0, "interviews.json 解析失败 → diagnostics 非空");
    const gamma = featureByTitle(board, "Gamma 特性");
    c.ok(gamma !== null, "损坏源子树保留：节点仍在（标题可解析）");
    c.eq(gamma?.kind, "spec", "降级节点 kind 保留");
    c.eq(gamma?.tasks?.length, 2, "同目录 tasks.md 仍正常解析（子树级降级，不整体丢弃）");
    c.ok(ISO_RE.test(gamma?.updatedAt ?? ""), "降级节点保留 mtime 派生的 updatedAt", show(gamma?.updatedAt));
    c.ok(typeof gamma?.statusRule === "string" && gamma.statusRule.length > 0, "降级节点 statusRule 写明原因");
    c.eq(featureByKind(board, "interview-only").length, 0, "损坏的登记簿不产生节点（按空登记簿处置）");
  },
});

// ---------------------------------------------------------------- T7 场景（派生层）

/** golden 是否在某节点上携带该字段（场景 18 覆盖清单）。 */
function goldenHasKey(board, key) {
  let found = false;
  walkNodes(board.features, (n) => {
    if (Object.hasOwn(n, key)) found = true;
  });
  return found;
}

// ---- 场景 2：open/none 访谈登记 → interview-only + interviewed-not-arranged
scenario("2", "只有 open/none 访谈登记 → interview-only 节点 + interviewed-not-arranged + 段位待设计", {
  build(root) {
    const planRel = ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000002.md";
    w(root, planRel, ["# 已安排计划", "", "- [ ] 1. 计划条目", "  - 条目正文。", ""].join("\n"));
    w(
      root,
      ".zcode/board/interviews.json",
      JSON.stringify(
        {
          version: 1,
          interviews: [
            {
              id: "itw-20261009-0001",
              at: "2026-10-09T10:00:00+08:00",
              sessionId: "sess_0002",
              topic: "面板分组与过滤",
              summary: "确认分组与过滤；尚未产出任何文件。",
              decisions: ["先落契约"],
              artifacts: [],
              outcome: "none",
              status: "open",
            },
            {
              id: "itw-20261009-0002",
              at: "2026-10-09T11:00:00+08:00",
              sessionId: "sess_0002",
              topic: "产物丢失的访谈",
              summary: "产物路径已登记但文件不存在。",
              decisions: [],
              artifacts: ["docs/plans/plan-lost.md"],
              outcome: "plan",
              status: "open",
            },
            {
              id: "itw-20261009-0003",
              at: "2026-10-09T09:00:00+08:00",
              sessionId: "sess_0002",
              topic: "已回填的访谈",
              summary: "已由计划稿承接。",
              decisions: [],
              artifacts: [planRel],
              outcome: "plan",
              resolvedBy: "plan:sess_00000000-0000-4000-8000-000000000002",
              status: "open",
            },
          ],
        },
        null,
        2,
      ) + "\n",
    );
  },
  assert(c, ctx) {
    const { board, run } = ctx;
    c.eq(board.features.length, 3, "features = 1 计划节点 + 2 interview-only 节点");

    const openNone = featureByTitle(board, "面板分组与过滤");
    c.eq(openNone?.kind, "interview-only", "open/none 登记 → interview-only 节点");
    c.eq(openNone?.status, "pending", "interview-only 状态 pending（§4.3 规则 4）");
    c.eq(openNone?.statusRule, "interview.status=open 且 outcome=none（无产物）", "statusRule 与 golden 词汇一致");
    c.eq(openNone?.attention, ["interviewed-not-arranged"], "挂 interviewed-not-arranged");
    c.eq(openNone?.stage, "待设计", "段位 = 待设计（节点带 interviewed-not-arranged）");
    c.inc(openNone?.stageRule ?? "", "interviewed-not-arranged", "stageRule 溯源到缺口码");

    const lost = featureByTitle(board, "产物丢失的访谈");
    c.eq(lost?.kind, "interview-only", "产物缺失 → 退回 interview-only（§12）");
    c.eq(lost?.attention, ["interviewed-not-arranged"], "产物缺失的访谈同样挂缺口码（宁误报不漏报）");
    c.ok(
      diagFor(board, ".zcode/board/interviews.json").some((d) => d.message.includes("itw-20261009-0002")),
      "产物缺失进 diagnostics（不静默）",
      show(diagFor(board, ".zcode/board/interviews.json").map((d) => d.message)),
    );

    const merged = featureByTitle(board, "已安排计划");
    c.eq(merged?.origin?.interviewId, "itw-20261009-0003", "resolvedBy 命中的登记条目不另成节点");
    c.eq(
      merged?.attention,
      [],
      "计划卡已有派生卡（#53 契约 v2.3 判据收窄：plan 判零卡）→ 不再误挂 arranged-not-expanded",
    );
    c.eq(merged?.stage, "待办", "段位按原推导（status=pending 且无 activeRun）→ 待办");
    c.inc(merged?.stageRule ?? "", "子卡汇总 0/1", "stageRule 溯源子卡汇总 N/M（契约 v2.3）");

    c.eq(
      board.attentionSummary,
      { interviewedNotArranged: 2, arrangedNotExpanded: 0, interruptedResume: 0, unmergedWorktree: 0 },
      "attentionSummary 逐码计数正确（仅两份访谈登记挂缺口）",
    );
    c.inc(run.md, "已访谈，尚未落卡", "board.md 渲染缺口固定文案（§8.4）");
    c.inc(run.md, "待设计", "board.md 渲染段位");
  },
});

// ---- 场景 5：spec 全链（progress v3 + tasks.md 半勾）
scenario("5", "spec 全链：progress v3 + tasks.md 半勾 → 特性 active/执行中、任务混合、progress 汇总与 activity 时间戳", {
  build(root) {
    w(root, "specs/preview/requirements.md", "# Requirements: 预览特性\n");
    w(root, ".zcode/board/registry.json", JSON.stringify({
      version: 1,
      seq: 50,
      entries: [{ no: 50, kind: "spec", specRoot: "specs/preview/", title: "预览特性", assignedAt: "2026-01-05T08:00:00+08:00" }],
    }, null, 2) + "\n");
    w(
      root,
      "specs/preview/tasks.md",
      [
        "# Implementation Plan: 预览特性",
        "",
        "## Tasks",
        "",
        "- [ ] 1. 甲任务 <!-- zcode-board: no=51 -->",
        "  - Scope: 甲细节。",
        "",
        "- [x] 2. 乙任务 <!-- zcode-board: no=52 -->",
        "  - Scope: 乙细节。",
        "",
        "- [ ] 3. 丙任务 <!-- zcode-board: no=53 -->",
        "  - Scope: 丙细节。",
        "",
      ].join("\n"),
    );
    w(
      root,
      "specs/preview/progress.json",
      JSON.stringify(
        {
          version: 3,
          feature: "预览特性",
          current: { stage: "execution", title: "其他事项" },
          stages: {
            design: { status: "completed", note: "", evidence: [] },
            execution: { status: "active", note: "", evidence: [] },
            "code-review": { status: "pending", note: "", evidence: [] },
          },
          execution: { totalTasks: 3, completedTasks: 1 },
          activity: [{ at: "2026-10-09T12:00:00+08:00", title: "推进执行", summary: "半勾状态" }],
          blockers: [],
        },
        null,
        2,
      ) + "\n",
    );
    for (const rel of ["specs/preview/requirements.md", "specs/preview/tasks.md", "specs/preview/progress.json"]) {
      setMtime(root, rel, "2026-01-05T08:00:00");
    }
  },
  assert(c, ctx) {
    const { board } = ctx;
    const preview = featureByTitle(board, "预览特性");
    c.eq(preview?.status, "active", "任一 stage active → 特性 active（§4.3 规则 1）");
    c.eq(preview?.statusRule, "progress.stages.execution=active", "statusRule 点名命中的 stage");
    c.eq(preview?.stage, "执行中", "段位 = 执行中（status active，无 run 级 activeRun）");
    c.eq(
      preview?.updatedAt,
      "2026-10-09T12:00:00+08:00",
      "activity 最新 at → 特性 updatedAt（§4.2；与源 mtime max 合并）",
    );
    c.eq(preview?.progress, { totalTasks: 3, completedTasks: 1 }, "progress 汇总取自 progress.json execution");
    c.eq(preview?.attention, [], "有 progress.json + tasks.md → 无 arranged-not-expanded");

    const jia = taskByTitle(preview, "甲任务");
    const yi = taskByTitle(preview, "乙任务");
    const bing = taskByTitle(preview, "丙任务");
    c.eq(
      [jia?.status, yi?.status, bing?.status],
      ["pending", "completed", "pending"],
      "任务 pending / completed 混合（勾选=已合并）",
    );
    c.eq(jia?.stage, "待办", "未勾选且无 activeRun → 段位待办");
    c.eq(yi?.stage, "已完成", "已勾选 → 段位已完成");
    c.eq(yi?.statusRule, "tasks.md checkbox checked（勾选=已合并，6.3）", "已完成卡 statusRule 保持 T6 词汇");
    c.eq(bing?.stage, "待办", "未勾选卡段位待办");
    c.eq(
      board.attentionSummary,
      { interviewedNotArranged: 0, arrangedNotExpanded: 0, interruptedResume: 0, unmergedWorktree: 0 },
      "全链场景无缺口",
    );
  },
});

// ---- 场景 6：progress 未解除阻塞 → 特性 blocked
scenario("6", "progress 未解除阻塞 → 特性 blocked（statusRule 点名 stage）+ 段位阻塞", {
  build(root) {
    w(root, "specs/blocked/requirements.md", "# Requirements: 受阻特性\n");
    w(root, ".zcode/board/registry.json", JSON.stringify({
      version: 1,
      seq: 60,
      entries: [{ no: 60, kind: "spec", specRoot: "specs/blocked/", title: "受阻特性", assignedAt: "2026-01-05T08:00:00+08:00" }],
    }, null, 2) + "\n");
    w(
      root,
      "specs/blocked/tasks.md",
      [
        "# Implementation Plan: 受阻特性",
        "",
        "## Tasks",
        "",
        "- [ ] 1. 受阻任务 <!-- zcode-board: no=61 -->",
        "  - Scope: 受阻细节。",
        "",
        "- [ ] 2. 无关任务 <!-- zcode-board: no=62 -->",
        "  - Scope: 无关细节。",
        "",
      ].join("\n"),
    );
    w(
      root,
      "specs/blocked/progress.json",
      JSON.stringify(
        {
          version: 3,
          feature: "受阻特性",
          current: { stage: "execution", title: "其他事项" },
          stages: {
            design: { status: "completed", note: "", evidence: [] },
            execution: { status: "blocked", note: "等第三方凭据", evidence: [] },
            "code-review": { status: "pending", note: "", evidence: [] },
          },
          execution: { totalTasks: 2, completedTasks: 0 },
          activity: [],
          blockers: [
            { id: "B1", stage: "execution", summary: "1. 受阻任务", owner: "用户", evidence: ["specs/blocked/notes.md"] },
          ],
        },
        null,
        2,
      ) + "\n",
    );
  },
  assert(c, ctx) {
    const { board } = ctx;
    const blocked = featureByTitle(board, "受阻特性");
    c.eq(blocked?.status, "blocked", "任一 stage blocked → 特性 blocked（§4.3 规则 1 先命中）");
    c.eq(blocked?.statusRule, "progress.stages.execution=blocked", "statusRule 点名命中的 stage");
    c.eq(blocked?.stage, "阻塞", "段位 = 阻塞");
    c.eq(blocked?.attention, [], "有 progress + tasks → 无安排缺口");
    const stuck = taskByTitle(blocked, "受阻任务");
    c.eq(stuck?.status, "pending", "任务状态不因特性 blocked 改写（§4.2：默认只升特性级）");
    c.eq(stuck?.blockers?.length, 1, "progress blocker 匹配任务标题 → 挂该卡");
    c.eq(stuck?.stage, "待办", "受阻任务段位仍待办（status 未变）");
    c.eq(
      board.attentionSummary,
      { interviewedNotArranged: 0, arrangedNotExpanded: 0, interruptedResume: 0, unmergedWorktree: 0 },
      "缺口计数为 0",
    );
  },
});

// ---- 场景 18：引用语法断言（schema 级）
scenario("18", "引用语法断言（schema 级）：golden 过 schema 子集校验；引用位全为整数稳定号", {
  build(root) {
    w(
      root,
      ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000018a.md",
      ["# 目标九", "<!-- zcode-board: no=9 -->", "", "- **T1 戊（草案）**：戊正文。 <!-- zcode-board: no=10 -->", ""].join(
        "\n",
      ),
    );
    w(
      root,
      ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000018b.md",
      [
        "# 引用方",
        "<!-- zcode-board: no=11 -->",
        "",
        "- **T1 己（草案）**：己正文。 <!-- zcode-board: no=12 -->",
        "  > blocked-by: #9 —— 等戊落地",
        "",
      ].join("\n"),
    );
  },
  assert(c, ctx) {
    const { board, run } = ctx;

    // A. golden 由 T1 的独立校验器复核（schema 子集 + 引用不变量），不由编译器自证
    const goldenCheck = spawnSync(
      process.execPath,
      [join(ASSETS_DIR, "tools", "validate-sample.mjs"), "--only", "golden"],
      { encoding: "utf8" },
    );
    c.eq(
      goldenCheck.status,
      0,
      "golden 通过 board.schema.json 子集校验（T1 独立校验器，退出码 0）",
      truncate(goldenCheck.stdout ?? goldenCheck.stderr ?? "", 300),
    );
    const golden = JSON.parse(readFileSync(join(ASSETS_DIR, "samples", "board.golden.json"), "utf8"));
    for (const key of ["no", "label", "details", "blockers", "lastRun"]) {
      c.ok(goldenHasKey(golden, key), `golden 含 ${key} 字段（§13 场景 18 覆盖清单）`);
    }
    const goldenLive = liveNumbers(golden);
    const goldenRefs = [];
    walkNodes(golden.features, (n, ptr) => {
      for (const b of n.blockers ?? []) if (Object.hasOwn(b, "blockedBy")) goldenRefs.push([ptr, b.blockedBy]);
    });
    c.ok(goldenRefs.length > 0, "golden 含 blockedBy 引用位（判据可测）");
    c.eq(
      goldenRefs.filter(([, v]) => !Number.isInteger(v) || v < 1),
      [],
      "golden 全部 blockedBy 为正整数（号是身份）",
    );
    c.eq(
      goldenRefs.filter(([, v]) => !goldenLive.has(v)),
      [],
      "golden 全部 blockedBy 落在板上活号集合（引用可达）",
    );
    c.eq(
      goldenRefs.filter(([, v]) => typeof v === "string" || String(v).includes(".")),
      [],
      "golden 引用位无层级标签形态（标签是排版）",
    );

    // B. 编译器产物：同一组不变量
    const live = liveNumbers(board);
    const refs = [];
    walkNodes(board.features, (n, ptr) => {
      for (const b of n.blockers ?? []) if (Object.hasOwn(b, "blockedBy")) refs.push([ptr, b.blockedBy]);
    });
    c.ok(refs.length > 0, "夹具产物含 blockedBy 引用位");
    c.eq(refs.filter(([, v]) => !Number.isInteger(v) || v < 1), [], "产物全部 blockedBy 为正整数稳定号");
    c.eq(refs.filter(([, v]) => !live.has(v)), [], "产物全部 blockedBy 落在板上活号集合");
    c.eq(refs[0]?.[1], 9, "#9 写法归一为整数 9（引用位只认稳定号）");

    const labeled = [];
    walkNodes(board.features, (n) => {
      if (Object.hasOwn(n, "label")) labeled.push(n.label);
    });
    c.ok(labeled.length > 0, "板上存在 label（显示位）");
    c.ok(
      labeled.every((l) => /^[1-9][0-9]*(\.[1-9][0-9]*)*$/.test(l)),
      "label 形态限定在显示位词表内",
      show(labeled),
    );
    c.ok(!JSON.stringify(board).includes('"blockedBy":"'), "引用位不写字符串句柄");
    c.inc(run.md, "ID-9", "board.md 渲染 ID-<label> 形态");
  },
});

// ---- 场景 24：interrupted-resume + activeRun + 弹窗只携 lastRun 摘要
scenario("24", "interrupted-resume：最新 run partial → 缺口 + activeRun + lastRun 四要素；后续 done → 缺口清除", {
  build(root) {
    const planRel024 = ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000024.md";
    w(
      root,
      planRel024,
      [
        "# 断点夹具",
        "<!-- zcode-board: no=8 -->",
        "",
        "- **T1 执行中断的卡（草案）**：断点正文。 <!-- zcode-board: no=9 -->",
        "- **T2 已收尾的卡（草案）**：收尾正文。 <!-- zcode-board: no=10 -->",
        "",
      ].join("\n"),
    );
    setMtime(root, planRel024, "2026-01-02T03:04:05");
    seedRuns(root, [
      {
        runId: "run-20261009-a",
        sessionId: "sess_0024",
        role: "implementer",
        at: "2026-10-09T14:20:00+08:00",
        result: "partial",
        cards: [9],
        worktree: ".zcode/worktrees/task-9",
        branch: "task-9",
        evidence: ["specs/x/中历史证据.md"],
        breakpoint: { stoppedAt: 9, next: "补 updater 单测后重新验证" },
      },
      {
        runId: "run-20261009-b",
        sessionId: "sess_0024",
        role: "implementer",
        at: "2026-10-09T13:00:00+08:00",
        result: "partial",
        cards: [10],
        evidence: ["specs/x/旧证据.md"],
        breakpoint: { stoppedAt: 10, next: "先修类型" },
      },
      {
        runId: "run-20261009-c",
        sessionId: "sess_0024",
        role: "implementer",
        at: "2026-10-09T15:00:00+08:00",
        result: "done",
        cards: [10],
        evidence: ["specs/x/最新证据.md"],
        breakpoint: null,
      },
    ]);
  },
  assert(c, ctx) {
    const { board, root, run } = ctx;
    const plan = featureByTitle(board, "断点夹具");
    const broken = taskByTitle(plan, "执行中断的卡（草案）");
    const finished = taskByTitle(plan, "已收尾的卡（草案）");
    c.eq(broken?.status, "pending", "任务状态由 checkbox 决定（run 不改 status，§4.5）");
    c.eq(
      broken?.lastRun,
      {
        at: "2026-10-09T14:20:00+08:00",
        role: "implementer",
        result: "partial",
        stoppedAt: 9,
        next: "补 updater 单测后重新验证",
      },
      "lastRun 四要素摘要（§4.5）",
    );
    c.eq(broken?.activeRun, { role: "implementer", at: "2026-10-09T14:20:00+08:00" }, "partial → activeRun 非空（显示字段，不是状态）");
    c.ok((broken?.attention ?? []).includes("interrupted-resume"), "挂 interrupted-resume");
    c.eq(broken?.stage, "执行中", "段位 = 执行中（activeRun 干活角色）");
    c.inc(run.md, "停在 #9", "board.md 渲染断点（停在 #N）");
    c.inc(run.md, "补 updater 单测后重新验证", "board.md 渲染下一步摘要");
    c.eq(broken?.updatedAt, "2026-10-09T14:20:00+08:00", "updatedAt 合并最新 run.at");

    c.eq(finished?.lastRun?.result, "done", "最新 run（按 at）为 done");
    c.eq(finished?.activeRun, null, "done → activeRun null");
    c.ok(!(finished?.attention ?? []).includes("interrupted-resume"), "done → 无 interrupted-resume（不残留）");
    c.eq(finished?.stage, "待办", "无 activeRun 的 pending 卡 → 待办");
    c.eq(board.attentionSummary.interruptedResume, 1, "attentionSummary.interruptedResume 计数 +1");
    c.ok(
      !run.boardText.includes("中历史证据") && !run.boardText.includes("旧证据") && !run.boardText.includes("最新证据"),
      "弹窗区块只携 lastRun 摘要：runs 证据与全史不进板（单一事件单一家，勘误 4）",
    );
    c.ok(!run.boardText.includes("run-20261009-a"), "板内无 runId（lastRun 字段表冻结）");

    // 第二段：后续 done run 落账 → 缺口与 activeRun 清除
    seedRuns(root, [
      ...readRuns(root),
      {
        runId: "run-20261009-d",
        sessionId: "sess_0024",
        role: "implementer",
        at: "2026-10-09T16:30:00+08:00",
        result: "done",
        cards: [9],
        worktree: ".zcode/worktrees/task-9",
        branch: "task-9",
        evidence: ["specs/x/补测证据.md"],
        breakpoint: null,
      },
    ]);
    const second = runCompiler(root);
    c.eq(second.code, 0, "二次编译退出码 0");
    const broken2 = taskByTitle(featureByTitle(second.board, "断点夹具"), "执行中断的卡（草案）");
    c.eq(broken2?.activeRun, null, "done 后 activeRun 清除");
    c.ok(!(broken2?.attention ?? []).includes("interrupted-resume"), "done 后 interrupted-resume 清除");
    c.eq(broken2?.stage, "待办", "清除后段位回落待办");
    const third = runCompiler(root);
    c.eq(
      maskedRootUpdatedAt(third.boardText ?? ""),
      maskedRootUpdatedAt(second.boardText ?? ""),
      "含 run 派生字段（lastRun/activeRun/段位/缺口）的编译幂等：两次逐字节一致（掩码编译时刻）",
    );
  },
});

// ---- 场景 25：unmerged-worktree + 待合并段位
scenario("25", "unmerged-worktree：worktree 字段与待合并段位；integrator done + 勾选 → 缺口清除、卡已完成", {
  build(root) {
    w(root, "specs/split/requirements.md", "# Requirements: 拆分特性\n");
    w(root, ".zcode/board/registry.json", JSON.stringify({
      version: 1,
      seq: 11,
      entries: [{ no: 11, kind: "spec", specRoot: "specs/split/", title: "拆分特性", assignedAt: "2026-01-05T08:00:00+08:00" }],
    }, null, 2) + "\n");
    w(
      root,
      "specs/split/tasks.md",
      [
        "# Implementation Plan: 拆分特性",
        "",
        "## Tasks",
        "",
        "- [ ] 1. 拆分支付回调（核心） <!-- zcode-board: no=12 -->",
        "  - Scope: 抽出服务。",
        "",
        "- [ ] 2. 其他任务 <!-- zcode-board: no=13 -->",
        "  - Scope: 其他。",
        "",
      ].join("\n"),
    );
    w(
      root,
      "specs/split/progress.json",
      JSON.stringify(
        {
          version: 3,
          feature: "拆分特性",
          current: { stage: "execution", title: "其他事项" },
          stages: {
            design: { status: "completed", note: "", evidence: [] },
            execution: { status: "active", note: "", evidence: [] },
            "code-review": { status: "pending", note: "", evidence: [] },
          },
          execution: { totalTasks: 2, completedTasks: 0 },
          activity: [],
          blockers: [],
        },
        null,
        2,
      ) + "\n",
    );
    seedRuns(root, [
      {
        runId: "run-20261009-w",
        sessionId: "sess_0025",
        role: "implementer",
        at: "2026-10-09T14:20:00+08:00",
        result: "partial",
        cards: [12],
        worktree: ".zcode/worktrees/task-12",
        branch: "task-12",
        evidence: ["specs/split/service.ts"],
        breakpoint: { stoppedAt: 12, next: "补回调单测" },
      },
    ]);
    mkdirSync(join(root, ".zcode/worktrees/task-12"), { recursive: true });
    mkdirSync(join(root, ".zcode/worktrees/task-99"), { recursive: true });
  },
  assert(c, ctx) {
    const { board, root, run } = ctx;
    const card = taskByTitle(featureByTitle(board, "拆分特性"), "拆分支付回调（核心）");
    c.eq(card?.worktree, ".zcode/worktrees/task-12", "有带 worktree 的 run 且无 integrator done → worktree 字段非空");
    c.ok((card?.attention ?? []).includes("unmerged-worktree"), "挂 unmerged-worktree（进待合并段位）");
    c.ok((card?.attention ?? []).includes("interrupted-resume"), "同卡两码互不排斥（中断 + 待合并）");
    c.eq(card?.stage, "执行中", "段位 = 执行中（implementer partial）");
    c.eq(board.attentionSummary.unmergedWorktree, 1, "attentionSummary.unmergedWorktree 计数 +1");
    c.inc(run.md, "待合并", "board.md 渲染待合并段位");
    c.inc(run.md, ".zcode/worktrees/task-12", "board.md 渲染 worktree 路径");

    const wtDiags = (board.diagnostics ?? []).filter((d) => d.message.includes("task-"));
    c.ok(
      wtDiags.some((d) => d.message.includes("task-99")),
      "目录在而 runs 无据 → diagnostics 点名 task-99（不执行 git、不猜状态）",
      show(wtDiags.map((d) => d.message)),
    );
    c.ok(
      !wtDiags.some((d) => d.message.includes("task-12")),
      "worktree 与 runs 互证一致 → 不误报 task-12",
      show(wtDiags.map((d) => d.message)),
    );

    // 第二段：integrator done 落账 + tasks.md 勾选 + 正规清理目录 → 缺口清除、卡已完成
    seedRuns(root, [
      ...readRuns(root),
      {
        runId: "run-20261009-m",
        sessionId: "sess_0025",
        role: "integrator",
        at: "2026-10-09T16:00:00+08:00",
        result: "done",
        cards: [12],
        worktree: ".zcode/worktrees/task-12",
        branch: "task-12",
        evidence: ["Merge task-12 [#12] (a1b2c3d)"],
        breakpoint: null,
      },
    ]);
    w(
      root,
      "specs/split/tasks.md",
      [
        "# Implementation Plan: 拆分特性",
        "",
        "## Tasks",
        "",
        "- [x] 1. 拆分支付回调（核心） <!-- zcode-board: no=12 -->",
        "  - Scope: 抽出服务。",
        "",
        "- [ ] 2. 其他任务 <!-- zcode-board: no=13 -->",
        "  - Scope: 其他。",
        "",
      ].join("\n"),
    );
    rmSync(join(root, ".zcode/worktrees/task-12"), { recursive: true, force: true });
    const second = runCompiler(root);
    const card2 = taskByTitle(featureByTitle(second.board, "拆分特性"), "拆分支付回调（核心）");
    c.eq(second.code, 0, "二次编译退出码 0");
    c.eq(card2?.worktree, null, "integrator done 收尾 → worktree 字段清空");
    c.ok(!(card2?.attention ?? []).includes("unmerged-worktree"), "unmerged-worktree 缺口清除");
    c.eq(card2?.status, "completed", "勾选（=已合并）→ 卡 completed");
    c.eq(card2?.stage, "已完成", "段位 = 已完成");
    c.eq(second.board.attentionSummary.unmergedWorktree, 0, "缺口计数归零");
    c.ok(
      !(second.board.diagnostics ?? []).some((d) => d.message.includes("task-12")),
      "目录经正规清理 → 无残留诊断",
    );
  },
});

// ---- 场景 42：unmerged-worktree 判据收紧（幽灵工作树；#42）
scenario("42", "unmerged-worktree 判据收紧（#42）：worktree 字段命中且目录真实存在才触发；字段命中目录缺失 → 提示级诊断不缺口", {
  build(root) {
    const planRel = ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000042.md";
    w(
      root,
      planRel,
      [
        "# 判据收紧夹具",
        "<!-- zcode-board: no=68 -->",
        "",
        "- **T1 真实现场（根级目录）**：正文。 <!-- zcode-board: no=70 -->",
        "- **T2 幽灵现场（目录缺失）**：正文。 <!-- zcode-board: no=71 -->",
        "- **T3 跨项目现场（嵌套项目根）**：正文。 <!-- zcode-board: no=72 -->",
        "- **T4 无现场声明**：正文。 <!-- zcode-board: no=73 -->",
        "",
      ].join("\n"),
    );
    setMtime(root, planRel, "2026-01-02T03:04:05");
    seedRuns(root, [
      {
        runId: "run-20261010-t70",
        sessionId: "sess_0042",
        role: "implementer",
        at: "2026-10-10T01:00:00+08:00",
        result: "partial",
        cards: [70],
        worktree: ".zcode/worktrees/task-70",
        branch: "task-70",
        evidence: [],
        breakpoint: { stoppedAt: 70, next: "继续" },
      },
      {
        runId: "run-20261010-t71",
        sessionId: "sess_0042",
        role: "implementer",
        at: "2026-10-10T01:01:00+08:00",
        result: "partial",
        cards: [71],
        worktree: ".zcode/worktrees/task-71",
        branch: "task-71",
        evidence: [],
        breakpoint: { stoppedAt: 71, next: "继续" },
      },
      {
        runId: "run-20261010-t72",
        sessionId: "sess_0042",
        role: "test-verifier",
        at: "2026-10-10T01:02:00+08:00",
        result: "done",
        cards: [72],
        worktree: ".zcode/worktrees/task-72",
        branch: "task-72",
        evidence: [],
        breakpoint: null,
      },
      {
        runId: "run-20261010-t73",
        sessionId: "sess_0042",
        role: "code-reviewer",
        at: "2026-10-10T01:03:00+08:00",
        result: "done",
        cards: [73],
        evidence: [],
        breakpoint: null,
      },
    ]);
    mkdirSync(join(root, ".zcode/worktrees/task-70"), { recursive: true });
    mkdirSync(join(root, "nested-proj", ".zcode", "worktrees", "task-72"), { recursive: true });
  },
  assert(c, ctx) {
    const { board, run } = ctx;
    const f = featureByTitle(board, "判据收紧夹具");
    const real = taskByTitle(f, "真实现场（根级目录）");
    const ghost = taskByTitle(f, "幽灵现场（目录缺失）");
    const cross = taskByTitle(f, "跨项目现场（嵌套项目根）");
    const none = taskByTitle(f, "无现场声明");

    c.ok((real?.attention ?? []).includes("unmerged-worktree"), "有字段且有目录 → 触发缺口（原判据保留）", show(real?.attention));
    c.eq(real?.worktree, ".zcode/worktrees/task-70", "fs 互证通过 → worktree 字段保留");

    c.ok(
      !(ghost?.attention ?? []).includes("unmerged-worktree"),
      "字段命中但目录不存在 → 不触发缺口（#42 收紧：幽灵工作树不再误报）",
      show(ghost?.attention),
    );
    c.eq(ghost?.worktree, null, "降级：worktree 字段为 null（不进待合并聚合）");
    const ghostDiags = diagFor(board, ".zcode/board/runs.json").filter((d) => d.message.includes("task-71"));
    c.eq(ghostDiags.length, 1, "字段命中目录缺失 → 提示级 diagnostics 点名（不静默）", show(ghostDiags.map((d) => d.message)));
    c.inc(ghostDiags[0]?.message ?? "", "目录不存在", "文案写明「runs 声明工作树但目录不存在」");

    c.ok(
      (cross?.attention ?? []).includes("unmerged-worktree"),
      "目录在嵌套项目根下（跨项目现场，如 ZPaPa/.zcode/worktrees/task-32）→ fs 互证仍成立",
      show(cross?.attention),
    );
    c.eq(
      cross?.worktree,
      "nested-proj/.zcode/worktrees/task-72",
      "互证通过 → 归一为现场实际路径（#151：短声明按各自项目根书写，输出板根相对现场路径；原 #42「保留声明原样」口径由 #151 修订）",
    );

    c.ok(!(none?.attention ?? []).includes("unmerged-worktree"), "无字段声明 → 不触发缺口（runs 侧不再按卡号推导）");
    c.eq(none?.worktree, null, "无字段声明 → worktree 恒 null");
    c.ok(
      !diagFor(board, ".zcode/board/runs.json").some((d) => d.message.includes("task-73")),
      "无声明不是「声明了但目录不存在」：不产降级诊断",
    );

    c.eq(board.attentionSummary.unmergedWorktree, 2, "计数 = 2（仅互证通过的两张：根级 + 嵌套项目根）");
    const mergeSection = String(run.md).split("## 待合并（unmerged-worktree 聚合）")[1]?.split("\n## ")[0] ?? "";
    c.inc(mergeSection, ".zcode/worktrees/task-70", "board.md 待合并聚合含真实现场");
    c.inc(mergeSection, " —— nested-proj/.zcode/worktrees/task-72", "board.md 待合并聚合含跨项目现场（归一后现场路径）");
    c.ok(!mergeSection.includes("task-71"), "board.md 待合并聚合不列幽灵现场（缺口与聚合同源同字段）");
  },
});

// ---- 场景 30：卡龄（updatedAt = max(源推导, 最新 run.at)）
scenario("30", "卡龄：updatedAt = max(源推导, 最新 run.at)；无 run 的陈旧卡保留源 mtime", {
  build(root) {
    const planRel = ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000030.md";
    w(
      root,
      planRel,
      [
        "# 卡龄夹具",
        "<!-- zcode-board: no=30 -->",
        "",
        "- **T1 有 run 的卡（草案）**：卡龄正文。 <!-- zcode-board: no=31 -->",
        "- **T2 陈旧卡（草案）**：30 天无任何触碰。 <!-- zcode-board: no=32 -->",
        "",
      ].join("\n"),
    );
    setMtime(root, planRel, "2026-09-09T08:00:00");
    seedRuns(root, [
      {
        runId: "run-20261009-k",
        sessionId: "sess_0030",
        role: "test-verifier",
        at: "2026-10-09T14:05:00+08:00",
        result: "done",
        cards: [31],
        evidence: [],
        breakpoint: null,
      },
    ]);
  },
  assert(c, ctx) {
    const { board, root, run } = ctx;
    const plan = featureByTitle(board, "卡龄夹具");
    const active = taskByTitle(plan, "有 run 的卡（草案）");
    const stale = taskByTitle(plan, "陈旧卡（草案）");
    const planAbs = join(root, ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000030.md");
    const sourceAt = isoFromMtime(planAbs);
    c.eq(active?.updatedAt, "2026-10-09T14:05:00+08:00", "源无变化但有新 run → updatedAt 前进到最新 run.at");
    c.eq(stale?.updatedAt, sourceAt, "无 run 的卡 updatedAt = 源 mtime（独立真值：测试自算 mtime ISO）");
    c.eq(plan?.updatedAt, "2026-10-09T14:05:00+08:00", "特性 updatedAt 合并子树最新 run.at（§4.5 max 合并）");
    const days = (Date.parse(active.updatedAt) - Date.parse(stale.updatedAt)) / 86400000;
    c.ok(days >= 29.9, "陈旧卡与执行卡卡龄差 ≥30 天（标灰/最老视角置顶的数据基础）", `差 ${days.toFixed(2)} 天`);
    c.inc(run.md, "2026-10-09T14:05:00+08:00", "board.md 渲染 updatedAt（卡龄信号可见）");
  },
});

// ---- 场景 32：plan-overgrown
scenario("32", "plan-overgrown：61 卡提示拆票、恰 60 卡不提示（阈值取编译器导出常量）", {
  build(root) {
    const lines = (n, base, title) => {
      const out = [`# ${title}`, `<!-- zcode-board: no=${base - 1} -->`, ""];
      for (let i = 1; i <= n; i += 1) {
        out.push(`- **T${i} 卡 ${i}（草案）**：正文 ${i}。 <!-- zcode-board: no=${base + i - 1} -->`);
      }
      out.push("");
      return out.join("\n");
    };
    w(root, ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000032a.md", lines(PLAN_OVERGROWN_THRESHOLD + 1, 100, "超标计划"));
    w(root, ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000032b.md", lines(PLAN_OVERGROWN_THRESHOLD, 300, "边界计划"));
  },
  assert(c, ctx) {
    const { board } = ctx;
    c.eq(PLAN_OVERGROWN_THRESHOLD, 60, "阈值常量为 60（§4.2 建议值，T6 导出常量）");
    const bigRel = ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000032a.md";
    const edgeRel = ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000032b.md";
    const big = featureByTitle(board, "超标计划");
    const edge = featureByTitle(board, "边界计划");
    c.eq(big?.tasks?.length, 61, "61 张派生卡");
    c.eq(edge?.tasks?.length, 60, "恰 60 张派生卡");
    const bigDiags = diagFor(board, bigRel).filter((d) => d.message.includes("plan-overgrown"));
    c.ok(bigDiags.length === 1, "超阈值 → 一条 plan-overgrown 诊断（§4.2：提示拆票或升级 spec）", show(diagFor(board, bigRel).map((d) => d.message)));
    c.ok(
      bigDiags[0]?.message.includes("61") && bigDiags[0]?.message.includes("60") && bigDiags[0]?.message.includes("拆票"),
      "诊断点名卡数、阈值与处置建议",
      show(bigDiags.map((d) => d.message)),
    );
    c.eq(
      diagFor(board, edgeRel).filter((d) => d.message.includes("plan-overgrown")),
      [],
      "恰 60 张不提示（阈值语义：超过才提示）",
    );
    c.eq(
      board.attentionSummary.arrangedNotExpanded,
      0,
      "#53 契约 v2.3：有卡计划稿（60/61 张）不再误挂 arranged-not-expanded（判据收窄为零卡）",
    );
  },
});

// ---- 场景 34：pr 字段透传
scenario("34", "pr 字段透传：远程模式 merge 凭据 → pr 非空并回显；本地模式恒为 null", {
  build(root) {
    w(
      root,
      ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000034.md",
      [
        "# PR 夹具",
        "<!-- zcode-board: no=41 -->",
        "",
        "- **T1 远程合并的卡（草案）**：远程。 <!-- zcode-board: no=42 -->",
        "- **T2 本地合并的卡（草案）**：本地。 <!-- zcode-board: no=43 -->",
        "",
      ].join("\n"),
    );
    seedRuns(root, [
      {
        runId: "run-20261009-r1",
        sessionId: "sess_0034",
        role: "implementer",
        at: "2026-10-09T14:00:00+08:00",
        result: "partial",
        cards: [42],
        worktree: ".zcode/worktrees/task-42",
        branch: "task-42",
        evidence: [],
        breakpoint: { stoppedAt: 42, next: "补测" },
      },
      {
        runId: "run-20261009-r2",
        sessionId: "sess_0034",
        role: "integrator",
        at: "2026-10-09T16:00:00+08:00",
        result: "done",
        cards: [42],
        worktree: ".zcode/worktrees/task-42",
        branch: "task-42",
        evidence: ["https://github.com/ag-jin/ZPaPa/pull/41"],
        pr: { number: 41, url: "https://github.com/ag-jin/ZPaPa/pull/41" },
        breakpoint: null,
      },
      {
        runId: "run-20261009-r3",
        sessionId: "sess_0034",
        role: "integrator",
        at: "2026-10-09T16:10:00+08:00",
        result: "done",
        cards: [43],
        evidence: ["Merge task-43 [#43] (d4e5f6a)"],
        breakpoint: null,
      },
    ]);
  },
  assert(c, ctx) {
    const { board, run } = ctx;
    const plan = featureByTitle(board, "PR 夹具");
    const remote = taskByTitle(plan, "远程合并的卡（草案）");
    const local = taskByTitle(plan, "本地合并的卡（草案）");
    c.eq(remote?.pr, { number: 41, url: "https://github.com/ag-jin/ZPaPa/pull/41" }, "远程模式 PR 映射透传（number + url）");
    c.eq(local?.pr, null, "本地模式 pr 恒为 null");
    c.eq(remote?.worktree, null, "integrator done 收尾 → worktree 清空");
    c.ok(!(remote?.attention ?? []).includes("unmerged-worktree"), "远程合并完成 → 无待合并缺口");
    c.inc(run.md, "PR：#41", "board.md 回显 PR 号（#41）");
    c.inc(run.md, "https://github.com/ag-jin/ZPaPa/pull/41", "board.md 回显 PR 链接");
  },
});

// ---- 场景 35：归档全链（勘误 10）
// 夹具常量（build 与 assert 共用的独立期望；号/路径/assignedAt 为字面真值，不从实现推导）
const S35 = {
  specOld: "specs/old-feature/",
  specArch: "specs/archive/old-feature/",
  specTasksOld: "specs/old-feature/tasks.md",
  specTasksArch: "specs/archive/old-feature/tasks.md",
  planOld: ".zcode/plans/plan-arch.md",
  planArch: ".zcode/archive/plan-arch.md",
  livePlan: ".zcode/plans/plan-live.md",
  specTitle: "旧特性（待归档）",
  planTitle: "归档计划稿",
  liveTitle: "活计划",
  assignedAt: {
    20: "2026-09-01T08:00:00+08:00",
    21: "2026-09-01T08:00:01+08:00",
    22: "2026-09-01T08:00:02+08:00",
    30: "2026-09-01T08:00:03+08:00",
    31: "2026-09-01T08:00:04+08:00",
  },
};
let S35_PRE = null; // 归档移动前的板（点名前置：completed + updatedAt 超冷却期）
let S35_HOOK = null; // Stop hook 调用结果（点名证据）

scenario("35", "归档全链：等待点名→移动→板上消失/sources 干净→registry 指向改写入档→9d 文案 A→新条目 seq+1→--check 直查通过", {
  steps: [{ args: ["--check"] }, { args: ["--assign"] }, { args: [] }, { args: ["--check"] }],
  build(root) {
    // -- 归档移动前：completed 特性 + 归档计划稿（预发号，registry 指向原位）
    w(root, "specs/old-feature/requirements.md", `# Requirements: ${S35.specTitle}\n`);
    w(root, S35.specTasksOld, [
      "# Implementation Plan: 旧特性（待归档）", "",
      "- [x] 1. 旧任务甲 <!-- zcode-board: no=21 -->", "  - Scope: 甲。",
      "- [x] 2. 旧任务乙 <!-- zcode-board: no=22 -->", "  - Scope: 乙。", "",
    ].join("\n"));
    w(root, "specs/old-feature/progress.json", JSON.stringify({ version: 3, feature: S35.specTitle,
      current: { stage: "code-review", title: "" },
      stages: { execution: { status: "completed", note: "", evidence: [] }, "code-review": { status: "completed", note: "", evidence: [] } },
      execution: { totalTasks: 2, completedTasks: 2 }, activity: [], blockers: [] }, null, 2) + "\n");
    w(root, S35.planOld, ["# 归档计划稿", "<!-- zcode-board: no=30 -->", "- **T1 归档卡（草案）**：正文。 <!-- zcode-board: no=31 -->", ""].join("\n"));
    // F2 半场诱饵：归档根直接源文件（按名排除，不当 spec 根）
    w(root, "specs/archive/tasks.md", ["# Implementation Plan: 归档根诱饵", "", "- [ ] 1. 诱饵任务", ""].join("\n"));
    w(root, "specs/archive/dead/requirements.md", "# Requirements: 已归档死特性\n");
    w(root, "specs/archive/dead/tasks.md", ["# Implementation Plan: 已归档死特性", "", "- [ ] 1. 已归档任务 <!-- zcode-board: no=91 -->", ""].join("\n"));
    w(root, ".zcode/board/registry.json", JSON.stringify({ version: 1, seq: 31, entries: [
      { no: 20, kind: "spec", specRoot: S35.specOld, title: S35.specTitle, assignedAt: S35.assignedAt[20] },
      { no: 21, kind: "task", file: S35.specTasksOld, title: "旧任务甲", assignedAt: S35.assignedAt[21] },
      { no: 22, kind: "task", file: S35.specTasksOld, title: "旧任务乙", assignedAt: S35.assignedAt[22] },
      { no: 30, kind: "plan", file: S35.planOld, title: S35.planTitle, assignedAt: S35.assignedAt[30] },
      { no: 31, kind: "task", file: S35.planOld, title: "归档卡（草案）", assignedAt: S35.assignedAt[31] },
    ] }, null, 2) + "\n");
    // 冷却期前置：源文件 mtime 拨到 10 天前（特性 updatedAt 派生自源 mtime）
    const daysAgo = new Date(Date.now() - 10 * 86400_000);
    const p = (n) => String(n).padStart(2, "0");
    const oldIso = `${daysAgo.getFullYear()}-${p(daysAgo.getMonth() + 1)}-${p(daysAgo.getDate())}T${p(daysAgo.getHours())}:${p(daysAgo.getMinutes())}:${p(daysAgo.getSeconds())}`;
    for (const rel of ["specs/old-feature/requirements.md", S35.specTasksOld, "specs/old-feature/progress.json"]) setMtime(root, rel, oldIso);

    // 1) 移动前编译 → 2) Stop 对账点名"待归档"（hook 只点名不移动；点名在移动前观察）
    S35_PRE = runCompiler(root, []);
    S35_HOOK = spawnSync(process.execPath, [join(ASSETS_DIR, "hooks", "reconcile-stop.mjs")], {
      input: JSON.stringify({ cwd: root, sessionId: "sess_s35" }),
      encoding: "utf8",
    });
    // 3) 编排者移动（只改文件位置；标记随文件走）
    for (const [from, to] of [
      [S35.planOld, S35.planArch],
      ["specs/old-feature/requirements.md", "specs/archive/old-feature/requirements.md"],
      [S35.specTasksOld, S35.specTasksArch],
      ["specs/old-feature/progress.json", "specs/archive/old-feature/progress.json"],
    ]) {
      w(root, to, readFileSync(join(root, from), "utf8"));
      rmSync(join(root, from), { force: true });
    }
    rmSync(join(root, "specs/old-feature"), { recursive: true, force: true });
    // 4) 移动后新增：活计划（未领号；条目引用已归档号 21 → 勘误 9d 文案 A）
    w(root, S35.livePlan, [
      "# 活计划", "",
      "- **T1 活卡（草案）**：正文。",
      "  > blocked-by: 21 —— 等归档件回迁", "",
    ].join("\n"));
  },
  assert(c, ctx) {
    const [preCheck, assign, compile, finalCheck] = ctx.steps;
    // -- 点名（移动前）：completed 且超 7 天冷却 → Stop 第四类点名；hook 只点名不移动
    c.ok(S35_PRE?.code === 0 && S35_PRE?.board != null, "移动前编译产出板（点名前置）");
    c.eq(featureByTitle(S35_PRE?.board, S35.specTitle)?.status, "completed", "移动前：归档特性 status=completed（点名前置）");
    c.eq(S35_HOOK?.status, 0, "Stop hook 退出码 0（点名非阻断）");
    const reconcile = readFileSync(join(ctx.root, ".zcode/board/last-reconcile.md"), "utf8");
    c.inc(reconcile, "- 结论：点名 1 项（未登记 0 / 未合并 0 / 板陈旧 0 / 待归档 1）", "点名四类：待归档 1（其余为 0）");
    c.inc(reconcile, S35.specTitle, "点名归档特性（按 updatedAt 超 7 天冷却机械判定）");
    c.inc(reconcile, "hook 只点名不移动", "点名注明 hook 只点名、移动归编排者（勘误 10）");

    // -- 移动后、--assign 前：--check 失败（指向失效但归档候选已验证 → 可修复诊断）
    c.eq(preCheck?.code, 1, "移动后未 run --assign：--check 非零退出（指向失效独立诊断）");
    c.inc(preCheck.stdout, "运行 --assign", "失败诊断给出修复路径（运行 --assign 改写指向）");
    c.inc(preCheck.stdout, S35.specArch, "失败诊断点名已验证的归档候选（specs/archive/old-feature/）");

    // -- --assign：registry 指向改写为归档路径；号/assignedAt 不变；seq 继续前进
    c.eq(assign?.code, 0, "--assign 退出码 0");
    c.inc(assign.stderr, "归档", "assign 诊断记录归档指向改写（不静默）");
    const registry = readJsonFile(join(ctx.root, ".zcode/board/registry.json")).value;
    c.eq(registry?.seq, 33, "seq=33（归档不改写号：20–31 全保留；活计划新领 32/33）");
    c.eq(
      registry?.entries?.map((e) => ({ no: e.no, ref: e.specRoot ?? e.file })),
      [
        { no: 20, ref: S35.specArch },
        { no: 21, ref: S35.specTasksArch },
        { no: 22, ref: S35.specTasksArch },
        { no: 30, ref: S35.planArch },
        { no: 31, ref: S35.planArch },
        { no: 32, ref: S35.livePlan },
        { no: 33, ref: S35.livePlan },
      ],
      "registry：20–31 号不变且指向按勘误 10 三映射改写入档；活计划新领 32/33（不复用归档号）",
    );
    c.eq(
      (registry?.entries ?? []).filter((e) => e.no <= 31).map((e) => e.assignedAt),
      [20, 21, 22, 30, 31].map((n) => S35.assignedAt[n]),
      "归档条目 assignedAt 逐条保留（改写只动指向）",
    );
    c.eq(
      (registry?.entries ?? []).filter((e) => e.no >= 32).map((e) => e.no),
      [32, 33],
      "新条目领 seq+1（32→33）：高水位只增，归档不释放号",
    );

    // -- 板：归档节点消失、sources 不含归档路径、specs/archive 不当根
    const board = ctx.board;
    c.eq((board?.features ?? []).map((f) => f.title), [S35.liveTitle], "板上只剩活计划（归档特性/归档计划稿从板上消失）");
    c.ok(!featureByTitle(board, S35.specTitle) && !featureByTitle(board, S35.planTitle), "归档特性与归档计划稿无节点（含子卡一并离板）");
    c.ok(!featureByTitle(board, "归档根诱饵") && !featureByTitle(board, "已归档死特性"), "specs/archive/ 与 specs/archive/<f>/ 不当 spec 根（F2 按名排除）");
    c.eq(
      (board?.sources ?? []).filter((s) => s.kind === "spec").map((s) => s.root),
      [],
      "sources[] 的 spec 根为空（归档不在扫描面）",
    );
    c.eq(
      (board?.sources ?? []).filter((s) => s.kind === "plan").map((s) => s.path),
      [S35.livePlan],
      "sources[] 的 plan 只含活计划稿（归档路径不在扫描面）",
    );
    c.ok(
      !JSON.stringify(board?.sources ?? []).includes("archive"),
      "sources[] 逐字符不含归档路径（specs/archive、.zcode/archive、docs/archive 均不在扫描面）",
    );

    // -- 勘误 9d 文案 A：已归档号被 blocked-by 引用 → 不造引用 + 独立诊断（且非文案 B）
    const live = featureByTitle(board, S35.liveTitle);
    const liveTask = taskByTitle(live, "活卡（草案）");
    c.eq(liveTask?.no, 33, "活卡领号 33（32 为活计划号）");
    c.eq(liveTask?.label, "1", "活卡 label 1（#46 A2：计划内层级路径，与计划码组合唯一）");
    c.eq(
      liveTask?.blockers,
      [{ kind: "dependency", summary: "等归档件回迁", evidence: [S35.livePlan] }],
      "已归档号 21：不造引用（blockedBy 缺省，summary 原文保留）",
    );
    c.ok(
      diagFor(board, S35.livePlan).some((d) => d.message.includes("在 registry 有条目但不在本次编译的板上")),
      "走勘误 9d 文案 A（registry 有条目而板上无——目标可能已归档）",
      show(diagFor(board, S35.livePlan).map((d) => d.message)),
    );
    c.ok(
      diagFor(board, S35.livePlan).every((d) => !d.message.includes("未知号")),
      "不误用文案 B（号 21 在 registry 有条目，非完全未知号）",
    );

    // -- --check 归档直查：指向归档路径且含标记 → 通过并 note"已归档"
    c.eq(compile?.code, 0, "移动后重编译退出码 0");
    c.eq(finalCheck?.code, 0, "归档后 --check 通过（按指向路径直查）");
    c.inc(finalCheck.stdout, "已归档", "check note 明写「已归档」（勘误 10）");
    c.inc(finalCheck.stdout, "条目 20", "check 逐条点名归档条目 20");
    c.inc(finalCheck.stdout, S35.planArch, "check 按指向直查归档计划稿路径");
    c.ok(!finalCheck.stdout.includes("[registry 不一致]"), "归档条目不报不一致（防误报）");
  },
});

// ---- 段位表：七段位逐段 + 2 条反向（角色错配）
scenario("stage", "段位派生：段位表各一（该夹具无取消卡）+ 反向：角色错配不得进审核中/执行中", {
  build(root) {
    w(root, "specs/stage/requirements.md", "# Requirements: 段位夹具\n");
    w(root, ".zcode/board/registry.json", JSON.stringify({
      version: 1,
      seq: 20,
      entries: [{ no: 20, kind: "spec", specRoot: "specs/stage/", title: "段位夹具", assignedAt: "2026-01-05T08:00:00+08:00" }],
    }, null, 2) + "\n");
    w(
      root,
      "specs/stage/tasks.md",
      [
        "# Implementation Plan: 段位夹具",
        "",
        "## Tasks",
        "",
        "- [x] 1. 已完成任务 <!-- zcode-board: no=21 -->",
        "  - Scope: 已完成。",
        "",
        "- [ ] 2. 待办任务 <!-- zcode-board: no=22 -->",
        "  - Scope: 待办。",
        "",
        "- [ ] 3. 执行中任务 <!-- zcode-board: no=23 -->",
        "  - Scope: 执行中。",
        "",
        "- [ ] 4. 审核中任务 <!-- zcode-board: no=24 -->",
        "  - Scope: 审核中。",
        "",
      ].join("\n"),
    );
    w(
      root,
      "specs/stage/progress.json",
      JSON.stringify(
        {
          version: 3,
          feature: "段位夹具",
          current: { stage: "execution", title: "其他事项" },
          stages: {
            design: { status: "completed", note: "", evidence: [] },
            execution: { status: "blocked", note: "等凭据", evidence: [] },
            "code-review": { status: "pending", note: "", evidence: [] },
          },
          execution: { totalTasks: 4, completedTasks: 1 },
          activity: [],
          blockers: [],
        },
        null,
        2,
      ) + "\n",
    );
    seedRuns(root, [
      {
        runId: "run-20261009-s1",
        sessionId: "sess_stage",
        role: "implementer",
        at: "2026-10-09T10:00:00+08:00",
        result: "partial",
        cards: [23],
        worktree: ".zcode/worktrees/task-23",
        branch: "task-23",
        evidence: [],
        breakpoint: { stoppedAt: 23, next: "继续执行" },
      },
      {
        runId: "run-20261009-s2",
        sessionId: "sess_stage",
        role: "test-verifier",
        at: "2026-10-09T11:00:00+08:00",
        result: "partial",
        cards: [24],
        evidence: [],
        breakpoint: { stoppedAt: 24, next: "补验证证据" },
      },
      {
        runId: "run-20261009-s3",
        sessionId: "sess_stage",
        role: "integrator",
        at: "2026-10-09T12:00:00+08:00",
        result: "partial",
        cards: [22],
        evidence: [],
        breakpoint: { stoppedAt: 22, next: "等 rebase" },
      },
      {
        runId: "run-20261009-s4",
        sessionId: "sess_stage",
        role: "test-verifier",
        at: "2026-10-09T09:00:00+08:00",
        result: "done",
        cards: [21],
        evidence: [],
        breakpoint: null,
      },
    ]);
    mkdirSync(join(root, ".zcode/worktrees/task-23"), { recursive: true });
    w(root, ".zcode/plans/plan-sess_00000000-0000-4000-8000-0000000000st.md", "# 未拆解计划\n\n（本稿无可识别任务语法）\n");
    w(
      root,
      ".zcode/board/interviews.json",
      JSON.stringify(
        {
          version: 1,
          interviews: [
            {
              id: "itw-20261009-stage",
              at: "2026-10-09T08:00:00+08:00",
              sessionId: "sess_stage",
              topic: "尚未落卡的访谈",
              summary: "只谈未写。",
              decisions: [],
              artifacts: [],
              outcome: "none",
              status: "open",
            },
          ],
        },
        null,
        2,
      ) + "\n",
    );
  },
  assert(c, ctx) {
    const { board, run } = ctx;
    const spec = featureByTitle(board, "段位夹具");
    const plan = featureByTitle(board, "未拆解计划");
    const interview = featureByTitle(board, "尚未落卡的访谈");

    c.eq(spec?.stage, "阻塞", "阻塞：spec 有 stage blocked");
    const done = taskByTitle(spec, "已完成任务");
    const todo = taskByTitle(spec, "待办任务");
    const doing = taskByTitle(spec, "执行中任务");
    const review = taskByTitle(spec, "审核中任务");
    c.eq(done?.stage, "已完成", "已完成：checkbox checked");
    c.eq(todo?.stage, "待办", "待办：pending 且无可归段 activeRun");
    c.eq(doing?.stage, "执行中", "执行中：activeRun.role=implementer（干活角色）");
    c.eq(review?.stage, "审核中", "审核中：activeRun.role=test-verifier（判断角色）");
    c.eq(plan?.stage, "待设计", "待设计：计划节点带 arranged-not-expanded");
    c.eq(interview?.stage, "待设计", "待设计：访谈节点带 interviewed-not-arranged");

    // 反向：角色错配不得进"审核中"/"执行中"
    c.ne(todo?.stage, "审核中", "反向：integrator（错配角色）不得进审核中");
    c.ne(todo?.stage, "执行中", "反向：integrator（错配角色）不得进执行中");
    c.eq(todo?.activeRun?.role, "integrator", "该卡 activeRun 确实存在（判据可测）");
    c.inc(todo?.stageRule ?? "", "integrator", "stageRule 指名错配角色并按 status 归位");
    c.ne(doing?.stage, "审核中", "反向：implementer（干活角色）不得进审核中");
    c.ne(review?.stage, "执行中", "反向：test-verifier（判断角色）不得进执行中");
    c.ne(done?.stage, "审核中", "反向：test-verifier done（无 activeRun）不得进审核中");

    c.eq(
      stageCounts(board),
      { 待设计: 2, 待办: 1, 执行中: 1, 审核中: 1, 阻塞: 1, 已完成: 1 },
      "全板段位分布：该夹具六段位各有节点，无取消卡（已取消由场景 36 覆盖）",
    );
    c.eq(
      board.attentionSummary,
      { interviewedNotArranged: 1, arrangedNotExpanded: 1, interruptedResume: 3, unmergedWorktree: 1 },
      "缺口计数：三张中断可续（22/23/24）、一张待合并（23）",
    );
    c.inc(run.md, "段位", "board.md 渲染段位段");
  },
});

// ---- 补充：progress.execution 与 tasks.md 勾选数不一致 → diagnostics
scenario("t7x", "补充：progress.execution 与 tasks.md 勾选数不一致 → diagnostics（T6 遗留项）", {
  build(root) {
    w(root, "specs/drift/requirements.md", "# Requirements: 漂移特性\n");
    w(root, ".zcode/board/registry.json", JSON.stringify({
      version: 1,
      seq: 70,
      entries: [{ no: 70, kind: "spec", specRoot: "specs/drift/", title: "漂移特性", assignedAt: "2026-01-05T08:00:00+08:00" }],
    }, null, 2) + "\n");
    w(
      root,
      "specs/drift/tasks.md",
      [
        "# Implementation Plan: 漂移特性",
        "",
        "## Tasks",
        "",
        "- [ ] 1. 甲任务 <!-- zcode-board: no=71 -->",
        "  - Scope: 甲。",
        "",
        "- [x] 2. 乙任务 <!-- zcode-board: no=72 -->",
        "  - Scope: 乙。",
        "",
      ].join("\n"),
    );
    w(
      root,
      "specs/drift/progress.json",
      JSON.stringify(
        {
          version: 3,
          feature: "漂移特性",
          current: { stage: "execution", title: "其他事项" },
          stages: {
            design: { status: "completed", note: "", evidence: [] },
            execution: { status: "active", note: "", evidence: [] },
            "code-review": { status: "pending", note: "", evidence: [] },
          },
          execution: { totalTasks: 5, completedTasks: 3 },
          activity: [],
          blockers: [],
        },
        null,
        2,
      ) + "\n",
    );
  },
  assert(c, ctx) {
    const { board } = ctx;
    const ds = diagFor(board, "specs/drift/progress.json");
    c.ok(
      ds.some((d) => d.message.includes("totalTasks") && d.message.includes("5") && d.message.includes("2")),
      "totalTasks=5 与 tasks.md 条目数 2 不一致 → diagnostics 点名（不静默）",
      show(ds.map((d) => d.message)),
    );
    c.ok(
      ds.some((d) => d.message.includes("completedTasks") && d.message.includes("3") && d.message.includes("1")),
      "completedTasks=3 与 tasks.md 勾选数 1 不一致 → diagnostics 点名",
      show(ds.map((d) => d.message)),
    );
    c.eq(diagFor(board, "specs/drift/tasks.md"), [], "tasks.md 自身无解析诊断（只是与 progress 对不上）");
  },
});

// ---- 场景 36/37：契约 v2.1（T21）语法族 `> cancelled:` 与 `> agents:`
scenario("36", "契约 v2.1：> cancelled: 解析——status=cancelled/段位已取消/号不回收/未合并工作树提醒清理", {
  build(root) {
    const planRel = ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000036.md";
    w(
      root,
      planRel,
      [
        "# 取消夹具",
        "<!-- zcode-board: no=60 -->",
        "",
        "> cancelled: 无主取消行（上方无条目）",
        "",
        "- [ ] 1. 常规事项 <!-- zcode-board: no=61 -->",
        "  - Scope: 常规。",
        "",
        "- [ ] 2. 取消事项 <!-- zcode-board: no=62 -->",
        "  - Scope: 取消。",
        "  > cancelled: 上游方案变更，本卡作废",
        "",
        "- [x] 3. 勾选后取消 <!-- zcode-board: no=63 -->",
        "  - Scope: 勾选后取消。",
        "  > cancelled: 勾选后作废",
        "",
      ].join("\n"),
    );
    seedRuns(root, [
      {
        runId: "run-20261009-c1",
        sessionId: "sess_cancel",
        role: "implementer",
        at: "2026-10-09T10:00:00+08:00",
        result: "partial",
        cards: [62],
        worktree: ".zcode/worktrees/task-62",
        branch: "task-62",
        evidence: [],
        breakpoint: { stoppedAt: 62, next: "继续" },
      },
    ]);
    mkdirSync(join(root, ".zcode/worktrees/task-62"), { recursive: true });
  },
  assert(c, ctx) {
    const { board, run } = ctx;
    const planRel = ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000036.md";
    const feature = featureByTitle(board, "取消夹具");
    const plain = taskByTitle(feature, "常规事项");
    const cancelledTask = taskByTitle(feature, "取消事项");
    const checkedThenCancelled = taskByTitle(feature, "勾选后取消");

    c.eq(cancelledTask?.no, 62, "取消条目保留稳定号（号不回收）");
    c.eq(cancelledTask?.label, "2", "取消条目保留 label（#46 A2 计划内树位派生不变）");
    c.eq(cancelledTask?.status, "cancelled", "status=cancelled（> cancelled: 解析）");
    c.inc(cancelledTask?.statusRule ?? "", "上游方案变更", "取消原因留痕于 statusRule");
    c.eq(cancelledTask?.stage, "已取消", "段位=已取消（七段位第七段）");
    c.inc(cancelledTask?.stageRule ?? "", "cancelled", "stageRule 溯源到 cancelled");
    c.eq(checkedThenCancelled?.status, "cancelled", "取消优先于勾选（取消留痕优先，不落 completed）");
    c.eq(checkedThenCancelled?.stage, "已取消", "勾选后取消同为已取消段位");
    c.eq(plain?.status, "pending", "同稿其余条目不受影响");
    c.eq(plain?.stage, "待办", "同稿其余条目段位不变（待办）");

    c.ok(
      (cancelledTask?.attention ?? []).includes("unmerged-worktree"),
      "已取消卡保留未合并现场事实（attention 含 unmerged-worktree）",
      show(cancelledTask?.attention),
    );
    const ds = diagFor(board, planRel);
    c.ok(
      ds.some((d) => d.message.includes("62") && d.message.includes("清理")),
      "已取消卡 + 未合并工作树 → diagnostics 提醒走 git worktree 正规清理",
      show(ds.map((d) => d.message)),
    );
    c.ok(
      ds.some((d) => d.message.includes("语法位置无效")),
      "无主取消行（上方无任务条目）→ 不挂卡 + diagnostics",
      show(ds.map((d) => d.message)),
    );
    c.inc(run.md, "已取消", "board.md 段位呈现含已取消（v2.1 起为实产出）");
  },
});

scenario("36b", "计划内层级标签（#46 A2）：计划任务 label = 计划内层级路径（1/1.1/1.1.1），计划间可重复；spec 维持 <特性号>.<序>", {
  build(root) {
    const planA = ".zcode/plans/plan-layer-a.md";
    w(
      root,
      planA,
      [
        "# 层级甲计划",
        "<!-- zcode-board: no=1 -->",
        "- [ ] 甲 <!-- zcode-board: no=2 -->",
        "  - [ ] 甲一 <!-- zcode-board: no=3 -->",
        "    - [ ] 甲一一 <!-- zcode-board: no=4 -->",
        "- [ ] 乙 <!-- zcode-board: no=5 -->",
        "- [ ] 丙 <!-- zcode-board: no=6 -->",
        "",
      ].join("\n"),
    );
    const planB = ".zcode/plans/plan-layer-b.md";
    w(
      root,
      planB,
      ["# 层级乙计划", "<!-- zcode-board: no=10 -->", "- [ ] 丁 <!-- zcode-board: no=11 -->", ""].join("\n"),
    );
    w(root, "specs/alpha/requirements.md", "# Requirements: Alpha 特性\n");
    w(
      root,
      "specs/alpha/tasks.md",
      [
        "# Implementation Plan: Alpha",
        "",
        "- [ ] 1. 规格任务甲 <!-- zcode-board: no=21 -->",
        "  - [ ] 1.1 规格子任务 <!-- zcode-board: no=22 -->",
        "- [ ] 2. 规格任务乙 <!-- zcode-board: no=23 -->",
        "",
      ].join("\n"),
    );
    w(
      root,
      ".zcode/board/registry.json",
      `${JSON.stringify(
        {
          version: 1,
          seq: 23,
          entries: [
            { no: 1, kind: "plan", file: planA, title: "层级甲计划", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 2, kind: "task", file: planA, title: "甲", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 3, kind: "task", file: planA, title: "甲一", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 4, kind: "task", file: planA, title: "甲一一", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 5, kind: "task", file: planA, title: "乙", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 6, kind: "task", file: planA, title: "丙", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 10, kind: "plan", file: planB, title: "层级乙计划", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 11, kind: "task", file: planB, title: "丁", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 20, kind: "spec", specRoot: "specs/alpha/", title: "Alpha 特性", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 21, kind: "task", file: "specs/alpha/tasks.md", title: "规格任务甲", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 22, kind: "task", file: "specs/alpha/tasks.md", title: "规格子任务", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 23, kind: "task", file: "specs/alpha/tasks.md", title: "规格任务乙", assignedAt: "2026-10-01T00:00:00+08:00" },
          ],
        },
        null,
        2,
      )}\n`,
    );
  },
  assert(c, ctx) {
    const { board } = ctx;
    const planA = featureByTitle(board, "层级甲计划");
    c.ok(planA, "甲计划节点在板上");
    // 计划内层级：第一个任务 = 1；其子 = 1.1；再深 = 1.1.1；平级续 2/3
    c.eq(
      (planA?.tasks ?? []).map((t) => ({ label: t.label, title: t.title })),
      [
        { label: "1", title: "甲" },
        { label: "2", title: "乙" },
        { label: "3", title: "丙" },
      ],
      "计划顶层任务 label = 1..n（计划内序，不含特性号）",
    );
    c.eq(planA?.tasks?.[0]?.tasks?.[0]?.label, "1.1", "第一个任务的子任务 label = 1.1");
    c.eq(planA?.tasks?.[0]?.tasks?.[0]?.tasks?.[0]?.label, "1.1.1", "嵌套再深一层 label = 1.1.1");
    c.eq(planA?.label, "1", "计划特性 label 仍是稳定号字符串（scheme 不变）");

    const planB = featureByTitle(board, "层级乙计划");
    c.eq(planB?.tasks?.[0]?.label, "1", "第二份计划的顶层任务同样从 1 起（计划间可重复）");
    c.eq(
      [planA?.tasks?.[0]?.label, planB?.tasks?.[0]?.label],
      ["1", "1"],
      "标签唯一性收窄到所属计划内（与 planCode 组合保证项目内唯一）",
    );

    const spec = featureByTitle(board, "Alpha 特性");
    c.eq(spec?.label, "20", "spec 特性 label 仍是稳定号字符串");
    c.eq(
      (spec?.tasks ?? []).map((t) => ({ label: t.label, title: t.title })),
      [
        { label: "20.1", title: "规格任务甲" },
        { label: "20.2", title: "规格任务乙" },
      ],
      "spec 任务 label 维持 <特性号>.<序>（首段 = 特性稳定号）",
    );
    c.eq(spec?.tasks?.[0]?.tasks?.[0]?.label, "20.1.1", "spec 嵌套子任务 = <父 label>.<序>");
  },
});

scenario("36c", "当前执行者（#46 A3）：任务 currentAssignee = 管线 ∩ activeRun；特性 = 子树首个非空；无则 null（字段恒写出）", {
  build(root) {
    const planRel = ".zcode/plans/plan-assignee.md";
    w(
      root,
      planRel,
      [
        "# 责任管线夹具",
        "<!-- zcode-board: no=1 -->",
        "",
        "- **T1 甲卡（草案）**：正文。 <!-- zcode-board: no=2 -->",
        "- **T2 乙卡（草案）**：正文。 <!-- zcode-board: no=3 -->",
        "  > agents: debugger|test-verifier",
        "- **T3 丙卡（草案）**：正文。 <!-- zcode-board: no=4 -->",
        "",
      ].join("\n"),
    );
    w(
      root,
      ".zcode/plans/plan-empty.md",
      [
        "# 无执行夹具",
        "<!-- zcode-board: no=5 -->",
        "",
        "- **T1 丁卡（草案）**：正文。 <!-- zcode-board: no=6 -->",
        "",
      ].join("\n"),
    );
    seedRuns(root, [
      {
        runId: "run-36c-a",
        sessionId: "sess_36c",
        role: "implementer",
        at: "2026-10-09T10:00:00+08:00",
        result: "partial",
        cards: [2],
        breakpoint: { stoppedAt: 2, next: "继续甲" },
      },
      {
        runId: "run-36c-b",
        sessionId: "sess_36c",
        role: "code-reviewer",
        at: "2026-10-09T11:00:00+08:00",
        result: "partial",
        cards: [3],
        breakpoint: { stoppedAt: 3, next: "继续乙" },
      },
    ]);
  },
  assert(c, ctx) {
    const { board } = ctx;
    const feature = featureByTitle(board, "责任管线夹具");
    const isEmpty = featureByTitle(board, "无执行夹具");
    const [jia, yi, bing] = feature?.tasks ?? [];
    c.eq(jia?.currentAssignee, "implementer", "甲卡：标准管线 ∩ activeRun=implementer → implementer");
    c.eq(yi?.currentAssignee, null, "乙卡：自定义管线 debugger|test-verifier ∩ activeRun=code-reviewer → null（不硬指）");
    c.eq(bing?.currentAssignee, null, "丙卡：无 activeRun → null");
    c.eq(feature?.currentAssignee, "implementer", "特性：子树首个非空 currentAssignee");
    c.eq(isEmpty?.currentAssignee, null, "无执行计划：特性 currentAssignee = null");
    c.ok(
      (isEmpty?.tasks ?? []).every((t) => Object.hasOwn(t, "currentAssignee")),
      "任务卡字段恒写出（null 也显式存在，UI 无第三种形态）",
    );
    c.ok(Object.hasOwn(feature ?? {}, "currentAssignee"), "特性节点字段恒写出（null 也显式存在）");
  },
});

scenario("36d", "计划稿章节（#46 B2 数据面）：任务带 section = 上方最近章节标题；章节前条目无 section；spec 任务无该字段", {
  build(root) {
    const planRel = ".zcode/plans/plan-sections.md";
    w(
      root,
      planRel,
      [
        "# 章节夹具",
        "<!-- zcode-board: no=1 -->",
        "",
        "- **T0 序前卡（草案）**：章节前条目。 <!-- zcode-board: no=2 -->",
        "",
        "## UI 期",
        "",
        "- **T1 甲（草案）**：正文。 <!-- zcode-board: no=3 -->",
        "",
        "## 梦",
        "",
        "- **T2 乙（草案）**：正文。 <!-- zcode-board: no=4 -->",
        "  - **T2.1 乙子（草案）**：正文。 <!-- zcode-board: no=5 -->",
        "",
        "## 远期",
        "",
        "- **T3 丙（草案）**：正文。 <!-- zcode-board: no=6 -->",
        "",
      ].join("\n"),
    );
    w(root, "specs/beta/requirements.md", "# Requirements: Beta 特性\n");
    w(root, "specs/beta/tasks.md", ["# Implementation Plan: Beta", "", "- [ ] 1. 规格卡 <!-- zcode-board: no=11 -->", ""].join("\n"));
    w(
      root,
      ".zcode/board/registry.json",
      `${JSON.stringify(
        {
          version: 1,
          seq: 11,
          entries: [
            { no: 1, kind: "plan", file: planRel, title: "章节夹具", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 2, kind: "task", file: planRel, title: "序前卡（草案）", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 3, kind: "task", file: planRel, title: "甲（草案）", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 4, kind: "task", file: planRel, title: "乙（草案）", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 5, kind: "task", file: planRel, title: "乙子（草案）", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 6, kind: "task", file: planRel, title: "丙（草案）", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 10, kind: "spec", specRoot: "specs/beta/", title: "Beta 特性", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 11, kind: "task", file: "specs/beta/tasks.md", title: "规格卡", assignedAt: "2026-10-01T00:00:00+08:00" },
          ],
        },
        null,
        2,
      )}\n`,
    );
  },
  assert(c, ctx) {
    const { board } = ctx;
    const plan = featureByTitle(board, "章节夹具");
    const [序前, 甲, 乙] = plan?.tasks ?? [];
    c.eq(序前?.title, "序前卡（草案）", "章节前条目在板上");
    c.ok(!Object.hasOwn(序前 ?? {}, "section"), "章节前条目无 section 字段（不编造空章节）");
    c.eq(甲?.section, "UI 期", "甲卡 section = 上方最近章节标题");
    c.eq(乙?.section, "梦", "乙卡 section = 最近章节（后一个章节覆盖前一个）");
    c.eq(乙?.tasks?.[0]?.section, "梦", "嵌套子卡继承所在章节");
    c.eq(plan?.tasks?.[3]?.section, "远期", "丙卡 section = 远期");
    const spec = featureByTitle(board, "Beta 特性");
    c.ok(!Object.hasOwn(spec?.tasks?.[0] ?? {}, "section"), "spec 任务无 section 字段（章节是计划稿概念）");
  },
});

scenario("37", "契约 v2.1：> agents: 解析——assignees 顺序即管线序；缺省=标准管线；表外角色整行不解析", {
  build(root) {
    w(
      root,
      ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000037.md",
      [
        "# 指派夹具",
        "<!-- zcode-board: no=70 -->",
        "",
        "- [ ] 1. 默认管线 <!-- zcode-board: no=71 -->",
        "  - Scope: 默认。",
        "",
        "- [ ] 2. 定制管线 <!-- zcode-board: no=72 -->",
        "  - Scope: 定制。",
        "  > agents: debugger | test-verifier",
        "",
        "- [ ] 3. 表外角色 <!-- zcode-board: no=73 -->",
        "  - Scope: 表外。",
        "  > agents: implementer | reviewer",
        "",
        "- [ ] 4. 重复声明 <!-- zcode-board: no=74 -->",
        "  - Scope: 重复。",
        "  > agents: code-reviewer | integrator",
        "  > agents: debugger",
        "",
      ].join("\n"),
    );
  },
  assert(c, ctx) {
    const { board, run } = ctx;
    const planRel = ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000037.md";
    const feature = featureByTitle(board, "指派夹具");
    const byDefault = taskByTitle(feature, "默认管线");
    const custom = taskByTitle(feature, "定制管线");
    const invalid = taskByTitle(feature, "表外角色");
    const duplicate = taskByTitle(feature, "重复声明");

    c.eq(
      byDefault?.assignees,
      ["implementer", "test-verifier", "code-reviewer", "integrator"],
      "缺省=标准管线（implementer→test-verifier→code-reviewer→integrator，免写）",
    );
    c.eq(custom?.assignees, ["debugger", "test-verifier"], "> agents: 顺序即管线序（逐字保留）");
    c.eq(
      invalid?.assignees,
      ["implementer", "test-verifier", "code-reviewer", "integrator"],
      "含表外角色 → 整行不解析，assignees 保持缺省标准管线（不猜）",
    );
    c.eq(duplicate?.assignees, ["code-reviewer", "integrator"], "同卡多条 > agents: 行 → 首条有效者生效");

    const ds = diagFor(board, planRel);
    c.ok(
      ds.some((d) => d.message.includes("reviewer")),
      "表外角色 → diagnostics 点名（不静默）",
      show(ds.map((d) => d.message)),
    );
    c.ok(
      ds.some((d) => d.message.includes("首条")),
      "重复 > agents: 行 → diagnostics 提示首条生效",
      show(ds.map((d) => d.message)),
    );
    const allHave = [byDefault, custom, invalid, duplicate].every((t) => Array.isArray(t?.assignees) && t.assignees.length > 0);
    c.ok(allHave, "每张卡均携带 assignees（字符串数组，非空）");
    c.inc(run.md, "管线", "board.md 渲染非标准管线（可读呈现）");
  },
});

// ---- 场景 39（S2）：tasks.md 引用族行 → 不解析 + diagnostics 逐行点名（不挂卡）
scenario("39", "S2：tasks.md 引用族行（> blocked:/blocked-by:/cancelled:/agents:）不解析 + diagnostics 逐行点名、不挂卡", {
  build(root) {
    w(root, "specs/reffam/requirements.md", "# Requirements: 引用族夹具\n");
    w(root, ".zcode/board/registry.json", JSON.stringify({
      version: 1,
      seq: 71,
      entries: [{ no: 70, kind: "spec", specRoot: "specs/reffam/", title: "引用族夹具", assignedAt: "2026-01-05T08:00:00+08:00" }],
    }, null, 2) + "\n");
    w(
      root,
      "specs/reffam/tasks.md",
      [
        "# Implementation Plan: 引用族夹具",
        "",
        "## Tasks",
        "",
        "- [ ] 1. 甲任务 <!-- zcode-board: no=71 -->",
        "  - Scope: 甲。",
        "  > blocked-by: 70 —— 等待特性 70",
        "  > cancelled: 上游方案变更（本行不解析）",
        "  > agents: debugger | test-verifier",
        "",
      ].join("\n"),
    );
  },
  assert(c, ctx) {
    const { board } = ctx;
    const feature = featureByTitle(board, "引用族夹具");
    const task = taskByTitle(feature, "甲任务");
    c.eq(feature?.tasks?.length, 1, "引用族行不产出卡（仍恰 1 张任务卡）");
    c.eq(task?.no, 71, "任务条目正常解析（引用族行不干扰条目）");
    c.eq(task?.status, "pending", "> cancelled: 行不解析：status 不落 cancelled（取消留痕只属计划稿语法族）");
    c.eq(
      task?.assignees,
      ["implementer", "test-verifier", "code-reviewer", "integrator"],
      "> agents: 行不解析：assignees 保持缺省标准管线（不猜、不部分接受）",
    );
    c.eq(task?.blockers, [], "> blocked-by: 行不解析：不造引用（blockers 为空，spec 侧真相源是 progress.json）");
    const ds = diagFor(board, "specs/reffam/tasks.md");
    c.eq(ds.length, 3, "三条引用族行各一条 diagnostics（不静默）");
    c.ok(
      ds.length === 3 &&
        ds.every(
          (d) =>
            d.message.includes("tasks.md 不引入该语法族") &&
            d.message.includes("本行不解析") &&
            d.message.includes("progress.json"),
        ),
      "文案对齐 markers.md §7 反例表：tasks.md 不引入该语法族：本行不解析（spec 侧阻塞真相源是 progress.json）",
      show(ds.map((d) => d.message)),
    );
    c.ok(
      [7, 8, 9].every((n) => ds.some((d) => d.message.includes(`第 ${n} 行`))),
      "诊断逐行点名（第 7/8/9 行）",
      show(ds.map((d) => d.message)),
    );
  },
});

// ---- 场景 53a（#53 / 契约 v2.3）：计划稿特性段位随子卡汇总；arranged-not-expanded 判据收窄为零卡
scenario("53a", "#53：plan 特性段位随子卡汇总（全完成→已完成 / 半勾→执行中 / 未勾→待办 / 零卡→待设计）；有卡不再误挂 arranged-not-expanded", {
  build(root) {
    const doneRel = ".zcode/plans/plan-53-done.md";
    w(
      root,
      doneRel,
      [
        "# 全完成计划",
        "<!-- zcode-board: no=1 -->",
        "",
        "- [x] 1. 甲卡（草案） <!-- zcode-board: no=2 -->",
        "- [x] 2. 乙卡（草案） <!-- zcode-board: no=3 -->",
        "",
      ].join("\n"),
    );
    const halfRel = ".zcode/plans/plan-53-half.md";
    w(
      root,
      halfRel,
      [
        "# 半勾计划",
        "<!-- zcode-board: no=4 -->",
        "",
        "- [x] 1. 甲卡（草案） <!-- zcode-board: no=5 -->",
        "  - [ ] 1.1 甲子卡（草案） <!-- zcode-board: no=6 -->",
        "- [ ] 2. 乙卡（草案） <!-- zcode-board: no=7 -->",
        "",
      ].join("\n"),
    );
    const pendingRel = ".zcode/plans/plan-53-pending.md";
    w(
      root,
      pendingRel,
      [
        "# 未勾计划",
        "<!-- zcode-board: no=8 -->",
        "",
        "- [ ] 1. 甲卡（草案） <!-- zcode-board: no=9 -->",
        "- [ ] 2. 乙卡（草案） <!-- zcode-board: no=10 -->",
        "",
      ].join("\n"),
    );
    const emptyRel = ".zcode/plans/plan-53-empty.md";
    w(root, emptyRel, ["# 空稿计划", "<!-- zcode-board: no=11 -->", "", "（本稿无可识别任务语法）", ""].join("\n"));
    w(
      root,
      ".zcode/board/registry.json",
      `${JSON.stringify(
        {
          version: 1,
          seq: 11,
          entries: [
            { no: 1, kind: "plan", file: doneRel, title: "全完成计划", assignedAt: "2026-10-01T00:00:00+08:00", planCode: "DONE" },
            { no: 4, kind: "plan", file: halfRel, title: "半勾计划", assignedAt: "2026-10-01T00:00:00+08:00", planCode: "HALF" },
            { no: 8, kind: "plan", file: pendingRel, title: "未勾计划", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 11, kind: "plan", file: emptyRel, title: "空稿计划", assignedAt: "2026-10-01T00:00:00+08:00" },
          ],
        },
        null,
        2,
      )}\n`,
    );
  },
  assert(c, ctx) {
    const { board, run } = ctx;
    const done = featureByTitle(board, "全完成计划");
    const half = featureByTitle(board, "半勾计划");
    const pending = featureByTitle(board, "未勾计划");
    const empty = featureByTitle(board, "空稿计划");
    c.eq(done?.attention, [], "全完成计划：有卡（不再按 draft 误判）→ 不挂 arranged-not-expanded");
    c.eq(done?.stage, "已完成", "全完成计划：子卡 2/2 completed → 段位已完成（不受 status=active 压制）");
    c.inc(done?.stageRule ?? "", "子卡汇总 2/2", "stageRule 写明子卡汇总 N/M");
    c.eq(done?.tasks?.map((t) => t.stage), ["已完成", "已完成"], "子卡各自段位：勾选 = 已完成");
    c.eq(done?.planCode, "DONE", "计划码透传（本场景同时覆盖 D1 嵌套渲染的所属计划）");

    c.eq(half?.attention, [], "半勾计划：有卡 → 不挂 arranged-not-expanded");
    c.eq(half?.stage, "执行中", "半勾计划（status=active，未全完成）→ 原推导执行中");
    c.inc(half?.stageRule ?? "", "子卡汇总 1/3", "stageRule 写明子卡汇总 N/M（含嵌套子卡）");

    c.eq(pending?.attention, [], "未勾计划：有卡 → 不挂 arranged-not-expanded");
    c.eq(pending?.stage, "待办", "未勾计划（status=pending 且无 activeRun）→ 原推导待办");
    c.inc(pending?.stageRule ?? "", "子卡汇总 0/2", "stageRule 写明子卡汇总 N/M");

    c.eq(empty?.attention, ["arranged-not-expanded"], "零卡计划：判据收窄后仍挂 arranged-not-expanded（宁误报不漏报）");
    c.eq(empty?.stage, "待设计", "零卡计划 → 段位待设计");
    c.inc(empty?.stageRule ?? "", "arranged-not-expanded", "stageRule 溯源到缺口码");
    c.ok(
      !(empty?.stageRule ?? "").includes("汇总"),
      "零卡计划稿 stageRule 无「子卡汇总 0/0」后缀（T5356r S-2 速修不回退：零卡无汇总可言）",
      empty?.stageRule,
    );
    c.eq(board.attentionSummary.arrangedNotExpanded, 1, "全板 arranged-not-expanded 计数 = 1（仅零卡稿）");

    c.inc(run.md, "子卡汇总 2/2", "board.md 渲染子卡汇总 stageRule");
    // D1（第二绿发现）：嵌套任务行必须透传计划码（<计划码>-<层级>），不得回落 ID-<层级>
    c.inc(run.md, "HALF-1.1", "board.md 嵌套任务行渲染 <计划码>-<层级>（HALF-1.1）");
    c.ok(!run.md.includes("ID-1.1"), "board.md 嵌套任务行不再回落 ID-<层级>（ID-1.1 不出现）");
  },
});

// ---- 场景 53b（#53 / 契约 v2.3）：roadmap 占位稿标记——独立注释与合并注释、段位恒待设计、非法位置
const S53B = {
  standaloneRel: ".zcode/plans/plan-53-roadmap-a.md",
  combinedRel: ".zcode/plans/plan-53-roadmap-b.md",
  badRel: ".zcode/plans/plan-53-roadmap-bad.md",
};
scenario("53b", "#53：roadmap 标记（独立/合并注释）→ plan.roadmap=true、特性与全部卡段位恒待设计；非法位置不生效 + diagnostics、--check 非零", {
  build(root) {
    const standaloneRel = S53B.standaloneRel;
    w(
      root,
      standaloneRel,
      [
        "# 路线占位稿（独立注释）",
        "<!-- zcode-board: no=1 -->",
        "<!-- zcode-board: roadmap -->",
        "",
        "说明：下例在反引号内，是文档示例（不构成标记）：`<!-- zcode-board: roadmap -->`",
        "",
        "```",
        "<!-- zcode-board: roadmap -->",
        "```",
        "",
        "- [x] 1. 已勾选条目 <!-- zcode-board: no=2 -->",
        "- [ ] 2. 未勾选条目 <!-- zcode-board: no=3 -->",
        "  - [ ] 2.1 子条目 <!-- zcode-board: no=4 -->",
        "",
      ].join("\n"),
    );
    const combinedRel = S53B.combinedRel;
    w(
      root,
      combinedRel,
      [
        "# 合并注释占位稿",
        "<!-- zcode-board: no=5, roadmap -->",
        "",
        "- [ ] 1. 条目 <!-- zcode-board: no=6 -->",
        "",
      ].join("\n"),
    );
    const badRel = S53B.badRel;
    w(
      root,
      badRel,
      [
        "# 非法占位稿（标记在章节内）",
        "<!-- zcode-board: no=8 -->",
        "",
        "## 章节",
        "",
        "<!-- zcode-board: roadmap -->",
        "",
        "- [ ] 1. 条目 <!-- zcode-board: no=9 -->",
        "",
      ].join("\n"),
    );
    w(root, "specs/gamma/requirements.md", "# Requirements: Gamma 特性\n");
    w(
      root,
      "specs/gamma/tasks.md",
      [
        "# Implementation Plan: Gamma",
        "",
        "## Tasks",
        "",
        "- [ ] 1. 甲任务 <!-- zcode-board: no=21 -->",
        "",
        "<!-- zcode-board: roadmap -->",
        "",
      ].join("\n"),
    );
    w(
      root,
      ".zcode/board/registry.json",
      `${JSON.stringify(
        {
          version: 1,
          seq: 21,
          entries: [
            { no: 20, kind: "spec", specRoot: "specs/gamma/", title: "Gamma 特性", assignedAt: "2026-10-01T00:00:00+08:00" },
          ],
        },
        null,
        2,
      )}\n`,
    );
  },
  assert(c, ctx) {
    const { board, root } = ctx;
    const badRel = S53B.badRel;
    const standalone = featureByTitle(board, "路线占位稿（独立注释）");
    const combined = featureByTitle(board, "合并注释占位稿");
    const bad = featureByTitle(board, "非法占位稿（标记在章节内）");
    const gamma = featureByTitle(board, "Gamma 特性");

    c.eq(standalone?.roadmap, true, "独立注释 roadmap 标记 → plan.roadmap=true");
    c.eq(standalone?.stage, "待设计", "roadmap 稿特性段位恒待设计");
    c.inc(standalone?.stageRule ?? "", "roadmap", "特性 stageRule 溯源 roadmap 标记");
    c.eq(
      standalone?.tasks?.map((t) => t.stage),
      ["待设计", "待设计"],
      "roadmap 稿顶层卡段位恒待设计（勾选与否不影响：占位稿本稿条目本身不执行）",
    );
    c.eq(standalone?.tasks?.[0]?.status, "completed", "roadmap 不改 status（勾选事实仍如实落 completed）");
    c.eq(standalone?.tasks?.[1]?.tasks?.[0]?.stage, "待设计", "roadmap 稿嵌套子卡段位同样待设计");
    c.eq(standalone?.attention, [], "roadmap 稿有卡 → 无 arranged-not-expanded");

    c.eq(combined?.no, 5, "合并注释（no=N, roadmap）仍解析出特性号");
    c.eq(combined?.roadmap, true, "合并注释 roadmap 标记 → plan.roadmap=true");
    c.eq(combined?.stage, "待设计", "合并注释稿段位恒待设计");
    c.eq(combined?.tasks?.[0]?.stage, "待设计", "合并注释稿子卡段位恒待设计");
    c.eq(
      // 过滤收窄为「roadmap 标记（第 N 行）…」类诊断（标记解释/位置类）——T5356r P-2 后本稿因"已勾选条目"
      // 另有提示级激活诊断（属新行为，由场景 57b 断言），不属"示例被当作标记"一类，不在此断言面。
      diagFor(board, S53B.standaloneRel).filter((d) => d.message.includes("roadmap 标记")),
      [],
      "反引号内/围栏代码块内的语法示例不构成标记（无标记解释类诊断；文档可安全引用 v2.3 语法）",
    );
    c.ok(
      diagFor(board, S53B.standaloneRel).some((d) => d.message.includes("建议复核占位标记")),
      "该稿有勾选条目 → 提示级激活诊断（P-2 新行为；示例行本身不进诊断面）",
      show(diagFor(board, S53B.standaloneRel).map((d) => d.message)),
    );

    c.ok(!Object.hasOwn(bad ?? {}, "roadmap"), "非法位置（二级标题下）的 roadmap 标记不生效（不落 roadmap 字段）");
    c.eq(bad?.stage, "待办", "非法位置不生效：段位按常规推导（待办）");
    const badDiags = diagFor(board, badRel).map((d) => d.message);
    c.ok(
      badDiags.some((m) => m.includes("roadmap") && (m.includes("位置无效") || m.includes("H1"))),
      "非法位置 diagnostics 点名（不静默）",
      show(badDiags),
    );
    c.ok(!Object.hasOwn(gamma ?? {}, "roadmap"), "spec 特性不产出 roadmap 字段");
    const specDiags = diagFor(board, "specs/gamma/tasks.md").map((d) => d.message);
    c.ok(
      specDiags.some((m) => m.includes("roadmap")),
      "tasks.md 中的 roadmap 标记位置无效 + diagnostics（只在计划稿 H1 层合法）",
      show(specDiags),
    );

    // --check：非法位置 → 失败级；合法位置（独立/合并注释稿）不进失败项
    const check = checkProject(root);
    const roadmapFailures = check.failures.filter((f) => f.category === "roadmap 标记");
    c.ok(roadmapFailures.length === 2, `--check 对两处非法 roadmap 标记各报失败（实际 ${roadmapFailures.length} 项）`, show(roadmapFailures.map((f) => f.message)));
    c.ok(
      roadmapFailures.some((f) => String(f.message).includes("plan-53-roadmap-bad.md")) &&
        roadmapFailures.some((f) => String(f.message).includes("specs/gamma/tasks.md")),
      "失败项逐处点名（非法位置稿 与 tasks.md）",
      show(roadmapFailures.map((f) => f.message)),
    );
    c.eq(check.ok, false, "--check 非零（含非法 roadmap 标记时）");
  },
});

// ---- 场景 53c（#53 / 契约 v2.3）：nextAssignee 卡级派生
scenario("53c", "#53：nextAssignee = assignees 序中首个无 done run 证据的角色；三绿卡→integrator；全 done→null", {
  build(root) {
    const planRel = ".zcode/plans/plan-53-next-assignee.md";
    w(
      root,
      planRel,
      [
        "# 接手人夹具",
        "<!-- zcode-board: no=1 -->",
        "",
        "- **T1 三绿卡（草案）**：缺 integrator。 <!-- zcode-board: no=10 -->",
        "- **T2 已合并卡（草案）**：四角色全 done。 <!-- zcode-board: no=11 -->",
        "- **T3 新卡（草案）**：无执行记录。 <!-- zcode-board: no=12 -->",
        "- **T4 自定义管线卡（草案）**：debugger→test-verifier。 <!-- zcode-board: no=13 -->",
        "  > agents: debugger|test-verifier",
        "- **T5 仅 integrator 管线（草案）**：integrator partial 未 done。 <!-- zcode-board: no=14 -->",
        "  > agents: integrator",
        "",
      ].join("\n"),
    );
    seedRuns(root, [
      { runId: "run-53c-a1", sessionId: "sess_53c", role: "implementer", at: "2026-10-09T10:00:00+08:00", result: "done", cards: [10], breakpoint: null },
      { runId: "run-53c-a2", sessionId: "sess_53c", role: "test-verifier", at: "2026-10-09T11:00:00+08:00", result: "done", cards: [10], breakpoint: null },
      { runId: "run-53c-a3", sessionId: "sess_53c", role: "code-reviewer", at: "2026-10-09T12:00:00+08:00", result: "done", cards: [10], breakpoint: null },
      { runId: "run-53c-b1", sessionId: "sess_53c", role: "implementer", at: "2026-10-09T10:00:00+08:00", result: "done", cards: [11], breakpoint: null },
      { runId: "run-53c-b2", sessionId: "sess_53c", role: "test-verifier", at: "2026-10-09T11:00:00+08:00", result: "done", cards: [11], breakpoint: null },
      { runId: "run-53c-b3", sessionId: "sess_53c", role: "code-reviewer", at: "2026-10-09T12:00:00+08:00", result: "done", cards: [11], breakpoint: null },
      { runId: "run-53c-b4", sessionId: "sess_53c", role: "integrator", at: "2026-10-09T13:00:00+08:00", result: "done", cards: [11], breakpoint: null },
      { runId: "run-53c-c1", sessionId: "sess_53c", role: "implementer", at: "2026-10-09T10:00:00+08:00", result: "partial", cards: [12], breakpoint: { stoppedAt: 12, next: "续做" } },
      { runId: "run-53c-d1", sessionId: "sess_53c", role: "test-verifier", at: "2026-10-09T11:00:00+08:00", result: "done", cards: [13], breakpoint: null },
      { runId: "run-53c-e1", sessionId: "sess_53c", role: "integrator", at: "2026-10-09T11:00:00+08:00", result: "partial", cards: [14], breakpoint: { stoppedAt: 14, next: "重试合并" } },
    ]);
  },
  assert(c, ctx) {
    const { board } = ctx;
    const f = featureByTitle(board, "接手人夹具");
    const threeGreen = taskByTitle(f, "三绿卡（草案）");
    const merged = taskByTitle(f, "已合并卡（草案）");
    const fresh = taskByTitle(f, "新卡（草案）");
    const custom = taskByTitle(f, "自定义管线卡（草案）");
    const onlyIntegrator = taskByTitle(f, "仅 integrator 管线（草案）");
    c.eq(threeGreen?.nextAssignee, "integrator", "三绿卡（implementer/test-verifier/code-reviewer done）→ integrator");
    c.eq(merged?.nextAssignee, null, "四角色全有 done 证据（含 integrator done=已合并）→ null");
    c.eq(fresh?.nextAssignee, "implementer", "无 run 卡 → 管线首角色（标准管线 implementer）");
    c.ok(
      (f?.tasks ?? []).every((t) => Object.hasOwn(t, "nextAssignee")),
      "任务卡字段恒写出（null 也显式存在）",
    );
    c.eq(custom?.nextAssignee, "debugger", "自定义管线：按管线序取首个无 done 证据者（debugger）");
    c.eq(onlyIntegrator?.nextAssignee, "integrator", "partial 不算 done 证据：integrator 仍在接手位");
    c.eq(threeGreen?.currentAssignee, null, "nextAssignee 与 currentAssignee 独立（done 收尾 → 无 activeRun → currentAssignee null）");
    c.eq(board.version, 2, "板主版本不变（nextAssignee 为 v2.3 兼容增量）");
  },
});

// ---------------------------------------------------------------- #56 事实互证（--check 不变量扩展）

/** #56 夹具公用件：读磁盘 board.json / board.md（夹具作者面，独立于编译器内部结构）。 */
function readBoardJson(root) {
  return JSON.parse(readFileSync(join(root, ".zcode/board/board.json"), "utf8"));
}
function readBoardMd(root) {
  return readFileSync(join(root, ".zcode/board/board.md"), "utf8");
}
/** 事实互证失败项文案（--check 的失败级类别，一条不变量一项）。 */
function factFailuresOf(check) {
  return (check.failures ?? []).filter((f) => f.category === "事实互证").map((f) => f.message);
}

// ---- 场景 56a（#56 不变量 a）：特性子卡全部 completed → 特性 stage=已完成
scenario("56a", "#56 不变量 a：子卡全部 completed 的 plan 特性 stage=已完成（假板必咬 + 正常板零噪声）", {
  build(root) {
    const planRel = ".zcode/plans/plan-56a-done.md";
    w(
      root,
      planRel,
      ["# 全完成计划 56a", "<!-- zcode-board: no=1 -->", "", "- [x] 1. 甲卡 <!-- zcode-board: no=2 -->", "- [x] 2. 乙卡 <!-- zcode-board: no=3 -->", ""].join(
        "\n",
      ),
    );
    w(
      root,
      ".zcode/board/registry.json",
      `${JSON.stringify(
        {
          version: 1,
          seq: 3,
          entries: [
            { no: 1, kind: "plan", file: planRel, title: "全完成计划 56a", assignedAt: "2026-10-01T00:00:00+08:00", planCode: "DONE" },
            { no: 2, kind: "task", file: planRel, title: "甲卡", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 3, kind: "task", file: planRel, title: "乙卡", assignedAt: "2026-10-01T00:00:00+08:00" },
          ],
        },
        null,
        2,
      )}\n`,
    );
  },
  assert(c, ctx) {
    const { root, board } = ctx;
    const boardRel = ".zcode/board/board.json";
    c.eq(board.features[0]?.stage, "已完成", "夹具前置：全完成 plan 特性 stage=已完成（编译器正确派生，不变量 a 的绿侧）");
    const clean = checkProject(root);
    c.ok(clean.ok, "正常板 --check 通过（事实互证零噪声）", show(clean.failures.map((f) => `[${f.category}] ${f.message}`)));

    // 违例夹具（假板）：stage 被改成"待办"——事实互证必须点名（路径 + 编号 + 两值对照）
    const tampered = readBoardJson(root);
    tampered.features[0].stage = "待办";
    w(root, boardRel, `${JSON.stringify(tampered, null, 2)}\n`);
    const bad = checkProject(root);
    const facts = factFailuresOf(bad);
    c.eq(facts.length, 1, "假板（全完成却 stage=待办）恰好触发 1 项事实互证失败", show(facts));
    const msg = facts[0] ?? "";
    c.inc(msg, "不变量 a", "失败项点名不变量 a");
    c.inc(msg, "features[0]", "失败项点名节点路径 features[0]");
    c.inc(msg, "#1", "失败项点名节点编号 #1");
    c.inc(msg, "待办", "失败项给出实际值（待办）");
    c.inc(msg, "已完成", "失败项给出应然值（已完成）");
    const cli = runCompiler(root, ["--check"]);
    c.eq(cli.code, 1, "假板：--check 非零退出（失败级）");
    c.inc(cli.stdout, "事实互证", "stdout 报告事实互证失败项");
  },
});

// ---- 场景 56b（#56 不变量 b）：有卡的特性不得挂 arranged-not-expanded（roadmap 稿同理）
scenario("56b", "#56 不变量 b：已有任务卡的特性不得挂 arranged-not-expanded（roadmap 稿压制段位但不误报未拆解）", {
  build(root) {
    const planRel = ".zcode/plans/plan-56b-roadmap-done.md";
    w(
      root,
      planRel,
      ["# 路线占位稿 56b", "<!-- zcode-board: no=10, roadmap -->", "", "- [x] 1. 占位条目 <!-- zcode-board: no=11 -->", ""].join("\n"),
    );
    w(
      root,
      ".zcode/board/registry.json",
      `${JSON.stringify(
        {
          version: 1,
          seq: 11,
          entries: [
            { no: 10, kind: "plan", file: planRel, title: "路线占位稿 56b", assignedAt: "2026-10-01T00:00:00+08:00", planCode: "ROAD" },
            { no: 11, kind: "task", file: planRel, title: "占位条目", assignedAt: "2026-10-01T00:00:00+08:00" },
          ],
        },
        null,
        2,
      )}\n`,
    );
  },
  assert(c, ctx) {
    const { root, board } = ctx;
    const boardRel = ".zcode/board/board.json";
    const f = featureByTitle(board, "路线占位稿 56b");
    c.eq(f?.roadmap, true, "夹具前置：roadmap 占位稿标记生效（plan.roadmap=true）");
    c.eq([f?.stage, f?.tasks?.[0]?.status], ["待设计", "completed"], "夹具前置：卡全部 completed 但 roadmap 压制段位为待设计（不变量 a 不误报）");
    c.eq(f?.attention, [], "夹具前置：有卡 → 不挂 arranged-not-expanded");
    const clean = checkProject(root);
    c.ok(clean.ok, "正常板 --check 通过（事实互证零噪声）", show(clean.failures.map((x) => `[${x.category}] ${x.message}`)));

    // 违例夹具（假板）：有卡却挂 arranged-not-expanded（连同 attentionSummary 同步篡改，
    // 隔离出不变量 b 这一项——结构断言/互检不因计数失配叠加噪声）
    const tampered = readBoardJson(root);
    tampered.features[0].attention.push("arranged-not-expanded");
    tampered.attentionSummary.arrangedNotExpanded += 1;
    w(root, boardRel, `${JSON.stringify(tampered, null, 2)}\n`);
    const bad = checkProject(root);
    const facts = factFailuresOf(bad);
    // TQ-1 扩面后该篡改同时使 board.md 与 board.json 失配（板新增缺口节点、md 无待处理节）→
    // 除不变量 b 外另有 1 项待处理节缺失点名（属互证面扩面的正确副作用）；此处隔离出不变量 b 恰 1 项。
    const bFacts = facts.filter((m) => m.includes("不变量 b"));
    c.eq(bFacts.length, 1, "假板（有卡挂未拆解）触发不变量 b 恰 1 项", show(facts));
    c.ok(
      facts.some((m) => m.includes("待处理节缺少编号链")),
      "同一篡改的 board.md 与 board.json 失配亦被 TQ-1 待处理节对照点名（互证面扩面的正确副作用）",
      show(facts),
    );
    const msg = bFacts[0] ?? "";
    c.inc(msg, "不变量 b", "失败项点名不变量 b");
    c.inc(msg, "features[0]", "失败项点名节点路径 features[0]");
    c.inc(msg, "#10", "失败项点名节点编号 #10");
    c.inc(msg, "arranged-not-expanded", "失败项点名缺口码 arranged-not-expanded");
    c.ok(!msg.includes("不变量 a"), "roadmap 压制段位不误报不变量 a（全完成≠已完成，属设计内）", msg);
    const cli = runCompiler(root, ["--check"]);
    c.eq(cli.code, 1, "假板：--check 非零退出（失败级）");
    c.inc(cli.stdout, "事实互证", "stdout 报告事实互证失败项");
  },
});

// ---- 场景 56c（#56 不变量 c）：board.md 编号形态与 board.json planCode/label 派生一致（D1 守卫）
scenario("56c", "#56 不变量 c：board.md 编号形态 ↔ board.json 派生（嵌套任务行含递归深度 ≥2，D1 类渲染回归必咬）", {
  build(root) {
    const planRel = ".zcode/plans/plan-56c-nested.md";
    w(
      root,
      planRel,
      [
        "# 嵌套编号计划 56c",
        "<!-- zcode-board: no=20 -->",
        "",
        "- [x] 1. 顶层甲 <!-- zcode-board: no=21 -->",
        "- [ ] 2. 顶层乙 <!-- zcode-board: no=22 -->",
        "  - [ ] 2.1 嵌套子卡 <!-- zcode-board: no=23 -->",
        "    - [ ] 2.1.1 更深子卡 <!-- zcode-board: no=24 -->",
        "",
      ].join("\n"),
    );
    w(
      root,
      ".zcode/board/registry.json",
      `${JSON.stringify(
        {
          version: 1,
          seq: 24,
          entries: [
            { no: 20, kind: "plan", file: planRel, title: "嵌套编号计划 56c", assignedAt: "2026-10-01T00:00:00+08:00", planCode: "NEST" },
            { no: 21, kind: "task", file: planRel, title: "顶层甲", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 22, kind: "task", file: planRel, title: "顶层乙", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 23, kind: "task", file: planRel, title: "嵌套子卡", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 24, kind: "task", file: planRel, title: "更深子卡", assignedAt: "2026-10-01T00:00:00+08:00" },
          ],
        },
        null,
        2,
      )}\n`,
    );
  },
  assert(c, ctx) {
    const { root, board, run } = ctx;
    const mdRel = ".zcode/board/board.md";
    // 渲染绿侧：三层嵌套全部渲染 <计划码>-<层级>（深度 ≥2 不漏传计划码）
    for (const id of ["NEST-1", "NEST-2", "NEST-2.1", "NEST-2.1.1"]) {
      c.inc(run.md, `- ${id} ·`, `board.md 渲染 ${id}（<计划码>-<层级>，含深度 3）`);
    }
    c.ok(!run.md.includes("ID-2.1"), "board.md 嵌套任务行不回落 ID-<层级>（旧 D1 形态不出现）");
    const clean = checkProject(root);
    c.ok(clean.ok, "正常板 --check 通过（编号形态互证零噪声）", show(clean.failures.map((x) => `[${x.category}] ${x.message}`)));

    // 违例夹具：把最深一层任务行改回旧 D1 形态（ID-2.1.1）
    const md = readBoardMd(root);
    const tamperedMd = md.replace("- NEST-2.1.1 ·", "- ID-2.1.1 ·");
    c.ok(tamperedMd !== md, "夹具前置：命中待篡改的嵌套任务行（NEST-2.1.1）");
    w(root, mdRel, tamperedMd);
    const tamperedLine = tamperedMd.split(/\r?\n/).findIndex((l) => l.includes("- ID-2.1.1 ·")) + 1;

    const bad = checkProject(root);
    const facts = factFailuresOf(bad);
    c.eq(facts.length, 1, "假板（嵌套行回落 ID-2.1.1）恰好触发 1 项事实互证失败", show(facts));
    const msg = facts[0] ?? "";
    c.inc(msg, "不变量 c", "失败项点名不变量 c");
    c.inc(msg, `第 ${tamperedLine} 行`, "失败项点名 board.md 行号（第 " + tamperedLine + " 行）");
    c.inc(msg, "ID-2.1.1", "失败项给出实际渲染形态（ID-2.1.1）");
    c.inc(msg, "NEST-2.1.1", "失败项给出应然派生形态（NEST-2.1.1）");
    c.inc(msg, "features[0].tasks[1].tasks[0].tasks[0]", "失败项点名嵌套节点路径（递归深度 3）");
    c.inc(msg, "#24", "失败项点名节点编号 #24");
    const cli = runCompiler(root, ["--check"]);
    c.eq(cli.code, 1, "假板：--check 非零退出（失败级）");
    c.inc(cli.stdout, "事实互证", "stdout 报告事实互证失败项");
  },
});

// ---- 场景 56d（#56 不变量 d）：board.json 携带 stageSummary 时与全板节点 stage 逐项复算相等
scenario("56d", "#56 不变量 d：stageSummary（如携带）与全板节点 stage 逐项复算相等（错一项必咬；正确零噪声）", {
  build(root) {
    const planRel = ".zcode/plans/plan-56d-counts.md";
    w(
      root,
      planRel,
      ["# 段位计数计划 56d", "<!-- zcode-board: no=30 -->", "", "- [x] 1. 勾选卡 <!-- zcode-board: no=31 -->", "- [ ] 2. 未勾选卡 <!-- zcode-board: no=32 -->", ""].join("\n"),
    );
    w(
      root,
      ".zcode/board/registry.json",
      `${JSON.stringify(
        {
          version: 1,
          seq: 32,
          entries: [
            { no: 30, kind: "plan", file: planRel, title: "段位计数计划 56d", assignedAt: "2026-10-01T00:00:00+08:00", planCode: "CNT1" },
            { no: 31, kind: "task", file: planRel, title: "勾选卡", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 32, kind: "task", file: planRel, title: "未勾选卡", assignedAt: "2026-10-01T00:00:00+08:00" },
          ],
        },
        null,
        2,
      )}\n`,
    );
  },
  assert(c, ctx) {
    const { root, board } = ctx;
    const boardRel = ".zcode/board/board.json";
    c.eq(
      Object.hasOwn(board, "stageSummary"),
      false,
      "夹具前置：编译器当前不携带 stageSummary（不变量 d 为「如携带」判定：不携带 → 零噪声）",
    );
    const clean = checkProject(root);
    c.ok(clean.ok, "正常板 --check 通过（事实互证零噪声）", show(clean.failures.map((x) => `[${x.category}] ${x.message}`)));

    // 违例夹具（假板）：携带 stageSummary 且错一项（已完成 5，复算 1；其余项按夹具真值手写）
    const correctSummary = { 待设计: 0, 待办: 1, 执行中: 1, 审核中: 0, 阻塞: 0, 已完成: 1, 已取消: 0 };
    const tampered = readBoardJson(root);
    tampered.stageSummary = { ...correctSummary, 已完成: 5 };
    w(root, boardRel, `${JSON.stringify(tampered, null, 2)}\n`);
    const bad = checkProject(root);
    const facts = factFailuresOf(bad);
    c.eq(facts.length, 1, "假板（已完成计数 5 vs 复算 1）恰好触发 1 项事实互证失败", show(facts));
    const msg = facts[0] ?? "";
    c.inc(msg, "不变量 d", "失败项点名不变量 d");
    c.inc(msg, 'stageSummary."已完成"=5', '失败项给出携带值与路径（stageSummary."已完成"=5）');
    c.inc(msg, "复算 1", "失败项给出复算值（复算 1）");
    const cli = runCompiler(root, ["--check"]);
    c.eq(cli.code, 1, "假板：--check 非零退出（失败级）");
    c.inc(cli.stdout, "事实互证", "stdout 报告事实互证失败项");

    // 反向对照：同一字段但取正确计数 → 不变量 d 不再报（非恒红判据；其余失败仅属板/源互检）
    const fixed = readBoardJson(root);
    fixed.stageSummary = { ...correctSummary };
    w(root, boardRel, `${JSON.stringify(fixed, null, 2)}\n`);
    const okCheck = checkProject(root);
    c.eq(factFailuresOf(okCheck), [], "正确计数：不变量 d 零违例（携带但相等 → 通过）");
    c.ok(
      okCheck.failures.every((x) => x.category !== "事实互证"),
      "正确计数：失败项仅来自板/源互检（多出字段），不掺事实互证",
      show(okCheck.failures.map((x) => `[${x.category}] ${x.message}`)),
    );
  },
});

// ---------------------------------------------------------------- #57 第三绿发现批次（T5356r）

// ---- 场景 57a（TQ-3）：--assign 不改写合并形态 roadmap 头标记；合法位多条 roadmap 标记首个生效 + diagnostics
scenario("57a", "TQ-3：--assign 幂等不写入/不改写 roadmap 子旗标（合并形态头标记零改写）；多条合法 roadmap 标记首个生效 + 提示级 diagnostics（--check 不阻断）", {
  steps: [{ args: ["--assign"] }, { args: ["--assign"] }],
  build(root) {
    // 合并形态头标记（no=100, roadmap）：--assign 不得重复盖号、不得改写子旗标
    const mergedRel57 = ".zcode/plans/plan-57-merged-roadmap.md";
    w(root, mergedRel57, ["# 合并头标记占位稿 57", "<!-- zcode-board: no=100, roadmap -->", "", "- [ ] 1. 占位条目 <!-- zcode-board: no=101 -->", ""].join("\n"));
    // 合法位多条 roadmap 标记（H1 层：合并 + 独立两形态同现）：首个生效 + diagnostics
    const dupRel57 = ".zcode/plans/plan-57-dup-roadmap.md";
    w(
      root,
      dupRel57,
      ["# 多条 roadmap 标记稿 57", "<!-- zcode-board: no=110, roadmap -->", "<!-- zcode-board: roadmap -->", "", "- [ ] 1. 条目 <!-- zcode-board: no=111 -->", ""].join("\n"),
    );
    w(
      root,
      ".zcode/board/registry.json",
      `${JSON.stringify(
        {
          version: 1,
          seq: 111,
          entries: [
            { no: 100, kind: "plan", file: mergedRel57, title: "合并头标记占位稿 57", assignedAt: "2026-10-01T00:00:00+08:00", planCode: "MERG" },
            { no: 101, kind: "task", file: mergedRel57, title: "占位条目", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 110, kind: "plan", file: dupRel57, title: "多条 roadmap 标记稿 57", assignedAt: "2026-10-01T00:00:00+08:00", planCode: "DUPR" },
            { no: 111, kind: "task", file: dupRel57, title: "条目", assignedAt: "2026-10-01T00:00:00+08:00" },
          ],
        },
        null,
        2,
      )}\n`,
    );
  },
  assert(c, ctx) {
    const { root, board, assigns } = ctx;
    const mergedRel57 = ".zcode/plans/plan-57-merged-roadmap.md";
    const dupRel57 = ".zcode/plans/plan-57-dup-roadmap.md";
    const [a1, a2] = assigns;

    c.eq([a1?.code, a2?.code], [0, 0], "--assign 两次均退出码 0");
    const diffFirst = diffSnapshot(ctx.before, a1.after, ALLOWED_OUTPUTS);
    c.eq(
      diffFirst.changed.map((x) => x.rel).filter((rel) => !ALLOWED_OUTPUTS.includes(rel)),
      [],
      "首次 --assign 零源写入（合并形态头标记被认作已盖号：不变写、不补盖；registry 逐字节不变）",
    );
    const diffSecond = diffSnapshot(a1.after, a2.after);
    c.eq(
      diffSecond.changed.map((x) => x.rel).filter((rel) => !ALLOWED_OUTPUTS.includes(rel)),
      [],
      "第二次 --assign 幂等（源与 registry 零写入）",
    );
    c.eq(diffSecond.added, [], "第二次 --assign 无新增文件");
    c.eq(diffSecond.removed, [], "第二次 --assign 无删除文件");

    const mergedText = readFileSync(join(root, mergedRel57), "utf8");
    c.inc(mergedText, "<!-- zcode-board: no=100, roadmap -->", "合并形态头标记逐字保留（子旗标不改写）");
    c.eq(
      mergedText.split(/\r?\n/).filter((l) => l.includes("zcode-board: no=")).length,
      2,
      "合并头标记稿无重复盖号（号标记恰两处：头标记 + 条目行尾）",
    );
    const dupText = readFileSync(join(root, dupRel57), "utf8");
    c.eq(
      dupText.split(/\r?\n/).filter((l) => /zcode-board:\s*(no=[1-9][0-9]*\s*,\s*roadmap|roadmap)\s*-->/.test(l)).length,
      2,
      "多条标记稿两条 roadmap 标记逐字保留（--assign 不改写）",
    );

    const merged = featureByTitle(board, "合并头标记占位稿 57");
    const dup = featureByTitle(board, "多条 roadmap 标记稿 57");
    c.eq([merged?.roadmap, merged?.stage], [true, "待设计"], "合并形态：roadmap=true、段位恒待设计");
    c.eq([dup?.roadmap, dup?.stage], [true, "待设计"], "多条标记：首个生效（roadmap=true）、段位恒待设计");
    const dupDiags = diagFor(board, dupRel57).map((d) => d.message);
    c.ok(
      dupDiags.some((m) => m.includes("roadmap 标记出现多条") && m.includes("首个有效者生效")),
      "auditRoadmap.duplicates：合法位多条标记 → diagnostics 点名（首个生效、其余忽略，不静默）",
      show(dupDiags),
    );
    const check = checkProject(root);
    c.ok(check.ok, "多条合法 roadmap 标记为提示级（--check 不阻断，0 失败）", show(check.failures.map((f) => `[${f.category}] ${f.message}`)));
  },
});

// ---- 场景 57b（P-2）：roadmap 占位稿出现激活迹象（勾选记录 / done-partial run 证据）→ 提示级 diagnostics
scenario("57b", "P-2：roadmap 稿出现勾选记录或卡 run 证据 → 提示级 diagnostics「建议复核占位标记」（不阻断；未激活稿零噪声）", {
  build(root) {
    const checkedRel = ".zcode/plans/plan-57b-checked-roadmap.md";
    w(root, checkedRel, ["# 勾选激活占位稿 57b", "<!-- zcode-board: no=120, roadmap -->", "", "- [x] 1. 已勾选条目 <!-- zcode-board: no=121 -->", ""].join("\n"));
    const runRel = ".zcode/plans/plan-57b-run-roadmap.md";
    w(root, runRel, ["# run 激活占位稿 57b", "<!-- zcode-board: no=130, roadmap -->", "", "- [ ] 1. 条目 <!-- zcode-board: no=131 -->", ""].join("\n"));
    const quietRel = ".zcode/plans/plan-57b-quiet-roadmap.md";
    w(root, quietRel, ["# 静默占位稿 57b", "<!-- zcode-board: no=140, roadmap -->", "", "- [ ] 1. 条目 <!-- zcode-board: no=141 -->", ""].join("\n"));
    seedRuns(root, [
      {
        runId: "run-20261009-57b",
        sessionId: "sess_0057b",
        role: "implementer",
        at: "2026-10-09T14:20:00+08:00",
        result: "done",
        cards: [131],
        evidence: [".zcode/board/evidence/T57/x.md"],
        breakpoint: null,
      },
    ]);
    w(
      root,
      ".zcode/board/registry.json",
      `${JSON.stringify(
        {
          version: 1,
          seq: 141,
          entries: [
            { no: 120, kind: "plan", file: checkedRel, title: "勾选激活占位稿 57b", assignedAt: "2026-10-01T00:00:00+08:00", planCode: "CHK1" },
            { no: 121, kind: "task", file: checkedRel, title: "已勾选条目", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 130, kind: "plan", file: runRel, title: "run 激活占位稿 57b", assignedAt: "2026-10-01T00:00:00+08:00", planCode: "RUN1" },
            { no: 131, kind: "task", file: runRel, title: "条目", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 140, kind: "plan", file: quietRel, title: "静默占位稿 57b", assignedAt: "2026-10-01T00:00:00+08:00", planCode: "QUI1" },
            { no: 141, kind: "task", file: quietRel, title: "条目", assignedAt: "2026-10-01T00:00:00+08:00" },
          ],
        },
        null,
        2,
      )}\n`,
    );
  },
  assert(c, ctx) {
    const { root, board } = ctx;
    const checkedRel = ".zcode/plans/plan-57b-checked-roadmap.md";
    const runRel = ".zcode/plans/plan-57b-run-roadmap.md";
    const quietRel = ".zcode/plans/plan-57b-quiet-roadmap.md";

    const checkedMsgs = diagFor(board, checkedRel).map((d) => d.message);
    c.ok(
      checkedMsgs.some((m) => m.includes("建议复核占位标记") && m.includes("勾选记录 1 条")),
      "勾选记录的 roadmap 稿：提示级 diagnostics 明文「建议复核占位标记」+ 勾选迹象",
      show(checkedMsgs),
    );
    const runMsgs = diagFor(board, runRel).map((d) => d.message);
    c.ok(
      runMsgs.some((m) => m.includes("建议复核占位标记") && m.includes("done/partial run 证据 1 卡")),
      "卡有 done/partial run 的 roadmap 稿：提示级 diagnostics + run 迹象",
      show(runMsgs),
    );
    c.eq(diagFor(board, quietRel), [], "未激活（无勾选、无 run）的 roadmap 稿零噪声（不误报）");
    c.eq(
      [featureByTitle(board, "勾选激活占位稿 57b")?.stage, featureByTitle(board, "run 激活占位稿 57b")?.stage],
      ["待设计", "待设计"],
      "提示不改判据：roadmap 稿段位仍恒待设计（激活后由编排者复核移除标记）",
    );
    const check = checkProject(root);
    c.ok(check.ok, "提示级不阻断：--check 仍 0 失败", show(check.failures.map((f) => `[${f.category}] ${f.message}`)));
    c.eq(
      check.failures.filter((f) => String(f.message).includes("建议复核占位标记")).length,
      0,
      "提示不落失败级（仅 diagnostics 点名）",
    );
  },
});

// ---- 场景 57c（TQ-1）：不变量 (c) 扩面——编号对照覆盖 board.md 的 ## 待处理 / ## 待合并 节（walkBoardNodes 渲染位）
scenario("57c", "TQ-1：不变量 (c) 扩面——## 待处理 / ## 待合并 节的编号链（walkBoardNodes 渲染位，含嵌套）与 board.json 派生一致；篡改必咬、正常零噪声", {
  build(root) {
    const planRel = ".zcode/plans/plan-57c-sections.md";
    w(
      root,
      planRel,
      [
        "# 章节渲染互证稿 57c",
        "<!-- zcode-board: no=200 -->",
        "",
        "- [ ] 1. 中断卡 <!-- zcode-board: no=201 -->",
        "- [ ] 2. 待合并卡 <!-- zcode-board: no=202 -->",
        "  - [ ] 2.1 嵌套待合并卡 <!-- zcode-board: no=203 -->",
        "",
      ].join("\n"),
    );
    // unmerged-worktree 判据要求目录经 fs 互证：建真实工作树目录（空目录即可）
    mkdirSync(join(root, ".zcode/worktrees/task-202"), { recursive: true });
    mkdirSync(join(root, ".zcode/worktrees/task-203"), { recursive: true });
    seedRuns(root, [
      {
        runId: "run-20261009-57c-1",
        sessionId: "sess_0057c",
        role: "implementer",
        at: "2026-10-09T10:00:00+08:00",
        result: "partial",
        cards: [201],
        evidence: ["e1.md"],
        breakpoint: { stoppedAt: 201, next: "补测试" },
      },
      {
        runId: "run-20261009-57c-2",
        sessionId: "sess_0057c",
        role: "implementer",
        at: "2026-10-09T11:00:00+08:00",
        result: "done",
        cards: [202],
        worktree: ".zcode/worktrees/task-202",
        branch: "task-202",
        evidence: ["e2.md"],
        breakpoint: null,
      },
      {
        runId: "run-20261009-57c-3",
        sessionId: "sess_0057c",
        role: "implementer",
        at: "2026-10-09T12:00:00+08:00",
        result: "partial",
        cards: [203],
        worktree: ".zcode/worktrees/task-203",
        branch: "task-203",
        evidence: ["e3.md"],
        breakpoint: { stoppedAt: 203, next: "继续" },
      },
    ]);
    w(
      root,
      ".zcode/board/registry.json",
      `${JSON.stringify(
        {
          version: 1,
          seq: 203,
          entries: [
            { no: 200, kind: "plan", file: planRel, title: "章节渲染互证稿 57c", assignedAt: "2026-10-01T00:00:00+08:00", planCode: "SEC1" },
            { no: 201, kind: "task", file: planRel, title: "中断卡", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 202, kind: "task", file: planRel, title: "待合并卡", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 203, kind: "task", file: planRel, title: "嵌套待合并卡", assignedAt: "2026-10-01T00:00:00+08:00" },
          ],
        },
        null,
        2,
      )}\n`,
    );
  },
  assert(c, ctx) {
    const { root, run } = ctx;
    const mdRel = ".zcode/board/board.md";
    // 绿侧渲染：待处理（两类码，含深度 2 链）与待合并节
    c.inc(run.md ?? "", "## 待处理", "board.md 渲染 ## 待处理 节");
    c.inc(run.md ?? "", "  - SEC1 > SEC1-1 中断卡", "待处理节：中断卡链渲染（计划码 + 层级）");
    c.inc(run.md ?? "", "  - SEC1 > SEC1-2 待合并卡 > SEC1-2.1 ", "待处理节：嵌套链渲染（深度 2，编号链含父级全链）");
    c.inc(run.md ?? "", "- SEC1 > SEC1-2 待合并卡 —— .zcode/worktrees/task-202", "待合并节：顶层链 + 工作树渲染");
    const clean = checkProject(root);
    c.ok(clean.ok, "正常板 --check 通过（章节编号互证零噪声）", show(clean.failures.map((x) => `[${x.category}] ${x.message}`)));

    // 篡改 1：待处理节把中断卡链的计划码形态改为 ID-1（D1 类回落）→ 必咬
    const md = readBoardMd(root);
    const tampered1 = md.replace("  - SEC1 > SEC1-1 中断卡", "  - SEC1 > ID-1 中断卡");
    c.ok(tampered1 !== md, "夹具前置：命中待处理节中断卡链");
    w(root, mdRel, tampered1);
    const tamperedLine1 = tampered1.split(/\r?\n/).findIndex((l) => l.includes("SEC1 > ID-1 中断卡")) + 1;
    const bad1 = checkProject(root);
    const facts1 = factFailuresOf(bad1);
    c.eq(facts1.length, 1, "待处理节链回落 ID-1：恰好触发 1 项事实互证失败", show(facts1));
    const msg1 = facts1[0] ?? "";
    c.inc(msg1, "不变量 c", "失败项点名不变量 c");
    c.inc(msg1, "待处理", "失败项点名节名（待处理）");
    c.inc(msg1, `第 ${tamperedLine1} 行`, `失败项点名 board.md 行号（第 ${tamperedLine1} 行）`);
    c.inc(msg1, "ID-1", "失败项给出实际渲染链");
    c.inc(msg1, "SEC1-1", "失败项给出应然派生链");
    const cli1 = runCompiler(root, ["--check"]);
    c.eq(cli1.code, 1, "待处理节篡改：--check 非零退出（失败级）");
    c.inc(cli1.stdout, "事实互证", "stdout 报告事实互证失败项");

    // 篡改 2：待合并节把顶层链形态改为 ID-2 → 必咬（待合并节在对照面）
    w(root, mdRel, tampered1); // 复位到仅篡改 1 的文本后再叠加篡改 2（独立行）
    const tampered2 = tampered1.replace("SEC1 > SEC1-2 待合并卡 —— ", "SEC1 > ID-2 待合并卡 —— ");
    c.ok(tampered2 !== tampered1, "夹具前置：命中待合并节顶层链");
    w(root, mdRel, tampered2);
    const bad2 = checkProject(root);
    const facts2 = factFailuresOf(bad2);
    c.ok(
      facts2.some((m) => m.includes("待合并") && m.includes("ID-2") && m.includes("SEC1-2")),
      "待合并节链回落 ID-2：事实互证点名（节名 + 两值对照）",
      show(facts2),
    );
  },
});

// ---------------------------------------------------------------- #66 取消终态语义补全（T66 跟进批次）

// ---- 场景 66a（#66-1）：roadmap 段位压制对 status=cancelled 让位（取消是终态，优先级最高）
scenario("66a", "#66：roadmap 占位稿中的取消卡段位=已取消（取消为终态、优先于 roadmap 压制）；未取消卡仍待设计", {
  build(root) {
    const rel = ".zcode/plans/plan-66a-cancelled-roadmap.md";
    w(
      root,
      rel,
      [
        "# 取消让位稿",
        "<!-- zcode-board: no=300 -->",
        "<!-- zcode-board: roadmap -->",
        "",
        "- [ ] 1. 常规占位条目 <!-- zcode-board: no=301 -->",
        "- [ ] 2. 取消占位条目 <!-- zcode-board: no=302 -->",
        "  > cancelled: 随稿撤销（取消留痕）",
        "  - [ ] 2.1 嵌套取消子条目 <!-- zcode-board: no=303 -->",
        "    > cancelled: 随稿撤销",
        "",
      ].join("\n"),
    );
    w(
      root,
      ".zcode/board/registry.json",
      `${JSON.stringify(
        {
          version: 1,
          seq: 303,
          entries: [
            { no: 300, kind: "plan", file: rel, title: "取消让位稿", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 301, kind: "task", file: rel, title: "常规占位条目", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 302, kind: "task", file: rel, title: "取消占位条目", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 303, kind: "task", file: rel, title: "嵌套取消子条目", assignedAt: "2026-10-01T00:00:00+08:00" },
          ],
        },
        null,
        2,
      )}\n`,
    );
  },
  assert(c, ctx) {
    const { board, root, run } = ctx;
    const feature = featureByTitle(board, "取消让位稿");
    const plain = taskByTitle(feature, "常规占位条目");
    const cancelledTask = taskByTitle(feature, "取消占位条目");
    const nested = cancelledTask?.tasks?.[0] ?? null;

    c.eq(feature?.roadmap, true, "夹具前置：该稿 roadmap=true（占位稿）");
    c.eq(feature?.stage, "待设计", "特性自身未取消：段位仍待设计（roadmap 压制不回退）");
    c.eq(plain?.status, "pending", "未取消卡 status 照常派生");
    c.eq(plain?.stage, "待设计", "未取消卡仍受 roadmap 压制（待设计）");
    c.eq(cancelledTask?.status, "cancelled", "取消卡 status=cancelled（> cancelled: 解析不受 roadmap 影响）");
    c.eq(cancelledTask?.stage, "已取消", "取消卡段位=已取消（#66：取消为终态，让位于 roadmap 压制）");
    c.inc(cancelledTask?.stageRule ?? "", "cancelled", "取消卡 stageRule 溯源到 cancelled（非 roadmap 压制文案）");
    c.ok(
      !(cancelledTask?.stageRule ?? "").includes("恒为待设计"),
      "取消卡不带「段位恒为待设计」的 roadmap 压制文案（#66 让位不静默）",
      show(cancelledTask?.stageRule),
    );
    c.eq(nested?.stage, "已取消", "嵌套取消子卡同样让位于 roadmap 压制（递归口径一致）");

    const check = checkProject(root);
    c.ok(check.ok, "--check 通过：取消+roadmap 卡不触发不变量 a/b 误报（cancelled 不算 completed）", show(check.failures.map((f) => `[${f.category}] ${f.message}`)));
    c.inc(run.md, "已取消", "board.md 段位呈现含已取消（取消卡不让位于压制）");
  },
});

// ---- 场景 66b（#66-2）：特性级取消落点——计划稿 H1 标记行之后、首个非引用行之前的 `> cancelled:`
scenario("66b", "#66：特性级 > cancelled: 落点（H1 标记行后、首个非引用行前，允许与 roadmap 独立注释并存）→ 特性 cancelled/已取消；区域外仍不解析", {
  build(root) {
    const roadmapRel = ".zcode/plans/plan-66b-feature-cancelled-roadmap.md";
    w(
      root,
      roadmapRel,
      [
        "# 特性级取消稿",
        "<!-- zcode-board: no=310 -->",
        "<!-- zcode-board: roadmap -->",
        "> cancelled: 用户 2026-10-10 指令撤掉本方案（取消留痕、条目保留）",
        "",
        "- [ ] 1. 条目甲 <!-- zcode-board: no=311 -->",
        "",
      ].join("\n"),
    );
    const repeatRel = ".zcode/plans/plan-66b-feature-cancelled-repeat.md";
    w(
      root,
      repeatRel,
      [
        "# 合并形态头标记取消稿",
        "<!-- zcode-board: no=320, roadmap -->",
        "> cancelled: 方案变更（首条）",
        "> cancelled: 重复行（应被忽略）",
        "",
        "- [ ] 1. 条目乙 <!-- zcode-board: no=321 -->",
        "",
      ].join("\n"),
    );
    const outsideRel = ".zcode/plans/plan-66b-outside-region.md";
    w(
      root,
      outsideRel,
      [
        "# 区域外取消稿",
        "<!-- zcode-board: no=330 -->",
        "",
        "> cancelled: 空行隔断（区域外，不解析为特性级）",
        "",
        "- [ ] 1. 条目丙 <!-- zcode-board: no=331 -->",
        "",
      ].join("\n"),
    );
    const emptyRel = ".zcode/plans/plan-66b-empty-reason.md";
    w(
      root,
      emptyRel,
      [
        "# 无原因特性级取消稿",
        "<!-- zcode-board: no=340 -->",
        "> cancelled:",
        "",
        "- [ ] 1. 条目丁 <!-- zcode-board: no=341 -->",
        "",
      ].join("\n"),
    );
    w(
      root,
      ".zcode/board/registry.json",
      `${JSON.stringify(
        {
          version: 1,
          seq: 341,
          entries: [
            { no: 310, kind: "plan", file: roadmapRel, title: "特性级取消稿", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 311, kind: "task", file: roadmapRel, title: "条目甲", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 320, kind: "plan", file: repeatRel, title: "合并形态头标记取消稿", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 321, kind: "task", file: repeatRel, title: "条目乙", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 330, kind: "plan", file: outsideRel, title: "区域外取消稿", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 331, kind: "task", file: outsideRel, title: "条目丙", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 340, kind: "plan", file: emptyRel, title: "无原因特性级取消稿", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 341, kind: "task", file: emptyRel, title: "条目丁", assignedAt: "2026-10-01T00:00:00+08:00" },
          ],
        },
        null,
        2,
      )}\n`,
    );
  },
  assert(c, ctx) {
    const { board, root } = ctx;
    const roadmapFeature = featureByTitle(board, "特性级取消稿");
    const repeatFeature = featureByTitle(board, "合并形态头标记取消稿");
    const outsideFeature = featureByTitle(board, "区域外取消稿");
    const emptyFeature = featureByTitle(board, "无原因特性级取消稿");

    // (a) 与 roadmap 独立注释并存：特性级取消解析（特性 cancelled/已取消，优先于 roadmap 压制）
    c.eq(roadmapFeature?.roadmap, true, "并存形态：roadmap 标记照常生效（roadmap=true）");
    c.eq(roadmapFeature?.status, "cancelled", "特性级 > cancelled: → 特性 status=cancelled");
    c.inc(roadmapFeature?.statusRule ?? "", "撤掉本方案", "特性级取消原因留痕于 statusRule");
    c.eq(roadmapFeature?.stage, "已取消", "特性段位=已取消（特性自身取消 > roadmap 压制）");
    c.inc(roadmapFeature?.stageRule ?? "", "cancelled", "特性 stageRule 溯源到 cancelled");
    c.eq(roadmapFeature?.tasks?.[0]?.stage, "待设计", "子卡自身未取消：仍受 roadmap 压制（待设计）");
    c.eq(roadmapFeature?.tasks?.[0]?.status, "pending", "子卡 status 照常派生（不受特性级取消影响）");

    // (b) 合并形态头标记 + 多条特性级取消：首条有效者生效 + diagnostics
    c.eq(repeatFeature?.status, "cancelled", "合并形态头标记稿：特性级取消照常解析");
    c.inc(repeatFeature?.statusRule ?? "", "方案变更（首条）", "多条特性级取消：首条有效者生效");
    c.ok(
      !(repeatFeature?.statusRule ?? "").includes("重复行"),
      "多条特性级取消：后者不进入 statusRule（不静默改写）",
      show(repeatFeature?.statusRule),
    );
    const repeatDiags = diagFor(board, ".zcode/plans/plan-66b-feature-cancelled-repeat.md").map((d) => d.message);
    c.ok(
      repeatDiags.some((m) => m.includes("多条") && m.includes("首条有效者生效")),
      "多条特性级取消 → diagnostics 点名（首条生效、其余忽略）",
      show(repeatDiags),
    );

    // (c) 区域外（空行隔断）：不解析为特性级取消，保持原"语法位置无效"路径
    c.eq(outsideFeature?.status, "pending", "区域外取消行不解析：特性 status 照常派生（pending）");
    c.eq(outsideFeature?.stage, "待办", "区域外取消行不解析：段位按常规推导（待办）");
    const outsideDiags = diagFor(board, ".zcode/plans/plan-66b-outside-region.md").map((d) => d.message);
    c.ok(
      outsideDiags.some((m) => m.includes("语法位置无效")),
      "区域外取消行：上方无任务条目 → diagnostics（不吞不静默）",
      show(outsideDiags),
    );

    // (d) 空原因：与卡级同口径（未记原因，不造内容）
    c.eq(emptyFeature?.status, "cancelled", "空原因特性级取消照常解析");
    c.inc(emptyFeature?.statusRule ?? "", "未记原因", "空原因 statusRule 写「未记原因」（与卡级同口径）");
    c.eq(emptyFeature?.stage, "已取消", "空原因特性级取消段位=已取消");

    const check = checkProject(root);
    c.ok(check.ok, "--check 通过（特性级取消不触发事实互证误报）", show(check.failures.map((f) => `[${f.category}] ${f.message}`)));
  },
});

// ---- 场景 66c（#66-3）：全取消子卡汇总 → 特性已取消（与全完成→已完成对称；混合态不 rollup）
scenario("66c", "#66：全部子卡 cancelled（子卡数>0）→ 特性段位=已取消（优先于 roadmap 压制）；混合态不 rollup、零卡不 rollup", {
  build(root) {
    const allRel = ".zcode/plans/plan-66c-all-cancelled.md";
    w(
      root,
      allRel,
      [
        "# 全取消稿",
        "<!-- zcode-board: no=350 -->",
        "",
        "- [ ] 1. 取消甲 <!-- zcode-board: no=351 -->",
        "  > cancelled: 甲取消",
        "- [ ] 2. 取消乙 <!-- zcode-board: no=352 -->",
        "  > cancelled: 乙取消",
        "  - [ ] 2.1 取消乙子 <!-- zcode-board: no=353 -->",
        "    > cancelled: 乙子取消",
        "",
      ].join("\n"),
    );
    const mixedRel = ".zcode/plans/plan-66c-mixed.md";
    w(
      root,
      mixedRel,
      [
        "# 混合稿",
        "<!-- zcode-board: no=360 -->",
        "",
        "- [ ] 1. 取消丙 <!-- zcode-board: no=361 -->",
        "  > cancelled: 丙取消",
        "- [ ] 2. 未取消丁 <!-- zcode-board: no=362 -->",
        "",
      ].join("\n"),
    );
    const roadmapAllRel = ".zcode/plans/plan-66c-roadmap-all-cancelled.md";
    w(
      root,
      roadmapAllRel,
      [
        "# 全取消占位稿",
        "<!-- zcode-board: no=370 -->",
        "<!-- zcode-board: roadmap -->",
        "",
        "- [ ] 1. 占位取消 <!-- zcode-board: no=371 -->",
        "  > cancelled: 占位撤销",
        "",
      ].join("\n"),
    );
    const zeroRel = ".zcode/plans/plan-66c-zero-card.md";
    w(root, zeroRel, ["# 零卡稿", "<!-- zcode-board: no=380 -->", "", "正文（无可识别条目）。", ""].join("\n"));
    w(
      root,
      ".zcode/board/registry.json",
      `${JSON.stringify(
        {
          version: 1,
          seq: 380,
          entries: [
            { no: 350, kind: "plan", file: allRel, title: "全取消稿", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 351, kind: "task", file: allRel, title: "取消甲", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 352, kind: "task", file: allRel, title: "取消乙", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 353, kind: "task", file: allRel, title: "取消乙子", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 360, kind: "plan", file: mixedRel, title: "混合稿", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 361, kind: "task", file: mixedRel, title: "取消丙", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 362, kind: "task", file: mixedRel, title: "未取消丁", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 370, kind: "plan", file: roadmapAllRel, title: "全取消占位稿", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 371, kind: "task", file: roadmapAllRel, title: "占位取消", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 380, kind: "plan", file: zeroRel, title: "零卡稿", assignedAt: "2026-10-01T00:00:00+08:00" },
          ],
        },
        null,
        2,
      )}\n`,
    );
  },
  assert(c, ctx) {
    const { board, root } = ctx;
    const allCancelled = featureByTitle(board, "全取消稿");
    const mixed = featureByTitle(board, "混合稿");
    const roadmapAll = featureByTitle(board, "全取消占位稿");
    const zeroCard = featureByTitle(board, "零卡稿");

    c.eq(allCancelled?.stage, "已取消", "全部子卡 cancelled（含嵌套，3/3）→ 特性段位=已取消");
    c.inc(allCancelled?.stageRule ?? "", "全部 cancelled", "stageRule 记全取消汇总口径（与全完成 N/M 对称）");
    c.eq(allCancelled?.status, "pending", "rollup 只改段位：特性 status 照旧派生（无勾选 → pending）");
    c.eq(
      allCancelled?.tasks?.map((t) => t.stage),
      ["已取消", "已取消"],
      "全取消稿各卡段位=已取消（卡级不受影响）",
    );
    c.eq(allCancelled?.tasks?.[1]?.tasks?.[0]?.stage, "已取消", "嵌套取消子卡段位=已取消");

    c.eq(mixed?.stage, "待办", "混合态（取消+未取消）不 rollup：段位照旧推导（待办）");
    c.ok(!(mixed?.stageRule ?? "").includes("全部 cancelled"), "混合态 stageRule 不带全取消汇总文案", show(mixed?.stageRule));

    c.eq(roadmapAll?.roadmap, true, "全取消占位稿：roadmap=true");
    c.eq(roadmapAll?.stage, "已取消", "全取消汇总优先于 roadmap 压制（终态优先序：rollup > 现有推导）");

    c.eq(zeroCard?.stage, "待设计", "零卡稿不 rollup（子卡数>0 为判据）：段位照旧（待设计）");

    const check = checkProject(root);
    c.ok(check.ok, "--check 通过（全取消稿不触发事实互证误报）", show(check.failures.map((f) => `[${f.category}] ${f.message}`)));
  },
});

// ---------------------------------------------------------------- #67 技能包版本化（版本单一事实源 / --version / --manifest / 三处同源）

// ---- 场景 67a（#67-2）：compile-board.mjs --version 单行输出 包版本 / 契约版本 / schema 版本
scenario("67a", "#67：--version 单行输出 `zcode-board <包版本> · 契约 <vX.Y> · schema <vX.Y>`（读 markers.md 变更段头与 schema x-schemaVersion；无项目根、只读）", {
  build(root) {
    // 空项目即可：--version 与项目无关（不读写 <项目根>）
    w(root, ".zcode/board/.keep", "");
  },
  assert(c, ctx) {
    const res = spawnSync(process.execPath, [COMPILER, "--version"], { encoding: "utf8", cwd: ctx.root });
    c.eq(res.status, 0, "--version 退出码 0（无项目根亦可）");
    c.eq(
      res.stdout,
      `zcode-board ${SKILL_VERSION} · 契约 v2.5 · schema v2.4\n`,
      "--version 恰一行：包版本（常量）/ 契约 v2.5 / schema v2.4（A1-5 收口事实值：契约 v2.4 已被 #72 占用、A1 批顺延；末位/次位随版本策略 bump）",
    );
    c.inc(res.stdout, "zcode-board 0.5.0", "--version 包版本字面 0.5.0（独立事实值，非由常量自证）");
    c.eq(res.stderr, "", "--version 无 stderr 输出");
  },
});

// ---- 场景 67b（#67-1/#67-3/#67-6）：三处同源 + 三段式接受集 + 冻结件 #66 例外成文
scenario("67b", "#67：SKILL_VERSION 常量（0.5.0）↔ board.json generatedBy ↔ SKILL.md 头部版本行同值；同卡扩展：包/契约/schema 三版本在常量、markers 段头、schema 版本位与读取器四处同源互锁；三段式 generatedBy 过 schema/公共不变量、旧两段式拒收", {
  build(root) {
    const rel = ".zcode/plans/plan-67b.md";
    w(
      root,
      rel,
      ["# 版本化稿", "<!-- zcode-board: no=401 -->", "", "- [ ] 1. 版本卡 <!-- zcode-board: no=402 -->", ""].join("\n"),
    );
    w(
      root,
      ".zcode/board/registry.json",
      `${JSON.stringify(
        {
          version: 1,
          seq: 402,
          entries: [
            { no: 401, kind: "plan", file: rel, title: "版本化稿", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 402, kind: "task", file: rel, title: "版本卡", assignedAt: "2026-10-01T00:00:00+08:00" },
          ],
        },
        null,
        2,
      )}\n`,
    );
  },
  assert(c, ctx) {
    const { board } = ctx;
    const boardText = ctx.run.boardText ?? "";
    const md = ctx.run.md ?? "";

    // 事实源常量（卡文事实值：包版本自 0.3.0 起步、0.3.1 为 #69/#71 修订、0.4.0 = #72 扫描面配置化、
    // 0.5.0 = A1 批收口顺延，0.2 是编译器历史版本）
    c.eq(SKILL_VERSION, "0.5.0", "lib/version.mjs SKILL_VERSION === 0.5.0（唯一事实源；A1-5 #80 收口）");

    // ---- 三版本同源（A1-5 #80 形态扩展）：包/契约/schema 三版本在各自唯一事实源、读取器与硬写位处取值互锁
    // 独立事实值：契约 v2.5（v2.4 已被 #72 占用，A1 批顺延）、schema v2.4、包 0.5.0（版本策略次版本级）
    const schema = JSON.parse(readFileSync(join(ASSETS_DIR, "board.schema.json"), "utf8"));
    c.eq(readContractVersion(), "2.5", "契约版本 = markers.md 最高变更段头 === 2.5（A1-5 顺延）");
    c.eq(readSchemaVersion(), "2.4", "schema 版本 = board.schema.json x-schemaVersion === 2.4（A1-5 顺延）");
    c.eq(
      readVersionInfo(),
      { name: "zcode-board", packageVersion: "0.5.0", contractVersion: "2.5", schemaVersion: "2.4" },
      "readVersionInfo 三版本一次性读数 = 0.5.0 / v2.5 / v2.4（--version 与 --manifest 共用唯一读取口）",
    );
    c.eq(formatVersionLine(), "zcode-board 0.5.0 · 契约 v2.5 · schema v2.4", "版本行逐字（独立事实值；--version 与 --manifest 回显同源）");
    c.eq(schema["x-contractVersion"], readContractVersion(), "schema x-contractVersion 与 markers 段头同源（两硬写位互锁）");
    c.eq(schema["x-schemaVersion"], readSchemaVersion(), "schema x-schemaVersion 与读取器同源");
    c.eq(schema["x-schemaVersion"], "2.4", "schema x-schemaVersion === 2.4（A1-5 顺延事实值）");
    c.eq(schema["x-contractVersion"], "2.5", "schema x-contractVersion === 2.5（A1-5 顺延事实值）");
    // 草案标注解除（A1 批规格已冻结）：x-pending 键清除 = 无未收口草案位
    c.ok(!Object.hasOwn(schema, "x-pending"), "x-pending 草案标注已清（A1 批收口：epic 定义转正、无残留草案位）", show(schema["x-pending"]));

    // 第二处：board.json generatedBy（编译期读同一常量）
    c.eq(board.generatedBy, `zcode-board/${SKILL_VERSION}`, "board.json.generatedBy 由常量派生（形态 zcode-board/<包版本>）");
    c.eq(board.generatedBy, "zcode-board/0.5.0", "board.json.generatedBy === zcode-board/0.5.0（A1-5 卡文事实值）");
    c.ok(!boardText.includes("zcode-board/0.2"), "board.json 无遗留 0.2 版本串（无第二手写位）");
    c.inc(md, `zcode-board/${SKILL_VERSION}`, "board.md 生成器行版本同源");

    // 第一处：SKILL.md 头部版本行（手写位，由本断言守卫防漂移）
    const skillText = readFileSync(SKILL_MD_PATH, "utf8");
    const headerLine = skillText.split("\n").find((l) => l.startsWith("- 技能版本：")) ?? "";
    const token = headerLine.match(/`(zcode-board\/[^`]+)`/)?.[1] ?? "";
    c.eq(token, `zcode-board/${SKILL_VERSION}`, "SKILL.md 头部版本行与常量同值（手写漂移守卫）");
    c.inc(headerLine, "v2.5", "SKILL.md 头部版本行注明契约映射 v2.5（A1-5 顺延；批收口单飞写入）");
    c.ok(!skillText.includes("zcode-board/0.2"), "SKILL.md 无遗留 0.2 版本串（含 assets 清单行）");
    c.inc(skillText, "assets/compile-board.mjs --version", "SKILL.md §3.1 命令表含 --version 逐字行");

    // 版本策略成文（#67-5）：主/次/修订 bump 规则 + 契约破坏性变更连带升包版本
    const strategyIdx = skillText.indexOf("版本策略");
    c.ok(strategyIdx >= 0, "SKILL.md 含「版本策略」节（#67-5 成文）");
    const strategy = skillText.slice(Math.max(0, strategyIdx - 200), strategyIdx + 1600);
    c.inc(strategy, "修订 =", "策略含修订规则（bug 修复，不动契约/schema 版本）");
    c.inc(strategy, "次 =", "策略含次版本规则（能力新增、契约向后兼容）");
    c.inc(strategy, "主 =", "策略含主版本规则（破坏性契约变更）");
    c.inc(strategy, "必须连带升包版本", "策略明确：契约破坏性变更必须连带升包版本");

    // 冻结件：schema 自身版本字段 + 契约版本字段（--version / manifest 读取位；同源互锁见上「三版本同源」组）
    // #72 冻结文：扫描面配置化（默认收窄 + opt-in + 防 mass 改写闸）进入 schema 元数据
    c.inc(schema["x-note"] ?? "", "扫描面配置化", "x-note 载 #72 扫描面配置化条目");
    c.ok(/0\.5\.0/.test(schema["x-note"] ?? ""), "x-note 包版本映射更新为 0.5.0（A1-5 收口）");
    c.inc(schema["x-note"] ?? "", "契约 v2.5 + schema v2.4", "x-note 载当前映射：包 0.5.0 = 契约 v2.5 + schema v2.4");

    // #72 契约成文：markers.md v2.4 变更段 + §9 扫描面配置（scan.json 语法）+ §6 防 mass 改写闸
    const markersText = readFileSync(join(ASSETS_DIR, "contracts", "markers.md"), "utf8");
    c.inc(markersText, "v2.4 变更段", "markers.md 载 v2.4 变更段（#72 历史明细；契约版本读取位取最高段头）");
    c.inc(markersText, "v2.5 变更段（A1 批收口 · #80", "markers.md 载 v2.5 变更段（A1-5 收口；契约版本读取位）");
    c.inc(markersText, "契约版本顺延 v2.4 → **v2.5**", "v2.5 段载契约顺延事实（v2.4 已被 #72 占用）");
    c.inc(markersText, "包版本连带升 **0.4.0 → 0.5.0**", "v2.5 段载包版本连带升 0.5.0（版本策略）");
    c.inc(markersText, "## 9. 扫描面配置", "markers.md §9 扫描面配置成文");
    c.inc(markersText, "scan.json", "§9 载 scan.json 语法");
    c.inc(markersText, "includeDirs", "§9 载 includeDirs");
    c.inc(markersText, "excludeGlobs", "§9 载 excludeGlobs");
    c.inc(markersText, "防 mass 改写闸", "§6 载 --assign 防 mass 改写闸");

    // #66 例外进冻结文：占位稿恒待设计句须注明 cancelled 终态不让位
    c.inc(schema["x-note"] ?? "", "已取消", "x-note 载 #66 例外：占位稿中已取消卡/特性段位照常「已取消」");
    const roadmapDecisions = (schema["x-decisions"] ?? []).filter((d) => d.includes("恒为待设计"));
    c.ok(roadmapDecisions.length > 0, "x-decisions 含「恒为待设计」句（对照面非空）");
    c.ok(
      roadmapDecisions.every((d) => d.includes("cancelled") || d.includes("已取消")),
      "x-decisions 各「恒为待设计」句均含 cancelled 例外（#66 冻结件勘误）",
      show(roadmapDecisions),
    );

    // 接受集：三段式过、旧两段式拒（schema 子集校验器 + 公共不变量校验器同一口径）
    const okBoard = JSON.parse(JSON.stringify(board));
    const legacy = JSON.parse(JSON.stringify(board));
    legacy.generatedBy = "zcode-board/0.2";
    c.eq(validateSchemaValue(schema, okBoard).filter((m) => m.includes("generatedBy")), [], "三段式 generatedBy 通过 schema 子集校验");
    c.eq(checkBoardInvariants(okBoard).filter((m) => m.includes("generatedBy")), [], "三段式 generatedBy 通过公共不变量校验");
    c.ok(validateSchemaValue(schema, legacy).some((m) => m.includes("generatedBy")), "旧两段式 generatedBy 被 schema 拒绝（0.2 形态退场）");
    c.ok(checkBoardInvariants(legacy).some((m) => m.includes("generatedBy")), "旧两段式 generatedBy 被公共不变量拒绝");
  },
});

// ---- 场景 67c（#67-4）：--manifest 内容寻址（副本域重新生成，与仓库内 manifest 比对）
scenario("67c", "#67：--manifest 重新生成 assets/manifest.json（包/契约/schema 版本 + 关键文件 sha256）；副本域重生成与仓库内 manifest 一致（除 generatedAt）——第三处同源", {
  build(root) {
    // 技能包副本（SKILL.md + assets 关键件）：--manifest 只操作技能资产，与 <项目根> 无关
    const copy = join(root, "skill-copy");
    const copyFile = (from, to) => {
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, readFileSync(from));
    };
    copyFile(SKILL_MD_PATH, join(copy, "SKILL.md"));
    copyFile(join(ASSETS_DIR, "board.schema.json"), join(copy, "assets", "board.schema.json"));
    copyFile(join(ASSETS_DIR, "compile-board.mjs"), join(copy, "assets", "compile-board.mjs"));
    copyFile(join(ASSETS_DIR, "contracts", "markers.md"), join(copy, "assets", "contracts", "markers.md"));
    for (const name of readdirSync(join(ASSETS_DIR, "lib")).sort()) {
      if (name.endsWith(".mjs")) copyFile(join(ASSETS_DIR, "lib", name), join(copy, "assets", "lib", name));
    }
    w(root, ".zcode/board/.keep", ""); // 默认编译夹具（commonChecks 用）
  },
  assert(c, ctx) {
    // 入口守卫按 realpath 比较 argv[1]（macOS /var → /private/var 软链）；测试副本在 tmpdir 下，
    // 故用 realpathSync 归一 spawn 路径，保证入口被真正执行（静默 no-op 会让下游断言必咬）。
    const copy = realpathSync(join(ctx.root, "skill-copy"));
    const res = spawnSync(process.execPath, [join(copy, "assets", "compile-board.mjs"), "--manifest"], {
      encoding: "utf8",
      cwd: ctx.root,
    });
    c.eq(res.status, 0, "副本域 --manifest 退出码 0（不需要 <项目根>）");
    c.inc(res.stdout, "manifest 已写出", "--manifest 单行回显写出位置");
    const loaded = readJsonFile(join(copy, "assets", "manifest.json"));
    c.ok(loaded.ok, "副本域 assets/manifest.json 已写出且 JSON 可解析", loaded.error ?? (loaded.missing ? "文件缺失" : ""));
    const m = loaded.value ?? {};

    // 三版本字段（包版本 = 常量，唯一事实源）
    c.eq(m.packageVersion, SKILL_VERSION, "manifest.packageVersion === lib/version.mjs 常量");
    c.eq(m.packageVersion, "0.5.0", "manifest.packageVersion === 0.5.0（A1-5 收口）");
    c.eq(m.contractVersion, "2.5", "manifest.contractVersion === 2.5（markers.md 变更段头）");
    c.eq(m.schemaVersion, "2.4", "manifest.schemaVersion === 2.4（schema x-schemaVersion）");
    c.ok(ISO_RE.test(m.generatedAt ?? ""), "manifest.generatedAt 为带时区 ISO 8601", show(m.generatedAt));

    // 关键文件清单（compile-board + lib 全部 + contracts/markers.md + board.schema.json + SKILL.md）
    const expectedKeys = [
      "SKILL.md",
      "assets/board.schema.json",
      "assets/compile-board.mjs",
      "assets/contracts/markers.md",
      ...readdirSync(join(ASSETS_DIR, "lib"))
        .filter((n) => n.endsWith(".mjs"))
        .sort()
        .map((n) => `assets/lib/${n}`),
    ];
    c.eq(Object.keys(m.files ?? {}).sort(), [...expectedKeys].sort(), "manifest.files 键集 = 关键文件清单");

    // 内容寻址：逐文件独立复算 sha256
    const digest = (abs) => createHash("sha256").update(readFileSync(abs)).digest("hex");
    const mismatches = [];
    for (const [rel, sha] of Object.entries(m.files ?? {})) {
      const abs = join(copy, rel);
      if (!isFile(abs)) {
        mismatches.push(`${rel}：副本缺失`);
        continue;
      }
      if (digest(abs) !== sha) mismatches.push(`${rel}：digest 不符`);
    }
    c.eq(mismatches, [], "manifest.files 各摘要 = 对应文件 sha256（内容寻址）");

    // 仓库内 manifest（随卡提交）与重新生成一致——文件变更未刷新 manifest 必咬
    const repo = readJsonFile(join(ASSETS_DIR, "manifest.json"));
    c.ok(repo.ok, "仓库内 assets/manifest.json 存在且可解析（manifest 随版本提交）");
    const strip = (x) => ({ ...(x ?? {}), generatedAt: "<编译时刻>" });
    c.eq(strip(repo.value), strip(m), "仓库内 manifest 与副本域重新生成逐字段一致（仅 generatedAt 掩码）");
  },
});

// ---- 场景 69（#69）：入口守卫按 realpath 归一——符号链接调用路径下主逻辑照常执行
scenario("69", "#69：入口守卫 realpathSync 归一比较——经符号链接路径调用编译器，主逻辑执行（--version 正常输出，不再静默 exit 0）", {
  build(root) {
    // 技能包副本（含守卫、版本读取与 schema/契约读取所需文件；--version 不读 SKILL.md，故不复制——
    // 保证本场景在突变副本域（run-mutations 只拷 assets/）同样可构造，断言不因夹具缺件假性命中）
    const copy = join(root, "skill-copy");
    const copyFile = (from, to) => {
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, readFileSync(from));
    };
    copyFile(join(ASSETS_DIR, "board.schema.json"), join(copy, "assets", "board.schema.json"));
    copyFile(join(ASSETS_DIR, "compile-board.mjs"), join(copy, "assets", "compile-board.mjs"));
    copyFile(join(ASSETS_DIR, "contracts", "markers.md"), join(copy, "assets", "contracts", "markers.md"));
    for (const name of readdirSync(join(ASSETS_DIR, "lib")).sort()) {
      if (name.endsWith(".mjs")) copyFile(join(ASSETS_DIR, "lib", name), join(copy, "assets", "lib", name));
    }
    // 复现条件（#69 实证）：调用路径含符号链接成分 → resolve(argv[1]) ≠ import.meta.url（Node 取 realpath）。
    symlinkSync(copy, join(root, "skill-link"));
    w(root, ".zcode/board/.keep", ""); // 默认编译夹具（commonChecks 用）
  },
  assert(c, ctx) {
    const viaLink = spawnSync(process.execPath, [join(ctx.root, "skill-link", "assets", "compile-board.mjs"), "--version"], {
      encoding: "utf8",
      cwd: ctx.root,
    });
    c.eq(viaLink.status, 0, "经符号链接路径 --version 退出码 0");
    c.inc(viaLink.stdout ?? "", `zcode-board ${SKILL_VERSION}`, "主逻辑执行：stdout 含版本行（守卫静默 no-op 时 stdout 为空，必咬）");
    c.inc(viaLink.stdout ?? "", "契约 v", "版本行含契约版本（--version 完整输出）");
    // 对照组：同目标 realpath 直调（无符号链接成分）——两形态输出逐字节一致（守卫单点，不产生分叉）
    const direct = spawnSync(process.execPath, [join(ctx.root, "skill-copy", "assets", "compile-board.mjs"), "--version"], {
      encoding: "utf8",
      cwd: ctx.root,
    });
    c.eq(direct.status, 0, "同目标 realpath 直调 --version 退出码 0");
    c.eq(direct.stdout, viaLink.stdout, "符号链接路径与 realpath 直调输出逐字节一致");
  },
});

// ---- 场景 71（#71）：嵌套项目根相对路径形态的 runs 归一与互证对齐（E2-02/E1-V31）
scenario("71", "#71：runs 归一接受「<子目录>/.zcode/worktrees/task-<no>」嵌套形态（末段号解析）；互证层后缀匹配不变；同因诊断按 run 合并点名；未知形态仍拒收", {
  build(root) {
    const planRel = ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000071.md";
    w(
      root,
      planRel,
      [
        "# 嵌套形态夹具",
        "<!-- zcode-board: no=79 -->",
        "",
        "- **T1 跨项目真实现场**：正文。 <!-- zcode-board: no=80 -->",
        "- **T2 跨项目缺失现场**：正文。 <!-- zcode-board: no=81 -->",
        "- **T3 未知形态拒收**：正文。 <!-- zcode-board: no=82 -->",
        "- **T4 同 run 双卡现场甲**：正文。 <!-- zcode-board: no=83 -->",
        "- **T5 同 run 双卡现场乙**：正文。 <!-- zcode-board: no=84 -->",
        "",
      ].join("\n"),
    );
    setMtime(root, planRel, "2026-01-02T03:04:05");
    seedRuns(root, [
      {
        runId: "run-20261010-a80a",
        sessionId: "sess_0071",
        role: "implementer",
        at: "2026-10-10T05:00:00+08:00",
        result: "done",
        cards: [80],
        worktree: "proj-x/.zcode/worktrees/task-80",
        branch: "task-80",
        evidence: [],
        breakpoint: null,
      },
      {
        runId: "run-20261010-b81b",
        sessionId: "sess_0071",
        role: "implementer",
        at: "2026-10-10T05:01:00+08:00",
        result: "done",
        cards: [81],
        worktree: "proj-x/.zcode/worktrees/task-81",
        branch: "task-81",
        evidence: [],
        breakpoint: null,
      },
      {
        runId: "run-20261010-c82c",
        sessionId: "sess_0071",
        role: "implementer",
        at: "2026-10-10T05:02:00+08:00",
        result: "done",
        cards: [82],
        worktree: "proj-x/inner/.zcode/worktrees/task-82",
        branch: "task-82",
        evidence: [],
        breakpoint: null,
      },
      {
        runId: "run-20261010-d83d",
        sessionId: "sess_0071",
        role: "implementer",
        at: "2026-10-10T05:03:00+08:00",
        result: "done",
        cards: [83, 84],
        worktree: "proj-x/.zcode/worktrees/task-83",
        branch: "task-83",
        evidence: [],
        breakpoint: null,
      },
    ]);
    // fs 事实：仅 T1 的现场真实存在（一层子项目根 proj-x 下）
    mkdirSync(join(root, "proj-x", ".zcode", "worktrees", "task-80"), { recursive: true });
  },
  assert(c, ctx) {
    const { board, run } = ctx;
    const f = featureByTitle(board, "嵌套形态夹具");
    const real = taskByTitle(f, "跨项目真实现场");
    const ghost = taskByTitle(f, "跨项目缺失现场");
    const bad = taskByTitle(f, "未知形态拒收");
    const twinA = taskByTitle(f, "同 run 双卡现场甲");
    const twinB = taskByTitle(f, "同 run 双卡现场乙");

    // 嵌套声明进接受集 + fs 互证（精确/后缀）→ 缺口成立
    c.eq(real?.worktree, "proj-x/.zcode/worktrees/task-80", "嵌套项目根相对路径声明被归一接受；exact 命中 → 字段 = 现场路径（声明与现场同值，#151 归一后同值）");
    c.eq(
      [real?.lastRun?.at, real?.lastRun?.role, real?.lastRun?.result],
      ["2026-10-10T05:00:00+08:00", "implementer", "done"],
      "嵌套声明 run 的 lastRun 三要素正确（归一不吞事件字段）",
    );
    c.ok(
      (real?.attention ?? []).includes("unmerged-worktree"),
      "现场目录真实存在（子项目根下）→ unmerged-worktree 缺口触发（E2-02 失明项恢复）",
      show(real?.attention),
    );
    c.eq(board.attentionSummary.unmergedWorktree, 1, "缺口计数 = 1（仅真实现场）");
    const mergeSection = String(run.md).split("## 待合并（unmerged-worktree 聚合）")[1]?.split("\n## ")[0] ?? "";
    c.inc(mergeSection, "proj-x/.zcode/worktrees/task-80", "board.md 待合并聚合含嵌套形态现场");

    // 目录缺失 → 降级 + 提示级诊断（与 #42 同判据；逐条点名声明 run）
    c.eq(ghost?.worktree, null, "嵌套声明但目录不存在 → worktree 降为 null（不猜状态）");
    c.ok(!(ghost?.attention ?? []).includes("unmerged-worktree"), "目录缺失 → 不触发缺口（#42 判据保留）");
    const ghostDiags = diagFor(board, ".zcode/board/runs.json").filter((d) =>
      d.message.includes("proj-x/.zcode/worktrees/task-81"),
    );
    c.eq(ghostDiags.length, 1, "降级提示级诊断恰 1 条（不静默）", show(ghostDiags.map((d) => d.message)));
    c.inc(ghostDiags[0]?.message ?? "", "目录不存在", "文案写明「目录不存在」");
    c.inc(ghostDiags[0]?.message ?? "", "#81", "诊断点名卡 #81（单卡维持 #42 文案形态，不外泄 runId）");

    // 不在接受集的形态（两级嵌套）仍拒收 + 诊断
    c.eq(bad?.worktree, null, "未知形态（两级嵌套）不落 worktree 字段");
    c.ok(!(bad?.attention ?? []).includes("unmerged-worktree"), "未知形态不触发缺口");
    const badDiags = diagFor(board, ".zcode/board/runs.json").filter((d) =>
      d.message.includes("proj-x/inner/.zcode/worktrees/task-82"),
    );
    c.eq(badDiags.length, 1, "未知形态 → 恰 1 条拒收诊断", show(badDiags.map((d) => d.message)));
    c.inc(badDiags[0]?.message ?? "", "不符合冻结命名", "拒收文案保留「不符合冻结命名」判据");

    // 同一 run 同一声明落到多张卡：同因合并为一条，点名 run 与两卡（不重复噪音）
    const twinDiags = diagFor(board, ".zcode/board/runs.json").filter((d) =>
      d.message.includes("proj-x/.zcode/worktrees/task-83"),
    );
    c.eq(twinDiags.length, 1, "同一 run 的同一声明（双卡）合并为 1 条诊断", show(twinDiags.map((d) => d.message)));
    c.inc(twinDiags[0]?.message ?? "", "run-20261010-d83d", "合并诊断点名 run");
    c.inc(twinDiags[0]?.message ?? "", "#83", "合并诊断点名卡 #83");
    c.inc(twinDiags[0]?.message ?? "", "#84", "合并诊断点名卡 #84");
    c.eq(twinA?.worktree ?? null, null, "双卡现场甲：目录缺失 → worktree null");
    c.eq(twinB?.worktree ?? null, null, "双卡现场乙：目录缺失 → worktree null");

    // schema 接受集同步（T1 子集校验器不认嵌套形态则板产物形态非法）
    const schema = JSON.parse(readFileSync(join(ASSETS_DIR, "board.schema.json"), "utf8"));
    const schemaErrors = validateSchemaValue(schema, board).filter((m) => m.includes("worktree"));
    c.eq(schemaErrors, [], "schema 子集校验接受嵌套形态 worktree（板产物形态合法）");
  },
});

// ---- 场景 151（#151）：derive 规范化层——两形态声明归一为同一现场路径（板根相对；E2-02 残余）
scenario("151", "#151：子项目根 worktree 归一化——冻结/嵌套两形态声明归一为 fs 互证命中的现场路径（两态一致）；缺失降级保留声明原文；同因合并点名 run（#71 已落在长形态上成立）", {
  build(root) {
    const planRel = ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000151.md";
    w(
      root,
      planRel,
      [
        "# 归一化两态夹具",
        "<!-- zcode-board: no=140 -->",
        "",
        "- **T1 长形态声明·同路径现场**：正文。 <!-- zcode-board: no=141 -->",
        "- **T2 冻结形态声明·子项目根现场**：正文。 <!-- zcode-board: no=142 -->",
        "- **T3 同卡两态声明·后行冻结形态**：正文。 <!-- zcode-board: no=143 -->",
        "- **T4 冻结形态声明·板根现场**：正文。 <!-- zcode-board: no=144 -->",
        "- **T5 长形态声明·目录缺失**：正文。 <!-- zcode-board: no=145 -->",
        "- **T6 同 run 双卡·目录缺失甲**：正文。 <!-- zcode-board: no=146 -->",
        "- **T7 同 run 双卡·目录缺失乙**：正文。 <!-- zcode-board: no=147 -->",
        "",
      ].join("\n"),
    );
    setMtime(root, planRel, "2026-01-02T03:04:05");
    seedRuns(root, [
      {
        runId: "run-20261010-n141",
        sessionId: "sess_0151",
        role: "implementer",
        at: "2026-10-10T05:00:00+08:00",
        result: "done",
        cards: [141],
        worktree: "ZPaPa/.zcode/worktrees/task-141",
        branch: "task-141",
        evidence: [],
        breakpoint: null,
      },
      {
        // 真实数据形态（#46/T36u）：报告在子项目内相对各自项目根书写短形态，现场在子项目根下。
        runId: "run-20261010-n142",
        sessionId: "sess_0151",
        role: "implementer",
        at: "2026-10-10T05:01:00+08:00",
        result: "done",
        cards: [142],
        worktree: ".zcode/worktrees/task-142",
        branch: "task-142",
        evidence: [],
        breakpoint: null,
      },
      {
        runId: "run-20261010-n143a",
        sessionId: "sess_0151",
        role: "implementer",
        at: "2026-10-10T05:02:00+08:00",
        result: "done",
        cards: [143],
        worktree: "ZPaPa/.zcode/worktrees/task-143",
        branch: "task-143",
        evidence: [],
        breakpoint: null,
      },
      {
        // 同一卡两态声明：后行（最新带 worktree 记录）为冻结形态——归一结果不得随声明形态翻转。
        runId: "run-20261010-n143b",
        sessionId: "sess_0151",
        role: "test-verifier",
        at: "2026-10-10T05:03:00+08:00",
        result: "partial",
        cards: [143],
        worktree: ".zcode/worktrees/task-143",
        branch: "task-143",
        evidence: [],
        breakpoint: { stoppedAt: 143, next: "复跑" },
      },
      {
        runId: "run-20261010-n144",
        sessionId: "sess_0151",
        role: "implementer",
        at: "2026-10-10T05:04:00+08:00",
        result: "done",
        cards: [144],
        worktree: ".zcode/worktrees/task-144",
        branch: "task-144",
        evidence: [],
        breakpoint: null,
      },
      {
        runId: "run-20261010-n145",
        sessionId: "sess_0151",
        role: "implementer",
        at: "2026-10-10T05:05:00+08:00",
        result: "done",
        cards: [145],
        worktree: "ZPaPa/.zcode/worktrees/task-145",
        branch: "task-145",
        evidence: [],
        breakpoint: null,
      },
      {
        runId: "run-20261010-n146",
        sessionId: "sess_0151",
        role: "implementer",
        at: "2026-10-10T05:06:00+08:00",
        result: "done",
        cards: [146, 147],
        worktree: "ZPaPa/.zcode/worktrees/task-146",
        branch: "task-146",
        evidence: [],
        breakpoint: null,
      },
    ]);
    // fs 事实：141/142/143 现场在子项目根 ZPaPa 下；144 现场在板根；145/146 无目录（已清理）
    for (const n of [141, 142, 143]) mkdirSync(join(root, "ZPaPa", ".zcode", "worktrees", `task-${n}`), { recursive: true });
    mkdirSync(join(root, ".zcode", "worktrees", "task-144"), { recursive: true });
  },
  assert(c, ctx) {
    const { board, run } = ctx;
    const f = featureByTitle(board, "归一化两态夹具");
    const t1 = taskByTitle(f, "长形态声明·同路径现场");
    const t2 = taskByTitle(f, "冻结形态声明·子项目根现场");
    const t3 = taskByTitle(f, "同卡两态声明·后行冻结形态");
    const t4 = taskByTitle(f, "冻结形态声明·板根现场");
    const t5 = taskByTitle(f, "长形态声明·目录缺失");
    const twinA = taskByTitle(f, "同 run 双卡·目录缺失甲");
    const twinB = taskByTitle(f, "同 run 双卡·目录缺失乙");

    // 两态归一：声明形态不作输出形态，字段 = fs 互证命中的现场路径（板根相对）
    c.eq(t1?.worktree, "ZPaPa/.zcode/worktrees/task-141", "长形态声明 exact 命中 → 字段 = 现场路径（声明与现场同值）");
    c.eq(
      t2?.worktree,
      "ZPaPa/.zcode/worktrees/task-142",
      "冻结形态声明 + 子项目根现场 → 归一为板根相对现场路径（不再输出板根下不存在的短路径）",
    );
    c.eq(
      t3?.worktree,
      "ZPaPa/.zcode/worktrees/task-143",
      "同卡两态声明（后行为冻结形态）→ 归一结果与声明形态无关（两态一致）",
    );
    c.eq(t4?.worktree, ".zcode/worktrees/task-144", "冻结形态声明 + 板根现场（exact 命中）→ 字段 = 现场路径（同值）");
    for (const [t, no] of [[t1, 141], [t2, 142], [t3, 143], [t4, 144]]) {
      c.ok((t?.attention ?? []).includes("unmerged-worktree"), `卡 #${no}：现场经 fs 互证 → unmerged-worktree 缺口成立`, show(t?.attention));
    }
    c.eq(board.attentionSummary.unmergedWorktree, 4, "缺口计数 = 4（仅四个真实现场；两个缺失现场不计）");

    // board.md 待合并聚合：渲染归一后的现场路径（两个原本短声明、现场在子项目根的卡）
    const mergeSection = String(run.md).split("## 待合并（unmerged-worktree 聚合）")[1]?.split("\n## ")[0] ?? "";
    c.inc(mergeSection, " —— ZPaPa/.zcode/worktrees/task-142", "待合并聚合：短声明归一为现场路径（#142）");
    c.inc(mergeSection, " —— ZPaPa/.zcode/worktrees/task-143", "待合并聚合：两态声明归一为同一现场路径（#143）");

    // 长形态声明而目录缺失 → 降级：worktree null、不缺口、恰 1 条点名声明原文的诊断
    c.eq(t5?.worktree, null, "长形态声明 + 目录缺失 → worktree 降为 null（不猜状态）");
    c.ok(!(t5?.attention ?? []).includes("unmerged-worktree"), "目录缺失 → 不触发缺口（#42 判据保留）");
    const t5Diags = diagFor(board, ".zcode/board/runs.json").filter((d) => d.message.includes("ZPaPa/.zcode/worktrees/task-145"));
    c.eq(t5Diags.length, 1, "长形态缺失 → 恰 1 条降级诊断（不静默）", show(t5Diags.map((d) => d.message)));
    c.inc(t5Diags[0]?.message ?? "", "目录不存在", "文案写明「目录不存在」");
    c.inc(t5Diags[0]?.message ?? "", "#145", "诊断点名卡 #145");

    // 同一 run 的长形态声明落到两卡 → 同因合并为 1 条并点名 run（#71 已落，长形态上成立）
    const twinDiags = diagFor(board, ".zcode/board/runs.json").filter((d) =>
      d.message.includes("ZPaPa/.zcode/worktrees/task-146"),
    );
    c.eq(twinDiags.length, 1, "同一 run 的长形态声明（双卡）合并为 1 条诊断", show(twinDiags.map((d) => d.message)));
    c.inc(twinDiags[0]?.message ?? "", "run-20261010-n146", "合并诊断点名 run");
    c.inc(twinDiags[0]?.message ?? "", "#146", "合并诊断点名卡 #146");
    c.inc(twinDiags[0]?.message ?? "", "#147", "合并诊断点名卡 #147");
    c.eq(twinA?.worktree ?? null, null, "缺失现场甲：worktree null");
    c.eq(twinB?.worktree ?? null, null, "缺失现场乙：worktree null");

    // 零形态噪音：两形态声明全接受，无「不符合冻结命名」拒收
    c.eq(
      (board.diagnostics ?? []).filter((d) => d.message.includes("不符合冻结命名")).length,
      0,
      "两形态声明零拒收噪音（归一化层接受集与 #71 判据一致）",
    );

    // schema 接受集同步：归一后的现场路径仍为合法形态（短/长两形态都在接受集）
    const schema = JSON.parse(readFileSync(join(ASSETS_DIR, "board.schema.json"), "utf8"));
    const schemaErrors = validateSchemaValue(schema, board).filter((m) => m.includes("worktree"));
    c.eq(schemaErrors, [], "schema 子集校验接受归一后的现场路径（板产物形态合法）");
  },
});

// ---- #72：扫描面配置化（契约 v2.4）——默认收窄
scenario("72a", "#72：默认扫描面收窄为 .zcode/plans（无 scan.json 时 docs/plans、docs/design-notes 不扫不上板，文件零触碰）", {
  build(root) {
    w(root, ".zcode/plans/plan-keep.md", ["# 苗圃稿", "", "- **T1 苗圃条目（草案）**：正文。", ""].join("\n"));
    w(root, "docs/plans/plan-old.md", ["# 旧票计划", "",
      "- **T1 旧计划条目（草案）**：正文。", ""].join("\n"));
    for (let i = 0; i < 5; i += 1) {
      w(root, `docs/design-notes/note-${i}.md`, [`# 历史档 ${i}`, "", "- [ ] 1. 历史条目", "  - Scope: 历史细节。", ""].join("\n"));
    }
    w(root, "docs/notes.md", "# docs 根诱饵（不属计划目录）\n\n- **T1 诱饵条目**：不应出现在板上。\n");
  },
  assert(c, ctx) {
    const { board, root } = ctx;
    c.eq(
      (board.sources ?? []).filter((s) => s.kind === "plan").map((s) => s.path),
      [".zcode/plans/plan-keep.md"],
      "sources[] 计划源仅 .zcode/plans（docs/plans、docs/design-notes 默认不扫）",
    );
    c.eq(board.features.map((f) => [f.title, f.kind]), [["苗圃稿", "plan"]], "板上仅苗圃稿特性（两处 docs 计划目录零吸入）");
    c.ok(!JSON.stringify(board).includes("历史档"), "docs/design-notes 历史档（远端 296 类）零吸入");
    c.ok(!JSON.stringify(board).includes("旧票计划"), "docs/plans 旧计划零吸入");
    c.ok(!JSON.stringify(board).includes("诱饵"), "docs/ 根其他文件仍不扫");
    c.ok(isFile(join(root, "docs/plans/plan-old.md")) && isFile(join(root, "docs/design-notes/note-0.md")), "未 opt-in 的 docs 计划文件仍在（未被触碰）");
    c.eq(diagFor(board, ".zcode/board/scan.json"), [], "无 scan.json → 默认扫描面零诊断（不噪音）");
  },
});

scenario("72b", "#72：scan.json 显式 opt-in（includeDirs 池内目录）→ docs/plans、docs/design-notes 正常扫入；扫描序 = 池内冻结序", {
  build(root) {
    w(root, ".zcode/plans/plan-keep.md", ["# 苗圃稿", "", "- **T1 苗圃条目（草案）**：正文。", ""].join("\n"));
    w(root, "docs/plans/plan-old.md", ["# 旧票计划", "", "- **T1 旧计划条目（草案）**：正文。", ""].join("\n"));
    w(root, "docs/design-notes/plan-legacy.md", ["# 旧项目票计划", "", "- [ ] 1. 遗留事项", ""].join("\n"));
    // 书写顺序故意倒置：生效扫描序应为池内冻结序（docs/plans → docs/design-notes），保障发号确定性
    w(root, ".zcode/board/scan.json", JSON.stringify({ includeDirs: ["docs/design-notes", "docs/plans"] }, null, 2) + "\n");
  },
  assert(c, ctx) {
    const { board } = ctx;
    c.eq(
      (board.sources ?? []).filter((s) => s.kind === "plan").map((s) => s.path),
      [".zcode/plans/plan-keep.md", "docs/plans/plan-old.md", "docs/design-notes/plan-legacy.md"],
      "opt-in 后三目录全扫，顺序 = 池内冻结序（与 includeDirs 书写顺序无关）",
    );
    c.eq(
      board.features.map((f) => f.title),
      ["苗圃稿", "旧票计划", "旧项目票计划"],
      "三份计划稿各成特性节点",
    );
    c.eq(diagFor(board, ".zcode/board/scan.json"), [], "合法 scan.json 零诊断（不噪音）");
  },
});

scenario("72c", "#72：scan.json excludeGlobs 生效（按项目根相对路径排除；未匹配文件照常扫入）", {
  build(root) {
    w(root, ".zcode/plans/plan-keep.md", ["# 苗圃稿", "", "- **T1 苗圃条目（草案）**：正文。", ""].join("\n"));
    w(root, ".zcode/plans/plan-draft-1.md", ["# 苗圃草稿", "", "- **T1 草稿条目（草案）**：不应上板。", ""].join("\n"));
    w(root, "docs/plans/plan-old.md", ["# 旧票计划", "", "- **T1 旧计划条目（草案）**：正文。", ""].join("\n"));
    w(root, "docs/design-notes/note-a.md", ["# 历史档 A", "", "- [ ] 1. 历史条目 A", ""].join("\n"));
    w(root, "docs/design-notes/note-b.md", ["# 历史档 B", "", "- [ ] 1. 历史条目 B", ""].join("\n"));
    w(
      root,
      ".zcode/board/scan.json",
      JSON.stringify({ includeDirs: ["docs/plans", "docs/design-notes"], excludeGlobs: ["**/plan-draft-*.md", "docs/design-notes/**"] }, null, 2) + "\n",
    );
  },
  assert(c, ctx) {
    const { board, root } = ctx;
    c.eq(
      (board.sources ?? []).filter((s) => s.kind === "plan").map((s) => s.path),
      [".zcode/plans/plan-keep.md", "docs/plans/plan-old.md"],
      "excludeGlobs 命中者不扫（**/ 前缀零段可匹配；docs/design-notes/** 整目录排除）",
    );
    c.eq(board.features.map((f) => f.title), ["苗圃稿", "旧票计划"], "被排除文件不上板；未匹配文件照常扫入");
    c.ok(!JSON.stringify(board).includes("草稿条目") && !JSON.stringify(board).includes("历史条目 A"), "排除项零吸入（含 design-notes 整目录）");
    c.ok(isFile(join(root, ".zcode/plans/plan-draft-1.md")) && isFile(join(root, "docs/design-notes/note-a.md")), "被排除文件仍在（未被触碰）");
    c.eq(diagFor(board, ".zcode/board/scan.json"), [], "合法 excludeGlobs 零诊断");
  },
});

scenario("72d", "#72：坏 scan.json → 失败级诊断 + 按默认 .zcode/plans 兜底（不猜、不部分生效）", {
  build(root) {
    w(root, ".zcode/plans/plan-keep.md", ["# 苗圃稿", "", "- **T1 苗圃条目（草案）**：正文。", ""].join("\n"));
    w(root, "docs/design-notes/note-a.md", ["# 历史档 A", "", "- [ ] 1. 历史条目", ""].join("\n"));
    w(root, ".zcode/board/scan.json", "{ 这不是合法 JSON —— includeDirs 字段也不存在\n");
  },
  assert(c, ctx) {
    const { board, root, run } = ctx;
    const diags = diagFor(board, ".zcode/board/scan.json");
    c.ok(diags.length >= 1, "坏 scan.json → 诊断非空（失败级，不静默）", show(board.diagnostics));
    c.inc(diags[0]?.message ?? "", "解析失败", "诊断点名解析失败");
    c.inc(diags[0]?.message ?? "", ".zcode/plans", "诊断写明按默认 .zcode/plans 兜底");
    c.eq(
      (board.sources ?? []).filter((s) => s.kind === "plan").map((s) => s.path),
      [".zcode/plans/plan-keep.md"],
      "兜底扫描面：只扫苗圃（坏配置不因残片被部分采纳）",
    );
    c.eq(run.code, 0, "默认编译仍退出码 0（诊断不阻断编译；--check 侧归失败项）");
    c.ok(isFile(join(root, "docs/design-notes/note-a.md")), "历史档未被触碰");
  },
});

scenario("72e", "#72：includeDirs 引用池外目录 → 诊断拒绝（防任意目录当计划源）；池内条目照常生效", {
  build(root) {
    w(root, ".zcode/plans/plan-keep.md", ["# 苗圃稿", "", "- **T1 苗圃条目（草案）**：正文。", ""].join("\n"));
    w(root, "docs/plans/plan-old.md", ["# 旧票计划", "", "- **T1 旧计划条目（草案）**：正文。", ""].join("\n"));
    w(root, "docs/history/bait.md", ["# 池外诱饵", "", "- **T1 任意目录条目（草案）**：不应上板。", ""].join("\n"));
    w(root, ".zcode/board/scan.json", JSON.stringify({ includeDirs: ["docs/plans", "docs/history"] }, null, 2) + "\n");
  },
  assert(c, ctx) {
    const { board, root } = ctx;
    const diags = diagFor(board, ".zcode/board/scan.json");
    c.eq(diags.length, 1, "池外引用恰 1 条诊断（不叠加噪音）", show(diags.map((d) => d.message)));
    c.inc(diags[0]?.message ?? "", "docs/history", "诊断点名被拒目录");
    c.inc(diags[0]?.message ?? "", "opt-in 池", "诊断说明「池外引用拒绝」判据");
    c.eq(
      (board.sources ?? []).filter((s) => s.kind === "plan").map((s) => s.path),
      [".zcode/plans/plan-keep.md", "docs/plans/plan-old.md"],
      "池内条目照常生效、池外目录不扫（防任意目录当计划源）",
    );
    c.ok(!JSON.stringify(board).includes("任意目录条目"), "池外目录零吸入");
    c.ok(isFile(join(root, "docs/history/bait.md")), "池外诱饵文件未被触碰");
  },
});

// ---------------------------------------------------------------- 静态断言：无第三方依赖

function staticChecks(c) {
  c.ok(isFile(COMPILER), `交付物存在：assets/compile-board.mjs`, COMPILER);
  c.ok(isFile(join(ASSETS_DIR, "lib", "board-io.mjs")), "交付物存在：assets/lib/board-io.mjs");

  const files = [];
  const collect = (dir) => {
    if (!isDir(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === "node_modules") continue;
        collect(p);
        continue;
      }
      if (/\.mjs$/.test(name) || /\.js$/.test(name)) files.push(p);
    }
  };
  collect(ASSETS_DIR);

  const offenders = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    const re = /(?:^|[^\w.])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const spec = m[1];
      if (!spec.startsWith("node:") && !spec.startsWith(".") && !spec.startsWith("/")) {
        offenders.push(`${toPosix(f.slice(ASSETS_DIR.length + 1))} → ${spec}`);
      }
    }
    const dyn = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
    while ((m = dyn.exec(text)) !== null) {
      const spec = m[1];
      if (!spec.startsWith("node:") && !spec.startsWith(".") && !spec.startsWith("/")) {
        offenders.push(`${toPosix(f.slice(ASSETS_DIR.length + 1))} → 动态 import ${spec}`);
      }
    }
  }
  c.eq(offenders, [], `全部 ${files.length} 个 .mjs 文件仅使用 node: 内置或相对导入（无第三方依赖）`);
}

// ---------------------------------------------------------------- 直接断言：冻结库 board-io 的公开契约

function libChecks(c) {
  // 标记解析（markers.md §1–§2）
  c.eq(parseMarkers("<!-- zcode-board: no=7 -->").map((m) => m.no), [7], "parseMarkers 解析规范形态");
  c.eq(parseMarkers("<!--zcode-board:no=12-->").map((m) => m.no), [12], "parseMarkers 对注释内空白容错");
  c.eq(parseMarkers("<!-- zcode-board: no=07 -->").map((m) => m.no), [], "前导零标记非法（不解析）");
  c.eq(parseMarkers("<!-- zcode-board: no=0 -->").map((m) => m.no), [], "0 非法（[1-9] 起）");

  const entryLine = "- [ ] 1. 甲 <!-- zcode-board: no=7 -->";
  c.eq(lineEndMarker(entryLine)?.no, 7, "lineEndMarker 认条目行行尾标记");
  c.eq(lineEndMarker(`${entryLine} 尾随文字`), null, "标记不在行尾（后有文字）→ 不认");
  c.eq(lineEndMarker("正文段落 <!-- zcode-board: no=7 -->")?.no, 7, "行尾标记本身不依赖行类型（是否附着卡由条目判定）");
  c.eq(stripLineEndMarker(entryLine), "- [ ] 1. 甲", "stripLineEndMarker 只去标记，其余字节不动");
  c.eq(
    stripLineEndMarker("- [ ] 1. 甲"),
    "- [ ] 1. 甲",
    "无标记行原样返回（解析永不因缺号失败）",
  );

  // 文件级标记：条目行行尾标记不得被当文件头标记
  const lines = ["# 计划", "- **T1 甲**：甲。 <!-- zcode-board: no=3 -->", "<!-- zcode-board: no=9 -->"];
  const head = findFileMarker(lines, (l) => /^\s*[-*+]\s+\*\*/.test(l));
  c.eq([head?.no, head?.lineIndex], [9, 2], "跳过条目行行尾标记后取首个非条目行标记为文件头（不误读为特性号）");
  c.eq(
    findFileMarker(["# 计划", "- [ ] 1. 甲 <!-- zcode-board: no=3 -->"], (l) => /\[[ xX]\]/.test(l)),
    null,
    "只有条目行标记时无文件头标记（不得把任务号当特性号）",
  );

  // 句柄归一（markers.md §4 冻结算法）
  for (const raw of ["9", "#9", "ID-9"]) {
    c.eq(normalizeHandle(raw), 9, `句柄 ${raw} → 整数 9`);
  }
  for (const raw of ["1.2", "ID-1.2", "#1.2", "1.2.3", "task-9", "no=9", "0", "09", "-3"]) {
    c.eq(normalizeHandle(raw), null, `非句柄形态 ${raw} 拒收`);
  }

  // 原子写与读取分流
  const dir = mkdtempSync(join(tmpdir(), "zcode-board-t6-io-"));
  const f = join(dir, "x.json");
  writeJsonAtomic(f, { a: 1 });
  c.eq(readFileSync(f, "utf8"), '{\n  "a": 1\n}\n', "writeJsonAtomic 输出两空格缩进 + 末尾换行");
  c.eq(readdirSync(dir), ["x.json"], "原子写不残留临时文件");
  writeFileAtomic(f, "覆盖");
  c.eq(readFileSync(f, "utf8"), "覆盖", "writeFileAtomic 覆盖写（临时文件 + 改名）");
  c.eq(readJsonFile(f).error !== null, true, "readJsonFile 区分损坏（有 error，missing=false）");
  const missing = readJsonFile(join(dir, "nope.json"));
  c.eq([missing.missing, missing.error], [true, null], "readJsonFile 区分缺失（missing=true，error=null）");
  rmSync(dir, { recursive: true, force: true });

  c.ok(ISO_RE.test(isoLocal(new Date())), "isoLocal 输出带时区 ISO 8601（schema pattern 同源）");
}

// ---------------------------------------------------------------- 派生库 lib/derive.mjs 的公开契约

function deriveLibChecks(c, mod) {
  const { STAGE, STAGE_VALUES, WORKING_ROLES, JUDGING_ROLES, deriveStage, normalizeRuns } = mod;
  c.ok(
    STAGE && Array.isArray(STAGE_VALUES) && SEVEN_STAGES.every((s) => STAGE_VALUES.includes(s)),
    "七段位词表齐备（v2.1 起「已取消」为实产出）",
    show(STAGE_VALUES),
  );
  c.eq(WORKING_ROLES, ["implementer", "debugger", "refactoring-optimizer"], "干活角色表（段位执行中）");
  c.eq(JUDGING_ROLES, ["test-verifier", "code-reviewer"], "判断角色表（段位审核中）");

  const at = "2026-10-09T14:20:00+08:00";
  const cases = [
    ["pending", null, [], "待办"],
    ["active", null, [], "执行中"],
    ["blocked", null, [], "阻塞"],
    ["completed", null, [], "已完成"],
    ["cancelled", null, [], "已取消"],
    ["pending", { role: "implementer", at }, [], "执行中"],
    ["pending", { role: "debugger", at }, [], "执行中"],
    ["pending", { role: "refactoring-optimizer", at }, [], "执行中"],
    ["pending", { role: "test-verifier", at }, [], "审核中"],
    ["pending", { role: "code-reviewer", at }, [], "审核中"],
    ["pending", { role: "integrator", at }, [], "待办"],
    ["pending", null, ["interviewed-not-arranged"], "待设计"],
    ["pending", null, ["arranged-not-expanded"], "待设计"],
    ["pending", null, ["interrupted-resume"], "待办"],
  ];
  for (const [status, activeRun, attention, expected] of cases) {
    const r = deriveStage(status, activeRun, attention);
    c.eq(
      r?.stage,
      expected,
      `deriveStage(${status}, ${activeRun ? activeRun.role : "null"}, [${attention}]) → ${expected}`,
    );
    c.ok(typeof r?.stageRule === "string" && r.stageRule.trim() !== "", `  ↑ 带 stageRule 溯源（${expected}）`);
  }

  const input = { role: "test-verifier", at };
  const attn = ["interrupted-resume"];
  const snapshot = JSON.stringify([input, attn]);
  const r1 = deriveStage("pending", input, attn);
  const r2 = deriveStage("pending", input, attn);
  c.eq(r2, r1, "纯函数：同输入同输出（无隐藏状态）");
  c.eq(JSON.stringify([input, attn]), snapshot, "纯函数不修改入参");
  c.ok(STAGE.CANCELLED === "已取消", "已取消段位与 cancelled 状态配套（v2.1，T21）");

  // 当前执行者（#46 A3）：assignees[] × activeRun.role 交叉推导——只有角色在管线内才成立
  if (typeof mod.deriveCurrentAssignee === "function") {
    const deriveCurrentAssignee = mod.deriveCurrentAssignee;
    const standard = ["implementer", "test-verifier", "code-reviewer", "integrator"];
    c.eq(
      deriveCurrentAssignee({ assignees: standard, activeRun: { role: "implementer", at } }),
      "implementer",
      "当前执行者：activeRun.role 在管线内 → 该角色",
    );
    c.eq(
      deriveCurrentAssignee({ assignees: ["debugger", "test-verifier"], activeRun: { role: "code-reviewer", at } }),
      null,
      "当前执行者：activeRun.role 不在管线内 → null（交叉推导不成立，不硬指）",
    );
    c.eq(deriveCurrentAssignee({ assignees: standard, activeRun: null }), null, "当前执行者：无 activeRun → null");
    c.eq(deriveCurrentAssignee({ assignees: [], activeRun: { role: "implementer", at } }), null, "当前执行者：管线缺失 → null");
    const input2 = { assignees: [...standard], activeRun: { role: "implementer", at } };
    const snap2 = JSON.stringify(input2);
    deriveCurrentAssignee(input2);
    c.eq(JSON.stringify(input2), snap2, "当前执行者纯函数不修改入参");
  } else {
    c.ok(false, "导出纯函数 deriveCurrentAssignee（#46 A3 单点）");
  }

  // arranged-not-expanded 判据（#53 / 契约 v2.3）：plan 判"零卡"，spec 维持"零卡或全 draft"
  if (typeof mod.deriveArrangedNotExpanded === "function") {
    const deriveArrangedNotExpanded = mod.deriveArrangedNotExpanded;
    c.eq(
      deriveArrangedNotExpanded({ kind: "plan", tasks: [{ draft: true }, { draft: true }] }),
      false,
      "plan 有卡（即使全为 draft）不再判未拆解（#53 判据收窄）",
    );
    c.eq(deriveArrangedNotExpanded({ kind: "plan", tasks: [] }), true, "plan 零卡 → 未拆解（宁误报不漏报）");
    c.eq(
      deriveArrangedNotExpanded({ kind: "plan", hasTaskDoc: true, tasks: [] }),
      false,
      "plan 有 tasks.md/progress.json → 不判未拆解",
    );
    c.eq(deriveArrangedNotExpanded({ kind: "spec", tasks: [{ draft: false }] }), false, "spec 有非 draft 卡 → 不判未拆解");
    c.eq(deriveArrangedNotExpanded({ kind: "spec", tasks: [{ draft: true }] }), true, "spec 全 draft → 仍判未拆解（spec 分支保持现状）");
    c.eq(deriveArrangedNotExpanded({ kind: "spec", tasks: [] }), true, "spec 零卡 → 未拆解");
  } else {
    c.ok(false, "导出纯函数 deriveArrangedNotExpanded（#53 单点）");
  }

  // 下一接手人（#53 / 契约 v2.3）：assignees 序中首个无 done run 证据的角色；全 done → null；空管线 → null
  if (typeof mod.deriveNextAssignee === "function") {
    const deriveNextAssignee = mod.deriveNextAssignee;
    const standard = ["implementer", "test-verifier", "code-reviewer", "integrator"];
    const doneRec = (role) => ({ role, result: "done" });
    c.eq(
      deriveNextAssignee({ assignees: standard, records: [doneRec("implementer"), doneRec("test-verifier"), doneRec("code-reviewer")] }),
      "integrator",
      "三绿卡 → 首个无 done 证据角色 integrator",
    );
    c.eq(
      deriveNextAssignee({ assignees: standard, records: standard.map(doneRec) }),
      null,
      "管线全部有 done 证据（含 integrator done=已合并）→ null",
    );
    c.eq(deriveNextAssignee({ assignees: standard, records: [] }), "implementer", "无 run 卡 → 管线首角色");
    c.eq(
      deriveNextAssignee({ assignees: standard, records: [{ role: "implementer", result: "partial" }] }),
      "implementer",
      "partial/failed 不算 done 证据（该角色仍在接手位）",
    );
    c.eq(
      deriveNextAssignee({ assignees: ["test-verifier", "implementer"], records: [doneRec("test-verifier")] }),
      "implementer",
      "自定义管线按书写序判定（test-verifier done → 下一位 implementer）",
    );
    c.eq(deriveNextAssignee({ assignees: [], records: [doneRec("implementer")] }), null, "空管线 → null");
    const input3 = { assignees: [...standard], records: [doneRec("implementer")] };
    const snap3 = JSON.stringify(input3);
    deriveNextAssignee(input3);
    c.eq(JSON.stringify(input3), snap3, "下一接手人纯函数不修改入参");
  } else {
    c.ok(false, "导出纯函数 deriveNextAssignee（#53 单点）");
  }

  // runs 归一：形态违规 → 不落字段 + diagnostics（不猜路径/远程号，保持产物 schema 合法）
  const badRuns = normalizeRuns(
    [
      {
        runId: "run-bad-wt",
        at: "2026-10-09T10:00:00+08:00",
        role: "implementer",
        result: "partial",
        cards: [1],
        worktree: "task-1",
        pr: { number: 41, url: "ftp://example.com/41" },
      },
      {
        runId: "run-bad-cards",
        at: "2026-10-09T11:00:00+08:00",
        role: "implementer",
        result: "done",
        cards: [1, "ID-1.2"],
        breakpoint: { stoppedAt: "1.2", next: null },
      },
      { runId: "run-bad-role", at: "2026-10-09T12:00:00+08:00", role: "reviewer", result: "done", cards: [1] },
      { runId: "run-bad-at", role: "implementer", result: "done", cards: [1] },
    ],
    { runsPath: ".zcode/board/runs.json" },
  );
  const rec = badRuns.byNo.get(1)?.find((r) => r.runId === "run-bad-wt");
  c.eq([rec?.worktree, rec?.pr], [null, null], "worktree/pr 形态违规 → 不落字段（不产出 schema 非法形态）");
  c.ok(
    badRuns.diagnostics.some((d) => d.message.includes("worktree")) &&
      badRuns.diagnostics.some((d) => d.message.includes("pr")) &&
      badRuns.diagnostics.some((d) => d.message.includes("ID-1.2")) &&
      badRuns.diagnostics.some((d) => d.message.includes("role")) &&
      badRuns.diagnostics.some((d) => d.message.includes("at")),
    "形态违规一律 diagnostics 点名（标签不是句柄；不猜时钟/角色）",
    show(badRuns.diagnostics.map((d) => d.message)),
  );
  c.eq(badRuns.byNo.get(1)?.length, 2, "仅合法记录挂卡（两条：bad-wt 与 bad-cards）");

  // runs 归一（#71）：嵌套项目根相对路径形态进接受集（号解析取末段 task-N）；其余形态仍拒收
  const wt = (no, worktree, at) => ({
    runId: `run-wt-${no}`,
    at,
    role: "implementer",
    result: "done",
    cards: [no],
    worktree,
  });
  const nestedRuns = normalizeRuns(
    [
      wt(1, ".zcode/worktrees/task-1", "2026-10-09T09:00:00+08:00"),
      wt(2, "ZPaPa/.zcode/worktrees/task-2", "2026-10-09T10:00:00+08:00"),
      wt(3, "a/b/.zcode/worktrees/task-3", "2026-10-09T11:00:00+08:00"),
      wt(4, "/abs/.zcode/worktrees/task-4", "2026-10-09T12:00:00+08:00"),
      wt(5, "../.zcode/worktrees/task-5", "2026-10-09T13:00:00+08:00"),
      wt(6, ".hidden/.zcode/worktrees/task-6", "2026-10-09T14:00:00+08:00"),
      wt(7, "ZPaPa/.zcode/worktrees/slice-7", "2026-10-09T15:00:00+08:00"),
      wt(8, "ZPaPa/.zcode/worktrees/task-08", "2026-10-09T16:00:00+08:00"),
    ],
    { runsPath: ".zcode/board/runs.json" },
  );
  c.eq(nestedRuns.byNo.get(1)?.[0]?.worktree, ".zcode/worktrees/task-1", "短形态 .zcode/worktrees/task-<no> 仍在接受集");
  c.eq(
    nestedRuns.byNo.get(2)?.[0]?.worktree,
    "ZPaPa/.zcode/worktrees/task-2",
    "嵌套项目根相对路径 <子目录>/.zcode/worktrees/task-<no> 被接受（末段 task-N 号解析，#71）",
  );
  for (const no of [3, 4, 5, 6, 7, 8]) {
    c.eq(nestedRuns.byNo.get(no)?.[0]?.worktree, null, `不在接受集的形态仍拒收（卡 ${no}）`);
  }
  c.eq(
    nestedRuns.diagnostics.filter((d) => d.message.includes("worktree")).length,
    6,
    "拒收形态逐条诊断（6 条，不静默）",
  );

  // 工作树归一（#151）：resolveWorktree = 声明 × fs 事实清单 → 命中的现场路径（exact 优先/后缀归一/
  // 严格不复证）；deriveCardRuns 输出归一结果、降级保留声明原文——两态（短/长）声明归一一致。
  c.eq(typeof mod.resolveWorktree, "function", "lib/derive.mjs 导出 resolveWorktree（#151 归一判据，纯函数）");
  const exactFacts = ["ZPaPa/.zcode/worktrees/task-9", ".zcode/worktrees/task-9"];
  c.eq(
    mod.resolveWorktree?.(".zcode/worktrees/task-9", exactFacts),
    ".zcode/worktrees/task-9",
    "exact 命中优先于后缀命中（与事实清单顺序无关）",
  );
  c.eq(
    mod.resolveWorktree?.(".zcode/worktrees/task-8", ["ZPaPa/.zcode/worktrees/task-8"]),
    "ZPaPa/.zcode/worktrees/task-8",
    "短声明 + 子项目根事实 → 归一为事实原路径（现场实际位置）",
  );
  c.eq(
    mod.resolveWorktree?.("ZPaPa/.zcode/worktrees/task-6", ["ZPaPa/.zcode/worktrees/task-6"]),
    "ZPaPa/.zcode/worktrees/task-6",
    "长声明 exact 命中 → 事实原路径（同值）",
  );
  c.eq(
    mod.resolveWorktree?.("ZPaPa/.zcode/worktrees/task-7", [".zcode/worktrees/task-7"]),
    null,
    "长声明 + 仅板根短事实 → 不复证（声明指向的现场不在即不猜状态）",
  );
  c.eq(mod.resolveWorktree?.(".zcode/worktrees/task-5", []), null, "无事实 → null（缺省无互证）");
  c.eq(
    mod.resolveWorktree?.(".zcode/worktrees/task-4", ["Y/.zcode/worktrees/task-4", "X/.zcode/worktrees/task-4"]),
    "Y/.zcode/worktrees/task-4",
    "多个同尾事实 → 取清单顺序第一个（调用方扫描序：确定性，不猜）",
  );
  c.eq(
    mod.worktreeCorroborated?.(".zcode/worktrees/task-8", ["ZPaPa/.zcode/worktrees/task-8"]),
    true,
    "worktreeCorroborated 布尔口径与 resolveWorktree 一致（命中 → true）",
  );
  c.eq(
    mod.worktreeCorroborated?.("ZPaPa/.zcode/worktrees/task-7", [".zcode/worktrees/task-7"]),
    false,
    "worktreeCorroborated 布尔口径与 resolveWorktree 一致（不复证 → false）",
  );

  // deriveCardRuns 两态一致：同一现场、不同声明形态 → 同一归一结果；降级保留声明原文
  const normRuns = mod.normalizeRuns(
    [
      { runId: "run-norm-41", at: "2026-10-09T09:00:00+08:00", role: "implementer", result: "done", cards: [41], worktree: ".zcode/worktrees/task-41" },
      { runId: "run-norm-42", at: "2026-10-09T10:00:00+08:00", role: "implementer", result: "done", cards: [42], worktree: "ZPaPa/.zcode/worktrees/task-42" },
      { runId: "run-norm-43", at: "2026-10-09T11:00:00+08:00", role: "implementer", result: "done", cards: [43], worktree: "ZPaPa/.zcode/worktrees/task-43" },
    ],
    { runsPath: ".zcode/board/runs.json" },
  );
  const normFacts = ["ZPaPa/.zcode/worktrees/task-41", "ZPaPa/.zcode/worktrees/task-42"];
  const state41 = mod.deriveCardRuns(normRuns.byNo.get(41), { existingWorktrees: normFacts });
  const state42 = mod.deriveCardRuns(normRuns.byNo.get(42), { existingWorktrees: normFacts });
  c.eq(state41?.worktree, "ZPaPa/.zcode/worktrees/task-41", "短声明 + 子项目根现场：deriveCardRuns 输出归一后的现场路径");
  c.eq(state42?.worktree, "ZPaPa/.zcode/worktrees/task-42", "长声明 exact 命中：deriveCardRuns 输出现场路径");
  c.eq(
    [state41?.worktree, state42?.worktree],
    ["ZPaPa/.zcode/worktrees/task-41", "ZPaPa/.zcode/worktrees/task-42"],
    "两态声明（短/长）归一为同一形态的现场路径（声明形态不作输出形态）",
  );
  c.ok((state41?.attention ?? []).includes("unmerged-worktree"), "归一命中 → unmerged-worktree 缺口成立（#42 判据保留）");
  const state43 = mod.deriveCardRuns(normRuns.byNo.get(43), { existingWorktrees: normFacts });
  c.eq(state43?.worktree, null, "未互证 → worktree null（不猜状态）");
  c.eq(state43?.demotedWorktree, "ZPaPa/.zcode/worktrees/task-43", "降级保留声明原文（供调用方逐卡点名，不归一为不存在的路径）");
}

// ---------------------------------------------------------------- A1-1（#76）epic 层规格首章：三层容器与登记行语法（schema 面）

// ---- 场景 76（#76，tracer）：epic 首章冻结面——`epics` 登记行定义（code 4 位冻结形态/title/status）与计划
//      归属字段 `epic`（引用位：稳定号或登记 id `epic:<码>`；码不进引用位）/`phase`（单值正整数）。
//      合法夹具（登记行 + 归属、同期次两稿、无 epic）放行；反例（裸码进引用位/重复 phase/登记行码形态非法）拒收。
scenario("76", "#76：epic 首章 schema——epics 登记行定义与 features.epic/phase 形态；合法夹具放行、反例（码进引用位/重复 phase）拒收", {
  build(root) {
    // 场景本体为 schema 面（合成夹具）断言；项目夹具只需可编译以过公共检查（空项目）
    w(root, ".zcode/board/.keep", "");
  },
  assert(c, ctx) {
    const schema = JSON.parse(readFileSync(join(ASSETS_DIR, "board.schema.json"), "utf8"));
    const golden = JSON.parse(readFileSync(join(ASSETS_DIR, "samples", "board.golden.json"), "utf8"));
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const epicErrs = (board, frag) => validateSchemaValue(schema, board).filter((m) => m.includes(frag));

    // ---- 1. 首章冻结面在位（定义与草案标注；schema 定义未落地时本组必咬）
    const epicsDef = schema?.properties?.epics ?? {};
    c.eq(epicsDef.type, "array", "#76：根级 `epics` 定义在位（登记行派生透出，数组）");
    c.eq(epicsDef?.items?.required ?? [], ["code", "title", "status"], "#76：epics[] 登记行必填三字段 code/title/status（AD-7）");
    c.eq(epicsDef?.items?.properties?.code?.pattern, "^[A-Z][A-Z0-9]{3}$", "#76：epic code 保持 4 位冻结形态（与 planCode 同 regex；AD-3 双字段合成前提）");
    c.eq(epicsDef?.items?.properties?.status?.enum ?? [], ["active", "cancelled", "archived"], "#76：epic 状态词表 active|cancelled|archived（终态细则归 A1-2/A1-3）");

    const featureProps = schema?.properties?.features?.items?.properties ?? {};
    const epicBranches = featureProps.epic?.oneOf ?? [];
    c.eq(epicBranches.length, 2, "#76：features[].epic 定义在位（引用位 oneOf 两分支：稳定号 / 登记 id）");
    c.eq(epicBranches[0]?.type, "integer", "#76：epic 引用接受稳定号形态（正整数分支）");
    c.eq(epicBranches[1]?.pattern, "^epic:[A-Z][A-Z0-9]{3}$", "#76：epic 引用接受登记 id `epic:<4位码>`（裸码不属任一形态）");
    c.eq(featureProps.phase?.type, "integer", "#76：features[].phase 定义在位（单值整数；多值/重复携带即被类型拒收）");
    c.ok(
      !Object.hasOwn(schema, "x-pending"),
      "#76：A1-5 已收口——草案标注 x-pending 清除、epic 定义转正（不再挂待办）",
      show(schema["x-pending"]),
    );

    // ---- 2. 合法夹具放行（合成板 = golden + 登记行 + 归属字段）
    const legal = clone(golden);
    legal.epics = [
      { code: "KANB", title: "看板系统", status: "active" },
      { code: "PREV", title: "预览通道", status: "cancelled" },
    ];
    const plans = legal.features.filter((f) => f.kind === "plan");
    c.ok(plans.length >= 2, "#76：golden 含 ≥2 计划特性（一期两稿夹具可构造）", show(plans.length));
    plans[0].epic = "epic:KANB"; // 登记 id 形态
    plans[0].phase = 1;
    plans[1].epic = "epic:KANB"; // 同期次两稿：同 epic 同 phase 两特性合法（AD-2 期次只作组头）
    plans[1].phase = 1;
    c.eq(validateSchemaValue(schema, legal), [], "#76 放行：epics[] + 登记 id 归属 + 同期次两稿整体过 schema 子集校验");

    const legalNumber = clone(legal);
    legalNumber.features.find((f) => f.kind === "plan").epic = 68; // 稳定号形态
    c.eq(validateSchemaValue(schema, legalNumber), [], "#76 放行：epic 稳定号（正整数）形态过 schema");
    // 无 epic 合法（AD-8）：golden 另含无归属特性（interview-only/零卡稿），已随上两断言零错误覆盖

    // ---- 3. 反例拒收（红→绿：schema 定义落地前反例不被拒，本组必咬）
    const badRef = clone(legal);
    badRef.features.find((f) => f.kind === "plan").epic = "KANB";
    c.ok(
      epicErrs(badRef, ".epic").length >= 1,
      "#76 拒收：裸码 \"KANB\" 进引用位（码不是句柄，只认稳定号/登记 id）",
      show(validateSchemaValue(schema, badRef).slice(0, 2)),
    );

    const badPhase = clone(legal);
    badPhase.features.find((f) => f.kind === "plan").phase = [1, 1];
    c.ok(
      epicErrs(badPhase, ".phase").length >= 1,
      "#76 拒收：phase 多值/重复携带（[1, 1] 形态；phase 为单值正整数）",
      show(validateSchemaValue(schema, badPhase).slice(0, 2)),
    );

    const badReg = clone(legal);
    badReg.epics = [{ code: "kanb", title: "看板系统", status: "active" }];
    c.ok(
      epicErrs(badReg, ".code").length >= 1,
      "#76 拒收：登记行 code 形态非法（小写；4 位冻结形态 ^[A-Z][A-Z0-9]{3}$）",
      show(validateSchemaValue(schema, badReg).slice(0, 2)),
    );

    // ---- 4. 契约文本承接面（markers.md 首章；消费契约字段表在板目录，属文档面非本套件断言面）
    const markersText = readFileSync(join(ASSETS_DIR, "contracts", "markers.md"), "utf8");
    c.inc(markersText, "v2.4 补篇段（#76", "markers.md 载 #76 变更段（v2.4 补篇，不改版本号）");
    c.inc(markersText, "## 10. epic 层规格", "markers.md §10 epic 首章成文");
    c.inc(markersText, "epic:KANB", "§10 载登记 id 正例 `epic:KANB`");
    c.inc(markersText, "KANB1", "§10 载显示层合成名 KANB1");
    c.inc(markersText, "双字段合成", "§10 载「双字段合成」约定名（AD-3）");
    c.inc(markersText, "码不进引用位", "§10 载引用位纪律「码不进引用位」（AD-7）");
    c.inc(markersText, "重复携带", "§10 反例表载 phase 重复携带拒收边界");
  },
});

// ---------------------------------------------------------------- A1-2（#77）epic 壳层终态优先序：登记行终态不让位与永不复用（规格/schema 层）

// ---- 场景 77（#77）：段位/终态优先序扩条（epic 级）——`epics[]` 登记行 `cancelled`/`archived` 为 epic 壳层终态：
//      优先序 = epic 登记行终态 > 成员稿 rollup（全完成/全取消）> 成员稿 roadmap 压制 > 其余推导（卡级/特性级
//      #66 已落，epic 壳层本轮补条）；**成员活跃不复活 epic 终态**；期号与 epic 码永不复用（码不重分配、期号不回收）。
//      边界注记：epic 段位 rollup / 复活判定 / 渲染的实现归 A3-*，--check 不复用与 seq 高水位断言归 A2-3——本卡不实现
//      编译器行为；本场景断言域 = 规格/schema 层可表达性：「epic 已取消 + 成员活跃」组合可表达（登记行终态词表拒收
//      段位词/误拼词），优先序与不复用条文落 markers.md §10.5 与 board.schema.json x-note/x-decisions——缺条必咬
//      （本组写入前为红侧）。
scenario("77", "#77：epic 壳层终态优先序扩条——登记行 cancelled/archived 终态（成员活跃不复活）与期号/epic 码永不复用成文；反例（终态被成员活跃盖过/码复用/段位词进登记行）可判", {
  build(root) {
    // 场景本体为规格/schema 面（合成夹具）断言；项目夹具只需可编译以过公共检查（空项目）
    w(root, ".zcode/board/.keep", "");
  },
  assert(c, ctx) {
    const schema = JSON.parse(readFileSync(join(ASSETS_DIR, "board.schema.json"), "utf8"));
    const golden = JSON.parse(readFileSync(join(ASSETS_DIR, "samples", "board.golden.json"), "utf8"));
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const epicErrs = (board, frag) => validateSchemaValue(schema, board).filter((m) => m.includes(frag));

    // ---- 1. 终态词表与「epic 已取消 + 成员活跃」可表达性（成员活跃不复活 epic 终态；schema 不改写壳层事实）
    const epicStatusEnum = schema?.properties?.epics?.items?.properties?.status?.enum ?? [];
    c.eq(epicStatusEnum, ["active", "cancelled", "archived"], "#77：epic 登记行终态词表保持 active|cancelled|archived（cancelled/archived 为终态；不动枚举值）");

    const cancelledEpic = clone(golden);
    cancelledEpic.epics = [{ code: "KANB", title: "看板系统", status: "cancelled" }];
    const activeMember = cancelledEpic.features.filter((f) => f.kind === "plan")[0];
    activeMember.epic = "epic:KANB";
    activeMember.phase = 1;
    activeMember.status = "active"; // 成员活跃（验收场景："epic 已取消 + 成员活跃"）
    activeMember.stage = "执行中";
    c.eq(
      validateSchemaValue(schema, cancelledEpic),
      [],
      "#77 可表达：epic 已取消 + 成员稿活跃 整体过 schema（壳层终态与成员派生同层独立，不因成员活跃复活）",
    );

    const archivedEpic = clone(cancelledEpic);
    archivedEpic.epics[0].status = "archived";
    c.eq(validateSchemaValue(schema, archivedEpic), [], "#77 可表达：epic 归档（archived）同为终态、与成员活跃并存");

    // 反例：段位词写进登记行终态位 → 拒收（终态词表不漂移）
    const badWord = clone(cancelledEpic);
    badWord.epics[0].status = "已取消";
    c.ok(
      epicErrs(badWord, "epics[0].status").length >= 1,
      "#77 拒收：登记行 status 写段位词「已取消」（终态词表 active|cancelled|archived，段位词不进登记行）",
      show(validateSchemaValue(schema, badWord).slice(0, 2)),
    );

    // 反例：误拼形（canceled 单 l）→ 拒收（近似词形不复用）
    const badSpell = clone(cancelledEpic);
    badSpell.epics[0].status = "canceled";
    c.ok(
      epicErrs(badSpell, "epics[0].status").length >= 1,
      "#77 拒收：登记行 status 误拼「canceled」（终态词表只认 cancelled）",
      show(validateSchemaValue(schema, badSpell).slice(0, 2)),
    );

    // ---- 2. markers.md §10.5 成文（优先序扩条 + AD-9 五条归属 + 反例；写入前本组为红侧——缺条必咬）
    const markersText = readFileSync(join(ASSETS_DIR, "contracts", "markers.md"), "utf8");
    c.inc(markersText, "### 10.5", "#77：markers.md §10.5 终态优先序扩条成文（epic 壳层）");
    c.inc(markersText, "epic 壳层", "§10.5 载「epic 壳层」术语（优先序第三层落点）");
    c.inc(markersText, "不因成员活跃复活", "§10.5 载硬规则：epic 终态不因成员活跃复活");
    c.inc(markersText, "不重分配、期号不回收", "§10.5 载不复用判据（AD-9①：码不重分配、期号不回收）");
    c.inc(markersText, "成员稿逐稿", "§10.5 载 AD-9②名目（整体取消留痕 = 成员稿逐稿 > cancelled:）");
    c.inc(markersText, "归档冷却时钟", "§10.5 载 AD-9③名目（冷却 = 成员稿 updatedAt 之 max）");
    c.inc(markersText, "第四种改写", "§10.5 载 AD-9④名目（归档 = 成员稿 + 登记行指向改写，勘误 10）");
    c.inc(markersText, "plan-reviewer", "§10.5 载 AD-9⑤名目（归类审查入 plan-reviewer 清单）");
    c.inc(markersText, "epic 壳层同序见 §10.5", "§3.1 段位优先序节交叉引用 §10.5（扩条落点）");

    // 优先序链位次：epic 登记行终态先于 roadmap 压制命中（roadmap 盖过 cancelled 属违规，#66 同序扩条）
    const sec77Start = markersText.indexOf("### 10.5");
    const sec77EndRaw = sec77Start < 0 ? -1 : markersText.indexOf("\n## ", sec77Start + 1);
    const sec77 = sec77Start < 0 ? "" : markersText.slice(sec77Start, sec77EndRaw < 0 ? markersText.length : sec77EndRaw);
    c.ok(
      sec77.includes("epic 登记行终态") && sec77.indexOf("roadmap 压制") > sec77.indexOf("epic 登记行终态"),
      "#77：§10.5 优先序链位次——epic 登记行终态先于 roadmap 压制（终态不让位；roadmap 盖过 cancelled 可判违规）",
      show({ terminusAt: sec77.indexOf("epic 登记行终态"), roadmapAt: sec77.indexOf("roadmap 压制"), len: sec77.length }),
    );
    c.inc(markersText, "roadmap 盖过 cancelled", "§10.4 反例表载「roadmap 盖过 cancelled」违规判定");
    c.inc(markersText, "epic 取消/归档后其 `code` 被后发 epic 复用", "§10.4 反例表载「码复用」违规判定");
    c.inc(markersText, "成员活跃不复活", "§10.4 反例表载「成员活跃不复活 epic 终态」违规判定");

    // ---- 3. board.schema.json 注释一致性（x-note 补篇 + x-decisions 终态条；枚举与版本位不动）
    c.inc(schema["x-note"] ?? "", "#77", "x-note 载 #77 补篇条目（epic 壳层终态优先序）");
    c.inc(schema["x-note"] ?? "", "不因成员活跃", "x-note 载硬规则：不因成员活跃复活 epic 终态");
    const terminalDecisions = (schema["x-decisions"] ?? []).filter((d) => d.includes("epic 壳层终态"));
    c.ok(terminalDecisions.length >= 1, "#77：x-decisions 载 epic 壳层终态优先序条（对照面非空）");
    c.ok(
      terminalDecisions.length >= 1 && terminalDecisions.every((d) => d.includes("不因成员活跃") && d.includes("永不复用")),
      "#77：x-decisions epic 终态条含「不因成员活跃」与「永不复用」两锚点（非空且逐条）",
      show(terminalDecisions.map((d) => d.slice(0, 80))),
    );
    c.ok(
      !Object.hasOwn(schema, "x-pending"),
      "#77：A1-5 已收口——草案标注清除，终态语义随契约 v2.5 / schema v2.4 冻结（本卡当时不动版本位）",
      show(schema["x-pending"]),
    );
  },
});

// ---------------------------------------------------------------- A1-3（#78）epic 整体取消与归档：留痕、冷却时钟与第四种指向改写（规格/schema 层）

// ---- 场景 78（#78）：epic 整体取消/归档语法冻结——整体取消三件套（登记行置 cancelled + 成员稿逐稿
//      `> cancelled:` 留痕 + 在途 run 处置清单点名）；缺留痕边界（不静默 → 逐稿对账点名，非失败级）；
//      归档冷却时钟 = 成员稿 updatedAt 之 max（7 天；冷却未到不点名）；归档 = 成员稿归档 + 登记面指向
//      改写（勘误 10 第四种改写：成员条目 file/specRoot 改指归档路径 + epic 登记行置 archived；号 /
//      assignedAt / epic/phase 归属一律不改）。
//      三类反例夹具：①缺留痕（成员稿仍进行态可观察）；②冷却未到（时钟取 max 不取最早——夹具
//      updatedAt [10 天, 3 天] → max 3 天 < 7 → 冷却未到；误取最早 10 天会误报）；③改写指向错误
//      （半态：成员稿已归档而登记条目未随移动改指 → --check 非零咬住；--assign 修复后指向与归属逐项保真）。
//      边界注记（承接标注）：改写机具（--assign 整批 + epic 登记行置态）与 --check 断言归 A2；待归档 /
//      缺留痕 / 在途 run 处置清单点名归 B 线对账面（reconcile 待归档类扩展）；渲染归 A3-*——本场景断言域 =
//      规格/schema 层可表达性 + 既有归档机具的指向改写事实（缺条必咬，写入前为红侧）。
scenario("78", "#78：epic 整体取消与归档——三件套 / 缺留痕对账点名 / 冷却=max updatedAt / 第四种指向改写；三类反例（缺留痕、冷却未到、改写指向错误）可判", {
  steps: [{ args: ["--check"] }, { args: ["--assign"] }, { args: [] }, { args: ["--check"] }],
  build(root) {
    // 成员稿甲（有特性级取消留痕；mtime 拨到 10 天前）+ 成员稿乙（缺留痕；mtime 3 天前）+ 成员稿丙
    // （已移入归档目录、登记条目仍指活路径——反例③半态）
    w(
      root,
      ".zcode/plans/plan-78-alpha.md",
      [
        "# 稿甲（KANB 一期）",
        "<!-- zcode-board: no=101 -->",
        "> cancelled: KANB 整体取消，成员稿逐稿留痕",
        "",
        "- [ ] 1. 甲卡 <!-- zcode-board: no=102 -->",
        "",
      ].join("\n"),
    );
    w(
      root,
      ".zcode/plans/plan-78-beta.md",
      ["# 稿乙（KANB 一期）", "<!-- zcode-board: no=103 -->", "", "- [ ] 1. 乙卡 <!-- zcode-board: no=104 -->", ""].join("\n"),
    );
    w(
      root,
      ".zcode/archive/plan-78-gamma.md",
      ["# 稿丙（KANB 一期）", "<!-- zcode-board: no=106 -->", "", "- [ ] 1. 丙卡 <!-- zcode-board: no=107 -->", ""].join("\n"),
    );
    w(
      root,
      ".zcode/board/registry.json",
      `${JSON.stringify(
        {
          version: 1,
          seq: 107,
          epics: [{ code: "KANB", title: "看板系统", status: "archived" }],
          entries: [
            { no: 101, kind: "plan", file: ".zcode/plans/plan-78-alpha.md", title: "稿甲（KANB 一期）", assignedAt: "2026-10-01T00:00:00+08:00", planCode: "ALPH", epic: "epic:KANB", phase: 1 },
            { no: 102, kind: "task", file: ".zcode/plans/plan-78-alpha.md", title: "甲卡", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 103, kind: "plan", file: ".zcode/plans/plan-78-beta.md", title: "稿乙（KANB 一期）", assignedAt: "2026-10-01T00:00:00+08:00", planCode: "BETA", epic: "epic:KANB", phase: 1 },
            { no: 104, kind: "task", file: ".zcode/plans/plan-78-beta.md", title: "乙卡", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 106, kind: "plan", file: ".zcode/plans/plan-78-gamma.md", title: "稿丙（KANB 一期）", assignedAt: "2026-10-01T00:00:00+08:00", planCode: "GAMA", epic: "epic:KANB", phase: 1 },
            { no: 107, kind: "task", file: ".zcode/plans/plan-78-gamma.md", title: "丙卡", assignedAt: "2026-10-01T00:00:00+08:00" },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const isoDaysAgo = (days) => {
      const t = new Date(Date.now() - days * 86400_000);
      const p = (n) => String(n).padStart(2, "0");
      return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
    };
    setMtime(root, ".zcode/plans/plan-78-alpha.md", isoDaysAgo(10));
    setMtime(root, ".zcode/plans/plan-78-beta.md", isoDaysAgo(3));
  },
  assert(c, ctx) {
    const { root, board } = ctx;
    const [preCheck, assign, compile, finalCheck] = ctx.steps;
    const schema = JSON.parse(readFileSync(join(ASSETS_DIR, "board.schema.json"), "utf8"));
    const golden = JSON.parse(readFileSync(join(ASSETS_DIR, "samples", "board.golden.json"), "utf8"));
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const markersText = readFileSync(join(ASSETS_DIR, "contracts", "markers.md"), "utf8");

    // ---- 1. schema：终态词表不动 + 整体取消/归档后板形态可表达（本卡不动版本位；顺延已由 A1-5 #80 落地）
    const epicStatusEnum = schema?.properties?.epics?.items?.properties?.status?.enum ?? [];
    c.eq(epicStatusEnum, ["active", "cancelled", "archived"], "#78：epic 登记行终态词表保持 active|cancelled|archived（本卡不动枚举值）");
    c.eq(schema["x-schemaVersion"], "2.4", "#78：本卡未动版本位——x-schemaVersion 现值 2.4 = A1-5 收口顺延后实读");
    c.eq(schema["x-contractVersion"], "2.5", "#78：本卡未动版本位——x-contractVersion 现值 2.5 = A1-5 收口顺延后实读");

    const cancelledBoard = clone(golden);
    cancelledBoard.epics = [{ code: "KANB", title: "看板系统", status: "cancelled" }];
    const member = cancelledBoard.features.filter((f) => f.kind === "plan")[0];
    member.epic = "epic:KANB";
    member.phase = 1;
    member.status = "cancelled";
    member.stage = "已取消";
    for (const t of member.tasks ?? []) {
      t.status = "cancelled";
      t.stage = "已取消";
    }
    c.eq(validateSchemaValue(schema, cancelledBoard), [], "#78 可表达：整体取消后板（epic cancelled + 成员稿逐稿取消留痕）过 schema 子集校验");

    const archivedBoard = clone(golden);
    archivedBoard.epics = [{ code: "KANB", title: "看板系统", status: "archived" }];
    c.eq(validateSchemaValue(schema, archivedBoard), [], "#78 可表达：epic 归档后登记行留档（archived）与成员稿离板并存");

    // ---- 2. 契约文本：§10.6 成文与三类反例可判（缺条必咬——本组写入前为红侧）
    c.inc(markersText, "v2.4 补篇段（#78", "#78：markers.md 载 #78 变更段（v2.4 补篇，不改版本号）");
    c.inc(markersText, "### 10.6", "#78：markers.md §10.6「epic 整体取消与归档」成文");
    const sec78Start = markersText.indexOf("### 10.6");
    const sec78EndRaw = sec78Start < 0 ? -1 : markersText.indexOf("\n## ", sec78Start + 1);
    const sec78 = sec78Start < 0 ? "" : markersText.slice(sec78Start, sec78EndRaw < 0 ? markersText.length : sec78EndRaw);
    c.ok(sec78.length > 800, "#78：§10.6 节实体非空（完整成文，非占位）", show({ len: sec78.length }));
    // 节内锚点（§10.5 已先有部分名目；节内锚定保证「§10.6 未成文即红」，不被上文同名文字蒙混）
    c.inc(sec78, "在途 run 处置清单", "§10.6 载整体取消第三件套「在途 run 处置清单点名」");
    c.inc(sec78, "勘误 10", "§10.6 载勘误 10 依据（三映射复用）");
    c.inc(sec78, "成员稿逐稿", "§10.6 载成员稿逐稿留痕（零新语法，复用 §3.1 落点）");
    c.inc(sec78, "登记面指向改写", "§10.6 载「登记面指向改写」（第四种改写落名）");
    c.inc(sec78, "第四种改写", "§10.6 载第四种改写名目");
    c.inc(sec78, "缺留痕", "§10.6 载「成员稿缺留痕 → 对账点名」边界");
    c.inc(sec78, "对账点名级", "§10.6 载缺留痕判级（对账点名级、非失败级）");
    c.inc(sec78, "冷却未到", "§10.6 载「冷却未到」判据（不点名、保持现状合法）");
    c.inc(sec78, "`updatedAt` 之 max", "§10.6 载冷却时钟 = 成员稿 updatedAt 之 max");
    c.inc(sec78, "不是 min", "§10.6 载时钟取 max 的误读拒收（不是 min/最早）");
    c.inc(sec78, "epic 登记行置 `archived`", "§10.6 载归档登记行置态（archived）");
    c.inc(sec78, "`file`/`specRoot` 改指归档路径", "§10.6 载成员条目指向改写（file/specRoot → 归档路径）");
    c.inc(sec78, "B 线对账面", "§10.6 载机具承接（对账点名归 B 线对账面）");
    c.inc(sec78, "机械断言归 A2", "§10.6 载机具承接（断言实现归 A2）");
    c.inc(sec78, "§3.1", "#78：§10.6 交叉引用 §3.1（特性级落点复用）");
    c.inc(sec78, "§10.5", "#78：§10.6 交叉引用 §10.5（终态优先序与永不复用）");
    c.inc(sec78, "§10.2", "#78：§10.6 交叉引用 §10.2（登记行载体）");
    // 反例表（§10.4）与细则指向（§10.2/§10.5 → §10.6）——全文锚，缺条必咬
    c.inc(markersText, "缺 `> cancelled:` 留痕", "§10.4 反例表载①缺留痕判定");
    c.inc(markersText, "冷却未到却被点名", "§10.4 反例表载②冷却未到误报判定");
    c.inc(markersText, "仍指活路径", "§10.4 反例表载③改写指向错误判定");
    c.inc(markersText, "见 §10.6", "§10.2/§10.5 行指向 §10.6 细则（交叉引用在位）");

    // ---- 3. 反例①缺留痕（真实夹具可观察）：稿甲留痕生效、稿乙缺留痕仍进行态
    const fAlpha = featureByTitle(board, "稿甲（KANB 一期）");
    const fBeta = featureByTitle(board, "稿乙（KANB 一期）");
    c.eq(fAlpha?.status, "cancelled", "反例①前置：稿甲有特性级 `> cancelled:` 留痕 → 特性 cancelled（复用 #66 落点，零新语法）");
    c.eq(fAlpha?.stage, "已取消", "反例①：稿甲段位已取消（终态不让位）");
    c.inc(fAlpha?.statusRule ?? "", "成员稿逐稿留痕", "反例①：留痕原因进 statusRule（取消留痕可追溯）");
    c.eq(fBeta?.status, "pending", "反例①：稿乙缺留痕 → 仍进行态（epic 已归档而成员未留痕 = 缺留痕状态在板上可观察）");
    c.eq(fBeta?.stage, "待办", "反例①：稿乙段位待办（未留痕可判；机械点名承接归 A2/B 线）");
    c.ok(!featureByTitle(board, "稿丙（KANB 一期）"), "反例①前置：稿丙已归档离板（成员稿归档后不在板上）");

    // ---- 4. 反例③改写指向错误（半态 → 修复；登记行置态与新整批断言归 A2）
    c.eq(preCheck?.code, 1, "反例③：成员稿已归档而登记条目未随移动改指 → --check 非零（半态被咬住）");
    c.inc(preCheck.stdout, "运行 --assign", "反例③：失败诊断给出修复路径（--assign 改写指向）");
    c.inc(preCheck.stdout, "plan-78-gamma", "反例③：诊断点名成员条目（归档候选路径）");
    c.eq(assign?.code, 0, "修复：--assign 退出码 0");
    c.inc(assign.stderr, "归档指向改写", "修复诊断记录指向改写（不静默）");
    const registry = readJsonFile(join(root, ".zcode/board/registry.json")).value;
    const e106 = registry?.entries?.find((e) => e.no === 106);
    const e107 = registry?.entries?.find((e) => e.no === 107);
    c.eq(e106?.file, ".zcode/archive/plan-78-gamma.md", "改写后：成员条目 106 指向归档路径");
    c.eq(e107?.file, ".zcode/archive/plan-78-gamma.md", "改写后：成员任务条目 107 同批改指（成员稿归档 = 整稿同批）");
    c.eq(
      { no: e106?.no, assignedAt: e106?.assignedAt, epic: e106?.epic, phase: e106?.phase, planCode: e106?.planCode },
      { no: 106, assignedAt: "2026-10-01T00:00:00+08:00", epic: "epic:KANB", phase: 1, planCode: "GAMA" },
      "改写只动指向：号/assignedAt/epic/phase/planCode 一律不改（第四种改写纪律）",
    );
    c.eq(registry?.epics, [{ code: "KANB", title: "看板系统", status: "archived" }], "epic 登记行原样保留（置态写入归 A2 机具；现有 --assign 不擅动登记行）");
    c.eq(compile?.code, 0, "重编译退出码 0（归档成员离板、活成员照常上板）");
    c.eq(finalCheck?.code, 0, "修复后 --check 通过（归档件按指向直查）");
    c.inc(finalCheck.stdout, "已归档", "check note 明写「已归档」");
    c.ok(
      (board?.features ?? []).length === 2 &&
        ["稿甲（KANB 一期）", "稿乙（KANB 一期）"].every((t) => featureByTitle(board, t)),
      "归档成员稿丙离板；活成员（稿甲/稿乙）照常上板（成员稿归档不影响其余成员）",
      show((board?.features ?? []).map((f) => f.title)),
    );
    c.ok(!JSON.stringify(board?.sources ?? []).includes("archive"), "sources[] 不含归档路径（成员稿归档后不在扫描面）");

    // ---- 5. 反例②冷却未到（时钟 = 成员稿 updatedAt 之 max；夹具 [10 天, 3 天] → max 3 天 < 7 → 冷却未到）
    const ageDays = (iso) => (Date.now() - Date.parse(iso ?? "")) / 86400_000;
    const ages = [fAlpha, fBeta].map((f) => ageDays(f?.updatedAt));
    c.ok(
      Math.abs(ages[0] - 10) < 0.2 && Math.abs(ages[1] - 3) < 0.2,
      "反例②前置：成员稿 updatedAt 派生自源 mtime（稿甲 10 天前 / 稿乙 3 天前）——时钟基准数据在板上可取",
      show(ages.map((a) => Math.round(a * 10) / 10)),
    );
    c.ok(
      Math.min(...ages) < 7 && Math.max(...ages) > 7,
      "反例②：时钟取 max updatedAt = 最近动过的一份（距今 3 天）→ 冷却未到、不点名；误取最早（10 天 > 7）会误报——时钟只能取 max（§10.6.2）",
      show({ 最近: Math.round(Math.min(...ages) * 10) / 10, 最早: Math.round(Math.max(...ages) * 10) / 10 }),
    );

    // ---- 6. board.schema.json 注释一致性（x-note 补篇 + x-decisions 细则条；枚举与版本位不动）
    const note78 = String(schema["x-note"] ?? "");
    c.inc(note78, "#78", "#78：x-note 载 #78 补篇条目（epic 整体取消与归档）");
    c.inc(note78, "第四种改写", "#78：x-note 载第四种改写名目");
    c.inc(note78, "在途 run 处置清单", "#78：x-note 载在途 run 处置清单点名");
    const d78 = (schema["x-decisions"] ?? []).filter((d) => d.includes("#78 规格冻结"));
    c.ok(d78.length >= 1, "#78：x-decisions 载 #78 冻结条（A1-5 收口后草案措辞随动；对照面非空）", show(d78.map((d) => d.slice(0, 60))));
    c.ok(
      d78.length >= 1 &&
        d78.every(
          (d) =>
            d.includes("在途 run 处置清单") &&
            d.includes("缺留痕") &&
            d.includes("登记面指向改写") &&
            d.includes("`updatedAt` 之 max"),
        ),
      "#78：x-decisions #78 条含四锚点（处置清单 / 缺留痕 / 登记面指向改写 / 冷却 max）",
      show(d78),
    );
  },
});

// ---------------------------------------------------------------- A1-4（#79）迁移补录路径与无 epic 合法（规格 + 真实夹具层）

// ---- 场景 79（#79）：归属措辞与补录路径成文（markers.md §10.7）——归属为「应当而非必须」：同产品
//      多期次应当归入同一 epic；单稿小功能可不归属；无 epic 合法（顶层平铺渲染、不标「未归属」、
//      `--check` 不判失败）；PREV 型已取消无 epic 稿保持顶层（拍板「PREV 保持顶层」）；存量补录走
//      `--assign --epic <code>` 同通道一次性改写（补录只加归属对：不动号/计划码/assignedAt）。
//      反例（误判必咬）：夹具构造零 epic 项目（含 PREV 型已取消无 epic 稿）——若实现引入「未归属」
//      判定（--check 点名/失败级，或板面渲染「未归属」角标），本场景必咬；误判不存在时零噪声。
//      边界注记（承接标注）：补录机具 `--assign --epic` 归 A2-1、归属断言包归 A2-2、存量整批补录
//      执行归 A5、渲染实现归 A3-*——本场景断言域 = 契约成文（§10.7 缺条必咬，写入前为红侧）+
//      现有编译/--check/--assign 对无 epic 稿的零失败零点名（无归属不得伪装为缺口/失败）。
scenario("79", "#79：迁移补录路径与无 epic 合法——§10.7 措辞/补录通道成文；零 epic 项目编译与 --check 零失败零点名（PREV 型取消稿保持顶层；误判「未归属」必咬）", {
  steps: [{ args: [] }, { args: ["--check"] }, { args: ["--assign"] }, { args: ["--check"] }],
  build(root) {
    // 零 epic 项目：单稿小功能（可不归属）+ PREV 型已取消无 epic 稿（拍板：PREV 保持顶层）
    w(
      root,
      ".zcode/plans/plan-79-solo.md",
      [
        "# 单稿小功能（无 epic 稿）",
        "<!-- zcode-board: no=201 -->",
        "",
        "- [ ] 1. 小步改进 <!-- zcode-board: no=202 -->",
        "",
      ].join("\n"),
    );
    w(
      root,
      ".zcode/plans/plan-79-prev.md",
      [
        "# 预览通道旧稿（PREV 型 · 已取消）",
        "<!-- zcode-board: no=203 -->",
        "> cancelled: 方案作废，按拍板保持顶层（PREV 保持顶层）",
        "",
        "- [ ] 1. 旧条目 <!-- zcode-board: no=204 -->",
        "",
      ].join("\n"),
    );
    w(
      root,
      ".zcode/board/registry.json",
      `${JSON.stringify(
        {
          version: 1,
          seq: 204,
          entries: [
            {
              no: 201,
              kind: "plan",
              file: ".zcode/plans/plan-79-solo.md",
              title: "单稿小功能（无 epic 稿）",
              assignedAt: "2026-10-01T00:00:00+08:00",
              planCode: "SOLO",
            },
            { no: 202, kind: "task", file: ".zcode/plans/plan-79-solo.md", title: "小步改进", assignedAt: "2026-10-01T00:00:00+08:00" },
            {
              no: 203,
              kind: "plan",
              file: ".zcode/plans/plan-79-prev.md",
              title: "预览通道旧稿（PREV 型 · 已取消）",
              assignedAt: "2026-10-01T00:00:00+08:00",
              planCode: "PREV",
            },
            { no: 204, kind: "task", file: ".zcode/plans/plan-79-prev.md", title: "旧条目", assignedAt: "2026-10-01T00:00:00+08:00" },
          ],
        },
        null,
        2,
      )}\n`,
    );
  },
  assert(c, ctx) {
    const { root, board } = ctx;
    const [compile, midCheck, assign, finalCheck] = ctx.steps;
    const markersText = readFileSync(join(ASSETS_DIR, "contracts", "markers.md"), "utf8");

    // ---- 1. 契约文本：§10.7「归属措辞与补录路径」成文（写入前为红侧——缺条必咬）
    c.inc(markersText, "v2.4 补篇段（#79", "#79：markers.md 载 #79 变更段（v2.4 补篇，不改版本号）");
    c.inc(markersText, "### 10.7", "#79：markers.md §10.7「归属措辞与补录路径」成文");
    const sec79Start = markersText.indexOf("### 10.7");
    const sec79EndRaw = sec79Start < 0 ? -1 : markersText.indexOf("\n## ", sec79Start + 1);
    const sec79 = sec79Start < 0 ? "" : markersText.slice(sec79Start, sec79EndRaw < 0 ? markersText.length : sec79EndRaw);
    c.ok(sec79.length > 600, "#79：§10.7 节实体非空（完整成文，非占位）", show({ len: sec79.length }));
    c.inc(sec79, "应当归入同一 epic", "§10.7 载归属措辞（应当面）：同产品多期次应当归入同一 epic");
    c.inc(sec79, "单稿小功能可不归属", "§10.7 载归属措辞（非必须面）：单稿小功能可不归属");
    c.inc(sec79, "无 epic 合法", "§10.7 载无 epic 合法（AD-8 拍板）");
    c.inc(sec79, "顶层平铺", "§10.7 载无 epic 稿顶层平铺渲染");
    c.inc(sec79, "不把「无归属」判失败", "§10.7 载 --check 口径：不把「无归属」判失败");
    c.inc(sec79, "PREV 保持顶层", "§10.7 载拍板原文「PREV 保持顶层」（已取消无 epic 稿保持顶层块）");
    c.inc(sec79, "--assign --epic", "§10.7 载补录通道（--assign --epic 同通道）");
    c.inc(sec79, "一次性改写", "§10.7 载补录形态（一次性批量改写）");
    c.inc(sec79, "补录只加归属对", "§10.7 载补录不改身份（补录只加归属对：不动号/计划码/assignedAt）");
    c.inc(sec79, "归类正确", "§10.7 载 AD-9⑤（归类审查入 plan-reviewer「归类正确」项）");
    c.inc(sec79, "plan-reviewer", "§10.7 载审查门落点（plan-reviewer）");
    const seg79Line = markersText.split("\n").find((l) => l.includes("v2.4 补篇段（#79")) ?? "";
    c.inc(seg79Line, "不改版本号", "#79：变更段标注不改版本号（版本顺延归 A1-5）");
    c.inc(seg79Line, "A1-5", "#79：变更段载版本顺延归属（A1-5 统一收口）");
    // 反例表（§10.4）与交叉引用——全文锚，缺条必咬
    c.inc(markersText, "板面渲染「未归属」角标", "§10.4 反例表载误判行（把无归属当违规 / 渲染「未归属」角标）");
    c.inc(markersText, "手工直改 registry", "§10.4 反例表载绕过补录通道（手工直改 registry）拒收");
    c.inc(markersText, "归类审查 finding", "§10.4 反例表载同产品多期次各立 epic 的归类审查判定");
    c.inc(markersText, "措辞与补录路径见 §10.7", "§10.1 AD-8 行指向 §10.7 细则（交叉引用在位）");

    // ---- 2. 无 epic 稿编译与板上形态（顶层渲染；误判「未归属」必咬的反例夹具）
    c.eq(compile?.code, 0, "零 epic 项目默认编译退出码 0（无 epic 不阻断）");
    c.ok(!Object.hasOwn(board ?? {}, "epics"), "零 epic 项目 board.json 无 epics 键（AD-8；照旧渲染）");
    const fSolo = featureByTitle(board, "单稿小功能（无 epic 稿）");
    const fPrev = featureByTitle(board, "预览通道旧稿（PREV 型 · 已取消）");
    c.ok(fSolo != null, "单稿小功能照常上板（无归属不影响上板）");
    c.ok(
      fSolo != null && !Object.hasOwn(fSolo, "epic") && !Object.hasOwn(fSolo, "phase"),
      "单稿小功能 epic/phase 双缺省（合法缺省形态，不凭空补字段）",
    );
    c.eq(fSolo?.attention, [], "单稿小功能无缺口（「未归属」不得伪装为缺口码）");
    c.eq(fPrev?.status, "cancelled", "PREV 型稿特性级取消生效（> cancelled: 落点复用）");
    c.eq(fPrev?.stage, "已取消", "PREV 型稿段位已取消（终态不让位）");
    c.ok(
      fPrev != null && !Object.hasOwn(fPrev, "epic") && !Object.hasOwn(fPrev, "phase"),
      "PREV 型已取消稿同样无归属字段（拍板：PREV 保持顶层）",
    );
    c.inc(fPrev?.statusRule ?? "", "保持顶层", "PREV 型稿取消原因留痕进 statusRule（顶层即正常形态）");

    // board.md 顶层渲染形态：两稿平铺在「## 特性」节内（不落入 epic 容器、不标「未归属」）
    const md = ctx.run.md ?? "";
    c.inc(md, "### SOLO · 单稿小功能（无 epic 稿）", "board.md 顶层渲染：单稿小功能以计划码 SOLO 平铺（顶层，非 epic 容器内）");
    c.inc(md, "### PREV · 预览通道旧稿（PREV 型 · 已取消）", "board.md 顶层渲染：PREV 型保持顶层块（拍板）");
    c.ok(
      md.indexOf("## 特性") >= 0 &&
        md.indexOf("## 特性") < md.indexOf("### PREV") &&
        md.indexOf("### PREV") < md.indexOf("### SOLO"),
      "两稿按顶层特性序平铺（## 特性 节内；扫描序 = 文件名字典序 prev < solo，文档序不变）",
      show({ head: md.indexOf("## 特性"), prev: md.indexOf("### PREV"), solo: md.indexOf("### SOLO") }),
    );
    c.ok(
      !md.includes("未归属") && !md.includes("无归属"),
      "board.md 不标注/不报「未归属」「无归属」（无 epic = 正常形态而非缺口；误判必咬）",
    );

    // ---- 3. --check 零失败零点名（若实现误判「未归属」为失败或点名，本组必咬）
    c.eq(midCheck?.code, 0, "--check 退出码 0（无 epic 不判失败）");
    c.inc(midCheck?.stdout ?? "", "结论：--check 通过（0 项失败）", "--check 结论 = 通过（0 项失败）");
    c.ok(
      !(midCheck?.stdout ?? "").includes("未归属") && !(midCheck?.stdout ?? "").includes("无归属"),
      "--check 输出零点名「未归属」「无归属」（误判必咬）",
    );
    c.ok(!(midCheck?.stdout ?? "").includes("对账点名"), "--check 无对账点名节（零噪声）", truncate(midCheck?.stdout ?? ""));

    // ---- 4. --assign 对无 epic 稿零改写（补录须显式 --assign --epic 通道；机具归 A2-1）
    c.eq(assign?.code, 0, "--assign 退出码 0（无 epic 项目不因缺归属报错）");
    const registry = readJsonFile(join(root, ".zcode/board/registry.json")).value;
    const byNo = (n) => (registry?.entries ?? []).find((e) => e.no === n);
    c.ok(
      [201, 202, 203, 204].every((n) => byNo(n) && !Object.hasOwn(byNo(n), "epic") && !Object.hasOwn(byNo(n), "phase")),
      "--assign（不带 --epic）不凭空补归属对：四条目 epic/phase 均不出现（补录走显式 --assign --epic 通道）",
      show((registry?.entries ?? []).map((e) => ({ no: e.no, epic: e.epic, phase: e.phase }))),
    );
    c.ok(!Object.hasOwn(registry ?? {}, "epics"), "registry 无 epics 段（零 epic 项目形态；补录时先登记 epic，§10.7.2）");

    // ---- 5. 补录后复核口径：最终 --check 仍 0 失败（顶层稿不受牵连）
    c.eq(finalCheck?.code, 0, "最终 --check 退出码 0");
    c.inc(finalCheck?.stdout ?? "", "结论：--check 通过（0 项失败）", "最终 --check 结论 = 通过（0 项失败）");
  },
});

// ---------------------------------------------------------------- B1-1（#97）第五不变量：completed 须有该卡 integrator done 证据（对账点名级）

// ---- 场景 97a（#97 第五不变量 e）：completed 卡须有该卡 integrator done 的 run 证据；
//      缺证据 = 对账点名级（非失败级，--check 仍通过、退出码 0）；删证据必咬（红侧突变夹具）
scenario("97a", "#97 第五不变量 e：completed 卡须有 integrator done 证据——缺证据对账点名（非失败级、不阻塞）；删证据必咬", {
  build(root) {
    const planRel = ".zcode/plans/plan-97-merged-evidence.md";
    w(
      root,
      planRel,
      [
        "# 合并证据夹具 97",
        "<!-- zcode-board: no=1 -->",
        "",
        "- [x] 1. 已合并卡 <!-- zcode-board: no=2 -->",
        "- [x] 2. 无证据卡 <!-- zcode-board: no=3 -->",
        "- [ ] 3. 未完成卡 <!-- zcode-board: no=4 -->",
        "- [x] 4. 仅 partial 证据卡 <!-- zcode-board: no=5 -->",
        "",
      ].join("\n"),
    );
    w(
      root,
      ".zcode/board/registry.json",
      `${JSON.stringify(
        {
          version: 1,
          seq: 5,
          entries: [
            { no: 1, kind: "plan", file: planRel, title: "合并证据夹具 97", assignedAt: "2026-10-01T00:00:00+08:00", planCode: "EVID" },
            { no: 2, kind: "task", file: planRel, title: "已合并卡", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 3, kind: "task", file: planRel, title: "无证据卡", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 4, kind: "task", file: planRel, title: "未完成卡", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 5, kind: "task", file: planRel, title: "仅 partial 证据卡", assignedAt: "2026-10-01T00:00:00+08:00" },
          ],
        },
        null,
        2,
      )}\n`,
    );
    seedRuns(root, [
      { runId: "run-97a-merged", sessionId: "sess_97a", role: "integrator", at: "2026-10-09T13:00:00+08:00", result: "done", cards: [2], breakpoint: null },
      {
        runId: "run-97a-partial",
        sessionId: "sess_97a",
        role: "integrator",
        at: "2026-10-09T14:00:00+08:00",
        result: "partial",
        cards: [5],
        breakpoint: { stoppedAt: 5, next: "重试合并" },
      },
    ]);
  },
  assert(c, ctx) {
    const { root, board } = ctx;
    const f = featureByTitle(board, "合并证据夹具 97");
    c.eq(
      (f?.tasks ?? []).map((t) => t.status),
      ["completed", "completed", "pending", "completed"],
      "夹具前置：勾选态直映（[x]=completed；仅 integrator partial 的卡亦 completed，partial 不算 done 证据）",
    );

    // 绿侧：缺证据只点名、不判失败（对账级；--check 通过，退出码 0）
    const clean = checkProject(root);
    c.ok(
      clean.ok,
      "--check 通过：对账点名不阻塞（非失败级）",
      show((clean.failures ?? []).map((x) => `[${x.category}] ${x.message}`)),
    );
    const roll = clean.rollcall ?? [];
    c.eq(roll.length, 2, "对账点名恰 2 项（#3 无证据、#5 仅 partial）", show(roll));
    const joined = roll.join("\n");
    c.inc(joined, "不变量 e", "点名文案属第五不变量 e");
    c.inc(joined, "features[0].tasks[1]", "点名 #3 的节点路径");
    c.inc(joined, "#3", "点名 #3 稳定号");
    c.inc(joined, "features[0].tasks[3]", "点名 #5 的节点路径");
    c.inc(joined, "#5", "点名 #5 稳定号");
    c.ok(!joined.includes("#2"), "已合并卡（integrator done 证据在）不点名", joined);
    c.ok(!joined.includes("#4"), "未完成卡不点名（只对 completed 判）", joined);
    c.inc(joined, "runs.json", "点名写明证据源（runs.json）");

    const cli = runCompiler(root, ["--check"]);
    c.eq(cli.code, 0, "缺证据但无失败项：--check 退出码 0（不阻塞正常流）");
    c.inc(cli.stdout, "对账点名", "stdout 有独立「对账点名」节");
    c.inc(cli.stdout, "#3", "stdout 逐条点名 #3");
    c.inc(cli.stdout, "#5", "stdout 逐条点名 #5");
    c.ok(!cli.stdout.includes("校验失败"), "非失败级：报告不出现「校验失败」节", cli.stdout);

    // 红侧（突变夹具：把 integrator run 删掉必咬）：删除 #2 的 done 证据 → 重编译后点名 #2
    seedRuns(root, readRuns(root).filter((r) => r.runId !== "run-97a-merged"));
    const recompiled = runCompiler(root, []);
    c.eq(recompiled.code, 0, "删证据后重编译成功（前置）");
    const bitten = checkProject(root);
    c.ok(
      bitten.ok,
      "删证据不改变判级：仍非失败级",
      show((bitten.failures ?? []).map((x) => `[${x.category}] ${x.message}`)),
    );
    const bittenRoll = bitten.rollcall ?? [];
    c.eq(bittenRoll.length, 3, "删掉 #2 的 integrator done run → 点名增为 3 项（#2/#3/#5）", show(bittenRoll));
    c.inc(bittenRoll.join("\n"), "features[0].tasks[0]", "失控证据后 #2 被点名（路径）");
    c.inc(bittenRoll.join("\n"), "#2", "失控证据后 #2 被点名（稳定号）");
    const cliBitten = runCompiler(root, ["--check"]);
    c.eq(cliBitten.code, 0, "红侧：仍退出码 0（对账级非失败级）");
    c.inc(cliBitten.stdout, "#2", "红侧 stdout 点名 #2");
  },
});

// ---- 场景 97b（#97 豁免登记）：登记豁免（.zcode/board/exemptions.json，{no, reason, at}）后点名消失；
//      坏登记 = 失败级「豁免登记」，且该条不生效（不静默放行，也不静默改写）
scenario("97b", "#97 豁免登记：合法登记后点名消失（非失败级）；坏登记失败级点名且不生效（格式与位置本轮定案）", {
  build(root) {
    const planRel = ".zcode/plans/plan-97-exemption.md";
    w(
      root,
      planRel,
      [
        "# 豁免登记夹具 97",
        "<!-- zcode-board: no=10 -->",
        "",
        "- [x] 1. 有证据卡 <!-- zcode-board: no=11 -->",
        "- [x] 2. 速修卡（无合并证据，待登记豁免） <!-- zcode-board: no=12 -->",
        "- [ ] 3. 未完成卡 <!-- zcode-board: no=13 -->",
        "",
      ].join("\n"),
    );
    w(
      root,
      ".zcode/board/registry.json",
      `${JSON.stringify(
        {
          version: 1,
          seq: 13,
          entries: [
            { no: 10, kind: "plan", file: planRel, title: "豁免登记夹具 97", assignedAt: "2026-10-01T00:00:00+08:00", planCode: "EXMP" },
            { no: 11, kind: "task", file: planRel, title: "有证据卡", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 12, kind: "task", file: planRel, title: "速修卡（无合并证据，待登记豁免）", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 13, kind: "task", file: planRel, title: "未完成卡", assignedAt: "2026-10-01T00:00:00+08:00" },
          ],
        },
        null,
        2,
      )}\n`,
    );
    seedRuns(root, [
      { runId: "run-97b-merged", sessionId: "sess_97b", role: "integrator", at: "2026-10-09T13:00:00+08:00", result: "done", cards: [11], breakpoint: null },
    ]);
  },
  assert(c, ctx) {
    const { root } = ctx;
    c.eq(EXEMPTIONS_REL, ".zcode/board/exemptions.json", "登记位置本轮定案：.zcode/board/exemptions.json（编排者单写者）");

    // 登记格式校验器（lib/schema-check.mjs，纯函数）公开语义
    c.eq(checkExemptionsDoc({ version: 1, exemptions: [] }).errors, [], "空登记表：合法（零错误）");
    const okDoc = checkExemptionsDoc({ version: 1, exemptions: [{ no: 12, reason: "速修直提交（无走卡合并）", at: "2026-10-10T09:00:00+08:00" }] });
    c.eq([okDoc.errors.length, okDoc.exemptNos], [0, [12]], "合法条目：零错误 + 生效号提取");
    const structBad = checkExemptionsDoc({ version: 2, exemptions: "x" });
    c.ok(structBad.errors.length >= 1, "结构非法（version≠1 / exemptions 非数组）：逐项点名", show(structBad.errors));
    c.eq(structBad.exemptNos, [], "结构非法 → 整份拒收（零豁免生效）");
    const dupDoc = checkExemptionsDoc({
      version: 1,
      exemptions: [
        { no: 12, reason: "a", at: "2026-10-10T09:00:00+08:00" },
        { no: 12, reason: "b", at: "2026-10-10T09:05:00+08:00" },
      ],
    });
    c.ok(dupDoc.errors.some((e) => e.includes("重复")), "同号重复登记 → 失败级点名", show(dupDoc.errors));

    // 未登记：点名 #12（前置）
    const before = checkProject(root);
    c.eq((before.rollcall ?? []).length, 1, "未登记豁免：恰点名 #12", show(before.rollcall));
    c.inc((before.rollcall ?? [])[0] ?? "", "#12", "点名文案含 #12");

    // 合法登记：点名消失、不引入失败项、CLI 零点名噪声
    w(
      root,
      EXEMPTIONS_REL,
      `${JSON.stringify(
        { version: 1, exemptions: [{ no: 12, reason: "速修直提交 main（用户拍板，无走卡合并）", at: "2026-10-10T09:00:00+08:00" }] },
        null,
        2,
      )}\n`,
    );
    const after = checkProject(root);
    c.eq(after.rollcall ?? [], [], "登记豁免后点名消失（#12 不再点名）");
    c.ok(after.ok, "合法登记不引入失败项（--check 通过）", show((after.failures ?? []).map((x) => `[${x.category}] ${x.message}`)));
    const cliOk = runCompiler(root, ["--check"]);
    c.eq(cliOk.code, 0, "登记豁免：--check 退出码 0");
    c.ok(!cliOk.stdout.includes("对账点名"), "stdout 无「对账点名」节（点名消失即零噪声）", cliOk.stdout);

    // FINDING-1 回炉（B1 批量验证）：结构非法路径 = version≠1/字符串/缺失 且 exemptions 为合法数组
    // → 整份拒收（exemptNos 恒空），不得"报错但条目仍生效"（version 闸形同虚设）
    const legalEntry = { no: 12, reason: "结构非法夹具：version 不合法时该条不得生效", at: "2026-10-10T09:00:00+08:00" };
    for (const [label, badDoc] of [
      ["version=2", { version: 2, exemptions: [legalEntry] }],
      ['version="1"（字符串）', { version: "1", exemptions: [legalEntry] }],
      ["version 缺失", { exemptions: [legalEntry] }],
    ]) {
      const unit = checkExemptionsDoc(badDoc);
      c.eq(unit.exemptNos, [], `${label}：结构非法 → 零豁免生效（单测，整份拒收）`);
      c.ok(unit.errors.some((e) => e.includes("$.version")), `${label}：失败级点名 version（单测）`, show(unit.errors));
      w(root, EXEMPTIONS_REL, `${JSON.stringify(badDoc, null, 2)}\n`);
      const vBad = checkProject(root);
      c.ok((vBad.failures ?? []).some((x) => x.category === "豁免登记"), `${label}：--check 失败项类别「豁免登记」`);
      const vRoll = vBad.rollcall ?? [];
      c.eq(vRoll.length, 1, `${label}：整份拒收 → #12 恢复点名`, show(vRoll));
      c.inc(vRoll.join("\n"), "#12", `${label}：恢复点名指向 #12`);
      const vCli = runCompiler(root, ["--check"]);
      c.eq(vCli.code, 1, `${label}：CLI 非零退出（失败级）`);
    }

    // 坏登记（条目级非法：缺 reason / no 非整数）→ 失败级「豁免登记」，该条不生效（#12 重新点名）
    w(
      root,
      EXEMPTIONS_REL,
      `${JSON.stringify(
        {
          version: 1,
          exemptions: [
            { no: 12, at: "2026-10-10T09:00:00+08:00" },
            { no: "12", reason: "字符串号", at: "2026-10-10T09:05:00+08:00" },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const bad = checkProject(root);
    const regFails = (bad.failures ?? []).filter((x) => x.category === "豁免登记");
    c.eq(regFails.length, 2, "两条非法登记各一条失败级点名（缺 reason / no 非整数）", show(regFails.map((x) => x.message)));
    c.ok(!bad.ok, "坏登记：--check 失败（非零退出语义）");
    c.inc((bad.rollcall ?? []).join("\n"), "#12", "非法条目不生效：#12 重新点名（不静默放行）");
    const cliBad = runCompiler(root, ["--check"]);
    c.eq(cliBad.code, 1, "坏登记：CLI 非零退出");
    c.inc(cliBad.stdout, "豁免登记", "stdout 失败项点名类别「豁免登记」");

    // 解析失败：整份拒收（零豁免生效），失败级点名
    w(root, EXEMPTIONS_REL, "{ 坏 JSON\n");
    const broken = checkProject(root);
    c.ok((broken.failures ?? []).some((x) => x.category === "豁免登记"), "解析失败 → 失败级「豁免登记」");
    c.eq((broken.rollcall ?? []).length, 1, "整份拒收：#12 恢复点名（豁免零生效）");
  },
});

// ---------------------------------------------------------------- D2-2（#152）卡号绑定断言：worktree 名 ↔ 卡号（对账点名级）

// ---- 场景 152：板面 worktree（#151 归一后的现场实际路径）末段 task-<no> 必须等于该卡稳定号——
//      错配 → 对账点名（非失败级、退出码 0）；合规/不进判定域 → 零噪声；错配声明移除 → 点名自清。
//      判级依据（成文于 compile-board.mjs checkWorktreeCardBinding 与 run-event.md §2.1）：错配源自
//      追加式 runs 声明（不可由重编译修复），故与第五不变量 (e) 同通道——对账点名级、不阻断退出码。
scenario("152", "#152 卡号绑定：worktree 末段号 ≠ 卡号 → 对账点名（非失败级）；短/嵌套两形态都咬；合规与不进判定域零噪声", {
  build(root) {
    const planRel = ".zcode/plans/plan-152-binding.md";
    w(
      root,
      planRel,
      [
        "# 卡号绑定夹具 152",
        "<!-- zcode-board: no=1 -->",
        "",
        "- [ ] 1. 合规短形态现场 <!-- zcode-board: no=9 -->",
        "- [ ] 2. 错配短形态现场（#10 声明 task-9） <!-- zcode-board: no=10 -->",
        "- [ ] 3. 错配嵌套现场（#22 声明 task-21，现场在子项目根） <!-- zcode-board: no=22 -->",
        "- [ ] 4. 合规现场（#30 声明 task-30） <!-- zcode-board: no=30 -->",
        "- [ ] 5. 目录缺失的错配声明（#12 声明 task-13） <!-- zcode-board: no=12 -->",
        "- [ ] 6. 形态非法声明（#14 两级嵌套） <!-- zcode-board: no=14 -->",
        "- [ ] 7. 未声明现场 <!-- zcode-board: no=15 -->",
        "",
      ].join("\n"),
    );
    w(
      root,
      ".zcode/board/registry.json",
      `${JSON.stringify(
        {
          version: 1,
          seq: 30,
          entries: [
            { no: 1, kind: "plan", file: planRel, title: "卡号绑定夹具 152", assignedAt: "2026-10-01T00:00:00+08:00", planCode: "BIND" },
            { no: 9, kind: "task", file: planRel, title: "合规短形态现场", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 10, kind: "task", file: planRel, title: "错配短形态现场（#10 声明 task-9）", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 22, kind: "task", file: planRel, title: "错配嵌套现场（#22 声明 task-21，现场在子项目根）", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 30, kind: "task", file: planRel, title: "合规现场（#30 声明 task-30）", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 12, kind: "task", file: planRel, title: "目录缺失的错配声明（#12 声明 task-13）", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 14, kind: "task", file: planRel, title: "形态非法声明（#14 两级嵌套）", assignedAt: "2026-10-01T00:00:00+08:00" },
            { no: 15, kind: "task", file: planRel, title: "未声明现场", assignedAt: "2026-10-01T00:00:00+08:00" },
          ],
        },
        null,
        2,
      )}\n`,
    );
    seedRuns(root, [
      // 合规：现场名 = 卡号（#9 声明 task-9；同一现场随后被 #10 错配声明——E4-09/H3 的原始构造）
      { runId: "run-152-a9", sessionId: "sess_152", role: "implementer", at: "2026-10-10T01:00:00+08:00", result: "partial", cards: [9], worktree: ".zcode/worktrees/task-9", branch: "task-9", evidence: [], breakpoint: { stoppedAt: 9, next: "继续" } },
      // 错配（短形态）：#10 声明 task-9（目录存在 → 板挂 unmerged）
      { runId: "run-152-b10", sessionId: "sess_152", role: "implementer", at: "2026-10-10T01:01:00+08:00", result: "partial", cards: [10], worktree: ".zcode/worktrees/task-9", branch: "task-9", evidence: [], breakpoint: { stoppedAt: 10, next: "继续" } },
      // 错配（嵌套归一）：#22 声明短形态，现场在子项目根 proj-x 下 → #151 归一为现场实际路径后仍错配
      { runId: "run-152-c22", sessionId: "sess_152", role: "implementer", at: "2026-10-10T01:02:00+08:00", result: "partial", cards: [22], worktree: ".zcode/worktrees/task-21", branch: "task-21", evidence: [], breakpoint: { stoppedAt: 22, next: "继续" } },
      // 合规：现场名 = 卡号
      { runId: "run-152-d30", sessionId: "sess_152", role: "implementer", at: "2026-10-10T01:03:00+08:00", result: "partial", cards: [30], worktree: ".zcode/worktrees/task-30", branch: "task-30", evidence: [], breakpoint: { stoppedAt: 30, next: "继续" } },
      // 记录级错配但目录缺失 → 不进判定域（现场不在：字段 null，由 #42 降级诊断承载）
      { runId: "run-152-e12", sessionId: "sess_152", role: "implementer", at: "2026-10-10T01:04:00+08:00", result: "partial", cards: [12], worktree: ".zcode/worktrees/task-13", branch: "task-13", evidence: [], breakpoint: { stoppedAt: 12, next: "继续" } },
      // 形态非法（两级嵌套）→ 归一层拒收，字段 null → 不进判定域
      { runId: "run-152-f14", sessionId: "sess_152", role: "implementer", at: "2026-10-10T01:05:00+08:00", result: "partial", cards: [14], worktree: "proj-x/inner/.zcode/worktrees/task-14", branch: "task-14", evidence: [], breakpoint: { stoppedAt: 14, next: "继续" } },
      // 未声明现场（缺省 null，不推导）→ 不进判定域
      { runId: "run-152-g15", sessionId: "sess_152", role: "implementer", at: "2026-10-10T01:06:00+08:00", result: "done", cards: [15], evidence: [], breakpoint: null },
    ]);
    // fs 事实：① 根级 task-9（#9 合规现场 + #10 错配声明指向它）；② 根级 task-30（#30 合规）；
    //   ③ 子项目根 proj-x 下 task-21（#22 短声明经后缀互证归一为现场实际路径）。task-13 / proj-x/inner 不存在。
    mkdirSync(join(root, ".zcode", "worktrees", "task-9"), { recursive: true });
    mkdirSync(join(root, ".zcode", "worktrees", "task-30"), { recursive: true });
    mkdirSync(join(root, "proj-x", ".zcode", "worktrees", "task-21"), { recursive: true });
  },
  assert(c, ctx) {
    const { root, board, run } = ctx;
    const f = featureByTitle(board, "卡号绑定夹具 152");
    const card9 = taskByTitle(f, "合规短形态现场");
    const card10 = taskByTitle(f, "错配短形态现场（#10 声明 task-9）");
    const card22 = taskByTitle(f, "错配嵌套现场（#22 声明 task-21，现场在子项目根）");
    const card30 = taskByTitle(f, "合规现场（#30 声明 task-30）");
    const card12 = taskByTitle(f, "目录缺失的错配声明（#12 声明 task-13）");
    const card14 = taskByTitle(f, "形态非法声明（#14 两级嵌套）");
    const card15 = taskByTitle(f, "未声明现场");

    // 夹具前置：板面 worktree = #151 归一后的现场实际路径（判定域 = 非空字段）
    c.eq(card9?.worktree, ".zcode/worktrees/task-9", "前置：#9 合规现场字段=声明路径（exact 命中）");
    c.eq(card10?.worktree, ".zcode/worktrees/task-9", "前置：H3 构造——#10 现场字段=他人名下路径 task-9（目录存在 → 板挂 unmerged）");
    c.ok((card10?.attention ?? []).includes("unmerged-worktree"), "前置：#10 挂 unmerged-worktree（错配现场被计入待合并归属）");
    c.eq(card22?.worktree, "proj-x/.zcode/worktrees/task-21", "前置：#22 短声明经 #151 归一为子项目根现场实际路径");
    c.eq(card30?.worktree, ".zcode/worktrees/task-30", "前置：#30 合规现场字段");
    c.eq(card12?.worktree, null, "前置：#12 声明目录缺失 → 字段 null（历史/无现场的记录级错配不进判定域，由 #42 提示级诊断承载）");
    c.eq(card14?.worktree, null, "前置：#14 形态非法 → 归一层拒收、字段 null（不进判定域）");
    c.eq(card15?.worktree, null, "前置：#15 未声明现场 → 字段 null（不按卡号推导，#42）");

    // 绿侧（点名级）：错配逐条点名但不判失败（--check 通过、退出码 0）
    const res = checkProject(root);
    c.ok(
      res.ok,
      "对账点名不阻塞：--check 通过（非失败级）",
      show((res.failures ?? []).map((x) => `[${x.category}] ${x.message}`)),
    );
    const roll = res.rollcall ?? [];
    c.eq(roll.length, 2, "卡号绑定恰点名 2 项（#10 短形态错配、#22 嵌套归一错配）", show(roll));
    const joined = roll.join("\n");
    c.inc(joined, "卡号绑定", "点名文案属「卡号绑定（worktree 名 ↔ 卡号）」判据");
    c.inc(joined, "features[0].tasks[1]", "点名 #10 的节点路径（tasks[1]）");
    c.inc(joined, "（#10）", "点名 #10 稳定号");
    c.inc(joined, "task-9", "两值对照含工作树名 task-9");
    c.inc(joined, "features[0].tasks[2]", "点名 #22 的节点路径（tasks[2]）");
    c.inc(joined, "（#22）", "点名 #22 稳定号");
    c.inc(joined, "proj-x/.zcode/worktrees/task-21", "嵌套形态按归一后现场路径点名（末段 task-21）");
    c.inc(joined, "非失败级", "点名写明判级（对账点名级）");
    c.ok(!joined.includes("（#9）"), "合规卡（名=号，与 #10 共享同一现场）不点名", joined);
    c.ok(!joined.includes("（#30）"), "合规卡 #30 不点名", joined);
    c.ok(!joined.includes("（#12）"), "目录缺失的记录级错配不点名（不进判定域，不重复 #42 提示）", joined);
    c.ok(!joined.includes("（#14）"), "形态非法声明不点名（不进判定域，不重复归一层诊断）", joined);
    c.ok(!joined.includes("（#15）"), "未声明现场不点名", joined);

    const cli = runCompiler(root, ["--check"]);
    c.eq(cli.code, 0, "CLI：--check 退出码 0（对账点名不阻断）");
    c.inc(cli.stdout, "对账点名", "stdout 有独立「对账点名」节");
    c.inc(cli.stdout, "（#10）", "stdout 逐条点名 #10");
    c.inc(cli.stdout, "（#22）", "stdout 逐条点名 #22");
    c.ok(!cli.stdout.includes("校验失败"), "非失败级：报告不出现「校验失败」节", cli.stdout);
    c.inc(run.md ?? "", ".zcode/worktrees/task-9", "board.md 待合并聚合照常渲染现场（点名不改板面派生）");

    // 错配声明移除（现场按命名纪律收口/清理后）→ 点名自清（自愈路径，无需机械修复）
    seedRuns(root, readRuns(root).filter((r) => r.runId !== "run-152-b10" && r.runId !== "run-152-c22"));
    const recompiled = runCompiler(root, []);
    c.eq(recompiled.code, 0, "错配声明移除后重编译成功（前置）");
    const after = checkProject(root);
    c.eq(after.rollcall ?? [], [], "错配声明移除（现场收口）→ 点名自清（零残留）");
    c.ok(
      after.ok,
      "点名自清后 --check 仍通过（0 失败）",
      show((after.failures ?? []).map((x) => `[${x.category}] ${x.message}`)),
    );
  },
});

// ---------------------------------------------------------------- E1b-1（#159）苗圃位置规则：裁决稿/设计稿/纲领稿禁入 plans/

// ---- 场景 159（#159/E1b-1；契约 §11 位置分层）：苗圃（.zcode/plans/）内裁决稿/设计稿/纲领稿按文件名/标题
//      特征命中 → --check 对账点名（非失败级、退出码 0、不阻断）；正常计划稿（plan-* 命名约定，含标题含
//      族词者）零误报；无法判族不判（零噪音）；移至新位置 .zcode/design/ 后点名自清（绿）；design/ 不进
//      扫描面（scan.json 池外引用被拒，文件零触碰）。
scenario("159", "#159 苗圃位置规则：裁决稿/设计稿/纲领稿被 --check 点名（对账点名级）；plan-* 零误报；移至 .zcode/design/ 后点名自清", {
  build(root) {
    const planDoc = (title) => [`# ${title}`, "", "- **T1 条目（草案）**：正文。", ""].join("\n");
    // 正常计划稿：plan-* 命名约定（含标题含族词的豁免反例）+ 无法判族（不判，不噪音）→ 全部零点名
    w(root, ".zcode/plans/plan-keep.md", planDoc("苗圃稿"));
    w(root, ".zcode/plans/plan-sess_00000000-0000-4000-8000-000000000159.md", planDoc("会话稿 159"));
    w(root, ".zcode/plans/plan-设计稿评审计划.md", planDoc("设计稿评审计划（plan- 前缀豁免反例）"));
    w(root, ".zcode/plans/后续期路线.md", planDoc("后续期路线（无法判族：不判）"));
    w(root, ".zcode/plans/scratch-note.md", planDoc("便签（无法判族：不判）"));
    // 苗圃违例 5 例：裁决稿 ×3（文件名首段 ×2 含中文、H1 自称 ×1）、设计稿 ×1、纲领稿 ×1
    w(root, ".zcode/plans/adjudication-board.md", planDoc("裁决包 · 看板系统 board-v2（文件名首段判族）"));
    w(root, ".zcode/plans/裁决包-board-v2.md", planDoc("裁决包 · 中文首段判族"));
    w(root, ".zcode/plans/design-p2-内置注入.md", planDoc("设计稿 · P2 内置注入（文件名首段判族）"));
    w(root, ".zcode/plans/program-board-v2.md", planDoc("整体开发纲要 · board-v2（文件名首段判族）"));
    w(root, ".zcode/plans/board-v2-裁决包.md", planDoc("裁决包 · board-v2（文件名首段无族词 → H1 自称判族）"));
    // 新位置（约定层 .zcode/design/）：不进计划扫描面、零吸入、文件零触碰
    w(root, ".zcode/design/adjudication-board-v2.md", planDoc("裁决包 · 已落新位置"));
  },
  assert(c, ctx) {
    const { root, board } = ctx;
    const NURSERY = ".zcode/plans";
    const DESIGN = ".zcode/design";
    const violators = [
      { rel: `${NURSERY}/adjudication-board.md`, family: "裁决稿" },
      { rel: `${NURSERY}/裁决包-board-v2.md`, family: "裁决稿" },
      { rel: `${NURSERY}/design-p2-内置注入.md`, family: "设计稿" },
      { rel: `${NURSERY}/program-board-v2.md`, family: "纲领稿" },
      { rel: `${NURSERY}/board-v2-裁决包.md`, family: "裁决稿" },
    ];
    const clean = [
      `${NURSERY}/plan-keep.md`,
      `${NURSERY}/plan-sess_00000000-0000-4000-8000-000000000159.md`,
      `${NURSERY}/plan-设计稿评审计划.md`,
      `${NURSERY}/后续期路线.md`,
      `${NURSERY}/scratch-note.md`,
    ];

    // 前置：苗圃全扫（含违例稿——位置违例不改扫描面，只点名）；新位置 design/ 不在扫描面
    const planSources = (board.sources ?? []).filter((s) => s.kind === "plan").map((s) => s.path);
    c.ok(
      violators.every((v) => planSources.includes(v.rel)),
      "前置：苗圃内违例稿照常在扫描面（位置违例靠点名、不静默改扫描面）",
      show(planSources),
    );
    c.eq(planSources.filter((p) => p.startsWith(`${DESIGN}/`)), [], "前置：新位置 .zcode/design/ 不进计划扫描面");
    c.ok(!JSON.stringify(board).includes("已落新位置"), "前置：design/ 内文档零吸入（不上板）");

    // 红侧（点名级）：文件名/标题族词命中 → 逐条对账点名，不判失败（--check 通过、退出码 0）
    const res = checkProject(root);
    c.ok(
      res.ok,
      "位置违例不阻塞：--check 通过（对账点名级、非失败级）",
      show((res.failures ?? []).map((x) => `[${x.category}] ${x.message}`)),
    );
    const roll = res.rollcall ?? [];
    c.eq(roll.length, 5, "苗圃位置违例恰点名 5 项（裁决稿 ×3、设计稿 ×1、纲领稿 ×1）", show(roll));
    const joined = roll.join("\n");
    for (const v of violators) {
      c.inc(joined, `${v.rel} 判为${v.family}`, `点名 ${v.rel}（族：${v.family}）`);
    }
    c.inc(joined, "位置规则", "点名文案属「苗圃位置规则」判据（#159/E1b-1）");
    c.inc(joined, "禁入", "点名写明禁入苗圃");
    c.inc(joined, `.zcode/design/`, "点名给出新位置 .zcode/design/（移位收口路径）");
    c.inc(joined, "自清", "点名写明移位后本项自清（自愈路径）");
    c.inc(joined, "A5-4", "点名写明处置输入归 A5-4（接口注记）");
    c.inc(joined, "非失败级", "点名写明判级（对账点名级、非失败级）");
    for (const rel of clean) {
      c.ok(!joined.includes(rel), `零误报：${rel} 不点名`, joined);
    }

    // CLI 红侧：stdout 有独立「对账点名」节（断言切片到该节，避免诊断节的路径命中造成假绿）、
    // 退出码 0、不出现「校验失败」
    const cli = runCompiler(root, ["--check"]);
    c.eq(cli.code, 0, "CLI 红侧：--check 退出码 0（不阻断正常流）");
    const cliRollAt = cli.stdout.indexOf("对账点名");
    c.ok(cliRollAt >= 0, "stdout 有独立「对账点名」节");
    const cliRoll = cliRollAt >= 0 ? cli.stdout.slice(cliRollAt) : "";
    c.inc(cli.stdout, "--check 通过", "stdout 结论仍为通过（非失败级）");
    for (const v of violators) c.inc(cliRoll, v.rel, `「对账点名」节逐条点名 ${v.rel}`);
    c.ok(
      !cliRoll.includes(`${NURSERY}/plan-keep.md`) && !cliRoll.includes(`${NURSERY}/plan-设计稿评审计划.md`),
      "「对账点名」节：正常计划稿（含标题含族词者）零误报",
      cliRoll.slice(0, 600),
    );
    c.ok(!cli.stdout.includes("校验失败"), "非失败级：报告不出现「校验失败」节", cli.stdout);

    // 绿侧：三稿处置动作（移至新位置 .zcode/design/，移位不改名）→ 重编译对账 → 点名自清、扫描面照常
    mkdirSync(join(root, DESIGN), { recursive: true });
    for (const v of violators) {
      const src = join(root, v.rel);
      const dest = join(root, DESIGN, basename(v.rel));
      writeFileSync(dest, readFileSync(src));
      rmSync(src);
    }
    const recompiled = runCompiler(root, []);
    c.eq(recompiled.code, 0, "移位后重编译退出码 0（前置：板与源同步）");
    const after = checkProject(root);
    c.eq(after.rollcall ?? [], [], "移至 .zcode/design/ 后点名自清（零残留）");
    c.ok(
      after.ok,
      "移位后 --check 仍通过（0 失败）",
      show((after.failures ?? []).map((x) => `[${x.category}] ${x.message}`)),
    );
    const cliGreen = runCompiler(root, ["--check"]);
    c.eq(cliGreen.code, 0, "CLI 绿侧：--check 退出码 0");
    c.ok(!cliGreen.stdout.includes("对账点名"), "绿侧 stdout 不再出现「对账点名」节", cliGreen.stdout);
    c.inc(cliGreen.stdout, "通过", "绿侧结论 = 通过");

    // 新位置边界：不进扫描面/不上板/文件零触碰；scan.json 池外引用被拒（design/ 永不能进计划扫描面）
    const planSources2 = (recompiled.board?.sources ?? []).filter((s) => s.kind === "plan").map((s) => s.path);
    c.eq(planSources2.filter((p) => p.startsWith(`${DESIGN}/`)), [], "新位置 .zcode/design/ 仍不进扫描面");
    c.ok(!JSON.stringify(recompiled.board ?? {}).includes("已落新位置"), "design/ 文档零吸入（不上板）");
    c.ok(
      violators.every((v) => isFile(join(root, DESIGN, basename(v.rel)))) && isFile(join(root, DESIGN, "adjudication-board-v2.md")),
      "design/ 内文件全部存在（编译器零触碰）",
    );

    // 忽略口径（excludeGlobs）：苗圃违例稿被项目显式排除 → 不扫不判（零点名）；与 #72 同源、不二份实现
    w(root, ".zcode/plans/program-legacy.md", ["# 整体开发纲要 · legacy（忽略口径夹具）", "", "- **T1 条目（草案）**：正文。", ""].join("\n"));
    w(root, ".zcode/board/scan.json", `${JSON.stringify({ excludeGlobs: ["**/program-legacy.md"] }, null, 2)}\n`);
    const compiledIgnored = runCompiler(root, []);
    c.eq(compiledIgnored.code, 0, "excludeGlobs 夹具重编译退出码 0");
    const ignoredFacts = checkProject(root);
    c.eq(ignoredFacts.rollcall ?? [], [], "被 excludeGlobs 排除的苗圃违例稿不判（项目级显式忽略口径，零点名）");
    c.ok(
      !(compiledIgnored.board?.sources ?? []).some((s) => s.kind === "plan" && s.path === `${NURSERY}/program-legacy.md`),
      "排除项不扫（不在 sources[]）",
    );
    c.ok(isFile(join(root, NURSERY, "program-legacy.md")), "排除项文件零触碰");
    rmSync(join(root, NURSERY, "program-legacy.md"));

    w(root, ".zcode/board/scan.json", `${JSON.stringify({ includeDirs: [DESIGN] }, null, 2)}\n`);
    const cfg = checkProject(root);
    const cfgDiags = (cfg.board?.diagnostics ?? []).filter((d) => d.path === ".zcode/board/scan.json");
    c.eq(cfgDiags.length, 1, "scan.json 引用 .zcode/design（池外）→ 恰 1 条诊断（拒绝该条）", show(cfgDiags));
    c.inc(cfgDiags[0]?.message ?? "", DESIGN, "诊断点名被拒目录 .zcode/design");
    c.inc(cfgDiags[0]?.message ?? "", "opt-in 池", "诊断说明「池外引用拒绝」判据");
    c.ok(
      (cfg.failures ?? []).some((f) => f.category === "扫描面配置" && String(f.message).includes(DESIGN)),
      "扫描面配置错误归 --check 失败级（配置错不静默）",
      show((cfg.failures ?? []).map((x) => `[${x.category}] ${x.message}`)),
    );
    c.ok(!JSON.stringify(cfg.board ?? {}).includes("已落新位置"), "池外引用不改变扫描面：design/ 仍零吸入");

    // 规则成文（契约面）：markers.md §11 位置分层（规则文本可机械核对；版本仍 v2.4——不改版本号）
    const markersText = readFileSync(join(ASSETS_DIR, "contracts", "markers.md"), "utf8");
    c.inc(markersText, "## 11. 位置分层", "markers.md §11 位置分层成文");
    c.inc(markersText, ".zcode/design/", "契约写明新位置 .zcode/design/");
    c.inc(markersText, "裁决稿/设计稿禁入 plans/", "契约写明规则原话（裁决稿/设计稿禁入 plans/）");
    c.inc(markersText, "对账点名级（非失败级、不阻断退出码）", "契约写明判级（对账点名级）");
    c.inc(markersText, "plan-*", "契约写明计划稿命名约定豁免（正常计划稿零误报）");
    c.inc(markersText, "A5-4", "契约写明 A5-4 处置输入接口注记");
  },
});

// ---------------------------------------------------------------- 事实互证库 lib/fact-invariants.mjs 的公开契约

function factLibChecks(c, mod) {
  const { checkCompletedMergedEvidence, checkFactInvariants } = mod;
  c.eq(typeof checkFactInvariants, "function", "lib/fact-invariants.mjs 导出 checkFactInvariants（纯函数）");

  const feature = (over) => ({
    kind: "plan",
    title: "特性",
    status: "active",
    statusRule: "r",
    stage: "执行中",
    stageRule: "r",
    attention: [],
    tasks: [],
    ...over,
  });
  const task = (over) => ({ title: "卡", status: "pending", statusRule: "r", stage: "待办", stageRule: "r", attention: [], ...over });

  // 零噪声基线：空板 / 有卡有号但不违例
  c.eq(checkFactInvariants({ board: { features: [] } }), [], "空板：四条不变量零违例");
  c.eq(
    checkFactInvariants({
      board: { features: [{ ...feature({ no: 1, label: "1" }), tasks: [task({ no: 2, label: "1" })] }] },
    }),
    [],
    "有卡有号且自洽：零违例",
  );

  // (a) 子卡全完成 → 特性 stage 必须已完成；roadmap 压制段位不误报；半完成不判
  const aOut = checkFactInvariants({
    board: { features: [{ ...feature({ no: 1, label: "1" }), tasks: [task({ no: 2, label: "1", status: "completed" })] }] },
  });
  c.eq(aOut.length, 1, "(a) 全完成但 stage=执行中：恰 1 条违例", show(aOut));
  c.inc(aOut[0] ?? "", "不变量 a", "(a) 文案点名不变量 a");
  c.inc(aOut[0] ?? "", "features[0]", "(a) 文案点名路径 features[0]");
  c.inc(aOut[0] ?? "", "#1", "(a) 文案点名编号 #1");
  c.inc(aOut[0] ?? "", '"执行中"', "(a) 文案给出实际值");
  c.inc(aOut[0] ?? "", '"已完成"', "(a) 文案给出应然值");
  c.eq(
    checkFactInvariants({
      board: { features: [{ ...feature({ no: 1, label: "1", roadmap: true, stage: "待设计" }), tasks: [task({ status: "completed", stage: "待设计" })] }] },
    }),
    [],
    "(a) roadmap 占位稿：全完成也不判已完成（段位被压制，属设计内）",
  );
  c.eq(
    checkFactInvariants({ board: { features: [{ ...feature({ no: 1, label: "1" }), tasks: [task({ status: "completed" }), task({ status: "pending" })] }] } }),
    [],
    "(a) 半完成：不判已完成",
  );

  // (b) 有卡不得挂 arranged-not-expanded；零卡挂码合法（判据为零卡）
  const bOut = checkFactInvariants({
    board: { features: [{ ...feature({ no: 3, label: "3", attention: ["arranged-not-expanded"] }), tasks: [task({ no: 4, label: "1" })] }] },
  });
  c.eq(bOut.length, 1, "(b) 有卡却挂未拆解：恰 1 条违例", show(bOut));
  c.inc(bOut[0] ?? "", "不变量 b", "(b) 文案点名不变量 b");
  c.inc(bOut[0] ?? "", "features[0]", "(b) 文案点名路径 features[0]");
  c.inc(bOut[0] ?? "", "#3", "(b) 文案点名编号 #3");
  c.inc(bOut[0] ?? "", "arranged-not-expanded", "(b) 文案点名缺口码");
  c.eq(
    checkFactInvariants({ board: { features: [{ ...feature({ no: 3, label: "3", attention: ["arranged-not-expanded"], stage: "待设计" }), tasks: [] }] } }),
    [],
    "(b) 零卡挂未拆解：合法（判据为零卡，宁误报不漏报）",
  );

  // (c) board.md 编号形态 ↔ board.json 派生（含递归深度 ≥2）；缺 md 文本 → 跳过
  const cBoard = {
    features: [
      {
        ...feature({ no: 5, label: "5", planCode: "TST2" }),
        tasks: [task({ no: 6, label: "1" }), task({ no: 7, label: "2", tasks: [task({ no: 8, label: "2.1" })] })],
      },
    ],
  };
  const mdWith = (deepId) =>
    [
      "# 项目看板 · 夹具",
      "",
      "## 特性",
      "",
      "### TST2 · 特性",
      "",
      "- TST2-1 · 卡 — pending（r）· 段位：待办（r）",
      "- TST2-2 · 子卡 — pending（r）· 段位：待办（r）",
      `- ${deepId} · 更深子卡 — pending（r）· 段位：待办（r）`,
      "",
      "## 诊断",
      "",
      "- 无",
      "",
    ].join("\n");
  c.eq(checkFactInvariants({ board: cBoard, boardMd: mdWith("TST2-2.1") }), [], "(c) 编号形态一致（含深度 2）：零违例");
  const cOut = checkFactInvariants({ board: cBoard, boardMd: mdWith("ID-2.1") });
  c.eq(cOut.length, 1, "(c) 嵌套行回落 ID-2.1：恰 1 条违例", show(cOut));
  c.inc(cOut[0] ?? "", "不变量 c", "(c) 文案点名不变量 c");
  c.inc(cOut[0] ?? "", "ID-2.1", "(c) 文案给出实际渲染形态");
  c.inc(cOut[0] ?? "", "TST2-2.1", "(c) 文案给出应然派生形态");
  c.inc(cOut[0] ?? "", "features[0].tasks[1].tasks[0]", "(c) 文案点名嵌套节点路径（递归深度 2）");
  c.inc(cOut[0] ?? "", "#8", "(c) 文案点名节点编号 #8");
  c.eq(checkFactInvariants({ board: cBoard, boardMd: null }), [], "(c) 未提供 board.md 文本：跳过编号形态互证");

  // (d) stageSummary 携带时逐项复算；不携带不判
  const dBoard = {
    features: [
      {
        ...feature({ no: 9, label: "9" }),
        tasks: [task({ no: 10, label: "1", status: "completed", stage: "已完成" }), task({ no: 11, label: "2" })],
      },
    ],
  };
  c.eq(checkFactInvariants({ board: dBoard }), [], "(d) 不携带 stageSummary：不判（零噪声）");
  c.eq(
    checkFactInvariants({ board: { ...dBoard, stageSummary: { 待设计: 0, 待办: 1, 执行中: 1, 审核中: 0, 阻塞: 0, 已完成: 1, 已取消: 0 } } }),
    [],
    "(d) 携带且逐项相等：零违例",
  );
  const dOut = checkFactInvariants({ board: { ...dBoard, stageSummary: { 待设计: 0, 待办: 1, 执行中: 1, 审核中: 0, 阻塞: 0, 已完成: 4, 已取消: 0 } } });
  c.eq(dOut.length, 1, "(d) 已完成计数错 1 项：恰 1 条违例", show(dOut));
  c.inc(dOut[0] ?? "", "不变量 d", "(d) 文案点名不变量 d");
  c.inc(dOut[0] ?? "", 'stageSummary."已完成"=4', "(d) 文案给出携带值与路径");
  c.inc(dOut[0] ?? "", "复算 1", "(d) 文案给出复算值");

  // (e) 第五不变量（#97）：completed 任务卡须有该卡 integrator done 的 run 证据；
  //     对账点名级（独立导出 checkCompletedMergedEvidence，不改变 (a)–(d) 的失败级契约）
  c.eq(typeof checkCompletedMergedEvidence, "function", "(e) 导出 checkCompletedMergedEvidence（第五不变量入口）");
  const eBoard = {
    features: [
      {
        ...feature({ no: 20, label: "20" }),
        tasks: [
          task({ no: 21, label: "1", status: "completed" }),
          task({ no: 22, label: "2", status: "completed" }),
          task({ no: 23, label: "3" }),
          task({ status: "completed" }), // 未领号：无引用位（runs 只能引用稳定号），不判
        ],
      },
    ],
  };
  const eOut = checkCompletedMergedEvidence({ board: eBoard, runs: [] });
  c.eq(eOut.length, 2, "(e) 空 runs：恰 2 条点名（#21/#22；未领号卡不判）", show(eOut));
  c.inc(eOut.join("\n"), "不变量 e", "(e) 文案点名不变量 e");
  c.inc(eOut.join("\n"), "#21", "(e) 点名 #21");
  c.inc(eOut.join("\n"), "#22", "(e) 点名 #22");
  c.inc(eOut.join("\n"), "features[0].tasks[0]", "(e) 点名节点路径");
  c.ok(!eOut.join("\n").includes("#23"), "(e) 未 completed 卡不点名", show(eOut));
  c.ok(!eOut.join("\n").includes("未领号"), "(e) 未领号 completed 卡不判（无引用位边界，防恒名词条）", show(eOut));
  const merged = (over) => ({ role: "integrator", result: "done", cards: [21], ...over });
  c.eq(
    checkCompletedMergedEvidence({ board: eBoard, runs: [merged({})] }).length,
    1,
    "(e) integrator done 证据在 → 恰 1 条（仅 #22）",
  );
  c.eq(
    checkCompletedMergedEvidence({ board: eBoard, runs: [merged({ result: "partial" })] }).length,
    2,
    "(e) partial 不算 done 证据（#21 仍点名）",
  );
  c.eq(
    checkCompletedMergedEvidence({ board: eBoard, runs: [merged({ role: "test-verifier" })] }).length,
    2,
    "(e) 非 integrator 的 done 不算合并证据（#21 仍点名）",
  );
  c.eq(
    checkCompletedMergedEvidence({ board: eBoard, runs: [merged({ result: "interrupted" })] }).length,
    2,
    "(e) interrupted 不算合并证据（#21 仍点名）",
  );
  c.eq(
    checkCompletedMergedEvidence({ board: eBoard, runs: [merged({ result: "failed" })] }).length,
    2,
    "(e) failed 不算合并证据（#21 仍点名）",
  );
  c.eq(
    checkCompletedMergedEvidence({ board: eBoard, runs: [], exemptNos: [21, 22] }).length,
    0,
    "(e) 登记豁免（按稳定号）后不再点名",
  );
  c.eq(checkCompletedMergedEvidence({ board: null, runs: [] }), [], "(e) 板非对象：不判（失败级另一路点名）");
  c.eq(
    checkCompletedMergedEvidence({ board: eBoard, runs: [merged({}), merged({ runId: "r2" })] }),
    checkCompletedMergedEvidence({ board: eBoard, runs: [merged({}), merged({ runId: "r2" })] }),
    "(e) 纯函数：同输入两次调用结果逐字相等",
  );

  // 纯函数：同输入两次调用逐字相同（无隐藏状态/IO）
  c.eq(checkFactInvariants({ board: cBoard, boardMd: mdWith("ID-2.1") }), cOut, "纯函数：同输入两次调用结果逐字相等");
}

// ---------------------------------------------------------------- 词表漂移守卫（S-1，T5356r）

/**
 * S-1（T5356r）：fact-invariants 为防重言式独立复写了 derive / 编译器的词表与渲染位形态；
 * 本守卫把两侧常量逐项对照——任一侧改名/改形态即红，防止不变量 (b) 之类的判据因词表漂移静默失效
 * （如 ARRANGED_NOT_EXPANDED 在 derive 侧改名后，(b) 永远不命中且无人察觉）。
 */
function vocabularyGuardChecks(c, fact, derive, compiler, runs) {
  const snap = typeof fact.vocabularySnapshot === "function" ? fact.vocabularySnapshot() : null;
  if (!c.ok(snap != null, "lib/fact-invariants.mjs 导出 vocabularySnapshot()（S-1 守卫入口）")) return;
  // 契约字面值对照（独立来源：设计与契约文本，不借任一侧实现）
  c.eq(snap.stageValues, SEVEN_STAGES, "复写七段位词表逐项与契约字面值一致");
  c.ok(snap.stageValues !== derive.STAGE_VALUES, "对照非重言：两侧为独立副本（快照非 derive 引用）");
  // 逐项对照：derive 侧改名/改值 → 本断言红（不变量 a/b 的判据常量）
  c.eq(snap.stageValues, derive.STAGE_VALUES, "S-1：复写七段位词表 ↔ derive.STAGE_VALUES 逐项相等");
  c.eq(snap.doneStage, derive.STAGE.DONE, "S-1：DONE_STAGE ↔ derive.STAGE.DONE（不变量 a 的判据常量）");
  c.eq(
    snap.arrangedNotExpanded,
    derive.ATTENTION.ARRANGED_NOT_EXPANDED,
    "S-1：ARRANGED_NOT_EXPANDED ↔ derive.ATTENTION.ARRANGED_NOT_EXPANDED（不变量 b 的判据常量——改名即红，防静默失效）",
  );
  c.eq(snap.attentionCodes, derive.ATTENTION_CODES, "S-1：缺口码序列 ↔ derive.ATTENTION_CODES（待处理节渲染序 + 计数复算的判据词表）");
  // 编号形态里的计划码段 ↔ 编译器 PLAN_CODE_RE 同口径（渲染位形态常量）
  c.eq(`^${snap.planCodeSource}$`, compiler.PLAN_CODE_RE.source, "S-1：计划码形态常量 ↔ compile-board.PLAN_CODE_RE 同口径（渲染位形态）");
  const idRe = new RegExp(snap.idTokenSource);
  for (const t of ["未领号", "#7", "ID-3", "IMPL", "IMPL-1.2"]) {
    c.ok(idRe.test(t), `编号形态匹配合法 token ${JSON.stringify(t)}`, `${snap.idTokenSource}`);
  }
  for (const t of ["ID-undefined", "1.2", "no=7", "impl"]) {
    c.ok(!idRe.test(t), `编号形态拒收非法 token ${JSON.stringify(t)}`, `${snap.idTokenSource}`);
  }
  // 第五不变量 (e) 的合并证据词（#97）：字面值按契约 + 与 runs.mjs 词表成员对照（改名即红，防判据静默失效）
  c.eq(snap.mergedRole, "integrator", "S-1：合并证据角色字面值 = integrator（契约 6.3 勾选=已合并）");
  c.eq(snap.mergedResult, "done", "S-1：合并证据结果字面值 = done（report 三值表）");
  c.ok(runs.RUN_ROLES.includes(snap.mergedRole), "S-1：合并证据角色 ↔ runs.RUN_ROLES 词表成员（#97 第五不变量判据常量）");
  c.ok(runs.RUN_REPORT_RESULTS.includes(snap.mergedResult), "S-1：合并证据结果 ↔ runs.RUN_REPORT_RESULTS 词表成员（#97 第五不变量判据常量）");
}

// ---------------------------------------------------------------- 标记写回库 lib/marker-write.mjs 的公开契约（TQ-3，T5356r）

/**
 * TQ-3（T5356r）：头标记去重守卫须与 board-io 的 MARKER_SOURCE 同口径——合并形态
 * `no=N, roadmap` 也是合法现位头标记，重复插入即产生"同号两处标记"（markers.md §4 反例）。
 */
function markerWriteLibChecks(c, mod) {
  const { insertHeaderMarker } = mod;
  c.eq(typeof insertHeaderMarker, "function", "lib/marker-write.mjs 导出 insertHeaderMarker");
  const merged = "# 合并形态头标记稿\n<!-- zcode-board: no=5, roadmap -->\n";
  c.eq(
    insertHeaderMarker(merged, 7),
    merged,
    "TQ-3：已有合并形态头标记（no=5, roadmap）不再插入（防重复盖号，与 MARKER_SOURCE 同口径）",
  );
  const separate = "# 独立注释头标记稿\n<!-- zcode-board: no=5 -->\n<!-- zcode-board: roadmap -->\n";
  c.eq(insertHeaderMarker(separate, 7), separate, "已有独立成行头标记：不再插入（既有行为不回退）");
  const bare = "# 未盖号稿\n正文\n";
  const marked = insertHeaderMarker(bare, 7);
  c.inc(marked, "<!-- zcode-board: no=7 -->", "未盖号稿：仍插入规范标记（既有行为不回退）");
  c.eq(marked.split(/\r?\n/).filter((l) => l.includes("zcode-board: no=")).length, 1, "未盖号稿插入后恰一处号标记");
}

// ---------------------------------------------------------------- 扫描面配置库 lib/scan-config.mjs 的公开契约（#72）

/**
 * #72：扫描面配置解析的唯一入口——默认面收窄（只 .zcode/plans）、opt-in 池、excludeGlobs 语义、
 * 配置错误兜底。glob 期望值取自契约成文语义（markers.md v2.4 §9），不借实现复算。
 */
function scanConfigLibChecks(c, mod) {
  c.eq(typeof mod.loadScanConfig, "function", "lib/scan-config.mjs 导出 loadScanConfig（唯一解析入口）");
  c.ok(typeof mod.globToRegExp === "function" && typeof mod.matchesAnyGlob === "function", "导出 globToRegExp / matchesAnyGlob（excludeGlobs 语义）");
  c.eq(mod.DEFAULT_PLAN_DIRS, [".zcode/plans"], "默认扫描面冻结为 .zcode/plans 一处（#72 收窄）");
  c.eq(mod.OPT_IN_PLAN_DIRS, ["docs/plans", "docs/design-notes"], "opt-in 池冻结为两目录（冻结序 = 扫描序）");
  c.eq(mod.SCAN_CONFIG_REL, ".zcode/board/scan.json", "配置唯一读取位");

  // glob 语义表（文档化语义的独立真值）
  const cases = [
    ["**/archive/**", "docs/archive/plans/x.md", true],
    ["**/archive/**", "archive/x.md", true],
    ["**/archive/**", "docs/plans/x.md", false],
    ["**/plan-draft-*.md", ".zcode/plans/plan-draft-1.md", true],
    ["**/plan-draft-*.md", "plan-draft-1.md", true],
    ["docs/design-notes/**", "docs/design-notes/a.md", true],
    ["docs/design-notes/**", "docs/design-notes/sub/a.md", true],
    ["docs/design-notes/**", "docs/plans/a.md", false],
    ["docs/*.md", "docs/a.md", true],
    ["docs/*.md", "docs/sub/a.md", false],
    ["?.md", "a.md", true],
    ["?.md", "ab.md", false],
    ["docs/f[1].md", "docs/f[1].md", true],
  ];
  for (const [glob, rel, expected] of cases) {
    c.eq(mod.globToRegExp(glob).test(rel), expected, `glob ${JSON.stringify(glob)} vs ${JSON.stringify(rel)} → ${expected}`);
  }
  c.eq(mod.matchesAnyGlob("docs/plans/x.md", ["**/x.md", "docs/design-notes/**"]), true, "matchesAnyGlob：任一命中即排除");
  c.eq(mod.matchesAnyGlob("docs/plans/x.md", []), false, "matchesAnyGlob：空模式表不排除");

  // 解析面（临时夹具域）：默认 / 坏 JSON 兜底 / 合法 opt-in 冻结序 / 池外拒绝
  const root = newRoot("scan-config-lib");
  try {
    let s = mod.loadScanConfig(root);
    c.eq([s.planDirs, s.errors.length, s.present], [[".zcode/plans"], 0, false], "无 scan.json → 默认面、零诊断");

    w(root, ".zcode/board/scan.json", "{ 坏 JSON\n");
    s = mod.loadScanConfig(root);
    c.eq(s.planDirs, [".zcode/plans"], "坏 JSON → 扫描面回落默认（兜底）");
    c.eq(s.errors.length, 1, "坏 JSON → 恰 1 条失败级诊断");

    w(root, ".zcode/board/scan.json", `${JSON.stringify({ includeDirs: ["docs/design-notes", "docs/plans"], excludeGlobs: ["**/x-*.md"] })}\n`);
    s = mod.loadScanConfig(root);
    c.eq(s.planDirs, [".zcode/plans", "docs/plans", "docs/design-notes"], "合法 opt-in → 默认 + 池内冻结序（与书写顺序无关）");
    c.eq(s.excludeGlobs, ["**/x-*.md"], "excludeGlobs 原样生效");
    c.eq(s.errors, [], "合法配置零诊断");

    w(root, ".zcode/board/scan.json", `${JSON.stringify({ includeDirs: ["docs/plans", "../escape", "/abs", "src"] })}\n`);
    s = mod.loadScanConfig(root);
    c.eq(s.planDirs, [".zcode/plans", "docs/plans"], "非法与池外条目拒绝、池内条目照常生效");
    c.eq(s.errors.length, 3, "三条非法 includeDirs 各一条诊断（.. 穿越 / 绝对路径 / 池外引用）");
  } finally {
    removeRoot(root);
  }
}

// ---------------------------------------------------------------- 主流程

async function main(argv) {
  const onlyIdx = argv.indexOf("--scenario");
  const only = onlyIdx >= 0 ? new Set(String(argv[onlyIdx + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) : null;
  const clean = argv.includes("--clean");

  say("zcode-board · 场景断言（T6 骨架 + T7 派生层；测试先行：红 → 绿）");
  say(`node      : ${process.version}`);
  say(`assets    : ${ASSETS_DIR}`);
  say(`编译器     : ${COMPILER}（存在：${isFile(COMPILER)}）`);
  say(`断言脚本   : ${toPosix(fileURLToPath(import.meta.url))}`);
  say(`场景      : ${only ? [...only].join(",") : "全部"}`);

  say("");
  say("== 静态断言（无第三方依赖 / 交付物存在） ==");
  {
    const c = new Checks("static");
    staticChecks(c);
  }

  say("");
  say("== 冻结库 board-io 的公开契约（标记解析 / 句柄归一 / 原子写 / 时间戳） ==");
  {
    const c = new Checks("lib");
    libChecks(c);
  }

  say("");
  say("== 派生库 lib/derive.mjs 的公开契约（段位纯函数 / 角色表；T7 交付物） ==");
  {
    const c = new Checks("derive-lib");
    try {
      const mod = await import("../lib/derive.mjs");
      deriveLibChecks(c, mod);
    } catch (e) {
      c.ok(false, "lib/derive.mjs 可导入（T7 交付物）", e.message);
    }
  }

  say("");
  say("== 事实互证库 lib/fact-invariants.mjs 的公开契约（#56 四条失败级不变量 + #97 第五不变量对账级） ==");
  {
    const c = new Checks("fact-lib");
    try {
      const mod = await import("../lib/fact-invariants.mjs");
      factLibChecks(c, mod);
    } catch (e) {
      c.ok(false, "lib/fact-invariants.mjs 可导入（#56 交付物）", e.message);
    }
  }

  say("");
  say("== 扫描面配置库 lib/scan-config.mjs 的公开契约（#72：glob 语义 / 默认面收窄 / 配置错误兜底） ==");
  {
    const c = new Checks("scan-config-lib");
    try {
      const mod = await import("../lib/scan-config.mjs");
      scanConfigLibChecks(c, mod);
    } catch (e) {
      c.ok(false, "lib/scan-config.mjs 可导入（#72 交付物）", e.message);
    }
  }

  say("");
  say("== 标记写回库 lib/marker-write.mjs 的公开契约（TQ-3/T5356r：合并形态头标记去重同口径） ==");
  {
    const c = new Checks("marker-write-lib");
    try {
      const mod = await import("../lib/marker-write.mjs");
      markerWriteLibChecks(c, mod);
    } catch (e) {
      c.ok(false, "lib/marker-write.mjs 可导入（T9 交付物）", e.message);
    }
  }

  say("");
  say("== 词表漂移守卫（S-1/T5356r：fact-invariants 复写词表 ↔ derive / compile-board / runs 逐项对照） ==");
  {
    const c = new Checks("vocab-guard");
    try {
      const fact = await import("../lib/fact-invariants.mjs");
      const derive = await import("../lib/derive.mjs");
      const compiler = await import("../compile-board.mjs");
      const runs = await import("../lib/runs.mjs");
      vocabularyGuardChecks(c, fact, derive, compiler, runs);
    } catch (e) {
      c.ok(false, "词表漂移守卫可执行（fact-invariants / derive / compile-board / runs 可导入）", e.message);
    }
  }

  for (const s of SCENARIOS) {
    if (only && !only.has(s.id)) continue;
    say("");
    say(`== 场景 ${s.id}：${s.title} ==`);
    const root = newRoot(`s${s.id}`);
    say(`  夹具：${root}`);
    let failed = false;
    try {
      s.build(root);
    } catch (e) {
      say(`  FAIL  夹具构造异常：${e.message}`);
      failCount += 1;
      failedScenarios.add(s.id);
      failed = true;
    }
    if (!failed) {
      const before = treeSnapshot(root);
      // 步骤支持：默认按 runs 次数跑默认编译；T9 场景可用 steps 注入 --assign 等前置步骤
      const stepPlan = s.steps ?? Array.from({ length: s.runs ?? 1 }, () => ({ args: [] }));
      const steps = [];
      let snap = before;
      for (const step of stepPlan) {
        const args = step.args ?? [];
        const res = runCompiler(root, args);
        const afterStep = treeSnapshot(root);
        steps.push({ ...res, args, before: snap, after: afterStep });
        snap = afterStep;
        say(`  命令：node ${toPosix(COMPILER)} ${root}${args.length > 0 ? ` ${args.join(" ")}` : ""}（退出码 ${res.code}）`);
      }
      const after = snap;
      const compiles = steps.filter((st) => !st.args.includes("--assign"));
      const assigns = steps.filter((st) => st.args.includes("--assign"));
      const last = compiles[compiles.length - 1] ?? steps[steps.length - 1];
      const ctx = {
        root,
        runs: compiles,
        run: last,
        board: last.board,
        before,
        after,
        steps,
        assigns,
        lastStep: steps[steps.length - 1],
      };
      const c = new Checks(s.id);
      const usable = commonChecks(c, ctx);
      if (usable) {
        try {
          s.assert(c, ctx);
        } catch (e) {
          c.ok(false, "场景断言执行异常", e.stack ?? e.message);
        }
      } else {
        c.skip("场景断言", "board.json 不可用");
      }
      if (clean) removeRoot(root);
    }
    if (!clean && failedScenarios.has(s.id)) say(`  保留夹具供排查：${root}`);
  }

  say("");
  say(`结论：通过 ${passCount}，失败 ${failCount}`);
  if (failedScenarios.size > 0) {
    say(`失败场景：${[...failedScenarios].sort().join(", ")}`);
  } else {
    say("全部场景通过（0 失败）");
  }
  return failCount === 0 ? 0 : 1;
}

process.exit(await main(process.argv.slice(2)));
