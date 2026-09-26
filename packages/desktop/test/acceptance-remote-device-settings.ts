#!/usr/bin/env node
/**
 * 验收脚本：远程设备设置投射（目标验收标准 4）
 *
 * 验收标准 4：「设置页可读改 B 的 22 个白名单字段，改后 B 侧生效」
 * 本脚本用与 UI 相同的白名单逻辑与读写路径，跨机验证：
 *   V1 读取 B 的设置，白名单筛选（与 UI 同源的 pickProjectableSettings）
 *   V2 远程改一个字段 → B 侧读回确认生效 → 回滚 → 再确认
 *   V3 验证被排除字段不可见（UI 不会展示）
 *
 * 安全：只改一个无害的展示字段（messageStreamShowReasoning）并立即回滚；
 * 改前记录原值、改后读回确认，与 UI 组件的行为完全一致。
 *
 * 跑法：node --import tsx packages/desktop/test/acceptance-remote-device-settings.ts
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
// 直接用 UI 侧的白名单实现，保证验的就是产品逻辑
const { pickProjectableSettings, isProjectableSetting } = await tsImport(
  pathToFileURL(join(repoRoot, "packages/ui/src/lib/remoteDeviceSettings.ts")).href,
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

// ── V1：读取 + 白名单筛选 ──
const settings = await settingService.get();
const entries = pickProjectableSettings(settings);
const allBoolish = Object.entries(settings).filter(([, v]) => typeof v === "boolean");
const excluded = allBoolish.filter(([k]) => !isProjectableSetting(k, settings[k]));

console.log("=== V1：远端设置读取 + 白名单筛选 ===");
console.log(`设置总字段: ${Object.keys(settings).length}`);
console.log(`布尔字段:   ${allBoolish.length}`);
console.log(`可投射:     ${entries.length}`);
console.log(`已排除:     ${excluded.length}（${excluded.map(([k]) => k).join(", ")}）`);
console.log("\n可投射字段（UI 将展示这些）:");
for (const entry of entries) console.log(`  ☑ ${entry.key} = ${entry.value}`);

// ── V2：远程写入 → 读回确认 → 回滚 ──
console.log("\n=== V2：远程写入验证（写入 → 读回 → 回滚）===");
const targetKey = "messageStreamShowReasoning";
const originalValue = entries.find((e) => e.key === targetKey)?.value;
if (originalValue === undefined) {
  console.error(`❌ 目标字段 ${targetKey} 不在可投射列表里`);
  await connection.disposeAndWait({ timeoutMs: 5_000 });
  process.exit(1);
}
console.log(`  目标: ${targetKey}（原值 ${originalValue}）`);

const nextValue = !originalValue;
await settingService.update({ [targetKey]: nextValue });
const afterWrite = entries.length
  ? Object.entries(await settingService.get()).find(([k]) => k === targetKey)?.[1]
  : undefined;
const writeOk = afterWrite === nextValue;
console.log(`  写入 ${nextValue} → 读回 ${afterWrite} ${writeOk ? "✅ 生效" : "❌ 未生效"}`);

await settingService.update({ [targetKey]: originalValue });
const afterRollback = Object.entries(await settingService.get()).find(([k]) => k === targetKey)?.[1];
const rollbackOk = afterRollback === originalValue;
console.log(`  回滚 ${originalValue} → 读回 ${afterRollback} ${rollbackOk ? "✅ 已还原" : "❌ 还原失败"}`);

// ── V3：被排除字段确实不可见 ──
console.log("\n=== V3：敏感/本地字段不暴露 ===");
const projectableKeys = new Set(entries.map((e) => e.key));
const leaked = excluded.filter(([k]) => projectableKeys.has(k));
console.log(`被排除字段泄漏进可投射列表: ${leaked.length === 0 ? "0 个 ✅" : `${leaked.length} 个 ❌`}`);

await connection.disposeAndWait({ timeoutMs: 5_000 });

console.log("\n=== 验收结论（标准 4）===");
console.log(`V1 远端设置读取:      ✅（${Object.keys(settings).length} 字段，可投射 ${entries.length}）`);
console.log(`V2 远程修改并生效:    ${writeOk ? "✅" : "❌"}（读回确认 ${afterWrite}）`);
console.log(`V2 回滚还原:          ${rollbackOk ? "✅" : "❌"}（当前 ${afterRollback}）`);
console.log(`V3 敏感字段不泄漏:    ${leaked.length === 0 ? "✅" : "❌"}`);
process.exit(writeOk && rollbackOk && leaked.length === 0 ? 0 : 1);
