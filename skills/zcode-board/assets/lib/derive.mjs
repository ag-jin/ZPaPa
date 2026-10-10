#!/usr/bin/env node
/**
 * zcode-board / derive（T7 交付物：派生层纯函数）
 *
 * 职责（设计 §4.3 状态推导 / §4.5 run 归一 / §8.4 四缺口码 / §6.1 工作树诊断挂点）：
 *   1. 特性/任务 status 推导 + statusRule 溯源（确定性规则，按序取第一个命中；run 事件不参与 status）；
 *   2. 段位派生（七段位，纯函数 f(status, activeRun, attention)）+ stageRule 溯源；
 *   3. runs.json 归一：lastRun / activeRun / worktree / pr / attention（§4.5）；
 *      unmerged-worktree 触发判据（#42 收紧）：worktree 字段命中「且」目录经 fs 互证真实存在——
 *      互证基准（真实工作树目录清单）由调用方以纯数据传入；字段命中而目录不在 → 不触发缺口 +
 *      demotedWorktree（调用方落提示级 diagnostics）。
 *   4. 四缺口码与 attentionSummary 计数（§8.4）；
 *   5. 诊断辅助：plan-overgrown（阈值由调用方传入，来源 compile-board.mjs 导出常量）、
 *      progress.execution 与 tasks.md 勾选数不一致、worktree 目录与 runs 互证（纯数据，不触盘）。
 *
 * 边界：本模块不做任何 IO（不读盘、不写盘、不执行 git）——IO 归 compile-board.mjs / board-io.mjs；
 * 无第三方依赖（仅 node 内置，且本文件不需要任何内置模块）。
 */

// ---------------------------------------------------------------- 词表与常量

/** 七段位（用户需求 · 2026-10-09）。"已取消"自契约 v2.1（T21）起为实产出（`> cancelled:` 语法族，markers.md v2.1）。 */
export const STAGE = Object.freeze({
  DESIGN: "待设计",
  TODO: "待办",
  DOING: "执行中",
  REVIEW: "审核中",
  BLOCKED: "阻塞",
  DONE: "已完成",
  CANCELLED: "已取消",
});
export const STAGE_VALUES = Object.freeze(Object.values(STAGE));

/** 干活角色（段位执行中）与判断角色（段位审核中，含"待合并"角标位由 unmerged-worktree 缺口码承载）。 */
export const WORKING_ROLES = Object.freeze(["implementer", "debugger", "refactoring-optimizer"]);
export const JUDGING_ROLES = Object.freeze(["test-verifier", "code-reviewer"]);
export const RUN_ROLES = Object.freeze([...WORKING_ROLES, ...JUDGING_ROLES, "integrator"]);
export const RUN_RESULTS = Object.freeze(["done", "partial", "failed", "interrupted"]);

/** 四缺口码（§8.4）与固定文案（应用侧渲染词汇，§8.4 卡片徽章文案）。 */
export const ATTENTION = Object.freeze({
  INTERVIEWED_NOT_ARRANGED: "interviewed-not-arranged",
  ARRANGED_NOT_EXPANDED: "arranged-not-expanded",
  INTERRUPTED_RESUME: "interrupted-resume",
  UNMERGED_WORKTREE: "unmerged-worktree",
});
export const ATTENTION_CODES = Object.freeze(Object.values(ATTENTION));
export const ATTENTION_LABELS = Object.freeze({
  [ATTENTION.INTERVIEWED_NOT_ARRANGED]: "已访谈，尚未落卡",
  [ATTENTION.ARRANGED_NOT_EXPANDED]: "已安排，尚未拆解任务",
  [ATTENTION.INTERRUPTED_RESUME]: "执行中断，可续（停在 #N）",
  [ATTENTION.UNMERGED_WORKTREE]: "待合并（执行现场未回流）",
});
/** 归入"待设计"段的两个缺口码（尚未进入可执行形态）。 */
export const DESIGN_ATTENTION_CODES = Object.freeze([
  ATTENTION.INTERVIEWED_NOT_ARRANGED,
  ATTENTION.ARRANGED_NOT_EXPANDED,
]);

/** 带时区 ISO 8601 形态（与 board-io.mjs 的 ISO_RE 同源；此处独立常量以保持本模块零依赖、可被 hook 直接引用）。 */
export const ISO_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([+-][0-9]{2}:[0-9]{2}|Z)$/;

/** 时间取 max（按 epoch 比较，容忍不同时区偏移；非法值不参与）。 */
export function maxIso(...candidates) {
  let best = null;
  let bestT = Number.NEGATIVE_INFINITY;
  for (const c of candidates) {
    if (typeof c !== "string" || !ISO_RE.test(c)) continue;
    const t = Date.parse(c);
    if (Number.isNaN(t)) continue;
    if (t > bestT) {
      bestT = t;
      best = c;
    }
  }
  return best;
}

// ---------------------------------------------------------------- 状态推导（§4.3 + §4.2 任务级）

export const PLAN_STATUS_RULE_OPEN = "plan 无勾选记录且无执行证据（§4.3 规则 3：run 事件不参与 status）";
export const PLAN_STATUS_RULE_CHECKED = "plan 有勾选记录（§4.3 规则 3）";
export const PLAN_TASK_RULE_UNCHECKED = "plan 条目未勾选（draft：真相在 plan 文件本身）";
export const PLAN_TASK_RULE_CHECKED = "plan 条目已勾选（draft：真相在 plan 文件本身）";
export const SPEC_TASK_RULE_UNCHECKED = "tasks.md checkbox unchecked（仅反映已合并部分，6.3）";
export const SPEC_TASK_RULE_CHECKED = "tasks.md checkbox checked（勾选=已合并，6.3）";
export const SPEC_TASK_ACTIVE_PREFIX = "progress.current.stage=execution 且 current.title 匹配本卡";
export const DEGRADED_RULE = "源解析失败：状态未知（降级保留标题与 mtime，§12）";

/** 特性 status：progress.json 存在时按 §4.3 规则 1（确定性按序取第一个命中），否则规则 2（tasks.md 勾选面）。 */
export function deriveSpecFeatureStatus({ progress, hasTasksDoc, tasks }) {
  const stages = progress && typeof progress === "object" && progress.stages && typeof progress.stages === "object"
    ? progress.stages
    : null;
  const names = stages ? Object.keys(stages) : [];
  if (names.length > 0) {
    const firstWith = (want) => names.find((n) => stages[n] && stages[n].status === want) ?? null;
    const blockedStage = firstWith("blocked");
    if (blockedStage) return { status: "blocked", statusRule: `progress.stages.${blockedStage}=blocked` };
    const execStatus = stages.execution?.status;
    const reviewStatus = stages["code-review"]?.status;
    if (execStatus === "completed" && (reviewStatus === "completed" || reviewStatus === "not_applicable")) {
      return {
        status: "completed",
        statusRule: "progress.stages.execution=completed 且 code-review completed/not_applicable",
      };
    }
    const activeStage = firstWith("active");
    if (activeStage) return { status: "active", statusRule: `progress.stages.${activeStage}=active` };
    return {
      status: "pending",
      statusRule: "progress.json 存在但无 blocked/completed/active 阶段（§4.3 规则 1 兜底）",
    };
  }
  if (hasTasksDoc) {
    const total = (tasks ?? []).length;
    const checked = (tasks ?? []).filter((t) => t.checked).length;
    if (total > 0 && checked === total) {
      return { status: "completed", statusRule: "无 progress.json：tasks.md 全部勾选（§4.3 规则 2）" };
    }
    if (checked > 0) {
      return { status: "active", statusRule: `无 progress.json：tasks.md 部分勾选 ${checked}/${total}（§4.3 规则 2）` };
    }
    return { status: "pending", statusRule: "无 progress.json：tasks.md 全未勾选（§4.3 规则 2）" };
  }
  return { status: "pending", statusRule: "spec 无 progress.json 与 tasks.md（§4.3 规则 2 兜底）" };
}

/** 计划稿特性 status：§4.3 规则 3（仅有勾选记录 → active；否则 pending + arranged-not-expanded）。 */
export function derivePlanFeatureStatus({ hasChecked }) {
  return hasChecked
    ? { status: "active", statusRule: PLAN_STATUS_RULE_CHECKED }
    : { status: "pending", statusRule: PLAN_STATUS_RULE_OPEN };
}

/** 任务 status（§4.2）：勾选=已合并 → completed；current.title 可确证命中 → active；否则 pending。 */
export function deriveTaskStatus({ checked, currentMatch = false }) {
  if (checked) return { status: "completed", statusRule: SPEC_TASK_RULE_CHECKED };
  if (currentMatch) {
    return { status: "active", statusRule: `${SPEC_TASK_ACTIVE_PREFIX} · ${SPEC_TASK_RULE_UNCHECKED}` };
  }
  return { status: "pending", statusRule: SPEC_TASK_RULE_UNCHECKED };
}

/** 计划稿草案卡 status：勾选态直映（真相在 plan 文件本身）。 */
export function derivePlanTaskStatus({ checked }) {
  return checked
    ? { status: "completed", statusRule: PLAN_TASK_RULE_CHECKED }
    : { status: "pending", statusRule: PLAN_TASK_RULE_UNCHECKED };
}

// ---------------------------------------------------------------- 段位派生（七段位，纯函数）

/**
 * 段位 = f(status, activeRun, attention)：
 *   阻塞 > 已取消 > 已完成 > 待设计（安排类缺口）> 审核中（判断角色 activeRun）> 执行中 > 待办。
 * 返回 {stage, stageRule}；stageRule 写明依据（看板上的每个段位都可回答"这从哪推出来的"）。
 */
export function deriveStage(status, activeRun, attention) {
  const codes = Array.isArray(attention) ? attention : [];
  if (status === "blocked") return { stage: STAGE.BLOCKED, stageRule: "status=blocked（§4.3）" };
  if (status === "cancelled") {
    return { stage: STAGE.CANCELLED, stageRule: "status=cancelled（> cancelled: 取消留痕；条目保留、号不复用）" };
  }
  if (status === "completed") return { stage: STAGE.DONE, stageRule: "status=completed（勾选=已合并 6.3 / progress 阶段完成）" };
  const designCode = DESIGN_ATTENTION_CODES.find((c) => codes.includes(c));
  if (designCode) return { stage: STAGE.DESIGN, stageRule: `attention 含 ${designCode}（§8.4 缺口码：尚未进入可执行形态）` };
  const role = activeRun && typeof activeRun === "object" ? activeRun.role : null;
  if (JUDGING_ROLES.includes(role)) {
    return { stage: STAGE.REVIEW, stageRule: `activeRun.role=${role}（判断角色，§4.5；待合并角标由 unmerged-worktree 承载）` };
  }
  if (WORKING_ROLES.includes(role)) return { stage: STAGE.DOING, stageRule: `activeRun.role=${role}（干活角色，§4.5）` };
  if (status === "active") return { stage: STAGE.DOING, stageRule: "status=active（阶段推进/部分勾选，无 run 级 activeRun）" };
  const note = role ? `activeRun.role=${role} 不属于干活/判断角色表（不参与段位）· ` : "";
  return { stage: STAGE.TODO, stageRule: `${note}status=${status} 且无 activeRun` };
}

// ---------------------------------------------------------------- runs.json 归一（§4.5）

function normalizePr(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!Number.isInteger(raw.number)) return null;
  if (typeof raw.url !== "string" || !/^https?:\/\/.+/.test(raw.url)) return null;
  return { number: raw.number, url: raw.url };
}

/**
 * 工作树路径接受集（#71，按"声明自由、互证严格"；§6.1 条件 5）：
 *   ① 冻结短形态 `.zcode/worktrees/task-<no>`；
 *   ② 嵌套项目根相对路径 `<子目录>/.zcode/worktrees/task-<no>`（板根与一层子项目根并存时的常态，
 *      如声明侧写 `ZPaPa/.zcode/worktrees/task-64`）；一层子目录名不得以 `.` 开头（隐藏目录/穿越
 *      不在 fs 互证扫描面内，声明侧同口径拒收）。
 * 末段固定 `task-<no>`（号解析取末段；前导零/非 task-N 拒收）；其余形态（绝对路径、多级嵌套）拒收 + diagnostics。
 */
export const WORKTREE_PATH_RE = /^(?:([^/.][^/]*)\/)?\.zcode\/worktrees\/task-([1-9][0-9]*)$/;

/**
 * 工作树声明路径解析（#71）：接受形态 → { path, no, subdir }；不在接受集 → null（拒收，不猜）。
 * 以 WORKTREE_PATH_RE 为唯一接受判据（捕获组 1 = 一层子项目根名，组 2 = 末段稳定号；无 g 旗标，exec 无状态）。
 */
export function parseWorktreePath(raw) {
  const m = WORKTREE_PATH_RE.exec(typeof raw === "string" ? raw : "");
  return m ? { path: raw, no: Number(m[2]), subdir: m[1] ?? null } : null;
}

/**
 * runs.json → 按卡号分组的记录（纯数据归一）：
 *   - 机械字段不合规（缺 at / role 词表外 / result 词表外）→ 跳过该条 + diagnostics（不猜）；
 *   - cards 非整数子句柄（层级标签形态）→ 该值不解析 + diagnostics，不猜卡号（run-event.md §5）；
 *   - 有序性：按 at 升序，同刻按追加序。
 * 返回 { order, byNo: Map<no, record[]>, diagnostics: [{path, message}] }。
 */
export function normalizeRuns(rawRuns, { runsPath }) {
  const order = [];
  const byNo = new Map();
  const diagnostics = [];
  const list = Array.isArray(rawRuns) ? rawRuns : [];
  list.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") {
      diagnostics.push({ path: runsPath, message: `runs[${index}] 不是对象：跳过该条（不猜执行事实）。` });
      return;
    }
    const id = typeof raw.runId === "string" && raw.runId !== "" ? raw.runId : `runs[${index}]`;
    if (!ISO_RE.test(String(raw.at ?? ""))) {
      diagnostics.push({ path: runsPath, message: `${id} 缺 at 或 at 非带时区 ISO 8601：无法排序，跳过该条（不猜时钟）。` });
      return;
    }
    if (!RUN_ROLES.includes(raw.role)) {
      diagnostics.push({ path: runsPath, message: `${id} 的 role=${JSON.stringify(raw.role ?? null)} 不在角色词表：跳过该条。` });
      return;
    }
    if (!RUN_RESULTS.includes(raw.result)) {
      diagnostics.push({ path: runsPath, message: `${id} 的 result=${JSON.stringify(raw.result ?? null)} 不在结果词表：跳过该条。` });
      return;
    }
    const cards = [];
    for (const c of Array.isArray(raw.cards) ? raw.cards : []) {
      if (Number.isInteger(c) && c > 0) {
        cards.push(c);
        continue;
      }
      diagnostics.push({
        path: runsPath,
        message: `${id} 的 cards 含非稳定号值 ${JSON.stringify(c)}（稳定号=正整数；标签不是句柄）：该值不解析，不猜卡号。`,
      });
    }
    let stoppedAt = null;
    const breakpoint = raw.breakpoint && typeof raw.breakpoint === "object" ? raw.breakpoint : null;
    if (breakpoint && breakpoint.stoppedAt != null) {
      if (Number.isInteger(breakpoint.stoppedAt) && breakpoint.stoppedAt > 0) stoppedAt = breakpoint.stoppedAt;
      else {
        diagnostics.push({
          path: runsPath,
          message: `${id} 的 breakpoint.stoppedAt=${JSON.stringify(breakpoint.stoppedAt)} 非稳定号：该值不解析，不猜卡号。`,
        });
      }
    }
    const rawWorktree = typeof raw.worktree === "string" && raw.worktree !== "" ? raw.worktree : null;
    const worktreeParsed = rawWorktree != null ? parseWorktreePath(rawWorktree) : null;
    if (rawWorktree != null && worktreeParsed == null) {
      diagnostics.push({
        path: runsPath,
        message: `${id} 的 worktree=${JSON.stringify(rawWorktree)} 不符合冻结命名 .zcode/worktrees/task-<no> 或嵌套项目根相对路径 <子目录>/.zcode/worktrees/task-<no>（§6.1 条件 5/#71）：不落该字段（不猜路径）。`,
      });
    }
    const pr = normalizePr(raw.pr);
    if (raw.pr != null && pr == null) {
      diagnostics.push({
        path: runsPath,
        message: `${id} 的 pr 形态非法（需 {number: 整数, url: http(s) 链接}）：不落 pr 字段（不猜远程号）。`,
      });
    }
    const record = {
      index,
      at: raw.at,
      t: Date.parse(raw.at),
      runId: id,
      role: raw.role,
      result: raw.result,
      cards,
      worktree: worktreeParsed != null ? rawWorktree : null,
      stoppedAt,
      next: breakpoint && typeof breakpoint.next === "string" && breakpoint.next !== "" ? breakpoint.next : null,
      pr,
    };
    order.push(record);
    for (const no of cards) {
      if (!byNo.has(no)) byNo.set(no, []);
      byNo.get(no).push(record);
    }
  });
  return { order, byNo, diagnostics };
}

function sortedRecords(records) {
  return [...(records ?? [])].sort((a, b) => (a.t === b.t ? a.index - b.index : a.t - b.t));
}

const isMergedDone = (r) => r.role === "integrator" && r.result === "done";

/**
 * 单卡的 run 派生（§4.5）：
 *   lastRun = 最新一条的摘要；activeRun = 最新 result ∈ {partial, interrupted} → {role, at}；
 *   worktree = 最新带 worktree 的记录，且其后无该卡 integrator done，**且该目录经 fs 互证真实存在**
 *     → 路径，否则 null（#42 判据收紧：字段命中 + 目录真实存在才触发 unmerged-worktree 缺口）；
 *   attention = interrupted-resume / unmerged-worktree。
 * #42（幽灵工作树）：字段命中而目录不存在 → 不触发缺口、worktree 降为 null，改由调用方落提示级
 *   diagnostics（本函数把它放在 demotedWorktree，供调用方带上卡号点名——derive 层不带路径与卡号）。
 * @param {object[]} records 该卡的 runs 记录（normalizeRuns 归一后）
 * @param {object} [opts]
 * @param {string[]} [opts.existingWorktrees] 真实存在的工作树相对路径（fs 事实，由调用方扫描提供；
 *   缺省 [] ≡ 无互证 → 不触发缺口 + demotedWorktree 点名）。互证面 = 板根与一层子项目根下的
 *   `.zcode/worktrees/`（如 `ZPaPa/.zcode/worktrees/task-32`）；声明侧两形态（#71 短/嵌套项目根相对路径）
 *   经 exact 或后缀匹配命中。
 * 返回 {lastRun, activeRun, worktree, demotedWorktree, pr, latestAt, attention[]}。
 */
export function deriveCardRuns(records, { existingWorktrees = [] } = {}) {
  const sorted = sortedRecords(records);
  if (sorted.length === 0) {
    return { lastRun: null, activeRun: null, worktree: null, demotedWorktree: null, pr: null, latestAt: null, attention: [] };
  }
  const last = sorted[sorted.length - 1];
  const lastRun = { at: last.at, role: last.role, result: last.result, stoppedAt: last.stoppedAt, next: last.next };
  const interrupted = last.result === "partial" || last.result === "interrupted";
  const activeRun = interrupted ? { role: last.role, at: last.at } : null;

  let mergedIdx = -1;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    if (isMergedDone(sorted[i])) {
      mergedIdx = i;
      break;
    }
  }
  let worktreeIdx = -1;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    if (sorted[i].worktree != null) {
      worktreeIdx = i;
      break;
    }
  }
  const declared = worktreeIdx >= 0 && worktreeIdx > mergedIdx ? sorted[worktreeIdx].worktree : null;
  const corroborated = declared != null && worktreeCorroborated(declared, existingWorktrees);
  const unmerged = corroborated;
  const demotedWorktree = declared != null && !corroborated ? declared : null;
  let prIdx = -1;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    if (sorted[i].pr != null) {
      prIdx = i;
      break;
    }
  }

  const attention = [];
  if (interrupted) attention.push(ATTENTION.INTERRUPTED_RESUME);
  if (unmerged) attention.push(ATTENTION.UNMERGED_WORKTREE);
  return {
    lastRun,
    activeRun,
    worktree: unmerged ? declared : null,
    demotedWorktree,
    pr: prIdx >= 0 ? sorted[prIdx].pr : null,
    latestAt: last.at,
    attention,
  };
}

/**
 * 声明的工作树路径是否被真实目录互证（#42：attention 侧 fs 互证判据；#71 两形态对齐后口径不变）。
 * 命中口径：精确相等，或真实路径以 `/<声明路径>` 结尾——后者覆盖"声明侧写短形态、现场在子项目根"
 * （如声明 `.zcode/worktrees/task-32`，真实目录 `ZPaPa/.zcode/worktrees/task-32`）；声明侧写嵌套形态
 * 而现场同路径时走精确相等。#71 起两形态都进声明接受集，互证两侧方向一致（不再"一侧接受、一侧拒收"）。
 * 不猜状态：目录不在即不互证。
 */
export function worktreeCorroborated(declared, existingWorktrees) {
  if (typeof declared !== "string" || declared === "") return false;
  const list = Array.isArray(existingWorktrees) ? existingWorktrees : [];
  return list.some((p) => typeof p === "string" && (p === declared || p.endsWith(`/${declared}`)));
}

/**
 * 当前执行者（#46 A3）：`assignees[]` × `activeRun.role` 的交叉推导——只有该角色确实在
 * 本节点的责任管线内才成立（管线可被 `> agents:` 覆盖；执行角色在表外时不硬指，返回 null）。
 * 纯函数：不改写入参、无隐藏状态；无 activeRun / 管线缺失 → null。
 */
export function deriveCurrentAssignee({ assignees, activeRun }) {
  const role = activeRun && typeof activeRun === "object" ? activeRun.role : null;
  if (typeof role !== "string" || role === "") return null;
  const pipeline = Array.isArray(assignees) ? assignees : [];
  return pipeline.includes(role) ? role : null;
}

/**
 * 下一接手人（#53，契约 v2.3）：`assignees[]` 序中第一个**无 done run 证据**的角色——
 * 某角色已有 result=done 的记录即视为该环节已交付，接手位顺延给下一环节；
 * `integrator` done = 已合并，故"三绿卡"（implementer/test-verifier/code-reviewer done）→ integrator。
 * 全部角色均有 done 证据（管线走完/已合并）→ null；assignees 为空 → null；
 * partial/failed/interrupted 不算 done 证据（角色仍在接手位）。
 * 纯函数：不改写入参、无隐藏状态；records 为该卡归一后的 runs 记录。
 */
export function deriveNextAssignee({ assignees, records }) {
  const pipeline = Array.isArray(assignees) ? assignees : [];
  if (pipeline.length === 0) return null;
  const doneRoles = new Set();
  for (const r of Array.isArray(records) ? records : []) {
    if (r && r.result === "done" && typeof r.role === "string" && r.role !== "") doneRoles.add(r.role);
  }
  for (const role of pipeline) {
    if (!doneRoles.has(role)) return role;
  }
  return null;
}

// ---------------------------------------------------------------- 缺口码与汇总（§8.4）

/**
 * arranged-not-expanded 判据（§8.4；#53 契约 v2.3 收窄）：特性节点（plan 或 spec）无
 * tasks.md/progress.json，且——
 *   - plan：派生任务卡为**零**（计划稿任务卡按契约恒为 draft：真相在 plan 文件本身，
 *     "全部为 draft"没有区分度，会把有卡稿永久误挂"已安排，尚未拆解任务"）；
 *   - spec：派生任务卡为零或全部为 draft（spec 卡 draft=false，该判据仍有区分度）。
 * "识别不出就归入缺口"（宁误报不漏报）不变。
 */
export function deriveArrangedNotExpanded({ kind, hasTaskDoc = false, hasProgressDoc = false, tasks = [] }) {
  if (kind !== "plan" && kind !== "spec") return false;
  if (hasTaskDoc || hasProgressDoc) return false;
  if (kind === "plan") return tasks.length === 0;
  return tasks.every((t) => t.draft === true);
}

/** 全板 attentionSummary：与各节点 attention 逐码相等（§3.3 不变量）。 */
export function summarizeAttention(nodes) {
  const out = Object.fromEntries(ATTENTION_CODES.map((c) => [c, 0]));
  const walk = (list) => {
    for (const node of list ?? []) {
      for (const code of node.attention ?? []) if (code in out) out[code] += 1;
      walk(node.tasks);
    }
  };
  walk(nodes);
  return {
    interviewedNotArranged: out[ATTENTION.INTERVIEWED_NOT_ARRANGED],
    arrangedNotExpanded: out[ATTENTION.ARRANGED_NOT_EXPANDED],
    interruptedResume: out[ATTENTION.INTERRUPTED_RESUME],
    unmergedWorktree: out[ATTENTION.UNMERGED_WORKTREE],
  };
}

/** 全板段位计数（board.md 摘要用）。 */
export function summarizeStages(nodes) {
  const out = Object.fromEntries(STAGE_VALUES.map((s) => [s, 0]));
  const walk = (list) => {
    for (const node of list ?? []) {
      if (node.stage in out) out[node.stage] += 1;
      walk(node.tasks);
    }
  };
  walk(nodes);
  return out;
}

// ---------------------------------------------------------------- 诊断辅助（§4.2 / §4.5 / §12）

/** plan-overgrown（§4.2）：单稿派生任务卡数超过阈值 → 提示拆票或升级 spec；恰等于阈值不提示。 */
export function diagnosePlanOvergrown({ path, cardCount, threshold }) {
  if (!Number.isInteger(cardCount) || !Number.isInteger(threshold) || cardCount <= threshold) return null;
  return {
    path,
    message: `计划稿派生任务卡 ${cardCount} 张，超过 plan-overgrown 阈值 ${threshold}（§4.2）：建议拆票或升级为 spec。`,
  };
}

/** progress.execution 与 tasks.md 勾选数不一致（§4.2）：记入 diagnostics，不静默（以真相源为准）。 */
export function diagnoseProgressMismatch({ progressPath, execution, taskCount, checkedCount }) {
  const out = [];
  if (!execution || !Number.isInteger(execution.totalTasks) || !Number.isInteger(execution.completedTasks)) return out;
  if (execution.totalTasks !== taskCount) {
    out.push({
      path: progressPath,
      message: `progress.execution.totalTasks=${execution.totalTasks} 与 tasks.md 条目数 ${taskCount} 不一致（§4.2）：记入 diagnostics，不静默。`,
    });
  }
  if (execution.completedTasks !== checkedCount) {
    out.push({
      path: progressPath,
      message: `progress.execution.completedTasks=${execution.completedTasks} 与 tasks.md 勾选数 ${checkedCount} 不一致（§4.2）：记入 diagnostics，不静默。`,
    });
  }
  return out;
}

const taskDirNo = (name) => {
  const m = /^task-([1-9][0-9]*)$/.exec(String(name ?? ""));
  return m ? Number(m[1]) : null;
};

/**
 * worktree 目录与 runs 互证的辅助诊断（§4.5 / §6.1 / §12）——纯数据判定，调用方提供目录事实，
 * 编译器不执行任何 git 命令、不猜状态：
 *   - 目录在（板根 `.zcode/worktrees/`，调用方给名）而板上无对应卡号 / 该卡无 runs 未合并证据
 *     → 点名核查（残留或未落账）；
 *   - 嵌套 .zcode/worktrees/ → 违反"只开一层"（§6.1 条件 3）。
 * 反向（"runs 有据而目录不在"）自 #42 起由派生层承载：`deriveCardRuns` 只在目录经 fs 互证存在时
 * 保留 `worktree`（否则降为 demotedWorktree + 调用方提示级诊断）——故此处按构造不会遇到
 * "worktree 非空而目录不在"的卡（互证面含嵌套项目根，见 compiler 的 #42 扫描块）。
 */
export function diagnoseWorktrees({ worktreesRel, cards, existingDirs, nestedDirs }) {
  const out = [];
  const dirNames = new Set(existingDirs ?? []);
  const byNo = new Map();
  for (const c of cards ?? []) {
    if (!Number.isInteger(c.no)) continue;
    byNo.set(c.no, c);
  }
  for (const name of dirNames) {
    const no = taskDirNo(name);
    if (no == null) continue;
    const card = byNo.get(no);
    if (!card) {
      out.push({
        path: worktreesRel,
        message: `发现工作树目录 ${worktreesRel}/${name}，但板上无卡号 ${no} 与之对应：不猜状态，请核查后走 git worktree 正规清理（§6.1/§12）。`,
      });
      continue;
    }
    if (!card.worktree) {
      out.push({
        path: worktreesRel,
        message: `发现工作树目录 ${worktreesRel}/${name}，但 runs 无该卡未合并证据：不猜状态（可能已合并未清理或未落账），请核查（§4.5/§12）。`,
      });
    }
  }
  for (const name of nestedDirs ?? []) {
    out.push({
      path: worktreesRel,
      message: `发现嵌套工作树目录 ${worktreesRel}/${name}/.zcode/worktrees：工作树只开一层（§6.1 条件 3），请走 git worktree 正规清理。`,
    });
  }
  return out;
}
