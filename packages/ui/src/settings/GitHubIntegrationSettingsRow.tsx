import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";

/* #8 D2：设置 ▸ 实验功能里的 **GitHub 集成**（PAT）行 —— 本仓**第一个 secret 字段**。

   两条安全纪律（任务卡：#8 D2「首个 secret 字段：输入框脱敏 + 不回显明文」）：
   ① **本组件的 props 里没有 token**：它只拿到一个布尔事实（`tokenConfigured`）——
      「回显明文」在结构上不可能发生（拿不到的东西渲染不出来）；输入框里的值是**本次输入草稿**
      （初值恒空串），输入类型 `password`；
   ② 保存后草稿**立刻清空**（下一次进来仍是空框 + 一行「已配置」状态），不把刚保存的明文继续留在
      DOM 里（截图/共享屏幕都不该看到它）。

   明文落盘的取舍（本地单机、单用户、文件权限即边界）在 description 里向用户言明：这不是
   「我们没想过」，而是「本期就这样，且告诉你了」。 */

export function GitHubIntegrationSettingsRow({
  tokenConfigured,
  saving,
  onSave,
  onClear,
}: {
  /** **只有布尔事实**：已配置 = 非空白 token（判据来自 shared 的唯一实现）。 */
  tokenConfigured: boolean;
  saving: boolean;
  onSave: (token: string) => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  /** 本次输入的草稿：**恒以空串起步**，保存成功即清空（绝不预填已保存的 token）。 */
  const [draft, setDraft] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const save = async () => {
    if (draft.trim() === "") return;
    setLocalError(null);
    try {
      await onSave(draft.trim());
      setDraft("");
    } catch (error) {
      // 就地提示（容器另有 toast）：失败时**保留草稿**，用户能直接重试。
      setLocalError(error instanceof Error ? error.message : String(error));
    }
  };

  const clear = async () => {
    setLocalError(null);
    try {
      await onClear();
      setDraft("");
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <SettingsRow
      label={t("settings.experiments.githubIntegration.label")}
      description={t("settings.experiments.githubIntegration.description")}
      detail={
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span
              data-testid="github-integration-token-status"
              className="text-ui-xs text-foreground-subtle"
            >
              {tokenConfigured
                ? t("settings.experiments.githubIntegration.tokenConfigured")
                : t("settings.experiments.githubIntegration.tokenNotConfigured")}
            </span>
            {/* 脱敏占位：固定宽度文本，**不**按 token 长度或内容派生（长度也是信息）。 */}
            {tokenConfigured ? (
              <span
                data-testid="github-integration-token-masked"
                className="text-ui-xs text-foreground-subtlest"
              >
                ••••••••
              </span>
            ) : null}
          </div>
          <Input
            data-testid="github-integration-token-input"
            type="password"
            value={draft}
            autoComplete="off"
            placeholder={t("settings.experiments.githubIntegration.tokenPlaceholder")}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              data-testid="github-integration-token-save"
              disabled={saving || draft.trim() === ""}
              onClick={() => void save()}
            >
              {t("settings.experiments.githubIntegration.tokenSave")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="github-integration-token-clear"
              disabled={saving || !tokenConfigured}
              onClick={() => void clear()}
            >
              {t("settings.experiments.githubIntegration.tokenClear")}
            </Button>
          </div>
          {localError === null ? null : (
            <span
              data-testid="github-integration-token-error"
              className="text-ui-xs text-destructive"
            >
              {localError}
            </span>
          )}
        </div>
      }
      control={null}
    />
  );
}
