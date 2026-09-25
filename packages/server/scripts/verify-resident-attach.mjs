#!/usr/bin/env node
/**
 * 常驻会话主机 A 端挂载验证（单机版）。
 *
 * 用一个「直连隧道」的 mock backend 模拟 SSH forwardOut（ssh-backend 的 openTcpTunnel
 * 在真 SSH 连接上行为等价），完整跑通 connectResidentRemote 链路：
 *   状态文件发现 → 协议版本协商 → POST /api/rpc-host-capability → ws /ws/host 挂载
 *   → 真实 RPC 调用（setting.get）→ disposeAndWait 优雅关闭。
 *
 * 用法：
 *   node scripts/verify-resident-attach.mjs
 * 前置：本机 ZCode 桌面 App 已运行（常驻主机在线，~/.zcode/v2/resident-host.json 存在）。
 * 真实 SSH 隧道层的验证见 zcode-server-cli/scripts/verify-remote-ssh.mjs（需 sshd 容器）。
 */
import { createConnection, createServer } from "node:net";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ${message}`);
    process.exit(1);
  }
  console.log(`✅ ${message}`);
}

const statusPath = join(homedir(), ".zcode/v2/resident-host.json");
const status = JSON.parse(readFileSync(statusPath, "utf8"), );
assert(status.port > 0, `resident host status file loaded (port=${status.port} protocol=${status.protocolVersion})`);

const { connectResidentRemote } = await tsImport(
  pathToFileURL(join(packageRoot, "src/remote/connect-resident.ts")).href,
  import.meta.url,
);

// mock backend：readFile 返回真实状态文件；openTcpTunnel 建立到目标的直连 TCP 隧道。
const backend = {
  async readFile() {
    return JSON.stringify(status);
  },
  async openTcpTunnel({ remoteHost, remotePort }) {
    const server = createServer();
    const sockets = new Set();
    server.on("connection", (local) => {
      const remote = createConnection({ host: remoteHost, port: remotePort });
      sockets.add(local);
      sockets.add(remote);
      local.pipe(remote);
      remote.pipe(local);
      const cleanup = () => {
        for (const socket of [local, remote]) {
          socket.destroy();
          sockets.delete(socket);
        }
      };
      local.on("close", cleanup);
      remote.on("close", cleanup);
      local.on("error", cleanup);
      remote.on("error", cleanup);
    });
    const localPort = await new Promise((resolvePort, rejectPort) => {
      server.once("error", rejectPort);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (typeof address === "object" && address) {
          resolvePort(address.port);
          return;
        }
        rejectPort(new Error("tunnel listen failed"));
      });
    });
    return {
      localPort,
      dispose() {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close();
      },
    };
  },
  dispose() {},
};

let remoteCloseCode = null;
const connection = await connectResidentRemote(backend, {
  onDidRemoteClose: ({ code }) => {
    remoteCloseCode = code;
  },
});
assert(connection !== null, "connectResidentRemote returned a connection (discovery + negotiation + ticket + ws attach)");

const settings = await connection.services.settingService.get();
assert(
  typeof settings === "object" && settings !== null,
  `real RPC call over resident host ok (setting.get, locale=${settings?.locale ?? "?"})`,
);

await connection.disposeAndWait({ timeoutMs: 5_000 });
assert(remoteCloseCode !== null, `remote close reported after dispose (code=${remoteCloseCode})`);

console.log("resident attach verification passed");
process.exit(0);
