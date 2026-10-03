import assert from "node:assert/strict";
import test from "node:test";
import { createWindowHostControllerRuntime } from "../src/host/windowHostControllerService.js";

/**
 * 同一设备多项目时，写操作的作用域矩阵（穷举；每一格直接是一个用例）。
 *
 * 背景（实机缺陷，2026-10-03）：A 同时投射同一台设备 B 上的两个项目时，
 * 对「非当前绑定项目」的会话做归档等写操作会被 host 拒绝：
 *   zcode-task.archiveTask FAIL "列表 mutation 与 remote attachment scope 不匹配"
 * 当天 archiveTask 0 成功 / 2 失败，setTaskUnread 253 失败 / 10 成功。
 *
 * 根因：一台被投射设备只有一个 logical session，其 workspace 绑定是**单值**
 * （bindWorkspaceContext 覆盖），而投射端只有一份设备级 services —— 所有项目共用
 * 一个 attachment，该 attachment 的 scope 是"最后绑定的那个项目"。
 * resolveTaskAddress 又把 attachmentScope 与请求参数做严格相等比较，于是写任何
 * 非当前绑定项目的会话都被 fail-closed 拒绝。
 *
 * 不变量（每一格最终都断言它）：**写操作只要落在同一台设备上就必须放行，并且到达
 * 对端 taskService 的参数必须是对端自己的键（workspacePath），不带本端 identity。**
 *
 * 逆推出的要求见本目录同名说明；矩阵覆盖：
 *   目标归属 × 操作（25 格）· attachment 种类边界（含本地不得被剥离）· 未绑定/跨设备
 *   必须仍然 fail-closed。
 */

// ── 设备与项目的固定件 ──
const DEVICE_S = "dev-S";
const DEVICE_T = "dev-T";
const P1 = "/s/proj-1"; // 设备 S：当前绑定
const P2 = "/s/proj-2"; // 设备 S：已绑定但非当前
const P3 = "/s/proj-3"; // 设备 S：从未绑定
const P4 = "/t/proj-4"; // 设备 T：已绑定
const LOCAL = "/local/proj";

function identity(device: string, projectPath: string): string {
  return `remote:ssh:${device.toLowerCase()}:22:user:${projectPath}`;
}
const I1 = identity(DEVICE_S, P1);
const I2 = identity(DEVICE_S, P2);
const I3 = identity(DEVICE_S, P3);
const I4 = identity(DEVICE_T, P4);
const LOCAL_IDENTITY = "project-identity-local";

type PeerTask = {
  taskId: string;
  title: string;
  workspacePath: string;
  status: "completed";
  createdAt: number;
  updatedAt: number;
  provider: "zcode-agent";
  mode: "coding";
  pinned: boolean;
  archived: boolean;
  unreadAt?: number;
};

/**
 * 对端（设备）的假 taskService：**按对端自己的键（workspacePath）存取**，
 * 归档后移出默认列表、进归档列表 —— 与真实 B 的 tasks-index 行为同口径。
 */
function createPeerDevice(projectPath: string, taskId: string) {
  const calls: Array<{ method: string; request: Record<string, unknown> }> = [];
  const task: PeerTask = {
    taskId,
    title: `远端会话 ${projectPath}`,
    workspacePath: projectPath,
    status: "completed",
    createdAt: 1,
    updatedAt: 2,
    provider: "zcode-agent",
    mode: "coding",
    pinned: false,
    archived: false,
  };
  const record = (method: string, request: unknown) => {
    calls.push({ method, request: request as Record<string, unknown> });
  };
  const service = {
    async listTasks(request: Record<string, unknown>) {
      record("listTasks", request);
      return task.archived ? [] : [{ ...task }];
    },
    async listPinnedTasks(request: Record<string, unknown>) {
      record("listPinnedTasks", request);
      return task.pinned && !task.archived ? [{ ...task }] : [];
    },
    async listArchivedTasks(request: Record<string, unknown>) {
      record("listArchivedTasks", request);
      return task.archived ? [{ ...task }] : [];
    },
    async setTaskPinned(request: Record<string, unknown> & { pinned: boolean }) {
      record("setTaskPinned", request);
      task.pinned = request.pinned;
      return { ...task };
    },
    async archiveTask(request: Record<string, unknown>) {
      record("archiveTask", request);
      task.archived = true;
      return { ...task };
    },
    async unarchiveTask(request: Record<string, unknown>) {
      record("unarchiveTask", request);
      task.archived = false;
      return { ...task };
    },
    async deleteTask(request: Record<string, unknown>) {
      record("deleteTask", request);
      task.archived = true;
      return true;
    },
    async deleteArchivedTask(request: Record<string, unknown>) {
      record("deleteArchivedTask", request);
      return true;
    },
    async deleteArchivedTasks(request: Record<string, unknown>) {
      record("deleteArchivedTasks", request);
      return { deletedTaskIds: [task.taskId], skippedTaskIds: [], failedTaskIds: [] };
    },
    async setTaskUnread(request: Record<string, unknown> & { unread: boolean }) {
      record("setTaskUnread", request);
      return { ...task, unreadAt: request.unread ? 3 : undefined };
    },
  };
  return { calls, service, task };
}

function createLocalDevice() {
  const calls: Array<{ method: string; request: Record<string, unknown> }> = [];
  const service = {
    async listTasks() {
      return [
        {
          taskId: "sess_local_1",
          title: "本地会话",
          workspacePath: LOCAL,
          workspaceIdentity: LOCAL_IDENTITY,
          status: "completed",
          createdAt: 1,
          updatedAt: 2,
          provider: "zcode-agent",
          mode: "coding",
          pinned: false,
          archived: false,
        },
      ];
    },
    async listPinnedTasks() {
      return [];
    },
    async listArchivedTasks() {
      return [];
    },
    async setTaskPinned(request: Record<string, unknown>) {
      calls.push({ method: "setTaskPinned", request });
      return { taskId: "sess_local_1" };
    },
    async archiveTask(request: Record<string, unknown>) {
      calls.push({ method: "archiveTask", request });
      return { taskId: "sess_local_1" };
    },
    async unarchiveTask(request: Record<string, unknown>) {
      calls.push({ method: "unarchiveTask", request });
      return { taskId: "sess_local_1" };
    },
    async deleteTask(request: Record<string, unknown>) {
      calls.push({ method: "deleteTask", request });
      return true;
    },
    async setTaskUnread(request: Record<string, unknown>) {
      calls.push({ method: "setTaskUnread", request });
      return { taskId: "sess_local_1" };
    },
  };
  return { calls, service };
}

/**
 * 组装 harness：设备 S 绑定 {P1(当前), P2}，设备 T 绑定 {P4}。
 *
 * resolveSource 刻意与修复后的真实 host 同形：**按"该设备已绑定的 workspace 列表"
 * 解析**（identity 唯一定位项目），已绑定 → 返回该项目的远程 scope 与设备级
 * taskService；未绑定/跨设备的 remote identity → null（fail-closed）。
 */
function createHarness() {
  const s1 = createPeerDevice(P1, "sess_s1");
  const s2 = createPeerDevice(P2, "sess_s2");
  const t4 = createPeerDevice(P4, "sess_t4");
  const local = createLocalDevice();
  // 已知但"从未绑定"的项目：没有 peer 记录可查 —— 解析必须直接失败，不能猜。
  const bound = new Map<
    string,
    { device: string; path: string; peer: ReturnType<typeof createPeerDevice> }
  >([
    [I1, { device: DEVICE_S, path: P1, peer: s1 }],
    [I2, { device: DEVICE_S, path: P2, peer: s2 }],
    [I4, { device: DEVICE_T, path: P4, peer: t4 }],
  ]);

  const runtime = createWindowHostControllerRuntime({
    createId: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
    resolveSource: (scope: { workspacePath: string; workspaceIdentity?: string }) => {
      const hit = scope.workspaceIdentity ? bound.get(scope.workspaceIdentity) : undefined;
      if (hit) {
        return {
          scope: {
            kind: "remote" as const,
            remoteSessionId: hit.device,
            workspacePath: hit.path,
            workspaceIdentity: scope.workspaceIdentity!,
          },
          taskService: hit.peer.service as never,
          sourceAvailability: "online" as const,
        };
      }
      if (scope.workspaceIdentity && scope.workspaceIdentity.startsWith("remote:")) {
        // 未绑定的远程项目：绝不回落本地库。
        return null;
      }
      return {
        scope: {
          kind: "local" as const,
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
        },
        taskService: local.service as never,
        sourceAvailability: "online" as const,
      };
    },
  });

  return { runtime, s1, s2, t4, local };
}

const DEVICE_S_ATTACHMENT = {
  kind: "remote" as const,
  remoteSessionId: DEVICE_S,
  workspacePath: P1, // 设备 S 此刻绑定的是 P1
  workspaceIdentity: I1,
};
const LOCAL_ATTACHMENT = { kind: "local" as const };

/**
 * 复刻真实 RPC 形状：写操作必然先经 `resolveTaskAddress` 再 `mutateTask`
 * （`createControllerRoutedTaskService` 的 route() 就是这两步；实机日志的抛错点也在
 * resolveTaskAddress）。夹具若直接喂 address，会绕过被测的那道校验。
 */
async function runWrite(
  runtime: ReturnType<typeof createHarness>["runtime"],
  params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    attachmentScope: { kind: "local" } | typeof DEVICE_S_ATTACHMENT;
    mutation: unknown;
  },
): Promise<unknown> {
  const address = await runtime.resolveTaskAddress({
    taskId: params.taskId,
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    attachmentScope: params.attachmentScope as never,
  });
  return runtime.service.mutateTask({
    address: address as never,
    mutation: params.mutation as never,
  });
}

const OPERATIONS = [
  { op: "pin", mutation: { kind: "pin", pinned: true }, expectMethod: "setTaskPinned" },
  { op: "archive", mutation: { kind: "archive", archived: true }, expectMethod: "archiveTask" },
  {
    op: "unarchive",
    mutation: { kind: "archive", archived: false },
    expectMethod: "unarchiveTask",
  },
  { op: "delete", mutation: { kind: "delete" }, expectMethod: "deleteTask" },
  { op: "mark-read", mutation: { kind: "mark-read" }, expectMethod: "setTaskUnread" },
] as const;

/** 目标归属：矩阵的行。 */
const TARGETS = [
  {
    id: "当前绑定项目",
    workspacePath: P1,
    workspaceIdentity: I1,
    remoteSessionId: DEVICE_S,
    peer: "s1" as const,
    allowed: true,
  },
  {
    id: "同设备已绑定但非当前项目",
    workspacePath: P2,
    workspaceIdentity: I2,
    remoteSessionId: DEVICE_S,
    peer: "s2" as const,
    allowed: true,
  },
  {
    id: "同设备从未绑定项目",
    workspacePath: P3,
    workspaceIdentity: I3,
    remoteSessionId: DEVICE_S,
    peer: null,
    allowed: false,
  },
  {
    id: "另一台设备的项目",
    workspacePath: P4,
    workspaceIdentity: I4,
    remoteSessionId: DEVICE_T,
    peer: "t4" as const,
    allowed: false,
  },
] as const;

/** 穷举：4 种目标归属 × 5 种写操作 = 20 格，每格一个用例（经远程 attachment）。 */
for (const target of TARGETS) {
  for (const { op, mutation, expectMethod } of OPERATIONS) {
    const expectation = target.allowed ? "必须放行" : "必须 fail-closed 拒绝";
    test(`远程 attachment × ${target.id} × ${op}：${expectation}`, async () => {
      const { runtime, s1, s2, t4 } = createHarness();
      const peers = { s1, s2, t4 };
      const taskId = target.peer ? peers[target.peer].task.taskId : "sess_unknown";
      const cell = {
        taskId,
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        attachmentScope: DEVICE_S_ATTACHMENT,
        mutation,
      };

      if (!target.allowed) {
        await assert.rejects(runWrite(runtime, cell), (error: Error) => {
          assert.match(
            error.message,
            /没有与任务地址匹配的 source|列表 mutation/,
            `${op} 应 fail-closed，实际: ${error.message}`,
          );
          return true;
        });
        for (const peer of Object.values(peers)) {
          assert.equal(
            peer.calls.filter((call) => call.method === expectMethod).length,
            0,
            `${op} 被拒绝时不得有任何对端写调用`,
          );
        }
        return;
      }

      await runWrite(runtime, cell);

      const peer = peers[target.peer as "s1" | "s2" | "t4"];
      const call = peer.calls.find((entry) => entry.method === expectMethod);
      assert.ok(
        call,
        `应调用对端 ${expectMethod}（实际: ${peer.calls.map((c) => c.method).join(", ")}）`,
      );
      assert.equal(
        call.request.workspacePath,
        target.workspacePath,
        "对端必须按**自己的键**（项目路径）落库",
      );
      assert.equal(
        call.request.workspaceIdentity,
        undefined,
        "写路径不得把本端 remote identity 透传给对端（Index Isolation）",
      );
      assert.equal(call.request.taskId, taskId, "应带对端会话 id");
    });
  }
}

/** 穷举：本地 attachment 的边界格 —— 本地项目不得被"剥离 identity"扩大化，远程未绑定仍拒绝。 */
const LOCAL_ATTACHMENT_CELLS = [
  {
    id: "本地项目",
    workspacePath: LOCAL,
    workspaceIdentity: LOCAL_IDENTITY,
    allowed: true,
    expectIdentityPreserved: true,
  },
  {
    id: "远程当前绑定项目",
    workspacePath: P1,
    workspaceIdentity: I1,
    allowed: true,
    expectIdentityPreserved: false,
  },
  {
    id: "远程未绑定项目",
    workspacePath: P3,
    workspaceIdentity: I3,
    allowed: false,
    expectIdentityPreserved: false,
  },
] as const;

for (const cell of LOCAL_ATTACHMENT_CELLS) {
  test(`本地 attachment × ${cell.id} × archive：${cell.allowed ? "必须放行" : "必须拒绝"}`, async () => {
    const { runtime, s1, local } = createHarness();
    const write = {
      taskId: cell.expectIdentityPreserved ? "sess_local_1" : s1.task.taskId,
      workspacePath: cell.workspacePath,
      workspaceIdentity: cell.workspaceIdentity,
      attachmentScope: LOCAL_ATTACHMENT,
      mutation: { kind: "archive", archived: true },
    };

    if (!cell.allowed) {
      await assert.rejects(runWrite(runtime, write), /没有与任务地址匹配的 source|列表 mutation/);
      assert.equal(
        s1.calls.filter((call) => call.method === "archiveTask").length,
        0,
        "被拒绝时不得写到对端",
      );
      return;
    }

    const target = cell.expectIdentityPreserved ? local : s1;
    await runWrite(runtime, write);
    const call = target.calls.find((entry) => entry.method === "archiveTask");
    assert.ok(call, "应调用 archiveTask");
    if (cell.expectIdentityPreserved) {
      assert.equal(
        call.request.workspaceIdentity,
        LOCAL_IDENTITY,
        "本地 source 的 identity 是真实归属，必须原样保留",
      );
    } else {
      assert.equal(
        call.request.workspaceIdentity,
        undefined,
        "远程 source 的写路径必须剥离本端 identity",
      );
    }
  });
}

/** 归档删除（走同一个 resolveTaskAddress）也不得被多项目作用域挡住。 */
test("远程 attachment × 同设备非当前项目 × 删除归档会话：必须放行", async () => {
  const { runtime, s2 } = createHarness();
  s2.task.archived = true;
  const address = await runtime.resolveTaskAddress({
    taskId: s2.task.taskId,
    workspacePath: P2,
    workspaceIdentity: I2,
    attachmentScope: DEVICE_S_ATTACHMENT as never,
    allowMissingTask: true,
  });
  await runtime.service.deleteArchivedTask({ address: address as never });
  const call = s2.calls.find((entry) => entry.method === "deleteArchivedTask");
  assert.ok(
    call,
    `应调用对端 deleteArchivedTask（实际: ${s2.calls.map((c) => c.method).join(", ")}）`,
  );
  assert.equal(call.request.workspacePath, P2, "对端必须按自己的键（项目路径）落库");
  assert.equal(call.request.workspaceIdentity, undefined, "不得透传本端 identity");
});
