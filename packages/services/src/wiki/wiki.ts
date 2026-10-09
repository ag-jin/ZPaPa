import { ServiceChannels } from "@zcode/shared";
import type { Event } from "@zcode/rpc";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  WikiCatalogNode,
  WikiProjectStatus,
  WikiGenerateRequest,
  WikiGenerateResult,
  WikiGenerationProgress,
  WikiRenderNode,
  WikiSummary,
  WikiTaskState,
} from "./wikiTypes.js";

export type {
  WikiCatalogNode,
  WikiProjectStatus,
  WikiGenerateRequest,
  WikiGenerateResult,
  WikiGenerationProgress,
  WikiPage,
  WikiRenderNode,
  WikiSummary,
  WikiTaskState,
} from "./wikiTypes.js";

/**
 * Wiki 知识库服务。
 *
 * 产物落 `<workspace>/.wiki/`，生成逻辑在 host 进程内（服务层），
 * 模型调用复用 IZCodeAgentService.generateWorkspaceText —— 不新建模型调用通路。
 */
export interface IWikiService {
  /** 列出该 workspace 的 wiki（当前为单份，保留列表形态以免将来多份时改接口）。 */
  list(params: { workspacePath: string; workspaceIdentity?: string }): Promise<WikiSummary[]>;

  /** 读取一份 wiki 的渲染树（目录树 + 正文，以 catalogTree 为准）。 */
  getTree(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{ wikiId: string; nodes: WikiRenderNode[]; task: WikiTaskState | null } | null>;

  /** 读取生成任务当前状态。 */
  getTask(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<WikiTaskState | null>;

  /**
   * 读取单个项目的 wiki 状态：上次生成时间 + 自那以后积压的提交数。
   *
   * 设置页「先选项目、再看状态」用；提交数只给数值，不下发提交内容。
   */
  getProjectStatus(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<WikiProjectStatus>;

  /**
   * 生成（或续跑）一份 wiki。
   *
   * `request.resumeOnly` 为 true 时复用已有 catalogTree，只补生成缺失/失败的页面。
   */
  generate(request: WikiGenerateRequest): Promise<WikiGenerateResult>;

  /** 取消进行中的生成任务。 */
  cancel(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{ cancelled: boolean }>;

  /**
   * 生成进度事件。
   *
   * 方法名以 onDynamic 开头且返回 Event，RPC 框架自动路由（见 proxy-channel 的 isDynamicEvent）。
   */
  onDynamicGenerationProgress(progressId: string): Event<WikiGenerationProgress>;

  /** 删除该 workspace 的 wiki 产物（整目录）。 */
  remove(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{ removed: boolean }>;
}

export const IWikiService = createServiceDescriptor<IWikiService>(ServiceChannels.Wiki);

/** 生成语言选项。 */
export const WIKI_SUPPORTED_LANGUAGES = ["zh-CN", "en-US"] as const;
export type WikiLanguage = (typeof WIKI_SUPPORTED_LANGUAGES)[number];

/** 默认生成选项。maxOutputTokens 取新版样本实测值。 */
export const WIKI_DEFAULT_MAX_OUTPUT_TOKENS = 65_536;

/** 传给模型的归因标记。 */
export const WIKI_QUERY_SOURCE = "wiki_generation";
