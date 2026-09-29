import type { ReactNode } from "react";
import { FolderGit2, Loader2Icon } from "lucide-react";
import type { WikiProjectSettings } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";

export interface WikiProjectRow {
  workspacePath: string;
  workspaceIdentity?: string;
  /** workspaceKey（identity || path），配置表用它做键。 */
  workspaceKey: string;
  label: string;
}

export interface WikiProjectRowStatus {
  hasWiki: boolean;
  lastGeneratedAt: number | null;
  pendingCommits: number | null;
  autoUpdateEnabled: boolean;
}

/**
 * 项目列表（左栏）。
 *
 * 版式对齐设置页「模型设置」的左侧导航：同样的 min-h-8 圆角行、
 * 同样的 selected 态（border-border-hover + bg-card-selected）、
 * 同样的分组小标题（text-ui-sm font-semibold text-foreground-subtlest）。
 */
export function WikiProjectList({
  projects,
  selectedKey,
  onSelect,
  statusByKey,
  loading,
}: {
  projects: readonly WikiProjectRow[];
  selectedKey: string;
  onSelect: (workspaceKey: string) => void;
  statusByKey: ReadonlyMap<string, WikiProjectRowStatus | null>;
  loading: boolean;
}) {
  const { intl, localePreference } = useZCodeIntl();
  const locale = typeof localePreference === "string" && localePreference ? localePreference : "zh-CN";

  const formatDateTime = (value: number | null): string => {
    if (value === null) return intl.formatMessage({ id: "wiki.settings.status.never" });
    try {
      return new Intl.DateTimeFormat(locale, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value));
    } catch {
      return new Date(value).toLocaleString();
    }
  };

  return (
    <aside className="flex min-h-0 flex-col gap-3 px-1.5 py-3 md:px-2 md:py-2">
      <div className="flex h-7 items-center justify-between px-2 py-1 max-md:hidden">
        <h3 className="text-ui-sm font-semibold text-foreground-subtlest">
          {intl.formatMessage({ id: "wiki.settings.projectList.title" })}
        </h3>
        {loading ? (
          <Loader2Icon className="size-3.5 shrink-0 animate-spin text-foreground-subtle" />
        ) : null}
      </div>

      <div className="flex min-h-0 flex-col gap-1 overflow-y-auto">
        {projects.length === 0 ? (
          <p className="px-2 py-1 text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "wiki.settings.project.none" })}
          </p>
        ) : (
          projects.map((project) => {
            const status = statusByKey.get(project.workspaceKey);
            const isSelected = project.workspaceKey === selectedKey;
            const pending = status?.pendingCommits ?? null;
            return (
              <ControlHintTooltip
                key={project.workspaceKey}
                title={project.workspacePath}
                side="right"
              >
                <button
                  type="button"
                  aria-label={project.label}
                  aria-selected={isSelected}
                  data-state={isSelected ? "selected" : "idle"}
                  data-project-key={project.workspaceKey}
                  onClick={() => onSelect(project.workspaceKey)}
                  className={cn(
                    "shrink-0 box-border flex min-h-8 w-full items-center gap-2 rounded-lg border px-2 py-1 text-left text-ui-base font-medium transition-colors",
                    isSelected
                      ? "border-border-hover bg-card-selected text-foreground"
                      : "border-transparent text-foreground hover:border-border-hover/60",
                  )}
                >
                  <FolderGit2 className="size-4 shrink-0" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-1.5">
                      <span className="min-w-0 truncate">{project.label}</span>
                      {status?.autoUpdateEnabled ? (
                        <span className="shrink-0 rounded-full border border-border px-1.5 text-ui-base text-foreground-subtle">
                          {intl.formatMessage({ id: "wiki.settings.projectList.autoBadge" })}
                        </span>
                      ) : null}
                    </span>
                    <span className="truncate text-ui-sm text-foreground-subtlest">
                      {formatDateTime(status?.lastGeneratedAt ?? null)}
                      {pending !== null && pending > 0
                        ? ` · ${intl.formatMessage(
                            { id: "wiki.settings.projectList.pending" },
                            { count: String(pending) },
                          )}`
                        : ""}
                    </span>
                  </span>
                </button>
              </ControlHintTooltip>
            );
          })
        )}
      </div>
    </aside>
  );
}

/** 单项目配置的局部更新。 */
export type WikiProjectSettingsValuePatch = Partial<WikiProjectSettings>;

/**
 * 单个项目的配置（右栏容器）。
 *
 * 版式对齐「模型设置」右侧详情：同样的 p-4 sm:p-6 内边距。
 */
export function WikiProjectDetail({ children }: { children: ReactNode }) {
  return (
    <div className="relative min-w-0 p-4 sm:p-6" data-testid="wiki-project-config">
      {children}
    </div>
  );
}
