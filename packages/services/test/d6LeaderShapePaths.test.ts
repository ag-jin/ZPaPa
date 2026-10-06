/* D6 插队轮独立复验（test-verifier）：**四路径同形性**与**旧契约负向半边**。

   D6 的验收事实是「评论通道解析出的队长目标，与『指派给小队』产出**同形**的 leader 类 run」。
   host 里四条路径最终都落到 `planDispatch` 的两个入口：
     · 规则到点（trigger=rule）/ 队长工具 / UI 改派 —— 负责人是 squad ⇒ `case "squad"`；
     · 评论通道（在线入口 / 到期义务重放 / 未收敛补投扫描）—— 三处共用 `runCommentDispatch`
       ⇒ 同一个 comment 变体 ⇒ `leaderOverride`。
   所以同形性在**服务面可穷举**：两条入口给出的 `run.enqueued` 必须逐字段相同，四条触发路径才可能同形。
   本文件把这两处入口与三态判据逐格比对，并钉住 host 真实传入的 `runClass` 声明组合不改变结论。

   期望值取 `DispatchEvent` 契约面字段（`RunClass` 三分、`SquadBriefing` 四段），不读实现中间量。 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Squad } from "@zcode/shared";
import { LEADER_PROTOCOL_TEXT, planDispatch } from "../src/workitem/leaderDispatch.js";

const WS = "d6v-ws";
const WSP = "/tmp/d6v-ws";
const LEAD = "d6v-leader";
const MEMBER = "d6v-member";
const SQUAD = "d6v-squad";

const squad = (over: Partial<Squad> = {}): Squad =>
  ({
    id: SQUAD,
    name: "网关组",
    leaderAgentId: LEAD,
    members: [{ agentId: LEAD, role: "leader" }, { agentId: MEMBER }],
    instructions: { stopCondition: "全部 done 即收工", maxRounds: "5" },
    enabled: true,
    ...over,
  }) as Squad;

/** 负责人类型的三种形态：评论通道的常态格是「负责人不是队长本人」。 */
const workItem = (assignee: { type: "agent" | "user" | "squad"; id: string }, parentId?: string) =>
  ({
    id: "d6v-wi",
    workspaceIdentity: WS,
    workspacePath: WSP,
    title: "D6 复验",
    body: "",
    status: "todo",
    assignee,
    ...(parentId !== undefined ? { parentId } : {}),
    labels: [],
    properties: {},
    position: 0,
  }) as never;

const runOf = (events: ReturnType<typeof planDispatch>) => {
  const run = events.find((event) => event.kind === "run.enqueued");
  assert.ok(run?.kind === "run.enqueued", "本用例期望一条 run.enqueued");
  return run;
};

test("D6 同形性：规则 / 人改派（assignee=squad）与评论队长支（leaderOverride）的 run 事件逐字段相同", () => {
  const byRule = runOf(
    planDispatch({
      workItem: workItem({ type: "squad", id: SQUAD }),
      squad: squad(),
      trigger: "rule",
      ruleId: "rule-1",
    }),
  );
  const byUserAssign = runOf(
    planDispatch({
      workItem: workItem({ type: "squad", id: SQUAD }),
      squad: squad(),
      trigger: "user",
    }),
  );
  /* 评论通道的三种格（负责人都**不是**队长本人）：agent 项 / 人项，都是「评论解析出的队长目标」。 */
  const commentTargets = [
    workItem({ type: "agent", id: MEMBER }),
    workItem({ type: "user", id: "d6v-human" }),
    /* 小队批次的队员子项：host 会声明 runClass="member"（评论触发时它对任何项都声明类别）。 */
    workItem({ type: "agent", id: MEMBER }, "d6v-parent"),
  ];
  for (const item of commentTargets) {
    const byComment = runOf(
      planDispatch({
        workItem: item,
        squad: null,
        trigger: "user",
        leaderOverride: { squad: squad() },
      }),
    );
    assert.deepEqual(
      byComment,
      byRule,
      "评论队长支必须与「指派给小队」逐字段同形（标记/类别/squadId/三段简报）",
    );
    assert.deepEqual(byComment, byUserAssign);
  }

  /* 规则路径的差别只在留痕事件（幂等键的一半），run 事件本身同形 —— 顺序：先成因，后结论。 */
  const ruleEvents = planDispatch({
    workItem: workItem({ type: "squad", id: SQUAD }),
    squad: squad(),
    trigger: "rule",
    ruleId: "rule-1",
  });
  assert.deepEqual(
    ruleEvents.map((event) => event.kind),
    ["wake.rule_fired", "run.enqueued"],
  );
  assert.deepEqual(
    planDispatch({
      workItem: workItem({ type: "squad", id: SQUAD }),
      squad: squad(),
      trigger: "user",
    }).map((event) => event.kind),
    ["run.enqueued"],
    "人发起/评论通道没有规则到点这一档",
  );

  /* 简报是三段式契约（机制段是系统常量，不取自用户可写指令）。 */
  const briefing = byRule.kind === "run.enqueued" ? byRule.briefing : undefined;
  assert.ok(briefing !== undefined, "队长 run 必须带简报");
  assert.equal(briefing.squadId, SQUAD);
  assert.equal(briefing.leaderAgentId, LEAD);
  assert.deepEqual(briefing.roster, [
    { agentId: LEAD, role: "leader" },
    { agentId: MEMBER },
  ]);
  assert.equal(briefing.protocol, LEADER_PROTOCOL_TEXT);
  assert.deepEqual(briefing.instructions, { stopCondition: "全部 done 即收工", maxRounds: "5" });
});

test("D6 同形性：host 真实传入的 runClass 声明（standalone / member）不改变队长支结论", () => {
  /* host 对 `msg.trigger === "comment"` 一律声明类别（`declaredRunClassFor` 的结论）：
     顶层项 ⇒ standalone；小队批次的队员子项 ⇒ member。队长支不消费这个声明（它描述的是**负责人**
     的 run 类别，而这次派发的目标已被替换成队长）——但**真实入参组合必须能跑通**：
     若队长支去校验声明，评论通道就会在这里响亮抛，而真实场景下它抛得毫无道理。 */
  const standaloneDeclared = runOf(
    planDispatch({
      workItem: workItem({ type: "agent", id: MEMBER }),
      squad: null,
      trigger: "user",
      runClass: "standalone",
      leaderOverride: { squad: squad() },
    }),
  );
  assert.equal(standaloneDeclared.runClass, "leader", "类别以队长支为准，不被负责人的声明覆盖");

  const memberDeclared = runOf(
    planDispatch({
      workItem: workItem({ type: "agent", id: MEMBER }, "d6v-parent"),
      squad: null,
      trigger: "user",
      runClass: "member",
      leaderOverride: { squad: squad() },
    }),
  );
  assert.deepEqual(memberDeclared, standaloneDeclared, "两条评论格（顶层/队员子项）产出同一个 leader 事件");
});

test("D6 互斥：同时给 targetOverride 与 leaderOverride ⇒ 响亮抛（不得静默取其一）", () => {
  assert.throws(
    () =>
      planDispatch({
        workItem: workItem({ type: "agent", id: MEMBER }),
        squad: null,
        trigger: "user",
        targetOverride: { type: "agent", id: MEMBER },
        leaderOverride: { squad: squad() },
      }),
    /互斥/,
    "两支同时给 = 目标身份没答出来：静默取其一会让另一条的契约看起来还活着",
  );
});

test("D6 三态同结论：正常 / 归档 / 停用 —— 评论队长支与 assignee=squad 逐字相同", () => {
  const states: Array<[string, Squad]> = [
    ["正常", squad()],
    ["归档", squad({ archivedAt: 7 })],
    ["停用", squad({ enabled: false })],
    ["归档+停用", squad({ archivedAt: 7, enabled: false })],
  ];
  for (const [label, state] of states) {
    const byAssignee = planDispatch({
      workItem: workItem({ type: "squad", id: SQUAD }),
      squad: state,
      trigger: "user",
    });
    const byOverride = planDispatch({
      workItem: workItem({ type: "agent", id: MEMBER }),
      squad: null,
      trigger: "user",
      leaderOverride: { squad: state },
    });
    assert.deepEqual(
      byOverride,
      byAssignee,
      `${label}：两条入口必须给出同一个结论（各写一份判据迟早分叉且不报错）`,
    );
    if (label === "正常") {
      assert.equal(byOverride.find((event) => event.kind === "run.enqueued") !== undefined, true);
    } else {
      const skip = byOverride.find((event) => event.kind === "inbox.notified");
      assert.ok(skip?.kind === "inbox.notified", `${label}：不派发（skip 不是失败）`);
      assert.match(skip.reason, /已归档|已停用/);
    }
  }
  /* 归档先判（更强的终态结论）：两者同时命中时报「已归档」。 */
  const both = planDispatch({
    workItem: workItem({ type: "agent", id: MEMBER }),
    squad: null,
    trigger: "user",
    leaderOverride: { squad: squad({ archivedAt: 7, enabled: false }) },
  });
  const bothSkip = both.find((event) => event.kind === "inbox.notified");
  assert.ok(bothSkip?.kind === "inbox.notified");
  assert.match(bothSkip.reason, /已归档/);
  assert.doesNotMatch(bothSkip.reason, /已停用/);
});

test("D6 旧契约负向半边：targetOverride 单走时事件形状与 D6 之前逐字相同（不带队长标记/简报/squadId）", () => {
  /* 评论 @普通智能体：即使本项被指派给小队、即使小队已归档，也走普通 agent 覆盖 —— 
     被点名的智能体不该以为自己要去派单（简报是「你是队长」的机制段）。 */
  const run = runOf(
    planDispatch({
      workItem: workItem({ type: "squad", id: SQUAD }),
      squad: squad({ archivedAt: 7 }),
      trigger: "user",
      targetOverride: { type: "agent", id: MEMBER },
      runClass: "standalone",
    }),
  );
  assert.deepEqual(
    Object.keys(run).sort(),
    ["agentId", "isLeaderTask", "kind", "runClass", "workItemId"],
    "事件字段集合与修前一致：D6 不得给普通覆盖支加任何字段（有 squadId/briefing 就是形态泄漏）",
  );
  assert.equal(run.agentId, MEMBER);
  assert.equal(run.isLeaderTask, false);
  assert.equal(run.runClass, "standalone", "类别来自调用方声明（不受 D6 影响）");

  /* 声明不合法（member 缺父项证据）时照旧响亮抛：D6 没有放宽既有守卫。 */
  assert.throws(
    () =>
      planDispatch({
        workItem: workItem({ type: "agent", id: MEMBER }),
        squad: null,
        trigger: "user",
        runClass: "member",
        targetOverride: { type: "agent", id: MEMBER },
      }),
    /slug|member|父项|证据/,
    "普通覆盖支的「声明 ↔ 父项证据」对表一字未放宽",
  );
});
