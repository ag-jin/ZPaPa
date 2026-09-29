/**
 * Wiki 知识库产物契约。
 *
 * 产物落盘在 `<workspace>/.wiki/`，跟随项目走：
 *   wiki/wiki.json               权威产物（catalogTree + 已生成页面）
 *   wiki/task.json               生成任务进度
 *   wiki/draft.json              生成中途草稿（含 generatedPageIds，用于断点续跑）
 *   wiki/draft-pages/<hash>.json 单页增量落盘
 *
 * 本文件是纯类型契约，不引 node:*，可从 @zcode/services 根入口导出。
 */

/** catalogTree 的节点。叶子节点通过 pageId 指向 pages 里的一页。 */
export interface WikiCatalogNode {
  id: string;
  title: string;
  order: number;
  /** 有 pageId 表示这是一个需要生成正文的页面；没有则是纯分组节点。 */
  pageId?: string;
  children?: WikiCatalogNode[];
}

/** 页面正文里引用的源码位置锚点，比 filePaths 更细（带起始行）。 */
export interface WikiPageSource {
  path: string;
  startLine: number;
}

/**
 * 一页。
 *
 * `markdown` 为 null 表示这是一页**占位**：目录已规划但正文生成失败。
 * 这正是 task.json 里 failedPages 的来源，重跑时按此识别待补页面。
 */
export interface WikiPage {
  id: string;
  parentId: string;
  title: string;
  order: number;
  description: string;
  filePaths: string[];
  markdown: string | null;
  sources?: WikiPageSource[];
  createdAt?: number;
  updatedAt?: number;
}

/** 项目上下文快照：生成时冻结，用于判断项目是否变过（manifestHash）与给模型理解项目。 */
export interface WikiProjectContext {
  repoId: string;
  workspaceKey: string;
  name: string;
  rootPath: string;
  defaultBranch?: string;
  commitHash?: string;
  commitTime?: number;
  fileCount?: number;
  /** 语言 → 字节数。 */
  languageStats?: Record<string, number>;
  readme?: string;
}

/** 生成用的模型选择。与 @zcode/shared 的 ModelSelection 同构（此处独立声明以便产物自描述）。 */
export interface WikiModelSelection {
  providerId: string;
  modelId: string;
  options?: {
    reasoningLevel?: string;
  };
}

/** 生成选项。两份历史样本均有此字段；maxOutputTokens 对应单次请求的输出预算。 */
export interface WikiGenerationOptions {
  generateDiagrams?: boolean;
  thoughtLevel?: string;
  maxOutputTokens?: number;
  /** 生成语言，如 zh-CN。 */
  language?: string;
}

/**
 * 旧版样本的模型字段（无 modelSelection 时存在）。
 * 新产物以 modelSelection 为准，本字段只为读旧产物保留。
 */
export interface WikiLegacyGenerationModel {
  providerId?: string;
  providerName?: string;
  modelName?: string;
}

/** 一份完整 wiki。 */
export interface WikiDocument {
  wikiId: string;
  repoId: string;
  workspaceKey: string;
  workspacePath: string;
  language?: string;
  modelSelection?: WikiModelSelection;
  generationModel?: WikiLegacyGenerationModel;
  generationOptions?: WikiGenerationOptions;
  /** 项目清单指纹，用于判断能否复用旧 wiki。 */
  manifestHash: string;
  context?: WikiProjectContext;
  catalogTree: WikiCatalogNode[];
  pages: WikiPage[];
  createdAt?: number;
  updatedAt?: number;
}

/** 生成任务阶段。 */
export type WikiTaskPhase = "planning" | "generating" | "done" | "failed" | "cancelled";

/** 生成任务状态快照。 */
export interface WikiTaskState {
  taskId: string;
  workspaceKey: string;
  repoId: string;
  phase: WikiTaskPhase;
  status: string;
  completedPages: number;
  failedPages: number;
  totalPages: number;
  wikiId: string;
  createdAt: number;
  updatedAt: number;
  /** 失败原因摘要（本版新增，供 UI 展示；旧产物没有此字段）。 */
  error?: string;
}

/**
 * draft.json：生成中途的草稿。
 *
 * 与 WikiDocument 的差别：多 taskId 与 generatedPageIds。
 * `pages` 里包含占位页（markdown 为 null），这是「已完成 vs 待补」的判定依据。
 */
export interface WikiDraftDocument extends WikiDocument {
  taskId: string;
  /** 已成功生成正文的页面 id 列表，断点续跑时据此跳过。 */
  generatedPageIds: string[];
}

/** 列表项：给 UI 列出某 workspace 下的 wiki。 */
export interface WikiSummary {
  wikiId: string;
  workspaceKey: string;
  workspacePath: string;
  language?: string;
  pageCount: number;
  catalogNodeCount: number;
  createdAt?: number;
  updatedAt?: number;
  /** 是否存在未完成的生成任务（task.json 存在且 phase 非终结态）。 */
  task?: WikiTaskState;
}

/** 生成进度事件。 */
export interface WikiGenerationProgress {
  taskId: string;
  phase: WikiTaskPhase;
  totalPages: number;
  completedPages: number;
  failedPages: number;
  /** 当前正在生成的页面标题，便于 UI 展示。 */
  currentPageTitle?: string;
  error?: string;
}

/** 生成请求。 */
export interface WikiGenerateRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 用户本次选定的模型；缺省用当前 preferredSelection。 */
  selection?: WikiModelSelection;
  /**
   * 本次生成的推理档位。
   *
   * **独立于 selection**：用户可以只调档位而沿用默认模型。
   * 服务端在解析出最终模型后把它合并进 selection.options。
   */
  reasoningLevel?: string;
  language?: string;
  generateDiagrams?: boolean;
  maxOutputTokens?: number;
  /** 只补生成失败/缺失的页面，复用已有 catalogTree 与已完成页面。 */
  resumeOnly?: boolean;
}

export interface WikiGenerateResult {
  wikiId: string;
  taskId: string;
  totalPages: number;
  completedPages: number;
  failedPages: number;
}

const IN_PROGRESS_PHASES: readonly WikiTaskPhase[] = ["planning", "generating"];

/** 任务是否仍在进行中（用于 UI 决定是否显示取消按钮）。 */
export function isWikiTaskInProgress(phase: WikiTaskPhase): boolean {
  return IN_PROGRESS_PHASES.includes(phase);
}

/**
 * 展平 catalogTree 为「页面节点」列表。
 *
 * 只有带 pageId 的节点才是需要正文的页面；这与 totalPages 的语义一致
 * （旧样本实测：tree 里 14 个带 pageId 的节点 ⇒ totalPages=14）。
 */
export function flattenWikiPageNodes(
  nodes: readonly WikiCatalogNode[],
): Array<{ node: WikiCatalogNode; pageId: string; parentId: string }> {
  const out: Array<{ node: WikiCatalogNode; pageId: string; parentId: string }> = [];
  const walk = (list: readonly WikiCatalogNode[], parentId: string) => {
    for (const node of list) {
      if (node.pageId) out.push({ node, pageId: node.pageId, parentId });
      if (node.children?.length) walk(node.children, node.id);
    }
  };
  walk(nodes, "");
  return out;
}

/** 统计目录树里带 pageId 的节点数（= totalPages）。 */
export function countWikiPageNodes(nodes: readonly WikiCatalogNode[]): number {
  return flattenWikiPageNodes(nodes).length;
}

/**
 * 组合供 UI 渲染的目录树：把 pages 的正文按 pageId 挂回目录节点。
 *
 * 只有目录树是权威结构，pages 只是正文的载体 —— 因此渲染必须以 catalogTree 为准，
 * 否则正文缺失的占位页会从目录里凭空消失（旧样本 failedPages 场景正是如此）。
 */
export function buildWikiRenderTree(
  nodes: readonly WikiCatalogNode[],
  pages: readonly WikiPage[],
): WikiRenderNode[] {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const walk = (list: readonly WikiCatalogNode[]): WikiRenderNode[] =>
    list.map((node) => ({
      id: node.id,
      title: node.title,
      order: node.order,
      page: node.pageId ? (byId.get(node.pageId) ?? null) : null,
      children: walk(node.children ?? []),
    }));
  return walk(nodes).sort((a, b) => a.order - b.order);
}

/** 供 UI 渲染的目录节点：page 为 null 表示正文缺失（生成失败或未开始）。 */
export interface WikiRenderNode {
  id: string;
  title: string;
  order: number;
  page: WikiPage | null;
  children: WikiRenderNode[];
}

/**
 * 单个项目的 wiki 状态：设置页「先选项目，再看状态」用。
 *
 * 只看两件事：上次什么时候生成的、以及之后积压了多少次提交。
 */
export interface WikiProjectStatus {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 是否已有 wiki 产物。 */
  hasWiki: boolean;
  /** 上次生成完成时间（毫秒）。无产物时为 null。 */
  lastGeneratedAt: number | null;
  /** 上次生成时对应的 git 提交时间。 */
  lastGeneratedCommitTime: number | null;
  /**
   * 自上次生成以来新增的提交数（**待同步的积压量**，不是仓库总提交数）。
   *
   * null 表示无法判定：不是 git 仓库、产物没记 commitHash、或历史被改写
   * （原 commitHash 已不在图上）。不返回 0 —— 0 的含义是「确认没有新提交」，
   * 与「查不到」是两回事，混用会误导用户以为不用更新。
   */
  pendingCommits: number | null;
  /** 当前 HEAD 提交时间，便于 UI 展示「最近一次提交」。 */
  headCommitTime: number | null;
}
