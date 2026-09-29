import type { IFileService } from "../file/file.js";
import type { WikiModelSelection } from "./wikiTypes.js";

/** 一次性文本生成能力；由 node.ts 注入 zcodeAgentService.generateWorkspaceText。 */
export interface WikiTextGenerator {
  generateText(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    selection: WikiModelSelection;
    prompt: string;
    querySource: string;
    maxOutputTokens?: number;
    signal?: AbortSignal;
    /** 协议层 RPC 超时；必须透传，否则长页面会被协议默认 3 分钟超时先掐断。 */
    requestTimeoutMs?: number;
  }): Promise<{ text: string }>;
}

/** 读取当前 preferred 模型；由 node.ts 注入 providerRuntime.modelSelection.getView()。 */
export interface WikiCurrentModelProvider {
  readCurrentModel(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<WikiModelSelection | null>;
}

export interface WikiGeneratorOptions {
  fileService: IFileService;
  textGenerator: WikiTextGenerator;
  currentModelProvider: WikiCurrentModelProvider;
  logger?: import("../logger/serviceLogger.js").ServiceLogger;
}
