#!/usr/bin/env node
/**
 * 验收（层 2 · 跨机只读）：投射的「不留存 / 不污染」不变量。
 *
 * 两条不变量，历史上各被违反过一次：
 *
 *   I1 投射端（A）的 tasks-index 里没有任何 `remote:` 前缀的索引行。
 *      违反后的表现：A 本机列表混入不属于它的会话，断连也不消失。
 *      历史残留：实测曾有 12 条 `remote:ssh:100.66.1.6:...`（连另一台机器留下的）。
 *
 *   I2 被投射端（B）自己的库里，一个会话只按「B 自己的键」存在，没有
 *      `remote:` 前缀行。违反后的表现：同一会话在对端列表出现两次。
 *      根因见 .agents/plans/finding-remote-identity-write-duplication.md：
 *      A 的隔离标签被透传写进 B 的库。
 *
 * 为什么这两条要放在一起：它们是同一个约束的两面 —— **本端 identity 不得
 * 跨机传递到对端数据层，也不得在对端留下痕迹**。读路径已修（远程 source 只按
 * workspacePath 查对端），写路径（archive/pin/delete 等 mutation）此前未修。
 *
 * 本脚本只读：不向 A 或 B 写入任何数据。
 * 跑法：node --import tsx packages/desktop/test/acceptance-index-isolation.ts
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const PROJECT_PATH = "/Volumes/数据盘/网站/新赛马";
const REMOTE_PREFIX = "remote:";

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `\n     ${detail}` : ""}`);
  if (!ok) failures += 1;
}
let failures = 0;

/** 统计某个 tasks-index 库里带远程前缀的行（库不存在视为 0：还没建过索引）。 */
function countRemotePrefixedRows(dbPath: string): {
  exists: boolean;
  total: number;
  byKey: number;
  byIdentity: number;
  byTaskId: number;
  samples: string[];
} {
  if (!existsSync(dbPath)) {
    return { exists: false, total: 0, byKey: 0, byIdentity: 0, byTaskId: 0, samples: [] };
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  // count(*) 恒返回一行，但 DatabaseSync 的返回类型是可选行：取不到就说明库结构异常，
  // 这里退化为 -1 让断言失败可见，而不是静默当成 0（那会掩盖真实的残留）。
  const countOf = (sql: string, ...params: string[]): number => {
    const row = db.prepare(sql).get(...params) as { c?: number } | undefined;
    return typeof row?.c === "number" ? row.c : -1;
  };
  try {
    const total = countOf("select count(*) c from tasks");
    const byKey = countOf(
      "select count(*) c from tasks where workspace_key like ?",
      `${REMOTE_PREFIX}%`,
    );
    const byIdentity = countOf(
      "select count(*) c from tasks where workspace_identity like ?",
      `${REMOTE_PREFIX}%`,
    );
    const byTaskId = countOf(
      "select count(*) c from tasks where task_id like ?",
      `${REMOTE_PREFIX}%`,
    );
    const samples = (
      db
        .prepare(
          `select workspace_key, task_id from tasks
           where workspace_key like ? or workspace_identity like ?
           limit 5`,
        )
        .all(`${REMOTE_PREFIX}%`, `${REMOTE_PREFIX}%`) as Array<{
        workspace_key: string;
        task_id: string;
      }>
    ).map((row) => `${row.workspace_key} / ${row.task_id}`);
    return { exists: true, total, byKey, byIdentity, byTaskId, samples };
  } finally {
    db.close();
  }
}

console.log("=== I1：投射端（本机）任务库无远程前缀索引行 ===");
const localIndex = join(homedir(), ".zcode", "v2", "tasks-index.sqlite");
const local = countRemotePrefixedRows(localIndex);
console.log(`  库: ${localIndex}`);
console.log(`  总行数: ${local.total}`);
check(
  "I1 本机任务库无 remote: 前缀行（workspace_key / workspace_identity / task_id 三个字段）",
  local.exists && local.byKey === 0 && local.byIdentity === 0 && local.byTaskId === 0,
  local.exists
    ? `byKey=${local.byKey} byIdentity=${local.byIdentity} byTaskId=${local.byTaskId}` +
        (local.samples.length > 0 ? `\n     样例: ${local.samples.join(" | ")}` : "")
    : "库不存在（视为通过）",
);

console.log("\n=== I2：被投射端（B）自己的库也只有一个键 ===");
const { createRemoteBackend } = await tsImport(
  pathToFileURL(join(repoRoot, "packages/server/src/remote/create-backend.ts")).href,
  import.meta.url,
);
const { connectResidentRemote } = await tsImport(
  pathToFileURL(join(repoRoot, "packages/server/src/remote/connect-resident.ts")).href,
  import.meta.url,
);

const backend = await createRemoteBackend({
  kind: "ssh",
  host: process.env.ZPAPA_DEVICE_HOST ?? "100.66.1.2",
  port: 22,
  username: process.env.ZPAPA_DEVICE_USER ?? "linguojin",
  privateKeyPath: process.env.ZPAPA_DEVICE_KEY ?? join(homedir(), ".ssh/id_ed25519_imac"),
});
const connection = await connectResidentRemote(backend, { onDidRemoteClose: () => {} });
if (!connection) {
  console.error("❌ 挂载 B 的常驻主机失败（对端未运行？）");
  process.exit(1);
}
console.log("  已挂载 B 的常驻主机（只读）");

// 关键：必须直读对端**原始索引**。走对端 taskService 按项目路径查询看不到泄漏 ——
// 泄漏行的键就是 `remote:...`，按项目路径过滤时它们根本不匹配，于是"查询结果干净"
// 与"库里真的有脏行"可以同时成立（本脚本第一版就栽在这里）。
const remoteHome = process.env.ZPAPA_DEVICE_HOME ?? "/Users/linguojin";
const remoteIndex = `${remoteHome}/.zcode/v2/tasks-index.sqlite`;
const query = `select count(*) from tasks where workspace_key like 'remote:%' or workspace_identity like 'remote:%' or task_id like 'remote:%'`;
const stream = await backend.exec(
  `sqlite3 -readonly '${remoteIndex}' "${query}" 2>&1 || echo "SQLITE_UNAVAILABLE"`,
);
let raw = "";
for await (const chunk of stream.stdout) raw += chunk.toString();
const remoteLeakCount = /^\s*\d+\s*$/.test(raw) ? Number(raw.trim()) : null;
console.log(`  B 的原始索引: ${remoteIndex}`);
check(
  "I2b 对端原始 tasks-index 无本端 identity 泄漏",
  remoteLeakCount === 0,
  remoteLeakCount === null
    ? `无法查询（sqlite3 不可用或库不存在）: ${raw.trim().slice(0, 120)}`
    : `remote: 前缀行 = ${remoteLeakCount}`,
);

// 交叉验证：经对端 taskService 读回的形状也不得带前缀（防止"库干净但代理层贴标签"）。
const tasks = await connection.services.zcodeTaskService.listTasks({ workspacePath: PROJECT_PATH });
const leaked = tasks.filter(
  (task: { workspaceIdentity?: string; workspacePath?: string; taskId?: string }) =>
    (typeof task.workspaceIdentity === "string" &&
      task.workspaceIdentity.startsWith(REMOTE_PREFIX)) ||
    task.workspacePath?.startsWith(REMOTE_PREFIX) ||
    task.taskId?.startsWith(REMOTE_PREFIX),
);
console.log(`  B 的「${PROJECT_PATH}」会话数: ${tasks.length}`);
check(
  "I2 对端返回的会话不带 remote: 前缀（对端按自己的键组织数据）",
  leaked.length === 0,
  leaked.length === 0
    ? "0 条泄漏"
    : `${leaked.length} 条: ${leaked
        .slice(0, 3)
        .map((t: { taskId?: string }) => t.taskId)
        .join(", ")}`,
);

// I3：对端**会话库**的 workspace_id 也不得带本端 identity。
// 这与 I2b 是两个不同的表：V4 建会话路径写的是 session.workspace_id，
// 而 mutation 路径写的是 tasks-index。两者各自泄漏过，所以分开断言。
// 注意：用户的正常会话这里一律为 NULL（实测 1783 条全 NULL），带 remote: 前缀
// 的一定是投射端传过去的隔离标签。
const sessionQuery = `select count(*) from session where workspace_id like 'remote:%'`;
const sessionStream = await backend.exec(
  `sqlite3 -readonly '${remoteHome}/.zcode/cli/db/db.sqlite' "${sessionQuery}" 2>&1 || echo "SQLITE_UNAVAILABLE"`,
);
let sessionRaw = "";
for await (const chunk of sessionStream.stdout) sessionRaw += chunk.toString();
const sessionLeakCount = /^\s*\d+\s*$/.test(sessionRaw) ? Number(sessionRaw.trim()) : null;
check(
  "I3 对端 session 表的 workspace_id 无本端 identity（用户会话一律为 NULL）",
  sessionLeakCount === 0,
  sessionLeakCount === null
    ? `无法查询: ${sessionRaw.trim().slice(0, 120)}`
    : `带 remote: 前缀的 workspace_id = ${sessionLeakCount}`,
);

await connection.disposeAndWait({ timeoutMs: 5_000 });

console.log("\n=== 验收结论（投射隔离不变量）===");
if (failures === 0) {
  console.log("I1 本机无远程前缀索引行 ✅");
  console.log("I2 对端 tasks-index 无本端 identity 泄漏 ✅（原始索引 + 代理读回）");
  console.log("I3 对端 session 表无本端 identity 泄漏 ✅");
  console.log("全部通过 ✅");
} else {
  console.log(`存在 ${failures} 项失败 ❌`);
}
process.exit(failures === 0 ? 0 : 1);
