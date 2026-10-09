# 预览更新通道（Preview Update Channel）实现计划

> **验收方法 = 逆推 + 穷举**（本文件第四节与第五节即验收本体；第六节只是给逐格结论提供**证据形式**的手段，不是另一套东西）。
> **审查纪律**：只有逆推、没有穷举清单 ⇒ 视为**未完成验收**；任一格空缺 ⇒ 先补证据或补理由。
> 审查来源：`autoUpdater.ts` 源码、`electron-updater@` 的 `GitHubProvider.js` 源码、`.github/workflows/*.yml`、既有 schema/UI/i18n。

---

## 一、结论：一半已存在，别重造

你引的那句文案**已在代码里**且接线完整：

| 已存在                                            | 位置                                                        |
| ------------------------------------------------- | ----------------------------------------------------------- |
| 设置项 `receivePreviewUpdates`（**两处 schema**） | `packages/shared/src/validationAppSettings.ts:542` / `:642` |
| 开关 UI（**在「通用」区**，非实验区）             | `packages/ui/src/settingsPageHelpers.tsx:577-587`           |
| 两语文案（zh-CN 即「接受提前收到预览版更新」）    | `zh-CN.ts:2075` / `en-US.ts:2209`                           |
| 主进程消费 + 即时推送                             | `main/index.ts:967-973` → `autoUpdater.ts:1393`             |
| 映射到 electron-updater                           | `autoUpdater.ts:811`                                        |

**这一半不动。** 缺的是两块：

- **缺口 A（严重）**：`autoUpdater.allowPrerelease` **全仓只在一处赋值**（`autoUpdater.ts:811`，初始化时）；拨开关走的 `refreshAutoUpdaterReleaseChannel`（`:1393-1446`）改状态、清缓存、重跑 `checkForUpdates()`，**从不重设**它 ⇒ **界面变了、过滤没变，须重启生效** ⇒ **直接违背那句文案**。
- **缺口 B**：GitHub 上**没有可被 prerelease 通道解析的发布物**（`desktop-release.yml` 的 `gh release create` 不带 `--prerelease`；`desktop-dev-build.yml` 那条 `dev` **刻意不上传 `latest*.yml`**）。

---

## 二、已确认的决策（用户）

1. **触发与编号**：tag **`vX.Y.Z-preview.N`**，发 `--prerelease` 且**保留 `latest*.yml`**。
   `X.Y.Z-preview.N < X.Y.Z` ⇒ **开关关着**的客户端会看到更新的正式版并升回去（它读 `releases/latest`，该端点排除 prerelease）。
   ⚠️ **开关开着**时**不会**自动回到正式版：客户端只在「prerelease 标识恰为 `preview`」的 Release 里选
   （`allowPrerelease` 分支里 `shouldFetchVersion` 对**自定义通道**为假 ⇒ 第一个正式版被跳过），于是它一直报「已是最新」。
   **实测（2026-10-03，按 `GitHubProvider` 的选版规则对**真实 atom feed** 跑一遍）**：开关开 ⇒ 选中 `v3.16.4-preview.1`；
   开关关 ⇒ 读 `releases/latest` = `v3.16.4`。⇒ 要回到正式版的动作是**关开关**（3.16.4 起立即生效），**不是**等一次发布。
2. **覆盖全矩阵**（mac arm64 + mac x64 + win x64），与正式同形（10 个资产）。

---

## 三、两个**由源码定下来**的关键事实（本计划的地基，不是推测）

### 事实 1：预览版**只发常规 `latest*.yml` 就能被解析**（无需通道名清单）

`node_modules/electron-updater/out/providers/GitHubProvider.js:119-134` 是 **try/catch 带回退**：

```js
try {
  let channel = this.channel;
  if (allowPrerelease && semver.prerelease(tag)?.[0])
    channel = this.getCustomChannelName(String(prerelease[0])); // → "preview-mac"
  rawData = await fetchData(channel); // 先要 preview-mac.yml
} catch (e) {
  if (this.updater.allowPrerelease)
    rawData = await fetchData(this.getDefaultChannelName()); // 404 ⇒ 回退 latest-mac.yml
  else throw e;
}
```

⇒ 预览标签找不到 `preview-mac.yml` 会**回退**到 `latest-mac.yml`。
**前提**：prerelease 标识必须是 `preview` 本身（文件名与标识字符串绑定）。⇒ **不要用 `rc`/`beta` 等其它标识**，否则回退前置条件与后续过滤都不成立。
**结论**：T1 **不需要** `detectUpdateChannel`、**不需要**通道名清单——比原设想便宜。

### 事实 2：`dev` 滚动预发布**会毒死预览通道**，且修法是「两者一起切」

`GitHubProvider.js:51-56`：`allowPrerelease` 且 `currentChannel === null` 时

```js
const currentChannel = this.updater.channel || semver.prerelease(this.updater.currentVersion)?.[0] || null;
if (currentChannel === null) { tag = <atom feed 第一条，完全不筛>; }
```

- **开关打开 + 当前装的是稳定版** ⇒ `updater.channel` 与版本的 prerelease 段**都是 null** ⇒ 取 feed **第一条**。`dev` 每次 delete+recreate ⇒ atom 时间最新 ⇒ 极可能第一条 ⇒ 去 `dev` 上找 `latest-mac.yml` ⇒ 它刻意没有 ⇒ 回退仍在同一 tag ⇒ **抛 `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`** ⇒ **预览通道整体坏掉**。
- **修法**：设 `channel = "preview"` 后，选择循环（`:58-82`）按「tag 的 prerelease 标识 === 当前通道」筛选 ⇒ **`dev` 被跳过**（`semver.prerelease("dev")` 为 null）。
- **⚠️ 但不能无条件设**：稳定通道下 `channel` 若仍是 `"preview"`，`allowPrerelease=false` 分支会去**正式版**上要 `preview-mac.yml` ⇒ 404 且**此时不许回退** ⇒ **把稳定通道弄坏**。
- **⇒ 正确做法：`allowPrerelease` 与 `channel` 必须成对切换**：
  - 预览 ⇒ `allowPrerelease = true`、`channel = "preview"`
  - 稳定 ⇒ `allowPrerelease = false`、`channel = null`（`channel` getter 为 `updater.channel || options.channel`，置 null 即回默认）

---

## 四、逆推法（**验收本体 · 上篇**）

对每一个**权威陈述**反查「因此必须为真什么」，再落到「谁验」。

### 4.1 逆推「你引的那句文案」（把它当规格逐子句拆）

| 文案子句                                         | 反推出的必须为真                                     | 落点                             | 现状                        |
| ------------------------------------------------ | ---------------------------------------------------- | -------------------------------- | --------------------------- |
| 「接受提前收到预览版更新」                       | 有**可切换**的通道选择，**默认关**                   | 已有                             | ✅                          |
| 「**开启后**将最快、提前体验新功能」             | (a) 开启后**能拿到尚未正式发布的版本**               | T1（要有带清单的 prerelease）    | ❌ 无产物                   |
|                                                  | (b)「**最快**」= 不等正式节奏 ⇒ 必须含 prerelease    | T2 `allowPrerelease`             | ⚠️ 有标志但**拨开关不改它** |
|                                                  | (c) 不是「显示一下」而是**真能下到** ⇒ 资产可解析    | T1 + 事实 1                      | ❌                          |
|                                                  | (d) **不能因为仓库里有无清单的滚动预发布而整体失败** | T2 `channel="preview"`（事实 2） | ❌                          |
| 「**关闭后**将随着版本发布节奏获得版本推送更新」 | (a) 关闭后**只收正式版**                             | T2                               | ✅（初始化时正确）          |
|                                                  | (b) **不得收到预览版** ⇒ **负向验收，必须有**        | 5.1 关+只有预览                  | ✅/待验                     |
|                                                  | (c) 与正式发布**一一对应**，不跳版、不误判           | T3 版本序                        | ⚠️ 需写明语义               |
| （时态）「开启**后**将…」                        | 切换**立即生效**，非「下次启动」                     | **T2**                           | ❌ **当前缺陷**             |

### 4.2 逆推「代码里既有的承诺」（注释/结构已写下、可能没做到）

| 承诺（出处）                                                                                                                                 | 反推出的必须为真                                    | 现状                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| `refreshAutoUpdaterReleaseChannel` 注释：_「不能立刻改 availableUpdateChannel，否则旧请求返回时会把旧通道的版本标成新通道」_（`:1410-1412`） | 切通道**必须清缓存 + 串行**，**且延后之后真的应用** | ⚠️ 延后了，但重跑 check 时**没应用通道**                          |
| `shouldIgnoreStaleAvailableUpdate`（`:360`）存在 ⇒ 承诺「过期请求不生效」                                                                    | 需要 per-update 的通道标记                          | ❌ GitHub 路径**不产出** `zcodeReleaseChannel` ⇒ **守卫恒不生效** |
| `skippedElectronUpdateVersions` 按 `stable\|preview` 分键（`validationAppSettings.ts:38`）                                                   | 通道必须**标对**                                    | ⚠️ 同上 ⇒ 会**把 stable 标成 preview**                            |
| `desktop-release.yml:155-156` 注释：_「两架构清单必须合并，否则后上传的覆盖先上传的，另一个架构永远收不到更新」_                             | **预览路径也必须合并两架构**                        | 待实现                                                            |
| `manifest` 含 `files[].sha512` ⇒ 承诺下载校验                                                                                                | 预览资产**也须带校验和**                            | ✅ electron-builder 自动产（验收确认）                            |
| `autoUpdater.ts:800` 注释：更新源已从平台 manifest 切到 GitHub Releases                                                                      | 平台 manifest 通道**已废弃**                        | ⚠️ `manifestUpdateProvider.ts` 仍是**死代码**，误导               |
| `GITHUB_RELEASES_PAGE_URL` 用 `/releases/latest`（`:37-39`）                                                                                 | 未签名 mac 的「打开发布页」回退应**指向当前通道**   | ⚠️ 预览用户会被送到**正式版页**                                   |

---

## 五、穷举法（**验收本体 · 下篇**）

**维度**：开关(2) × 仓库内容(5) × 入口(4) × 平台(3) × 版本序(4) × 失败态(5)。
逐格结论只取：**有验收（编号）** / **由代码或类型保证（写明位置）** / **不适用 + 理由**。**任一格空缺 ⇒ 未完成。**

### 5.1 开关 × 仓库内容（**本功能成败的判据**）

| 开关 | 仓库内容            | 期望                                 | 证据编号                     |
| ---- | ------------------- | ------------------------------------ | ---------------------------- |
| 关   | 只有更旧正式版      | 「已是最新」                         | E-A1                         |
| 关   | 有更新正式版        | 发现并提示正式版                     | E-D1                         |
| 关   | **只有预览版**      | **「已是最新」**（不得误推）         | **E-B5（负向，必须有）**     |
| 关   | 预览版 + 更新正式版 | **只**发现正式版                     | E-B5                         |
| 开   | **只有预览版**      | **发现预览版**                       | **E-B6（正向，对应缺口 A）** |
| 开   | 预览版 + 更新正式版 | 取**号更大**者                       | E-B6                         |
| 开   | 只有更新正式版      | 发现正式版（开预览不该看不到正式版） | E-B6 变体                    |

### 5.2 入口 × 开关生效（**4 个入口都要过**，不能只验手动菜单）

| 入口                                          | 拨开关后须立即生效 | 备注 / 证据                                         |
| --------------------------------------------- | ------------------ | --------------------------------------------------- |
| 启动检查（`:1814`）                           | 用**当时**值       | ⚠️ 现为竞态（provider 未 await 完就检查）⇒ **E-S3** |
| 每小时轮询（`:1816`）                         | 用**最新**值       | 若只在初始化赋值 ⇒ 拨后**不生效** ⇒ E-S1            |
| 手动「检查更新」菜单（`:1895`）               | 用最新值           | 同 E-S1                                             |
| **拨开关即时通道**（`main/index.ts:967-973`） | **立即生效**       | ❌ 当前缺陷 ⇒ **E-S1**                              |

### 5.3 平台 × 资产（预览必须与正式同形）

| 平台      | 必需资产                                  | 清单                                                         |
| --------- | ----------------------------------------- | ------------------------------------------------------------ |
| mac arm64 | `*.dmg` + `*-mac-arm64.zip` + `.blockmap` | 合并进**同一份**（预览用 `latest-mac.yml`，靠事实 1 的回退） |
| mac x64   | `*.dmg` + `*-mac-x64.zip` + `.blockmap`   | 同上（**两架构合一**）                                       |
| win x64   | `*.exe` + `.exe.blockmap`                 | `latest.yml`                                                 |
| 合计      | **10 个**（与正式一致）                   | 预览也必须齐 ⇒ E-D2                                          |

### 5.4 版本序边界（最易「静默卡住」）

| 场景                                                   | 期望                                                                                        | 现状 / 证据                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 已装 `X.Y.Z-preview.N`、关开关、最新正式仍 `X.Y.(Z-1)` | **停在预览版**，但界面**说清原因**                                                          | ❌ 会静默「已是最新」⇒ **E-E12**                                                         |
| 已装 `X.Y.Z-preview.N`、正式 `X.Y.Z` 发布              | **开关关着**的客户端自动升到正式版；**开关开着**的**不会**（它只在自己的通道里选，见 §2.1） | ✅ **已实测**（2026-10-03 真实 feed 模拟选版：开 ⇒ `v3.16.4-preview.1`；关 ⇒ `v3.16.4`） |
| 已装 stable、开开关、仓库存 `X.Y.Z-preview.N`          | 发现预览版                                                                                  | E-B6                                                                                     |
| 预览号**高于**随后正式号（违反发布纪律）               | 会卡住 ⇒ 属**发布纪律**，文档写明                                                           | 8-风险                                                                                   |

### 5.5 失败态（每格都要**可见**归宿，不得静默）

| 失败态                | 期望                                         | 现状 / 证据                               |
| --------------------- | -------------------------------------------- | ----------------------------------------- |
| 无网 / 超时           | 收敛 error 态、可见、可重试                  | ✅ electron-updater error 事件（`:1786`） |
| **`dev` 污染致 404**  | **不得**失败 ⇒ 事实 2 的 `channel="preview"` | ❌→修 ⇒ **E-E13**                         |
| 未签名 mac（DR 失败） | 退化「打开发布页」且**指向当前通道**         | ⚠️ 现指向 `/releases/latest` ⇒ 4.2 末行   |
| 未打包（dev 跑）      | 跳过，不算缺陷                               | ✅ `canUseAutoUpdaterInCurrentRuntime`    |
| 检查在飞时拨开关      | **延后并在收口后真的应用**                   | ⚠️ 现为「只重跑 check」⇒ E-S1/E-S2        |

---

## 六、证据形式（第六节**只是手段**，验收本体在四、五节）

- **E-S\***：单元/变异证据。S1 拨开关后 `allowPrerelease` **与** `channel` 成对改变（**删掉重设 ⇒ 必红**，即当前真实缺陷）；S2 切通道清缓存（去掉清理 ⇒ 必红）；S3 冷启动「先应用配置、再检查」（去 await ⇒ 必红）；S4 通道显示有断言（去消费点 ⇒ 必红）；S5 stale 守卫**要么有测试、要么连同依赖删掉**（不留半截）。
- **E-A/B/C/D/E\***：你能亲手验收的端到端步骤，**每步给观察方式**：
  - **A 发布侧**：A3 打预览 tag ⇒ Release 有 **Pre-release** 徽标、**不是 Latest**；A1 其资产**含 `latest-mac.yml`（两架构合并）与 `latest.yml`**；A2 `https://github.com/ag-jin/ZPaPa/releases/latest` **指向正式版**；A4 **反向**：只有预览版更新时 `releases/latest` **仍指向旧正式版**。
  - **B 应用侧**（判据）：B5 关开关点检查 ⇒ **必须「已是最新」**（即使仓库有更新预览版）；B6 **开开关、不重启** ⇒ **必须**发现预览版；B7 **关开关、不重启** ⇒ 回「只认正式版」。（B6 与 B7 都要验，防单向生效的半拉子。）
  - **C**：界面能看出当前拿到的是预览还是正式版。
  - **D 回归**：D1 正式链路照旧（tag ⇒ 构建 ⇒ 收到 ⇒ **安装成功**）；D2 资产仍 10 个；D3 mac 两架构清单仍合并。
  - **E 边界**：E12 预览用户关开关后若正式号更低 ⇒ **停在预览版且界面说清原因**；E13 `dev` 不污染预览通道。
- **命令**：`pnpm exec tsx --test packages/desktop/test/<file>.test.ts` + `pnpm run typecheck`；**必须跑所在包全量**——`verify:pre-push` **不含测试**（小队那边刚踩到）。

### 6.1 证伪式验收（证明「验收」本身不是空断言）

| #   | 做法                                               | 期望                                                                       |
| --- | -------------------------------------------------- | -------------------------------------------------------------------------- |
| F1  | 删掉「拨开关时重设 `allowPrerelease`/`channel`」   | E-S1 必红；真机上**复现「拨了没反应」**                                    |
| F2  | 把 `allowPrerelease` 恒置 `true`（`channel` 不设） | E-B5 **必须失败** ⇒ 证明过滤确由该标志决定                                 |
| F3  | 发布时去掉 `--prerelease`                          | E-A3/A4 失败（预览被算作 Latest）                                          |
| F4  | 预览 Release **不**传 `latest*.yml`                | E-B6 失败（通道无内容；注意事实 1 的回退只救「文件名」不救「文件不存在」） |

**结论记录**：每条记「**观察到的现象**（原文/URL/截图）+ 与期望是否一致」；失败分四类：①发布侧 ②**应用侧** ③可见性 ④回归。**任一「应用侧」失败 ⇒ 本功能视为未完成。**

---

## 七、要做的四件事

- **T1｜预览发布通道（workflow）**：发布步在 tag 含 `-preview` 时加 **`--prerelease`**；stable 路径一字不动；**不得用 `--latest`**（这正是 stable 用户不被误推的机制）。**保留 `latest*.yml`**（事实 1 允许）。不改触发条件（`v*` 已匹配；「tag 必须等于 package.json 版本」照常适用 ⇒ 版本号写成 `3.17.0-preview.1`）。
- **T2｜让开关立刻生效（核心）**：把「应用通道到 updater」抽成**一个函数**，初始化与拨开关**两条路径都调它**、且在 `checkForUpdates()` **之前**；**成对设置 `allowPrerelease` + `channel`**（事实 2）；切通道时一并清 `readyUpdateVersion` / `skippedElectronUpdateVersions` / `availableUpdateChannel`；保留「检查在飞时延后」但**延后之后必须真的应用**；**冷启动顺序**：`applyGitHubUpdateProvider`（`:1565`，async）先 await 完再 `triggerCheckForUpdates("startup")`。
- **T3｜通道可见 + 版本序语义**：`updateStatusModel.ts:18` 已算 `updateChannel` 但**全仓无消费点** ⇒ 接到界面；**补 `zcodeReleaseChannel` 回传**（GitHub 路径不产出它 ⇒ stale 守卫恒不生效、且会把 stable 标成 preview）——**要么补上、要么连同依赖删掉，不留半截**；版本序语义写进注释与文档。
- **T4｜文档 + 死代码**：`README(.en).md` 发版小节（约 `:162`）补**预览发布流程**（含「标识必须是 `preview`」「预览号不得高于随后的正式号」两条纪律——记忆里「一律 patch、feat 也不 bump minor」是**纯人工约定、工具不强制**，文档是**唯一**护栏）；`manifestUpdateProvider.ts` 在本分支是**死代码** ⇒ 建议删；`GITHUB_RELEASES_PAGE_URL` 的回退改成**指向当前通道**。

---

## 八、明确不做

不做 beta/alpha 多通道（只 stable/preview）；不做降级（用 `-preview.N < X.Y.Z` 排序回避）；不动 Linux；不动平台 manifest 通道（要么删死代码，要么留待以后）。

## 九、风险与代价

- 预览与正式**共用 `latest*.yml` 文件名** ⇒ 正确性**完全依赖**「不同 Release 的区分 + prerelease 过滤 + 事实 1 的回退」，不靠文件名 ⇒ **E-A4（预览不得成 Latest）是硬要求**。
- **prerelease 标识必须恰为 `preview`**：换成 `rc`/`beta` 会同时破坏选择循环的过滤条件与回退前置条件。
- 发布纪律若违反（先发预览、再发更低的正式号）⇒ 预览用户卡住。
- 我记忆里「ZPaPa 无 GitHub Actions」是**错的**（实际有 `desktop-release.yml` 与 `desktop-dev-build.yml`），实施时一并纠正记录。
