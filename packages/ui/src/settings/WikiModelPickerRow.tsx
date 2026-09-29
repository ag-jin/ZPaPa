import { useMemo } from "react";
import { ZCODE_AGENT_PROVIDER, type ModelSelection } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { SubagentReasoningField } from "@/settings/SubagentReasoningField.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";

/** `custom:<providerId>:<modelId>` → ModelSelection。 */
export function parseModelSelectValue(value: string): ModelSelection | null {
  const prefix = "custom:";
  if (!value.startsWith(prefix)) return null;
  const rest = value.slice(prefix.length);
  const separator = rest.indexOf(":");
  if (separator <= 0) return null;
  const providerId = rest.slice(0, separator);
  const modelId = rest.slice(separator + 1);
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

/**
 * 模型 + 推理强度选择控件（不含 label / description）。
 *
 * 直接复用 composer / Subagents 的既有控件（ModelConfigSelect +
 * SubagentReasoningField）：模型清单的分组、账号徽标、不可用态、
 * 推理强度档位这些规则都封装在那些组件里，重写一遍必然漂移。
 *
 * **默认是具体模型，不是「跟随默认模型」**：后者是个伪选项 ——
 * 它把「用哪个模型」推迟到执行时刻，用户看不到实际会用谁，
 * 而推理档位在那种状态下也没有落点。这里把当前生效的模型直接显示为已选值，
 * 用户想改就改。
 */
export function ModelPickerRow({
  selection,
  reasoningLevel,
  onSelectionChange,
  onReasoningLevelChange,
  modelView,
  disabled = false,
}: {
  /** 已配置的模型；未配置时为 undefined，此时展示环境解析出的当前生效值。 */
  selection: ModelSelection | undefined;
  /** 独立设置的推理档位（与模型正交）。 */
  reasoningLevel: string | undefined;
  onSelectionChange: (next: ModelSelection) => void;
  onReasoningLevelChange: (next: string | undefined) => void;
  modelView: ReturnType<typeof useModelSelectionServiceView>["state"];
  disabled?: boolean;
}) {
  const { intl } = useZCodeIntl();

  const modelGroups = useMemo(() => {
    if (modelView.status !== "ready") return [];
    return buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, modelView.view);
  }, [modelView]);

  /** 当前生效的模型：优先用户已配置的，否则用环境解析出的默认模型。 */
  const effectiveSelection = useMemo<ModelSelection | undefined>(() => {
    if (selection) return selection;
    if (modelView.status !== "ready") return undefined;
    return modelView.view.effectiveSelection ?? modelView.view.preferredSelection;
  }, [selection, modelView]);

  const normalizedValue = effectiveSelection
    ? `custom:${effectiveSelection.providerId}:${effectiveSelection.modelId}`
    : "";

  /** 推理档位：以独立字段为准，回落到模型自带的档位。 */
  const activeReasoningLevel = reasoningLevel ?? effectiveSelection?.options?.reasoningLevel;

  const reasoningState = useMemo(() => {
    if (modelView.status !== "ready") {
      return { kind: "unknown" as const, status: "loading" as const };
    }
    if (!effectiveSelection) return { kind: "not-applicable" as const };
    const option = resolveModelThoughtOption({
      modelSelectionView: modelView.view,
      providerId: effectiveSelection.providerId,
      modelId: effectiveSelection.modelId,
      ...(activeReasoningLevel ? { currentValue: activeReasoningLevel } : {}),
    });
    return option ? { kind: "supported" as const, option } : { kind: "unsupported" as const };
  }, [modelView, effectiveSelection, activeReasoningLevel]);

  const triggerLabel = effectiveSelection
    ? effectiveSelection.modelId
    : intl.formatMessage({ id: "wiki.settings.model.pending" });

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <ModelConfigSelect
        modelGroups={modelGroups}
        normalizedValue={normalizedValue}
        triggerLabel={triggerLabel}
        triggerLabelPrefix={effectiveSelection ? effectiveSelection.providerId : undefined}
        showManageModelsAction={false}
        lockReasonMessage=""
        isItemLocked={() => false}
        onValueChange={(value) => {
          const parsed = parseModelSelectValue(value);
          if (parsed) onSelectionChange(parsed);
        }}
        contentSide="bottom"
        focusSelectorOnClose={null}
        labelVisibilityClassName="inline-flex min-w-0"
        triggerClassName="h-8 w-fit max-w-full min-w-0 justify-between rounded-lg border border-input-border bg-input bg-clip-border px-3 py-1.5 text-foreground hover:border-border-hover hover:bg-input focus-visible:border-input-border-focused focus-visible:bg-input-focused"
        triggerLabelClassName="inline-flex min-w-0 truncate text-left"
        disabled={disabled}
      />
      {/* 推理强度：与模型独立，任何已解析出模型的场合都能调 */}
      {effectiveSelection ? (
        <SubagentReasoningField
          intl={intl}
          state={reasoningState}
          disabled={disabled}
          contentSide="bottom"
          labelVisibilityClassName="inline-flex min-w-0"
          onValueCommit={(value) => onReasoningLevelChange(value || undefined)}
        />
      ) : null}
    </div>
  );
}
