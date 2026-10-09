import type { SquadSnapshot } from "@zcode/services";
import type { SquadEntryFeedback } from "./squadEntryViewModel.js";

/* 「面」无关的共享纯逻辑：**状态机**与**行动作判据**（智能体页 / 小队页同一份实现）。

   为什么必须抽出来（2026-10-03 小队面落地时）：两台机器与「是哪个面」无关 ——
   状态机只看「有没有目标 / 有没有快照 / 在不在加载 / 上一次失败」，行动作只看「归档没归档」。
   若每个面各留一份拷贝，改了一处漏一处**不报错**：今天两个页面的行为必须一致（同一套骨架），
   而行为一致的最省事实现就是只有一份代码。`ready` 暴露**整个 `snapshot`**，由各面自己投影
   （智能体页取 `snapshot.teamAgents`，小队页取 `snapshot.squads`）——投影是各面的事，
   状态判定是共享的事。

   本文件同样不 import React、不 import UI 原语（照 squadEntryViewModel 的既定做法）：
   ui 包没有渲染测试设施，判断留在组件里就等于不可测。 */

/**
 * 状态机入参。四个字段都是**快照式**的：`snapshot` 是最近一次**成功**的取数结果
 * （失败不清空它 —— 见下面 ready 一格的理由），`failure` 是最近一次失败。
 */
export type SquadSurfaceViewModelInput = {
  /** 有没有可用的目标 workspace（由 props 的 path 求出来的 target 是否为 null）。 */
  hasTarget: boolean;
  snapshot: SquadSnapshot | null;
  loading: boolean;
  /** 最近一次失败（含原始 detail）；下一次成功会被清空。 */
  failure: SquadEntryFeedback | null;
};

export type SquadSurfaceViewState =
  | { mode: "no-workspace" }
  | { mode: "loading" }
  | { mode: "error"; feedback: SquadEntryFeedback }
  | {
      mode: "ready";
      /** 整个快照原样透出；各面自己投影（teamAgents / squads）。 */
      snapshot: SquadSnapshot;
      /** 有数据但最近一次刷新失败 ⇒ 横幅（**不清空已有数据**）。 */
      loadFailure: SquadEntryFeedback | null;
      /** `snapshot.enabled === false` ⇒ 实验已关闭横幅（呈现，不是门禁）。 */
      experimentDisabled: boolean;
    };

/**
 * 逐格穷举（16 种组合全覆盖，无"其它情况"）：
 *
 * 1. **无 workspace ⇒ `no-workspace`，优先于一切**（连"加载中"都不说：没有目标就无从加载，
 *    显示 spinner 会让人以为在等一个永远不会来的结果）；
 * 2. 有 workspace、**无快照**：
 *    - `loading` ⇒ `loading`（**重试进行中优先于旧失败**：照 SquadMinimalView 的既有口径，
 *      失败行只在 `!loading` 时显示 —— 点「重试」后界面必须真的进入"正在读取"，而不是
 *      停在上一次的失败上）；
 *    - 非 loading 且 `failure !== null` ⇒ `error`（**必须带 failure 的 detail**：
 *      错误态没有原因就等于没有错误态）；
 *    - 非 loading 且无 failure ⇒ `loading`（首帧：effect 还没跑，`loading` 也还没置位。
 *      此刻"还没有数据、也没有失败"的最诚实呈现是"正在读取"，而不是空列表 ——
 *      空列表会短暂地说出"这里什么都没有"这句假话）；
 * 3. **有快照 ⇒ `ready`**，且**刷新失败不清空已有数据**：快照仍是它的，失败转为
 *    `loadFailure` 横幅（清空数据等于把一次网络抖动变成"你的智能体都没了"）。
 *    `snapshot.enabled === false` 只额外挂一条实验已关闭横幅 —— **这不是门禁**
 *    （门禁是服务层单点 `assertDispatchEnabled`），名册管理在实验关闭时仍可用。
 */
export function squadSurfaceViewState(input: SquadSurfaceViewModelInput): SquadSurfaceViewState {
  if (!input.hasTarget) return { mode: "no-workspace" };
  const { snapshot, loading, failure } = input;
  if (!snapshot) {
    if (loading || !failure) return { mode: "loading" };
    return { mode: "error", feedback: failure };
  }
  return {
    mode: "ready",
    snapshot,
    loadFailure: failure,
    experimentDisabled: snapshot.enabled === false,
  };
}

export type RosterRowActions = {
  canEdit: boolean;
  canToggle: boolean;
  canArchive: boolean;
  /** ⑤刀（裁定#2）：归档行可恢复（归档非终态——定义与记忆都在，一键回在用名单）。 */
  canRestore: boolean;
};

/**
 * 一行（智能体或小队）给不给三个动作（本轮设计裁定：**归档是终态**）。
 * 只看 `archivedAt` 一个字段 —— 这正是智能体与小队的共同形状（本函数因此是泛化的）。
 *
 * 为什么已归档 ⇒ 三个都 false：归档的语义是"离开在用名单"（spec §16 S10：派发时被 skip），
 * 而**仓库里没有"取消归档"**这件事（`teamAgentService` / `squadService` 都只有 `archive`
 * 一个方向，谁都不清 `archivedAt`）。若归档行仍给"编辑/启停"，用户就会以为那些操作能把它弄回来
 * —— 而它们只改定义字段与 `enabled`，归档状态纹丝不动：**给了按钮却解决不了他想解决的问题**，
 * 比不给按钮更糟。归档行只显示徽标（定义与记忆都在，这是有意保留的）。
 *
 * `canToggle` **同时覆盖启用与停用两个方向**（一个布尔管一个开关，不拆成两个字段：
 * 拆开只会让"两个字段互相矛盾"成为可能的写法）。
 */
export function rosterRowActions<T extends { archivedAt?: number }>(entry: T): RosterRowActions {
  const archived = entry.archivedAt !== undefined;
  return { canEdit: !archived, canToggle: !archived, canArchive: !archived, canRestore: archived };
}
