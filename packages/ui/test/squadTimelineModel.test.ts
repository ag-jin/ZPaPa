import assert from "node:assert/strict";
import test from "node:test";
import type { SquadRunRecord, SquadRunStatus } from "@zcode/services";
import type { TeamAgent } from "@zcode/shared";
import { resolveSubagentColorFromName } from "../src/lib/subagentColors.js";
import {
  buildSquadTimelineModel,
  type TimelineArc,
  type TimelineLane,
} from "../src/squad/squadTimelineModel.js";

/* 「活动时间线」（规格 §11.2）**纯布局模型**的用例（ui 包没有渲染测试设施，
   判据全部留在纯函数上、由 node:test 逐格钉住 —— 本项目的既定做法）。

   覆盖：空输入 / 单队长站 / 队长+两队员（两条弧） / 队员先于队长（无弧） / 同批无队长（零弧）
   / 跨批不画弧 / 两条队长 run（归最近先前） / 开放与终态站 / 名册缺失（不丢行） /
   lane 顺序（队长最上、最早站、同刻 tie-break） / 确定性（同输入两次逐字一致） /
   弧的四格（A 事实 recorded 命中目标站 / B 非队长派发无弧 ×2 成因 / C 三种回落 inferred）
   / 同 runId 重复（只画一次）。
   每条都写明变异方式（改哪一行会红），变异已在交付报告里逐条实测。 */

const run = (over: Partial<SquadRunRecord> = {}): SquadRunRecord => ({
  runId: "run-1",
  workspaceKey: "ws",
  workspacePath: "/tmp/ws",
  workItemId: "wi-child-1",
  parentWorkItemId: "wi-batch-1",
  agentId: "ta-member",
  isLeaderTask: false,
  branch: "squad/member/aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbb",
  dirName: null,
  status: "open",
  sessionId: null,
  // 0008 两列（派发成因 / 入边）：本文件只做布局，缺省 = NULL（遗留行语义）—— 行必须逐字段成型。
  dispatchCause: null,
  causedByRunId: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const agent = (over: Partial<TeamAgent> = {}): TeamAgent => ({
  id: "ta-leader",
  name: "队长",
  systemPrompt: "",
  skills: [],
  memoryScope: "project",
  enabled: true,
  ...over,
});

const laneById = (lanes: TimelineLane[], laneId: string): TimelineLane => {
  const lane = lanes.find((candidate) => candidate.laneId === laneId);
  assert.ok(lane, `lane「${laneId}」应在模型里`);
  return lane;
};

// ---------- 空输入 ----------

test("空输入 ⇒ 空 lanes / 空 arcs / 非 NaN 的空域（选定 {startAt:0,endAt:0}）", () => {
  const model = buildSquadTimelineModel({ runs: [], teamAgents: [] });
  assert.deepEqual(model, { lanes: [], arcs: [], domain: { startAt: 0, endAt: 0 } });
  assert.ok(
    Number.isFinite(model.domain.startAt) && Number.isFinite(model.domain.endAt),
    "0/0 而不是 NaN：NaN 会静默产出空几何与非法 style，且缩放计算处处要加空分支",
  );
});

// ---------- 单队长站 ----------

test("单队长站（merged）：一条 lane、一个闭合站、branchLabel=null、domain=站的起止", () => {
  const model = buildSquadTimelineModel({
    runs: [
      run({
        runId: "run-leader",
        agentId: "ta-leader",
        isLeaderTask: true,
        branch: null,
        status: "merged",
        createdAt: 10,
        updatedAt: 42,
      }),
    ],
    teamAgents: [agent()],
  });

  assert.deepEqual(
    model.lanes.map((lane) => lane.laneId),
    ["ta-leader"],
  );
  const lane = model.lanes[0]!;
  assert.equal(lane.isLeaderLane, true, "有队长站的 lane");
  assert.equal(lane.label, "队长", "名字查 teamAgents");
  assert.deepEqual(lane.stations, [
    {
      runId: "run-leader",
      startAt: 10,
      endAt: 42,
      open: false,
      status: "merged",
      isLeaderTask: true,
      branchLabel: null,
      workItemId: "wi-child-1",
      sessionId: null,
    },
  ]);
  assert.deepEqual(model.arcs, [], "队长站自己是弧的起点，不是终点 —— 不给自己编一条弧");
  assert.deepEqual(model.domain, { startAt: 10, endAt: 42 });
});

// ---------- 弧（推断） ----------

test("队长 + 两队员（同批、都在队长之后）⇒ 两条弧，都指向队长 run", () => {
  const model = buildSquadTimelineModel({
    runs: [
      run({
        runId: "run-leader",
        agentId: "ta-leader",
        isLeaderTask: true,
        branch: null,
        status: "merged",
        createdAt: 5,
        updatedAt: 6,
      }),
      run({ runId: "run-m1", agentId: "ta-m1", createdAt: 10 }),
      run({ runId: "run-m2", agentId: "ta-m2", createdAt: 20 }),
    ],
    teamAgents: [agent(), agent({ id: "ta-m1", name: "甲" }), agent({ id: "ta-m2", name: "乙" })],
  });

  assert.deepEqual(model.arcs, [
    { fromRunId: "run-leader", toRunId: "run-m1", kind: "leader_dispatch_inferred" },
    { fromRunId: "run-leader", toRunId: "run-m2", kind: "leader_dispatch_inferred" },
  ]);
  assert.equal(
    laneById(model.lanes, "ta-m1").stations[0]!.branchLabel,
    run().branch,
    "队员站的分支名是事实字段",
  );
});

test("队员 run 早于同批队长 ⇒ 无弧（推断不出来就说不知道）", () => {
  const model = buildSquadTimelineModel({
    runs: [
      run({ runId: "run-m1", agentId: "ta-m1", createdAt: 1 }),
      run({
        runId: "run-leader",
        agentId: "ta-leader",
        isLeaderTask: true,
        branch: null,
        createdAt: 5,
        updatedAt: 6,
        status: "merged",
      }),
    ],
    teamAgents: [agent(), agent({ id: "ta-m1", name: "甲" })],
  });
  assert.deepEqual(model.arcs, [], "手工在队长 run 之前起的队员 run：台账里没有能解释它的队长站");
});

// ⚠️ 弧的判据必须看 isLeaderTask：拿「任何更早的站」当队长，这条用例立刻红
// （同批没有任何队长站时，更早的队员站会被凑成一条假边）。
test("同批两名队员、无队长 ⇒ 零弧（不许拿更早的队员站凑一条假边）", () => {
  const model = buildSquadTimelineModel({
    runs: [
      run({ runId: "run-m1", agentId: "ta-m1", createdAt: 1 }),
      run({ runId: "run-m2", agentId: "ta-m2", createdAt: 2 }),
    ],
    teamAgents: [],
  });
  assert.deepEqual(model.arcs, []);
});

test("弧只在同批内推断：另一批的队长站不画本批队员的弧", () => {
  const model = buildSquadTimelineModel({
    runs: [
      run({
        runId: "run-leader-other",
        agentId: "ta-leader",
        isLeaderTask: true,
        branch: null,
        parentWorkItemId: "wi-batch-OTHER",
        createdAt: 1,
        updatedAt: 2,
        status: "merged",
      }),
      run({ runId: "run-m1", agentId: "ta-m1", parentWorkItemId: "wi-batch-1", createdAt: 5 }),
    ],
    teamAgents: [agent()],
  });
  assert.deepEqual(model.arcs, []);
});

test("两条队长 run 时间交叠 ⇒ 弧归**最近先前**的那条（不是任意一条）", () => {
  const model = buildSquadTimelineModel({
    runs: [
      run({
        runId: "run-leader-1",
        agentId: "ta-leader",
        isLeaderTask: true,
        branch: null,
        status: "merged",
        createdAt: 10,
        updatedAt: 11,
      }),
      run({ runId: "run-m1", agentId: "ta-m1", createdAt: 20 }),
      run({
        runId: "run-leader-2",
        agentId: "ta-leader",
        isLeaderTask: true,
        branch: null,
        status: "merged",
        createdAt: 30,
        updatedAt: 31,
      }),
      run({ runId: "run-m2", agentId: "ta-m2", createdAt: 40 }),
    ],
    teamAgents: [agent()],
  });

  assert.deepEqual(model.arcs, [
    { fromRunId: "run-leader-1", toRunId: "run-m1", kind: "leader_dispatch_inferred" },
    { fromRunId: "run-leader-2", toRunId: "run-m2", kind: "leader_dispatch_inferred" },
  ]);
});

test("弧的成色是字面量联合：本模型（NULL 遗留行）只出 inferred；类型层并列 recorded / inferred", () => {
  const model = buildSquadTimelineModel({
    runs: [
      run({
        runId: "run-leader",
        agentId: "ta-leader",
        isLeaderTask: true,
        branch: null,
        createdAt: 5,
        updatedAt: 6,
        status: "merged",
      }),
      run({ runId: "run-m1", agentId: "ta-m1", createdAt: 10 }),
    ],
    teamAgents: [agent()],
  });
  assert.equal(model.arcs.length, 1);
  for (const arc of model.arcs) {
    assert.equal(
      arc.kind,
      "leader_dispatch_inferred",
      "NULL 遗留行的台账里没有派发边：渲染层必须以「推断」呈现（虚线）",
    );
  }
  // 类型层面并列两个字面量（Record 强制穷尽：将来加/删成色这里编译失败，消费点全被拖出来）：
  // recorded = 台账事实（0008 两列）、inferred = 回落推断。
  const kinds: Record<TimelineArc["kind"], true> = {
    leader_dispatch_recorded: true,
    leader_dispatch_inferred: true,
  };
  assert.deepEqual(Object.keys(kinds).sort(), [
    "leader_dispatch_inferred",
    "leader_dispatch_recorded",
  ]);
});

// ---------- 弧的四格（A 事实 / B 不画 / C 回落） ----------

/* A 格（事实）：leader_tool + causedByRunId 命中队长站 ⇒ recorded，目标 = **被引用的**那条站。
   关键反例钉法：故意让时间上**更近**的队长站在场（leader-2, 30），台账却记着是 leader-1（5）
   派的 —— A 格若偷用「最近先前」启发，起点会变成 leader-2，本用例必红；
   kind 若回落成 inferred，第一条 deepEqual 也必红。 */
test("A 格：leader_tool 且入边命中队长站 ⇒ recorded 弧，目标 = 被引用的站（不是最近先前）", () => {
  const model = buildSquadTimelineModel({
    runs: [
      run({
        runId: "run-leader-1",
        agentId: "ta-leader",
        isLeaderTask: true,
        branch: null,
        status: "merged",
        createdAt: 5,
        updatedAt: 6,
      }),
      run({
        runId: "run-leader-2",
        agentId: "ta-leader",
        isLeaderTask: true,
        branch: null,
        status: "merged",
        createdAt: 30,
        updatedAt: 31,
      }),
      run({
        runId: "run-m1",
        agentId: "ta-m1",
        createdAt: 40,
        dispatchCause: "leader_tool",
        causedByRunId: "run-leader-1",
      }),
    ],
    teamAgents: [agent(), agent({ id: "ta-m1", name: "甲" })],
  });

  assert.deepEqual(model.arcs, [
    { fromRunId: "run-leader-1", toRunId: "run-m1", kind: "leader_dispatch_recorded" },
  ]);
});

/* B 格（事实）：user_reassign / rule ⇒ **不画弧** —— 即便画推断弧的条件全部在场
   （同批有更早的队长站，时间启发本会画一条）。
   变异（V1）：删掉 B 格判据（让两种成因也走回落推断）⇒ 本用例必红。 */
test("B 格：user_reassign / rule 的队员站没有入边（台账说了不是队长派的，画弧就是在编）", () => {
  for (const cause of ["user_reassign", "rule"] as const) {
    const model = buildSquadTimelineModel({
      runs: [
        run({
          runId: "run-leader",
          agentId: "ta-leader",
          isLeaderTask: true,
          branch: null,
          status: "merged",
          createdAt: 5,
          updatedAt: 6,
        }),
        run({ runId: "run-m1", agentId: "ta-m1", createdAt: 10, dispatchCause: cause }),
      ],
      teamAgents: [agent(), agent({ id: "ta-m1", name: "甲" })],
    });
    assert.deepEqual(model.arcs, [], `cause=${cause}：不画弧`);
  }
});

/* C 格（回落推断）：三种格都必须落到 inferred（渲染层的虚线语义），不许抛、不许画到不存在的目标：
   ① NULL（0008 之前的遗留行）；② leader_tool 但入边缺失；③ 入边指向的 run 不在站点集里（坏输入）。
   变异（V3）：删掉回落（NULL 行不再画弧）⇒ 本用例第 ① 格必红。 */
test("C 格：NULL / leader_tool 缺入边 / 入边查不到站 ⇒ 都是 inferred（最近先前队长站）", () => {
  const cases: Array<{ name: string; over: Partial<SquadRunRecord> }> = [
    { name: "NULL（遗留行）", over: {} },
    {
      name: "leader_tool 但入边缺失",
      over: { dispatchCause: "leader_tool", causedByRunId: null },
    },
    {
      name: "leader_tool 但入边查不到站",
      over: { dispatchCause: "leader_tool", causedByRunId: "run-ghost" },
    },
  ];
  for (const { name, over } of cases) {
    const model = buildSquadTimelineModel({
      runs: [
        run({
          runId: "run-leader",
          agentId: "ta-leader",
          isLeaderTask: true,
          branch: null,
          status: "merged",
          createdAt: 5,
          updatedAt: 6,
        }),
        run({ runId: "run-m1", agentId: "ta-m1", createdAt: 10, ...over }),
      ],
      teamAgents: [agent(), agent({ id: "ta-m1", name: "甲" })],
    });
    assert.deepEqual(
      model.arcs,
      [{ fromRunId: "run-leader", toRunId: "run-m1", kind: "leader_dispatch_inferred" }],
      `${name}：回落到「最近先前队长站」的推断弧（虚线段位）`,
    );
  }
});

/* C 格的防御边界：入边指向的站**存在但不是队长站**（坏数据）⇒ 不算事实，回落推断；
   绝不从队员站画一条「队长派发」的实线，也不抛（resolveMemberEdge 的 if 取「定位到队长站」）。 */
test("C 格（防御）：入边指向站点集里的非队长站 ⇒ 回落推断，不产出「事实」弧", () => {
  const model = buildSquadTimelineModel({
    runs: [
      run({
        runId: "run-leader",
        agentId: "ta-leader",
        isLeaderTask: true,
        branch: null,
        status: "merged",
        createdAt: 5,
        updatedAt: 6,
      }),
      // 更早的队员站 run-m0：被 m1 的入边错误引用（它是站，但不是队长站）。
      run({ runId: "run-m0", agentId: "ta-m0", createdAt: 8 }),
      run({
        runId: "run-m1",
        agentId: "ta-m1",
        createdAt: 10,
        dispatchCause: "leader_tool",
        causedByRunId: "run-m0",
      }),
    ],
    teamAgents: [agent(), agent({ id: "ta-m0", name: "零" }), agent({ id: "ta-m1", name: "甲" })],
  });

  assert.deepEqual(
    model.arcs.find((arc) => arc.toRunId === "run-m1"),
    { fromRunId: "run-leader", toRunId: "run-m1", kind: "leader_dispatch_inferred" },
    "入边没定位到队长站 ⇒ 回落推断（最近先前队长站），不是被引用的那条队员站",
  );
  assert.ok(
    !model.arcs.some((arc) => arc.kind === "leader_dispatch_recorded"),
    "坏数据不得产出「事实」弧（不许把实线画到违例目标上）",
  );
});

// ---------- 开放 / 闭合 ----------

// 五态逐格（`Record<SquadRunStatus, boolean>` 强制穷尽：将来加状态时这里编译失败）。
const EXPECTED_OPEN: Record<SquadRunStatus, boolean> = {
  open: true,
  produced: true,
  rejected: true,
  merged: false,
  discarded: false,
};

test("开放/闭合逐态：活跃站 open=true / endAt=null；终态站 open=false / endAt=updatedAt", () => {
  for (const [status, expectedOpen] of Object.entries(EXPECTED_OPEN) as Array<
    [SquadRunStatus, boolean]
  >) {
    const model = buildSquadTimelineModel({
      runs: [run({ runId: `run-${status}`, status, createdAt: 10, updatedAt: 99 })],
      teamAgents: [],
    });
    const station = model.lanes[0]!.stations[0]!;
    assert.equal(station.open, expectedOpen, `status=${status} 的开放判据`);
    if (expectedOpen) {
      assert.equal(station.endAt, null, `status=${status}：活跃站不得取 updatedAt 当终点`);
    } else {
      assert.equal(station.endAt, 99, `status=${status}：终态站的 endAt = updatedAt`);
    }
  }
});

// 这条单独钉 domain 与「活跃站按 startAt 计」的关系：活跃站若错误地取 updatedAt，
// endAt 会变成 99（≠ 55）而红 —— 模型必须纯：「现在」由渲染层给，不由 updatedAt 代劳。
test("domain 的右端：活跃站按 startAt 计（不引入 now、不拿 updatedAt 顶替）", () => {
  const model = buildSquadTimelineModel({
    runs: [
      run({ runId: "run-active", status: "produced", createdAt: 10, updatedAt: 99 }),
      run({ runId: "run-done", status: "discarded", createdAt: 20, updatedAt: 55 }),
    ],
    teamAgents: [],
  });
  assert.deepEqual(model.domain, { startAt: 10, endAt: 55 });
});

// ---------- 名册缺失（不丢行） ----------

test("agent 定义不在名册 ⇒ lane 仍在：label 回落 id、色按名字稳定取（历史 run 不因定义被删而消失）", () => {
  const missing = buildSquadTimelineModel({
    runs: [run({ runId: "run-gone", agentId: "ta-gone", createdAt: 1 })],
    teamAgents: [],
  });
  const lane = missing.lanes[0]!;
  assert.equal(lane.label, "ta-gone", "查不到就原样显示 id（显示空会更糟）");
  assert.equal(lane.color, resolveSubagentColorFromName("ta-gone"), "色按 label 稳定取");
  assert.equal(
    buildSquadTimelineModel({
      runs: [run({ runId: "run-gone", agentId: "ta-gone", createdAt: 1 })],
      teamAgents: [],
    }).lanes[0]!.color,
    lane.color,
    "同输入两次取色一致（稳定）",
  );

  // 定义在册但**没设色** ⇒ 同样按名字取（agent.color ?? resolveSubagentColorFromName）
  const namelessColor = buildSquadTimelineModel({
    runs: [run({ runId: "run-nc", agentId: "ta-nc", createdAt: 1 })],
    teamAgents: [agent({ id: "ta-nc", name: "无色" })],
  }).lanes[0]!;
  assert.equal(namelessColor.color, resolveSubagentColorFromName("无色"));

  // 定义在册且设了色 ⇒ 用它（身份色单源）
  const colored = buildSquadTimelineModel({
    runs: [run({ runId: "run-c", agentId: "ta-c", createdAt: 1 })],
    teamAgents: [agent({ id: "ta-c", name: "有色", color: "purple" })],
  }).lanes[0]!;
  assert.equal(colored.color, "purple");
});

// ---------- lane 顺序 ----------

// 变异：去掉「队长 lane 最上」⇒ 改成按最早站排 ⇒ 顺序变 [ta-a, ta-b, ta-leader] ⇒ 本用例红。
test("lane 顺序：有队长站的最上（即便它的最早站晚于成员的）；其余按最早站升序", () => {
  const model = buildSquadTimelineModel({
    runs: [
      run({
        runId: "run-leader",
        agentId: "ta-leader",
        isLeaderTask: true,
        branch: null,
        status: "merged",
        createdAt: 10,
        updatedAt: 11,
      }),
      run({ runId: "run-a", agentId: "ta-a", createdAt: 1 }),
      run({ runId: "run-b", agentId: "ta-b", createdAt: 2 }),
    ],
    teamAgents: [agent()],
  });
  assert.deepEqual(
    model.lanes.map((lane) => lane.laneId),
    ["ta-leader", "ta-a", "ta-b"],
    "队长 lane 是这条时间线的「指挥行」，角色优先于先来后到",
  );
});

test("lane 顺序同刻 tie-break：按 laneId 升序（成员 lane 与队长 lane 各一组，全序）", () => {
  // 成员 lane：最早站同刻（7）⇒ laneId 定序；输入顺序故意 z 先 a 后。
  const members = buildSquadTimelineModel({
    runs: [
      run({ runId: "run-z", agentId: "ta-z", createdAt: 7 }),
      run({ runId: "run-a", agentId: "ta-a", createdAt: 7 }),
    ],
    teamAgents: [],
  });
  assert.deepEqual(
    members.lanes.map((lane) => lane.laneId),
    ["ta-a", "ta-z"],
  );

  // 队长 lane：最早**队长**站同刻（3）⇒ 同样按 laneId 定序（不是按普通最早站）。
  const leaders = buildSquadTimelineModel({
    runs: [
      run({
        runId: "run-lz",
        agentId: "ta-lz",
        isLeaderTask: true,
        branch: null,
        createdAt: 3,
        updatedAt: 4,
        status: "merged",
      }),
      run({
        runId: "run-la",
        agentId: "ta-la",
        isLeaderTask: true,
        branch: null,
        createdAt: 3,
        updatedAt: 4,
        status: "merged",
      }),
    ],
    teamAgents: [],
  });
  assert.deepEqual(
    leaders.lanes.map((lane) => lane.laneId),
    ["ta-la", "ta-lz"],
  );
});

test("同 lane 多站：按 startAt ASC, runId ASC（同刻按 id 定序）", () => {
  const model = buildSquadTimelineModel({
    runs: [
      run({ runId: "run-z", agentId: "ta-a", createdAt: 100 }),
      run({ runId: "run-a", agentId: "ta-a", createdAt: 100 }),
      run({ runId: "run-earlier", agentId: "ta-a", createdAt: 50 }),
    ],
    teamAgents: [],
  });
  assert.deepEqual(
    model.lanes[0]!.stations.map((station) => station.runId),
    ["run-earlier", "run-a", "run-z"],
  );
});

// ---------- 确定性 / 容错 ----------

test("确定性：同一份输入两次调用结果逐字一致；输入顺序打乱也不变（模型自己排序）", () => {
  const input = {
    runs: [
      run({
        runId: "run-leader",
        agentId: "ta-leader",
        isLeaderTask: true,
        branch: null,
        status: "merged",
        createdAt: 5,
        updatedAt: 6,
      }),
      run({ runId: "run-m2", agentId: "ta-m2", createdAt: 20, status: "produced" }),
      run({ runId: "run-m1", agentId: "ta-m1", createdAt: 10, status: "merged", updatedAt: 12 }),
      run({
        runId: "run-m1b",
        agentId: "ta-m1",
        createdAt: 10,
        status: "discarded",
        updatedAt: 11,
      }),
    ],
    teamAgents: [agent(), agent({ id: "ta-m1", name: "甲" })],
  };
  const first = buildSquadTimelineModel(input);
  const second = buildSquadTimelineModel(input);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second), "逐字一致（不只是结构相等）");

  const shuffled = buildSquadTimelineModel({
    runs: [...input.runs].reverse(),
    teamAgents: input.teamAgents,
  });
  assert.equal(
    JSON.stringify(shuffled),
    JSON.stringify(first),
    "输出不依赖输入行序：lane / 站 / 弧都由模型自己排序",
  );
});

test("容错：同一 runId 重复 ⇒ 只画一次（取给定顺序的第一条）", () => {
  const model = buildSquadTimelineModel({
    runs: [
      run({ runId: "run-dup", agentId: "ta-first", createdAt: 1 }),
      run({ runId: "run-dup", agentId: "ta-second", createdAt: 1 }),
    ],
    teamAgents: [],
  });
  assert.deepEqual(
    model.lanes.map((lane) => lane.laneId),
    ["ta-first"],
    "坏数据不得把同一次运行画成两个站",
  );
  assert.equal(model.lanes[0]!.stations.length, 1);
});
