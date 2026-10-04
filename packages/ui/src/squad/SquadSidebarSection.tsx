import { useCallback, useEffect, useMemo, useState } from "react";
import type { SquadSnapshot } from "@zcode/services";
import { Alert, AlertTitle } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  resolveSquadRuntimeService,
  squadWorkspaceTarget,
} from "./squadRuntimeAccess.js";

/* 侧栏「小队」功能显示（用户 2026-10-04 需求）：挂在「分组/项目」区右侧，按**项目**分组显示
   智能体与小队的入口，分组头可折叠。

   **隔离边界（用户明示：原本的项目入口先隔离开，防止改坏）**：本组件是**全新独立文件**，
   不 import 也不改 WorkspaceSidebar 的任何任务行/项目区渲染路径；接线侧只允许在
   WorkspaceSidebar 的 header 右侧加一个开关按钮 + 在列表区**之前**条件渲染本组件
   （见结构守卫：任务列表的既有分支一行不得改）。数据经服务面 `getSnapshot` 逐项目拉取
   （读路径在非 git 目录同样可用——第 50 轮 lazy Git capability），**只读**：这里不给
   新建/编辑动作，定义管理仍在「智能体/小队」一级页。

   折叠态是**组件本地状态**（不进持久 store）：侧栏是瞬态导航面，刷新后回到默认（全收）
   的代价小；为此加一条 store 依赖反而扩大改动面。 */

export type SquadSidebarProject = {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 展示名：侧栏已有的项目名（调用方传），本组件不重复推导。 */
  label: string;
};

type ProjectSnapshot =
  | { state: "loading" }
  | { state: "ready"; snapshot: SquadSnapshot }
  | { state: "error"; message: string };

export function SquadSidebarSection({
  projects,
  activeWorkspacePath,
  onOpenSquadAgents,
  onOpenSquads,
  activateProject,
}: {
  projects: SquadSidebarProject[];
  /** 当前激活项目（入口直开）；非激活项目的入口先激活再打开。 */
  activeWorkspacePath: string;
  onOpenSquadAgents: () => void;
  onOpenSquads: () => void;
  /** 激活项目的跨项目通路（调用方注入，如 platform.activateOrSetWorkspace）；缺省时非激活项目入口置灰。 */
  activateProject?: (workspacePath: string) => Promise<unknown>;
}) {
  const { intl } = useZCodeIntl();
  const services = useServices();
  const t = useCallback((id: string) => intl.formatMessage({ id }), [intl]);

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [snapshots, setSnapshots] = useState<Record<string, ProjectSnapshot>>({});

  const projectKeys = useMemo(
    () => projects.map((p) => `${p.workspacePath}|${p.workspaceIdentity ?? ""}`),
    [projects],
  );

  /* 逐项目拉快照：入口旁的计数（N 智能体 / M 小队）与实验开关呈现。失败**逐项目可见**
     （错误态带原因），不静默成 0——0 与「读不到」必须分得开。 */
  useEffect(() => {
    let cancelled = false;
    for (const project of projects) {
      const key = `${project.workspacePath}|${project.workspaceIdentity ?? ""}`;
      setSnapshots((current) =>
        current[key] ? current : { ...current, [key]: { state: "loading" } },
      );
      const target = squadWorkspaceTarget(project.workspacePath, project.workspaceIdentity);
      if (!target) continue; // 项目缺路径：拉不了快照，保持 loading 不冒充 0
      resolveSquadRuntimeService(services)
        .getSnapshot(target)
        .then((snapshot) => {
          if (!cancelled) {
            setSnapshots((current) => ({ ...current, [key]: { state: "ready", snapshot } }));
          }
        })
        .catch((error: unknown) => {
          logger.warn("[SquadSidebarSection] 读取项目小队快照失败", {
            workspacePath: project.workspacePath,
            error: error instanceof Error ? error.message : String(error),
          });
          if (!cancelled) {
            setSnapshots((current) => ({
              ...current,
              [key]: { state: "error", message: error instanceof Error ? error.message : String(error) },
            }));
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [projectKeys, projects, services]);

  const toggleGroup = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /** 入口点击：激活项目（非当前）→ 打开对应页。两步都由调用方给的回调承载，本层不猜激活语义。 */
  const openEntry = useCallback(
    async (project: SquadSidebarProject, kind: "agents" | "squads") => {
      if (project.workspacePath !== activeWorkspacePath) {
        if (!activateProject) return; // 置灰入口的兜底：不该可点
        await activateProject(project.workspacePath);
      }
      if (kind === "agents") onOpenSquadAgents();
      else onOpenSquads();
    },
    [activateProject, activeWorkspacePath, onOpenSquadAgents, onOpenSquads],
  );

  if (projects.length === 0) {
    return (
      <p className="text-ui-sm text-foreground-subtlest" data-testid="squad-sidebar-empty">
        {t("squad.sidebar.noProjects")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1" data-testid="squad-sidebar-section">
      {projects.map((project, index) => {
        const key = projectKeys[index]!;
        const isCollapsed = collapsed.has(key);
        const snap = snapshots[key];
        const isActive = project.workspacePath === activeWorkspacePath;
        return (
          <div key={key} className="rounded-lg border border-border px-2 py-1.5">
            <button
              type="button"
              className="flex w-full items-center gap-1.5 text-left"
              data-testid="squad-sidebar-group-header"
              data-workspace-path={project.workspacePath}
              aria-expanded={!isCollapsed}
              onClick={() => toggleGroup(key)}
            >
              {isCollapsed ? (
                <ChevronRight aria-hidden className="size-3.5 shrink-0 text-foreground-subtlest" />
              ) : (
                <ChevronDown aria-hidden className="size-3.5 shrink-0 text-foreground-subtlest" />
              )}
              <span
                className={cn(
                  "truncate text-ui-sm",
                  isActive ? "text-foreground" : "text-foreground-subtle",
                )}
              >
                {project.label}
              </span>
              {snap?.state === "loading" ? <Spinner className="size-3" /> : null}
            </button>
            {!isCollapsed ? (
              <div className="mt-1 flex flex-col gap-1 pl-5">
                {snap?.state === "error" ? (
                  <span className="text-ui-xs text-destructive" data-testid="squad-sidebar-error">
                    {t("squad.sidebar.loadFailed")}
                  </span>
                ) : null}
                {snap?.state === "ready" && !snap.snapshot.enabled ? (
                  <Alert variant="warning" className="px-2 py-1">
                    <AlertTitle className="text-ui-xs">{t("squad.common.experimentOff")}</AlertTitle>
                  </Alert>
                ) : null}
                {(["agents", "squads"] as const).map((kind) => {
                  const disabled =
                    snap?.state !== "ready" ||
                    (project.workspacePath !== activeWorkspacePath && !activateProject);
                  return (
                    <Button
                      key={kind}
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 justify-start px-1.5 text-ui-sm"
                      disabled={disabled}
                      data-testid={`squad-sidebar-${kind}`}
                      onClick={() => {
                        void openEntry(project, kind);
                      }}
                    >
                      {t(kind === "agents" ? "squad.sidebar.agentsEntry" : "squad.sidebar.squadsEntry")}
                      {snap?.state === "ready" ? (
                        <span className="ml-auto text-ui-xs text-foreground-subtlest">
                          {kind === "agents"
                            ? snap.snapshot.teamAgents.filter((a) => a.archivedAt === undefined).length
                            : snap.snapshot.squads.length}
                        </span>
                      ) : null}
                    </Button>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
