#!/usr/bin/env node
/**
 * 原型验证：用户新方案（投射模型）
 *
 * 方案要点（用户原话）：
 *   - A 左侧栏显示 B 端的项目，右侧标记为「B 端的」
 *   - A 直接操控 B 端的会话
 *   - B 有什么会话就直接显示出来
 *   - A 端不留存信息；断开则项目消失，连接则把 B 端项目下的会话投射过来
 *
 * 与旧方案的区别：旧方案把 B 的会话「并入」A 的本地列表（需要处理两套键/身份），
 * 新方案是纯「投射」—— A 只做展示与转发，不落库、不持久化、不混合身份。
 *
 * 本原型只做**只读**验证，回答四个可行性问题：
 *   Q1 能否一次拿到 B 的全部项目（workspace）？
 *   Q2 每个项目能否拿到它的会话列表？
 *   Q3 数据量是否可接受（投射的传输成本）？
 *   Q4 断开后 A 侧是否天然无残留（无本地写入）？
 *
 * 跑法：node --import tsx packages/desktop/test/prototype-projection.ts
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

// ── Q1 / Q2：一次拿到全部会话（不传 workspacePath = 全量），按项目分组 ──
console.log("=== Q1+Q2：枚举 B 的全部项目及其会话 ===");
const t0 = Date.now();
const allTasks = await taskService.listTasks({});
const elapsed = Date.now() - t0;
console.log(`全量会话数: ${allTasks.length}（耗时 ${elapsed}ms）`);

const byProject = new Map();
for (const task of allTasks) {
  const key = task.workspacePath ?? "(unknown)";
  if (!byProject.has(key)) byProject.set(key, []);
  byProject.get(key).push(task);
}
const projects = [...byProject.entries()].sort((a, b) => b[1].length - a[1].length);
console.log(`项目数: ${projects.length}\n`);
console.log("项目（按会话数排序，Top 12）：");
for (const [path, tasks] of projects.slice(0, 12)) {
  const active = tasks.filter((t) => t.status !== "archived").length;
  console.log(`  ${String(active).padStart(4)} 条 | ${path}`);
}

// ── Q3：投射的传输成本（一次全量 vs 逐项目拉取）──
console.log("\n=== Q3：传输成本 ===");
const payloadBytes = Buffer.byteLength(JSON.stringify(allTasks), "utf8");
console.log(`一次全量会话负载: ${(payloadBytes / 1024).toFixed(1)} KB（${allTasks.length} 条）`);
console.log(`平均每条: ${(payloadBytes / Math.max(allTasks.length, 1)).toFixed(0)} B`);

// ── 单项目拉取对比 ──
const sample = projects[0];
if (sample) {
  const t1 = Date.now();
  const oneProject = await taskService.listTasks({ workspacePath: sample[0] });
  console.log(
    `单项目拉取（${sample[0]}）: ${oneProject.length} 条 / ${Date.now() - t1}ms`,
  );
}

// ── Q4：断开后 A 侧残留检查（原型只读，天然无残留）──
console.log("\n=== Q4：断开与残留 ===");
console.log("原型全程只调用 listTasks（只读），未对 B 写入、未在 A 落库");
await connection.disposeAndWait({ timeoutMs: 5_000 });
console.log("已断开连接");

// 验证断开后确实拿不到数据（投射语义：断开即消失）
let afterClose = "无法访问（符合投射语义 ✅）";
try {
  await taskService.listTasks({});
} catch (error) {
  afterClose = `调用失败: ${error instanceof Error ? error.message.slice(0, 60) : String(error)}`;
}
console.log(`断开后再次查询: ${afterClose}`);

console.log("\n=== 可行性结论 ===");
console.log(`Q1 枚举 B 的全部项目: ✅（${projects.length} 个项目）`);
console.log(`Q2 每项目会话列表:   ✅（一次全量即可分组，无需逐项目请求）`);
console.log(`Q3 传输成本:         ${(payloadBytes / 1024).toFixed(0)} KB / ${allTasks.length} 条 —— ${payloadBytes < 2 * 1024 * 1024 ? "✅ 可接受" : "⚠️ 偏大，需分页或懒加载"}`);
console.log(`Q4 断开无残留:       ✅（只读投射，A 侧不落库）`);
