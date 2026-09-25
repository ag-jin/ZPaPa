// A 端经 SSH 隧道挂载对端「常驻会话主机」（远程项目升级第 1 期 A 端）。
// 流程：读对端 ~/.zcode/v2/resident-host.json（发现+协议协商）→ backend.openTcpTunnel
// 打本地隧道 → POST /api/rpc-host-capability 取一次性票据 → ws /ws/host 以
// desktop-continuous 角色挂载。任一步不满足返回 null，由调用方回退 legacy stdio 模式；
// 本模块绝不部署/升级对端任何运行时（版本策略由协议版本协商决定）。
import WebSocket from "ws";
import { ChannelClient, SocketProtocol } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { RemoteServiceAccess } from "@zcode/client";
import {
  formatLogPrefix,
  SERVER_REMOTE_PROTOCOL_VERSION,
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
} from "@zcode/shared";
import type { IRemoteBackend, RemoteTcpTunnel } from "./backend.js";
import type { RemoteConnection } from "./connect.js";
import { wrapWebSocket } from "../http.js";

/** 对端常驻主机状态文件（B 端 desktop main 写入；v1 假定默认数据目录）。 */
export const RESIDENT_HOST_STATUS_REMOTE_PATH = "~/.zcode/v2/resident-host.json";

interface ResidentHostStatusFile {
  host?: string;
  port?: number;
  version?: string;
  protocolVersion?: number;
}

export interface ConnectResidentOptions {
  signal?: AbortSignal;
  onDidRemoteClose?: (event: { code: number }) => void;
}

const CONNECT_TIMEOUT_MS = 15_000;

function parseResidentHostStatus(raw: string): ResidentHostStatusFile | null {
  try {
    const parsed = JSON.parse(raw) as ResidentHostStatusFile;
    if (
      typeof parsed.port === "number" &&
      parsed.port > 0 &&
      typeof parsed.protocolVersion === "number" &&
      typeof parsed.host === "string" &&
      parsed.host.trim()
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 尝试挂载对端常驻会话主机。返回 null 表示对端没有常驻主机或协议不兼容，
 * 调用方应回退 legacy connectRemote；失败时不动 backend（回退路径还要复用它）。
 */
export async function connectResidentRemote(
  backend: IRemoteBackend,
  options: ConnectResidentOptions = {},
): Promise<RemoteConnection | null> {
  const log = (...args: unknown[]) =>
    console.log(formatLogPrefix("connectResident", process.pid), ...args);

  if (options.signal?.aborted) return null;
  if (!backend.openTcpTunnel) return null;

  // 1) 发现：读对端状态文件。文件不存在/损坏视为"无常驻主机"，直接回退。
  let status: ResidentHostStatusFile | null = null;
  try {
    const raw = await backend.readFile(RESIDENT_HOST_STATUS_REMOTE_PATH);
    status = parseResidentHostStatus(raw);
  } catch {
    return null;
  }
  if (!status) {
    log("no resident host status file, falling back to legacy stdio connection");
    return null;
  }

  // 2) 协议协商：只看远程功能协议版本，与软件版本无关（A 不强制 B 升级）。
  //    v1 兼容窗口：完全相等；未来破坏性改动时在此放宽为区间判断。
  if (status.protocolVersion !== SERVER_REMOTE_PROTOCOL_VERSION) {
    log(
      `resident host protocol mismatch: remote=${status.protocolVersion} local=${SERVER_REMOTE_PROTOCOL_VERSION}, falling back to legacy`,
    );
    return null;
  }

  // 3) 隧道：本地临时端口 → 对端回环 host:port。
  let tunnel: RemoteTcpTunnel;
  try {
    tunnel = await backend.openTcpTunnel({
      remoteHost: status.host!,
      remotePort: status.port!,
    });
  } catch (error) {
    log("tcp tunnel failed:", error instanceof Error ? error.message : String(error));
    return null;
  }

  try {
    // 4) 票据 + WS 挂载（desktop-continuous 角色）。任何失败都视为不可用并回退。
    const baseUrl = `http://127.0.0.1:${tunnel.localPort}`;
    const connection = await attachResidentWebSocket(baseUrl, options, log);
    log(
      `resident host attached via ws tunnel (remote version=${status.version ?? "?"} protocol=${status.protocolVersion})`,
    );

    let disposalStarted = false;
    const beginDisposal = () => {
      if (disposalStarted) return;
      disposalStarted = true;
      backendDisconnectDisposable?.dispose();
      try {
        connection.disposeTransport();
      } finally {
        tunnel.dispose();
      }
    };
    const backendDisconnectDisposable = backend.onDidDisconnect?.(() => {
      // SSH 断开时隧道必然失效，并入同一条关闭上报链路。
      connection.reportRemoteClose(-1);
    });

    return {
      services: connection.services,
      client: connection.client,
      dispose() {
        beginDisposal();
        backend.dispose();
      },
      async disposeAndWait(disposeOptions) {
        beginDisposal();
        await connection.waitClose(Math.max(disposeOptions?.timeoutMs ?? 5_000, 0));
        if (backend.disposeAndWait) {
          await backend.disposeAndWait();
          return;
        }
        backend.dispose();
      },
    };
  } catch (error) {
    tunnel.dispose();
    log(
      "resident host attach failed, falling back to legacy:",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

interface ResidentWebSocketAttachment {
  services: IServiceAccessor;
  client: ChannelClient;
  disposeTransport(): void;
  waitClose(timeoutMs: number): Promise<void>;
  reportRemoteClose(code: number): void;
}

async function attachResidentWebSocket(
  baseUrl: string,
  options: ConnectResidentOptions,
  log: (...args: unknown[]) => void,
): Promise<ResidentWebSocketAttachment> {
  const timeoutMs = CONNECT_TIMEOUT_MS;
  const ticketResponse = await fetch(`${baseUrl}/api/rpc-host-capability`, {
    method: "POST",
    signal: options.signal,
  });
  if (!ticketResponse.ok) {
    throw new Error(`rpc-host-capability status ${ticketResponse.status}`);
  }
  const ticket = (await ticketResponse.json()) as { capability?: string };
  if (!ticket.capability) {
    throw new Error("rpc-host-capability response missing capability");
  }

  const ws = new WebSocket(`ws://127.0.0.1:${new URL(baseUrl).port}/ws/host`, {
    headers: { [ZCODE_RPC_HOST_CAPABILITY_HEADER]: ticket.capability },
  });

  let closed = false;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let reportedClose = false;
  const reportRemoteClose = (code: number) => {
    if (reportedClose) return;
    reportedClose = true;
    options.onDidRemoteClose?.({ code });
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("resident host ws upgrade timed out"));
    }, timeoutMs);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const socket = wrapWebSocket(ws);
  socket.onClose(() => {
    closed = true;
    resolveClosed();
    reportRemoteClose(1000);
  });
  const protocol = new SocketProtocol(socket);
  const client = new ChannelClient(protocol);

  return {
    services: new RemoteServiceAccess(client),
    client,
    disposeTransport() {
      try {
        ws.close();
      } catch {
        // 关闭失败直接走 terminate 兜底。
        ws.terminate();
      }
      protocol.dispose();
      client.dispose();
    },
    async waitClose(timeoutMs: number) {
      if (closed) return;
      await Promise.race([
        closedPromise,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, timeoutMs);
          timer.unref?.();
        }),
      ]);
      ws.terminate();
    },
    reportRemoteClose(code: number) {
      reportRemoteClose(code);
    },
  };
}
