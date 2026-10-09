import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BOARD_STAGES, BOARD_STATUS_VALUES } from "../src/board/boardViewModel.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

/**
 * 看板面板的 i18n 收口守卫（卡 #35 验收：「i18n 无硬编码文案」）。
 *
 * 期望值的独立真源：`en-US.ts` / `zh-CN.ts` 两份词条表本身——键集、占位符都必须对齐；
 * 界面源码里出现的 `board.*` 字面量必须都在两张表里（拼错 key 会静默渲染成裸 key，
 * 这类坏法只有源码级扫描才拦得住）。
 */

const BOARD_SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src/board");

const boardKeys = (table: Record<string, string>): string[] =>
  Object.keys(table)
    .filter((key) => key.startsWith("board."))
    .sort();

/** 词条里的 {占位符} 集合（去重后排序）：只译一侧会露出原始花括号。 */
function placeholders(message: string | undefined): string[] {
  return [
    ...new Set([...(message ?? "").matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "")),
  ].sort();
}

test("board.* 词条两语键集逐字一致（无单边键）", () => {
  const zhKeys = boardKeys(zhCN);
  const enKeys = boardKeys(enUS);
  assert.deepEqual(enKeys, zhKeys, "两语键集必须一致（单边键 = 另一种语言静默回落裸 key）");
  assert.ok(zhKeys.length >= 88, `面板词条数应覆盖全量（实测 ${zhKeys.length}）`);
});

test("board.* 词条的占位符两语一致（{count}/{time}/… 不得只译一侧）", () => {
  for (const key of boardKeys(zhCN)) {
    assert.deepEqual(placeholders(enUS[key]), placeholders(zhCN[key]), `${key} 的占位符两语不一致`);
  }
});

test("源码里出现的 board.* 字面量都在词条表内（拼错 key 不会静默渲染成裸 key）", () => {
  const files = readdirSync(BOARD_SRC_DIR).filter(
    (name) => name.endsWith(".ts") || name.endsWith(".tsx"),
  );
  const missing: string[] = [];
  for (const file of files) {
    const source = readFileSync(join(BOARD_SRC_DIR, file), "utf8");
    for (const match of source.matchAll(/"board\.[A-Za-z0-9.]+"/g)) {
      const key = match[0].slice(1, -1);
      if (!(key in zhCN) || !(key in enUS)) missing.push(`${file}: ${key}`);
    }
  }
  assert.deepEqual(missing, [], "以下 board.* 字面量在词条表里找不到");
});

test("面板界面不出现硬编码中文文案（契约字段值除外）", () => {
  // 契约字段值（七段位/状态枚举）是机器词汇、不本地化：判定时按 `BOARD_STAGES` 词表放行，
  // 其余中文字面量一律视为「界面文案漏词条」。
  const fieldValues = new Set<string>([...BOARD_STAGES, ...BOARD_STATUS_VALUES]);
  const files = readdirSync(BOARD_SRC_DIR).filter((name) => name.endsWith(".tsx"));
  const offenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(join(BOARD_SRC_DIR, file), "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      if (/^\s*\*/.test(line) || /^\s*\/\//.test(line)) continue;
      const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
      const literals = [...code.matchAll(/"([^"]*)"/g), ...code.matchAll(/>([^<{]+)</g)];
      for (const match of literals) {
        const text = (match[1] ?? "").trim();
        if (!/[\u4e00-\u9fff]/.test(text)) continue;
        if (fieldValues.has(text)) continue;
        if (/^(data-|aria-)/.test(text)) continue;
        offenders.push(`${file}:${index + 1} ${text.slice(0, 40)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "界面文案必须走词条（硬编码中文文案应改词条）");
});
