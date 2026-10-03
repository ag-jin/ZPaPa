import type { TeamAgent } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SUBAGENT_COLOR_CLASS, resolveSubagentColorFromName } from "@/lib/subagentColors.js";
import { rosterRowActions } from "./squadSurfaceViewModel.js";

/* 「智能体」页面的**纯呈现**列表（取数与动作都在 SquadAgentsPage）。

   拆出来是为了两件事：① 单文件不越 400 行；② 列表与动作解耦后，"哪些行给哪些按钮"的判据
   只在共享的 `rosterRowActions` 一处出现（本层只照它画），页面只负责调服务。

   **空态在这里**（空列表 + 引导 + 新建按钮在页面头部常驻）：空态不是"没有内容"，
   而是"这里该有什么、怎么开始"的那句话，与列表是同一条渲染分支，分开写会漂移。 */

const LIST_CLASSNAME = "flex flex-col gap-2";
/** 行容器：比所在卡片（rounded-xl）低一级（spec §11.3 的圆角层级）。 */
const ROW_CLASSNAME = "rounded-lg border border-border px-3 py-2";

export function SquadAgentsList({
  agents,
  busyAgentId,
  onEdit,
  onToggle,
  onArchive,
}: {
  agents: TeamAgent[];
  /** 有请求在飞的行 id（照 SquadMinimalView 的 busyRunId 形态）：该行动作按钮全部禁用。 */
  busyAgentId: string | null;
  onEdit: (agent: TeamAgent) => void;
  onToggle: (agent: TeamAgent) => void;
  onArchive: (agent: TeamAgent) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });

  if (agents.length === 0) {
    return (
      <div className="flex flex-col gap-1" data-testid="squad-agents-empty">
        <p className="text-ui-base text-foreground">{t("squad.agents.empty")}</p>
        <p className="text-ui-sm text-foreground-subtlest">{t("squad.agents.emptyHint")}</p>
      </div>
    );
  }

  return (
    <ul className={LIST_CLASSNAME} data-testid="squad-agents-list">
      {agents.map((agent) => {
        const actions = rosterRowActions(agent);
        const busy = busyAgentId === agent.id;
        return (
          <li
            key={agent.id}
            data-agent-id={agent.id}
            className={cn(ROW_CLASSNAME, "flex items-center justify-between gap-3")}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  // 九色板只表达身份，**不编码状态**（spec §11.3）；未设色时按名字稳定取一个。
                  SUBAGENT_COLOR_CLASS[agent.color ?? resolveSubagentColorFromName(agent.name)],
                )}
                aria-hidden
              />
              <span className="break-words text-ui-base text-foreground">{agent.name}</span>
              <span className="text-ui-xs text-foreground-subtlest">
                {t(`squad.common.memoryScope.${agent.memoryScope}`)}
              </span>
              {/* 状态徽标复用既有键（不新造一份文案）。 */}
              {agent.archivedAt !== undefined ? (
                <span className="text-ui-xs text-foreground-subtlest">
                  {t("squad.common.archived")}
                </span>
              ) : null}
              {!agent.enabled ? (
                <span className="text-ui-xs text-foreground-subtlest">
                  {t("squad.common.disabled")}
                </span>
              ) : null}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {/* 已归档 ⇒ 三个动作都不给（归档是终态，仓库里没有"取消归档"）——
                  判据在共享的 rosterRowActions，本层只照它画。 */}
              {actions.canEdit ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  data-testid="squad-agent-edit"
                  onClick={() => onEdit(agent)}
                >
                  {t("squad.common.edit")}
                </Button>
              ) : null}
              {actions.canToggle ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  data-testid="squad-agent-toggle"
                  onClick={() => onToggle(agent)}
                >
                  {agent.enabled ? t("squad.common.disable") : t("squad.common.enable")}
                </Button>
              ) : null}
              {actions.canArchive ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  data-testid="squad-agent-archive"
                  onClick={() => onArchive(agent)}
                >
                  {t("squad.common.archive")}
                </Button>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
