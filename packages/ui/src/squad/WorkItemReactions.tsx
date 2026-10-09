import { useMemo, useState } from "react";
import { SmilePlus } from "lucide-react";
import type { AuthorRef } from "@zcode/services";
import type { WorkItem } from "@zcode/shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { WorkItemReactionChips } from "./WorkItemReactionChips.js";
import { useWorkItemReactions } from "./useWorkItemReactions.js";
import {
  WORK_ITEM_REACTION_EMOJIS,
  workItemReactionsTarget,
} from "./workItemReactionsViewModel.js";

/* 工作项回应的**选择器**（阶段三 · T-P3-R5u；纯呈现 + 一个本地的展开态）。

   形态取自 multica 的 `ReactionBar` + `QuickEmojiPicker`（取证报告 §1 Q3/Q4）：入口是一枚
   常驻的「+ 表情」按钮（0 反应时也画 —— 详情页 `showPicker=true`），点开是 8 枚快捷表情的
   listbox；**已选过的那一枚不禁用**：再点它就是撤销（卡面 toggle 语义「点 picker=添加
   （已选过的=撤销）」）—— 评论回应那一套「已回应 ⇒ 禁用」是**只增**语义，不适用。

   两个导出都是纯的（展开态在 `WorkItemReactionPicker` 内部）：组件测试对 SSR 的**首帧**生效，
   `WorkItemReactionOptions` 单独导出以便把「点开之后」的形态也逐格钉住（照
   `WorkItemChildAddFailureLine` 的先例）。 */

/** 「我已反应」的那几枚（在途的那一枚用 `pendingEmoji` 单独禁用，其余照常可点）。 */
type WorkItemReactionOptionsProps = {
  reactedEmojis: ReadonlySet<string>;
  pendingEmoji: string | null;
  onToggle: (emoji: string) => void;
};

/** 展开后的 8 枚快捷表情（listbox；键位路径由容器上的 Escape 关闭承接）。 */
export function WorkItemReactionOptions({
  reactedEmojis,
  pendingEmoji,
  onToggle,
}: WorkItemReactionOptionsProps) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  return (
    <ul
      role="listbox"
      aria-label={t("squad.workItemDetail.reactions.add")}
      className="flex flex-wrap items-center gap-1"
    >
      {WORK_ITEM_REACTION_EMOJIS.map((emoji) => {
        const mine = reactedEmojis.has(emoji);
        return (
          <li key={emoji}>
            <button
              type="button"
              role="option"
              aria-selected={mine}
              disabled={pendingEmoji === emoji}
              data-testid={`work-item-reactions-option-${emoji}`}
              onClick={() => onToggle(emoji)}
              className={cn(
                "flex h-7 items-center justify-center rounded-md border px-2 text-ui-sm",
                mine
                  ? "border-brand/30 bg-brand/10 text-brand"
                  : "border-border text-foreground-subtle enabled:hover:border-border-hover",
              )}
            >
              <span aria-hidden>{emoji}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 入口按钮 + 展开态。`onToggle` 收到的是**被点的那一枚**（撤销还是置上由接线层判：它手里才有
 * 完整的行集与观察者身份）。
 */
export function WorkItemReactionPicker({
  reactedEmojis,
  pendingEmoji,
  onToggle,
}: WorkItemReactionOptionsProps) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const [open, setOpen] = useState(false);
  return (
    <span
      className="flex flex-col gap-1"
      /* Escape 先收菜单（不改变任何已提交事实）—— 键盘用户不必去点别处。 */
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={t("squad.workItemDetail.reactions.add")}
        aria-expanded={open}
        aria-haspopup="listbox"
        data-testid="work-item-reactions-add"
        onClick={() => setOpen((previous) => !previous)}
      >
        <SmilePlus aria-hidden className="size-3.5" />
      </Button>
      {open ? (
        <WorkItemReactionOptions
          reactedEmojis={reactedEmojis}
          pendingEmoji={pendingEmoji}
          onToggle={(emoji) => {
            setOpen(false);
            onToggle(emoji);
          }}
        />
      ) : null}
    </span>
  );
}

/* 详情页概览尾部的**固定一行**（阶段三 · T-P3-R5u；multica 的 `issue-detail.tsx:3511-3523` 同位）。

   为什么是**自足**的（而不是从页面接钱）：`WorkItemDetailPage.tsx` 是 399/400 的冻结页面
   （本轮零改动，拆解的排它裁定），概览只收到 `workItem` 本体 —— 于是：
   · **目标**按行自身的来源反推（`workItemReactionsTarget`，收件箱 `inboxItemUnsubscribeTarget`
     同一手法）；
   · **观察者身份**本挂载点拿不到（读面的 `viewerActor` 没有传进来）⇒ 传 `null`：聚合如实给
     `reactedByMe: null`（不假装「不是我」），由写路径沿两条**可靠**推理补上：
     ①恰一行新增 ⇒ 那行的作者就是我（`workItemReactionLearnedViewer`），此后按 `(kind,id)`
     逐行判定，历史行一并点亮；②「置上」没有多行 ⇒ 命中了五元组唯一键 ⇒ 这一枚本来就是我
     （`workItemReactionOwnEmojisAfterWrite` 的本机集），故第一次点击之后同一枚再点即撤销。
     见交付报告的「viewer 身份取法」一段；接缝写给 R4/T-P3-V：把读面的 `viewerActor` 传进来
     即可让**未按过的**历史行也一并点亮（本机集只在按下之后才知道那一枚归我）。

   三条呈现纪律：
   ① **首帧零字节**：读还没回来（`loaded === false`）时整块不渲染 —— 「还没读到」与「0 反应」
      是两件事，预判空态等于把故障说成事实；概览区还压着一份逐字节搬件基线，挂上来的东西
      不能在首帧画任何字节。
   ② **0 反应只画入口**：`groups` 为空时不画 chip 组，但仍然画「+ 表情」入口（multica 详情页
      `showPicker=true` 的同位语义）。
   ③ **归档行整块不出现**：服务面把归档行「视同不存在」（读也抛、写也抛），页面头部已有
      「已归档」标记 —— 这里不编一条读不到的原因行（归档项没有回应呈现面）。 */

export function WorkItemReactions({
  workItem,
  viewerActor,
}: {
  /** 工作项本体（协作读模型带回；本块只消费它 —— 不自己取数、不自己拼 target）。 */
  workItem: Pick<WorkItem, "id" | "workspacePath" | "workspaceIdentity" | "archivedAt">;
  /** 观察者身份（读面带回的 `viewerActor`）；`null` = 本挂载点拿不到（见上「自足」一段）。 */
  viewerActor: AuthorRef | null;
}) {
  const archived = workItem.archivedAt !== undefined;
  const workItemId = archived ? null : workItem.id;
  /* 目标按**值**稳定（同一个 workItem 的多次渲染拿到同一个对象）：写路径的目标代守卫据此换代，
     每次渲染新造对象会让在途的写返回被误判过期。 */
  const target = useMemo(
    () => (archived ? null : workItemReactionsTarget(workItem)),
    [archived, workItem.workspaceIdentity, workItem.workspacePath],
  );
  const { groups, loaded, failure, pendingEmoji, toggle, reload } = useWorkItemReactions({
    target,
    workItemId,
    viewerActor,
  });
  if (archived || target === null || workItemId === null) return null;
  /* ① 首帧零字节：还没读到且没有失败原因 ⇒ 整块不渲染（失败则**响亮**给一行）。 */
  if (!loaded) {
    return failure === null ? null : (
      <WorkItemReactionsFailureLine error={failure} onRetry={reload} />
    );
  }
  const reactedEmojis = new Set(
    groups.filter((group) => group.reactedByMe === true).map((group) => group.emoji),
  );
  return (
    <div data-testid="work-item-reactions" className="flex flex-col gap-1">
      {/* 写入失败或刷新失败：同一行（原因原样 + 重试 = 回读），行集保持上一次读到的事实。 */}
      {failure === null ? null : <WorkItemReactionsFailureLine error={failure} onRetry={reload} />}
      <span className="flex flex-wrap items-center gap-1">
        {groups.length === 0 ? null : (
          <WorkItemReactionChips
            groups={groups}
            pendingEmoji={pendingEmoji}
            onToggle={(emoji) => void toggle(emoji)}
          />
        )}
        <WorkItemReactionPicker
          reactedEmojis={reactedEmojis}
          pendingEmoji={pendingEmoji}
          onToggle={(emoji) => void toggle(emoji)}
        />
      </span>
    </div>
  );
}

/** 读到失败时的一行（原因原样 + 就地重试；文案键与详情页其余失败行同一族）。 */
export function WorkItemReactionsFailureLine({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  return (
    <Alert variant="destructive" data-testid="work-item-reactions-failure">
      <AlertTitle>{t("squad.common.operationFailed")}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <span className="text-ui-xs">{error}</span>
        <Button size="sm" variant="outline" className="self-start" onClick={onRetry}>
          {t("squad.workItemDetail.retry")}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
