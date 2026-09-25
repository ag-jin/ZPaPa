// 常驻会话主机(resident host)↔ desktop main 的 parentPort 消息协议。
// 与 HostMessageTypes 同一归属:跨进程消息类型统一放 shared,两端独立 tsconfig 均可引用。
// 主机进程本体见 packages/desktop/src/residentHost/index.ts,管理器见 main/desktopResidentHost.ts。

export interface ResidentHostReadyMessage {
  type: "resident-host-ready";
  /** 实际监听端口(临时端口,由 OS 分配)。 */
  port: number;
  version: string;
  protocolVersion: number;
}

export interface ResidentHostLogMessage {
  type: "resident-host-log";
  level: "info" | "warn" | "error";
  message: string;
}

export interface ResidentHostFatalMessage {
  type: "resident-host-fatal";
  message: string;
}

export type ResidentHostToMainMessage =
  | ResidentHostReadyMessage
  | ResidentHostLogMessage
  | ResidentHostFatalMessage;

export interface MainToResidentHostMessage {
  type: "resident-host-quit";
}
