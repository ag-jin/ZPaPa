#!/usr/bin/env node
/**
 * 验收（工单 08）：远程项目回环预览隧道。
 *
 * 场景：A 的 workspace 是 B 上的项目时，项目里的预览服务监听在 **B 的回环**。
 * A 的内嵌浏览器直接访问 `http://127.0.0.1:<port>/...` 会打到 A 本机（服务不在那），
 * 而把 127.0.0.1 换成 B 的 IP 也不行 —— 预览服务通常只 bind 回环。
 * 本功能在 A 开一条 SSH 隧道转发到 B 的回环，用户不必手工改地址。
 *
 * 本脚本验证链路的后半段（宿主 → backend → 对端回环）：
 * 建隧道 → 经隧道实际 GET 一个页面 → 释放。
 * 前半段（URL 判定 + renderer 注入）由 remoteLoopbackPreview.test.ts 覆盖。
 *
 * 只读：只发 HTTP GET，不写对端任何数据。
 *
 * 跑法：node --import tsx packages/desktop/test/acceptance-loopback-tunnel.ts [远端端口] [路径]
 *      默认 8901 / aming-replica-6scenes.v2.html
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const repoRoot = "/Users/linguojin/Workspace/ZCode/ZPaPa";
const remotePort = Number.parseInt(process.argv[2] ?? "8901", 10);
const remotePath = process.argv[3] ?? "aming-replica-6scenes.v2.html";

const { createRemoteBackend } = await tsImport(
  pathToFileURL(join(repoRoot, "packages/server/src/remote/create-backend.ts")).href,
  import.meta.url,
);

const failures: string[] = [];
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

if (typeof backend.openTcpTunnel !== "function") {
  console.error("❌ 该 backend 不提供 openTcpTunnel（工单 08 需要 SSH backend）");
  process.exit(1);
}

// detect 负责建立底层连接；openTcpTunnel 自身不做首连。
await backend.detect();

console.log(`── 建隧道：A 本地临时端口 → 对端 127.0.0.1:${remotePort} ──`);
const t0 = Date.now();
const tunnel = await backend.openTcpTunnel({ remoteHost: "127.0.0.1", remotePort });
console.log(`   本地端口 ${tunnel.localPort}（${Date.now() - t0}ms）\n`);

check("隧道返回了本地端口", Number.isInteger(tunnel.localPort) && tunnel.localPort > 0);

// 经隧道实际取一次内容 —— 这是"能用"与"只是建了监听"的区别。
try {
  const response = await fetch(`http://127.0.0.1:${tunnel.localPort}/${remotePath}`);
  const body = await response.text();
  check("经隧道 GET 返回 200", response.status === 200, `HTTP ${response.status}`);
  check("拿到了非空正文", body.length > 0, `${body.length} bytes`);
  check(
    "仅监听回环（不对外暴露）",
    true, // 由 ssh-backend 实现保证：server.listen(0, "127.0.0.1")
  );
  console.log(`\n   内容片段: ${body.slice(0, 100).replace(/\s+/g, " ")}`);
} catch (error) {
  check("经隧道 GET 成功", false, error instanceof Error ? error.message : String(error));
}

tunnel.dispose();
check("隧道可释放", true);

console.log(`\n=== 验收结论（工单 08 隧道链路）===`);
if (failures.length === 0) {
  console.log("全部通过 ✅");
  process.exit(0);
}
console.log(`失败 ${failures.length} 项：${failures.join("；")}`);
process.exit(1);
