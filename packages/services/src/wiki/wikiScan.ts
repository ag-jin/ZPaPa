import { createHash } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import type { IFileService } from "../file/file.js";
import { WORKSPACE_PRODUCT_TOP_LEVEL_NAMES } from "../workspaceProductDirs.js";
import { WIKI_DIR_RELATIVE_PATH } from "./wikiStore.js";

/** 可遍历的源码文件扩展名 → 语言标签。用于 languageStats 与选材。 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "ts", ".tsx": "tsx", ".js": "js", ".jsx": "jsx", ".mjs": "mjs", ".cjs": "cjs",
  ".json": "json", ".md": "md", ".py": "py", ".go": "go", ".rs": "rs", ".java": "java",
  ".rb": "rb", ".php": "php", ".vue": "vue", ".svelte": "svelte", ".css": "css",
  ".scss": "scss", ".html": "html", ".yml": "yaml", ".yaml": "yaml", ".toml": "toml",
  ".sh": "sh", ".sql": "sql", ".c": "c", ".h": "h", ".cc": "cc", ".cpp": "cpp",
};

/** 这些目录一律跳过：既不是项目源码，也让清单变得不可读。 */
const SKIPPED_DIR_NAMES: ReadonlySet<string> = new Set([
  "node_modules", ".git", "dist", "build", "out", "target", "vendor",
  ".next", ".nuxt", ".cache", "coverage", "__pycache__", ".venv", "venv",
  ".idea", ".vscode",
  /* spec §13 C10 的工作区产物目录排除清单（**扫描半边**）：**不在这里手写**，改为从
     代码侧唯一来源 `packages/services/src/workspaceProductDirs.ts` 的
     `WORKSPACE_PRODUCT_DIRS` 派生（去重后的顶层目录名）。清单本体与「新增产物目录在此登记」
     的说明见仓库根 `.gitignore` 的同名段——加了清单却没同步那边，一致性测试会红。
     `.worktree/` 里是整份仓库的副本，不挡会把 N 份副本当源码吃进清单、并让 manifestHash
     每次都变；`.zcode/` 覆盖 squad / agent-memory / agent-memory-local 等全部实验命名空间产物。
     两者都**不**依赖 includeHidden 过滤——见下面 isWikiArtifactDir 处「不同实现处理不一致」的理由。 */
  ...WORKSPACE_PRODUCT_TOP_LEVEL_NAMES,
]);

const MAX_SCAN_ENTRIES = 40_000;
const MAX_README_CHARS = 8_000;

export interface WikiScanFile {
  /** 相对 workspace 根的路径，统一用 / 分隔，便于跨平台与产物一致性。 */
  path: string;
  size: number;
  language: string;
}

export interface WikiScanResult {
  files: WikiScanFile[];
  /** 语言 → 总字节数。 */
  languageStats: Record<string, number>;
  fileCount: number;
  readme: string | undefined;
  /** 清单指纹：文件路径 + 大小。用于判断项目是否变过。 */
  manifestHash: string;
}

function languageOf(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return null;
  // 无扩展名的常见脚本（Makefile 等）不计入语言统计
  return LANGUAGE_BY_EXTENSION[fileName.slice(dot).toLowerCase()] ?? null;
}

function toPosixPath(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/");
}

/**
 * 判断某个相对目录路径是否就是 wiki 产物目录本身。
 *
 * 按完整路径比较而不是「目录名等于某段」：产物在 docs/wiki，
 * 其中 docs 是用户的真实文档目录、wiki 也可能是用户的目录名，
 * 只有 docs/wiki 这一条确切路径该被跳过。
 */
function isWikiArtifactDir(relativeDir: string): boolean {
  return relativeDir === WIKI_DIR_RELATIVE_PATH;
}

/**
 * 扫描 workspace，产出清单、语言统计、README 与 manifestHash。
 *
 * 只扫不读正文：正文由模型按需通过 filePaths 引用，避免把整个仓库塞进一次请求。
 * 读取走注入的 IFileService（它是只读的，正好够用）。
 */
export async function scanWikiWorkspace(params: {
  workspacePath: string;
  fileService: IFileService;
}): Promise<WikiScanResult> {
  const root = resolve(params.workspacePath);
  const files: WikiScanFile[] = [];
  const languageStats: Record<string, number> = {};

  // 显式栈遍历，避免深仓库递归爆栈，也便于随时按 MAX_SCAN_ENTRIES 截断。
  const queue: string[] = [""];
  while (queue.length > 0 && files.length < MAX_SCAN_ENTRIES) {
    const dir = queue.shift()!;
    let entries: Awaited<ReturnType<IFileService["readdir"]>>;
    try {
      entries = await params.fileService.readdir({ path: dir || ".", includeHidden: false });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // 不同 IFileService 实现是否过滤 "." / ".." 不一致；不过滤会让遍历原地打转。
      if (entry.name === "." || entry.name === "..") continue;
      const childPath = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.type === "directory") {
        if (SKIPPED_DIR_NAMES.has(entry.name)) continue;
        // 产物目录必须显式排除：虽然 includeHidden:false 通常已过滤掉 .wiki，
        // 但不同 IFileService 实现对隐藏项的处理不一致，这里再挡一次，
        // 否则产物会被算进 manifestHash，导致每次生成后「项目都变了」。
        if (isWikiArtifactDir(childPath)) continue;
        queue.push(childPath);
        continue;
      }
      const language = languageOf(entry.name);
      if (!language) continue;
      // stat 的 size 在旧远端服务端可能不返回；缺失时按 0 计，不影响路径指纹。
      let size = 0;
      try {
        const stat = await params.fileService.stat({ path: childPath });
        size = typeof stat.size === "number" ? stat.size : 0;
      } catch {
        size = 0;
      }
      files.push({ path: childPath, size, language });
      languageStats[language] = (languageStats[language] ?? 0) + size;
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  const readme = await readWorkspaceReadme({ root, fileService: params.fileService });

  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file.path}:${file.size}\n`);
  hash.update(readme ?? "");

  return {
    files,
    languageStats,
    fileCount: files.length,
    readme,
    manifestHash: hash.digest("hex"),
  };
}

async function readWorkspaceReadme(params: {
  root: string;
  fileService: IFileService;
}): Promise<string | undefined> {
  for (const name of ["README.md", "readme.md", "Readme.md", "README.MD"]) {
    try {
      const result = await params.fileService.readTextFile({ path: name });
      if (result.content) return result.content.slice(0, MAX_README_CHARS);
    } catch {
      // 逐个候选试；都不存在就不给 readme
    }
  }
  return undefined;
}

/**
 * 把扫描结果压成「给模型看的清单」。
 *
 * 按目录聚合，只保留路径与体量，避免单文件清单在大型仓库里吃掉全部上下文预算。
 */
export function buildManifestDigest(scan: WikiScanResult, maxChars = 24_000): string {
  const byDir = new Map<string, WikiScanFile[]>();
  for (const file of scan.files) {
    const slash = file.path.lastIndexOf("/");
    const dir = slash < 0 ? "." : file.path.slice(0, slash);
    const list = byDir.get(dir);
    if (list) list.push(file);
    else byDir.set(dir, [file]);
  }

  const lines: string[] = [];
  for (const dir of [...byDir.keys()].sort()) {
    const files = byDir.get(dir)!;
    const total = files.reduce((sum, file) => sum + file.size, 0);
    lines.push(`${dir}/ (${files.length} 文件, ${formatBytes(total)})`);
    // 单目录文件过多时只列前若干个，其余折叠 —— 提示模型这是概览而非全量。
    const preview = files.slice(0, 40);
    for (const file of preview) {
      lines.push(`  ${file.path.slice(dir === "." ? 0 : dir.length + 1)} (${formatBytes(file.size)})`);
    }
    if (files.length > preview.length) {
      lines.push(`  … 另有 ${files.length - preview.length} 个文件`);
    }
    if (lines.join("\n").length > maxChars) {
      lines.push("… 清单已截断");
      break;
    }
  }
  return lines.join("\n").slice(0, maxChars);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** workspace 显示名：取路径最后一段；根路径时回退整条路径。 */
export function workspaceDisplayName(workspacePath: string): string {
  const root = resolve(workspacePath);
  const parts = root.split(sep).filter(Boolean);
  return parts[parts.length - 1] ?? root;
}

/** 相对路径（统一 / 分隔），用于产物里的 filePaths。 */
export function relativeWorkspacePath(workspacePath: string, absolutePath: string): string {
  return toPosixPath(relative(resolve(workspacePath), resolve(absolutePath)));
}
