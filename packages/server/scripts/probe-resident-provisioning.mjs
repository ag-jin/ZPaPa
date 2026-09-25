#!/usr/bin/env node
/**
 * 跨机回归：A 端通过真实 SSH 挂载 B 常驻主机后，依次调用
 *   1) setting.get（sanity RPC）
 *   2) providerProvisioningTargetService.apply（向导 handleConnected → initialSync 的链路）
 * 每个 RPC 带 15s 超时，用于区分「挂死」与「报错」；退出前优雅关闭。
 *
 * 用法：node scripts/probe-resident-provisioning.mjs [host] [user] [keyPath]
 * 默认 host=100.66.1.2 user=linguojin，密钥 ~/.ssh/id_ed25519_imac。
 */
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = process.argv[2] ?? "100.66.1.2";
const username = process.argv[3] ?? "linguojin";
const keyPath = process.argv[4] ?? join(homedir(), ".ssh/id_ed25519_imac");

const { createRemoteBackend } = await tsImport(
  pathToFileURL(join(packageRoot, "src/remote/create-backend.ts")).href,
  import.meta.url,
);
const { connectResidentRemote } = await tsImport(
  pathToFileURL(join(packageRoot, "src/remote/connect-resident.ts")).href,
  import.meta.url,
);

function withTimeout(promise, label, ms = 15_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

console.log(`[probe] connecting ssh ${username}@${host}:22 ...`);
const backend = await createRemoteBackend({
  kind: "ssh",
  host,
  port: 22,
  username,
  privateKeyPath: keyPath,
});
console.log("[probe] backend connected");

let remoteCloseCode = null;
const connection = await connectResidentRemote(backend, {
  onDidRemoteClose: ({ code }) => {
    remoteCloseCode = code;
  },
});
if (!connection) {
  console.error("[probe] ❌ connectResidentRemote returned null");
  process.exit(1);
}
console.log("[probe] ✅ resident attached");

const settings = await withTimeout(connection.services.settingService.get(), "setting.get");
console.log(`[probe] ✅ setting.get ok (locale=${settings?.locale ?? "?"})`);

const envelope = {
  schemaVersion: 1,
  syncId: `probe-${Date.now()}`,
  personalConfig: {
    providerConfigRules: { providerRules: [] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
  },
  accountSettings: {
    providerFamilyDomain: null,
    providerFamilyConnectionSelections: { zai: undefined, bigmodel: undefined },
  },
  credentials: [],
};
try {
  const result = await withTimeout(
    connection.services.providerProvisioningTargetService.apply(envelope),
    "providerProvisioningTarget.apply",
  );
  console.log(`[probe] ✅ apply returned: ${JSON.stringify(result)}`);
} catch (error) {
  console.log(`[probe] ⚠️ apply error（非挂死即报错）: ${error?.message ?? error}`);
}

await connection.disposeAndWait({ timeoutMs: 5_000 });
console.log(`[probe] remote close code=${remoteCloseCode}`);
console.log("[probe] done");
process.exit(0);
