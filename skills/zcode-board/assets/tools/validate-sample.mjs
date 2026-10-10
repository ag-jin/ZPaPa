#!/usr/bin/env node
/**
 * zcode-board 契约包 v2 自验工具（T1 交付物）
 *
 * 无第三方依赖：仅 Node 内置模块（node:fs / node:path / node:url / node:process）。
 * 校验面（全部为公开契约文件的机器断言，不触碰任何应用源码）：
 *   1. board.schema.json 只使用受约束关键字子集（type/required/properties/items/enum/const/oneOf/pattern）+ 根级 x-* 元数据；
 *   2. board.golden.json 通过 board.schema.json 子集校验；
 *   3. golden 不变量（号为正整数且唯一、未领号形态、引用位只认稳定号、attention 与 attentionSummary 一致、四码一致语义、覆盖清单等）；
 *   4. 三份模板与设计 §3.1/§3.2/§5.2 的字段清单一致（_note 逐字段点名 + 顶层键集合 + version 1 + 空数组）。
 *
 * 用法：
 *   node assets/tools/validate-sample.mjs                  # 全量自验（默认，含反向断言）
 *   node assets/tools/validate-sample.mjs --only golden     # 只验 schema + golden + 不变量
 *   node assets/tools/validate-sample.mjs --only templates  # 只验三份模板
 *   node assets/tools/validate-sample.mjs --mutate all      # 反向断言：逐个变异必须被校验拒绝
 *   node assets/tools/validate-sample.mjs --mutate <name>   # 单个变异（名字见 --list-mutations）
 *   node assets/tools/validate-sample.mjs --list-mutations   # 列出全部变异名称
 *
 * 退出码：0 = 全部通过；1 = 有失败；2 = 反向断言未被拒绝（校验不敏感）。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(HERE, "..");
const SCHEMA_PATH = join(ASSETS, "board.schema.json");
const GOLDEN_PATH = join(ASSETS, "samples", "board.golden.json");

const ALLOWED_KEYWORDS = new Set(["type", "required", "properties", "items", "enum", "const", "oneOf", "pattern"]);
const ATTENTION_CODES = ["interviewed-not-arranged", "arranged-not-expanded", "interrupted-resume", "unmerged-worktree"];
const ROLES = ["implementer", "debugger", "refactoring-optimizer", "code-reviewer", "test-verifier", "integrator"];
const STATUSES = ["pending", "active", "blocked", "completed", "cancelled"];
const ISO_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([+-][0-9]{2}:[0-9]{2}|Z)$/;
/** 标准管线（契约 v2.1；此处为独立字面量，不引实现常量——判断"非标准管线样例"覆盖用）。 */
const DEFAULT_ASSIGNEES = "implementer|test-verifier|code-reviewer|integrator";
const LABEL_RE = /^[1-9][0-9]*(\.[1-9][0-9]*)*$/;
/** 工作树路径接受集（#71 两形态）：短形态或一层子项目根相对路径（独立字面量，不引实现常量）。 */
const WORKTREE_RE = /^(?:[^/.][^/]*\/)?\.zcode\/worktrees\/task-[1-9][0-9]*$/;

// 三模板的字段契约（设计 §3.1 / §3.2 / §5.2）——字段清单完整性的断言基准。
const TEMPLATE_SPECS = {
  "interviews.template.json": {
    arrayKey: "interviews",
    topKeys: ["_note", "version", "interviews"],
    fields: ["id", "at", "sessionId", "topic", "summary", "decisions", "artifacts", "outcome", "resolvedBy", "status"],
  },
  "registry.template.json": {
    arrayKey: "entries",
    topKeys: ["_note", "version", "seq", "entries"],
    fields: ["no", "kind", "file", "specRoot", "title", "assignedAt", "planCode", "seq"],
  },
  "runs.template.json": {
    arrayKey: "runs",
    topKeys: ["_note", "version", "runs"],
    fields: ["runId", "sessionId", "role", "at", "result", "cards", "worktree", "branch", "evidence", "breakpoint", "stoppedAt", "next", "pr"],
  },
};

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
  if (a && b && typeof a === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function loadJson(path) {
  if (!existsSync(path)) return { error: `文件不存在：${path}` };
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { error: `文件不可读：${path}（${e.message}）` };
  }
  try {
    return { value: JSON.parse(text) };
  } catch (e) {
    return { error: `JSON 解析失败：${path}（${e.message}）` };
  }
}

function tokenInText(text, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`).test(text);
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

// -------------------------------------------------- 1. schema 子集校验器

function validate(schema, value, ptr, errors) {
  if ("const" in schema && !deepEqual(schema.const, value)) {
    errors.push(`${ptr}: 应恒等于 ${JSON.stringify(schema.const)}，实际 ${JSON.stringify(value)}`);
    return;
  }
  if (schema.enum && !schema.enum.some((e) => deepEqual(e, value))) {
    errors.push(`${ptr}: 不在枚举 ${JSON.stringify(schema.enum)} 内（实际 ${JSON.stringify(value)}）`);
    return;
  }
  if (schema.type) {
    const a = typeOf(value);
    const ok = schema.type === "number" ? a === "number" || a === "integer" : a === schema.type;
    if (!ok) {
      errors.push(`${ptr}: 类型应为 ${schema.type}，实际 ${a}`);
      return;
    }
  }
  if (schema.pattern !== undefined) {
    if (typeof value === "string" && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${ptr}: 不匹配 pattern ${schema.pattern}（实际 ${JSON.stringify(value)}）`);
    }
  }
  if (schema.required && isPlainObject(value)) {
    for (const k of schema.required) {
      if (!(k in value)) errors.push(`${ptr}: 缺少必填字段 ${k}`);
    }
  }
  if (schema.properties && isPlainObject(value)) {
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (k in value) validate(sub, value[k], `${ptr}.${k}`, errors);
    }
  }
  if (schema.items && Array.isArray(value)) {
    value.forEach((v, i) => validate(schema.items, v, `${ptr}[${i}]`, errors));
  }
  if (schema.oneOf) {
    const branchErrors = schema.oneOf.map((b) => {
      const e = [];
      validate(b, value, ptr, e);
      return e;
    });
    const hits = branchErrors.filter((e) => e.length === 0).length;
    if (hits !== 1) {
      const best = branchErrors.reduce((a, b) => (b.length < a.length ? b : a), branchErrors[0] ?? []);
      errors.push(`${ptr}: oneOf 应恰好命中 1 个分支，实际命中 ${hits} 个；最接近分支的问题：${best[0] ?? "（无）"}`);
    }
  }
}

function checkSchemaSubset(node, ptr, errors, isRoot) {
  if (!isPlainObject(node)) return;
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
    if (ALLOWED_KEYWORDS.has(k)) continue;
    if (isRoot && k.startsWith("x-")) continue;
    errors.push(`${ptr}: 出现受约束子集之外的关键字 "${k}"（允许：${[...ALLOWED_KEYWORDS].join("/")}${isRoot ? " + 根级 x-* 元数据" : ""}）`);
  }
}

// -------------------------------------------------- 2. golden 不变量

const STATS = () => ({
  features: 0,
  tasks: 0,
  numbered: 0,
  unnumbered: 0,
  external: 0,
  dependency: 0,
  dependencyWithNo: 0,
  dependencyWithoutNo: 0,
  lastRunNull: 0,
  lastRunSet: 0,
  activeRunSet: 0,
  worktreeSet: 0,
  prSet: 0,
  prNull: 0,
  assigneesDefault: 0,
  assigneesCustom: 0,
  emptyDetails: 0,
  planCodeFeature: 0,
  planCodeSpec: 0,
  currentAssigneeTaskSet: 0,
  currentAssigneeTaskNull: 0,
  currentAssigneeFeatureSet: 0,
  nextAssigneeTaskSet: 0,
  nextAssigneeTaskNull: 0,
  roadmapFeature: 0,
  planAllCompleted: 0,
  planAllCancelled: 0,
  planFeatureCancelled: 0,
  roadmapCancelledCard: 0,
  sectionSet: 0,
});

function checkInvariants(board, errors) {
  const stats = STATS();
  const noMap = new Map();
  const featureLabelMap = new Map();
  const codeCounts = Object.fromEntries(ATTENTION_CODES.map((c) => [c, 0]));
  const statusSeen = new Set();

  const checkIdentity = (node, ptr) => {
    const hasNo = Object.prototype.hasOwnProperty.call(node, "no");
    const hasLabel = Object.prototype.hasOwnProperty.call(node, "label");
    if (hasNo !== hasLabel) errors.push(`${ptr}: no/label 必须同时存在或同时缺省（未领号缺省形态）`);
    if (hasNo) {
      if (!Number.isInteger(node.no) || node.no < 1) {
        errors.push(`${ptr}.no: 必须是正整数（稳定号），实际 ${JSON.stringify(node.no)}`);
      } else if (noMap.has(node.no)) {
        errors.push(`${ptr}.no: 号 ${node.no} 与 ${noMap.get(node.no)} 重复（活号必须唯一）`);
      } else {
        noMap.set(node.no, ptr);
      }
      stats.numbered += 1;
    } else {
      stats.unnumbered += 1;
    }
    if (hasLabel && typeof node.label === "string" && !LABEL_RE.test(node.label)) {
      errors.push(`${ptr}.label: 层级标签形态不合法（${JSON.stringify(node.label)}）`);
    }
  };

  const checkAttention = (node, ptr) => {
    const list = Array.isArray(node.attention) ? node.attention : [];
    if (!Array.isArray(node.attention)) errors.push(`${ptr}.attention: 应为数组（可为空）`);
    for (const code of list) {
      if (!ATTENTION_CODES.includes(code)) {
        errors.push(`${ptr}.attention: 未知缺口码 ${JSON.stringify(code)}`);
        continue;
      }
      codeCounts[code] += 1;
      if (code === "interrupted-resume") {
        const result = node.lastRun?.result;
        if (!["partial", "interrupted"].includes(result)) {
          errors.push(`${ptr}: 挂 interrupted-resume 但 lastRun.result=${JSON.stringify(result)}（应为 partial|interrupted）`);
        }
      }
      if (code === "unmerged-worktree" && !(typeof node.worktree === "string" && node.worktree)) {
        errors.push(`${ptr}: 挂 unmerged-worktree 但 worktree 为空`);
      }
      if (code === "arranged-not-expanded") {
        // v2.3/#53 判据：plan 判零卡（计划稿卡恒为 draft，"全部为 draft"无区分度）；
        // spec 维持"零卡或全部为 draft"。
        const tasks = node.tasks ?? [];
        if (node.kind === "plan") {
          if (tasks.length > 0) {
            errors.push(`${ptr}: plan 挂 arranged-not-expanded 但已有派生任务卡（v2.3/#53 判据：plan 判零卡）`);
          }
        } else if (tasks.length > 0 && !tasks.every((t) => t.draft === true)) {
          errors.push(`${ptr}: 挂 arranged-not-expanded 但存在非 draft 任务卡`);
        }
      }
      if (code === "interviewed-not-arranged" && node.kind !== "interview-only") {
        errors.push(`${ptr}: 挂 interviewed-not-arranged 但 kind=${JSON.stringify(node.kind)}（应为 interview-only）`);
      }
    }
  };

  const checkCardCommon = (node, ptr) => {
    if (typeof node.status === "string") statusSeen.add(node.status);
    if (typeof node.statusRule !== "string" || node.statusRule.trim() === "") {
      errors.push(`${ptr}.statusRule: 每个 status 必须带非空 statusRule（可溯源）`);
    }
    checkIdentity(node, ptr);
    checkAttention(node, ptr);
    if (node.details === "") stats.emptyDetails += 1;
    // 计划稿章节（#46 B2）：出现即须为非空字符串
    if ("section" in node && (typeof node.section !== "string" || node.section.trim() === "")) {
      errors.push(`${ptr}.section: 出现时须为非空章节标题，实际 ${JSON.stringify(node.section)}`);
    }
    if ("activeRun" in node) {
      const active = node.activeRun !== null && node.activeRun !== undefined;
      const resumable = ["partial", "interrupted"].includes(node.lastRun?.result);
      if (active && !resumable) errors.push(`${ptr}: activeRun 非空但 lastRun.result 非 partial|interrupted`);
      if (!active && resumable) errors.push(`${ptr}: lastRun.result 可续但 activeRun 为空（§4.5 一致性）`);
      if (active) stats.activeRunSet += 1;
    }
    // 当前执行者（#46 A3，卡级）：非空 ⟺ activeRun.role 且该角色在 assignees 管线内。
    // 特性级没有 activeRun（子树派生），由下方特性层规则单独校验。
    if ("currentAssignee" in node && "activeRun" in node) {
      const role = node.currentAssignee;
      if (role !== null) {
        const active = node.activeRun !== null && node.activeRun !== undefined ? node.activeRun.role : null;
        if (role !== active) {
          errors.push(`${ptr}.currentAssignee: 非空时应等于 activeRun.role（${JSON.stringify(role)} vs ${JSON.stringify(active)}）`);
        } else if (!Array.isArray(node.assignees) || !node.assignees.includes(role)) {
          errors.push(`${ptr}.currentAssignee: 角色 ${JSON.stringify(role)} 不在责任管线内（管线 ∩ activeRun 才成立）`);
        }
      }
    }
  };

  const checkBlockers = (node, ptr) => {
    if (!Array.isArray(node.blockers)) return;
    for (const [i, b] of node.blockers.entries()) {
      const bptr = `${ptr}.blockers[${i}]`;
      if (!isPlainObject(b)) continue;
      if (b.kind === "external") {
        stats.external += 1;
        if ("blockedBy" in b) errors.push(`${bptr}: external 阻拦不得携带 blockedBy`);
      } else if (b.kind === "dependency") {
        stats.dependency += 1;
        if ("blockedBy" in b) {
          stats.dependencyWithNo += 1;
          if (!Number.isInteger(b.blockedBy) || b.blockedBy < 1) {
            errors.push(`${bptr}.blockedBy: 引用位只认稳定号（正整数），实际 ${JSON.stringify(b.blockedBy)}`);
          } else if (!noMap.has(b.blockedBy)) {
            errors.push(`${bptr}.blockedBy: 目标号 ${b.blockedBy} 不在板上（应缺省 blockedBy 并记 diagnostics）`);
          }
        } else {
          stats.dependencyWithoutNo += 1;
        }
      }
      if (typeof b.summary !== "string") errors.push(`${bptr}.summary: 应为字符串（可空串），实际 ${typeOf(b.summary)}`);
      if (!Array.isArray(b.evidence)) errors.push(`${bptr}.evidence: 应为数组`);
    }
  };

  // 特性层
  for (const [fi, f] of (board.features ?? []).entries()) {
    const ptr = `features[${fi}]`;
    stats.features += 1;
    checkCardCommon(f, ptr);
    // 计划码（#46 A1）：只在有计划码时计数（覆盖清单断言用）
    if (typeof f.planCode === "string") {
      if (f.kind === "plan") stats.planCodeFeature += 1;
      else if (f.kind === "spec") stats.planCodeSpec += 1;
    }
    // 特性级当前执行者（#46 A3）：非空 ⟺ 等于子树某任务的 currentAssignee（子树首个非空由编译器保证）
    if ("currentAssignee" in f && f.currentAssignee !== null) {
      const descendantRoles = new Set();
      const collectRoles = (tasks) => {
        for (const t of tasks ?? []) {
          if (t.currentAssignee != null) descendantRoles.add(t.currentAssignee);
          collectRoles(t.tasks);
        }
      };
      collectRoles(f.tasks);
      if (!descendantRoles.has(f.currentAssignee)) {
        errors.push(`${ptr}.currentAssignee: 应等于子树某任务的 currentAssignee（实际 ${JSON.stringify(f.currentAssignee)}）`);
      }
      stats.currentAssigneeFeatureSet += 1;
    }
    // roadmap 占位稿（#53，契约 v2.3 新增；#66 终态优先序）：出现即 true 且仅计划稿；
    // 段位默认恒待设计——但 status=cancelled（特性自身取消标记）或全部子卡 cancelled（rollup）
    // 为已取消（取消是终态，不让位于 roadmap 压制）；卡级同理（取消卡已取消，其余待设计）。
    if ("roadmap" in f) {
      if (f.roadmap !== true) {
        errors.push(`${ptr}.roadmap: 出现即须为 true（false 省略，契约 v2.3）`);
      } else {
        stats.roadmapFeature += 1;
        if (f.kind !== "plan") {
          errors.push(`${ptr}.roadmap: 仅计划稿特性可带 roadmap 标记（实际 kind=${JSON.stringify(f.kind)}）`);
        }
        const flat = [];
        const collectFlat = (tasks) => {
          for (const t of tasks ?? []) {
            flat.push(t);
            collectFlat(t.tasks);
          }
        };
        collectFlat(f.tasks);
        const allCancelled = flat.length > 0 && flat.every((t) => t.status === "cancelled");
        const expectedFeatureStage = f.status === "cancelled" || allCancelled ? "已取消" : "待设计";
        if (f.stage !== expectedFeatureStage) {
          errors.push(
            `${ptr}: roadmap 占位稿特性段位应为${expectedFeatureStage}（status=${JSON.stringify(f.status)}、子卡 ${flat.filter((t) => t.status === "cancelled").length}/${flat.length} cancelled；#66 终态优先序，实际 ${JSON.stringify(f.stage)}）`,
          );
        }
        const walkRoadmapCards = (tasks) => {
          for (const t of tasks ?? []) {
            const expectedCardStage = t.status === "cancelled" ? "已取消" : "待设计";
            if (t.status === "cancelled") stats.roadmapCancelledCard += 1;
            if (t.stage !== expectedCardStage) {
              errors.push(
                `${ptr}: roadmap 占位稿任务卡段位应为${expectedCardStage}（#${t.no ?? "未领号"} status=${JSON.stringify(t.status)} 实际 ${JSON.stringify(t.stage)}；#66）`,
              );
            }
            walkRoadmapCards(t.tasks);
          }
        };
        walkRoadmapCards(f.tasks);
      }
    }
    // 计划稿特性段位随子卡汇总（#53，契约 v2.3；#66 全取消对称）：全完成→已完成、全取消→已取消；
    // 全取消汇总优先于 roadmap 压制；混合态不 rollup（段位不得标已完成/已取消，除非特性自身取消标记）。
    if (f.kind === "plan" && (f.tasks ?? []).length > 0) {
      const flat = [];
      const collectFlat = (tasks) => {
        for (const t of tasks ?? []) {
          flat.push(t);
          collectFlat(t.tasks);
        }
      };
      collectFlat(f.tasks);
      const allCompleted = flat.length > 0 && flat.every((t) => t.status === "completed");
      const allCancelled = flat.length > 0 && flat.every((t) => t.status === "cancelled");
      if (allCancelled) {
        stats.planAllCancelled += 1;
        if (f.stage !== "已取消") {
          errors.push(`${ptr}: 计划稿全部子卡 cancelled 时段位应为已取消（实际 ${JSON.stringify(f.stage)}；#66 与全完成→已完成对称）`);
        }
      } else if (allCompleted) {
        if (f.roadmap !== true) {
          stats.planAllCompleted += 1;
          if (f.stage !== "已完成") {
            errors.push(`${ptr}: 计划稿全部子卡 completed 时段位应为已完成（实际 ${JSON.stringify(f.stage)}）`);
          }
        }
      } else if (f.stage === "已完成") {
        errors.push(`${ptr}: 计划稿段位已完成但存在未完成子卡（子卡汇总口径，v2.3/#53）`);
      }
      if (f.status === "cancelled") {
        stats.planFeatureCancelled += 1;
        if (f.stage !== "已取消") {
          errors.push(`${ptr}: 特性级取消（status=cancelled）时段位应为已取消（实际 ${JSON.stringify(f.stage)}；#66 终态优先序）`);
        }
      }
      if (f.stage === "已取消" && f.status !== "cancelled" && !allCancelled) {
        errors.push(`${ptr}: 计划稿段位已取消但子卡未全部 cancelled（实际 ${flat.filter((t) => t.status === "cancelled").length}/${flat.length}；#66 判据：特性自身取消或全取消汇总）`);
      }
    }
    // 特性 label = 稳定号字符串；全局唯一（特性层）
    if (Object.prototype.hasOwnProperty.call(f, "no") && typeof f.label === "string") {
      if (f.label !== String(f.no)) {
        errors.push(`${ptr}.label: 特性 label 应等于其稳定号字符串（${JSON.stringify(f.label)} vs ${JSON.stringify(String(f.no))}）`);
      } else if (featureLabelMap.has(f.label)) {
        errors.push(`${ptr}.label: 特性标签 ${f.label} 与 ${featureLabelMap.get(f.label)} 重复`);
      } else {
        featureLabelMap.set(f.label, ptr);
      }
    }
    // 任务层（含一层嵌套：feature → task → subtask）
    const ownerNo = Object.prototype.hasOwnProperty.call(f, "no") && Number.isInteger(f.no) ? f.no : null;
    const planInternal = f.kind === "plan";
    const taskLabelSeen = new Map();
    const walkTasks = (tasks, base, depth, parentExpected) => {
      if (tasks === undefined) return;
      if (!Array.isArray(tasks)) {
        errors.push(`${base}.tasks: 应为数组`);
        return;
      }
      tasks.forEach((t, i) => {
        const tptr = `${base}.tasks[${i}]`;
        stats.tasks += 1;
        if (!isPlainObject(t)) return;
        checkCardCommon(t, tptr);
        checkBlockers(t, tptr);
        // 卡龄/执行字段覆盖
        if (t.lastRun === null || t.lastRun === undefined) stats.lastRunNull += 1;
        else stats.lastRunSet += 1;
        if (typeof t.worktree === "string" && t.worktree) {
          stats.worktreeSet += 1;
          if (!WORKTREE_RE.test(t.worktree)) {
            errors.push(`${tptr}.worktree: 命名应为 .zcode/worktrees/task-<no> 或 <子目录>/.zcode/worktrees/task-<no>（#71），实际 ${JSON.stringify(t.worktree)}`);
          } else if (Object.prototype.hasOwnProperty.call(t, "no")) {
            const trailNo = Number(t.worktree.split("/").pop().split("-").pop());
            if (trailNo !== t.no) errors.push(`${tptr}.worktree: 工作树号 ${trailNo} 与卡号 ${t.no} 不一致`);
          }
        }
        if (t.pr === null || t.pr === undefined) stats.prNull += 1;
        else stats.prSet += 1;
        // 指派管线（契约 v2.1）：缺省=标准管线；非标准（显式 > agents:）样例覆盖面
        if (Array.isArray(t.assignees) && t.assignees.length > 0) {
          if (t.assignees.join("|") === DEFAULT_ASSIGNEES) stats.assigneesDefault += 1;
          else stats.assigneesCustom += 1;
        }
        // 覆盖计数：#46 A3 currentAssignee / B2 section / #53 nextAssignee
        if ("currentAssignee" in t) {
          if (t.currentAssignee === null) stats.currentAssigneeTaskNull += 1;
          else stats.currentAssigneeTaskSet += 1;
        }
        // 下一接手人（#53，契约 v2.3）：非空时须为 assignees[] 内的角色（管线序判定由编译器承载）
        if ("nextAssignee" in t) {
          if (t.nextAssignee === null) stats.nextAssigneeTaskNull += 1;
          else {
            stats.nextAssigneeTaskSet += 1;
            if (typeof t.nextAssignee !== "string" || t.nextAssignee.trim() === "") {
              errors.push(`${tptr}.nextAssignee: 非空时须为角色字符串，实际 ${JSON.stringify(t.nextAssignee)}`);
            } else if (!Array.isArray(t.assignees) || !t.assignees.includes(t.nextAssignee)) {
              errors.push(`${tptr}.nextAssignee: 角色 ${JSON.stringify(t.nextAssignee)} 不在责任管线内（assignees 序内才成立）`);
            }
          }
        }
        if (typeof t.section === "string") stats.sectionSet += 1;
        // label 树位（契约 v2.2 / #46 A2）：计划任务 = 计划内层级路径（1/1.1/1.1.1，计划间可重复）；
        // spec 任务 = <特性号>.<序>（首段 = 特性稳定号）；唯一性收窄到所属特性内。
        const expected =
          parentExpected == null
            ? planInternal
              ? String(i + 1)
              : ownerNo != null
                ? `${ownerNo}.${i + 1}`
                : null
            : `${parentExpected}.${i + 1}`;
        if (typeof t.label === "string") {
          if (ownerNo == null) {
            errors.push(`${tptr}.label: 未领号特性下出现带 label 的任务卡`);
          } else if (taskLabelSeen.has(t.label)) {
            errors.push(`${tptr}.label: 标签 ${t.label} 与 ${taskLabelSeen.get(t.label)} 在所属特性内重复`);
          } else {
            taskLabelSeen.set(t.label, tptr);
            if (expected != null && t.label !== expected) {
              errors.push(`${tptr}.label: 树位派生应为 ${expected}（实际 ${JSON.stringify(t.label)}）`);
            }
          }
        }
        walkTasks(t.tasks, tptr, depth + 1, expected);
      });
    };
    walkTasks(f.tasks, ptr, 1, null);
  }

  // 引用位深扫：blockedBy / no 必须是整数（标签不得进入任何引用位）
  deepScan(board, "$", (key, value, ptr) => {
    if ((key === "blockedBy" || key === "no") && value !== null && !Number.isInteger(value)) {
      errors.push(`${ptr}: 引用位必须为稳定号整数，出现 ${JSON.stringify(value)}（"号是身份，标签是排版"）`);
    }
    if (key === "worktree" && value !== null && typeof value !== "string") {
      errors.push(`${ptr}: worktree 应为路径字符串或 null，实际 ${typeOf(value)}`);
    }
  });

  // attentionSummary 与节点 attention 逐码一致
  const summary = board.attentionSummary ?? {};
  for (const code of ATTENTION_CODES) {
    const key = { "interviewed-not-arranged": "interviewedNotArranged", "arranged-not-expanded": "arrangedNotExpanded", "interrupted-resume": "interruptedResume", "unmerged-worktree": "unmergedWorktree" }[code];
    if (!Number.isInteger(summary[key])) errors.push(`attentionSummary.${key}: 应为整数，实际 ${JSON.stringify(summary[key])}`);
    else if (summary[key] !== codeCounts[code]) {
      errors.push(`attentionSummary.${key}=${summary[key]} 与节点 attention 实际计数 ${codeCounts[code]} 不一致`);
    }
  }
  for (const k of Object.keys(summary)) {
    if (!["interviewedNotArranged", "arrangedNotExpanded", "interruptedResume", "unmergedWorktree"].includes(k)) {
      errors.push(`attentionSummary.${k}: 未知计数键`);
    }
  }

  // sources 完整性
  const kinds = new Set((board.sources ?? []).map((s) => s?.kind));
  for (const k of ["interviews", "registry", "runs", "spec", "plan"]) {
    if (!kinds.has(k)) errors.push(`sources[]: 缺少 ${k} 类输入（§3.3 要求完整列出参与编译的输入）`);
  }
  for (const [i, s] of (board.sources ?? []).entries()) {
    if (s?.kind === "spec" && (!Array.isArray(s.files) || s.files.length === 0)) {
      errors.push(`sources[${i}]: spec 条目必须列出 files[]`);
    }
  }

  // 顶层字段
  if (board.version !== 2) errors.push(`version: 应为 2（主版本 2），实际 ${JSON.stringify(board.version)}`);
  if (!board.project || typeof board.project.root !== "string" || board.project.root === "") errors.push("project.root: 应为非空字符串");
  if (!board.project || typeof board.project.name !== "string" || board.project.name === "") errors.push("project.name: 应为非空字符串");
  if (typeof board.generatedBy !== "string" || !/^zcode-board\/[0-9]+\.[0-9]+\.[0-9]+$/.test(board.generatedBy)) {
    errors.push(`generatedBy: 应为 zcode-board/<主>.<次>.<修订>（#67 包版本语义化三段），实际 ${JSON.stringify(board.generatedBy)}`);
  }
  if (typeof board.updatedAt !== "string" || !ISO_RE.test(board.updatedAt)) {
    errors.push(`updatedAt: 应为带时区的 ISO 8601，实际 ${JSON.stringify(board.updatedAt)}`);
  }
  for (const [i, d] of (board.diagnostics ?? []).entries()) {
    if (!isPlainObject(d)) continue;
    if (typeof d.path !== "string" || d.path === "") errors.push(`diagnostics[${i}].path: 应为非空路径`);
    if (typeof d.message !== "string" || d.message === "") errors.push(`diagnostics[${i}].message: 应为非空原因说明`);
  }

  // 覆盖断言（T1 验收：golden 必须含四种 attention 码、两类 blockers、执行字段、全量 statusRule、未领号形态）
  const coverageErrors = [];
  for (const code of ATTENTION_CODES) {
    if (codeCounts[code] < 1) coverageErrors.push(`golden 覆盖缺口：attention 码 ${code} 未出现`);
  }
  if (stats.external < 1) coverageErrors.push("golden 覆盖缺口：无 external 阻拦样例");
  if (stats.dependencyWithNo < 1) coverageErrors.push("golden 覆盖缺口：无带 blockedBy 的 dependency 阻拦样例");
  if (stats.dependencyWithoutNo < 1) coverageErrors.push("golden 覆盖缺口：无 blockedBy 缺省的 dependency 阻拦样例（§12 不造引用）");
  if (stats.lastRunNull < 1 || stats.lastRunSet < 1) coverageErrors.push("golden 覆盖缺口：lastRun 的 null 与非 null 形态未各出现");
  if (stats.activeRunSet < 1) coverageErrors.push("golden 覆盖缺口：activeRun 非空样例缺失");
  if (stats.worktreeSet < 1) coverageErrors.push("golden 覆盖缺口：worktree 非空样例缺失");
  if (stats.prSet < 1 || stats.prNull < 1) coverageErrors.push("golden 覆盖缺口：pr 的 null 与非 null 形态未各出现");
  if (stats.assigneesDefault < 1) coverageErrors.push("golden 覆盖缺口：assignees 缺省标准管线样例缺失（v2.1）");
  if (stats.assigneesCustom < 1) coverageErrors.push("golden 覆盖缺口：assignees 非标准管线样例缺失（v2.1，> agents: 显式覆盖）");
  if (stats.unnumbered < 1) coverageErrors.push("golden 覆盖缺口：未领号缺省形态（no/label 双缺省）样例缺失");
  if (stats.emptyDetails < 1) coverageErrors.push("golden 覆盖缺口：details 空串形态缺失（§4.2 提取不到留空）");
  if (stats.planCodeFeature < 1) coverageErrors.push("golden 覆盖缺口：计划码样例缺失（#46 A1，plan 特性带 planCode）");
  if (stats.planCodeSpec < 1) coverageErrors.push("golden 覆盖缺口：计划→spec 延续的计划码样例缺失（spec 特性带 planCode）");
  if (stats.currentAssigneeTaskSet < 1 || stats.currentAssigneeTaskNull < 1) {
    coverageErrors.push("golden 覆盖缺口：任务 currentAssignee 的 null 与非 null 形态未各出现（#46 A3）");
  }
  if (stats.currentAssigneeFeatureSet < 1) coverageErrors.push("golden 覆盖缺口：特性 currentAssignee 非空样例缺失（#46 A3）");
  if (stats.nextAssigneeTaskSet < 1 || stats.nextAssigneeTaskNull < 1) {
    coverageErrors.push("golden 覆盖缺口：任务 nextAssignee 的 null 与非 null 形态未各出现（#53 v2.3）");
  }
  if (stats.roadmapFeature < 1) coverageErrors.push("golden 覆盖缺口：roadmap 占位稿样例缺失（#53 v2.3）");
  if (stats.planAllCompleted < 1) {
    coverageErrors.push("golden 覆盖缺口：全完成计划稿（全部子卡 completed → 段位已完成）样例缺失（#53 v2.3）");
  }
  if (stats.roadmapCancelledCard < 1) {
    coverageErrors.push("golden 覆盖缺口：roadmap 稿取消卡（终态不让位 → 段位已取消）样例缺失（#66）");
  }
  if (stats.planFeatureCancelled < 1) {
    coverageErrors.push("golden 覆盖缺口：特性级取消稿（> cancelled: H1 落点 → 特性 cancelled/已取消）样例缺失（#66）");
  }
  if (stats.planAllCancelled < 1) {
    coverageErrors.push("golden 覆盖缺口：全取消计划稿（全部子卡 cancelled → 段位已取消）样例缺失（#66）");
  }
  if (stats.sectionSet < 1) coverageErrors.push("golden 覆盖缺口：计划任务 section（章节）样例缺失（#46 B2）");
  for (const s of STATUSES) {
    if (!statusSeen.has(s)) coverageErrors.push(`golden 覆盖缺口：status=${s} 样例缺失`);
  }
  if ((board.diagnostics ?? []).length < 1) coverageErrors.push("golden 覆盖缺口：diagnostics 非空样例缺失");
  errors.push(...coverageErrors);

  return { stats, codeCounts, statusSeen };
}

// -------------------------------------------------- 3. 模板校验

function checkTemplates(errors) {
  const results = [];
  for (const [file, spec] of Object.entries(TEMPLATE_SPECS)) {
    const path = join(ASSETS, "templates", file);
    const loaded = loadJson(path);
    if (loaded.error) {
      errors.push(`templates/${file}: ${loaded.error}`);
      results.push({ file, ok: false });
      continue;
    }
    const t = loaded.value;
    const before = errors.length;
    const keys = Object.keys(t);
    if (t.version !== 1) errors.push(`templates/${file}: version 应为 1，实际 ${JSON.stringify(t.version)}`);
    if (!Array.isArray(t[spec.arrayKey]) || t[spec.arrayKey].length !== 0) {
      errors.push(`templates/${file}: ${spec.arrayKey} 应为空数组`);
    }
    const expectedTop = [...spec.topKeys].sort().join(",");
    const actualTop = [...keys].sort().join(",");
    if (expectedTop !== actualTop) errors.push(`templates/${file}: 顶层键应为 ${expectedTop}，实际 ${actualTop}`);
    if (file === "registry.template.json" && t.seq !== 0) errors.push(`templates/${file}: seq 应为 0（空序列高水位），实际 ${JSON.stringify(t.seq)}`);
    const note = typeof t._note === "string" ? t._note : "";
    if (note === "") errors.push(`templates/${file}: _note 缺失（模板字段清单的文件头说明）`);
    for (const field of spec.fields) {
      if (!tokenInText(note, field)) errors.push(`templates/${file}: _note 未点名字段 ${field}（字段清单不完整）`);
    }
    results.push({ file, ok: errors.length === before, fields: spec.fields.length });
  }
  return results;
}

// -------------------------------------------------- 4. 契约文档（markers.md / run-event.md）

const DOC_SPECS = [
  {
    file: "contracts/markers.md",
    must: ["标签不是句柄", "<!-- zcode-board: no=", "ID-9", "层级标签", "> blocked:", "> blocked-by:", "> cancelled:", "> agents:", "--assign", "registry"],
  },
  {
    file: "contracts/run-event.md",
    must: ["run_event", "merge_report.v1", "interrupted", "无 run_event 块", "cards", "stoppedAt", "nextStep", "breakpoint", "diagnostics", "pr"],
  },
];

function checkDocs(errors) {
  const results = [];
  for (const spec of DOC_SPECS) {
    const path = join(ASSETS, spec.file);
    if (!existsSync(path)) {
      errors.push(`${spec.file}: 文件不存在`);
      results.push({ file: spec.file, ok: false });
      continue;
    }
    const text = readFileSync(path, "utf8");
    const before = errors.length;
    if (text.trim() === "") errors.push(`${spec.file}: 内容为空`);
    for (const token of spec.must) {
      if (!text.includes(token)) errors.push(`${spec.file}: 缺少契约要点 "${token}"`);
    }
    results.push({ file: spec.file, ok: errors.length === before, tokens: spec.must.length });
  }
  return results;
}

// -------------------------------------------------- 5. 反向断言（变异必须被拒）

function firstDependencyWithNo(board) {
  let found = null;
  deepScan(board, "$", (key, value, ptr) => {
    if (!found && key === "blockedBy" && Number.isInteger(value)) found = ptr.slice(0, -(key.length + 1));
  });
  return found;
}

function nodeAt(board, ptr) {
  const parts = ptr.replace(/^\$\.?/, "").split(".").filter((p) => p !== "");
  let cur = board;
  for (const p of parts) {
    const m = p.match(/^([A-Za-z0-9_]+)(?:\[(\d+)\])?$/);
    if (!m) return null;
    cur = cur[m[1]];
    if (m[2] !== undefined) cur = cur?.[Number(m[2])];
    if (cur === undefined || cur === null) return null;
  }
  return cur;
}

const MUTATIONS = [
  { name: "version-major", expect: "version 主版本漂移必须被拒（const 2）", apply: (b) => { b.version = 3; } },
  { name: "generated-by-legacy-two-segment", expect: "旧两段式 generatedBy 必须被拒（#67：包版本语义化三段 zcode-board/<主>.<次>.<修订>）", apply: (b) => { b.generatedBy = "zcode-board/0.2"; } },
  { name: "drop-status-rule", expect: "缺 statusRule 必须被拒（required）", apply: (b) => { delete b.features[0].tasks[0].statusRule; } },
  { name: "bad-attention-code", expect: "未知 attention 码必须被拒（enum）", apply: (b) => { b.features[0].tasks[1].attention = ["unmerged"]; } },
  {
    name: "label-in-reference",
    expect: "标签写进引用位必须被拒（blockedBy 只认稳定号整数）",
    apply: (b) => {
      const ptr = firstDependencyWithNo(b);
      if (!ptr) throw new Error("golden 无带 blockedBy 的 dependency 样例，无法构造变异");
      nodeAt(b, ptr).blockedBy = "1.2";
    },
  },
  { name: "zero-number", expect: "非正整数号必须被拒", apply: (b) => { b.features[0].no = 0; } },
  { name: "summary-count-drift", expect: "attentionSummary 计数漂移必须被拒（与节点 attention 不一致）", apply: (b) => { b.attentionSummary.interruptedResume += 3; } },
  {
    name: "off-board-blocked-by",
    expect: "指向不在板上目标的 blockedBy 必须被拒（§12 应缺省 + diagnostics）",
    apply: (b) => {
      const ptr = firstDependencyWithNo(b);
      if (!ptr) throw new Error("golden 无带 blockedBy 的 dependency 样例，无法构造变异");
      nodeAt(b, ptr).blockedBy = 4242;
    },
  },
  { name: "no-without-label", expect: "未领号形态破坏（有 no 无 label）必须被拒", apply: (b) => { delete b.features[0].label; } },
  {
    name: "interrupted-without-partial",
    expect: "挂 interrupted-resume 而 lastRun.result=done 必须被拒（§4.5 一致性）",
    apply: (b) => {
      for (const f of b.features) for (const t of f.tasks ?? []) if ((t.attention ?? []).includes("interrupted-resume")) t.lastRun.result = "done";
    },
  },
  {
    name: "unmerged-without-worktree",
    expect: "挂 unmerged-worktree 而去掉 worktree 必须被拒（§4.5 一致性）",
    apply: (b) => {
      for (const f of b.features) for (const t of f.tasks ?? []) if ((t.attention ?? []).includes("unmerged-worktree")) t.worktree = null;
    },
  },
  {
    name: "external-with-blocked-by",
    expect: "external 阻拦携带 blockedBy 必须被拒",
    apply: (b) => {
      for (const f of b.features) for (const t of f.tasks ?? []) for (const bl of t.blockers ?? []) if (bl.kind === "external") bl.blockedBy = 9;
    },
  },
  {
    name: "worktree-number-mismatch",
    expect: "工作树号与卡号不一致必须被拒",
    apply: (b) => {
      for (const f of b.features) for (const t of f.tasks ?? []) if (typeof t.worktree === "string" && t.worktree) t.worktree = ".zcode/worktrees/task-12";
    },
  },
  {
    name: "plan-label-drift",
    expect: "计划任务 label 偏离计划内层级树位（#46 A2）必须被拒",
    apply: (b) => {
      const plan = b.features.find((f) => f.kind === "plan" && (f.tasks ?? []).some((t) => t.label));
      if (!plan) throw new Error("golden 无带 label 的计划任务样例，无法构造变异");
      plan.tasks[1].label = "11.2";
    },
  },
  {
    name: "spec-label-first-segment",
    expect: "spec 任务 label 首段偏离所属特性稳定号必须被拒",
    apply: (b) => {
      const spec = b.features.find((f) => f.kind === "spec" && (f.tasks ?? []).some((t) => t.label));
      if (!spec) throw new Error("golden 无带 label 的 spec 任务样例，无法构造变异");
      spec.tasks[0].label = "9.1";
    },
  },
  {
    name: "task-label-duplicate-in-feature",
    expect: "同一特性内任务 label 重复必须被拒（唯一性收窄到所属特性）",
    apply: (b) => {
      const withTwo = b.features.find((f) => (f.tasks ?? []).filter((t) => t.label).length >= 2);
      if (!withTwo) throw new Error("golden 无同特性双任务样例，无法构造变异");
      const [a, c] = withTwo.tasks.filter((t) => t.label);
      c.label = a.label;
    },
  },
  {
    name: "bad-plan-code",
    expect: "计划码形态非法（小写/长度不符）必须被拒（pattern）",
    apply: (b) => {
      const withCode = b.features.find((f) => typeof f.planCode === "string");
      if (!withCode) throw new Error("golden 无 planCode 样例，无法构造变异");
      withCode.planCode = "ui01";
    },
  },
  {
    name: "current-assignee-outside-pipeline",
    expect: "currentAssignee 与 activeRun.role 脱节（不在管线内/不等值）必须被拒（#46 A3 交叉推导）",
    apply: (b) => {
      let target = null;
      for (const f of b.features) for (const t of f.tasks ?? []) if (t.currentAssignee != null) target = t;
      if (!target) throw new Error("golden 无 currentAssignee 非空样例，无法构造变异");
      target.currentAssignee = "integrator";
    },
  },
  {
    name: "empty-section",
    expect: "计划任务 section 为空串必须被拒（出现即非空）",
    apply: (b) => {
      let target = null;
      for (const f of b.features) for (const t of f.tasks ?? []) if (typeof t.section === "string") target = t;
      if (!target) throw new Error("golden 无 section 样例，无法构造变异");
      target.section = "";
    },
  },
  {
    name: "feature-cancelled-stage-flip",
    expect: "特性级取消稿段位回落必须被拒（#66：status=cancelled → 已取消）",
    apply: (b) => {
      const target = b.features.find((f) => f.kind === "plan" && f.status === "cancelled");
      if (!target) throw new Error("golden 无特性级取消样例，无法构造变异");
      target.stage = "待办";
    },
  },
  {
    name: "all-cancelled-plan-stage-flip",
    expect: "全取消计划稿段位回落必须被拒（#66：全部子卡 cancelled → 已取消）",
    apply: (b) => {
      const flat = (f) => {
        const out = [];
        const walk = (ts) => {
          for (const t of ts ?? []) {
            out.push(t);
            walk(t.tasks);
          }
        };
        walk(f.tasks);
        return out;
      };
      const target = b.features.find(
        (f) => f.kind === "plan" && f.status !== "cancelled" && flat(f).length > 0 && flat(f).every((t) => t.status === "cancelled"),
      );
      if (!target) throw new Error("golden 无全取消计划稿样例，无法构造变异");
      target.stage = "待办";
    },
  },
  {
    name: "roadmap-cancelled-card-stage-flip",
    expect: "roadmap 稿取消卡段位回落必须被拒（#66：取消终态不让位于 roadmap 压制）",
    apply: (b) => {
      let target = null;
      for (const f of b.features) {
        if (f.roadmap !== true) continue;
        for (const t of f.tasks ?? []) if (t.status === "cancelled" && target == null) target = t;
      }
      if (!target) throw new Error("golden 无 roadmap 稿取消卡样例，无法构造变异");
      target.stage = "待设计";
    },
  },
];

function runMutation(name, schema, golden) {
  const m = MUTATIONS.find((x) => x.name === name);
  if (!m) return { name, status: "unknown", detail: `未知变异名（可用：${MUTATIONS.map((x) => x.name).join(", ")}）` };
  const board = clone(golden);
  try {
    m.apply(board);
  } catch (e) {
    return { name, status: "skip", detail: `无法构造变异：${e.message}` };
  }
  const errors = [];
  validate(schema, board, "$", errors);
  try {
    checkInvariants(board, errors);
  } catch (e) {
    errors.push(`不变量检查异常：${e.message}`);
  }
  if (errors.length === 0) return { name, status: "insensitive", detail: m.expect };
  return { name, status: "rejected", detail: errors.slice(0, 2).join(" ｜ ") };
}

// -------------------------------------------------- 输出与主流程

const lines = [];
function say(s = "") {
  lines.push(s);
  console.log(s);
}
function section(title) {
  say("");
  say(`== ${title} ==`);
}
function pass(msg) {
  say(`PASS  ${msg}`);
}
function fail(msg) {
  say(`FAIL  ${msg}`);
}

function main(argv) {
  const onlyIdx = argv.indexOf("--only");
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : "all";
  const mutateIdx = argv.indexOf("--mutate");
  const mutate = mutateIdx >= 0 ? argv[mutateIdx + 1] : null;

  say("zcode-board 契约包 v2 自验（T1）");
  say(`assets: ${ASSETS}`);
  say(`node  : ${process.version}`);
  say(`模式  : ${mutate ? `--mutate ${mutate}` : `--only ${only}`}`);

  let failures = 0;
  const record = (msg) => {
    failures += 1;
    fail(msg);
  };

  // 载入 schema 与 golden
  const schemaLoaded = loadJson(SCHEMA_PATH);
  const goldenLoaded = loadJson(GOLDEN_PATH);

  if (only !== "templates") {
    section("1. schema 关键字子集（受约束关键字：type/required/properties/items/enum/const/oneOf/pattern）");
    if (schemaLoaded.error) {
      record(`board.schema.json: ${schemaLoaded.error}`);
    } else {
      const errors = [];
      checkSchemaSubset(schemaLoaded.value, "$", errors, true);
      if (errors.length === 0) pass("board.schema.json 只使用受约束关键字子集 + 根级 x-* 元数据");
      else errors.forEach(record);
    }

    section("2. golden 样例通过 schema 子集校验");
    if (goldenLoaded.error) {
      record(`board.golden.json: ${goldenLoaded.error}`);
    } else if (schemaLoaded.error) {
      record("board.schema.json 不可用，golden 校验无法执行");
    } else {
      const errors = [];
      validate(schemaLoaded.value, goldenLoaded.value, "$", errors);
      if (errors.length === 0) pass("board.golden.json 通过 board.schema.json 子集校验");
      else errors.forEach(record);
    }

    section("3. golden 不变量（号/标签/引用位/attention/覆盖清单）");
    if (goldenLoaded.error) {
      record("golden 不可用，不变量无法检查");
    } else {
      const errors = [];
      let info = null;
      try {
        info = checkInvariants(goldenLoaded.value, errors);
      } catch (e) {
        errors.push(`不变量检查异常：${e.message}`);
      }
      if (errors.length === 0) pass("golden 全部不变量通过");
      else errors.forEach(record);
      if (info) {
        say("");
        say("覆盖清单（golden）:");
        say(`  节点      : features=${info.stats.features}, tasks=${info.stats.tasks}, 领号=${info.stats.numbered}, 未领号=${info.stats.unnumbered}`);
        say(`  状态词    : ${[...info.statusSeen].sort().join(", ")}`);
        say(`  attention : ${ATTENTION_CODES.map((c) => `${c}=${info.codeCounts[c]}`).join(", ")}`);
        say(`  blockers  : external=${info.stats.external}, dependency=${info.stats.dependency}（带号=${info.stats.dependencyWithNo}, 缺号=${info.stats.dependencyWithoutNo}）`);
        say(`  执行字段  : lastRun 非空=${info.stats.lastRunSet}/null=${info.stats.lastRunNull}, activeRun 非空=${info.stats.activeRunSet}, worktree 非空=${info.stats.worktreeSet}`);
        say(`  pr 字段   : 非空=${info.stats.prSet}/null=${info.stats.prNull}`);
        say(`  指派管线  : 标准=${info.stats.assigneesDefault}/非标准=${info.stats.assigneesCustom}`);
        say(`  计划码    : plan=${info.stats.planCodeFeature}/spec 延续=${info.stats.planCodeSpec}`);
        say(`  细节      : details 空串=${info.stats.emptyDetails}`);
      }
    }
  }

  if (only !== "golden" && !mutate) {
    section("4. 三份模板（version 1、空数组、字段齐全）");
    const errors = [];
    const results = checkTemplates(errors);
    if (errors.length === 0) {
      for (const r of results) pass(`templates/${r.file}: 顶层键/version/空数组/_note 字段清单（${r.fields} 字段）齐备`);
    } else {
      errors.forEach(record);
    }

    section("5. 契约文档（标记语法族与 run_event 规范）");
    const docErrors = [];
    const docResults = checkDocs(docErrors);
    if (docErrors.length === 0) {
      for (const r of docResults) pass(`${r.file}: 契约要点齐备（${r.tokens} 项点名核查）`);
    } else {
      docErrors.forEach(record);
    }
  }

  // 反向断言
  if (mutate || only === "all") {
    const mode = mutate ?? "all";
    section(`6. 反向断言（变异必须被校验拒绝）${mode === "all" ? " · 全部变异" : ` · ${mode}`}`);
    if (goldenLoaded.error || schemaLoaded.error) {
      record("schema/golden 不可用，反向断言无法执行");
    } else {
      const names = mode === "all" ? MUTATIONS.map((m) => m.name) : [mode];
      for (const n of names) {
        const r = runMutation(n, schemaLoaded.value, goldenLoaded.value);
        if (r.status === "rejected") pass(`变异被拒: ${n} — 首条理由：${r.detail}`);
        else if (r.status === "skip") say(`SKIP  ${n}: ${r.detail}`);
        else if (r.status === "unknown") record(`变异不存在：${n}（可用：${MUTATIONS.map((x) => x.name).join(", ")}）`);
        else record(`变异未被拒（校验不敏感）: ${n} — 期望：${r.detail}`);
      }
    }
  }

  say("");
  say(failures === 0 ? "结论: 全部通过（0 失败）" : `结论: ${failures} 项失败`);
  return failures === 0 ? 0 : 1;
}

const argv = process.argv.slice(2);
if (argv.includes("--list-mutations")) {
  for (const m of MUTATIONS) console.log(`${m.name}\t${m.expect}`);
  process.exit(0);
}
process.exit(main(argv));
