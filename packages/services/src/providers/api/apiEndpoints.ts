import { resolveZaiBusinessBaseUrl } from "@zcode/shared";

// 离线裁剪版：/api/v1/client/scenes 场景拉取已离线化，此处不再导出云端 URL。

export const ZAI_API_HOST = resolveZaiBusinessBaseUrl(process.env);
