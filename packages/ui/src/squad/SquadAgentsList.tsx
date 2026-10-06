import type { SquadRunRecord } from "@zcode/services";
import type { TeamAgent } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SUBAGENT_COLOR_CLASS, resolveSubagentColorFromName } from "@/lib/subagentColors.js";
import { rosterRowActions } from "./squadSurfaceViewModel.js";
import { buildAgentPresence } from "./squadPresenceViewModel.js";

/* 「智能体」页面的**纯呈现**列表（取数与动作都在 SquadAgentsPage）。

   拆出来是为了两件事：① 单文件不越 400 行；② 列表与动作解耦后，"哪些行给哪些按钮"的判据
   只在共享的 `rosterRowActions` 一处出现（本层只照它画），页面只负责调服务。

   **空态在这里**（空列表 + 引导 + 新建按钮在页面头部常驻）：空态不是"没有内容"，
   而是"这里该有什么、怎么开始"的那句话，与列表是同一条渲染分支，分开写会漂移。

   **信息密度（2026-10-04 第 52 轮，对照 multica 的 Agents 面）**：智能体是带身份与配置的
   实体，不是一行名字 —— 卡片呈现四层信息：
   · 身份：色块（九色板，未设色按名字稳定取）+ 名字；
   · 配置：**模型徽标**（`modelSelection` 有则给 `modelId · 推理档`，无则「跟随默认」——
     模型是 multica 那侧的一等公民，我们此前完全不可见）+ 记忆作用域；
   · 说明：描述（`description` 有则一行截断；没有就不渲染，不占位不说"无描述"）；
   · 状态：停用 / 已归档徽标（复用既有键）。 */

const LIST_CLASSNAME = "flex flex-col gap-2";
/** 行容器：比所在卡片（rounded-xl）低一级（spec §11.3 的圆角层级）。 */
const ROW_CLASSNAME = "rounded-lg border border-border px-3 py-2";
/** 状态/配置徽标的统一样式：小字、弱前景（信息存在但不与名字抢层级）。 */
const BADGE_CLASSNAME = "text-ui-xs text-foreground-subtlest";

/** 模型徽标文案：有 modelSelection ⇒ `modelId（· 推理档）`；无 ⇒ 「跟随默认模型」。 */
function modelBadgeLabel(agent: TeamAgent): string {
  const selection = agent.modelSelection;
  if (!selection) return "";
  const reasoning = selection.options?.reasoningLevel;
  return reasoning ? `${selection.modelId} · ${reasoning}` : selection.modelId;
}

/** presence 状态点的语义 token（§11.3：状态不靠九色板；working/queued/idle 各一档）。 */
const PRESENCE_DOT_CLASSNAME: Record<"working" | "queued" | "idle", string> = {
  working: "bg-success",
  queued: "bg-warning",
  idle: "bg-border",
};

export function SquadAgentsList({
  agents,
  busyAgentId,
  runs,
  queuedRuns,
  onEdit,
  onToggle,
  onArchive,
  onRestore,
  onOpenDetail,
}: {
  agents: TeamAgent[];
  /** 有请求在飞的行 id（照 SquadMinimalView 的 busyRunId 形态）：该行动作按钮全部禁用。 */
  busyAgentId: string | null;
  /** 活跃 run（snapshot.runs）：presence 的 working 计数源（只认 open）。 */
  runs: SquadRunRecord[];
  /** 排队 run（snapshot.queuedRuns）：排队的**唯一合法数据源**（C5 契约）。 */
  queuedRuns: SquadRunRecord[];
  /** ④刀：行级点击进详情（透明覆盖按钮先例——行内已有独立按钮，整行 button 嵌套非法）。 */
  onOpenDetail?: (agentId: string) => void;
  onEdit: (agent: TeamAgent) => void;
  onToggle: (agent: TeamAgent) => void;
  onArchive: (agent: TeamAgent) => void;
  /** ⑤刀：恢复已归档智能体（归档行唯一动作）。 */
  onRestore: (agent: TeamAgent) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);

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
        const modelBadge = modelBadgeLabel(agent);
        const presence = buildAgentPresence(agent, runs, queuedRuns);
        return (
          <li
            key={agent.id}
            data-agent-id={agent.id}
            className={cn(ROW_CLASSNAME, "relative flex items-start justify-between gap-3")}
          >
            {/* 左：身份 + 配置 + 说明。竖排两行 —— 名字行带徽标，描述行弱化。 */}
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    "size-2.5 shrink-0 rounded-full",
                    // 九色板只表达身份，**不编码状态**（spec §11.3）；未设色时按名字稳定取一个。
                    SUBAGENT_COLOR_CLASS[agent.color ?? resolveSubagentColorFromName(agent.name)],
                  )}
                  aria-hidden
                />
                <span className="break-words text-ui-base text-foreground">{agent.name}</span>
                {/* 模型徽标：协作智能体的「提供商/runtime」那一格（multica 对齐）。 */}
                <span className={BADGE_CLASSNAME} data-testid="squad-agent-model-badge">
                  {modelBadge !== "" ? modelBadge : t("squad.agents.modelDefault")}
                </span>
                <span className={BADGE_CLASSNAME}>
                  {t(`squad.common.memoryScope.${agent.memoryScope}`)}
                </span>
                {/* 状态徽标复用既有键（不新造一份文案）。 */}
                {agent.archivedAt !== undefined ? (
                  <span className={BADGE_CLASSNAME}>{t("squad.common.archived")}</span>
                ) : null}
                {!agent.enabled ? (
                  <span className={BADGE_CLASSNAME}>{t("squad.common.disabled")}</span>
                ) : null}
                {/* presence（T5）：working/queued/idle + 计数。点色只作视觉，语义全在文案
                    （aria-hidden，不裸数字不裸色）；runningCount=0 不渲染「运行中·0」；
                    working+queued 并存双值（+M 排队）；排队数据只来自 snapshot.queuedRuns。 */}
                {presence.workload !== null ? (
                  <span
                    className={BADGE_CLASSNAME}
                    data-testid="squad-presence"
                    aria-label={t(
                      presence.workload === "working"
                        ? "squad.sidebar.working"
                        : presence.workload === "queued"
                          ? "squad.sidebar.queued"
                          : "squad.sidebar.idle",
                      { count: presence.workload === "idle" ? 0 : presence.workload === "queued" ? presence.queuedCount : presence.runningCount },
                    )}
                  >
                    <span
                      className={cn("inline-block size-1.5 rounded-full align-middle", PRESENCE_DOT_CLASSNAME[presence.workload])}
                      aria-hidden
                    />
                    {presence.workload === "working" ? (
                      <>
                        <span data-testid="squad-running-count">
                          {t("squad.sidebar.working", { count: presence.runningCount })}
                        </span>
                        {presence.queuedCount > 0 ? (
                          <span data-testid="squad-queued-count">
                            {t("squad.sidebar.queuedShort", { count: presence.queuedCount })}
                          </span>
                        ) : null}
                      </>
                    ) : presence.workload === "queued" ? (
                      <span data-testid="squad-queued-count">
                        {t("squad.sidebar.queued", { count: presence.queuedCount })}
                      </span>
                    ) : (
                      t("squad.sidebar.idle")
                    )}
                  </span>
                ) : null}
              </span>
              {/* 描述一行截断：没有就不渲染（空占位只会让卡片看起来坏了一半）。 */}
              {agent.description ? (
                <span
                  className="truncate text-ui-sm text-foreground-subtlest"
                  data-testid="squad-agent-description"
                >
                  {agent.description}
                </span>
              ) : null}
            </span>
            {onOpenDetail ? (
              /* 透明覆盖按钮（ConversationStatusPanel 同构）：整行可点进详情，且不嵌套
                 行内动作按钮的合法形态；z 序在动作按钮之下（按钮仍可点）。 */
              <button
                type="button"
                aria-label={t("squad.agentDetail.open", { name: agent.name })}
                data-testid="squad-agent-row-open-detail"
                className="absolute inset-0 z-0 cursor-pointer rounded-lg"
                onClick={() => onOpenDetail(agent.id)}
              />
            ) : null}
            <span className="relative z-10 flex shrink-0 items-center gap-2">
              {/* ⑤刀（裁定#2）：归档可恢复——归档行的唯一动作是「恢复」；
                  其余三个动作仍不给（恢复前不该编辑/启停/再归档）。 */}
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
              {actions.canRestore ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  data-testid="squad-agent-restore"
                  onClick={() => onRestore(agent)}
                >
                  {t("squad.common.restore")}
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
