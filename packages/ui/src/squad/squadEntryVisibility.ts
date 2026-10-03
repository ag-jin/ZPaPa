import type { AppSettings } from "@zcode/shared";

/* 最小入口的**显隐判据**（spec §12 / §16 S8；口径即 §5.7 第 6 项「关闭实验开关」）。

   为什么它必须是**纯函数**、且只吃一个「可能为 null」的快照：
   设置快照是**异步**加载的（`useSettings()` 在加载期给出 `null`）。若把「加载中」判成「可见」，
   入口会在开关关闭时先闪一下再消失（闪现未授权的 UI 是最糟的一种）；若判成「可见=false」的
   特例分支，就必须在视图里再写一遍 null 处理 —— 那就是第二份判据。这里把
   「null / 未设置 / false ⇒ 不可见」收敛成**一处**，视图与分区只问它。

   **它不是门禁**（确认 2：门禁是服务层单点 `ISquadRuntimeService.assertDispatchEnabled`）：
   本函数只管**呈现在不在**。UI 的隐藏与「服务层拦不拦新派发」是两件事，**不得互相依赖**：
   即便某处漏了隐藏，服务层自己也会拦下界面触发（`createWorkItem` 入口过门禁）；
   反过来，即便本函数判可见，服务层照样可能因开关关闭而拒 —— 那时错误会原样冒到界面上。
   正因为两者独立，本函数**不需要**、也**不应该**产生任何后端副作用。 */
export function squadEntryVisible(
  settings: Pick<AppSettings, "experimentalAgentSquadsEnabled"> | null | undefined,
): boolean {
  // 严格比较 true：只有显式为 true 才可见。`undefined`（未设置）与 `null`（加载中）
  // 都按「未开启」处理 —— 实验功能默认关闭，未加载完就展示入口等于凭空许诺。
  return settings?.experimentalAgentSquadsEnabled === true;
}
