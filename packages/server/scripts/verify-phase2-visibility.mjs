#!/usr/bin/env node
/**
 * 第 2 期端到端验证:A 侧以「项目真实路径、不带 identity」的 scope 查询 B 的会话列表。
 *
 * 复刻 UI 改动后的查询形态(useGroupedTaskView 的 buildWorkspaceScopes 对远程 tab
 * 产出 {workspacePath, workspaceIdentity: undefined}),验证:
 *   1. listGroupedTaskViewStructure 能返回该项目的会话(即 A 侧列表会显示的内容)
 *   2. listTaskList 能返回未归档会话列表
 * 只读,不写任何状态。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
const root = "/Users/linguojin/Workspace/ZCode/ZPaPa/packages/server";
const projectPath = process.argv[2] ?? "/Volumes/数据盘/网站/新赛马";
const { createRemoteBackend } = await tsImport(pathToFileURL(join(root, "src/remote/create-backend.ts")).href, import.meta.url);
const { connectResidentRemote } = await tsImport(pathToFileURL(join(root, "src/remote/connect-resident.ts")).href, import.meta.url);
const backend = await createRemoteBackend({ kind: "ssh", host: "100.66.1.2", port: 22, username: "linguojin", privateKeyPath: join(homedir(), ".ssh/id_ed25519_imac") });
const conn = await connectResidentRemote(backend, { onDidRemoteClose: () => {} });
if (!conn) { console.error("attach failed"); process.exit(1); }
const svc = conn.services.zcodeTaskService;
// UI 改动后的 scope 形态:纯路径,不带 identity
const scopes = [{ workspacePath: projectPath }];
console.log(`[p2] 查询形态: workspacePath=${projectPath} (无 identity)`);
try {
  const structure = await svc.listGroupedTaskViewStructure({ workspaceScopes: scopes });
  const nodes = structure?.view?.nodes ?? structure?.nodes ?? [];
  let taskCount = 0;
  for (const n of nodes) {
    if (n.type === "group") taskCount += (n.tasks?.length ?? 0);
    else if (n.task) taskCount += 1;
  }
  console.log(`[p2] ✅ listGroupedTaskViewStructure → ${nodes.length} 个节点, ${taskCount} 个任务`);
} catch (e) { console.log(`[p2] listGroupedTaskViewStructure 失败: ${e.message?.slice(0,160)}`); }
for (const [label, params] of [
  ["kind=all", { kind: "all", workspaceScopes: scopes, sortBy: "updated" }],
  ["kind=pinned", { kind: "pinned", workspaceScopes: scopes, sortBy: "updated" }],
]) {
  try {
    const r = await svc.listTaskList(params);
    const items = r?.items ?? [];
    console.log(`[p2] ✅ listTaskList(${label}) → ${items.length} 条${items.length ? ":" : ""}`);
    for (const it of items.slice(0, 5)) console.log(`      - ${String(it.title).slice(0, 40)} | archived=${it.archived} | status=${it.status}`);
  } catch (e) { console.log(`[p2] listTaskList(${label}) 失败: ${e.message?.slice(0,140)}`); }
}
await conn.disposeAndWait({ timeoutMs: 5000 });
console.log("[p2] done");
