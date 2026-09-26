# 原型验证报告：远程设备投射模型

验证时间：2026-09-26 15:05
验证方式：只读原型脚本（真实 SSH 挂载 B 的常驻主机），写操作显式开关 + 立即回滚

## 背景：用户方案转变

旧方案（已部分实现）把 B 的会话**并入** A 的本地列表，需要维护一套"影子索引"
（A 的 `tasks-index.sqlite` 里 `remote:` 前缀的元数据行）并处理两套键名的映射与隔离。

用户提出新方案：**纯投射** —— A 不存任何索引，左侧栏实时从 B 拉取并展示，
断开即消失。范围由设置里的「远程设备」选项控制。

**关键事实澄清**：A 原本确实不存会话**正文**（正文一直在 B），但**存了影子索引**
（实测 A 库有 12 条 `remote:ssh:100.66.1.6:...` 历史残留，来自 9 月连另一台机器）。
这 12 条已清理（备份 `/tmp/tasks-index.before-remote-cleanup.sqlite`），A 本地 211 条会话完好。

## 验证结果

### 原型 1：项目投射可行性（`prototype-projection.ts`）

| 验证项 | 结果 |
|---|---|
| 枚举 B 的全部项目 | ✅ 11 个项目 / 46 条会话 / **61ms** |
| 每项目会话列表 | ✅ 一次全量即可分组，无需逐项目请求 |
| 传输成本 | ✅ 全量 44.2 KB（平均 984 B/条） |
| 断开无残留 | ✅ 只读投射，A 不落库；断开后调用 `ChannelClient is disposed` |

B 实测项目清单（按会话数）：
`ZCode` 8 / `agent军团` 8 / `赛马插件` 8 / `新赛马` 4 / `workspace/default` 4 /
`中转站` 4 / `电商技能` 3 / `dsh-papa` 2 / `kiro-api` 2 / `ziniao` 2 / `网站22` 1

### 原型 2：设置驱动的范围控制（`prototype-projection-scoped.ts`）

模拟"用户在设置里只勾选 2 个项目"：

| 验证项 | 结果 |
|---|---|
| 项目枚举供设置勾选 | ✅ 11 个候选 |
| 按勾选过滤 | ✅ 选中 2 个（新赛马、中转站） |
| 投射数据形状 | ✅ 字段齐全（taskId/title/status/updatedAt/remoteProjectPath/origin） |
| 作用域可控 | ✅ 未选的 9 个项目**零泄漏** |
| 开销 | ✅ **1.8 KB / 8 条** |

`origin: "remote"` 字段供 UI 做图标/颜色区分（用户选择"混入现有列表 + 图标颜色区分"）。

### 原型 3：远程设置投射与修改（`prototype-remote-settings.ts`）

| 验证项 | 结果 |
|---|---|
| R1 从 A 读 B 的设置 | ✅ 39 字段 / **10ms** / 3.2 KB |
| R2 字段可投射性分类 | ✅ **22 个**布尔非敏感字段适合；17 个需排除 |
| R3 **远程修改** | ✅ 写入生效 → 读回确认 → **已回滚原值** |

**可投射字段示例**（22 个）：`memoryEnabled`、`messageStreamShowReasoning`、
`messageStreamShowTodos`、`toolGroupingExploreEnabled`、`toolGroupingTerminalEnabled`、
`taskAutoArchiveEnabled`、`keepAwakeWhileRunning`、`proactiveSuggestionsEnabled`、
`nativeSearchEnhancementsEnabled`、`askUserQuestionAutoResolutionEnabled` 等。

**需排除的字段**（17 个）：含路径/会话/窗口/凭据线索的（`recentProjects`、`locale`、
`embeddedBrowserViewportPreference`、`desktopZoomLevel`、`closeToTrayOnWindows`、
`taskAutoArchiveOlderThanDays` 等）—— 这些是设备本地属性，投射过去无意义或有隐私风险。

写验证后已核对 B 侧：`messageStreamShowReasoning` = True（原值）、字段总数 41（未变）。

## 结论：方案可行

三条通路全部验证通过，且开销极小：

1. **项目/会话投射**：44 KB 全量、1.8 KB 选择性，61ms
2. **范围由设置控制**：未选项零泄漏
3. **远程读取设置**：3.2 KB / 10ms
4. **远程修改设置**：写入-读回-回滚闭环通过

## 实施要点（待做）

1. **设置页**：新增「远程设备」区块
   - 连接管理（保留可重连入口，存连接记录而非会话索引）
   - 项目勾选（显示哪些远程项目）
   - 设置投射（22 个安全字段，可远程修改）
2. **左侧栏**：投射项渲染（`origin: "remote"` → 图标/颜色区分），数据实时从 B 拉
3. **连接生命周期**：断开清空投射；连接记录保留供重连
4. **安全边界**：写操作前需用户显式确认；只暴露白名单字段；敏感字段不投射

## 脚本

- `packages/desktop/test/prototype-projection.ts`（只读）
- `packages/desktop/test/prototype-projection-scoped.ts`（只读）
- `packages/desktop/test/prototype-remote-settings.ts`（默认只读，`--write` 才写且立即回滚）
