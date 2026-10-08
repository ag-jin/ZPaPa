import type { ModelSelection } from "@zcode/shared";

/** AgentBuilder 访谈用的模型选择（与 wiki / Git 提交消息同款形状：provider + model + 档位）。 */
export type AgentBuilderModelSelection = ModelSelection;

/**
 * 解析本轮访谈使用的模型（照 wiki 的 `resolveWikiModelSelection` 三档纪律）：
 * 显式指定 > 当前 preferredSelection > null（由调用方**响亮**报「没有可用的模型」）。
 *
 * 为什么返回 null 而不是挑一个：静默挑一个会让「用户没配模型」表现成「访谈用了一个
 * 你没选过的模型」，且失败点被推到更远的模型调用处（wiki 同款理由）。
 */
export function resolveAgentBuilderModelSelection(params: {
  requested?: ModelSelection | undefined;
  preferred?: ModelSelection | undefined;
}): AgentBuilderModelSelection | null {
  const base = isUsable(params.requested)
    ? params.requested
    : isUsable(params.preferred)
      ? params.preferred
      : null;
  if (!base) return null;
  return {
    providerId: base.providerId,
    modelId: base.modelId,
    ...(base.options === undefined ? {} : { options: { ...base.options } }),
  };
}

function isUsable(selection: ModelSelection | undefined): selection is ModelSelection {
  return Boolean(selection?.providerId?.trim() && selection.modelId?.trim());
}
