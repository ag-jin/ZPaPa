import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTunnelUrl,
  resolveRemoteLoopbackTarget,
} from "../src/lib/remoteLoopbackPreview.js";

/**
 * 远程项目回环预览的判定契约（工单 08）。
 *
 * 核心不变量：
 * - 只有「远程 workspace + 回环地址」才走隧道；本地项目访问回环必须保持原样。
 * - 非回环地址（真实主机名/IP）不走隧道 —— 那种情况本来就该直连。
 */

const remote = { isRemoteWorkspace: true };
const local = { isRemoteWorkspace: false };

test("远程项目里的 127.0.0.1 需要隧道，并取到端口", () => {
  const result = resolveRemoteLoopbackTarget(
    "http://127.0.0.1:8901/aming-replica-6scenes.v2.html",
    remote,
  );
  assert.equal(result.kind, "remote-loopback");
  assert.equal(result.remotePort, 8901, "端口取自 URL");
});

test("本地项目里的回环不走隧道（服务就在本机）", () => {
  const result = resolveRemoteLoopbackTarget("http://127.0.0.1:8901/x.html", local);
  assert.equal(result.kind, "local", "本地项目绝不能把回环转到远端");
});

test("localhost 与 IPv6 回环同样识别", () => {
  for (const url of [
    "http://localhost:3000/",
    "http://localhost.localdomain:3000/",
    "http://[::1]:3000/",
    "http://127.0.0.1:3000/",
    "http://127.9.9.9:3000/",
    "http://0.0.0.0:3000/",
  ]) {
    const result = resolveRemoteLoopbackTarget(url, remote);
    assert.equal(result.kind, "remote-loopback", `${url} 应识别为回环`);
    assert.equal(result.remotePort, 3000, `${url} 端口应为 3000`);
  }
});

test("非回环地址不走隧道（真实主机名/IP 本就该直连）", () => {
  for (const url of [
    "https://example.com/",
    "http://192.168.1.10:8000/",
    "http://100.66.1.2:8901/", // B 的 Tailscale IP：直连即可，不该再套隧道
    "http://myapp.internal:3000/",
  ]) {
    assert.equal(
      resolveRemoteLoopbackTarget(url, remote).kind,
      "local",
      `${url} 不是回环，不该走隧道`,
    );
  }
});

test("未写端口时按协议默认端口", () => {
  assert.equal(resolveRemoteLoopbackTarget("http://127.0.0.1/", remote).remotePort, 80);
  assert.equal(resolveRemoteLoopbackTarget("https://127.0.0.1/", remote).remotePort, 443);
});

test("非 http(s) 协议不处理", () => {
  assert.equal(resolveRemoteLoopbackTarget("file:///x.html", remote).kind, "local");
  assert.equal(resolveRemoteLoopbackTarget("zcode-media://x", remote).kind, "local");
});

test("非法 URL 安全退化", () => {
  assert.equal(resolveRemoteLoopbackTarget("not a url", remote).kind, "local");
  assert.equal(resolveRemoteLoopbackTarget("", remote).kind, "local");
});

test("改写隧道地址只换 host:port，保留路径/查询/哈希", () => {
  const url = "http://127.0.0.1:8901/preview/page.html?v=2#section";
  const rewritten = buildTunnelUrl(url, 54321);
  const parsed = new URL(rewritten);
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(parsed.port, "54321", "换成本地隧道临时端口");
  assert.equal(parsed.pathname, "/preview/page.html", "路径保留");
  assert.equal(parsed.search, "?v=2", "查询保留");
  assert.equal(parsed.hash, "#section", "哈希保留");
});

test("改写后仍是回环（隧道只监听 127.0.0.1，不对外暴露）", () => {
  const rewritten = buildTunnelUrl("http://127.0.0.1:8901/a.html", 12345);
  const result = resolveRemoteLoopbackTarget(rewritten, local);
  assert.equal(result.kind, "local", "隧道地址本身是本地回环，不应再被判定为需要隧道");
});
