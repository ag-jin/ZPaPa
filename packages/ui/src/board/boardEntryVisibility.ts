import type { AppSettings } from "@zcode/shared";

/* 「项目看板」入口/面板的**显隐判据**（卡 #58，范式与 squad/squadEntryVisibility.ts 同款）。

   为什么是**纯函数**且只吃一个「可能为 null」的快照：设置是**异步**加载的（`useSettings()`
   在加载期给出 `null`）。若把「加载中」判成「可见」，开关关闭时入口会先闪一下再消失（闪现未授权的
   UI 是最糟的一种）；若判成特例分支，就必须在视图里再写一遍 null 处理 —— 那就是第二份判据。
   这里把「null / 未设置 / false ⇒ 不可见」收敛成**一处**，入口列表与面板挂载只问它。

   与小队开关的区别：看板没有服务层门禁（面板是只读投影，契约 §7.1），因此本函数就是
   全部的门禁面 —— 关掉开关后不存在任何界面路径能打开面板。 */
export function projectBoardEntryVisible(
  settings: Pick<AppSettings, "experimentalProjectBoardEnabled"> | null | undefined,
): boolean {
  // 严格比较 true：只有显式为 true 才可见。`undefined`（未设置 / 存量设置升级）与 `null`
  // （加载中）都按「未开启」处理 —— 实验功能默认关闭。
  return settings?.experimentalProjectBoardEnabled === true;
}
