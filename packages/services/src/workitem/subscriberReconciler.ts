import {
  ASSIGNMENT_SUBSCRIBER_REASONS,
  MANUAL_SUBSCRIBER_REASON,
  type AutomaticSubscriberReason,
  type OptOutScope,
  type SubscriberReason,
  type SubscriberSubject,
} from "./subscriberFacts.js";

/* Subscriber 完整语义线 SUB.1：**唯一 reconciler**（spec §7.1 明文「所有 reason 必须由事实生产点
   显式写入或调用统一 reconciler」）——本模块是那**一处**实现，纯逻辑、零 IO。

   为什么把「改 reason / 撤销 / 墓碑保护」集中成一个纯函数，而不是在每个事实生产点各判一次：
   · 五条规则的组合（最近事实胜 × manual 保护 × 墓碑禁区 × 撤销只及负责人关系 × 同事实幂等）
     分散到四处调用面时，每处只写自己那条，**组合错误不报错**——表现是「某个入口能把你退掉的订阅
     又加回来」；
   · 纯函数可以逐格穷举（见 `workItemSubscriberReconciler.test.ts` 的矩阵），
     而写库语句只在**一处**（`subscriberFacts.applySubscriberFact`）把结论落下去。

   本模块**必须保持浏览器安全**：零 IO、零 `node:` 值导入、零 `.add(`（门面经根入口出值到 renderer）。

   入参 `current` 是**这一刻读到的行状态**（`null` = 没有这行关系）。为什么允许「先读后判」：
   判据需要既有 reason 才能决定是插入、改写还是整条语句 no-op；而**并发正确性不依赖这次读**——
   真正写下去的是存储层单条语句里的不变式（`workItemSubscriberRepo` 的 upsert 带
   `tombstoned_at IS NULL AND reason <> 'manual'` 谓词），读到的陈旧值最坏只让一次写变成空写。 */

/** 判据输入行状态（只取判据真正读到的三个字段；`tombstoned_at` 非空 = 已显式退订）。 */
export type SubscriberRowState = {
  reason: SubscriberReason;
  tombstonedAt: number | null;
  optOutScope: OptOutScope;
};

/**
 * 一次**订阅事实**（事实生产点只报事实，不报结论）。
 * · `subscribe`：自动事实（创建者 / 负责人 / 评论者 / 被点名 / 队长派单）——reason 由事实决定；
 * · `revoke`：负责人关系结束（改派）——撤销旧负责人的行；
 * · `manual_subscribe`：用户在详情页订阅（显式，可复活墓碑）；
 * · `manual_unsubscribe`：用户显式退订（两档范围）——落墓碑，自动规则不得复活。
 *
 * `subject` 参与事实的身份（同一个 subject 的同一个键），本函数**不读它**：判据只看行状态，
 * 落库与键拼装由 applier 负责。
 */
export type SubscriberFact =
  | { kind: "subscribe"; reason: AutomaticSubscriberReason; subject: SubscriberSubject }
  | { kind: "revoke"; subject: SubscriberSubject }
  | { kind: "manual_subscribe"; subject: SubscriberSubject }
  | { kind: "manual_unsubscribe"; subject: SubscriberSubject; scope: OptOutScope };

/**
 * 期望的**变化**（不是期望的终态）：applier 把每种 action 映射成恰好一条语句。
 *
 * `none` 也带原因（`why`）：调用方与可观察面要能回答「这次为什么没写」，而不是一个布尔。
 */
export type SubscriberDecision =
  | {
      action: "none";
      why: "tombstoned" | "manual_protected" | "unchanged" | "revoke_not_applicable";
    }
  | { action: "subscribe"; reason: SubscriberReason }
  | { action: "tombstone"; scope: OptOutScope }
  | { action: "clear_tombstone" }
  | { action: "revoke" };

/**
 * 唯一判据：给定**这一刻的行状态**与**本次事实**，给出期望变化。规则四条（拆解报告 §2.1）：
 *
 * 1. **最近事实胜**：活动行上的新自动事实改写 `reason`（同一人行不新增）；
 * 2. **墓碑禁区**：`tombstoned_at` 非空 ⇒ 一切自动事实（含撤销）都不适用——用户说过「不想收」，
 *    自动规则不得复活（撤销也不删墓碑：那是意愿，不是可撤销的关系）；
 * 3. **`manual` 受保护**：自动事实既不改写也不删除 `reason='manual'` 的行；
 * 4. **幂等**：同事实重投（同位 reason / 同档范围 / 已是 manual）返回 `none`——存储层不写，
 *    于是 `created_at` / `tombstoned_at` 都不产生新时间戳。
 *
 * 手动订阅是唯一能清墓碑的动作（spec §7.1）；手动退订**无行也建墓碑**：退订是关于未来的意愿，
 * 与「当前有没有自动关系」正交（不建的话下一次自动事实会把人又加回来）。
 */
export function reconcileSubscriberFacts(
  current: SubscriberRowState | null,
  fact: SubscriberFact,
): SubscriberDecision {
  switch (fact.kind) {
    case "subscribe": {
      if (current === null) return { action: "subscribe", reason: fact.reason };
      if (current.tombstonedAt !== null) return { action: "none", why: "tombstoned" };
      if (current.reason === MANUAL_SUBSCRIBER_REASON) {
        return { action: "none", why: "manual_protected" };
      }
      if (current.reason === fact.reason) return { action: "none", why: "unchanged" };
      return { action: "subscribe", reason: fact.reason };
    }

    case "revoke": {
      if (current === null) return { action: "none", why: "revoke_not_applicable" };
      if (current.tombstonedAt !== null) return { action: "none", why: "tombstoned" };
      if (current.reason === MANUAL_SUBSCRIBER_REASON) {
        return { action: "none", why: "manual_protected" };
      }
      /* 只撤销「负责人关系」两格：`creator` / `commenter` / `mentioned` 这些关系在改派后**仍然成立**
         （创建人还是创建人、评论过的人还是评论过），删掉它们是静默丢事实。 */
      if ((ASSIGNMENT_SUBSCRIBER_REASONS as readonly string[]).includes(current.reason)) {
        return { action: "revoke" };
      }
      return { action: "none", why: "revoke_not_applicable" };
    }

    case "manual_subscribe": {
      if (current === null) return { action: "subscribe", reason: MANUAL_SUBSCRIBER_REASON };
      if (current.tombstonedAt !== null) return { action: "clear_tombstone" };
      if (current.reason === MANUAL_SUBSCRIBER_REASON) return { action: "none", why: "unchanged" };
      /* 人说的算：显式订阅把自动原因改写为 manual（此后自动规则再也抹不掉它）。 */
      return { action: "subscribe", reason: MANUAL_SUBSCRIBER_REASON };
    }

    case "manual_unsubscribe": {
      if (current === null) return { action: "tombstone", scope: fact.scope };
      if (current.tombstonedAt === null) return { action: "tombstone", scope: fact.scope };
      if (current.optOutScope !== fact.scope) return { action: "tombstone", scope: fact.scope };
      return { action: "none", why: "unchanged" };
    }
  }
}
