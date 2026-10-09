import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SERVICES_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const INDEX_FILE = join(SERVICES_SRC, "index.ts");

const NODE_BUILTIN_RE = /^node:/;

/**
 * 从源码里抽出「会形成运行时依赖」的模块说明符。
 *
 * 关键区分：`import type {...} from "x"` 与 `export type {...} from "x"`
 * 在编译后被完全擦除，不构成浏览器侧的运行时依赖；而值导入/值再导出会。
 * 只有后者才可能让 renderer 解析到 node:* 而整包失败。
 */
function collectValueSpecifiers(source: string): string[] {
  const specifiers: string[] = [];

  // 去掉 `import type` / `export type` 语句（含多行花括号形式）。
  const withoutTypeStatements = source.replace(
    /(?:^|\n)\s*(?:import|export)\s+type\b[\s\S]*?from\s*["'][^"']+["']\s*;?/g,
    "\n",
  );

  // 去掉内联 type 说明符：`import { type A, B } from "x"` 里的 A 是类型，
  // 但整条语句仍可能有值（B），所以这里只用于判断「是否只剩类型」。
  const valueImportRe = /(?:^|\n)\s*(?:import|export)\s*([\s\S]*?)\s*from\s*["']([^"']+)["']\s*;?/g;
  valueImportRe.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = valueImportRe.exec(withoutTypeStatements)) !== null) {
    const clause = match[1] ?? "";
    const specifier = match[2]!;
    // 花括号内全是 `type X` 时，整条语句等价于 type-only，可忽略。
    const braceMatch = /\{([\s\S]*?)\}/.exec(clause);
    if (braceMatch) {
      const names = braceMatch[1]!
        .split(",")
        .map((piece) => piece.trim())
        .filter(Boolean);
      const allTypes = names.length > 0 && names.every((name) => /^type\s/.test(name));
      const hasDefaultOrNamespace = /^\s*(?:\*\s+as\s+\w+|\w+)\s*,?\s*$/.test(
        clause.replace(/\{[\s\S]*?\}/, "").replace(/,\s*$/, ""),
      );
      if (allTypes && !hasDefaultOrNamespace) continue;
    }
    specifiers.push(specifier);
  }

  // 副作用导入：`import "x"`
  const bareRe = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  bareRe.lastIndex = 0;
  while ((match = bareRe.exec(source)) !== null) specifiers.push(match[1]!);

  return specifiers;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** 相对说明符 → 真实源码文件（源码写 .js，磁盘上是 .ts/.tsx）。 */
async function resolveSourceFile(baseDir: string, specifier: string): Promise<string | null> {
  const target = resolve(baseDir, specifier);
  const stripped = target.replace(/\.js$/, "");
  for (const candidate of [
    stripped + ".ts",
    stripped + ".tsx",
    target,
    join(stripped, "index.ts"),
  ]) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

/** 递归收集从根入口可达、且会形成运行时依赖的源码模块。 */
async function collectRuntimeReachable(
  entry: string,
  seen = new Set<string>(),
): Promise<Set<string>> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const source = await readFile(entry, "utf8");
  for (const specifier of collectValueSpecifiers(source)) {
    if (!specifier.startsWith(".")) continue;
    const resolved = await resolveSourceFile(dirname(entry), specifier);
    if (resolved) await collectRuntimeReachable(resolved, seen);
  }
  return seen;
}

/**
 * 根入口 browser-safe 守卫（值依赖视角）。
 *
 * `packages/services` 根入口被 renderer 直接解析，只要有一条**运行时**依赖链
 * 触达 node:* 内建，整包会在 React 挂载前失败。现场表现极具迷惑性：
 * 页面永远停在启动壳，没有 vite 报错浮层、没有 pending 请求、资源全部 200。
 *
 * 注意只检查值依赖：`import type` / `export type` 会被编译擦除，是安全的。
 */
test("@zcode/services 根入口的值依赖不得触达 node:* 内建", async () => {
  const reachable = await collectRuntimeReachable(INDEX_FILE);
  assert.ok(reachable.size > 1, `应能收集到多个模块，实际 ${reachable.size}`);

  const offenders: Array<{ file: string; specifier: string }> = [];
  for (const file of reachable) {
    const source = await readFile(file, "utf8");
    for (const specifier of collectValueSpecifiers(source)) {
      if (NODE_BUILTIN_RE.test(specifier)) {
        offenders.push({ file: file.replace(SERVICES_SRC, ""), specifier });
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `根入口的运行时依赖触达了 node:*（会让 renderer 在挂载前整包失败）：\n${offenders
      .map((o) => `  ${o.file} → ${o.specifier}`)
      .join("\n")}\n` + "修复：把实现移到 @zcode/services/node，或把引用改为 `import type`。",
  );
});

test("守卫自身有效：wikiStore 确实有 node:* 值依赖（证明检查不是空转）", async () => {
  const source = await readFile(join(SERVICES_SRC, "wiki/wikiStore.ts"), "utf8");
  const valueSpecifiers = collectValueSpecifiers(source);
  assert.ok(
    valueSpecifiers.some((s) => NODE_BUILTIN_RE.test(s)),
    "wikiStore 应有 node:* 值依赖，否则本守卫失去意义",
  );
});

test("守卫能识别 type-only 引用为安全（terminalProfile 是类型引用）", async () => {
  const terminal = await readFile(join(SERVICES_SRC, "terminal/terminal.ts"), "utf8");
  // terminal.ts 用 `import type` 引用 terminalProfile，不应被当作运行时依赖
  assert.ok(
    !collectValueSpecifiers(terminal).includes("./terminalProfile.js"),
    "type-only 引用不应被计为运行时依赖",
  );
});
