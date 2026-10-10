#!/usr/bin/env node
/**
 * zcode-board / fact-invariants（#56 交付物：--check 的事实互证不变量）
 *
 * 职责：把"板自己回答这数对不对"做成常驻机械防线——不依赖人眼核对。四条不变量（失败级，
 * 违例逐条点名路径 + 节点编号 + 两值对照，不静默）：
 *   (a) 特性子卡全部 completed → 特性 stage=已完成（契约 v2.3：计划稿特性段位随子卡汇总）；
 *   (b) 已有任务卡（tasks.length>0）的特性不得挂 arranged-not-expanded（判据为零卡，契约 v2.3；
 *       roadmap 占位稿同理——roadmap 压制段位，但不该挂"未拆解"）；
 *   (c) board.md 渲染的编号形态与 board.json 的 planCode/label 派生一致（D1 类守卫：嵌套任务行
 *       全覆盖，含递归深度 ≥2——渲染器漏传计划码时由此咬住）；TQ-1 扩面（T5356r）：## 待处理 /
 *       ## 待合并 节（walkBoardNodes 渲染位）的编号链同入对照面；A3-3/#86 扩面：epic 章头
 *       （`# <码> · <标题>` + 终态标注）/期次组头（`## <码><期次> · 期次 <n>`，AD-3 合成编号渲染位）
 *       与 epic 章内成员稿节同入对照面——对照序列 = 渲染序（顶层稿块 → 各 epic 章带）↔ board.json
 *       派生序（独立复写 renderBoardMd 装配序，不导入编译器）；
 *   (d) 段位计数（board.json 内如携带 stageSummary）与全板节点 stage 逐项复算相等。
 *
 * 第五不变量（e，B1-1/#97；对账点名级，非失败级——独立导出 checkCompletedMergedEvidence）：
 *   (e) completed 的任务卡须有该卡 integrator done 的 run 证据（runs.json 为准）；缺证据逐条点名
 *       （路径 + 稳定号），不使 --check 非零退出；速修/管理卡按稳定号登记豁免后不再点名。
 *
 * 派生四段不变量（i1–i4，C2-2/#134；失败级——独立导出 checkDerivedIndexInvariants，由
 * checkFactInvariants 并入失败级出口）：
 *   (i1) frontier 复算一致：可执行前沿 = 板面卡级节点中「段位=待办 且无未解除阻塞项」者，按板序
 *        （features 序 × 任务树序）rank=1..n；四段恒写出后由本断言逐行对照——受阻卡混入/漏行/
 *        顺序错位/字段错位（title/stage/nextAssignee/resolvedDeps）逐条点名；
 *   (i2) recent 排序与截断：条目 at 须对称降序（新→旧），条数 ≤ 上限（N=10 成文），且每行须落在
 *        板上活号卡（离板引用不进活动面）且 title 与该卡同值；
 *   (i3) blocked 归因完整：非终态卡的每个未解除阻塞项恰一行（一卡多项出多行；external 恒未解除，
 *        dependency 仅当目标卡段位 ∈ 终态才解除；缺号/离板保守计入），逐行对照（no/title/stage/
 *        blockerKind/targetId/summary）——漏行、多行、错归因逐条点名；
 *   (i4) 段间对偶：待办卡 ∈ frontier ⟺ 不在 blocked（x-decisions 四段条）——两面同时命中
 *        （既称可执行又称受阻）或两面皆无（既不可执行又无归因：派生漏归因）均必咬。
 *   判定域与 derive.deriveBoardIndex 同口径（卡级节点＝有稳定号的任务卡，含嵌套；特性/容器不进段）；
 *   携带即判（缺段键不判——缺键由板/源互检与 schema 面承载，旧板/手写夹具零噪声）。
 *
 * 归属引用可达断言（h，A2-2/#82；失败级——独立导出 checkEpicRefs，不并入 checkFactInvariants）：
 *   (h) `features[].epic` 取登记 id 形态（`epic:<4位码>`）时，`epics[]` 必须有该 code 的登记行；无登记行
 *       = 悬空/孤儿引用（板面 faithful 透出但引用不可达、零 rollup）→ 逐条点名（路径 + 两值）。裸码等
 *       形态违规归 lib/schema-check.mjs 结构面；整数稳定号与无 epic 缺省不判（零噪声，AD-8）。
 *
 * 死号对账判据与 registry 幽灵/悬空可见性断言（B4-1/#105；E4-05 / A-facts U1 / E1 V28·V29 / T20 G1）：
 *   - `classifyDeadNumber(no, {liveNos, registryNos})`：号的可达面三分类单点纯判定——`live`（板上可达）/
 *     `registry-not-on-board`（幽灵/悬空条目：registry 有条目而板上无）/ `unknown`（完全未知号）；
 *     compile-board 的条目对账与引用两文案分流（勘误 9d）共用此判据（防二份口径漂移）；
 *   - `checkRegistryGhosts({board, registryEntries, archivedNos})`（失败级）：板面 + registry **独立复算**
 *     「两值可见性」——凡不在板上活条目、又非已验证归档件的 registry 条目，板面 diagnostics 必须点名
 *     （registry 源路径 + 条目号 + 指向路径）；缺则两视图分叉必咬（E4-05 缺陷本体的机械防线）。
 *     编译侧点名本身为提示级（降级可见性）；本断言只保证点名**不被吞掉**。
 *
 * 判定边界（与 lib/schema-check.mjs 同分层）：本模块只做纯数据判定，不读盘、不比对源——
 *   board 对象与 board.md 文本由调用方传入（磁盘板与重编译基线分别配对调用）；无第三方依赖，
 *   也不需要任何 node 内置模块。词表与渲染位语义在此**独立复写**（不导入 lib/derive.mjs 与编译器），
 *   否则复算与被检对象同源，退化为重言式。
 *
 * 返回：违例文案数组（空数组 = 通过）。文案形态：`不变量 <x>（...）：<路径>（<编号>）...`
 *   路径 = `features[i].tasks[j]...`（board.json 的 JSON 指针起点），编号 = 稳定号/#N + 计划码。
 */

// ---------------------------------------------------------------- 词表与常量（与契约同步的独立副本）

/** 七段位词表（契约 v2.1 起；与 lib/derive.mjs 的 STAGE_VALUES 同步，本模块零依赖不导入）。 */
const STAGE_VALUES = Object.freeze(["待设计", "待办", "执行中", "审核中", "阻塞", "已完成", "已取消"]);
const DONE_STAGE = "已完成";
const ARRANGED_NOT_EXPANDED = "arranged-not-expanded";
/**
 * 合并证据词（第五不变量 (e) 的独立复写；B1-1/#97）：role=integrator 且 result=done 的记录
 * 视为该卡"已合并"证据（与 lib/derive.mjs isMergedDone 及契约 6.3「勾选=已合并」同口径）。
 * 由 S-1 守卫与 lib/runs.mjs 词表对照，防改名静默失效。
 */
const MERGED_ROLE = "integrator";
const MERGED_RESULT = "done";
/**
 * 四缺口码（§8.4；渲染序与 compile-board 的 ATTENTION_CODES 同序——待处理节按此序分组渲染；
 * 由 S-1 守卫逐项对照 derive.ATTENTION_CODES）。
 */
const ATTENTION_CODES = Object.freeze([
  "interviewed-not-arranged",
  "arranged-not-expanded",
  "interrupted-resume",
  "unmerged-worktree",
]);
/**
 * 派生四段（C2-1/#133）判据的独立复写常量（C2-2/#134）——本模块零依赖不导入 derive.mjs，
 * 由 S-1 守卫（vocabularySnapshot）逐项与 lib/derive.mjs 对照，任一侧改名/改值即红，
 * 防止派生不变量判据随词表漂移静默失效：
 *   - TODO_STAGE：可执行前沿的段位判据（frontier 入选面）；
 *   - TERMINAL_STAGES：终态段位（依赖解除判据 / blocked 选取域边界）；
 *   - RECENT_LIMIT：recent[] 条数上限（N=10 成文）；
 *   - BLOCKER_KINDS：阻塞归因词表（schema blocked[].blockerKind 枚举同口径）。
 */
const TODO_STAGE = "待办";
const TERMINAL_STAGES = Object.freeze(["已完成", "已取消"]);
const RECENT_LIMIT = 10;
const BLOCKER_EXTERNAL = "external";
const BLOCKER_DEPENDENCY = "dependency";
const BLOCKER_KINDS = Object.freeze([BLOCKER_EXTERNAL, BLOCKER_DEPENDENCY]);
/** 带时区 ISO 8601 形态（与 lib/derive.mjs 的 ISO_RE 同口径；独立常量，S-1 守卫对照 source）。 */
const ISO_SOURCE = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([+-][0-9]{2}:[0-9]{2}|Z)$";
const ISO_RE = new RegExp(ISO_SOURCE);
/** (i) 族报告上限（超出即汇总一行，避免整页刷屏——同 (c) 口径）。 */
const MAX_SEGMENT_VIOLATIONS = 10;
/**
 * board.md 编号 token 形态（渲染位语义的独立复写）：
 *   `未领号`（no 缺省）/ `#N`（过渡态：有号无 label）/ `ID-<层级>` / `<计划码>` / `<计划码>-<层级>`。
 * 计划码 = 4 位 [A-Z][A-Z0-9]{3}（与 compile-board.PLAN_CODE_RE 同口径，由 S-1 守卫逐项对照）；
 * 层级路径 = `1` / `1.2` / `1.2.1`。
 */
const PLAN_CODE_SOURCE = "[A-Z][A-Z0-9]{3}";
const PLAN_CODE_RE = new RegExp(`^${PLAN_CODE_SOURCE}$`);
const ID_TOKEN_RE = new RegExp(`^(?:未领号|#[1-9][0-9]*|ID-[1-9][0-9]*(?:\\.[1-9][0-9]*)*|${PLAN_CODE_SOURCE}(?:-[1-9][0-9]*(?:\\.[1-9][0-9]*)*)?)$`);
const FEATURE_HEADING_RE = /^### (.+)$/;
const MD_TASK_LINE_RE = /^\s*- ([^ ·]+) · /;
/**
 * epic 层渲染位形态（A3-3/#86 扩面；独立复写 compile-board 的装配序与 derive 的词表——S-1 守卫对照）：
 *   - 登记 id 前缀 `epic:`（§10.3：kind 限定句柄，码不进引用位）；
 *   - 登记行状态词表（§10.2/§10.5）与章头终态标注（`（已取消）`/`（已归档）`）；
 *   - 期次组头整行形态 `## <码><期次> · 期次 <n>`（AD-3 双字段合成：合成编号只存显示层）。
 */
const EPIC_ID_PREFIX = "epic:";
const EPIC_STATUSES = Object.freeze(["active", "cancelled", "archived"]);
const EPIC_TERMINAL_MARKS = Object.freeze({ cancelled: "（已取消）", archived: "（已归档）" });
const EPIC_HEADING_RE = /^# (.+)$/;
const PHASE_HEADING_RE = new RegExp(`^${PLAN_CODE_SOURCE}[1-9][0-9]* · 期次 [1-9][0-9]*$`);
/** 编号对照面终点 = 末章「## 诊断」标题行（epic 章带落于「## 特性」与「## 诊断」之间）。 */
const BOARD_TAIL_RE = /^## 诊断/;
/** 渲染位类型标签（失败项点名用）。 */
const SLOT_KIND_LABELS = Object.freeze({ epic: "epic 章", phase: "期次组", feature: "稿节", task: "任务行" });
/** 三个编号对照节（T5356r TQ-1：待处理/待合并与特性节同入对照面）。 */
const FEATURE_SECTION_RE = /^## 特性\s*$/;
const PENDING_SECTION_RE = /^## 待处理\s*$/;
const UNMERGED_SECTION_RE = /^## 待合并/;
/** (c) 报告上限（超出即汇总一行，避免整页刷屏）。 */
const MAX_NUMBERING_VIOLATIONS = 10;
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * S-1 词表漂移守卫（T5356r）：本模块为防重言式独立复写了词表与渲染位形态常量——以只读快照导出，
 * 供测试逐项与 lib/derive.mjs（STAGE/ATTENTION）及 compile-board.mjs（PLAN_CODE_RE）对照。
 * 任一侧改名/改值 → 守卫断言红，防止不变量 (b) 之类的判据随词表漂移静默失效。
 */
export function vocabularySnapshot() {
  return {
    stageValues: [...STAGE_VALUES],
    doneStage: DONE_STAGE,
    arrangedNotExpanded: ARRANGED_NOT_EXPANDED,
    attentionCodes: [...ATTENTION_CODES],
    planCodeSource: PLAN_CODE_SOURCE,
    idTokenSource: ID_TOKEN_RE.source,
    mergedRole: MERGED_ROLE,
    mergedResult: MERGED_RESULT,
    // A3-3/#86：epic 层渲染位常量（renderBoardMd 装配序与章头/期次组形态；derive/compile-board 侧对照）
    epicIdPrefix: EPIC_ID_PREFIX,
    epicCodeSource: PLAN_CODE_SOURCE, // epic 码与计划码同冻结形态（§10.2；S-1 对照 derive.EPIC_CODE_RE）
    epicStatuses: [...EPIC_STATUSES],
    epicTerminalMarks: { ...EPIC_TERMINAL_MARKS },
    phaseHeadingSource: PHASE_HEADING_RE.source,
    // C2-2/#134：派生四段不变量（i1–i4）判据常量（derive / schema 侧对照）
    todoStage: TODO_STAGE,
    terminalStages: [...TERMINAL_STAGES],
    recentLimit: RECENT_LIMIT,
    blockerKinds: [...BLOCKER_KINDS],
    isoSource: ISO_SOURCE,
  };
}

// ---------------------------------------------------------------- 死号对账判据（B4-1/#105）

/**
 * 死号（不可达号）分类判据——**单点纯判定**（B4-1/#105；E4-05 / E1 V28·V29 / 勘误 9d）：
 *   号的可达面 = 本次编译的板（活条目集合）× registry（发号登记），「registry 有条目而板上无」与
 *   「完全未知号」是两种独立情形（勘误 9d 两文案先例），判据必须单点复写：
 *     - `"live"`：号在本次编译板上（可达；引用位照常成立、不点名）；
 *     - `"registry-not-on-board"`：号在 registry 有条目、板上无活条目（幽灵/悬空条目形态——
 *       E1 V29 #41 手误路径发号、E1 V28 #48 悬空；引用与对账走「registry 有条目而板上无」独立文案）；
 *     - `"unknown"`：号既不在板上、也不在 registry（完全未知号；引用走「核对句柄写法」独立文案）。
 * 非正整数形态（缺号/字符串/标签）不解析 → `"unknown"`（形态违规归结构面与「损坏源」失败项点名，
 * 本判据不叠加噪音）。liveNos/registryNos 缺省/非 Set → 视为空集合（fail-open 到 unknown，
 * 不猜可达——调用方传谁判谁）。
 * 纯函数：不读盘、不改入参、无隐藏状态。
 * @param {unknown} no 待判号（正整数稳定号）
 * @param {{liveNos?: Set<number>, registryNos?: Set<number>}} [facts] 板面活号集合与 registry 条目号集合
 * @returns {"live"|"registry-not-on-board"|"unknown"}
 */
export function classifyDeadNumber(no, { liveNos = null, registryNos = null } = {}) {
  if (!Number.isInteger(no) || no < 1) return "unknown";
  if (liveNos instanceof Set && liveNos.has(no)) return "live";
  if (registryNos instanceof Set && registryNos.has(no)) return "registry-not-on-board";
  return "unknown";
}

/**
 * registry 幽灵/悬空条目**两值可见性**断言（B4-1/#105；E4-05 / A-facts U1 / T20 G1）——**失败级**
 * （独立导出；由 compile-board `checkProject` 在磁盘板与重编译基线上各判一遍）。
 *
 * 存在原因（缺陷本体）：`--check` 的 registry 指向直查与板面 diagnostics 曾是两个视图——直查结论只在
 * `--check` 输出、board.json diagnostics 无（E4-05 实锤 #41：冷读者打开板"板面全绿"漏掉幽灵/悬空号）。
 * 本断言把「两视图一致」做成常驻机械防线：对「板面 + registry 条目」**独立复算**——凡号不在板上活条目、
 * 又非已验证归档件的 registry 条目，板面 diagnostics 必须有一条点名（含 registry 源路径、条目号、
 * 条目指向路径三项；即验收口径「含路径与两值」），缺则必咬。
 *
 * 判定域（成文，勿扩）：
 *   - 判定对象 = registry 条目（号为正整数）——板上活号不判（可达，零噪声）；已验证归档件由调用方以
 *     `archivedNos` 传入并跳过（勘误 10 直查通过 = 合法退役面，不误报）；形态非法条目（no 非正整数）
 *     不判（归「registry 不一致」失败面）；
 *   - 点名匹配 = diagnostics 行 path 等于板 `sources[].kind === "registry"` 的路径，且 message 含条目号
 *     （数字边界匹配，不绑定实现文案句式）与条目指向路径（file/specRoot，指向缺省则只认号）；
 *   - board 非对象/registry 非数组 → 零违例（失败级另一路点名，不叠加）。
 * 判级 = 失败级：视图分叉属结构矛盾类（重编译/修复编译器即可恢复），与不变量 (a)–(d)/(h) 同层；
 *   编译侧点名本身为提示级（降级可见性）——两级分工：编译侧**点名**、本断言保证点名**不被吞掉**。
 * 纯函数：不读盘、不改入参、无隐藏状态。
 * @param {object} input
 * @param {object} input.board board.json 形态对象（含 sources/diagnostics/features）
 * @param {unknown} input.registryEntries registry.entries 原始数组
 * @param {number[]} [input.archivedNos] 经直查验证的归档件号（调用方按 disk 判定；缺省 = 无）
 * @returns {string[]} 失败项文案（空数组 = 通过）
 */
export function checkRegistryGhosts({ board, registryEntries, archivedNos = [] } = {}) {
  const out = [];
  if (!isPlainObject(board)) return out;
  const rows = Array.isArray(board.diagnostics) ? board.diagnostics : [];
  const registryRel =
    (Array.isArray(board.sources) ? board.sources : []).find((s) => isPlainObject(s) && s.kind === "registry")?.path ?? null;
  const live = new Set();
  const walk = (tasks) => {
    for (const t of tasks ?? []) {
      if (isPlainObject(t) && Number.isInteger(t.no) && t.no >= 1) live.add(t.no);
      walk(t?.tasks);
    }
  };
  for (const f of board.features ?? []) {
    if (!isPlainObject(f)) continue;
    if (Number.isInteger(f.no) && f.no >= 1) live.add(f.no);
    walk(f.tasks);
  }
  const archived = new Set((Array.isArray(archivedNos) ? archivedNos : []).filter((n) => Number.isInteger(n) && n >= 1));
  /** 数字边界匹配（防 105 匹配到 1050/105a；不绑定实现文案句式——本断言只判"可见"，不判措辞）。 */
  const mentionsNumber = (message, no) => new RegExp(`(?:^|[^0-9])${no}(?:[^0-9]|$)`).test(message);
  const seen = new Set();
  for (const entry of Array.isArray(registryEntries) ? registryEntries : []) {
    const no = entry?.no;
    if (!Number.isInteger(no) || no < 1 || seen.has(no)) continue;
    seen.add(no);
    if (live.has(no) || archived.has(no)) continue;
    const ref = entry?.kind === "spec" ? entry?.specRoot : entry?.file;
    const refOk = typeof ref === "string" && ref !== "";
    const named = rows.some(
      (d) =>
        isPlainObject(d) &&
        d.path === registryRel &&
        typeof d.message === "string" &&
        mentionsNumber(d.message, no) &&
        (!refOk || d.message.includes(ref)),
    );
    if (named) continue;
    out.push(
      `registry 幽灵/悬空可见性（registry 有条目而板上无）：registry 条目 ${no}（kind=${JSON.stringify(entry?.kind ?? null)}，指向 ${JSON.stringify(refOk ? ref : null)}）不在板上活条目、且非已验证归档件，但 ${registryRel ?? "（板 sources[] 未列 registry 路径）"} 面 diagnostics 无对应点名（含路径与两值：registry 源路径 + 条目号 + 指向路径）——两视图分叉（E4-05/U1：--check 直查有、板面无，冷读者漏读）；重编译刷新板面点名，或修复编译器 diagnostic 出口；失败级（B4-1/#105）。`,
    );
  }
  return out;
}

// ---------------------------------------------------------------- 公用件

/** 节点标识（失败项点名用）：稳定号 + 计划码（显示层）。 */
function nodeRef(node) {
  const id = Number.isInteger(node?.no) ? `#${node.no}` : "未领号";
  const code = typeof node?.planCode === "string" && node.planCode !== "" ? ` / ${node.planCode}` : "";
  return `${id}${code}`;
}

/** 类型名（失败项点名用）。 */
function typeName(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** 子树全部任务卡（前序遍历，含嵌套）。 */
function flatTasks(tasks) {
  const out = [];
  const walk = (list) => {
    for (const t of list ?? []) {
      out.push(t);
      walk(t?.tasks);
    }
  };
  walk(tasks);
  return out;
}

/** 渲染位 id（独立复写 compile-board.mjs 的 renderNodeId / renderTaskNodeId 语义）。 */
function featureId(f) {
  if (f?.no == null) return "未领号";
  if (f?.planCode != null && f?.label != null) return f.planCode;
  return f?.label != null ? `ID-${f.label}` : `#${f.no}`;
}
function taskId(t, planCode) {
  if (t?.no == null) return "未领号";
  if (t?.label == null) return `#${t.no}`;
  return planCode != null ? `${planCode}-${t.label}` : `ID-${t.label}`;
}

/**
 * board.md「## X」节行区间（[start, end)，0 起；标题按正则匹配；无该节 → null）。TQ-1 待处理/
 * 待合并节用（特性节对照面改用 numberingRange——epic 章带同入，不再止步于下一个「## 」行）。
 */
function sectionRange(lines, headingRe) {
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start: start + 1, end };
}

/**
 * 编号对照面行区间（A3-3/#86）：「## 特性」标题下一行 → 末章「## 诊断」标题行之前。
 * epic 章带（`# <码>` 章头 + `## <码><期次>` 期次组 + 章内稿节）落在两章之间，同入对照面；
 * 待处理/待合并章在「## 特性」之前，不参与本节序列（由 TQ-1 链对照面覆盖）。
 */
function numberingRange(lines) {
  const start = lines.findIndex((l) => FEATURE_SECTION_RE.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (BOARD_TAIL_RE.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start: start + 1, end };
}

/**
 * board.md 实际渲染的编号位序列（编号对照面，渲染序）：epic 章头 / 期次组头 / 稿节标题行 / 任务行；
 * 其余行不构成编号位——固定文案行（"最近执行："/"执行环境："/"草案"/epic 详情行等）不匹配各自词法，
 * 不参与对照。epic 章头取码 + 终态标注（标题内容不入对照）；期次组取整行编号位（合成码 + 期次号——
 * 两值同入对照，合成号与后缀自相矛盾也咬）。
 */
function observedRenderSlots(lines, range) {
  const out = [];
  for (let i = range.start; i < range.end; i += 1) {
    const line = lines[i];
    const epic = EPIC_HEADING_RE.exec(line);
    if (epic) {
      const text = epic[1];
      const code = text.split(" · ")[0].trim();
      const mark = text.endsWith(EPIC_TERMINAL_MARKS.cancelled)
        ? EPIC_TERMINAL_MARKS.cancelled
        : text.endsWith(EPIC_TERMINAL_MARKS.archived)
          ? EPIC_TERMINAL_MARKS.archived
          : "";
      out.push({ line: i + 1, kind: "epic", id: `${code}${mark}`, parsed: PLAN_CODE_RE.test(code) });
      continue;
    }
    if (line.startsWith("## ")) {
      const text = line.slice(3).trim();
      out.push({ line: i + 1, kind: "phase", id: text, parsed: PHASE_HEADING_RE.test(text) });
      continue;
    }
    const heading = FEATURE_HEADING_RE.exec(line);
    if (heading) {
      const id = heading[1].split(" · ")[0].trim();
      out.push({ line: i + 1, kind: "feature", id, parsed: ID_TOKEN_RE.test(id) });
      continue;
    }
    const m = MD_TASK_LINE_RE.exec(line);
    if (m && ID_TOKEN_RE.test(m[1])) out.push({ line: i + 1, kind: "task", id: m[1], parsed: true });
  }
  return out;
}

/**
 * 待处理/待合并节的条目行（walkBoardNodes 渲染位，TQ-1）：节内编号链形如
 * `<id> <标题> > <id> <标题> …`（待合并行尾另有 ` —— <工作树>`）；取每段首个空白前的
 * token 组成编号链——标题内容不参与对照，只对照编号形态与节点链。
 * itemRe 按渲染缩进区分：待处理条目为 2 空格缩进，待合并条目顶格。
 */
function observedSectionChains(lines, range, itemRe) {
  const out = [];
  for (let i = range.start; i < range.end; i += 1) {
    const m = itemRe.exec(lines[i]);
    if (!m) continue;
    const tokens = m[1].split(" > ").map((seg) => /^(\S+)/.exec(seg)?.[1] ?? seg);
    out.push({ line: i + 1, id: tokens.join(" > "), parsed: tokens.every((t) => ID_TOKEN_RE.test(t)) });
  }
  return out;
}

/**
 * 单个特性块的渲染位序列（特性标题行 + 递归任务行，渲染序）。链（chain）= 从根特性到该节点的
 * 渲染位 id 序列；节点 id = 链末项。
 */
function featureBlockSlots(f, ptr) {
  const planCode = typeof f?.planCode === "string" ? f.planCode : null;
  const out = [];
  const rootChain = [featureId(f)];
  out.push({ kind: "feature", ptr, node: f, ref: `${ptr}（${nodeRef(f)}）`, id: rootChain[0], chain: rootChain });
  const walkTasks = (tasks, tptr0, parentChain) => {
    (tasks ?? []).forEach((t, i) => {
      const tptr = `${tptr0}.tasks[${i}]`;
      const chain = [...parentChain, taskId(t, planCode)];
      out.push({ kind: "task", ptr: tptr, node: t, ref: `${tptr}（${nodeRef(t)}）`, id: chain[chain.length - 1], chain });
      walkTasks(t?.tasks, tptr, chain);
    });
  };
  walkTasks(f?.tasks, ptr, rootChain);
  return out;
}

/**
 * board.json 派生的应然编号链序列（与渲染顺序同：特性 → 各特性任务前序，含递归深度 ≥2）。
 * 链（chain）= 从根特性到该节点的渲染位 id 序列；节点 id = 链末项（待处理/待合并节对照用，TQ-1）。
 */
function expectedChains(board) {
  return (board?.features ?? []).flatMap((f, i) => featureBlockSlots(f, `features[${i}]`));
}

/**
 * 可渲染 epic 登记行（A3-3/#86）：形态过滤与 derive.deriveEpics 同口径（code/title/status 三字段；
 * 编译产物只含合法行；手改 board.json 的非法行不入应然序列——结构断言归 A2-2/schema 面）。
 */
function emittableEpics(board) {
  const rows = Array.isArray(board?.epics) ? board.epics : [];
  return rows.filter(
    (row) =>
      isPlainObject(row) &&
      typeof row.code === "string" &&
      PLAN_CODE_RE.test(row.code) &&
      typeof row.title === "string" &&
      row.title.trim() !== "" &&
      EPIC_STATUSES.includes(row.status),
  );
}

/**
 * board.json 派生的应然渲染位序列（A3-3/#86；与 renderBoardMd 装配序同构，独立复写）：
 *   顶层稿块（无归属/孤儿引用——AD-8 顶层平铺）→ 各 epic 章：章头 → 期次组（按期次序升序：
 *   派生 rollup ∪ 成员并集）→ 组内成员稿块（特性序）。归组只认 `epic:<码>` 登记 id 反查登记行。
 * 槽位 id：epic 章头 = `<码><终态标注>`；期次组 = `<码><期次> · 期次 <n>`（合成编号渲染位）；
 * 稿节/任务行 = 既有渲染位 id（AD-2：卡编号维持 计划码-层级，合成名不进卡编号命名空间）。
 */
function expectedRenderSlots(board) {
  const features = board?.features ?? [];
  const epicRows = emittableEpics(board);
  const groupCodeOf = (f) => {
    if (typeof f?.epic !== "string" || !f.epic.startsWith(EPIC_ID_PREFIX)) return null;
    const code = f.epic.slice(EPIC_ID_PREFIX.length);
    return epicRows.some((e) => e.code === code) ? code : null;
  };
  const blocks = features.map((f, i) => featureBlockSlots(f, `features[${i}]`));
  const out = [];
  features.forEach((f, i) => {
    if (groupCodeOf(f) == null) out.push(...blocks[i]);
  });
  epicRows.forEach((epic, ei) => {
    const members = features.map((f, i) => ({ f, i })).filter(({ f }) => groupCodeOf(f) === epic.code);
    out.push({
      kind: "epic",
      ptr: `epics[${ei}]`,
      node: epic,
      ref: `epics[${ei}]（${epic.code}）`,
      id: `${epic.code}${EPIC_TERMINAL_MARKS[epic.status] ?? ""}`,
      chain: [epic.code],
    });
    const phaseNos = [
      ...new Set([...(Array.isArray(epic.phases) ? epic.phases.map((p) => p?.phase) : []), ...members.map(({ f }) => f.phase)]),
    ]
      .filter((n) => Number.isInteger(n) && n >= 1)
      .sort((a, b) => a - b);
    for (const phase of phaseNos) {
      out.push({
        kind: "phase",
        ptr: `epics[${ei}]`,
        node: epic,
        ref: `epics[${ei}]（${epic.code} · 期次 ${phase}）`,
        id: `${epic.code}${phase} · 期次 ${phase}`,
        chain: [`${epic.code}${phase}`],
      });
      for (const { f, i } of members.filter(({ f }) => f.phase === phase)) out.push(...blocks[i]);
    }
  });
  return out;
}

/** 待处理节应然序列：按缺口码渲染序分组，组内前序（与 renderBoardMd 同序）；id = 全链文本。 */
function expectedPendingItems(chains) {
  const out = [];
  for (const code of ATTENTION_CODES) {
    for (const e of chains) {
      if ((e.node?.attention ?? []).includes(code)) out.push({ ptr: e.ptr, node: e.node, id: e.chain.join(" > ") });
    }
  }
  return out;
}

/** 待合并节应然序列：walkBoardNodes 前序中带 worktree 的节点（与 renderBoardMd 同序）；id = 全链文本。 */
function expectedUnmergedItems(chains) {
  return chains
    .filter((e) => typeof e.node?.worktree === "string" && e.node.worktree !== "")
    .map((e) => ({ ptr: e.ptr, node: e.node, id: e.chain.join(" > ") }));
}

/** 全板段位计数（独立复算：与 summarizeStages 同语义、不共享实现，避免重言式）。 */
function countStages(board) {
  const counts = Object.fromEntries(STAGE_VALUES.map((s) => [s, 0]));
  const walk = (list) => {
    for (const n of list ?? []) {
      if (n && typeof n.stage === "string" && n.stage in counts) counts[n.stage] += 1;
      walk(n?.tasks);
    }
  };
  walk(board?.features);
  return counts;
}

/**
 * 待处理/待合并节的编号链对照（TQ-1）：逐条对照（同序），违规逐条点名节名 + 行号 + 两值对照；
 * 报告上限同 (c)。节缺失而应然非空 → 逐条"缺少编号链"（重编译即可修复）。
 */
function compareSectionChains(out, { label, obs, exp }) {
  const n = Math.max(obs.length, exp.length);
  let reported = 0;
  for (let k = 0; k < n && reported < MAX_NUMBERING_VIOLATIONS; k += 1) {
    const o = obs[k];
    const e = exp[k];
    if (o && e && o.parsed && o.id === e.id) continue;
    reported += 1;
    if (o && e) {
      out.push(
        o.parsed
          ? `不变量 c（board.md 编号形态）：board.md 第 ${o.line} 行（${label}）渲染链 "${o.id}"，按 board.json 派生应为 "${e.id}"（${e.ptr}（${nodeRef(e.node)}））——编号多面一致（D1 守卫：walkBoardNodes 渲染位）`
          : `不变量 c（board.md 编号形态）：board.md 第 ${o.line} 行（${label}）的编号位形态无法解析（${JSON.stringify(o.id)}），按 board.json 派生应为 "${e.id}"（${e.ptr}（${nodeRef(e.node)}））`,
      );
    } else if (o) {
      out.push(`不变量 c（board.md 编号形态）：board.md 第 ${o.line} 行（${label}）渲染链 "${o.id}"，board.json 中无对应节点（多渲染）`);
    } else if (e) {
      out.push(`不变量 c（board.md 编号形态）：board.md ${label}节缺少编号链 "${e.id}" 的渲染行（${e.ptr}（${nodeRef(e.node)}））`);
    }
  }
  if (n > MAX_NUMBERING_VIOLATIONS && reported >= MAX_NUMBERING_VIOLATIONS) {
    out.push(`不变量 c（board.md 编号形态）：${label}节编号链差异超过 ${MAX_NUMBERING_VIOLATIONS} 处（共 ${n} 位），仅显示前 ${MAX_NUMBERING_VIOLATIONS} 处`);
  }
}

// ---------------------------------------------------------------- 四条不变量

/**
 * 事实互证不变量检查（纯函数，无 IO）。
 * @param {object} input
 * @param {object} input.board   board.json 形态对象（磁盘板或重编译产物）
 * @param {string|null} [input.boardMd] 与 board 配对的 board.md 文本；缺省/非字符串 → 跳过 (c)
 * @returns {string[]} 违例文案（空数组 = 通过）
 */
export function checkFactInvariants({ board, boardMd = null } = {}) {
  const out = [];
  if (!isPlainObject(board)) return ["事实互证：board 非对象，无法判定（先修复板/源）"];

  // (a) 子卡全部 completed → 特性 stage=已完成（计划稿特性段位随子卡汇总，契约 v2.3）
  (board.features ?? []).forEach((f, i) => {
    if (!isPlainObject(f)) return;
    if (f.kind !== "plan") return; // 汇总判据只属计划稿特性（spec 段位随 progress 真相源，契约 §13.1）
    if (f.roadmap === true) return; // roadmap 占位稿段位被压制（本稿条目本身不执行；#66 起 cancelled 终态例外——照常"已取消"，本判据只查完成汇总故跳过）
    const tasks = flatTasks(f.tasks);
    if (tasks.length === 0) return;
    const completed = tasks.filter((t) => t?.status === "completed").length;
    if (completed !== tasks.length) return;
    if (f.stage !== DONE_STAGE) {
      out.push(
        `不变量 a（子卡全完成→已完成）：features[${i}]（${nodeRef(f)}）子卡 ${completed}/${tasks.length} 全部 completed，但 stage=${JSON.stringify(f.stage)}（应为"${DONE_STAGE}"）——计划稿特性段位随子卡汇总（契约 v2.3）`,
      );
    }
  });

  // (b) 已有任务卡的特性不得挂 arranged-not-expanded（判据已收窄为零卡，契约 v2.3；
  //     roadmap 占位稿同理——roadmap 压制段位，但不该挂"未拆解"）
  (board.features ?? []).forEach((f, i) => {
    if (!isPlainObject(f)) return;
    const tasks = flatTasks(f.tasks);
    if (tasks.length === 0) return;
    if ((f.attention ?? []).includes(ARRANGED_NOT_EXPANDED)) {
      out.push(
        `不变量 b（有卡不得挂未拆解）：features[${i}]（${nodeRef(f)}）已有 ${tasks.length} 张任务卡，attention 却含 ${ARRANGED_NOT_EXPANDED}（判据为零卡，契约 v2.3；roadmap 稿同理）`,
      );
    }
  });

  // (c) board.md 渲染的编号形态 ↔ board.json 的 planCode/label 派生（D1 类守卫：渲染器漏传
  //     计划码时嵌套行回落 ID-<层级>，此处逐行对照咬住；深度 ≥2 全覆盖）。
  //     TQ-1 扩面：## 待处理 / ## 待合并 节（walkBoardNodes 渲染位）同入对照面。
  //     A3-3/#86 扩面：epic 章头/期次组头（AD-3 合成编号渲染位）与章内稿节/任务行同入对照面——
  //     对照序列 = 渲染序（顶层稿块 → 各 epic 章带）↔ board.json 派生序。
  if (typeof boardMd === "string" && boardMd !== "") {
    const lines = boardMd.split(/\r?\n/);
    const chains = expectedChains(board);
    const range = numberingRange(lines);
    if (range == null) {
      out.push("不变量 c（board.md 编号形态）：board.md 缺「## 特性」节，无法做编号形态互证——重编译即可修复");
    } else {
      const obs = observedRenderSlots(lines, range);
      const exp = expectedRenderSlots(board);
      const n = Math.max(obs.length, exp.length);
      let reported = 0;
      for (let k = 0; k < n && reported < MAX_NUMBERING_VIOLATIONS; k += 1) {
        const o = obs[k];
        const e = exp[k];
        if (o && e && o.parsed && o.id === e.id && o.kind === e.kind) continue;
        reported += 1;
        if (o && e && o.parsed && o.id === e.id) {
          out.push(
            `不变量 c（board.md 编号形态）：board.md 第 ${o.line} 行（${SLOT_KIND_LABELS[o.kind]}）渲染 "${o.id}"，与派生位同号但层位不同（应然层位 = ${SLOT_KIND_LABELS[e.kind]}：${e.ref}）——epic 码与计划码撞号时以容器层位判定`,
          );
        } else if (o && e) {
          out.push(
            o.parsed
              ? `不变量 c（board.md 编号形态）：board.md 第 ${o.line} 行（${SLOT_KIND_LABELS[o.kind]}）渲染 "${o.id}"，按 board.json 派生应为 "${e.id}"（${e.ref}）——编号多面一致（D1 守卫：嵌套任务行含递归深度 ≥2；epic 章/期次组/合成编号渲染位同入对照面）`
              : `不变量 c（board.md 编号形态）：board.md 第 ${o.line} 行（${SLOT_KIND_LABELS[o.kind]}）的编号位形态无法解析（${JSON.stringify(o.id)}），按 board.json 派生应为 "${e.id}"（${e.ref}）`,
          );
        } else if (o) {
          out.push(
            `不变量 c（board.md 编号形态）：board.md 第 ${o.line} 行（${SLOT_KIND_LABELS[o.kind]}）渲染 "${o.id}"，board.json 中无对应编号位（多渲染）`,
          );
        } else if (e) {
          out.push(
            `不变量 c（board.md 编号形态）：board.md 编号对照面缺少编号位 "${e.id}" 的渲染行（${e.ref}）`,
          );
        }
      }
      if (n > MAX_NUMBERING_VIOLATIONS && reported >= MAX_NUMBERING_VIOLATIONS) {
        out.push(`不变量 c（board.md 编号形态）：编号位差异超过 ${MAX_NUMBERING_VIOLATIONS} 处（共 ${n} 位），仅显示前 ${MAX_NUMBERING_VIOLATIONS} 处`);
      }
    }
    // TQ-1：待处理/待合并节的编号链同入对照面（条目行按渲染缩进区分：待处理 2 空格、待合并顶格）
    for (const section of [
      { label: "待处理", headingRe: PENDING_SECTION_RE, itemRe: /^ {2}- (.+)$/, exp: expectedPendingItems(chains) },
      { label: "待合并", headingRe: UNMERGED_SECTION_RE, itemRe: /^- (.+)$/, exp: expectedUnmergedItems(chains) },
    ]) {
      const secRange = sectionRange(lines, section.headingRe);
      const obs = secRange == null ? [] : observedSectionChains(lines, secRange, section.itemRe);
      compareSectionChains(out, { label: section.label, obs, exp: section.exp });
    }
  }

  // (d) 段位计数（board.json 内如携带 stageSummary）与全板节点 stage 逐项复算相等
  if (Object.prototype.hasOwnProperty.call(board, "stageSummary") && board.stageSummary !== undefined) {
    const carried = board.stageSummary;
    if (!isPlainObject(carried)) {
      out.push(`不变量 d（段位计数复算）：stageSummary 应为七段位计数对象，实际 ${typeName(carried)}——携带即须逐项相等`);
    } else {
      const recomputed = countStages(board);
      for (const s of STAGE_VALUES) {
        if (!Object.prototype.hasOwnProperty.call(carried, s)) {
          out.push(`不变量 d（段位计数复算）：stageSummary 缺「${s}」计数键（全板节点复算 ${recomputed[s]}）——携带即须逐项相等`);
          continue;
        }
        if (carried[s] !== recomputed[s]) {
          out.push(
            `不变量 d（段位计数复算）：stageSummary."${s}"=${JSON.stringify(carried[s])} 与全板节点 stage 复算 ${recomputed[s]} 不一致（携带即须逐项相等）`,
          );
        }
      }
      for (const k of Object.keys(carried)) {
        if (!STAGE_VALUES.includes(k)) out.push(`不变量 d（段位计数复算）：stageSummary 含未知计数键 ${JSON.stringify(k)}（七段位词表外）`);
      }
    }
  }

  // (i) 派生四段不变量（C2-2/#134；失败级）：板面卡级节点复算 ↔ frontier/blocked/recent 逐行对照，
  //     段间对偶复核（详见 checkDerivedIndexInvariants 注释；缺段键不判——旧板/手写夹具零噪声）
  out.push(...checkDerivedIndexInvariants({ board }));

  return out;
}

// ---------------------------------------------------------------- 派生四段不变量（i1–i4，C2-2/#134）

/** 板面卡级节点（有稳定号；features[].tasks 递归——四段选取域，独立复写 derive.collectNumberedCards）。 */
function boardCardNodes(board) {
  const out = [];
  const walk = (tasks, ptr) => {
    (tasks ?? []).forEach((t, i) => {
      const tptr = `${ptr}.tasks[${i}]`;
      if (t && Number.isInteger(t.no)) out.push({ node: t, ptr: tptr });
      walk(t?.tasks, tptr);
    });
  };
  (board?.features ?? []).forEach((f, i) => {
    if (isPlainObject(f)) walk(f.tasks, `features[${i}]`);
  });
  return out;
}

/**
 * 卡内未解除阻塞项（独立复写 derive.unresolvedBlockers 判据；纯函数）：
 *   - external：恒为未解除（外部事实不由板面推导）；
 *   - dependency：目标号经 byNo 反查，目标段位 ∈ 终态 → 已解除；缺号（blockedBy 缺省，§12 不造引用）
 *     或目标离板（手改板/离板）→ 未解除（不猜，保守计入）；
 *   - 其它 kind：不判（词表外形态归结构面；不混入本断言，防静默误判）。
 * 返回 [{blockerKind, targetId, summary, index}]（index = blockers 原文序位，报告点名用）。
 */
function unresolvedBlockersOf(card, byNo, terminal) {
  const out = [];
  (Array.isArray(card.blockers) ? card.blockers : []).forEach((b, index) => {
    if (!b || typeof b !== "object") return;
    const summary = typeof b.summary === "string" ? b.summary : "";
    if (b.kind === BLOCKER_EXTERNAL) {
      out.push({ blockerKind: BLOCKER_EXTERNAL, targetId: null, summary, index });
      return;
    }
    if (b.kind !== BLOCKER_DEPENDENCY) return;
    const targetId = Number.isInteger(b.blockedBy) ? b.blockedBy : null;
    const target = targetId != null ? byNo.get(targetId) : null;
    if (target != null && terminal.has(target.stage)) return; // 依赖已解除（目标终态）
    out.push({ blockerKind: BLOCKER_DEPENDENCY, targetId, summary, index });
  });
  return out;
}

/** frontier 行对照视图（比对字段集；nullish 缺省键归一为 null——缺键不静默通过）。 */
const frontierRowView = (row) => ({
  rank: row.rank,
  no: row.no,
  title: row.title ?? null,
  stage: row.stage,
  nextAssignee: row.nextAssignee ?? null,
  resolvedDeps: row.resolvedDeps,
});
/** blocked 行对照视图（比对字段集）。 */
const blockedRowView = (row) => ({
  no: row.no ?? null,
  title: row.title ?? null,
  stage: row.stage ?? null,
  blockerKind: row.blockerKind ?? null,
  targetId: row.targetId ?? null,
  summary: row.summary ?? null,
});

/**
 * 段行对照（i1/i3 共用）：应然行按**行键**与实际行配对（缺行/多出行逐条点名，不因单行漂移级联刷屏），
 * 配对行逐字段对照（实际/应然两值），配对位点序列须单调递增（板序＝口径的一部分：顺序错位必咬，
 * 如 blocked 卡内 blockers 原文序被改）。违例上限 MAX_SEGMENT_VIOLATIONS（超出汇总一行）。
 */
function compareSegmentRows(out, { invariant, label, segName, act, exp, view, keyOf, note }) {
  const actRows = act.map((row, k) => ({ row, k, key: isPlainObject(row) ? keyOf(row) : null, used: false }));
  const matched = [];
  exp.forEach((e, ei) => {
    const key = keyOf(e);
    const hit = actRows.find((a) => !a.used && a.key === key) ?? null;
    if (hit) hit.used = true;
    matched.push({ e, ei, a: hit });
  });
  let reported = 0;
  const eRef = (e) => `${e._ptr}（${nodeRef(e)}）`;
  for (const { e, ei, a } of matched) {
    if (reported >= MAX_SEGMENT_VIOLATIONS) break;
    if (a == null) {
      reported += 1;
      out.push(`${invariant}（${label}）：${segName} 缺行（应然序第 ${ei + 1} 行）——应然 ${JSON.stringify(view(e))}（${eRef(e)}）——${note}`);
      continue;
    }
    if (JSON.stringify(view(a.row)) === JSON.stringify(view(e))) continue;
    reported += 1;
    out.push(
      `${invariant}（${label}）：${segName}[${a.k}]（#${a.row.no}）与板面复算不符——实际 ${JSON.stringify(view(a.row))}，应然 ${JSON.stringify(view(e))}（${eRef(e)}）——${note}`,
    );
  }
  for (const a of actRows) {
    if (reported >= MAX_SEGMENT_VIOLATIONS) break;
    if (a.used) continue;
    reported += 1;
    out.push(
      isPlainObject(a.row)
        ? `${invariant}（${label}）：${segName}[${a.k}]（#${a.row.no}）为多出行——板面复算无此来源（受阻卡不可执行 / 无该卡 / 无该未解除阻塞项；实际 ${JSON.stringify(view(a.row))}）——${note}`
        : `${invariant}（${label}）：${segName}[${a.k}] 非对象行（实际 ${JSON.stringify(a.row)}）——段内形态归结构面，本面点名不静默——${note}`,
    );
  }
  const idx = matched.filter((m) => m.a != null).map((m) => m.a.k);
  const orderBad = idx.findIndex((v, i) => i > 0 && idx[i - 1] >= v);
  if (orderBad > 0 && reported < MAX_SEGMENT_VIOLATIONS) {
    reported += 1;
    out.push(
      `${invariant}（${label}）：${segName} 顺序与板序不符（实然位点序列 [${idx.join(", ")}]）——按板序排列（features 序 × 任务树序；卡内按 blockers 原文序）——${note}`,
    );
  }
  if (reported >= MAX_SEGMENT_VIOLATIONS && matched.length + actRows.length > MAX_SEGMENT_VIOLATIONS) {
    out.push(`${invariant}（${label}）：${segName} 差异超过 ${MAX_SEGMENT_VIOLATIONS} 处，仅显示前 ${MAX_SEGMENT_VIOLATIONS} 处`);
  }
}

/**
 * 派生四段不变量（C2-2/#134；失败级；纯函数）——对 board.json 的 `frontier[]`/`blocked[]`/`recent[]`
 * 与板面卡级节点**独立复算**对照（不导入 lib/derive.mjs，避免复算与被检对象同源退化为重言式）：
 *   i1 frontier 复算一致 · i2 recent 排序与截断 · i3 blocked 归因完整 · i4 段间对偶。
 * 携带即判：任一段键缺省 → 该族跳过（缺键由板/源互检与 schema 面承载；旧板/手写夹具零噪声）。
 * 判定域同 derive.deriveBoardIndex（卡=有稳定号的任务卡，含嵌套；特性/容器不进段）；重复号先到者
 * 为准（活号唯一归结构面断言，本面不叠加噪音）。
 * @param {object} input
 * @param {object} input.board board.json 形态对象
 * @returns {string[]} 违例文案（空数组 = 通过）
 */
export function checkDerivedIndexInvariants({ board } = {}) {
  const out = [];
  if (!isPlainObject(board)) return out; // 板非对象：失败级另一路点名，不叠加
  const hasKey = (k) => Object.prototype.hasOwnProperty.call(board, k);
  const terminal = new Set(TERMINAL_STAGES);
  const nodes = boardCardNodes(board);
  const byNo = new Map();
  for (const { node } of nodes) if (!byNo.has(node.no)) byNo.set(node.no, node);
  const cards = nodes.map((e) => ({ ...e, unresolved: unresolvedBlockersOf(e.node, byNo, terminal) }));

  // (i1) frontier 复算一致：段位待办 且 无未解除阻塞项（板序；rank 1..n；resolvedDeps 原文序）
  if (hasKey("frontier")) {
    if (!Array.isArray(board.frontier)) {
      out.push(
        `不变量 i1（frontier 复算一致）：frontier 应为数组，实际 ${typeName(board.frontier)}——四段由编译器派生（C2-1/AD-11③），手改板/派生回归在此必咬`,
      );
    } else {
      const exp = cards
        .filter((e) => e.node.stage === TODO_STAGE && e.unresolved.length === 0)
        .map((e, i) => ({
          rank: i + 1,
          no: e.node.no,
          title: e.node.title ?? null,
          stage: e.node.stage,
          nextAssignee: e.node.nextAssignee ?? null,
          resolvedDeps: (Array.isArray(e.node.blockers) ? e.node.blockers : [])
            .filter((b) => b && b.kind === BLOCKER_DEPENDENCY && Number.isInteger(b.blockedBy))
            .map((b) => b.blockedBy),
          _ptr: e.ptr,
        }));
      compareSegmentRows(out, {
        invariant: "不变量 i1",
        label: "frontier 复算一致",
        segName: "frontier",
        act: board.frontier,
        exp,
        view: frontierRowView,
        keyOf: (row) => `${row.no}`,
        note: "可执行前沿＝段位待办且无未解除阻塞项（依赖全终态/无依赖），按板序 rank=1..n（x-decisions 四段条①）",
      });
    }
  }

  // (i2) recent 排序与截断：条目 at 须非升序（新→旧；同刻保持 run 追加序），条数 ≤ 上限（N=10），
  //      每行须落在板上活号卡（离板引用不进活动面）且 title 与该节点同值（同值消费，禁二份口径）
  if (hasKey("recent")) {
    if (!Array.isArray(board.recent)) {
      out.push(
        `不变量 i2（recent 排序/截断）：recent 应为数组，实际 ${typeName(board.recent)}——四段由编译器派生（C2-1/AD-11③），手改板/派生回归在此必咬`,
      );
    } else {
      let reported = 0;
      if (board.recent.length > RECENT_LIMIT) {
        reported += 1;
        out.push(
          `不变量 i2（recent 排序/截断）：recent 共 ${board.recent.length} 条，超过上限 ${RECENT_LIMIT}（N=10 成文：按 at 新→旧取最近 10 条）——截断回归在此必咬`,
        );
      }
      let prevT = null;
      board.recent.forEach((row, k) => {
        if (reported >= MAX_SEGMENT_VIOLATIONS) return;
        if (!isPlainObject(row)) {
          reported += 1;
          out.push(`不变量 i2（recent 排序/截断）：recent[${k}] 非对象行（实际 ${JSON.stringify(row)}）——段内形态归结构面，本面点名不静默`);
          return;
        }
        const at = row.at ?? null;
        if (typeof at !== "string" || !ISO_RE.test(at) || Number.isNaN(Date.parse(at))) {
          reported += 1;
          out.push(
            `不变量 i2（recent 排序/截断）：recent[${k}]（#${row.no}）的 at=${JSON.stringify(at)} 非带时区 ISO 8601——无法判定新→旧次序（不猜时钟）`,
          );
        } else {
          const t = Date.parse(at);
          if (prevT != null && t > prevT) {
            reported += 1;
            out.push(
              `不变量 i2（recent 排序/截断）：recent[${k}]（#${row.no}）at=${at} 晚于上一行——recent 须按 at 新→旧（同刻保持 run 追加序；同刻次序无板面承载体，不可复算——不判）`,
            );
          }
          prevT = t;
        }
        const node = Number.isInteger(row.no) ? byNo.get(row.no) : null;
        if (node == null) {
          reported += 1;
          out.push(
            `不变量 i2（recent 排序/截断）：recent[${k}]（#${row.no ?? "缺号"}）不在板上活号卡中——离板引用不进活动面（编译侧已 diagnostics 点名）`,
          );
          return;
        }
        if ((row.title ?? null) !== (node.title ?? null)) {
          reported += 1;
          out.push(
            `不变量 i2（recent 排序/截断）：recent[${k}]（#${row.no}）title=${JSON.stringify(row.title ?? null)} 与板面节点 title=${JSON.stringify(node.title ?? null)} 不一致——同值消费（禁二份口径）`,
          );
        }
      });
      if (reported >= MAX_SEGMENT_VIOLATIONS && board.recent.length > MAX_SEGMENT_VIOLATIONS) {
        out.push(`不变量 i2（recent 排序/截断）：违例超过 ${MAX_SEGMENT_VIOLATIONS} 处，仅显示前 ${MAX_SEGMENT_VIOLATIONS} 处`);
      }
    }
  }

  // (i3) blocked 归因完整：非终态卡的每个未解除阻塞项恰一行（板序 + 卡内 blockers 原文序）
  if (hasKey("blocked")) {
    if (!Array.isArray(board.blocked)) {
      out.push(
        `不变量 i3（blocked 归因完整）：blocked 应为数组，实际 ${typeName(board.blocked)}——四段由编译器派生（C2-1/AD-11③），手改板/派生回归在此必咬`,
      );
    } else {
      const exp = [];
      for (const e of cards) {
        if (terminal.has(e.node.stage)) continue; // 终态卡不入选取域（历史阻塞项不复活，归因只对未终态卡）
        for (const u of e.unresolved) {
          exp.push({
            no: e.node.no,
            title: e.node.title ?? null,
            stage: e.node.stage,
            blockerKind: u.blockerKind,
            targetId: u.targetId,
            summary: u.summary,
            _ptr: `${e.ptr}.blockers[${u.index}]`,
          });
        }
      }
      compareSegmentRows(out, {
        invariant: "不变量 i3",
        label: "blocked 归因完整",
        segName: "blocked",
        act: board.blocked,
        exp,
        view: blockedRowView,
        keyOf: (row) => [row.no, row.blockerKind].join("|"),
        note: "非终态卡的未解除阻塞项逐项一行（external 恒未解除；dependency 仅当目标段位 ∈ 终态才解除；缺号/离板保守计入），按板序、卡内按 blockers 原文序（x-decisions 四段条③）",
      });
    }
  }

  // (i4) 段间对偶：待办卡 ∈ frontier ⟺ 不在 blocked（两面同时命中/两面皆无均必咬）
  if (hasKey("frontier") && hasKey("blocked") && Array.isArray(board.frontier) && Array.isArray(board.blocked)) {
    const nosOf = (seg) => new Set(seg.filter((r) => isPlainObject(r) && Number.isInteger(r.no)).map((r) => r.no));
    const inFrontier = nosOf(board.frontier);
    const inBlocked = nosOf(board.blocked);
    let reported = 0;
    for (const e of cards) {
      if (e.node.stage !== TODO_STAGE) continue;
      const inF = inFrontier.has(e.node.no);
      const inB = inBlocked.has(e.node.no);
      if (inF !== inB) continue; // 对偶成立：一面有、一面无
      reported += 1;
      if (reported > MAX_SEGMENT_VIOLATIONS) break;
      out.push(
        inF
          ? `不变量 i4（段间对偶）：${e.ptr}（${nodeRef(e.node)}）段位=待办，却同时出现在 frontier 与 blocked 两段（一面称可执行、一面称受阻——同一判据两面自相矛盾）——待办卡 ∈ frontier ⟺ 不在 blocked（x-decisions 四段条）`
          : `不变量 i4（段间对偶）：${e.ptr}（${nodeRef(e.node)}）段位=待办，却既不在 frontier 也不在 blocked（既不可执行又无阻塞归因——派生漏归因静默空洞）——待办卡 ∈ frontier ⟺ 不在 blocked（x-decisions 四段条）`,
      );
    }
    if (reported > MAX_SEGMENT_VIOLATIONS) {
      out.push(`不变量 i4（段间对偶）：违例超过 ${MAX_SEGMENT_VIOLATIONS} 处，仅显示前 ${MAX_SEGMENT_VIOLATIONS} 处`);
    }
  }

  return out;
}

// ---------------------------------------------------------------- 第五不变量 (e)：completed 须有 integrator done 证据

/**
 * 第五不变量（e，B1-1/#97）——**对账点名级（非失败级）**：completed 的任务卡须有该卡
 * integrator done 的 run 证据。
 *
 * 判据（纯数据，无 IO；runs 由调用方传入 runs.json 原始数组，与本模块其余不变量同一边界）：
 *   - 证据 = runs 记录中 role=integrator 且 result=done 且 cards 含该卡稳定号（正整数）；
 *     partial/failed/interrupted 不算证据；非整数句柄不解析（不猜卡号）；
 *   - 判定域 = **任务卡**（features[].tasks 递归，含嵌套）且 status=completed 且带稳定号正整数。
 *     特性节点是汇总态（子卡全完成≠特性已合并），未领号卡无引用位（runs 只能引用稳定号）——
 *     两类均不判，避免产生无法登记豁免的恒名词条。
 * 判级：归「对账点名」而非失败级——勾选=已合并（契约 6.3）的证据补录/速修·管理卡豁免登记属收尾
 *   对账动作，逐条点名但不使 --check 非零退出（不阻塞正常流）；登记豁免的稳定号不再点名。
 *
 * @param {object} input
 * @param {object} input.board  board.json 形态对象
 * @param {object[]} [input.runs]  runs.json 的 runs 数组（原始记录；缺省 ≡ 无证据）
 * @param {number[]} [input.exemptNos]  已登记豁免的稳定号（登记格式/位置校验归 lib/schema-check.mjs）
 * @returns {string[]} 点名文案（空数组 = 无点名）
 */
export function checkCompletedMergedEvidence({ board, runs, exemptNos = [] } = {}) {
  const out = [];
  if (!isPlainObject(board)) return out; // 板非对象：失败级已点名，此处不叠加
  const evidence = new Set();
  for (const r of Array.isArray(runs) ? runs : []) {
    if (!isPlainObject(r)) continue;
    if (r.role !== MERGED_ROLE || r.result !== MERGED_RESULT) continue;
    for (const c of Array.isArray(r.cards) ? r.cards : []) {
      if (Number.isInteger(c) && c >= 1) evidence.add(c);
    }
  }
  const exempted = new Set((Array.isArray(exemptNos) ? exemptNos : []).filter((n) => Number.isInteger(n) && n >= 1));
  const walk = (tasks, ptr) => {
    (tasks ?? []).forEach((t, i) => {
      const tptr = `${ptr}.tasks[${i}]`;
      if (
        isPlainObject(t) &&
        t.status === "completed" &&
        Number.isInteger(t.no) &&
        t.no >= 1 &&
        !evidence.has(t.no) &&
        !exempted.has(t.no)
      ) {
        out.push(
          `不变量 e（completed 须有 integrator done 证据）：${tptr}（${nodeRef(t)}）status=completed 但 .zcode/board/runs.json 无该卡 integrator done 的 run 证据——对账点名级（非失败级；勾选=已合并 6.3；速修/管理卡登记豁免后不再点名）`,
        );
      }
      walk(t?.tasks, tptr);
    });
  };
  (board.features ?? []).forEach((f, i) => {
    if (isPlainObject(f)) walk(f.tasks, `features[${i}]`);
  });
  return out;
}

// ---------------------------------------------------------------- 归属引用可达断言（h，A2-2/#82）

/**
 * 归属引用可达断言（h，A2-2/#82；markers §10.2/§10.3）——**失败级**（与 (a)–(d) 同层；独立导出、
 * 不并入 checkFactInvariants，保持 (a)–(d) 既有契约与计数语义不动）：
 *   `features[].epic` 取登记 id 形态（`epic:<4位码>`）时，`epics[]` 必须有该 code 的登记行——
 *   登记行是 epic 的唯一机器载体（无文件锚、无 `no`/无 `file`，§10.2）；无登记行的引用 = **悬空/
 *   孤儿引用**：板面原样透出是 faithful（不造行、不猜），但引用不可达、零 rollup——结构矛盾，
 *   逐条点名 features[i]（路径 + 实际引用值 + 缺失 code + 修复方向）。
 * 判定域（成文，勿扩）：
 *   - 只判登记 id 形态（`epic:` 前缀 + 4 位码冻结形态）——裸码/其它形态 = 引用位**形态**违规
 *     （lib/schema-check.mjs `checkBoardInvariants` 结构面点名，本面不叠加）；
 *   - 整数稳定号 = 合法引用形态但无登记面映射（不猜、不判——口径同 `derive.deriveEpics`
 *     "稳定号引用无登记面映射，不猜、不计 rollup"）；
 *   - 无 `epic` 字段 = 合法缺省（AD-8：无 epic 不判失败——本断言对无归属稿零噪声）。
 * 判级 = 失败级（A2-2 定性）：与结构矛盾类先例同层（「码进引用位」schema oneOf 已拒；blockedBy
 *   目标不在板上活条目同为引用可达失败级）；修复可达（补登记行/清引用 + 重编译），非收尾对账域。
 * 调用面：磁盘板与重编译基线各判一遍（compile-board `checkBoardArtifact`，「epic 归属」失败项）。
 * 纯函数：不读盘、不改入参、无隐藏状态。
 * @param {object} input
 * @param {object} input.board board.json 形态对象
 * @returns {string[]} 失败项文案（空数组 = 通过）
 */
export function checkEpicRefs({ board } = {}) {
  const out = [];
  if (!isPlainObject(board)) return out; // 板非对象：失败级已由结构面点名，此处不叠加
  const rows = Array.isArray(board.epics) ? board.epics : [];
  const codes = new Set();
  for (const row of rows) if (isPlainObject(row) && typeof row.code === "string") codes.add(row.code);
  (board.features ?? []).forEach((f, i) => {
    if (!isPlainObject(f)) return;
    const epic = f.epic;
    if (typeof epic !== "string" || !epic.startsWith(EPIC_ID_PREFIX)) return;
    const code = epic.slice(EPIC_ID_PREFIX.length);
    if (!PLAN_CODE_RE.test(code)) return; // 形态非法 → 结构面点名（checkBoardInvariants），本面不叠加
    if (codes.has(code)) return;
    out.push(
      `不变量 h（归属引用可达）：features[${i}].epic=${JSON.stringify(epic)}——epics[] 无 ${JSON.stringify(code)} 登记行（悬空引用/孤儿引用；登记行是 epic 唯一机器载体，§10.2——引用不可归组、零 rollup）。补登记行（code/title/status 三字段，§10.2）或清引用后重编译；失败级（A2-2 归属引用断言）。`,
    );
  });
  return out;
}
