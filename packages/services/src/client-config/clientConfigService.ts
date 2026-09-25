import { clientConfigReadOptionsSchema, type ClientConfigSnapshot } from "@zcode/shared";
import type { IClientConfigService } from "./clientConfig.js";

/**
 * 首期仅公开配置；账户灰度不得通过此实例或缓存复用。
 *
 * 离线裁剪版：不再请求 {endpoint}/api/v1/client/configs（ZCode 云端灰度配置），
 * 恒定返回空快照，消费方（当前只有插件商店排序）回落本地默认值。
 * 依赖参数保留以维持既有装配签名，调用方无需改动。
 */
export function createClientConfigService(_dependencies: {
  apiClient: unknown;
  resolveRequestContext: () => unknown;
}): IClientConfigService {
  return {
    async getSnapshot(options = {}) {
      clientConfigReadOptionsSchema.parse(options);
      const snapshot: ClientConfigSnapshot = { pluginStoreOrder: null };
      return snapshot;
    },
  };
}
