#!/usr/bin/env node
/**
 * 原型验证 3：远程设置投射（只读优先）
 *
 * 需求（用户）：在设置里增加「B 端设备设置投影」，并且**可以远程修改**。
 *
 * 本原型分两步，先只读、后写（写步骤需显式传 --write 才执行）：
 *   R1 从 A 读 B 的全部设置（验证读取通路）
 *   R2 挑选适合投射的字段（过滤敏感/环境相关项）
 *   R3（需 --write）改一个无害字段并读回确认（验证写入通路 + 回滚）
 *
 * 安全设计：
 *   - 默认只读，写必须显式开关
 *   - 只改白名单里的无害布尔项，改完**立即回滚**原值
 *   - 全程打印前后值，可核对
 *
 * 跑法：
 *   node --import tsx packages/desktop/test/prototype-remote-settings.ts
 *   node --import tsx packages/desktop/test/prototype-remote-settings.ts --write
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const repoRoot = "/Users/linguojin/Workspace/ZCode/ZPaPa";
const allowWrite = process.argv.includes("--write");

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

const settingService = connection.services.settingService;

// ── R1：读 B 的设置 ──
console.log("=== R1：从 A 读 B 的设置 ===");
const t0 = Date.now();
const remoteSettings = await settingService.get();
const elapsed = Date.now() - t0;
const allKeys = Object.keys(remoteSettings);
console.log(`✅ 读取成功：${allKeys.length} 个字段，耗时 ${elapsed}ms`);
console.log(`负载: ${(Buffer.byteLength(JSON.stringify(remoteSettings), "utf8") / 1024).toFixed(1)} KB`);

// ── R2：筛选适合投射的字段 ──
console.log("\n=== R2：字段分类（哪些适合投射到 A 的设置页）===");
// 敏感/环境相关：含凭据线索、路径、内部标记的字段不投射
const SENSITIVE_PATTERNS = [
  /token/i,
  /credential/i,
  /secret/i,
  /password/i,
  /key$/i,
  /path/i,
  /dir/i,
  /session/i,
  /window/i,
  /zoom/i,
  /tab/i,
];
const projectable = [];
const excluded = [];
for (const [key, value] of Object.entries(remoteSettings)) {
  const isBool = typeof value === "boolean";
  const sensitive = SENSITIVE_PATTERNS.some((re) => re.test(key));
  if (isBool && !sensitive) projectable.push([key, value]);
  else excluded.push([key, typeof value, sensitive]);
}
console.log(`可投射（布尔且非敏感）: ${projectable.length} 个`);
for (const [key, value] of projectable) console.log(`  ☑ ${key} = ${value}`);
console.log(`\n已排除: ${excluded.length} 个（非布尔或命中敏感模式）`);
for (const [key, type, sensitive] of excluded.slice(0, 8)) {
  console.log(`  ✗ ${key} (${type}${sensitive ? ", 敏感" : ""})`);
}

// ── R3：远程修改（需 --write）──
console.log("\n=== R3：远程修改验证 ===");
if (!allowWrite) {
  console.log("（跳过；加 --write 才会执行。写步骤会改一个无害布尔项并立即回滚）");
} else {
  // 挑一个无副作用的展示选项作为样本
  const targetKey = "messageStreamShowReasoning";
  const original = remoteSettings[targetKey];
  console.log(`  目标字段: ${targetKey}（当前 ${original}）`);

  const flipped = !original;
  console.log(`  写入 ${flipped} ...`);
  await settingService.update({ [targetKey]: flipped });

  const after = await settingService.get();
  const actualAfter = after[targetKey];
  console.log(`  读回: ${actualAfter} → ${actualAfter === flipped ? "✅ 远程修改生效" : "❌ 未生效"}`);

  console.log(`  回滚到 ${original} ...`);
  await settingService.update({ [targetKey]: original });
  const restored = (await settingService.get())[targetKey];
  console.log(`  读回: ${restored} → ${restored === original ? "✅ 已还原" : "❌ 还原失败（请手工检查）"}`);
}

await connection.disposeAndWait({ timeoutMs: 5_000 });
console.log("\n=== 结论 ===");
console.log(`R1 远程读设置:  ✅（${allKeys.length} 字段 / ${elapsed}ms）`);
console.log(`R2 字段可投射:  ✅（${projectable.length} 个适合，${excluded.length} 个需排除）`);
console.log(
  `R3 远程改设置:  ${allowWrite ? "见上（已回滚）" : "未执行（加 --write 验证）"}`,
);
