import type { IGitService } from "../git/git.js";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import { readBestWiki, resolveWikiStorePaths } from "./wikiStore.js";
import { buildWikiRenderTree, countWikiPageNodes } from "./wikiTypes.js";
import type { WikiProjectStatus, WikiRenderNode, WikiSummary, WikiTaskState } from "./wikiTypes.js";

/** 读取渲染树（供服务层调用）。 */
export async function readWikiRenderTree(workspacePath: string): Promise<{
  wikiId: string;
  nodes: WikiRenderNode[];
  task: WikiTaskState | null;
} | null> {
  const best = await readBestWiki(workspacePath);
  if (!best) return null;
  return {
    wikiId: best.document.wikiId,
    nodes: buildWikiRenderTree(best.document.catalogTree, best.document.pages),
    task: best.task,
  };
}

/** 列出 wiki 摘要（供服务层调用）。 */
export async function listWikisForWorkspace(
  workspacePath: string,
  workspaceIdentity?: string,
): Promise<WikiSummary[]> {
  const best = await readBestWiki(workspacePath);
  if (!best) return [];
  const { document, task } = best;
  const withMarkdown = document.pages.filter(
    (page) => typeof page.markdown === "string" && page.markdown.length > 0,
  ).length;
  return [
    {
      wikiId: document.wikiId,
      workspaceKey: workspaceIdentity?.trim() || document.workspaceKey || workspacePath,
      workspacePath: document.workspacePath || workspacePath,
      ...(document.language ? { language: document.language } : {}),
      pageCount: withMarkdown,
      catalogNodeCount: countWikiPageNodes(document.catalogTree),
      ...(document.createdAt !== undefined ? { createdAt: document.createdAt } : {}),
      ...(document.updatedAt !== undefined ? { updatedAt: document.updatedAt } : {}),
      ...(task ? { task } : {}),
    },
  ];
}

/** 供 UI 判断产物目录位置（导出/排障用）。 */
export function wikiStoreRoot(workspacePath: string): string {
  return resolveWikiStorePaths(workspacePath).root;
}

/** 数提交时的单页大小与硬上限：避免超大仓库把历史全拉下来。 */
const COMMIT_GRAPH_PAGE_SIZE = 100;
const COMMIT_GRAPH_MAX_PAGES = 50;

/**
 * 统计「自某次提交以来新增了多少次提交」。
 *
 * 从 HEAD 沿父链往回找目标 hash，按它出现前的数量计。
 * 找不到目标（非 git 仓库、历史被 rebase/force-push 改写）时返回 null，
 * 而不是返回已扫描的数量 —— 那个数会把「查不到」伪装成「有一堆待更新」。
 */
export async function countCommitsSince(params: {
  gitService: Pick<IGitService, "getCommitGraph">;
  workspacePath: string;
  sinceCommitHash: string | undefined;
  logger?: ServiceLogger;
}): Promise<{ pending: number | null; headCommitTime: number | null }> {
  if (!params.sinceCommitHash) return { pending: null, headCommitTime: null };

  let skip = 0;
  let headCommitTime: number | null = null;
  for (let page = 0; page < COMMIT_GRAPH_MAX_PAGES; page += 1) {
    let result: Awaited<ReturnType<IGitService["getCommitGraph"]>>;
    try {
      result = await params.gitService.getCommitGraph({
        workspacePath: params.workspacePath,
        maxCount: COMMIT_GRAPH_PAGE_SIZE,
        skip,
      });
    } catch (error) {
      params.logger?.debug(undefined, "读取 git 提交图失败，无法统计待更新提交数", {
        workspacePath: params.workspacePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return { pending: null, headCommitTime };
    }

    for (let index = 0; index < result.commits.length; index += 1) {
      const commit = result.commits[index]!;
      if (page === 0 && index === 0) headCommitTime = commit.authoredAtMs;
      if (commit.hash === params.sinceCommitHash) {
        // skip + index = 目标提交之前（更新）的提交数
        return { pending: skip + index, headCommitTime };
      }
    }

    if (!result.hasMore || result.commits.length === 0) break;
    skip += result.commits.length;
  }

  // 目标 hash 不在图上：分支被改写或产物来自别的分支
  return { pending: null, headCommitTime };
}

/** 汇总单个项目的 wiki 状态。 */
export async function readWikiProjectStatus(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  gitService: Pick<IGitService, "getCommitGraph">;
  logger?: ServiceLogger;
}): Promise<WikiProjectStatus> {
  const best = await readBestWiki(params.workspacePath);
  const withMarkdown = best
    ? best.document.pages.filter(
        (page) => typeof page.markdown === "string" && page.markdown.length > 0,
      ).length
    : 0;
  const hasWiki = best !== null && withMarkdown > 0;

  const lastGeneratedAt = best ? (best.document.updatedAt ?? null) : null;
  const lastGeneratedCommitTime = best?.document.context?.commitTime ?? null;
  const sinceCommitHash = best?.document.context?.commitHash;

  const { pending, headCommitTime } = await countCommitsSince({
    gitService: params.gitService,
    workspacePath: params.workspacePath,
    sinceCommitHash,
    ...(params.logger ? { logger: params.logger } : {}),
  });

  return {
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    hasWiki,
    lastGeneratedAt,
    lastGeneratedCommitTime,
    // 没有产物时不存在「积压」概念，直接给 null 让 UI 显示「尚未生成」
    pendingCommits: hasWiki ? pending : null,
    headCommitTime,
  };
}
