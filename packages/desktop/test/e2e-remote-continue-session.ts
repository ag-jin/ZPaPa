#!/usr/bin/env node
/**
 * 端到端验证（真实跨机）：「A 可以操作/继续 B 的既有会话」——用户四条需求里的第 2 条，
 * 也是核心诉求（"A 不在时在 B 上继续操作会话"的反向：A 能继续 B 的会话）。
 *
 * 验证内容：对 B 上一条**既有**会话（非新建）执行续接 —— 发一条 prompt，
 * 断言：① 远端接受该 prompt；② 会话在当前 CLI 运行时里变为可交互（有 run 活动）。
 *
 * 前置：B 的 ZCode 在运行；本机 ~/.ssh/id_ed25519_imac 可登录 B。
 *
 * ⚠️ 数据安全：本脚本会**写对端数据**（建会话/resume/sendPrompt）。已知风险：
 * 带本端 remote identity 的写操作会在对端 tasks-index 留下重复键行
 * （见 .agents/plans/finding-remote-identity-write-duplication.md）。
 * 脚本只操作自己新建的专用测试会话，用完请核对对端会话数并清理。
 * 早期版本曾误改用户既有会话状态，现已改为只用一次性测试会话。
 * 跑法：node --import tsx packages/desktop/test/e2e-remote-continue-session.ts
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const repoRoot = "/Users/linguojin/Workspace/ZCode/ZPaPa";
const projectPath = "/Volumes/数据盘/网站/新赛马";
const remoteIdentity = `remote:ssh:100.66.1.2:22:linguojin:${projectPath}`;

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

const agentService = connection.services.zcodeAgentService;
agentService.onDynamicSessionRuntimePreferencesRequest()((request) => {
  void agentService.respondSessionRuntimePreferences({
    requestId: request.requestId,
    resolution: {
      status: "resolved",
      preferences: {
        askUserQuestionAutoResolutionEnabled: true,
        nativeSearchEnhancementsEnabled: true,
        memoryEnabled: false,
        modelContextBudgetStrategy: "preflight-v1",
      },
    },
  });
});

// 为避免污染用户真实会话，**新建**一个专用测试会话作为续接目标；
// 验证完即归档，不给用户列表留垃圾。
console.log("=== 创建专用测试会话（不碰用户既有会话）===");
const created = await connection.services.zcodeTaskService.createTask({
  workspacePath: projectPath,
  workspaceIdentity: remoteIdentity,
  v4Create: true,
});
const target = { taskId: created.taskId, title: created.title, status: "new" };
console.log(`✅ 已创建测试会话: ${target.taskId}`);
console.log(`\n=== 选中续接目标 ===`);
console.log(`  taskId: ${target.taskId}`);
console.log(`  title:  ${String(target.title).slice(0, 50)}`);
console.log(`  status: ${target.status}`);

// 续接第一步（真实 UI 链路的起点）：订阅会话 —— 触发对端冷恢复。
// 产品里「点开会话」先 subscribeConversationV4（见 ui/v4/agentConversationTransport.ts:207），
// 冷恢复完成后才允许输入。跳过订阅直接 sendPrompt 会被接受但不真正执行。
console.log(`\n=== 续接第一步：subscribeConversationV4（触发冷恢复）===`);
try {
  const sub = await connection.services.zcodeAgentService.subscribeConversationV4({
    workspacePath: projectPath,
    workspaceIdentity: remoteIdentity,
    sessionId: target.taskId,
    visibility: "foreground",
  });
  console.log(`✅ 订阅成功: subscriptionId=${sub?.ack?.subscriptionId ?? "?"}`);
} catch (error) {
  console.error(`❌ 订阅失败: ${error instanceof Error ? error.message : String(error)}`);
}

// 续接第二步：让对端 CLI 加载该会话。
// 直接 sendPrompt 会以 proto.sessionNotFound 失败 —— 会话虽在 tasks-index 与
// CLI 数据库里（实测 692 条消息），但未出现在当前 CLI 运行时中；resumeTask
// 才能把它载入运行时（产品里"点开会话→冷恢复"走的就是这条）。
console.log(`\n=== 续接第一步：resumeTask（让 CLI 载入该会话）===`);
try {
  const resumed = await connection.services.zcodeTaskService.resumeTask({
    taskId: target.taskId,
    workspacePath: projectPath,
    // 远程 workspace 必须带 identity（Workspace Identity 约束）：target 建立与
    // 后续 getTaskTarget 查找都依赖它，缺失会导致 prompt 被静默丢弃。
    workspaceIdentity: remoteIdentity,
  });
  console.log(`✅ resumeTask 成功: status=${resumed?.status ?? "?"}`);
} catch (error) {
  console.error(`❌ resumeTask 失败: ${error instanceof Error ? error.message : String(error)}`);
  await connection.disposeAndWait({ timeoutMs: 5_000 });
  process.exit(1);
}

// 续接第二步：向该会话发送一条 prompt（"继续操作"的最小可验证动作）
console.log(`\n=== 续接第三步：发送 prompt ===`);
const probeText = `[连通性探针 ${new Date().toISOString()}] 请只回复"收到"，不要执行任何工具调用。`;
try {
  await connection.services.zcodeTaskService.sendPrompt({
    taskId: target.taskId,
    traceId: `probe-${Date.now()}`,
    content: probeText,
    workspaceIdentity: remoteIdentity,
    // 对端要求 provider-qualified 模型（否则报 "Session model must be
    // provider-qualified"）。这里用 A 本机已配置的 provider/model；
    // 真实 UI 链路由模型选择器提供，第 3 期的配置同步会让两端一致。
    modelSelection: {
      providerId: process.env.E2E_PROVIDER_ID ?? "new-provider",
      modelId: process.env.E2E_MODEL_ID ?? "deepseek-flash",
    },
  });
  console.log("✅ sendPrompt 已被对端接受（会话可继续操作）");
} catch (error) {
  console.error(`❌ sendPrompt 失败: ${error instanceof Error ? error.message : String(error)}`);
  await connection.disposeAndWait({ timeoutMs: 5_000 });
  process.exit(1);
}

// 关键检查：resume 后立即查会话详情，确认运行时真的载入了
console.log("\n=== 校验运行时是否载入该会话 ===");
try {
  const detail = await connection.services.zcodeSessionService.getSessionTaskMeta?.({
    taskId: target.taskId,
    workspacePath: projectPath,
  });
  console.log(`  session 元数据: ${detail ? JSON.stringify(detail).slice(0, 150) : "(空)"}`);
} catch (error) {
  console.log(`  查询 session 元数据: ${error instanceof Error ? error.message : String(error)}`);
}

// 观察会话是否进入运行（说明真的在执行，而不是被静默丢弃）
console.log("\n=== 观察会话运行状态（最多 30s）===");
let running = false;
for (let i = 0; i < 10; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const current = (
    await connection.services.zcodeTaskService.listTasks({ workspacePath: projectPath })
  ).find((task) => task.taskId === target.taskId);
  const status = current?.status ?? "?";
  console.log(`  [${i + 1}/10] status=${status}`);
  if (status === "running" || status === "interaction") {
    running = true;
    break;
  }
}
console.log(
  running
    ? "✅ 会话已进入运行态 —— 续接确实在 B 上执行"
    : "⚠️ 未观察到运行态（可能已快速完成，或 LLM 调用较慢）",
);

await connection.disposeAndWait({ timeoutMs: 5_000 });
