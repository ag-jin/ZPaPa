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
export type ResidentHostToMainMessage = ResidentHostReadyMessage | ResidentHostLogMessage | ResidentHostFatalMessage;
export interface MainToResidentHostMessage {
    type: "resident-host-quit";
}
//# sourceMappingURL=residentHostProtocol.d.ts.map