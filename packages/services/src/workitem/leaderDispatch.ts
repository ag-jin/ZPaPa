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
 */
export type RunClass = "leader" | "member" | "standalone";

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
   * **派发时的事实**（加法，spec §6.1/§6.2）：本工作项的**父项**。用来判「这是不是一支小队批次里的
   * 队员任务」——队长用 `squad.createChildWorkItem` 建出的子项**总是挂在「指派给小队的那条父项」之下**
   * （工具的 modelInstructions 明文要求「Always pass the parent work item id you were given」）。
   *
   * 为什么判别必须来自这个事实、而不是触发来源：§5.5 让「队长派单」与「人手动触发」走**同一条**
   * 派发路径（`trigger: "user"`）⇒ 来源分不出「队员」与「单独安排」；而「本项在不在小队批次里」是
   * **工作项自身的事实**，与谁触发无关（规则触发一条队员子项时它仍是队员 ⇒ 必须开树）。
   *
   * 省略 / `null`（没给 / 本来就没有父项）= **没有「在批次里」的证据** ⇒ 判 `standalone`
   * （方向性理由见 `isSquadBatchChild`）。既有调用方不传时编译与行为都不变（**加法**）。
   */
  parentWorkItem?: WorkItem | null;
  trigger: "user" | "leader" | "rule";
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

  /* 原始值另存一份，只为下面 default 的错误信息：进了 switch 之后 `assignee.type` 会被收窄成
     `never`（三条腿已穷尽），在 default 里再读它就取不到原值了。 */
  const rawType: string = workItem.assignee.type;

  switch (workItem.assignee.type) {
    /* 指派给人：人不排队——没有 run 可起，进 Inbox 等人自己动手。 */
    case "user":
      events.push(notify(workItem.id, "工作项指派给人：不排队起 run，进 Inbox 等人处理"));
      break;

    /* 显式指派单个智能体（spec §5.6 `@` ≠ 指派）。这里要分**两类**，判别来自**派发时的事实**
       （spec §6.2：是否开工作树是**本次运行**的属性），不能事后猜：
        · 本项**在小队批次里**（父项被指派给小队 ⇒ 它是队长派给队员的子任务）⇒ `member`：
          开独立工作树 + 独立分支（§6.4），产出活到合并（§6.2）；
        · 否则是**单独安排的智能体** ⇒ `standalone`：**直接在工作区改**，没有工作树 / 合并那一步（§6.1）。
       两类都**不挂队长标记、不夹带花名册简报** —— 否则接到简报的普通智能体会以为自己该去派单。 */
    case "agent":
      events.push({
        kind: "run.enqueued",
        workItemId: workItem.id,
        agentId: workItem.assignee.id,
        isLeaderTask: false,
        runClass: isSquadBatchChild(input.parentWorkItem) ? "member" : "standalone",
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
 * 本工作项是不是**一支小队批次里的队员任务**（`runClass` 取 `member` 的**唯一**判据）：
 * 父项被指派给小队。
 *
 * 为什么是「父项负责人」而不是别的：队长派活的方式是 `squad.createChildWorkItem`（挂一条**子项**在
 * 指派给小队的那条父项之下，再 `squad.assignWorkItem` 指给某位队员），所以「队员的任务」= 一条
 * `parentId` 指向**小队项**的工作项。这条判据只读**派发那一刻的工作项事实**（§6.2：开不开工作树是
 * 「本次运行」的属性），与触发来源、与队员是谁都无关 —— 换个触发源（规则 / 人 / 队长）不会改变结论。
 *
 * 方向性（为什么「查不到父项」判 `false` 而不是 `true`）：判 `false` 的后果是「按 §6.1 单独安排放行：
 * 会话照发、只是不开树」，最坏是少一层隔离；判 `true` 的后果是**凭空开一棵没人会合并、也没人会回收的
 * 树**（这正是本次要修的缺陷：孤立分支 + 工作树永久堆积，且不报错）。两者都错时，前者可恢复、后者不可。
 */
function isSquadBatchChild(parent: WorkItem | null | undefined): boolean {
  return parent != null && parent.assignee.type === "squad";
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
