import type { IFileService } from "#src/file/file.js";
import type { IGitService } from "#src/git/git.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import type { WikiSettings } from "@zcode/shared";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type { IWikiService as IWikiServiceType } from "./wiki.js";
import { WikiGenerator } from "./wikiGenerator.js";
import { WikiAutoUpdateScheduler, type WikiAutoUpdateTarget } from "./wikiAutoUpdate.js";
import { listWikisForWorkspace, readWikiProjectStatus, readWikiRenderTree } from "./wikiRead.js";
import type { WikiGenerateRequest, WikiModelSelection } from "./wikiTypes.js";
import { resolveWikiStorePaths } from "./wikiStore.js";
import { rm } from "node:fs/promises";

/**
 * 把设置里存的 ModelSelection 收敛成本服务的模型选择形状。
 *
 * 两者结构相同但刻意分开声明（产物契约要能独立描述自己用了什么模型），
 * 这里做显式转换而不是直接 cast，避免任一侧加字段后静默不生效。
 */
function toWikiModelSelection(selection: ModelSelection): WikiModelSelection {
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.options?.reasoningLevel
      ? { options: { reasoningLevel: selection.options.reasoningLevel } }
      : {}),
  };
}

export interface CreateWikiServiceOptions {
  fileService: IFileService;
  /** 读提交图以统计「上次生成后积压了多少提交」；只读，不会改动仓库。 */
  gitService: Pick<IGitService, "getCommitGraph">;
  /** 一次性文本生成能力；由 node.ts 注入 zcodeAgentService.generateWorkspaceText。 */
  textGenerator: {
    generateText(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      selection: WikiModelSelection;
      prompt: string;
      querySource: string;
      maxOutputTokens?: number;
      signal?: AbortSignal;
      requestTimeoutMs?: number;
    }): Promise<{ text: string }>;
  };
  /** 读取当前 preferred 模型；由 node.ts 注入 providerRuntime.modelSelection.getView()。 */
  currentModelProvider: {
    readCurrentModel(params: {
      workspacePath: string;
      workspaceIdentity?: string;
    }): Promise<WikiModelSelection | null>;
  };
  /**
   * 定时自动更新所需的外部依赖。
   *
   * 不提供时自动更新不生效（调度器不启动），其余功能照常 ——
   * 这样不需要自动更新的 host（如 standalone server）无需构造这些依赖。
   */
  autoUpdate?: {
    readSettings: () => Promise<WikiSettings | undefined>;
    /** 已知 workspace 清单，用来把配置键反解成可读写的路径。 */
    listKnownTargets: () => Promise<WikiAutoUpdateTarget[]>;
    /** 记录某项目的自动更新时间，写回该项目的配置。 */
    recordRun?: (workspaceKey: string, at: number) => Promise<void>;
  };
  logger?: ServiceLogger;
}

/**
 * 组装 wiki 服务。
 *
 * 生成器（长任务、有状态）与 RPC 接口分开：接口这层只做参数归一化与进度转发，
 * 生成的并发/续跑/落盘全部由 WikiGenerator 负责。
 */
export function createWikiService(options: CreateWikiServiceOptions): IWikiServiceType {
  const logger = options.logger ?? createServiceLogger("wiki");
  const generator = new WikiGenerator({
    fileService: options.fileService,
    textGenerator: options.textGenerator,
    currentModelProvider: options.currentModelProvider,
    logger,
  });

  const autoUpdate = options.autoUpdate;
  const scheduler = autoUpdate
    ? new WikiAutoUpdateScheduler({
        readSettings: autoUpdate.readSettings,
        listKnownTargets: autoUpdate.listKnownTargets,
        logger,
        ...(autoUpdate.recordRun ? { recordRun: autoUpdate.recordRun } : {}),
        runUpdate: async (target, settings) => {
          // 自动更新走增量：复用已有目录树，只补缺失/失败的页，
          // 避免每次到点都重规划一篇 52 页的文档。
          const existing = await listWikisForWorkspace(target.workspacePath, target.workspaceIdentity);
          const resumeOnly = existing.length > 0;
          await generator.generate({
            workspacePath: target.workspacePath,
            ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
            generateDiagrams: settings.generateDiagrams,
            language: settings.language,
            ...(settings.maxOutputTokens ? { maxOutputTokens: settings.maxOutputTokens } : {}),
            // 定时任务用用户为定时场景指定的模型；没配才回退当前默认模型。
            // 这与手动生成刻意分开：无人值守时不该随会话切模型而变。
            ...(settings.autoUpdateModelSelection
              ? { selection: toWikiModelSelection(settings.autoUpdateModelSelection) }
              : {}),
            // 推理档位独立于模型：只设了档位时由 generator 合并进解析出的模型
            ...(settings.autoUpdateReasoningLevel
              ? { reasoningLevel: settings.autoUpdateReasoningLevel }
              : {}),
            resumeOnly,
          });
        },
      })
    : null;
  scheduler?.start();

  return {
    async list(params) {
      return await listWikisForWorkspace(params.workspacePath, params.workspaceIdentity);
    },

    async getTree(params) {
      return await readWikiRenderTree(params.workspacePath);
    },

    async getTask(params) {
      const best = await readWikiRenderTree(params.workspacePath);
      return best?.task ?? null;
    },

    async getProjectStatus(params) {
      return await readWikiProjectStatus({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        gitService: options.gitService,
        logger,
      });
    },

    async generate(request: WikiGenerateRequest) {
      return await generator.generate(request);
    },

    async cancel(params) {
      const cancelled = generator.cancel(params.workspacePath, params.workspaceIdentity);
      return { cancelled };
    },

    onDynamicGenerationProgress(progressId: string) {
      return generator.listen(progressId);
    },

    async remove(params) {
      const paths = resolveWikiStorePaths(params.workspacePath);
      try {
        await rm(paths.root, { recursive: true, force: true });
        return { removed: true };
      } catch (error) {
        logger.warn(undefined, "删除 wiki 产物失败", {
          root: paths.root,
          error: error instanceof Error ? error.message : String(error),
        });
        return { removed: false };
      }
    },
  };
}

export const WIKI_SERVICE_DESCRIPTOR = "wiki" as const;
