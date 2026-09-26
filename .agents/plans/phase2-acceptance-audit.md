# 第 2 期验收审计报告

审计时间：2026-09-26 13:25
审计方式：跨机端到端脚本（真实 SSH + 常驻主机，不依赖 UI 点击）

## 用户需求与证据对照

| # | 需求（用户原话） | 状态 | 证据 |
|---|---|---|---|
| ① | 「A 加 B 的项目后，直接展示 B 端 UI 能看到的全部会话，已归档的不用再看」 | ✅ **通过** | `e2e-remote-visibility.ts`：A 侧 timeline 查询返回 B 的会话（实测 5 条 = 原 4 条 + 测试新建 1 条）；对照实验证明不带 identity 时 0 条。归档会话由 `matchesTaskListMembershipKind(kind=timeline)` 排除（21 条归档不在结果内）。连跑 3 次稳定。 |
| ② | 「A 可以操作/继续 B 显示的所有会话」 | ⚠️ **部分验证** | `resumeTask`（带 workspaceIdentity）**成功**，`sendPrompt`（provider-qualified modelSelection）**被对端接受无报错**。但脚本实测 prompt **未写入 B 的 CLI 数据库**（最新消息仍是 00:42，探针时间 13:2x），会话状态也未变 running → **"被接受"≠"已执行"**，尚未达成可验证的续接闭环。 |
| ③ | 「A 新建的会话，B 端 UI 也要显示」 | ✅ **通过** | `e2e-remote-create-session.ts`：baseline B 4 条 → A 侧 createTask → B 变 5 条，新会话确认出现在 B 列表。 |
| ④ | 「B 点开会话就能看到 AI 的输出流」（不需要自动弹出） | ✅ **通过**（结构验证） | B 本地该会话有 593 条 assistant 消息 + 2792 个内容片段，输出流已完整持久化在 B 本地；B 的 UI 读本地库，与 A 是否连接无关。 |

## 需求②未通过的判断依据

脚本时序（`e2e-remote-continue-session.ts`）：

1. `resumeTask({taskId, workspacePath, workspaceIdentity})` → ✅ 返回 success
2. `sendPrompt({taskId, modelSelection: {providerId, modelId}, workspaceIdentity})` → ✅ 无异常
3. 轮询 30s：会话状态始终 `completed`，未进 running
4. **决定性证据**：B 的 `~/.zcode/cli/db/db.sqlite` 中该会话最新消息时间仍是 `00:42:16`，而探针执行于 `13:2x` → **消息未落库**

推测原因（待验证）：轻量客户端只走 RPC，缺少真实 UI 链路里的前置步骤 —— provider/session 绑定、草稿态提交、订阅建立等。产品里"点开会话→订阅→冷恢复→发消息"是一个多步序列，`sendPrompt` 单独调用不等价。

## 需求②排查所需的已知约束（本轮实测得出）

- 直接 `sendPrompt` 会 `proto.sessionNotFound`（会话在 tasks-index 与 CLI 库中存在，但未在 CLI 运行时）→ 必须先 `resumeTask`
- `sendPrompt` 要求 **provider-qualified** `modelSelection`（`{providerId, modelId}`），否则报 `Session model must be provider-qualified`
- 远程 `resumeTask`/`sendPrompt` 均需 `workspaceIdentity`（Workspace Identity 约束）
- 远端 Agent 会请求 runtime preferences，轻量客户端必须应答，结构与 host bridge 一致：
  `status: "resolved"` + 全部必需字段（`askUserQuestionAutoResolutionEnabled`、`nativeSearchEnhancementsEnabled`、`memoryEnabled`、`modelContextBudgetStrategy: "preflight-v1"`）

## 需求①的三层根因修复（已交付）

| 提交 | 内容 |
|---|---|
| `60d1b9e` | 远程 session 查询改用对端自己的键（不再透传本端 `remote:` identity） |
| `4658cd2` | 会话列表组件（Timeline/Pinned）纳入远程项目 tab（此前被 `isLocalWorkspaceScopes` 滤掉） |
| `cd89dd5` | 双层测试锁契约（host 层 + UI 层） |
| `d5b0eea` | 跨机 e2e 可见性脚本 |
| `68547d8` | 跨机 e2e 建会话脚本 |
| `fbcab70` | 跨机续接脚本（含未通过结论） |

## 待办

1. **需求②续接闭环**：定位 `sendPrompt` 被接受但未执行的原因（需复刻真实 UI 链路的前置步骤，或改用 UI 层验证）
2. **远程连接持久化**：实测 `setting.json` 的 `lastWorkspaceSession` 无 remote 条目，重启后远程 tab 不恢复
3. 第 3 期：模型/供应商配置显式方向同步（A→B / B→A / 不同步）
