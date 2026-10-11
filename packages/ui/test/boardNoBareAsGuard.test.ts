import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

/**
 * 「UI 不裸 as 断言」源码守卫（卡 #60/T-3；判据 = 评审 #33 轮「UI↔纯函数边界守卫去裸 as」
 * 与 T5455r S4「UI 不裸 as 断言」惯例）：板域**生产代码**（`packages/ui/src/board/`）不得出现
 * 裸类型断言——边界取值一律走类型收窄（`value is T` 守卫）、泛型或结构化取值，
 * `as const`（常量断言，不改变值的类型语义）除外。
 *
 * 范围与不采信声明：
 * - 只扫生产代码。测试夹具里的 JSON 形状标注（`structuredClone(...) as {...}` 等）不是 UI↔纯函数
 *   边界守卫，不在本守卫范围（#60/T-3 的点名点位 `boardRealSamples.test.ts` 已单独清理）。
 * - 判据面 = 剥完注释、字符串与模板串**文本**后的代码面：模板串 `${…}` 插值内的代码保留参与判定
 *   （插值可嵌套），模板文本与注释/字符串里的 "as" 不误伤；import/export 别名区（`{ X as Y }` /
 *   `* as ns`，含跨行子句）只掩别名本体，**不整行跳过**。
 * - 判据是**全局**匹配（不按行切割）：`as` 与类型跨行（`x as\n  T`）同样命中；命中按行点名列原文。
 *
 * 突变敏感（断言卡证据）：`src/board/` 生产代码的判据面出现裸 `as <类型>`，本守卫即红并点名文件与行。
 */

const BOARD_SRC_DIR = new URL("../src/board/", import.meta.url);

/** 逐字符等长空白化（换行保留）：占位后行号/列位仍与原文一致。 */
function blankRange(chars: string[], start: number, end: number): void {
  for (let index = start; index < end && index < chars.length; index += 1) {
    if (chars[index] !== "\n") chars[index] = " ";
  }
}

/**
 * 剥注释、字符串与模板串**文本**（守卫只判代码面）：模板串 `${…}` 插值内的代码保留参与判定
 * （插值内可再嵌模板串/对象字面量，花括号按深度配对）。占位符逐字符等长替换，行号与列位保持
 * 原文件一致——命中时点名的行号可直接对照源码。
 */
function stripCommentsAndStrings(source: string): string {
  const chars = source.split("");
  /** 模板文本 / 插值代码：进入模板串压栈，遇 `${` 换插值栈帧（须记花括号深度找到配对的 `}`）。 */
  type Frame = { kind: "template" } | { kind: "interp"; braces: number };
  const stack: Frame[] = [];
  let index = 0;
  while (index < chars.length) {
    const char = chars[index];
    const next = chars[index + 1];
    const top = stack[stack.length - 1];

    if (top?.kind === "template") {
      if (char === "\\") {
        blankRange(chars, index, index + 2);
        index += 2;
      } else if (char === "`") {
        blankRange(chars, index, index + 1);
        stack.pop();
        index += 1;
      } else if (char === "$" && next === "{") {
        blankRange(chars, index, index + 2);
        stack.push({ kind: "interp", braces: 0 });
        index += 2;
      } else {
        blankRange(chars, index, index + 1);
        index += 1;
      }
      continue;
    }

    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? chars.length : end + 2;
      blankRange(chars, index, stop);
      index = stop;
    } else if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? chars.length : end;
      blankRange(chars, index, stop);
      index = stop;
    } else if (char === '"' || char === "'") {
      // 与旧剥法同口径：只认同一行内配对收口的字符串字面量；未收口（如 JSX 文本里的单引号）
      // 按普通字符放行，避免把该行其后代码一并吞掉。
      let end = index + 1;
      while (end < chars.length && chars[end] !== char && chars[end] !== "\n") {
        if (chars[end] === "\\") end += 1;
        end += 1;
      }
      if (end < chars.length && chars[end] === char) {
        blankRange(chars, index, end + 1);
        index = end + 1;
      } else {
        index += 1;
      }
    } else if (char === "`") {
      blankRange(chars, index, index + 1);
      stack.push({ kind: "template" });
      index += 1;
    } else if (top?.kind === "interp" && char === "{") {
      top.braces += 1;
      index += 1;
    } else if (top?.kind === "interp" && char === "}") {
      if (top.braces === 0) stack.pop();
      else top.braces -= 1;
      blankRange(chars, index, index + 1);
      index += 1;
    } else {
      index += 1;
    }
  }
  return chars.join("");
}

/**
 * import/export 别名区掩码：`{ A as B }` / `* as ns` 的 `as` 是别名语法，不是类型断言。
 * 只掩别名子句本体（逐字符等长占位），**不整行跳过**——`export const x = y as T` 这类
 * 同行代码内的断言仍在判据面内；`import type` / 默认导入 + 具名子句 / `* as` 形态都覆盖。
 */
const ALIAS_CLAUSE_PATTERNS = [
  /(\b(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?)(\{[^{}]*\})/g,
  /(\b(?:import|export)\s+(?:type\s+)?)(\*\s+as\s+[\w$]+)/g,
];

function maskImportExportAliases(source: string): string {
  const masked = source.split("");
  for (const pattern of ALIAS_CLAUSE_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const start = (match.index ?? 0) + (match[1] ?? "").length;
      blankRange(masked, start, (match.index ?? 0) + match[0].length);
    }
  }
  return masked.join("");
}

/**
 * 裸类型断言判据：`as <类型>`；`as const` 不算（常量断言不是类型断言）。
 * 全局匹配（不按行切割）：`as` 与类型跨行（`x as\n  T`）同样命中；命中按行去重点名。
 */
const BARE_AS = /(^|[^\w$])as\s+(?!const\b)/g;

/**
 * 扫描一份源码，返回裸 `as` 命中（行号从 1 起；`text` 为命中行原文，供点名对照）。
 * 导出供反例/回归探针直接调用（见卡 #171 证据 ST-1 复验）。
 */
export function findBareAs(source: string): Array<{ line: number; text: string }> {
  const lines = source.split("\n");
  const judged = maskImportExportAliases(stripCommentsAndStrings(source));
  const newlines: number[] = [];
  for (let index = 0; index < judged.length; index += 1) {
    if (judged[index] === "\n") newlines.push(index);
  }
  const hits: Array<{ line: number; text: string }> = [];
  const reported = new Set<number>();
  for (const match of judged.matchAll(BARE_AS)) {
    // 定位 `as` 自身（非词前缀占 1 位；行首 `^` 分支占 0 位），避免把跨行命中记到类型行。
    const offset = (match.index ?? 0) + match[0].indexOf("as");
    const line = newlines.filter((newline) => newline < offset).length + 1;
    if (reported.has(line)) continue;
    reported.add(line);
    hits.push({ line, text: (lines[line - 1] ?? "").trim() });
  }
  return hits;
}

test("板域生产代码无裸 as 断言（#60/T-3：UI↔纯函数边界守卫走类型收窄，as const 除外）", () => {
  const offenders: string[] = [];
  const files = readdirSync(BOARD_SRC_DIR).sort();
  assert.ok(
    files.includes("boardNodeParts.tsx") && files.includes("boardViewsViewModel.ts"),
    `扫描目录应命中板域生产代码：${files.join(", ")}`,
  );
  for (const file of files) {
    if (!/\.tsx?$/.test(file)) continue;
    const source = readFileSync(new URL(file, BOARD_SRC_DIR), "utf8");
    for (const hit of findBareAs(source)) offenders.push(`${file}:${hit.line}: ${hit.text}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `板域生产代码不得裸 as（#60/T-3；改为类型收窄/守卫/泛型）：\n${offenders.join("\n")}`,
  );
});

test("判法自检（评审 ST-1 反例）：模板串插值内的裸 as 命中", () => {
  const fixture = "const blocked = `受阻 ${(node.blockers as unknown[]).length}`;";
  assert.deepEqual(findBareAs(fixture), [
    { line: 1, text: "const blocked = `受阻 ${(node.blockers as unknown[]).length}`;" },
  ]);
  // 插值内再嵌模板串 / 对象字面量（花括号须计数）：判定面不受括号与嵌套影响。
  const nested = "const id = `task:${flag ? `#${no as number}` : fallback}`;";
  assert.deepEqual(findBareAs(nested), [
    { line: 1, text: "const id = `task:${flag ? `#${no as number}` : fallback}`;" },
  ]);
  const braces = "const v = `x ${format({ stage: node.stage as BoardStage })}`;";
  assert.deepEqual(findBareAs(braces), [
    { line: 1, text: "const v = `x ${format({ stage: node.stage as BoardStage })}`;" },
  ]);
});

test("判法自检（评审 ST-1）：export 起始行内的裸 as 命中，别名区不误伤", () => {
  assert.deepEqual(findBareAs("export const stage = value as BoardStage;"), [
    { line: 1, text: "export const stage = value as BoardStage;" },
  ]);
  assert.deepEqual(findBareAs('export { stage as BoardStage } from "./mod.js";'), []);
});

test("判法自检（评审 ST-1）：as 与类型跨行同样命中", () => {
  assert.deepEqual(findBareAs("const carried = value as\n  BoardStage;"), [
    { line: 1, text: "const carried = value as" },
  ]);
});

test("判法自检：别名/常量断言/注释与字符串、模板文本不误伤；export 行内非别名代码仍判", () => {
  const clean = [
    'import { A as B } from "./mod.js";',
    'import type * as Ns from "./mod.js";',
    'import d, { A as B } from "./mod.js";',
    'import { type A as B } from "./mod.js";',
    'export { C as D } from "./mod.js";',
    'export * as E from "./mod.js";',
    "const f = value as const;",
    'const g = "as BoardStage";',
    "const h = 'as BoardStage';",
    "// const i = value as BoardStage;",
    "/* const j = value as BoardStage; */",
    "const k = `文本 as BoardStage`;",
  ].join("\n");
  assert.deepEqual(findBareAs(clean), []);
  // 多行具名子句（别名区跨行）同样不误伤。
  assert.deepEqual(findBareAs('import {\n  F as G,\n} from "./mod.js";'), []);
  // export 起始行内不是别名区的代码断言仍要判（不整行跳过）。
  assert.deepEqual(findBareAs("export const x = { stage: value as BoardStage };"), [
    { line: 1, text: "export const x = { stage: value as BoardStage };" },
  ]);
  assert.deepEqual(findBareAs("export default { stage: value as BoardStage };"), [
    { line: 1, text: "export default { stage: value as BoardStage };" },
  ]);
  // 字符串内的 `//`（URL）不再吞掉同行其后的代码断言（旧剥法先删行注释的同族漏判）。
  assert.deepEqual(
    findBareAs('const url = "https://example.com"; const target = value as BoardStage;'),
    [{ line: 1, text: 'const url = "https://example.com"; const target = value as BoardStage;' }],
  );
  // 未收口的引号（如 JSX 文本撇号）按普通字符放行，不吞掉同行其后的断言。
  assert.deepEqual(findBareAs("const s = 'unterminated; const target = value as BoardStage;"), [
    { line: 1, text: "const s = 'unterminated; const target = value as BoardStage;" },
  ]);
});
