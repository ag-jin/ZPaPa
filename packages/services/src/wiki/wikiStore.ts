import { createHash } from "node:crypto";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { atomicWriteJson } from "../fs/atomicFileUtils.js";
import type {
  WikiCatalogNode,
  WikiDocument,
  WikiDraftDocument,
  WikiPage,
  WikiSummary,
  WikiTaskState,
} from "./wikiTypes.js";
import { countWikiPageNodes } from "./wikiTypes.js";

/**
 * 产物目录（相对 workspace 根）。
 *
 * 用点开头的 `.wiki`：不算项目源码、不干扰目录浏览，也不会被
 * 扫描当作项目内容算进 manifestHash。单段路径，位于仓库根。
 */
export const WIKI_DIR_RELATIVE_PATH = ".wiki";

/**
 * 产物目录的路径段，供扫描时按路径精确跳过。
 *
 * 不能用「目录名等于 wiki 就跳过」这种按名匹配：用户项目里可能本来就有
 * 叫 wiki 的目录，那样会被误跳过。只跳过这一条确切路径。
 */
export const WIKI_DIR_SEGMENTS: readonly string[] = WIKI_DIR_RELATIVE_PATH.split("/");

/** @deprecated 用 WIKI_DIR_RELATIVE_PATH；保留别名避免改动面扩大。 */
export const WIKI_DIR_NAME = WIKI_DIR_RELATIVE_PATH;

export interface WikiStorePaths {
  /** 产物根目录（通常是 <workspace>/.wiki）。 */
  root: string;
  wikiFile: string;
  taskFile: string;
  draftFile: string;
  draftPagesDir: string;
}

/** 计算某个 workspace 的产物路径。 */
export function resolveWikiStorePaths(workspacePath: string): WikiStorePaths {
  const root = join(resolve(workspacePath), ...WIKI_DIR_SEGMENTS);
  return {
    root,
    wikiFile: join(root, "wiki.json"),
    taskFile: join(root, "task.json"),
    draftFile: join(root, "draft.json"),
    draftPagesDir: join(root, "draft-pages"),
  };
}

/**
 * 单页文件名：sha256(pageId) 前 16 位。
 *
 * 用哈希而不是原始 id 做文件名，既与历史产物一致，也避免模型产出的
 * pageId 直接进入路径（路径穿越）。
 */
export function wikiPageFileName(pageId: string): string {
  return `${createHash("sha256").update(pageId).digest("hex").slice(0, 16)}.json`;
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    // ENOENT（未生成过）与损坏 JSON 都按「没有」处理：产物是派生数据，
    // 读不出来应当降级为「无 wiki」，不能让 UI 因一个坏文件整体崩掉。
    return null;
  }
}

/**
 * 归一化一份 wiki 文档。
 *
 * 历史产物有两个 schema 版本：旧版只有 generationModel，新版多 modelSelection，
 * 且 maxOutputTokens 从 16384 变为 65536。这里统一补齐缺省字段，
 * 让上层只面对一种形状。
 */
export function normalizeWikiDocument(raw: unknown): WikiDocument | null {
  if (!raw || typeof raw !== "object") return null;
  const doc = raw as Partial<WikiDocument>;
  if (typeof doc.wikiId !== "string") return null;

  const pages: WikiPage[] = Array.isArray(doc.pages)
    ? doc.pages.filter((page): page is WikiPage => !!page && typeof page.id === "string")
    : [];
  const catalogTree: WikiCatalogNode[] = Array.isArray(doc.catalogTree) ? doc.catalogTree : [];

  return {
    ...doc,
    wikiId: doc.wikiId,
    repoId: doc.repoId ?? doc.workspaceKey ?? "",
    workspaceKey: doc.workspaceKey ?? "",
    workspacePath: doc.workspacePath ?? "",
    manifestHash: doc.manifestHash ?? "",
    catalogTree,
    pages,
  };
}

/** 读取一份 wiki；不存在或不可读时返回 null。 */
export async function readWikiDocument(workspacePath: string): Promise<WikiDocument | null> {
  const paths = resolveWikiStorePaths(workspacePath);
  return normalizeWikiDocument(await readJsonIfExists<unknown>(paths.wikiFile));
}

/** 读取生成任务状态。 */
export async function readWikiTaskState(workspacePath: string): Promise<WikiTaskState | null> {
  const paths = resolveWikiStorePaths(workspacePath);
  return await readJsonIfExists<WikiTaskState>(paths.taskFile);
}

/**
 * 读取生成草稿。
 *
 * 草稿比正式产物更「新」：生成中途失败时 wiki.json 可能还没写，
 * 但 draft.json 已经记下了目录树与已完成页面 —— 断点续跑靠它。
 */
export async function readWikiDraft(workspacePath: string): Promise<WikiDraftDocument | null> {
  const paths = resolveWikiStorePaths(workspacePath);
  const raw = await readJsonIfExists<WikiDraftDocument>(paths.draftFile);
  if (!raw) return null;
  const normalized = normalizeWikiDocument(raw);
  if (!normalized) return null;
  return {
    ...normalized,
    taskId: raw.taskId ?? "",
    generatedPageIds: Array.isArray(raw.generatedPageIds) ? raw.generatedPageIds : [],
  };
}

/** 读取 draft-pages 目录下所有已落盘的单页。 */
export async function readDraftPages(workspacePath: string): Promise<WikiPage[]> {
  const paths = resolveWikiStorePaths(workspacePath);
  let names: string[];
  try {
    names = await readdir(paths.draftPagesDir);
  } catch {
    return [];
  }
  const pages: WikiPage[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const page = await readJsonIfExists<WikiPage>(join(paths.draftPagesDir, name));
    if (page && typeof page.id === "string") pages.push(page);
  }
  return pages;
}

/**
 * 取「最完整的」一份 wiki：优先正式产物，其次草稿。
 *
 * 生成中途或生成失败时只有草稿可用，此时仍应能读到目录树与已完成页面。
 */
export async function readBestWiki(
  workspacePath: string,
): Promise<{ document: WikiDocument; task: WikiTaskState | null; fromDraft: boolean } | null> {
  const [wiki, draft, task] = await Promise.all([
    readWikiDocument(workspacePath),
    readWikiDraft(workspacePath),
    readWikiTaskState(workspacePath),
  ]);

  // 草稿页数更多说明它更完整（生成中途 wiki.json 还是旧的）。
  if (draft && wiki) {
    const useDraft = draft.pages.length > wiki.pages.length;
    return { document: useDraft ? draft : wiki, task, fromDraft: useDraft };
  }
  if (wiki) return { document: wiki, task, fromDraft: false };
  if (draft) return { document: draft, task, fromDraft: true };
  return null;
}

/** 列出该 workspace 的 wiki 摘要（当前只支持一个 workspace 一份 wiki）。 */
export async function listWikiSummaries(
  workspacePath: string,
  workspaceIdentity?: string,
): Promise<WikiSummary[]> {
  const best = await readBestWiki(workspacePath);
  if (!best) return [];
  const { document, task } = best;
  const pageCount = document.pages.filter((page) => page.markdown !== null).length;
  return [
    {
      wikiId: document.wikiId,
      workspaceKey: workspaceIdentity?.trim() || document.workspaceKey || workspacePath,
      workspacePath: document.workspacePath || workspacePath,
      ...(document.language ? { language: document.language } : {}),
      pageCount,
      catalogNodeCount: countWikiPageNodes(document.catalogTree),
      ...(document.createdAt !== undefined ? { createdAt: document.createdAt } : {}),
      ...(document.updatedAt !== undefined ? { updatedAt: document.updatedAt } : {}),
      ...(task ? { task } : {}),
    },
  ];
}

/** 确保产物目录存在（尤其 draft-pages）。 */
export async function ensureWikiStore(workspacePath: string): Promise<WikiStorePaths> {
  const paths = resolveWikiStorePaths(workspacePath);
  await mkdir(paths.draftPagesDir, { recursive: true });
  return paths;
}

/** 原子写正式产物。 */
export async function writeWikiDocument(
  workspacePath: string,
  document: WikiDocument,
): Promise<void> {
  const paths = await ensureWikiStore(workspacePath);
  await atomicWriteJson(paths.wikiFile, document as unknown as Record<string, unknown>);
}

/** 原子写任务状态。 */
export async function writeWikiTaskState(
  workspacePath: string,
  task: WikiTaskState,
): Promise<void> {
  const paths = await ensureWikiStore(workspacePath);
  await atomicWriteJson(paths.taskFile, task as unknown as Record<string, unknown>);
}

/** 原子写草稿（每页生成后调用，保证中途失败可续跑）。 */
export async function writeWikiDraft(
  workspacePath: string,
  draft: WikiDraftDocument,
): Promise<void> {
  const paths = await ensureWikiStore(workspacePath);
  await atomicWriteJson(paths.draftFile, draft as unknown as Record<string, unknown>);
}

/** 落盘单页。 */
export async function writeDraftPage(workspacePath: string, page: WikiPage): Promise<void> {
  const paths = await ensureWikiStore(workspacePath);
  await atomicWriteJson(
    join(paths.draftPagesDir, wikiPageFileName(page.id)),
    page as unknown as Record<string, unknown>,
  );
}

/**
 * 校验一个路径确实是 workspace 内的子路径。
 *
 * 产物目录虽由我们拼出，但 pageId / 文件名若来自模型输出，
 * 写入前仍必须确认没有跳出 workspace。
 */
export function isPathInsideWorkspace(workspacePath: string, candidate: string): boolean {
  const root = resolve(workspacePath);
  const target = resolve(candidate);
  return target === root || target.startsWith(root + sep);
}
