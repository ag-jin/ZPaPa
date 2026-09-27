/**
 * 远程项目的回环预览：把「本机回环 URL」判定为需要走 SSH 隧道的那一类。
 *
 * 背景（工单 08）：A 的当前 workspace 是**远端设备（B）上的项目**时，
 * 项目里跑起来的预览服务监听在 B 的回环上。用户在 A 的内嵌浏览器里输入
 * `http://127.0.0.1:8901/...` 会打到 A 本机 —— 服务其实在 B。
 * 以往的绕法是手工把 127.0.0.1 换成 B 的 IP，但预览服务常常只 bind 回环，
 * 换 IP 也不通，且用户不该关心这种细节。
 *
 * 本模块只做**判定**：给定 URL 与「当前是否远程 workspace」，
 * 算出该 URL 是否需要隧道、以及隧道要转发到哪个远端端口。
 * 真正的转发由 host 侧的 `openTcpTunnel` 负责（A 本地临时端口 → B 回环）。
 */

/** 判定结果：需要隧道时给出远端回环端口，并保留 URL 其余部分用于重建。 */
export type RemoteLoopbackTarget =
  | { kind: "local" }
  | { kind: "remote-loopback"; remotePort: number; originalUrl: string };

const LOOPBACK_V4_PATTERNS = [
  /^127\./,
  // 0.0.0.0 在浏览器里等价于回环（服务 bind 全部接口时本机访问即 0.0.0.0）。
  /^0\.0\.0\.0$/,
];

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[(.*)]$/, "$1");
  if (
    normalized === "localhost" ||
    normalized === "localhost.localdomain" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1"
  ) {
    return true;
  }
  return LOOPBACK_V4_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * 算出该 URL 是否需要走远端隧道。
 *
 * 只有「当前 workspace 是远程」且「URL 指向回环」时才需要 —— 本地项目里访问
 * 回环必须保持原样（那服务就在本机，走隧道反而错）。
 */
export function resolveRemoteLoopbackTarget(
  rawUrl: string,
  options: { isRemoteWorkspace: boolean },
): RemoteLoopbackTarget {
  if (!options.isRemoteWorkspace) {
    return { kind: "local" };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { kind: "local" };
  }

  // 只处理 http(s)：其它协议（file/zcode-media 等）没有"远端服务"语义。
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { kind: "local" };
  }
  if (!isLoopbackHost(parsed.hostname)) {
    return { kind: "local" };
  }

  // 显式端口优先；未写端口时按协议默认（http 80 / https 443）。
  const remotePort = parsed.port
    ? Number.parseInt(parsed.port, 10)
    : parsed.protocol === "https:"
      ? 443
      : 80;
  if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort > 65535) {
    return { kind: "local" };
  }

  return { kind: "remote-loopback", remotePort, originalUrl: rawUrl };
}

/**
 * 把原始回环 URL 改写成 A 本地隧道的临时端口地址。
 *
 * 保留 path / query / hash —— 只换 host:port，用户看到的地址栏仍是最初输入的
 * 那个 URL（地址栏由 UI 单独维护，不跟随隧道地址），因此这里改写的是
 * **实际加载地址**而非展示地址。
 */
export function buildTunnelUrl(originalUrl: string, localTunnelPort: number): string {
  const parsed = new URL(originalUrl);
  parsed.hostname = "127.0.0.1";
  parsed.port = String(localTunnelPort);
  return parsed.toString();
}
