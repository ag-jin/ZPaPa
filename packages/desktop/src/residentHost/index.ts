// 常驻会话主机进程：由 desktop main 通过 electronUtilityProcess.fork 拉起。
// 远程项目升级（第 1 期 B 端）：本机常驻 host，监听 127.0.0.1 临时端口，提供
// /api/server-info、/api/rpc-host-capability、/ws（回放客户端）、/ws/host（桌面连续角色）。
// 生命周期归本机桌面 App：App 启动随之启动、退出随之优雅退出；对端（A 机）的 SSH 连接
// 只做"隧道 + 挂载"，不再管进程生死，也不再触发任何部署/升级动作。
// 端口经 parentPort 上报，由 main 写入 resident-host.json 供远端经 SSH 发现。
import { createLocalServices, disposeServiceResourcesAndWait } from "@zcode/services/node";
import {
  SERVER_REMOTE_PROTOCOL_VERSION,
  ZCODE_VERSION,
  type MainToResidentHostMessage,
  type ResidentHostToMainMessage,
} from "@zcode/shared";
import { createHttpServer } from "@zcode/server";

const builtinProviderConfigFilePath = process.env.ZCODE_RESIDENT_BUILTIN_PROVIDER_CONFIG?.trim();

const { parentPort } = process;

function post(message: ResidentHostToMainMessage): void {
  parentPort?.postMessage(message);
  // 兜底：非 utilityProcess 调试运行时留痕，便于本地验证。
  if (!parentPort) {
    console.log(`[resident-host] ${JSON.stringify(message)}`);
  }
}

function log(level: "info" | "warn" | "error", message: string): void {
  post({ type: "resident-host-log", level, message });
}

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await disposeServiceResourcesAndWait(services);
  } catch (error) {
    log("warn", `dispose failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    process.exit(0);
  }
}

if (!builtinProviderConfigFilePath) {
  post({ type: "resident-host-fatal", message: "ZCODE_RESIDENT_BUILTIN_PROVIDER_CONFIG is required" });
  process.exit(1);
}

// 与现有 SSH 远端 server 同一服务面与权威模式：对端远程工作区装配（remoteWorkspaceServiceCollection）
// 依赖的通道集合不变，A 机经 /ws/host 挂载与经 stdio 直连看到的服务完全一致。
const services = createLocalServices({
  zcodeBuiltinProviderConfigFilePath: builtinProviderConfigFilePath,
  serviceAuthorityMode: "desktop-attached-remote",
});

// 仅回环 + 临时端口：对外暴露面为零，跨机访问只能经由 SSH 隧道。
const server = createHttpServer(services, 0, {
  host: "127.0.0.1",
  name: "ZCode Resident Host",
});

// listen 是异步的：port 0 由 OS 分配，必须等 listening 事件后才能从 address() 拿到端口。
const port = await new Promise<number>((resolve, reject) => {
  const initial = server.address();
  if (typeof initial === "object" && initial?.port) {
    resolve(initial.port);
    return;
  }
  const timeout = setTimeout(() => {
    reject(new Error("resident host listening timeout"));
  }, 10_000);
  timeout.unref?.();
  const onError = (error: Error) => {
    clearTimeout(timeout);
    reject(error);
  };
  server.once("listening", () => {
    clearTimeout(timeout);
    server.off("error", onError);
    const listening = server.address();
    resolve(typeof listening === "object" && listening ? listening.port : 0);
  });
  server.once("error", onError);
}).catch((error: unknown) => {
  post({
    type: "resident-host-fatal",
    message: `listen failed: ${error instanceof Error ? error.message : String(error)}`,
  });
  return 0;
});

if (!port) {
  void shutdown();
} else {
  post({
    type: "resident-host-ready",
    port,
    version: ZCODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
  });
  log("info", `listening on 127.0.0.1:${port} version=${ZCODE_VERSION}`);
}

parentPort?.on("message", (event: { data?: unknown }) => {
  const message = event.data as MainToResidentHostMessage | undefined;
  if (message?.type === "resident-host-quit") {
    void shutdown();
  }
});
// main 进程退出时 parentPort 关闭，不能留下持有 tasks-index / agent 子进程的孤儿 host。
parentPort?.on("close", () => {
  void shutdown();
});
