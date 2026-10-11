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
 * - 源码先剥注释与字符串字面量再判，注释/文案里的 "as" 不误伤；`import { X as Y }` 别名不判。
 *
 * 突变敏感（断言卡证据）：往 `src/board/` 任一文件加一条裸 `as`，本守卫即红并点名文件与行。
 */

const BOARD_SRC_DIR = new URL("../src/board/", import.meta.url);

/**
 * 剥注释与字符串字面量：守卫只判代码面（注释/文案里的 "as" 不误伤）。
 * 占位符**逐字符等长替换**（块注释/模板串只清非换行字符），行号与列位保持原文件一致——
 * 命中时点名的行号可直接对照源码。
 */
function stripCommentsAndStrings(source: string): string {
  const blank = (text: string): string => text.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, blank)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, blank)
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, blank);
}

/** 裸类型断言判据：`as <类型>`；`as const` 不算（常量断言不是类型断言）。 */
const BARE_AS = /(^|[^\w$])as\s+(?!const\b)/;

test("板域生产代码无裸 as 断言（#60/T-3：UI↔纯函数边界守卫走类型收窄，as const 除外）", () => {
  const offenders: string[] = [];
  const files = readdirSync(BOARD_SRC_DIR).sort();
  assert.ok(
    files.includes("boardNodeParts.tsx") && files.includes("boardViewsViewModel.ts"),
    `扫描目录应命中板域生产代码：${files.join(", ")}`,
  );
  for (const file of files) {
    if (!/\.tsx?$/.test(file)) continue;
    const source = stripCommentsAndStrings(readFileSync(new URL(file, BOARD_SRC_DIR), "utf8"));
    for (const [index, line] of source.split("\n").entries()) {
      // import/export 的 `as` 是别名语法，不是类型断言；其余行出现 `as <类型>` 即裸露点。
      if (/^\s*(import|export)\b/.test(line)) continue;
      if (BARE_AS.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `板域生产代码不得裸 as（#60/T-3；改为类型收窄/守卫/泛型）：\n${offenders.join("\n")}`,
  );
});
