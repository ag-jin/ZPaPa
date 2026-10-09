# 发现：ADR 0003 之后远程挂载 100% 失败 —— 窗口 host 丢失 provisioning target

日期：2026-09-29
状态：**已修**（本分支）
影响：用户报告「连上了但整个远程工作区建不起来」，报错 `Provider Provisioning 首次同步失败 (failed)`
关联：`docs/adr/0003-single-runtime-window-host-as-resident.md`、`finding-dual-host-runtime-split.md`

## 现象（用户报告）

A 连 B 的项目时报：

```
Provider Provisioning 首次同步失败 (failed)
```

挂载本身**看起来是成功的**（`resident host attached via ws tunnel`），但整个 remote
workspace 建不起来 —— 因为「Provider Provisioning 首次同步」是**发布屏障**（fail-closed）。
2026-09-29 22:06 一次会话内连续失败 6 次。

## 根因

ADR 0003（`c51f655`，2026-09-28）把常驻主机职责从独立进程移交给了**窗口 host**
（`host/residentExposure.ts`）。窗口 host 以 `serviceAuthorityMode: "desktop-local"`
运行（B 的 UI 需要 CUA 等物理桌面能力），而 `createLocalServices` 当时只在
**两个条件之一**成立时注册 provisioning target：

```
desktop-attached-remote || providerProvisioningTargetEnabled === true
```

窗口 host 两个都不满足 → 该 channel **根本不存在**。

数据流（修复前）：

```
A 侧 executor.syncLocalToRemote()
  └─ ws /ws/host (desktop-continuous) ──► B 侧窗口 host
                                            └─ ChannelServer: 无该 channel 路由
                                               → 请求挂起 → 1000ms 超时
                                               → Unknown channel: provider-provisioning-target
  ◄─ status:"failed"
  └─ environment-online 触发 → 屏障 fail-closed → 整个 remote workspace 建不起来
```

**为什么没被更早发现**：`connectResidentRemote` 不因此返回 null —— 挂载在传输层确实成功，
服务面大部分也可用（会话列表照样查得到）。失败只发生在挂载**之后**的首次同步屏障。
所以「挂得上」不等于「可用」，只探测挂载的验收会漏掉它。

## 证据

B 侧（100.66.1.2）日志在每次失败时都打出同一行：

```
[host] Unknown channel: provider-provisioning-target
```

两侧事件一一对应（跨机时钟恒定偏差约 0.56s），且每次失败都正好在请求发出后 1000ms ——
与 `channelServer.ts` 的超时语义吻合。B 侧当天 `Unknown channel` **只有这一个 channel**，
说明服务面其余部分完好。

时间线同样吻合：B 在 3.15.1 上最后一次成功同步是 09-28 19:50（当时是独立常驻主机进程，
模式 `desktop-attached-remote`，会注册该服务）；B 于 09-29 21:46 更新到 3.16.0
（启动日志变为 `standalone fork skipped: window host exposes itself`），22:05 首次连接即失败。
这是该错误在全部日志史上的首次出现。

两端的 `provisioning.json` 时间戳均早于故障时间 —— 请求根本没到达 target，**没有数据被改动**。

## 修法（三处，缺一不可）

1. **注册判定收进 Gate 本身**（`services/src/node.ts`）：新增
   `shouldRegisterProviderProvisioningTarget()`，把 `desktop-local` 也纳入。
   判定依据是「这个 Environment 会不会被投射端挂载」，而不是「它是不是 remote」：
   `desktop-local` 的窗口 host 兼作常驻主机（ADR 0003），本就属于挂载面。
   放在 Gate 而不是调用点，是为了让契约可被测试观测到（调用点参数无法覆盖）。

2. **信任边界**（`desktop/src/host/index.ts` + `server/src/http.ts`）：
   注册 ≠ 对外可写。该接口携带跨 Environment 凭据（OAuth 会话 + 账号 API key），
   必须按**连接级** `clientMode` 隔离：只有 `desktop-continuous`（桌面实时链路，
   含投射端挂载）可用真实 target；手机/Web 远控的 `web-remote-replayable`
   拿到的是抛错的桩。两处共用同一份判定与桩定义
   （`isProviderProvisioningTrustedClientMode` / `createUntrustedProviderProvisioningTarget`），
   避免两处各写一遍信任判定而漂移。

3. **A 侧补日志**（`desktop/src/main/desktopRemoteSessions.ts`）：
   原先 `environment-online` 失败分支只 reject 不记录，主日志里只剩
   「首次同步失败 (failed)」，无从判断是凭据被拒、Registry 不支持，还是挂载面缺 capability。
   现按与下方相同的脱敏口径补一条状态事实（不转抄远端自由文本，避免日志成为凭据泄露入口）。

## 验证

新增 `packages/desktop/test/providerProvisioningChannel.test.ts`（已登记层 1）：

| 用例                                                  | 覆盖                                               |
| ----------------------------------------------------- | -------------------------------------------------- |
| 窗口 host（desktop-local）提供该 channel              | 本次回归的直接锁                                   |
| 独立常驻主机（desktop-attached-remote）提供该 channel | 防修复反向破坏 legacy 形态                         |
| replayable 探测不到可用 target                        | 信任边界（弱断言）                                 |
| replayable 调真实 `apply` 被桩拒绝                    | 信任边界（强断言：拿到可用 target 才是缺陷）       |
| 端到端首次同步屏障放行                                | 用户可见症状本身（status applied/already-applied） |

**红/绿双向验证**：暂存修复后重跑，失败恰为上述 3 条（channel / 信任边界 / 端到端），
legacy 那条正确保持通过 —— 证明用例真的锁住了缺陷，而非恒真。

另扩展 `acceptance-resident-exposure.ts` 增 T5（跨机只读）：在真实设备上探测该 channel。
对仍跑旧构建的设备 B 实测：**T5 正确报缺失**（1 项失败），即该验收现在能捕获此缺陷。

只读约束：全部探测调**不存在的方法名**（有路由回 `Method not found`，无路由则超时），
绝不调 `apply` —— 后者是写接口，空 envelope 曾清空过对端个人 Provider 配置与 8 个凭据。

## 已知边界

- **设备侧必须升级到含本修复的构建才生效**：B 当前仍跑 3.16.0（不含修复），
  跨机验收对它的 T5 会持续报缺失，直到 B 升级。这是验收脚本的正确行为。
- 无干净的回退绕过：`ZCODE_RESIDENT_HOST_FORCE_STANDALONE=1` 能让挂载恢复
  （独立常驻主机为 `desktop-attached-remote`，会注册该服务），但会带回双 host
  运行时分叉 —— 即 ADR 0003 要解决的问题，等于用旧 bug 换新 bug。
