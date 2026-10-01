import assert from "node:assert/strict";
import test from "node:test";
import { planDispatch } from "../src/workitem/leaderDispatch.js";

/* 队长派发的契约（spec §3.3 指派语义 / §5.1 三路输入一处写入 / §5.7.2 队长不改父项状态）。
   分三层覆盖：
   1. brief 的关键用例（指派三态各自的出口）；
   2. **九格矩阵**（指派三态 × 触发源三态）逐格钉死「这一格发什么」——只核对 brief 点到的那几格
      会漏掉补集方向（前几个任务反复踩的坑）：最易漏的是「rule 列里只通知、没有 run 的那三格
      仍然要带 wake.rule_fired」；
   3. 矩阵之外的维度：squad 缺失/已归档/正常、名册 1 与 12 人、instructions 缺槽位、
      终态工作项、简报快照、入参不被改写。 */

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

test("指派单个 agent：产出普通 run（isLeaderTask=false、无 squadId）", () => {
  const events = planDispatch({
    workItem: wi({ type: "agent", id: "ta_x" }),
    squad: null,
    trigger: "user",
  });
  const run = events.find((e) => e.kind === "run.enqueued");
  assert.ok(run && run.kind === "run.enqueued");
  assert.equal(run.agentId, "ta_x");
  assert.equal(run.isLeaderTask, false);
  assert.equal(run.squadId, undefined);
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
  });
  assert.ok(withRule.some((e) => e.kind === "wake.rule_fired"));
  const withUser = planDispatch({
    workItem: wi({ type: "agent", id: "ta_x" }),
    squad: null,
    trigger: "user",
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
    期望值**逐格写出**而不是从规则推导出来的：推导出来的期望值与实现共享同一个错误假设。 */
const MATRIX: {
  assigneeType: AssigneeType;
  trigger: Trigger;
  run: { agentId: string; isLeaderTask: boolean; squadId?: string } | null;
}[] = [
  // assignee=user：人不排队（无 run 可起），三格都只进 Inbox。
  { assigneeType: "user", trigger: "user", run: null },
  { assigneeType: "user", trigger: "leader", run: null },
  { assigneeType: "user", trigger: "rule", run: null },
  // assignee=agent：三格都起同一形态的普通 run，不因触发源而变队长。
  { assigneeType: "agent", trigger: "user", run: { agentId: "ta_x", isLeaderTask: false } },
  { assigneeType: "agent", trigger: "leader", run: { agentId: "ta_x", isLeaderTask: false } },
  { assigneeType: "agent", trigger: "rule", run: { agentId: "ta_x", isLeaderTask: false } },
  // assignee=squad：三格都解析出队长、带标记与简报——规则触发**不是**例外。
  {
    assigneeType: "squad",
    trigger: "user",
    run: { agentId: "ta_lead", isLeaderTask: true, squadId: "sq_1" },
  },
  {
    assigneeType: "squad",
    trigger: "leader",
    run: { agentId: "ta_lead", isLeaderTask: true, squadId: "sq_1" },
  },
  {
    assigneeType: "squad",
    trigger: "rule",
    run: { agentId: "ta_lead", isLeaderTask: true, squadId: "sq_1" },
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
      const expectedBriefing =
        cell.assigneeType === "squad"
          ? {
              squadId: "sq_1",
              leaderAgentId: "ta_lead",
              roster: [{ agentId: "ta_lead", role: "leader" }, { agentId: "ta_a" }],
              instructions: { stopCondition: "全部 done 即收工", maxRounds: "5" },
            }
          : undefined;
      assert.deepEqual(runs[0], {
        kind: "run.enqueued",
        workItemId: "wi_1",
        agentId: cell.run.agentId,
        isLeaderTask: cell.run.isLeaderTask,
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
   空串会让「所有规则」看起来是同一条规则，而这种接线缺陷一路都不会报错。 */
test("trigger=rule 但 ruleId 缺失或空串：抛错", () => {
  const base = {
    workItem: wi({ type: "agent", id: "ta_x" }),
    squad: null,
    trigger: "rule",
  } as const;
  assert.throws(() => planDispatch({ ...base }), /ruleId/);
  assert.throws(() => planDispatch({ ...base, ruleId: "" }), /ruleId/);
});

// 补集方向：user / leader 触发**不**需要 ruleId，不许误伤（九格矩阵的 user/leader 两列本来就不传 id）。
test("user / leader 触发不需要 ruleId：不抛错", () => {
  for (const trigger of ["user", "leader"] as const) {
    assert.doesNotThrow(() =>
      planDispatch({ workItem: wi({ type: "agent", id: "ta_x" }), squad: null, trigger }),
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
