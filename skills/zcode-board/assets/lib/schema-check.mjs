#!/usr/bin/env node
/**
 * zcode-board / schema-check（T10 交付物：--check 的结构校验模块）
 *
 * 职责（设计 §3.3 产物形态 / §4.5 执行字段一致性 / §8.4 缺口码 / T1 冻结子集）：
 *   1. checkSchemaSubset(schema)：受约束关键字子集约束（type/required/properties/items/enum/const/oneOf/pattern
 *      + 根级 x-* 元数据）——写法示范 = assets/tools/validate-sample.mjs（T1）；
 *   2. validateSchemaValue(schema, value)：子集语义校验器（与 T1 校验器同语义）；
 *   3. checkBoardInvariants(board)：子系统无法表达的公共不变量——
 *      T7 公共不变量（status/stage 词表、statusRule/stageRule 可溯源、attentionSummary 与节点 attention
 *      逐码相等、执行字段一致性）+ "号是身份"引用位整数断言（no/blockedBy 只认稳定号整数）+
 *      活号唯一 / label 形态与归属（含 §2.4 过渡态例外：未领号特性下的带号卡 label 缺省合法）；
 *   4. checkExemptionsDoc(doc)（B1-1/#97）：豁免登记（.zcode/board/exemptions.json，第五不变量 (e)
 *      的点名抑制）格式校验——结构非法整份拒收；条目级非法该条拒绝 + 点名，合法条目照常生效。
 *
 * 判定边界：本模块只看板自身（不读盘、不比对源）；源/registry 一致性归 --check 的编译与清单层。
 * 无第三方依赖：仅 node 内置（本文件不需要任何内置模块）。
 */

// ---------------------------------------------------------------- 词表与常量

/** T1 冻结的关键字子集（board.schema.json 文件头声明；本模块与 validate-sample.mjs 同源语义）。 */
export const ALLOWED_SCHEMA_KEYWORDS = Object.freeze([
  "type",
  "required",
  "properties",
  "items",
  "enum",
  "const",
  "oneOf",
  "pattern",
]);

/** 状态词表（契约 v2.1/T21 起含 cancelled 终态：取消留痕、条目保留、号不复用）。 */
export const BOARD_STATUSES = Object.freeze(["pending", "active", "blocked", "completed", "cancelled"]);
/** 七段位（契约 v2.1/T21 起"已取消"为实产出；词表与 lib/derive.mjs 同步，此模块零依赖不导入）。 */
export const BOARD_STAGES = Object.freeze(["待设计", "待办", "执行中", "审核中", "阻塞", "已完成", "已取消"]);
export const BOARD_ATTENTION_CODES = Object.freeze([
  "interviewed-not-arranged",
  "arranged-not-expanded",
  "interrupted-resume",
  "unmerged-worktree",
]);
export const SUMMARY_KEYS = Object.freeze({
  "interviewed-not-arranged": "interviewedNotArranged",
  "arranged-not-expanded": "arrangedNotExpanded",
  "interrupted-resume": "interruptedResume",
  "unmerged-worktree": "unmergedWorktree",
});

const ISO_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([+-][0-9]{2}:[0-9]{2}|Z)$/;
/** generatedBy 形态（#67）：`zcode-board/<主>.<次>.<修订>`——包版本语义化三段（两段式 0.2 为编译器历史版本形态，已退场）。 */
const GENERATED_BY_RE = /^zcode-board\/[0-9]+\.[0-9]+\.[0-9]+$/;
const LABEL_RE = /^[1-9][0-9]*(\.[1-9][0-9]*)*$/;
/** 工作树路径接受集（#71 两形态，与 lib/derive.mjs WORKTREE_PATH_RE 同口径）：短形态或一层子项目根相对路径。 */
const WORKTREE_RE = /^(?:[^/.][^/]*\/)?\.zcode\/worktrees\/task-[1-9][0-9]*$/;
const PR_URL_RE = /^https?:\/\/.+/;
const SOURCE_KINDS = ["interviews", "registry", "runs", "spec", "plan"];

// ---------------------------------------------------------------- 基础工具

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function brief(v, max = 60) {
  let s;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s === undefined) s = String(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ---------------------------------------------------------------- 1. schema 关键字子集

/**
 * 关键字子集约束（T1 语义）：properties/items/oneOf 递归；根级允许 x-* 元数据；
 * 其余出现的关键字一律记为违规。
 */
export function checkSchemaSubset(node, ptr = "$", errors = [], isRoot = true) {
  if (!isPlainObject(node)) return errors;
  for (const [k, v] of Object.entries(node)) {
    if (k === "properties") {
      if (!isPlainObject(v)) {
        errors.push(`${ptr}.properties: 应为对象`);
        continue;
      }
      for (const [pk, pv] of Object.entries(v)) checkSchemaSubset(pv, `${ptr}.properties.${pk}`, errors, false);
      continue;
    }
    if (k === "items") {
      checkSchemaSubset(v, `${ptr}.items`, errors, false);
      continue;
    }
    if (k === "oneOf") {
      if (!Array.isArray(v)) {
        errors.push(`${ptr}.oneOf: 应为数组`);
        continue;
      }
      v.forEach((b, i) => checkSchemaSubset(b, `${ptr}.oneOf[${i}]`, errors, false));
      continue;
    }
    if (ALLOWED_SCHEMA_KEYWORDS.includes(k)) continue;
    if (isRoot && k.startsWith("x-")) continue;
    errors.push(
      `${ptr}: 出现受约束子集之外的关键字 ${JSON.stringify(k)}（允许：${ALLOWED_SCHEMA_KEYWORDS.join("/")}${isRoot ? " + 根级 x-* 元数据" : ""}）`,
    );
  }
  return errors;
}

// ---------------------------------------------------------------- 2. 子集语义校验器

/**
 * 子集语义校验（与 T1 校验器同语义）：
 *   const → 恒等；enum → 成员；type → 类型（number 兼容 integer）；pattern → 正则匹配；
 *   required → 必填；properties → 逐字段递归；items → 逐元素递归；oneOf → 恰好命中一个分支。
 * 返回错误字符串数组（$ 起点的 JSON 指针 + 原因）。
 */
export function validateSchemaValue(schema, value, ptr = "$", errors = []) {
  if (!isPlainObject(schema)) return errors;
  if ("const" in schema && !deepEqual(schema.const, value)) {
    errors.push(`${ptr}: 应恒等于 ${brief(schema.const)}，实际 ${brief(value)}`);
    return errors;
  }
  if (schema.enum && !schema.enum.some((e) => deepEqual(e, value))) {
    errors.push(`${ptr}: 不在枚举 ${brief(schema.enum)} 内（实际 ${brief(value)}）`);
    return errors;
  }
  if (schema.type) {
    const actual = typeOf(value);
    const ok = schema.type === "number" ? actual === "number" || actual === "integer" : actual === schema.type;
    if (!ok) {
      errors.push(`${ptr}: 类型应为 ${schema.type}，实际 ${actual}`);
      return errors;
    }
  }
  if (schema.pattern !== undefined && typeof value === "string" && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${ptr}: 不匹配 pattern ${schema.pattern}（实际 ${brief(value)}）`);
  }
  if (schema.required && isPlainObject(value)) {
    for (const k of schema.required) if (!(k in value)) errors.push(`${ptr}: 缺少必填字段 ${k}`);
  }
  if (schema.properties && isPlainObject(value)) {
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (k in value) validateSchemaValue(sub, value[k], `${ptr}.${k}`, errors);
    }
  }
  if (schema.items && Array.isArray(value)) {
    value.forEach((v, i) => validateSchemaValue(schema.items, v, `${ptr}[${i}]`, errors));
  }
  if (schema.oneOf) {
    const branchErrors = schema.oneOf.map((b) => validateSchemaValue(b, value, ptr, []));
    const hits = branchErrors.filter((e) => e.length === 0).length;
    if (hits !== 1) {
      const best = branchErrors.reduce((a, b) => (b.length < a.length ? b : a), branchErrors[0] ?? []);
      errors.push(`${ptr}: oneOf 应恰好命中 1 个分支，实际命中 ${hits} 个；最接近分支的问题：${best[0] ?? "（无）"}`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------- 3. 板公共不变量

function walkBoardNodes(features, fn) {
  const walkTasks = (tasks, ptr, owner) => {
    for (const [i, t] of (tasks ?? []).entries()) {
      const tptr = `${ptr}.tasks[${i}]`;
      fn(t, tptr, owner);
      walkTasks(t?.tasks, tptr, owner);
    }
  };
  for (const [i, f] of (features ?? []).entries()) {
    fn(f, `features[${i}]`, null);
    walkTasks(f?.tasks, `features[${i}]`, f);
  }
}

function deepScan(value, ptr, fn) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => deepScan(v, `${ptr}[${i}]`, fn));
    return;
  }
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      fn(k, v, `${ptr}.${k}`);
      deepScan(v, `${ptr}.${k}`, fn);
    }
  }
}

/**
 * 板公共不变量（T7 公共不变量 + "号是身份"）：
 *   - 顶层：version/project/generatedBy/updatedAt/sources/diagnostics/attentionSummary 形态与词表；
 *   - 节点：status/stage 词表 + statusRule/stageRule 非空；no 正整数且活号唯一；label 形态、唯一、
 *     特性 label=稳定号、任务 label 首段=所属特性稳定号；attention ∈ 四码；
 *     interrupted-resume/unmerged-worktree 与 lastRun/activeRun/worktree 的一致性；
 *   - blockers：external 无 blockedBy；dependency 的 blockedBy 为正整数且落在板上活号集合；
 *   - 引用位深扫：任何 no/blockedBy 出现非整数 → 违规（标签不得进入引用位）。
 * 返回错误字符串数组（空数组 = 通过）。
 */
export function checkBoardInvariants(board) {
  const errors = [];
  if (!isPlainObject(board)) {
    errors.push("$: 板应为对象");
    return errors;
  }
  if (board.version !== 2) errors.push(`$.version: 应为 2（主版本冻结），实际 ${brief(board.version)}`);
  if (!isPlainObject(board.project) || typeof board.project.root !== "string" || board.project.root === "") {
    errors.push("$.project.root: 应为非空字符串");
  }
  if (!isPlainObject(board.project) || typeof board.project.name !== "string" || board.project.name === "") {
    errors.push("$.project.name: 应为非空字符串");
  }
  if (typeof board.generatedBy !== "string" || !GENERATED_BY_RE.test(board.generatedBy)) {
    errors.push(`$.generatedBy: 应为 zcode-board/<主>.<次>.<修订>，实际 ${brief(board.generatedBy)}`);
  }
  if (typeof board.updatedAt !== "string" || !ISO_RE.test(board.updatedAt)) {
    errors.push(`$.updatedAt: 应为带时区 ISO 8601，实际 ${brief(board.updatedAt)}`);
  }
  if (!Array.isArray(board.sources)) {
    errors.push("$.sources: 应为数组");
  } else {
    board.sources.forEach((s, i) => {
      const sp = `$.sources[${i}]`;
      if (!isPlainObject(s)) {
        errors.push(`${sp}: 应为对象`);
        return;
      }
      if (!SOURCE_KINDS.includes(s.kind)) errors.push(`${sp}.kind: 未知输入类别 ${brief(s.kind)}`);
      if (s.kind === "spec") {
        if (typeof s.root !== "string" || s.root === "") errors.push(`${sp}.root: spec 条目应为非空根路径`);
        if (!Array.isArray(s.files) || s.files.length === 0) errors.push(`${sp}.files: spec 条目应列出 files[]`);
      } else if (typeof s.path !== "string" || s.path === "") {
        errors.push(`${sp}.path: 应为非空路径`);
      }
    });
  }
  if (!Array.isArray(board.diagnostics)) {
    errors.push("$.diagnostics: 应为数组");
  } else {
    board.diagnostics.forEach((d, i) => {
      if (!isPlainObject(d)) {
        errors.push(`$.diagnostics[${i}]: 应为对象`);
        return;
      }
      if (typeof d.path !== "string" || d.path === "") errors.push(`$.diagnostics[${i}].path: 应为非空路径`);
      if (typeof d.message !== "string" || d.message === "") errors.push(`$.diagnostics[${i}].message: 应为非空原因说明`);
    });
  }
  if (!Array.isArray(board.features)) {
    errors.push("$.features: 应为数组");
    return errors;
  }

  const noMap = new Map();
  const codeCounts = Object.fromEntries(BOARD_ATTENTION_CODES.map((c) => [c, 0]));

  // ---- pass 1：身份与形态
  walkBoardNodes(board.features, (node, ptr, owner) => {
    if (!isPlainObject(node)) {
      errors.push(`${ptr}: 应为对象`);
      return;
    }
    if (!BOARD_STATUSES.includes(node.status)) {
      errors.push(`${ptr}.status: 不在四词表 ${brief(BOARD_STATUSES)} 内（实际 ${brief(node.status)}）`);
    }
    if (typeof node.statusRule !== "string" || node.statusRule.trim() === "") {
      errors.push(`${ptr}.statusRule: 应为非空溯源说明（每个 status 必须可溯源）`);
    }
    // stage/statusRule 为 T7 起产物字段：出现即校验（T1 冻结的 pre-T7 样例允许缺省）
    if ("stage" in node && !BOARD_STAGES.includes(node.stage)) {
      errors.push(`${ptr}.stage: 不在七段位词表内（实际 ${brief(node.stage)}）`);
    }
    // 计划码（#46 A1）：出现即校验形态（4 位：首字符字母 + 大写字母数字）
    if ("planCode" in node && node.planCode !== undefined) {
      if (typeof node.planCode !== "string" || !/^[A-Z][A-Z0-9]{3}$/.test(node.planCode)) {
        errors.push(`${ptr}.planCode: 形态应为 4 位 [A-Z][A-Z0-9]{3}（实际 ${brief(node.planCode)}）`);
      }
    }
    // 当前执行者（#46 A3）：出现且非空 → 必须等于 activeRun.role 且在 assignees 管线内（**卡级**；
    // 特性级 currentAssignee 由子树派生、无 activeRun，不在此判）
    if (
      "activeRun" in node &&
      "currentAssignee" in node &&
      node.currentAssignee !== undefined &&
      node.currentAssignee !== null
    ) {
      const activeRole =
        node.activeRun !== null && node.activeRun !== undefined ? node.activeRun.role : null;
      if (node.currentAssignee !== activeRole) {
        errors.push(`${ptr}.currentAssignee: 非空时应等于 activeRun.role（${brief(node.currentAssignee)} vs ${brief(activeRole)}）`);
      } else if (!Array.isArray(node.assignees) || !node.assignees.includes(node.currentAssignee)) {
        errors.push(`${ptr}.currentAssignee: 角色 ${brief(node.currentAssignee)} 不在责任管线内`);
      }
    }
    if ("stageRule" in node && (typeof node.stageRule !== "string" || node.stageRule.trim() === "")) {
      errors.push(`${ptr}.stageRule: 应为非空溯源说明`);
    }
    if (typeof node.title !== "string" || node.title === "") errors.push(`${ptr}.title: 应为非空字符串`);
    if (typeof node.details !== "string") errors.push(`${ptr}.details: 应为字符串，实际 ${typeOf(node.details)}`);
    if (!Array.isArray(node.attention)) {
      errors.push(`${ptr}.attention: 应为数组`);
    } else {
      for (const code of node.attention) {
        if (!BOARD_ATTENTION_CODES.includes(code)) {
          errors.push(`${ptr}.attention: 未知缺口码 ${brief(code)}（四码词表外）`);
          continue;
        }
        codeCounts[code] += 1;
      }
    }
    const hasNo = Object.prototype.hasOwnProperty.call(node, "no");
    // label 缺省 = 字段不存在**或值未定义**：编译器内存产物在未领号特性下会保留 undefined 形参位，
    // 序列化（JSON 丢弃 undefined）后即"字段缺省"——两种形态必须同判（§2.4 过渡态）。
    const hasLabel = Object.prototype.hasOwnProperty.call(node, "label") && node.label !== undefined;
    // §2.4 过渡态例外（v2.1）：卡有 no 无 label 合法 ⟺ 其所属特性未领号（特性 no/label 双缺）——
    // --assign 逐文件写号的中间形态，`--check` 不判违规；特性已领号而卡缺 label 仍违规；
    // 反向（卡有 label 无 no）不成立，仍由下方归属断言拦下。
    const ownerUnnumbered =
      owner != null &&
      !Object.prototype.hasOwnProperty.call(owner, "no") &&
      !Object.prototype.hasOwnProperty.call(owner, "label");
    if (hasNo !== hasLabel && !(ownerUnnumbered && hasNo && !hasLabel)) {
      errors.push(`${ptr}: no/label 应同时存在或同时缺省（未领号缺省形态；§2.4 过渡态例外仅限未领号特性下的带号卡）`);
    }
    if (hasNo) {
      if (!Number.isInteger(node.no) || node.no < 1) {
        errors.push(`${ptr}.no: 应为正整数稳定号，实际 ${brief(node.no)}`);
      } else if (noMap.has(node.no)) {
        errors.push(`${ptr}.no: 活号 ${node.no} 与 ${noMap.get(node.no)} 重复（活号必须唯一）`);
      } else {
        noMap.set(node.no, ptr);
      }
    }
    if (hasLabel) {
      if (typeof node.label !== "string" || !LABEL_RE.test(node.label)) {
        errors.push(`${ptr}.label: 层级标签形态不合法（${brief(node.label)}）`);
      }
    }
    if (owner == null && hasNo && hasLabel && node.label !== String(node.no)) {
      errors.push(`${ptr}.label: 特性 label 应等于其稳定号字符串（${brief(node.label)} vs ${brief(String(node.no))}）`);
    }
  });

  // ---- pass 1b：label 树位（#46 A2）：计划任务 = 计划内层级路径（1 / 1.1 / 1.1.1，计划间可重复）；
  //      spec 任务 = <特性号>.<序>（首段 = 特性稳定号）；特性 label = 稳定号字符串（全局唯一）。
  const featureLabelSeen = new Map();
  (board.features ?? []).forEach((f, fi) => {
    const fptr = `features[${fi}]`;
    if (!isPlainObject(f)) return;
    const hasOwnNo = Object.prototype.hasOwnProperty.call(f, "no");
    const hasOwnLabel =
      Object.prototype.hasOwnProperty.call(f, "label") && f.label !== undefined;
    if (hasOwnNo && hasOwnLabel && typeof f.label === "string") {
      if (featureLabelSeen.has(f.label)) {
        errors.push(`${fptr}.label: 特性标签 ${f.label} 与 ${featureLabelSeen.get(f.label)} 重复（特性标签全局唯一）`);
      } else {
        featureLabelSeen.set(f.label, fptr);
      }
    }
    const ownerNo = hasOwnNo && Number.isInteger(f.no) ? f.no : null;
    const planInternal = f.kind === "plan";
    const seen = new Map();
    const walk = (tasks, ptr, parentExpected) => {
      (tasks ?? []).forEach((t, i) => {
        const tptr = `${ptr}.tasks[${i}]`;
        const expected =
          parentExpected == null
            ? planInternal
              ? String(i + 1)
              : ownerNo != null
                ? `${ownerNo}.${i + 1}`
                : null
            : `${parentExpected}.${i + 1}`;
        if (isPlainObject(t) && typeof t.label === "string") {
          if (ownerNo == null) {
            errors.push(`${tptr}.label: 未领号特性下出现带 label 的任务卡`);
          } else if (seen.has(t.label)) {
            errors.push(`${tptr}.label: 标签 ${t.label} 与 ${seen.get(t.label)} 在所属特性内重复`);
          } else {
            seen.set(t.label, tptr);
            if (expected != null && t.label !== expected) {
              errors.push(
                `${tptr}.label: 树位派生应为 ${expected}（实际 ${brief(t.label)}；#46 A2：计划任务用计划内层级路径）`,
              );
            }
          }
        }
        walk(t?.tasks, tptr, expected);
      });
    };
    walk(f.tasks, fptr, null);
  });

  // ---- pass 2：引用可达与执行字段一致性（活号集合已完整）
  walkBoardNodes(board.features, (node, ptr) => {
    if (!isPlainObject(node)) return;
    const attn = Array.isArray(node.attention) ? node.attention : [];
    const resumable = ["partial", "interrupted"].includes(node.lastRun?.result);
    if (attn.includes("interrupted-resume") && !resumable) {
      errors.push(`${ptr}: 挂 interrupted-resume 但 lastRun.result=${brief(node.lastRun?.result ?? null)}（应为 partial|interrupted）`);
    }
    if (attn.includes("unmerged-worktree") && !(typeof node.worktree === "string" && node.worktree !== "")) {
      errors.push(`${ptr}: 挂 unmerged-worktree 但 worktree 为空`);
    }
    if ("activeRun" in node) {
      const active = node.activeRun !== null && node.activeRun !== undefined;
      if (active && !resumable) errors.push(`${ptr}: activeRun 非空但 lastRun.result 非 partial|interrupted`);
      if (!active && resumable) errors.push(`${ptr}: lastRun.result 可续但 activeRun 为空（§4.5 一致性）`);
    }
    if (node.worktree != null) {
      if (typeof node.worktree !== "string" || !WORKTREE_RE.test(node.worktree)) {
        errors.push(`${ptr}.worktree: 命名应为 .zcode/worktrees/task-<no> 或 <子目录>/.zcode/worktrees/task-<no>（#71），实际 ${brief(node.worktree)}`);
      }
    }
    if (node.pr != null) {
      if (
        !isPlainObject(node.pr) ||
        !Number.isInteger(node.pr.number) ||
        typeof node.pr.url !== "string" ||
        !PR_URL_RE.test(node.pr.url)
      ) {
        errors.push(`${ptr}.pr: 应为 null 或 {number 整数, url http(s) 链接}`);
      }
    }
    if (node.blockers != null) {
      if (!Array.isArray(node.blockers)) {
        errors.push(`${ptr}.blockers: 应为数组`);
      } else {
        node.blockers.forEach((b, i) => {
          const bp = `${ptr}.blockers[${i}]`;
          if (!isPlainObject(b)) {
            errors.push(`${bp}: 应为对象`);
            return;
          }
          if (b.kind === "external") {
            if (Object.prototype.hasOwnProperty.call(b, "blockedBy")) {
              errors.push(`${bp}: external 阻拦不得携带 blockedBy`);
            }
          } else if (b.kind === "dependency") {
            if (Object.prototype.hasOwnProperty.call(b, "blockedBy")) {
              if (!Number.isInteger(b.blockedBy) || b.blockedBy < 1) {
                errors.push(`${bp}.blockedBy: 引用位只认稳定号（正整数），实际 ${brief(b.blockedBy)}`);
              } else if (!noMap.has(b.blockedBy)) {
                errors.push(`${bp}.blockedBy: 目标号 ${b.blockedBy} 不在板上活条目（§12 应缺省并记 diagnostics）`);
              }
            }
          } else {
            errors.push(`${bp}.kind: 应为 external|dependency，实际 ${brief(b.kind)}`);
          }
          if (typeof b.summary !== "string") errors.push(`${bp}.summary: 应为字符串（可空串）`);
          if (!Array.isArray(b.evidence)) errors.push(`${bp}.evidence: 应为数组`);
        });
      }
    }
  });

  // ---- attentionSummary 与节点 attention 逐码相等（§3.3/§8.4 不变量）
  const summary = board.attentionSummary;
  if (!isPlainObject(summary)) {
    errors.push("$.attentionSummary: 应为对象（四键整数）");
  } else {
    for (const code of BOARD_ATTENTION_CODES) {
      const key = SUMMARY_KEYS[code];
      if (!Number.isInteger(summary[key])) {
        errors.push(`$.attentionSummary.${key}: 应为整数，实际 ${brief(summary[key])}`);
      } else if (summary[key] !== codeCounts[code]) {
        errors.push(
          `$.attentionSummary.${key}=${summary[key]} 与节点 attention 实际计数 ${codeCounts[code]} 不一致（逐码相等为硬不变量）`,
        );
      }
    }
    for (const k of Object.keys(summary)) {
      if (!Object.values(SUMMARY_KEYS).includes(k)) errors.push(`$.attentionSummary.${k}: 未知计数键`);
    }
  }

  // ---- 引用位深扫："号是身份，标签是排版"
  deepScan(board, "$", (key, value, ptr) => {
    if ((key === "no" || key === "blockedBy") && value !== null && value !== undefined && !Number.isInteger(value)) {
      errors.push(`${ptr}: 引用位必须为稳定号整数，出现 ${brief(value)}（"号是身份，标签是排版"）`);
    }
  });

  return errors;
}

// ---------------------------------------------------------------- 4. 豁免登记（exemptions.json，B1-1/#97）

/**
 * 豁免登记文件位置（B1-1/#97 本轮定案）：`.zcode/board/exemptions.json`——编排者单写者；
 * 唯一用途 = --check 第五不变量 (e) 的点名抑制（速修/管理卡：勾选=已合并但无该卡 integrator done
 * 的 run 证据，登记后不再对账点名）。--check 只读；编译器不读、不影响板产出（非编译源）。
 */
export const EXEMPTIONS_REL = ".zcode/board/exemptions.json";

/**
 * 豁免登记格式校验（纯函数，不读盘；读侧归 compile-board --check）。
 * 格式冻结：`{ "version": 1, "exemptions": [ { "no": <正整数>, "reason": <非空串>, "at": <带时区 ISO 8601> } ] }`。
 * 返回 { exemptNos, errors }（与 lib/scan-config.mjs loadScanConfig 同形）：
 *   - 结构非法（非对象 / version≠1 / exemptions 非数组）→ 整份拒收（exemptNos=[]）；
 *   - 条目级非法（no 非正整数 / reason 空 / at 形态非法）→ 该条拒绝 + 点名，其余合法条目照常生效；
 *   - 同号重复 → 该号全部条目拒绝（不猜哪条为准）。
 */
export function checkExemptionsDoc(doc) {
  if (!isPlainObject(doc)) {
    return { exemptNos: [], errors: [`$: 豁免登记应为对象（{ version: 1, exemptions: [...] }），实际 ${typeOf(doc)}`] };
  }
  // 结构闸（FINDING-1 回炉/B1 批量验证）：非对象以外的结构非法（version≠1，含字符串/缺失；exemptions
  // 非数组）→ 整份拒收（exemptNos 恒空）。不得"报错但条目仍生效"——失败文案与实际效果必须一致
  // （version 闸不得形同虚设）；条目级校验只在结构合法后执行。
  const structural = [];
  if (doc.version !== 1) structural.push(`$.version: 应为 1（豁免登记文件版本），实际 ${brief(doc.version)}`);
  if (!Array.isArray(doc.exemptions)) structural.push(`$.exemptions: 应为数组，实际 ${typeOf(doc.exemptions)}`);
  if (structural.length > 0) return { exemptNos: [], errors: structural };
  const errors = [];
  const entries = [];
  doc.exemptions.forEach((e, i) => {
    const ptr = `$.exemptions[${i}]`;
    if (!isPlainObject(e)) {
      errors.push(`${ptr}: 应为对象（{ no, reason, at }）`);
      return;
    }
    const own = [];
    if (!Number.isInteger(e.no) || e.no < 1) own.push(`${ptr}.no: 应为正整数稳定号，实际 ${brief(e.no)}`);
    if (typeof e.reason !== "string" || e.reason.trim() === "") own.push(`${ptr}.reason: 应为非空登记原因`);
    if (typeof e.at !== "string" || !ISO_RE.test(e.at)) own.push(`${ptr}.at: 应为带时区 ISO 8601，实际 ${brief(e.at)}`);
    if (own.length > 0) {
      errors.push(...own);
      return;
    }
    entries.push({ index: i, no: e.no });
  });
  const byNo = new Map();
  for (const { index, no } of entries) {
    if (!byNo.has(no)) byNo.set(no, []);
    byNo.get(no).push(index);
  }
  const dupNos = new Set();
  for (const [no, indexes] of byNo) {
    if (indexes.length > 1) {
      dupNos.add(no);
      errors.push(`$.exemptions: 号 ${no} 重复登记（条目 ${indexes.join("、")}）——不猜哪条为准，均不生效`);
    }
  }
  const exemptNos = entries.filter((en) => !dupNos.has(en.no)).map((en) => en.no);
  return { exemptNos, errors };
}
