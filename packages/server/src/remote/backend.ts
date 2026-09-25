import type { IDisposable, Event } from "@zcode/rpc";

export interface RemoteEnvironment {
  platform: string; // "linux" | "darwin"
  arch: string; // "x64" | "arm64"
}

export interface StdioStream {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  onClose: Event<number>; // exit code
}

export type RemoteDisconnectReason = "error" | "close" | "end";

export interface RemoteDisconnectEvent {
  reason: RemoteDisconnectReason;
  error?: Error;
}

export interface RemoteUploadProgress {
  uploadedBytes: number;
  totalBytes: number;
}

export interface RemoteUploadOptions {
  onProgress?: (progress: RemoteUploadProgress) => void;
  signal?: AbortSignal;
}

export interface IRemoteBackend extends IDisposable {
  /** WSL 可选的运行时网络解析；其它远端类型保持未注入。 */
  resolveRuntimeProxy?(proxyUrl: string): Promise<string>;
  /** 等待当前 backend 自己创建的底层进程/连接完成回收；不允许扩大到共享运行时。 */
  disposeAndWait?(options?: { graceTimeoutMs?: number; killWaitTimeoutMs?: number }): Promise<void>;
  /** 远端底层连接断开事件；用于补偿 stdio channel 没有及时 close 的半开连接。 */
  onDidDisconnect?: Event<RemoteDisconnectEvent>;
  /**
   * 可选：在本地开启 TCP 隧道转发到远端回环端口（ssh2 forwardOut）。
   * 远程项目升级 A 端经隧道挂载对端常驻会话主机时使用；仅 SSH backend 提供。
   */
  openTcpTunnel?(options: { remoteHost: string; remotePort: number }): Promise<RemoteTcpTunnel>;
  /** Detect remote environment (no Node.js required) */
  detect(): Promise<RemoteEnvironment>;
  /** Upload a file to the remote machine */
  upload(localPath: string, remotePath: string, options?: RemoteUploadOptions): Promise<void>;
  /** Execute a command on the remote machine, returning stdio streams */
  exec(command: string): Promise<StdioStream>;
  /** Check if a remote file exists */
  exists(remotePath: string): Promise<boolean>;
  /** Read a small remote file (e.g. version string) */
  readFile(remotePath: string): Promise<string>;
}

export interface RemoteTcpTunnel {
  /** 本地监听端口（临时端口，经 127.0.0.1 访问）。 */
  readonly localPort: number;
  /** 关闭本地监听并断开已建立的转发连接。 */
  dispose(): void;
}
