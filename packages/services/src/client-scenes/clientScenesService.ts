import type { ClientScenesResponse, IClientScenesService } from "./clientScenes.js";

export function createClientScenesService(_dependencies: {
  apiClient: unknown;
}): IClientScenesService {
  return {
    // 离线裁剪版：不再请求 {endpoint}/api/v1/client/scenes（云端场景/推荐语料拉取），
    // 恒定返回空场景列表，Automations 模板与草稿推荐提示词由本地静态内容兜底。
    list: async () => ({ code: 0, msg: "offline", data: [] }) as ClientScenesResponse,
  };
}
