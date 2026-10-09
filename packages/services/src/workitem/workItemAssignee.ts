import type { WorkItem } from "@zcode/shared";
import type { UserDispatchCause } from "./squadDispatchRequests.js";
import type { SquadRuntime } from "./squadContracts.js";
import { subscriberFactsForAssigneeChange } from "./subscriberFacts.js";

/* 「改负责人 + 发派发事件」的**唯一实现**（`reassignWorkItem`（UI 改派）与 `assignWorkItem`
   （队长派单工具薄包装）都只调它）：两处的写者纪律、同值处置、事件出口因此不可能分叉。

   为什么单独成文件：① 它被 `squadRuntimeService.ts`（描述符那一侧）**值导入**，而描述符必须保持
   **浏览器安全**（`packages/services/src/index.ts` 用值导入导出它，触达 node:* 会让 renderer 在挂载前
   整包失败，见 browserSafeRootEntry.test.ts）—— 本文件因此只 `import type`，不触达任何 node 侧值
   （与 `squadDispatchRequests.ts` 同一手法）；② `squadRuntimeService.ts` 贴着 oxlint 的 400 行硬门槛
   （skipComments 口径），把这一块搬出来让两侧都留在门槛内（照 `squadDialogParts.tsx` 的既有先例：
   拆机械块，语义一字不动）。

   **门禁不在本函数里**：门禁必须在构造 runtime 之前过（见 `reassignWorkItem` 接口注释第 1 条），
   两个调用面各自在构造前调同一个 `assertEnabled()`。

   逐个动作（与接口 doc 的语义 2–6 逐条对应）：
   1. **只改既有工作项**：未命中（不存在 / 已归档）⇒ 响亮抛。错误文案保留「指派失败」的历史措辞
      （队长工具跨协议把这条 message 原样带给 CLI / 模型，不改它就没有对外可观察的变化；改派面
      读到同一句也不失真 —— 「指派」是「改派」的上位词）。
   2. **同值处置由调用面显式选择**（`sameAssignee`）：`skip` = 不写不发、返回 `assigned:false`
      （改派语义 3：同一事实重投不产生第二次动作）；`reapply` = 照写照发（队长工具对同一队员的**重试**，
      见 `assignWorkItem` 的注释）。**为什么把这一格显式化而不是两处各写一份前置判断**：两条调用面的
      差别只有这一格；写两份判断（或让薄包装自己比一遍）等于把「改负责人 + 发事件」拆回两处实现，
      而两份的漂移不报错。
   3. **写者**：只经 `workItemRepo.updateAssignee`（条件更新，恰命中一行才算成功）；未命中 ⇒ 响亮抛。
   4. **发事件**：`type === "user"` ⇒ **不发**（人不需要被派 run ——「指派给人 = 等人自己动手」）；
      `agent` / `squad` ⇒ 发 `workitem.dispatch_requested`（载荷 `assignee`：类型 + id，小队也能是对象），
      经**唯一出口**（实例订阅表 + 常驻 hub），**不在这里开 run**（§5.1 一处写入 / §5.6 `@` ≠ 指派）。
   5. **成因（`cause`）是调用面的事实，本函数只搬运**：两条调用面各自知道「这次派发是谁发起的」
      （队长派单工具 / UI 改派），故由它们显式给出、本函数原样带进事件载荷 —— 在这里反推成因
      （例如按调用者猜）就是**二次判定**：推断错的表现是台账里落一个错的成因，而读回不会报错。
      类型收窄成用户侧子集（`rule` 不经这条链）。**同值 `skip` 短路时不发事件 ⇒ 不涉及成因。 */
export function applyWorkItemAssignee(
  runtime: SquadRuntime,
  input: { workItemId: string; assignee: WorkItem["assignee"] },
  options: { sameAssignee: "skip" | "reapply"; cause: UserDispatchCause },
): { assigned: boolean } {
  const item = runtime.workItemRepo.get(input.workItemId);
  if (!item) {
    // 响亮：本实现只改**既有**工作项的负责人（用 `createWorkItem` 会重建一条，丢掉 id 与已有子项）。
    throw new Error(
      `指派失败：工作项「${input.workItemId}」不存在或已归档。本方法只改既有工作项的负责人，` +
        "静默建新项会让这条派发挂到一个与调用方所指无关的对象上。",
    );
  }
  if (
    options.sameAssignee === "skip" &&
    item.assignee.type === input.assignee.type &&
    item.assignee.id === input.assignee.id
  ) {
    return { assigned: false };
  }
  // 负责人不是 status（唯一写者那条约束管的是 status）；走 repo 的专用写入口（同样是
  // 「恰命中一行才算成功」的条件更新），不在这里拼 SQL，也不把 repo 暴露给调用方。
  if (!runtime.workItemRepo.updateAssignee(item.id, input.assignee)) {
    throw new Error(
      `指派失败：工作项「${item.id}」在写入时已不可写（被归档或删除）——` +
        "静默 no-op 会让调用方以为派单成功了，而库里仍指着旧负责人。",
    );
  }
  /* 投影（C3b.1）：**记录先于驱动**（与 `transition` 同款次序）。`from` 是本函数开头读到的旧值
     （写之前的行），`cause` 是调用面给的既成事实，投影只搬运。写失败不抛（模块内 catch+logWarn）：
     一次成功的改派不因时间线回声丢失被翻转成调用方异常。 */
  runtime.activityProjector.assigneeChanged({
    item,
    from: item.assignee,
    to: input.assignee,
    cause: options.cause,
  });
  /* 订阅事实（SUB.1）：**负责人关系换人**这条事实的两个半边 —— 新负责人入册（`cause` 决定
     `assignee` / `delegated`）+ 旧负责人行撤销；同主体重投不产撤销（见事实映射处）。
     与投影同一次序（写成功之后、发事件之前）：事实点只报事实，reason 的映射单源在 `subscriberFacts`。 */
  for (const fact of subscriberFactsForAssigneeChange({
    from: item.assignee,
    to: input.assignee,
    cause: options.cause,
  })) {
    runtime.subscriberFacts({ workItemId: item.id, fact });
  }
  /* **指派给人（= 等人自己动手）只写负责人，不发派发事件**：
     人不需要被派 run（`planDispatch` 的 user 支路同样只通知、不排队）。除 user 外的两类都发 ——
     `agent` 起队员 / 单独安排 run，`squad` 由派发路径解析出队长 run（载荷 `assignee` 带类型）。
     事件经**唯一出口**发出：与状态变迁事件是**同一张订阅表**（`SquadRuntime.emitWorkItemEvent`
     ↔ `subscribeWorkItemEvents`），消费方按 `kind` 分流。开 run 由派发路径负责，不由此处代劳。 */
  if (input.assignee.type !== "user") {
    // 收窄成 `{ type: "agent" | "squad"; id }`（`WorkItem["assignee"]` 是「单对象 + 联合字段」，
    // 判别收窄只对 `type` 本身生效，故这里显式按收窄后的 `type` 重建载荷）。
    runtime.emitWorkItemEvent({
      kind: "workitem.dispatch_requested",
      workItemId: item.id,
      assignee: { type: input.assignee.type, id: input.assignee.id },
      cause: options.cause,
    });
  }
  return { assigned: true };
}
