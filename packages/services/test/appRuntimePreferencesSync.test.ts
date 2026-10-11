// App 运行时偏好同步的单元断言（卡 #204/A3）：
// 1) normalizeAppRuntimePreferences 对新实验字段 fail-closed（只认显式 true）；
// 2) syncWorkspaceAppRuntimePreferences 的字段↔方法映射、调用顺序与 method-not-found 兼容
//    （interaction 必备；modelIo / askMattFlow 旧 CLI 缺方法时降级，其他失败上抛）；
// 3) 跨包合同：ask-matt 载荷必须能过服务端实际使用的共享 strict params schema。
//    这里刻意不 deepEqual 实现的载荷形状——那与实现同义反复，两侧各自自洽时不会红
//    （F1 逃逸根因）。判据真源 = @zcode/shared 的 strict schema（server handler 用它 parseParams）。
// 假 client 只实现 request 一个边界，记录 method/params 供断言。

import assert from "node:assert/strict";
import test from "node:test";
import {
  zcodeProtocolMethods,
  zcodeWorkspaceUpdateAskMattFlowPreferencesParamsSchema,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type { z } from "zod";
import {
  isProtocolMethodNotFoundError,
  normalizeAppRuntimePreferences,
  syncWorkspaceAppRuntimePreferences,
  type SyncWorkspaceAppRuntimePreferencesParams,
} from "../src/zcode-agent/appRuntimePreferencesSync.js";

const workspace: ZCodeWorkspaceRef = {
  workspaceKey: "ws-ask-matt",
  workspacePath: "/tmp/ws-ask-matt",
};

interface RecordedRequest {
  method: string;
  params: unknown;
}

function recordingClient(
  requests: RecordedRequest[],
  failingMethods: ReadonlyMap<string, Error> = new Map(),
): SyncWorkspaceAppRuntimePreferencesParams["client"] {
  return {
    async request<T>(
      method: Parameters<SyncWorkspaceAppRuntimePreferencesParams["client"]["request"]>[0],
      params?: unknown,
      _resultSchema?: z.ZodType<T>,
    ): Promise<T> {
      requests.push({ method, params });
      const failure = failingMethods.get(method);
      if (failure) throw failure;
      // 假 client 不校验结果 schema；成功路径返回 undefined 即视为 Host 已接受。
      return undefined as T;
    },
  };
}

test("normalize：ask-matt 字段 fail-closed，其他字段保持既有判据", () => {
  assert.equal(
    normalizeAppRuntimePreferences({ askUserQuestionAutoResolutionEnabled: true })
      .askMattFlowEnabled,
    false,
  );
  assert.equal(
    normalizeAppRuntimePreferences({
      askUserQuestionAutoResolutionEnabled: true,
      askMattFlowEnabled: true,
    }).askMattFlowEnabled,
    true,
  );
  assert.equal(
    normalizeAppRuntimePreferences({
      askUserQuestionAutoResolutionEnabled: false,
      askMattFlowEnabled: false,
      modelIoFullRetentionEnabled: true,
    }).modelIoFullRetentionEnabled,
    true,
  );
});

test("同步成功：依次发 interaction → modelIo → askMattFlow，ask-matt 载荷带 enabled", async () => {
  const requests: RecordedRequest[] = [];
  await syncWorkspaceAppRuntimePreferences({
    client: recordingClient(requests),
    preferences: {
      askUserQuestionAutoResolutionEnabled: true,
      askMattFlowEnabled: true,
      modelIoFullRetentionEnabled: false,
    },
    workspace,
  });

  assert.deepEqual(
    requests.map((request) => request.method),
    [
      "workspace/updateInteractionPreferences",
      zcodeProtocolMethods.workspaceUpdateModelIoPreferences,
      zcodeProtocolMethods.workspaceUpdateAskMattFlowPreferences,
    ],
  );
  // 合同判据走共享 strict schema（服务端 parseParams 的同一条），不 deepEqual 实现形状：
  // 两侧分歧时必须在这里红，而不是两侧各自绿。
  const askMattParams = zcodeWorkspaceUpdateAskMattFlowPreferencesParamsSchema.parse(
    requests[2]?.params,
  );
  assert.equal(askMattParams.enabled, true, "偏好开 → enabled=true（只认显式 true 的归一化）");
  assert.deepEqual(askMattParams.workspace, workspace);
});

test("跨包合同：ask-matt 载荷过共享 strict params schema；旧 preferences 形状被同一 schema 拒绝", async () => {
  const requests: RecordedRequest[] = [];
  await syncWorkspaceAppRuntimePreferences({
    client: recordingClient(requests),
    preferences: { askUserQuestionAutoResolutionEnabled: true, askMattFlowEnabled: true },
    workspace,
  });
  const askMattParams = requests.find(
    (request) => request.method === zcodeProtocolMethods.workspaceUpdateAskMattFlowPreferences,
  )?.params;

  const parsed = zcodeWorkspaceUpdateAskMattFlowPreferencesParamsSchema.safeParse(askMattParams);
  assert.equal(
    parsed.success,
    true,
    `客户端真实载荷必须被服务端共享 schema 接受（F1：-32602 使开态不可达），实收 ${JSON.stringify(askMattParams)}`,
  );

  // 反向腿：schema 是 strict 的（F1 复现锚点）。旧形状 {preferences:{...}} 必须被拒收，
  // 否则本用例会被「schema 放行一切」的实现蒙混过关。
  const legacyShape = { workspace, preferences: { askMattFlowEnabled: true } };
  const legacy = zcodeWorkspaceUpdateAskMattFlowPreferencesParamsSchema.safeParse(legacyShape);
  assert.equal(legacy.success, false, "旧 preferences 形状必须被 strict schema 拒绝（-32602）");

  // fail-closed 腿：偏好未显式给 askMattFlowEnabled 时，载荷仍须是 schema 合法的 enabled=false，
  // 不能是缺字段/undefined（strict schema 下同样 -32602）。
  const disabledRequests: RecordedRequest[] = [];
  await syncWorkspaceAppRuntimePreferences({
    client: recordingClient(disabledRequests),
    preferences: { askUserQuestionAutoResolutionEnabled: true },
    workspace,
  });
  const disabledParams = zcodeWorkspaceUpdateAskMattFlowPreferencesParamsSchema.parse(
    disabledRequests.find(
      (request) => request.method === zcodeProtocolMethods.workspaceUpdateAskMattFlowPreferences,
    )?.params,
  );
  assert.equal(disabledParams.enabled, false, "未设置 → enabled=false（fail-closed）");
});

test("兼容：旧 CLI 对 ask-matt 方法 method-not-found 时降级，其他失败上抛", async () => {
  const tolerated: RecordedRequest[] = [];
  const methodNotFound = Object.assign(new Error("Method not found"), { code: -32601 });
  await syncWorkspaceAppRuntimePreferences({
    client: recordingClient(
      tolerated,
      new Map([[zcodeProtocolMethods.workspaceUpdateAskMattFlowPreferences, methodNotFound]]),
    ),
    preferences: { askUserQuestionAutoResolutionEnabled: true },
    workspace,
  });
  assert.equal(
    tolerated.filter(
      (request) => request.method === zcodeProtocolMethods.workspaceUpdateAskMattFlowPreferences,
    ).length,
    1,
    "method-not-found 只降级不重试",
  );
  assert.ok(isProtocolMethodNotFoundError(methodNotFound));

  const fatal = Object.assign(new Error("Host rejected"), { code: -32602 });
  await assert.rejects(
    syncWorkspaceAppRuntimePreferences({
      client: recordingClient(
        [],
        new Map([[zcodeProtocolMethods.workspaceUpdateAskMattFlowPreferences, fatal]]),
      ),
      preferences: { askUserQuestionAutoResolutionEnabled: true },
      workspace,
    }),
    /Host rejected/,
    "非 method-not-found 的同步失败必须上抛（不能静默丢开关）",
  );

  // interaction 是必备方法：它失败时整个同步失败，不进入后续方法。
  const interactionRequests: RecordedRequest[] = [];
  await assert.rejects(
    syncWorkspaceAppRuntimePreferences({
      client: recordingClient(
        interactionRequests,
        new Map([[zcodeProtocolMethods.workspaceUpdateInteractionPreferences, fatal]]),
      ),
      preferences: { askUserQuestionAutoResolutionEnabled: true },
      workspace,
    }),
    /Host rejected/,
  );
  assert.equal(interactionRequests.length, 1);
});
