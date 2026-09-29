# Spec：mac 应用内自动更新

> 状态：**已实施**（本文在实现前定稿，实现后回填验证结果）
> 依据：`.agents/plans/finding-provisioning-barrier-regression.md` 的后续线；用户 2026-09-29 明确要求
> 关联 ADR：无（本改动不改变状态所有者，只补齐被短路的一条既有链路）

## Problem Statement

用户明确要求：**更新走 GitHub 仓库 → 有新包自动检测 → 应用内更新**。

Windows 已经是这个形态（`initAutoUpdater` 配置 GitHub provider、启动即检查、每小时轮询、
下载后菜单可「重启以更新」）。macOS 是**两处被显式短路**：

- `initAutoUpdater`：`process.platform === "darwin"` 时直接 return，不配置 updater、不轮询；
- `checkForUpdateMenuClick`：darwin 直接 `shell.openExternal(GITHUB_RELEASES_PAGE_URL)`，
  回 `{kind:"open-page"}`，让用户自己去浏览器下载安装。

于是 mac 用户每次升级都要手动下载 dmg 并覆盖安装。这个代价在 2026-09-29 真实发生过一次：
设备 B 因为没有跟着更新，持续丢失修复后的能力（见 finding 文档）。

## 根因（实测，推翻了仓库既有注释）

仓库 `autoUpdater.ts` 的注释称「macOS 未签名 → Squirrel 静默安装会被签名校验拒绝」。
用本机 Electron 41 直接探原生 `autoUpdater`，实测结论更精确：

| 应用签名状态 | native `setFeedURL()` |
|---|---|
| 完全未签名（当前发布包） | ❌ 抛 `Could not get code signature for running application` |
| ad-hoc 签名（`codesign -s -`，无 Team ID） | ✅ 成功 |

机制：Squirrel.Mac 的 `SQRLCodeSignature currentApplicationSignature` 内部调用
`SecCodeCopyDesignatedRequirement`；未签名应用取不到 designated requirement，
返回 nil，release 分支直接抛 `NSInternalInconsistencyException`。

### 一个必须记录的测量陷阱（否则会得出错误结论）

排错中发现：给 native updater 挂上 `error` 监听器后，上述**同步抛错会变成异步
`error` 事件**，`setFeedURL` 表面"成功"：

```
仅加 native.on("error", noop) 后调 setFeedURL  → OK   ← 假象，不是真的可用
构造 MacUpdater（其构造器会挂该监听器）→ 后续 setFeedURL OK  ← 同一假象的另一个入口
```

**结论不变**：未签名包是"下载可能成功、安装必失败"。这正是仓库里既有
`SQRLUpdaterErrorDomain code=2`（「update-downloaded 后才发现包无法 stage」）
处理分支的成因。因此判据不能用「`setFeedURL` 是否抛错」，
必须看**签名事实**（见 Solution 第三条）。

### 第二个实测发现

ad-hoc **自动生成**的 DR 是 `cdhash H"..."`（钉死代码哈希），跨版本必然校验失败。
必须用**显式 identifier 型 DR**；实测两版同 identifier 的 ad-hoc 包互相校验通过。

## 过渡约束（重要）

当前已发布的 3.16.1 是**未签名**包，它连 Squirrel 都初始化不了 →
**存量 mac 用户无法就地自动升级**，必须手动安装一次带 ad-hoc 签名的新版作为过渡。
这是本改动的一次性代价，不是可以绕过的：未签名应用在原生层就没有更新能力。

## 决定性约束（三条，实测）

1. **必须 zip**：electron-updater 的 `MacUpdater.doDownloadUpdate` 走
   `findFile(files, "zip", ["pkg", "dmg"])`，找不到 zip 直接抛
   `ERR_UPDATER_ZIP_FILE_NOT_FOUND`。**dmg 不能用于 mac 自动更新**。
   实测 CI 已构建 zip + blockmap，但 workflow 的 `artifact-glob` 只有 `*.dmg`，被丢弃。

2. **需要 `latest-mac.yml`**：Windows 上传 `latest.yml`（已确认在 Release 资产里），
   mac 的清单从未上传。electron-updater 通过 `getChannelFilePrefix()` 在 darwin 上
   读 `latest-mac.yml`（`getChannelFilePrefix` 返回 `-mac`）。

3. **两个架构同名清单**：`getUpdateInfoFileName` 的 `getArchPrefixForUpdateFile`
   **只给 Linux 加架构后缀**，mac 的 x64 与 arm64 都产出 `latest-mac.yml`。
   而 CI 的 mac-arm64（`macos-15`）与 mac-x64（`macos-15-intel`）是**分跑的两个 job**，
   各自产出同名文件 → 后上传者覆盖先上传者。
   **必须合并成一份含两个 `files[]` 条目的 manifest**；updater 侧
   `MacUpdater` 会按 URL 里是否含 `arm64` 自行筛选（实测其 `isArm64` 逻辑读 `file.url.pathname`）。

## Solution

三处改动，缺一不可：

### 一、签名：ad-hoc + 显式 identifier DR（`electron-builder.config.js`）

- `mac.identity` 在未启用正式签名时用 `"-"`（ad-hoc），而不是 `null`（完全跳过签名）。
- 新增 DR 文件（内容为 identifier 型要求，**不能**用 ad-hoc 默认的 cdhash，
  那会导致跨版本校验失败），由 `mac.sign` 钩子精确加到**顶层 app bundle** 上。
- 保留既有 `ZCODE_ENABLE_MAC_SIGN=1` 走 Developer ID 的路径不变：有证书时仍用真签名，
  将来拿到证书只需注入环境变量，代码无需再改。

> 为什么不是 Developer ID：本机当前 `security find-identity` 为 0 个可用证书，
> 且需要 Apple 开发者账号。ad-hoc 零成本且实测可初始化 Squirrel。
> 为什么 CUA 不受影响：本构建 `@zcode/zcode-cua` 是占位 stub
> （README：every runtime surface reports unavailable and fails closed），
> 其 TeamIdentifier pinning 不参与实际运行，ad-hoc 不改变任何权限边界。

#### 实现后追加发现的阻塞级缺陷（2026-09-30，已修复并实测）

**症状**：把 DR 直接配成 `mac.requirements` 时，CI 的 mac 签名步骤会**直接中断**。

**根因**：`app-builder-lib` 的 `getOptionsForFile()`（`macPackager.js:379-391`）
把 `mac.requirements` **无条件套给每个待签文件**，没有路径判断。而嵌套代码各有自己的
identifier：

| 嵌套项 | 自身 identifier |
|---|---|
| Squirrel.framework | `com.github.Squirrel` |
| Electron Framework.framework | `com.github.Electron.framework` |
| Mantle.framework | `org.mantle.Mantle` |
| Helper.app | `dev.zcode.app.helper` |

给它们套上 `designated => identifier "dev.zcode.app"` 后，嵌套代码**无法满足自己的 DR**，
osx-sign 结尾内置的 `codesign --verify --deep --strict` 立即报
`nested code is modified or invalid`；即使跳过该 verify，Squirrel 的
`kSecCSCheckNestedCode` 也会拒绝这样的包。

**修复**：改走 electron-builder 的 `mac.sign` 钩子（`signMacAppWithTopLevelRequirement`），
复用 `app-builder-lib/out/codeSign/macCodeSign.js` 的 `sign`（含其内置 3 次重试），
只把 requirements 精确加到顶层 bundle；并显式 `delete` 嵌套项上继承来的 requirements，
防止将来有人在 mac 配置里重新加上 `requirements` 时又签坏嵌套代码。

**实测验证**（真实配置模块 + 真实 osx-sign + Swift 探针复刻 Squirrel 校验）：

| 形态 | 顶层 DR | osx-sign 内置 `--verify --deep --strict` | Squirrel 同款跨版本校验 |
|---|---|---|---|
| `requirements` 全局（原方案） | identifier ✓ | **失败** | — |
| `requirements` 仅顶层（修复后） | identifier ✓ | 通过 | **通过** `status=0` |
| 无 requirements（ad-hoc 默认） | cdhash | 通过 | **失败** `-67050` |

验证方法本身也要注意：`probe` 探针必须让「新版」与「旧版」的代码**真正不同**
（否则 cdhash 相同的两份拷贝会让 cdhash 型 DR 也「通过」，得出错误结论）。

### 二、去掉 mac 短路（`autoUpdater.ts`）

- `initAutoUpdater`：删除 darwin 提前 return，让 mac 走与 Windows 相同的
  provider 配置 + 启动检查 + 每小时轮询。
- `checkForUpdateMenuClick`：删除 darwin 的 open-page 分支，让菜单进入同一状态机。
- **保留** `open-page` 这个 payload 类型与 UI 文案：它是「应用内安装不可用」的
  正规出口，改由**运行期探测**触发（见下一条），而不是按平台写死。

### 三、签名不可用时的降级（关键安全边界）

ad-hoc 让当前发布形态可更新，但「签名不可用」这件事必须在**运行期**处理，
不能靠平台判断一次性写死。分两层：

- **进程启动时**：`initAutoUpdater` 在 darwin 上先探测原生 updater 能否初始化
  （`setFeedURL` 是否抛错）。不能则记 warn 并保持「手动打开发布页」行为 —— 
  即今天的行为成为**降级路径**，而不是唯一路径。
- **事件回调里**：Squirrel 的 staging 失败（`SQRLUpdaterErrorDomain`）已有处理
  （`handleAutoUpdateFailure` 清 ready、退回可重试状态，并已有 dev 态豁免）。
  保留并复用它，不新增分支。

> 判据：能初始化 → 完整应用内更新；不能 → 与今天完全一致的 open-page 行为。
> 任何情况下都不能让用户停在「点了更新但没反应」。

## 不改的东西（明确的边界）

- **DR 的 identifier 取值**：沿用应用既有 bundle identifier（`appId`），不新造。
- **Windows 路径**：一行不动。
- **`open-page` payload / i18n 文案**：保留（降级路径仍用）。
- **协议版本 / 远端链路**：与本改动无关。
- **强制更新（force-update）**：沿用既有状态机，不做 mac 特判。

## 验收场景

| # | 场景 | 期望 |
|---|---|---|
| A1 | mac 新版本发布后启动应用 | 自动检查发现新版（不再需要手动下载） |
| A2 | 「检查更新」菜单 | 进入状态机（而非直接打开浏览器） |
| A3 | 有新包 | 按设置项自动或手动下载 zip，进度可见 |
| A4 | 下载完成 | 菜单显示「重启以更新」，点击后安装并重启到新版 |
| A5 | 签名不可用（如未来换构建形态） | 回退 open-page，用户仍能手动下载，**不出现点了没反应** |
| A6 | 版本不低于远端 | 报「已是最新」，状态复位 |
| A7 | `latest-mac.yml` 缺失或格式坏 | 报错并复位，不挂死 |
| A8 | 两个架构 | x64 与 arm64 各自拿到正确包（清单含两个 files[] 条目） |

## 验证方式

- **纯函数层**（可自动跑）：`packages/desktop/test/autoUpdatePolicy.test.ts` 锁定
  DR 解析（未签名/identifier 型/cdhash 型）、`.app` 路径上溯、以及
  「macOS 打包态是否有应用内更新」的判定；已做**红/绿双向验证**
  （注入「darwin 一律 true」的回归后，恰好失败 DR 那条用例）。
- **构建层**（已实测）：本地用 `--prepackaged` 复用既有 app 跑 mac zip 打包，
  确认 dist 里**确实生成 `latest-mac.yml`**，格式与合并脚本解析的形态一致。
- **签名层**（已实测）：用真实配置模块（`electron-builder.config.js`）的 `mac.sign`
  钩子对真实 app 副本签名，确认顶层 DR 是 `designated => identifier "dev.zcode.app"`
  （非 cdhash），嵌套保留各自默认，且 `codesign --verify --deep --strict` 通过。
- **Squirrel 校验层**（已实测）：用 Swift 探针复刻 `SQRLCodeSignature.m` 的校验
  （`SecCodeCopyDesignatedRequirement` + `SecStaticCodeCheckValidityWithErrors`
  带 `kSecCSCheckNestedCode | kSecCSStrictValidate | kSecCSCheckAllArchitectures`），
  跨「代码确实不同」的两版验证通过（`status=0`）。

### 实测中修正的两个坑（都会导致功能静默失效）

1. **DR 文件必须是完整要求表达式**：只写 `identifier "..."` 会被 codesign 拒绝
   （`invalid or corrupted code requirement(s) / unexpected token: identifier`），
   必须写成 `designated => identifier "..."`。
2. **验证方法本身的陷阱**：用 `codesign --deep --requirements` 会报
   `nested code is modified or invalid` —— 但这是 `--deep` 的行为，不是配置问题：
   electron-builder 是**自内向外逐文件**签名的（`@electron/osx-sign` 的
   `for (const filePath of [...children, opts.app])` 循环，不传 `--deep`），
   并把 requirements 应用到每个文件。因此不能用 `--deep` 复现真实签名流程。

### 仍需发版后才能确认的一条

**真实的 post-sign 安装链路**（下载 zip → Squirrel staging → ShipIt 替换 → 重启到新版）
无法在发版前完全验证。本地能验证到：DR 形态正确、嵌套签名正确、清单生成正确、
判定逻辑正确、Squirrel 同款校验 API 通过。最终确认需要发一个版本并在已装旧版的 mac 上实测。

另有一条**发版时必须盯住**的点：CI 的 mac 签名步骤是本次改动**首次真正执行**
（此前 `identity: null` 时签名整体跳过，`--prepackaged` 本地验证又跳过 `doPack`）。
发版时确认 CI 日志里出现 `signing` 且没有 `nested code is modified or invalid`。
