import { writeWikiDraft, writeWikiTaskState } from "./wikiStore.js";
import type { WikiScanResult } from "./wikiScan.js";
import type {
  WikiDraftDocument,
  WikiGenerateRequest,
  WikiGenerationProgress,
  WikiPage,
  WikiProjectContext,
  WikiTaskPhase,
  WikiTaskState,
} from "./wikiTypes.js";

/** 组装产物里的项目上下文快照。 */
export function buildWikiProjectContext(
  request: WikiGenerateRequest,
  scan: WikiScanResult,
  projectName: string,
  workspaceKey: string,
): WikiProjectContext {
  return {
    repoId: workspaceKey,
    workspaceKey,
    name: projectName,
    rootPath: request.workspacePath,
    ...(scan.readme ? { readme: scan.readme } : {}),
    fileCount: scan.fileCount,
    languageStats: scan.languageStats,
  };
}

/** 用新生成的正文替换草稿里的同 id 页面；不存在则追加。 */
export function replaceDraftPage(draft: WikiDraftDocument, page: WikiPage): void {
  const index = draft.pages.findIndex((item) => item.id === page.id);
  if (index >= 0) draft.pages[index] = page;
  else draft.pages.push(page);
}

/** 写任务状态。 */
export async function persistWikiTask(
  request: WikiGenerateRequest,
  task: WikiTaskState,
): Promise<void> {
  await writeWikiTaskState(request.workspacePath, task);
}

/**
 * 每页生成后刷新草稿与任务状态。
 *
 * 顺序是先草稿后任务：任务状态是给 UI 看的进度，草稿是续跑的依据。
 * 即使两次写入之间进程被杀，损失也只是 UI 少一次进度刷新，不会丢正文。
 */
export async function persistWikiProgress(params: {
  request: WikiGenerateRequest;
  draft: WikiDraftDocument;
  progress: WikiGenerationProgress;
  phase: WikiTaskPhase;
  startedAt: number;
  status?: string;
}): Promise<void> {
  await writeWikiDraft(params.request.workspacePath, params.draft);
  await writeWikiTaskState(params.request.workspacePath, {
    taskId: params.draft.taskId,
    workspaceKey: params.draft.workspaceKey,
    repoId: params.draft.repoId,
    phase: params.phase,
    status: params.status ?? "running",
    completedPages: params.progress.completedPages,
    failedPages: params.progress.failedPages,
    totalPages: params.progress.totalPages,
    wikiId: params.draft.wikiId,
    createdAt: params.startedAt,
    updatedAt: Date.now(),
  });
}
