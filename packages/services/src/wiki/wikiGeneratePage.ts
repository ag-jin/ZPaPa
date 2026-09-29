import { buildPagePrompt, normalizePageMarkdown } from "./wikiPlan.js";
import type { WikiGenerateRequest, WikiModelSelection } from "./wikiTypes.js";
import type { WikiTextGenerator } from "./wikiGeneratorTypes.js";

/** 单页生成的模型超时；整个任务的耗时由页数决定，不在这里兜底。 */
export const PAGE_REQUEST_TIMEOUT_MS = 10 * 60_000;
/** 单页生成失败后的重试次数（不含首次）。 */
export const PAGE_RETRY_LIMIT = 1;

/** 发一次模型请求并把超时与取消都接上。 */
export async function callWikiModel(params: {
  textGenerator: WikiTextGenerator;
  request: WikiGenerateRequest;
  selection: WikiModelSelection;
  prompt: string;
  maxOutputTokens: number;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<string> {
  // 两个 abort 来源合并：调用方的「停止生成」与本次请求的超时。
  const timeout = AbortSignal.timeout(params.timeoutMs);
  const signal = AbortSignal.any([params.signal, timeout]);
  const result = await params.textGenerator.generateText({
    workspacePath: params.request.workspacePath,
    ...(params.request.workspaceIdentity
      ? { workspaceIdentity: params.request.workspaceIdentity }
      : {}),
    selection: params.selection,
    prompt: params.prompt,
    querySource: "wiki_generation",
    maxOutputTokens: params.maxOutputTokens,
    signal,
    requestTimeoutMs: params.timeoutMs,
  });
  return result.text;
}

/**
 * 生成一页正文，失败按 PAGE_RETRY_LIMIT 重试。
 *
 * 取消不算可重试失败：用户已经按了停止，重试只会白烧一次请求。
 */
export async function generateWikiPageContent(params: {
  textGenerator: WikiTextGenerator;
  request: WikiGenerateRequest;
  selection: WikiModelSelection;
  language: string;
  generateDiagrams: boolean;
  maxOutputTokens: number;
  projectName: string;
  manifestDigest: string;
  readme: string | undefined;
  pageTitle: string;
  pageDescription: string;
  filePaths: readonly string[];
  siblingTitles: readonly string[];
  signal: AbortSignal;
}): Promise<string> {
  const prompt = buildPagePrompt({
    projectName: params.projectName,
    language: params.language,
    generateDiagrams: params.generateDiagrams,
    pageTitle: params.pageTitle,
    pageDescription: params.pageDescription,
    filePaths: params.filePaths,
    siblingTitles: params.siblingTitles,
    readme: params.readme,
    manifestDigest: params.manifestDigest,
  });

  let lastError: unknown;
  for (let attempt = 0; attempt <= PAGE_RETRY_LIMIT; attempt += 1) {
    if (params.signal.aborted) throw new Error("已取消");
    try {
      const raw = await callWikiModel({
        textGenerator: params.textGenerator,
        request: params.request,
        selection: params.selection,
        prompt,
        maxOutputTokens: params.maxOutputTokens,
        timeoutMs: PAGE_REQUEST_TIMEOUT_MS,
        signal: params.signal,
      });
      const markdown = normalizePageMarkdown(raw);
      if (markdown.length === 0) throw new Error("模型返回了空正文");
      return markdown;
    } catch (error) {
      lastError = error;
      if (params.signal.aborted) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
