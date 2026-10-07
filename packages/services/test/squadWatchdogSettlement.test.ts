import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import { SQUAD_RUN_SETTLE_REASON_USER_CANCEL } from "../src/workitem/squadRunRepo.js";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";
import {
  terminalKindForPhase,
  type ZCodeTaskIndexTerminalEvent,
} from "../src/zcode-agent/zcodeTaskIndexSyncer.js";
import type { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* W2（看门狗六件套）：**终态语义**的两处跨终态缺口（R-3 报告 §5.4-1 点名的覆盖缺口）。

   为什么单独一个文件而不是塞进 `squadRuntimeRecovery.test.ts`：那里覆盖的是 `failMemberRun`
   自身的响亮/幂等分支，而这里覆盖的是**「已有终态的 run 又收到一次终局信号」**这一族 ——
   ① 成功臂（`completeMemberRun`）此前**没有**任何跨终态保护（`discarded → produced` 静默改写、
   工作项被推回 `in_review`）；② `stop` 的会话终态此前落 `turn.completed` ⇒ adapter 出口一律
   `"succeeded"` ⇒ 看门狗/取消自己发起的 stop 反而走**成功入账**。两条都不报错，只把「取消」
   这条语义静默吃掉 —— 故都必须在**行为**层钉住（读实体状态，不是读源码相信）。

   夹具与 `c1ResidualMemberRun.test.ts` / `squadRuntimeRecovery.test.ts` 同形：真实 git 仓库 +
   真实 runtime（真实工作树与台账）。 */

const WS = "w2-ws";

type Fixture = {
  repoRoot: string;
  runtime: SquadRuntime;
  itemId: string;
  agentId: string;
  /** 另开一个 `in_progress` 工作项（并发上限 = 1 ⇒ 同一工作项上的第二条 run 会落到 queued，分开更干净）。 */
  createItem(itemId: string): void;
  openFor(runId: string, itemId?: string): Promise<unknown>;
  /** 捕获 `console.warn`（lifecycle 的 `logWarn` 缺省回落）⇒ 断言「有且仅有一条警告」。 */
  captureWarn<T>(run: () => Promise<T>): Promise<{ result: T; warns: string[] }>;
};

async function setup(): Promise<Fixture> {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: WS,
    readExperimentEnabled: () => true,
  });
  // 有名册定义 ⇒ `openMemberRun` 走「容量/活跃/义务」裁决（无定义则直开）。
  const agent = runtime.teamAgentService.create({
    name: "w2-agent",
    systemPrompt: "s",
    memoryScope: "project",
    maxConcurrentRuns: 1,
  });
  const itemId = "w2-wi";
  const createItem = (id: string): void => {
    runtime.workItemRepo.insert({
      id,
      workspaceIdentity: WS,
      workspacePath: repoRoot,
      title: "终态语义",
      body: "",
      status: "in_progress",
      assignee: { type: "agent", id: agent.id },
      labels: [],
      properties: {},
      position: 0,
    });
  };
  createItem(itemId);
  return {
    repoRoot,
    runtime,
    itemId,
    agentId: agent.id,
    createItem,
    openFor: (runId: string, targetItemId?: string) =>
      runtime.lifecycle.openMemberRun({
        runId,
        workItemId: targetItemId ?? itemId,
        parentWorkItemId: targetItemId ?? itemId,
        agentId: agent.id,
        isLeaderTask: false,
      }),
    captureWarn: async <T,>(run: () => Promise<T>) => {
      const warns: string[] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => {
        warns.push(args.map((arg) => String(arg)).join(" "));
      };
      try {
        return { result: await run(), warns };
      } finally {
        console.warn = original;
      }
    },
  };
}

test("取消后迟到成功：completeMemberRun 对 discarded 行 no-op（台账不回 produced、工作项不被推回 in_review）+ 单条 warn", async () => {
  const f = await setup();
  const runId = "w2-late-success";
  await f.openFor(runId);
  assert.equal(f.runtime.squadRunRepo.get(runId)?.status, "open", "前置：新建的队员 run 是 open");

  // 取消（L1 台账半边）：run 出活跃集，reason 落 settle_reason。
  await f.runtime.lifecycle.failMemberRun({ runId, reason: SQUAD_RUN_SETTLE_REASON_USER_CANCEL });
  assert.equal(f.runtime.squadRunRepo.get(runId)?.status, "discarded", "取消后是 discarded");

  // 迟到成功：会话最终跑完了才把「成功」送到成功臂。
  const { warns } = await f.captureWarn(() =>
    f.runtime.lifecycle.completeMemberRun({ runId }),
  );

  assert.equal(
    f.runtime.squadRunRepo.get(runId)?.status,
    "discarded",
    "迟到成功**不得**把已取消的 run 改写成 produced（取消被静默吃掉 = 这条 run 又回到活跃集）",
  );
  assert.equal(
    f.runtime.workItemRepo.get(f.itemId)?.status,
    "in_progress",
    "工作项不得被推回 in_review：取消是用户表态，迟到产出不该让它重新进审查",
  );
  assert.equal(warns.length, 1, `no-op 必须留**一条** warn（实际 ${warns.length} 条）`);
  assert.match(warns[0] ?? "", /discarded/, "warn 文案要点名当时的终态（否则人无从判断被丢弃的是什么）");
});

test("跨终态改写响亮抛：produced / rejected 行上再调 completeMemberRun ⇒ 抛且不动任何实体状态", async () => {
  const f = await setup();

  // ① 重复入账：同一条 run 的「成功」被送两次（双出口 / 重投）⇒ 响亮抛，不得静默再写一遍。
  const produced = "w2-double-complete";
  await f.openFor(produced);
  await f.runtime.lifecycle.completeMemberRun({ runId: produced });
  assert.equal(f.runtime.squadRunRepo.get(produced)?.status, "produced", "前置：第一次入账成功");
  const workItemAfterFirst = f.runtime.workItemRepo.get(f.itemId)?.status;
  await assert.rejects(
    () => f.runtime.lifecycle.completeMemberRun({ runId: produced }),
    /produced/,
    "已 produced 的行上再入账 = 跨终态改写（重复入账要能被人看见，不得静默）",
  );
  assert.equal(f.runtime.squadRunRepo.get(produced)?.status, "produced", "抛之后台账不动");
  assert.equal(
    f.runtime.workItemRepo.get(f.itemId)?.status,
    workItemAfterFirst,
    "抛之后工作项也不动（响亮不是「先写了再抛」）",
  );

  // ② 背叛待修结论：审查打回（rejected = 产出要活到修复后合并，spec §6.2）⇒ 迟到成功不得把它翻成 produced。
  const rejected = "w2-rejected-then-success";
  const rejectedItem = "w2-wi-rejected";
  f.createItem(rejectedItem);
  await f.openFor(rejected, rejectedItem);
  assert.equal(f.runtime.workItemRepo.get(rejectedItem)?.status, "in_progress", "前置：新工作项在 in_progress");
  await f.runtime.lifecycle.completeMemberRun({ runId: rejected });
  assert.equal(
    f.runtime.workItemRepo.get(rejectedItem)?.status,
    "in_review",
    "前置：入账把工作项推进到 in_review",
  );
  await f.runtime.lifecycle.reviewMemberRun({ runId: rejected, verdict: "rejected" });
  assert.equal(f.runtime.squadRunRepo.get(rejected)?.status, "rejected", "前置：打回待修");
  await assert.rejects(
    () => f.runtime.lifecycle.completeMemberRun({ runId: rejected }),
    /rejected/,
    "rejected 行上再入账会掩盖「被打回」这条结论 —— 必须响亮抛",
  );
  assert.equal(f.runtime.squadRunRepo.get(rejected)?.status, "rejected", "抛之后仍是待修");
});

/* ---- R-3 修复②：stop 的**会话终态**必须与「跑完了」区分（否则看门狗/取消自己发的 stop 走成功臂）----

   链路上的三段（R-3 §4 已逐段证过）：`completedInterrupted` 在相位枚举里 → syncer 此前一律发
   `turn.completed` → adapter 出口 `"succeeded"` → host 只在 `!== "succeeded"` 时走失败出口。
   本用例钉**中段偏后**这一格：adapter 出口的三值映射（syncer 的 kind 是它的输入契约）。

   为什么用**假 syncer**：这里要断言的正是「syncer 与 adapter 之间那条事件契约」——真实的 syncer
   要靠 workspace frames 摄入才发得出终态（另一套订阅/基线机制），在那上面搭夹具会让本用例
   失败时无法区分「映射错」与「帧没送到」。syncer 自己那一半（相位 → kind）在下面单钉。 */

test("stop 的会话终态：adapter 出口把 turn.interrupted 映射为 stopped（不得再落 succeeded）", () => {
  type Options = Parameters<typeof createZCodeTaskServiceAdapter>[0];
  const listeners: Array<(event: ZCodeTaskIndexTerminalEvent) => void> = [];
  const disposable = { dispose() {} };
  const service = createZCodeTaskServiceAdapter({
    zcodeAgentService: { disposeAll() {} } as unknown as Options["zcodeAgentService"],
    taskIndexRepo: { close() {} } as unknown as TaskIndexRepo,
    taskIndexSyncer: {
      onSessionTerminalEvent: (listener: (event: ZCodeTaskIndexTerminalEvent) => void) => {
        listeners.push(listener);
        return disposable;
      },
      onSessionReadyEvent: () => disposable,
      disposeAll() {},
    } as unknown as Options["taskIndexSyncer"],
  });

  const taskId = "task-interrupted";
  const outcomes: string[] = [];
  service.onDynamicTaskTerminalOutcome(taskId)((outcome) => outcomes.push(outcome.outcome));
  assert.ok(listeners.length > 0, "终态出口必须有订阅者（没有订阅 = 这条链根本不通）");

  const fire = (kind: ZCodeTaskIndexTerminalEvent["kind"]): void => {
    for (const listener of listeners) {
      listener({
        target: { workspacePath: "/ws", workspaceIdentity: "ws", sessionId: taskId },
        kind,
      });
    }
  };
  fire("turn.completed");
  fire("turn.failed");
  fire("turn.interrupted");

  assert.deepEqual(
    outcomes,
    ["succeeded", "failed", "stopped"],
    "三种终态各自出口：被 stop 打断的一次**不是**「跑完了」——落 succeeded 会让 run 走成功入账（produced）",
  );
  service.disposeAll();
});

test("stop 的会话终态：相位 → kind 的映射在 syncer 里只有一处（发射点不得再写内联三元）", () => {
  // 行为面：六个相位逐个钉（期望值取自协议相位语义，不是实现里抄一遍的表达式）。
  assert.equal(terminalKindForPhase("completedSuccess"), "turn.completed", "跑完了 ⇒ turn.completed");
  assert.equal(
    terminalKindForPhase("completedInterrupted"),
    "turn.interrupted",
    "被 stop 打断 ⇒ 自己的 kind（R-3 修复②的核心：不能与 completedSuccess 合并）",
  );
  assert.equal(terminalKindForPhase("error"), "turn.failed", "出错 ⇒ turn.failed");
  // 非终态相位不该被喂进这条映射（发射点只在终态迁移时调用）；若被喂错，**不得**冒充中断。
  for (const phase of ["draft", "prewarming", "running"] as const) {
    assert.equal(
      terminalKindForPhase(phase),
      "turn.completed",
      `非终态相位 ${phase} 落到缺省值（历史口径），但绝不能是 turn.interrupted`,
    );
  }

  // 接线面：发射点必须**消费**这条映射 —— 内联三元正是 R-3 缺陷的原始形态（两相位合并）。
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../src/zcode-agent/zcodeTaskIndexSyncer.ts"),
    "utf8",
  );
  assert.match(
    source,
    /terminalEventEmitter\.fire\(\{\s*target,\s*(?:\/\*[\s\S]*?\*\/\s*)?kind: terminalKindForPhase\(phase\),/,
    "终态发射点必须走 terminalKindForPhase（内联三元会让 completedInterrupted 静默回到 succeeded）",
  );
  assert.doesNotMatch(
    source,
    /kind:\s*failed\s*\?\s*"turn\.failed"\s*:\s*"turn\.completed"/,
    "旧的「两相位合并」写法不得回到发射点（那是 R-3 缺陷本身）",
  );
});
