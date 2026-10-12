// 后台子 agent 完成 → 主会话必须被唤醒（模型请求带通知正文）。
//
// 为什么这组用例承重：用户报告「后台子代理执行完成后经常静默，主会话收不到完成通知/最终报告」，
// 这正是 f580ad8 修复线之外要核对的残留。完成链的三段各自可能断：终态委派（runner）、
// 运行命令队列投递（core runtime）、模型轮（唤醒）。本文件把「唤醒」当作断言对象——
// 子 agent 完成后，父 runtime 必须自己发起一次模型请求，且该请求的消息里带
// `<task-notification>` 正文；父会话全程没有用户输入，也没有别的定时器。
//
// 三条覆盖：空闲父会话单个 / 空闲父会话 N=12 并发 / 父会话 busy（turn 进行中）时子 agent 完成。
// 第三条件是生产常态（协调者一边跑一边收通知）；前两条把「通知在队列里等 drain」这条路径锁死。

import assert from "node:assert/strict";
import test from "node:test";
import { createSessionId, type Model, type ModelRequest } from "@zcode/contracts";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { createExploreSubagentPort } from "../src/subagent/runner.js";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";

const PARENT_SESSION_ID = String(createSessionId("wake_parent"));

interface Gate {
  holding: boolean;
  waiters: (() => void)[];
}

interface Harness {
  gate: Gate;
  modelRequests: ModelRequest[];
  notificationsPersisted: string[];
  runtime: AgentRuntime;
}

function createFakeModel(onRequest: (request: ModelRequest) => Promise<void> | void): Model {
  const model: Model = {
    providerId: "fake-provider" as never,
    modelId: "fake-model" as never,
    displayName: "fake",
    optionSpecs: { maxOutputTokens: { max: 4096, min: 1 } } as never,
    options: {},
    properties: {
      contextWindow: 200_000,
      inputFormat: {
        supportsAudio: false,
        supportsImage: false,
        supportsPdf: false,
        supportsText: true,
        supportsVideo: false,
      },
      outputFormat: { supportsText: true },
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsToolCall: true,
    } as never,
    bind: () => model,
    generateText: async (request) => {
      await onRequest(request);
      return {
        finishReason: "stop",
        text: "",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as never,
      };
    },
    streamText: (request) => {
      return (async function* () {
        await onRequest(request);
        yield { type: "start" } as never;
      })();
    },
  };
  return model;
}

/** 端口 fake：记录调用并把未实现的方法落成 async no-op（本用例只关心自己断言的几个面）。 */
function asyncProxy<T>(
  record?: (prop: string, args: unknown[]) => void,
  overrides?: Record<string, (...args: unknown[]) => unknown>,
): T {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") return undefined;
        if (typeof prop === "symbol") return undefined;
        const override = overrides?.[String(prop)];
        if (override) return override;
        return (...args: unknown[]) => {
          record?.(String(prop), args);
          return Promise.resolve(undefined);
        };
      },
    },
  ) as T;
}

/** 只打印通知/批次/turn 相关的 warn/error，失败时留下证据。 */
function createCapturingLogger(): unknown {
  const shouldPrint = (message: string): boolean =>
    /notification|batch|turn|Turn|compact|context/i.test(message);
  const emit = (level: string) => (message: string, context?: unknown, extra?: unknown) => {
    if (shouldPrint(message)) {
      console.log(`[${level}]`, message, JSON.stringify(context)?.slice(0, 400));
      if (extra instanceof Error) console.log(`[${level}] stack:`, extra.stack?.slice(0, 1200));
    }
  };
  const logger: Record<string, unknown> = {};
  logger.debug = emit("debug");
  logger.info = emit("info");
  logger.warn = emit("warn");
  logger.error = emit("error");
  logger.child = () => logger;
  return logger;
}

async function createHarness(): Promise<Harness> {
  const modelRequests: ModelRequest[] = [];
  const notificationsPersisted: string[] = [];
  const registry = new InMemoryRuntimeTaskRegistry();
  const gate: Gate = { holding: false, waiters: [] };
  let agentSeq = 0;
  const sessionStore = asyncProxy<Record<string, unknown>>(
    (prop, args) => {
      if (prop !== "savePart") return;
      const part = args[0] as { text?: string } | undefined;
      if (typeof part?.text === "string" && part.text.includes("<task-notification>")) {
        notificationsPersisted.push(part.text);
      }
    },
    {
      // 会话消息 / todo 读面：turn 收尾需要数组形状（真 store 同款）。
      messages: async () => [],
      readTodos: async () => [],
    },
  );
  const subagentPort = createExploreSubagentPort({
    createAgentId: () => `agent_wake_${String(++agentSeq).padStart(4, "0")}`,
    emitParentEvent: async () => {},
    // 与生产同一条派发（runtime/methods/subagent.ts 的 createDefaultSubagentPort）。
    enqueueParentTaskNotification: (notification) => {
      runtime.enqueueBackgroundTaskNotification({
        originMeta: notification.originMeta,
        taskId: notification.taskId,
        text: notification.text,
        traceContext: notification.traceContext,
      });
      return undefined;
    },
    runtimeTaskRegistry: registry,
    runExploreAgent: async (request) => {
      await request.onSessionReady?.();
      return {
        events: [],
        response: `报告：${request.description} 已完成`,
        traceId: request.traceContext.traceId,
      };
    },
  });
  const runtime = new AgentRuntime(
    PARENT_SESSION_ID as never,
    {
      modelSelection: { providerId: "fake-provider", modelId: "fake-model" },
      modelStreaming: false,
      workingDirectory: process.cwd(),
    } as never,
    {
      eventStore: {
        append: async (event: unknown) => event,
        deleteSession: async () => {},
        getEvents: async () => [],
        getEventsAfter: async () => [],
        getLatestSequenceNumber: async () => 0,
      } as never,
      logger: createCapturingLogger(),
      modelFactory: () =>
        createFakeModel(async (request) => {
          modelRequests.push(request);
          if (!gate.holding) return;
          await new Promise<void>((resolve) => {
            gate.waiters.push(resolve);
          });
        }),
      runtimeTaskRegistry: registry,
      sessionStore,
      subagentPort,
    } as never,
  );
  return { gate, modelRequests, notificationsPersisted, runtime };
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function launchBackgroundChild(
  harness: Harness,
  description: string,
  parentToolCallId: string,
): Promise<void> {
  await harness.runtime.subagentPort?.launch?.(
    {
      agentType: "general-purpose",
      description,
      parentToolCallId,
      prompt: "work",
      runInBackground: true,
      sessionId: PARENT_SESSION_ID as never,
      trace: { traceId: `trace_${parentToolCallId}` } as never,
      workingDirectory: process.cwd(),
      workspaceRoot: process.cwd(),
    },
    {},
  );
}

const carriedAgentIds = (requests: readonly ModelRequest[]): Set<string> => {
  const ids = new Set<string>();
  for (const request of requests) {
    for (const match of JSON.stringify(request.messages).matchAll(
      /<task-id>(agent_[^<]+)<\/task-id>/g,
    )) {
      ids.add(match[1]!);
    }
  }
  return ids;
};

const notificationAgentId = (text: string): string | undefined => /<task-id>([^<]+)</.exec(text)?.[1];

test("空闲父会话：单个后台子 agent 完成后被唤醒（无用户输入）", async () => {
  const harness = await createHarness();
  await launchBackgroundChild(harness, "wake-1", "call_wake_1");
  await settle(2000);

  assert.equal(harness.notificationsPersisted.length, 1, "通知未落到父会话");
  assert.deepEqual(
    [...carriedAgentIds(harness.modelRequests)],
    ["agent_wake_0001"],
    "父会话没有被唤醒（没有任何模型请求带通知正文）",
  );
});

test("空闲父会话：N=12 并发完成后逐条唤醒（批量合并也不许漏）", async () => {
  const harness = await createHarness();
  const total = 12;
  for (let index = 0; index < total; index += 1) {
    await launchBackgroundChild(harness, `wake-${index}`, `call_wake_${index}`);
  }
  await settle(3000);

  const carried = carriedAgentIds(harness.modelRequests);
  const missing = harness.notificationsPersisted
    .map((text) => notificationAgentId(text)!)
    .filter((agentId) => !carried.has(agentId));
  assert.equal(harness.notificationsPersisted.length, total, "有通知未落到父会话");
  assert.deepEqual(missing, [], "有通知没有唤醒父会话");
});

test("busy 父会话：子 agent 在 turn 进行中完成，turn 结束后必须有一次带通知的模型请求", async () => {
  const harness = await createHarness();
  harness.gate.holding = true;
  // 父会话开一轮用户 turn；模型请求被门挂住 ⇒ turn 处于进行中（生产常态）。
  const parentTurn = harness.runtime
    .executeTurn("继续推进", undefined, { inputSource: "user" } as never)
    .catch(() => undefined);
  await settle(300);
  assert.equal(harness.modelRequests.length, 1, "父会话 turn 未进入模型请求");

  await launchBackgroundChild(harness, "wake-during-turn", "call_wake_during");
  await settle(500);

  // 放行父会话 turn：此后没有任何用户输入，也没有别的通知；通知只能靠 runtime 自己送进模型。
  harness.gate.holding = false;
  for (const release of harness.gate.waiters.splice(0)) release();
  await settle(2500);

  assert.deepEqual(
    [...carriedAgentIds(harness.modelRequests)],
    ["agent_wake_0001"],
    "busy 场景下通知没有唤醒父会话",
  );
  await parentTurn;
});
