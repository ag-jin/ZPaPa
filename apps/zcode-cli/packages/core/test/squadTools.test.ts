// 队长派单工具集（建子工作项 / 派给队员）的行为测试。
//
// 为什么这组用例的承重项是「只发事件、不写状态」：spec §4.3 / §5.1 裁定工作项生命周期状态只有
// 一个写者（workItemService.transition）。队长 run 被唤醒后拿到的这两个工具若多出一条直写
// status 的通路，用户 / 队长 / 调度器三方就各自有了第二份判据——那正是本任务最容易被顺手破坏的一处。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createSquadTools, squadToolNames } from "../src/tool/handlers/squad.js";

/**
 * 记录 port 调用的假端口。**故意不实现任何写状态的方法**——
 * 它的键集就是「ported 面」的运行时快照。
 */
function fakePort() {
  const created: unknown[] = [];
  const assigned: unknown[] = [];
  return {
    created,
    assigned,
    port: {
      async createChildWorkItem(input: { parentId: string; title: string; assignee: unknown }) {
        created.push(input);
        return { workItemId: "wi-child" };
      },
      async assignWorkItem(input: { workItemId: string; agentId: string }) {
        assigned.push(input);
        return { dispatched: true as const };
      },
      async listRoster() {
        return { leaderAgentId: "ta-lead", members: [{ agentId: "ta-a" }] };
      },
    },
  };
}

test("smoke：CLI 工作区能用 tsx --test 跑测试", () => {
  assert.ok(true);
});

// 缺 port ⇒ 响亮抛 ConfigurationError（照 cron.ts 的 assertAutomationPort）：
// 静默 no-op 会让队长以为「派单成功了」，而队员永远不会被唤醒。
test("未注入 squadPort ⇒ 抛 ConfigurationError，不静默返回", async () => {
  const tools = createSquadTools({ squadPort: undefined });
  await assert.rejects(
    () =>
      tools.createChildWorkItem.handler(
        { parentId: "wi-p", title: "t", assigneeAgentId: "ta-a" },
        {} as never,
      ),
    /squadPort|ConfigurationError/,
  );
});

test("建子工作项：把父项 id 原样交给 port", async () => {
  const { port, created } = fakePort();
  const tools = createSquadTools({ squadPort: port });
  const out = await tools.createChildWorkItem.handler(
    { parentId: "wi-p", title: "拆解 1", assigneeAgentId: "ta-a" },
    { sessionId: "s1" } as never,
  );
  assert.equal(out.workItemId, "wi-child");
  assert.equal((created[0] as { parentId: string }).parentId, "wi-p");
});

// 派给队员 = 发派发事件（assign），**不是**替调用方写状态。
test("派给队员：只经 port 发派发事件", async () => {
  const { port, assigned } = fakePort();
  const tools = createSquadTools({ squadPort: port });
  await tools.assignWorkItem.handler({ workItemId: "wi-c", agentId: "ta-a" }, {} as never);
  assert.deepEqual(assigned, [{ workItemId: "wi-c", agentId: "ta-a" }]);
});

// 【唯一写者不变 —— 本任务的承重断言】
// SquadPort **不得**暴露任何写工作项状态的方法；一旦有人给它加一个 `transition`，
// 队长就能绕过 workItemService 直写 status（P0/P1 裁定：只有 transition 能写 status），
// 这条断言正是拦它的那道闸。
//
// 注意：只对 fixture 做 `in` 判定是**同义反复**（fixture 由本文件写，它当然没有 transition）。
// 能真正咬住变异的判据是「接口声明体里不许出现这些方法名」——契约类型是接口的全部运行时痕迹。
const SQUAD_PORT_SOURCE_PATH = new URL(
  "../../contracts/src/interfaces/squad.port.ts",
  import.meta.url,
);
test("SquadPort 不得暴露任何写工作项状态的方法", () => {
  const { port } = fakePort();
  for (const forbidden of ["transition", "setStatus", "updateStatus", "forceStatus"]) {
    assert.equal(
      forbidden in port,
      false,
      `SquadPort 不得暴露 ${forbidden}（唯一写者是 workItemService）`,
    );
  }

  const source = readFileSync(SQUAD_PORT_SOURCE_PATH, "utf8");
  // 只查接口声明体：注释里写明「只有 workItemService.transition 能写」是允许的，
  // 所以先剥掉块注释与行注释，再对成员名做词边界匹配。
  const withoutComments = source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/.*$/gm, "");
  const declaredMembers = withoutComments
    .slice(withoutComments.indexOf("export interface SquadPort"))
    .replace(/^\s*\}/m, "");
  for (const forbidden of ["transition", "setStatus", "updateStatus", "forceStatus"]) {
    assert.equal(
      new RegExp(`\\b${forbidden}\\b`).test(declaredMembers),
      false,
      `SquadPort 声明体不得出现 ${forbidden}（唯一写者是 workItemService）`,
    );
  }
});

// 不可见性双保险的第一道：没有 port ⇒ 工具**不注册**（照 runtime-tools.ts:67 的 includeAutomation）。
test("没有 squadPort 时工具不进工具表", async () => {
  const { includeSquadTools } = await import("../src/runtime/helpers/runtime-tools.js");
  assert.equal(includeSquadTools({}), false);
  assert.equal(includeSquadTools({ squadPort: {} as never }), true);
});

// 派给不存在的队员必须**响亮失败**：静默放行会让工作项挂在一个永远没人做的队员上。
test("派给花名册外的队员 ⇒ 抛", async () => {
  const { port } = fakePort();
  const tools = createSquadTools({ squadPort: port });
  await assert.rejects(
    () => tools.assignWorkItem.handler({ workItemId: "wi-c", agentId: "ta-nobody" }, {} as never),
    /ta-nobody|花名册/,
  );
});

// ---------- 穷举补格（Step 5 矩阵里不能空着的格） ----------

// 建子项必须带父项 id：§14 的「在某工作项下建子项」一旦丢了父项，子项会飘到树外。
test("建子工作项不带父项 id ⇒ 抛（input schema 必填）", async () => {
  const { port } = fakePort();
  const tools = createSquadTools({ squadPort: port });
  await assert.rejects(
    () => tools.createChildWorkItem.handler({ title: "拆解 1" } as never, {} as never),
    /parentId/,
  );
});

// 花名册读不到（port 抛）必须原样向上，不得当成「没有合法队员」而静默放行或改写。
test("花名册读取失败 ⇒ 原样抛出，不吞", async () => {
  const boom = new Error("roster read boom");
  const tools = createSquadTools({
    squadPort: {
      async createChildWorkItem() {
        return { workItemId: "wi-child" };
      },
      async assignWorkItem() {
        return { dispatched: true as const };
      },
      async listRoster(): Promise<never> {
        throw boom;
      },
    },
  });
  await assert.rejects(
    () => tools.assignWorkItem.handler({ workItemId: "wi-c", agentId: "ta-a" }, {} as never),
    (error: unknown) => error === boom,
  );
});

// 实验关闭（服务层抛 SquadDispatchDisabledError）必须**原样**回到模型：
// 吞掉它或改写成别的形态，队长就看不到「实验功能已关闭」这个唯一可行动的事实。
// 这里用等值身份断言（===），改写 / 重新包装都会红。
test("服务层门禁错误原样带回（含 squad_dispatch_disabled 稳定码）", async () => {
  const disabled = new Error(
    "[squad_dispatch_disabled] 实验功能已关闭：停止新派发（进行中的 run 不受影响）",
  ) as Error & { code: string };
  disabled.code = "squad_dispatch_disabled";
  const tools = createSquadTools({
    squadPort: {
      async createChildWorkItem(): Promise<never> {
        throw disabled;
      },
      async assignWorkItem() {
        return { dispatched: true as const };
      },
      async listRoster() {
        return { leaderAgentId: "ta-lead", members: [{ agentId: "ta-a" }] };
      },
    },
  });
  await assert.rejects(
    () =>
      tools.createChildWorkItem.handler(
        { parentId: "wi-p", title: "t", assigneeAgentId: "ta-a" },
        {} as never,
      ),
    (error: unknown) => error === disabled && error.code === "squad_dispatch_disabled",
  );
});

// §14 / §13.2：工具**独立命名**，不与既有 Agent / SendMessage / CronCreate 语义重叠或重名。
test("工具名与既有协作/调度工具不重名", () => {
  const existing = new Set([
    "Agent",
    "Task",
    "SendMessage",
    "CronCreate",
    "CronUpdate",
    "CronList",
    "CronDelete",
  ]);
  assert.equal(new Set(squadToolNames).size, squadToolNames.length, "两个 squad 工具名之间不得重复");
  for (const name of squadToolNames) {
    assert.equal(existing.has(name), false, `${name} 与既有工具重名`);
  }
  assert.deepEqual([...squadToolNames].sort(), [
    "SquadAssignWorkItem",
    "SquadCreateChildWorkItem",
  ]);
});
