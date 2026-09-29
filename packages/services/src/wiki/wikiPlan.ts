import { randomUUID } from "node:crypto";
import type { WikiCatalogNode, WikiModelSelection, WikiPage } from "./wikiTypes.js";
import { flattenWikiPageNodes } from "./wikiTypes.js";

const MAX_CATALOG_PAGES = 120;
const MIN_CATALOG_PAGES = 3;

export interface BuildPlanPromptParams {
  projectName: string;
  language: string;
  generateDiagrams: boolean;
  readme: string | undefined;
  manifestDigest: string;
  /** 上一份 wiki 的页标题，用于增量更新时保持结构稳定。 */
  previousPageTitles?: readonly string[];
}

/**
 * 第一跳：让模型给出目录结构（每页标题 + 该页应覆盖的文件）。
 *
 * 之所以分两跳：产物契约本身是「catalogTree 先定、正文逐页填」的形状，
 * 且单页请求比「一次生成 52 页」要可控得多（样本 2 单页平均 8.9k 字符）。
 */
export function buildCatalogPrompt(params: BuildPlanPromptParams): string {
  const langLine =
    params.language === "en-US"
      ? "Write all titles and descriptions in English."
      : "所有标题与描述用简体中文。";

  const diagramLine = params.generateDiagrams
    ? "需要时用 ```mermaid 代码块画架构/流程图（每页 0-3 个，不要为凑数而画）。"
    : "不要输出 mermaid 或其他图表代码块。";

  const previous =
    params.previousPageTitles && params.previousPageTitles.length > 0
      ? [
          "",
          "## 已有 wiki 的页面标题（本次是更新，请尽量保持结构稳定）",
          params.previousPageTitles.map((title) => `- ${title}`).join("\n"),
        ].join("\n")
      : "";

  return [
    `你是资深架构师，要为项目「${params.projectName}」设计一份开发文档知识库的**目录结构**。`,
    "",
    "## 目标",
    `把项目拆成 ${MIN_CATALOG_PAGES}-${MAX_CATALOG_PAGES} 个知识页，每页聚焦一个可独立阅读的主题，`,
    "让新成员按目录顺序读下来即可掌握项目全貌。",
    "",
    "## 要求",
    "- 顶层按子系统/职责分组，每个分组下 3-10 页；分组与页面都要有清晰的标题。",
    "- 每页必须给出 `filePaths`：该页主要讲哪些文件（用清单里的相对路径，最多 8 个）。",
    "- 每页 `description` 一句话说明这页讲什么，将用于目录展示。",
    "- 页面粒度要均匀：不要把整个服务端塞进一页，也不要为单个小文件单开一页。",
    `- ${langLine}`,
    `- ${diagramLine}`,
    "",
    "## 项目清单（路径 + 体量）",
    "```",
    params.manifestDigest,
    "```",
    ...(params.readme
      ? ["", "## README（节选，用于理解项目定位）", "```", params.readme, "```"]
      : []),
    previous,
    "",
    "## 输出格式（**只输出 JSON，不要任何解释或 markdown 代码围栏**）",
    "```json",
    JSON.stringify(
      {
        catalogTree: [
          {
            title: "分组标题",
            children: [
              {
                title: "页面标题",
                description: "一句话说明",
                filePaths: ["path/to/file.ts"],
              },
            ],
          },
        ],
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

/** 从模型输出里抽出 JSON（容忍代码围栏与前后解释文字）。 */
export function extractJsonPayload(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    // 模型可能在 JSON 前后夹带说明，退一步取第一个 { 到最后一个 } 的区间。
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

interface RawCatalogNode {
  title?: unknown;
  description?: unknown;
  filePaths?: unknown;
  pageId?: unknown;
  children?: unknown;
}

function toTitlePrefix(index: number): string {
  return `page-${index + 1}`;
}

function normalizeFilePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const paths = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().replace(/^\.\//, "").replace(/\\/g, "/"))
    .filter((item) => item.length > 0 && !item.startsWith("/") && !item.includes(".."));
  return [...new Set(paths)].slice(0, 8);
}

/**
 * 把模型的目录输出归一化为 catalogTree + 页面骨架。
 *
 * id 由我们生成（`node-N-<hex>` / `page-N-<hex>`），不采信模型给的 id：
 * 既要保证与历史产物形状一致，也避免模型产出重复或穿越性 id。
 */
export function normalizeCatalogPlan(raw: unknown): {
  catalogTree: WikiCatalogNode[];
  pages: WikiPage[];
} {
  const payload = raw as { catalogTree?: unknown } | null;
  const rawNodes = Array.isArray(payload?.catalogTree) ? payload.catalogTree : [];

  let order = 0;
  let pageIndex = 0;
  const pages: WikiPage[] = [];

  const buildPages = (nodes: readonly RawCatalogNode[], parentId: string): WikiCatalogNode[] => {
    const out: WikiCatalogNode[] = [];
    for (const rawNode of nodes) {
      if (!rawNode || typeof rawNode.title !== "string" || rawNode.title.trim().length === 0) {
        continue;
      }
      order += 1;
      const nodeId = `node-${order}-${randomUUID().slice(0, 8)}`;
      const children = Array.isArray(rawNode.children)
        ? buildPages(rawNode.children as RawCatalogNode[], nodeId)
        : [];

      const node: WikiCatalogNode = {
        id: nodeId,
        title: rawNode.title.trim(),
        order,
      };

      // 有子节点的是分组；没有子节点的是页面。若模型两者都给，以子节点优先，
      // 避免一个节点既当分组又当页面导致目录树语义混乱。
      if (children.length > 0) {
        node.children = children;
      } else {
        pageIndex += 1;
        const pageId = `${toTitlePrefix(pageIndex)}-${randomUUID().slice(0, 8)}`;
        node.pageId = pageId;
        pages.push({
          id: pageId,
          parentId,
          title: rawNode.title.trim(),
          order,
          description: typeof rawNode.description === "string" ? rawNode.description.trim() : "",
          filePaths: normalizeFilePaths(rawNode.filePaths),
          markdown: null,
        });
      }
      out.push(node);
    }
    return out;
  };

  const catalogTree = buildPages(rawNodes as RawCatalogNode[], "");

  // 顶层若只有一个分组而它下面还有分组，说明模型多包了一层，展平它。
  const unwrapped =
    catalogTree.length === 1 && catalogTree[0]?.children && !catalogTree[0].pageId
      ? catalogTree[0].children
      : catalogTree;

  return { catalogTree: unwrapped, pages };
}

/** 校验目录规划是否可用。 */
export function validateCatalogPlan(plan: {
  catalogTree: WikiCatalogNode[];
  pages: WikiPage[];
}): { ok: true } | { ok: false; reason: string } {
  if (plan.pages.length === 0) {
    return { ok: false, reason: "模型没有产出任何页面" };
  }
  if (plan.pages.length > MAX_CATALOG_PAGES) {
    return { ok: false, reason: `页面数 ${plan.pages.length} 超过上限 ${MAX_CATALOG_PAGES}` };
  }
  if (flattenWikiPageNodes(plan.catalogTree).length !== plan.pages.length) {
    return { ok: false, reason: "目录树页面节点数与页面数不一致" };
  }
  return { ok: true };
}

export interface BuildPagePromptParams {
  projectName: string;
  language: string;
  generateDiagrams: boolean;
  pageTitle: string;
  pageDescription: string;
  filePaths: readonly string[];
  /** 同分组内的兄弟页标题，帮助模型避免重复内容。 */
  siblingTitles: readonly string[];
  readme: string | undefined;
  manifestDigest: string;
}

/** 第二跳：逐页生成正文。 */
export function buildPagePrompt(params: BuildPagePromptParams): string {
  const langLine =
    params.language === "en-US"
      ? "Write the page in English."
      : "用简体中文撰写这一页。";

  const diagramLine = params.generateDiagrams
    ? "需要时用 ```mermaid 代码块画图（0-3 个；没有合适的内容就不画）。"
    : "不要输出 mermaid 或其他图表代码块。";

  const siblingLine =
    params.siblingTitles.length > 0
      ? `同组的其他页面（不要重复它们的内容）：${params.siblingTitles.join("、")}`
      : "";

  const files =
    params.filePaths.length > 0
      ? params.filePaths.map((path) => `- ${path}`).join("\n")
      : "- （本页没有指定文件，请依据项目清单推断相关模块）";

  return [
    `你在为项目「${params.projectName}」撰写知识库中的一页。`,
    "",
    `## 本页标题`,
    params.pageTitle,
    "",
    `## 本页要讲什么`,
    params.pageDescription || "（未提供，请按标题自行判断重点）",
    "",
    "## 涉及的文件",
    files,
    "",
    ...(siblingLine ? [siblingLine, ""] : []),
    "## 写作要求",
    "- 用 markdown。开头用 `# 标题`，然后分 2-5 个二级小节展开。",
    "- 讲清「这个模块负责什么、关键流程怎么走、有哪些约束与坑」，不要逐行复述代码。",
    "- 可以引用具体函数名、类型名、常量，但不要大段贴源码。",
    `- ${langLine}`,
    `- ${diagramLine}`,
    "- 只输出这一页的 markdown 正文，不要写前后言、不要用代码围栏包整篇。",
    "",
    "## 项目清单（供你判断本页模块在整体中的位置）",
    "```",
    params.manifestDigest,
    "```",
    ...(params.readme ? ["", "## README（节选）", "```", params.readme, "```"] : []),
  ].join("\n");
}

/** 清理模型返回的正文：去掉可能的整篇围栏与前言。 */
export function normalizePageMarkdown(raw: string): string {
  let text = raw.trim();
  // 整篇被一个代码围栏包住时剥掉它
  const whole = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/.exec(text);
  if (whole?.[1]) text = whole[1].trim();
  if (text.length === 0) return "";
  // 模型偶尔会加「好的，以下是…」之类的开场白；从第一个标题行开始取
  const headingIndex = text.search(/^#{1,6} /m);
  if (headingIndex > 0 && headingIndex < 400) text = text.slice(headingIndex);
  return text.trim();
}

export interface ResolveModelSelectionParams {
  requested?: WikiModelSelection;
  preferred?: WikiModelSelection;
  /**
   * 独立设置的推理档位。优先于 selection 自带的 options：
   * 档位与模型是两个正交选择，用户改了档位就该生效，无论模型来自哪里。
   */
  reasoningLevel?: string;
}

/**
 * 解析本次生成使用的模型。
 *
 * 用户显式选择优先；否则回退当前 preferredSelection。
 * 都没有则返回 null，由调用方报「模型不可用」——不静默挑一个。
 */
export function resolveWikiModelSelection(
  params: ResolveModelSelectionParams,
): WikiModelSelection | null {
  const base =
    params.requested?.providerId && params.requested.modelId
      ? params.requested
      : params.preferred?.providerId && params.preferred.modelId
        ? params.preferred
        : null;
  if (!base) return null;

  const level = params.reasoningLevel?.trim() || base.options?.reasoningLevel;
  return {
    providerId: base.providerId,
    modelId: base.modelId,
    ...(level ? { options: { reasoningLevel: level } } : {}),
  };
}
