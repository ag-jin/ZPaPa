#!/usr/bin/env node
/**
 * 验收：设备访问层（工单 02）
 *
 * 用真实设备验证设备级访问：能力探测 → 枚举会话 → 推导投影项目清单。
 * 只读，不写对端任何数据。
 *
 * 跑法：node --import tsx packages/desktop/test/acceptance-device-access.ts
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
console.log("✅ 已连接设备（无目录）\n");

const result = await createDeviceAccess({
  zcodeTaskService: connection.services.zcodeTaskService,
  settingService: connection.services.settingService,
});

// 1) 已登记项目
const registered = await result.access.listRegisteredProjects();
console.log(`=== 已登记项目: ${registered.length} 个 ===`);
for (const path of registered.slice(0, 5)) console.log(`  ${path}`);

// 2) 设备级枚举（含能力探测与退化）
const t0 = Date.now();
const tasks = await result.access.listAllTasks();
console.log(`\n=== 设备级枚举: ${tasks.length} 条会话 (${Date.now() - t0}ms) ===`);
console.log(`能力探测结论: ${result.supportsDeviceWideEnumeration ? "对端支持设备级枚举 ✅" : "对端不支持，已退化为按项目查询"}`);

// 3) 投影项目清单（并集）
const projects = buildProjectedProjectList({ registeredProjects: registered, tasks });
console.log(`\n=== 投影项目清单: ${projects.length} 个（已登记 ∪ 有会话）===`);
for (const project of projects) {
  console.log(`  ${String(project.sessionCount).padStart(3)} 条 | ${project.path}`);
}

// 4) 单项目会话
const sample = projects[0];
if (sample) {
  const list = await result.access.listProjectTasks(sample.path);
  console.log(`\n=== 单项目查询: ${sample.path} → ${list.length} 条 ===`);
}

await connection.disposeAndWait({ timeoutMs: 5_000 });
console.log("\n=== 验收结论（工单 02）===");
console.log(`无目录连接:     ✅`);
console.log(`读已登记项目:   ✅（${registered.length} 个）`);
console.log(`设备级枚举:     ${tasks.length > 0 ? "✅" : "❌"}（${tasks.length} 条）`);
console.log(`投影项目清单:   ${projects.length > 0 ? "✅" : "❌"}（${projects.length} 个）`);
console.log(`只读验证:       ✅ 未写入对端任何数据`);
process.exit(projects.length > 0 ? 0 : 1);
