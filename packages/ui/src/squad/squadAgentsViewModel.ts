import type { TeamAgent } from "@zcode/shared";
import type { SquadSnapshot } from "@zcode/services";
import type { SquadEntryFeedback } from "./squadEntryViewModel.js";

/* 「智能体」一级页面（SquadAgentsPage）的**纯逻辑**（不 import React、不 import UI 原语）。

   为什么与设置卡同一手法把判断抽出来：ui 包没有渲染测试设施（既有测试全是纯逻辑），
   把「现在该显示哪个态」「这一行给不给动作按钮」留在组件里就等于**不可测**。放这里之后，
   状态机的每一格与每个动作判据都能被 node:test 逐格钉住，组件只负责画（照 squadEntryViewModel
   的既定做法，2026-10-03 一级入口落地时沿用）。 */

/**
 * 状态机入参。四个字段都是**快照式**的：`snapshot` 是最近一次**成功**的取数结果
 * （失败不清空它 —— 见下面 ready 一格的理由），`failure` 是最近一次失败。
 */
export type SquadAgentsViewModelInput = {
  /** 有没有可用的目标 workspace（由 props 的 path 求出来的 target 是否为 null）。 */
  hasTarget: boolean;
  snapshot: SquadSnapshot | null;
  loading: boolean;
  /** 最近一次失败（含原始 detail）；下一次成功会被清空。 */
  failure: SquadEntryFeedback | null;
};

export type SquadAgentsViewState =
  | { mode: "no-workspace" }
  | { mode: "loading" }
  | { mode: "error"; feedback: SquadEntryFeedback }
  | {
      mode: "ready";
      agents: TeamAgent[];
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
 *    （门禁是服务层单点 `assertDispatchEnabled`），本页的名册管理在实验关闭时仍可用。
 */
export function squadAgentsViewState(input: SquadAgentsViewModelInput): SquadAgentsViewState {
  if (!input.hasTarget) return { mode: "no-workspace" };
  const { snapshot, loading, failure } = input;
  if (!snapshot) {
    if (loading || !failure) return { mode: "loading" };
    return { mode: "error", feedback: failure };
  }
  return {
    mode: "ready",
    agents: snapshot.teamAgents,
    loadFailure: failure,
    experimentDisabled: snapshot.enabled === false,
  };
}

export type TeamAgentRowActions = {
  canEdit: boolean;
  canToggle: boolean;
  canArchive: boolean;
};

/**
 * 一行智能体给不给三个动作（本轮设计裁定：**归档是终态**）。
 *
 * 为什么已归档 ⇒ 三个都 false：归档的语义是"离开在用名单"（spec §16 S10：派发时被 skip），
 * 而**仓库里没有"取消归档"**这件事（`teamAgentService` 只有 `archive` 一个方向，谁都不清
 * `archivedAt`）。若归档行仍给"编辑/启停"，用户就会以为那些操作能把它弄回来 ——
 * 而它们只改定义字段与 `enabled`，归档状态纹丝不动：**给了按钮却解决不了他想解决的问题**，
 * 比不给按钮更糟。归档行只显示徽标（定义与记忆都在，这是有意保留的）。
 *
 * `canToggle` **同时覆盖启用与停用两个方向**（一个布尔管一个开关，不拆成两个字段：
 * 拆开只会让"两个字段互相矛盾"成为可能的写法）。
 */
export function teamAgentRowActions(agent: TeamAgent): TeamAgentRowActions {
  const archived = agent.archivedAt !== undefined;
  return { canEdit: !archived, canToggle: !archived, canArchive: !archived };
}
