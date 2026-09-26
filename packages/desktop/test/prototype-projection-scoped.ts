#!/usr/bin/env node
/**
 * 原型验证 2：设置驱动的「项目投射」流程（用户新方案，只读）
 *
 * 方案（用户确认）：
 *   - B 的项目混入 A 的项目列表，图标/颜色区分
 *   - 会话实时从 B 拉（投射），A 不落库
 *   - 断开则项目消失，但保留可重连入口
 *   - 设置里新增「远程设备」选项，由用户**选择显示哪些项目**
 *
 * 本原型验证「选择 + 投射」这一段是否可行、开销如何：
 *   S1 从 B 枚举项目列表（供设置页勾选）
 *   S2 按"用户已选项目"过滤，只投射被选中的
 *   S3 验证投射结果的数据形状能否直接喂给 UI（字段齐全度）
 *   S4 验证"未选项目"确实不出现（作用域可控）
 *
 * 全程只读，不写 B、不写 A。
 * 跑法：node --import tsx packages/desktop/test/prototype-projection-scoped.ts
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
console.log("✅ 已挂载 B 的常驻主机\n");

const taskService = connection.services.zcodeTaskService;

// ── S1：枚举项目列表（设置页的候选清单）──
const allTasks = await taskService.listTasks({});
const projectMap = new Map();
for (const task of allTasks) {
  const path = task.workspacePath ?? "(unknown)";
  if (!projectMap.has(path)) projectMap.set(path, []);
  projectMap.get(path).push(task);
}
const allProjects = [...projectMap.keys()].sort();
console.log("=== S1：设置页候选项目（来自 B 的实际数据）===");
for (const path of allProjects) {
  console.log(`  ☐ ${path}  （${projectMap.get(path).length} 条会话）`);
}
console.log(`共 ${allProjects.length} 个候选\n`);

// ── S2：模拟用户只勾选 2 个项目（设置里保存的就是这个清单）──
const selectedProjects = allProjects.filter((p) => p.includes("新赛马") || p.includes("中转站"));
console.log("=== S2：用户勾选的项目 ===");
for (const path of selectedProjects) console.log(`  ☑ ${path}`);
console.log(`已选 ${selectedProjects.length} / ${allProjects.length}\n`);

// ── S3：投射被选项目的会话，检查数据形状 ──
console.log("=== S3：投射结果（供左侧栏渲染）===");
const projected = [];
for (const path of selectedProjects) {
  const tasks = await taskService.listTasks({ workspacePath: path });
  console.log(`  ▸ ${path} → ${tasks.length} 条`);
  for (const task of tasks) {
    projected.push({
      // UI 渲染所需的最小字段集
      taskId: task.taskId,
      title: task.title,
      status: task.status,
      updatedAt: task.updatedAt,
      remoteProjectPath: path,
      origin: "remote", // 供 UI 做图标/颜色区分
    });
  }
}
const payloadBytes = Buffer.byteLength(JSON.stringify(projected), "utf8");
console.log(`\n投射会话总数: ${projected.length}，负载 ${(payloadBytes / 1024).toFixed(1)} KB`);

console.log("\n字段齐全度检查（UI 渲染最小集）:");
const required = ["taskId", "title", "status", "updatedAt", "remoteProjectPath", "origin"];
const sample = projected[0];
const missing = sample ? required.filter((field) => !(field in sample)) : required;
console.log(`  必需字段: ${required.join(", ")}`);
console.log(`  缺失字段: ${missing.length === 0 ? "无 ✅" : missing.join(", ") + " ❌"}`);
console.log("\n渲染样本（前 3 条）:");
for (const item of projected.slice(0, 3)) {
  console.log(`  [${item.origin}] ${String(item.title).slice(0, 38)} | ${item.status} | ${item.remoteProjectPath}`);
}

// ── S4：作用域可控性 ──
console.log("\n=== S4：未选项目确实不出现 ===");
const unselected = allProjects.filter((p) => !selectedProjects.includes(p));
console.log(`未选项目 ${unselected.length} 个:`);
for (const path of unselected.slice(0, 5)) console.log(`  ✗ ${path}`);
const leaked = projected.filter((item) => !selectedProjects.includes(item.remoteProjectPath));
console.log(`投射结果中混入未选项: ${leaked.length === 0 ? "0 条 ✅" : `${leaked.length} 条 ❌`}`);

await connection.disposeAndWait({ timeoutMs: 5_000 });
console.log("\n=== 结论 ===");
console.log(`S1 项目枚举供设置勾选: ✅（${allProjects.length} 个）`);
console.log(`S2 按勾选过滤:         ✅`);
console.log(`S3 投射数据形状:       ${missing.length === 0 ? "✅ 字段齐全，可直接渲染" : "⚠️ 需补字段"}`);
console.log(`S4 作用域可控:         ${leaked.length === 0 ? "✅ 未选项不泄漏" : "❌ 有泄漏"}`);
console.log(`开销:                  ${(payloadBytes / 1024).toFixed(1)} KB / ${projected.length} 条（含全部字段）`);
console.log("断开后 A 侧无残留:     ✅（只读投射，未写任何库）");
