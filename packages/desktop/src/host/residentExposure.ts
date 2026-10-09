/**
 * 把窗口 host 对外暴露为「可远程挂载的常驻主机」。
 *
 * ## 为什么需要（见 ADR 0003）
 *
 * 投射端（A）与被投射端（B）必须共用**同一份运行时**，否则会话运行态分叉：
 * agent 的会话状态是进程内内存态（`context.sessions` 每进程一份，`resumeSession`
 * 命中内存即早退、不重读库）。若 B 上并存两个 host，A 经常驻主机跑出的轮次
 * 虽写进共享 sqlite，B 本机 host 的 runtime 内存里却没有，且永不回读 ——
 * 两端进度永久分叉（实测：B 的 UI 停在原地，A 已推进多轮）。
 *
 * 因此不新起第二个 host，而是让**已经在服务 B 桌面 UI 的那个窗口 host** 额外
 * 提供一个回环监听端口，供 A 经 SSH 隧道挂载。同一个进程、同一份 services、
 * 同一份运行时 → 天然一致。
 *
 * ## 为什么不反过来（让 B 的 UI 去连独立常驻主机）
 *
 * 窗口 host 承担 14 项仅它具备的职责（DB 启动门禁、广播总线、任务实时总线、
 * CUA 操作状态投影、agent 预热、feedback、deviceMid 等）。让 UI 改连独立常驻
 * 主机意味着迁移这全部职责，且常驻主机的 `desktop-attached-remote` 模式会
 * 使 B 失去电脑控制（CUA）。方向反过来则**零迁移**。
 *
 * ## 边界
 *
 * - 只监听回环（`127.0.0.1`）+ 临时端口，对外暴露面为零；跨机访问只能经 SSH 隧道。
 * - 发现文件格式与既有 `resident-host.json` 一致，A 侧 `connectResidentRemote`
 *   无需改动。
 * - 生命周期随窗口 host：host 退出即清理文件，A 侧据此判定设备离线。
 */
import { createHttpServer } from "@zcode/server";
import type { ServiceCollection } from "@zcode/services";
import { SERVER_REMOTE_PROTOCOL_VERSION, ZCODE_VERSION } from "@zcode/shared";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAppConfigDir } from "@zcode/services/node";

/** 发现文件名与 residentHost 保持一致（A 侧按该路径读取，不可漂移）。 */
export const RESIDENT_HOST_STATUS_FILE_NAME = "resident-host.json";

export interface ResidentExposureHandle {
  readonly port: number;
  dispose(): void;
}

interface ResidentExposureOptions {
  services: ServiceCollection;
  log: (message: string) => void;
  warn: (message: string, error?: unknown) => void;
}

function statusFilePath(): string {
  return join(getAppConfigDir(), RESIDENT_HOST_STATUS_FILE_NAME);
}

/** 选举锁：确保同一设备上**只有一个** host 对外暴露（单一运行时不变量的前提）。 */
function lockFilePath(): string {
  return join(getAppConfigDir(), "resident-host.lock");
}

/**
 * 尝试成为对外暴露的那个 host（先到先得）。
 *
 * 为什么需要：窗口 host 是 per-window 的。若开了两个窗口，两个 host 都会写
 * resident-host.json，后写覆盖先写 —— 投射端可能挂到一个即将关闭的窗口上，
 * 而"一台设备一份运行时"这个前提也被破坏。锁保证只有第一个 host 暴露。
 *
 * 陈锁处理：进程已退出（kill(pid, 0) 失败）时抢占，避免上次异常退出后永久失效。
 */
function tryAcquireExposureLock(): "acquired" | "held-by-other" {
  const lockPath = lockFilePath();
  const write = (): boolean => {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };
  if (write()) return "acquired";

  // 锁已存在：判活。活着则让给它，死了则抢占一次。
  let ownerPid: number | null = null;
  try {
    const raw = readFileSync(lockPath, "utf8").trim();
    const parsed = Number.parseInt(raw, 10);
    ownerPid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    ownerPid = null;
  }
  if (ownerPid !== null && ownerPid !== process.pid) {
    try {
      process.kill(ownerPid, 0);
      return "held-by-other";
    } catch {
      // 进程已不存在：抢占陈锁。
    }
  }
  try {
    rmSync(lockPath, { force: true });
  } catch {
    return "held-by-other";
  }
  return write() ? "acquired" : "held-by-other";
}

/**
 * 让当前 host 可被远程挂载。幂等：重复调用返回同一个句柄。
 *
 * 失败不抛出 —— 远程挂载是附加能力，不应因为端口占用或权限问题让本机 UI 起不来。
 */
let exposure: ResidentExposureHandle | null = null;
let exposureInFlight: Promise<ResidentExposureHandle | null> | null = null;
/**
 * 已请求退出。监听可能在 10s 超时窗口内迟到成功 —— 此时必须自行撤销：
 * 留着会写出一个指向"即将不存在的进程"的发现文件，让投射端连上一个死端口。
 */
let disposed = false;

export async function exposeAsResidentHost(
  options: ResidentExposureOptions,
): Promise<ResidentExposureHandle | null> {
  if (disposed) return null;
  if (exposure) return exposure;
  if (exposureInFlight) return exposureInFlight;

  exposureInFlight = (async () => {
    try {
      if (tryAcquireExposureLock() === "held-by-other") {
        // 另一个窗口的 host 已经在对外服务：让给它，避免两个 host 争同一个发现文件。
        options.log("another window host already serves as resident; skipping");
        return null;
      }
      const listeningServer = createHttpServer(options.services, 0, { host: "127.0.0.1" });
      const port = await new Promise<number>((resolve, reject) => {
        const initial = listeningServer.address();
        if (typeof initial === "object" && initial?.port) {
          resolve(initial.port);
          return;
        }
        const timer = setTimeout(
          () => reject(new Error("resident exposure listen timeout")),
          10_000,
        );
        listeningServer.once("listening", () => {
          clearTimeout(timer);
          const listening = listeningServer.address();
          resolve(typeof listening === "object" && listening ? listening.port : 0);
        });
      });
      if (!port) throw new Error("resident exposure got no port");
      if (disposed) {
        // 退出期间才就绪：不写发现文件，直接关掉并交还锁。
        try {
          listeningServer.close();
        } catch {
          // 关闭失败无关紧要：进程即将退出，内核会回收监听。
        }
        try {
          rmSync(lockFilePath(), { force: true });
        } catch {
          // 忽略：下次启动的判活逻辑会清理陈锁。
        }
        return null;
      }

      writeFileSync(
        statusFilePath(),
        `${JSON.stringify(
          {
            host: "127.0.0.1",
            port,
            pid: process.pid,
            version: ZCODE_VERSION,
            protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
            startedAt: Date.now(),
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      options.log(`exposed as resident host on 127.0.0.1:${port}`);

      let handleDisposed = false;
      const handle: ResidentExposureHandle = {
        port,
        dispose: () => {
          if (handleDisposed) return;
          handleDisposed = true;
          try {
            listeningServer.close();
          } catch (error) {
            options.warn("resident exposure close failed", error);
          }
          try {
            rmSync(statusFilePath(), { force: true });
          } catch {
            // 文件已被删或权限不足：host 即将退出，残留由下次启动覆盖。
          }
          try {
            rmSync(lockFilePath(), { force: true });
          } catch {
            // 同上：锁文件残留时会由下一个 host 的判活逻辑抢占。
          }
          if (exposure === handle) exposure = null;
        },
      };
      exposure = handle;
      return handle;
    } catch (error) {
      // 抢了锁但没服务成功：必须释放，否则别的窗口 host 永远不会接管。
      try {
        rmSync(lockFilePath(), { force: true });
      } catch {
        // 忽略：下次启动的判活逻辑会清理。
      }
      options.warn("expose as resident host failed（远程挂载不可用，本机功能不受影响）", error);
      return null;
    } finally {
      exposureInFlight = null;
    }
  })();

  return exposureInFlight;
}

/** 供 host 退出时调用：关闭监听并移除发现文件。 */
export function disposeResidentExposure(): void {
  disposed = true;
  exposure?.dispose();
}
