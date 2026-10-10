#!/usr/bin/env node
/**
 * zcode-board / runs（T8 交付物，文件级单写者：runs.json 唯一写路径）
 *
 * 职责（设计 §5.2/§5.3、contracts/run-event.md 冻结的落账映射与容错语义）：
 *   - mapRunEvent(block, {sessionId, at, runId, mechanical})：run_event 块 → runs 记录（纯函数）；
 *   - appendRun(root, block, {sessionId, now, mechanical})：以上记录原子追加写入
 *     <项目根>/.zcode/board/runs.json（临时文件 + 改名，复用冻结的 lib/board-io.mjs）。
 *
 * 不变量（契约 §0/§2/§3/§5）：
 *   - 机械字段 runId/sessionId/at 由本模块补齐；块内自报的同名字段一律忽略（防伪造时钟）；
 *   - 报告自有字段（role/result/cards/stoppedAt/nextStep/evidence/worktree/branch/pr）照抄，缺省不造；
 *     未知键忽略不转抄（单一事件单一家）；pr 仅形态合法（{number: 正整数, url: http(s)}，契约 v2.1）
 *     时转抄，非法不落 + diagnostics；
 *   - cards: [] ≡ 无卡关联事件；worktree/branch 仅当块内**显式声明**时转抄，缺省一律 null + diagnostics
 *     （v2.1 勘误 #42：取消「cards 恰含一卡即推导 task-<no>」——推导给管理型 run 凭空造出幽灵执行现场）；
 *   - 引用位只认稳定号正整数（字符串按 markers.md §4 句柄归一：9 / #9 / ID-9 → 9）；
 *     层级标签与其余非法值丢弃 + diagnostics，不静默改写为其他号；
 *   - 表外 role/result → 跳过该块 + diagnostics，进程不失败；interrupted 仅机械通道可记
 *     （run-event.md §2：报告只能给 done|partial|failed，interrupted 由 Stop hook/应用补记）；
 *   - 追加式：既有记录与顶层键零改写；源缺失按空执行记录新建（version=1）；源损坏拒绝覆盖（不丢数据）。
 *
 * 界面边界：stdin（hook payload / 裸报告）的解析与 run_event 块的抽取归 T13 的 record-run.mjs；
 * 本模块只接受已解析的块并保证"唯一写路径"。无第三方依赖（仅 node 内置）。
 */

import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

import { isoLocal, normalizeHandle, readJsonFile, writeJsonAtomic } from "./board-io.mjs";

/** runs.json 相对项目根路径（设计 §5.2；与编译器 sources[] 同一路径）。 */
export const RUNS_REL = ".zcode/board/runs.json";
/** role 词表（设计 §5.2 / 角色矩阵 §1.3；B2-1/#99 第四绿扩词：ui-designer 可落账）。 */
export const RUN_ROLES = [
  "implementer",
  "debugger",
  "refactoring-optimizer",
  "code-reviewer",
  "test-verifier",
  "integrator",
  "ui-designer",
];
/** 报告块允许的 result（run-event.md §2：报告只能给这三值）。 */
export const RUN_REPORT_RESULTS = ["done", "partial", "failed"];
/** runs.json 记录的 result 词表（设计 §5.2：interrupted 由机械通道补记）。 */
export const RUN_RECORD_RESULTS = [...RUN_REPORT_RESULTS, "interrupted"];

const FILE_VERSION = 1;
const NEXT_STEP_MAX = 200;
const RUN_ID_ATTEMPTS = 8;
/** pr.url 冻结形态（契约 v2.1 §2 / schema `^https?://.+`：与读侧 lib/derive.mjs 同口径）。 */
const PR_URL_RE = /^https?:\/\/.+/;

function diag(list, message) {
  list.push({ path: RUNS_REL, message });
}

/** 本地日期段 YYYYMMDD（复用冻结的带时区时间戳工具，保证与 at 同一时区口径）。 */
function localDatePart(date) {
  return isoLocal(date).slice(0, 10).replace(/-/g, "");
}

function newRunId(date) {
  return `run-${localDatePart(date)}-${randomBytes(2).toString("hex")}`;
}

/** 稳定号归一：正整数原样；字符串走 markers.md §4 句柄归一；其余 → null（丢弃，不猜）。 */
function normalizeCardNo(value) {
  if (Number.isInteger(value) && value >= 1) return value;
  if (typeof value === "string") return normalizeHandle(value);
  return null;
}

/**
 * run_event 块 → runs 记录（run-event.md §3 落账映射；纯函数，无 IO）。
 * 返回 {record, diagnostics}；块无效（role/result 表外或块非对象）时 record === null。
 */
export function mapRunEvent(block, { sessionId = null, at = null, runId = null, mechanical = false } = {}) {
  const diagnostics = [];
  const stamp = at instanceof Date ? at : new Date();
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    diag(diagnostics, "run_event 块不是对象：跳过该块（不猜身份）。");
    return { record: null, diagnostics };
  }

  const role = typeof block.role === "string" ? block.role : "";
  if (!RUN_ROLES.includes(role)) {
    diag(
      diagnostics,
      `run_event.role 表外（${JSON.stringify(block.role ?? null)}）：跳过该块（词表：${RUN_ROLES.join("|")}）。`,
    );
    return { record: null, diagnostics };
  }
  const allowedResults = mechanical ? RUN_RECORD_RESULTS : RUN_REPORT_RESULTS;
  const result = typeof block.result === "string" ? block.result : "";
  if (!allowedResults.includes(result)) {
    diag(
      diagnostics,
      `run_event.result 表外（${JSON.stringify(block.result ?? null)}）：跳过该块（词表：${allowedResults.join("|")}）。`,
    );
    return { record: null, diagnostics };
  }

  const cards = [];
  if (block.cards !== undefined && block.cards !== null) {
    if (!Array.isArray(block.cards)) {
      diag(diagnostics, "run_event.cards 不是数组：丢弃该值（不猜卡号）。");
    } else {
      for (const raw of block.cards) {
        const no = normalizeCardNo(raw);
        if (no === null) diag(diagnostics, `run_event.cards 含非法值 ${JSON.stringify(raw)}：丢弃该值（不静默改写）。`);
        else cards.push(no);
      }
    }
  }

  const evidence = [];
  if (block.evidence !== undefined && block.evidence !== null) {
    if (!Array.isArray(block.evidence)) {
      diag(diagnostics, "run_event.evidence 不是数组：丢弃该值（不猜路径）。");
    } else {
      for (const raw of block.evidence) {
        if (typeof raw === "string" && raw !== "") evidence.push(raw);
        else diag(diagnostics, `run_event.evidence 含非法值 ${JSON.stringify(raw)}：丢弃该值。`);
      }
    }
  }

  let stoppedAt = null;
  if (block.stoppedAt !== undefined && block.stoppedAt !== null) {
    const no = normalizeCardNo(block.stoppedAt);
    if (no === null) {
      diag(diagnostics, `run_event.stoppedAt 非法（${JSON.stringify(block.stoppedAt)}）：丢弃该值（不按 cards 猜卡号）。`);
    } else {
      stoppedAt = no;
    }
  }

  let nextStep = null;
  if (block.nextStep !== undefined && block.nextStep !== null) {
    const s = block.nextStep;
    if (typeof s !== "string" || s === "" || /[\r\n]/.test(s) || s.length > NEXT_STEP_MAX) {
      diag(diagnostics, `run_event.nextStep 非法（须单行 ≤${NEXT_STEP_MAX} 字符）：丢弃该值（不截断、不编）。`);
    } else {
      nextStep = s;
    }
  }

  let worktree = typeof block.worktree === "string" && block.worktree !== "" ? block.worktree : null;
  let branch = typeof block.branch === "string" && block.branch !== "" ? block.branch : null;
  if (worktree === null || branch === null) {
    // v2.1 勘误（#42）：取消「恰一卡自动推导」——推导会为管理型 run 凭空造出 task-<no> 幽灵工作树
    // （板面 unmerged-worktree 误报的根因）。执行现场只认块内显式声明，缺省一律 null。
    diag(diagnostics, "run_event 未声明工作树/分支（缺省位一律 null，不按卡号推导执行现场）。");
  }

  let pr = null;
  // 契约 v2.1 §2/§3：pr 是已知键，但仅当形态合法（{number: 正整数, url: http(s)}）时转抄；
  // 形态非法 → 该值不落 + diagnostics（不猜远程号）；缺省/显式 null ≡ 不落该字段（板侧派生为 null）。
  if (block.pr !== undefined && block.pr !== null) {
    const raw = block.pr;
    const legal =
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      Number.isInteger(raw.number) &&
      raw.number >= 1 &&
      typeof raw.url === "string" &&
      PR_URL_RE.test(raw.url);
    if (!legal) {
      diag(diagnostics, "run_event.pr 形态非法（需 {number: 正整数, url: http(s) 链接}）：不落该字段（不猜远程号）。");
    } else {
      pr = { number: raw.number, url: raw.url }; // 仅转抄白名单两键（不得借 pr 通道扩展）
    }
  }

  const record = {
    runId: typeof runId === "string" && runId !== "" ? runId : newRunId(stamp),
    sessionId: typeof sessionId === "string" && sessionId !== "" ? sessionId : null,
    role,
    at: isoLocal(stamp),
    result,
    cards,
    worktree,
    branch,
    evidence,
    breakpoint: stoppedAt === null && nextStep === null ? null : { stoppedAt, next: nextStep },
  };
  if (pr !== null) record.pr = pr; // 缺省不造该字段（契约 §3）
  return { record, diagnostics };
}

/**
 * 原子追加一条 run 记录（runs.json 唯一写路径）。
 * 返回 {ok, record, path, diagnostics}；失败时零写入（既有文件字节不变）。
 */
export function appendRun(projectRoot, block, { sessionId = null, now = new Date(), mechanical = false } = {}) {
  const root = resolve(projectRoot);
  const abs = join(root, RUNS_REL);
  const loaded = readJsonFile(abs);
  let doc;
  if (loaded.missing) {
    doc = { version: FILE_VERSION, runs: [] };
  } else if (!loaded.ok) {
    return {
      ok: false,
      record: null,
      path: abs,
      diagnostics: [{ path: RUNS_REL, message: `runs.json 解析失败（${loaded.error}）：拒绝落账，请人工修复后重试。` }],
    };
  } else if (
    !loaded.value ||
    typeof loaded.value !== "object" ||
    Array.isArray(loaded.value) ||
    !Array.isArray(loaded.value.runs)
  ) {
    return {
      ok: false,
      record: null,
      path: abs,
      diagnostics: [{ path: RUNS_REL, message: "runs.json 结构不合法（runs 必须为数组）：拒绝落账，请人工修复后重试。" }],
    };
  } else {
    doc = loaded.value;
  }

  const stamp = now instanceof Date ? now : new Date();
  let mapped = mapRunEvent(block, { sessionId, at: stamp, runId: newRunId(stamp), mechanical });
  let attempts = 0;
  while (
    mapped.record !== null &&
    doc.runs.some((r) => r && typeof r === "object" && r.runId === mapped.record.runId) &&
    attempts < RUN_ID_ATTEMPTS
  ) {
    attempts += 1;
    mapped = mapRunEvent(block, { sessionId, at: stamp, runId: newRunId(stamp), mechanical });
  }
  if (mapped.record === null) {
    return { ok: false, record: null, path: abs, diagnostics: mapped.diagnostics };
  }
  if (doc.runs.some((r) => r && typeof r === "object" && r.runId === mapped.record.runId)) {
    return {
      ok: false,
      record: null,
      path: abs,
      diagnostics: [...mapped.diagnostics, { path: RUNS_REL, message: `runId 生成冲突（重试 ${RUN_ID_ATTEMPTS} 次）：未落账。` }],
    };
  }

  doc.runs.push(mapped.record);
  try {
    writeJsonAtomic(abs, doc);
  } catch (e) {
    return {
      ok: false,
      record: null,
      path: abs,
      diagnostics: [...mapped.diagnostics, { path: RUNS_REL, message: `落账写盘失败（${e.message}）：未落账（不阻塞主流程）。` }],
    };
  }
  return { ok: true, record: mapped.record, path: abs, diagnostics: mapped.diagnostics };
}
