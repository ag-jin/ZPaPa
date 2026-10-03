import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isWorkspaceFileSearchPathIgnored,
  loadWorkspaceFileSearchIgnoreRules,
} from "../src/file/workspaceFileIgnore.js";
import {
  WORKSPACE_PRODUCT_DIRS,
  WORKSPACE_PRODUCT_TOP_LEVEL_NAMES,
} from "../src/workspaceProductDirs.js";

/* 硬约束 3 的落点（spec §17 表 `spec:675` 的闭合件）：C10 清单必须进**不依赖 workspace 状态**的
   那半边 —— `BUILTIN_IGNORE_LINES`（`workspaceFileIgnore.ts:47`）。

   为什么不能只靠「按 .gitignore 拷贝生成 .zcodeignore」这半边：**无 `.gitignore` 的 workspace**
   与**已有旧 `.zcodeignore` 的 workspace** 都拿不到 C10 那几条（前者走内置模板、后者走既有文件，
   两条路都不经过 .gitignore 拷贝），而这两类恰恰最常见。后果是 `.worktree/` 里 N 份仓库副本
   被索引/搜索吃进、`manifestHash` 漂移 —— **不报错**。

   本文件把「唯一来源派生」与「真的生效」都变成断言：前半是源码级（防止有人再抄一份清单），
   后半是行为级（用真实的「从零创建」路径证明那几条真的进了排除规则）。 */

const SOURCE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../src/file/workspaceFileIgnore.ts"),
  "utf8",
);

test("BUILTIN_IGNORE_LINES 从 WORKSPACE_PRODUCT_DIRS 派生的集合取（不新增第三份清单）", () => {
  // 唯一来源仍是 `workspaceProductDirs.ts`：模板必须 import 它派生的顶层名集合。
  assert.match(
    SOURCE,
    /WORKSPACE_PRODUCT_TOP_LEVEL_NAMES/,
    "内置模板必须从 workspaceProductDirs 派生的集合取，而不是自己再手写一份 C10 清单",
  );
  // 并且真的把它**展开**进内置清单（只 import 不展开 = 清单还是手写的，新增一条要改两处）。
  assert.match(
    SOURCE,
    /\.\.\.\[\s*\.\.\.WORKSPACE_PRODUCT_TOP_LEVEL_NAMES\s*\]/,
    "BUILTIN_IGNORE_LINES 必须由派生集合展开而来",
  );
});

test("内置模板里没有手写的 .worktree/ / .zcode/ 字面量（否则「要改 2–3 处」的老问题回来了）", () => {
  // 反向断言：这两条一旦被手写回来，就说明派生链断了（改了常量而模板不再跟着走）。
  assert.doesNotMatch(SOURCE, /"\.worktree\/"/);
  assert.doesNotMatch(SOURCE, /"\.zcode\//);
});

test("从零创建的 workspace（无 .gitignore）也吃得到 C10 全部清单项", async () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-ignore-"));
  // 关键前提：**不写 .gitignore** —— 这正是「半边失效」里最常见的一类 workspace
  // （走 buildBuiltinDefaultsSection(null) 的内置模板那条路）。
  const rules = await loadWorkspaceFileSearchIgnoreRules(ws);
  assert.equal(rules.source, "created-from-template", "无 .gitignore ⇒ 必须是内置模板来源");

  for (const dir of WORKSPACE_PRODUCT_DIRS) {
    // 逐条断言的是**实际行为**（matcher 真的忽略它），不是模板文本里出现过这个词：
    // 文案级断言会被「写了但不生效」（例如后缀写成 `**/x`、大小写不符）骗过去。
    const top = dir.split("/")[0]!;
    assert.equal(
      isWorkspaceFileSearchPathIgnored(rules, top, "directory"),
      true,
      `${top}/ 必须被内置模板排除（C10 清单项 ${dir}）`,
    );
    assert.equal(
      isWorkspaceFileSearchPathIgnored(rules, `${top}/inner.ts`, "file"),
      true,
      `${top}/ 下的文件必须一并排除（C10 清单项 ${dir}）`,
    );
  }
  // 反向对照：普通源码目录不能被误伤（否则「一律忽略」式实现也会通过）。
  assert.equal(isWorkspaceFileSearchPathIgnored(rules, "src", "directory"), false);
  assert.equal(isWorkspaceFileSearchPathIgnored(rules, "src/index.ts", "file"), false);
  // 顶层名集合与清单是同一来源的两个投影：这里顺带钉住它的形状（清单项的顶层段）。
  assert.deepEqual(
    [...WORKSPACE_PRODUCT_TOP_LEVEL_NAMES].sort(),
    [...new Set(WORKSPACE_PRODUCT_DIRS.map((dir) => dir.split("/")[0]!))].sort(),
  );

  rmSync(ws, { recursive: true, force: true });
});
