# 第 2 期：远程会话双向可见（A 连 B 后两端同库）

## 需求（用户确认）

A 通过 SSH「远程项目」连 B 的某个项目目录后：

1. **A 加 B 的项目后，直接展示 B 端全部会话**（已归档不显示）
2. **A 可以操作/继续 B 显示的所有会话**（不只查看）
3. **A 新建的会话，B 端 UI 也要显示**
4. **B 点开会话就能看到 AI 输出流**

展示方式：**直接并入 A 的会话列表**（与本地会话同样呈现）。

核心诉求（用户原话）：**"这样是否满足我不在 A 端的时候，在 B 端上继续操作会话。"**

## 边界（用户明确，不得扩张）

- ❌ 不做"互相看对方所有项目"；作用域严格限定在**被连接的那个项目**
- ❌ 不显示 A 的输入框/打字状态
- ❌ 不改 SSH 连接语义（原语义就是"连接对方的项目库"）

## 已确认事实（实测，带证据）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 远程 workspace 的 taskService 就是 **B 端服务**（经 RPC 代理），A 建会话索引天然写在 B | `remoteWorkspaceServiceCollection.ts:197,331` |
| 2 | A 挂载 B 后 `listTasks({workspacePath})` → **8 条**；加 `workspaceIdentity: remote:ssh:...` → **0 条** | 实测 `probe-key-match.mjs` |
| 3 | B 的 `tasks-index.sqlite` 中该项目 26 条会话：`workspace_key` = 纯路径、`workspace_identity` = NULL，8 条未归档 | B 库直查 |
| 4 | 键解析：`resolveWorkspaceKey = identity?.trim() \|\| path`（**identity 优先**） | `packages/shared/src/task-realtime-core.ts:82` |
| 5 | **混合键共存**：B 本地历史会话用纯路径键；A 远程建的会话带 identity 键 | 事实 3 + A 库 `remote:ssh:` 记录 |
| 6 | A 侧 `useLocalWorkspaceScopes` 的 `isLocalWorkspaceTab` 要求 `!remoteSessionId && !remoteTarget && !workspaceIdentity` **三者全空**，远程 tab 被完全排除 | `packages/ui/src/hooks/useLocalWorkspaceScopes.ts:5` |
| 7 | **架构约束**：远程必须传 workspaceIdentity（身份隔离） | `paneLayoutTree.ts:40`、`AGENTS.md` Workspace Identity 节 |

## 结论：真正要解决的问题

**不是数据通路，是 A 侧 UI 不查询远程项目的会话。**

- 需求 ①：数据在 B、A 能查到（事实 2），但 A 的列表不查（事实 6）→ **需改 UI scope**
- 需求 ②：远程 taskService 就是 B 的（事实 1）→ 点开续接天然可行
- 需求 ③：索引写在 B（事实 1），键取决于传入 identity（事实 3/4）→ **需保证建会话时的键 == B 的本地键形态**
- 需求 ④：输出流在 B 的 CLI 库，B 本地读自己的会话 → **天然满足**

## 方案

### 改动 ①：A 侧会话列表纳入远程 tab
- `packages/ui/src/hooks/useLocalWorkspaceScopes.ts`：新增可选参数（如 `includeRemoteTabs`），允许远程 tab 通过。
- 调用点：`useGroupedTaskView.ts:590`（会话列表）、`WorkspaceTimelineTasksSection.tsx:69`、`WorkspacePinnedTasksSection.tsx:75`。
- 风险：`useAutomationProjectOptions.ts:69` 也在用，**automation 项目下拉不应纳入远程**（保持原语义）。

### 改动 ②：远程 tab 的查询 scope 用「项目路径」而不是 remote identity
- `useGroupedTaskView.ts:98 buildWorkspaceScopes`：对远程 tab 传 `{workspacePath: <B项目路径>, workspaceIdentity: undefined}`。
- 依据：事实 2（带 identity 查 0 条、纯路径查 8 条）。
- **不违反架构约束**：identity 仍用于身份隔离与 RPC 路由；只在"查 B 库的会话列表"这一步匹配 B 的存储形态（B 库里就是纯路径键）。
- ⚠️ **需验证**：host 侧 `resolveSource`（`packages/desktop/src/host/index.ts:1815`）对"无 identity 的 scope"会落到 **A 的本地 taskService**（查 A 自己的库，不是 B）。因此必须同时让 host 能识别"这是已连接的远程项目路径" → 走 `windowRemoteConnectionRegistry.findSessionForWorkspace`。这是本方案**最关键的实现点**。

### 改动 ③：归档不展示
- 会话列表查询默认已过滤 `deleted`，需确认 `archived` 的默认行为并显式排除。

## 分步实施与验证

1. **先验证 ② 的前提**：host `resolveSource` 能否凭路径命中远程 session（若 `findSessionForWorkspace` 按 workspaceKey 匹配，则无 identity 的 scope 命中不了）→ 可能需要 host 侧新增"按项目路径匹配远程 session"的分支。
2. 改 ① + ②，本地会话回归验证（必须与改动前一致）。
3. 跨机实测：
   - A 连 B 的项目 → A 列表出现 B 的 8 条未归档会话
   - A 点开其中一条 → 能继续对话（在 B 上执行）
   - A 新建会话 → B 刷新可见、B 点开看到输出流
   - A 关闭 → B 独立操作会话（**回答核心诉求**）

## 风险与回退

- **风险**：`workspaceIdentity` 在 20+ 处使用（syncer、store、pane 等），改 scope 键可能影响归属判断。
- **缓解**：只在查询 scope 构造处改，不动写入侧 identity；本地路径回归测试。
- **回退**：改动集中在 UI scope 构造 + 可能一处 host 分支，可独立回滚。

## 待确认（需实验）

- `findSessionForWorkspace` 的匹配逻辑（按 key 还是按路径）→ 决定改动 ② 是否需要 host 侧配套。
- `archived` 默认过滤行为。
