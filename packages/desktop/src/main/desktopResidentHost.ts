// desktop main 侧的常驻会话主机（resident host）进程管理器。
// 职责：拉起/重启常驻 host utility process；把监听端口写入 resident-host.json
// （供对端经 SSH `cat` 发现）；App 退出前优雅收尾并清理状态文件。
// 主机生命周期只归本机：对端连接不影响进程生死，也不触发任何部署动作。
import { utilityProcess as electronUtilityProcess } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAppConfigDir } from "@zcode/services/node";
import type { ResidentHostToMainMessage } from "@zcode/shared";
import { buildHostProcessEnv, residentHostModulePath } from "./desktopRuntimeEnv.js";

interface ResidentHostDeps {
  hostProcessLocalEnv: Record<string, string>;
  /** 桌面解析出的 Built-in Provider 配置路径（与本地 Host 同源）。 */
  builtinProviderConfigFilePath: string;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

export interface ResidentHostStatusFile {
  host: string;
  port: number;
  pid: number | null;
  version: string;
  protocolVersion: number;
  startedAt: number;
}

export interface ResidentHostHandle {
  /** App 退出前优雅收尾：清状态文件 → 通知 host 释放资源 → 兜底强杀。 */
  dispose: () => Promise<void>;
}

export const RESIDENT_HOST_STATUS_FILE_NAME = "resident-host.json";
export const RESIDENT_HOST_DISABLED_ENV = "ZCODE_RESIDENT_HOST_DISABLED";

const RESTART_BACKOFF_MS = 5_000;
const MAX_RESTART_ATTEMPTS = 5;
const DISPOSE_FORCE_KILL_MS = 3_000;

function residentHostStatusFilePath(): string {
  return join(getAppConfigDir(), RESIDENT_HOST_STATUS_FILE_NAME);
}

function writeResidentHostStatus(status: ResidentHostStatusFile): void {
  writeFileSync(residentHostStatusFilePath(), JSON.stringify(status, null, 2), "utf8");
}

function removeResidentHostStatus(): void {
  rmSync(residentHostStatusFilePath(), { force: true });
}

export function spawnResidentHost(deps: ResidentHostDeps): ResidentHostHandle | null {
  if (process.env[RESIDENT_HOST_DISABLED_ENV]?.trim() === "1") {
    deps.logger.info("[resident-host] disabled by env, skip spawn");
    return null;
  }

  let child: ElectronUtilityProcess | null = null;
  let disposing = false;
  let restartAttempts = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let disposeWait: (() => void) | null = null;

  const spawn = (): void => {
    child = electronUtilityProcess.fork(residentHostModulePath, [], {
      serviceName: "zcode-resident-host",
      execArgv: ["--no-warnings"],
      env: {
        ...buildHostProcessEnv(deps.hostProcessLocalEnv),
        ZCODE_PROCESS_LABEL: "resident-host",
        ZCODE_RESIDENT_BUILTIN_PROVIDER_CONFIG: deps.builtinProviderConfigFilePath,
      },
    });
    deps.logger.info(`[resident-host] forked pid=${child.pid}`);

    child.on("message", (raw: unknown) => {
      const message = raw as ResidentHostToMainMessage;
      if (!message || typeof message !== "object") return;
      if (message.type === "resident-host-log") {
        const level = message.level === "warn" ? "warn" : message.level === "error" ? "error" : "info";
        deps.logger[level](`[resident-host] ${message.message}`);
        return;
      }
      if (message.type === "resident-host-fatal") {
        deps.logger.error(`[resident-host] fatal: ${message.message}`);
        return;
      }
      if (message.type === "resident-host-ready") {
        restartAttempts = 0;
        writeResidentHostStatus({
          host: "127.0.0.1",
          port: message.port,
          pid: child?.pid ?? null,
          version: message.version,
          protocolVersion: message.protocolVersion,
          startedAt: Date.now(),
        });
        deps.logger.info(
          `[resident-host] ready port=${message.port} version=${message.version} protocol=${message.protocolVersion}`,
        );
      }
    });

    child.on("exit", () => {
      if (disposing) {
        disposeWait?.();
        return;
      }
      // 崩溃自愈：有界退避重启；超限后清状态文件，让对端按"无常驻主机"回退 legacy 连接。
      removeResidentHostStatus();
      if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
        deps.logger.error(
          `[resident-host] exited and restart budget exhausted (${restartAttempts}), giving up`,
        );
        return;
      }
      restartAttempts += 1;
      deps.logger.warn(
        `[resident-host] exited unexpectedly, restart ${restartAttempts}/${MAX_RESTART_ATTEMPTS} in ${RESTART_BACKOFF_MS}ms`,
      );
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (!disposing) spawn();
      }, RESTART_BACKOFF_MS);
    });
  };

  spawn();

  return {
    async dispose(): Promise<void> {
      if (disposing) return;
      disposing = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      removeResidentHostStatus();
      const current = child;
      if (!current) return;
      const exited = new Promise<void>((resolve) => {
        disposeWait = resolve;
      });
      try {
        current.postMessage({ type: "resident-host-quit" });
      } catch (error) {
        deps.logger.warn("[resident-host] postMessage quit failed:", error);
      }
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            current.kill();
            resolve();
          }, DISPOSE_FORCE_KILL_MS);
          timer.unref?.();
        }),
      ]);
    },
  };
}
