#!/usr/bin/env node
/**
 * 验收（设备级投射 · UI 路径）：设备通道读项目 + 读改设备设置。
 *
 * 为什么单独一个脚本：`acceptance-device-connect.ts` 走 connectResidentRemote 直连，
 * 那条路上 `settingService` 本来就是对端的；而 UI 经窗口 Host 的 scoped collection，
 * 那里的 `ISettingService` 被刻意注册为本机实现（模型配置/凭据必须读写本机），
 * 因此设备投射必须走专用通道 `IRemoteDeviceProjectsService`。
 * 本脚本复刻 Host 侧该通道的实现方式（用对端原始访问面代为读写），
 * 从而在没有 UI 的环境里也能验证这条链路。
 *
 * 只读 + 受控写：写操作只碰一个显示类布尔，且严格走
 * 「记录原值 → 写入 → 读回确认 → 回滚」，绝不触碰会话/项目数据。
 *
 * 跑法：node --import tsx packages/desktop/test/acceptance-device-channel.ts
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const repoRoot = "/Users/linguojin/Workspace/ZCode/ZPaPa";
const { connectResidentRemote } = await tsImport(
  pathToFileURL(join(repoRoot, "packages/server/src/remote/connect-resident.ts")).href,
  import.meta.url,
);
const { createRemoteBackend } = await tsImport(
  pathToFileURL(join(repoRoot, "packages/server/src/remote/create-backend.ts")).href,
  import.meta.url,
);
const { createDeviceAccess, buildProjectedProjectList } = await tsImport(
  pathToFileURL(join(repoRoot, "packages/ui/src/lib/remoteDeviceAccess.ts")).href,
  import.meta.url,
);
const { pickProjectableSettings } = await tsImport(
  pathToFileURL(join(repoRoot, "packages/ui/src/lib/remoteDeviceSettings.ts")).href,
  import.meta.url,
);

const failures = [];
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `（${detail}）` : ""}`);
  if (!ok) failures.push(label);
}

const backend = await createRemoteBackend({
  kind: "ssh",
  host: "100.66.1.2",
  port: 22,
  username: "linguojin",
  privateKeyPath: join(homedir(), ".ssh/id_ed25519_imac"),
});
const t0 = Date.now();
const conn = await connectResidentRemote(backend, { onDidRemoteClose: () => {} });
if (!conn) {
  console.error("❌ 设备级连接失败");
  process.exit(1);
}
console.log(`✅ 设备级连接成功（无目录，${Date.now() - t0}ms）\n`);

// ── 复刻 Host 侧 IRemoteDeviceProjectsService 的实现 ────────────────────────────
// （packages/desktop/src/host/remoteWorkspaceServiceCollection.ts 里注册的那份）
const deviceChannel = {
  listRegisteredProjects: async (): Promise<string[]> => {
    const settings = await conn.services.settingService.get();
    const recent = settings.recentProjects ?? [];
    return recent.filter((item): item is string => typeof item === "string" && item.length > 0);
  },
  getSettings: async (): Promise<Record<string, unknown>> =>
    (await conn.services.settingService.get()) as unknown as Record<string, unknown>,
  updateSetting: async (key: string, value: unknown): Promise<void> => {
    await conn.services.settingService.update({ [key]: value });
  },
};

// ── 1) 设备访问层经设备通道读项目清单 ──────────────────────────────────────────
const access = await createDeviceAccess({
  zcodeTaskService: conn.services.zcodeTaskService,
  settingService: conn.services.settingService,
  remoteDeviceProjectsService: deviceChannel,
});
const registered = await access.access.listRegisteredProjects();
const tasks = await access.access.listAllTasks();
const projects = buildProjectedProjectList({ registeredProjects: registered, tasks });

console.log("── 项目清单（设备通道 vs 本机 settingService）──");
console.log(`   设备通道读到: ${registered.length} 个项目`);
console.log(`   首 3 个: ${JSON.stringify(registered.slice(0, 3))}`);
console.log(`   会话 ${tasks.length} 条 / 投影项 ${projects.length} 个\n`);

// 关键判据：设备通道读到的不能是 A 自己的 recentProjects。
// 常见表现是读到 /Users/jin1/... 这类本机路径；设备项目应为 /Volumes/... 等对端路径。
const localSettings = (await conn.services.settingService.get()).recentProjects ?? [];
check("设备项目清单非空", registered.length > 0, `${registered.length} 个`);
check(
  "读到的项目来自设备（含对端路径）",
  registered.some((p) => !localSettings.includes(p) || p.startsWith("/Volumes/")),
  registered[0] ?? "—",
);

// 退化路径：设备不支持无参枚举时，按已登记项目逐个查询应能拿到会话。
check("按项目查询会话可用（退化路径）", tasks.length > 0, `${tasks.length} 条`);

// ── 2) 设备设置读：经设备通道读完整设置并挑白名单字段 ──────────────────────────
const settings = await deviceChannel.getSettings();
const entries = pickProjectableSettings(settings);
console.log(`\n── 设备设置投射（白名单）──`);
console.log(`   可投射字段: ${entries.length} 个`);
console.log(`   示例: ${entries.slice(0, 5).map((e) => e.key).join(", ")}\n`);
check("可读到设备设置白名单字段", entries.length > 0, `${entries.length} 个`);
check(
  "敏感字段未被投射",
  !entries.some((e) => /token|credential|secret|password/i.test(e.key)),
);

// ── 3) 设备设置写：记录原值 → 写 → 读回 → 回滚（只碰一个显示类布尔）────────────
const WRITE_KEY = "messageStreamShowTodos";
const before = (await deviceChannel.getSettings())[WRITE_KEY];
if (typeof before !== "boolean") {
  console.log(`⚠️  跳过写验证：设备上 ${WRITE_KEY} 不是布尔（${String(before)}）`);
} else {
  console.log(`── 设备设置写（${WRITE_KEY}: ${before} → ${!before}）──`);
  await deviceChannel.updateSetting(WRITE_KEY, !before);
  const after = (await deviceChannel.getSettings())[WRITE_KEY];
  check("写后读回新值", after === !before, `读到 ${String(after)}`);

  await deviceChannel.updateSetting(WRITE_KEY, before);
  const rolled = (await deviceChannel.getSettings())[WRITE_KEY];
  check("回滚到原值", rolled === before, `读到 ${String(rolled)}`);
}

await conn.disposeAndWait?.({ timeoutMs: 5_000 }).catch(() => undefined);

console.log(`\n=== 验收结论（设备级投射 · 设备通道）===`);
if (failures.length === 0) {
  console.log("全部通过 ✅");
  process.exit(0);
}
console.log(`失败 ${failures.length} 项：${failures.join("；")}`);
process.exit(1);
