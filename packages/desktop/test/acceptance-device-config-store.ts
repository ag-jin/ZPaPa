#!/usr/bin/env node
/**
 * 验收：设备配置独立存储（选项 A）。
 *
 * 核心断言：设备配置存独立文件，**与 settings.json 完全解耦** ——
 * 其它版本实例重写 settings（丢弃未知字段）时，设备配置不受影响。
 *
 * 这是「保存无效」的根因修复验证：官方版与 dev 版共用 setting.json，
 * 官方版不认识新增字段，每次写设置都会抹掉它。
 *
 * 跑法：node --import tsx packages/desktop/test/acceptance-device-config-store.ts
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const repoRoot = "/Users/linguojin/Workspace/ZCode/ZPaPa";
const { createRemoteDeviceConfigService } = await tsImport(
  pathToFileURL(join(repoRoot, "packages/services/src/remote/remoteDeviceConfigNode.ts")).href,
  import.meta.url,
);

const dir = await mkdtemp(join(tmpdir(), "zpapa-device-store-"));
const service = createRemoteDeviceConfigService({ configDir: dir });

const device = {
  target: {
    kind: "ssh" as const,
    host: "100.66.1.2",
    username: "linguojin",
    privateKeyPath: "/Users/linguojin/.ssh/id_ed25519_imac",
  },
  lastConnectionStatus: "connected" as const,
  visibleProjects: { "/p/a": true, "/p/b": false },
};

// V1 空文件时返回空
const empty = await service.list();
console.log(`V1 初始读取: ${empty.length} 台 ${empty.length === 0 ? "✅" : "❌"}`);

// V2 保存后能读回
await service.save([device]);
const saved = await service.list();
const roundTrip =
  saved.length === 1 &&
  saved[0]?.target.kind === "ssh" &&
  saved[0].target.host === "100.66.1.2" &&
  saved[0].visibleProjects?.["/p/b"] === false;
console.log(`V2 保存→读回: ${saved.length} 台 ${roundTrip ? "✅（含显示偏好）" : "❌"}`);

// V3 配置文件是独立文件，且不含会话数据
const fileText = await readFile(join(dir, "remote-devices.json"), "utf8");
const file = JSON.parse(fileText);
const noSessionData = !fileText.includes("sessions") && !fileText.includes("taskId");
console.log(`V3 独立文件 remote-devices.json: ${noSessionData ? "✅ 不含会话数据" : "❌"}`);
console.log(`   文件内容: ${JSON.stringify(file).slice(0, 140)}`);

// V4 关键：模拟"其它版本实例重写 settings" —— 设备配置不受影响
// （设备配置根本不在 settings 里，这里的断言是"两者互不引用"）
const fakeSettings = {
  schemaVersion: 1,
  recentProjects: ["/x"],
  lastWorkspaceSession: [{ kind: "local", workspacePath: "/x" }],
};
await writeFile(join(dir, "setting.json"), JSON.stringify(fakeSettings));
const afterOtherVersionWroteSettings = await service.list();
console.log(
  `V4 其它版本写 settings 后: ${afterOtherVersionWroteSettings.length} 台 ${
    afterOtherVersionWroteSettings.length === 1 ? "✅ 设备配置存活" : "❌ 被影响"
  }`,
);

// V5 单条损坏不拖垮整份列表
await writeFile(
  join(dir, "remote-devices.json"),
  JSON.stringify({ schemaVersion: 1, devices: [device, { target: null, broken: true }] }),
);
const resilient = await service.list();
console.log(
  `V5 坏数据容错: ${resilient.length} 台 ${resilient.length === 1 ? "✅ 保留可解析项" : "❌"}`,
);

// V6 清空
await service.save([]);
const cleared = await service.list();
console.log(`V6 清空设备: ${cleared.length} 台 ${cleared.length === 0 ? "✅" : "❌"}`);

await rm(dir, { recursive: true, force: true });
console.log("\n=== 验收结论（选项 A：设备配置独立存储）===");
console.log(`独立文件存储:     ✅（remote-devices.json）`);
console.log(`保存→读回:        ${roundTrip ? "✅" : "❌"}`);
console.log(
  `与 settings 解耦: ${afterOtherVersionWroteSettings.length === 1 ? "✅" : "❌"}（其它版本写 settings 不影响设备配置）`,
);
console.log(`坏数据容错:       ${resilient.length === 1 ? "✅" : "❌"}`);
process.exit(roundTrip && afterOtherVersionWroteSettings.length === 1 ? 0 : 1);
