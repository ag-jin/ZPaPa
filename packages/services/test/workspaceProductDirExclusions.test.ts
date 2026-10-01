import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IFileService } from "../src/file/file.js";
import {
  isWorkspaceFileSearchPathIgnored,
  loadWorkspaceFileSearchIgnoreRules,
} from "../src/file/workspaceFileIgnore.js";
import { WORKSPACE_PRODUCT_DIRS } from "../src/workspaceProductDirs.js";
import { WIKI_DIR_RELATIVE_PATH } from "../src/wiki/wikiStore.js";
import { scanWikiWorkspace } from "../src/wiki/wikiScan.js";

/* spec §13 C10：工作区产物目录的排除清单**集中一处维护**，同时驱动 gitignore 与扫描排除。
   本文件把「集中一处」与「两处生效」都变成断言，而不是注释里的承诺：
   ① 代码侧唯一来源是 `../src/workspaceProductDirs.js` 的 `WORKSPACE_PRODUCT_DIRS`
      （wiki 扫描与下面的 PRODUCT_DIRS 都从它派生，不再各写一份清单）；
   ② 仓库根 `.gitignore` 必须逐条登记该常量的每一项（见第一条测试的验收判据）；
   ③ 文件搜索半边：把这份 `.gitignore` 交给既有的 `.zcodeignore` 生成机制，产物目录必须被忽略；
   ④ 服务端扫描半边：wiki 清单扫描也必须挡住同一批目录（`.worktree/` 是整份仓库的副本，
      不挡会让清单膨胀 N 倍且 manifestHash 永远在变）。 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** 排除清单：正文来自代码侧唯一来源；`.wiki/` 的目录名归 wiki 模块自己的常量所有，
    一并锁住（它也是同类产物目录，已登记在同一段 `.gitignore` 里）。 */
const PRODUCT_DIRS: readonly string[] = [...WORKSPACE_PRODUCT_DIRS, WIKI_DIR_RELATIVE_PATH];

/* 验收判据（复审裁定）：改 `WORKSPACE_PRODUCT_DIRS` 而**不**改仓库根 `.gitignore` → 本测试必红。
   于是「新增一个产物目录」的标准动作只剩两处且强制同步：改常量（唯一来源）+ 改 `.gitignore`。 */
test("仓库根 .gitignore 逐条登记了代码侧清单的每一项", () => {
  const raw = readFileSync(join(REPO_ROOT, ".gitignore"), "utf8");
  // 取规则行：去空行/注释，再去掉首尾的 `/`（`/.worktree/` 与 `.worktree` 归一化后可比）。
  const rules = new Set(
    raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => line.replace(/^\/+/, "").replace(/\/+$/, "")),
  );
  for (const dir of PRODUCT_DIRS) {
    assert.ok(
      rules.has(dir),
      `仓库根 .gitignore 缺少产物目录「${dir}」的规则——改了清单常量却没同步 .gitignore？`,
    );
  }
});

test("仓库根 .gitignore 登记了全部产物目录，并驱动文件搜索的排除规则", async () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  writeFileSync(join(ws, ".gitignore"), readFileSync(join(REPO_ROOT, ".gitignore"), "utf8"));
  // 走既有机制：workspace 没有 .zcodeignore 时按 .gitignore 拷贝自动创建 —— 这正是
  // 「一处维护、两处生效」的耦合点，所以「新目录只加 .gitignore」才够。
  const rules = await loadWorkspaceFileSearchIgnoreRules(ws);
  assert.equal(rules.source, "created-from-gitignore");
  for (const dir of PRODUCT_DIRS) {
    assert.equal(
      isWorkspaceFileSearchPathIgnored(rules, dir, "directory"),
      true,
      `${dir} 目录应被排除`,
    );
    assert.equal(
      isWorkspaceFileSearchPathIgnored(rules, `${dir}/sample.ts`, "file"),
      true,
      `${dir} 下的文件应被排除`,
    );
  }
  // 反向对照：普通源码目录不能被误伤，否则「一律忽略」式实现也会通过。
  assert.equal(isWorkspaceFileSearchPathIgnored(rules, "src/index.ts", "file"), false);
});

/**
 * 最小 IFileService：读真实临时目录做路径行为，不用桩假装 fs。
 * **刻意不实现 includeHidden 过滤**——wikiScan 的注释写明「不同 IFileService 实现对隐藏项的
 * 处理不一致，产物目录必须显式排除」，这里就是那个场景：隐藏项被返回时，显式排除必须自己挡住。
 */
function realFsFileService(root: string): IFileService {
  return {
    async readdir(params: { path: string }) {
      const relativeDir = params.path === "." ? "" : params.path;
      const absoluteDir = relativeDir ? join(root, relativeDir) : root;
      return readdirSync(absoluteDir, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        path: relativeDir ? `${relativeDir}/${entry.name}` : entry.name,
        type: entry.isDirectory() ? ("directory" as const) : ("file" as const),
      }));
    },
    async stat(params: { path: string }) {
      const stats = statSync(join(root, params.path));
      return {
        path: params.path,
        type: stats.isDirectory() ? ("directory" as const) : ("file" as const),
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      };
    },
    async readTextFile(params: { path: string }) {
      const content = readFileSync(join(root, params.path), "utf8");
      return {
        path: params.path,
        content,
        offset: 0,
        bytesRead: content.length,
        totalBytes: content.length,
        truncated: false,
        isBinary: false,
      };
    },
  } as unknown as IFileService;
}

test("wiki 扫描（服务端扫描半边）跳过产物目录，不把工作树与命名空间当源码", async () => {
  const root = mkdtempSync(join(tmpdir(), "ws-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), "export const a = 1;\n");
  // 工作树是整份仓库的副本：不排除就会把 N 份副本当源码吃进清单。
  mkdirSync(join(root, ".worktree", "wi-1", "src"), { recursive: true });
  writeFileSync(join(root, ".worktree", "wi-1", "src", "copy.ts"), "export const b = 2;\n");
  // 实验命名空间下的定义文件同样是产物（.json 会被 languageOf 计入，故能证明被挡住）。
  mkdirSync(join(root, ".zcode", "squad", "agents"), { recursive: true });
  writeFileSync(join(root, ".zcode", "squad", "agents", "ta_1.json"), "{}\n");
  // local scope 记忆（本次清单新增项）：同样是产物，不能当源码吃进清单。
  mkdirSync(join(root, ".zcode", "agent-memory-local", "ta_1"), { recursive: true });
  writeFileSync(join(root, ".zcode", "agent-memory-local", "ta_1", "MEMORY.md"), "# 记忆\n");
  mkdirSync(join(root, ".wiki", "pages"), { recursive: true });
  writeFileSync(join(root, ".wiki", "pages", "generated.md"), "# 生成物\n");

  const scan = await scanWikiWorkspace({
    workspacePath: root,
    fileService: realFsFileService(root),
  });
  assert.deepEqual(
    scan.files.map((file) => file.path),
    ["src/index.ts"],
  );
});
