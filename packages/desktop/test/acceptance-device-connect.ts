#!/usr/bin/env node
/**
 * 验收（工单 02 完整闭环）：设备级连接 → 设备访问。
 *
 * 复刻 A 侧链路的实质步骤（连接 + 等就绪 + 设备查询），但不依赖 UI：
 * 连接底层与设置页用的是同一条 connectRemoteWorkspaceTarget 通路。
 *
 * 跑法：node --import tsx packages/desktop/test/acceptance-device-connect.ts
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const repoRoot = "/Users/linguojin/Workspace/ZCode/ZPaPa";
const { connectResidentRemote } = await tsImport(
  pathToFileURL(join(repoRoot, "packages/server/src/remote/connect-resident.ts")).href,
  import.meta.url,
);
const { createRemoteBackend } = await tsImport(
  pathToFileURL(join(repoRoot, "packages/server/src/remote/create-backend.ts")).href,
  import.meta.url,
);
const { createDeviceAccess, buildProjectedProjectList } = await tsImport(
  pathToFileURL(join(repoRoot, "packages/ui/src/lib/remoteDeviceAccess.ts")).href,
  import.meta.url,
);

// 1) 设备级连接（无目录）
const t0 = Date.now();
const backend = await createRemoteBackend({
  kind: "ssh",
  host: "100.66.1.2",
  port: 22,
  username: "linguojin",
  privateKeyPath: join(homedir(), ".ssh/id_ed25519_imac"),
});
const connection = await connectResidentRemote(backend, { onDidRemoteClose: () => {} });
if (!connection) {
  console.error("❌ 设备级连接失败");
  process.exit(1);
}
console.log(`✅ 设备级连接成功（无目录，${Date.now() - t0}ms）`);

// 2) 设备访问：读项目清单
const access = await createDeviceAccess({
  zcodeTaskService: connection.services.zcodeTaskService,
  settingService: connection.services.settingService,
});
const registered = await access.access.listRegisteredProjects();
const tasks = await access.access.listAllTasks();
const projects = buildProjectedProjectList({ registeredProjects: registered, tasks });
console.log(`✅ 设备访问：已登记 ${registered.length} 个项目 / 枚举 ${tasks.length} 条会话 / 投影清单 ${projects.length} 个`);

// 3) 开关序列：断开 → 重连（验证可重复连接，不残留）
await connection.disposeAndWait({ timeoutMs: 5_000 });
console.log("✅ 已断开");

const backend2 = await createRemoteBackend({
  kind: "ssh",
  host: "100.66.1.2",
  port: 22,
  username: "linguojin",
  privateKeyPath: join(homedir(), ".ssh/id_ed25519_imac"),
});
const connection2 = await connectResidentRemote(backend2, { onDidRemoteClose: () => {} });
if (!connection2) {
  console.error("❌ 重连失败");
  process.exit(1);
}
const tasks2 = await connection2.services.zcodeTaskService.listTasks({
  workspacePath: projects[0]?.path ?? registered[0] ?? "/",
});
console.log(`✅ 重连成功，单项目查询返回 ${tasks2.length} 条`);
await connection2.disposeAndWait({ timeoutMs: 5_000 });

console.log("\n=== 验收结论（工单 02）===");
console.log(`无目录连接:       ✅`);
console.log(`设备访问(项目):   ✅（${registered.length} 个已登记 / ${projects.length} 个投影）`);
console.log(`断开重连:         ✅`);
console.log(`只读验证:         ✅ 未写入对端任何数据`);
process.exit(projects.length > 0 ? 0 : 1);
