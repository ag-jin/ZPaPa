import assert from "node:assert/strict";
import test from "node:test";
import { IZCodeTaskService, ServiceCollection } from "@zcode/services";
import { createWindowRemoteConnectionRegistry } from "../src/host/windowRemoteConnectionRegistry.js";
import { resolveRemoteControllerSource } from "../src/host/windowRemoteControllerSource.js";
import { createWindowHostControllerRuntime } from "../src/host/windowHostControllerService.js";

/**
 * 一台被投射设备的 workspace 绑定必须是**列表**，不能是单值。
 *
 * 逆推（出处见 CONTEXT.md「Single Device Scope」）：
 *   「首版只支持同时连接一台被投射设备；**数据结构按列表存**（将来增设备不需重构）」
 *   + 「Projection Scope：投射端显示哪些被投射设备的项目，由投射端用户在设置页勾选决定」
 * ⇒ 同一设备的多个已绑定项目都要能被解析到同一个 logical session；只有"从未绑定"的
 *   项目才必须解析失败（fail-closed，绝不能回落本地库）。
 *
 * 这是实机缺陷「同一设备多项目时无法归档」的根因所在：绑定被覆盖成单值后，
 * 非当前绑定项目的写操作解析不到 source，被 resolveTaskAddress 拒绝。
 */

const DEVICE = {
  kind: "ssh" as const,
  host: "device-s",
  port: 22,
  username: "user",
};
const P1 = "/s/proj-1";
const P2 = "/s/proj-2";
const P3 = "/s/proj-3";
const I1 = "remote:ssh:device-s:22:user:/s/proj-1";
const I2 = "remote:ssh:device-s:22:user:/s/proj-2";
const I3 = "remote:ssh:device-s:22:user:/s/proj-3";

function createRegistry() {
  const closes: Array<() => void> = [];
  const registry = createWindowRemoteConnectionRegistry<{ marker: string }>({
    createId: (() => {
      let n = 0;
      return () => `sess-${++n}`;
    })(),
    connect: async () => ({
      services: { marker: "device-services" },
      dispose: () => undefined,
      onDidClose: (
        listener: (event: { exitCode: number | null; signal: string | null }) => void,
      ) => {
        closes.push(() => listener({ exitCode: 0, signal: null }));
        return { dispose: () => undefined };
      },
    }),
  });
  return { registry, closes };
}

async function connectAndBind() {
  const { registry, closes } = createRegistry();
  const descriptor = await registry.connect({
    requestId: "req-1",
    target: DEVICE,
    remoteAssets: {},
    workspacePath: P1,
    workspaceIdentity: I1,
  });
  const remoteSessionId = descriptor.remoteSessionId;
  await registry.bindWorkspaceContext({
    remoteSessionId,
    workspacePath: P2,
    workspaceIdentity: I2,
  });
  return { registry, closes, remoteSessionId };
}

test("已绑定过但非当前的 workspace 仍能解析到同一个 logical session", async () => {
  const { registry, remoteSessionId } = await connectAndBind();
  const matched = registry.findSessionForWorkspace({ workspacePath: P1, workspaceIdentity: I1 });
  assert.ok(matched, "绑定过 P1、后又绑定 P2，P1 必须仍可解析（列表形态，不是单值覆盖）");
  assert.equal(matched.remoteSessionId, remoteSessionId);
  assert.equal(
    matched.workspacePath,
    P1,
    "返回的必须是**被请求的**那个 workspace 上下文，而不是 session 的当前绑定 —— 否则调用方会拿到错项目的 scope",
  );
  assert.equal(matched.workspaceIdentity, I1);
});

test("当前绑定的 workspace 仍能解析（切回即用）", async () => {
  const { registry } = await connectAndBind();
  const matched = registry.findSessionForWorkspace({ workspacePath: P2, workspaceIdentity: I2 });
  assert.ok(matched);
  assert.equal(matched.workspacePath, P2);
  assert.equal(matched.workspaceIdentity, I2);
});

test("从未绑定的项目解析失败（fail-closed，绝不回落本地库）", async () => {
  const { registry } = await connectAndBind();
  assert.equal(
    registry.findSessionForWorkspace({ workspacePath: P3, workspaceIdentity: I3 }),
    null,
  );
});

test("设备级 services 对任意已绑定 workspace 都可用；未绑定的照样拒绝", async () => {
  const { registry, remoteSessionId } = await connectAndBind();
  assert.equal(
    (
      registry.resolveScopedServices({
        kind: "remote",
        remoteSessionId,
        workspacePath: P1,
        workspaceIdentity: I1,
      }) as { marker: string }
    ).marker,
    "device-services",
    "attachment 是设备粒度的：同设备的非当前项目也必须能取到 services",
  );
  assert.throws(
    () =>
      registry.resolveScopedServices({
        kind: "remote",
        remoteSessionId,
        workspacePath: P3,
        workspaceIdentity: I3,
      }),
    /不匹配/,
    "从未绑定的项目不得解析出 services",
  );
});

/**
 * 组合用例（本文件最重的一格）：真实 registry + 真实 source 胶水 + Controller runtime，
 * 只把"对端服务面"换成替身。它证明的不是某一层，而是**三层拼起来之后**：
 * 设备绑定着 P2 时，对 P1 的会话归档仍能到达对端、且以 P1（对端自己的键）落库。
 */
test("组合：设备当前绑定 P2 时，P1 的会话归档仍落到对端（修复后的真实链路）", async () => {
  const calls: Array<{ method: string; request: Record<string, unknown> }> = [];
  const peerTask = {
    taskId: "sess_proj_1",
    title: "P1 的会话",
    workspacePath: P1,
    status: "completed",
    createdAt: 1,
    updatedAt: 2,
    provider: "zcode-agent",
    mode: "coding",
    pinned: false,
    archived: false,
  };
  const peer = {
    async listTasks(request: Record<string, unknown>) {
      calls.push({ method: "listTasks", request });
      return peerTask.archived ? [] : [{ ...peerTask }];
    },
    async listPinnedTasks(request: Record<string, unknown>) {
      calls.push({ method: "listPinnedTasks", request });
      return [];
    },
    async listArchivedTasks(request: Record<string, unknown>) {
      calls.push({ method: "listArchivedTasks", request });
      return peerTask.archived ? [{ ...peerTask }] : [];
    },
    async archiveTask(request: Record<string, unknown>) {
      calls.push({ method: "archiveTask", request });
      peerTask.archived = true;
      return { ...peerTask };
    },
  };
  const services = new ServiceCollection().register(
    IZCodeTaskService,
    peer as unknown as IZCodeTaskService,
  );
  const registry = createWindowRemoteConnectionRegistry<ServiceCollection>({
    createId: (() => {
      let n = 0;
      return () => `sess-${++n}`;
    })(),
    connect: async () => ({ services, dispose: () => undefined }),
  });
  const descriptor = await registry.connect({
    requestId: "req-1",
    target: DEVICE,
    remoteAssets: {},
    workspacePath: P2,
    workspaceIdentity: I2,
  });
  const remoteSessionId = descriptor.remoteSessionId;
  // 设备先绑定 P2（切走），再对 P1 的会话做归档 —— 实机缺陷正是这一格。
  await registry.bindWorkspaceContext({
    remoteSessionId,
    workspacePath: P1,
    workspaceIdentity: I1,
  });
  await registry.bindWorkspaceContext({
    remoteSessionId,
    workspacePath: P2,
    workspaceIdentity: I2,
  });

  const runtime = createWindowHostControllerRuntime({
    createId: (() => {
      let n = 0;
      return () => `rt-${++n}`;
    })(),
    resolveSource: (scope: { workspacePath: string; workspaceIdentity?: string }) =>
      resolveRemoteControllerSource({ scope, registry }),
  });

  const address = await runtime.resolveTaskAddress({
    taskId: peerTask.taskId,
    workspacePath: P1,
    workspaceIdentity: I1,
    attachmentScope: {
      kind: "remote",
      remoteSessionId,
      workspacePath: P2,
      workspaceIdentity: I2,
    },
  });
  await runtime.service.mutateTask({
    address: address as never,
    mutation: { kind: "archive", archived: true } as never,
  });

  const archiveCall = calls.find((call) => call.method === "archiveTask");
  assert.ok(
    archiveCall,
    `非当前绑定项目的归档必须到达对端（实际调用: ${calls.map((c) => c.method).join(", ")}）`,
  );
  assert.equal(archiveCall.request.workspacePath, P1, "对端必须按自己的键（P1）落库");
  assert.equal(archiveCall.request.workspaceIdentity, undefined, "不得透传本端 identity");
});

test("绑定不丢历史：会话快照同时给出当前绑定与全部已绑定 workspace", async () => {
  const { registry, remoteSessionId } = await connectAndBind();
  const session = registry.getSession(remoteSessionId);
  assert.ok(session);
  assert.equal(session.workspacePath, P2, "当前绑定 = 最后一次 bind 的项目");
  assert.deepEqual(
    (session.boundWorkspaces ?? []).map((entry) => entry.workspacePath).sort(),
    [P1, P2],
    "解绑/收口需要按列表拿到该设备的全部已绑定项目（断开时一起收口）",
  );
});
