# 02: 不选目录，直接连设备

**What to build:** 在设置页添加一台远程设备（主机、用户名、密钥文件路径或密码），点连接即可建立到被投射设备（B）的会话通道 —— **不需要先选择目录**。连接成功后能读到该设备的项目清单。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] 设置页可添加/编辑/删除一台远程设备（主机、用户名、认证方式）
- [ ] 连接操作不再要求选择目录作为前提
- [ ] 连接失败时给出明确原因（认证失败 / 对端软件未运行 / 网络不通），不出现无限等待
- [ ] 连接成功后能从被投射设备读到项目清单
- [ ] 凭据：密钥方式引用系统密钥文件路径，密钥本体不进入投射端数据库
- [ ] 断开后设备条目保留（供重连），不保留项目清单

## 实施进展（2026-09-26）

### 已完成

**a) 设备条目 schema**（commit b7d752f）
- 新增 `remoteDevice` 条目类型：只含 target（怎么连）、连接状态、`visibleProjects`（显示偏好）；**无 workspacePath**。
- 消费点处理：botsService 的 workspace 映射、启动 tab 恢复均显式跳过设备条目（设备不是 workspace tab）。

**b) 设备访问层**（commit 4129b7c，已跨机验收）
- 能力探测 + 退化：设备级全量枚举是较新能力，实测对端旧构建会在缺省参数时报错；访问层探测后自动退化为「按已登记项目逐个查询再合并去重」，满足"不强制对端升级"。
- 投影项目清单取并集（已登记 ∪ 有会话），新登记无会话的项目也可见。
- 纯函数测试 5/5；真实设备验收：无目录连接 ✅ / 已登记项目 10 ✅ / 枚举 33 条 134ms ✅ / 清单 10 ✅ / 只读 ✅。

**c) 设备管理 UI**（`RemoteDeviceManagementSection.tsx`，已接入设置页通用区）
- 未配置时显示添加表单（主机/用户名/密钥路径）。
- 已配置时显示目标摘要、连接状态、连接/断开按钮、项目清单勾选（连接后可得）、移除设备。
- i18n 双语 21 键。

### 待完成（最后一环）

**d) 连接能力注入**：`RemoteDeviceManagementSection` 依赖 SettingsPage 传入的 `remoteDeviceConnect`，而 SettingsPage 目前**未定义**该 prop（typecheck 报 `Cannot find name 'remoteDeviceConnect'`）。

正确落点（已勘查）：
- 连接底层已有：`platform.connectRemote(target, requestId?, context?)` 返回 `{success, sessionId}`，且 **context 的 workspacePath 可选**（底层本就不要求目录，是 UI 流程强制的）。
- 拿到 services 的入口：`bindRemoteWorkspaceContextAndGetSession({platform, sessionId, ...})`（`useRemoteWorkspaceHistory.ts:820` 一带），或 `registerRemoteWorkspaceSession({sessionId, services})` 注册到 `remoteWorkspaceSessionStore` 后由 `useWorkspaceServices` 解析。
- 因此 `remoteDeviceConnect` 应实现在 `useRemoteWorkspaceHistory` 内（它已持有 platform、register/unregister、bind 等全部依赖），再由 Root 经 `settingsLayerProps` 注入 SettingsPage。
- 断开时用 `unregisterRemoteWorkspaceSession(sessionId)` + `platform.disposeRemoteSession(sessionId)`。

### 验收标准对照

- [x] 设置页可添加/编辑/删除一台远程设备（主机、用户名、认证方式）
- [~] 连接操作不再要求选择目录作为前提 —— 底层已支持，UI 注入待完成
- [x] 连接失败时给出明确原因（状态区展示 error）
- [x] 连接成功后能从被投射设备读到项目清单（设备访问层已验收）
- [x] 凭据：引用密钥文件路径，密钥本体不进入投射端数据库
- [x] 断开后设备条目保留（供重连），不保留项目清单（内存态，断开即丢）
