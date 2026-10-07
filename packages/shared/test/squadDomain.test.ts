import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SQUAD_FALLBACK_WALL_CLOCK_HOURS,
  DEFAULT_SQUAD_IDLE_TIMEOUT_MINUTES,
  DEFAULT_SQUAD_RUN_TTL_MINUTES,
  DEFAULT_SQUAD_TOOL_TIMEOUT_MINUTES,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  SQUAD_BREAKER_THRESHOLD,
  SQUAD_BREAKER_WINDOW_MINUTES,
  SQUAD_INSTRUCTION_SLOTS,
  SQUAD_REQUIRED_INSTRUCTION_SLOTS,
  SQUAD_RETRY_BUDGET,
  squadSchema,
  validateSquad,
} from "../src/squad.js";

const base = {
  id: "sq_1",
  name: "网关组",
  leaderAgentId: "ta_lead",
  members: [{ agentId: "ta_lead", role: "leader" }, { agentId: "ta_a" }],
  instructions: { goal: "上线限流" },
  enabled: true,
};

test("8 个槽位是固定全集", () => {
  assert.deepEqual(SQUAD_INSTRUCTION_SLOTS, [
    "goal",
    "breakdown",
    "dispatch",
    "independence",
    "acceptance",
    "stopCondition",
    "reporting",
    "maxRounds",
  ]);
});

// 收手条件与轮次上限是必填槽位：缺了队长就没有终止条件，会一直派或早早停。
test("缺少必填槽位时 validateSquad 报错", () => {
  const squad = squadSchema.parse(base);
  const result = validateSquad(squad);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.problems.some((p) => p.includes("stopCondition")));
  assert.ok(!result.ok && result.problems.some((p) => p.includes("maxRounds")));
});

test("补齐必填槽位后校验通过", () => {
  const squad = squadSchema.parse({
    ...base,
    instructions: { stopCondition: "子项全 done 且审查通过即收工", maxRounds: "5" },
  });
  assert.deepEqual(validateSquad(squad), { ok: true });
});

// leader 必须同时是 members 之一：否则「队长协调」没有承载者。
test("leader 不在 members 里则报错", () => {
  const squad = squadSchema.parse({ ...base, members: [{ agentId: "ta_a" }] });
  const result = validateSquad(squad);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.problems.some((p) => p.includes("leaderAgentId")));
});

test("members 内同一 agentId 重复则报错", () => {
  const squad = squadSchema.parse({
    ...base,
    members: [{ agentId: "ta_a" }, { agentId: "ta_a" }],
  });
  const result = validateSquad(squad);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.problems.some((p) => p.includes("重复")));
});

test("strict：未知字段被拒（如 hostBinding）", () => {
  assert.equal(squadSchema.safeParse({ ...base, hostBinding: "h1" }).success, false);
});

test("继承既有字段可选性：description 可选、archivedAt 可选", () => {
  const parsed = squadSchema.parse(base);
  assert.equal(parsed.description, undefined);
  assert.equal(parsed.archivedAt, undefined);
});

/* ---------- Step 5 穷举补充 ---------- */

// 必填槽位是固定两个。缺了这条断言，改 SQUAD_REQUIRED_INSTRUCTION_SLOTS 时上一条仍会绿，
// 表现为「必填集合悄悄缩水却没人发现」。
test("必填槽位就是收手条件与轮次上限两个", () => {
  assert.deepEqual(SQUAD_REQUIRED_INSTRUCTION_SLOTS, ["stopCondition", "maxRounds"]);
});

// 槽位取值三分：非空 / 空串 / 只有空白。后两种等于没写，必须由 validateSquad 拦下——
// 否则队长表单里一个「  」就能绕过必填，落盘后仍是无终止条件。
test("必填槽位为空串或纯空白都算未填", () => {
  const empty = validateSquad(
    squadSchema.parse({ ...base, instructions: { stopCondition: "", maxRounds: "5" } }),
  );
  assert.equal(empty.ok, false);
  assert.ok(!empty.ok && empty.problems.some((p) => p.includes("stopCondition")));

  const blank = validateSquad(
    squadSchema.parse({ ...base, instructions: { stopCondition: "   ", maxRounds: "" } }),
  );
  assert.equal(blank.ok, false);
  assert.ok(!blank.ok && blank.problems.some((p) => p.includes("stopCondition")));
  assert.ok(!blank.ok && blank.problems.some((p) => p.includes("maxRounds")));
});

// 槽位名写错（不在 8 槽位全集内）必须报错：静默丢弃会让队长拿到空指令却毫无提示。
test("instructions 里出现全集之外的槽位名被拒", () => {
  assert.equal(
    squadSchema.safeParse({ ...base, instructions: { goal: "x", goalX: "y" } }).success,
    false,
  );
});

// 单人小队（只有队长）合法：队长自己干活的小队不该被挡。
test("只有队长一人的成员名单通过校验", () => {
  const squad = squadSchema.parse({
    ...base,
    members: [{ agentId: "ta_lead", role: "leader" }],
    instructions: { stopCondition: "收工", maxRounds: "3" },
  });
  assert.deepEqual(validateSquad(squad), { ok: true });
});

// 名册**不设上限**：spec §3.10 的「单小队并行队员 ≤ 6」是并发约束（由派发侧管），不是名册规模。
// 若这里凭空加 .max，会拒绝合法的大名单——12 与 13 都必须通过。
test("名册不设上限：12 人与 13 人都通过", () => {
  const makeMembers = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ agentId: i === 0 ? "ta_lead" : `ta_${i}` }));

  assert.equal(squadSchema.safeParse({ ...base, members: makeMembers(12) }).success, true);
  assert.equal(squadSchema.safeParse({ ...base, members: makeMembers(13) }).success, true);
});

// 空成员名单被 schema 拒（min 1）：无人的小队没有被派单的承载者。
test("空成员名单被 schema 拒绝", () => {
  assert.equal(squadSchema.safeParse({ ...base, members: [] }).success, false);
});

// role 是自由标签，可省；省了就应是 undefined，而不是被 schema 补成空串（否则「有无角色」再也分不出）。
test("成员 role 可省且缺省为 undefined", () => {
  const parsed = squadSchema.parse(base);
  assert.equal(parsed.members[1]!.role, undefined);
  assert.equal(parsed.members[0]!.role, "leader");
});

/* 看门狗阈值是**用户裁定的契约值**（2026-10-07），单源在 shared：这里用字面量逐条钉住，
   防止有人「顺手」把它们改成别的数而没有任何用例变红（消费点（services/host）不得写散值，
   由 services 侧的结构守卫再钉一次）。 */
test("看门狗阈值六值 + 毫秒换算：单源常量逐条钉住（裁定值，不得静默改动）", () => {
  assert.equal(DEFAULT_SQUAD_RUN_TTL_MINUTES, 30, "TTL 缺省 30 分钟");
  assert.equal(DEFAULT_SQUAD_IDLE_TIMEOUT_MINUTES, 10, "空闲阈值缺省 10 分钟");
  assert.equal(DEFAULT_SQUAD_TOOL_TIMEOUT_MINUTES, 5, "工具阈值缺省 5 分钟");
  assert.equal(DEFAULT_SQUAD_FALLBACK_WALL_CLOCK_HOURS, 24, "探测缺席兜底墙钟 24 小时");
  assert.equal(SQUAD_RETRY_BUDGET, 1, "重试预算 1 次");
  assert.equal(SQUAD_BREAKER_WINDOW_MINUTES, 30, "熔断窗口 30 分钟");
  assert.equal(SQUAD_BREAKER_THRESHOLD, 3, "熔断阈值 3 次");
  assert.equal(MS_PER_MINUTE, 60_000, "分钟 ⇒ 毫秒");
  assert.equal(MS_PER_HOUR, 3_600_000, "小时 ⇒ 毫秒");
});
