# 多智能体小队（借鉴 multica）调研与可行性核验

> 状态：**调研 + 可行性核验，尚未写任何代码**。
> 日期：2026-10-01
> 结论速览：**总体可行，且大部分底座仓库里已有**——真正要新建的只有两块（worktree 隔离的实现、审查后合并的闭环）。

---

## 0. 一句话

用户的目标不是「把 multica 搬过来」，而是：**用多个 agent 交叉验证，即使同一个模型，也比单 agent 更容易发现问题**。squad、排班、互通都只是手段。而且这是**实验**：另起一套机制、与旧功能并存、随时能关掉，**不替换**现有 subagent / automation。

用户提出的具体形态：

1. 智能体是**独立的**，调用**我们自己的 CLI**；
2. 可配多个智能体，各配信息、**各用不同模型**；
3. **小队之内依旧可以讨论**，由**队长协调**；
4. 每个队员执行时用**独立工作树**，审查完才合并，**合并完就抛弃**；
5. 每个智能体有**自己的记忆、自己的配置文件夹**，独立起来。

---

## 1. multica 是什么（机制总览）

### 1.1 分层与执行模型

Web(Next.js) / 桌面(Electron) / 手机(Expo) → Go 后端(Chi + sqlc + WebSocket) → Postgres 17。**真正执行 code 的是用户本机的一个 daemon**：它探测机器上的 26 种 agent CLI（Claude Code、Codex、Cursor…），把每个注册成一个 runtime，被派活时 spawn 它们——server 自己从不跑模型。它的一层身份是「调度 + 记录」，执行外包给 daemon。

### 1.2 核心抽象

`Workspace → Project → Issue → 指派对象(member|agent|squad) → Runtime → Run`，旁边挂着 Chat、Inbox、Skills、Autopilots、Squads。最关键：**Issue 是工作单元，Run 是执行单元**，两者分开。

### 1.3 小队 Squad

表结构极简，就两张：

| 表             | 关键列                                                                    |
| -------------- | ------------------------------------------------------------------------- |
| `squad`        | `leader_id → agent(id) ON DELETE RESTRICT`、`instructions`、`archived_at` |
| `squad_member` | `member_type('agent'\|'member')`、`member_id`、`role`                     |

队长**必须是一个 agent**，创建时自动作为成员写入 `role="leader"`。更重要的是 `issue.assignee_type ∈ ('member','agent','squad')`——**任务可以直接指派给整个小队**。指派给小队的语义是：解析出 `leader_id`，给队长排一次打了 `is_leader_task + squad_id` 标记的「队长角色 run」，并注入包含操作协议 + 花名册 + 指令的 briefing。**队长不是常驻进程，是一个会被唤醒的角色。**

### 1.4 编排引擎：Issue Wakeups（核心）

文档原话：

> **「没有睡着的进程，也没有第二套 run 生命周期。」**

机制是：在 issue 上挂一条规则 `issue_wakeup`，调度器每 ~30 秒 tick 一次捞出 ready 的规则，产生一次**普通 run**。规则四种 `kind`：`event`（订阅事实）/ `at`（一次性）/ `every`（间隔）/ `cron`，配 `once|continuous` 模式，外加可选 `condition`。条件四类：`issue_field`、`children_done`、`pull_request`、`other_issue`，靠 fingerprint 去重。

**队长就是这样被唤醒的**：`children_done` 条件触发时，解析父 issue 的指派对象——单个 agent 就给他一次 run；**是 squad 就给 leader 一次 leader-role run**；是人就只发一条 inbox 通知。

工程讲究在幂等与并发：所有写路径走 workspace→issue→rule 固定加锁序，`SET LOCAL lock_timeout='50ms'`、每规则 2s 预算，用 `revision` 做 fencing，**receipt 消费与建 run 必须同事务**。

**防失控是硬规则，不靠 prompt 自觉**：

- `max_fires`：连续规则默认上限 **20**；
- 暂停原因三种：`max_fires`、`loop`（一条 run 链两次经过同一规则，链长上限 32）、`rate`（**1 小时 12 次**）；
- 重复触发 **merge** 成一次 run（receipt 唯一键 `(wakeup_id, revision, event_key)`）；
- **自我承认短路**：输入全来自目标 agent 自己 → 只消费不启动。

还有 expires（`expires_at` vs `expires_in_seconds`，后者重新启用会重置计时）与 `on_timeout = wake|end`。

### 1.5 排班是**另一个**机制

Autopilot（cron 自动化）和 wakeup **是两套独立实现**，各跑各的 job，互不复用。三张表 `autopilot` / `autopilot_trigger` / `autopilot_run`；触发方式 `schedule|webhook|api`；autopilot 也能指派给 squad。三个值得抄的细节：

- **`skipped` 与 `failed` 必须分开**——skipped 是「非失败终态」，复用 failed 会污染失败率信号，导致自动 pause 误判；
- 准入区分 **fail-open**（瞬时 DB 错永不吞排班）与 **fail-closed**（对象不存在/已归档才硬 skip）；
- 配额用 **reservation（预留→消费/释放）+ 终态 CAS settle + 独立 reconciler**，不是裸计数。

### 1.6 执行侧 daemon 协议

持久 `daemon_id`（uuidv7，机器级，写 `~/.multica/daemon.id`）+ 上报 legacy ids 供服务端合并旧记录；WS 唤醒 + 批量 claim（WS 优先、HTTP 兜底）+ 30s 兜底轮询 + **3 分钟 WS claim 轮询并向下抖动**（避免机群同步）；15s 心跳。每个任务隔离 workspace（git 用共享裸库派生 worktree）+ 注入 `TMPDIR` + 任务级 `mat_` 令牌；`--max-concurrent-tasks` 默认 20，**slot-before-claim**；流式回传带**单调 Seq**。取消靠状态轮询（5s）+ 重连补查。steering（回复注入当前 run）按 CLI 最低版本 gate，且 **fail-closed**。

### 1.7 交互层与 feature flag

侧栏 13 个一级入口，分四组（个人 / 工作 / AI 团队 / 工具）。看板按 status/assignee/project 分组，任务指派人三态用头像区分。建小队是个 modal：选一个 leader + 多选 members。**「落在 review 而不是 main」落地为 `in_review` 状态 + 人工检查点，不是 git 硬门**。Inbox 只在**需要人决策**时推送。

Feature flag：定义在 `server/internal/featureflags/keys.go`，规则顺序 deny>allow>percent>default，UI 呈现是**隐藏入口、不加 badge**，而且**它当前没有独立的「实验功能」面板**（旧的 `labs` URL 早已折叠进 workspace）。

### 1.8 治理层

- **可见 ≠ 可运行**：`canAccessPrivateAgent`（能否看见）与 `canInvokeAgent`（能否触发）**分两个轴**，连 admin 也绕不过 Access。
- **A2A 按顶层人类发起者判决**：U 触发 A，A 再 @B，只有 U 在 B 的白名单里 B 才可被调起——防止 agent 互点形成绕白名单的通道。
- **review gate 与 run 成功解耦**：completed ≠ done，终态交给人或外部信号（PR merge）。
- Skills 是 `SKILL.md` 方法包，与 agent 多对多挂载，可单独停用、记住来源。
- Chat 与 issue 平行；**@agent = 触发一次运行，不是通知**。

### 1.9 状态体系：4 category / 7 键

multica 的 7 个状态**不是执行态，是「工作项(issue)的生命周期」态**，真正骨架是 **4 个 category**：

| category  | 内置键                              | 机械含义           |
| --------- | ----------------------------------- | ------------------ |
| unstarted | `backlog` `todo`                    | 未开始，可自由改派 |
| started   | `in_progress` `in_review` `blocked` | 进行中             |
| done      | `done`                              | 终态之一           |
| closed    | `cancelled`                         | 终态之一           |

**机器只读 category**（判终态、算 `children_done`、能不能挂规则），7 个键只是给人看的标签；自定义态靠加键、category 锁死（`is_system`）。

---

## 2. 我们的取舍原则

1. **只提供机制，不写死工作流**。「审查」不是我们要定下的机制——可以是审查智能体，也可以是别的智能体去检查。状态只给**槽位**，什么时候叫醒谁由**用户配的规则**决定。
2. **完整吸收，但只用自有 CLI** ⇒ **丢弃整条异构 CLI 适配层**（详见 §3.4）。
3. **实验性质**：另起机制、与旧功能并存、可整块关掉、**不替换**现有 subagent / automation。
4. **四红线**（决定「同模型多 agent 更易发现问题」能否成立）：
   - ① **上下文隔离**：审查者拿到产出物本身，不是作者的推理链；
   - ② **独立性**：汇总前互不可见，否则趋同成一个 agent；
   - ③ **视角差异**：对抗/正确性/边界/安全等 role，比复制同一 agent 三遍强；
   - ④ （加分）**能动手跑**的审查者更强。

---

## 3. 对 ZPaPa 的可行性核验

### 3.1 已经现成可复用

| 用户要求                         | 现有实现                                                                                                                              | 位置                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 智能体独立、调用自有 CLI         | 已是「一 agent 一目录」的定义；子 agent 跑成**子会话**                                                                                | `packages/services/src/subagents/subagentStorage.ts`；`subagentMarkdown.ts`                              |
| 每 agent 可配信息 / **不同模型** | `AgentSummary` 已有 `name/systemPrompt/modelSelection/tools/skills/permissionMode`；workflow agent 亦有 `model` 字段                  | `packages/shared/src/subagents-types.ts:43`；`contracts/src/workflow/script.ts`                          |
| **每 agent 独立持久记忆**        | `AgentMemoryScope = user\|project\|local`，写在 agent 的 `.md` frontmatter；根 `agent-memory/<key>/MEMORY.md`；自动补 Write/Edit 工具 | `apps/zcode-cli/packages/core/src/subagent/persistent-memory.ts`；`subagent/profile.ts:19,187`           |
| 多 agent 编排底座                | workflow：phases + agent activities，跑成子会话，带并发闸、activity 缓存、events/artifacts                                            | `apps/zcode-cli/packages/{contracts,dynamic-workflow*}/`、`bootstrap/src/app/script-workflow-runtime.ts` |
| 排班                             | automations（cron）+ off-peak                                                                                                         | `packages/services/src/session/automation*`、`offPeakTask*`                                              |
| 技能                             | skills 已有                                                                                                                           | `packages/services/src/skills/`                                                                          |
| 通知（inbox 原料）               | background-task-notifications                                                                                                         | `packages/shared/src/background-task-notifications.ts`                                                   |
| 渠道                             | bots 已有 feishu / telegram / weixin                                                                                                  | `packages/services/src/bots/`                                                                            |
| 实验开关落点                     | 设置页加分区有固定套路                                                                                                                | `settingsNavigation.ts` → `settingsPageConfig.ts` → `SettingsPage.tsx` → `validationAppSettings.ts`      |

### 3.2 需要新建

1. **`isolation: "worktree"` 的实现**。契约已声明（`contracts/src/workflow/script.ts:42`），但 `script-workflow-runtime.ts:282` 是 `throw new Error("... not implemented yet.")` —— **补实现，不是从零造**。
2. **「审查后合并」的闭环**：worktree 的建 / 合 / 删 + 孤儿清理。workflow 有 activity/artifact，但没有 merge 概念。
3. **一等「协作智能体」实体**：不能拿 subagent 当运行单元（见 §4.1）。
4. **小队实体**（leader + members）与**唤醒规则**（在现有 cron 旁加 event/条件两类）。
5. **小队讨论的路由层**：现有 SendMessage 是**父子树**，不是**多对多群**。
6. **一等 `Project` 实体**（本地 grep 无）、**Inbox**、**feature flag 分区**、**chat/mentions**。

### 3.3 需要修的缺陷

1. **记忆 key 用 agent 名**（`sanitizePersistentAgentMemoryKey`：非 `[a-zA-Z0-9_-]` → `-`）——**改名 = 丢记忆**，且两个不同名字可能 sanitize 成同一个 key 而撞车。应换成**稳定 id**。
2. **`project` scope 把记忆写进工作区**（`<ws>/.zcode/agent-memory/`）→ 需确认 gitignore / 扫描排除（同 `.worktree` 的坑）。

### 3.4 因为「只用自有 CLI」而可丢弃的部分

multica **最重、最脏**的一半在这里，且**存在的唯一理由就是适配外部 CLI**：

- daemon 探针 / `agent_runtime` + `runtime_profile` + `protocol_family` 白名单迁移；
- 26 种 CLI 的 `--version` 版本 gate；
- WS 唤醒 + claim 协议；
- `SupportsTaskSupplement` 按版本 fail-closed。

**自有 runtime ⇒ 只有一个 runtime**，全可丢弃。**要吸收的是「协作语义（领域模型 + 编排规则）」，不是它的「CLI 集线器」定位。**

反过来，自有 CLI 让我们更强：

- **steering 是原生能力**（已有 `CommandInbox` 串行 admission 接收 busy/running 输入，见 `AGENTS.md` 第 65 条），不需要版本 gate；
- 协议免协商；并发/隔离自控（复用 host/workspace，ADR 0003）；per-agent 模型已有。

### 3.5 关键约束与坑

1. **`.worktree/` 放项目根必须双排除**：加进 `.gitignore`（否则 `git status` 全脏、嵌套 `.git` 文件干扰「是否仓库」判定）**和扫描排除**（`wikiScan.ts:17-19` 是硬编码排除集 + `.zcodeignore`）。否则搜索/wiki/文件树/watcher 会去遍历 N 份副本。项目根放 dot 目录有先例：`WIKI_DIR_RELATIVE_PATH = ".wiki"`。
2. **同一分支不能挂两个 worktree**：`shared/src/git.ts:34` 已有 `branch-in-other-worktree` 错误码 → 每队员必须从同一 base 派生**各自独立的分支**。
3. **必须同 host**：worktree 与合并都是文件系统级的 → 一个小队所有成员必须跑在同一台 host（贴合 ADR 0003）。
4. **workflow 入口受灰度开关控制**：离线裁剪后「自动化 → 工作流」可能默认不可见（git log `2564652`）——用它前先确认本版可用，或走实验分区另开入口。
5. **孤儿 worktree 会占住分支**：不清干净 → 下次同分支再建会撞 `branch-in-other-worktree` → **清理是重派发的正确性前置**，需要 startup 时的残留 reconciler（对应 multica `043_fix_orphaned_autopilot_runs`）。

---

## 4. 设计草案

### 4.1 实体

**协作智能体（一等实体，不是 subagent）**

```
TeamAgent {
  id, name, description, color,
  systemPrompt, skills[], modelSelection,
  tools[] / disallowedTools[], permissionMode,
  memoryScope: user | project | local,   // 复用现有能力
  hostBinding?,                          // 绑哪台设备（决定能否被排班唤醒执行）
  enabled, provenance?
}
```

- **定义可复用现成格式**（`name/systemPrompt/modelSelection/tools/skills/permissionMode`），**但执行不能等于 subagent**：

| 维度                                              | subagent                                | 队友智能体               |
| ------------------------------------------------- | --------------------------------------- | ------------------------ |
| 身份                                              | 无稳定身份，一次性                      | 稳定 id，可被指派/唤醒/@ |
| 生命周期                                          | 绑父会话（`parentSessionId`），父亡子散 | 独立存活，跨会话延续     |
| 上下文                                            | 嵌套进父的编排                          | **必须隔离**             |
| 会话史                                            | 无独立历史                              | 有                       |
| 可被指派工作项 / 被规则唤醒 / 有 inbox / 能当队长 | 不能                                    | 能                       |

- **底层机制其实很近、语义相反**：ZPaPa 已有 child-session 底座（`parentSessionId` 授权链 + workflow 子会话）。**subagent 的 parent = 当前对话；队友 run 的 parent 应 = 工作项**。同一底座挂不同父。

**小队**

```
Squad { id, name, leaderAgentId, members: [{ agentId, role? }], enabled }
```

**工作项**：一等实体，`assignee ∈ (user | agent | squad)`，承载 §1.9 的生命周期。

**唤醒规则**：`{ kind: event|at|every|cron, mode, condition?, filters?, maxFires, ... }`——在现有 cron 自动化旁加 **event / 条件** 两类。

### 4.2 生命周期（4 category + 6 键）

建议键：`todo | in_progress | in_review | blocked | done | cancelled`。

- **借 category 骨架 + `in_review`/`blocked`**，不借 `backlog`/`todo` 的排队语义（ZPaPa 的 task 偏会话，一开即一次 run）。
- `in_review` = 交付后未验收的**独立停留点**（多 agent 互查的落点）；`blocked` = 卡住需介入的**显式态**（联动 inbox）。
- 现有三套 status（执行态 / 派发态 / automation 生命周期态）必须与这套**正交，绝不能合并**（见 `task_status 残留` 教训）。

**三条必须一起借的原则**：

1. **状态只描述生命周期、不驱动执行**（multica 原话：_"This is not a workflow engine"_）——绝不让「进入 in_review」自动 call 审查 agent。
2. **`completed` ≠ `done` ≠ `closed`** 三层分开——否则「run 成功」被当成「工作通过」，互查白做。
3. **聚合判定用 category 不用键名**（「等子任务全完成再唤醒队长」的判据是子项 category ∈ {done, closed}）。

### 4.3 一条完整流转

```
派单 → 建 worktree（派生独立分支）→ 队员执行 → 讨论/审查
     → 队长合并 → 抛弃 worktree（+ 删分支）→ 孤儿清理兜底
```

- **worktree 生命周期**：**执行期临时、合并完即抛**。准确规则是「活到该队员这次工作**被合并**为止」——
  **审查被拒时 must 存活到合并**，不能提前删。
- **合并串行**（一次一个），避免竞态；失败 → 留分支 + 进 inbox + 标 blocked。
- **清理必须保证**：success / reject / crash/abort 三条路径都要能回收，配 startup reconciler。
- **强制前置**：v1 **只支持全员同 host**。

### 4.4 记忆：私有 + 显式共享

- **每 agent 私有记忆**（现成能力）。
- **leader 默认不读成员私有记忆**；队员要说给队长听，得**主动汇报**进共享通道（工作项/讨论）。
- 这不是缺陷，正是**独立性红线的落实**——若 leader 能随便读成员记忆，就退化成「一个人自己想」。
- **agent home（配置+记忆）必须持久、且在 worktree 之外**：抛的是 worktree，不是 agent home。

### 4.5 防失控（必须与编排同期做）

`max_fires` 上限、`loop`/`rate` 暂停原因、同工作项重复触发 **merge 成一次 run**、自我承认短路。**不做的话队长会无限派单。**

### 4.6 权限

沿用 **可见 ≠ 可运行**两轴；A2A 按顶层人类发起者归因，agent 互点不能绕过允许名单。

---

## 5. 分期

| 期                | 内容                                                                                                    | 可独立关闭 |
| ----------------- | ------------------------------------------------------------------------------------------------------- | ---------- |
| **P0 机制底座**   | 工作项实体 + 4 category 生命周期（一处拥有、流转幂等）+ 实验分区开关 + 协作智能体实体（含 memoryScope） | ✅         |
| **P1 编排**       | 唤醒规则（event/条件）+ 防失控三件套 + 队长角色 run                                                     | ✅         |
| **P2 隔离与协作** | `isolation:"worktree"` 实现 + 建/合/抛+孤儿清理 + squad 配置 UI + 小队讨论路由 + Inbox                  | ✅         |
| **P3 排班与治理** | autopilot 指派到 squad、权限双轴、skills 挂载、board 可视化                                             | ✅         |

---

## 5.5 信息架构与 UI（落点已定）

**用户已定：不新增顶层 Tab / 菜单，长在会话窗口这一层。** ZPaPa 的「顶层」本就是标签页（设置、插件商店都是 tab），没有全局一级菜单栏。

- **入口**：会话窗口里一个「智能体」入口（header 上的头像簇 + 「N 在跑」），显示**本项目下工作的智能体**。
- **点开**：弹出智能体目录，列出队长/队员/审查者及其状态；点某一个 → 打开它的**独立会话**。
- **小队记录**：会话窗口下的记录流（谁派了什么、谁汇报了什么）。
- **复用**：`SubagentDirectorySidePane`（目录）+ `SubagentSessionSidePane`（独立会话）+ 会话里的 `onOpenSubagentSession` 打开链路——**同套 UI，换挂载的父**。
- **真差异点**：现有目录挂在「当前对话」下；我们要挂在「本项目 / 工作项」下，数据源从 `useSessionSubagents` 扩到「本项目的工作项成员会话」。
- **名册仍要有家**：智能体与小队的**定义**（跨项目资产，user scope）放「设置 ▸ 实验功能」；**运行与记录**才长在会话窗口下。
- **不做**：独立看板、左轨道一级菜单。
- **关键澄清（用户补充）**：「独立挂载在项目下的智能体会话」是**通用底座，不限于小队**——**单独安排的智能体**（不在小队里）也是这个形态。会话窗口点开的「本项目工作的智能体」**两类都列**，用**小队徽标**区分是不是队员，而不是分两个入口。**小队只是这个底座之上的一层协调**（队长/讨论/工作树隔离/审查后合并）。
- **推论**：「工作树隔离」应做成**每次运行的一个选项**而不是小队专属——单独安排的智能体直接在工作区改，**没有合并那一步**，也就没有工作树/孤儿清理问题。与 multica 一致：指派对象可以是 agent，也可以是 squad。
- 视觉预览：`.superpowers/brainstorm/*/content/squad-under-conversation.html`（会话窗口下的形态）、`squad-ui-overview.html`（完整三块）、`top-level-ia.html`（三种顶层落法对比）。

---

## 5.6 工作项归属与触发（已定）

**用户已定：工作安排既可由队长指定，也可由用户安排**（与 multica 一致）。核对 multica 后，实际是**三路输入**：

| 来源            | 形态                                                         |
| --------------- | ------------------------------------------------------------ |
| **用户**        | 指派负责人 / 把工作项派给整个小队 / `@` 某个智能体起一次运行 |
| **队长**        | leader-role run 里派单：显式 @队员、或建子工作项             |
| **规则 · 排班** | 条件满足（`children_done` 等）或 cron 到点                   |

**核心不是「几路」，而是「多路输入、一处写入」**：三路都**不直接改状态**，而是发出同一形状的**派发事件**；由**工作项状态机（唯一所有者）**消费并流转。这正是 AGENTS.md「避免重复状态和多条写入路径」的要求。

**三条必须保留的 multica 细节**：

1. **防失控只约束「非人发起」**：`max_fires` / `loop` / `rate` 只对规则型生效；用户手动「现在就跑」**豁免**。
2. **`@` 不等于指派**：触发一次运行，但**不改**负责人与状态（丢了这条，「谁负责」会漂）。
3. **终止条件写进指令**：系统不替队伍判断何时停，队长指令必须写清「派完即停 / 何时让位」。

**落到 ZPaPa**：唤醒规则表挂在**工作项**上；用户操作、队长 run、条件与 cron 都是它的事件来源；队长的派单产出的是**子工作项 / 派发事件**，而不是直接改父项状态。

---

## 5.7 覆盖度审计：12 项决策（已定）

对 6 路调研逐条比对后的缺口，用户逐条确认（原则：**按完整形态吸收，不以工作量为由削减**）：

| #   | 项                              | 决策                                                                                                                                         |
| --- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 父子任务树（子工作项）          | **完整父子树**：任意深度 + 分阶段（`stage:N` / `each_stage`）                                                                                |
| 2   | PR 关联 + review gate           | **完整 GitHub 集成**：自动关联、PR 快照、merge 驱动状态                                                                                      |
| 3   | 订阅者模型 + Inbox              | **完整**：订阅者表（reason 含 delegated）+ `opt_out_scope` + tombstone + 条目类型 + 严重级 + 只在需决策时推 + 父子冒泡 + 已读归档 + 渠道路由 |
| 4   | 工作项评论 / 活动时间线         | **完整**：评论可 @ 触发运行 + 连续评论合并成一次运行 + `/note` 抑制 + `@all` 不触发 + 内联评论                                               |
| 5   | 工作项元数据                    | **完整**：labels + 带类型的自定义属性 + 手工排序 + 工作项搜索索引 + 表情                                                                     |
| 6   | 工作项级交付物                  | **完整**：分类（计划/文档/实现/diff/预览/测试结果），挂在运行上可供审查                                                                      |
| 7   | 归档语义                        | **完整**：归档 agent → 派发 skip；归档小队 → 指派与排班**转移给队长**；保留历史、不可被唤醒                                                  |
| 8   | 单次 run 的重试/超时/看门狗     | **完整**：空闲看门狗 + 工具看门狗 + 墙钟超时 + 取消/中断 + 失败重试 + 熔断                                                                   |
| 9   | 成本/用量按 run 记账            | **完整**：每次 run 记 token/成本，按智能体/小队/工作项聚合展示                                                                               |
| 10  | Agent 的「AI 构建」向导         | **做**：手工配 or 描述一句让 AI 生成配置                                                                                                     |
| 11  | 渠道创建/触发工作项（`/issue`） | **不做**：渠道只到对话，不派活                                                                                                               |
| 12  | Chat 独立入口                   | **不做**：**ZPaPa 现有会话窗口已经是它**（不建工单即可直接问/派活），multica 的 Chat 在此冗余                                                |

**有意丢弃（已确认）**：异构 CLI 适配层、多租户治理（角色/席位/entitlement/计费/配额）、运维与遥测、multica 专属 flag（composio_mcp_apps / plugins_v1 / triage_v1 / local_search_index）、看板泳道（延后 P3）。

**ZPaPa 有而 multica 无（优势，别丢）**：闲时执行（off-peak）、workflow 子会话底座 + 因果图分析、离线无遥测、git checkpoint（按轮次快照/回滚）。

**审计依据**（已 grep 核实 ZPaPa 确无对应物）：父子任务树、GitHub PR 集成、工作项级 comment/activity、labels/自定义属性/排序/搜索索引。

---

## 5.8 收尾 5 项决策（已定）

原 §6 的 5 条待拍项，已逐条定案：

| #   | 项               | 决策                                                                                                                                                   |
| --- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A   | 合并目标         | **集成分支**：队员先合 `squad/<工作项>`，整批过了再一次性合回主分支（主分支干净、整批可整体放弃）                                                      |
| B   | 合并后分支       | **删除**（队员分支与集成分支都删）；留痕靠工作项交付物 / diff 记录，不靠分支                                                                           |
| C   | 编排地基         | **完全另起一套**：不基于 workflow 子系统；编排层自建（工作项 / 小队 / 唤醒规则 / 队长 / 合并）。边界：底下的「一次会话运行」仍用自有 CLI 运行时        |
| D   | 智能体定义来源   | **独立实体、自成一份定义**；新建时可从现有 agent **一键预填一次**，此后各自独立、**无持续引用**（对齐 multica：agent 本就是独立记录，无复制/引用概念） |
| E   | 是否绑 host/设备 | **不做多设备联动**，不绑 host，单机运行（「全员同 host」约束因此自动满足）                                                                             |

> 原 §6「待定」已清空，设计层面无遗留待决项。

## 5.9 已有功能与冲突梳理

### A. 仓库已有的相关功能（按「怎么用」分类）

| 现有能力                                                         | 与新功能的关系                                 | 位置                                                                                                            |
| ---------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 会话/任务窗口（shell、任务列表、Side Pane）                      | **承载面**：小队就长在这层                     | `app-shell/WorkspaceShellLayout.tsx`、`v4/V4ChatPane.tsx`                                                       |
| 子 agent 系统（目录 + 独立会话 + 打开链路）                      | **直接复用 UI**；数据源要换                    | `app-shell/SubagentDirectorySidePane.tsx`、`SubagentSessionSidePane.tsx`、`v4/ConversationAgentToolCallRow.tsx` |
| 每 agent 独立持久记忆 + 配置目录                                 | **直接复用**（`memory: user\|project\|local`） | `core/src/subagent/persistent-memory.ts`、`subagents/subagentStorage.ts`                                        |
| 项目级共享记忆                                                   | **相邻**：与私有记忆并存                       | `services/src/memory/memoryService.ts`                                                                          |
| automations（cron）+ off-peak 闲时执行                           | **排班基础**；与新唤醒规则并存                 | `session/automation*`、`offPeakTask*`                                                                           |
| workflow 子系统（phases + agent activities + 时间线 + artifact） | ⚠️ **只借视觉语言**，编排不寄生（决策 C）      | `components/workflow-timeline/*`、`dynamic-workflow*`                                                           |
| skills                                                           | **直接复用**                                   | `services/src/skills/`                                                                                          |
| 通知 + 渠道 bots                                                 | **Inbox/渠道原料**；渠道不派活（12-11）        | `background-task-notifications.ts`、`services/src/bots/`                                                        |
| git 服务 + checkpoint + GitPane                                  | **worktree/合并基础**；checkpoint 是另一种隔离 | `services/src/git/*`                                                                                            |
| 设置页体系                                                       | **实验分区落点**                               | `lib/settingsNavigation.ts` 等 4 处                                                                             |
| CommandInbox 串行 admission                                      | **steering 原生能力**                          | CLI runtime                                                                                                     |
| host/设备 + 远程投射                                             | **单机前提**（决策 E）                         | ADR 0003、`services/src/remote/`                                                                                |
| usage 面板（账号级）                                             | **相邻**：per-run 记账是新增                   | `settings/usage-stats/`                                                                                         |

### B. 冲突与重叠清单

| #   | 冲突                                                                                                                               | 严重   | 处理                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| C1  | **编排另起（决策 C）vs 时间线 UI 复用**：`WorkflowTimeline` 的模型来自 `WorkflowRunState`（zcode-protocol-v4），不是通用数据       | **高** | 二选一：①把小队状态**映射成 `WorkflowRunState`** 复用组件；②**只借视觉语言**（轨道/站点/药丸/九色）自建小队时间线。写 spec 时必须定 |
| C2  | **status 四套并存**：执行态（`running\|completed\|error`）、派发态（`dispatch_status`）、automation 生命周期态、新的工作项生命周期 | **高** | 四者**正交**、工作项生命周期**一处拥有、流转幂等**；不得合并（参见 `task_status 残留` 教训）                                        |
| C3  | **subagent 与「协作智能体」两套 agent 概念并存**                                                                                   | **高** | 存储目录、设置清单、UI 入口都要**显式区分**；设置里两者不得同名混淆                                                                 |
| C4  | **记忆三套**：项目共享 / 每 agent 私有 / 新实体记忆                                                                                | 中     | 明确三者关系与目录；`project` scope 写进工作区需排除                                                                                |
| C5  | **automations(cron) 与新唤醒规则（event/条件）并存**                                                                               | 中     | 明确分工：automation 管「无工作项的一次性/定时任务」，唤醒规则管「挂在工作项上的 event/条件」                                       |
| C6  | **SendMessage 是父子树，小队需要多对多**                                                                                           | 中     | 新建按「小队/工作项」路由的消息层，不复用父子语义                                                                                   |
| C7  | **`taskAutoArchiveEnabled` 会扫走旧任务**                                                                                          | 中     | 若工作项落在 task 体系，须**排除**，否则工作项被自动归档                                                                            |
| C8  | **远程投射会显示新 UI**                                                                                                            | 中     | 明确声明「实验功能不参与投射」（决策 E 已定不做多设备联动）                                                                         |
| C9  | **两套开关体系**：编译期 `HIDDEN_SETTINGS_SECTIONS`（长期隐藏）vs 运行期 `appSettings` 布尔（用户可开）                            | 中     | 别混用；实验分区走**运行期**开关，且关掉后要让相关入口整体消失                                                                      |
| C10 | **`.worktree/` 与 `.zcode/agent-memory/` 在工作区内**                                                                              | 中     | **同时**加 `.gitignore` 与扫描排除（`wikiScan` 硬编码集 + `.zcodeignore`）                                                          |
| C11 | **智能体目录入口与现有 `SubagentDirectorySidePane` 同 UI 不同源**                                                                  | 低     | 决定合并成一个入口还是两个；数据源分别为「当前对话的 subagent」与「本项目/工作项成员」                                              |
| C12 | **新工具命名**（建子工作项 / 派给队员）与现有 Agent / SendMessage / CronCreate 的语义边界                                          | 低     | 明确工具集新增清单与命名，避免语义重叠                                                                                              |
| C13 | **新增设置分区要改 4 处 + i18n**                                                                                                   | 低     | 按既有套路（`SettingsSectionId` 联合、`isSettingsSectionId`、`settingsPageConfig`、`SettingsPage` 渲染、locale）                    |
| C14 | **workspaceIdentity / workspacePath 双键规则**                                                                                     | 低     | 新实体（工作项/小队/智能体）的键必须遵从既有身份规则                                                                                |

### C. 结论

冲突集中在**三个**：**编排与时间线 UI 的关系（C1）**、**状态所有权（C2）**、**agent 概念分裂（C3）**。其余多可通过「显式区分 + 排除规则」解掉。**C1 是写 spec 前必须拍的第一件事**。

---

## 5.10 冲突抉择（建议方案）

| #      | 抉择                                                                                                                                                                                                                                                                                                 | 理由                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1** | **编排另起 + 显示层投影复用**：编排层完全自建（决策 C 不变），但在**显示边界**把小队状态**投影成一个视图模型**喂给现有 `WorkflowTimeline`。**不做领域复用**——不复用 workflow 的 script/phases/run 存储。                                                                                             | 时间线组件承载了大量硬活（轨道/站点/弧线/行进光/药丸/roster/虚拟化视口/几何计算），自建是纯重复且必然与现有 UI 漂移。小队结构与它天然同构：**lane=队员、station=一次运行、arc=交接**。`WorkflowRunState` 当作**视图协议**而非领域模型，与「编排另起」不矛盾。**退出阀**：若投影扭曲（如 worktree/合并态塞不进去），退回「只借视觉语言、自建时间线」。小组件不受 workflow 灰度开关影响（开关只隐藏入口，不删代码）。 |
| C2     | **工作项生命周期是新增的第四套，且是唯一对外的**：执行态归 CLI runtime、派发态归调度器内部、automation 生命周期态归 automation——**三者不外露**给用户与 agent；只有工作项生命周期是产品级状态，**一处拥有、流转幂等**。                                                                               | 避免多写入路径（`task_status 残留` 教训）。                                                                                                                                                                                                                                                                                                                                                                         |
| C3     | **三处显式区分**：①存储（协作智能体放实验命名空间，如 `<ws>/.zcode/squad/`，整块可删）；②UI（现有在「设置 ▸ Subagent」，新的在「设置 ▸ 实验功能 ▸ 协作智能体」）；③术语（现有称「子智能体」，新的称「协作智能体 / 队友」）。会话窗口的「本项目智能体」目录**汇总列两类**（已定），但**配置处分开**。 | 概念分裂靠命名与位置隔离，不靠用户自己分辨。                                                                                                                                                                                                                                                                                                                                                                        |
| C4     | 记忆三套**并存**：项目共享记忆保持原样；协作智能体记忆复用现有 `agent-memory/<key>`（**key 换成稳定 id**）；`project` scope 目录进排除清单。                                                                                                                                                         | 复用现成能力，只修 key 缺陷。                                                                                                                                                                                                                                                                                                                                                                                       |
| C5     | **分工**：automation 管「无工作项的定时任务」；唤醒规则管「挂在工作项上的 event/条件」。automation 若要指向工作项，走唤醒规则而非另开一路。                                                                                                                                                          | 两条触发机制并存但不重叠。                                                                                                                                                                                                                                                                                                                                                                                          |
| C6     | 新建**小队消息通道**（挂在 squad / work item 上）；`SendMessage` 的父子语义**不动**。                                                                                                                                                                                                                | 多对多不是父子树的超集。                                                                                                                                                                                                                                                                                                                                                                                            |
| C7     | 工作项**不进** task 自动归档的扫描范围（按类型/命名空间排除）。                                                                                                                                                                                                                                      | 否则工作项会被 `taskAutoArchiveEnabled` 按 7 天扫走。                                                                                                                                                                                                                                                                                                                                                               |
| C8     | 实验功能**不参与远程投射**：在投射的内容过滤里排除（与决策 E 一致）。                                                                                                                                                                                                                                | 免得多设备端出现半残界面。                                                                                                                                                                                                                                                                                                                                                                                          |
| C9     | 实验分区用**运行期**开关（`appSettings` 布尔）；`HIDDEN_SETTINGS_SECTIONS` 只用于**长期隐藏**，不做实验开关。                                                                                                                                                                                        | 两套语义不同，别混用。                                                                                                                                                                                                                                                                                                                                                                                              |
| C10    | 排除清单**集中一处维护**：`.worktree/`、`.zcode/agent-memory/`、`.zcode/squad/` 同时进 `.gitignore` 与扫描排除。                                                                                                                                                                                     | 一处改，两处生效，避免漏。                                                                                                                                                                                                                                                                                                                                                                                          |
| C11    | **合并成一个「智能体」入口**（列本项目所有），配置分两处。                                                                                                                                                                                                                                           | 一处看状态，两处管定义。                                                                                                                                                                                                                                                                                                                                                                                            |
| C12    | 工具新增走**独立命名**（如 `CreateWorkItem` / `DelegateTask`），并在工具文档里写明与 `Agent` / `SendMessage` / `CronCreate` 的边界。                                                                                                                                                                 | 语义不重叠。                                                                                                                                                                                                                                                                                                                                                                                                        |
| C13    | 按既有 4 处套路加分区（id 联合、`isSettingsSectionId`、`settingsPageConfig`、`SettingsPage` 渲染、locale）。                                                                                                                                                                                         | —                                                                                                                                                                                                                                                                                                                                                                                                                   |
| C14    | 新实体的键遵从 `workspaceIdentity?.trim() \|\| workspacePath`。                                                                                                                                                                                                                                      | AGENTS.md 既有规则。                                                                                                                                                                                                                                                                                                                                                                                                |

---

**最终确认（2026-10-01，用户逐条拍板）**：C1–C14 全部通过，**两处修订**——

- **C1 改为「直接自建时间线」**：**不复用** workflow 时间线组件，**只沿用九色板（`SUBAGENT_COLORS`）与语义状态色**，轨道/站点/弧线自己写。零耦合，与「编排另起一套」完全一致。已知代价：几何计算、虚拟化视口、动效需自建且要自己防止与现有 UI 漂移。
- **C6 澄清为「会话只做沟通、执行不在会话里」**：小队有一个**共享沟通会话**，用于讨论 / 汇报 / 队长协调；但**队员的执行不发生在会话中**，而在各自的**独立运行 + 工作树**里。即 **沟通面 ≠ 执行面**。`SendMessage` 的父子语义不动。这样也保住了上下文隔离（四红线之②）。

其余 12 条按 §5.10 建议原样通过。队长指令模板按 §5.11 定案（8 槽位，**收手条件**与**轮次上限**必填）。

---

## 5.11 队长指令模板（机制，不是固定工作流）

队长指令是**终止条件的载体**（系统不替你判断何时收手）。它落在 **Squad 实体的 `instructions` 字段**上（对齐 multica 的 `squad.instructions`），可按工作项覆盖。模板只给**槽位**，填什么由用户定：

| 槽位           | 作用                                      | 例                                                             |
| -------------- | ----------------------------------------- | -------------------------------------------------------------- |
| **目标**       | 这个计划成功长什么样                      | 「限流上线并通过审查」                                         |
| **拆解规则**   | 怎么拆成子工作项：粒度与判据              | 「按模块拆，单项不超过 3 个文件改动」                          |
| **派单规则**   | 派给谁：按队员 role / 能力；是否允许并行  | 「安全类给审查者；实现类给实现者，最多并行 3」                 |
| **独立性要求** | 队员执行时**不得互相看结论**（四红线之②） | 「各自独立跑，汇总前不共享草稿」                               |
| **验收标准**   | 每个子项怎样算过                          | 「测试通过 + 审查者无阻断意见」                                |
| **收手条件**   | **何时停**：继续 / 收工 / 叫人            | 「全部子项 done 且审查通过即收工；有 blocked 就进 Inbox 等人」 |
| **汇报格式**   | 向人汇报什么、何时进 Inbox                | 「只在需决策或全部完成时通知」                                 |
| **轮次上限**   | 最多派几轮（与 `max_fires` 呼应）         | 「最多 5 轮」                                                  |

**为什么模板里必须有「收手条件」和「轮次上限」**：写含糊的结果只有两种——**早早停了等人催**，或**没完没了地派**直到撞上 `max_fires`。这两条是把「自动推进」变成「可靠自动推进」的关键。

---

## 附：来源与文件索引

**multica（main 分支）**：`README.md` / `VISION.md` / `CLI_AND_DAEMON.md` / `docs/engineering/issue-wakeups.md` /
`docs/issue-status-lifecycle-rollout.md` / `docs/maintenance-jobs.md`；
`server/migrations/{042_autopilot,084_squad,090_task_is_leader,096_autopilot_squad_assignee,124_autopilot_run_planned_at,127_task_squad_id}_*.sql`；
`server/internal/service/{issue_wakeup*,issue,autopilot*}.go`；`server/internal/{scheduler,dispatch,issuestatus,daemon,daemonws,featureflags,auth}/`；
`packages/views/**`、`packages/core/**`。

**ZPaPa**：`packages/services/src/subagents/{subagentStorage,subagentMarkdown,subagentsService}.ts`；
`apps/zcode-cli/packages/core/src/subagent/{persistent-memory.ts,profile.ts}`；
`apps/zcode-cli/packages/contracts/src/workflow/script.ts`；`apps/zcode-cli/packages/bootstrap/src/app/script-workflow-runtime.ts`；
`packages/services/src/git/repo/{gitCliRepo,gitCheckpointRepo}.ts`、`packages/services/src/git/gitCheckpointService.ts`；
`packages/shared/src/{subagents-types,git,model-selection}.ts`；
`packages/ui/src/{lib/settingsNavigation.ts,settings/settingsPageConfig.ts,SettingsPage.tsx}`；
`packages/shared/src/validationAppSettings.ts`。
