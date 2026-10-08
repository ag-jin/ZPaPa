// 后台子 agent 与父会话生命周期的边界（P1-1 加固验证）。
//
// 为什么这组用例承重：孤儿收敛的 J4 判据拿 `context.sessions`（host record）当「本进程认领」信号，
// 但生产拓扑里 subagent child 是父 runtime 内联创建的 `new AgentRuntime(...)`
// （core/runtime/methods/subagent.ts），**没有 host record**——bootstrap 的 `context.sessions.set`
// 只发生在被 create/resume/fork 的 host 会话上。于是 J4 在生产里几乎恒 false，真正让
// 「父被去激活 ∧ child 还活着」不可达的是另外两道防线，本文件把这两道锁在真实 runtime 接缝上：
//
//   1) 常驻钉住：后台 child 在**父 runtime** 的 task registry 里是 `isBackgrounded ∧ running`
//      ⇒ `hasRunningBackgroundTasks()` / `hasResidencyBlockingWork()` 为真 ⇒ 常驻池
//      （session-resident-pool.ts 的 `isEligible`）的 idle TTL 与高水位两条回收路径都跳过父会话。
//      即：只要后台 child 在跑，父会话不会被容量去激活（切走会话只是退订，本来也不是去激活）。
//   2) 终止入口唯一：后台 launch 不订阅父 turn 的 abort signal（runner.ts 的 `start()` 只在
//      启动瞬间读一次 `startOptions.signal.aborted`），SubagentPort 也没有 stopAll/close 之类
//      的整体停止面 ⇒ 父侧 turn abort / runtime beginShutdown（app.close 第一拍）都不终止 child。
//
// 因此「连带终止」只可能来自进程消失；**例外**是显式会话关闭（deleteSession/closeSession）：
// 它绕过常驻池闸门，把父 record 摘掉却不碰 child（详见 bootstrap 侧
// subagent-orphan-reconcile.ts 文件头的 P1-1 边界说明）。这两条不变量即使将来换成真实认领信号
// 也必须继续成立，所以值得单独锁住。

import assert from "node:assert/strict";
import test from "node:test";
import { createSessionId } from "@zcode/contracts";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { createExploreSubagentPort } from "../src/subagent/runner.js";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";

const PARENT_SESSION_ID = String(createSessionId("parent_lifetime"));
const CHILD_AGENT_ID = "agent_lifetime_00000000";

interface BackgroundChildHarness {
  childSignals: AbortSignal[];
  parentTurn: AbortController;
  runtime: AgentRuntime;
  /** 与生产同源：registry 拿的是父 runtime 自己那一个。 */
  registry: InMemoryRuntimeTaskRegistry;
}

/**
 * 起一个「父 runtime + 父 runtime 自身 subagent port + 一个挂住不返回的后台 child」的装置。
 *
 * `runExploreAgent` 是唯一被替换的生产接缝（真实 child runtime 是内联 `new AgentRuntime`，
 * 单测起不动）：它复刻真实 child runtime 的两件承重事实——先调 `onSessionReady`（未落库就 spawn
 * 会让 background launch 的 readyGate 永不 settle），再挂住直到 abort。
 */
async function launchBackgroundChild(): Promise<BackgroundChildHarness> {
  const registry = new InMemoryRuntimeTaskRegistry();
  const childSignals: AbortSignal[] = [];
  const parentTurn = new AbortController();
  const subagentPort = createExploreSubagentPort({
    createAgentId: () => CHILD_AGENT_ID,
    emitParentEvent: async () => {},
    enqueueParentTaskNotification: () => undefined,
    runtimeTaskRegistry: registry,
    runExploreAgent: async (request, options) => {
      const signal = options?.signal;
      assert.ok(signal, "后台 child 必须有 abort signal");
      childSignals.push(signal);
      await request.onSessionReady?.();
      return await new Promise((_resolve, reject) => {
        const onAbort = (): void => reject(signal.reason ?? new Error("aborted"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  });
  const runtime = new AgentRuntime(
    PARENT_SESSION_ID as never,
    { workingDirectory: process.cwd() } as never,
    {
      eventStore: {
        append: async (event: unknown) => event,
        deleteSession: async () => {},
        getEvents: async () => [],
        getEventsAfter: async () => [],
        getLatestSequenceNumber: async () => 0,
      },
      modelFactory: (() => {
        throw new Error("本用例不该构造模型");
      }) as never,
      runtimeTaskRegistry: registry,
      subagentPort,
    } as never,
  );

  await runtime.subagentPort?.launch?.(
    {
      agentType: "general-purpose",
      description: "长跑后台 child",
      parentToolCallId: "call_parent_lifetime",
      prompt: "work",
      runInBackground: true,
      sessionId: PARENT_SESSION_ID as never,
      trace: { traceId: "trace_parent_lifetime" } as never,
      workingDirectory: process.cwd(),
      workspaceRoot: process.cwd(),
    },
    { signal: parentTurn.signal },
  );

  return { childSignals, parentTurn, registry, runtime };
}

/** 让 abort/registry 的同步链路跑完（无定时器语义，只是让 microtask/监听器结算）。 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

test("后台 child 在跑：父 runtime 的常驻阻塞事实为真 ⇒ 常驻池不会回收父会话", async () => {
  const { registry, runtime } = await launchBackgroundChild();
  const task = registry.get(CHILD_AGENT_ID);
  // 钉住的性质来自这条登记形状（hasRunningBackgroundRuntimeTask 只看这两项）。
  assert.equal(task?.type, "local_agent");
  assert.equal(task?.isBackgrounded, true);
  assert.equal(task?.status, "running");
  assert.equal(runtime.hasRunningBackgroundTasks(), true);
  assert.equal(runtime.hasResidencyBlockingWork(), true);
  await runtime.subagentPort?.stopTask?.(CHILD_AGENT_ID);
  await settle();
  // 反面对照：同一个 runtime 上，后台 child 结束后阻塞事实回落——证明这条事实不是常量真。
  assert.equal(runtime.hasRunningBackgroundTasks(), false);
  assert.equal(runtime.hasResidencyBlockingWork(), false);
});

test("父侧 teardown 不连带终止后台 child：app.close 的 runtime 侧全链之后 child 仍在跑", async () => {
  const { childSignals, parentTurn, runtime } = await launchBackgroundChild();
  assert.equal(childSignals.length, 1);

  // 父 turn 终止（Stop / 新一轮抢占 / 会话切走时的前台收口）。
  parentTurn.abort(new Error("parent turn cancelled"));
  await settle();
  assert.equal(childSignals[0]?.aborted, false, "父 turn abort 不得传播到后台 child");
  assert.equal(runtime.hasResidencyBlockingWork(), true);

  // 会话关闭（session-facade.close → closeSessionResources）里**所有**会碰 runtime 的步骤。
  // 其余步骤（executionPort / MCP / session store）是共享的兄弟端口，够不到 subagent port；
  // SubagentPort 本身也没有 stopAll/close 这类整体停止面（唯一停止入口是 stopTask）。
  runtime.beginShutdown();
  await runtime.drainMemoryExtractions(10);
  await runtime.closeBrowserSession();
  await settle();
  assert.equal(childSignals[0]?.aborted, false, "会话关闭链不得终止后台 child");
  assert.equal(runtime.hasRunningBackgroundTasks(), true);
  assert.equal(runtime.hasResidencyBlockingWork(), true);

  // 收尾：只有显式 stopTask 能终止它。
  const stopped = await runtime.subagentPort?.stopTask?.(CHILD_AGENT_ID);
  await settle();
  assert.equal(childSignals[0]?.aborted, true, "显式 stopTask 必须能终止 child（正对照）");
  assert.equal(stopped?.status, "killed");
  assert.equal(runtime.hasResidencyBlockingWork(), false);
});
