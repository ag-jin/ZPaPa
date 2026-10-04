import type { InboxItem, InboxItemKind, InboxItemSeverity } from "@zcode/services";
import type { SquadEntryFeedback } from "./squadEntryViewModel.js";

/* 「收件箱」一级页面（InboxPage / InboxList）的**纯逻辑**（不 import React、不 import UI 原语
   —— 照 squadEntryViewModel / squadSurfaceViewModel 的既定做法：ui 包没有渲染测试设施，
   判断留在组件里就等于不可测）。

   **为什么不复用共享的 `squadSurfaceViewState`**：那台机器的两个输入收件箱**都没有** ——
   ① `hasTarget`：收件箱是**跨项目**的通知面（服务面 `listInboxItems` 没有目标参数），页面上
      没有"当前项目"这个概念，"无激活工作区"那一格在语义上不成立；
   ② `snapshot: SquadSnapshot`：收件箱不发快照，它的数据是 `InboxItem[]`，也没有 `enabled` 位。
   硬把它套进那台机器，就得给 `hasTarget` 编一个恒真的假值、给 `snapshot` 造一个假的
   SquadSnapshot —— 那正是"同一语义两处实现"的开端。
   但它的**两条口径逐条照搬**（都是被实测教训逼出来的，不是可选项）：
   ① **错误必带原因**：`error` 一格必须把 failure（含原始 detail）原样透出 —— 错误态没有原因
      就等于没有错误态；
   ② **刷新失败不清空数据**：已有条目仍留在 `ready.items` 里，失败转为 `loadFailure` 横幅 ——
      清空数据等于把一次网络抖动变成"你的收件箱清空了"。 */

export type InboxViewModelInput = {
  /** 最近一次**成功**的取数结果；失败不清空它（见上）。`null` = 还没成功读过一次。 */
  items: InboxItem[] | null;
  loading: boolean;
  /** 最近一次失败（含原始 detail）；下一次成功会被清空。 */
  failure: SquadEntryFeedback | null;
};

export type InboxViewState =
  | { mode: "loading" }
  | { mode: "error"; feedback: SquadEntryFeedback }
  | { mode: "ready"; items: InboxItem[]; loadFailure: SquadEntryFeedback | null };

/**
 * 逐格穷举（口径照 `squadSurfaceViewState` 去掉"无目标"那一格）：
 *
 * 1. **无数据**（还没成功读过一次）：
 *    - `loading` ⇒ `loading`（**重试进行中优先于旧失败**：点「重试」后界面必须真的进入
 *      "正在读取"，而不是停在上一次的失败上）；
 *    - 非 loading 且 `failure !== null` ⇒ `error`（**必须带 failure 的 detail**）；
 *    - 非 loading 且无 failure ⇒ `loading`（首帧：effect 还没跑，`loading` 也还没置位。此刻
 *      "还没有数据、也没有失败"的最诚实呈现是"正在读取"，而不是空列表 —— 空列表会短暂地
 *      说出"收件箱是空的"这句假话）；
 * 2. **有数据 ⇒ `ready`**，且**刷新失败不清空已有数据**（失败转为 `loadFailure` 横幅）。
 *
 * **没有"实验已关闭"这一格**：那是 settings 的判据（页面用 `useSettings()` + 既有的
 * `squadEntryVisible` 一处判），不是取数结果的一部分 —— 收件箱在实验关闭时**仍可读/归档**，
 * 把它塞进取数状态机会让"拿到数据"与"开关关着"这两个正交事实互相遮掩。
 */
export function inboxViewState(input: InboxViewModelInput): InboxViewState {
  const { items, loading, failure } = input;
  if (!items) {
    if (loading || !failure) return { mode: "loading" };
    return { mode: "error", feedback: failure };
  }
  return { mode: "ready", items, loadFailure: failure };
}

// ---------- 文案表 ----------

/**
 * kind → 文案 id。用 `Record<InboxItemKind, string>` **强制穷尽** —— 将来给
 * `INBOX_ITEM_KINDS` 加一个 kind 时这里会编译失败，而不是界面上多出一个裸 key。
 *
 * ⚠️ **`member_failed` 的文案必须中性**（第 34 轮登记的硬约束）：队员 run 与**队长 run 共用
 * 同一个失败出口**（`buildMemberFailedInboxItem` 的 `branch: string | null` 就是这个共用形状），
 * 故这一格**不得**写成「队员失败」—— 中文用「运行失败」。谁失败由次要行里的 `reason` 原文
 * 自报（那句以「队员」/「队长」开头），不靠这里猜。
 */
export const INBOX_KIND_MESSAGE_IDS: Record<InboxItemKind, string> = {
  merge_conflict: "squad.inbox.kind.merge_conflict",
  member_failed: "squad.inbox.kind.member_failed",
  run_orphaned: "squad.inbox.kind.run_orphaned",
  dispatch_skipped: "squad.inbox.kind.dispatch_skipped",
};

/**
 * severity → 文案 id（同样 `Record` 强制穷尽）。三档的**映射本身**（哪个 kind 有多急）不在这里：
 * 它是 `inboxItemRepo.INBOX_SEVERITY_BY_KIND` 的单源映射（产生点不得各自写字面量），
 * UI 只把读回来的 severity 翻成词。
 */
export const INBOX_SEVERITY_MESSAGE_IDS: Record<InboxItemSeverity, string> = {
  action_required: "squad.inbox.severity.action_required",
  attention: "squad.inbox.severity.attention",
  info: "squad.inbox.severity.info",
};

/**
 * severity → 徽标配色（**语义色 token**，spec §11.3：状态只由语义色表达）。
 * `action_required` ⇒ destructive；`attention` ⇒ warning；`info` ⇒ 中性 muted
 * （仓库没有 info 语义色 token，通知不该借一个"有颜色"的语义 —— 中性就是它的语义）。
 * 这里**不出现九色板**（red-500 之类）：那会把"多急"编码成一个随手挑的颜色。
 */
export const INBOX_SEVERITY_BADGE_CLASSES: Record<InboxItemSeverity, string> = {
  action_required: "bg-destructive/10 text-destructive",
  attention: "bg-warning/10 text-warning",
  info: "bg-muted text-foreground-subtle",
};

export function inboxKindMessageId(kind: InboxItemKind): string {
  return INBOX_KIND_MESSAGE_IDS[kind];
}

export function inboxSeverityMessageId(severity: InboxItemSeverity): string {
  return INBOX_SEVERITY_MESSAGE_IDS[severity];
}

// ---------- 次要行 ----------

/**
 * 从 `detail` 里读一个**非空字符串**；其它形态（undefined / null / 数字 / 空串）一律 `null`
 * —— 于是拼装端"取不到就跳过该片段"，**绝不渲染出 `undefined`**（detail 是
 * `Record<string, unknown>`，形状逐 kind 不同，且可能带本函数不认识的键）。
 */
function readDetailString(detail: Record<string, unknown>, key: string): string | null {
  const value = detail[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 按 kind 从 `detail` 取字段拼一条**次要行**（分支 / reason / agentId 等）。
 *
 * 字段名以产生点为准（`packages/services/src/workitem/inboxItemProducers.ts` 的四个构建件），
 * 本函数**不猜键名**：取不到就跳过该片段，全空回 `null`（组件据此不渲染空行）。
 *
 * **为什么这里不判 severity / 不决定"多急"**：那是 repo 的单源映射
 * `INBOX_SEVERITY_BY_KIND`（kind 是持久列，severity 由它补），UI 再判一份就等于给
 * "冲突算不算急"开第二处口径，而两处不一致不会报错。
 *
 * **为什么 `item.workItemId` / `item.runId` 不出现在这里**：它们是行上的顶层列（detail 里同名
 * 的键是产生点自带的事实副本），标题回落与穿透用的都是顶层列 —— 次要行重复一遍只会让同一件事
 * 出现两次。`merge_conflict` 的 `conflictDetail`（git 原文明细，多行）也不在次要行渲染：
 * 一行放不下，且它不是"扫一眼列表"要读的东西。
 */
export function inboxItemDetailLine(item: InboxItem): string | null {
  const fragments: string[] = [];
  const push = (value: string | null): void => {
    if (value) fragments.push(value);
  };

  switch (item.kind) {
    case "merge_conflict": {
      // 两条冲突路径（逐队员 / 整批合回）的字段不同：能拼出「从哪到哪」就拼，
      // 拼不出（只有一端）就显示那一端 —— 都取不到则整段跳过。
      const memberBranch = readDetailString(item.detail, "memberBranch");
      const integrationBranch = readDetailString(item.detail, "integrationBranch");
      const targetBranch = readDetailString(item.detail, "targetBranch");
      push(
        memberBranch && integrationBranch
          ? `${memberBranch} → ${integrationBranch}`
          : (memberBranch ?? integrationBranch ?? targetBranch),
      );
      push(readDetailString(item.detail, "agentId"));
      break;
    }
    case "member_failed": {
      // 队长 run 无分支（branch 为 null）⇒ 该片段跳过；reason 原文自报是队员还是队长。
      push(readDetailString(item.detail, "branch"));
      push(readDetailString(item.detail, "agentId"));
      push(readDetailString(item.detail, "reason"));
      break;
    }
    case "run_orphaned": {
      // sessionId 可能缺失（未绑会话的历史行同样按孤儿和解）；缺就跳过。
      push(readDetailString(item.detail, "agentId"));
      push(readDetailString(item.detail, "sessionId"));
      push(readDetailString(item.detail, "reason"));
      break;
    }
    case "dispatch_skipped": {
      // 四条 skip 的 reason 原文点名的就是处置方向（指派给人 / 小队不存在 / 已归档 / 已停用）。
      push(readDetailString(item.detail, "reason"));
      break;
    }
  }

  return fragments.length > 0 ? fragments.join(" · ") : null;
}

// ---------- 穿透目标（「看到 → 处理」的闭环） ----------

/* 收件箱是**跨项目**面：每条条目自己带着「这件事在哪个项目」的坐标（`workspacePath` +
   `workspaceKey`）。穿透（打开工作项 / 打开会话）的第一步就是把这两个坐标还原成
   shell 能用的导航目标 —— 还原规则只在这里一份（可被 node:test 钉住），组件不各自拼。

   **identity 的口径（C14，唯一来源是共享的 `resolveWorkspaceKey`）**：
   `workspaceKey = workspaceIdentity?.trim() || workspacePath`。反过来推：
   · `workspaceKey !== workspacePath` ⇒ key 就是（trim 后的）identity —— 可以按 identity 用；
   · `workspaceKey === workspacePath` ⇒ 条目没带 identity（落库时就是空）⇒ **只给 path**，
     绝不可拿 key 冒充 identity（拿 path 当 identity 传进 tabStore 会让同路径的远端 tab
     匹配不上，激活静默失败）。
   两种形状在条目上长得一样（都是非空字符串），所以这条反推规则必须写清楚，且只写一处。 */

/** 「打开工作项」的去处：目标项目坐标 + 要聚焦的那条工作项（shell 负责跨 workspace 导航）。 */
export type InboxWorkItemTarget = {
  workspacePath: string;
  /** 由 `workspaceKey` 反推（C14 口径）；`undefined` = 条目没带 identity（按本地项目处理）。 */
  workspaceIdentity?: string;
  workItemId: string;
};

/** 「打开会话」的去处：目标项目坐标 + 要打开的会话 id（run 类条目的穿透）。 */
export type InboxSessionTarget = {
  workspacePath: string;
  /** 同 `InboxWorkItemTarget.workspaceIdentity`（同一处反推）。 */
  workspaceIdentity?: string;
  sessionId: string;
};

/** 条目 → 项目坐标（`null` = 坏形状：`workspacePath` 为空串——没有项目可去，不猜）。 */
function inboxWorkspaceTarget(
  item: Pick<InboxItem, "workspacePath" | "workspaceKey">,
): { workspacePath: string; workspaceIdentity?: string } | null {
  if (item.workspacePath.length === 0) return null;
  const identity = item.workspaceKey !== item.workspacePath ? item.workspaceKey.trim() : "";
  return identity.length > 0
    ? { workspacePath: item.workspacePath, workspaceIdentity: identity }
    : { workspacePath: item.workspacePath };
}

/**
 * 条目的会话 id：`detail.sessionId` 是**非空字符串**才返回它，否则 `null`（坏形状一律 null，不猜）。
 *
 * `sessionId` 是本轮才补进 `member_failed` 的键（此前产生的条目没有它），`run_orphaned` 的键一直
 * 允许 `null` —— 两种情况都必须按「缺失」降级（界面不给「打开会话」钮），不得报错。
 * 读法与次要行同源（`readDetailString`）：detail 是 `Record<string, unknown>`，形状可能坏。
 */
export function inboxItemSessionId(item: Pick<InboxItem, "detail">): string | null {
  return readDetailString(item.detail, "sessionId");
}

/**
 * 「打开工作项」的目标：`workItemId` 非空 且 项目坐标推得出 ⇒ 目标；否则 `null`（不给钮，不猜）。
 * 返回的目标三样齐全（`workspacePath` / `workspaceIdentity?` / `workItemId`），shell 拿到即可导航。
 */
export function inboxItemWorkItemTarget(
  item: Pick<InboxItem, "workspacePath" | "workspaceKey" | "workItemId">,
): InboxWorkItemTarget | null {
  const workspace = inboxWorkspaceTarget(item);
  const workItemId =
    typeof item.workItemId === "string" && item.workItemId.length > 0 ? item.workItemId : null;
  if (!workspace || workItemId === null) return null;
  return { ...workspace, workItemId };
}

/**
 * 「打开会话」的目标：会话 id 与项目坐标**都**推得出 ⇒ 目标；否则 `null`。
 * 只按 `inboxItemSessionId` 渲染会话钮、到点击时才拼坐标会让拼不出的那条变成**死钮** ——
 * 判据收在这里，两种形状由同一个函数回答。
 */
export function inboxItemSessionTarget(
  item: Pick<InboxItem, "detail" | "workspacePath" | "workspaceKey">,
): InboxSessionTarget | null {
  const workspace = inboxWorkspaceTarget(item);
  const sessionId = inboxItemSessionId(item);
  if (!workspace || sessionId === null) return null;
  return { ...workspace, sessionId };
}

// ---------- 行动作 ----------

export type InboxRowActions = {
  canMarkRead: boolean;
  canArchive: boolean;
};

/**
 * 一行给不给两个动作（四格穷举，口径照共享的 `rosterRowActions`）：
 *
 * · **未读且未归档** ⇒ 两个都 true；
 * · **已读未归档** ⇒ 只 `canArchive`（已读的动作没有第二次可做的 —— 标已读是幂等的，
 *   但把幂等动作做成常驻按钮只会让人以为"还能改回去"）；
 * · **已归档**（不论已读）⇒ **两个都 false**：归档行只显示徽标。
 *
 * 为什么已归档 ⇒ 都不给：仓库里**没有"取消归档"**（repo 只有 `archive` 一个方向），行内再给
 * 动作只会让人以为那些动作能把它弄回来；而且归档行只可能在打开「显示已归档」时出现，
 * 那时它们的作用是"留痕可查"，不是"待办"。
 */
export function inboxRowActions(item: Pick<InboxItem, "readAt" | "archivedAt">): InboxRowActions {
  if (item.archivedAt !== null) return { canMarkRead: false, canArchive: false };
  return { canMarkRead: item.readAt === null, canArchive: true };
}
