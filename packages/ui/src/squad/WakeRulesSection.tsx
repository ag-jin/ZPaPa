import { useCallback, useEffect, useMemo, useState } from "react";
import type { CreateWakeRuleRequest } from "@zcode/services";
import type { WakeRule, WorkItem } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { CreateWakeRuleDialog } from "./CreateWakeRuleDialog.js";
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
import {
  WAKE_RULE_STATUS_BADGE_CLASSES,
  WAKE_RULE_STATUS_MESSAGE_IDS,
  formatWakeRuleTime,
  resolveWorkItemTitle,
  wakeRuleRowState,
  wakeRuleScheduleParts,
} from "./wakeRulesViewModel.js";

/* 「唤醒规则」分区（「工作项」一级页面里的一块，spec §11.1 / UI 方案承诺的「项目窗口 ▸ 规则」）：
   列出本项目的唤醒规则（`listWakeRules` 按工作项反查 ⇒ 作用域就是这个项目）、建新规则
   （`createWakeRule`）、启停（`pauseWakeRule` / `resumeWakeRule`）。

   为什么挂「工作项」页而不是「自动化」页（已定口径）：规则挂在**工作项**上、按 workspace 反查
   ⇒ 它天然是项目作用域的；而 spec §5.6 明确 cron 自动化与唤醒规则是两套**分工**的机制 ——
   混进「自动化」页会让用户把两套机制读成一套。

   **props 只收 `workItems`（不收整个 snapshot）**：本分区需要的快照内容只有它 ——
   行标题查它、建规则的宿主候选来自它；runs / teamAgents / squads 与本分区无关，
   收下整个 snapshot 只是把「本分区到底依赖什么」这条信息弄糊。

   **取数/写动作的层界**（自己定，写清）：本分区**自含**所有唤醒规则的取数与写动作
   （mount + 刷新钮取列表；暂停 / 启用 / 新建都在这里调服务）。不把这些上交给 WorkItemsPage：
   列表状态（`rules` / 失败 / 重载）是分区自己的，把 create 放页面 = 页面要回调分区重载列表
   （跨层耦合）；而页面那边的新建 / 编辑 / 改派是**快照驱动**的（动作成功后重取整张快照），
   与本分区的数据源不同。失败翻译照既有形态：`squadEntryErrorFeedback`（含门禁拒绝）/
   `squadServiceUnavailableFeedback`（服务没接上）、toast 带原始 detail（**不吞错**）。

   **写动作单飞**（一次只允许一个在飞）：`busyRuleId` 是单值 —— 在飞期间**所有**行的动作一起
   禁用（与 `runRuleAction` 的前置挡重一致：只禁在飞行、别的行还能点，就会有一条「点了没反应」
   的静默路径）。新建在飞时同理（`creating` 禁掉新建钮与对话框重复提交）。

   四态齐全：加载中（首帧 / 重试中，**重试优先于旧失败**）/ 错误（带原因 + 重试）/
   空（一句话 + 一行 hint）/ 列表行。有数据时刷新失败 ⇒ 一行提示（**不清空已有数据**），
   重试走标题行刷新钮（照 SquadRunsDirectorySection 的既有口径）。 */

const LIST_CLASSNAME = "flex flex-col gap-2";
/** 行容器：比所在卡片（rounded-xl）低一级（spec §11.3 的圆角层级，照 SquadRunsReview）。 */
const ROW_CLASSNAME = "rounded-lg border border-border px-3 py-2";

export function WakeRulesSection({
  workspacePath,
  workspaceIdentity,
  workItems,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 当前项目的工作项（= 规则宿主候选 + 行标题的解析源）。由页面从快照里投影给本分区。 */
  workItems: WorkItem[];
}) {
  const { intl, locale } = useZCodeIntl();
  const services = useServices();

  const target = useMemo(
    () => squadWorkspaceTarget(workspacePath, workspaceIdentity),
    [workspacePath, workspaceIdentity],
  );

  /** 最近一次**成功**读到列表（失败不清空它 —— 刷新失败要变成 ready 之上的一行提示）。 */
  const [rules, setRules] = useState<WakeRule[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<SquadEntryFeedback | null>(null);
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  /** 文案：带占位符替换的一种（`values` 供 kind 相关句式与进度文案用）。 */
  const t = useCallback(
    (id: string, values?: Record<string, string | number>) => intl.formatMessage({ id }, values),
    [intl],
  );

  /** 提示一律**响亮**：warning 走 toast 变体；失败额外带原始细节（不吞错，照 WorkItemsPage）。 */
  const notify = useCallback(
    (feedback: SquadEntryFeedback) => {
      const message = feedback.detail
        ? `${t(feedback.messageId)}：${feedback.detail}`
        : t(feedback.messageId);
      toast(message, feedback.tone === "warning" ? { variant: "warning" } : undefined);
    },
    [t],
  );

  /* 重载：**失败不清空已有列表**。取数通路必须经 `resolveSquadRuntimeService`（缺服务时响亮抛，
     见 squadRuntimeAccess 的头注）——`listWakeRules` 与 `getSnapshot` 不同：它不过门禁
     （只看有哪些规则不算新派发），实验关着也能读。 */
  const reload = useCallback(async () => {
    if (!target) return;
    setLoading(true);
    try {
      const service = resolveSquadRuntimeService(services);
      setRules(await service.listWakeRules(target));
      setFailure(null);
    } catch (error) {
      logger.error("[WakeRulesSection] 读取唤醒规则失败", {
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

  /**
   * 暂停 / 启用的唯一执行点（动作 → 服务方法的映射只此一处；用例逐条钉住这个映射）。
   * 置忙 → 调服务 → 成功提示 + 重载 / 失败提示（不吞错）→ 复位，照页面的 runAction 形态。
   * 前置挡重（`busyRuleId !== null`）与按钮禁用**同一个判据**：不并存「点了没反应」的路径。
   */
  const runRuleAction = useCallback(
    async (ruleId: string, action: "pause" | "resume") => {
      if (!target || busyRuleId !== null) return;
      setBusyRuleId(ruleId);
      try {
        const service = resolveSquadRuntimeService(services);
        await (action === "pause"
          ? service.pauseWakeRule(target, { id: ruleId })
          : service.resumeWakeRule(target, { id: ruleId }));
        notify({
          tone: "success",
          messageId: action === "pause" ? "squad.rules.paused" : "squad.rules.resumed",
        });
        await reload();
      } catch (error) {
        logger.warn("[WakeRulesSection] 唤醒规则操作失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        notify(squadEntryErrorFeedback(error));
      } finally {
        setBusyRuleId(null);
      }
    },
    [busyRuleId, notify, reload, services, target],
  );

  /**
   * 新建的提交路径（对话框已用 `buildCreateWakeRuleInput` 校验过，收进来的是**合法入参**）。
   * 成功 ⇒ 关框 + toast + 重载；失败 ⇒ **不关框**（重试就在眼前）+ 失败提示（含门禁拒绝）。
   * 另有一层挡重（`creating`），与对话框壳的 canSubmit 同一个判据来源。
   */
  const submitCreate = useCallback(
    (input: CreateWakeRuleRequest) => {
      if (!target || creating) return;
      void (async () => {
        setCreating(true);
        try {
          await resolveSquadRuntimeService(services).createWakeRule(target, input);
          setCreateOpen(false);
          notify({ tone: "success", messageId: "squad.rules.created" });
          await reload();
        } catch (error) {
          logger.warn("[WakeRulesSection] 创建唤醒规则失败", {
            error: error instanceof Error ? error.message : String(error),
          });
          notify(squadEntryErrorFeedback(error));
        } finally {
          setCreating(false);
        }
      })();
    },
    [creating, notify, reload, services, target],
  );

  /** 写动作在飞（暂停 / 启用 / 新建任一）——行内动作与新建钮的公共禁用判据。 */
  const writing = busyRuleId !== null || creating;

  return (
    <section className="flex flex-col gap-2" data-testid="squad-rules-section">
      {/* 标题行常驻（与页面的动作行同款理由：入口可见性不依赖取数成功）。 */}
      <div className="flex items-center justify-between gap-2">
        <p className="text-ui-base font-medium text-foreground">{t("squad.rules.title")}</p>
        <span className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!target || loading}
            data-testid="squad-rules-refresh"
            onClick={() => {
              void reload();
            }}
          >
            {loading ? <Spinner className="size-3.5" /> : null}
            {t("squad.common.refresh")}
          </Button>
          {/* 宿主候选为空（本项目还没有工作项）⇒ 置灰：规则挂不上任何东西，开框必然失败。 */}
          <Button
            size="sm"
            disabled={!target || workItems.length === 0 || writing}
            data-testid="squad-rules-create"
            onClick={() => setCreateOpen(true)}
          >
            {t("squad.rules.create")}
          </Button>
        </span>
      </div>

      {!target ? (
        <p className="text-ui-sm text-foreground-subtlest" data-testid="squad-rules-no-workspace">
          {t("squad.common.noWorkspace")}
        </p>
      ) : null}

      {/* 加载中（**重试优先于旧失败**：点重试后必须真的进入「正在读取」）。 */}
      {target && rules === null && (loading || !failure) ? (
        <div
          className="flex items-center gap-2 text-ui-sm text-foreground-subtle"
          data-testid="squad-rules-loading"
        >
          <Spinner className="size-3.5" />
          {t("squad.rules.loading")}
        </div>
      ) : null}

      {/* 无数据 + 失败了 ⇒ 错误态（**必须带原因**）+ 重试。 */}
      {target && rules === null && !loading && failure ? (
        <div className="flex flex-col gap-2" data-testid="squad-rules-error">
          <p role="alert" className="text-ui-sm text-[var(--color-danger)]">
            {t("squad.rules.loadFailed")}：{t(failure.messageId)}
            {failure.detail ? `：${failure.detail}` : ""}
          </p>
          <span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void reload();
              }}
            >
              {t("squad.common.refresh")}
            </Button>
          </span>
        </div>
      ) : null}

      {target && rules !== null ? (
        <>
          {/* 有数据但最近一次刷新失败 ⇒ 一行提示（数据仍在，**不清空**），重试走标题行刷新钮。 */}
          {failure ? (
            <p
              role="alert"
              className="text-ui-xs text-[var(--color-danger)]"
              data-testid="squad-rules-load-failure"
            >
              {t(failure.messageId)}
              {failure.detail ? `：${failure.detail}` : ""}
            </p>
          ) : null}

          {rules.length === 0 ? (
            <div className="flex flex-col gap-1" data-testid="squad-rules-empty">
              <p className="text-ui-base text-foreground">{t("squad.rules.empty")}</p>
              {/* 无工作项时「新建规则」是**置灰**的（规则必须挂在某条工作项上）——此时那句
                  「点新建规则选一条工作项」是句空话（按钮点不动）：换成定向指引，
                  置灰的按钮旁边必须能读到**为什么**（本项目一路的既有纪律）。 */}
              <p className="text-ui-sm text-foreground-subtlest">
                {workItems.length === 0
                  ? t("squad.rules.noWorkItemsHint")
                  : t("squad.rules.emptyHint")}
              </p>
            </div>
          ) : (
            <ul className={LIST_CLASSNAME} data-testid="squad-rules-list">
              {rules.map((rule) => {
                // 状态 / 行动作可用性走纯函数（矩阵与优先级可被 node:test 钉住）。
                const rowState = wakeRuleRowState(rule);
                const parts = wakeRuleScheduleParts(rule);
                return (
                  <li
                    key={rule.id}
                    data-rule-id={rule.id}
                    className={cn(ROW_CLASSNAME, "flex items-center justify-between gap-3")}
                  >
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        {/* 宿主工作项标题（查不到回落 id —— 工作项已归档时仍要看得出规则挂在哪）。 */}
                        <span className="break-words text-ui-base text-foreground">
                          {resolveWorkItemTitle(workItems, rule.workItemId)}
                        </span>
                        <span
                          className={cn(
                            "shrink-0 rounded-full px-2 py-0.5 text-ui-xs",
                            WAKE_RULE_STATUS_BADGE_CLASSES[rowState.status],
                          )}
                        >
                          {t(WAKE_RULE_STATUS_MESSAGE_IDS[rowState.status])}
                        </span>
                      </span>
                      <span className="break-all text-ui-xs text-foreground-subtle">
                        {/* 排期描述：kind 决定句式（走 i18n）；取不到排期事实 ⇒ 中性的「配置缺失」。
                            到点时刻用本地时区显示（与调度口径一致 —— timezone 字段只落盘不留存生效，
                            见 CreateWakeRuleRequest 的 doc）。 */}
                        {parts === null
                          ? t("squad.rules.configMissing")
                          : parts.kind === "at"
                            ? t("squad.rules.schedule.at", {
                                time: formatWakeRuleTime(parts.at, locale),
                              })
                            : parts.kind === "every"
                              ? t("squad.rules.schedule.every", {
                                  seconds: parts.intervalSeconds,
                                })
                              : t("squad.rules.schedule.cron", {
                                  expression: parts.cronExpression,
                                })}
                        {/* 上限 / 已触发：**有显式上限**才显示 `fireCount / maxFires`。没设上限的规则
                            不显示（调度侧对连续规则按默认 20 执行，但那个 20 不是用户设的配置 ——
                            显示成「3 / 20」会让用户以为上限就是 20 已配置）。 */}
                        {rule.maxFires !== undefined
                          ? ` · ${t("squad.rules.fireProgress", {
                              count: rule.fireCount,
                              max: rule.maxFires,
                            })}`
                          : ""}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {/* 暂停 / 启用由纯函数 wakeRuleRowState 给出（在跑才可暂停；两种暂停都可
                          恢复 —— 闸暂停的复位路径也是 resume）。写动作单飞 ⇒ 在飞期间全禁用。 */}
                      {rowState.canPause ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={writing}
                          data-testid="rule-pause"
                          onClick={() => {
                            void runRuleAction(rule.id, "pause");
                          }}
                        >
                          {t("squad.rules.pause")}
                        </Button>
                      ) : null}
                      {rowState.canResume ? (
                        <Button
                          size="sm"
                          disabled={writing}
                          data-testid="rule-resume"
                          onClick={() => {
                            void runRuleAction(rule.id, "resume");
                          }}
                        >
                          {t("squad.rules.resume")}
                        </Button>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : null}

      {/* 新建对话框：本分区持有开关与提交路径（成功关框 + toast + 重载；失败不关框）；
          对话框本身只收集 + 校验 + 回意图。 */}
      {createOpen && target ? (
        <CreateWakeRuleDialog
          workItems={workItems}
          busy={creating}
          onClose={() => setCreateOpen(false)}
          onSubmit={submitCreate}
        />
      ) : null}
    </section>
  );
}
