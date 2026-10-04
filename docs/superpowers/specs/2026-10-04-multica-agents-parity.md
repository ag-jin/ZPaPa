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

| # | multica 的格（用户口述） | 我们的数据/服务层 | 我们的 UI 现状 | 吸收判定 | 状态 |
|---|---|---|---|---|---|
| 1 | 指令（systemPrompt） | `systemPrompt`（schema 必填） | 表单可编辑 | 已吸收 | ✅ |
| 2 | skill | `skills[]`（schema 有 default []） | **不可见、不可编辑** | 吸收：表单技能选择 + 列表徽标 | 待实现（第③刀） |
| 3 | MCP | 无对应字段 | 无 | **待用户确认**：TeamAgent 是否需要 per-agent MCP 配置（涉及 host 层 MCP 挂载，超出小队域现状） | ❓ |
| 4 | 集成（integrations） | 无（spec §13 PR 集成是批次级，不是 agent 级） | 无 | **待用户确认**：agent 级集成指什么（GitHub 账号绑定？webhook？） | ❓ |
| 5 | 工作任务表（该 agent 的任务） | `work_items.assignee={type:"agent"}` + `getSnapshot().workItems` 可过滤 | 智能体页**不显示**该 agent 的任务（工作项页有全局看板） | 吸收：agent 卡片/详情里给「指派给它的任务」列表 | 待实现（需先定呈现位） |
| 6 | 智能体概览 | `description` / `color` / `enabled` | 描述+色块+徽标（第 52 轮已上）；**选色/编辑描述不可**（第②刀） | 吸收 | 第②刀 |
| 7 | 运行数据（该 agent 跑过什么） | `squad_runs.agentId` + `listSquadRuns`（服务面已有，按 workspace） | 智能体页**不显示**该 agent 的 run 历史 | 吸收：agent 维度的 run 计数/最近 run（数据已齐，纯 UI） | 待实现 |
| 8 | 设置的参数（模型等） | `modelSelection` / `tools[]` / `disallowedTools[]` / `permissionMode` / `memoryScope` | 列表有模型徽标（第 52 轮）；**编辑白名单只有 3 字段**（name/systemPrompt/memoryScope） | 吸收：编辑白名单扩 `description`/`color`/`modelSelection`（第②刀）；tools/permissionMode（第③刀） | 第②③刀 |

## 2. 实现次序（沿台账第 52 轮的三刀，并入本矩阵）

1. **第②刀（编辑能力）**：矩阵 #6 #8 的可编辑半边——表单扩 description / color 选色器 /
   modelSelection（复用现成模型选择组件）；服务面 `TeamAgentEditablePatch` 白名单扩展（TDD 先行）。
2. **第③刀（高级字段）**：矩阵 #2 skills、#8 的 tools/permissionMode。
3. **agent 维度任务/运行数据（#5 #7）**：数据层已齐，纯呈现；呈现位（卡片内展开 vs 详情页）待定。
4. **#3 MCP / #4 集成**：**不开工**，先由用户确认语义与边界（可能涉及 host 层，不只是 UI）。

## 3. 纪律

- 每格实现前确认「待用户确认」标记已消除；拿不准的回到本文登记，不猜。
- 与 subagent 的隔离（§0）是**硬边界**：任何实现轮次违反即回退，不将就。
