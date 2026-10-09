import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { SquadSnapshot } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SUBAGENT_COLOR_CLASS } from "@/lib/subagentColors.js";
import {
  squadEntryErrorFeedback,
  squadServiceUnavailableFeedback,
  type SquadEntryFeedback,
} from "./squadEntryViewModel.js";
import {
  SQUAD_RUNTIME_SERVICE_UNAVAILABLE_CODE,
  resolveSquadRuntimeService,
  squadWorkspaceTarget,
} from "./squadRuntimeAccess.js";
import { squadSurfaceViewState } from "./squadSurfaceViewModel.js";
import { squadRunDirectoryRows } from "./squadRunsDirectoryViewModel.js";

/* 会话「智能体目录」侧栏里的「小队运行（本项目）」分区：列出本项目在跑的小队 run
   （头像 + 名字 + 队长/队员徽标 + 运行状态 + 分支），点「打开会话」→ 打开它的独立会话。

   为什么取数口径与状态机照搬三个小队页面（不另造一套）：同一份服务（`resolveSquadRuntimeService`
   → `getSnapshot(target)`）、同一个共享状态机（`squadSurfaceViewState`）、同一套失败翻译
   （`squadEntryErrorFeedback` / `squadServiceUnavailableFeedback`）。本分区没有写动作，
   只有**打开时取数**（mount）+ 刷新按钮 —— duplicate 提交纪律同款：loading 期间刷新按钮禁用。

   scope 由宿主目录的 tab 给（props 的 workspacePath / workspaceIdentity），**不从 tab store 读**：
   再从 store 读一份等于同一语义两处来源，而分叉不报错（照 SquadAgentsPage 的理由）。

   整段的显隐（远端投射边界 / 实验开关）不在这里判 —— 宿主用纯函数
   `squadDirectorySectionVisible` 决定渲不渲染本组件；本组件只管把已渲染的分区画全。 */

export const SquadRunsDirectorySection = memo(function SquadRunsDirectorySection({
  workspacePath,
  workspaceIdentity,
  onOpenSession,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 打开某个 run 的独立会话（由宿主目录 → 侧栏 → shell 逐级接线，目标是本 workspace）。 */
  onOpenSession: (sessionId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const services = useServices();

  const target = useMemo(
    () => squadWorkspaceTarget(workspacePath, workspaceIdentity),
    [workspacePath, workspaceIdentity],
  );

  const [snapshot, setSnapshot] = useState<SquadSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<SquadEntryFeedback | null>(null);

  const t = useCallback((id: string) => intl.formatMessage({ id }), [intl]);

  /* 读取（mount 一次 + 刷新按钮）：**失败不清空已有快照** —— 刷新失败要变成 ready 之上的
     一行提示，而不是把「你的小队运行都没了」这句话说出来（同三个小队的页面）。 */
  const reload = useCallback(async () => {
    if (!target) return;
    setLoading(true);
    try {
      const service = resolveSquadRuntimeService(services);
      setSnapshot(await service.getSnapshot(target));
      setFailure(null);
    } catch (error) {
      logger.error("[SquadRunsDirectorySection] 读取小队运行失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      setFailure(
        (error as { code?: unknown } | null)?.code === SQUAD_RUNTIME_SERVICE_UNAVAILABLE_CODE
          ? squadServiceUnavailableFeedback()
          : squadEntryErrorFeedback(error),
      );
    } finally {
      setLoading(false);
    }
  }, [services, target]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const state = squadSurfaceViewState({
    hasTarget: target !== null,
    snapshot,
    loading,
    failure,
  });
  const rows = state.mode === "ready" ? squadRunDirectoryRows(state.snapshot) : [];

  return (
    <section className="mt-5" data-testid="squad-runs-directory">
      {/* 标题行：标题用两个既有分区的同一档；刷新按钮挂这里（分区自己没有动作行，
          照三个页面「刷新常驻、loading 期间置灰」的形态）。计数只在读到时给 —— 读不到还显示
          「0」会是一句假话（它与空态文案重复，且会随失败/加载状态漂移）。 */}
      <div className="flex items-center justify-between gap-2 px-3 pb-1.5">
        <h3 className="min-w-0 truncate text-ui-sm font-medium text-foreground-subtlest">
          {t("subagentDirectory.squadRuns.title")}
          {state.mode === "ready" ? ` · ${rows.length}` : ""}
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!target || loading}
          data-testid="squad-runs-directory-refresh"
          onClick={() => {
            void reload();
          }}
        >
          {loading ? <Spinner className="size-3.5" /> : null}
          {t("squad.common.refresh")}
        </Button>
      </div>

      {state.mode === "no-workspace" ? (
        <p
          className="px-3 py-2 text-ui-sm text-foreground-subtlest"
          data-testid="squad-runs-directory-no-workspace"
        >
          {t("squad.common.noWorkspace")}
        </p>
      ) : null}

      {state.mode === "loading" ? (
        <div
          className="flex items-center gap-2 px-3 py-2 text-ui-sm text-foreground-subtle"
          data-testid="squad-runs-directory-loading"
        >
          <Spinner className="size-3.5" />
          {t("common.loading")}
        </div>
      ) : null}

      {/* 无数据 + 失败 ⇒ 错误态（**必须带原因**）+ 重试。取数通路缺失（服务没接上）经
          `squadServiceUnavailableFeedback` 翻成「服务未接上」这一类单列文案。 */}
      {state.mode === "error" ? (
        <div className="px-3 py-2" data-testid="squad-runs-directory-error">
          <p role="alert" className="text-ui-sm text-[var(--color-danger)]">
            {t("subagentDirectory.squadRuns.loadFailed")}：{t(state.feedback.messageId)}
            {state.feedback.detail ? `：${state.feedback.detail}` : ""}
          </p>
          <Button
            className="mt-2"
            variant="outline"
            size="sm"
            onClick={() => {
              void reload();
            }}
          >
            {t("squad.common.refresh")}
          </Button>
        </div>
      ) : null}

      {state.mode === "ready" ? (
        <>
          {/* 实验已关闭：呈现横幅（整段显隐由宿主的 squadDirectorySectionVisible 负责；
              这里是设置与快照短暂不一致的窗口里的兜底呈现，不是门禁）。 */}
          {state.experimentDisabled ? (
            <p
              className="px-3 pb-1 text-ui-xs text-foreground-subtle"
              data-testid="squad-runs-directory-experiment-off"
            >
              {t("squad.common.experimentOff")}
            </p>
          ) : null}

          {/* 有数据但最近一次刷新失败 ⇒ 一行提示（数据仍在，**不清空**），重试走标题行的刷新按钮。 */}
          {state.loadFailure ? (
            <p role="alert" className="px-3 pb-1 text-ui-xs text-[var(--color-danger)]">
              {t(state.loadFailure.messageId)}
              {state.loadFailure.detail ? `：${state.loadFailure.detail}` : ""}
            </p>
          ) : null}

          {rows.length === 0 ? (
            <p
              className="px-3 py-3 text-ui-base text-foreground-subtlest"
              data-testid="squad-runs-directory-empty"
            >
              {t("subagentDirectory.squadRuns.empty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-2" data-testid="squad-runs-directory-list">
              {rows.map((row) => {
                // 提到局部常量再收窄：闭包里用 `row.sessionId` 会让收窄失效（属性可能在别处被改）——
                // 照 SquadRunsReview 的同款写法。
                const sessionId = row.sessionId;
                return (
                  <li
                    key={row.runId}
                    data-run-id={row.runId}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                  >
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="flex min-w-0 items-center gap-2">
                        {/* 九色板只表达身份，不编码状态（spec §11.3）——与智能体列表同一款式子。 */}
                        <span
                          className={cn(
                            "size-2 shrink-0 rounded-full",
                            SUBAGENT_COLOR_CLASS[row.color],
                          )}
                          aria-hidden
                        />
                        <span className="truncate text-ui-base text-foreground">
                          {row.agentName}
                        </span>
                        {/* 队长 / 队员徽标：判据在视图模型里（纯函数，可被 node:test 钉住），本层照抄渲染。 */}
                        <span className="shrink-0 text-ui-xs text-foreground-subtlest">
                          {t(row.roleMessageId)}
                        </span>
                      </span>
                      {/* 状态文案复用 squad.runs.status.*；分支是「这次运行在哪」的操作性标识，
                          没有分支（队长 run）回落到 runId（判据在视图模型）。 */}
                      <span className="break-all text-ui-xs text-foreground-subtle">
                        {t(row.statusMessageId)} · {row.branchLabel}
                      </span>
                    </span>
                    {/* 打开会话：只在台账里真有 sessionId 时给 —— 没有会话就没有可打开的东西，
                        给一个点了必然失败的按钮比不给更糟（判据与守卫形态照 SquadRunsReview）。 */}
                    {sessionId ? (
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid="squad-run-open-session"
                        onClick={() => onOpenSession(sessionId)}
                      >
                        {t("squad.runs.openSession")}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
});
