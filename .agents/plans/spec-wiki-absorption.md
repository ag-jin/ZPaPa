# Wiki 知识库功能：产物契约与吸收规则

> 状态：**已实施**（后端 + UI + 设置页 + 测试全部落地，验证通过）。本文件保留为契约与决策依据。
> 依据：`/Users/linguojin/Downloads/WIKI/` 两份真实产物 + ZPaPa 仓库真实代码。

## 零、实施结果与偏差（与下面规划的差异）

已交付，20 个新文件 / 30 个改动文件：

| 层 | 文件 |
|---|---|
| 契约与存储 | `wikiTypes.ts`（两版 schema 兼容）、`wikiStore.ts`（`<workspace>/.wiki/` 读写） |
| 扫描与规划 | `wikiScan.ts`（清单 / manifestHash / languageStats / readme）、`wikiPlan.ts`（两跳提示词 + JSON 解析 + 归一化） |
| 生成 | `wikiGenerator.ts`（逐页落盘 + 断点续跑 + 取消）、`wikiGeneratePage.ts`、`wikiPersist.ts` |
| 定时更新 | `wikiAutoUpdate.ts`（cron 调度，复用 automation 的 croner 解析） |
| 服务接线 | `wiki.ts`（接口 + 频道）、`wikiService.ts`（工厂）、`wikiRead.ts` |
| UI | `WikiPane.tsx`（侧边面板）、`WikiCatalogTree.tsx`（目录树）、`settings/WikiSettingsSection.tsx` |
| 测试 | 4 个测试文件，35 项全部通过 |

**与规划的三处偏差**（都是实施中发现更好做法）：

1. **存储位置为 `<workspace>/.wiki/`**（用户决定），不再是应用数据目录，也不是 `docs/wiki`。
   用点开头的目录：不算项目源码、默认被 `includeHidden:false` 过滤、不干扰目录浏览。
  因此 `getWorkspaceHash` 那套哈希规则只在**读取历史产物**时还需要，新产物不用。
2. **`thoughtLevel` 未保留**，只存 `modelSelection.options.reasoningLevel`
   （两者是同一东西的两个名字，见 §3.3.1）。
3. **自动更新的目标清单取「最近项目」**（`settings.recentProjects`），
   不额外引入一份需要用户维护的登记表。

**遗留**：远端 workspace（SSH/WSL/Docker）暂未接入，参照 §五 风险 6 的显式排除做法。

**扫描必须按路径精确排除产物目录**（实施中发现的坑）：产物目录从仓库根 `wiki/` 改成
`docs/wiki/`、再改成 `.wiki/` 的过程中暴露出一个问题 —— 最初用「目录名等于 wiki 就跳过」
的按名匹配，会连用户项目里本该被文档化的真实 `wiki/` 目录一起跳过。
现在改为按完整相对路径（`WIKI_DIR_RELATIVE_PATH`）精确比对：只有产物目录本身被跳过，
用户的 `wiki/`、`docs/wiki/` 都正常进清单。同时这道排除是**必需**的：
产物若进了扫描，每次生成都会改变 `manifestHash`，让「项目变没变」的判断永远为真。
两个方向都有回归测试锁定（`wikiPlan.test.ts` 的「.wiki 被跳过」与「不被误跳过」）。

## 一、结论先行

**这个功能在 ZPaPa 源码里已经被删除干净，不是被注释或降级。**

证据：
- 全仓库源码 grep `wiki`（排除 dist/node_modules）只命中两处误报：
  - `packages/rpc/src/serialization.ts:65` —— 维基百科链接（VQL 编码说明）
  - `apps/zcode-cli/packages/core/src/tool/handlers/generated/bash-command-registry.ts` —— 命令注册表
- 构建产物 `packages/zcode-server-cli/dist/server-core.js` 里 `知识库` 出现 71 次，
  但**全部是飞书 helpdesk API 文档注释**（`helpdesk-v1/faq/create` 之类），与本功能无关。
- 上游 `ZCode.app` 的 `app.asar`（314MB，binary-safe 搜索）中
  `draft-pages` / `generateDiagrams` / `manifestHash` / `wikiId` / `catalogTree` / `generatedPageIds`
  **命中数全部为 0**。
- git 历史 76 个 commit 中没有任何 wiki 相关文件被删除的记录。

**所以这不是「恢复」，而是「重建」。** 好消息是：产物契约可以从磁盘上的真实产物完整反推，
且仓库里已有现成的模板可直接照抄（`GitCommitMessageGenerator`）。

## 二、产物契约（从真实产物反推）

存储位置规则——**哈希已确证，父目录名未确证**：

```
<某个数据目录>/<workspaceHash>/
  wiki.json        # 权威产物
  draft.json       # 生成中途草稿（多 taskId + generatedPageIds）
  task.json        # 任务进度
  draft-pages/
    <sha256(pageId)[:16]>.json   # 单页增量落盘
```

**已确证**：目录名 `<workspaceHash>` = `sha256(workspaceKey).slice(0, 12)`，
与 `packages/services/src/paths.ts:196 getWorkspaceHash()` 实现完全一致（本地 `workspaceKey === workspacePath`）。

验证：`/Volumes/数据盘/网站/agent军团` → sha256 前 12 位 = `385551730d64` ✓
　　　`/Volumes/数据盘/网站/新赛马` → sha256 前 12 位 = `7b050da874c6` ✓

**未确证**：这两份产物最初存放的**父目录名**。用户是把它拷到 `~/Downloads/WIKI/` 下给的，
所以「WIKI」是用户自己起的名字，不能当作上游的目录名。

已知的候选父目录（`packages/services/src/paths.ts`，全部已导出）：
- `getAppConfigDir()`（`:53`）= `{dataBaseDir}/.zcode/v2` —— 最可能的落点，会话/tasks-index 都在这层
- `getLegacyTaskSessionSnapshotPath()`（`:209`）= `~/.zcode/v2/sessions/{workspaceHash}/{taskId}.json`
  —— 这是「按 workspaceHash 分目录」的既有命名范式，wiki 极可能沿用同一层

→ **实施决策**：不要猜。建议新功能用独立目录（如 `<getAppConfigDir()>/wiki/<workspaceHash>/`），
并在只读读取器里**同时按候选路径探测**（`wiki/<hash>/`、`sessions/<hash>/`），
这样用户直接丢进来的产物也能被发现。父目录名做成常量，便于一处调整。

`draft-pages/*.json` 文件名 = `sha256(pageId).slice(0, 16)`（如 `page-1-80e1e11c` → `0b6e4e79cff99ec6`），
此规则两份样本均验证通过。

### 顶层字段

| 字段 | 说明 |
|---|---|
| `wikiId` | UUID，wiki 身份 |
| `repoId` / `workspaceKey` / `workspacePath` | 本版三者同值（本地 workspace） |
| `language` | 生成语言，样本为 `zh-CN` |
| `manifestHash` | 项目清单指纹，用于判断项目是否变化（决定能否复用旧 wiki） |
| `context` | 项目上下文快照（见下） |
| `catalogTree` | 目录树（节点：`id` / `title` / `order` / `children` / `pageId`） |
| `pages` | 页面数组 |
| `createdAt` / `updatedAt` | 时间戳（毫秒） |

`context` 字段：`repoId`、`workspaceKey`、`name`、`rootPath`、`defaultBranch`、`commitHash`、
`commitTime`、`fileCount`、`languageStats`（语言 → 字节数）、`readme`（README 全文，供模型理解项目）。

`generationOptions.generateDiagrams` 的实际效果：开启后模型会在 markdown 里输出
` ```mermaid ` 代码块。样本 2 共 **103 个 mermaid 图**，合计正文 463,278 字符
（52 页，平均约 8,900 字符/页）。单页正文接近 9k 字符，加上 `maxOutputTokens: 65536`，
单页生成是一次不小的请求。

**好消息：mermaid 渲染能力仓库已有，不用新建**。UI 侧现成组件：
- `packages/ui/src/components/ai-elements/mermaid-block.tsx`
- `packages/ui/src/components/ai-elements/diagram-preview-dialog.tsx`
- `packages/ui/src/lib/mermaidLanguage.ts`

只要 wiki 的 markdown 渲染走既有组件，图表就能直接显示。

### 页面字段

`id`（`page-N-<hex>`）、`parentId`（指向 catalogTree 的 `node-N-<hex>`）、`title`、`order`、
`description`（该页摘要）、`filePaths[]`（该页依据的文件）、`markdown`（正文）、
`sources[]`（`{path, startLine}`，比 filePaths 更细的行号锚点）、`createdAt` / `updatedAt`。

### 两版 schema 差异（重要：向后兼容要同时吃下）

| | 旧版（`385551730d64`） | 新版（`7b050da874c6`） |
|---|---|---|
| 模型字段 | `generationModel: {providerId, providerName, modelName}` | 同时有 `generationModel` + `modelSelection: {providerId, modelId, options:{reasoningLevel}}` |
| 选项字段 | `generationOptions: {generateDiagrams, thoughtLevel, maxOutputTokens}` | 同上，`maxOutputTokens` 16384 → 65536 |
| `sources` | 有 | 有 |

`draft.json` 比 `wiki.json` 多两个字段：`taskId` 与 `generatedPageIds[]`（已完成页面 id 列表）。

### failedPages 语义（已确证）

`task.json` 的 `totalPages` / `completedPages` / `failedPages` 对应：
- `totalPages` = catalogTree 中带 `pageId` 的节点数
- `completedPages` = 真正生成出 `markdown` 的页面数
- `failedPages` = `totalPages - completedPages`

样本 `385551730d64`：tree 里 14 个节点有 pageId，实际生成 10 页 → `wiki.json.pages` 只有 10 条，
而 `draft.json.pages` 有 14 条（4 条是**无 markdown 的占位页**，字段只有
`id/parentId/title/order/description/filePaths`，`markdown` 为 `null`）。
`generatedPageIds` 恰好是那 10 条。

**这条语义决定了实现必须是「渐进落盘 + 断点续跑」**：目录树先建好，页面逐页生成并及时落盘，
失败不阻塞其余页面，重跑时按 `generatedPageIds` 跳过已完成的页。

## 三、实现规则（照抄仓库现成模式）

### 3.1 模型调用：直接用现成的通用原语，**不要再造**

仓库已有「给定 workspace + selection + prompt → 返回文本」的通用能力：

- 协议定义：`packages/shared/src/zcode-protocol/index.ts:2075`
  - `zcodeWorkspaceGenerateTextParamsSchema`：`workspace` / `selection` / `prompt`（或 `messages`）/
    `querySource` / `maxOutputTokens` / `operationId`
  - `zcodeWorkspaceGenerateTextResultSchema`：`text` / `selection` / `usage` / `finishReason`
  - `zcodeWorkspaceCancelGenerateTextParamsSchema`（用 `operationId` 取消）
  - 协议方法名：`:3613 workspaceGenerateText` = `"workspace/generateText"`、
    `:3614 workspaceCancelGenerateText` = `"workspace/cancelGenerateText"`
- 服务端接口：`packages/services/src/zcode-agent/zcodeAgent.ts:687`，
  参数类型 `ZCodeAgentGenerateWorkspaceTextParams`（`:306-312`：`selection` / `prompt?` / `messages?` /
  `tools?` / `querySource` / `maxOutputTokens?` / `signal?` / `requestTimeoutMs?` /
  `workspacePath` / `workspaceIdentity?`）—— **`signal` 直接支持取消，不用自己拼 operationId**
- 服务端实现：`packages/services/src/zcode-agent/zcodeAgentService.ts:4355-4404`
  （内部 `randomUUID()` 生成 `operationId` `:4366`，abort 时发 `cancelGenerateText` `:4383`）
- CLI 侧执行：`apps/zcode-cli/packages/core/src/runtime/methods/workspace-generate-text.ts:139`
  （`:183` 有 `AbortSignal.timeout(60_000)` 兜底超时）
- 现成调用范例（**这就是要照抄的模板**）：
  `packages/services/src/git/gitCommitMessageGenerator.ts`
  - `:120-145 resolveCurrentModel()` —— 从 `modelSelection.getView().preferredSelection` 读当前模型
  - `:147-172 complete()` —— 调 `textGenerator.generateText({...})`
  - `:239-255` / `:337-356` —— 校验输出、失败抛带 `reason` 的错误
- 真实接线：`packages/services/src/node.ts:2289-2307`

注意 `querySource` 是个自由字符串标记，用于模型调用归因（已有值如
`gitCommitMessageGenerator.ts:18` 的 `"git_commit_message"`）。wiki 应新增自己的值（如 `"wiki_generation"`）。

**输出预算的职责分离**（本仓硬约束，`provider-registry-model-runtime.ts:71-72` 注释明确）：
`providerId`/`modelId`/`reasoningLevel` 由 `ModelSelection` 承载，
而 `maxOutputTokens` 属于**单次请求**，必须由调用方显式传，不能在 ModelFactory 里静默绑定。
wiki 的 `generationOptions.maxOutputTokens` 正好对应这个入参。

### 3.2 服务分层与新服务注册点

服务用 `ServiceDescriptor` 模式（`packages/services/src/descriptors.ts:14`），
频道名集中定义在 `packages/shared/src/channels.ts:75 export const ServiceChannels`。

新增一个服务需要改的位置（照 `IGitService` 的链路，已逐处核实）：

| # | 位置 | 作用 |
|---|---|---|
| 1 | `packages/shared/src/channels.ts:150` 后 | 加频道名 `Wiki: "wiki"`（对象 `as const`，`:155` 派生 `ServiceChannelName`） |
| 2 | `packages/services/src/wiki/wiki.ts`（新建） | 定义 `IWikiService` 接口 + `createServiceDescriptor<...>(ServiceChannels.Wiki)` |
| 3 | `packages/services/src/wiki/wikiService.ts`（新建） | 服务端实现（读写文件、调度生成） |
| 4 | `packages/services/src/index.ts` | 显式导出（根入口必须 browser-safe，不能引 node:*） |
| 5 | `packages/services/src/accessor.ts` | `IServiceAccessor` 接口加 `readonly wikiService?: IWikiService` |
| 6 | `packages/services/src/node.ts:2400-2573` | `.register(IWikiService, createWikiService(...))`（现有 44 条注册的链上追加） |
| 7 | `packages/client/src/remoteServiceAccess.ts` | 类字段声明 + 构造函数 `ProxyChannel.toService` 赋值（**两处都要加**） |
| 8 | `packages/desktop/src/host/remoteWorkspaceServiceCollection.ts:315-406` | 桌面远端 workspace 侧注册 |

唯一暴露点：`ServiceCollection.exposeOnChannelServer()`（`packages/services/src/collection.ts:30`）会遍历
所有已注册服务逐个 `server.registerChannel`。它有 5 个调用点
（`packages/desktop/src/host/index.ts:2117`、`packages/server/src/http.ts:121` 与 `:438`、
`packages/server/src/stdio.ts:68`、`packages/zcode-server-cli/src/server-core/http.ts:105`），
都是全量注册，**新增服务不需要逐个改这些**。

注：#8 只在「wiki 生成要在远程设备上执行、或要显示远程设备的 wiki」时需要。
若首版只服务本地 workspace，第 1 期可只做 #1–#7。
远端注册需要额外决策：本仓既有先例是 `ISkillsService`/`IPluginsService` 走远端、
`ISettingService`/`ICredentialService` 走本机（同文件 `:320-357`）。

`packages/services/src/index.ts` 里有一句明确的约束注释：
「Conversation share 的具体实现依赖 Node 文件系统，只能从 `@zcode/services/node` 引入；
根入口必须保持 browser-safe，避免 renderer 解析到 node:* 模块。」
→ 因此**接口与 descriptor 放根入口导出，Node 实现放 `src/wiki/` 并在 `node.ts` 注册**。

### 3.2.1 落盘：`IFileService` 是只读的

**关键约束**：`packages/services/src/file/file.ts` 的 `IFileService` **没有任何写方法**
（只有 `readTextFile` / `readdir` / `stat` / `checkFilesExist` / `resolvePath` / `readFileRange` /
`searchWorkspaceFiles` / `listWorkspaceFiles*`）。wiki 产物落盘**不能走 `IFileService`**。

正确做法是用现成的原子写工具：
- `packages/services/src/fs/atomicFileUtils.ts:106 atomicWriteText()` / `:160 atomicWriteJson()`
- 落盘服务先例（照抄）：`packages/services/src/onboarding/onboardingRecordService.ts`
  —— `:64-69` 串行写队列（`enqueueWrite`）+ `:14` import `atomicWriteText`；
  另有 `settingService.ts:20`、`subagentsService.ts:38`、`pluginSyncService.ts:1107` 等同类先例

`workspacePath` 无集中解析函数，一律由调用方逐层显式传参（见 `zcodeAgent.ts:687`）。
唯一的路径规范化入口是 `IFileService.resolvePath()`。

### 3.2.2 长任务进度：用 `onDynamicXxx` 事件约定

框架层强制约定（`packages/rpc/src/proxy-channel.ts:164-172`）：
**服务接口上名为 `onDynamicXxx(arg)` 且返回 `Event<T>` 的方法会被 RPC 自动路由**，
服务端由 `fromService` 的 `isDynamicEvent` 识别（`proxy-channel.ts:72-74`）。
这是本仓唯一的长任务进度范式，wiki 生成进度必须用它。

可直接照抄的完整样本（**Feedback 最完整：进度 + 取消 + UI job 状态机三件套**）：

| 服务 | 接口 | 实现 | 取消 |
|---|---|---|---|
| Feedback | `packages/services/src/feedback/feedback.ts:46` `onDynamicUploadProgress(id)`；进度类型 `:14-19` | `feedbackService.ts:215`（emitter 延迟创建 + 末订阅者移除即清理 `:108-119`；AbortController 表 `:104-105`） | `cancelUpload` `:212`、`cancelCreate` `:151` |
| PromptAttachmentTransfer | `promptAttachmentTransfer.ts:42` | `promptAttachmentTransferService.ts:42` | `cancel(operationId)` `:40` |
| PluginManagement | `pluginManagement.ts:60` | `pluginManagementService.ts:40-41` | 有 |
| FileWatcher | `fileWatcher.ts:20` | `fileWatcherService.ts:135-138`（含订阅前事件 buffer） | — |

UI 侧 job 状态机模板（wiki 生成进度面板可直接照抄）：
`packages/ui/src/feedback/feedbackSubmissionJob.ts`（592 行）——
job 注册表 `:150-174`、状态形状 `getState()` `:186-203`、listener + setState/setProgress `:206-227`、
取消 `:167-188`、进度订阅 `:464`、取消调用 `:379`/`:393`。
UI 宿主参照 `FeedbackHost.tsx`、`FeedbackBackgroundUploadIndicator.tsx`、`FeedbackSubmitProgressView.tsx`。

### 3.2.3 一个 schema 硬约束

`packages/shared/src/model-selection.ts:4` 的 `modelSelectionSchema` 是 **`.strict()`，
只允许 `providerId` / `modelId` / `options.reasoningLevel` 三个键**。
所以产物里的 `generationOptions`（含 `generateDiagrams` / `maxOutputTokens`）
**不能复用这个 schema**，需要 wiki 自己定义类型。`generationOptions` 存盘时原样保留，
但传给模型时要把 `maxOutputTokens` 走 `generateWorkspaceText` 的独立入参
（`ZCodeAgentGenerateWorkspaceTextParams.maxOutputTokens`，`zcodeAgent.ts:306-312`）。

### 3.3 依赖方向（architecture-policy.yaml）

`global.managedOnly: true`，即只强制校验 `managed: true` 的模块（当前只有 `storage`）。
但 `maxFileLines: 400` 是全局限制——**新文件必须控制在 400 行以内**，否则要拆分。
这直接影响 wiki 生成逻辑的拆分方式（建议按「清单/建树/生成/落盘」拆成多个文件）。

`packages/services` 的既有依赖：`@zcode/provider`、`@zcode/provider-node`、`@zcode/rpc`、
`@zcode/shared`、`@zcode/zcode-cua`。wiki 功能**不需要新增任何依赖**。

### 3.3.1 「每次可以选择 AI」怎么实现

用户的原话需求是「每次可以选择 AI 进行对照项目写 wiki」。仓库已有完整机制，不需要新造：

- `packages/provider/src/facades.ts:201 interface ModelSelectionView`
  - `providers: readonly ModelSelectionProviderView[]` —— 可选的 provider/模型清单，喂给 UI 下拉框
  - `preferredSelection?: ModelSelection` —— 默认选中项
- `IModelSelectionService.getView()` 已是现成 RPC 服务
  （`packages/services/src/model-provider/providerFacadeServices.ts:105`）
- `ModelSelection` 的字段即产物里的 `modelSelection`：`{providerId, modelId, options:{reasoningLevel}}`
  —— 与样本 2 的 `wiki.json.modelSelection` **完全同构**，可以直接序列化存进产物

也就是说：UI 用 `modelSelectionService.getView()` 拉清单渲染选择器 →
把选中的 `ModelSelection` 传给 wiki 生成服务 → 生成时作为 `selection` 传给
`generateWorkspaceText` → 同时原样存进产物的 `modelSelection` 字段。
**这条链路两端都已经存在，wiki 只需要串起来。**

注意 `thoughtLevel` 与 `reasoningLevel` **是同一个东西的两个名字**，不是两个档位。
证据：`packages/ui/src/settings/SubagentsSection.tsx:208` 直接
`const reasoningLevel = thoughtLevel?.trim()`；`:312` 反向读
`thoughtLevel: initial?.modelSelection?.options?.reasoningLevel`。
即 `thoughtLevel` 是 UI 习惯叫法，落到数据模型就是 `modelSelection.options.reasoningLevel`。

所以产物里 `generationOptions.thoughtLevel` 与 `modelSelection.options.reasoningLevel` 同源，
实施时**只需保留一个**（建议保留 `modelSelection`，因为它是活的数据结构，
能与 `ModelSelectionView` 直接对接）；`generationOptions.thoughtLevel` 只为读旧产物而兼容即可。

### 3.4 UI 注册点

设置页分区不是随手加 JSX，而是有类型化注册表，需改 **4 处**：

| # | 位置 | 作用 |
|---|---|---|
| 1 | `packages/ui/src/lib/settingsNavigation.ts:4-23` | `SettingsSectionId` 联合类型加 `"wiki"`（现 19 个值） |
| 2 | `packages/ui/src/settings/settingsPageConfig.ts:55` 起 | `BASE_SETTINGS_SECTIONS` 加一项（`{id, icon, titleId, groupId}`）；分组见 `:39-48` |
| 3 | `packages/ui/src/i18n/locales/zh-CN.ts` + `en-US.ts` | 加分区标题与面板文案 |
| 4 | `packages/ui/src/SettingsPage.tsx:2143-2280` | 三元链里加 `activeSection === "wiki" ? <WikiSection/> : ...` |

注意 `settingsNavigation.ts:37-47 HIDDEN_SETTINGS_SECTIONS` 是「保留 id 但隐藏入口」的机制
（如 `workspaceFileSearch`、`computerUse`）。**wiki 不要加进这个集合**，否则分区不显示。

若做成侧边面板而非设置页，则改 **4 处不同位置**：
1. `packages/ui/src/lib/workspaceSidePane.ts:516-535`（`WorkspaceSidePaneTab` 联合，现 19 个成员）
2. `packages/ui/src/app-shell/AnimatedSidePanePanel.tsx`（`:1204`/`:1226`/`:1233`/`:1290` 的三元链）
3. `packages/ui/src/app-shell/sidePaneTabPresentation.ts:25-67`（搜索关键词）、`:101-120`（标题）
4. `packages/ui/src/app-shell/SidePaneTabTrigger.tsx:315`/`:523`（图标分支）

若要做成主视图（像 automations / plugin-store 那样），改
`packages/ui/src/app-shell/types.ts:120 WorkspaceMainView` 联合 +
`WorkspaceShellLayout.tsx:1747`/`:1800`/`:1902` 的分发链。

标记某个操作可被命令面板调用：`packages/ui/src/quickpick/quickPickCommands.ts:86` 的
`createQuickPickCommands()`，命令类型 `:36-49`，handlers 接口 `:54-77`（需扩接口才能加新动作）。

### 3.4.1 渲染层可直接复用（都已存在）

- **markdown 渲染器**：`packages/ui/src/components/ai-elements/message.tsx:1314 MessageResponse`
  （基于 `streamdown`，已内置 CJK / math / **mermaid** / code 插件，`:12-15`）
- **独立 markdown 面板**（wiki 页面展示最直接的选择）：
  `packages/ui/src/previewPaneMarkdownContent.tsx:20 MarkdownPreviewContent`
  —— 内部就是 `<MessageResponse workspacePath={...} />`（`:55-60`）
- **可折叠树**：`packages/ui/src/workspace-file-tree/WorkspaceFileTree.tsx`（20 个配套文件）；
  通用原语 `packages/ui/src/components/ui/collapsible.tsx`
- **文件路径链接**（点击打开源码，对应产物的 `filePaths` / `sources`）：
  `packages/ui/src/lib/markdownFileLink.ts:179 parseMarkdownFileLinkTarget()` /
  `:226 resolveMarkdownFileLink()`；点击处理在 `message.tsx:1428-1480`
- **mermaid**：`packages/ui/src/components/ai-elements/mermaid-block.tsx` +
  `diagram-preview-dialog.tsx`（无需新建）

**结论：UI 层几乎不需要新写渲染组件**，wiki 面板主要是「树 + markdown」的组合与数据接线。

### 3.5 裁剪合规红线

本项目已剔除全部云连接。wiki 功能**必须全部本地**：
- 不引入任何 z.ai / bigmodel 端点调用（模型调用一律走用户自配 provider）
- 不新增遥测（`apps/zcode-cli/packages/telemetry` 不得接入）
- 产物落本地磁盘，不上传

参照 `packages/services/src/node.ts:2390` 的先例：会话分享因为会上传云端，被替换为
`createUnsupportedConversationShareService`。wiki 是纯本地功能，不需要这种降级。

## 四、分期实施建议

### 第 1 期：只读消费（最小可用，风险最低）
先不做生成，只让已有产物能被看到。
1. 定义产物类型与读取器（纯函数，可单测）：按 §二的候选路径探测
   `<getAppConfigDir()>/<候选父目录>/<workspaceHash>/{wiki,task,draft}.json` + `draft-pages/`
2. 加 `IWikiService`（只读：`listWikis` / `getWiki` / `getPage`）
3. 按 §3.2 的 #1–#7 接线（首版不碰远端）
4. UI：设置页或侧边面板里列出 wiki，渲染目录树 + markdown（复用 §3.4.1 的现成组件）
5. 验证：能正确加载 `/Users/linguojin/Downloads/WIKI/` 两份样本
   —— 含旧版 schema（无 `modelSelection`）与含 failedPages 的那份（占位页 `markdown: null`）

**为什么先做只读**：产物契约复杂（两版 schema + 占位页 + 目录树 + 未确证的存储路径），
先把「读对」验证透，再写「生成」才不会返工。只读阶段没有任何写入风险。

### 第 2 期：生成能力

**先做一个关键架构决策：生成逻辑放在哪一层。** 两个候选：

| | 方案 A：服务层（推荐） | 方案 B：CLI runtime |
|---|---|---|
| 落点 | `packages/services/src/wiki/` | `apps/zcode-cli/packages/core/src/` |
| 模型调用 | 循环调 `generateWorkspaceText`（单次文本生成，无工具循环） | agent 循环 + Read/Grep 工具（参照 `memory/`） |
| 文件内容 | 自己读、自己控预算 | 模型自己读 |
| 进度 | `onDynamic` 事件（RPC 原生） | 需新增协议方法（4 处） |
| 落盘 | `atomicWriteJson`（host 进程） | `runtime.fileSystemPort`（CLI 侧，**不是** `IFileService`） |
| 测试脚手架 | 有（`packages/services/test/`） | **无**（`apps/zcode-cli` 无 test 目录） |

**推荐方案 A**，理由是产物契约本身决定了它就是「两阶段 + 逐页落盘」的形状：
`catalogTree` 先规划好每页的 `filePaths`，再逐页生成 markdown，`generatedPageIds` 记录进度。
这与「循环调用单次文本生成 + 每页落盘」直接对应；
而方案 B 的自由 agent 循环反而不自然产生这种可分页检查点的产物。

参照先例：`memory` extraction（`apps/zcode-cli/packages/core/src/memory/`）是方案 B 的完整范本，
若将来发现方案 A 生成质量不足（模型需要主动探索仓库才能写好），可迁移过去。

方案 A 的实施步骤：
1. 项目扫描 → 算 `manifestHash` + 建 `context`（`fileCount` / `languageStats` / `commitHash` 等）
2. 调用模型产出 **catalogTree**（第一跳：让模型给出目录结构与每页 filePaths）
3. 逐页调用 `generateWorkspaceText` 产出 markdown，**每页完成即落盘 `draft-pages/`**，
   并把 id 追加到 `generatedPageIds`
4. 失败页不阻塞；全部结束后写 `wiki.json` / `task.json`（`failedPages` 如实记录）
5. 支持断点续跑：重跑时按 `generatedPageIds` 跳过已完成页
6. 并发与取消：服务接口加 `onDynamicWikiProgress(taskId): Event<...>` + `cancel(taskId)`，
   取消用 `generateWorkspaceText` 的 `signal`（内部转 `operationId` + `cancelGenerateText`）

**注意：本仓没有通用 checkpoint/断点续传框架**，`generatedPageIds` 需要自己实现。
唯一相近的是 `memory/extraction.ts:85` 的 `getCursor()`（消息游标，语义不同）。

### 第 3 期：打磨
`generateDiagrams`（图表生成）、增量更新（按 `manifestHash` 判断项目是否变过）、
导出、页面跳转到源码文件（`sources[].startLine` 已经带了行号锚点）。

## 五、风险与取舍

1. **样本格式兼容 vs 重新设计** —— 建议**完全兼容**。两份样本代表两个 schema 版本，
   说明上游自己演进过；直接兼容可以立刻吃下用户已有产物，且字段本身覆盖完整
   （`sources` 带行号、`catalogTree` 与 `pages` 分离、`generatedPageIds` 支持续跑，设计是合理的）。
   代价是要处理两版字段差异（`modelSelection` 有无）与占位页（`markdown: null`）。

2. **模型输出不可控** —— `gitCommitMessageGenerator` 已有应对先例（校验失败抛 `invalid-output`、
   只留短 preview 给用户）。wiki 页面是长文本，校验标准更松，需要防止模型返回空内容或复述 prompt。
   建议：单页生成失败按 `failedPages` 记账而不是整体失败。

3. **长任务超时与成本** —— 样本 2 是 52 页、`maxOutputTokens: 65536`，总耗时
   （`task.json` 时间戳差）约 4.8 小时。必须逐页落盘 + 可中断续跑，
   否则中途失败会丢掉全部进度。这也是 `draft-pages/` 目录存在的根本原因。

4. **maxFileLines: 400 约束** —— 生成逻辑天然容易写成大文件，需提前按职责拆分
   （建议：`wikiTypes.ts` 类型 / `wikiScan.ts` 项目扫描 / `wikiPlan.ts` 建树 /
   `wikiGenerate.ts` 逐页生成 / `wikiStore.ts` 读写落盘，各自成文件），
   否则会卡在架构检查上。

5. **`BackgroundWorkSummary.kind` 是闭集，别踩** ——
   若想让 wiki 生成进度出现在 v4 会话状态面板里，必须扩
   `packages/shared/src/zcode-protocol-v4/snapshot.ts:368` 的
   `z.enum(["bash","subagent","workflow"])`，而该 schema 的注释（`:364-367`）明确警告
   **旧版桌面会整帧拒收**，CLI 与桌面必须同批发布。
   → **建议首版不要把 wiki 塞进 status panel**，用 §3.2.2 的独立 `onDynamic` 事件 + 自己的
   进度面板，避开这个版本耦合陷阱。

6. **远端 workspace 需要单独决策** —— 首版建议显式排除远端
   （参照 `apps/zcode-cli/packages/core/src/runtime/helpers/project-memory-extraction.ts:42`
   的 `if (runtime.isRemoteWorkspace()) return;`），避免落盘位置歧义
   （远端文件系统 vs 本机）。要支持时再按 §3.2 #8 注册并决定归属侧。

## 六、验证命令（均已实测）

```bash
pnpm typecheck                              # 全仓类型检查（已实测 exit=0）
pnpm lint                                   # oxlint（已实测 0 error，71 个既有 warning）
pnpm architecture:check -- --changed        # 架构约束（已实测 0 违规）
node --import tsx --test packages/services/test/wikiStore.test.ts        # 14/14
node --import tsx --test packages/services/test/wikiPlan.test.ts         # 13/13
node --import tsx --test packages/services/test/wikiAutoUpdate.test.ts   # 6/6
node --import tsx --test packages/services/test/wikiRealSamples.test.ts  # 2/2（真实产物）
```

`wikiRealSamples.test.ts` 直接读 `/Users/linguojin/Downloads/WIKI/` 下的两份真实产物
（复制到临时 workspace 的 `wiki/` 下再读），覆盖旧版 schema、failedPages 场景与 mermaid 图。
样本目录不存在时自动 skip，不会在别的机器上误报失败。
