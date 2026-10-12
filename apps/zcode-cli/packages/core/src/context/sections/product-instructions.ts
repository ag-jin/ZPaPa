// ============================================================
// Product Instructions Section Builder
// ============================================================

import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

/**
 * 产品行为纪律段（卡 #212/A11）：全文由 bootstrap 按 ask-matt 开关解析后经
 * `AgentRuntimeConfig.productInstructions` 传入（同一个布尔单点：server-operations 从
 * context.appRuntimePreferences 写出）。缺席/空白 = 开关关或未设置 = 调用方不产出本段。
 *
 * 段内容属于会话内恒定的产品策略（资源随开关在会话创建时冻结），进 stable 桶，
 * 与身份/自定义 stable body 同一条 system 消息。
 */
export function buildProductInstructionsSection(content: string): ContextSection {
  const trimmed = content.trim();
  return {
    name: "Product Instructions (Karpathy)",
    source: "product_instructions",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: trimmed.length,
    tokens: estimateTokens(trimmed),
    content: trimmed,
    preview: trimmed.slice(0, 100),
  };
}
