import type { Squad } from "@zcode/shared";
import type { SquadSnapshot } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveTeamAgentName } from "./squadEntryViewModel.js";
import { buildSquadPresence } from "./squadPresenceViewModel.js";
import { rosterRowActions } from "./squadSurfaceViewModel.js";
import { canCreateSquad } from "./squadsViewModel.js";

/* 「小队」页面的**纯呈现**列表（取数与动作都在 SquadsPage）。

   与 SquadAgentsList **逐条同形**（同一套骨架、同一套 testid 形态）：拆出来是为了两件事
   —— ① 单文件不越 400 行；② 列表与动作解耦后，"哪些行给哪些按钮"的判据只在共享的
   `rosterRowActions` 一处出现（本层只照它画），页面只负责调服务。

   **空态在这里**（空列表 + 引导 + 新建按钮在页面头部常驻）：空态不是"没有内容"，
   而是"这里该有什么、怎么开始"的那句话，与列表是同一条渲染分支，分开写会漂移。
   候选不足时额外说明**为什么**建不了（先去哪建协作智能体）。 */

const LIST_CLASSNAME = "flex flex-col gap-2";
/** 行容器：比所在卡片（rounded-xl）低一级（spec §11.3 的圆角层级）。 */
const ROW_CLASSNAME = "rounded-lg border border-border px-3 py-2";

export function SquadsList({
  squads,
  snapshot,
  busySquadId,
  onEdit,
  onToggle,
  onArchive,
  onRestore,
}: {
  squads: Squad[];
  /** 用来解析队长 / 队员的显示名（`resolveTeamAgentName` 查不到时回落 id）。 */
  snapshot: SquadSnapshot;
  /** 有请求在飞的行 id（照 SquadAgentsPage 的 busyAgentId 形态）：该行动作按钮全部禁用。 */
  busySquadId: string | null;
  onEdit: (squad: Squad) => void;
  onToggle: (squad: Squad) => void;
  onArchive: (squad: Squad) => void;
  /** ⑤刀：恢复已归档小队（归档行唯一动作）。 */
  onRestore: (squad: Squad) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);

  if (squads.length === 0) {
    return (
      <div className="flex flex-col gap-1" data-testid="squads-empty">
        <p className="text-ui-base text-foreground">{t("squad.squads.empty")}</p>
        <p className="text-ui-sm text-foreground-subtlest">{t("squad.squads.emptyHint")}</p>
        {/* 候选不足 ⇒ 把「为什么建不了、先去哪」说明白（判据是纯函数 canCreateSquad，
            与页面头部「新建」按钮的置灰**同一个**判据）。 */}
        {!canCreateSquad(snapshot) ? (
          <p className="text-ui-sm text-foreground-subtlest">
            {t("squad.squads.noDispatchableAgentsHint")}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <ul className={LIST_CLASSNAME} data-testid="squads-list">
      {squads.map((squad) => {
        const actions = rosterRowActions(squad);
        const busy = busySquadId === squad.id;
        /* 队员显示**除队长外**的成员名（队长单独在「队长：」后显示，避免同一人出现两次）。
           查不到回落 id（`resolveTeamAgentName`）：显示空会让名册看起来缺人。 */
        const memberNames = squad.members
          .filter((member) => member.agentId !== squad.leaderAgentId)
          .map((member) => resolveTeamAgentName(snapshot, member.agentId));
        const presence = buildSquadPresence(
          squad,
          snapshot.teamAgents,
          snapshot.runs,
          snapshot.queuedRuns,
        );
        return (
          <li
            key={squad.id}
            data-squad-id={squad.id}
            data-testid={`squad-profile-card-${squad.id}`}
            className={cn(ROW_CLASSNAME, "flex items-center justify-between gap-3")}
          >
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="break-words text-ui-base text-foreground">{squad.name}</span>
              <span className="text-ui-xs text-foreground-subtlest">
                {t("squad.squads.leaderLabel")}
                {resolveTeamAgentName(snapshot, squad.leaderAgentId)}
                {/* 只有队长（无其它队员）是合法的小队 ⇒ 队员段整体省略，不留一个空的「队员：」。 */}
                {memberNames.length > 0 ? (
                  <>
                    {" · "}
                    {t("squad.squads.membersLabel")}
                    {memberNames.join("、")}
                  </>
                ) : null}
              </span>
              {/* T6 头像堆叠：可见 3 + "+N"（可读文案）；重叠 -ml-1.5（≈8px）+ surface 描边。 */}
              <span className="flex items-center" data-testid="squad-avatar-stack" aria-hidden>
                {presence.avatarStack.map((entry) => (
                  <span
                    key={entry.agentId}
                    className={cn(
                      "size-2.5 rounded-full ring-1 ring-background first:ml-0 -ml-1.5",
                      entry.colorClass,
                    )}
                  />
                ))}
                {presence.avatarOverflow > 0
                  ? t("squad.sidebar.moreMembers", { count: presence.avatarOverflow })
                  : null}
              </span>
              <span className="text-ui-xs text-foreground-subtlest">
                {t("squad.sidebar.agentCount", { count: presence.activeMemberCount })}
              </span>
              {/* T6 聚合 presence：与智能体行同一套呈现（Σ 成员 count(open) / Σ queued）；
                  归档小队 workload=null ⇒ 不显示可运行状态（只留「已归档」）。 */}
              {presence.workload !== null ? (
                <span
                  className="text-ui-xs text-foreground-subtlest"
                  data-testid="squad-presence"
                >
                  <span
                    className={cn(
                      "mr-1 inline-block size-1.5 rounded-full align-middle",
                      presence.workload === "working"
                        ? "bg-success"
                        : presence.workload === "queued"
                          ? "bg-warning"
                          : "bg-border",
                    )}
                    aria-hidden
                  />
                  {presence.workload === "working"
                    ? t("squad.sidebar.working", { count: presence.runningCount })
                    : presence.workload === "queued"
                      ? t("squad.sidebar.queued", { count: presence.queuedCount })
                      : t("squad.sidebar.idle")}
                  {presence.workload === "working" && presence.queuedCount > 0
                    ? t("squad.sidebar.queuedShort", { count: presence.queuedCount })
                    : null}
                </span>
              ) : null}
              {/* 状态徽标复用既有键（不新造一份文案）。 */}
              {squad.archivedAt !== undefined ? (
                <span className="text-ui-xs text-foreground-subtlest">
                  {t("squad.common.archived")}
                </span>
              ) : null}
              {!squad.enabled ? (
                <span className="text-ui-xs text-foreground-subtlest">
                  {t("squad.common.disabled")}
                </span>
              ) : null}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {/* ⑤刀（裁定#2）：归档可恢复——归档行的唯一动作是「恢复」。 */}
              {actions.canEdit ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  data-testid="squad-row-edit"
                  onClick={() => onEdit(squad)}
                >
                  {t("squad.common.edit")}
                </Button>
              ) : null}
              {actions.canToggle ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  data-testid="squad-row-toggle"
                  onClick={() => onToggle(squad)}
                >
                  {squad.enabled ? t("squad.common.disable") : t("squad.common.enable")}
                </Button>
              ) : null}
              {actions.canRestore ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  data-testid="squad-row-restore"
                  onClick={() => onRestore(squad)}
                >
                  {t("squad.common.restore")}
                </Button>
              ) : null}
              {actions.canArchive ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  data-testid="squad-row-archive"
                  onClick={() => onArchive(squad)}
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
