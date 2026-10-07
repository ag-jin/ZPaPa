# 发现：设备级投射分两件事——「表单」冗余，「免目录连接 + 读设备项目」不可省

日期：2026-09-26
关联：`.agents/plans/finding-device-projection-reads-local-settings.md`

## 结论

用户指出「设备区块 UI 冗余」，经核对**部分成立**：

| 组成                                        | 判定                 | 依据                                                                                                                |
| ------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 连接表单（host/用户名/密钥路径）            | **冗余**             | 产品 `SSHDialog.tsx` 已有，且多一个 `privateKeyPassphrase` 字段                                                     |
| 免目录连接（设备级，不 bind 工作目录）      | **不可省**           | 产品向导 4 步固定 `kind → settings → connecting → directory`，必选目录；而需求明确要「不选目录直接连上 B 的 zcode」 |
| 读设备项目清单（`recentProjects` + 会话数） | **不可省**           | spec User Story 7/14；产品连接后只挂载单个项目，不枚举整机                                                          |
| `tabStore.projection` 透传修复              | **真 bug，独立成立** | `createWorkspaceTab`/`mergeWorkspaceTabOptions` 都漏传，投射条目会退化成普通 tab                                    |

## 产品既有能力（不要重复造）

`packages/ui/src/SSHDialog.tsx`（侧边栏「远程连接」入口，`remote.trigger`）：

- 字段：`host` / `username` / `privateKeyPath` / `privateKeyPassphrase`
- 步骤：`RemoteWizardStep = "kind" | "settings" | "connecting" | "directory"`（`RemoteConnectionWizardChrome.tsx:7`）
- 语义：连上后进入**目录选择**，bind 一个 workspace，走 `remoteWorkspaceServiceCollection`
  装配对端 workspace host

即：产品已经解决了「连上 B 的某个项目」。本功能要补的是它**做不到**的两件事：

1. 不做目录 bind 的**设备级连接**（需求：整台设备，不是某个目录）
2. 连上后**枚举设备上的项目清单**（供勾选投射到 A 侧边栏）

## 关键约束：settingService 在 workspace 语义下是刻意的本机实现

`packages/desktop/src/host/remoteWorkspaceServiceCollection.ts:313`：

```ts
// 设置、凭据、OAuth、模型供应商和 settings-sync 继续读写本机配置。
.register(ISettingService, localSettingService)
```

因此**不能**靠现有 workspace 连接的 accessor 去读设备侧设置 —— 实测
`session.remoteServices.settingService.get()` 仍返回 A 的 `recentProjects`（host 侧
组装时就已替换，renderer 拿不到未替换版本）。本轮为验证此点临时加的
`session.remoteServices` 字段与相关透传**已回滚**（实测无效，属冗余代码）。

## 可行的修复方向（未实施）

设备投射读的是「设备登记了哪些项目」这一**业务事实**，不该复用 settings 通道。建议：

在 resident host 上增加只读设备端点（如 `/api/device-projects`），返回该设备的
`recentProjects` + 各项目会话数；A 的 host 经既有 SSH 隧道调用。

- 不动 workspace 语义（模型配置、终端 shell 枚举等仍读本机）
- 语义清晰：投射读的是设备业务事实，不是「对端设置」
- 后续「在 A 添加 B 的新项目」（spec 第 26 行）可在同端点扩展写能力

## 测试方式教训

本轮在 UI 验证上耗费大量时间：反复用 CGEvent 盲点 + 截屏，命中率低且无法确认状态。
更可靠的手段按优先级：

1. **CDP 直连**：dev 版 `--remote-debugging-port=9229`，用 `Runtime.evaluate`
   直接读写 DOM/调用 store（本轮后半段改用此法，效率显著提升）
2. **renderer 内 ESM import 读 store**：`import('/@fs/<abs>/store/xxx.ts')` 拿
   zustand 实况，比推断代码可靠
3. **product 日志**：`[remoteDevice]`/`connectResident` 等关键路径已有 info 日志
4. 截屏仅用于最终视觉确认，不用于逐次交互

脚本位置：`.scratch/cdp/cdp.mjs`（极简 CDP 客户端，`node cdp.mjs <wsUrl> <expr>`）
