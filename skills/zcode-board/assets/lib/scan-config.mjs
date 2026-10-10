#!/usr/bin/env node
/**
 * zcode-board / 扫描面配置（契约 v2.4，卡 #72）
 *
 * 背景（远端实战）：编译器曾把 `.zcode/plans/`、`docs/plans/`、`docs/design-notes/` 三个目录
 * 硬编码为计划稿扫描面——远端新赛马项目的 `docs/design-notes/` 有 296 份活历史档，默认编译把
 * 整批吸上板、`--assign` 逐份盖号改写。契约 v2.4 起：
 *   - **默认扫描面收窄为 `.zcode/plans/` 一处**（破坏性变更 → 包版本 0.4.0）；
 *   - `docs/plans/`、`docs/design-notes/` 移入 **opt-in 目录池**，由项目级配置
 *     `.zcode/board/scan.json` 显式开启：
 *       { "includeDirs": ["docs/design-notes", ...], "excludeGlobs": ["**&#47;archive/**", ...] }
 *   - `includeDirs` 只能引用池内目录（池外引用 → 失败级诊断 + 拒绝该条，防把任意目录当计划源）；
 *   - 配置读取失败（坏 JSON / 结构非法）→ 失败级诊断 + 按默认 `.zcode/plans` 兜底（不猜）。
 *
 * 本模块是扫描面的唯一解析点：编译器三态（默认编译 / `--assign` / `--check`）与 hooks 共用，
 * 保证"编译器扫什么"与"hook 认什么源"同源。
 *
 * 无第三方依赖（仅 node 内置）。
 */

import { join } from "node:path";

import { readJsonFile } from "./board-io.mjs";

/** 项目级扫描面配置相对路径（存在即解析）。 */
export const SCAN_CONFIG_REL = ".zcode/board/scan.json";
/** 默认扫描面（冻结：苗圃一处；契约 v2.4 起 docs 计划目录不再默认扫描）。 */
export const DEFAULT_PLAN_DIRS = Object.freeze([".zcode/plans"]);
/** opt-in 目录池（`includeDirs` 的合法取值；冻结序 = 扫描序，只可整体引用、不可改序）。 */
export const OPT_IN_PLAN_DIRS = Object.freeze(["docs/plans", "docs/design-notes"]);

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** includeDirs 条目归一：trim、反斜杠转 posix、去 `./` 前缀与末尾 `/`；非法（空/绝对/`..` 穿越/非字符串）→ null。 */
function normalizeDirRef(raw) {
  if (typeof raw !== "string") return null;
  let t = raw.trim().split("\\").join("/");
  while (t.startsWith("./")) t = t.slice(2);
  t = t.replace(/\/+$/, "");
  if (t === "" || t.startsWith("/") || t.split("/").includes("..")) return null;
  return t;
}

/**
 * glob → RegExp（对项目根相对 posix 路径匹配；`excludeGlobs` 的语法成文见 markers.md v2.4）：
 *   - `**&#47;` 前缀：零个或多个完整路径段（`**&#47;archive/**` 匹配 `archive/x.md` 与 `docs/archive/x.md`）；
 *   - `**`：任意字符（含 `/`）；`*`：单段内任意字符（不含 `/`）；`?`：单段内单字符；
 *   - 其余字符字面匹配（正则元字符转义）。
 */
export function globToRegExp(glob) {
  let re = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") {
          i += 1;
          re += "(?:[^/]+/)*";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      continue;
    }
    re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${re}$`);
}

/** 项目根相对路径是否命中任一排除模式。 */
export function matchesAnyGlob(rel, globs) {
  return (globs ?? []).some((g) => globToRegExp(g).test(rel));
}

/**
 * 解析项目扫描面：返回有效扫描目录（确定性顺序：默认苗圃 → 池内冻结序）与排除模式。
 * 返回 { rel, present, includeDirs, excludeGlobs, planDirs, errors }：
 *   - errors: 失败级诊断（{path, message}）——编译器落 diagnostics；`--check` 另作失败项；
 *   - 解析失败/结构非法（坏 JSON）→ 整份配置拒收，planDirs 回落默认。
 *   - 条目级非法（形态非法 / 池外引用 / 未知字段）→ 该条拒绝并点名；其余合法条目照常生效。
 */
export function loadScanConfig(root) {
  const rel = SCAN_CONFIG_REL;
  const loaded = readJsonFile(join(root, rel));
  const fallback = (errors) => ({
    rel,
    present: true,
    includeDirs: [],
    excludeGlobs: [],
    planDirs: [...DEFAULT_PLAN_DIRS],
    errors,
  });
  if (loaded.missing) {
    return { rel, present: false, includeDirs: [], excludeGlobs: [], planDirs: [...DEFAULT_PLAN_DIRS], errors: [] };
  }
  if (!loaded.ok) {
    return fallback([
      {
        path: rel,
        message: `scan.json 解析失败（${loaded.error}）：整份配置拒收，扫描面按默认 .zcode/plans/ 兜底（不猜）——请修复后重编译。`,
      },
    ]);
  }
  if (!isPlainObject(loaded.value)) {
    return fallback([
      { path: rel, message: "scan.json 顶层不是对象（期望 { includeDirs, excludeGlobs }）：整份配置拒收，扫描面按默认 .zcode/plans/ 兜底（不猜）。" },
    ]);
  }
  const value = loaded.value;
  const errors = [];
  const includeDirs = [];
  const excludeGlobs = [];

  for (const key of Object.keys(value)) {
    if (key === "includeDirs" || key === "excludeGlobs") continue;
    errors.push({ path: rel, message: `scan.json 未知字段 ${JSON.stringify(key)}（仅支持 includeDirs / excludeGlobs）：该字段忽略（不猜）。` });
  }

  if (value.includeDirs !== undefined) {
    if (!Array.isArray(value.includeDirs)) {
      errors.push({ path: rel, message: "scan.json includeDirs 不是数组：该字段拒绝（不猜，不部分接受）。" });
    } else {
      value.includeDirs.forEach((raw, i) => {
        const dir = normalizeDirRef(raw);
        if (dir === null) {
          errors.push({
            path: rel,
            message: `scan.json includeDirs[${i}]=${JSON.stringify(raw)} 形态非法（应为项目根相对目录，禁绝对路径与 .. 穿越）：该条拒绝。`,
          });
          return;
        }
        if (!OPT_IN_PLAN_DIRS.includes(dir)) {
          errors.push({
            path: rel,
            message:
              `scan.json includeDirs[${i}]=${JSON.stringify(dir)} 引用 opt-in 池外目录：拒绝（池仅 ${OPT_IN_PLAN_DIRS.join("、")}；` +
              "默认扫描面 .zcode/plans/ 恒生效、无需列出——防把任意目录当计划源）。",
          });
          return;
        }
        if (!includeDirs.includes(dir)) includeDirs.push(dir);
      });
    }
  }

  if (value.excludeGlobs !== undefined) {
    if (!Array.isArray(value.excludeGlobs)) {
      errors.push({ path: rel, message: "scan.json excludeGlobs 不是数组：该字段拒绝（不猜，不部分接受）。" });
    } else {
      value.excludeGlobs.forEach((raw, i) => {
        if (typeof raw !== "string" || raw.trim() === "") {
          errors.push({
            path: rel,
            message: `scan.json excludeGlobs[${i}]=${JSON.stringify(raw)} 形态非法（应为非空 glob 字符串，如 "**/archive/**"）：该条拒绝。`,
          });
          return;
        }
        if (!excludeGlobs.includes(raw)) excludeGlobs.push(raw);
      });
    }
  }

  // 生效扫描序 = 默认苗圃 → 池内冻结序（与书写顺序无关：保住 T9 发号确定性，一经启用不得更改）。
  const planDirs = [...DEFAULT_PLAN_DIRS, ...OPT_IN_PLAN_DIRS.filter((d) => includeDirs.includes(d))];
  return { rel, present: true, includeDirs, excludeGlobs, planDirs, errors };
}
