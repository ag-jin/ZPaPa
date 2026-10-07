# multica「智能体」页逐格对照（字段级吸收矩阵）

> 依据：用户 2026-10-04 口述 multica 实际功能清单（权威来源；本地 multica 仓库只有 daemon/协议
> 调研报告，无前端源码——此前的吸收只做了**面级**对照，未到字段级，是流程缺陷，本文补上）。
> 用途：智能体页打磨（台账第 52 轮起的三刀）的**规格边界**；逐格给出「我们已有什么 / 缺什么 /
> 吸收判定」，实现轮次开工前先补齐「待用户确认」格。

## 0. 前置裁定（用户 2026-10-04 再次确认，与 spec C3 一致）

- 小队的协作智能体（TeamAgent）与原有子智能体（subagent）**是两种东西**，必须分隔开，
  **特别是配置文件存储**：TeamAgent 落 `<workspace>/.zcode/squad/agents/`，
  subagent 落 `<workspace>/.zcode/agents/`，互不读写。
- 每个协作智能体都是**独立个体**，不是任何人的「子」：不共享 subagent 的定义/设置/生命周期；
  与 subagent 的唯一接触是 `prefillFrom` 一次性预填（provenance 留痕，此后无引用）。
- 允许**复用工具性常量/组件**（如 SUBAGENT_COLORS 调色板、ModelSelection 校验）——
  复用工具 ≠ 共享身份/存储；越线的判据：TeamAgent 的任何读写路径出现 `.zcode/agents`
  或 subagent 的设置分区。

## 1. 逐格对照矩阵

| #   | multica 的格（用户口述）      | 我们的数据/服务层                                                                     | 我们的 UI 现状                                                                         | 吸收判定                                                                                          | 状态                   |
| --- | ----------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------- |
| 1   | 指令（systemPrompt）          | `systemPrompt`（schema 必填）                                                         | 表单可编辑                                                                             | 已吸收                                                                                            | ✅                     |
| 2   | skill                         | `skills[]`（schema 有 default []）                                                    | **不可见、不可编辑**                                                                   | 吸收：表单技能选择 + 列表徽标                                                                     | 待实现（第③刀）        |
| 3   | MCP                           | 无对应字段                                                                            | 无                                                                                     | **待用户确认**：TeamAgent 是否需要 per-agent MCP 配置（涉及 host 层 MCP 挂载，超出小队域现状）    | ❓                     |
| 4   | 集成（integrations）          | 无（spec §13 PR 集成是批次级，不是 agent 级）                                         | 无                                                                                     | **待用户确认**：agent 级集成指什么（GitHub 账号绑定？webhook？）                                  | ❓                     |
| 5   | 工作任务表（该 agent 的任务） | `work_items.assignee={type:"agent"}` + `getSnapshot().workItems` 可过滤               | 智能体页**不显示**该 agent 的任务（工作项页有全局看板）                                | 吸收：agent 卡片/详情里给「指派给它的任务」列表                                                   | 待实现（需先定呈现位） |
| 6   | 智能体概览                    | `description` / `color` / `enabled`                                                   | 描述+色块+徽标（第 52 轮已上）；**选色/编辑描述不可**（第②刀）                         | 吸收                                                                                              | 第②刀                  |
| 7   | 运行数据（该 agent 跑过什么） | `squad_runs.agentId` + `listSquadRuns`（服务面已有，按 workspace）                    | 智能体页**不显示**该 agent 的 run 历史                                                 | 吸收：agent 维度的 run 计数/最近 run（数据已齐，纯 UI）                                           | 待实现                 |
| 8   | 设置的参数（模型等）          | `modelSelection` / `tools[]` / `disallowedTools[]` / `permissionMode` / `memoryScope` | 列表有模型徽标（第 52 轮）；**编辑白名单只有 3 字段**（name/systemPrompt/memoryScope） | 吸收：编辑白名单扩 `description`/`color`/`modelSelection`（第②刀）；tools/permissionMode（第③刀） | 第②③刀                 |

## 1.1 「一 agent 一 CLI」的核对（用户 2026-10-04 两轮问答，已证实并精确化）

用户先问「multica 是不是一个智能体用一个 CLI、每个 CLI 相对隔离」，再补充「**同一个 CLI
也能建多个智能体**」——两点都对，合成准确表述：

- **runtime（CLI）是 daemon 机器级注册的执行引擎**：每个 CLI 一个 profile
  （`multica runtime profile create`），二进制含 `agent.(*XBackend).Execute` ×24、
  支持清单 26 种；
- **agent 是定义层个体**：创建时选（名字/提供商/）runtime + 模型，日志实证
  `picked chat task agent=Mika provider=omp` —— agent 名（Mika）与 runtime 名（omp）
  是**两个独立字段**，多个 agent 可绑定同一个 runtime；
- **绑定是多对一**：隔离不靠「独占 CLI」，靠每 agent 独立定义 + 每任务独立 worktree +
  daemon 统一管会话文件（`~/.multica/pi-sessions/` + 任务级 `mat_` 令牌）。

**我们的模型与此同构（用户补充后差异进一步收窄）**：ZPaPa = 所有 agent 绑定**唯一的
ZCode CLI runtime**，独立性同样靠定义文件（`.zcode/squad/agents/`）+ `modelSelection`
（每 agent 可不同模型）+ 独立记忆 + 独立工作树。与 multica 的差别只剩「可选 runtime 的
数量（26 vs 1）」，而这是既定裁定（不做多 CLI 平台）。矩阵 #8 的「设置参数」因此**不含
runtime/CLI 选择**维度；后续轮次不得把「不能选 CLI」当缺失功能补进来。

## 1.2 实地取证：本机 Multica.app 前端 bundle 里的智能体设计（2026-10-04，用户指引）

> 来源：`/Applications/Multica.app` 的 renderer bundle（asar 解包，Zod schema + i18n 键表 +
> 路由树实证）。这是**实地版**，取代此前仅凭调研报告转述的部分。凭据（daemon token 等）不入文档。

### multica 智能体的完整设计（实地）

**定义字段全集**（`StoredAgentDraftSchema`）：`name` / `description` / `instructions`（指令）/
`conversation_starters[]`（开场白 label+prompt）/ `avatar_url`（头像上传）/ `model` /
`thinking_level` / `service_tier`（速度档）/ `skill_ids[]` / `permission_scope`
（private|workspace|members）/ `member_ids[]` / `team_ids[]`。

**详情页结构**（i18n `inspector.*` 键表）：

- Profile：头像（可换）/ 名字（重命名）/ 描述；
- Execution：**Runtime 选择器**（online/offline 状态、owned by）· Model（Default /
  Managed by runtime / 搜索或直输 model ID / **动态发现**）· Thinking · Speed ·
  **Concurrency（每 agent 最大并发 run 数，滑杆 min–max）**；
- Access：可见性；Properties / Details（Owner/Created/Updated 只读生命周期）；
- Skills：**挂 workspace 级技能库**（Attach a workspace skill）；
- Integrations 分区。
- Overview 含「Runs need attention」（runtime 不可用时排队 run 计数）。

**任务/运行数据**（`AgentTaskSchema`，比我们的 squad_runs 多出的列）：`priority` /
`attempt` / `parent_task_id` / `failure_reason` / `autopilot_run_id`；分页（nextCursor）。
另有仪表盘聚合（agent_id / total_seconds / task_count / metered_task_count）。

**生命周期**：archive 后**可 Restore**（非终态）；runtime 缺失时「保留配置与历史，绑
runtime 才能跑」横幅；DM 私聊入口 + Assign work 直接指派。

**创建方式两条**（路由树）：`agents/new/manual`（手动表单）与 `agents/new/ai`（**AI 对话式
AgentBuilder**，含草稿持久化 + 中途切换 runtime；另有内置「Chief of Staff」agent Mika）。

**MCP / 集成的实际形态**（修正矩阵 #3 #4）：

- MCP 是 **workspace 级** `mcp_config`（对话框带名字/JSON 校验），任务启动时按任务开关传入
  （daemon 日志 E4 `mcp_config=false`）——**不是 per-agent 独立 MCP 定义**；
- 集成 = workspace 设置里的 composio/apps 连接管理（feature flag `composio_mcp_apps` 控制），
  agent 侧只有 Integrations 呈现分区。

**唤醒规则**（`IssueWakeupSchema`，与我们 WakeRule 同构）：agent_id + instruction +
kind（event/at/every/cron）+ mode（once/continuous）。

### 对矩阵 #1–#8 的修正与新格

| 格          | 修正/结论                                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #3 MCP      | 语义已清：workspace 级配置 + 任务级开关 ⇒ 对应到我们 = workspace 的 MCP 设置（已有），agent 页只需呈现；**不做 per-agent MCP**                                                                         |
| #4 集成     | 语义已清：外部服务连接（composio 一类，workspace 级）⇒ 我们暂无此层，**不吸收**（登记为远期）                                                                                                          |
| #8 设置参数 | 新增发现：**Concurrency（每 agent 最大并发 run 数）**我们完全没有——多队员同时派发时的防失控手段，值得吸收（需裁定默认值与上限）                                                                        |
| 新格        | **archive 可 Restore**：multica 归档可恢复；我们是终态不可逆——差异真实存在，是否补「恢复」待用户裁定                                                                                                   |
| 新格        | **AI 对话式创建**（AgentBuilder）：先登记待定，不建议本阶段吸收（依赖聊天面）                                                                                                                          |
| 新格        | conversation_starters / avatar 上传 / permission_scope：与我们聊天复用、九色板、协作域权限占位的既有取舍不同，**按既有裁定不吸收**（permission_scope 与协作域 canView/canInvoke 预留同向，实现时对齐） |

## 2. 实现次序（沿台账第 52 轮的三刀，并入本矩阵；§1.2 实地取证后修订）

1. **第②刀（编辑能力）**：矩阵 #6 #8 的可编辑半边——表单扩 description / color 选色器 /
   modelSelection（复用现成模型选择组件）；服务面 `TeamAgentEditablePatch` 白名单扩展（TDD 先行）。
2. **第③刀（高级字段）**：矩阵 #2 skills、#8 的 tools/permissionMode。
3. **agent 维度任务/运行数据（#5 #7）**：数据层已齐，纯呈现；呈现位（卡片内展开 vs 详情页）待定。
4. **§1.2 已清语义的格**：#3 MCP（呈现 workspace 级配置即可）、#4 集成（不吸收，远期）——不再等确认。
5. **新增待裁定格**：#8 的 Concurrency（每 agent 最大并发 run，建议吸收）、archive 可 Restore
   （建议吸收，破坏「归档即终态」的既有取舍需用户点头）——实现排入第②③刀之后。

## 3. 纪律

- 每格实现前确认「待用户确认」标记已消除；拿不准的回到本文登记，不猜。
- 与 subagent 的隔离（§0）是**硬边界**：任何实现轮次违反即回退，不将就。

## 1.3 源码级对照（multica-ai/multica@b4ca5b4，2026-10-04 clone）

> 用户指引直接读源码。浅克隆 `github.com/multica-ai/multica`，读 `server/migrations/`（agent 表
> 001 建表 + 75 个 ALTER）、`server/pkg/db/generated/agent.sql.go`（UpdateAgentParams）、
> `server/internal/service/task.go`（ClaimTask）、`server/internal/handler/mcp_overlay.go`。

**agent 表可编辑字段全集**（`UpdateAgentParams`，sqlc 生成，源码级权威）：Name / Description /
AvatarUrl / RuntimeConfig·RuntimeMode·RuntimeID（三件） / Visibility / **PermissionMode** /
Status / **MaxConcurrentTasks** / Instructions / **CustomEnv** / **CustomArgs** / **McpConfig** /
Model / ThinkingLevel / ServiceTier / **ConversationStarters** / **ComposioToolkitAllowlist**。

**对 §1.2（bundle 推断）的三处源码修正**：

1. **MCP 是 per-agent 的**：`agent.mcp_config` 是真实列（Claude 风格 `{"mcpServers":…}`），
   且任务领取时 `mergeMCPOverlay` 把**每任务 overlay** 叠加在 agent 配置上（mcp_overlay.go）。
   §1.2 「不做 per-agent MCP」的结论**作废**，该格重回待裁定。
2. **集成的 agent 侧形态 = `ComposioToolkitAllowlist`**（agent 级 composio 工具白名单）+
   workspace 级 composio 连接——依赖 composio 生态，维持不吸收（远期）。
3. **Concurrency 生效层 = 服务端派发闸**：`ClaimTask` 的 SQL 原子领取按 `max_concurrent_tasks`
   限流（task.go:3488，含 runtime 作用域），**默认 6**（migration 023）。非 UI 摆设。

**源码新增待裁定格**：`CustomEnv`（每 agent 自定义环境变量）/ `CustomArgs`（每 agent 自定义
CLI 参数）——我们完全没有；派发链路要透传，吸收需动 host 侧，成本高于 UI 字段。

## 4. 用户逐项裁定（2026-10-04，七格全部定案）

| #   | 格                                   | 裁定                                                                        |
| --- | ------------------------------------ | --------------------------------------------------------------------------- |
| 1   | Concurrency（每 agent 最大并发 run） | **要**：字段 + 服务层派发闸（完整吸收，默认值实现时定）                     |
| 2   | 归档可恢复（Restore）                | **要**：归档从终态改为可逆（智能体与小队同口径；定义与记忆本就保留）        |
| 3   | CustomEnv / CustomArgs               | **缓**：等真实场景（动派发链路透传，成本高）                                |
| 4   | per-agent MCP                        | **要**：agent 级独立 MCP 配置；涉及 host 层挂载合并，**实现前先出设计细节** |
| 5   | AI 对话式创建（AgentBuilder）        | **要**：依赖聊天面，排期靠后，方向定了                                      |
| 6   | 任务表呈现位                         | **独立详情页**（同 multica agents/:id 形态，新增路由）                      |
| 7   | 运行数据呈现位                       | **进详情页**（与任务表同页分区/页签）                                       |

**裁定后的实现次序（取代 §2 中被影响的部分）**：

1. 第②刀（不变）：表单扩 description / color 选色器 / modelSelection + 服务面编辑白名单（TDD）。
2. 第③刀（不变）：skills / tools / permissionMode 编辑。
3. **第④刀（新）**：agent 独立详情页——概览 + 任务表（#6）+ 运行数据（#7）三区一体；含路由与导航接线。
4. **第⑤刀（新）**：Concurrency 字段 + 派发闸（服务层）；归档可恢复（服务层 restore + UI 入口，含确认文案从「不可撤销」改「可恢复」）。
5. **远期（新）**：per-agent MCP（先设计后实现）、AI 对话式创建（依赖聊天面）。
6. **缓**：CustomEnv / CustomArgs（等场景触发）。

## 5. Chat 会话挂载（用户 2026-10-04 问，核既定裁定 + multica 源码）

**问**：multica 的聊天会话在我们这边怎么挂载，还是左侧项目下的会话级吗？

**答：维持项目（工作区）下的会话级**——IA 计划 §七既有裁定（2026-10-03 用户确认），本轮用
multica 源码复核不推翻：multica 的 Chat 是 workspace 级一级双栏面（左线程列表+右会话，
`?session`/`?agent` 双深链），但它的 workspace 是云端多机聚合概念；我们的 workspace = 本地
目录，且 run=会话（壳全复用）、执行上下文绑定项目（队员会话更在各自工作树里）——项目级
挂载与执行一致，不另造 Chat tab。

**吸收一个小形态**：agent 详情页 DM 直通（multica `?agent=<id>` 一次性深链）⇒ 第④刀详情页
加「发起会话」入口：落到该项目会话列表并新建会话，与 §七「头像簇穿透」同一条路。

**队员会话可见性（用户 2026-10-04 裁定：维持穿透）**：队员会话不进左侧项目会话列表
（workspacePath=工作树路径，列表按项目过滤——工作树隔离的语义结果），可见路径 = 三个穿透点
（①会话面板头像簇（第 45 轮已做）；②看板/时间线 run 条目（C11）；③agent 详情页运行区（第④刀））。
队长会话天然在列表（workspacePath=项目路径）。
