import type { WorkItemCreator } from "@zcode/shared";
import { resolveWorkspaceKey } from "@zcode/shared";
import type { SquadRuntime } from "./squadContracts.js";
import type { ISquadRuntimeService, SquadWorkspaceTarget } from "./squadRuntimeService.js";

/* 工作项级**表情回应**的**服务面两个方法**（`setWorkItemReaction` / `listWorkItemReactions`）的
   唯一实现（P3-R5s 切片 3）。

   为什么单独成文件（照 `workItemViewService.ts` / `squadWakeRules.ts` 的两条先例）：
   ① `squadRuntimeService.ts` 是描述符那一侧、**必须保持浏览器安全**（根入口值导入导出它）；
   ② 归属校验 / emoji 护栏 / 身份注入搬出来，描述符侧只留接线。

   契约（逐条对应验收；口径来自拆解报告 §T-P3-R5 卡 + reports/2026-10-09-reactions-multica-evidence.md §5）：

   · **on=true = add / on=false = remove**（multica 的 POST / DELETE 两路由在此收成一个开关参数：
     UI 的 toggle 语义本来就只需要「置上 / 撤掉」两态，不必让 UI 先判断自己有没有反应过）。
   · **返回 = 操作后该工作项的**全部**反应行（插入序）**：与 `listWorkItemReactions` 同形状。
     幂等语义下「重复 add 返回同值」（同人同 emoji 不产生第二行 ⇒ 返回数组逐字段相同）。
     **不返回聚合分组**：`{emoji,count,actors,reactedByMe}` 的聚合归 UI（multica 的 `groupReactions`
     就在 UI 层，且 `reactedByMe` 要拿「我」与 actor 逐个比 —— 那正是 UI 已有的身份视图）。
   · **emoji 只剩两条闸**：非空 + 宽松长度上限（32 字节，防滥用）。**不白名单**：快捷表情集是
     UI 的呈现层（multica 服务端零校验，只有空串被拒）—— 白名单写进服务面会让「放开完整 emoji
     picker」变成一次服务端改动 + 一次数据迁移。
   · **作者身份 = 组合根注入的 `localHumanActor`**（与 0018 创建人 / 0020 视图 owner **同一处定义点**）：
     调用方**不能自证身份**（设计案 §12-2），故两个方法都没有 author 入参。未注入 ⇒ **两个方法都
     响亮抛**（读也抛：这份服务面没接通本机身份时，界面读到的行没有「谁是我」的判据，聚合的
     `reactedByMe` 会静默错位 —— 与 0018/0020 的「身份未接通一律抛」同款）。
   · **工作项归属**（§8.5）：工作项不存在 / 已归档 / 不属于目标 workspace ⇒ 响亮抛、**零写入**。
     归档行**视同不存在**（与 `listWakeRules` 的登记口径、`updateWorkItem` 的未命中口径同款）：
     界面读不到归档工作项，写进去的反应也没有任何呈现面。
   · **不过门禁**（`assertDispatchEnabled`）：reactions 不产生新派发（与 `updateWorkItem` 同款理由
     —— 关掉实验开关后不该连点个表情都不让）。**本层不写任何第二份开关判据。** */

/**
 * emoji 的**宽松长度上限**（UTF-8 字节）：护栏是防滥用，不是白名单（见文件头）。
 *
 * 32 字节的取法：32 = 单码点 emoji 的 8 倍长度、组合序列（肤色 / ZWJ 家族）也够用；
 * 超过这个量级的「emoji」只可能是传错对象（整段文本 / blob）——**存储层不设这条**（迁移 0021
 * 只拒空串），它是服务面的输入护栏，登记在交付报告（要放开只需改这一个常量）。
 */
export const WORK_ITEM_REACTION_EMOJI_MAX_BYTES = 32;

export type WorkItemReactionOpsDeps = {
  /** 按目标现构 runtime（裁定 4：不缓存、不取首个）——与描述符侧同一个工厂。 */
  createRuntime: (target: SquadWorkspaceTarget) => Promise<SquadRuntime>;
  /**
   * **本机操作者身份**（反应行的作者）：与 0018 创建人 / 0020 视图 owner **同一处定义点**
   * （组合根本机操作者常量）。身份是幂等键（五元组含 `author_kind/author_id`）的一半，
   * **不能**由调用方自证；未注入 ⇒ 两个方法**响亮抛**。
   */
  localHumanActor?: () => WorkItemCreator;
  /** 时钟（测试可钉死；缺省 `Date.now`）：`created_at` 在服务面边界取，repo 显式收时间戳以便回放。 */
  now?: () => number;
  /** id 生成（测试可钉死；缺省 `crypto.randomUUID`）：id 不是幂等键（五元组才是），但它是行身份。 */
  newId?: () => string;
};

export function createWorkItemReactionOps(
  deps: WorkItemReactionOpsDeps,
): Pick<ISquadRuntimeService, "setWorkItemReaction" | "listWorkItemReactions"> {
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID());

  /**
   * 本机操作者（反应行的作者；见 deps.localHumanActor 的理由）。未接通 ⇒ 响亮抛：
   * 静默用「空身份」会让反应长在谁也认不出的主体上，而聚合的第一格判据就是作者身份。
   */
  const requireActor = (): WorkItemCreator => {
    const actor = deps.localHumanActor?.();
    if (!actor) {
      throw new Error(
        "工作项 reactions 服务面未接通本机操作者身份：组合根必须注入 localHumanActor（与 0018 创建人 / " +
          "0020 视图 owner 同一处定义点）。反应行的作者是幂等键的一半 —— 没有它，「同人同 emoji 恰一条」" +
          "没有判据，故一律抛。",
      );
    }
    return actor;
  };

  /** emoji 的两条闸（唯一实现；见文件头「emoji 只剩两条闸」）。**写之前**判，被拒时不落盘。 */
  const assertEmoji = (emoji: unknown): string => {
    if (typeof emoji !== "string" || emoji.length === 0) {
      throw new Error(
        `emoji 必须是非空字符串（收到 ${JSON.stringify(emoji)}）：这是唯一的形状判据 —— 存储不白名单` +
          "（multica 服务端零校验，唯一的存储层闸是迁移 0021 的 CHECK(length(emoji) > 0)）。",
      );
    }
    const bytes = new TextEncoder().encode(emoji).length;
    if (bytes > WORK_ITEM_REACTION_EMOJI_MAX_BYTES) {
      throw new Error(
        `emoji 超过长度上限（${bytes} > ${WORK_ITEM_REACTION_EMOJI_MAX_BYTES} 字节）：` +
          "护栏是防滥用（表情是自由输入，超长串只可能是传错对象），不是白名单；" +
          "要放开完整 picker 只需改服务面这一个常量（存储层不设这条）。",
      );
    }
    return emoji;
  };

  /**
   * 工作项归属校验（唯一实现，两个方法共用）。三条分支各自响亮，**没有一个降级成「视同没有」**：
   * · 不存在 ⇒ 抛（静默返回空数组会把「id 算错」伪装成「这个项还没人反应」）；
   * · 跨 workspace ⇒ 抛（§8.5：把「取错了目标」伪装成「不存在」会让人查错方向）；
   * · 已归档 ⇒ 抛（归档行视同不存在：界面读不到它，写进去的反应也没有呈现面）。
   * 判据读的是**本 runtime 绑定的 workspace**（`workspaceKeyOf`），不是调用方另传的 key。
   */
  const assertWorkItemInWorkspace = (
    runtime: SquadRuntime,
    workspaceKey: string,
    workItemId: string,
  ): void => {
    const live = runtime.workItemRepo.get(workItemId);
    if (live) {
      if (live.workspaceIdentity !== workspaceKey) {
        throw crossWorkspaceError(workItemId, live.workspaceIdentity, workspaceKey);
      }
      return;
    }
    const anyRow = runtime.workItemRepo.getIncludingArchived(workItemId);
    if (!anyRow) {
      throw new Error(
        `工作项「${workItemId}」不存在：工作项级 reactions 必须挂在本 workspace 的既有工作项上（§8.5），` +
          "不写指向空气的孤儿反应。",
      );
    }
    if (anyRow.workspaceIdentity !== workspaceKey) {
      throw crossWorkspaceError(workItemId, anyRow.workspaceIdentity, workspaceKey);
    }
    throw new Error(
      `工作项「${workItemId}」已归档：归档行视同不存在（工作项级 reactions 不挂到已归档项上 —— ` +
        "界面读不到它，写进去的反应也没有任何呈现面）。请先在工作项列表里恢复它。",
    );
  };

  const crossWorkspaceError = (workItemId: string, owner: string, workspaceKey: string): Error =>
    new Error(
      `工作项「${workItemId}」属于 workspace「${owner}」，与本次目标的「${workspaceKey}」不一致：` +
        "跨 workspace 引用一律响亮拒绝（§8.5）。",
    );

  return {
    /**
     * on=true ⇒ 幂等添加（`INSERT OR IGNORE` + `changes()` 判真插入）；on=false ⇒ 幂等撤销
     * （不存在 = 无变化、不报错）。返回**操作后该工作项的全部反应行**（插入序）——
     * 幂等语义下重复调用返回同值（见文件头）。
     *
     * 次序固定：① 现构 runtime；② 身份（未接通 ⇒ 抛）；③ emoji 两条闸（抛则不落盘）；
     * ④ 工作项归属（不存在 / 已归档 / 跨 workspace ⇒ 抛，零写入）；⑤ 写；⑥ 回读返回。
     */
    async setWorkItemReaction(target, input) {
      const runtime = await deps.createRuntime(target);
      const actor = requireActor();
      const emoji = assertEmoji(input.emoji);
      const workspaceKey = workspaceKeyOf(runtime);
      assertWorkItemInWorkspace(runtime, workspaceKey, input.workItemId);
      if (input.on) {
        runtime.workItemReactionRepo.add({
          id: newId(),
          workspaceKey,
          workItemId: input.workItemId,
          author: actor,
          emoji,
          createdAt: now(),
        });
      } else {
        runtime.workItemReactionRepo.remove({
          workspaceKey,
          workItemId: input.workItemId,
          author: actor,
          emoji,
        });
      }
      return runtime.workItemReactionRepo.listByWorkItem(workspaceKey, input.workItemId);
    },

    /**
     * 本工作项的反应行（原始行、插入序）：**聚合归 UI**（`{emoji,count,actors,reactedByMe}`，
     * 其中 `reactedByMe` 必须带 kind 判断），服务面只给事实。
     * **不过门禁、只读**（读不是新派发，与 `listWakeRules` / `listWorkItemViews` 同款）。
     * 归属校验与写路径**同一份实现**（不存在 / 已归档 / 跨 workspace 一律响亮抛）。
     */
    async listWorkItemReactions(target, input) {
      const runtime = await deps.createRuntime(target);
      requireActor();
      const workspaceKey = workspaceKeyOf(runtime);
      assertWorkItemInWorkspace(runtime, workspaceKey, input.workItemId);
      return runtime.workItemReactionRepo.listByWorkItem(workspaceKey, input.workItemId);
    },
  };
}

/** 本 runtime 的 `workspace_key`（C14 口径）：与 `getSnapshot` / `createWorkItem` 同一条式子。 */
function workspaceKeyOf(runtime: SquadRuntime): string {
  return resolveWorkspaceKey({
    workspacePath: runtime.boundWorkspace.path,
    workspaceIdentity: runtime.boundWorkspace.identity,
  });
}
