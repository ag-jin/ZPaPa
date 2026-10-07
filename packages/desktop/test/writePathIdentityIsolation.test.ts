import assert from "node:assert/strict";
import test from "node:test";
import { createWindowHostControllerRuntime } from "../src/host/windowHostControllerService.js";

/**
 * 写路径的 identity 隔离契约。
 *
 * 与 `remoteSessionVisibility.test.ts`（读路径）对称 —— 同一个约束的两面：
 * **本端为远程工作区起的隔离标签 `remote:<kind>:...:path` 不得跨机传给对端。**
 *
 * 读路径在 60d1b9e 已修（远程 source 只按 workspacePath 查对端）。写路径此前未修：
 * 用户对投射条目做置顶/归档/删除时，本端 identity 被原样发给对端 taskService，
 * 对端按一个它从未写过的键落库，产生一条永远不该存在的重复行。用户视角是同一
 * 会话在设备列表里出现两次。
 *
 * 实测证据（修复前，B 的 tasks-index）：
 *   remote:ssh:100.66.1.2:22:linguojin:/Volumes/数据盘/网站/新赛马 | sess_8c8af48f-...
 *   remote:ssh:100.66.1.2:22:linguojin:/Volumes/数据盘/网站/新赛马 | sess_e38c8742-...
 *
 * 本测试用 fake taskService 断言写操作参数形状，不依赖真实设备。
 */
const remoteScope = {
  kind: "remote" as const,
  remoteSessionId: "remote-session-1",
  workspacePath: "/remote/project",
  workspaceIdentity: "remote:ssh:host:22:user:/remote/project",
};

function createHarness() {
  const calls: Array<{ method: string; request: Record<string, unknown> }> = [];
  const remoteTaskService = {
    async listTasks(request: Record<string, unknown>) {
      calls.push({ method: "listTasks", request });
      return [
        {
          taskId: "sess_remote_1",
          title: "远端会话",
          workspacePath: "/remote/project",
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
    async listPinnedTasks(request: Record<string, unknown>) {
      calls.push({ method: "listPinnedTasks", request });
      return [];
    },
    async listArchivedTasks(request: Record<string, unknown>) {
      calls.push({ method: "listArchivedTasks", request });
      return [];
    },
    async listTaskList(request: Record<string, unknown>) {
      calls.push({ method: "listTaskList", request });
      return { items: [], total: 0, hasMore: false };
    },
    // 写操作：记录参数形状即可，返回值只需满足类型。
    async setTaskPinned(request: Record<string, unknown>) {
      calls.push({ method: "setTaskPinned", request });
      return { taskId: "sess_remote_1" };
    },
    async archiveTask(request: Record<string, unknown>) {
      calls.push({ method: "archiveTask", request });
      return { taskId: "sess_remote_1" };
    },
    async unarchiveTask(request: Record<string, unknown>) {
      calls.push({ method: "unarchiveTask", request });
      return { taskId: "sess_remote_1" };
    },
    async deleteTask(request: Record<string, unknown>) {
      calls.push({ method: "deleteTask", request });
      return true;
    },
    async setTaskUnread(request: Record<string, unknown>) {
      calls.push({ method: "setTaskUnread", request });
      return { taskId: "sess_remote_1" };
    },
  };

  const runtime = createWindowHostControllerRuntime({
    createId: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
    resolveSource: (scope) =>
      scope.workspaceIdentity === remoteScope.workspaceIdentity
        ? {
            scope: remoteScope,
            taskService: remoteTaskService as never,
            sourceAvailability: "online" as const,
          }
        : null,
  });

  return { runtime, calls };
}

/**
 * 走一次列表查询，让投影登记 source 与行。
 *
 * 投影的 mutate 会先校验"地址能匹配到已登记的 source 且行存在"，跳过这步会
 * 直接抛「没有与任务地址匹配的 source」—— 那是测试夹具搭建问题，不是被测行为。
 */
async function primeProjection(runtime: ReturnType<typeof createHarness>["runtime"]) {
  await runtime.service.listTaskList({
    kind: "timeline",
    workspaceScopes: [
      {
        workspacePath: remoteScope.workspacePath,
        workspaceIdentity: remoteScope.workspaceIdentity,
      },
    ],
    sortBy: "updated",
  });
}

/** UI 传来的远程地址：schema 要求 remote address 必须带 identity。 */
const remoteAddress = {
  taskId: "sess_remote_1",
  workspacePath: remoteScope.workspacePath,
  workspaceIdentity: remoteScope.workspaceIdentity,
  remoteSessionId: remoteScope.remoteSessionId,
};

const mutations: Array<{ name: string; mutation: unknown; expectMethod: string }> = [
  { name: "pin", mutation: { kind: "pin", pinned: true }, expectMethod: "setTaskPinned" },
  { name: "archive", mutation: { kind: "archive", archived: true }, expectMethod: "archiveTask" },
  {
    name: "unarchive",
    mutation: { kind: "archive", archived: false },
    expectMethod: "unarchiveTask",
  },
  { name: "delete", mutation: { kind: "delete" }, expectMethod: "deleteTask" },
  { name: "mark-read", mutation: { kind: "mark-read" }, expectMethod: "setTaskUnread" },
];

for (const { name, mutation, expectMethod } of mutations) {
  test(`写操作 ${name} 不发本端 remote identity 给对端`, async () => {
    const { runtime, calls } = createHarness();
    await primeProjection(runtime);
    await runtime.service.mutateTask({
      address: remoteAddress,
      mutation: mutation as never,
    });

    const target = calls.find((call) => call.method === expectMethod);
    assert.ok(
      target,
      `应调用对端 ${expectMethod}（实际调用: ${calls.map((c) => c.method).join(", ")}）`,
    );
    assert.equal(
      target.request.workspaceIdentity,
      undefined,
      `${name} 不应把本端 remote identity 透传给对端 taskService —— ` +
        `对端从未写过这个键，透传会让它落库成一条永远不该存在的重复行`,
    );
    assert.equal(target.request.workspacePath, "/remote/project", `${name} 应带对端项目路径`);
    assert.equal(target.request.taskId, "sess_remote_1", `${name} 应带对端会话 id`);
  });
}

test("本地写操作仍原样保留 identity（剥离只作用于远程 source）", async () => {
  const calls: Array<{ method: string; request: Record<string, unknown> }> = [];
  const localIdentity = "project-identity-abc";
  const localTask = {
    taskId: "sess_local_1",
    title: "本地会话",
    workspacePath: "/local/project",
    workspaceIdentity: localIdentity,
    status: "completed",
    createdAt: 1,
    updatedAt: 2,
    provider: "zcode-agent",
    mode: "coding",
    pinned: false,
    archived: false,
  };
  const localTaskService = {
    // refreshSource 用这三个方法登记投影行；只实现 listTaskList 会让 mutaste
    // 因"行不存在"而抛错（那是夹具问题，不是被测行为）。
    async listTasks() {
      return [localTask];
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
  };
  const runtime = createWindowHostControllerRuntime({
    createId: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
    resolveSource: (scope) =>
      scope.workspaceIdentity === localIdentity
        ? {
            scope: {
              kind: "local" as const,
              workspacePath: "/local/project",
              workspaceIdentity: localIdentity,
            },
            taskService: localTaskService as never,
            sourceAvailability: "online" as const,
          }
        : null,
  });

  // 先让投影登记本地 source 与行，否则 mutate 会因匹配不到 source 而抛错。
  await runtime.service.listTaskList({
    kind: "timeline",
    workspaceScopes: [{ workspacePath: "/local/project", workspaceIdentity: localIdentity }],
    sortBy: "updated",
  });

  await runtime.service.mutateTask({
    address: {
      taskId: "sess_local_1",
      workspacePath: "/local/project",
      workspaceIdentity: localIdentity,
    },
    mutation: { kind: "pin", pinned: true } as never,
  });

  const target = calls.find((call) => call.method === "setTaskPinned");
  assert.ok(target, "本地 setTaskPinned 应被调用");
  assert.equal(
    target.request.workspaceIdentity,
    localIdentity,
    "本地 source 的 identity 是真实归属，必须保留（剥离不能扩大化）",
  );
});
