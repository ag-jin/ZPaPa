import type { SquadRunRecord } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { runReviewable, squadRunStatusMessageId } from "./squadEntryViewModel.js";

/* 「待收尾的运行」区块的**纯呈现**（取数与动作都在 WorkItemsPage）。

   与 SquadRunList（随 SquadMinimalView 退役的那段）逐条同形，外加一个**打开会话**的穿透
   入口（用户 2026-10-03 裁定：点某次 run ⇒ 打开它的独立会话；调试一个队员产出最直接的
   去处就是它自己的转写）。本层只把给定的数据画全；标题与空态、列表是同一条渲染分支
   （分开写会漂移：标题在页面、空态在列表，改一处漏一处不报错）。 */

const LIST_CLASSNAME = "flex flex-col gap-2";
/** 行容器：本页**第一个**圆角容器（页面列是布局区，不计层级）⇒ rounded-xl
    （DESIGN.md「Radius ▸ Container hierarchy」）。 */
const ROW_CLASSNAME = "rounded-xl border border-border px-3 py-2";

export function SquadRunsReview({
  runs,
  busyRunId,
  onReview,
  onOpenSession,
}: {
  runs: SquadRunRecord[];
  /** 有请求在飞的行 id（照既有 busyRunId 形态）：该行动作按钮全部禁用。 */
  busyRunId: string | null;
  onReview: (runId: string, verdict: "approved" | "rejected") => void;
  /** 打开该 run 的独立会话（只带 sessionId —— 目标 workspace 由页面的 shell 上下文决定）。 */
  onOpenSession: (sessionId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });

  return (
    <div className="flex flex-col gap-2" data-testid="squad-runs-review">
      <p className="text-ui-base font-medium text-foreground">{t("squad.runs.title")}</p>
      {runs.length === 0 ? (
        <p className="text-ui-sm text-foreground-subtlest" data-testid="squad-runs-empty">
          {t("squad.runs.empty")}
        </p>
      ) : (
        <ul className={LIST_CLASSNAME} data-testid="squad-runs-list">
          {runs.map((run) => {
            const busy = busyRunId === run.runId;
            // 提到局部常量再收窄：闭包里用 `run.sessionId` 会让收窄失效（属性可能在别处被改）。
            const sessionId = run.sessionId;
            return (
              <li
                key={run.runId}
                data-run-id={run.runId}
                className={cn(ROW_CLASSNAME, "flex items-center justify-between gap-3")}
              >
                <span className="flex min-w-0 flex-col gap-1">
                  {/* 分支是「这次运行在哪」的操作性标识；没有分支（队长 run）回落到 runId。 */}
                  <span className="break-all text-ui-base text-foreground">
                    {run.branch ?? run.runId}
                  </span>
                  <span className="text-ui-xs text-foreground-subtle">
                    {t(squadRunStatusMessageId(run.status))}
                    {run.isLeaderTask ? ` · ${t("squad.runs.leader")}` : ""}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {/* 打开会话：只在台账里真有 sessionId 时给 —— 没有会话就没有可打开的东西，
                      给一个点了必然失败的按钮比不给更糟。 */}
                  {sessionId ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      data-testid="run-open-session"
                      onClick={() => onOpenSession(sessionId)}
                    >
                      {t("squad.runs.openSession")}
                    </Button>
                  ) : null}
                  {/* 通过 / 打回：只给**有可裁决产出**的 run（produced / rejected，判据在
                      `runReviewable`）。还在跑的 run 给这两个按钮 = 邀请一次必然失败
                      （spec §17 登记项：对 open 的 run 审查会以 branch_missing 响亮拒绝）——
                      想看进度应该点「打开会话」。 */}
                  {runReviewable(run) ? (
                    <>
                      <Button
                        size="sm"
                        disabled={busy}
                        data-testid="run-approve"
                        onClick={() => onReview(run.runId, "approved")}
                      >
                        {t("squad.runs.approve")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        data-testid="run-reject"
                        onClick={() => onReview(run.runId, "rejected")}
                      >
                        {t("squad.runs.reject")}
                      </Button>
                    </>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
