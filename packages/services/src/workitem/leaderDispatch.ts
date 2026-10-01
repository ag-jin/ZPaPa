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
  instructions: Record<string, string>;
};

/** 派发事件：`run.enqueued` 起一次运行；`inbox.notified` 是**跳过**（进 Inbox 等人处理）；
    `wake.rule_fired` 是规则触发的留痕（幂等键 `(workItemId, ruleId, revision, eventKey)` 的一半，§3.9）。 */
export type DispatchEvent =
  | {
      kind: "run.enqueued";
      workItemId: string;
      agentId: string;
      isLeaderTask: boolean;
      squadId?: string;
      briefing?: SquadBriefing;
    }
  | { kind: "inbox.notified"; workItemId: string; reason: string }
  | { kind: "wake.rule_fired"; workItemId: string; ruleId: string };

export function planDispatch(input: {
  workItem: WorkItem;
  squad: Squad | null;
  trigger: "user" | "leader" | "rule";
  /* 规则触发时的规则 id。brief 的 Interfaces 只写了触发源种类、没写 id 的来路，而 `wake.rule_fired`
     事件必须带上它；无 id 时留空串、**不凭空编一个**——真实 id 由调度器接线时给出（spec §3.9
     的幂等键要用它区分不同规则，空串会让两条规则的派发看起来是同一件事）。 */
  ruleId?: string;
}): DispatchEvent[] {
  const { workItem, squad, trigger } = input;
  const events: DispatchEvent[] = [];

  /* 触发源只留痕、不参与解析：痕迹放在结论**之前**，消费方按序读到的是因果顺序
     （先「某条规则到点了」，再「派发结论是什么」）。 */
  if (trigger === "rule") {
    events.push({ kind: "wake.rule_fired", workItemId: workItem.id, ruleId: input.ruleId ?? "" });
  }

  switch (workItem.assignee.type) {
    /* 指派给人：人不排队——没有 run 可起，进 Inbox 等人自己动手。 */
    case "user":
      events.push(notify(workItem.id, "工作项指派给人：不排队起 run，进 Inbox 等人处理"));
      break;

    /* 显式指派单个智能体：起一次普通 run。不挂队长标记、也不夹带花名册简报——
       否则接到简报的普通智能体会以为自己该去派单。 */
    case "agent":
      events.push({
        kind: "run.enqueued",
        workItemId: workItem.id,
        agentId: workItem.assignee.id,
        isLeaderTask: false,
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
      events.push({
        kind: "run.enqueued",
        workItemId: workItem.id,
        agentId: squad.leaderAgentId,
        isLeaderTask: true,
        squadId: squad.id,
        briefing: buildBriefing(squad),
      });
      break;
    }
  }

  /* 没有 default 分支：`assignee.type` 是 P0 的枚举，三条腿已穷尽，TS 能证明走不到第四种。
     前提是入库数据可信——注意 workItemRepo 读库时对 assignee_type 是 `as` 强转、不做运行时校验，
     手改过库的行理论上能带来第四个值，落到这里就会既不跑也不响。这里不加兜底是因为正确修法在读库侧
     （补运行时校验），在派发器里再长一条腿只是把问题挪个地方（AGENTS.md：不不断增加兜底分支）。 */

  return events;
}

function notify(workItemId: string, reason: string): DispatchEvent {
  return { kind: "inbox.notified", workItemId, reason };
}

/**
 * 队长简报（spec §3.3：花名册 + 操作协议 + `instructions`）。
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
    instructions: { ...squad.instructions },
  };
}
