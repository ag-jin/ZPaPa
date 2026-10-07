#!/usr/bin/env node
/**
 * 验收（工单 04）：投射同步的数据面。
 *
 * 验证「设备项目 → 投射条目」的差异计算在真实设备数据上正确：
 * 首次同步应创建全部可见项目；重复同步应零变更（不重建）；
 * 关闭显示偏好后应移除对应条目。只读（不写对端）。
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
const { computeProjectionSync, filterProjectsByVisibility } = await tsImport(
  pathToFileURL(join(repoRoot, "packages/ui/src/lib/remoteDeviceProjection.ts")).href,
  import.meta.url,
);

const backend = await createRemoteBackend({
  kind: "ssh",
  host: "100.66.1.2",
  port: 22,
  username: "linguojin",
  privateKeyPath: join(homedir(), ".ssh/id_ed25519_imac"),
});
const conn = await connectResidentRemote(backend, { onDidRemoteClose: () => {} });
if (!conn) {
  console.error("❌ 连接失败");
  process.exit(1);
}
const deviceSessionId = "verify-session";

const access = await createDeviceAccess({
  zcodeTaskService: conn.services.zcodeTaskService,
  settingService: conn.services.settingService,
});
const registered = await access.access.listRegisteredProjects();
const tasks = await access.access.listAllTasks();
const allProjects = buildProjectedProjectList({ registeredProjects: registered, tasks });
console.log(`设备项目: ${allProjects.length} 个`);

// 1) 首次同步：应创建全部项目
const first = computeProjectionSync({
  deviceSessionId,
  deviceProjects: allProjects,
  existingTabs: [],
});
console.log(`首次同步: 创建 ${first.toCreate.length} / 移除 ${first.toRemoveTabIds.length}`);
const ok1 = first.toCreate.length === allProjects.length;

// 2) 模拟"已创建"后重复同步：应零变更(不重建)
const existingTabs = first.toCreate.map((p: { path: string }, i: number) => ({
  id: `tab-${i}`,
  workspacePath: p.path,
  projection: { deviceSessionId },
}));
const second = computeProjectionSync({
  deviceSessionId,
  deviceProjects: allProjects,
  existingTabs,
});
console.log(`重复同步: 创建 ${second.toCreate.length} / 移除 ${second.toRemoveTabIds.length}`);
const ok2 = second.toCreate.length === 0 && second.toRemoveTabIds.length === 0;

// 3) 关闭第一个项目的显示偏好：应移除它
const hidden = allProjects[0].path;
const visible = filterProjectsByVisibility(allProjects, { [hidden]: false });
const third = computeProjectionSync({ deviceSessionId, deviceProjects: visible, existingTabs });
console.log(`关闭偏好后: 创建 ${third.toCreate.length} / 移除 ${third.toRemoveTabIds.length}`);
const ok3 = third.toRemoveTabIds.length === 1;

await conn.disposeAndWait({ timeoutMs: 5000 });
console.log("\n=== 验收结论（工单 04）===");
console.log(`设备数据可用:   ✅（${allProjects.length} 个项目）`);
console.log(`首次同步建齐:   ${ok1 ? "✅" : "❌"}`);
console.log(`重复同步不重建: ${ok2 ? "✅" : "❌"}（避免丢失展开/滚动状态）`);
console.log(`偏好关闭即移除: ${ok3 ? "✅" : "❌"}`);
process.exit(ok1 && ok2 && ok3 ? 0 : 1);
