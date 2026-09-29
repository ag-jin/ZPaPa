import { randomUUID } from "node:crypto";
import { Event, Emitter } from "@zcode/rpc";
import type {
  WikiDocument,
  WikiDraftDocument,
  WikiGenerateRequest,
  WikiGenerateResult,
  WikiGenerationProgress,
  WikiPage,
  WikiTaskPhase,
} from "./wikiTypes.js";
import { flattenWikiPageNodes } from "./wikiTypes.js";
import {
  buildCatalogPrompt,
  extractJsonPayload,
  normalizeCatalogPlan,
  resolveWikiModelSelection,
  validateCatalogPlan,
} from "./wikiPlan.js";
import { buildManifestDigest, scanWikiWorkspace, workspaceDisplayName } from "./wikiScan.js";
import { readBestWiki, writeDraftPage, writeWikiDocument } from "./wikiStore.js";
import { WIKI_DEFAULT_MAX_OUTPUT_TOKENS } from "./wiki.js";
import type {
  WikiCurrentModelProvider,
  WikiGeneratorOptions,
  WikiTextGenerator,
} from "./wikiGeneratorTypes.js";
import { callWikiModel, generateWikiPageContent } from "./wikiGeneratePage.js";
import {
  buildWikiProjectContext,
  persistWikiProgress,
  persistWikiTask,
  replaceDraftPage,
} from "./wikiPersist.js";

export type { WikiCurrentModelProvider, WikiGeneratorOptions, WikiTextGenerator };

const CATALOG_REQUEST_TIMEOUT_MS = 10 * 60_000;

function now(): number {
  return Date.now();
}

interface RunningTask {
  taskId: string;
  abort: AbortController;
  progress: WikiGenerationProgress;
  emitter: Emitter<WikiGenerationProgress>;
}

/**
 * wiki 生成器。
 *
 * 关键设计（都来自真实产物契约的约束）：
 * 1. 两跳：先让模型规划 catalogTree，再逐页生成正文。
 * 2. 每页生成完立即落盘 draft-pages 并刷新 draft.json —— 中途失败可续跑，
 *    这是 draft-pages 目录存在的根本原因（单次生成可能数小时）。
 * 3. 失败页不阻塞其余页：正文缺失的页以占位形式留在目录树里，
 *    最终 task.json 的 failedPages 如实记账。
 */
export class WikiGenerator {
  readonly #running = new Map<string, RunningTask>();

  constructor(private readonly options: WikiGeneratorOptions) {}

  #key(workspacePath: string, workspaceIdentity?: string): string {
    return workspaceIdentity?.trim() || workspacePath;
  }

  getProgress(workspacePath: string, workspaceIdentity?: string): WikiGenerationProgress | null {
    return this.#running.get(this.#key(workspacePath, workspaceIdentity))?.progress ?? null;
  }

  cancel(workspacePath: string, workspaceIdentity?: string): boolean {
    const running = this.#running.get(this.#key(workspacePath, workspaceIdentity));
    if (!running) return false;
    running.abort.abort();
    return true;
  }

  /**
   * 读取当前进度事件。
   *
   * 订阅时立即补发一次当前状态：UI 打开面板时任务往往已经在跑，
   * 只等下一次 tick 会让面板在数秒内显示为空。
   */
  listen(progressId: string): Event<WikiGenerationProgress> {
    return (listener) => {
      const running = this.#running.get(progressId);
      if (!running) return { dispose: () => {} };
      const disposable = running.emitter.event(listener);
      listener({ ...running.progress });
      return disposable;
    };
  }

  async generate(request: WikiGenerateRequest): Promise<WikiGenerateResult> {
    const key = this.#key(request.workspacePath, request.workspaceIdentity);
    if (this.#running.has(key)) {
      throw new Error("该工作区已有正在进行的 wiki 生成任务");
    }

    const existing = await readBestWiki(request.workspacePath);
    const preferred = await this.options.currentModelProvider.readCurrentModel({
      workspacePath: request.workspacePath,
      ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
    });
    const selection = resolveWikiModelSelection({
      ...(request.selection ? { requested: request.selection } : {}),
      ...(preferred ? { preferred } : {}),
      // 独立档位优先：用户只调档位、沿用默认模型时也要生效
      ...(request.reasoningLevel ? { reasoningLevel: request.reasoningLevel } : {}),
    });
    if (!selection) {
      throw new Error("没有可用的模型：请先在设置中选择模型，或在生成对话框里指定");
    }

    const language = request.language ?? existing?.document.language ?? "zh-CN";
    const generateDiagrams = request.generateDiagrams ?? true;
    const maxOutputTokens = request.maxOutputTokens ?? WIKI_DEFAULT_MAX_OUTPUT_TOKENS;

    const taskId = randomUUID();
    const wikiId = existing?.document.wikiId ?? randomUUID();
    const abort = new AbortController();
    const emitter = new Emitter<WikiGenerationProgress>();
    const progress: WikiGenerationProgress = {
      taskId,
      phase: "planning",
      totalPages: 0,
      completedPages: 0,
      failedPages: 0,
    };
    this.#running.set(key, { taskId, abort, progress, emitter });

    const startedAt = now();
    try {
      await persistWikiTask(request, {
        taskId,
        workspaceKey: key,
        repoId: key,
        phase: "planning",
        status: "running",
        completedPages: 0,
        failedPages: 0,
        totalPages: 0,
        wikiId,
        createdAt: startedAt,
        updatedAt: startedAt,
      });

      const scan = await scanWikiWorkspace({
        workspacePath: request.workspacePath,
        fileService: this.options.fileService,
      });
      const manifestDigest = buildManifestDigest(scan);
      const projectName = workspaceDisplayName(request.workspacePath);

      // ── 规划阶段：复用旧目录树，或让模型重新规划 ──
      let catalogTree = existing?.document.catalogTree ?? [];
      let pages = existing?.document.pages ?? [];

      const canReuse = request.resumeOnly === true && pages.length > 0;
      if (!canReuse) {
        const planRaw = await callWikiModel({
          textGenerator: this.options.textGenerator,
          request,
          selection,
          prompt: buildCatalogPrompt({
            projectName,
            language,
            generateDiagrams,
            readme: scan.readme,
            manifestDigest,
            ...(existing
              ? { previousPageTitles: existing.document.pages.map((page) => page.title) }
              : {}),
          }),
          maxOutputTokens,
          timeoutMs: CATALOG_REQUEST_TIMEOUT_MS,
          signal: abort.signal,
        });
        const plan = normalizeCatalogPlan(extractJsonPayload(planRaw));
        const validation = validateCatalogPlan(plan);
        if (!validation.ok) {
          throw new Error(`目录规划不可用：${validation.reason}`);
        }
        catalogTree = plan.catalogTree;
        pages = plan.pages;
      }

      const pageNodes = flattenWikiPageNodes(catalogTree);
      const existingById = new Map(pages.map((page) => [page.id, page]));
      // 续跑时已完成正文的页（含从 draft-pages 落盘的）直接跳过
      const doneIds = new Set(
        pages.filter((page) => typeof page.markdown === "string" && page.markdown.length > 0)
          .map((page) => page.id),
      );

      progress.phase = "generating";
      progress.totalPages = pageNodes.length;
      progress.completedPages = doneIds.size;
      progress.failedPages = 0;
      this.#emit(key);

      const draft: WikiDraftDocument = {
        taskId,
        wikiId,
        repoId: key,
        workspaceKey: key,
        workspacePath: request.workspacePath,
        language,
        modelSelection: selection,
        generationOptions: { generateDiagrams, maxOutputTokens, language },
        manifestHash: scan.manifestHash,
        context: buildWikiProjectContext(request, scan, projectName, key),
        catalogTree,
        pages: [...pages],
        generatedPageIds: [...doneIds],
        createdAt: existing?.document.createdAt ?? startedAt,
        updatedAt: startedAt,
      };
      await persistWikiProgress({ request, draft, progress, phase: "generating", startedAt });

      let failed = 0;
      for (const { pageId, node } of pageNodes) {
        if (abort.signal.aborted) break;
        if (doneIds.has(pageId)) continue;

        const base = existingById.get(pageId);
        const siblings = pageNodes
          .filter((item) => item.parentId === node.id)
          .map((item) => item.node.title)
          .filter((title) => title !== node.title);

        try {
          const markdown = await generateWikiPageContent({
            textGenerator: this.options.textGenerator,
            request,
            selection,
            language,
            generateDiagrams,
            maxOutputTokens,
            projectName,
            manifestDigest,
            readme: scan.readme,
            pageTitle: node.title,
            pageDescription: base?.description ?? "",
            filePaths: base?.filePaths ?? [],
            siblingTitles: siblings,
            signal: abort.signal,
          });
          const page: WikiPage = {
            id: pageId,
            parentId: node.id,
            title: node.title,
            order: node.order,
            description: base?.description ?? "",
            filePaths: base?.filePaths ?? [],
            markdown,
            createdAt: base?.createdAt ?? now(),
            updatedAt: now(),
          };
          // 先落单页，再刷草稿索引：即使下一行崩溃，正文也不会丢。
          await writeDraftPage(request.workspacePath, page);
          doneIds.add(pageId);
          replaceDraftPage(draft, page);
          draft.generatedPageIds = [...doneIds];
          draft.updatedAt = now();
        } catch (error) {
          if (abort.signal.aborted) break;
          failed += 1;
          this.options.logger?.warn(undefined, "wiki 单页生成失败", {
            pageId,
            title: node.title,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        progress.completedPages = doneIds.size;
        progress.failedPages = failed;
        progress.currentPageTitle = node.title;
        await persistWikiProgress({ request, draft, progress, phase: "generating", startedAt });
      }

      const cancelled = abort.signal.aborted;
      const phase: WikiTaskPhase = cancelled ? "cancelled" : "done";

      // 收尾：把草稿提升为正式产物
      const document: WikiDocument = {
        wikiId,
        repoId: key,
        workspaceKey: key,
        workspacePath: request.workspacePath,
        language,
        modelSelection: selection,
        generationOptions: { generateDiagrams, maxOutputTokens, language },
        manifestHash: scan.manifestHash,
        context: draft.context,
        catalogTree,
        pages: draft.pages,
        createdAt: draft.createdAt,
        updatedAt: now(),
      };
      if (!cancelled) {
        await writeWikiDocument(request.workspacePath, document);
      }

      progress.phase = phase;
      delete progress.currentPageTitle;
      this.#emit(key);
      await persistWikiTask(request, {
        taskId,
        workspaceKey: key,
        repoId: key,
        phase,
        status: cancelled ? "cancelled" : "completed",
        completedPages: doneIds.size,
        failedPages: failed,
        totalPages: pageNodes.length,
        wikiId,
        createdAt: startedAt,
        updatedAt: now(),
        ...(cancelled ? { error: "已取消" } : {}),
      });

      return {
        wikiId,
        taskId,
        totalPages: pageNodes.length,
        completedPages: doneIds.size,
        failedPages: failed,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      progress.phase = "failed";
      progress.error = message;
      this.#emit(key);
      await persistWikiTask(request, {
        taskId,
        workspaceKey: key,
        repoId: key,
        phase: "failed",
        status: "failed",
        completedPages: progress.completedPages,
        failedPages: progress.failedPages,
        totalPages: progress.totalPages,
        wikiId,
        createdAt: startedAt,
        updatedAt: now(),
        error: message,
      });
      throw error;
    } finally {
      const running = this.#running.get(key);
      running?.emitter.dispose();
      this.#running.delete(key);
    }
  }

  #emit(key: string): void {
    const running = this.#running.get(key);
    if (!running) return;
    running.emitter.fire({ ...running.progress });
  }
}
