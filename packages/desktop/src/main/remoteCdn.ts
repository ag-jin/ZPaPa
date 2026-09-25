import type { ZCodeEnv } from "@zcode/shared";

export interface ResolveRemoteCdnOptions {
  env?: ZCodeEnv;
  locale?: string;
  timeZone?: string;
  overrideBaseUrl?: string;
  version?: string;
  now?: Date;
}

/**
 * 离线裁剪版：远程运行时资源（WSL/SSH/Docker 的 server-bundle、node-runtime 等）不再从
 * https://cdn-zcode.z.ai 下载。恒定返回空候选列表，remoteAssetCache 对空列表直接走
 * 「无远端清单」路径：已有本地缓存的组件继续可用，缺失组件的远程工作区部署会明确失败，
 * 而不是静默联网下载。恢复远程资源功能时需要还原此函数。
 */
export function resolveRemoteCdnBaseUrls(_options: ResolveRemoteCdnOptions = {}): string[] {
  return [];
}
