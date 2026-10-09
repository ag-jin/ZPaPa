/* 工作项 Surface **控件带**（阶段二 · T-P2-R4）的纯判据。

   为什么要有这一层（与 `workItemSurfaceViewModel` 同一理由）：本包没有渲染测试设施，
   判据写进组件就等于不可测；而控件带上的坏法全是**静默**的 —— 防抖延迟两处各写一个毫秒数
   （一处改一处不改：输入像卡住或每敲一个字打一次全表投影）、搜索框被写成 `defaultValue`
   （外部清空看不见：用户点了「清除筛选」，框里还留着旧词，而结果已经变了）、
   取数失败时控件**消失**（入口没了，用户连"为什么不能筛"都问不到）。

   本文件不 import React、不 import UI 原语、不碰 i18n 文案正文（只给**消息 id**）。
   过滤 / 搜索匹配 / 排序的**业务判据不在这里**（它们是 R1 的 `workItemSurfaceViewModel`）——
   本层只有「控件自身的交互口径」：防抖、草稿与权威值的对齐、键盘语义、置灰原因。 */

import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";

/**
 * 本地搜索的防抖延迟（毫秒）—— **唯一一处**（组件里的定时器必须读它）。
 *
 * 为什么本地过滤也要防抖：每次提交都会让宿主重跑一次投影（三视图共用那份）并重排整块看板；
 * 逐键提交在长名册上是肉眼可见的卡顿，而"敲一个字就重排一次"的坏法不会报错。
 * 为什么是 200ms：这是**内存里**的字符串匹配（无网络、无索引），延迟只需要把连打合并成一次；
 * 取值与 `useTabPersistence`（300ms，写盘）不同档，也与"自动刷新"（60s）不同档。
 */
export const WORK_ITEM_SURFACE_SEARCH_DEBOUNCE_MS = 200;

/**
 * 草稿要不要**跟随**权威值（`surface.search`）。
 *
 * 搜索框是本组件的本地草稿 + 防抖提交，于是权威值有两个来源：① 本组件提交后由页面回灌的
 * **回声**；② 别的路径改的权威值（「清除筛选」、输入框里的 Esc、R6 的命名视图还原）。
 * 两者必须分开：回声也去跟随，就会把用户在防抖窗口里**接着敲的字**覆盖回上一帧的值
 * （表现是"打字丢字"，只在快速输入时出现）；而外部改的也不跟随，就会出现
 * "搜索框里还留着旧词、结果已经是新查询的结果"这种**自相矛盾**的界面。
 *
 * 判据就是"权威值是不是我上次提交出去的那个"：不是 ⇒ 跟随。
 */
export function workItemSurfaceSearchDraftFollows(input: {
  /** 权威值（页面持有的 `surface.search`）。 */
  authoritative: string;
  /** 本组件**上次提交出去**的值（回声的判别依据）。 */
  lastEmitted: string;
}): boolean {
  return input.authoritative !== input.lastEmitted;
}

/**
 * 同族**两个**控件的可及名称（`<族标签> <当前值>`）。
 *
 * 为什么需要组合而不是各用一枚键：排序是**两个**控件（键 + 方向），两个都叫「排序」时，
 * 读屏与键盘用户听到的是两个同名控件 —— 选错了也说不清选错了哪个。
 * 而「排序方向」这一枚键不在阶段二的冻结清单里（零键增纪律）⇒ 用**已有**的两枚键拼。
 *
 * 分隔符为什么是**空格**而不是本仓正文里常见的全角冒号：`en-US` 的文案不用全角标点
 * （`"Unchanged: same assignee"`），拿 `：` 去拼英文会得到 `Sort：Ascending` 这种半中半英的名称；
 * 空格在中英两边都读得通，而且不在名称里引入任何语言相关标点。
 */
export function workItemSurfaceTwinControlLabel(family: string, value: string): string {
  return `${family} ${value}`;
}

/* ---------------- 取数不可用时的置灰原因 ---------------- */

/**
 * 置灰原因的文案键（**全部复用既有键** —— 阶段二零键增：这三枚键本来就表达「读不到数据」的
 * 三种局面，本层不新增第四种说法）。取值是消息 id，正文在 locale 里（本层不碰文案正文）。
 */
export const WORK_ITEM_SURFACE_CONTROLS_DISABLED_MESSAGE_IDS = {
  noWorkspace: "squad.common.noWorkspace",
  loading: "squad.workItems.loading",
  readFailed: "squad.workItems.loadFailed",
} as const;

/**
 * 控件带**为什么**不可用（`null` = 可用）。
 *
 * 口径（与页面状态机同源，不另判一遍）：
 * · 无工作区 ⇒ 说无工作区（**优先于一切**：没有目标就无从读取，说「正在读取」会让人等一个
 *   永远不会来的结果 —— 与 `squadSurfaceViewState` 的第一条同款）；
 * · 有工作区、**数据面不可用**（页面用 `createDisabled` 表达：`!(有目标 ∧ 快照就绪)`，
 *   判据单源在 `workItemCreateEnabled`）⇒ 读取中就说读取中，否则说上一次读取失败；
 * · 数据就绪 ⇒ 可用（**后台刷新在飞不算不可用**：不能拿一次刷新把用户的输入框锁住）。
 *
 * 已登记的边界：首帧（effect 未跑、`loading` 尚未置位、也还没有失败）会短暂读到「读取失败」——
 * 页面状态机把这一格读成「正在读取」。消掉这一帧的差需要给页面加 props（`failure`），
 * 而页面是阶段二的**串行点**（R1 冻结）⇒ 本层不为了一个悬停提示去动它（登记给复验）。
 */
export function workItemSurfaceControlsDisabledReason(input: {
  targetAvailable: boolean;
  /** 与新建按钮同一份可用性判据的反面（页面给的 `createDisabled`）。 */
  dataUnavailable: boolean;
  loading: boolean;
}): string | null {
  if (!input.targetAvailable) return WORK_ITEM_SURFACE_CONTROLS_DISABLED_MESSAGE_IDS.noWorkspace;
  if (!input.dataUnavailable) return null;
  return input.loading
    ? WORK_ITEM_SURFACE_CONTROLS_DISABLED_MESSAGE_IDS.loading
    : WORK_ITEM_SURFACE_CONTROLS_DISABLED_MESSAGE_IDS.readFailed;
}

/* ---------------- 搜索输入框的键盘语义（闭集） ---------------- */

/**
 * 搜索框按键的意图（**闭集**：加一种意图 ⇒ 类型报错拖出全部消费点）。
 * · `commit` = Enter（**立刻**提交，不等防抖窗口）；`clear` = Escape（清空搜索）；`ignore` = 不吃这个键。
 */
export type WorkItemSurfaceSearchKeyIntent = "commit" | "clear" | "ignore";

/**
 * 搜索框按键 → 意图的**唯一判据**（照 `resolveWorkItemInlineTitleKeyIntent` 的先例）。
 *
 * 三条必须钉死的语义：
 * · **Tab 必须 `ignore`**（= 放行）：吃了 Tab 就等于把键盘用户困在搜索框里 —— 焦点出不去，
 *   而这是"看"不出来的坏法（鼠标用户永远碰不到）；
 * · **组合期的 Enter 是候选确认**（中文输入法选字），不是提交 —— 不认组合态，用户每选一次字
 *   就提交一次查询；组合判据走 `isImeComposingKeyEvent` 单源（不在两处各写一份 isComposing 链）；
 * · Escape = **清空搜索**：与「清除筛选」（`clearQuery`：搜索 + 两个 facet 一起清）**不是同一件事**
 *   —— 在搜索框里按 Esc 不该顺手把用户配好的 facet 也清掉。
 */
export function resolveWorkItemSurfaceSearchKeyIntent(input: {
  key: string;
  compositionActive: boolean;
  isComposing?: boolean;
}): WorkItemSurfaceSearchKeyIntent {
  if (
    isImeComposingKeyEvent({
      compositionActive: input.compositionActive,
      isComposing: input.isComposing,
    })
  ) {
    return "ignore";
  }
  if (input.key === "Enter") return "commit";
  if (input.key === "Escape") return "clear";
  return "ignore";
}
