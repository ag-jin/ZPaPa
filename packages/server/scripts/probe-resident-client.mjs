/**
 * B→A 反向挂载探针（在 B 上运行，连回 A 的常驻会话主机）。
 *
 * 用途：验证「反向连接」链路 —— B 作为客户端，经 SSH 隧道挂载 A 的常驻主机。
 * 脚本自包含（esbuild 打成单文件），用 B 自带 Electron 的 ELECTRON_RUN_AS_NODE=1
 * 运行（B 无独立 node）。
 *
 * 用法（在 B 上）：
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/ZCode.app/Contents/MacOS/ZCode" probe.mjs \
 *     --host=100.66.1.9 --user=linguojin --key=/Users/linguojin/.ssh/id_ed25519
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { createRemoteBackend } from "../src/remote/create-backend.js";
import { connectResidentRemote } from "../src/remote/connect-resident.js";

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function withTimeout(promise, label, ms = 15_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
  const host = argValue("host", "100.66.1.9");
  const username = argValue("user", process.env.USER ?? "linguojin");
  const keyPath = argValue("key", `${homedir()}/.ssh/id_ed25519`);
  if (!existsSync(keyPath)) {
    throw new Error(`private key not found: ${keyPath}`);
  }

  console.log(`[b2a] connecting ssh ${username}@${host}:22 ...`);
  const backend = await createRemoteBackend({
    kind: "ssh",
    host,
    port: 22,
    username,
    privateKeyPath: keyPath,
  });
  console.log("[b2a] backend connected");

  let remoteCloseCode = null;
  const connection = await connectResidentRemote(backend, {
    onDidRemoteClose: ({ code }) => {
      remoteCloseCode = code;
    },
  });
  if (!connection) {
    console.error("[b2a] FAIL connectResidentRemote returned null (fell back to legacy)");
    process.exit(1);
  }
  console.log("[b2a] OK resident attached (reverse direction)");

  const settings = await withTimeout(connection.services.settingService.get(), "setting.get");
  console.log(`[b2a] OK setting.get (locale=${settings?.locale ?? "?"})`);

  // 只读探测:apply 是写接口,绝不能在连通性探针里调用(会覆盖对端个人配置并删凭据)。
  const view = await withTimeout(
    connection.services.providerSettingsService.getView(),
    "provider-settings.getView",
  );
  console.log(`[b2a] OK provider-settings.getView (providers=${view?.providers?.length ?? "?"})`);

  await connection.disposeAndWait({ timeoutMs: 5_000 });
  console.log(`[b2a] remote close code=${remoteCloseCode}`);
  console.log("[b2a] done");
  process.exit(0);
}

main().catch((error) => {
  console.error(`[b2a] FATAL ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
