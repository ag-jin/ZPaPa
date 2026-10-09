import { useCallback, useEffect, useMemo, useState } from "react";
import type { WikiProjectSettings, WikiSettings } from "@zcode/shared";
import type { WikiProjectStatus } from "@zcode/services";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useBaseWorkspaceServices, useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { ModelPickerRow } from "@/settings/WikiModelPickerRow.js";
import { WikiFieldRow as FieldRow } from "@/settings/WikiFieldRow.js";
import { WikiScheduleFields } from "@/settings/WikiScheduleFields.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import {
  WikiProjectDetail,
  WikiProjectList,
  type WikiProjectRow,
  type WikiProjectRowStatus,
  type WikiProjectSettingsValuePatch,
} from "@/settings/WikiProjectColumns.js";

/** workspace 身份键：与 services 层约定一致（identity 优先）。 */
function resolveWorkspaceKey(workspacePath: string, workspaceIdentity?: string): string {
  return workspaceIdentity?.trim() || workspacePath;
}

/**
 * 项目知识库设置分区。
 *
 * 版式对齐设置页「模型设置」：同样的左右双栏 split panel（含窄屏折叠栏宽）、
 * 同样的顶部 description + 刷新动作、同样的右栏详情内边距。
 * 每个项目各存自己的配置（settings.wikiSettings.projects），互不影响。
 */
export function WikiSettingsSection({
  settings,
  onChange,
  workspaceOptions,
}: {
  settings: WikiSettings;
  onChange: (patch: Partial<WikiSettings>) => Promise<void>;
  /** 可选项目（已登记 workspace）。 */
  workspaceOptions: Array<{ workspacePath: string; workspaceIdentity?: string; label: string }>;
}) {
  const { intl } = useZCodeIntl();
  const baseServices = useBaseWorkspaceServices();

  const projects: WikiProjectRow[] = useMemo(
    () =>
      workspaceOptions.map((option) => ({
        workspacePath: option.workspacePath,
        ...(option.workspaceIdentity ? { workspaceIdentity: option.workspaceIdentity } : {}),
        workspaceKey: resolveWorkspaceKey(option.workspacePath, option.workspaceIdentity),
        label: option.label,
      })),
    [workspaceOptions],
  );

  const [selectedKey, setSelectedKey] = useState<string>("");
  const [statusByKey, setStatusByKey] = useState<ReadonlyMap<string, WikiProjectRowStatus | null>>(
    new Map(),
  );
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /**
   * 待提交的改动。
   *
   * 编辑先落到本地草稿，「保存」才写进设置 —— 否则每敲一下都在落盘，
   * 用户也无法放弃修改。dirty 只标记「有未保存改动」。
   */
  const [draft, setDraft] = useState<{ key: string; value: WikiProjectSettings } | null>(null);

  // 项目列表变化时保持已选不丢；首次自动选第一个
  useEffect(() => {
    if (projects.length === 0) {
      setSelectedKey("");
      return;
    }
    setSelectedKey((current) =>
      current && projects.some((project) => project.workspaceKey === current)
        ? current
        : (projects[0]?.workspaceKey ?? ""),
    );
  }, [projects]);

  const selectedProject = projects.find((project) => project.workspaceKey === selectedKey) ?? null;
  const projectSettings = selectedKey ? (settings.projects?.[selectedKey] ?? {}) : {};

  /** 编辑只改本地草稿，由「保存」提交。 */
  const patchProject = useCallback(
    (patch: WikiProjectSettingsValuePatch) => {
      if (!selectedKey) return;
      setDraft((current) => {
        const base = current?.key === selectedKey ? current.value : projectSettings;
        return { key: selectedKey, value: { ...base, ...patch } };
      });
    },
    [selectedKey, projectSettings],
  );

  // 选中项目对应的 services（含远端 workspace）
  const selectedServices = useWorkspaceServices(
    selectedProject?.workspacePath ?? null,
    null,
    selectedProject?.workspaceIdentity ?? null,
  );

  /** 当前生效值：有草稿用草稿，否则用已保存的配置。 */
  const effectiveSettings: WikiProjectSettings =
    draft?.key === selectedKey ? draft.value : projectSettings;
  const dirty = draft?.key === selectedKey;

  const handleSave = useCallback(async () => {
    if (!selectedKey || !draft || draft.key !== selectedKey) return;
    setSaving(true);
    setActionError(null);
    try {
      const next: WikiProjectSettings = { ...draft.value };
      // 改频率或时刻要刷新锚点：排期以锚点为基准按日历天推进
      if (
        next.autoUpdateFrequency !== projectSettings.autoUpdateFrequency ||
        next.autoUpdateHour !== projectSettings.autoUpdateHour ||
        next.autoUpdateMinute !== projectSettings.autoUpdateMinute
      ) {
        next.autoUpdateAnchorAt = Date.now();
      }
      await onChange({ projects: { ...settings.projects, [selectedKey]: next } });
      setDraft(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [selectedKey, draft, projectSettings, onChange, settings.projects]);

  /** 拉取所有项目的状态，供左栏展示。 */
  const refreshStatuses = useCallback(async () => {
    if (projects.length === 0) {
      setStatusByKey(new Map());
      return;
    }
    setLoading(true);
    const next = new Map<string, WikiProjectRowStatus | null>();
    await Promise.all(
      projects.map(async (project) => {
        try {
          const status: WikiProjectStatus = await baseServices.wikiService.getProjectStatus({
            workspacePath: project.workspacePath,
            ...(project.workspaceIdentity ? { workspaceIdentity: project.workspaceIdentity } : {}),
          });
          next.set(project.workspaceKey, {
            hasWiki: status.hasWiki,
            lastGeneratedAt: status.lastGeneratedAt,
            pendingCommits: status.pendingCommits,
            autoUpdateEnabled:
              settings.projects?.[project.workspaceKey]?.autoUpdateEnabled === true,
          });
        } catch {
          // 单个项目读不到状态不影响其余项目
          next.set(project.workspaceKey, null);
        }
      }),
    );
    setStatusByKey(next);
    setLoading(false);
  }, [projects, baseServices.wikiService, settings.projects]);

  /**
   * 立即生成当前项目。
   *
   * 用已保存的配置执行（未保存的改动不参与）—— 否则用户以为在用旧配置，
   * 实际跑了草稿里的新参数，结果对不上。
   */
  const handleGenerateNow = useCallback(async () => {
    if (!selectedProject) return;
    setGenerating(true);
    setActionError(null);
    try {
      await selectedServices.wikiService.generate({
        workspacePath: selectedProject.workspacePath,
        ...(selectedProject.workspaceIdentity
          ? { workspaceIdentity: selectedProject.workspaceIdentity }
          : {}),
        ...(projectSettings.generateDiagrams !== undefined
          ? { generateDiagrams: projectSettings.generateDiagrams }
          : {}),
        ...(projectSettings.language ? { language: projectSettings.language } : {}),
        ...(projectSettings.modelSelection ? { selection: projectSettings.modelSelection } : {}),
        ...(projectSettings.reasoningLevel
          ? { reasoningLevel: projectSettings.reasoningLevel }
          : {}),
        resumeOnly: true,
      });
      await refreshStatuses();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setGenerating(false);
    }
  }, [selectedProject, selectedServices.wikiService, projectSettings, refreshStatuses]);

  useEffect(() => {
    void refreshStatuses();
  }, [refreshStatuses]);

  const { state: modelView } = useModelSelectionServiceView(
    baseServices.modelSelectionService ?? null,
  );

  const renderModelPicker = useCallback(
    (kind: "manual" | "scheduled", disabled = false) => (
      <ModelPickerRow
        disabled={disabled}
        selection={
          kind === "manual"
            ? effectiveSettings.modelSelection
            : effectiveSettings.autoUpdateModelSelection
        }
        reasoningLevel={
          kind === "manual"
            ? effectiveSettings.reasoningLevel
            : effectiveSettings.autoUpdateReasoningLevel
        }
        onSelectionChange={(next) =>
          patchProject(
            kind === "manual" ? { modelSelection: next } : { autoUpdateModelSelection: next },
          )
        }
        // 档位独立存储：与模型正交，用户可只调档位而沿用当前模型
        onReasoningLevelChange={(next) =>
          patchProject(
            kind === "manual" ? { reasoningLevel: next } : { autoUpdateReasoningLevel: next },
          )
        }
        modelView={modelView}
      />
    ),
    [effectiveSettings, patchProject, modelView],
  );

  const enabled = effectiveSettings.autoUpdateEnabled === true;
  const pendingCommits = statusByKey.get(selectedKey)?.pendingCommits ?? null;

  return (
    <div className="space-y-4" data-testid="wiki-settings-section">
      <div className="flex items-start justify-between gap-3">
        <p className="text-ui-base leading-6 text-foreground-subtle">
          {intl.formatMessage({ id: "wiki.settings.description" })}
        </p>
        <SettingsResourceHeaderActions
          onRefresh={() => void refreshStatuses()}
          refreshing={loading}
          refreshLabel={intl.formatMessage({ id: "wiki.action.refresh" })}
        />
      </div>

      <div className="overflow-clip rounded-xl border border-border bg-card">
        <div className="grid min-h-[36rem] grid-cols-[56px_minmax(0,1fr)] gap-0 md:grid-cols-[224px_minmax(0,1fr)]">
          <div className="min-w-0 border-r border-border">
            <WikiProjectList
              projects={projects}
              selectedKey={selectedKey}
              onSelect={setSelectedKey}
              statusByKey={statusByKey}
              loading={loading}
            />
          </div>
          <WikiProjectDetail>
            {selectedProject ? (
              <div className="flex flex-col">
                {/* 项目身份 */}
                <div className="pb-4">
                  <h2 className="truncate text-ui-lg font-semibold text-foreground">
                    {selectedProject.label}
                  </h2>
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 text-ui-sm text-foreground-subtle">
                    <span className="truncate font-mono">
                      {selectedProject.workspacePath}/.wiki/
                    </span>
                    {pendingCommits !== null && pendingCommits > 0 ? (
                      <span className="text-foreground">
                        {intl.formatMessage(
                          { id: "wiki.settings.projectList.pending" },
                          { count: String(pendingCommits) },
                        )}
                      </span>
                    ) : null}
                  </p>
                </div>

                {/* 生成选项 */}
                <div className="border-t border-border">
                  <FieldRow
                    label={intl.formatMessage({ id: "wiki.settings.diagrams.label" })}
                    description={intl.formatMessage({ id: "wiki.settings.diagrams.hint" })}
                    control={
                      <Switch
                        checked={effectiveSettings.generateDiagrams !== false}
                        onCheckedChange={(checked) => patchProject({ generateDiagrams: checked })}
                      />
                    }
                  />
                </div>
                <div className="border-t border-border">
                  <FieldRow
                    label={intl.formatMessage({ id: "wiki.settings.language.label" })}
                    description={intl.formatMessage({ id: "wiki.settings.language.hint" })}
                    control={
                      <Select
                        value={effectiveSettings.language ?? "zh-CN"}
                        onValueChange={(value) => patchProject({ language: value })}
                      >
                        <SelectTrigger className="h-8 w-32 rounded-lg px-3 text-ui-base">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent position="popper" align="start" side="bottom" sideOffset={4}>
                          <SelectItem value="zh-CN">简体中文</SelectItem>
                          <SelectItem value="en-US">English</SelectItem>
                        </SelectContent>
                      </Select>
                    }
                  />
                </div>
                <div className="border-t border-border">
                  <FieldRow
                    label={intl.formatMessage({ id: "wiki.settings.model.label" })}
                    description={intl.formatMessage({ id: "wiki.settings.model.hint" })}
                    control={renderModelPicker("manual")}
                  />
                </div>

                <WikiScheduleFields
                  value={effectiveSettings}
                  onChange={patchProject}
                  scheduledModelPicker={renderModelPicker("scheduled", !enabled)}
                />

                {/* 右下角动作：立即生成当前项目 / 保存本页配置 */}
                <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
                  {actionError ? (
                    <span className="mr-auto text-ui-sm text-destructive">{actionError}</span>
                  ) : null}
                  <Button
                    variant="outline"
                    size="lg"
                    disabled={generating || !selectedProject}
                    onClick={() => void handleGenerateNow()}
                  >
                    {generating ? <Loader2Icon className="size-4 animate-spin" /> : null}
                    {intl.formatMessage({ id: "wiki.action.generateNow" })}
                  </Button>
                  <Button
                    variant="default"
                    size="lg"
                    disabled={saving || !dirty}
                    onClick={() => void handleSave()}
                  >
                    {intl.formatMessage({ id: "wiki.action.save" })}
                  </Button>
                </div>
              </div>
            ) : null}
          </WikiProjectDetail>
        </div>
      </div>
    </div>
  );
}
