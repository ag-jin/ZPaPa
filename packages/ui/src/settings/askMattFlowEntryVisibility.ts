import type { AppSettings } from "@zcode/shared";
import { projectBoardEntryVisible } from "@/board/boardEntryVisibility.js";

/* 「ask-matt 开发流程」入口/命令面的**显隐判据**（卡 #202，范式为显隐判据纯函数单点，
   与 `../board/boardEntryVisibility.ts` 同款）。

   为什么是**纯函数**且只吃一个「可能为 null」的快照：设置是**异步**加载的（`useSettings()`
   在加载期给出 `null`）。若把「加载中」判成「可见」，开关关闭时入口会先闪一下再消失（闪现未授权的
   UI 是最糟的一种）；若判成特例分支，就必须在每个消费面再写一遍 null 处理 —— 那就是第二份判据。
   这里把「null / 未设置 / false ⇒ 不可见」收敛成**一处**；后续卡的 / 命令面板入口、技能注册与
   提示注入的 gate 都问这一个函数。 */

export function askMattFlowEntryVisible(
  settings: Pick<AppSettings, "experimentalAskMattFlowEnabled"> | null | undefined,
): boolean {
  // 严格比较 true：只有显式为 true 才可见。`undefined`（未设置 / 存量设置升级）与 `null`
  // （加载中）都按「未开启」处理 —— 实验功能默认关闭。
  return settings?.experimentalAskMattFlowEnabled === true;
}

/**
 * 「来料厂」乘积态说明行的显隐判据：**板关 + 流开**时开关页显示状态说明一行（卡文交付面 ④）。
 *
 * 为什么复用两个显隐判据而不是各写一遍比较：这一格的定义是「看板入口不可见 且 流程入口可见」，
 * 与两个开关的判据同源；任何一侧判据收紧（例如把加载中改成可见），说明行会跟着走，不会分叉。
 * 其余三格都不显示：开开=看板可见，无需说明；开关/关关=流程未启用，不解释一个不存在的组合。
 */
export function askMattFlowBoardClosedNoticeVisible(
  settings:
    | Pick<AppSettings, "experimentalProjectBoardEnabled" | "experimentalAskMattFlowEnabled">
    | null
    | undefined,
): boolean {
  return askMattFlowEntryVisible(settings) && !projectBoardEntryVisible(settings);
}
