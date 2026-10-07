import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { SQUAD_BREAKER_THRESHOLD } from "@zcode/shared";
import {
  LEADER_PROTOCOL_TEXT,
  declaredRunClassFor,
  planDispatch,
} from "../src/workitem/leaderDispatch.js";

/* 队长派发的契约（spec §3.3 指派语义 / §5.1 三路输入一处写入 / §5.7.2 队长不改父项状态）。
   分三层覆盖：
   1. brief 的关键用例（指派三态各自的出口）；
   2. **九格矩阵**（指派三态 × 触发源三态）逐格钉死「这一格发什么」——只核对 brief 点到的那几格
      会漏掉补集方向（前几个任务反复踩的坑）：最易漏的是「rule 列里只通知、没有 run 的那三格
      仍然要带 wake.rule_fired」；
   3. 矩阵之外的维度：squad 缺失/已归档/正常、名册 1 与 12 人、instructions 缺槽位、
      终态工作项、简报快照、入参不被改写。

   另有一组「类别必须**显式声明**」的契约用例（第 4b 节）：`agent` 指派的类别不再由父项的有无**推断**
   —— 漏传会静默落成「单独安排」、把队员直接放进主工作区（§6.1 隔离被静默取消）；现在类别由调用方
   声明、`parentWorkItem` 做校验，缺一或矛盾一律响亮抛。 */

const wi = (assignee: { type: string; id: string }) =>
  ({
    id: "wi_1",
    workspaceIdentity: "ws",
    workspacePath: "/tmp/ws",
    title: "t",
    body: "",
    status: "todo",
    assignee,
    labels: [],
    properties: {},
    position: 0,
  }) as never;
const squad = {
  id: "sq_1",
  name: "网关组",
  leaderAgentId: "ta_lead",
  members: [{ agentId: "ta_lead", role: "leader" }, { agentId: "ta_a" }],
  instructions: { stopCondition: "全部 done 即收工", maxRounds: "5" },
  enabled: true,
} as never;
/* 规则 id：`trigger === "rule"` 时必须给出（缺了或空串会抛错，见 §4 的两条新契约）。 */
const RULE_ID = "wr_1";

// ---------- 1. brief 的关键用例 ----------

// 指派给小队 → 解析出队长，产出带 isLeaderTask + squadId + 简报的一次运行。
test("指派 squad：产出队长角色 run（带标记与花名册简报）", () => {
  const events = planDispatch({
    workItem: wi({ type: "squad", id: "sq_1" }),
    squad,
    trigger: "user",
  });
  const run = events.find((e) => e.kind === "run.enqueued");
  assert.ok(run && run.kind === "run.enqueued");
  assert.equal(run.agentId, "ta_lead");
  assert.equal(run.isLeaderTask, true);
  assert.equal(run.squadId, "sq_1");
  assert.equal(run.briefing?.roster.length, 2);
  assert.equal(run.briefing?.instructions.stopCondition, "全部 done 即收工");
});

test("指派单个 agent：产出普通 run（isLeaderTask=false、无 squadId、类别=单独安排）", () => {
  const events = planDispatch({
    workItem: wi({ type: "agent", id: "ta_x" }),
    squad: null,
    trigger: "user",
    // 类别的**声明**（必答）：顶层项、没有父项 ⇒ 单独安排。
    runClass: "standalone",
  });
  const run = events.find((e) => e.kind === "run.enqueued");
  assert.ok(run && run.kind === "run.enqueued");
  assert.equal(run.agentId, "ta_x");
  assert.equal(run.isLeaderTask, false);
  assert.equal(run.squadId, undefined);
  // 显式判别字段（复审判词：不得让消费者靠 squadId 的有无去猜）。
  assert.equal(run.runClass, "standalone");
});

/* 队员与单独安排的**唯一**分界（spec §6.1/§6.4）：本项的**父项被指派给小队**（队长用
   `squad.createChildWorkItem` 建的子项就挂在「指派给小队的那条父项」之下）。
   调用方**声明**类别（`runClass`），`parentWorkItem` 只做校验 —— 两者都要给，缺一即抛（第 4b 节）。 */
test("指派 agent 且声明 member + 父项被指派给小队 ⇒ 类别=队员（同样不挂队长标记）", () => {
  const events = planDispatch({
    workItem: { ...wi({ type: "agent", id: "ta_a" }), parentId: "wi_parent" } as never,
    squad: null,
    parentWorkItem: wi({ type: "squad", id: "sq_1" }),
    runClass: "member",
    trigger: "user",
  });
  const run = events.find((e) => e.kind === "run.enqueued");
  assert.ok(run && run.kind === "run.enqueued");
  assert.equal(run.runClass, "member");
  assert.equal(run.isLeaderTask, false, "队员 run 不挂队长标记（挂上会被当成该去派单的队长）");
  assert.equal(run.squadId, undefined, "队员的 squadId 仍不设：类别由 runClass 显式表达");
});

/* 补集方向：父项**不是**小队（例如被指派给某个 agent / 人）⇒ 不是队员，按 §6.1 单独安排。
   这一格里声明是 `standalone`，证据（父项负责人不是小队）**支持**它 —— 声明与证据一致才放行：
   「普通父子层级里的项」不是批次成员（这正是 §6.1「单独安排的智能体」的语义）。 */
test("声明 standalone + 父项不是小队 ⇒ 类别=单独安排（不凭空判成队员）", () => {
  for (const parentType of ["agent", "user"] as const) {
    const events = planDispatch({
      workItem: { ...wi({ type: "agent", id: "ta_a" }), parentId: "wi_parent" } as never,
      squad: null,
      parentWorkItem: wi({ type: parentType, id: parentType === "agent" ? "ta_p" : "u_p" }),
      runClass: "standalone",
      trigger: "user",
    });
    const run = events.find((e) => e.kind === "run.enqueued");
    assert.ok(run && run.kind === "run.enqueued");
    assert.equal(run.runClass, "standalone", `父项=${parentType} 时不得判成队员`);
  }
});

// 契约一致性：`isLeaderTask` 是保留的历史字段，必须与 `runClass` 恒等（`=== "leader"`）——
// 两者一旦漂移，读旧字段的消费者与读新字段的消费者会对同一次派发得出不同结论，且不报错。
test("isLeaderTask 与 runClass 恒等（两个字段不得漂移）", () => {
  const cases = [
    { assignee: { type: "agent", id: "ta_x" }, parent: null, declared: "standalone" as const },
    {
      assignee: { type: "agent", id: "ta_a" },
      parent: wi({ type: "squad", id: "sq_1" }),
      declared: "member" as const,
    },
    { assignee: { type: "squad", id: "sq_1" }, parent: null, declared: undefined },
  ];
  for (const cell of cases) {
    const events = planDispatch({
      workItem: wi(cell.assignee),
      squad,
      parentWorkItem: cell.parent,
      ...(cell.declared !== undefined ? { runClass: cell.declared } : {}),
      trigger: "user",
    });
    const run = events.find((e) => e.kind === "run.enqueued");
    assert.ok(run && run.kind === "run.enqueued");
    assert.equal(run.isLeaderTask, run.runClass === "leader");
  }
});

// 指派给人：不排队，只发 Inbox 通知。
test("指派给人的工作项：只发 inbox 通知，不发 run", () => {
  const events = planDispatch({
    workItem: wi({ type: "user", id: "u1" }),
    squad: null,
    trigger: "user",
  });
  assert.equal(
    events.some((e) => e.kind === "run.enqueued"),
    false,
  );
  assert.ok(events.some((e) => e.kind === "inbox.notified"));
});

// 指派给 squad 但小队已归档：不得发起 run（对应 spec §3.10/第 7 项 skip 语义）。
test("squad 已归档：不发起 run", () => {
  const events = planDispatch({
    workItem: wi({ type: "squad", id: "sq_1" }),
    squad: { ...squad, archivedAt: 1 } as never,
    trigger: "rule",
    ruleId: RULE_ID,
  });
  assert.equal(
    events.some((e) => e.kind === "run.enqueued"),
    false,
  );
});

// 规则触发也要走同一处解析：不得出现「规则路径绕过队长解析」的第二条路。
test("rule 触发 squad：同样产出队长角色 run", () => {
  const events = planDispatch({
    workItem: wi({ type: "squad", id: "sq_1" }),
    squad,
    trigger: "rule",
    ruleId: RULE_ID,
  });
  const run = events.find((e) => e.kind === "run.enqueued");
  assert.ok(run && run.kind === "run.enqueued" && run.isLeaderTask === true);
});

// 触发源只在事件上留痕，不改变解析：规则触发要额外带 wake.rule_fired。
test("rule 触发附加 wake.rule_fired，user 触发不附加", () => {
  const withRule = planDispatch({
    workItem: wi({ type: "agent", id: "ta_x" }),
    squad: null,
    trigger: "rule",
    ruleId: RULE_ID,
    runClass: "standalone",
  });
  assert.ok(withRule.some((e) => e.kind === "wake.rule_fired"));
  const withUser = planDispatch({
    workItem: wi({ type: "agent", id: "ta_x" }),
    squad: null,
    trigger: "user",
    runClass: "standalone",
  });
  assert.equal(
    withUser.some((e) => e.kind === "wake.rule_fired"),
    false,
  );
});

// squad 缺失（已被删除或引用失效）时不得静默当作普通 agent 发起运行。
test("assignee=squad 但 squad 为 null：不发 run，只通知", () => {
  const events = planDispatch({
    workItem: wi({ type: "squad", id: "sq_1" }),
    squad: null,
    trigger: "rule",
    ruleId: RULE_ID,
  });
  assert.equal(
    events.some((e) => e.kind === "run.enqueued"),
    false,
  );
  assert.ok(events.some((e) => e.kind === "inbox.notified"));
});

// ---------- 2. 九格矩阵：指派三态 × 触发源三态 ----------

type AssigneeType = "user" | "agent" | "squad";
type Trigger = "user" | "leader" | "rule";

/** 每格的期望出口。`run: null` 表示「只进 Inbox、不起 run」。
    期望值**逐格写出**而不是从规则推导出来的：推导出来的期望值与实现共享同一个错误假设。
    `declared` 是**调用方给的类别声明**（agent 指派必答；user/squad 指派不需要，故留空）——
    矩阵不传父项，所以 agent 列只能是 `standalone`（没有「在批次里」的证据时声明 member 会响亮抛，
    见第 4b 节的穷举）。 */
const MATRIX: {
  assigneeType: AssigneeType;
  trigger: Trigger;
  declared?: "member" | "standalone";
  run: {
    agentId: string;
    isLeaderTask: boolean;
    runClass: "leader" | "member" | "standalone";
    squadId?: string;
  } | null;
}[] = [
  // assignee=user：人不排队（无 run 可起），三格都只进 Inbox。
  { assigneeType: "user", trigger: "user", run: null },
  { assigneeType: "user", trigger: "leader", run: null },
  { assigneeType: "user", trigger: "rule", run: null },
  // assignee=agent（本矩阵不传父项 ⇒ 没有「在批次里」的证据）：三格都**声明 standalone**、结论也是
  // 单独安排，不因触发源变队长、也不因触发源变队员（类别是运行属性，只由父项证据 + 声明决定）。
  {
    assigneeType: "agent",
    trigger: "user",
    declared: "standalone",
    run: { agentId: "ta_x", isLeaderTask: false, runClass: "standalone" },
  },
  {
    assigneeType: "agent",
    trigger: "leader",
    declared: "standalone",
    run: { agentId: "ta_x", isLeaderTask: false, runClass: "standalone" },
  },
  {
    assigneeType: "agent",
    trigger: "rule",
    declared: "standalone",
    run: { agentId: "ta_x", isLeaderTask: false, runClass: "standalone" },
  },
  // assignee=squad：三格都解析出队长、带标记与简报——规则触发**不是**例外。
  {
    assigneeType: "squad",
    trigger: "user",
    run: { agentId: "ta_lead", isLeaderTask: true, runClass: "leader", squadId: "sq_1" },
  },
  {
    assigneeType: "squad",
    trigger: "leader",
    run: { agentId: "ta_lead", isLeaderTask: true, runClass: "leader", squadId: "sq_1" },
  },
  {
    assigneeType: "squad",
    trigger: "rule",
    run: { agentId: "ta_lead", isLeaderTask: true, runClass: "leader", squadId: "sq_1" },
  },
];

const assigneeOf = (type: AssigneeType) =>
  type === "user"
    ? { type: "user", id: "u1" }
    : type === "agent"
      ? { type: "agent", id: "ta_x" }
      : { type: "squad", id: "sq_1" };

for (const cell of MATRIX) {
  test(`九格矩阵：assignee=${cell.assigneeType} × trigger=${cell.trigger}`, () => {
    const events = planDispatch({
      workItem: wi(assigneeOf(cell.assigneeType)),
      squad,
      trigger: cell.trigger,
      // 类别**声明**（agent 列必答；user/squad 列的类别由负责人类型本身决定，不需要）。
      ...(cell.declared !== undefined ? { runClass: cell.declared } : {}),
      // rule 列必须给出规则 id（缺失或空串会抛错）；user / leader 列不给——它们与规则无关。
      ...(cell.trigger === "rule" ? { ruleId: RULE_ID } : {}),
    });
    const runs = events.filter((e) => e.kind === "run.enqueued");
    const inbox = events.filter((e) => e.kind === "inbox.notified");
    const fired = events.filter((e) => e.kind === "wake.rule_fired");

    // 出口**恰有一个**：要么起 run 要么进 Inbox，既不同时发也都不发。
    assert.equal(runs.length + inbox.length, 1, "每格只能有一个出口");

    if (cell.run) {
      // 整条事件的**完整形状**：多带一个字段（如普通 run 夹带简报）也会在这里失败。
      // 简报是**三段**（spec §3.3）：roster / protocol / instructions。
      // `protocol` 是系统生成的机制段，其内容不随 squad fixture 变（故直接用常量对表）。
      const expectedBriefing =
        cell.assigneeType === "squad"
          ? {
              squadId: "sq_1",
              leaderAgentId: "ta_lead",
              roster: [{ agentId: "ta_lead", role: "leader" }, { agentId: "ta_a" }],
              protocol: LEADER_PROTOCOL_TEXT,
              instructions: { stopCondition: "全部 done 即收工", maxRounds: "5" },
            }
          : undefined;
      assert.deepEqual(runs[0], {
        kind: "run.enqueued",
        workItemId: "wi_1",
        agentId: cell.run.agentId,
        isLeaderTask: cell.run.isLeaderTask,
        // **判别字段逐格写出**（不是从 isLeaderTask 推导）：加它的目的就是让消费者不必去猜类别。
        runClass: cell.run.runClass,
        ...(cell.run.squadId === undefined ? {} : { squadId: cell.run.squadId }),
        ...(expectedBriefing === undefined ? {} : { briefing: expectedBriefing }),
      });
    } else {
      assert.equal(runs.length, 0, "人 / 失效指派不得起 run");
      assert.deepEqual(Object.keys(inbox[0]).sort(), ["kind", "reason", "workItemId"]);
      assert.equal(inbox[0].workItemId, "wi_1");
      assert.ok(inbox[0].reason.length > 0, "skip 必须给出可读原因");
    }

    // 触发源只留痕：rule 列全带、user/leader 列全不带——与指派是哪一态无关。
    assert.equal(fired.length, cell.trigger === "rule" ? 1 : 0);
    if (cell.trigger === "rule") {
      assert.deepEqual(Object.keys(fired[0]).sort(), ["kind", "ruleId", "workItemId"]);
      assert.equal(fired[0].workItemId, "wi_1");
    }
  });
}

// ---------- 3. 矩阵之外的维度 ----------

/* squad 四态 × 触发源三态（矩阵只覆盖了「正常」那一行）。
   缺失 / 已归档 / 已停用都走 skip：**绝不**把 squad.id 当普通 agentId 起一次 run。
   `enabled:false` 与 `archivedAt` 是 spec §3.3 并列的两条状态，必须同等对待（否则停用的小队照旧被派单）。 */
const SQUAD_SITUATIONS = {
  缺失: null,
  已归档: { ...squad, archivedAt: 1 },
  停用: { ...squad, enabled: false },
} as const;
for (const situation of Object.keys(SQUAD_SITUATIONS) as (keyof typeof SQUAD_SITUATIONS)[]) {
  for (const trigger of ["user", "leader", "rule"] as const) {
    test(`squad ${situation} × trigger=${trigger}：只通知，不降级成普通 agent run`, () => {
      const events = planDispatch({
        workItem: wi({ type: "squad", id: "sq_1" }),
        squad: SQUAD_SITUATIONS[situation] as never,
        trigger,
        ...(trigger === "rule" ? { ruleId: RULE_ID } : {}),
      });
      assert.equal(events.filter((e) => e.kind === "run.enqueued").length, 0);
      assert.equal(events.filter((e) => e.kind === "inbox.notified").length, 1);
      assert.equal(
        events.filter((e) => e.kind === "wake.rule_fired").length,
        trigger === "rule" ? 1 : 0,
      );
    });
  }
}

/* 补集方向：`enabled: true` 不得被停用闸误伤（否则整支小队再也派不出单）。
   显式写 `enabled: true`（而非依赖 fixture 默认）才能钉住「闸判的是 `=== false` 而非 falsy」。 */
test("squad enabled:true 正常派发（停用闸不误伤）", () => {
  const events = planDispatch({
    workItem: wi({ type: "squad", id: "sq_1" }),
    squad: { ...squad, enabled: true } as never,
    trigger: "user",
  });
  const run = events.find((e) => e.kind === "run.enqueued");
  assert.ok(run && run.kind === "run.enqueued" && run.isLeaderTask === true);
  assert.equal(events.filter((e) => e.kind === "inbox.notified").length, 0);
});

/* 已归档与已停用的 reason 必须**各说各的**：归档是长期退出、停用是可重开的开关，
   接线方与用户要能分辨该去「取消归档」还是「重新启用」，否则两种状态在界面上长得一样。 */
test("已归档与已停用的 reason 不同，且都点出各自状态", () => {
  const reasonOf = (s: unknown) => {
    const events = planDispatch({
      workItem: wi({ type: "squad", id: "sq_1" }),
      squad: s as never,
      trigger: "user",
    });
    const inbox = events.find((e) => e.kind === "inbox.notified");
    assert.ok(inbox && inbox.kind === "inbox.notified");
    return inbox.reason;
  };
  const archived = reasonOf({ ...squad, archivedAt: 1 });
  const disabled = reasonOf({ ...squad, enabled: false });
  assert.notEqual(archived, disabled);
  assert.ok(archived.includes("归档"), `归档原因应含「归档」：${archived}`);
  assert.ok(disabled.includes("停用"), `停用原因应含「停用」：${disabled}`);
});

// 四种 skip 成因（人 / 小队缺失 / 小队已归档 / 小队已停用）的理由必须各说各的：一句通用的「跳过」让人无法处置。
test("四种 skip 成因的 reason 互不相同且非空", () => {
  const reasons = [
    planDispatch({ workItem: wi({ type: "user", id: "u1" }), squad: null, trigger: "user" }),
    planDispatch({ workItem: wi({ type: "squad", id: "sq_1" }), squad: null, trigger: "user" }),
    planDispatch({
      workItem: wi({ type: "squad", id: "sq_1" }),
      squad: { ...squad, archivedAt: 1 } as never,
      trigger: "user",
    }),
    planDispatch({
      workItem: wi({ type: "squad", id: "sq_1" }),
      squad: { ...squad, enabled: false } as never,
      trigger: "user",
    }),
  ].map((events) => {
    const inbox = events.find((e) => e.kind === "inbox.notified");
    assert.ok(inbox && inbox.kind === "inbox.notified");
    assert.ok(inbox.reason.length > 0);
    return inbox.reason;
  });
  assert.equal(new Set(reasons).size, reasons.length);
});

/* 名册规模：1 人与 12 人都要原样带进简报。spec §3.10 的「单小队并行队员 ≤ 6」是**并发**上限，
   不是名册上限——这里若拿它给简报做截断，第 7 名之后的队员会被静默丢掉。 */
for (const size of [1, 12]) {
  test(`名册 ${size} 人：简报逐人带上，不做截断`, () => {
    const members = Array.from({ length: size }, (_, index) =>
      index === 0 ? { agentId: "ta_lead", role: "leader" } : { agentId: `ta_${index}` },
    );
    const events = planDispatch({
      workItem: wi({ type: "squad", id: "sq_1" }),
      squad: { ...squad, members } as never,
      trigger: "user",
    });
    const run = events.find((e) => e.kind === "run.enqueued");
    assert.ok(run && run.kind === "run.enqueued");
    assert.deepEqual(run.briefing?.roster, members);
  });
}

/* instructions 原样透传：齐全时逐键相符，缺槽位时**不补齐**。
   「缺 stopCondition / maxRounds 的小队不该被派发」这道闸在 Task 1 的 validateSquad 与 Task 2 的
   create/update 上；这里若补默认值，等于把闸绕过去，队长会拿到一份没人写过的收手条件。 */
test("instructions 原样透传：8 槽位齐全时逐键相符，缺槽位时不补", () => {
  const eight = {
    goal: "g",
    breakdown: "b",
    dispatch: "d",
    independence: "i",
    acceptance: "a",
    stopCondition: "s",
    reporting: "r",
    maxRounds: "5",
  };
  const full = planDispatch({
    workItem: wi({ type: "squad", id: "sq_1" }),
    squad: { ...squad, instructions: eight } as never,
    trigger: "user",
  });
  const fullRun = full.find((e) => e.kind === "run.enqueued");
  assert.ok(fullRun && fullRun.kind === "run.enqueued");
  assert.deepEqual(fullRun.briefing?.instructions, eight);

  const thin = { stopCondition: "收工" };
  const partial = planDispatch({
    workItem: wi({ type: "squad", id: "sq_1" }),
    squad: { ...squad, instructions: thin } as never,
    trigger: "user",
  });
  const partialRun = partial.find((e) => e.kind === "run.enqueued");
  assert.ok(partialRun && partialRun.kind === "run.enqueued");
  assert.deepEqual(partialRun.briefing?.instructions, thin);
});

/* 终态（done/cancelled）的工作项**仍会派发**：spec §5.7.2/S7 是「状态不驱动执行」，
   本函数只解析指派、不看状态；「终态不该再派发」的闸属于派发入口（工作项服务），
   不在这里再加一条按状态的过滤。结论写死在测试里，免得下次靠猜。 */
for (const status of ["done", "cancelled"] as const) {
  test(`status=${status} 的工作项仍按指派派发（本函数不看状态）`, () => {
    const events = planDispatch({
      workItem: { ...wi({ type: "squad", id: "sq_1" }), status } as never,
      squad,
      trigger: "user",
    });
    const run = events.find((e) => e.kind === "run.enqueued");
    assert.ok(run && run.kind === "run.enqueued" && run.isLeaderTask === true);
  });
}

// 简报是「派发那一刻的快照」（spec §3.10：队员变更不影响已派发且进行中的 run）。
test("简报是快照：派发后改名册/指令不影响已产出的事件", () => {
  const mutable = {
    id: "sq_1",
    name: "网关组",
    leaderAgentId: "ta_lead",
    members: [{ agentId: "ta_lead", role: "leader" }, { agentId: "ta_a" }],
    instructions: { stopCondition: "全部 done 即收工", maxRounds: "5" } as Record<string, string>,
    enabled: true,
  };
  const events = planDispatch({
    workItem: wi({ type: "squad", id: "sq_1" }),
    squad: mutable as never,
    trigger: "user",
  });
  const run = events.find((e) => e.kind === "run.enqueued");
  assert.ok(run && run.kind === "run.enqueued");

  mutable.members.push({ agentId: "ta_b", role: "late" });
  mutable.instructions.stopCondition = "改了";

  assert.deepEqual(run.briefing?.roster, [
    { agentId: "ta_lead", role: "leader" },
    { agentId: "ta_a" },
  ]);
  assert.equal(run.briefing?.instructions.stopCondition, "全部 done 即收工");
});

/** 深冻结：纯函数若就地写入参，冻结后在严格模式下会**抛错**而不是静默改掉调用方的数据。 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

// 纯产出：同一份（冻结的）入参两次调用得到同一批事件，且调用本身不改写任何入参。
test("纯函数：深冻结入参后仍可派发，两次调用结果一致", () => {
  const frozenItem = deepFreeze(wi({ type: "squad", id: "sq_1" }));
  // 先深拷贝再冻结：直接冻结共享的 squad fixture 会把别的用例也一起冻住，用例之间就有了顺序依赖。
  const frozenSquad = deepFreeze(structuredClone(squad));
  const first = planDispatch({
    workItem: frozenItem,
    squad: frozenSquad,
    trigger: "rule",
    ruleId: RULE_ID,
  });
  const second = planDispatch({
    workItem: frozenItem,
    squad: frozenSquad,
    trigger: "rule",
    ruleId: RULE_ID,
  });
  assert.deepEqual(first, second);
  assert.equal(first.filter((e) => e.kind === "run.enqueued").length, 1);
});

// ---------- 4. 契约违例与接线缺陷：响亮失败，不许静默无动作 ----------

/* `assignee.type` 由 `workItemSchema` 限定为三态，但 `workItemRepo` 读库是 `as` 强转、不做运行时校验，
   手改过库的行能带来第四个值。这种行**不能**既不跑也不响（用户看到的是「指派了但什么都没发生」），
   所以三态 × 三个触发源都抛：未知类型与触发源无关，也不许被规则路径吞掉。
   （rule 触发要同时给出 ruleId，否则先撞上 ruleId 的断言，测不到类型断言。） */
for (const trigger of ["user", "leader", "rule"] as const) {
  test(`未知 assignee.type × trigger=${trigger}：抛错（契约违例的断言）`, () => {
    assert.throws(
      () =>
        planDispatch({
          workItem: wi({ type: "robot", id: "r1" }),
          squad: null,
          trigger,
          ...(trigger === "rule" ? { ruleId: RULE_ID } : {}),
        }),
      /未知的指派类型「robot」/,
    );
  });
}

/* trigger=rule 却不指名规则 → 抛错（不许留空串静默通过）：spec §3.9 的幂等键含 ruleId，
   空串会让「所有规则」看起来是同一条规则，而这种接线缺陷一路都不会报错。
   纯空白也算未填（与本分支 Task 1 的「空白 = 未填」口径一致）：只拒 `""` 会让 `" "` 带着
   「有 id」的假象一路通过，幂等键里就留下一枚空白 id。 */
test("trigger=rule 但 ruleId 缺失、空串或纯空白：抛错", () => {
  const base = {
    workItem: wi({ type: "agent", id: "ta_x" }),
    squad: null,
    trigger: "rule",
  } as const;
  assert.throws(() => planDispatch({ ...base }), /ruleId/);
  assert.throws(() => planDispatch({ ...base, ruleId: "" }), /ruleId/);
  assert.throws(() => planDispatch({ ...base, ruleId: " " }), /ruleId/);
});

// 补集方向：非空白的 ruleId 必须放行（不能把闸收得连合法 id 都拒），且原样带上（不做 trim 改写）。
test("trigger=rule 且 ruleId 为非空白：放行，事件原样带 id", () => {
  const events = planDispatch({
    workItem: wi({ type: "agent", id: "ta_x" }),
    squad: null,
    trigger: "rule",
    ruleId: " wr_1 ",
    runClass: "standalone",
  });
  const fired = events.find((e) => e.kind === "wake.rule_fired");
  assert.ok(fired && fired.kind === "wake.rule_fired");
  assert.equal(fired.ruleId, " wr_1 ");
});

// 补集方向：user / leader 触发**不**需要 ruleId，不许误伤（九格矩阵的 user/leader 两列本来就不传 id）。
test("user / leader 触发不需要 ruleId：不抛错", () => {
  for (const trigger of ["user", "leader"] as const) {
    assert.doesNotThrow(() =>
      planDispatch({
        workItem: wi({ type: "agent", id: "ta_x" }),
        squad: null,
        trigger,
        runClass: "standalone",
      }),
    );
  }
});

/* 两条新断言可能同时命中（rule 触发 + 缺 ruleId + 类型是未知值）：先报**接线缺陷**。
   理由是它当场就能修（调用方补一个 id），而坏数据怎么修还没定；次序写死，免得靠猜。 */
test("ruleId 缺失与未知类型同时命中：先报 ruleId（接线缺陷优先）", () => {
  assert.throws(
    () => planDispatch({ workItem: wi({ type: "robot", id: "r1" }), squad: null, trigger: "rule" }),
    /ruleId/,
  );
});

// ---------- 5. 类别（member / standalone）必须**显式声明**：不许再从「可选字段的有无」推断 ----------

/* 这一节修的是本轮那条**静默**残留：旧判别式写作
   `isSquadBatchChild(input.parentWorkItem) ? "member" : "standalone"`，而 `parentWorkItem` 因 F8 冻结
   签名只能做成**可选** ⇒ 调用方**漏传**时没有「在批次里」的证据 ⇒ 静默落成 `standalone`
   ⇒ **那个队员不开工作树、直接在主工作区改**：spec §6.1 的隔离承诺被**悄悄取消**，全程不报错。
   根因是**拿可选字段的有无当判据** —— 「漏传」与「确实不在批次里」在结果上长得一模一样。
   现在：类别由调用方**声明**（`runClass`），`parentWorkItem` 降级为**校验**；下面逐格给出处置，
   没有一格会「碰巧」落成 standalone（第 5.3 节还把「父项已归档」那一格单列出来）。 */

/** agent 指派的工作项；`parentId` 给了就带上（模拟子项）。 */
const agentItem = (parentId: string | undefined) =>
  ({
    ...wi({ type: "agent", id: "ta_a" }),
    ...(parentId !== undefined ? { parentId } : {}),
  }) as never;
const squadParent = () => wi({ type: "squad", id: "sq_1" });

// 5.1 未声明：类别必答。缺省落 standalone 就是把队员静默降级成「直接改主工作区」。
test("agent 指派未声明 runClass：抛错（缺省不得落成 standalone）", () => {
  assert.throws(
    () => planDispatch({ workItem: agentItem(undefined), squad: null, trigger: "user" }),
    /没有声明 runClass/,
    "缺声明必须响亮 —— 默认成 standalone 就是静默取消工作树隔离",
  );
  // 有父项也不放行：声明是**必答**，与「有没有父项」无关；否则「忘了声明」会被父项悄悄补上（又变成推断）。
  assert.throws(
    () =>
      planDispatch({
        workItem: agentItem("wi_parent"),
        squad: null,
        parentWorkItem: squadParent(),
        trigger: "user",
      }),
    /没有声明 runClass/,
  );
});

// 5.2 声明 member 但缺父项证据（`parentWorkItem` 未给 / 为 null）：响亮抛，**不得**默认成 standalone。
test("声明 member 但缺 parentWorkItem：抛错（不得默认成 standalone）", () => {
  for (const missing of [undefined, null] as const) {
    assert.throws(
      () =>
        planDispatch({
          workItem: agentItem("wi_parent"),
          squad: null,
          parentWorkItem: missing,
          runClass: "member",
          trigger: "user",
        }),
      /没有可用的父项事实/,
      `parentWorkItem=${String(missing)} 时必须响亮，不许静默落 standalone`,
    );
  }
});

// 5.3 **父项已归档那一格**（显式决定：**响亮拒绝**）。
/* `workItemRepo.listByWorkspace` 过滤归档行（`archived_at IS NULL`）⇒ 父项一旦归档，`parentWorkItem`
   就是 `null`（与「父项被删 / 落在别的 workspace」同一形态）。这一格**故意**不选 standalone：
   查不到父项**无法证明它不在批次里**，按 §6.1 单独安排放行 = 把一名可能的队员**静默**放进主工作区；
   也不选 member：没有证据可校验（等于凭空开树）。两条都不能静默选 ⇒ 拒绝，交给人处置
   （宿主按 permanent 收口并留痕，见 host 派发桥）。
   兑现路径：`declaredRunClassFor` 在这一格故意声明 `member` ⇒ `planDispatch` 抛「没有可用的父项事实」。 */
test("父项已归档（parentId 在、父项查不到）：响亮拒绝，不静默按单独安排放行", () => {
  const declared = declaredRunClassFor({ parentId: "wi_archived", parent: null });
  assert.equal(
    declared,
    "member",
    "这一格故意声明 member：好让 planDispatch 响亮拒绝，而不是落 standalone",
  );
  assert.throws(
    () =>
      planDispatch({
        workItem: agentItem("wi_archived"),
        squad: null,
        parentWorkItem: null,
        runClass: declared,
        trigger: "user",
      }),
    /没有可用的父项事实/,
  );
});

// 5.4 声明 member 但父项不是小队：证据与声明**矛盾** ⇒ 抛（静默改判任一方向都会掩盖缺陷）。
test("声明 member 但父项不是小队：抛错（证据与声明矛盾）", () => {
  for (const parentType of ["agent", "user"] as const) {
    assert.throws(
      () =>
        planDispatch({
          workItem: agentItem("wi_parent"),
          squad: null,
          parentWorkItem: wi({ type: parentType, id: "wi_p" }),
          runClass: "member",
          trigger: "user",
        }),
      /声明与事实矛盾/,
      `父项=${parentType} 时不得把 member 静默改判`,
    );
  }
});

// 5.5 声明 standalone 但父项被指派给小队（它其实在批次里）：抛（**选定处置 = 抛**，理由见实现注释：
//     按 standalone 放行会静默丢隔离，按 member 放行是凭空开一棵调用方没要求的树 —— 两条都在掩盖接线缺陷，
//     而改对声明即可自愈，故选择响亮）。
test("声明 standalone 但父项被指派给小队：抛错（它其实在小队批次里）", () => {
  assert.throws(
    () =>
      planDispatch({
        workItem: agentItem("wi_parent"),
        squad: null,
        parentWorkItem: squadParent(),
        runClass: "standalone",
        trigger: "user",
      }),
    /被指派给小队/,
  );
});

// 5.6 放行格：声明与证据一致的两格（既有行为不变）。
test("声明 member + 父项被指派给小队：开树（member，既有行为不变）", () => {
  const events = planDispatch({
    workItem: agentItem("wi_parent"),
    squad: null,
    parentWorkItem: squadParent(),
    runClass: "member",
    trigger: "user",
  });
  const run = events.find((e) => e.kind === "run.enqueued");
  assert.ok(run && run.kind === "run.enqueued");
  assert.equal(run.runClass, "member");
});

test("声明 standalone + 无父项 / 非小队父项：不开树（standalone，既有行为不变）", () => {
  for (const parent of [undefined, null, wi({ type: "agent", id: "ta_p" })] as const) {
    const events = planDispatch({
      workItem: agentItem(parent === undefined ? undefined : "wi_parent"),
      squad: null,
      parentWorkItem: parent,
      runClass: "standalone",
      trigger: "user",
    });
    const run = events.find((e) => e.kind === "run.enqueued");
    assert.ok(run && run.kind === "run.enqueued");
    assert.equal(
      run.runClass,
      "standalone",
      `父项=${parent === null ? "null" : String(parent)} 时仍是单独安排`,
    );
  }
});

// 5.7 声明策略 `declaredRunClassFor` 逐格（调用方该声明哪一类）：唯一实现，host 与测试同形副本都用它。
test("declaredRunClassFor 逐格：声明由「本项 parentId + 父项事实」唯一决定", () => {
  assert.equal(declaredRunClassFor({ parentId: undefined, parent: null }), "standalone", "顶层项");
  assert.equal(
    declaredRunClassFor({ parentId: "wi_parent", parent: squadParent() }),
    "member",
    "父项是小队",
  );
  assert.equal(
    declaredRunClassFor({ parentId: "wi_parent", parent: wi({ type: "agent", id: "ta_p" }) }),
    "standalone",
    "父项在、负责人不是小队（普通父子层级，或批次归档后父项被转交给队长的残局）⇒ 不是批次成员",
  );
  assert.equal(
    declaredRunClassFor({ parentId: "wi_parent", parent: null }),
    "member",
    "有 parentId 却拿不到父项（归档 / 删除 / 跨 workspace）⇒ 故意声明 member，好让 planDispatch 响亮拒绝",
  );
  // 与 planDispatch 的放行一致：声明策略给出的值永远不会被 planDispatch 拒（四条都自洽）。
  for (const input of [
    { parentId: undefined, parent: null },
    { parentId: "wi_parent", parent: squadParent() },
    { parentId: "wi_parent", parent: wi({ type: "agent", id: "ta_p" }) },
  ] as const) {
    assert.doesNotThrow(() =>
      planDispatch({
        workItem: agentItem(input.parentId),
        squad: null,
        parentWorkItem: input.parent,
        runClass: declaredRunClassFor(input),
        trigger: "user",
      }),
    );
  }
});

// 5.8 非 agent 指派：类别由**负责人类型**唯一决定（人 ⇒ 不排队；小队 ⇒ 队长），声明不参与也不改变结论。
//     这条防止有人把声明当成「可以命令一条工作项变成队员」的开关。
test("user / squad 指派的类别由负责人类型决定，runClass 不参与", () => {
  const leader = planDispatch({
    workItem: wi({ type: "squad", id: "sq_1" }),
    squad,
    trigger: "user",
    runClass: "standalone",
  }).find((e) => e.kind === "run.enqueued");
  assert.ok(leader && leader.kind === "run.enqueued");
  assert.equal(leader.runClass, "leader", "声明不得把小队的指派改成 standalone");

  const human = planDispatch({
    workItem: wi({ type: "user", id: "u1" }),
    squad: null,
    trigger: "user",
    runClass: "member",
  });
  assert.equal(
    human.some((e) => e.kind === "run.enqueued"),
    false,
    "声明不得让「指派给人」起 run",
  );
});

/* ---------- 5.9 B-1 裁定（2026-10-06）：显式目标覆盖 targetOverride ----------

   §5.2 明文「`@agent` ≠ 改派」（assignee 保持不变），而 §4.2 要求显式 @ 是一次运行请求 ——
   于是「评论目标 ≠ assignee」是**常态格**。`planDispatch` 的 agent 分支此前只派 assignee
   （规则/队长工具/UI 改派三路共用同一处解析），评论触发接不进来。这里钉覆盖的全部格子：
   派给点名者、不动 assignee（纯函数）、负责人是人/小队时同样成立、类别仍按本项父项事实声明。 */

test("targetOverride：@agent Z 而 assignee=A ⇒ 派给 Z（不是 A），且不挂队长标记/简报", () => {
  const workItem = agentItem(undefined);
  const before = JSON.stringify(workItem);
  const events = planDispatch({
    workItem,
    squad: null,
    trigger: "user",
    runClass: "standalone",
    targetOverride: { type: "agent", id: "ta_mentioned" },
  });
  const run = events.find((e) => e.kind === "run.enqueued");
  assert.ok(run && run.kind === "run.enqueued");
  assert.equal(run.agentId, "ta_mentioned", "派给点名者（B-1：评论目标 ≠ assignee 是常态格）");
  assert.equal(run.isLeaderTask, false);
  assert.equal(run.squadId, undefined);
  assert.equal(run.briefing, undefined, "被点名的普通智能体不得拿到队长简报（会以为自己该去派单）");
  assert.equal(
    JSON.stringify(workItem),
    before,
    "planDispatch 只读不写：入参一字不动（@ ≠ 改派，§5.2）",
  );
});

test("targetOverride：负责人是 user / squad 时同样派给点名者（评论不依赖 assignee）", () => {
  for (const assignee of [
    { type: "user", id: "u_1" },
    { type: "squad", id: "sq_1" },
  ] as const) {
    const events = planDispatch({
      workItem: wi(assignee),
      squad,
      trigger: "user",
      runClass: "standalone",
      targetOverride: { type: "agent", id: "ta_mentioned" },
    });
    const run = events.find((e) => e.kind === "run.enqueued");
    assert.ok(run && run.kind === "run.enqueued", `assignee=${assignee.type} 时覆盖必须仍然起 run`);
    assert.equal(run.agentId, "ta_mentioned");
    assert.equal(
      events.some((e) => e.kind === "inbox.notified"),
      false,
      "覆盖生效时不得再走 assignee 的 skip 分支",
    );
  }
});

test("targetOverride：类别仍须显式声明（漏声明 / 声明与父项事实矛盾一律响亮抛）", () => {
  // 漏声明：与 agent 分支同一条纪律（否则静默落 standalone，队员丢工作树隔离）。
  assert.throws(
    () =>
      planDispatch({
        workItem: agentItem(undefined),
        squad: null,
        trigger: "user",
        targetOverride: { type: "agent", id: "ta_mentioned" },
      }),
    /runClass/,
  );
  // 声明 member 但父项证据是小队之外（覆盖不得把校验短路掉）。
  assert.throws(
    () =>
      planDispatch({
        workItem: agentItem("wi_parent"),
        squad: null,
        parentWorkItem: wi({ type: "agent", id: "ta_p" }),
        runClass: "member",
        trigger: "user",
        targetOverride: { type: "agent", id: "ta_mentioned" },
      }),
    /矛盾/,
  );
});

test("targetOverride：声明 member + 父项是小队 ⇒ 覆盖目标仍按批次成员开树（类别与目标无关）", () => {
  const events = planDispatch({
    workItem: agentItem("wi_parent"),
    squad: null,
    parentWorkItem: squadParent(),
    runClass: "member",
    trigger: "user",
    targetOverride: { type: "agent", id: "ta_mentioned" },
  });
  const run = events.find((e) => e.kind === "run.enqueued");
  assert.ok(run && run.kind === "run.enqueued");
  assert.equal(run.agentId, "ta_mentioned");
  assert.equal(run.runClass, "member", "类别按本项父项事实推导 —— 与派给谁无关（§7.1 方案 A）");
});

test("targetOverride：trigger=rule 时仍先留痕 wake.rule_fired（规则幂等键不因覆盖丢失）", () => {
  const events = planDispatch({
    workItem: agentItem(undefined),
    squad: null,
    trigger: "rule",
    ruleId: RULE_ID,
    runClass: "standalone",
    targetOverride: { type: "agent", id: "ta_mentioned" },
  });
  assert.deepEqual(events[0], { kind: "wake.rule_fired", workItemId: "wi_1", ruleId: RULE_ID });
  assert.equal(events[1]?.kind, "run.enqueued");
});

/* ---------- 5.10 #4 修复（用户 2026-10-06 裁定）：归档 / 停用 agent 的派发 skip ----------

   `D4`（登记不修 → 本轮修）：agent 分支此前**不校验名册状态** —— 一条指派（或评论点名）到一个
   已归档 / 已停用智能体的派发会照样起 run。归档/停用是「这个智能体现在不接新派发」，按
   **skip（非失败）** 处置（对齐 multica errDispatchSkipped 口径）：`inbox.notified` 事件 ⇒ host
   现有 skip 分支落 `dispatch_skipped` Inbox（复用既有 kind，不新造枚举）。
   判据只在调用方**给出了名册事实**时生效：名册缺席（查不到 / 未注入）保持既有 A5 语义（不设限）。 */

test("#4：targetAgent 已归档 ⇒ skip（不是 failed），带可分辨的归档文案", () => {
  const events = planDispatch({
    workItem: agentItem(undefined),
    squad: null,
    trigger: "user",
    runClass: "standalone",
    targetAgent: { id: "ta_a", archivedAt: 1, enabled: true } as never,
  });
  assert.equal(
    events.some((event) => event.kind === "run.enqueued"),
    false,
    "已归档的智能体不得被起 run（归档 = 停止使用）",
  );
  const skip = events.find((event) => event.kind === "inbox.notified");
  assert.ok(skip?.kind === "inbox.notified");
  assert.match(skip.reason, /归档/, "归档文案要能让人知道该去「取消归档」");
});

test("#4：targetAgent 已停用 ⇒ skip 且文案与归档可分辨", () => {
  const events = planDispatch({
    workItem: agentItem(undefined),
    squad: null,
    trigger: "user",
    runClass: "standalone",
    targetAgent: { id: "ta_a", enabled: false } as never,
  });
  assert.equal(
    events.some((event) => event.kind === "run.enqueued"),
    false,
  );
  const skip = events.find((event) => event.kind === "inbox.notified");
  assert.ok(skip?.kind === "inbox.notified");
  assert.match(skip.reason, /停用/, "停用是可随时重开的临时开关：文案不得与归档混用");
  assert.doesNotMatch(skip.reason, /归档/);
});

test("#4：正常 / 名册缺席都照旧派发（缺证据不设限，A5 语义不变）", () => {
  for (const targetAgent of [
    { id: "ta_a", enabled: true },
    { id: "ta_a", enabled: true, archivedAt: undefined },
    null,
    undefined,
  ] as const) {
    const events = planDispatch({
      workItem: agentItem(undefined),
      squad: null,
      trigger: "user",
      runClass: "standalone",
      ...(targetAgent !== undefined ? { targetAgent } : {}),
    });
    assert.equal(
      events.some((event) => event.kind === "run.enqueued"),
      true,
      `targetAgent=${JSON.stringify(targetAgent)} 时不得被拦（缺名册证据 ≠ 不可派发）`,
    );
  }
});

test("#4：targetOverride 目标已归档 / 已停用 ⇒ 同样 skip（评论点名者与 assignee 同一条判据）", () => {
  for (const [agent, pattern] of [
    [{ id: "ta_mentioned", archivedAt: 5, enabled: true }, /归档/],
    [{ id: "ta_mentioned", enabled: false }, /停用/],
  ] as const) {
    const events = planDispatch({
      workItem: agentItem(undefined),
      squad: null,
      trigger: "user",
      runClass: "standalone",
      targetOverride: { type: "agent", id: "ta_mentioned" },
      targetAgent: agent as never,
    });
    assert.equal(
      events.some((event) => event.kind === "run.enqueued"),
      false,
    );
    const skip = events.find((event) => event.kind === "inbox.notified");
    assert.ok(skip?.kind === "inbox.notified");
    assert.match(skip.reason, pattern);
  }
});

// ---------- 6. W3 熔断 skip（§3.6 的消费点：派发规划） ----------

/* 熔断命中 ⇒ 四条 `run.enqueued` 出口**逐格**都不产出 run。为什么必须穷举：`planDispatch` 有四条
   产出 run 的腿（assignee=agent / targetOverride / leaderOverride / assignee=squad），而**队长那两条
   的目标不经过 `targetAgent` 入参**（`:307-310` 只传 squad）——按「哪里加了归档 skip 就跟着加」的
   直觉补，会正好漏掉队长两支，于是「熔断」对一半派发入口形同虚设，且不报错。

   反方向同样断言（计数 < 阈值 ⇒ 四条腿照常产出 run）：只断言「熔断 ⇒ 无 run」的用例会被一个
   「永远 skip」的实现骗过，那不是熔断而是把派发整个关掉。 */
const breakerCounts = (agentId: string, count: number) => [{ agentId, count }];

test("W3 熔断 skip：窗口计数 ≥ 阈值 ⇒ 四条 run.enqueued 出口逐格产出 skip（穷举矩阵）", () => {
  const exits: Array<{
    name: string;
    trippedAgentId: string;
    dispatch: (
      counts: Array<{ agentId: string; count: number }>,
    ) => ReturnType<typeof planDispatch>;
  }> = [
    {
      name: "① assignee=agent",
      trippedAgentId: "ta_a",
      dispatch: (agentBreakerCounts) =>
        planDispatch({
          workItem: agentItem(undefined),
          squad: null,
          trigger: "user",
          runClass: "standalone",
          agentBreakerCounts,
        }),
    },
    {
      name: "② targetOverride（评论点名者）",
      trippedAgentId: "ta_mentioned",
      dispatch: (agentBreakerCounts) =>
        planDispatch({
          workItem: wi({ type: "user", id: "u_1" }),
          squad: null,
          trigger: "user",
          runClass: "standalone",
          targetOverride: { type: "agent", id: "ta_mentioned" },
          agentBreakerCounts,
        }),
    },
    {
      name: "③ leaderOverride（评论点名队长）",
      trippedAgentId: "ta_lead",
      dispatch: (agentBreakerCounts) =>
        planDispatch({
          workItem: wi({ type: "user", id: "u_1" }),
          squad: null,
          trigger: "user",
          leaderOverride: { squad },
          agentBreakerCounts,
        }),
    },
    {
      name: "④ assignee=squad（指派给小队 ⇒ 队长）",
      trippedAgentId: "ta_lead",
      dispatch: (agentBreakerCounts) =>
        planDispatch({
          workItem: wi({ type: "squad", id: "sq_1" }),
          squad,
          trigger: "user",
          agentBreakerCounts,
        }),
    },
  ];

  for (const exit of exits) {
    // 命中：窗口内计数 = 阈值 ⇒ 不算「这次」，但已经不接新派发。
    const tripped = exit.dispatch(breakerCounts(exit.trippedAgentId, SQUAD_BREAKER_THRESHOLD));
    assert.equal(
      tripped.some((event) => event.kind === "run.enqueued"),
      false,
      `${exit.name}：熔断命中 ⇒ 不得产出 run.enqueued（漏这一支 = 熔断形同虚设）`,
    );
    const skip = tripped.find((event) => event.kind === "inbox.notified");
    assert.ok(skip?.kind === "inbox.notified", `${exit.name}：skip 必须留痕（inbox.notified）`);
    assert.match(skip.reason, /熔断/, `${exit.name}：skip 文案必须点名熔断（人要知道为什么没派）`);

    // 边界反证：差一次（阈值 − 1）⇒ 照常产出 run。
    const below = exit.dispatch(breakerCounts(exit.trippedAgentId, SQUAD_BREAKER_THRESHOLD - 1));
    assert.equal(
      below.some((event) => event.kind === "run.enqueued"),
      true,
      `${exit.name}：计数 < 阈值 ⇒ 必须照常派发（否则「熔断」变成了把派发整个关掉）`,
    );

    // 别的 agent 熔断 ⇒ 本出口不受影响（熔断按**目标** agent 判，不是「有谁熔断就全停」）。
    const otherTripped = exit.dispatch(breakerCounts("ta_someone_else", SQUAD_BREAKER_THRESHOLD));
    assert.equal(
      otherTripped.some((event) => event.kind === "run.enqueued"),
      true,
      `${exit.name}：别的 agent 熔断不得拦下本出口`,
    );
  }
});

test("守卫｜熔断判据不引入 I/O：planDispatch 只吃注入的计数（事实全注入的纯函数纪律）", () => {
  const source = readFileSync(
    join(import.meta.dirname, "..", "src", "workitem", "leaderDispatch.ts"),
    "utf8",
  );
  // 判据本体只在 squadWatchdog 一处（本模块只把每个出口的目标 agent 喂进去）。
  assert.ok(
    source.includes('from "./squadWatchdog.js"'),
    "熔断判据必须来自单源（第二份「几次算熔断」= 改阈值漏一处）",
  );
  for (const forbidden of ["createSquadRunRepo", "DatabaseSync", "readFileSync", "await "])
    assert.ok(
      !source.includes(forbidden),
      `planDispatch 是纯函数：不得出现「${forbidden}」（计数必须由调用方注入，本层不查库）`,
    );
  assert.ok(source.includes("agentBreakerCounts"), "熔断事实必须经入参注入（不是模块级缓存）");
});
