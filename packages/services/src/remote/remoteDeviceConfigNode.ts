/**
 * 远程设备配置服务的 Node 侧实现：独立文件存储。
 *
 * 文件位置：`<应用配置目录>/remote-devices.json`（与 credentials.json 同级）。
 * 写入用原子替换 + 文件锁，与产品其它私有配置一致。
 */
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import { z } from "zod";
import type { IRemoteDeviceConfigService, RemoteDeviceConfigRecord } from "./remoteDeviceConfig.js";

export const REMOTE_DEVICES_FILE_NAME = "remote-devices.json";

const sshTargetSchema = z.object({
  kind: z.literal("ssh"),
  host: z.string().trim().min(1),
  port: z.number().int().positive().max(65535).optional(),
  username: z.string().trim().min(1),
  sshConfigAlias: z.string().optional(),
  privateKeyPath: z.string().optional(),
  privateKeyPassphrase: z.string().optional(),
});

const wslTargetSchema = z.object({
  kind: z.literal("wsl"),
  distro: z.string().optional(),
  user: z.string().optional(),
});
const dockerTargetSchema = z.object({
  kind: z.literal("docker"),
  container: z.string().trim().min(1),
});
const targetSchema = z.discriminatedUnion("kind", [
  sshTargetSchema,
  wslTargetSchema,
  dockerTargetSchema,
]);

const deviceRecordSchema = z.object({
  target: targetSchema,
  lastConnectedAt: z.number().int().nonnegative().optional(),
  lastConnectionStatus: z.enum(["connected", "failed", "never"]).default("never"),
  lastConnectionError: z.string().optional(),
  visibleProjects: z.record(z.string(), z.boolean()).optional(),
});

const devicesFileSchema = z.object({
  schemaVersion: z.literal(1),
  devices: z.array(deviceRecordSchema).default([]),
});

/**
 * 解析设备文件。
 *
 * 单条损坏不应让整份设备列表不可用：逐条 safeParse 后只保留可解析项，
 * 避免一条坏数据导致用户"设备凭空消失"且无从恢复。
 */
function parseDevicesFile(value: unknown): RemoteDeviceConfigRecord[] {
  const envelope = z
    .object({ schemaVersion: z.literal(1).optional(), devices: z.array(z.unknown()).optional() })
    .safeParse(value);
  if (!envelope.success) return [];
  const raw = envelope.data.devices ?? [];
  const records: RemoteDeviceConfigRecord[] = [];
  for (const item of raw) {
    const parsed = deviceRecordSchema.safeParse(item);
    if (parsed.success) records.push(parsed.data as RemoteDeviceConfigRecord);
  }
  return records;
}

export function createRemoteDeviceConfigService(options: {
  readonly configDir: string;
  readonly onError?: (error: unknown) => void;
}): IRemoteDeviceConfigService {
  const filePath = join(options.configDir, REMOTE_DEVICES_FILE_NAME);

  return {
    async list(): Promise<RemoteDeviceConfigRecord[]> {
      try {
        const text = await readFile(filePath, "utf8");
        return parseDevicesFile(JSON.parse(text));
      } catch (error) {
        // 文件缺失(ENOENT)是正常路径：尚未保存过任何设备。
        if ((error as { code?: string })?.code === "ENOENT") return [];
        // 读失败按"无设备"处理，并上报：不能让配置问题阻断设备管理界面。
        options.onError?.(error);
        return [];
      }
    },

    async save(devices): Promise<void> {
      await withFileLock(filePath, async () => {
        const payload = { schemaVersion: 1 as const, devices: [...devices] };
        await atomicWritePrivateTextFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
      });
    },
  };
}
