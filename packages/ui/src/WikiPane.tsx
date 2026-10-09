import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpenIcon, Loader2Icon, RefreshCwIcon, SquareIcon, SparklesIcon } from "lucide-react";
import type { WikiProjectSettings } from "@zcode/shared";
import type { WikiGenerationProgress, WikiRenderNode, WikiTaskState } from "@zcode/services";
import { isWikiTaskInProgress } from "@zcode/services";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { CatalogTreeNode, MissingPageNotice } from "@/WikiCatalogTree.js";

export interface WikiPaneProps {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
}

/** 数出目录树里已生成正文的页数。 */
function countPages(node: WikiRenderNode): number {
  const self = node.page?.markdown ? 1 : 0;
  return self + node.children.reduce((total, child) => total + countPages(child), 0);
}

type LoadState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "ready"; wikiId: string; nodes: WikiRenderNode[]; task: WikiTaskState | null }
  | { kind: "error"; message: string };

export function WikiPane({ workspacePath, workspaceIdentity, remoteSessionId }: WikiPaneProps) {
  const { intl } = useZCodeIntl();
  const services = useWorkspaceServices(workspacePath, remoteSessionId, workspaceIdentity);
  const wikiService = services.wikiService;

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const [progress, setProgress] = useState<WikiGenerationProgress | null>(null);
  /** 生成选项来自设置页（模型 / 图表 / 语言），面板不自行配置。 */
  const [projectSettings, setProjectSettings] = useState<WikiProjectSettings>({});

  const refresh = useCallback(async () => {
    try {
      const tree = await wikiService.getTree({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
      if (!tree) {
        setState({ kind: "empty" });
        return;
      }
      setState({ kind: "ready", wikiId: tree.wikiId, nodes: tree.nodes, task: tree.task });
      setExpandedIds((current) => {
        if (current.size > 0) return current;
        // 首次加载展开顶层，避免用户看到一屏折叠的根节点。
        return new Set(tree.nodes.map((node) => node.id));
      });
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [wikiService, workspacePath, workspaceIdentity]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 生成进行中时订阅进度。taskId 变化要重订阅：每次生成是新任务。
  const taskId = state.kind === "ready" ? (state.task?.taskId ?? null) : null;
  const activeTaskId = progress?.taskId ?? taskId;
  const generationRunning = progress ? isWikiTaskInProgress(progress.phase) : false;
  const subscriptionRef = useRef<{ dispose: () => void } | null>(null);

  useEffect(() => {
    subscriptionRef.current?.dispose();
    subscriptionRef.current = null;
    if (!activeTaskId || !generationRunning) return;
    const subscription = wikiService.onDynamicGenerationProgress(activeTaskId)((next) => {
      setProgress(next);
      if (!isWikiTaskInProgress(next.phase)) {
        // 任务结束时刷新一次，拿到最终正文
        void refresh();
      }
    });
    subscriptionRef.current = subscription;
    return () => {
      subscription.dispose();
      subscriptionRef.current = null;
    };
  }, [wikiService, activeTaskId, generationRunning, refresh]);

  const handleGenerate = useCallback(
    async (resumeOnly: boolean) => {
      setProgress({
        taskId: "",
        phase: "planning",
        totalPages: 0,
        completedPages: 0,
        failedPages: 0,
      });
      try {
        // 生成选项全部来自设置页；模型未配置时由服务端回退当前默认模型。
        await wikiService.generate({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(projectSettings.generateDiagrams !== undefined
            ? { generateDiagrams: projectSettings.generateDiagrams }
            : {}),
          ...(projectSettings.language ? { language: projectSettings.language } : {}),
          // 模型（含推理强度）来自本项目配置；未配置时由服务端回退当前默认模型
          ...(projectSettings.modelSelection ? { selection: projectSettings.modelSelection } : {}),
          resumeOnly,
        });
        await refresh();
      } catch (error) {
        setProgress((current) =>
          current
            ? {
                ...current,
                phase: "failed",
                error: error instanceof Error ? error.message : String(error),
              }
            : null,
        );
      }
    },
    [wikiService, workspacePath, workspaceIdentity, projectSettings, refresh],
  );

  const handleCancel = useCallback(async () => {
    await wikiService.cancel({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    });
  }, [wikiService, workspacePath, workspaceIdentity]);

  /**
   * 读一次**本项目**的生成配置（模型 / 图表 / 语言）。
   *
   * 配置按项目存（settings.wikiSettings.projects[workspaceKey]），
   * 因此这里必须按当前 workspace 取，不能读全局那份 —— 全局字段在改成
   * 按项目配置后已废弃，读它会让「设置页改了但面板不生效」。
   * 面板只消费配置、不提供配置入口：配置集中在设置页，避免两处都能改。
   */
  useEffect(() => {
    let cancelled = false;
    void services.settingService
      .get()
      .then((app) => {
        if (cancelled) return;
        const key = workspaceIdentity?.trim() || workspacePath;
        setProjectSettings(app.wikiSettings?.projects?.[key] ?? {});
      })
      .catch(() => {
        // 读不到设置时按服务端默认选项生成
      });
    return () => {
      cancelled = true;
    };
  }, [services.settingService, workspacePath, workspaceIdentity]);

  const selectedPage = useMemo(() => {
    if (state.kind !== "ready" || !selectedPageId) return null;
    const stack = [...state.nodes];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.page?.id === selectedPageId) return node.page;
      stack.push(...node.children);
    }
    return null;
  }, [state, selectedPageId]);

  const toggleNode = useCallback((nodeId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
      data-testid="wiki-pane"
    >
      {/* 头部沿用 pane 约定：h2 标题 + 副标题 + 右侧徽标 */}
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-ui-base font-medium">
              {intl.formatMessage({ id: "wiki.pane.title" })}
            </h2>
            <p className="truncate text-ui-base text-foreground-subtle">
              {workspacePath.split("/").filter(Boolean).pop() ?? workspacePath}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {state.kind === "ready" && state.nodes.length > 0 ? (
              <span className="rounded-full border border-border px-2 py-0.5 text-ui-base text-foreground-subtle">
                {intl.formatMessage(
                  { id: "wiki.summary.pages" },
                  {
                    pages: String(state.nodes.reduce((count, node) => count + countPages(node), 0)),
                    planned: String(state.task?.totalPages ?? 0),
                  },
                )}
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="icon-md"
              onClick={() => void refresh()}
              title={intl.formatMessage({ id: "wiki.action.refresh" })}
            >
              <RefreshCwIcon className="size-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {generationRunning ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 text-ui-base">
          <Loader2Icon className="size-3.5 shrink-0 animate-spin text-foreground-subtle" />
          <span className="truncate">
            {intl.formatMessage(
              { id: "wiki.progress" },
              {
                completed: String(progress?.completedPages ?? 0),
                total: String(progress?.totalPages ?? 0),
              },
            )}
          </span>
          {progress?.currentPageTitle ? (
            <span className="truncate text-foreground-subtle">{progress.currentPageTitle}</span>
          ) : null}
          {progress && progress.failedPages > 0 ? (
            <span className="shrink-0 text-destructive">
              {intl.formatMessage(
                { id: "wiki.progress.failed" },
                { count: String(progress.failedPages) },
              )}
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto shrink-0"
            onClick={() => void handleCancel()}
          >
            <SquareIcon className="size-3" />
            {intl.formatMessage({ id: "wiki.action.cancel" })}
          </Button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <nav className="w-60 shrink-0 overflow-y-auto border-r border-border px-2 py-2">
          {state.kind === "ready" && state.nodes.length > 0 ? (
            state.nodes.map((node) => (
              <CatalogTreeNode
                key={node.id}
                node={node}
                depth={0}
                selectedPageId={selectedPageId}
                onSelect={setSelectedPageId}
                expandedIds={expandedIds}
                onToggle={toggleNode}
              />
            ))
          ) : state.kind === "ready" ? (
            <p className="px-2 py-1 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "wiki.catalog.empty" })}
            </p>
          ) : null}
        </nav>

        <section className="min-w-0 flex-1 overflow-y-auto">
          {state.kind === "loading" ? (
            <div className="flex h-full items-center justify-center gap-2">
              <Loader2Icon className="size-4 animate-spin text-foreground-subtle" />
              <span className="text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "wiki.state.loading" })}
              </span>
            </div>
          ) : state.kind === "error" ? (
            <p className="px-4 py-3 text-ui-base text-destructive">{state.message}</p>
          ) : state.kind === "empty" ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-4 text-center">
              <BookOpenIcon className="size-6 text-foreground-subtle" />
              <p className="max-w-sm text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "wiki.state.empty" })}
              </p>
              <Button variant="default" size="sm" onClick={() => void handleGenerate(false)}>
                <SparklesIcon className="size-3.5" />
                {intl.formatMessage({ id: "wiki.action.generate" })}
              </Button>
            </div>
          ) : selectedPage ? (
            selectedPage.markdown ? (
              <div className="px-4 py-3">
                <MessageResponse workspacePath={workspacePath}>
                  {selectedPage.markdown}
                </MessageResponse>
              </div>
            ) : (
              <div className="h-full p-4">
                <MissingPageNotice title={selectedPage.title} />
              </div>
            )
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-4 text-center">
              <p className="text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "wiki.state.selectPage" })}
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button variant="default" size="sm" onClick={() => void handleGenerate(false)}>
                  <SparklesIcon className="size-3.5" />
                  {intl.formatMessage({ id: "wiki.action.generate" })}
                </Button>
                {state.task && state.task.failedPages > 0 ? (
                  <Button variant="outline" size="sm" onClick={() => void handleGenerate(true)}>
                    {intl.formatMessage(
                      { id: "wiki.action.retryFailed" },
                      { count: String(state.task.failedPages) },
                    )}
                  </Button>
                ) : null}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
