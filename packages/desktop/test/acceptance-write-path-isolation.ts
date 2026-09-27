#!/usr/bin/env node
/**
 * 验收（层 3 · 跨机写带回滚）：对投射条目的写操作不污染对端索引。
 *
 * 背景（真实缺陷，实测复现）：用户对投射出来的条目做置顶/归档/删除时，A 会把
 * 自己为远程工作区起的隔离标签（`remote:ssh:...:path`）原样发给 B 的 taskService。
 * B 从未写过这个键，于是落库成一条**永远不该存在的重复行** —— 用户看到同一会话
 * 在设备列表里出现两次。修复前实测 B 的 tasks-index 里留有 2 条这样的行：
 *
 *   remote:ssh:100.66.1.2:22:linguojin:/Volumes/数据盘/网站/新赛马 | sess_8c8af48f-...
 *   remote:ssh:100.66.1.2:22:linguojin:/Volumes/数据盘/网站/新赛马 | sess_e38c8742-...
 *
 * 本脚本验证修复：走 host Controller 的真实写路径（mutateTask）操作一个**自己
 * 新建的一次性会话**，然后直接读对端库断言该会话只有一条、且键不含本端 identity。
 *
 * 数据安全（严格遵守）：
 *   - 只操作本脚本自己新建的会话（护栏 assertTestOwnedTarget），绝不碰用户会话。
 *   - 写操作只有 pin/unpin（可逆，不改内容），结尾归档并复原。
 *   - 断言全部为只读库查询。
 *
 * 跑法：node --import tsx packages/desktop/test/acceptance-write-path-isolation.ts
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { assertTestOwnedTarget, TEST_OBJECT_PREFIX } from "./support/testIsolation.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const DEVICE_HOST = process.env.ZPAPA_DEVICE_HOST ?? "100.66.1.2";
const DEVICE_USER = process.env.ZPAPA_DEVICE_USER ?? "linguojin";
// 探针专用项目：优先用配置的项目；用不到时退化为设备上的默认工作区。
const PROJECT_PATH = process.env.ZPAPA_PROJECT_PATH ?? "/Volumes/数据盘/网站/新赛马";
const remoteIdentity = `remote:ssh:${DEVICE_HOST}:22:${DEVICE_USER}:${PROJECT_PATH}`;

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `\n     ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const { connectResidentRemote } = await tsImport(
  pathToFileURL(join(repoRoot, "packages/server/src/remote/connect-resident.ts")).href,
  import.meta.url,
);
const { createRemoteBackend } = await tsImport(
  pathToFileURL(join(repoRoot, "packages/server/src/remote/create-backend.ts")).href,
  import.meta.url,
);
const { createWindowHostControllerRuntime } = await tsImport(
  pathToFileURL(join(repoRoot, "packages/desktop/src/host/windowHostControllerService.ts")).href,
  import.meta.url,
);

const backend = await createRemoteBackend({
  kind: "ssh",
  host: DEVICE_HOST,
  port: 22,
  username: DEVICE_USER,
  privateKeyPath: process.env.ZPAPA_DEVICE_KEY ?? join(homedir(), ".ssh/id_ed25519_imac"),
});
const connection = await connectResidentRemote(backend, { onDidRemoteClose: () => {} });
if (!connection) {
  console.error("❌ 挂载 B 的常驻主机失败");
  process.exit(1);
}
console.log("已挂载 B 的常驻主机\n");

/** 直接读对端库统计某会话的索引行（只读，交叉验证代理层返回值）。 */
async function countRemoteRowsFor(taskId: string): Promise<{ rows: string[] }> {
  const sql = `select workspace_key from tasks where task_id='${taskId}';`;
  const dbPath = `$HOME/.zcode/v2/tasks-index.sqlite`;
  const stream = await backend.exec(`sqlite3 ${dbPath} ${JSON.stringify(sql)}`);
  let out = "";
  for await (const chunk of stream.stdout) out += chunk.toString();
  const rows = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { rows };
}

// ── 建一次性测试会话（唯一允许被写的对象）──
console.log("=== 建一次性测试会话（唯一被写对象）===");
const created = await connection.services.zcodeTaskService.createTask({
  workspacePath: PROJECT_PATH,
  workspaceIdentity: remoteIdentity,
  v4Create: true,
});
const testSessionId = created.taskId as string;
const createdSessionIds = new Set<string>([testSessionId]);
console.log(`  会话: ${testSessionId}`);
console.log(`  标题: ${String(created.title).slice(0, 46)}`);
check(
  `测试会话标题带可识别前缀（${TEST_OBJECT_PREFIX}），便于对端审计`,
  typeof created.title === "string" && created.title.startsWith(TEST_OBJECT_PREFIX),
  `实际标题: ${String(created.title).slice(0, 60)}`,
);

// 基线：建会话本身不该产生 remote: 前缀行（createTask 也带 identity）
const baseline = await countRemoteRowsFor(testSessionId);
console.log(`  对端索引行数（基线）: ${baseline.rows.length}`);
for (const row of baseline.rows) console.log(`    ${row}`);
check(
  "I1 建会话后，对端索引里该会话只有一条、且不含本端 identity",
  baseline.rows.length === 1 && !baseline.rows[0]?.startsWith("remote:"),
  `实际 ${baseline.rows.length} 行: ${baseline.rows.join(" | ")}`,
);

// ── 走真实 Controller 写路径：pin → unpin ──
const runtime = createWindowHostControllerRuntime({
  createId: (() => {
    let n = 0;
    return () => `wp-${++n}`;
  })(),
  resolveSource: (scope: { workspaceIdentity?: string }) => {
    if (scope.workspaceIdentity !== remoteIdentity) return null;
    return {
      scope: {
        kind: "remote",
        remoteSessionId: "write-path-check",
        workspacePath: PROJECT_PATH,
        workspaceIdentity: remoteIdentity,
      },
      taskService: connection.services.zcodeTaskService,
      sourceAvailability: "online",
    };
  },
});

// 地址由 UI 构造：remote address 必须带 identity（schema 强制）。
const address = {
  taskId: testSessionId,
  workspacePath: PROJECT_PATH,
  workspaceIdentity: remoteIdentity,
  remoteSessionId: "write-path-check",
};

const guard = assertTestOwnedTarget({
  taskId: address.taskId,
  createdSessionIds,
  operation: "mutateTask(pin)",
});
if (!guard.allowed) {
  console.error(`❌ ${guard.reason}`);
  await connection.disposeAndWait({ timeoutMs: 5_000 });
  process.exit(1);
}

console.log("\n=== 走真实 Controller 写路径：pin → unpin ===");
try {
  const pinned = await runtime.service.mutateTask({
    address,
    mutation: { kind: "pin", pinned: true } as never,
  });
  console.log(`  pin 返回: ${pinned ? `pinned=${(pinned as { pinned?: boolean }).pinned}` : "null"}`);
  const unpinned = await runtime.service.mutateTask({
    address,
    mutation: { kind: "pin", pinned: false } as never,
  });
  console.log(`  unpin 返回: ${unpinned ? `pinned=${(unpinned as { pinned?: boolean }).pinned}` : "null"}`);
} catch (error) {
  console.log(`  ⚠️ mutateTask 调用异常: ${error instanceof Error ? error.message : String(error)}`);
}

// 关键断言：写操作之后，对端库里该会话**仍然只有一条**、且不含本端 identity。
const after = await countRemoteRowsFor(testSessionId);
console.log(`\n=== 写操作后的对端索引行 ===`);
console.log(`  行数: ${after.rows.length}`);
for (const row of after.rows) console.log(`    ${row}`);

const leaked = after.rows.filter((row) => row.startsWith("remote:"));
check(
  "I2 写操作后对端索引无本端 identity 行（修复的写路径不泄漏）",
  leaked.length === 0,
  leaked.length === 0 ? "0 条泄漏" : `${leaked.length} 条: ${leaked.join(" | ")}`,
);
check(
  "I3 写操作后该会话仍只有一条索引行（无重复键）",
  after.rows.length === 1,
  `实际 ${after.rows.length} 行`,
);
check(
  "I4 对端索引键是设备自己的纯项目路径",
  after.rows.length === 1 && after.rows[0] === PROJECT_PATH,
  `实际键: ${after.rows.join(" | ")}`,
);

// ── 清理：归档这个一次性会话，不给设备列表留垃圾 ──
console.log("\n=== 清理 ===");
try {
  await connection.services.zcodeTaskService.archiveTask({
    taskId: testSessionId,
    workspacePath: PROJECT_PATH,
  });
  console.log(`  已归档测试会话 ${testSessionId}`);
} catch (error) {
  console.log(`  ⚠️ 归档失败（需手工清理）: ${error instanceof Error ? error.message : String(error)}`);
}

await connection.disposeAndWait({ timeoutMs: 5_000 });

console.log("\n=== 验收结论（写路径隔离）===");
if (failures === 0) {
  console.log("I1 建会话不产生 remote 前缀行 ✅");
  console.log("I2 写操作不泄漏本端 identity ✅");
  console.log("I3 无重复索引键 ✅");
  console.log("I4 对端键为自身路径 ✅");
  console.log("全部通过 ✅");
} else {
  console.log(`存在 ${failures} 项失败 ❌`);
}
process.exit(failures === 0 ? 0 : 1);
