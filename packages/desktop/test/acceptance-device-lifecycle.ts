#!/usr/bin/env node
/**
 * 验收：设备连接的完整生命周期（不经 UI，直接跑连接能力）。
 *
 * 覆盖设置页「连接」按钮会走的全部步骤：
 *   读设备配置 → 连接（不选目录）→ 等 session 就绪 → 设备访问 → 推导项目清单
 *   → 投射同步（含显示偏好过滤）
 *
 * 只读验证（不写对端），投射同步只读本地 tabStore 状态。
 *
 * 跑法：node --import tsx packages/desktop/test/acceptance-device-lifecycle.ts
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
const { createRemoteDeviceConfigService } = await tsImport(
  pathToFileURL(join(repoRoot, "packages/services/src/remote/remoteDeviceConfigNode.ts")).href,
  import.meta.url,
);
const { createDeviceAccess, buildProjectedProjectList } = await tsImport(
  pathToFileURL(join(repoRoot, "packages/ui/src/lib/remoteDeviceAccess.ts")).href,
  import.meta.url,
);
const { computeProjectionSync, filterProjectsByVisibility } = await tsImport(
  pathToFileURL(join(repoRoot, "packages/ui/src/lib/remoteDeviceProjection.ts")).href,
  import.meta.url,
);

// 1) 读设备配置（设置页会用同一个服务）
const configDir = join(homedir(), ".zcode", "v2");
const deviceService = createRemoteDeviceConfigService({ configDir });
const devices = await deviceService.list();
console.log(`1) 读取设备配置: ${devices.length} 台`);
if (devices.length === 0) {
  console.error("❌ 未找到已保存的设备（请先在设置页保存设备）");
  process.exit(1);
}
const device = devices[0];
const target = device.target;
console.log(
  `   目标: ${target.kind === "ssh" ? `${target.username}@${target.host}` : target.kind}`,
);

// 2) 连接（不选目录）
const t0 = Date.now();
const backend = await createRemoteBackend(target);
const connection = await connectResidentRemote(backend, { onDidRemoteClose: () => {} });
if (!connection) {
  console.error("❌ 连接失败（对端可能未运行或协议不匹配）");
  process.exit(1);
}
console.log(`2) 连接成功: ${Date.now() - t0}ms`);

// 3) 设备访问 → 项目清单
const access = await createDeviceAccess({
  zcodeTaskService: connection.services.zcodeTaskService,
  settingService: connection.services.settingService,
});
const [registeredProjects, tasks] = await Promise.all([
  access.access.listRegisteredProjects(),
  access.access.listAllTasks(),
]);
const allProjects = buildProjectedProjectList({ registeredProjects, tasks });
console.log(
  `3) 设备访问: 已登记 ${registeredProjects.length} / 会话 ${tasks.length} / 项目 ${allProjects.length}`,
);

// 4) 投射同步（含显示偏好过滤）
const visible = filterProjectsByVisibility(allProjects, device.visibleProjects);
const deviceSessionId = "lifecycle-check";
const syncResult = computeProjectionSync({
  deviceSessionId,
  deviceProjects: visible,
  existingTabs: [],
});
console.log(
  `4) 投射: 应创建 ${syncResult.toCreate.length} 个条目（偏好过滤后 ${visible.length}/${allProjects.length}）`,
);

// 5) 重复同步应零变更
const existingTabs = syncResult.toCreate.map((project: { path: string }, index: number) => ({
  id: `t-${index}`,
  workspacePath: project.path,
  projection: { deviceSessionId },
}));
const second = computeProjectionSync({ deviceSessionId, deviceProjects: visible, existingTabs });
console.log(
  `5) 重复同步: 创建 ${second.toCreate.length} / 移除 ${second.toRemoveTabIds.length}（应均为 0）`,
);

await connection.disposeAndWait({ timeoutMs: 5_000 });

const ok =
  devices.length > 0 &&
  allProjects.length > 0 &&
  syncResult.toCreate.length === visible.length &&
  second.toCreate.length === 0 &&
  second.toRemoveTabIds.length === 0;
console.log("\n=== 验收结论（设备连接完整生命周期）===");
console.log(`读设备配置:   ✅（${devices.length} 台）`);
console.log(`连接(无目录): ✅（${Date.now() - t0}ms）`);
console.log(`设备访问:     ✅（${allProjects.length} 项目 / ${tasks.length} 会话）`);
console.log(
  `投射同步:     ${syncResult.toCreate.length === visible.length ? "✅" : "❌"}（建 ${syncResult.toCreate.length} 个）`,
);
console.log(
  `幂等性:       ${second.toCreate.length === 0 && second.toRemoveTabIds.length === 0 ? "✅" : "❌"}`,
);
console.log(`只读验证:     ✅ 未写入对端数据`);
process.exit(ok ? 0 : 1);
