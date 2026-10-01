/**
 * Dynamic Workflow 灰度在桌面端 host 环境里的落值（纯函数，便于层 1 锁定）。
 *
 * 为什么不留在 desktopRuntimeEnv.ts：那个模块在纯 Node 测试环境里会经传递依赖命中
 * `electron` 的具名导出（`does not provide an export named 'app'`），于是判定没法被
 * 单测覆盖。而这个判定一旦改错，整块「工作流」能力（自动化页的标签 + 下发给模型的
 * 九个工具）会**静默消失** —— 正是必须被测试盯住的那一类。做法与 autoUpdatePolicy.ts 一致。
 *
 * 分档：
 *   - 未打包 dev：透传 shell 里的合法取值，方便手工切档；非法值直接丢弃而不是转发给 Host，
 *     Host 因此不必再判一次来源；
 *   - 打包（preview 与 production 现在同值）：固定写入 {@link PACKAGED_DYNAMIC_WORKFLOW_MODE}，
 *     忽略 shell —— 上游这两档本不相同（preview 恒开、production 恒关），
 *     本 fork 让它们合并，理由见下。
 *
 * 为什么本 fork 的 production 也写入（与上游不同）：
 *
 *   上游把 production 留空是**反篡改**设计 —— 灰度由服务端 `/api/v1/client/configs` 下发，
 *   production 端不让本机自行打开。但本 fork 已按用户要求裁掉全部 z.ai/bigmodel 云通道
 *   （`nodeApiClient` 对平台域名一律抛错），那次下发读不到 → 恒 fallback 到
 *   `DEFAULT_DYNAMIC_WORKFLOW_MODE`（"disabled"）→ 用户可见症状就是
 *   「自动化里的工作流整个没了」（日志：`动态工作流灰度配置读取失败，按关闭处理` +
 *   `Offline build: platform API requests are disabled (zcode.z.ai)`）。
 *   此时不存在服务端权威，用**构建档位**（而不是本机环境变量）决定，才是与 preview 一致的做法。
 *
 *   **反篡改不变量仍然成立**：本模块只按档位「写」或「删」，绝不原样透传继承值；
 *   `buildHostProcessEnv` 调用方还会先无条件 `delete` 一次继承值。所以本机环境变量
 *   依旧无法自行打开灰度，Host 端的 resolveDynamicWorkflowClientConfig 可以无条件相信读到的值。
 */
import { ZCODE_DYNAMIC_WORKFLOW_MODE_ENV, normalizeDynamicWorkflowMode } from "@zcode/shared";

/** 打包档位下本 fork 的取值；与 preview 一致，今天与 onDemand 行为等价（都只判 enabled）。 */
export const PACKAGED_DYNAMIC_WORKFLOW_MODE = "alwaysOn" as const;

export function resolveDynamicWorkflowModeHostEnv(options: {
  inheritedValue: string | undefined;
  isPackaged: boolean;
}): Record<string, string> {
  if (!options.isPackaged) {
    const mode = normalizeDynamicWorkflowMode(options.inheritedValue);
    return mode ? { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: mode } : {};
  }
  return { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: PACKAGED_DYNAMIC_WORKFLOW_MODE };
}
