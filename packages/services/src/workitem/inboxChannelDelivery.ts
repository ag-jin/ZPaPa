import type { InboxItem, InboxItemKind, InboxItemSeverity } from "./inboxItemRepo.js";
import {
  resolveInboxDeliveryTier,
  resolveInboxRecipients,
  type InboxSubscriberRow,
} from "./inboxNotificationPolicy.js";

/* SUB.3b：**投递编排**（渠道只读推送的「要不要推」这一半）。

   分工（与 §2.4 的挂接点行逐格对应）：
   · 判据：投递档（`resolveInboxDeliveryTier`，severity 单源派生）与收件人（`resolveInboxRecipients`，
     订阅 + 祖先冒泡 + 退订静音）都在 `inboxNotificationPolicy` 一处 —— 本模块**零自判**，
     只按判据的返回值决定「推 / 不推」，再调注入的 port；
   · 落点：port 由组合根绑定到 bots 域的 `pushInboxChannelSummary`（workitem 域只持类型，
     不 import provider 实现）—— 于是「推到哪」是 bots 域的配置事实，这里只回答「推不推」；
   · 渲染：摘要只带 kind / severity / title（结构化），文案与两语归 bots 的消息表
     （`messages.ts`）—— 本项目里「一条记录长什么样」不按调用点的语言习惯漂移。

   **Best-effort**（§2.4 失败行）：port 同步抛或返回的 Promise 被拒 ⇒ 只 warn。
   条目是已落库的 durable 事实，推送只是它的副本；让副本的失败冒到调用方，
   会把一次成功的登记翻转成响亮失败，还会连带回滚/重放主流程。 */

/** 一次渠道推送入参（与 `IBotsService.pushInboxChannelSummary` 的结构对齐；此处只持类型）。 */
export type InboxChannelPushParams = {
  target: { workspacePath: string; workspaceIdentity?: string };
  summary: { kind: InboxItemKind; severity: InboxItemSeverity; title: string };
};

/**
 * 出站口：`void` 或 Promise 都接受 —— 组合根绑的 bots 方法是异步的，
 * 而挂接点（`insertIfAbsent` 的 onInserted）是**同步**的（登记返回值不得等一次网络往返）。
 *
 * 返回值类型是 `unknown` 而不是某个结论类型：这一层**不用**出站结果做任何分支
 * （best-effort 的失败语义在 bots 域自己收口）—— 留一个结论类型只会把「按结果重试/改判」
 * 的诱惑带进来。
 */
export type InboxChannelPushPort = (params: InboxChannelPushParams) => void | Promise<unknown>;

export interface InboxChannelDelivery {
  /**
   * 「这条条目**真的新插入**了」的通知（挂接点唯一：`inboxItemRepo.insertIfAbsent === true`）。
   *
   * **绝不抛、绝不 await、绝不改任何状态**：调用方在登记路径上，本方法只做一个决定。
   */
  notifyInserted(item: InboxItem): void;
}

/** 失败留痕的唯一文案（同步抛与异步拒共用一句：复盘时按这一句就能捞到全部投递失败）。 */
const WARN_MESSAGE =
  "渠道推送失败（best-effort：Inbox 行已落库，推送只是它的副本，不回滚、不重试）";

export function createInboxChannelDelivery(deps: {
  /** 本编排器绑定的目标 workspace（与 runtime 的 `boundWorkspace` 同源）。 */
  target: { workspacePath: string; workspaceIdentity?: string };
  /** 读一个工作项的订阅行（含 tombstone 行）——绑定到 `subscriberRepo.listByWorkItem`。 */
  readSubscribers: (workItemId: string) => readonly InboxSubscriberRow[];
  /** 上溯一步（父 id；`null` = 已到根）——绑定到工作项树。 */
  readParentId: (workItemId: string) => string | null;
  /** 出站口；**不注入 = 未接通 ⇒ 零出站**（既有装配零改动）。 */
  push?: InboxChannelPushPort;
  /** 失败留痕口（best-effort；生产绑服务 logger，测试可捕获）。 */
  warn: (message: string, error?: unknown) => void;
}): InboxChannelDelivery {
  return {
    notifyInserted(item) {
      const push = deps.push;
      if (push === undefined) return;
      try {
        if (resolveInboxDeliveryTier(item.kind) !== "push") return;
        /* 收件人闸（§2.2：订阅是同一产生点的**投递/过滤面**；§2.3：冒泡的唯一可观察面是渠道推送）：
           没人在这条事实的订阅面上（本项 ∪ 祖先链，退订静音已由解析器扣掉）⇒ 零出站。
           工作项拿不到（`workItemId=null`）时没有可解析的收件人集合 —— 不猜、不兜底推送。 */
        if (item.workItemId === null) return;
        const recipients = resolveInboxRecipients({
          workItemId: item.workItemId,
          readSubscribers: deps.readSubscribers,
          readParentId: deps.readParentId,
        });
        if (recipients.length === 0) return;
        const result = push({
          target: deps.target,
          summary: { kind: item.kind, severity: item.severity, title: item.title },
        });
        if (result !== undefined) {
          // 异步出站（生产形态）：拒信在这里被吃掉并留痕，绝不放成未处理 rejection。
          void Promise.resolve(result).catch((error: unknown) => {
            deps.warn(WARN_MESSAGE, error);
          });
        }
      } catch (error) {
        deps.warn(WARN_MESSAGE, error);
      }
    },
  };
}
