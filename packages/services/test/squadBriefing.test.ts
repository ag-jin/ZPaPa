import assert from "node:assert/strict";
import test from "node:test";
import { LEADER_PROTOCOL_TEXT, planDispatch } from "../src/workitem/leaderDispatch.js";

/* 队长简报的三段契约（spec §3.3 / §17 留白表「队长简报缺操作协议」）。

   P1 只落了两段（roster + instructions），缺的 `protocol` 恰是**机制**那一半：
   不写进简报，队长就不知道三道闸、串行合并、整批才合回、审查未过前工作树存活，
   而它**不会报错**——队长只会照着自己猜的规矩跑。所以这一段必须有、且不得来自用户可写的 instructions。 */

const squad = {
  id: "sq_1",
  name: "网关组",
  leaderAgentId: "ta_lead",
  members: [{ agentId: "ta_lead", role: "leader" }, { agentId: "ta_a" }],
  instructions: { stopCondition: "子项全 done 即收工", maxRounds: "5" },
  enabled: true,
} as never;
const wi = {
  id: "wi_1",
  workspaceIdentity: "ws",
  workspacePath: "/tmp/ws",
  title: "t",
  body: "",
  status: "todo",
  assignee: { type: "squad", id: "sq_1" },
  labels: [],
  properties: {},
  position: 0,
} as never;

/** 取本用例唯一那条 run.enqueued 的简报；取不到就直接失败（不让下面的断言在 undefined 上静默）。 */
function briefingOf(s: unknown) {
  const run = planDispatch({ workItem: wi, squad: s as never, trigger: "user" }).find(
    (e) => e.kind === "run.enqueued",
  );
  assert.ok(run && run.kind === "run.enqueued" && run.briefing, "指派给小队应产出带简报的队长 run");
  return run.briefing;
}

test("队长简报是三段：roster / protocol / instructions", () => {
  const b = briefingOf(squad);
  assert.equal(b.roster.length, 2);
  assert.equal(b.instructions.stopCondition, "子项全 done 即收工");
  assert.ok(b.protocol.length > 0, "protocol 段不得为空");
  // 三段是**同时存在**的三个字段，不是「protocol 其实是 instructions 的别名」。
  assert.deepEqual(
    Object.keys(b).sort(),
    ["instructions", "leaderAgentId", "protocol", "roster", "squadId"],
    "简报字段恰为 squadId / leaderAgentId / roster / protocol / instructions",
  );
});

// protocol 是**系统生成的机制段**，不得取自用户可写的 instructions：
// 并进 instructions 等于把机制交还给用户去写，用户没写就等于「队长不知道规则却照跑」。
test("protocol 段不随用户指令改变，且必含四类机制要点", () => {
  const other = { ...squad, instructions: { stopCondition: "x", maxRounds: "1" } };
  const b = briefingOf(other);
  assert.equal(b.protocol, LEADER_PROTOCOL_TEXT);
  for (const must of ["max_fires", "串行", "集成分支", "blocked", "存活"]) {
    assert.ok(LEADER_PROTOCOL_TEXT.includes(must), `protocol 段缺机制要点：${must}`);
  }
});

// spec §3.3 的 protocol 行逐项：三道闸与判定次序、stopCondition/maxRounds 语义、
// 派单不改父项状态、整批通过才合回主分支、冲突进 Inbox、合并后才抛弃。
// 逐项断言（而不是只看关键词总体存在），因为少写一条的表现是「队长静默按错的规矩跑」。
test("protocol 段逐项含 spec §3.3 罗列的机制要点", () => {
  const musts: Array<[string, string]> = [
    ["rate", "第二道闸（一小时内 run 次数）"],
    ["loop", "第三道闸（run 链中同一规则重复）"],
    ["判定次序", "三道闸的判定次序是硬契约"],
    ["stopCondition", "收手条件"],
    ["maxRounds", "轮次上限"],
    ["父项", "派单不改父项状态"],
    ["整批", "整批通过才合回主分支"],
    ["Inbox", "解不了冲突进 Inbox"],
    ["合并后", "合并后才抛弃工作树"],
  ];
  for (const [needle, why] of musts) {
    assert.ok(LEADER_PROTOCOL_TEXT.includes(needle), `protocol 缺「${needle}」（${why}）`);
  }
});

// 补集方向：用户**没有**填任何 instructions 时，protocol 仍然要在场。
// 这一段的存在不依赖用户输入——它正是「机制不由用户决定」的体现。
test("instructions 为空时 protocol 依然在场", () => {
  const b = briefingOf({ ...squad, instructions: {} });
  assert.equal(b.protocol, LEADER_PROTOCOL_TEXT);
  assert.deepEqual(b.instructions, {});
});
