import assert from "node:assert/strict";
import test from "node:test";
import { createWindowHostControllerRuntime } from "../src/host/windowHostControllerService.js";

/**
 * 远程会话可见性集成测试（不经 UI，直接驱动 host Controller）。
 *
 * 背景：A 连 B 的项目后，B 端返回了会话（已跨机实测 4 条），但 A 的列表始终为空。
 * 诊断日志显示 UI 传给 host 的 scopes 只有 workspacePath、没有 identity，
 * 而 host 的 resolveSource 需要 identity 才能定位远程连接。
 *
 * 本测试锁定 host 层的契约：
 *   1. scope 带 remote identity → resolveSource 应命中远程 source（本测试用 fake 断言调用形状）
 *   2. 远程 source 查对端时只传 workspacePath（不透传本端 identity）—— 这是 60d1b9e 的修复
 */
test("远程 source 查询对端时只传 workspacePath，不透传本端 identity", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const remoteScope = {
    kind: "remote" as const,
    remoteSessionId: "remote-session-1",
    workspacePath: "/remote/project",
    workspaceIdentity: "remote:ssh:host:22:user:/remote/project",
  };
  // B 端 taskService 模拟：记录收到的查询参数，并返回一条会话
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
  };

  const sourceErrors: unknown[] = [];
  const runtime = createWindowHostControllerRuntime({
    onSourceError: (scope, operation, error) => {
      sourceErrors.push({ scope, operation, error: error instanceof Error ? error.message : String(error) });
    },
    createId: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
    resolveSource: (scope) => {
      if (scope.workspaceIdentity === remoteScope.workspaceIdentity) {
        return {
          scope: remoteScope,
          taskService: remoteTaskService as never,
          sourceAvailability: "online" as const,
        };
      }
      return null;
    },
  });

  const result = await runtime.service.listTaskList({
    kind: "timeline",
    workspaceScopes: [
      {
        workspacePath: remoteScope.workspacePath,
        workspaceIdentity: remoteScope.workspaceIdentity,
      },
    ],
    sortBy: "updated",
  });

  // 诊断：投影里到底有没有行？
  assert.deepEqual(sourceErrors, [], "source 解析/刷新不应报错");

  // 核心断言 1：远程 source 收到了查询，且**只带 workspacePath**（不透传本端 identity）
  assert.ok(calls.length > 0, "远程 taskService 应被调用");
  for (const call of calls) {
    const req = call.request as { workspacePath?: string; workspaceIdentity?: string };
    assert.equal(
      req.workspaceIdentity,
      undefined,
      `${call.method} 不应把本端 remote identity 透传给对端`,
    );
    assert.equal(req.workspacePath, "/remote/project", `${call.method} 应带对端项目路径`);
  }

  // 核心断言 2：B 返回的会话经归一化后进入结果（identity 被替换为本端 scope 的 identity）
  assert.equal(result.total, 1, "应返回对端的 1 条会话");
  assert.equal(result.items[0]?.taskId, "sess_remote_1");
  assert.equal(
    result.items[0]?.workspaceIdentity,
    remoteScope.workspaceIdentity,
    "返回项的 identity 应归一化为本端 scope 的 identity",
  );
});
