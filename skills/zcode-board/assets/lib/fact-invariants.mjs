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
 *       ## 待合并 节（walkBoardNodes 渲染位）的编号链同入对照面；
 *   (d) 段位计数（board.json 内如携带 stageSummary）与全板节点 stage 逐项复算相等。
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
 * board.md 编号 token 形态（渲染位语义的独立复写）：
 *   `未领号`（no 缺省）/ `#N`（过渡态：有号无 label）/ `ID-<层级>` / `<计划码>` / `<计划码>-<层级>`。
 * 计划码 = 4 位 [A-Z][A-Z0-9]{3}（与 compile-board.PLAN_CODE_RE 同口径，由 S-1 守卫逐项对照）；
 * 层级路径 = `1` / `1.2` / `1.2.1`。
 */
const PLAN_CODE_SOURCE = "[A-Z][A-Z0-9]{3}";
const ID_TOKEN_RE = new RegExp(`^(?:未领号|#[1-9][0-9]*|ID-[1-9][0-9]*(?:\\.[1-9][0-9]*)*|${PLAN_CODE_SOURCE}(?:-[1-9][0-9]*(?:\\.[1-9][0-9]*)*)?)$`);
const FEATURE_HEADING_RE = /^### (.+)$/;
const MD_TASK_LINE_RE = /^\s*- ([^ ·]+) · /;
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
  };
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

/** board.md「## X」节行区间（[start, end)，0 起；标题按正则匹配；无该节 → null）。 */
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
 * board.md 实际渲染的编号位序列（特性标题行 + 任务行；其余行不构成编号位——固定文案行
 * 如"最近执行："/"执行环境："/"草案"等不匹配 id 词法，不参与对照）。
 */
function observedIds(lines, range) {
  const out = [];
  for (let i = range.start; i < range.end; i += 1) {
    const heading = FEATURE_HEADING_RE.exec(lines[i]);
    if (heading) {
      const id = heading[1].split(" · ")[0].trim();
      out.push({ line: i + 1, id, parsed: ID_TOKEN_RE.test(id) });
      continue;
    }
    const m = MD_TASK_LINE_RE.exec(lines[i]);
    if (m && ID_TOKEN_RE.test(m[1])) out.push({ line: i + 1, id: m[1], parsed: true });
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
 * board.json 派生的应然编号链序列（与渲染顺序同：特性 → 各特性任务前序，含递归深度 ≥2）。
 * 链（chain）= 从根特性到该节点的渲染位 id 序列；节点 id = 链末项（特性节对照用）。
 */
function expectedChains(board) {
  const out = [];
  const walkTasks = (tasks, ptr, planCode, parentChain) => {
    (tasks ?? []).forEach((t, i) => {
      const tptr = `${ptr}.tasks[${i}]`;
      const chain = [...parentChain, taskId(t, planCode)];
      out.push({ ptr: tptr, node: t, chain });
      walkTasks(t?.tasks, tptr, planCode, chain);
    });
  };
  (board?.features ?? []).forEach((f, i) => {
    const ptr = `features[${i}]`;
    const chain = [featureId(f)];
    out.push({ ptr, node: f, chain });
    walkTasks(f?.tasks, ptr, typeof f?.planCode === "string" ? f.planCode : null, chain);
  });
  return out;
}

/** board.json 派生的应然编号位序列（特性/任务行；节点 id = 链末项）。 */
function expectedIds(board) {
  return expectedChains(board).map(({ ptr, node, chain }) => ({ ptr, node, id: chain[chain.length - 1] }));
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
  if (typeof boardMd === "string" && boardMd !== "") {
    const lines = boardMd.split(/\r?\n/);
    const chains = expectedChains(board);
    const range = sectionRange(lines, FEATURE_SECTION_RE);
    if (range == null) {
      out.push("不变量 c（board.md 编号形态）：board.md 缺「## 特性」节，无法做编号形态互证——重编译即可修复");
    } else {
      const obs = observedIds(lines, range);
      const exp = expectedIds(board);
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
              ? `不变量 c（board.md 编号形态）：board.md 第 ${o.line} 行渲染 "${o.id}"，按 board.json 派生应为 "${e.id}"（${e.ptr}（${nodeRef(e.node)}））——编号多面一致（D1 守卫：嵌套任务行含递归深度 ≥2）`
              : `不变量 c（board.md 编号形态）：board.md 第 ${o.line} 行的编号位形态无法解析（${JSON.stringify(o.id)}），按 board.json 派生应为 "${e.id}"（${e.ptr}（${nodeRef(e.node)}））`,
          );
        } else if (o) {
          out.push(
            `不变量 c（board.md 编号形态）：board.md 第 ${o.line} 行渲染 "${o.id}"，board.json 中无对应编号位（多渲染）`,
          );
        } else if (e) {
          out.push(
            `不变量 c（board.md 编号形态）：board.md 特性节缺少编号位 "${e.id}" 的渲染行（${e.ptr}（${nodeRef(e.node)}））`,
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

  return out;
}
