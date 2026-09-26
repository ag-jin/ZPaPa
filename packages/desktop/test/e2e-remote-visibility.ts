#!/usr/bin/env node
/**
 * 端到端验证（真实跨机，不经 UI）：
 *   用 host Controller 的完整链路 + 真实 B 的 taskService，
 *   断言「远程 scope 带 identity」时能拿到 B 的会话。
 *
 * 与 remoteSessionVisibility.test.ts 的区别：那个用 fake service 锁契约，
 * 这个接真实 SSH 到 B，验证线上数据面。
 *
 * 跑法：node --import tsx test/e2e-remote-visibility.ts
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const repoRoot = "/Users/linguojin/Workspace/ZCode/ZPaPa";
const projectPath = "/Volumes/数据盘/网站/新赛马";
const remoteIdentity = `remote:ssh:100.66.1.2:22:linguojin:${projectPath}`;

const { connectResidentRemote } = await tsImport(
  pathToFileURL(join(repoRoot, "packages/server/src/remote/connect-resident.ts")).href,
  import.meta.url,
);
const { createRemoteBackend } = await tsImport(
  pathToFileURL(join(repoRoot, "packages/server/src/remote/create-backend.ts")).href,
  import.meta.url,
);
const { createWindowHostControllerRuntime } = await tsImport(
  pathToFileURL(join(repoRoot, "packages/desktop/src/host/windowHostControllerService.ts")).href,
  import.meta.url,
);

const backend = await createRemoteBackend({
  kind: "ssh",
  host: "100.66.1.2",
  port: 22,
  username: "linguojin",
  privateKeyPath: join(homedir(), ".ssh/id_ed25519_imac"),
});
const connection = await connectResidentRemote(backend, { onDidRemoteClose: () => {} });
if (!connection) {
  console.error("❌ attach 失败");
  process.exit(1);
}
console.log("✅ 已挂载 B 的常驻主机");

// 复刻 host 侧 resolveSource：远程 scope（带 identity）→ 远端 taskService
const runtime = createWindowHostControllerRuntime({
  createId: (() => {
    let n = 0;
    return () => `e2e-${++n}`;
  })(),
  resolveSource: (scope) => {
    if (scope.workspaceIdentity !== remoteIdentity) return null;
    return {
      scope: {
        kind: "remote",
        remoteSessionId: "e2e-session",
        workspacePath: projectPath,
        workspaceIdentity: remoteIdentity,
      },
      taskService: connection.services.zcodeTaskService,
      sourceAvailability: "online",
    };
  },
});

// UI 改动后的确切查询形态：远程 tab 的 scope 带 identity
const result = await runtime.service.listTaskList({
  kind: "timeline",
  workspaceScopes: [{ workspacePath: projectPath, workspaceIdentity: remoteIdentity }],
  sortBy: "updated",
});

console.log(`\n=== A 侧列表查询结果（timeline，远程 scope 带 identity）===`);
console.log(`条数: ${result.total}`);
for (const item of result.items) {
  console.log(`  - ${String(item.title).slice(0, 44)} | status=${item.status}`);
  console.log(`      identity=${item.workspaceIdentity === remoteIdentity ? "✅ 归一化为本端身份" : `❌ ${item.workspaceIdentity}`}`);
}

if (result.total === 0) {
  console.error("\n❌ 列表为空 —— 远程会话不可见");
  process.exit(1);
}
console.log(`\n✅ 通过：A 能看到 B 的 ${result.total} 条会话`);

// 对照：若 scope 不带 identity（修复前的形态），应查不到（证明 identity 必需）
const withoutIdentity = await runtime.service.listTaskList({
  kind: "timeline",
  workspaceScopes: [{ workspacePath: projectPath }],
  sortBy: "updated",
});
console.log(`\n对照(scope 不带 identity): ${withoutIdentity.total} 条 ${withoutIdentity.total === 0 ? "（符合预期：identity 必需）" : "（意外命中本地同路径项目）"}`);

await connection.disposeAndWait({ timeoutMs: 5_000 });
