import type { AuthorRef, SquadWorkspaceTarget, WorkItemReactionRecord } from "@zcode/services";

/* 工作项级**表情回应**的**判据层**（阶段三 · T-P3-R5u；纯函数，可独立测）。

   口径来自任务卡 T-P3-R5（卡更新段）+ 取证报告 reports/2026-10-09-reactions-multica-evidence.md
   §1 Q3/Q4 与 §5 的「聚合规则」三条，逐条落在这里（组件与 hook 只消费，不再各判一次）：

   ① **kind 判断**：`reactedByMe` 的判据是 `author.kind === viewer.kind && author.id === viewer.id`
      —— 少了 kind 这一列，`agent:local-user` 的同 emoji 会被误标成「我」（订阅线同款断言：
      `human:local-user` 与 `agent:local-user` 是两个人）。
   ② **不折叠**：按 emoji 全量分组，没有上限、没有「+N」（multica 的 `flex-wrap` 平铺无 cap）。
   ③ **插入序**：分组次序 = 各行**首次出现**的次序（服务面读 = `created_at ASC, id ASC`，
      与 multica `ListIssueReactions` 同款），不按热度/码位重排 —— 重排的表现是界面次序
      随数据量抖动，看起来像「有人在动数据」。

   `reactedByMe` 可以是 `null`：**身份不可判定**（本挂载点拿不到观察者身份）时不假装「不是我」
   —— 与评论回应的 `CommentReactionGroup.mine: boolean | null` 同一口径（D1-A / C5）。 */

/**
 * 工作项回应的**快捷表情集**（v1 唯一一层；卡面 8 枚逐字同序）。
 *
 * 单一模块：选择器与任何消费点都从这里取（第二份清单 = 两边迟早不一样）。
 * 存储层**不白名单**（迁移 0021 只拒空串）—— 白名单是**呈现层**的事，写进 DDL 会把
 * 「放开完整 emoji picker」变成一次数据迁移（取证报告 §5「表情集」）。
 */
export const WORK_ITEM_REACTION_EMOJIS = ["👍", "👌", "❤️", "✅", "🎉", "😕", "🚀", "👀"] as const;

/** 回应分组：`emoji + count` 是 chip 的全部内容；`reactedByMe` 是品牌色的唯一判据。 */
export type WorkItemReactionGroup = {
  emoji: string;
  count: number;
  /** 主体的**行序**（= `created_at ASC`）；名字解析是呈现层的事（本层不起名）。 */
  actors: AuthorRef[];
  /** `null` = 观察者身份不可判定 ⇒ 界面不标「我」（不假装「不是我」）。 */
  reactedByMe: boolean | null;
};

/** `(kind, id)` 两列都同才算同一个主体（只比 id 会把智能体当成我）。 */
function sameActor(left: AuthorRef, right: AuthorRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}

/**
 * 按 emoji 分组（一次遍历，保持**首见次序**；组内主体按行序）。
 *
 * 空输入 ⇒ 空数组：0 反应是合法事实（界面据此决定「只画入口」还是「连入口一起画」），
 * 不是错误、也不该被调用方当成「没读到」。
 */
export function workItemReactionGroups(input: {
  rows: WorkItemReactionRecord[];
  /** 观察者身份（读面带回）；`null` = 不可判定（见文件头末段）。 */
  viewerActor: AuthorRef | null;
  /**
   * **本机集**：身份不可判定时唯一可用的第二条判据（`ownEmojis`）。
   *
   * 为什么它可靠而不是猜：本机集的每一枚都来自**服务面的写结论**（见
   * `workItemReactionOwnEmojisAfterWrite`）—— 「置上」返回多了一行 ⇒ 那行的作者就是我；
   * 「置上」没有多行 ⇒ 命中了五元组唯一键 ⇒ 这一枚本来就是我的。两条推理都只依赖服务面契约。
   *
   * 缺省（`undefined`）＝ 调用方没有这份知识（peek / 静态调用）：身份缺席就是 `null`。
   */
  ownEmojis?: ReadonlySet<string>;
}): WorkItemReactionGroup[] {
  const groups = new Map<string, WorkItemReactionGroup>();
  const judge = (emoji: string, author: AuthorRef): boolean | null => {
    if (input.viewerActor !== null) return sameActor(author, input.viewerActor);
    /* 身份不可判定：本机集里有的 ⇒ 确定是我的；没有的 ⇒ **不知道**（`null`，不是 `false`）。 */
    return input.ownEmojis?.has(emoji) === true ? true : null;
  };
  for (const row of input.rows) {
    const existing = groups.get(row.emoji);
    if (!existing) {
      groups.set(row.emoji, {
        emoji: row.emoji,
        count: 1,
        actors: [row.author],
        reactedByMe: judge(row.emoji, row.author),
      });
      continue;
    }
    existing.count += 1;
    existing.actors.push(row.author);
    if (existing.reactedByMe !== true) {
      existing.reactedByMe = judge(row.emoji, row.author);
    }
  }
  return [...groups.values()];
}

/**
 * 按下某一枚 emoji 之后该发**置上**还是**撤销**（卡面 toggle 语义：同 emoji 再点 = 撤销；
 * 选择器里选中自己已选过的那枚 = 同一件事）。
 *
 * 身份可判定 ⇒ 逐行 `(kind,id)` 判；不可判定 ⇒ 查本机集（在里面 ⇒ 撤销）。两条判据都没有
 * （本机集是空的、这一枚没写过）⇒ **只能置上**：服务面的写是幂等的（同人同 emoji 恰一条、
 * 重复 add 无副作用），而猜「撤销」会把别人的反应删掉 —— 两种错法不对称，故只走安全的那一边。
 */
export function workItemReactionToggleOn(input: {
  rows: WorkItemReactionRecord[];
  viewerActor: AuthorRef | null;
  ownEmojis?: ReadonlySet<string>;
  emoji: string;
}): boolean {
  const viewer = input.viewerActor;
  if (viewer === null) return input.ownEmojis?.has(input.emoji) !== true;
  return !input.rows.some((row) => row.emoji === input.emoji && sameActor(row.author, viewer));
}

/**
 * 一次写成功之后的**本机集**：置上 ⇒ 加上这一枚（无论新增还是幂等命中，结论都是「这枚是我的」）；
 * 撤销 ⇒ 去掉这一枚。
 *
 * 为什么「置上 + 没有新增行」也归我：`setWorkItemReaction(on:true)` 走 `INSERT OR IGNORE`，
 * **没有新行**只可能是命中了 `(workItem, 我, emoji)` 这个五元组 —— 即这一枚本来就是我按过的。
 * 这条推理让「身份不可判定」的挂载点（详情页概览，页面冻结不投 `viewerActor`）一次点击就判准：
 * 第一次点是「置上」（幂等安全），之后再点同一枚就是撤销，而不会永远卡在「点了没反应」。
 */
export function workItemReactionOwnEmojisAfterWrite(input: {
  previousEmojis: ReadonlySet<string>;
  emoji: string;
  /** 本次意图（`workItemReactionToggleOn` 的结论）。 */
  on: boolean;
}): ReadonlySet<string> {
  const next = new Set(input.previousEmojis);
  if (input.on) next.add(input.emoji);
  else next.delete(input.emoji);
  return next;
}

/**
 * 从一次写的前后行集**学出本机操作者身份**（`null` = 学不到，不猜）。
 *
 * 为什么这件事成立：服务面契约写明「反应行的作者 = 组合根注入的 `localHumanActor`，
 * 调用方不能自证身份」—— 因此**我这一次写新增的那一行**的作者必然是我。
 *
 * 为什么只在「恰一行新增」时学：0 行新增 = 幂等命中（没有新事实）；≥2 行新增 = 同时有并发写者，
 * 分不清哪一行是我。「候选多于一个不得静默挑一个」是仓库既有纪律（`squadWorkspaceTarget` 同款）。
 *
 * 学到之后，`reactedByMe` 从「本会话我按过的」升级为**逐行 (kind,id) 判定** —— 我此前的
 * 历史反应（本次会话之外留下的行）也一并被正确点亮。
 */
export function workItemReactionLearnedViewer(
  previousRows: WorkItemReactionRecord[],
  nextRows: WorkItemReactionRecord[],
): AuthorRef | null {
  const known = new Set(previousRows.map((row) => row.id));
  const added = nextRows.filter((row) => !known.has(row.id));
  return added.length === 1 ? added[0]!.author : null;
}

/**
 * 一次写成功之后的**观察者身份**：调用方给的那份优先（读面身份是权威），缺席时用这次学到的。
 *
 * 行集**不再经本层**：`setWorkItemReaction` 返回的就是操作后该工作项的全部行（插入序），
 * 直接用那一份替换本地行集 —— 本地做增减会造出第二份事实（仓库纪律：无乐观插入，
 * 只有「服务返回替换」）。
 */
export function workItemReactionViewerAfterWrite(input: {
  previousRows: WorkItemReactionRecord[];
  nextRows: WorkItemReactionRecord[];
  viewerActor: AuthorRef | null;
}): AuthorRef | null {
  return input.viewerActor ?? workItemReactionLearnedViewer(input.previousRows, input.nextRows);
}

/**
 * 回应读写要用的 workspace 目标：**按行自身的来源反推**（`workspacePath` + `workspaceIdentity`）。
 *
 * 为什么不是页面那份 `target`：详情页概览只收到 `workItem` 本体（`WorkItemDetailPage.tsx` 是
 * 399/400 的冻结页面，本轮零改动），拿不到页面的目标；而 `WorkItem.workspaceIdentity` 就是
 * repo 的 `workspace_key` 列（`workItemRepo.ts` 的同名列映射），按它反推出的 key 与
 * 服务面的归属校验**同值**。这与收件箱的 `inboxItemUnsubscribeTarget` 是同一手法
 * （跨面目标一律按行反推，不挑、不猜、不取首个）。
 *
 * 空路径 ⇒ `null`（坏形状不出手；schema 保证非空，故这是兜底而非常规分支）。
 */
export function workItemReactionsTarget(workItem: {
  workspacePath: string;
  workspaceIdentity: string;
}): SquadWorkspaceTarget | null {
  const path = workItem.workspacePath.trim();
  if (path.length === 0) return null;
  return { path, identity: workItem.workspaceIdentity.trim() };
}
