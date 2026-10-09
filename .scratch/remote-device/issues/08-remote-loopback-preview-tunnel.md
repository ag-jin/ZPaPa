# 08: 远程项目的回环预览自动隧道

**What to build:** 在远程项目（B 上的项目）里打开内嵌浏览器访问回环地址
（如 `http://127.0.0.1:8901/aming-replica-6scenes.v2.html`）时，
自动为该端口建立到 B 的 SSH 隧道并加载内容 —— 用户不必手工改 IP。

**Blocked by:** 02（设备级连接）

**Status:** 实现完成（六层链路已打通，隧道经实测可取到对端回环页面）

## 背景

A 的当前 workspace 是 B 的项目时，会话里跑起来的预览服务（dev server、
静态站点）监听在 **B** 的回环上。用户在 A 的内嵌浏览器里粘贴
`http://127.0.0.1:8901/...` 会打到 **A 本机**，断连或 404；
现在的绕法是手工把 127.0.0.1 换成 B 的 IP（且 B 的服务往往只 bind 回环，
换 IP 也不通）。

## 已具备的基础设施

`ssh-backend.ts` 已有 `openTcpTunnel({ remoteHost, remotePort })`：

- 在 A 开本地临时端口（仅 `127.0.0.1`），每连接一次 `ssh2 forwardOut`
- 目前只被 `connect-resident.ts` 用于挂载 B 的常驻主机
- 浏览器面板已能拿到 `remoteSessionId`（`UnifiedBrowserView.tsx:65`），
  即"当前是不是远程项目"已有判据

## 验收

- [x] 在 B 的项目里打开 `http://127.0.0.1:<port>/...` 自动经隧道加载 —— 判定层（`resolveRemoteLoopbackTarget`）在归一化后拦截、经 `resolveLoopbackUrl` 换隧道地址；宿主链路经 acceptance-loopback-tunnel.ts 实测（A 本地端口 → B 回环，HTTP 200 / 12.5MB）
- [x] 地址栏仍显示原 URL —— `onUrlChange`/`setAddressValue` 传归一化后的原 URL，只有实际 `loadURL` 用隧道地址
- [x] 同端口复用 —— Controller 按 `workspaceKey\0remotePort` 缓存（`loopbackTunnels`），命中即返回既有 localPort
- [x] 本地项目不受影响 —— 用 `useWorkspaceServicesResolution().isRemoteTarget` 判定；非远程时 resolver 直接返回原 URL
- [x] 随 attachment 生命周期清理 —— 隧道存在 Controller 私有 Map，`dispose()` 统一释放（ssh-backend 侧 `server.close()` + 断开已建转发）
- [x] 失败给出明确提示 —— resolver 抛错后由 `openUrl` 的既有加载失败路径呈现；同时 warn 日志带 remotePort 与原因
- [x] 只有远程 workspace 才启用；非 SSH 形态按能力探测退化 —— `capabilities?.openTcpTunnel` 缺失时宿主 `openTunnel` 返回 null，Controller 抛「对端不支持回环隧道」

## 设计要点

1. **判据**：当前内嵌浏览器 tab 所属 workspace 是否远程（已有 `remoteSessionId`），
   且目标 URL 的 host 是回环地址（`isLocalDevelopmentHost` 已覆盖
   127.0.0.0/8、::1、localhost、0.0.0.0 的判定可复用）。
2. **端口映射**：每个 `remotePort` 一条隧道，缓存在 host 侧（按
   remoteSessionId + port 做键，随 session 生命周期回收）。
3. **不改 URL 语义**：隧道对用户透明，地址栏保持原样。
4. **不做端口探测**：只转发用户实际访问的端口，不扫 B 的监听面。
