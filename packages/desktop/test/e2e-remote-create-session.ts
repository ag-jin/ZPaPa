#!/usr/bin/env node
/**
 * 端到端验证（真实跨机，不经 UI）：「A 在 B 的项目里建会话 → B 端可见」。
 *
 * 这是用户四条需求里的第 3 条，也是唯一还没被独立验证过的一条。
 *
 * 关键：远端 Agent 会向本端请求 runtime preferences（app-global 设置），
 * 真实链路里由 window Host 的 runtimePreferencesBridge 应答。脚本作为
 * 轻量客户端，必须自己应答，否则 createSession 会以
 * 「Client request timed out: session/requestRuntimePreferences」失败。
 *
 * 跑法：node --import tsx packages/desktop/test/e2e-remote-create-session.ts
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const repoRoot = "/Users/linguojin/Workspace/ZCode/ZPaPa";
const projectPath = "/Volumes/数据盘/网站/新赛马";

const { connectResidentRemote } = await tsImport(
  pathToFileURL(join(repoRoot, "packages/server/src/remote/connect-resident.ts")).href,
  import.meta.url,
);
const { createRemoteBackend } = await tsImport(
  pathToFileURL(join(repoRoot, "packages/server/src/remote/create-backend.ts")).href,
  import.meta.url,
);

const backend = await createRemoteBackend({
  kind: "ssh",
  host: "100.66.1.2",
  port: 22,
  username: "linguojin",
  privateKeyPath: join(homedir(), ".ssh/id_ed25519_imac"),
});
const connection = await connectResidentRemote(backend, { onDidRemoteClose: () => {} });
if (!connection) {
  console.error("❌ attach 失败");
  process.exit(1);
}
console.log("✅ 已挂载 B 的常驻主机");

// 应答 B 的 Agent 对 runtime preferences 的请求（真实链路里由 host bridge 做）。
// 缺少这一步 → createSession 以 requestRuntimePreferences 超时失败。
const agentService = connection.services.zcodeAgentService;
let bridgedCount = 0;
agentService.onDynamicSessionRuntimePreferencesRequest()((request) => {
  bridgedCount += 1;
  console.log(`   [bridge] 应答 runtime preferences 请求 #${bridgedCount}（scope=${request.scope}）`);
  // 结构必须与 host bridge 一致（见 host/remoteWorkspaceServiceCollection.ts）：
  // status 是 "resolved"（不是 "ok"），且 preferences 必须含全部必需字段 ——
  // 少一个字段，对端 createSession 会以 zod invalid_type 失败。
  void agentService.respondSessionRuntimePreferences({
    requestId: request.requestId,
    resolution: {
      status: "resolved",
      preferences: {
        askUserQuestionAutoResolutionEnabled: true,
        nativeSearchEnhancementsEnabled: true,
        memoryEnabled: false,
        modelContextBudgetStrategy: "preflight-v1", // = DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY
      },
    },
  });
});

const before = await connection.services.zcodeTaskService.listTasks({ workspacePath: projectPath });
console.log(`[baseline] B 上该项目现有 ${before.length} 条未归档会话`);

console.log("\n=== 在 B 的项目里创建会话（A 侧发起）===");
let created;
try {
  created = await connection.services.zcodeTaskService.createTask({
    workspacePath: projectPath,
    v4Create: true,
  });
  console.log(`✅ createTask 返回: ${JSON.stringify(created).slice(0, 200)}`);
} catch (error) {
  console.error(`❌ createTask 失败: ${error instanceof Error ? error.message : String(error)}`);
  await connection.disposeAndWait({ timeoutMs: 5_000 });
  process.exit(1);
}

// 关键断言：新建的会话应出现在 B 的会话列表里（即 B 端 UI 能看到）
const after = await connection.services.zcodeTaskService.listTasks({ workspacePath: projectPath });
console.log(`\n[after] B 上该项目现有 ${after.length} 条未归档会话（基线 ${before.length}）`);
const createdTaskId = created?.taskId ?? created?.sessionId;
if (createdTaskId) {
  const visible = after.some((task) => task.taskId === createdTaskId);
  console.log(`新会话 ${createdTaskId} ${visible ? "✅ 已出现在 B 的列表里" : "❌ 未出现在 B 的列表里"}`);
}

await connection.disposeAndWait({ timeoutMs: 5_000 });
console.log(`\nbridge 应答次数: ${bridgedCount}`);
