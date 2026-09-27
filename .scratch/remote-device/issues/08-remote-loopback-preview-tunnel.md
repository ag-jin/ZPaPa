# 08: 远程项目的回环预览自动隧道

**What to build:** 在远程项目（B 上的项目）里打开内嵌浏览器访问回环地址
（如 `http://127.0.0.1:8901/aming-replica-6scenes.v2.html`）时，
自动为该端口建立到 B 的 SSH 隧道并加载内容 —— 用户不必手工改 IP。

**Blocked by:** 02（设备级连接）

**Status:** ready-for-agent

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

- [ ] 在 B 的项目里打开 `http://127.0.0.1:<port>/...` 自动经隧道加载
- [ ] 地址栏仍显示原 URL（用户视角地址不变）
- [ ] 同一端口复用隧道（不每次新建）；不同端口各自独立
- [ ] 本地项目里访问回环**不受影响**（仍打本机）
- [ ] 连接断开时隧道随之清理，不残留监听
- [ ] 隧道建立失败时给出明确提示（而非静默空白页）
- [ ] 只有远程 workspace 才启用；非 SSH 形态（WSL/Docker）按能力探测退化

## 设计要点

1. **判据**：当前内嵌浏览器 tab 所属 workspace 是否远程（已有 `remoteSessionId`），
   且目标 URL 的 host 是回环地址（`isLocalDevelopmentHost` 已覆盖
   127.0.0.0/8、::1、localhost、0.0.0.0 的判定可复用）。
2. **端口映射**：每个 `remotePort` 一条隧道，缓存在 host 侧（按
   remoteSessionId + port 做键，随 session 生命周期回收）。
3. **不改 URL 语义**：隧道对用户透明，地址栏保持原样。
4. **不做端口探测**：只转发用户实际访问的端口，不扫 B 的监听面。
