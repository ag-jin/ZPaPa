import type { Squad, WorkItem } from "@zcode/shared";

/* 队长角色 run 的派发（spec §3.3 指派语义 / §5.1 三路输入一处写入 / §5.7.2 队长不改父项状态）。

   这里是**唯一一处**队长解析：用户指派、队长派单、规则触发三路都从这一个入口出去，
   差别只在事件里是否附带 `wake.rule_fired`。之所以把「唯一一处」当硬约束，是因为最容易出错的写法
   是在规则路径上另开一条捷径——「有 assignee 就当 agent 起一次 run」。那样指派给小队的工作项
   一旦由规则唤醒，就会被当成普通 agent 执行，队长被整条绕过（spec §5.1「三路都只发同一形状的
   派发事件」）。

   本函数**只产出事件**，不写任何状态：工作项状态由工作项服务按条件推进（§5.7.2 / S6），
   这里连入参都不改（简报也做成快照），所以同一份入参任何时候都得到同一批事件，可以被穷举测干净。 */

export type SquadBriefing = {
  squadId: string;
  leaderAgentId: string;
  roster: { agentId: string; role?: string }[];
  /** **系统生成**的机制段（spec §3.3）：内容与用户指令无关，见 `LEADER_PROTOCOL_TEXT`。 */
  protocol: string;
  instructions: Record<string, string>;
};

/**
 * 操作协议：简报的**机制**那一半（spec §3.3）。**系统生成、非用户可写**。
 *
 * 为什么必须是独立一段、不能并进 `instructions`（spec §3.3 末段）：`instructions` 是**用户意图**
 * 那一半，机制交还给用户去写，没写就等于「队长不知道规则却照跑」——而且**不报错**，
 * 表现只是「它自顾自地跑，规矩和产品语义对不上」。
 *
 * 逐项对应 spec §3.3 的 protocol 行与 §5.5 / §5.7 / §6.2 / §6.3：
 * 三道闸与判定次序、stopCondition 与 maxRounds 语义、派单不改父项状态、
 * 串行合并到集成分支、整批通过才合回主分支、解不了冲突 → blocked + 进 Inbox、
 * 审查未通过前工作树存活、合并后才抛弃。
 * 文案做成常量而不是拼在 `buildBriefing` 里：它是**契约面**（Wave 1 的渲染器、测试与将来的
 * 本地化都要对表），散在函数体里会随改动漂移而没人发现。
 */
export const LEADER_PROTOCOL_TEXT = [
  "你是本小队的队长。以下规则由系统给定，不由用户指令覆盖：",
  "",
  "1. 三道闸与判定次序（防失控，硬规则）：派发前先判 `max_fires`，再判 `rate`（一小时内 run 次数），",
  "   最后判 `loop`（run 链中同一规则重复出现）；三道闸都过了才判去重。顺序不可调换。",
  "2. 收手条件与轮次上限：用户给的 `stopCondition` 决定何时继续 / 收工 / 叫人，`maxRounds` 是",
  "   最多派几轮。两者与 `max_fires` 呼应，撞上任何一条都停下来并进 Inbox 汇报，不要自己放宽。",
  "3. 派单只产出**子工作项与派发事件**，**不得改父项状态**：父项由工作项服务按条件推进。",
  "4. 合并是**串行**的：一次只合一个队员进集成分支，不要并发合并。",
  "5. 队员的成果先合到集成分支，**整批通过才合回主分支**；中途不得直接改主分支。",
  "6. 集成分支上解不了的冲突：把工作项置 `blocked` 并进 **Inbox** 交给用户，不要自行丢弃或强推。",
  "7. 审查未通过的队员分支：其工作树必须**存活**到合并为止，不得提前清理。",
  "8. 工作树与分支在**合并后**才抛弃；未合并就删 = 丢掉一个队员的活。",
].join("\n");

/**
 * 一次 run 的**类别**（spec §6.1「是否开工作树是**本次运行**的属性」的三分）：
 *
 * · `leader`     —— 队长 run：在**目标工作区**执行（不开工作树）；仍需一条台账行（§5.7(1) 判「进行中」）。
 * · `member`     —— 小队**队员** run：开**独立工作树 + 独立分支**（§6.4），登记台账行，产出活到合并（§6.2）。
 * · `standalone` —— **单独安排的智能体**（不在任何小队里）：**直接在工作区改** —— 不开工作树、不开分支、
 *                   **没有合并那一步**（§6.1）⇒ 也就没有孤儿要回收。
 *
 * 为什么必须是**显式字段**、而不是让消费者去猜（复审判词）：派发结果里唯一带 `squadId` 的是队长，
 * 其余两类此前**没有任何可分辨的字段** —— 于是消费者只能按「非队长 ⇒ 开树」处理，把单独安排的智能体
 * 也塞进了一条分支。那条分支**永不合并、也永不被回收**（`activeBranches` 只覆盖小队命名空间），
 * 而且全程**不报错**。用 `squadId` 的有无代替判别就是一条隐式契约：谁一改就漂移，故这里写成**必填**。
 *
 * **产出面必填还不够**：类别在**输入面**也必须由调用方显式声明（见 `planDispatch` 的 `runClass` 入参
 * 与 `DeclaredRunClass`）—— 否则「调用方漏传父项事实」会静默落成 `standalone`（下一轮修掉的残留）。
 */
export type RunClass = "leader" | "member" | "standalone";

/**
 * 类别**声明**的取值：`member`（小队队员）与 `standalone`（单独安排的智能体）。
 *
 * 为什么没有 `leader`：队长由「负责人被指派给小队」这一**事实**唯一决定（`assignee.type === "squad"`），
 * 调用方既不需要也无法声明它。**为什么需要这个字段**：见 `planDispatch` 的 `runClass` 入参注释 ——
 * 一句话，类别不能从「可选字段的有无」推断，必须**必答**，答漏了要响亮。
 */
export type DeclaredRunClass = "member" | "standalone";

/** 派发事件：`run.enqueued` 起一次运行；`inbox.notified` 是**跳过**（进 Inbox 等人处理）；
    `wake.rule_fired` 是规则触发的留痕（幂等键 `(workItemId, ruleId, revision, eventKey)` 的一半，§3.9）。 */
export type DispatchEvent =
  | {
      kind: "run.enqueued";
      workItemId: string;
      agentId: string;
      /** 历史字段，机械半与既有消费者仍读它；与 `runClass` 恒等（`=== "leader"`）。**新增不替换**。 */
      isLeaderTask: boolean;
      /** 本次 run 的**类别**（见 `RunClass`）：消费者据此分流，**不得**再靠 `squadId` 的有无去猜。 */
      runClass: RunClass;
      squadId?: string;
      briefing?: SquadBriefing;
    }
  | { kind: "inbox.notified"; workItemId: string; reason: string }
  | { kind: "wake.rule_fired"; workItemId: string; ruleId: string };

export function planDispatch(input: {
  workItem: WorkItem;
  squad: Squad | null;
  /**
   * **派发时的事实**（加法，spec §6.1/§6.2）：本工作项的**父项**。**校验**用（不再是判据 —— 判据是
   * 调用方给的 `runClass` 声明）：队长用 `squad.createChildWorkItem` 建出的子项**总是挂在「指派给小队
   * 的那条父项」之下**（工具的 modelInstructions 明文要求「Always pass the parent work item id you
   * were given」），所以「父项被指派给小队」是「本项在一支小队批次里」的**证据**。
   *
   * 为什么校验要盯这条事实、而不是触发来源：spec §5.5 让「队长派单」与「人手动触发」走**同一条**
   * 派发路径（`trigger: "user"`）⇒ 来源分不出「队员」与「单独安排」；而「本项在不在小队批次里」是
   * **工作项自身的事实**，与谁触发无关（规则触发一条队员子项时它仍是队员 ⇒ 仍必须开树）。
   *
   * 为什么这条事实仍然要传：它不是判据了，但它仍是**校验**的一半 —— 只声明、无证据（或证据与声明
   * 矛盾）一律响亮抛。**光靠源码守卫盯「调用方有没有传」是不够的**（它只能证「传了」，证不了「传对了」），
   * 所以本函数把「声明 ↔ 事实」当场对表（见 `resolveAgentRunClass`）。
   *
   * 省略 / `null`（没给 / 根本没查到）= **没有「在批次里」的证据**：若调用方声明 `member`，这会导致
   * 响亮抛（**不得**默认成 standalone，见 `resolveAgentRunClass`）；声明 `standalone` 时才放行。
   * 既有调用方不传时编译不受影响（**加法**）。
   */
  parentWorkItem?: WorkItem | null;
  /**
   * 本次 run 的**类别**，由**派发调用方显式声明**（加法；`assignee.type === "agent"` 时**运行时必填**）。
   *
   * 这一格是「队员被判成单独安排、静默丢掉工作树隔离」那条残留的修法。旧判别式写作
   * `isSquadBatchChild(input.parentWorkItem) ? "member" : "standalone"`，而 `parentWorkItem` 因 F8
   * 冻结签名只能做成**可选** ⇒ 调用方**漏传**时没有「在批次里」的证据 ⇒ 静默落 `standalone`
   * ⇒ **那个队员不开工作树、直接在主工作区改** —— spec §6.1 的隔离承诺被**静默取消**，且全程不报错。
   * 根因是**拿「可选字段的有无」当判据**：漏传与「确实不在批次里」在结果上长得一模一样，而前者是接线缺陷。
   * 所以类别改为**必答**：调用方说出它派的是哪一类，`parentWorkItem` 降级为**校验** ——
   * 声明缺证据 / 声明与证据矛盾一律**响亮抛**，没有任何一格会「碰巧」落成 standalone。
   *
   * 「声明什么」由 `declaredRunClassFor`（同一模块导出，唯一策略）算：它只读本项的 `parentId` 与父项
   * 事实，**包括**「父项查不到」那一格（那一格故意声明 `member` 好让本函数响亮拒绝，理由见该函数）。
   *
   * 非 agent 指派（`user` / `squad`）的调用方**可以不传**：那两类的类别由负责人类型本身唯一决定
   * （人 ⇒ 不排队；小队 ⇒ 队长），`runClass` 只在 agent 这一支里有信息量。
   */
  runClass?: DeclaredRunClass;
  trigger: "user" | "leader" | "rule";
  /**
   * **显式目标覆盖**（B-1 裁定，2026-10-06；spec §5.2/§4.2）：本次派发**派给谁**。
   *
   * 为什么必须有这一格：`@agent` 评论是「一次运行请求」而**不是改派**（§5.2 明文「`@agent` 不等于改派，
   * assignee 保持不变」）⇒「评论目标 ≠ assignee」是**常态格**。而没有覆盖时，`agent` 分支只派
   * `workItem.assignee.id`（规则 / 队长工具 / UI 改派三路共用的既有语义）—— 评论触发接不进来；
   * 让接线方自己改 assignee 再派发则是伪造用户改派（`user_reassign` 成因 + 负责人被改写），
   * 正是 §5.2 禁止的「把 `@` 伪装成 `user_reassign`」。
   *
   * 语义（逐条）：
   * · 覆盖命中时**跳过 assignee 推导**：`user` / `squad` 负责人也照样给覆盖目标起一次 agent run
   *   （评论不依赖 assignee；`@agent` 在指派给人的项上同样是运行请求）；
   * · `runClass` **仍按本项自身的父项事实**声明与校验（§7.1 方案 A：类别是「本次运行」的属性，
   *   与派给谁无关）—— 覆盖不短路 `resolveAgentRunClass` 的「声明↔证据」对表；
   * · 覆盖目标**不带**队长标记、不夹带花名册简报（被点名的普通智能体不该以为自己要去派单）；
   * · 只描述**派给谁**，不写任何状态：`assignee`/`status` 一字不动（纯函数，§5.2）。
   */
  targetOverride?: { type: "agent"; id: string };
  /* 规则触发时的规则 id。brief 的 Interfaces 只写了触发源种类、没写 id 的来路，而 `wake.rule_fired`
     事件必须带上它，所以这里补一个可选入参（**不凭空编一个 id**）。`trigger === "rule"` 时它是必填：
     缺失、空串、或**纯空白**一律抛错，见下面的 if 分支。 */
  ruleId?: string;
}): DispatchEvent[] {
  const { workItem, squad, trigger } = input;
  const events: DispatchEvent[] = [];

  /* 触发源只留痕、不参与解析：痕迹放在结论**之前**，消费方按序读到的是因果顺序
     （先「某条规则到点了」，再「派发结论是什么」）。 */
  if (trigger === "rule") {
    /* 规则触发却不指名规则 → **响亮失败**：spec §3.9 的幂等键是 `(workItemId, ruleId, revision, eventKey)`，
       留个空串就等于把「哪条规则」这一维抹掉——两条不同规则的派发会被当成同一件事，
       而且这种接线缺陷会一路静默通过（没有任何一步会报错）。
       判空用 `trim()`：与本分支既有口径一致（Task 1 的 `isBlankInstruction`「**空白 = 未填**」）——
       `" "` 同样是没填 id，只拒 `""` 会让纯空白串带着「有 id」的假象一路通过。 */
    if (input.ruleId === undefined || input.ruleId.trim() === "") {
      throw new Error(
        "trigger=rule 但没有给出规则 id（ruleId）：规则触发必须能指名是哪条规则，否则 spec §3.9 的幂等键退化",
      );
    }
    events.push({ kind: "wake.rule_fired", workItemId: workItem.id, ruleId: input.ruleId });
  }

  /* B-1：**显式目标覆盖优先于 assignee 推导**（评论 `@agent` 派给点名者、不动 assignee，§5.2）。
     为什么放在 trigger 留痕**之后**、switch **之前**：① 规则幂等键的留痕与「派给谁」无关，
     丢了它 `(workItemId, ruleId, revision, eventKey)` 四元组会退化；② 覆盖是「这次派给谁」的
     完整答案 ⇒ 不再进入按 assignee 类型分流的 switch（负责人是人/小队时也照样起 agent run）。
     类别仍走 `resolveAgentRunClass` 的「声明 ↔ 父项证据」对表：覆盖只换目标，不换类别判据。 */
  if (input.targetOverride !== undefined) {
    events.push({
      kind: "run.enqueued",
      workItemId: workItem.id,
      agentId: input.targetOverride.id,
      isLeaderTask: false,
      runClass: resolveAgentRunClass({
        declared: input.runClass,
        parent: input.parentWorkItem,
        workItemId: workItem.id,
        parentId: workItem.parentId,
      }),
    });
    return events;
  }

  /* 原始值另存一份，只为下面 default 的错误信息：进了 switch 之后 `assignee.type` 会被收窄成
     `never`（三条腿已穷尽），在 default 里再读它就取不到原值了。 */
  const rawType: string = workItem.assignee.type;

  switch (workItem.assignee.type) {
    /* 指派给人：人不排队——没有 run 可起，进 Inbox 等人自己动手。 */
    case "user":
      events.push(notify(workItem.id, "工作项指派给人：不排队起 run，进 Inbox 等人处理"));
      break;

    /* 显式指派单个智能体（spec §5.6 `@` ≠ 指派）。类别由**调用方声明**（`input.runClass`），本函数拿
       `parentWorkItem` 事实**校验**这个声明（见 `resolveAgentRunClass`）：声明缺证据 / 声明与证据矛盾
       一律响亮抛。不再有「非队长 ⇒ 单独安排」那条静默缺省 —— 那正是本次要修的那条残留
       （漏传父项 ⇒ 队员静默丢了工作树隔离，§6.1 落空且不报错）。
       两类都**不挂队长标记、不夹带花名册简报** —— 否则接到简报的普通智能体会以为自己该去派单。 */
    case "agent":
      events.push({
        kind: "run.enqueued",
        workItemId: workItem.id,
        agentId: workItem.assignee.id,
        isLeaderTask: false,
        runClass: resolveAgentRunClass({
          declared: input.runClass,
          parent: input.parentWorkItem,
          workItemId: workItem.id,
          parentId: workItem.parentId,
        }),
      });
      break;

    /* 指派给小队：解析 `leaderAgentId` 并注入简报（spec §3.3）。三条触发路径共用本分支。 */
    case "squad": {
      /* 小队拿不到（被删或指派引用失效）→ 只通知，**不降级**：把 squad.id 当普通 agentId
         起一次 run 会去唤醒一个不存在的智能体，人还得从一份看不懂的运行里反推真相。 */
      if (squad === null) {
        events.push(
          notify(
            workItem.id,
            "指派的小队不存在（已被删除或指派引用失效）：跳过本次派发，等人在 Inbox 处理",
          ),
        );
        break;
      }
      /* 已归档的小队按 **skip（非失败）** 处理（spec §3.10 / S10）：归档是「停止使用」，
         花名册与指令都还在，只是不再接新派发；报成失败会让人去查一个并不存在的错误。 */
      if (squad.archivedAt !== undefined) {
        events.push(
          notify(workItem.id, "指派的小队已归档：按归档语义跳过本次派发，等人在 Inbox 处理"),
        );
        break;
      }
      /* 已停用（`enabled: false`）与已归档是 spec §3.3 并列的**两条状态**，必须一样处理：
         两者都是「这个小队现在不接新派发」，只判 archivedAt 会让停用形同虚设——用户以为停用了，
         队长仍被唤醒派单（`WakeRule.enabled` 被 `listReady` 真实消费，两实体口径不能不对称）。
         reason 文案**必须与「已归档」区分**：归档是长期退出（花名册还在但不再使用），停用是可随时
         重新打开的临时开关，让接线方与用户一眼能分辨该去「取消归档」还是「重新启用」。
         次序上归档先判：两者同时命中时报「已归档」（更强的终态结论），不掩盖既有语义。 */
      if (squad.enabled === false) {
        events.push(
          notify(
            workItem.id,
            "指派的小队已停用（enabled=false）：按停用语义跳过本次派发，启用后再派发",
          ),
        );
        break;
      }
      events.push({
        kind: "run.enqueued",
        workItemId: workItem.id,
        agentId: squad.leaderAgentId,
        isLeaderTask: true,
        runClass: "leader",
        squadId: squad.id,
        briefing: buildBriefing(squad),
      });
      break;
    }

    /* 契约违例的**断言**，不是兜底分支。`assignee.type` 由 `workItemSchema` 限定为三态，上面三条腿已穷尽
       （TS 能证明只有 `never` 能走到这里）；能走到这一行，说明有数据绕过了 schema 写入——`workItemRepo`
       读库时对 `assignee_type` 是 `as` 强转、不做运行时校验，手改过库的行就能带来第四个值。
       此时**响亮失败**远好过静默跳过：静默的话用户看到的是「指派了但什么都没发生」，而抛错直接指出
       「是这条数据坏了」。AGENTS.md 禁的是「不断增加兜底分支」（新增容错路径）；对契约违例抛错恰恰相反，
       它是在把契约钉死，不是在容忍偏差。 */
    default:
      throw new Error(
        `未知的指派类型「${String(rawType)}」：assignee.type 只允许 user/agent/squad，` +
          "出现第四个值说明这条工作项绕过了 workItemSchema 写入，请检查数据库中该行",
      );
  }

  return events;
}

function notify(workItemId: string, reason: string): DispatchEvent {
  return { kind: "inbox.notified", workItemId, reason };
}

/**
 * `parentWorkItem` 这条**证据**是否支持「本项在一支小队批次里」：父项被**指派给小队**。
 *
 * 为什么是「父项负责人」：队长派活的方式是 `squad.createChildWorkItem`（挂一条**子项**在指派给小队的
 * 那条父项之下，再 `squad.assignWorkItem` 指给某位队员），所以「队员的任务」= 一条 `parentId` 指向
 * **小队项**的工作项。这只读**派发那一刻的工作项事实**（§6.2：开不开工作树是「本次运行」的属性），
 * 与触发来源、与队员是谁都无关 —— 换个触发源（规则 / 人 / 队长）不会改变结论。
 *
 * **它已经不再是判据**（判据是调用方给 `runClass` 的那条**声明**）：本函数只回答「这份证据支持哪一边」，
 * 由 `resolveAgentRunClass` 负责拿它与声明对表。原因就是本次的残留 —— 「从可选字段的有无推断类别」
 * 让**漏传**与「确实不在批次里」在结果上长得一样，前者是接线缺陷却被静默当成后者。
 */
function isSquadBatchChild(parent: WorkItem | null | undefined): boolean {
  return parent != null && parent.assignee.type === "squad";
}

/**
 * 把「调用方的类别**声明**」与「父项**证据**」对表，得出 `agent` 指派这一支真正的 `runClass`。
 * 三个「不该沉默」的格子全部在这里**响亮抛**（`assignee.type === "agent"` 专用，见 `planDispatch` 的
 * `runClass` 入参注释）：
 *
 * · **没声明**：类别必须必答。缺省落成 `standalone` 会把一名队员静默降级成「直接改主工作区」。
 * · **声明 `member` 但缺 `parentWorkItem`**：这一格就是「父项已归档 / 被删 / 跨 workspace」的落点
 *   （`workItemRepo.listByWorkspace` 过滤归档行 ⇒ 查不到就是 `null`）。**不许**默认成 standalone：
 *   查不到父项**无法证明它不在批次里**，按 standalone 放行 = 静默取消 §6.1 的隔离；而按 member 放行又
 *   没有证据可校验。两条都不能静默选 ⇒ 拒绝并交给人处置（重派发不会自愈，host 会按 permanent 收口）。
 * · **声明与证据矛盾**（member 对上一份非小队证据 / standalone 对上一份小队证据）：不静默改判任何一边。
 *   按 standalone 放行会丢隔离，按 member 放行是**凭空**开一棵调用方没要求的树 —— 两者都在掩盖接线缺陷。
 *
 * 为什么不在这里「按证据修正声明」：修正 = 把矛盾吞掉，而下一次矛盾就没人看得见了；响亮抛的代价只是
 * 一次可见的 permanent 失败，改对声明即可自愈。
 */
function resolveAgentRunClass(input: {
  declared: DeclaredRunClass | undefined;
  parent: WorkItem | null | undefined;
  workItemId: string;
  parentId: string | undefined;
}): "member" | "standalone" {
  const { declared, parent } = input;
  if (declared === undefined) {
    throw new Error(
      `工作项 ${input.workItemId} 被指派给单个智能体，但没有声明 runClass（member / standalone）：` +
        "类别必须由调用方**显式声明**，缺省不得落成 standalone —— 那会把一名队员静默降级成" +
        "「直接在工作区改」，spec §6.1 的工作树隔离会在无人察觉的情况下被取消",
    );
  }
  if (declared === "member") {
    if (parent == null) {
      throw new Error(
        `工作项 ${input.workItemId} 声明 runClass=member（在一支小队批次里），但没有可用的父项事实` +
          `（parentId=${input.parentId ?? "（无）"}；父项被归档 / 删除 / 落在别的 workspace 时都查不到）：` +
          "缺父项证据不得默认成 standalone（那是静默取消 §6.1 的隔离），也不得凭空开树 —— " +
          "请先让父项可读，或显式声明它不在批次里（runClass=standalone）",
      );
    }
    if (!isSquadBatchChild(parent)) {
      throw new Error(
        `工作项 ${input.workItemId} 声明 runClass=member，但父项 ${parent.id} 的负责人是` +
          `「${parent.assignee.type}」而不是小队：声明与事实矛盾（批次成员要求父项被指派给小队）。` +
          "静默改判任一方向都会掩盖这条接线/数据缺陷，故在此响亮失败",
      );
    }
    return "member";
  }
  // declared === "standalone"
  if (parent != null && isSquadBatchChild(parent)) {
    throw new Error(
      `工作项 ${input.workItemId} 声明 runClass=standalone，但父项 ${parent.id} 被指派给小队：` +
        "本项其实在一支小队批次里 —— 按 standalone 放行等于静默丢掉工作树隔离，" +
        "按 member 放行则是凭空开一棵调用方没要求的树；请把声明改成 runClass=member",
    );
  }
  return "standalone";
}

/**
 * 调用方该**声明**哪一类（`planDispatch` 的 `runClass` 入参）—— 「声明」的算法，**不是判据**：
 * 真正的判据是「声明 ↔ 证据」的对表，那一处只在 `resolveAgentRunClass`。
 *
 * 为什么要有这个小函数：类别必须显式声明，而「声明什么」只能从**派发时的事实**推出来 —— 本项的
 * `parentId`（工作项自身的字段，不经任何查找）+ 父项事实。把这条规则收在一处并导出，是为了让**所有**
 * 调用方（host 派发桥、测试里的同形副本）用同一条规则，而不是各写一份「碰巧一样」的推导
 * （那种复制的表现正是「改一处漏一处」，而它不会报错）。
 *
 * 逐格（与 `leaderDispatch.test.ts` 的穷举表一一对应）：
 * · `parentId` 缺（顶层项）⇒ `standalone`：它不在任何层级里，也就无从在批次里。
 * · 父项在、负责人是**小队** ⇒ `member`：正是 §6.4「每队员独立分支」的那一类。
 * · 父项在、负责人**不是**小队 ⇒ `standalone`：普通父子层级里的项**不是**批次成员（§6.1「单独安排的
 *   智能体」就是这个语义）。这一格也是**显式决定**的一格：批次被归档时
 *   `archiveSquadAndTransfer` 会把指派给该小队的父项**转交给队长** ⇒ 父项不再是批次根 ⇒ 不是队员。
 *   （无法与「本来就是普通父项」区分，故按非批次处理；理由：批次已终止 ⇒ 没有集成分支可合，
 *   开一棵树只会得到一棵永不合并、也永不被回收的树。）
 * · `parentId` 在、父项却**查不到**（归档 / 删除 / 跨 workspace）⇒ 仍声明 `member`：
 *   这一格**故意**让 `planDispatch` **响亮抛**、把它交给人处置 —— 见 `resolveAgentRunClass`。
 */
export function declaredRunClassFor(input: {
  /** 本项自身的 `parentId`（工作项字段，**不是**查找结果）。 */
  parentId: string | undefined;
  /** 父项事实：查得到就是那条工作项，查不到（或本就没有父项）是 `null`。 */
  parent: WorkItem | null;
}): DeclaredRunClass {
  if (input.parentId === undefined) return "standalone";
  // 有 parentId 却拿不到父项：**故意**声明 member，好让 planDispatch 响亮拒绝（不许按单独安排放行）。
  if (input.parent === null) return "member";
  return isSquadBatchChild(input.parent) ? "member" : "standalone";
}

/**
 * 队长简报（spec §3.3，**三段**）：花名册 + 操作协议 + 8 槽位 `instructions`。
 *
 * `protocol` 是系统生成的机制段（`LEADER_PROTOCOL_TEXT`），**不取自用户可写的 `instructions`**：
 * 两者一个是机制、一个是用户意图，并起来等于把机制交还给用户去写（spec §3.3 末段）。
 * 花名册与指令都做浅拷贝——派发出去的是**此刻的快照**：§3.10 说小队成员变更不影响已派发且
 * 进行中的 run，若这里直接把 `squad.members` 交出去，之后任何就地修改都会连带改掉已派发 run 的简报，
 * 快照语义就没了（而「以派发那一刻的花名册为准」正是队员变更规则的立足点）。
 * 指令**原样带上**，不补缺槽位：缺 `stopCondition` / `maxRounds` 的小队应当在写入时就被
 * `validateSquad`（Task 1）与 `create`/`update`（Task 2）拦住，这里补默认值等于把闸绕过去——
 * 队长会拿到一份没人写过的收手条件，正是 §5.4 要防的「没完没了地派单」。
 */
function buildBriefing(squad: Squad): SquadBriefing {
  return {
    squadId: squad.id,
    leaderAgentId: squad.leaderAgentId,
    roster: squad.members.map((member) => ({ ...member })),
    protocol: LEADER_PROTOCOL_TEXT,
    instructions: { ...squad.instructions },
  };
}
