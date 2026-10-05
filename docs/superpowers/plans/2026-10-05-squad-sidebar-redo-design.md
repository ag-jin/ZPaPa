# ZPaPa「侧栏小队重做」UI 设计方案

> 版本：`ui_design_report.v1`
>
> 日期：2026-10-05
>
> 范围：仅设计侧栏、智能体列表页、小队列表页及其共享状态视觉；不改产品代码/测试。本方案优先遵循 multica 的已实证设计（`multica-ai/multica@b4ca5b4`），同时服从 ZPaPa「既有项目/任务入口一行不改」的防改坏裁定。

## 1. 现状与设计约束

### 1.1 必须解决的四项缺陷

| 缺陷 | 本方案的验收结论 |
|---|---|
| 位置/形态不对 | 取消「toolbar 开关按钮 + 列表区顶部内嵌面板」。小队功能只作为侧栏纯导航分组中的直达入口；不把项目/工作区列表嵌入侧栏。 |
| 信息密度太浅 | 侧栏提供入口名称及稳定的导航层级；列表页提供 enabled/archived、运行中数量、排队数量、头像堆叠等状态密度。可选 hover 预览只展示已有快照，不在侧栏复制完整 roster。 |
| 交互路径太深 | 点击「智能体」或「小队」一次直接进入既有列表页，再从列表项进入详情；不经过开关、项目分组或中间面板。 |
| 预览版默认打开实验开关 | 本设计假设架构线已提供该语义：预览版入口默认可见，正式版默认关闭；UI 不自行复制默认判定，只继续消费统一的 `squadEntryVisible(settings)`。 |

### 1.2 已有代码事实

- `WorkspaceSidebar` 当前用 `showSquadEntries = squadEntryVisible(settings)` 作为四个实验入口的共用显隐判据（`packages/ui/src/WorkspaceSidebar.tsx:765-766`；事实报告 `.../2026-10-05-sidebar-redo-repo-facts.md:156-162`）。四个入口位于顶部导航列：Inbox `:1355-1371`、Agents `:1374-1390`、Squads `:1393-1409`、Work Items `:1412-1428`（事实报告 `:164-172`）。
- App → Shell → Sidebar 已有纯视图切换回调链：`App.tsx:844-861`，`WorkspaceShellLayout.tsx:209-212,1655-1666`，列表页在 `WorkspaceShellLayout.tsx:1953,1985` 等位置渲染（事实报告 `:176-186`）。重做优先复用这条链，不另造导航状态。
- `SquadSidebarSection.tsx` 为生产零引用的休眠组件，仅被结构守卫读取（`packages/ui/src/squad/SquadSidebarSection.tsx:16-27,41-55`；事实报告 `:118-150`）。它代表已废弃的「按项目分组、可折叠、顶部开关、列表区之前插入」方案，不能接回生产侧栏。
- 可用于状态的信息只有 `getSnapshot()`、`squad_runs`、agent 的 enabled/archived 状态与 `SUBAGENT_COLORS` 九色板；没有 multica 的 runtime availability（online/unstable/offline）字段（事实报告 `:12-18`、`:219-259`）。因此本设计不出现“在线/离线”措辞。
- 当前已有列表页 `SquadAgentsPage`/`SquadsPage` 及列表组件（事实报告 `:186`；源码目录 `packages/ui/src/squad/SquadAgentsPage.tsx`、`SquadsPage.tsx`、`SquadAgentsList.tsx`、`SquadsList.tsx`）。本轮把密度主要落在这些列表页，而非侧栏。

### 1.3 不可破坏的旧入口

「工作项」与既有项目/任务入口继续保持原有顺序、回调、active 表现与 testid；不把它移动进新 AI Team 分组，也不借重做改动任务列表区。当前工作项入口位于小队入口之后（`WorkspaceSidebar.tsx:1410-1428`），设计只要求将其视觉上归入既有 Work 语义时保持原一行导航事实不变；实现若需重排 DOM，必须先更新并扩大结构守卫，默认策略是**不重排**。

## 2. multica 对照与吸收边界

### 2.1 直接吸收

multica 侧栏是纯导航：个人区、Pinned、Work、AI Team、工具区；Agents/Squads 仅图标+文字直达列表页，状态密度留给列表页；Pinned 使用可折叠、截断、`Show N more`、dnd、hover 数量/X 的交互模板。该结论来自用户给定的源码实证：实体为 `packages/views/layout/app-sidebar.tsx`，commit `b4ca5b4`。

ZPaPa 吸收为：

1. 新增一个明确的侧栏分组标题 **AI Team / AI 团队**，默认展开；分组本身不是开关，不承载数据请求，不按项目/工作区复制入口。
2. 将现有实验入口的视觉组织调整为：Inbox 作为个人区入口；Agents、Squads 置于 AI Team；Work Items 保留在既有 Work 位置/行语义。若现有导航没有可安全重组的 Work 标题，则只新增 AI Team 标题并维持 Work Items 原 DOM 顺序，禁止为“对齐视觉”改动任务区。
3. Agents/Squads 一击直达既有 `squadAgentsPage`/`squadsPage`；列表项再进入详情页。不引入项目分组选择器或第二级小队面板。
4. 若实现 hover 预览，采用轻量浮层而非内嵌面板；默认不加载新数据，使用当前 snapshot 缓存；点击卡片仍进入完整列表/详情。
5. 头像堆叠使用 `SUBAGENT_COLORS`，最多显示 3 个头像，余数以 `+N` 表示；这是列表页卡片素材，不是侧栏入口的永久徽标。

### 2.2 明确不吸收

- 不吸收 multica runtime availability 的 online/unstable/offline 语义；ZPaPa 当前无该数据。
- 不在侧栏按项目/工作区分组；workspace 切换是上层壳的责任。
- 不把 running/queued 的详细状态塞进每条侧栏导航文字，避免侧栏变成第二个列表页；若有 hover 卡，仅提供摘要。
- 不复活 `SquadSidebarSection` 的按项目快照拉取、折叠项目、跨项目激活流程。该组件后续应删除，或改造为与本方案无关的实验隔离文件后再删除；不得保留生产接线。

## 3. 目标信息架构与交互

### 3.1 侧栏层级

建议顺序（只表达视觉分组；既有入口回调与导航地址不变）：

```text
个人
  Inbox                         [未读数徽标，仅当有未读]
  Chat                          [未读数徽标，仅当有未读]

Pinned                        [可折叠；沿用既有 Pinned 交互，如已有]
  ...
  Show N more

Work                          [现有项目/任务入口不改]
  Issues / Projects / Work Items（按现有产品事实呈现）
  Autopilot（若已有）

AI Team                       [默认展开；不是实验开关]
  Agents                       → 智能体列表页
  Squads                       → 小队列表页

工具
  Usage / Settings（按现有侧栏事实呈现）
```

若当前 ZPaPa 尚未有完整的 Chat/Issues/Projects/Autopilot/Usage 入口，不能为了补齐示意而虚构入口；本轮只新增 `AI Team` 分组标题，并将 Agents/Squads 置于其中。Inbox 和 Work Items 的现有一行入口、顺序及行为继续由现有实现负责。

### 3.2 侧栏入口组件

`AiTeamSidebarSection`（命名建议；实现时可复用已有分组组件）包含：

- 分组标题：图标 `UsersRound` 或现有团队图标 + `AI Team/AI 团队` 文案；默认展开。标题若可折叠，应有 `aria-expanded`，折叠只隐藏 Agents/Squads，不改变 gate。
- `Agents`：图标 `Bot`，文字直达；active 时使用现有 `bg-selected`/foreground token；不展示项目名、不展示数量徽标作为永久信息。
- `Squads`：图标 `UsersRound`，文字直达；active 时同上。
- 可选状态点：只有在已有 snapshot 已准备且确有需要时，在入口尾部展示一个 4px 状态点，含义为“此入口下存在需要注意的 run”，不展示裸数字。首期建议不显示，以保持 multica 的纯导航密度。

交互：

- 鼠标、键盘 Enter/Space 均一次进入目标列表页。
- active 入口不因再次点击而打开额外面板；仅保持列表页。
- gate 关闭或 settings 尚未加载时，整个 AI Team 分组不渲染，避免加载期间闪现（复用 `squadEntryVisible` 的 null/false 语义，事实报告 `:43-48`）。
- loading 不用侧栏 spinner 阻塞导航；列表页自行展示 loading。若未来 hover 预览无法取得 snapshot，显示“状态暂不可用”，入口仍可点击。

### 3.3 可选 hover 预览卡

首期可不做；若产品需要进一步提高入口信息密度，作为第二阶段增强：

- 触发：鼠标 hover 500ms 或键盘 focus 入口；触摸设备不触发，改为点击列表页。
- 定位：侧栏外侧浮层，宽 `280px`，不改变侧栏宽度和任务列表布局。
- 内容：标题（Agents/Squads）、总数、最多 3 个头像+`+N`、一行 active 状态摘要（例如“2 个运行中 · 1 个排队”）以及“打开列表”动作。
- 不含：项目分组、创建/编辑/删除、跨 workspace 激活、完整 run 列表。
- 关闭：pointer leaving、Escape、点击外部；focus 从入口进入浮层时不应丢失。
- 失败/无数据：`状态暂不可用`，不把错误伪装为 0；点击仍进入列表页。

## 4. Presence 语义与密度规范

### 4.1 ZPaPa 自有 presence 模型

不命名为 runtime presence，避免暗示在线探测。建议在 view model 层定义 `SquadPresenceSummary`（设计概念，不是本轮新增服务协议）：

| 维度 | 值 | 数据来源 | 视觉语义 |
|---|---|---|---|
| availability | `enabled` / `archived` | agent/squad 的 `enabled`、`archivedAt` | enabled=可派发；archived=历史保留、不可派发 |
| workload | `working` / `queued` / `idle` | `squad_runs` 的现有 run 状态，按服务层 canonical 状态映射 | working=存在运行中 run；queued=无/少量运行中但存在排队 run；idle=无运行中、无排队 |
| counts | `runningCount`、`queuedCount` | 同一 snapshot/run 查询聚合 | 只显示实际计数；不从列表长度猜测 |

约束：

- 不把 `enabled=false` 误标为 offline；文案是“已停用”。
- `archivedAt !== undefined` 优先级高于 enabled，文案是“已归档”；归档条目仍可查看历史，不能显示为可运行。
- `runningCount` 必须来自 run 的运行中状态；`queuedCount` 必须来自 run 的排队状态。实现要复用服务层已有状态枚举/映射，不在 UI 私自新增状态字符串。
- 状态未知、快照 loading 或读取失败时为 `unknown` 展示“状态暂不可用”，并保留入口/列表行；绝不显示 `0` 代替读取失败。
- 多 agent/squad 卡片取聚合：`runningCount = Σ runningCount`，`queuedCount = Σ queuedCount`；单个 agent 行显示自身计数，小队行显示小队聚合。

### 4.2 点色与文案

颜色必须使用语义 token，不直接写色值；状态点旁必须有可读文本或 `aria-label`，不能只靠颜色。

| 状态 | 点色 token | zh-CN | en-US | 说明 |
|---|---|---|---|---|
| enabled + working | `--color-status-working`（建议复用现有 success/primary 语义） | 运行中 · {runningCount} | Working · {runningCount} | `runningCount > 0` 时显示 |
| enabled + queued（且无 working） | `--color-status-queued`（warning） | 排队中 · +{queuedCount} | Queued · +{queuedCount} | `queuedCount > 0`；`+N` 代表等待中的 run |
| enabled + idle | `--color-status-idle`（neutral） | 空闲 | Idle | 无 working/queued |
| disabled | `--color-status-disabled`（neutral/subtle） | 已停用 | Disabled | 不可派发 |
| archived | `--color-status-archived`（muted） | 已归档 | Archived | 历史条目 |
| unknown/error | `--color-status-unknown`（danger/neutral，按现有 alert 语义） | 状态暂不可用 | Status unavailable | 读取失败或数据未齐 |

`runningCount` 规范：

- 单 agent：状态行显示 `运行中 · 2` / `Working · 2`；若有容量字段未来可用，再扩为 `2/{capacity}`，本轮不凭空展示容量。
- 小队：显示 `运行中 · 3`；需要同时表达排队时追加 `+2 排队` / `+2 queued`，不要把 `+2` 做成未解释的 badge。
- 只有排队无运行时显示 `排队中 · +2`；“+”是队列计数前缀，不表示增量变化。
- 0 不显示状态计数；显示“空闲”。

### 4.3 列表页卡片/行

#### 智能体列表页

每行/卡片由左到右：

1. 头像圆形 `32px`，颜色来自 `SUBAGENT_COLORS`；归档时降饱和并叠加归档标识。
2. 名称（主信息）与 description（最多两行，超出省略）。
3. Presence 行：状态点 + enabled/archived 文案 + workload 文案。
4. 数据信息：`运行中 · N`；有排队时 `+M 排队`。
5. 右侧动作：进入详情；已有归档/恢复/编辑动作按现有页面裁定呈现，不把动作塞入侧栏。

#### 小队列表页

每张 `squad-profile-card`：

1. 头像堆叠，最多 3 个，剩余以 `+N`；头像之间重叠 `8px`，外露边框使用 surface token。
2. 小队名、description。
3. 成员摘要：`N 个智能体` / `N agents`，归档成员不计入可运行成员但可在详情看历史。
4. Presence 汇总：状态点 + `运行中 · N` + 可选 `+M 排队`。
5. 卡片整体为可聚焦链接/按钮，一击进入小队详情；不先展开侧栏面板。

列表页状态密度应高于侧栏：允许每行同时显示 availability、workload、runningCount、queuedCount；状态信息与名称有明确层级，避免把数量做成唯一识别线索。

### 4.4 状态覆盖

- Loading：列表骨架行 3 条；头像/标题/状态位置保持稳定，避免布局跳动。
- Empty：Agents 无条目显示插图/图标、`暂无智能体 / No agents yet` 和列表页内的创建入口（若既有创建能力存在）；Squads 同理。空态不返回侧栏面板。
- Error：页面级 alert 显示读取失败与重试；已缓存行可保留并标注“状态暂不可用”；不可把 error 归并为 0。
- Partial：部分 agent/squad 成功、部分 run 查询失败时，成功条目正常显示，失败条目显示 unknown；页头提供“部分状态不可用”辅助文本。
- Archived：归档项默认位于列表筛选后的“已归档”区域或按现有页面规则显示；状态永远是“已归档”，不显示可运行点色。
- Gate off：入口和页面入口均不可见；已有深链接若被直接访问，应由页面使用既有实验关闭态（而不是侧栏重新定义文案）。

## 5. 视觉 token 与可访问性

### 5.1 Token 决策

优先复用现有 UI token（如 `bg-selected`、`text-foreground`、`text-foreground-subtle`、`border`、`destructive`、现有 `text-ui-xs/sm`）。若缺少以下语义，仅新增设计 token，不在组件内硬编码：

```text
Typography
  --font-ui-label: 14px / 20px, weight 500       侧栏入口、卡片标题
  --font-ui-body: 14px / 22px, weight 400        description、状态辅助文本
  --font-ui-caption: 12px / 16px, weight 400     点色旁文案、+N 排队
  --font-ui-section: 12px / 16px, weight 600     分组标题，字距 0.02em
  --font-ui-page-title: 20px / 28px, weight 600  列表页标题

Spacing（8-point system）
  --space-1: 4px    点色与文案间距、头像边框
  --space-2: 8px    icon-text、头像重叠外露、行内状态间距
  --space-3: 12px   入口水平 padding、卡片内部小间距
  --space-4: 16px   侧栏分组间距、卡片 padding
  --space-5: 20px   列表页 section 间距
  --space-6: 24px   页面左右 gutter
  --space-8: 32px   页面大区块间距

Iconography
  --icon-sidebar: 16px
  --icon-status: 8px（实际可用 8px 圆点；不可作为唯一信息）
  --icon-card: 20px
  --avatar-agent: 32px
  --avatar-stack-overlap: 8px
  --sidebar-preview-width: 280px
```

颜色语义：

```text
--color-status-working: 复用现有 success/brand 强色
--color-status-queued: 复用现有 warning 色
--color-status-idle: 复用现有 neutral-subtle 色
--color-status-disabled: 复用 muted foreground
--color-status-archived: 复用 archived/muted 色
--color-status-unknown: 复用 destructive 或 warning 的告警语义
--surface-sidebar-preview: 现有 popover/surface token
--border-sidebar-preview: 现有 border token
```

每个状态前景/背景组合达到 WCAG AA：正文至少 4.5:1，大字号与 UI 控件至少 3:1；点色需同时配合文案和 `aria-label`。暗色主题沿用语义 token，不为本方案另设一套亮色值。

### 5.2 无障碍

- AI Team 分组标题若可折叠，使用真实 `button`、`aria-expanded`、`aria-controls="ai-team-sidebar-items"`；不使用仅可点击的 `div`。
- Agents 入口：`aria-label="打开智能体列表"` / `aria-label="Open agents list"`；Squads：`aria-label="打开小队列表"` / `aria-label="Open squads list"`。若 label 可从可见文字自然生成，可保留可见文字并确保 name 不重复。
- active 入口使用 `aria-current="page"`，不只使用颜色或 `aria-pressed`；已有实现若使用 `aria-pressed`，重做时应至少补齐 current 语义，不改变导航行为。
- 状态点使用 `aria-hidden="true"`，父级状态文本提供完整 accessible name，例如 `智能体 Mika，已启用，运行中 2 个，排队 1 个`；归档项为 `智能体 Mika，已归档`。
- hover 卡必须可由键盘 focus 触发、Escape 关闭、焦点回到入口；不依赖 hover 才能取得关键信息。
- 所有入口与卡片最小命中区为 `32px` 高，触摸场景优先 `44px`；focus ring 使用现有 focus token，不能被 overflow 裁掉。
- 键盘顺序：分组标题（若可折叠）→ Agents → Squads → 后续 Work/工具入口；折叠后焦点不落入隐藏项。
- 不使用颜色作为唯一状态编码；归档/停用使用文字与图标/样式共同表达。支持 `prefers-reduced-motion`，头像 hover 与浮层不做必须依赖动画的反馈。

### 5.3 响应式

- 宽侧栏：显示图标+文字；AI Team 标题和两入口完整可见。
- 窄/折叠侧栏：只显示图标，入口保留 tooltip 与 accessible name；AI Team 分组标题可用团队图标表示，不复制状态数字。
- 主内容桌面宽度 `>= 1024px`：列表使用两列卡片或宽行，详情状态完整展开。
- `768–1023px`：列表改单列，状态信息保持两行内；头像堆叠不减少到单头像。
- `<768px` 或移动/窄窗：侧栏变为抽屉/导航层时，AI Team 仍是一级分组；禁用 hover 预览，点击直达列表；卡片状态换行而不横向溢出。
- 任何断点不把 Agent/Squad 重新按项目分组，也不把 Work Items 移到 AI Team。

## 6. i18n、testid 与语义清单

### 6.1 i18n 双语键

保留现有导航键 `workspace.openSquadAgents`、`workspace.openSquads`、`workspace.openWorkItems`（zh-CN `packages/ui/src/i18n/locales/zh-CN.ts:1504-1507`；en-US `:1619-1622`，事实报告 `:206-215`）。建议新增/重命名为以下稳定命名；实现时不得保留同义重复键：

| key | zh-CN | en-US |
|---|---|---|
| `squad.sidebar.aiTeam` | AI 团队 | AI Team |
| `squad.sidebar.openAgents` | 智能体 | Agents |
| `squad.sidebar.openSquads` | 小队 | Squads |
| `squad.sidebar.statusUnavailable` | 状态暂不可用 | Status unavailable |
| `squad.sidebar.enabled` | 已启用 | Enabled |
| `squad.sidebar.disabled` | 已停用 | Disabled |
| `squad.sidebar.archived` | 已归档 | Archived |
| `squad.sidebar.idle` | 空闲 | Idle |
| `squad.sidebar.working` | 运行中 · {count} | Working · {count} |
| `squad.sidebar.queued` | 排队中 · +{count} | Queued · +{count} |
| `squad.sidebar.queuedShort` | +{count} 排队 | +{count} queued |
| `squad.sidebar.agentCount` | {count} 个智能体 | {count, plural, one {# agent} other {# agents}} |
| `squad.sidebar.memberCount` | {count} 个成员 | {count, plural, one {# member} other {# members}} |
| `squad.sidebar.moreMembers` | 还有 {count} 个 | +{count} more |
| `squad.sidebar.openAgentsAria` | 打开智能体列表 | Open agents list |
| `squad.sidebar.openSquadsAria` | 打开小队列表 | Open squads list |
| `squad.sidebar.aiTeamExpand` | 展开 AI 团队 | Expand AI Team |
| `squad.sidebar.aiTeamCollapse` | 收起 AI 团队 | Collapse AI Team |
| `squad.sidebar.noAgents` | 暂无智能体 | No agents yet |
| `squad.sidebar.noSquads` | 暂无小队 | No squads yet |
| `squad.sidebar.partialStatus` | 部分状态暂不可用 | Some statuses unavailable |
| `squad.sidebar.previewOpenList` | 打开列表 | Open list |

已有 `squad.sidebar.noProjects/loadFailed/agentsEntry/squadsEntry` 四键及其结构守卫位于 `packages/ui/test/squadSidebarSection.test.ts:18-28`（事实报告 `:143-150`）。它们属于旧组件契约；重做删除旧组件后应删除旧键或迁移为上表键，并同步删除只为旧面板服务的守卫，不能让死键继续约束新结构。

计数文案必须用 ICU plural/变量，不通过字符串拼接生成中英文句子；错误态、loading 态、unknown 态均不得把空字符串作为可见状态。

### 6.2 testid 命名

采用稳定、按语义而非 CSS 命名的 testid：

```text
ai-team-sidebar-section
ai-team-sidebar-toggle                 （若分组可折叠）
ai-team-sidebar-agents
ai-team-sidebar-squads
squad-agents-page
squads-page
squad-agent-row-{agentId}
squad-profile-card-{squadId}
squad-presence
squad-running-count
squad-queued-count
squad-avatar-stack
squad-sidebar-preview                 （若实现 hover 卡）
squad-sidebar-status-unavailable
```

旧 `squad-sidebar-section`、`squad-sidebar-group-header`、`squad-sidebar-${kind}` 属于按项目内嵌面板的测试契约（`SquadSidebarSection.tsx:135-190`），删除旧面板时必须负向守卫它们不再出现在生产路径；新入口 testid 每个恰为一处渲染，不用动态拼接隐藏多个副本。

## 7. 结构守卫与验收守卫

守卫应优先验证可观察结构事实，必要时新增渲染级用例；不能只验证某段注释或类名。

### 7.1 侧栏结构正向守卫

1. `ai-team-sidebar-section` 存在且只渲染一个。
2. AI Team 分组默认展开；若可折叠，`aria-expanded` 与子项可见性一致。
3. `ai-team-sidebar-agents` 与 `ai-team-sidebar-squads` 各恰一处，均在 AI Team 分组内。
4. Agents 在点击后调用既有 `onOpenSquadAgents`，Squads 调用既有 `onOpenSquads`；回调链仍到 `workspaceMainView` 的 `agents`/`squads`（现状依据 `App.tsx:844-861`）。
5. 侧栏不新增 project/workspace map；源码中不得出现按项目遍历并为每个项目渲染 Agents/Squads 的新路径。
6. Work Items 的 `work-items-sidebar-open`、现有项目/任务入口的顺序与行为保持；任何 DOM 重排都应被测试明确拒绝，默认不重排。
7. gate 仍只有一个 UI 判据，入口开关为 false/null 时 AI Team 不渲染；预览/正式默认值由架构线守卫，不在 UI 复制渠道判定。
8. active 入口具有 `aria-current="page"`，所有状态文本同时可访问。

### 7.2 列表密度守卫

1. agent 行能显示 enabled/disabled/archived 三类 availability；归档项不能显示 working/queued 为可运行状态。
2. runningCount 来自 canonical run 聚合，queuedCount 来自 canonical queue 聚合；`runningCount=0` 不显示虚假的 `运行中 · 0`。
3. queuedCount > 0 时必须显示可读 `+N 排队/+N queued`，且不是仅颜色或裸数字。
4. 小队卡片有头像堆叠，最多 3 个可见头像，超出显示 `+N`；成员数为 0、1、3、4、N 均有测试覆盖。
5. loading/error/partial/empty 不把错误读取降级为 0；unknown 有独立 testid 与双语文案。
6. 九色板只用于头像身份区分，状态点使用语义状态 token；不能用九色板推导 online/offline。

### 7.3 旧面板负向守卫

删除 `packages/ui/src/squad/SquadSidebarSection.tsx`（推荐）以及只服务它的生产/测试契约；验收要求：

- `packages/ui/src` 无 `SquadSidebarSection` 生产引用；
- `WorkspaceSidebar` 不含 `SquadSidebarSection`、`squad-sidebar-group-header`、`squad-sidebar-empty`、`squad-sidebar-error`；
- 不存在旧注释所描述的“header 右侧开关 + 列表区之前条件渲染”接线（旧文件 `:16-27`）；
- 不存在按 workspacePath 的项目入口循环；
- 旧 `squad-sidebar-${kind}` testid 不再作为生产结构守卫；新守卫只钉 AI Team 两入口的数量与归属。

若暂时不能删除文件，必须标记 deprecated 且生产构建不可 import；不过推荐直接删除，因为它的测试守卫会持续把已裁定作废的交互拉回实现。

### 7.4 建议的渲染级补充

现有侧栏守卫主要是源码级结构守卫，并无入口渲染/e2e 覆盖（事实报告 `:263-284`）。本轮至少补充：

- gate on：AI Team 两按钮可见、点击一次切到对应 page；
- gate off/null：AI Team 不可见；
- active page：`aria-current` 正确；
- list fixture：enabled+working、enabled+queued、idle、disabled、archived、error 各渲染一次；
- keyboard：Tab → AI Team → Agents → Squads，Enter 直达，Escape 关闭预览（若做）。

## 8. 分期建议与第④/⑤刀衔接

### 本轮「侧栏小队重做」必须进入的范围

1. 侧栏纯导航化：AI Team 分组、Agents/Squads 直达；不接旧 `SquadSidebarSection`。
2. 既有 Work/项目/任务入口防改坏：顺序、回调、active、testid 的回归守卫。
3. 列表页 presence 基础：enabled/disabled/archived + runningCount + queuedCount；统一点色、双语文案、加载/错误/空态。
4. 头像堆叠与 `+N`；小队卡片状态摘要。
5. i18n、testid、aria 与结构/负向守卫。
6. 预览默认开只作为消费前提：不在本轮另改 schema、setting service 或 desktop；避免和架构线冲突。当前开关定义/缺省在 `packages/shared/src/protocol.ts:434-435`、`packages/shared/src/validationAppSettings.ts:517`，既有 UI 入口门在 `squadEntryVisibility.ts:16-22`（事实报告 `:22-48`）。

### 与第④刀（agent 独立详情页）的衔接

第④刀已裁定 agent 详情页承载概览、任务表、运行数据（对照文档 `docs/superpowers/specs/2026-10-04-multica-agents-parity.md:154-159`）。本轮列表行/卡片点击只做导航，不在侧栏/列表复制详情数据；presence 行的运行中/排队摘要作为详情页运行区的入口预告，详情页继续提供完整 run/任务历史。建议为 row/card 保留稳定的 `agentId/squadId` 深链，不设计二次 overlay 详情。

### 与第⑤刀（Concurrency/归档可恢复）的衔接

第⑤刀负责 Concurrency 派发闸与归档 Restore（对照文档 `.../multica-agents-parity.md:157-160`）。本轮：

- 不显示不存在的 capacity；现在只显示 runningCount。第⑤刀提供 per-agent capacity 后，状态行可扩为 `runningCount/capacity`，并在设计 token/文案中追加变量，而不改变入口路径。
- `archived` 视觉使用可恢复中性历史态，不使用“永久删除/不可恢复”文案；Restore 加入详情/列表项动作后，侧栏仍只显示入口。
- Concurrency 阻塞导致的排队仍显示 `+N 排队`，但“被 capacity 限流”原因需在详情/运行列表解释，不能在侧栏猜测。
- 第⑤刀若改变 run 状态枚举，必须由服务层提供 canonical → UI presence 映射；禁止 UI 直接依赖数据库字符串。

### 第二阶段可选增强

- hover preview 卡与 keyboard focus preview；
- Pinned 的 dnd/截断/数量/X 模板若 ZPaPa 尚无对应基础能力；
- 列表筛选“仅运行中/仅排队/已归档”；
- run 状态更新时间、容量 tooltip。以上均不能倒逼回按项目内嵌面板。

## 9. 偏离与开放问题

### 9.1 相对既有设计系统的偏离

- 新增 AI Team 分组是 IA 层增量，原因是用户明确裁定优先 multica；不改变现有导航回调和 Work/项目/任务入口。
- 新增语义状态 token 仅在现有 token 缺失时发生；优先映射到已有 success/warning/neutral/muted/danger，避免引入第二套颜色体系。
- 旧 `SquadSidebarSection` 的测试守卫会被删除/改写，而不是兼容：因为它固定了已废弃的项目分组形态，与本轮上位裁定直接冲突。

### 9.2 开放问题（交 task-planner/main-session）

1. 当前侧栏是否已有完整的 Work/个人/工具分组组件可直接复用？若没有，AI Team 只新增一个分组标题，不补齐 multica 全量入口。
2. `squad_runs` 的 canonical 状态到 `working/queued/idle` 的服务层映射名称需由实现/架构线确认；本设计禁止 UI 自行猜数据库枚举。
3. 是否首期做 hover preview？建议先不做，待列表页 presence 通过真实数据与可访问性验证后再原型验证。
4. 预览默认开与“预览包中用户曾显式关闭”的迁移语义仍由架构线裁定；本 UI 方案只消费最终 settings 快照，不复制渠道判断。

## 10. 实施交接结论

推荐下一角色为 `task-planner`：按“侧栏 IA/旧面板删除 → presence view model 与列表密度 → i18n/无障碍 → 结构及负向守卫 → 可选 hover”拆解依赖；实现时由 `implementer` 只修改本设计批准的 UI 文件与测试，不修改 services/desktop 的开关默认实现。验收以本文件第 7 节守卫和第 8 节分期边界为准。
